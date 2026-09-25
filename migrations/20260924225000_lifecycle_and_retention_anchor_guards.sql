begin;

-- Lifecycle changes and retention evidence remain valid under ordinary owner
-- DML. All clocks below come from the database runtime authority.

create or replace function fidensa_private.enforce_application_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  cleanup_allowed boolean := false;
  retention_allowed boolean := false;
  rate_digest text;
  terminal_reason text;
begin
  if tg_op = 'INSERT' then
    if new.lifecycle <> 'pending_verification' or new.version <> 1
       or new.verified_at is not null or new.terminal_at is not null
       or new.submitted_at > operation_time
       or new.submitted_at < operation_time - interval '5 seconds' then
      raise exception 'application insertion must begin pending verification at authoritative time' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select exists (
      select 1 from fidensa_private.exercise_controls
      where correlation_id = old.correlation_id and state = 'cleanup_pending'
    ) into cleanup_allowed;
    retention_allowed := old.lifecycle <> 'transferred'
      and old.retention_deadline <= operation_time + interval '25 minutes';
    if not cleanup_allowed and not retention_allowed then
      raise exception 'application deletion requires its immutable deadline or exercise cleanup' using errcode = '55000';
    end if;

    select email_rate_digest into rate_digest
      from fidensa_private.verifications
      where application_id = old.id order by generation desc limit 1;
    if rate_digest is null then
      raise exception 'application deletion requires its rate-keyed terminal evidence' using errcode = '55000';
    end if;
    terminal_reason := case
      when cleanup_allowed then 'controlled_exercise_cleanup'
      when old.lifecycle = 'pending_verification' then 'seven_day_unverified_retention'
      else 'twelve_month_inactive_retention'
    end;
    insert into fidensa_private.application_terminal_guards
      (application_id, email_rate_digest, digest_key_id, terminal_state,
       terminal_at, reason, retention_anchor_at, review_or_disposal_at)
    values
      (old.id, rate_digest, 'server-hmac-v1', 'deleted', operation_time,
       terminal_reason, operation_time, operation_time + interval '24 months')
    on conflict (application_id) do nothing;
    if not exists (
      select 1 from fidensa_private.application_terminal_guards
      where application_id = old.id and email_rate_digest = rate_digest
        and digest_key_id = 'server-hmac-v1' and terminal_state = 'deleted'
        and retention_anchor_at = terminal_at
        and review_or_disposal_at = terminal_at + interval '24 months'
    ) then
      raise exception 'application deletion requires an immutable terminal guard' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.lifecycle in ('anonymized', 'transferred') then
    raise exception 'terminal application state cannot be changed' using errcode = '55000';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'application updates advance exactly one version' using errcode = '55000';
  end if;
  if old.lifecycle = 'pending_verification' and new.lifecycle = 'active' then
    if new.verified_at is null or new.terminal_at is not null
       or new.verified_at > operation_time
       or new.verified_at < operation_time - interval '5 seconds'
       or new.updated_at <> new.verified_at
       or new.retention_deadline < new.verified_at
       or new.retention_deadline < new.submitted_at + interval '12 months'
       or (to_jsonb(new) - array[
            'lifecycle','verified_at','retention_deadline','version','updated_at'
          ]) is distinct from (to_jsonb(old) - array[
            'lifecycle','verified_at','retention_deadline','version','updated_at'
          ]) then
      raise exception 'verification transition must use authoritative time and only verification fields' using errcode = '55000';
    end if;
  elsif old.lifecycle = 'active' and new.lifecycle = 'transferred' then
    if new.terminal_at is null
       or new.transfer_policy_identity !~ '^accepted-application-transfer-policy-v1([:/@].+)?$'
       or new.transfer_recorded_at is distinct from new.terminal_at
       or new.terminal_at > operation_time
       or new.terminal_at < operation_time - interval '5 seconds'
       or new.terminal_at >= old.retention_deadline
       or new.updated_at <> new.terminal_at
       or not exists (
         select 1 from fidensa_private.reviewer_status
          where application_id = old.id and state = 'accepted'
       )
       or (to_jsonb(new) - array[
            'lifecycle','terminal_at','transfer_policy_identity',
            'transfer_recorded_at','version','updated_at'
          ]) is distinct from (to_jsonb(old) - array[
            'lifecycle','terminal_at','transfer_policy_identity',
            'transfer_recorded_at','version','updated_at'
          ]) then
      raise exception 'accepted transfer requires queue acceptance, policy identity, and authoritative terminal time' using errcode = '55000';
    end if;
  elsif old.lifecycle = 'active' and new.lifecycle = 'active' then
    if new.last_direct_interaction_at is null
       or new.last_direct_interaction_at < coalesce(old.last_direct_interaction_at, old.submitted_at)
       or new.last_direct_interaction_at > operation_time
       or (to_jsonb(new) - array['last_direct_interaction_at','retention_deadline','version','updated_at'])
          is distinct from
          (to_jsonb(old) - array['last_direct_interaction_at','retention_deadline','version','updated_at']) then
      raise exception 'active application updates are limited to a non-future direct interaction' using errcode = '55000';
    end if;
  else
    raise exception 'invalid application lifecycle transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create function fidensa_private.validate_application_lifecycle_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  app_id uuid := case
    when tg_table_name = 'applications' then
      coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid)
    when tg_table_name = 'application_terminal_guards' then
      coalesce((to_jsonb(new)->>'application_id')::uuid, (to_jsonb(old)->>'application_id')::uuid)
    else
      coalesce((to_jsonb(new)->>'application_id')::uuid, (to_jsonb(old)->>'application_id')::uuid)
  end;
  app_record fidensa_private.applications%rowtype;
  current_verification fidensa_private.verifications%rowtype;
  status_record fidensa_private.reviewer_status%rowtype;
begin
  select * into app_record from fidensa_private.applications where id = app_id;
  if app_record.id is null then return null; end if;

  select * into current_verification
    from fidensa_private.verifications
   where application_id = app_id and purpose = 'application_verification'
   order by generation desc limit 1;

  if app_record.lifecycle = 'pending_verification' then
    if current_verification.id is null
       or current_verification.state not in ('issued', 'delivery_unknown')
       or exists (
         select 1 from fidensa_private.reviewer_status where application_id = app_id
       )
       or exists (
         select 1 from fidensa_private.reviewer_status_history where application_id = app_id
       ) then
      raise exception 'pending application requires a current credential and no queue state' using errcode = '55000';
    end if;
    return null;
  end if;

  select * into status_record
    from fidensa_private.reviewer_status where application_id = app_id;
  if current_verification.id is null
     or current_verification.state <> 'consumed'
     or current_verification.consumed_at is distinct from app_record.verified_at
     or status_record.application_id is null
     or not exists (
       select 1 from fidensa_private.reviewer_status_history
        where application_id = app_id and transition_version = 1
          and prior_state is null and new_state = 'new'
          and actor = 'system' and reason = 'address_verified'
          and occurred_at = app_record.verified_at
     ) then
    raise exception 'active application requires paired credential consumption and initial queue history' using errcode = '55000';
  end if;

  if app_record.lifecycle = 'active' then
    if exists (
      select 1 from fidensa_private.application_terminal_guards
       where application_id = app_id and terminal_state = 'transferred'
    ) then
      raise exception 'active application cannot carry transferred terminal evidence' using errcode = '55000';
    end if;
  elsif app_record.lifecycle = 'transferred' then
    if status_record.state <> 'accepted'
       or app_record.transfer_policy_identity !~ '^accepted-application-transfer-policy-v1([:/@].+)?$'
       or app_record.transfer_recorded_at is distinct from app_record.terminal_at
       or app_record.terminal_at >= app_record.retention_deadline
       or not exists (
         select 1 from fidensa_private.application_terminal_guards
          where application_id = app_id and terminal_state = 'transferred'
            and terminal_at = app_record.terminal_at
            and retention_anchor_at = app_record.terminal_at
            and review_or_disposal_at = app_record.terminal_at + interval '24 months'
            and reason = 'accepted_policy_transfer'
       ) then
      raise exception 'transferred application requires accepted queue state and paired terminal guard' using errcode = '55000';
    end if;
  else
    raise exception 'unsupported application lifecycle pairing' using errcode = '55000';
  end if;
  return null;
end
$function$;

create constraint trigger application_lifecycle_pair_complete
after insert or update or delete on fidensa_private.applications
deferrable initially deferred for each row execute function fidensa_private.validate_application_lifecycle_pair();
create constraint trigger verification_application_pair_complete
after insert or update or delete on fidensa_private.verifications
deferrable initially deferred for each row execute function fidensa_private.validate_application_lifecycle_pair();
create constraint trigger queue_application_pair_complete
after insert or update or delete on fidensa_private.reviewer_status
deferrable initially deferred for each row execute function fidensa_private.validate_application_lifecycle_pair();
create constraint trigger queue_history_application_pair_complete
after insert or update or delete on fidensa_private.reviewer_status_history
deferrable initially deferred for each row execute function fidensa_private.validate_application_lifecycle_pair();
create constraint trigger terminal_guard_application_pair_complete
after insert or update or delete on fidensa_private.application_terminal_guards
deferrable initially deferred for each row execute function fidensa_private.validate_application_lifecycle_pair();

create or replace function fidensa_private.enforce_fixed_retention_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  anchor_time timestamptz;
  deadline_time timestamptz;
  row_correlation uuid;
  cleanup_allowed boolean := false;
begin
  if tg_table_name = 'abuse_events' then
    anchor_time := coalesce(new.occurred_at, old.occurred_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  elsif tg_table_name = 'abuse_investigations' then
    anchor_time := coalesce(new.selected_at, old.selected_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
  elsif tg_table_name = 'operational_logs' then
    anchor_time := coalesce(new.occurred_at, old.occurred_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  else
    anchor_time := coalesce(new.first_authenticated_received_at, old.first_authenticated_received_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  end if;

  if tg_op = 'INSERT' then
    if anchor_time > operation_time
       or anchor_time < operation_time - interval '5 seconds' then
      raise exception 'fixed-retention rows must begin at authoritative time' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if tg_table_name <> 'provider_events'
       or (to_jsonb(new) - 'state') is distinct from (to_jsonb(old) - 'state')
       or not (
         new.state = old.state
         or (old.state = 'authenticated' and new.state in ('applied','duplicate','stale','needs_reconciliation'))
         or (old.state = 'needs_reconciliation' and new.state in ('applied','stale'))
       ) then
      raise exception 'fixed-retention rows are immutable outside provider state normalization' using errcode = '55000';
    end if;
    return new;
  end if;

  if row_correlation is not null then
    select exists (
      select 1 from fidensa_private.exercise_controls
       where correlation_id = row_correlation and state = 'cleanup_pending'
    ) into cleanup_allowed;
  end if;
  if not cleanup_allowed
     and deadline_time > operation_time + interval '25 minutes' then
    raise exception 'fixed-retention row deletion requires its immutable deadline or exercise cleanup' using errcode = '55000';
  end if;
  return old;
end
$function$;

create trigger abuse_events_fixed_retention_guard
before insert or update or delete on fidensa_private.abuse_events
for each row execute function fidensa_private.enforce_fixed_retention_write();
create trigger abuse_investigations_fixed_retention_guard
before insert or update or delete on fidensa_private.abuse_investigations
for each row execute function fidensa_private.enforce_fixed_retention_write();
create trigger operational_logs_fixed_retention_guard
before insert or update or delete on fidensa_private.operational_logs
for each row execute function fidensa_private.enforce_fixed_retention_write();
create trigger provider_events_fixed_retention_guard
before insert or update or delete on fidensa_private.provider_events
for each row execute function fidensa_private.enforce_fixed_retention_write();

create or replace function fidensa_private.enforce_job_run_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  registered boolean;
  budget interval;
  budget_end timestamptz;
begin
  select deadline_budget into budget
    from fidensa_private.job_schedules
   where job_type = coalesce(new.job_type, old.job_type)
     and version = coalesce(new.version, old.version);
  registered := budget is not null;
  if tg_op = 'INSERT' then
    budget_end := new.scheduled_bucket + coalesce(budget, interval '0');
    if registered then
      if new.scheduled_bucket > operation_time
         or new.first_started_at < operation_time - interval '5 seconds'
         or new.first_started_at > operation_time then
        raise exception 'job bucket and start must be bounded by authoritative time' using errcode = '55000';
      end if;
      if new.first_terminal_at is not null and (
           new.first_terminal_at < new.first_started_at
           or new.first_terminal_at > operation_time
         ) then
        raise exception 'job terminal time must follow start and not exceed authoritative time' using errcode = '55000';
      end if;
    elsif fidensa_private.authoritative_environment() <> 'Test' then
      raise exception 'unregistered job types are confined to isolated tests' using errcode = '55000';
    end if;
    if new.job_type = 'database_retention' and (
         date_trunc('minute', new.scheduled_bucket) <> new.scheduled_bucket
         or extract(minute from new.scheduled_bucket)::integer % 15 <> 0
       ) then
      raise exception 'retention jobs require an exact 15-minute bucket' using errcode = '55000';
    elsif new.job_type = 'retention_health' and (
         date_trunc('minute', new.scheduled_bucket) <> new.scheduled_bucket
         or extract(hour from new.scheduled_bucket at time zone 'UTC') <> 14
         or extract(minute from new.scheduled_bucket at time zone 'UTC') <> 0
       ) then
      raise exception 'retention health jobs require the daily 14:00 UTC bucket' using errcode = '55000';
    end if;
    if new.job_type = 'database_retention'
       and new.first_terminal_at is not null
       and (new.first_started_at > budget_end or new.first_terminal_at > budget_end)
       and new.outcome <> 'failed' then
      raise exception 'late retention terminal evidence must remain failed' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.expires_at is null
       or old.expires_at > operation_time + interval '25 minutes' then
      raise exception 'job run deletion requires its fixed expiry' using errcode = '55000';
    end if;
    if exists (
      select 1 from fidensa_private.retention_incidents
      where job_run_id = old.id and resolved_at is null
    ) then
      raise exception 'job run deletion cannot cascade an unresolved incident' using errcode = '55000';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'updated_at') is not distinct from (to_jsonb(old) - 'updated_at') then
    return new;
  end if;
  if old.job_type <> 'database_retention'
     or (to_jsonb(new) - array[
          'first_terminal_at','outcome','selected_count','deleted_count',
          'remaining_count','expires_at','updated_at'
        ]) is distinct from (to_jsonb(old) - array[
          'first_terminal_at','outcome','selected_count','deleted_count',
          'remaining_count','expires_at','updated_at'
        ])
     or new.first_terminal_at is null
     or new.first_terminal_at < new.first_started_at
     or (old.first_terminal_at is not null
         and new.first_terminal_at <> old.first_terminal_at)
     or (old.first_terminal_at is null and new.first_terminal_at > operation_time)
     or ((new.first_started_at > new.scheduled_bucket + budget
          or new.first_terminal_at > new.scheduled_bucket + budget)
         and new.outcome <> 'failed') then
    raise exception 'job-run state is immutable outside its terminal retention transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_job_attempt_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  run_row fidensa_private.job_runs%rowtype;
  budget interval;
  budget_end timestamptz;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'job attempts are immutable' using errcode = '55000';
  end if;
  select * into run_row from fidensa_private.job_runs
   where id = new.job_run_id;
  select deadline_budget into budget from fidensa_private.job_schedules
   where job_type = run_row.job_type and version = run_row.version;
  if run_row.id is not null then
    budget_end := run_row.scheduled_bucket + budget;
    if new.started_at > operation_time
       or new.started_at < operation_time - interval '5 minutes'
       or (new.completed_at is not null and (
         new.completed_at < new.started_at or new.completed_at > operation_time
       )) then
      raise exception 'job attempt times must be bounded by authoritative time' using errcode = '55000';
    end if;
    if run_row.job_type = 'database_retention' then
      if (new.started_at > run_row.scheduled_bucket) <> new.delay_observed then
        raise exception 'retention attempt delay evidence must match its bucket' using errcode = '55000';
      end if;
      if new.completed_at is not null
         and (new.started_at > budget_end or new.completed_at > budget_end)
         and (new.outcome <> 'failed' or not new.incident or not new.delay_observed) then
        raise exception 'late retention attempts must fail and remain incidents' using errcode = '55000';
      end if;
    end if;
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_incident_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  run_row fidensa_private.job_runs%rowtype;
  budget interval;
  incident_anchor timestamptz;
begin
  if tg_op = 'INSERT' then
    select * into run_row from fidensa_private.job_runs
     where id = new.job_run_id;
    select deadline_budget into budget from fidensa_private.job_schedules
     where job_type = run_row.job_type and version = run_row.version;
    if run_row.id is null
       or (budget is null and fidensa_private.authoritative_environment() <> 'Test')
       or new.detected_at > operation_time
       or new.detected_at < operation_time - interval '5 seconds' then
      raise exception 'retention incidents require a current registered run and authoritative detection time' using errcode = '55000';
    end if;
    if budget is not null
       and new.incident_class in ('late_start','late_commit','not_started','health_not_started') then
      incident_anchor := least(
        coalesce(new.oldest_overdue_at, run_row.scheduled_bucket + budget),
        run_row.scheduled_bucket + budget
      );
      new.intake_close_due_at := incident_anchor + interval '24 hours';
    elsif new.incident_class = 'overdue_row' then
      new.intake_close_due_at := coalesce(new.oldest_overdue_at, new.detected_at) + interval '24 hours';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'retention incidents delete only with their expired job' using errcode = '55000';
    end if;
    return old;
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if old.resolved_at is not null
     or (to_jsonb(new) - array['resolved_at','resolution_evidence_digest','resolution_note'])
        is distinct from
        (to_jsonb(old) - array['resolved_at','resolution_evidence_digest','resolution_note'])
     or new.resolved_at is null
     or new.resolution_evidence_digest is null
     or nullif(btrim(new.resolution_note), '') is null then
    raise exception 'incident deadlines are frozen and resolution is a one-way paired act' using errcode = '55000';
  end if;
  return new;
end
$function$;

drop trigger retention_incidents_write_guard on fidensa_private.retention_incidents;
create trigger retention_incidents_write_guard
before insert or update or delete on fidensa_private.retention_incidents
for each row execute function fidensa_private.enforce_incident_write();

create or replace function fidensa_private.validate_job_run_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare run_id uuid := case when tg_table_name = 'job_runs'
  then coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid)
  else coalesce(
    (to_jsonb(new)->>'job_run_id')::uuid,
    (to_jsonb(old)->>'job_run_id')::uuid
  )
end;
declare run_row fidensa_private.job_runs%rowtype;
declare latest_attempt fidensa_private.job_run_attempts%rowtype;
declare budget interval;
declare budget_end timestamptz;
declare late_start boolean;
declare late_commit boolean;
begin
  select * into run_row from fidensa_private.job_runs where id = run_id;
  select deadline_budget into budget from fidensa_private.job_schedules
   where job_type = run_row.job_type and version = run_row.version;
  if run_row.id is null or run_row.job_type <> 'database_retention' then
    return null;
  end if;
  select * into latest_attempt from fidensa_private.job_run_attempts attempt
    where attempt.job_run_id = run_id
    order by attempt.attempt desc limit 1;
  if run_row.outcome = 'started' or latest_attempt.id is null
     or latest_attempt.started_at < run_row.scheduled_bucket
     or latest_attempt.started_at > fidensa_private.authoritative_now()
     or latest_attempt.completed_at is null
     or latest_attempt.completed_at < latest_attempt.started_at
     or latest_attempt.completed_at > fidensa_private.authoritative_now()
     or latest_attempt.outcome <> run_row.outcome
     or latest_attempt.selected_count <> run_row.selected_count
     or latest_attempt.deleted_count <> run_row.deleted_count
     or latest_attempt.remaining_count <> run_row.remaining_count then
    raise exception 'committed retention run requires its bounded terminal attempt' using errcode = '55000';
  end if;
  budget_end := run_row.scheduled_bucket + budget;
  late_start := run_row.first_started_at > budget_end;
  late_commit := run_row.first_terminal_at > budget_end;
  if late_start or late_commit then
    if run_row.outcome <> 'failed'
       or latest_attempt.outcome <> 'failed'
       or not latest_attempt.delay_observed
       or not latest_attempt.incident
       or not exists (
         select 1 from fidensa_private.retention_incidents incident
          where incident.job_run_id = run_id
            and incident.incident_class in ('late_start','late_commit','not_started')
            and incident.intake_close_due_at <= budget_end + interval '24 hours'
       ) then
      raise exception 'late retention run requires failed attempt and bucket-bound incident' using errcode = '55000';
    end if;
  end if;
  return null;
end
$function$;

create or replace function fidensa_private.enforce_rubric_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if new.first_scored_at is distinct from old.first_scored_at then
    if old.first_scored_at is not null or new.first_scored_at is null
       or new.first_scored_at > operation_time
       or new.first_scored_at < operation_time - interval '5 seconds'
       or old.calibration_anchor_at is not null
       or new.calibration_anchor_at <> new.first_scored_at
       or old.scored_since_calibration <> 0
       or new.scored_since_calibration <> 1 then
      raise exception 'first-score anchor requires the authoritative first scoring act' using errcode = '55000';
    end if;
  end if;
  if new.calibration_anchor_at is distinct from old.calibration_anchor_at then
    if new.calibration_anchor_at > operation_time then
      raise exception 'calibration anchors cannot be in the future' using errcode = '55000';
    end if;
    if old.calibration_anchor_at is null then
      if old.first_scored_at is not null or new.first_scored_at is null
         or new.calibration_anchor_at <> new.first_scored_at
         or old.scored_since_calibration <> 0
         or new.scored_since_calibration <> 1 then
        raise exception 'initial calibration anchor requires the first scoring act' using errcode = '55000';
      end if;
    elsif new.scored_since_calibration <> 0 or not exists (
      select 1 from fidensa_private.rubric_calibrations
      where rubric_version_id = new.id
        and scored_application_count = old.scored_since_calibration
        and recorded_at = new.calibration_anchor_at
    ) then
      raise exception 'calibration anchor change requires its calibration row' using errcode = '55000';
    end if;
  elsif new.scored_since_calibration < old.scored_since_calibration then
    raise exception 'calibration counter cannot reset without a new anchor' using errcode = '55000';
  end if;
  return new;
end
$function$;

alter table fidensa_private.applications enable always trigger application_lifecycle_pair_complete;
alter table fidensa_private.verifications enable always trigger verification_application_pair_complete;
alter table fidensa_private.reviewer_status enable always trigger queue_application_pair_complete;
alter table fidensa_private.reviewer_status_history enable always trigger queue_history_application_pair_complete;
alter table fidensa_private.application_terminal_guards enable always trigger terminal_guard_application_pair_complete;
alter table fidensa_private.abuse_events enable always trigger abuse_events_fixed_retention_guard;
alter table fidensa_private.abuse_investigations enable always trigger abuse_investigations_fixed_retention_guard;
alter table fidensa_private.operational_logs enable always trigger operational_logs_fixed_retention_guard;
alter table fidensa_private.provider_events enable always trigger provider_events_fixed_retention_guard;
alter table fidensa_private.retention_incidents enable always trigger retention_incidents_write_guard;

revoke execute on all functions in schema fidensa_private
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

commit;

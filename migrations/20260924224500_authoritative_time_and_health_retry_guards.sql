begin;

-- Ordinary owner DML cannot manufacture old scheduler evidence, defer
-- retention or calibration clocks into the future, or remove an unresolved
-- incident through a parent cascade. Health-review retries may repeat an
-- exactly unchanged incident observation.

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
    if new.verified_at is null or new.terminal_at is not null then
      raise exception 'verification transition is incomplete' using errcode = '55000';
    end if;
  elsif old.lifecycle = 'active' and new.lifecycle = 'transferred' then
    if new.terminal_at is null or new.transfer_policy_identity is null
       or new.transfer_recorded_at is null then
      raise exception 'accepted transfer metadata is incomplete' using errcode = '55000';
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

create or replace function fidensa_private.enforce_incident_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
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

create or replace function fidensa_private.enforce_rubric_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.calibration_anchor_at is distinct from old.calibration_anchor_at then
    if new.calibration_anchor_at > fidensa_private.authoritative_now() then
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

create function fidensa_private.enforce_rubric_calibration_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  current_count integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'rubric calibration evidence is immutable' using errcode = '55000';
  end if;
  select scored_since_calibration into current_count
    from fidensa_private.rubric_versions where id = new.rubric_version_id;
  if current_count is null
     or new.scored_application_count <> current_count
     or new.recorded_at > operation_time
     or new.recorded_at < operation_time - interval '5 seconds' then
    raise exception 'calibration evidence must bind current count and authoritative time' using errcode = '55000';
  end if;
  return new;
end
$function$;

drop trigger rubric_calibrations_immutable on fidensa_private.rubric_calibrations;
create trigger rubric_calibrations_immutable
before insert or update or delete on fidensa_private.rubric_calibrations
for each row execute function fidensa_private.enforce_rubric_calibration_write();

create or replace function fidensa_private.perform_retention(
  p_scheduled_bucket timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_id uuid;
  attempt_number integer;
  cutoff timestamptz := p_scheduled_bucket + interval '25 minutes';
  budget_end timestamptz := p_scheduled_bucket + interval '5 minutes';
  selected_total integer := 0;
  deleted_total integer := 0;
  remaining_total integer := 0;
  affected integer;
  oldest_deadline timestamptz;
  run_outcome fidensa_private.job_outcome;
  incident_kind text;
  started_at timestamptz := fidensa_private.authoritative_now();
  completed_at timestamptz;
begin
  if date_trunc('minute', p_scheduled_bucket) <> p_scheduled_bucket
     or extract(minute from p_scheduled_bucket)::integer % 15 <> 0 then
    raise exception 'scheduled bucket must be an exact UTC 15-minute boundary' using errcode = '22023';
  end if;
  select min(deadline) into oldest_deadline from (
    select retention_deadline as deadline from fidensa_private.applications
      where lifecycle <> 'transferred' and retention_deadline <= cutoff
    union all select deletion_deadline from fidensa_private.abuse_events where deletion_deadline <= cutoff
    union all select deletion_deadline from fidensa_private.abuse_investigations where deletion_deadline <= cutoff
    union all select deletion_deadline from fidensa_private.operational_logs where deletion_deadline <= cutoff
    union all select deletion_deadline from fidensa_private.provider_events where deletion_deadline <= cutoff
    union all select deletion_deadline from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= cutoff
    union all select byte_deletion_deadline from fidensa_private.privacy_export_artifacts
      where encrypted_bytes is not null and byte_deletion_deadline <= cutoff
    union all select closed_record_deletion_deadline from fidensa_private.privacy_requests
      where closed_record_deletion_deadline is not null and closed_record_deletion_deadline <= cutoff
    union all select review_or_disposal_at from fidensa_private.suppressions
      where state = 'released' and review_or_disposal_at <= cutoff
    union all select review_or_disposal_at from fidensa_private.application_operation_guards
      where review_or_disposal_at <= cutoff
    union all select review_or_disposal_at from fidensa_private.application_terminal_guards guard
      where review_or_disposal_at <= cutoff and not exists (
        select 1 from fidensa_private.terminal_guard_reviews review
        where review.application_id = guard.application_id
          and review.review_due_at = guard.review_or_disposal_at
      )
  ) due;

  select count(*) into selected_total from (
    select id from fidensa_private.applications where lifecycle <> 'transferred' and retention_deadline <= cutoff
    union all select id from fidensa_private.abuse_events where deletion_deadline <= cutoff
    union all select id from fidensa_private.abuse_investigations where deletion_deadline <= cutoff
    union all select id from fidensa_private.operational_logs where deletion_deadline <= cutoff
    union all select id from fidensa_private.provider_events where deletion_deadline <= cutoff
    union all select id from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= cutoff
    union all select id from fidensa_private.privacy_export_artifacts where encrypted_bytes is not null and byte_deletion_deadline <= cutoff
    union all select id from fidensa_private.privacy_requests where closed_record_deletion_deadline is not null and closed_record_deletion_deadline <= cutoff
    union all select id from fidensa_private.suppressions
      where state = 'released' and review_or_disposal_at <= cutoff
    union all select null::uuid from fidensa_private.application_operation_guards
      where review_or_disposal_at <= cutoff
    union all select application_id from fidensa_private.application_terminal_guards guard
      where review_or_disposal_at <= cutoff and not exists (
        select 1 from fidensa_private.terminal_guard_reviews review
        where review.application_id = guard.application_id
          and review.review_due_at = guard.review_or_disposal_at
      )
  ) selected;

  insert into fidensa_private.job_runs (
    job_type, version, scheduled_bucket, selection_cutoff, oldest_due_deadline,
    first_started_at, outcome
  ) values (
    'database_retention', 'v1', p_scheduled_bucket, cutoff, oldest_deadline,
    started_at, 'started'
  )
  on conflict (job_type, version, scheduled_bucket) do update
    set updated_at = fidensa_private.job_runs.updated_at
  returning id into run_id;

  select coalesce(max(attempt), 0) + 1 into attempt_number
    from fidensa_private.job_run_attempts where job_run_id = run_id;

  perform set_config('fidensa.application_write', 'retention', true);
  perform set_config('fidensa.verification_write', 'retention', true);
  perform set_config('fidensa.governed_delete', 'on', true);
  perform set_config('fidensa.subscription_write', 'retention', true);
  perform set_config('fidensa.score_write', 'retention', true);

  -- Pending subscription state is application-bound; active consent survives
  -- application deletion with only its approved minimal fields.
  delete from fidensa_private.subscriptions s
    using fidensa_private.applications a
    where s.application_id = a.id and s.state = 'pending_confirmation'
      and a.lifecycle = 'pending_verification' and a.retention_deadline <= cutoff;
  get diagnostics affected = row_count;
  deleted_total := deleted_total + affected;

  insert into fidensa_private.application_terminal_guards
    (application_id, email_rate_digest, digest_key_id, terminal_state, terminal_at, reason,
     retention_anchor_at, review_or_disposal_at)
  select a.id, v.email_rate_digest, 'server-hmac-v1',
         'deleted', started_at,
         case when a.lifecycle = 'pending_verification' then 'seven_day_unverified_retention'
              else 'twelve_month_inactive_retention' end,
         started_at, started_at + interval '24 months'
  from fidensa_private.applications a
  join lateral (
    select email_rate_digest from fidensa_private.verifications
    where application_id = a.id order by generation desc limit 1
  ) v on true
  where a.lifecycle <> 'transferred' and a.retention_deadline <= cutoff
  on conflict (application_id) do nothing;

  update fidensa_private.application_operation_guards g
    set result_class = 'terminal', terminal_at = coalesce(g.terminal_at, started_at)
    where exists (
      select 1 from fidensa_private.applications a
      where a.id = g.application_id and a.lifecycle <> 'transferred'
        and a.retention_deadline <= cutoff
    );

  delete from fidensa_private.applications
    where lifecycle <> 'transferred' and retention_deadline <= cutoff;
  get diagnostics affected = row_count;
  deleted_total := deleted_total + affected;

  delete from fidensa_private.abuse_events where deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;
  delete from fidensa_private.abuse_investigations where deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;
  delete from fidensa_private.operational_logs where deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;
  delete from fidensa_private.provider_events where deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;
  delete from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;

  update fidensa_private.privacy_export_artifacts
    set encrypted_bytes = null, state = 'expired', deleted_at = started_at
    where encrypted_bytes is not null and byte_deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;

  perform set_config('fidensa.privacy_write', 'retention', true);
  -- Cascades remove credentials, histories, proof references, and artifacts.
  -- The trigger explicitly permits only this retention marker for deletion.
  delete from fidensa_private.privacy_requests
    where closed_record_deletion_deadline is not null
      and closed_record_deletion_deadline <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;

  insert into fidensa_private.suppression_reviews
    (suppression_id, review_due_at, detected_at, owner)
  select id, review_or_disposal_at, started_at, 'scott_bishop'
    from fidensa_private.suppressions
    where state = 'effective' and review_or_disposal_at <= cutoff
  on conflict (suppression_id, review_due_at) do nothing;

  -- An effective suppression date is an owner-review trigger, never release
  -- authority. Only already released residue is physically disposed here.
  delete from fidensa_private.suppressions
    where state = 'released' and review_or_disposal_at <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;

  -- Replay guards have a fixed disposal date, including duplicate guards that
  -- never acquired an application id.  Terminal guards retain resurrection
  -- protection and create a persisted Scott-owned review when due.
  delete from fidensa_private.application_operation_guards
    where review_or_disposal_at <= cutoff;
  get diagnostics affected = row_count; deleted_total := deleted_total + affected;
  insert into fidensa_private.terminal_guard_reviews
    (application_id, review_due_at, detected_at, owner)
  select application_id, review_or_disposal_at, started_at, 'scott_bishop'
  from fidensa_private.application_terminal_guards
  where review_or_disposal_at <= cutoff
  on conflict (application_id, review_due_at) do nothing;

  delete from fidensa_private.job_runs expired_run
    where expired_run.expires_at is not null
      and expired_run.expires_at <= cutoff
      and expired_run.id <> run_id
      and not exists (
        select 1 from fidensa_private.retention_incidents incident
        where incident.job_run_id = expired_run.id
          and incident.resolved_at is null
      );

  -- Completion is observed only after every retention mutation above has run.
  completed_at := fidensa_private.authoritative_now();

  select count(*) into remaining_total from (
    select id from fidensa_private.applications where lifecycle <> 'transferred' and retention_deadline <= completed_at
    union all select id from fidensa_private.abuse_events where deletion_deadline <= completed_at
    union all select id from fidensa_private.abuse_investigations where deletion_deadline <= completed_at
    union all select id from fidensa_private.operational_logs where deletion_deadline <= completed_at
    union all select id from fidensa_private.provider_events where deletion_deadline <= completed_at
    union all select id from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= completed_at
    union all select id from fidensa_private.privacy_export_artifacts where encrypted_bytes is not null and byte_deletion_deadline <= completed_at
    union all select id from fidensa_private.privacy_requests where closed_record_deletion_deadline is not null and closed_record_deletion_deadline <= completed_at
  ) overdue;

  if started_at > budget_end then
    run_outcome := 'failed'; incident_kind := 'late_start';
  elsif completed_at > budget_end then
    run_outcome := 'failed'; incident_kind := 'late_commit';
  elsif remaining_total > 0 then
    run_outcome := 'failed'; incident_kind := 'overdue_row';
  else
    run_outcome := 'succeeded';
  end if;

  insert into fidensa_private.job_run_attempts (
    job_run_id, attempt, started_at, completed_at, outcome, selected_count,
    deleted_count, remaining_count, retry_of, delay_observed, incident
  ) values (
    run_id, attempt_number, started_at, completed_at, run_outcome,
    selected_total, deleted_total, remaining_total,
    (select id from fidensa_private.job_run_attempts where job_run_id = run_id order by attempt desc limit 1),
    started_at > p_scheduled_bucket, run_outcome = 'failed'
  );

  update fidensa_private.job_runs
    set first_terminal_at = coalesce(first_terminal_at, completed_at),
        outcome = run_outcome, selected_count = selected_total,
        deleted_count = deleted_total, remaining_count = remaining_total,
        expires_at = coalesce(first_terminal_at, completed_at) + interval '90 days',
        updated_at = completed_at
    where id = run_id;

  if incident_kind is not null then
    insert into fidensa_private.retention_incidents (
      job_run_id, incident_class, detected_at, oldest_overdue_at,
      intake_close_due_at, resolution_owner
    ) values (
      run_id, incident_kind, completed_at, oldest_deadline,
      coalesce(oldest_deadline, completed_at) + interval '24 hours', 'scott_bishop'
    ) on conflict (job_run_id, incident_class) do nothing;
  end if;
  return run_id;
end
$function$;


create or replace function fidensa_private.enforce_job_run_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  registered boolean;
begin
  registered := exists (
    select 1 from fidensa_private.job_schedules where job_type = new.job_type
  );
  if tg_op = 'INSERT' then
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
     or (old.first_terminal_at is null and new.first_terminal_at > operation_time) then
    raise exception 'job-run state is immutable outside its terminal retention transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create function fidensa_private.enforce_job_attempt_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  registered boolean;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'job attempts are immutable' using errcode = '55000';
  end if;
  select exists (
    select 1
      from fidensa_private.job_runs run
      join fidensa_private.job_schedules schedule on schedule.job_type = run.job_type
     where run.id = new.job_run_id
  ) into registered;
  if registered and (
       new.started_at > operation_time
       or new.started_at < operation_time - interval '5 minutes'
       or (new.completed_at is not null and (
         new.completed_at < new.started_at or new.completed_at > operation_time
       ))
     ) then
    raise exception 'job attempt times must be bounded by authoritative time' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger job_run_attempts_write_guard
before insert or update or delete on fidensa_private.job_run_attempts
for each row execute function fidensa_private.enforce_job_attempt_write();

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
begin
  select * into run_row from fidensa_private.job_runs where id = run_id;
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
  return null;
end
$function$;

alter table fidensa_private.applications enable always trigger applications_constrained_write;
alter table fidensa_private.retention_incidents enable always trigger retention_incidents_write_guard;
alter table fidensa_private.rubric_versions enable always trigger rubric_versions_state_guard;
alter table fidensa_private.rubric_calibrations enable always trigger rubric_calibrations_immutable;
alter table fidensa_private.job_runs enable always trigger job_runs_write_guard;
alter table fidensa_private.job_run_attempts enable always trigger job_run_attempts_write_guard;

revoke execute on all functions in schema fidensa_private
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

commit;

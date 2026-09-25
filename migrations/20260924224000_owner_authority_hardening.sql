begin;

-- Owner-authority hardening: ordinary owner DML is not authority. Retention eligibility
-- is derived from immutable row deadlines and the database clock; evidence
-- rows cannot be rewritten into permission. DDL remains the explicitly
-- accepted irreducible database-owner boundary.

create function fidensa_private.has_overdue_retention(p_observed_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from fidensa_private.applications
      where lifecycle <> 'transferred' and retention_deadline <= p_observed_at
    union all select 1 from fidensa_private.abuse_events
      where deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.abuse_investigations
      where deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.operational_logs
      where deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.provider_events
      where deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.identity_proofs
      where deletion_deadline is not null and deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.privacy_export_artifacts
      where encrypted_bytes is not null and byte_deletion_deadline <= p_observed_at
    union all select 1 from fidensa_private.privacy_requests
      where closed_record_deletion_deadline is not null
        and closed_record_deletion_deadline <= p_observed_at
  )
$function$;

create or replace function fidensa_private.configure_test_authority(
  p_environment text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_environment <> 'Test' then
    raise exception 'fixed-clock authority is confined to the Test environment' using errcode = '22023';
  end if;
  if not exists (
    select 1 from fidensa_private.runtime_authority
    where singleton and environment = 'Test'
  ) then
    raise exception 'test authority requires an existing Test state' using errcode = '42501';
  end if;
  update fidensa_private.runtime_authority
    set test_clock_at = p_now,
        test_clock_enabled = true,
        retention_monitoring_started_at = least(retention_monitoring_started_at, p_now),
        updated_at = clock_timestamp()
    where singleton and environment = 'Test';
end
$function$;

create or replace function fidensa_private.configure_staged_exercise_environment()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update fidensa_private.runtime_authority
    set environment = 'Staged-production',
        test_clock_at = null,
        test_clock_enabled = false,
        updated_at = clock_timestamp()
    where singleton and environment = 'Test';
  if not found then
    raise exception 'staged exercise transition requires an existing Test state' using errcode = '42501';
  end if;
end
$function$;

create function fidensa_private.enforce_runtime_authority_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'runtime authority is a migration-created singleton' using errcode = '55000';
  end if;

  if old.environment <> 'Test' and (
    new.environment is distinct from old.environment
    or new.test_clock_at is distinct from old.test_clock_at
    or new.test_clock_enabled is distinct from old.test_clock_enabled
    or new.retention_monitoring_started_at is distinct from old.retention_monitoring_started_at
  ) then
    raise exception 'runtime environment, clock, and monitoring start are immutable outside Test' using errcode = '55000';
  end if;

  if old.environment = 'Test' then
    if new.environment not in ('Test', 'Staged-production')
       or new.retention_monitoring_started_at > old.retention_monitoring_started_at then
      raise exception 'Test authority cannot promote environment or defer monitoring' using errcode = '55000';
    end if;
    if new.environment = 'Staged-production'
       and (new.test_clock_enabled or new.test_clock_at is not null) then
      raise exception 'leaving Test must discard fixed-clock authority' using errcode = '55000';
    end if;
  end if;
  return new;
end
$function$;

create trigger runtime_authority_write_guard
before insert or update or delete on fidensa_private.runtime_authority
for each row execute function fidensa_private.enforce_runtime_authority_write();

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
       or new.verified_at is not null or new.terminal_at is not null then
      raise exception 'application insertion must begin pending verification' using errcode = '55000';
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
       or (to_jsonb(new) - array['last_direct_interaction_at','retention_deadline','version','updated_at'])
          is distinct from
          (to_jsonb(old) - array['last_direct_interaction_at','retention_deadline','version','updated_at']) then
      raise exception 'active application updates are limited to direct interaction' using errcode = '55000';
    end if;
  else
    raise exception 'invalid application lifecycle transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create function fidensa_private.enforce_terminal_guard_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  app_record fidensa_private.applications%rowtype;
  operation_time timestamptz := fidensa_private.authoritative_now();
  expected_digest text;
  cleanup_allowed boolean := false;
  retention_allowed boolean := false;
begin
  if tg_op <> 'INSERT' then
    raise exception 'terminal guards are append-only anti-resurrection evidence' using errcode = '55000';
  end if;
  select * into app_record from fidensa_private.applications where id = new.application_id;
  if not found then
    if fidensa_private.authoritative_environment() = 'Test'
       and new.reason = 'synthetic guard review' then
      return new;
    end if;
    raise exception 'terminal guard requires its current application' using errcode = '55000';
  end if;
  select email_rate_digest into expected_digest
    from fidensa_private.verifications
    where application_id = new.application_id order by generation desc limit 1;
  if expected_digest is null or new.email_rate_digest <> expected_digest
     or new.retention_anchor_at <> new.terminal_at
     or new.review_or_disposal_at <> new.terminal_at + interval '24 months'
     or new.terminal_at > operation_time
     or new.terminal_at < operation_time - interval '10 minutes' then
    raise exception 'terminal guard fields must derive from current immutable state' using errcode = '55000';
  end if;

  if new.terminal_state = 'transferred' then
    if app_record.lifecycle <> 'transferred'
       or app_record.terminal_at <> new.terminal_at
       or new.reason <> 'accepted_policy_transfer' then
      raise exception 'transfer guard requires the paired transferred application' using errcode = '55000';
    end if;
    return new;
  end if;

  select exists (
    select 1 from fidensa_private.exercise_controls
    where correlation_id = app_record.correlation_id and state = 'cleanup_pending'
  ) into cleanup_allowed;
  retention_allowed := app_record.lifecycle <> 'transferred'
    and app_record.retention_deadline <= operation_time + interval '25 minutes';
  if new.terminal_state <> 'deleted'
     or not (cleanup_allowed or retention_allowed)
     or new.reason <> (case
       when cleanup_allowed then 'controlled_exercise_cleanup'
       when app_record.lifecycle = 'pending_verification' then 'seven_day_unverified_retention'
       else 'twelve_month_inactive_retention'
     end) then
    raise exception 'deletion guard requires deadline-derived retention or exercise cleanup' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger application_terminal_guards_append_only
before insert or update or delete on fidensa_private.application_terminal_guards
for each row execute function fidensa_private.enforce_terminal_guard_write();

create or replace function fidensa_private.enforce_subscription_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending_confirmation' or new.version <> 1 then
      raise exception 'subscription must begin pending confirmation' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 and not exists (
      select 1 from fidensa_private.applications a
      where a.id = old.application_id
        and a.lifecycle <> 'transferred'
        and a.retention_deadline <= fidensa_private.authoritative_now() + interval '25 minutes'
    ) then
      raise exception 'subscription deletion requires parent retention or cascade' using errcode = '55000';
    end if;
    return old;
  end if;
  if pg_trigger_depth() > 1 and old.application_id is not null
     and new.application_id is null
     and (to_jsonb(new) - array['application_id','updated_at'])
        is not distinct from (to_jsonb(old) - array['application_id','updated_at']) then
    return new;
  end if;
  if old.state = 'deleted' or new.version <> old.version + 1
     or not ((old.state = 'pending_confirmation' and new.state in ('active','deleted'))
             or (old.state = 'active' and new.state in ('unsubscribed','deleted'))
             or (old.state = 'unsubscribed' and new.state = 'deleted')) then
    raise exception 'invalid subscription transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_privacy_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'awaiting_confirmation' or new.version <> 1 then
      raise exception 'privacy request must begin awaiting confirmation' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if (old.closed_record_deletion_deadline is not null
        and old.closed_record_deletion_deadline <= fidensa_private.authoritative_now() + interval '25 minutes')
       or exists (
         select 1 from fidensa_private.exercise_controls
         where correlation_id = old.correlation_id and state = 'cleanup_pending'
       )
       or pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'privacy deletion requires its immutable deadline or exercise cleanup' using errcode = '55000';
  end if;
  if old.state = new.state and old.version = new.version
     and old.confirmation_sent_at is null and new.confirmation_sent_at is not null
     and (to_jsonb(new) - array['confirmation_sent_at','updated_at'])
        is not distinct from (to_jsonb(old) - array['confirmation_sent_at','updated_at']) then
    return new;
  end if;
  if old.state in ('fulfilled','denied','withdrawn','expired')
     or new.version <> old.version + 1 or old.state = new.state then
    raise exception 'invalid privacy-request transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_suppression_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    raise exception 'suppression facts are append-only' using errcode = '55000';
  elsif tg_op = 'DELETE' and not (
    (old.state = 'released'
     and old.review_or_disposal_at <= fidensa_private.authoritative_now() + interval '25 minutes')
    or exists (
      select 1 from fidensa_private.exercise_controls
      where correlation_id = old.correlation_id and state = 'cleanup_pending'
    )
  ) then
    raise exception 'suppression deletion requires released retention or exercise cleanup' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create function fidensa_private.enforce_recovery_evidence_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'retention recovery evidence is append-only' using errcode = '55000';
  end if;
  if new.occurred_at > fidensa_private.authoritative_now()
     or not (new.physical_absence_proved and new.provider_reconciled and new.no_resurrection_proved)
     or (new.action = 'incident_resolved' and not exists (
       select 1 from fidensa_private.retention_incidents where id = new.incident_id
     )) then
    raise exception 'retention recovery must be complete and time-bounded' using errcode = '55000';
  end if;
  return new;
end
$function$;

-- Recovery evidence retains the immutable incident UUID after the 90-day job
-- and incident operational rows expire; insertion still requires that the
-- referenced incident exists at the time the evidence is recorded.
alter table fidensa_private.retention_recoveries
  drop constraint retention_recoveries_incident_id_fkey;

create trigger retention_recoveries_append_only
before insert or update or delete on fidensa_private.retention_recoveries
for each row execute function fidensa_private.enforce_recovery_evidence_write();

create function fidensa_private.enforce_terminal_guard_review_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op <> 'INSERT' then
    raise exception 'terminal-guard review evidence is append-only' using errcode = '55000';
  end if;
  if new.state <> 'pending' or new.resolved_at is not null or new.evidence_digest is not null
     or not exists (
       select 1 from fidensa_private.application_terminal_guards guard
       where guard.application_id = new.application_id
         and guard.review_or_disposal_at = new.review_due_at
         and guard.review_or_disposal_at <= fidensa_private.authoritative_now() + interval '25 minutes'
     ) then
    raise exception 'terminal-guard review must derive from a due immutable guard' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger terminal_guard_reviews_append_only
before insert or update or delete on fidensa_private.terminal_guard_reviews
for each row execute function fidensa_private.enforce_terminal_guard_review_write();

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

create trigger rubric_calibrations_immutable
before update or delete on fidensa_private.rubric_calibrations
for each row execute function fidensa_private.reject_mutation();

create or replace function fidensa_private.validate_runtime_authority()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.intake_closed_at is null and new.intake_closed_at is not null then
    if new.intake_close_reason <> 'unresolved_retention_overdue_24_hours'
       or not exists (
         select 1 from fidensa_private.retention_incidents
         where resolved_at is null and intake_close_due_at <= new.intake_closed_at
       ) then
      raise exception 'intake closure requires an overdue unresolved incident' using errcode = '55000';
    end if;
  elsif old.intake_closed_at is not null and new.intake_closed_at is null then
    if exists (select 1 from fidensa_private.retention_incidents where resolved_at is null)
       or fidensa_private.has_overdue_retention(fidensa_private.authoritative_now())
       or not exists (
         select 1 from fidensa_private.retention_recoveries
         where action = 'intake_reopened' and occurred_at = new.updated_at
           and physical_absence_proved and provider_reconciled and no_resurrection_proved
       ) then
      raise exception 'intake reopening requires recovery, zero incidents, and zero overdue rows' using errcode = '55000';
    end if;
  end if;
  return null;
end
$function$;

create or replace function fidensa_private.enforce_job_run_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1 from fidensa_private.job_schedules where job_type = new.job_type
    ) then
      if new.scheduled_bucket > operation_time
         or new.first_started_at < new.scheduled_bucket
         or new.first_started_at > operation_time then
        raise exception 'job bucket and start must be bounded by authoritative time' using errcode = '55000';
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
     or (old.first_terminal_at is not null
         and new.first_terminal_at <> old.first_terminal_at)
     or new.first_terminal_at > operation_time then
    raise exception 'job-run state is immutable outside its terminal retention transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

drop trigger job_runs_write_guard on fidensa_private.job_runs;
create trigger job_runs_write_guard
before insert or update or delete on fidensa_private.job_runs
for each row execute function fidensa_private.enforce_job_run_write();

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
     or latest_attempt.outcome <> run_row.outcome
     or latest_attempt.selected_count <> run_row.selected_count
     or latest_attempt.deleted_count <> run_row.deleted_count
     or latest_attempt.remaining_count <> run_row.remaining_count then
    raise exception 'committed retention run requires its bounded terminal attempt' using errcode = '55000';
  end if;
  return null;
end
$function$;

-- New triggers must retain their force under replica-mode attempts.
alter table fidensa_private.runtime_authority enable always trigger runtime_authority_write_guard;
alter table fidensa_private.application_terminal_guards enable always trigger application_terminal_guards_append_only;
alter table fidensa_private.retention_recoveries enable always trigger retention_recoveries_append_only;
alter table fidensa_private.terminal_guard_reviews enable always trigger terminal_guard_reviews_append_only;
alter table fidensa_private.rubric_calibrations enable always trigger rubric_calibrations_immutable;
alter table fidensa_private.job_runs enable always trigger job_runs_write_guard;

revoke execute on all functions in schema fidensa_private
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

commit;

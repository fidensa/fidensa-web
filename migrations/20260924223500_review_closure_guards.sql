begin;

-- The Studio/migration owner is a non-superuser object owner. Caller SQL text,
-- PL/pgSQL stack text, role names, and custom GUCs are therefore never treated
-- as write authority. The closure below validates immutable content and paired
-- final database state. DDL remains the irreducible owner boundary and is an
-- acceptance-invalidating action under the accepted workflow contract.

-- Only the migration-time database owner can control a fixed clock, and only
-- in the isolated Test environment.
create table fidensa_private.test_authority_owners (
  role_name name primary key,
  recorded_at timestamptz not null default clock_timestamp()
);
insert into fidensa_private.test_authority_owners (role_name) values (current_user);
alter table fidensa_private.test_authority_owners enable row level security;
revoke all on table fidensa_private.test_authority_owners from public, anon, authenticated, service_role, fidensa_server, fidensa_job, fidensa_mutator;

alter table fidensa_private.runtime_authority
  add constraint runtime_fixed_clock_test_only
  check (not test_clock_enabled or (environment = 'Test' and test_clock_at is not null));

create or replace function fidensa_private.authoritative_now()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case when test_clock_enabled and environment = 'Test'
    then test_clock_at else clock_timestamp() end
  from fidensa_private.runtime_authority where singleton
$function$;

create or replace function fidensa_private.configure_test_authority(p_environment text, p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- EXECUTE is granted only to the role recorded in test_authority_owners.
  -- SECURITY DEFINER intentionally prevents that role from needing table DML.
  if p_environment <> 'Test' then
    raise exception 'fixed-clock authority is confined to the Test environment' using errcode = '22023';
  end if;
  update fidensa_private.runtime_authority
    set environment = 'Test', test_clock_at = p_now, test_clock_enabled = true,
        retention_monitoring_started_at = least(retention_monitoring_started_at, p_now),
        updated_at = clock_timestamp()
    where singleton;
end
$function$;

create function fidensa_private.configure_staged_exercise_environment()
returns void
language sql
security definer
set search_path = ''
as $function$
  update fidensa_private.runtime_authority
    set environment = 'Staged-production', test_clock_at = null,
        test_clock_enabled = false, updated_at = clock_timestamp()
    where singleton
$function$;

-- An unverified request may close without asserting a fabricated verified
-- scope.  Scope remains mandatory for states that actually use it.
do $replace_privacy_scope_check$
declare
  constraint_name name;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'fidensa_private.privacy_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%awaiting_confirmation%verified_scope%';
  if constraint_name is not null then
    execute format('alter table fidensa_private.privacy_requests drop constraint %I', constraint_name);
  end if;
end
$replace_privacy_scope_check$;

alter table fidensa_private.privacy_requests
  add constraint privacy_requests_verified_scope_required check (
    state not in ('verified', 'under_review', 'fulfilled') or verified_scope is not null
  );

alter table fidensa_private.retention_health_reviews
  add column scan_start timestamptz,
  add column scan_end timestamptz,
  add column missed_health_count integer not null default 0 check (missed_health_count >= 0);

alter table fidensa_private.retention_incidents
  drop constraint retention_incidents_incident_class_check,
  add constraint retention_incidents_incident_class_check check (
    incident_class in (
      'late_start', 'late_commit', 'not_started', 'overdue_row',
      'provider_cleanup', 'health_not_started'
    )
  ),
  add column resolution_evidence_digest text
    check (resolution_evidence_digest is null or resolution_evidence_digest ~ '^[0-9a-f]{64}$'),
  add column resolution_note text
    check (resolution_note is null or char_length(resolution_note) between 1 and 500);

create table fidensa_private.retention_recoveries (
  id uuid primary key default gen_random_uuid(),
  actor text not null check (actor = 'scott_bishop'),
  action text not null check (action in ('incident_resolved', 'intake_reopened')),
  incident_id uuid references fidensa_private.retention_incidents(id) on delete restrict,
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  physical_absence_proved boolean not null,
  provider_reconciled boolean not null,
  no_resurrection_proved boolean not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check ((action = 'incident_resolved') = (incident_id is not null))
);

create table fidensa_private.terminal_guard_reviews (
  application_id uuid not null references fidensa_private.application_terminal_guards(application_id) on delete cascade,
  review_due_at timestamptz not null,
  detected_at timestamptz not null,
  owner text not null check (owner = 'scott_bishop'),
  state text not null default 'pending' check (state in ('pending', 'resolved')),
  resolved_at timestamptz,
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  primary key (application_id, review_due_at),
  check ((state = 'resolved') = (resolved_at is not null))
);

alter table fidensa_private.retention_recoveries enable row level security;
alter table fidensa_private.terminal_guard_reviews enable row level security;
revoke all on table fidensa_private.retention_recoveries, fidensa_private.terminal_guard_reviews
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job, fidensa_mutator;

create or replace function fidensa_private.perform_retention_health(p_observed_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  health_id uuid;
  health_bucket timestamptz :=
    (date_trunc('day', p_observed_at at time zone 'UTC') at time zone 'UTC')
    + interval '14 hours';
  scan_start_at timestamptz;
  scan_end_at timestamptz;
  candidate_bucket timestamptz;
  candidate_health timestamptz;
  checked_count integer := 0;
  missed_count integer := 0;
  missed_health integer := 0;
  overdue integer := 0;
  unresolved integer := 0;
  oldest_overdue timestamptz;
  incident_run_id uuid;
  closed boolean;
begin
  if p_observed_at < health_bucket then
    raise exception 'retention health cannot run before its 14:00 UTC bucket' using errcode = '22023';
  end if;

  select coalesce(
      (select max(scan_end) + interval '15 minutes'
       from fidensa_private.retention_health_reviews where scan_end is not null),
      greatest(runtime.retention_monitoring_started_at, p_observed_at - interval '24 hours')
    )
    into scan_start_at
    from fidensa_private.runtime_authority runtime where runtime.singleton;
  scan_start_at := date_trunc('hour', scan_start_at)
    + floor(extract(minute from scan_start_at) / 15) * interval '15 minutes';
  scan_end_at := date_trunc('hour', p_observed_at - interval '5 minutes 1 microsecond')
    + floor(extract(minute from p_observed_at - interval '5 minutes 1 microsecond') / 15) * interval '15 minutes';

  if scan_start_at <= scan_end_at then
    for candidate_bucket in
      select generate_series(scan_start_at, scan_end_at, interval '15 minutes')
    loop
      checked_count := checked_count + 1;
      if not exists (
        select 1 from fidensa_private.job_runs
        where job_type = 'database_retention' and version = 'v1'
          and scheduled_bucket = candidate_bucket
      ) then
        perform fidensa_private.record_missed_retention_bucket(candidate_bucket, p_observed_at);
        missed_count := missed_count + 1;
      end if;
    end loop;
  end if;

  for candidate_health in
    select generate_series(
      coalesce(
        (select max(scheduled_bucket) + interval '1 day'
         from fidensa_private.retention_health_reviews),
        health_bucket
      ),
      health_bucket - interval '1 day',
      interval '1 day'
    )
  loop
    insert into fidensa_private.job_runs (
      job_type, version, scheduled_bucket, selection_cutoff, first_started_at,
      first_terminal_at, outcome, expires_at
    ) values (
      'retention_health', 'v1', candidate_health,
      candidate_health + interval '25 minutes', p_observed_at, p_observed_at,
      'failed', p_observed_at + interval '90 days'
    ) on conflict (job_type, version, scheduled_bucket) do update
      set updated_at = fidensa_private.job_runs.updated_at
    returning id into incident_run_id;
    insert into fidensa_private.retention_incidents (
      job_run_id, incident_class, detected_at, intake_close_due_at, resolution_owner
    ) values (
      incident_run_id, 'health_not_started', p_observed_at,
      candidate_health + interval '24 hours 5 minutes', 'scott_bishop'
    ) on conflict (job_run_id, incident_class) do nothing;
    missed_health := missed_health + 1;
  end loop;

  select count(*), min(deadline) into overdue, oldest_overdue from (
    select retention_deadline as deadline from fidensa_private.applications where lifecycle <> 'transferred' and retention_deadline <= p_observed_at
    union all select deletion_deadline from fidensa_private.abuse_events where deletion_deadline <= p_observed_at
    union all select deletion_deadline from fidensa_private.abuse_investigations where deletion_deadline <= p_observed_at
    union all select deletion_deadline from fidensa_private.operational_logs where deletion_deadline <= p_observed_at
    union all select deletion_deadline from fidensa_private.provider_events where deletion_deadline <= p_observed_at
    union all select deletion_deadline from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= p_observed_at
    union all select byte_deletion_deadline from fidensa_private.privacy_export_artifacts where encrypted_bytes is not null and byte_deletion_deadline <= p_observed_at
    union all select closed_record_deletion_deadline from fidensa_private.privacy_requests where closed_record_deletion_deadline is not null and closed_record_deletion_deadline <= p_observed_at
  ) rows_due;

  if overdue > 0 then
    select id into incident_run_id from fidensa_private.job_runs
      where job_type = 'database_retention' order by scheduled_bucket desc limit 1;
    insert into fidensa_private.retention_incidents
      (job_run_id, incident_class, detected_at, oldest_overdue_at,
       intake_close_due_at, resolution_owner)
    values (incident_run_id, 'overdue_row', p_observed_at, oldest_overdue,
            oldest_overdue + interval '24 hours', 'scott_bishop')
    on conflict (job_run_id, incident_class) do update
      set oldest_overdue_at = least(fidensa_private.retention_incidents.oldest_overdue_at, excluded.oldest_overdue_at),
          intake_close_due_at = least(fidensa_private.retention_incidents.intake_close_due_at, excluded.intake_close_due_at);
  end if;

  closed := fidensa_private.enforce_intake_containment(p_observed_at);
  select count(*) into unresolved from fidensa_private.retention_incidents where resolved_at is null;
  insert into fidensa_private.retention_health_reviews
    (scheduled_bucket, observed_at, scan_start, scan_end, checked_bucket_count,
     missed_bucket_count, missed_health_count, overdue_row_count,
     unresolved_incident_count, intake_closed, outcome)
  values (health_bucket, p_observed_at, scan_start_at, scan_end_at, checked_count,
          missed_count, missed_health, overdue, unresolved, closed,
          case when missed_count > 0 or missed_health > 0 or overdue > 0 or unresolved > 0
            then 'incident' else 'healthy' end)
  on conflict (scheduled_bucket) do update
    set observed_at = excluded.observed_at,
        scan_start = least(fidensa_private.retention_health_reviews.scan_start, excluded.scan_start),
        scan_end = greatest(fidensa_private.retention_health_reviews.scan_end, excluded.scan_end),
        checked_bucket_count = fidensa_private.retention_health_reviews.checked_bucket_count + excluded.checked_bucket_count,
        missed_bucket_count = fidensa_private.retention_health_reviews.missed_bucket_count + excluded.missed_bucket_count,
        missed_health_count = fidensa_private.retention_health_reviews.missed_health_count + excluded.missed_health_count,
        overdue_row_count = excluded.overdue_row_count,
        unresolved_incident_count = excluded.unresolved_incident_count,
        intake_closed = excluded.intake_closed,
        outcome = excluded.outcome
  returning id into health_id;
  return health_id;
end
$function$;

create function fidensa_api.resolve_retention_incident(
  p_incident_id uuid,
  p_evidence_digest text,
  p_note text,
  p_physical_absence_proved boolean,
  p_provider_reconciled boolean,
  p_no_resurrection_proved boolean,
  p_actor text default 'scott_bishop'
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if p_actor <> 'scott_bishop' or p_evidence_digest !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_note), '') is null
     or not p_physical_absence_proved or not p_provider_reconciled
     or not p_no_resurrection_proved then
    raise exception 'complete Scott-owned recovery proof is required' using errcode = '42501';
  end if;
  update fidensa_private.retention_incidents
    set resolved_at = operation_time,
        resolution_evidence_digest = p_evidence_digest,
        resolution_note = p_note
    where id = p_incident_id and resolved_at is null;
  if not found then
    raise exception 'unresolved retention incident required' using errcode = '55000';
  end if;
  insert into fidensa_private.retention_recoveries
    (actor, action, incident_id, evidence_digest, physical_absence_proved,
     provider_reconciled, no_resurrection_proved, occurred_at)
  values (p_actor, 'incident_resolved', p_incident_id, p_evidence_digest,
          true, true, true, operation_time);
end
$function$;

create function fidensa_api.reopen_application_intake(
  p_evidence_digest text,
  p_physical_absence_proved boolean,
  p_provider_reconciled boolean,
  p_no_resurrection_proved boolean,
  p_actor text default 'scott_bishop'
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare overdue_count integer;
begin
  if p_actor <> 'scott_bishop' or p_evidence_digest !~ '^[0-9a-f]{64}$'
     or not p_physical_absence_proved or not p_provider_reconciled
     or not p_no_resurrection_proved then
    raise exception 'complete Scott-owned recovery proof is required' using errcode = '42501';
  end if;
  if exists (select 1 from fidensa_private.retention_incidents where resolved_at is null) then
    raise exception 'all retention incidents must be resolved before reopening intake' using errcode = '55000';
  end if;
  select count(*) into overdue_count from (
    select id from fidensa_private.applications where lifecycle <> 'transferred' and retention_deadline <= operation_time
    union all select id from fidensa_private.abuse_events where deletion_deadline <= operation_time
    union all select id from fidensa_private.abuse_investigations where deletion_deadline <= operation_time
    union all select id from fidensa_private.operational_logs where deletion_deadline <= operation_time
    union all select id from fidensa_private.provider_events where deletion_deadline <= operation_time
    union all select id from fidensa_private.identity_proofs where deletion_deadline is not null and deletion_deadline <= operation_time
    union all select id from fidensa_private.privacy_requests where closed_record_deletion_deadline is not null and closed_record_deletion_deadline <= operation_time
  ) due;
  if overdue_count <> 0 then
    raise exception 'zero overdue rows are required before reopening intake' using errcode = '55000';
  end if;
  update fidensa_private.runtime_authority
    set intake_closed_at = null, intake_close_reason = null, updated_at = operation_time
    where singleton and intake_closed_at is not null;
  if not found then
    raise exception 'application intake is not closed' using errcode = '55000';
  end if;
  insert into fidensa_private.retention_recoveries
    (actor, action, evidence_digest, physical_absence_proved,
     provider_reconciled, no_resurrection_proved, occurred_at)
  values (p_actor, 'intake_reopened', p_evidence_digest, true, true, true, operation_time);
end
$function$;

create function fidensa_api.record_rubric_calibration(
  p_rubric_label text,
  p_findings text,
  p_actor text default 'scott_bishop'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare rubric_record fidensa_private.rubric_versions%rowtype;
declare calibration_id uuid;
begin
  if p_actor <> 'scott_bishop' or char_length(p_findings) not between 1 and 1000 then
    raise exception 'Scott-owned bounded calibration findings are required' using errcode = '42501';
  end if;
  select * into rubric_record from fidensa_private.rubric_versions
    where version_label = p_rubric_label for update;
  if not found then raise exception 'unknown rubric version' using errcode = '22023'; end if;
  insert into fidensa_private.rubric_calibrations
    (rubric_version_id, actor, findings, scored_application_count, recorded_at)
  values (rubric_record.id, p_actor, p_findings,
          rubric_record.scored_since_calibration, operation_time)
  returning id into calibration_id;
  update fidensa_private.rubric_versions
    set scored_since_calibration = 0, calibration_anchor_at = operation_time
    where id = rubric_record.id;
  return calibration_id;
end
$function$;

-- Immutable rows may disappear only as the nested result of a parent cascade.
-- The parent mutation is itself checked against retained data and deadlines.
create or replace function fidensa_private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end
$function$;

create or replace function fidensa_private.enforce_application_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare cleanup_allowed boolean := false;
declare retention_allowed boolean := false;
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
    select exists (
      select 1 from fidensa_private.job_runs
      where job_type = 'database_retention'
        and old.retention_deadline <= selection_cutoff
    ) into retention_allowed;
    if not cleanup_allowed and not retention_allowed then
      raise exception 'application deletion requires retained cleanup or retention state' using errcode = '55000';
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

create or replace function fidensa_private.enforce_verification_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.state not in ('issued', 'delivery_unknown') then
      raise exception 'verification must begin usable' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'verification deletion requires an application cascade' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.state not in ('issued', 'delivery_unknown')
     or new.state not in ('consumed', 'expired', 'superseded')
     or (to_jsonb(new) - array['state','consumed_at','updated_at'])
        is distinct from (to_jsonb(old) - array['state','consumed_at','updated_at']) then
    raise exception 'invalid verification transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

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
      join fidensa_private.job_runs j on j.job_type = 'database_retention'
      where a.id = old.application_id and a.retention_deadline <= j.selection_cutoff
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

create or replace function fidensa_private.enforce_score_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'score deletion requires an application cascade' using errcode = '55000';
    end if;
    return old;
  elsif tg_op = 'INSERT' then
    return new;
  end if;
  if tg_table_name = 'application_score_cohorts' then
    raise exception 'an application scoring cohort is immutable' using errcode = '55000';
  elsif tg_table_name = 'score_sets' then
    if old.superseded_at is null and new.superseded_at is not null
       and (to_jsonb(new) - array['superseded_at','updated_at'])
          is not distinct from (to_jsonb(old) - array['superseded_at','updated_at']) then
      return new;
    end if;
    if new.version = old.version + 1 and old.superseded_at is null
       and new.superseded_at is null
       and (to_jsonb(new) - array['state','assessed_at','version','updated_at'])
          is not distinct from
          (to_jsonb(old) - array['state','assessed_at','version','updated_at']) then
      return new;
    end if;
    raise exception 'invalid score-set revision or supersession' using errcode = '55000';
  elsif old.superseded_at is not null or new.superseded_at is null
        or (to_jsonb(new) - array['superseded_at'])
           is distinct from (to_jsonb(old) - array['superseded_at']) then
    raise exception 'score history may only be superseded once' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_exercise_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare permitted boolean;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'intake_closed' or new.version <> 1 then
      raise exception 'exercise control must begin closed at version one' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.state <> 'cleanup_pending' then
      raise exception 'only cleanup-pending exercise controls may be removed' using errcode = '55000';
    end if;
    return old;
  end if;
  permitted :=
    (old.state = 'intake_closed' and new.state = 'intake_open')
    or (old.state = 'intake_open' and new.state = 'executed')
    or (old.state = 'executed' and new.state = 'review_pending')
    or (old.state = 'review_pending' and new.state = 'review_verified')
    or (old.state in ('review_verified','invalidated') and new.state = 'cleanup_pending')
    or (new.state = 'invalidated' and old.state <> 'cleanup_pending');
  if not permitted or new.version <> old.version + 1 then
    raise exception 'invalid exercise transition or version' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_acceptance_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare permitted boolean;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'candidate' or new.version <> 1 then
      raise exception 'acceptance record must begin as a candidate' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    raise exception 'acceptance records are never deleted' using errcode = '55000';
  end if;
  permitted :=
    (old.state = 'candidate' and new.state in ('accepted','rejected','invalidated'))
    or (old.state in ('accepted','rejected') and new.state in ('invalidated','cleanup_verified'))
    or (old.state = 'invalidated' and new.state = 'invalidated_cleanup_verified');
  if not permitted or new.version <> old.version + 1 then
    raise exception 'invalid acceptance transition or version' using errcode = '55000';
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
    if new is null and old.closed_record_deletion_deadline is not null
       and exists (
         select 1 from fidensa_private.job_runs
         where job_type = 'database_retention'
           and old.closed_record_deletion_deadline <= selection_cutoff
       ) then return old; end if;
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'privacy deletion requires fixed-deadline retention' using errcode = '55000';
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

create or replace function fidensa_private.enforce_privacy_history_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  return new;
end
$function$;

create or replace function fidensa_private.enforce_queue_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare permitted boolean;
begin
  if tg_table_name = 'reviewer_status_history' then return new; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'new' or new.actor <> 'system' or new.reason <> 'address_verified'
       or new.version <> 1 then
      raise exception 'queue entry is verification-derived only' using errcode = '55000';
    end if;
    return new;
  end if;
  permitted := old.state <> 'accepted' and new.state <> old.state;
  if not permitted or new.version <> old.version + 1 or new.actor <> 'scott_bishop'
     or nullif(btrim(new.reason), '') is null then
    raise exception 'invalid queue edge, actor, reason, or version' using errcode = '55000';
  end if;
  return new;
end
$function$;

create function fidensa_private.validate_queue_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare app_id uuid := coalesce(new.application_id, old.application_id);
declare status_row fidensa_private.reviewer_status%rowtype;
declare history_count bigint;
declare invalid_count bigint;
declare latest fidensa_private.reviewer_status_history%rowtype;
begin
  select * into status_row from fidensa_private.reviewer_status where application_id = app_id;
  select count(*) into history_count from fidensa_private.reviewer_status_history where application_id = app_id;
  if status_row.application_id is null and history_count = 0 then return null; end if;
  if status_row.application_id is null or history_count <> status_row.version then
    raise exception 'queue current row and history are not paired' using errcode = '55000';
  end if;
  select * into latest from fidensa_private.reviewer_status_history
    where application_id = app_id order by transition_version desc limit 1;
  if latest.transition_version <> status_row.version or latest.new_state <> status_row.state
     or latest.actor <> status_row.actor or latest.reason <> status_row.reason
     or latest.occurred_at <> status_row.changed_at then
    raise exception 'queue current row does not match its latest history' using errcode = '55000';
  end if;
  select count(*) into invalid_count from (
    select h.*, row_number() over (order by transition_version) as sequence,
           lag(new_state) over (order by transition_version) as previous_state
    from fidensa_private.reviewer_status_history h where application_id = app_id
  ) chain
  where transition_version <> sequence
     or (sequence = 1 and (prior_state is not null or new_state <> 'new'
         or actor <> 'system' or reason <> 'address_verified'))
     or (sequence > 1 and (prior_state is distinct from previous_state
         or prior_state = new_state or prior_state = 'accepted' or actor <> 'scott_bishop'));
  if invalid_count <> 0 or not exists (
    select 1 from fidensa_private.applications
    where id = app_id and lifecycle = 'active'
  ) then
    raise exception 'queue history chain or application lifecycle is invalid' using errcode = '55000';
  end if;
  return null;
end
$function$;

create constraint trigger reviewer_status_pair_complete
after insert or update or delete on fidensa_private.reviewer_status
deferrable initially deferred for each row execute function fidensa_private.validate_queue_pair();
create constraint trigger reviewer_status_history_pair_complete
after insert or update or delete on fidensa_private.reviewer_status_history
deferrable initially deferred for each row execute function fidensa_private.validate_queue_pair();

create function fidensa_private.validate_privacy_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare request_id uuid := case when tg_table_name = 'privacy_requests'
  then coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid)
  else coalesce(
    (to_jsonb(new)->>'privacy_request_id')::uuid,
    (to_jsonb(old)->>'privacy_request_id')::uuid
  )
end;
declare current_row fidensa_private.privacy_requests%rowtype;
declare history_count bigint;
declare latest fidensa_private.privacy_request_history%rowtype;
begin
  select * into current_row from fidensa_private.privacy_requests where id = request_id;
  select count(*) into history_count from fidensa_private.privacy_request_history where privacy_request_id = request_id;
  if current_row.id is null and history_count = 0 then return null; end if;
  if current_row.id is null or history_count <> current_row.version then
    raise exception 'privacy request and history are not paired' using errcode = '55000';
  end if;
  select * into latest from fidensa_private.privacy_request_history
    where privacy_request_id = request_id order by transition_version desc limit 1;
  if latest.transition_version <> current_row.version or latest.new_state <> current_row.state then
    raise exception 'privacy current state does not match history' using errcode = '55000';
  end if;
  return null;
end
$function$;

create constraint trigger privacy_request_pair_complete
after insert or update or delete on fidensa_private.privacy_requests
deferrable initially deferred for each row execute function fidensa_private.validate_privacy_pair();
create constraint trigger privacy_request_history_pair_complete
after insert or update or delete on fidensa_private.privacy_request_history
deferrable initially deferred for each row execute function fidensa_private.validate_privacy_pair();

create function fidensa_private.validate_score_cohort()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare app_id uuid := coalesce(new.application_id, old.application_id);
declare rubric_id uuid := coalesce(new.rubric_version_id, old.rubric_version_id);
begin
  if exists (
    select 1 from fidensa_private.application_score_cohorts
    where application_id = app_id and rubric_version_id = rubric_id
  ) and not exists (
    select 1 from fidensa_private.score_sets
    where application_id = app_id and rubric_version_id = rubric_id
  ) then
    raise exception 'score cohort requires a same-version score set' using errcode = '55000';
  end if;
  return null;
end
$function$;

create constraint trigger score_cohort_complete
after insert or update or delete on fidensa_private.application_score_cohorts
deferrable initially deferred for each row execute function fidensa_private.validate_score_cohort();

create function fidensa_private.enforce_rubric_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and new.scored_since_calibration < old.scored_since_calibration
     and not (new.scored_since_calibration = 0 and exists (
       select 1 from fidensa_private.rubric_calibrations
       where rubric_version_id = new.id
         and scored_application_count = old.scored_since_calibration
         and recorded_at = new.calibration_anchor_at
     ) and new.calibration_anchor_at > old.calibration_anchor_at) then
    raise exception 'calibration reset requires its calibration row' using errcode = '55000';
  end if;
  return new;
end
$function$;
create trigger rubric_versions_state_guard
before update on fidensa_private.rubric_versions
for each row execute function fidensa_private.enforce_rubric_state();

create function fidensa_private.validate_active_rubric()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare active_id uuid;
begin
  select id into active_id from fidensa_private.rubric_versions where active;
  if active_id is null or (select count(*) from fidensa_private.rubric_versions where active) <> 1
     or (select count(*) from fidensa_private.rubric_criteria where rubric_version_id = active_id) <> 5 then
    raise exception 'one complete five-criterion active rubric is required' using errcode = '55000';
  end if;
  if exists (
    select 1
    from fidensa_private.reviewer_status rs
    join fidensa_private.applications a on a.id = rs.application_id
      and a.lifecycle = 'active'
      and a.retention_deadline > fidensa_private.authoritative_now()
      and a.verified_at <= (
        select created_at from fidensa_private.rubric_versions where id = active_id
      )
    where not exists (
      select 1 from fidensa_private.rubric_rescore_requirements r
      where r.application_id = a.id and r.rubric_version_id = active_id
    ) and (select material_change from fidensa_private.rubric_versions where id = active_id)
  ) then
    raise exception 'material rubric activation requires every active candidate rescore' using errcode = '55000';
  end if;
  return null;
end
$function$;

create constraint trigger rubric_active_complete
after insert or update or delete on fidensa_private.rubric_versions
deferrable initially deferred for each row execute function fidensa_private.validate_active_rubric();
create constraint trigger rubric_criteria_active_complete
after insert or update or delete on fidensa_private.rubric_criteria
deferrable initially deferred for each row execute function fidensa_private.validate_active_rubric();
create constraint trigger rubric_rescore_active_complete
after insert or update or delete on fidensa_private.rubric_rescore_requirements
deferrable initially deferred for each row execute function fidensa_private.validate_active_rubric();

create function fidensa_private.validate_runtime_authority()
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
       or not exists (
         select 1 from fidensa_private.retention_recoveries
         where action = 'intake_reopened' and occurred_at = new.updated_at
           and physical_absence_proved and provider_reconciled and no_resurrection_proved
       ) then
      raise exception 'intake reopening requires complete recovery and zero incidents' using errcode = '55000';
    end if;
  end if;
  return null;
end
$function$;
create constraint trigger runtime_authority_pair_complete
after update on fidensa_private.runtime_authority
deferrable initially deferred for each row execute function fidensa_private.validate_runtime_authority();

create function fidensa_private.enforce_suppression_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    raise exception 'suppression facts are append-only' using errcode = '55000';
  elsif tg_op = 'DELETE' and not (
    (old.state = 'released' and exists (
      select 1 from fidensa_private.job_runs
      where job_type = 'database_retention'
        and old.review_or_disposal_at <= selection_cutoff
    )) or exists (
      select 1 from fidensa_private.exercise_controls
      where correlation_id = old.correlation_id and state = 'cleanup_pending'
    )
  ) then
    raise exception 'suppression deletion requires released retention or exercise cleanup' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;
create trigger suppressions_append_only
before update or delete on fidensa_private.suppressions
for each row execute function fidensa_private.enforce_suppression_append_only();

create function fidensa_private.enforce_communication_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    raise exception 'communication facts are append-only; outcomes append separately' using errcode = '55000';
  elsif pg_trigger_depth() <= 1 then
    raise exception 'communication deletion requires an owning-record cascade' using errcode = '55000';
  end if;
  return old;
end
$function$;
create trigger communications_append_only
before update or delete on fidensa_private.communications
for each row execute function fidensa_private.enforce_communication_append_only();

create function fidensa_private.enforce_incident_write()
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
  elsif tg_op = 'UPDATE' and old.resolved_at is not null then
    raise exception 'resolved retention incidents are immutable' using errcode = '55000';
  end if;
  return new;
end
$function$;
create trigger retention_incidents_write_guard
before update or delete on fidensa_private.retention_incidents
for each row execute function fidensa_private.enforce_incident_write();

create function fidensa_private.validate_incident_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.resolved_at is not null and old.resolved_at is null and not exists (
    select 1 from fidensa_private.retention_recoveries
    where incident_id = new.id and action = 'incident_resolved'
      and occurred_at = new.resolved_at
      and evidence_digest = new.resolution_evidence_digest
      and physical_absence_proved and provider_reconciled and no_resurrection_proved
  ) then
    raise exception 'incident resolution requires its recovery row' using errcode = '55000';
  end if;
  return null;
end
$function$;
create constraint trigger retention_incident_pair_complete
after update on fidensa_private.retention_incidents
deferrable initially deferred for each row execute function fidensa_private.validate_incident_pair();

create function fidensa_private.enforce_job_run_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.expires_at is null or not exists (
      select 1 from fidensa_private.job_runs active_run
      where active_run.job_type = 'database_retention'
        and old.expires_at <= active_run.selection_cutoff
    ) then
      raise exception 'job run deletion requires its fixed expiry' using errcode = '55000';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'updated_at') is not distinct from (to_jsonb(old) - 'updated_at') then
    return new;
  end if;
  if old.job_type <> 'database_retention' then
    raise exception 'non-retention job runs are append-only' using errcode = '55000';
  end if;
  return new;
end
$function$;
create trigger job_runs_write_guard
before update or delete on fidensa_private.job_runs
for each row execute function fidensa_private.enforce_job_run_write();

create function fidensa_private.validate_job_run_pair()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare run_id uuid := case when tg_table_name = 'job_runs'
  then coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid)
  else coalesce((to_jsonb(new)->>'job_run_id')::uuid, (to_jsonb(old)->>'job_run_id')::uuid)
end;
declare run_row fidensa_private.job_runs%rowtype;
begin
  select * into run_row from fidensa_private.job_runs where id = run_id;
  if run_row.id is null or run_row.job_type <> 'database_retention' or run_row.outcome = 'started' then
    return null;
  end if;
  if not exists (
    select 1 from fidensa_private.job_run_attempts attempt
    where attempt.job_run_id = run_id
  ) then
    raise exception 'terminal retention job requires its matching attempt' using errcode = '55000';
  end if;
  return null;
end
$function$;
create constraint trigger job_run_pair_complete
after insert or update or delete on fidensa_private.job_runs
deferrable initially deferred for each row execute function fidensa_private.validate_job_run_pair();
create constraint trigger job_run_attempt_pair_complete
after insert or update or delete on fidensa_private.job_run_attempts
deferrable initially deferred for each row execute function fidensa_private.validate_job_run_pair();

-- Replication mode cannot silently skip governed checks. A non-superuser also
-- lacks authority to set session_replication_role, and every task trigger is
-- marked ENABLE ALWAYS as a second, independently inspectable control.
do $always_enable_task_triggers$
declare trigger_row record;
begin
  for trigger_row in
    select n.nspname, c.relname, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'fidensa_private' and not t.tgisinternal
  loop
    execute format('alter table %I.%I enable always trigger %I',
                   trigger_row.nspname, trigger_row.relname, trigger_row.tgname);
  end loop;
end
$always_enable_task_triggers$;

-- PostgreSQL grants PUBLIC function execution by default.  Default-privilege
-- changes are not retroactive, so revoke every private function explicitly.
revoke execute on all functions in schema fidensa_private from public;
revoke execute on all functions in schema fidensa_private from anon, authenticated, service_role, fidensa_server, fidensa_job, fidensa_mutator;

revoke execute on all functions in schema fidensa_api from public, anon, authenticated, fidensa_mutator;
grant execute on function fidensa_api.submit_application(boolean, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) to fidensa_server;
grant execute on function fidensa_api.verify_application(text, text) to fidensa_server;
grant execute on function fidensa_api.create_privacy_request(text, text, text, text, text, text) to fidensa_server;
grant execute on function fidensa_api.resend_application_verification(text, text, text, text) to fidensa_server;
grant execute on function fidensa_api.record_provider_event(text, text, timestamptz, text, uuid, text, text, uuid) to fidensa_server;
grant execute on function fidensa_api.authorize_fixture_operation(uuid, text) to fidensa_server;
grant execute on function fidensa_api.run_current_retention() to fidensa_job;
grant execute on function fidensa_api.run_retention_health() to fidensa_job;

do $owner_execution$
declare owner_name text := current_user;
begin
  execute format('grant execute on function fidensa_private.configure_test_authority(text,timestamptz) to %I', owner_name);
  execute format('grant execute on function fidensa_private.configure_staged_exercise_environment() to %I', owner_name);
  execute format('grant execute on function fidensa_api.resolve_retention_incident(uuid,text,text,boolean,boolean,boolean,text) to %I', owner_name);
  execute format('grant execute on function fidensa_api.reopen_application_intake(text,boolean,boolean,boolean,text) to %I', owner_name);
  execute format('grant execute on function fidensa_api.record_rubric_calibration(text,text,text) to %I', owner_name);
end
$owner_execution$;

-- The earlier migrations used this compatibility role only while defining the
-- first-generation guards.  It owns no objects after the single-owner rewrite
-- and must not remain as an assumable alternate DML identity.
revoke all privileges on all tables in schema fidensa_private from fidensa_mutator;
revoke all privileges on all sequences in schema fidensa_private from fidensa_mutator;
revoke all privileges on all functions in schema fidensa_private from fidensa_mutator;
revoke all privileges on all functions in schema fidensa_api from fidensa_mutator;
revoke all on schema fidensa_private, fidensa_api from fidensa_mutator;
drop role fidensa_mutator;

commit;

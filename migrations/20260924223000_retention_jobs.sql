begin;

create function fidensa_api.transfer_accepted_application(
  p_application_id uuid,
  p_policy_identity text,
  p_actor text default 'scott_bishop',
  p_now timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare app_record fidensa_private.applications%rowtype;
declare rate_digest text;
begin
  p_now := fidensa_private.authoritative_now();
  if p_actor <> 'scott_bishop' or p_policy_identity !~ '^accepted-application-transfer-policy-v1([:/@].+)?$' then
    raise exception 'accepted transfer requires Scott and an accepted application-transfer policy identity' using errcode = '42501';
  end if;
  select a.* into app_record
    from fidensa_private.applications a
    join fidensa_private.reviewer_status rs on rs.application_id = a.id
    where a.id = p_application_id and a.lifecycle = 'active' and rs.state = 'accepted'
    for update of a;
  if not found or p_now >= app_record.retention_deadline then
    raise exception 'accepted transfer must occur before the application deadline' using errcode = '55000';
  end if;
  perform set_config('fidensa.application_write', p_application_id::text, true);
  update fidensa_private.applications
    set lifecycle = 'transferred', terminal_at = p_now,
        transfer_policy_identity = p_policy_identity, transfer_recorded_at = p_now,
        version = version + 1, updated_at = p_now
    where id = p_application_id;
  select email_rate_digest into rate_digest from fidensa_private.verifications
    where application_id = p_application_id order by generation desc limit 1;
  insert into fidensa_private.application_terminal_guards
    (application_id, email_rate_digest, digest_key_id, terminal_state, terminal_at, reason,
     retention_anchor_at, review_or_disposal_at)
  values (p_application_id, rate_digest, 'server-hmac-v1',
          'transferred', p_now, 'accepted_policy_transfer', p_now, p_now + interval '24 months');
  update fidensa_private.application_operation_guards
    set result_class = 'terminal', terminal_at = p_now where application_id = p_application_id;
end
$function$;

create function fidensa_private.perform_retention(
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

  delete from fidensa_private.job_runs
    where expires_at is not null and expires_at <= cutoff
      and id <> run_id;

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

create function fidensa_private.record_missed_retention_bucket(
  p_scheduled_bucket timestamptz,
  p_detected_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare run_id uuid;
begin
  if p_detected_at <= p_scheduled_bucket + interval '5 minutes' then
    raise exception 'a bucket is not missed until its five-minute budget passes' using errcode = '22023';
  end if;
  insert into fidensa_private.job_runs (
    job_type, version, scheduled_bucket, selection_cutoff, first_started_at,
    first_terminal_at, outcome, expires_at
  ) values (
    'database_retention', 'v1', p_scheduled_bucket,
    p_scheduled_bucket + interval '25 minutes', p_detected_at, p_detected_at,
    'failed', p_detected_at + interval '90 days'
  )
  on conflict (job_type, version, scheduled_bucket) do update
    set updated_at = fidensa_private.job_runs.updated_at
  returning id into run_id;
  insert into fidensa_private.job_run_attempts (
    job_run_id, attempt, started_at, completed_at, outcome,
    delay_observed, incident
  ) values (run_id, 1, p_detected_at, p_detected_at, 'failed', true, true)
  on conflict (job_run_id, attempt) do nothing;
  insert into fidensa_private.retention_incidents (
    job_run_id, incident_class, detected_at, intake_close_due_at, resolution_owner
  ) values (run_id, 'not_started', p_detected_at,
            p_scheduled_bucket + interval '24 hours 5 minutes', 'scott_bishop')
  on conflict (job_run_id, incident_class) do nothing;
  return run_id;
end
$function$;

create function fidensa_private.enforce_intake_containment(p_observed_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare must_close boolean;
begin
  select exists (
    select 1 from fidensa_private.retention_incidents
    where resolved_at is null and intake_close_due_at is not null
      and intake_close_due_at <= p_observed_at
  ) into must_close;
  if must_close then
    update fidensa_private.runtime_authority
      set intake_closed_at = coalesce(intake_closed_at, p_observed_at),
          intake_close_reason = coalesce(intake_close_reason, 'unresolved_retention_overdue_24_hours'),
          updated_at = p_observed_at
      where singleton;
  end if;
  return must_close or exists (
    select 1 from fidensa_private.runtime_authority
    where singleton and intake_closed_at is not null
  );
end
$function$;

create function fidensa_api.run_current_retention()
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  observed_at timestamptz := fidensa_private.authoritative_now();
  bucket timestamptz;
  run_id uuid;
begin
  bucket := date_trunc('hour', observed_at)
    + (floor(extract(minute from observed_at) / 15) * interval '15 minutes');
  run_id := fidensa_private.perform_retention(bucket);
  perform fidensa_private.enforce_intake_containment(fidensa_private.authoritative_now());
  return run_id;
end
$function$;

create function fidensa_private.perform_retention_health(p_observed_at timestamptz)
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
  scan_start timestamptz;
  scan_end timestamptz;
  candidate_bucket timestamptz;
  checked_count integer := 0;
  missed_count integer := 0;
  overdue integer := 0;
  unresolved integer := 0;
  oldest_overdue timestamptz;
  incident_run_id uuid;
  closed boolean;
begin
  if p_observed_at < health_bucket then
    raise exception 'retention health cannot run before its 14:00 UTC bucket' using errcode = '22023';
  end if;

  select greatest(retention_monitoring_started_at, p_observed_at - interval '24 hours')
    into scan_start from fidensa_private.runtime_authority where singleton;
  scan_start := date_trunc('hour', scan_start)
    + floor(extract(minute from scan_start) / 15) * interval '15 minutes';
  scan_end := date_trunc('hour', p_observed_at - interval '5 minutes')
    + floor(extract(minute from p_observed_at - interval '5 minutes') / 15) * interval '15 minutes';

  if scan_start <= scan_end then
    for candidate_bucket in
      select generate_series(scan_start, scan_end, interval '15 minutes')
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
    (scheduled_bucket, observed_at, checked_bucket_count, missed_bucket_count,
     overdue_row_count, unresolved_incident_count, intake_closed, outcome)
  values (health_bucket, p_observed_at, checked_count, missed_count, overdue,
          unresolved, closed, case when missed_count > 0 or overdue > 0 or unresolved > 0
            then 'incident' else 'healthy' end)
  on conflict (scheduled_bucket) do update
    set observed_at = excluded.observed_at,
        checked_bucket_count = excluded.checked_bucket_count,
        missed_bucket_count = excluded.missed_bucket_count,
        overdue_row_count = excluded.overdue_row_count,
        unresolved_incident_count = excluded.unresolved_incident_count,
        intake_closed = excluded.intake_closed,
        outcome = excluded.outcome
  returning id into health_id;
  return health_id;
end
$function$;

create function fidensa_api.run_retention_health()
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select fidensa_private.perform_retention_health(fidensa_private.authoritative_now())
$function$;

-- Install pg_cron only when the host advertises it. The immutable schedule
-- registry above remains testable on disposable PostgreSQL builds without the
-- Supabase extension; Supabase projects take this branch during migration.
do $cron_install$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    if not exists (select 1 from cron.job where jobname = 'fidensa-database-retention-v1') then
      perform cron.schedule(
        'fidensa-database-retention-v1',
        '*/15 * * * *',
        'select fidensa_api.run_current_retention()'
      );
    end if;
    if not exists (select 1 from cron.job where jobname = 'fidensa-retention-health-v1') then
      perform cron.schedule(
        'fidensa-retention-health-v1',
        '0 14 * * *',
        'select fidensa_api.run_retention_health()'
      );
    end if;
    if not exists (select 1 from cron.job where jobname = 'fidensa-cron-history-retention-v1') then
      perform cron.schedule(
        'fidensa-cron-history-retention-v1',
        '30 14 * * *',
        $$delete from cron.job_run_details where end_time < clock_timestamp() - interval '90 days'$$
      );
    end if;
  end if;
end
$cron_install$;

revoke all on function fidensa_private.perform_retention(timestamptz) from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on function fidensa_private.record_missed_retention_bucket(timestamptz, timestamptz) from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on function fidensa_private.perform_retention_health(timestamptz) from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on function fidensa_private.enforce_intake_containment(timestamptz) from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on function fidensa_api.transfer_accepted_application(uuid, text, text, timestamptz) from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on function fidensa_api.run_current_retention() from public, anon, authenticated, fidensa_server;
revoke all on function fidensa_api.run_retention_health() from public, anon, authenticated, fidensa_server;
grant execute on function fidensa_api.run_current_retention() to fidensa_job;
grant execute on function fidensa_api.run_retention_health() to fidensa_job;

-- The compatibility mutator role owns no objects.  It intentionally retains
-- the grants used by older local tooling so the closure migration can prove
-- that SET ROLE plus forged transaction settings still cannot authorize DML.
grant usage on schema fidensa_private, fidensa_api to fidensa_mutator;
grant select, insert, update, delete on all tables in schema fidensa_private to fidensa_mutator;
grant usage, select on all sequences in schema fidensa_private to fidensa_mutator;
grant execute on all functions in schema fidensa_private to fidensa_mutator;
grant execute on all functions in schema fidensa_api to fidensa_mutator;

commit;

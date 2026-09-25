begin;

-- Bind replay and anti-resurrection rows to the synthetic exercise that
-- created them so cleanup can prove that the acceptance record is the sole
-- retained exercise artifact.
alter table fidensa_private.application_operation_guards
  add column correlation_id uuid;
alter table fidensa_private.application_terminal_guards
  add column correlation_id uuid;
alter table fidensa_private.application_terminal_guards
  add constraint application_terminal_guards_exercise_correlation
  foreign key (correlation_id)
  references fidensa_private.exercise_controls(correlation_id)
  on delete cascade;
alter table fidensa_private.job_runs
  add constraint job_runs_exercise_correlation
  foreign key (correlation_id)
  references fidensa_private.exercise_controls(correlation_id)
  on delete cascade;
alter table fidensa_private.exercise_controls
  drop constraint exercise_controls_check1;
alter table fidensa_private.exercise_controls
  add constraint exercise_controls_execution_state check (
    state = 'invalidated'
    or ((state in ('executed', 'review_pending', 'review_verified', 'cleanup_pending'))
        = (executed_at is not null))
  );

create function fidensa_private.bind_exercise_correlation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.correlation_id is null
     and fidensa_private.authoritative_environment() = 'Staged-production' then
    if tg_table_name = 'application_terminal_guards' then
      select correlation_id into new.correlation_id
        from fidensa_private.applications where id = new.application_id;
    else
      select correlation_id into new.correlation_id
        from fidensa_private.exercise_controls
       where state = 'intake_open'
         and opens_at <= fidensa_private.authoritative_now()
         and expires_at > fidensa_private.authoritative_now();
    end if;
  end if;
  return new;
end
$function$;

create trigger bind_operation_guard_exercise_correlation
before insert on fidensa_private.application_operation_guards
for each row execute function fidensa_private.bind_exercise_correlation();
create trigger bind_terminal_guard_exercise_correlation
before insert on fidensa_private.application_terminal_guards
for each row execute function fidensa_private.bind_exercise_correlation();
alter table fidensa_private.application_operation_guards
  enable always trigger bind_operation_guard_exercise_correlation;
alter table fidensa_private.application_terminal_guards
  enable always trigger bind_terminal_guard_exercise_correlation;

revoke all on function fidensa_private.bind_exercise_correlation()
  from public, anon, authenticated, service_role;

create function fidensa_private.require_live_exercise_correlation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.correlation_id is not null
     and not exists (
       select 1 from fidensa_private.exercise_controls
        where correlation_id = new.correlation_id
     ) then
    raise exception 'correlated provider event requires a live exercise control' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger require_provider_event_exercise_correlation
before insert on fidensa_private.provider_events
for each row execute function fidensa_private.require_live_exercise_correlation();
alter table fidensa_private.provider_events
  enable always trigger require_provider_event_exercise_correlation;
revoke all on function fidensa_private.require_live_exercise_correlation()
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

create or replace function fidensa_private.enforce_terminal_guard_write()
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
  privacy_allowed boolean := false;
begin
  if tg_op = 'DELETE' then
    if old.correlation_id is not null
       and pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'terminal guards are append-only anti-resurrection evidence' using errcode = '55000';
  elsif tg_op <> 'INSERT' then
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
  select exists (
    select 1 from fidensa_private.privacy_application_authorizations
     where application_id = app_record.id and operation = 'deletion'
       and consumed_at is null and expires_at > operation_time
  ) into privacy_allowed;
  retention_allowed := app_record.lifecycle <> 'transferred'
    and app_record.retention_deadline <= operation_time + interval '25 minutes';
  if new.terminal_state <> 'deleted'
     or not (privacy_allowed or cleanup_allowed or retention_allowed)
     or new.reason <> (case
       when privacy_allowed then 'verified_privacy_deletion'
       when cleanup_allowed then 'controlled_exercise_cleanup'
       when app_record.lifecycle = 'pending_verification' then 'seven_day_unverified_retention'
       else 'twelve_month_inactive_retention'
     end) then
    raise exception 'deletion guard requires governed authority' using errcode = '55000';
  end if;
  return new;
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
    if old.correlation_id is not null
       and pg_trigger_depth() > 1 then
      return old;
    end if;
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

drop function fidensa_api.submit_application_intake(
  boolean, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, boolean, text
);

create function fidensa_api.submit_application_intake(
  p_synthetic boolean,
  p_canonical_email text,
  p_delivery_email text,
  p_operation_digest text,
  p_credential_digest text,
  p_ip_digest text,
  p_email_digest text,
  p_applicant_name text,
  p_role_function text,
  p_context text,
  p_organization text,
  p_intended_use_case text,
  p_workflow_stage text,
  p_deployment_preference text,
  p_evaluation_timeline text,
  p_design_partner_willingness text,
  p_integration_constraints text,
  p_referral_source text,
  p_additional_context text,
  p_notice_version text,
  p_marketing_selected boolean,
  p_consent_text_version text,
  p_exercise_correlation_id uuid,
  p_exercise_recipient text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_uuid uuid;
  delivery_operation uuid;
  matching_gate_count integer;
begin
  if fidensa_private.authoritative_environment() = 'Staged-production' then
    select count(*) into matching_gate_count
      from fidensa_private.exercise_controls
     where state = 'intake_open'
       and correlation_id = p_exercise_correlation_id
       and exact_recipient = p_exercise_recipient
       and exact_recipient = p_canonical_email
       and opens_at <= fidensa_private.authoritative_now()
       and expires_at > fidensa_private.authoritative_now();
    if matching_gate_count <> 1 then return null; end if;
  elsif p_exercise_correlation_id is not null or p_exercise_recipient is not null then
    return null;
  end if;

  application_uuid := fidensa_api.submit_application(
    p_synthetic, p_canonical_email, p_delivery_email, p_operation_digest,
    p_credential_digest, p_ip_digest, p_email_digest, p_applicant_name,
    p_role_function, p_context, p_organization, p_intended_use_case,
    p_workflow_stage, p_deployment_preference, p_evaluation_timeline,
    p_design_partner_willingness, p_integration_constraints, p_referral_source,
    p_additional_context, p_notice_version, p_marketing_selected,
    p_consent_text_version
  );
  if application_uuid is null then return null; end if;

  select operation_id into strict delivery_operation
    from fidensa_private.communications
   where application_id = application_uuid
     and type = 'verification' and class = 'automatic';
  insert into fidensa_private.application_message_outbox (
    communication_id, state, attempt_count, first_attempt_at, available_at,
    lease_expires_at, created_at, updated_at
  )
  select id, 'claimed', 1, fidensa_private.authoritative_now(),
         fidensa_private.authoritative_now(),
         fidensa_private.authoritative_now() + interval '5 minutes',
         fidensa_private.authoritative_now(), fidensa_private.authoritative_now()
    from fidensa_private.communications where operation_id = delivery_operation;
  insert into fidensa_private.communication_outcomes (
    communication_id, prior_outcome, new_outcome, occurred_at
  )
  select id, 'intended', 'submitted', fidensa_private.authoritative_now()
    from fidensa_private.communications where operation_id = delivery_operation;
  return jsonb_build_object(
    'applicationId', application_uuid,
    'deliveryEmail', p_delivery_email,
    'operationId', delivery_operation
  );
end
$function$;

create or replace function fidensa_api.verify_application_intake(
  p_credential_digest text,
  p_ip_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_uuid uuid;
  application_correlation uuid;
  delivery_address text;
  receipt_operation uuid;
  reviewer_operation uuid;
  matching_gate_count integer;
begin
  select v.application_id, a.correlation_id
    into application_uuid, application_correlation
    from fidensa_private.verifications v
    join fidensa_private.applications a on a.id = v.application_id
   where v.credential_digest = p_credential_digest
     and v.purpose = 'application_verification'
     and v.state in ('issued', 'delivery_unknown');

  if fidensa_private.authoritative_environment() = 'Staged-production' then
    select count(*) into matching_gate_count
      from fidensa_private.exercise_controls
     where correlation_id = application_correlation
       and state in ('executed', 'review_pending')
       and expires_at > fidensa_private.authoritative_now();
    if application_uuid is null or matching_gate_count <> 1 then return null; end if;
  end if;

  if not fidensa_api.verify_application(p_credential_digest, p_ip_digest) then
    return null;
  end if;

  select delivery_email into strict delivery_address
    from fidensa_private.applications where id = application_uuid;
  select operation_id into strict receipt_operation
    from fidensa_private.communications
   where application_id = application_uuid and type = 'receipt';
  select operation_id into strict reviewer_operation
    from fidensa_private.communications
   where application_id = application_uuid and type = 'reviewer_notification';
  insert into fidensa_private.application_message_outbox (
    communication_id, available_at, created_at, updated_at
  )
  select id, fidensa_private.authoritative_now(), fidensa_private.authoritative_now(),
         fidensa_private.authoritative_now()
    from fidensa_private.communications
   where operation_id in (receipt_operation, reviewer_operation);
  return jsonb_build_object(
    'applicationId', application_uuid,
    'deliveryEmail', delivery_address,
    'receiptOperationId', receipt_operation,
    'reviewerOperationId', reviewer_operation
  );
end
$function$;

create or replace function fidensa_private.enforce_subscription_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare cleanup_allowed boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending_confirmation' or new.version <> 1 then
      raise exception 'subscription must begin pending confirmation' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      select exists (
        select 1 from fidensa_private.exercise_controls
        where correlation_id = old.correlation_id and state = 'cleanup_pending'
      ) into cleanup_allowed;
      if cleanup_allowed then
        return old;
      elsif exists (
        select 1 from fidensa_private.privacy_subscription_authorizations authz
        join fidensa_private.privacy_requests request
          on request.id = authz.privacy_request_id
        where authz.subscription_id = old.id
          and authz.consumed_at is null
          and authz.expires_at > fidensa_private.authoritative_now()
          and request.state = 'under_review'
          and request.request_type = 'deletion'
          and ('all' = any(request.verified_scope)
               or 'subscription' = any(request.verified_scope))
      ) then
        update fidensa_private.privacy_subscription_authorizations
           set consumed_at = fidensa_private.authoritative_now()
         where subscription_id = old.id and consumed_at is null;
      elsif not exists (
        select 1 from fidensa_private.applications a
        where a.id = old.application_id
          and a.lifecycle <> 'transferred'
          and a.retention_deadline <= fidensa_private.authoritative_now() + interval '25 minutes'
      ) then
        raise exception 'subscription deletion requires parent retention, exercise cleanup, verified privacy scope, or cascade' using errcode = '55000';
      end if;
    end if;
    return old;
  end if;
  if pg_trigger_depth() > 1 and old.application_id is not null
     and new.application_id is null
     and (to_jsonb(new) - array['application_id','updated_at'])
        is not distinct from (to_jsonb(old) - array['application_id','updated_at']) then
    return new;
  end if;
  if old.state = 'active' and new.state = 'active'
     and new.version = old.version + 1
     and (to_jsonb(new) - array['reviewed_at','review_identity','review_outcome','next_review_due_at','version','updated_at'])
       is not distinct from
         (to_jsonb(old) - array['reviewed_at','review_identity','review_outcome','next_review_due_at','version','updated_at']) then
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

create or replace function fidensa_api.cleanup_exercise(
  p_exercise_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare exercise_record fidensa_private.exercise_controls%rowtype;
declare acceptance_record fidensa_private.acceptance_records%rowtype;
declare target_state text;
begin
  p_now := fidensa_private.authoritative_now();
  select * into exercise_record from fidensa_private.exercise_controls
    where id = p_exercise_id and state = 'cleanup_pending' for update;
  if not found then raise exception 'cleanup_pending exercise required' using errcode = '55000'; end if;
  select * into acceptance_record from fidensa_private.acceptance_records
    where correlation_id = exercise_record.correlation_id for update;

  update fidensa_private.fixture_verifiers
    set state = 'revoked', revoked_at = coalesce(revoked_at, p_now)
    where exercise_control_id = p_exercise_id and state <> 'revoked';

  perform set_config('fidensa.application_write', 'retention', true);
  perform set_config('fidensa.verification_write', 'retention', true);
  perform set_config('fidensa.privacy_write', 'retention', true);
  perform set_config('fidensa.governed_delete', 'on', true);
  perform set_config('fidensa.subscription_write', 'retention', true);
  perform set_config('fidensa.score_write', 'retention', true);

  -- The subscription foreign key is ON DELETE SET NULL. Key cleanup on the
  -- exercise's exact allowlisted recipient so a provider snapshot already
  -- orphaned by subscription deletion is still removed without widening the
  -- deletion to unrelated contacts.
  delete from fidensa_private.provider_contact_state
   where canonical_email = exercise_record.exact_recipient;
  delete from fidensa_private.application_operation_guards
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.application_operation_guards guard
    using fidensa_private.applications application
   where guard.application_id = application.id
     and application.correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.applications
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.subscriptions
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.suppressions
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.provider_events
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.abuse_events
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.operational_logs
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.privacy_requests
   where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.fixture_verifiers
   where exercise_control_id = p_exercise_id;

  target_state := case when acceptance_record.state = 'invalidated'
    then 'invalidated_cleanup_verified' else 'cleanup_verified' end;
  perform fidensa_api.transition_acceptance_record(
    acceptance_record.id, acceptance_record.version, target_state,
    null, null, p_now
  );
  perform set_config('fidensa.exercise_write', p_exercise_id::text, true);
  delete from fidensa_private.exercise_controls where id = p_exercise_id;
end
$function$;

revoke execute on function fidensa_api.submit_application_intake(
  boolean, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, boolean, text,
  uuid, text
) from public, anon, authenticated;
grant execute on function fidensa_api.submit_application_intake(
  boolean, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, boolean, text,
  uuid, text
) to fidensa_server;
revoke execute on function fidensa_api.submit_application(
  boolean, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, boolean, text
) from fidensa_server;

commit;

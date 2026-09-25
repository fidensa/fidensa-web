begin;

create function fidensa_api.resend_application_verification(
  p_canonical_email text,
  p_credential_digest text,
  p_ip_digest text,
  p_email_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  app_record fidensa_private.applications%rowtype;
  current_bucket timestamptz;
  rate_denied boolean;
  next_generation integer;
  operation_time timestamptz := fidensa_private.authoritative_now();
begin
  current_bucket := date_trunc('hour', operation_time)
    + floor(extract(minute from operation_time) / 15) * interval '15 minutes';
  select * into app_record from fidensa_private.applications
    where canonical_email = p_canonical_email
      and lifecycle = 'pending_verification'
      and retention_deadline > current_bucket + interval '25 minutes'
    for update;

  select
    count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 hour') >= 10
    or count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 day') >= 30
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 hour') >= 3
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 day') >= 5
    or max(occurred_at) filter (where email_digest = p_email_digest and result_class = 'allowed') > operation_time - interval '60 seconds'
  into rate_denied
  from fidensa_private.abuse_events
  where event_class = 'delivery' and occurred_at <= operation_time;

  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline, correlation_id
  ) values (
    'delivery', p_ip_digest, p_email_digest, 'application_verification_delivery',
    case when rate_denied or app_record.id is null then 'denied' else 'allowed' end,
    operation_time, operation_time + interval '48 hours', app_record.correlation_id
  );
  if app_record.id is null or rate_denied then return false; end if;

  select coalesce(max(generation), 0) + 1 into next_generation
    from fidensa_private.verifications where application_id = app_record.id;
  perform set_config('fidensa.verification_write', app_record.id::text, true);
  update fidensa_private.verifications
    set state = 'superseded', updated_at = operation_time
    where application_id = app_record.id and purpose = 'application_verification'
      and state in ('issued', 'delivery_unknown');
  insert into fidensa_private.verifications (
    application_id, purpose, credential_digest, email_rate_digest, generation, state, issued_at,
    expires_at, delivery_operation_id, correlation_id
  ) values (
    app_record.id, 'application_verification', p_credential_digest, p_email_digest,
    next_generation, 'issued', operation_time, operation_time + interval '60 minutes',
    gen_random_uuid(), app_record.correlation_id
  );
  insert into fidensa_private.communications (
    application_id, type, class, actor, recipient_class, template_version,
    operation_id, outcome, occurred_at, correlation_id
  ) values (
    app_record.id, 'verification', 'automatic', 'system', 'applicant',
    'application-verification-v1', gen_random_uuid(), 'intended', operation_time,
    app_record.correlation_id
  );
  return true;
end
$function$;

create function fidensa_api.record_provider_event(
  p_event_digest text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_linked_domain text,
  p_linked_id uuid,
  p_normalized_outcome text,
  p_canonical_email text default null,
  p_correlation_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare restrictive boolean;
declare received_at timestamptz := fidensa_private.authoritative_now();
begin
  if p_event_type not in (
    'email.bounced', 'email.complained', 'email.suppressed',
    'contact.updated', 'suppression.added', 'suppression.removed'
  ) then
    raise exception 'unsupported provider event type' using errcode = '22023';
  end if;
  if p_occurred_at > received_at then
    raise exception 'provider occurrence cannot be in the future' using errcode = '22023';
  end if;
  if exists (select 1 from fidensa_private.provider_events where provider_event_digest = p_event_digest) then
    return false;
  end if;
  restrictive := p_event_type in ('email.bounced', 'email.complained', 'email.suppressed', 'suppression.added');
  insert into fidensa_private.provider_events (
    provider_event_digest, event_type, occurred_at, first_authenticated_received_at,
    linked_domain, linked_id, normalized_outcome, state, deletion_deadline,
    correlation_id
  ) values (
    p_event_digest, p_event_type, p_occurred_at, received_at, p_linked_domain,
    p_linked_id, p_normalized_outcome,
    case when p_event_type in ('contact.updated', 'suppression.removed')
      then 'needs_reconciliation'::fidensa_private.provider_event_state
      else 'applied'::fidensa_private.provider_event_state end,
    received_at + interval '90 days', p_correlation_id
  );
  if restrictive and p_canonical_email is not null then
    insert into fidensa_private.suppressions (
      canonical_email, scope, state, reason, source_event, effective_at,
      retention_purpose, review_or_disposal_at, correlation_id
    ) values (
      p_canonical_email, 'global', 'effective', p_normalized_outcome,
      p_event_digest, received_at, 'honor delivery restriction',
      received_at + interval '24 months', p_correlation_id
    ) on conflict (canonical_email, scope) where state = 'effective' do nothing;
  end if;
  return true;
end
$function$;

create function fidensa_api.create_exercise_control(
  p_correlation_id uuid,
  p_checklist_digest text,
  p_deployment_identity text,
  p_config_digest text,
  p_commit_identity text,
  p_exact_recipient text,
  p_opens_at timestamptz,
  p_expires_at timestamptz,
  p_member_manifest_digest text,
  p_now timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare exercise_id uuid := gen_random_uuid();
declare acceptance_id uuid := gen_random_uuid();
begin
  p_now := fidensa_private.authoritative_now();
  perform set_config('fidensa.exercise_write', exercise_id::text, true);
  insert into fidensa_private.exercise_controls (
    id, correlation_id, checklist_version, checklist_digest,
    deployment_identity, config_digest, commit_identity, exact_recipient,
    synthetic, state, opens_at, expires_at, creator, cleanup_owner,
    created_at, updated_at
  ) values (
    exercise_id, p_correlation_id, 'controlled-exercise-v1.0', p_checklist_digest,
    p_deployment_identity, p_config_digest, p_commit_identity,
    p_exact_recipient, true, 'intake_closed', p_opens_at, p_expires_at,
    'scott_bishop', 'controlled-exercise-cleanup', p_now, p_now
  );
  perform set_config('fidensa.acceptance_write', acceptance_id::text, true);
  insert into fidensa_private.acceptance_records (
    id, correlation_id, checklist_version, checklist_digest, synthetic,
    commit_identity, deployment_identity, config_digest,
    member_manifest_digest, state, created_at, updated_at
  ) values (
    acceptance_id, p_correlation_id, 'controlled-exercise-v1.0', p_checklist_digest,
    true, p_commit_identity, p_deployment_identity, p_config_digest,
    p_member_manifest_digest, 'candidate', p_now, p_now
  );
  return exercise_id;
end
$function$;

create function fidensa_api.issue_fixture_verifier(
  p_exercise_id uuid,
  p_credential_digest text,
  p_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare next_generation integer;
begin
  p_now := fidensa_private.authoritative_now();
  if not exists (
    select 1 from fidensa_private.exercise_controls
    where id = p_exercise_id and state in ('intake_closed', 'intake_open')
  ) then raise exception 'fixture verifier requires a pre-execution exercise' using errcode = '55000'; end if;
  update fidensa_private.fixture_verifiers
    set state = 'revoked', revoked_at = p_now
    where exercise_control_id = p_exercise_id and state = 'issued';
  select coalesce(max(generation), 0) + 1 into next_generation
    from fidensa_private.fixture_verifiers where exercise_control_id = p_exercise_id;
  insert into fidensa_private.fixture_verifiers (
    exercise_control_id, purpose, generation, credential_digest, issued_at
  ) values (
    p_exercise_id, 'synthetic_fixture_ingress', next_generation,
    p_credential_digest, p_now
  );
  return next_generation;
end
$function$;

create function fidensa_api.authorize_fixture_operation(
  p_correlation_id uuid,
  p_credential_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare verifier_id uuid;
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  select fv.id into verifier_id
    from fidensa_private.fixture_verifiers fv
    join fidensa_private.exercise_controls ec on ec.id = fv.exercise_control_id
    where ec.correlation_id = p_correlation_id
      and ec.state in ('executed', 'review_pending')
      and fv.credential_digest = p_credential_digest and fv.state = 'issued'
      and operation_time < ec.expires_at
    for update of fv;
  if not found then return false; end if;
  return true;
end
$function$;

create function fidensa_api.cleanup_exercise(
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

  -- The authoritative generation is irrevocably revoked before any digest or
  -- working gate is removed. An old deployed raw value can no longer verify.
  update fidensa_private.fixture_verifiers
    set state = 'revoked', revoked_at = coalesce(revoked_at, p_now)
    where exercise_control_id = p_exercise_id and state <> 'revoked';

  perform set_config('fidensa.application_write', 'retention', true);
  perform set_config('fidensa.verification_write', 'retention', true);
  perform set_config('fidensa.privacy_write', 'retention', true);
  perform set_config('fidensa.governed_delete', 'on', true);
  perform set_config('fidensa.subscription_write', 'retention', true);
  perform set_config('fidensa.score_write', 'retention', true);
  delete from fidensa_private.application_operation_guards g
    using fidensa_private.applications a
    where g.application_id = a.id and a.correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.applications where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.subscriptions where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.suppressions where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.provider_events where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.abuse_events where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.operational_logs where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.privacy_requests where correlation_id = exercise_record.correlation_id;
  delete from fidensa_private.fixture_verifiers where exercise_control_id = p_exercise_id;

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

revoke all on all functions in schema fidensa_api from public, anon, authenticated;
grant execute on function fidensa_api.resend_application_verification(text, text, text, text) to fidensa_server;
grant execute on function fidensa_api.record_provider_event(text, text, timestamptz, text, uuid, text, text, uuid) to fidensa_server;
grant execute on function fidensa_api.authorize_fixture_operation(uuid, text) to fidensa_server;

commit;

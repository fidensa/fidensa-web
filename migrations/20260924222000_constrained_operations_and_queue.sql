begin;

insert into fidensa_private.rubric_versions
  (id, version_label, cohort_label, prohibited_factors, active, created_by)
values
  ('00000000-0000-4000-8000-000000000101', 'rubric-v1', 'cohort-v1',
   array['protected characteristics', 'company prestige', 'marketing consent'], true, 'scott_bishop');

insert into fidensa_private.rubric_criteria
  (rubric_version_id, ordinal, criterion_key, label)
values
  ('00000000-0000-4000-8000-000000000101', 1, 'real_ai_security_need', 'Real AI-security evaluation need'),
  ('00000000-0000-4000-8000-000000000101', 2, 'contained_runner_fit', 'Fit with current contained-runner capability'),
  ('00000000-0000-4000-8000-000000000101', 3, 'design_partner_willingness', 'Design-partner willingness'),
  ('00000000-0000-4000-8000-000000000101', 4, 'deployment_feasibility', 'Deployment and integration feasibility'),
  ('00000000-0000-4000-8000-000000000101', 5, 'feedback_urgency', 'Urgency and ability to provide useful feedback');

create function fidensa_private.enforce_application_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.application_write', true) not in (coalesce(new.id, old.id)::text, 'retention') then
    raise exception 'application writes require a constrained operation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.lifecycle in ('anonymized', 'transferred') then
    raise exception 'terminal application state cannot be changed' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger applications_constrained_write
before insert or update or delete on fidensa_private.applications
for each row execute function fidensa_private.enforce_application_write();

create function fidensa_private.enforce_verification_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.verification_write', true) not in (coalesce(new.application_id, old.application_id)::text, 'retention') then
    raise exception 'verification writes require a constrained operation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.state in ('consumed', 'expired', 'superseded') and new.state <> old.state then
    raise exception 'terminal verification state cannot be changed' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger verifications_constrained_write
before insert or update or delete on fidensa_private.verifications
for each row execute function fidensa_private.enforce_verification_write();

create function fidensa_private.enforce_subscription_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare gate text := current_setting('fidensa.subscription_write', true);
begin
  if current_user <> 'fidensa_mutator'
     or gate not in (coalesce(new.application_id, old.application_id)::text, 'retention') then
    raise exception 'subscription writes require a constrained operation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.state = 'deleted' and new.state <> old.state then
    raise exception 'deleted subscription cannot be resurrected' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger subscriptions_constrained_write
before insert or update or delete on fidensa_private.subscriptions
for each row execute function fidensa_private.enforce_subscription_write();

create function fidensa_private.enforce_score_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare app_id uuid;
declare gate text := current_setting('fidensa.score_write', true);
begin
  if tg_table_name = 'score_sets' then
    app_id := coalesce(new.application_id, old.application_id);
  elsif tg_table_name = 'application_score_cohorts' then
    app_id := coalesce(new.application_id, old.application_id);
  else
    select application_id into app_id from fidensa_private.score_sets
      where id = coalesce(new.score_set_id, old.score_set_id);
  end if;
  if current_user <> 'fidensa_mutator' or gate not in (app_id::text, 'retention') then
    raise exception 'score writes require a constrained operation' using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger score_cohorts_constrained_write
before insert or update or delete on fidensa_private.application_score_cohorts
for each row execute function fidensa_private.enforce_score_write();
create trigger score_sets_constrained_write
before insert or update or delete on fidensa_private.score_sets
for each row execute function fidensa_private.enforce_score_write();
create trigger scores_constrained_write
before insert or update or delete on fidensa_private.scores
for each row execute function fidensa_private.enforce_score_write();

create function fidensa_private.enforce_rubric_content_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.version_label <> new.version_label
     or old.cohort_label <> new.cohort_label
     or old.prohibited_factors <> new.prohibited_factors
     or old.material_change <> new.material_change
     or old.created_by <> new.created_by
     or old.created_at <> new.created_at then
    raise exception 'rubric version content is immutable' using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger rubric_versions_content_immutable
before update on fidensa_private.rubric_versions
for each row execute function fidensa_private.enforce_rubric_content_immutable();

create function fidensa_private.enforce_score_integrity()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  criterion_rubric uuid;
  set_rubric uuid;
begin
  select rubric_version_id into criterion_rubric
    from fidensa_private.rubric_criteria where id = new.criterion_id;
  select rubric_version_id into set_rubric
    from fidensa_private.score_sets where id = new.score_set_id;
  if criterion_rubric is distinct from set_rubric then
    raise exception 'score criterion and score set rubric versions differ' using errcode = '23514';
  end if;
  return new;
end
$function$;

create trigger scores_same_rubric
before insert or update on fidensa_private.scores
for each row execute function fidensa_private.enforce_score_integrity();

create function fidensa_private.enforce_exercise_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.exercise_write', true) <> coalesce(new.id, old.id)::text then
    raise exception 'exercise-control writes require a constrained operation' using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger exercise_controls_constrained_write
before insert or update or delete on fidensa_private.exercise_controls
for each row execute function fidensa_private.enforce_exercise_write();

create function fidensa_private.enforce_acceptance_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.acceptance_write', true) <> coalesce(new.id, old.id)::text then
    raise exception 'acceptance-record writes require a constrained operation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.state in ('cleanup_verified', 'invalidated_cleanup_verified') then
    raise exception 'cleanup-verified acceptance records are immutable' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger acceptance_records_constrained_write
before insert or update or delete on fidensa_private.acceptance_records
for each row execute function fidensa_private.enforce_acceptance_write();

create function fidensa_private.enforce_privacy_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.privacy_write', true) not in (coalesce(new.id, old.id)::text, 'retention') then
    raise exception 'privacy-request writes require a constrained operation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.state in ('fulfilled', 'denied', 'withdrawn', 'expired') then
    raise exception 'terminal privacy request cannot reopen' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$function$;

create trigger privacy_requests_constrained_write
before insert or update or delete on fidensa_private.privacy_requests
for each row execute function fidensa_private.enforce_privacy_write();

create function fidensa_private.enforce_privacy_history_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user <> 'fidensa_mutator'
     or current_setting('fidensa.privacy_write', true) <> new.privacy_request_id::text then
    raise exception 'privacy history writes require a constrained operation' using errcode = '42501';
  end if;
  return new;
end
$function$;

create trigger privacy_request_history_constrained_insert
before insert on fidensa_private.privacy_request_history
for each row execute function fidensa_private.enforce_privacy_history_write();

create function fidensa_api.submit_application(
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
  p_consent_text_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_uuid uuid := gen_random_uuid();
  gate fidensa_private.exercise_controls%rowtype;
  chosen_correlation uuid;
  subscription_uuid uuid;
  subscription_created boolean := false;
  rate_denied boolean := false;
  operation_time timestamptz := fidensa_private.authoritative_now();
  operation_environment text := fidensa_private.authoritative_environment();
begin
  if p_canonical_email <> lower(p_canonical_email) then
    raise exception 'canonical address must be lowercase' using errcode = '22023';
  end if;
  if exists (
    select 1 from fidensa_private.runtime_authority
    where singleton and intake_closed_at is not null
  ) then
    return null;
  end if;

  if operation_environment in ('Local', 'Test') then
    if not p_synthetic then
      raise exception 'local and test intake accepts synthetic records only' using errcode = '42501';
    end if;
  elsif operation_environment = 'Staged-production' then
    select * into gate
      from fidensa_private.exercise_controls
      where state = 'intake_open'
      for update;
    if not found
       or gate.exact_recipient <> p_canonical_email
       or not p_synthetic
       or operation_time < gate.opens_at
       or operation_time >= gate.expires_at then
      return null;
    end if;
    chosen_correlation := gate.correlation_id;
  else
    -- This migration does not carry Production launch authority.
    return null;
  end if;

  select
    count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 hour') >= 10
    or count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 day') >= 40
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 hour') >= 3
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 day') >= 5
  into rate_denied
  from fidensa_private.abuse_events
  where event_class = 'submission' and occurred_at <= operation_time;

  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline, correlation_id
  ) values (
    'submission', p_ip_digest, p_email_digest, 'application_submission',
    case when rate_denied then 'denied' else 'allowed' end,
    operation_time, operation_time + interval '48 hours', chosen_correlation
  );
  if rate_denied then return null; end if;

  if exists (
    select 1 from fidensa_private.application_operation_guards
    where route = 'application_submission' and operation_digest = p_operation_digest
  ) then
    return null;
  end if;

  if exists (
    select 1 from fidensa_private.applications
    where canonical_email = p_canonical_email
      and lifecycle in ('pending_verification', 'active')
  ) then
    insert into fidensa_private.application_operation_guards
      (route, operation_digest, result_class, first_seen_at,
       retention_anchor_at, review_or_disposal_at)
    values ('application_submission', p_operation_digest, 'duplicate', operation_time,
            operation_time, operation_time + interval '24 months')
    on conflict do nothing;
    return null;
  end if;

  perform set_config('fidensa.application_write', application_uuid::text, true);
  insert into fidensa_private.applications (
    id, canonical_email, delivery_email, operation_digest, correlation_id, synthetic,
    applicant_name, role_function, context, organization, intended_use_case,
    workflow_stage, deployment_preference, evaluation_timeline,
    design_partner_willingness, integration_constraints, referral_source,
    additional_context, submitted_at, retention_deadline
  ) values (
    application_uuid, p_canonical_email, p_delivery_email, p_operation_digest,
    chosen_correlation, p_synthetic, p_applicant_name, p_role_function, p_context,
    p_organization, p_intended_use_case, p_workflow_stage, p_deployment_preference,
    p_evaluation_timeline, p_design_partner_willingness, p_integration_constraints,
    p_referral_source, p_additional_context, operation_time, operation_time + interval '7 days'
  );

  insert into fidensa_private.application_operation_guards
    (route, operation_digest, application_id, result_class, first_seen_at,
     retention_anchor_at, review_or_disposal_at)
  values ('application_submission', p_operation_digest, application_uuid, 'committed', operation_time,
          operation_time, operation_time + interval '24 months');

  perform set_config('fidensa.verification_write', application_uuid::text, true);
  insert into fidensa_private.verifications (
    application_id, purpose, credential_digest, email_rate_digest, generation, issued_at, expires_at,
    delivery_operation_id, correlation_id
  ) values (
    application_uuid, 'application_verification', p_credential_digest, p_email_digest, 1, operation_time,
    operation_time + interval '60 minutes', gen_random_uuid(), chosen_correlation
  );

  insert into fidensa_private.privacy_acknowledgements
    (application_id, notice_version, acknowledged, acknowledged_at, correlation_id)
  values (application_uuid, p_notice_version, true, operation_time, chosen_correlation);

  if p_marketing_selected then
    if p_consent_text_version is null then
      raise exception 'selected marketing consent requires a text version' using errcode = '23514';
    end if;
    perform set_config('fidensa.subscription_write', application_uuid::text, true);
    insert into fidensa_private.subscriptions (
      application_id, canonical_email, delivery_email, state, consent_source,
      consent_text_version, consented_at, correlation_id
    ) values (
      application_uuid, p_canonical_email, p_delivery_email, 'pending_confirmation',
      'application_checkbox', p_consent_text_version, operation_time, chosen_correlation
    )
    on conflict (canonical_email) where state <> 'deleted' do nothing
    returning id into subscription_uuid;

    subscription_created := subscription_uuid is not null;
    if subscription_uuid is null then
      select id into subscription_uuid from fidensa_private.subscriptions
      where canonical_email = p_canonical_email and state <> 'deleted';
    end if;

    insert into fidensa_private.consent_acts (
      application_id, subscription_id, canonical_email, consent_source,
      consent_text_version, selected_at, state, correlation_id
    ) values (
      application_uuid, subscription_uuid, p_canonical_email,
      'application_checkbox', p_consent_text_version, operation_time,
      'pending_confirmation', chosen_correlation
    );

    if subscription_created then
      insert into fidensa_private.consent_history
        (subscription_id, new_state, source, text_version, actor, occurred_at, correlation_id)
      values (subscription_uuid, 'pending_confirmation', 'application_checkbox',
              p_consent_text_version, 'applicant', operation_time, chosen_correlation);
    end if;
  end if;

  insert into fidensa_private.communications (
    application_id, type, class, actor, recipient_class, template_version,
    operation_id, outcome, occurred_at, correlation_id
  ) values (
    application_uuid, 'verification', 'automatic', 'system', 'applicant',
    'application-verification-v1', gen_random_uuid(), 'intended', operation_time, chosen_correlation
  );
  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline, correlation_id
  ) values (
    'delivery', p_ip_digest, p_email_digest, 'application_verification_delivery',
    'allowed', operation_time, operation_time + interval '48 hours', chosen_correlation
  );

  if operation_environment = 'Staged-production' then
    perform set_config('fidensa.exercise_write', gate.id::text, true);
    update fidensa_private.exercise_controls
      set state = 'executed', executed_at = operation_time, version = version + 1,
          updated_at = operation_time
      where id = gate.id and state = 'intake_open';
    if not found then
      raise exception 'exercise gate was consumed concurrently' using errcode = '40001';
    end if;
  end if;

  return application_uuid;
exception
  when unique_violation then
    return null;
end
$function$;

create function fidensa_api.verify_application(
  p_credential_digest text,
  p_ip_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  verification_record fidensa_private.verifications%rowtype;
  application_record fidensa_private.applications%rowtype;
  subscription_record fidensa_private.subscriptions%rowtype;
  email_digest_value text;
  rate_denied boolean;
  verification_found boolean;
  operation_time timestamptz := fidensa_private.authoritative_now();
begin
  select * into verification_record
    from fidensa_private.verifications
    where credential_digest = p_credential_digest
      and purpose = 'application_verification'
      and state in ('issued', 'delivery_unknown')
      and expires_at > operation_time
    for update;
  verification_found := found;
  if verification_found then
    email_digest_value := verification_record.email_rate_digest;
  end if;
  select
    count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 hour') >= 30
    or count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 day') >= 100
    or (email_digest_value is not null and (
      count(*) filter (where email_digest = email_digest_value and occurred_at > operation_time - interval '1 hour') >= 10
      or count(*) filter (where email_digest = email_digest_value and occurred_at > operation_time - interval '1 day') >= 20
    ))
  into rate_denied
  from fidensa_private.abuse_events
  where event_class = 'verification' and occurred_at <= operation_time;
  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline,
    correlation_id
  ) values (
    'verification', p_ip_digest, email_digest_value, 'verification_exchange',
    case when rate_denied then 'denied' else 'allowed' end,
    operation_time, operation_time + interval '48 hours', verification_record.correlation_id
  );
  if not verification_found or rate_denied then return false; end if;

  select * into application_record
    from fidensa_private.applications
    where id = verification_record.application_id
      and lifecycle = 'pending_verification'
      and retention_deadline > operation_time
    for update;
  if not found then return false; end if;

  perform set_config('fidensa.verification_write', application_record.id::text, true);
  update fidensa_private.verifications
    set state = 'consumed', consumed_at = operation_time, updated_at = operation_time
    where id = verification_record.id;

  perform set_config('fidensa.application_write', application_record.id::text, true);
  update fidensa_private.applications
    set lifecycle = 'active', verified_at = operation_time,
        retention_deadline = greatest(submitted_at, coalesce(last_direct_interaction_at, submitted_at)) + interval '12 months',
        version = version + 1, updated_at = operation_time
    where id = application_record.id;

  perform set_config('fidensa.queue_write', application_record.id::text, true);
  insert into fidensa_private.reviewer_status
    (application_id, state, actor, reason, changed_at)
  values (application_record.id, 'new', 'system', 'address_verified', operation_time);
  insert into fidensa_private.reviewer_status_history
    (application_id, prior_state, new_state, actor, reason, occurred_at,
     transition_version, correlation_id)
  values (application_record.id, null, 'new', 'system', 'address_verified',
          operation_time, 1, application_record.correlation_id);

  select * into subscription_record
    from fidensa_private.subscriptions
    where application_id = application_record.id and state = 'pending_confirmation'
    for update;
  if found then
    perform set_config('fidensa.subscription_write', application_record.id::text, true);
    update fidensa_private.subscriptions
      set state = 'active', confirmed_at = operation_time, version = version + 1,
          updated_at = operation_time
      where id = subscription_record.id;
    insert into fidensa_private.consent_history
      (subscription_id, prior_state, new_state, source, text_version, actor,
       occurred_at, correlation_id)
    values (subscription_record.id, 'pending_confirmation', 'active',
            'address_verification', subscription_record.consent_text_version,
            'system', operation_time, application_record.correlation_id);
  end if;
  update fidensa_private.consent_acts
    set state = 'confirmed', confirmed_at = operation_time
    where application_id = application_record.id and state = 'pending_confirmation';

  insert into fidensa_private.communications (
    application_id, type, class, actor, recipient_class, template_version,
    operation_id, outcome, occurred_at, correlation_id
  ) values
    (application_record.id, 'receipt', 'automatic', 'system', 'applicant',
     'application-receipt-v1', gen_random_uuid(), 'intended', operation_time,
     application_record.correlation_id),
    (application_record.id, 'reviewer_notification', 'automatic', 'system', 'reviewer',
     'reviewer-notification-v1', gen_random_uuid(), 'intended', operation_time,
     application_record.correlation_id);
  return true;
end
$function$;

create function fidensa_api.transition_reviewer_status(
  p_application_id uuid,
  p_expected_version bigint,
  p_target text,
  p_reason text,
  p_actor text default 'scott_bishop',
  p_now timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_record fidensa_private.reviewer_status%rowtype;
  next_version bigint;
begin
  p_now := fidensa_private.authoritative_now();
  if p_actor <> 'scott_bishop' then
    raise exception 'only Scott Bishop may transition reviewer state' using errcode = '42501';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception 'transition reason is required and bounded' using errcode = '22023';
  end if;
  select * into current_record from fidensa_private.reviewer_status
    where application_id = p_application_id for update;
  if not found then
    raise exception 'application is not in the reviewer queue' using errcode = '55000';
  end if;
  if current_record.version <> p_expected_version then
    raise exception 'reviewer status version conflict' using errcode = '40001';
  end if;
  if current_record.state::text = p_target then
    raise exception 'reviewer status no-op is forbidden' using errcode = '22023';
  end if;
  if current_record.state = 'accepted' then
    raise exception 'accepted is terminal for queue transitions' using errcode = '55000';
  end if;
  if not exists (
    select 1 from fidensa_private.applications
    where id = p_application_id and lifecycle = 'active'
      and retention_deadline > p_now
  ) then
    raise exception 'terminal or pre-verification application cannot transition' using errcode = '55000';
  end if;

  next_version := current_record.version + 1;
  perform set_config('fidensa.queue_write', p_application_id::text, true);
  update fidensa_private.reviewer_status
    set state = p_target::fidensa_private.queue_state, actor = p_actor, reason = p_reason,
        changed_at = p_now, version = next_version, updated_at = p_now
    where application_id = p_application_id;
  insert into fidensa_private.reviewer_status_history
    (application_id, prior_state, new_state, actor, reason, occurred_at,
     transition_version)
  values (p_application_id, current_record.state, p_target::fidensa_private.queue_state, p_actor, p_reason,
          p_now, next_version);
  return next_version;
end
$function$;

create function fidensa_api.record_direct_interaction(
  p_application_id uuid,
  p_occurred_at timestamptz,
  p_actor text default 'scott_bishop'
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if p_actor <> 'scott_bishop' then
    raise exception 'only Scott Bishop may record direct interaction' using errcode = '42501';
  end if;
  if p_occurred_at > operation_time then
    raise exception 'direct interaction occurrence cannot be in the future' using errcode = '22023';
  end if;
  perform set_config('fidensa.application_write', p_application_id::text, true);
  update fidensa_private.applications
    set last_direct_interaction_at = greatest(coalesce(last_direct_interaction_at, submitted_at), p_occurred_at),
        retention_deadline = greatest(submitted_at, coalesce(last_direct_interaction_at, submitted_at), p_occurred_at) + interval '12 months',
        version = version + 1, updated_at = operation_time
    where id = p_application_id and lifecycle = 'active';
  if not found then
    raise exception 'active application required' using errcode = '55000';
  end if;
end
$function$;

create function fidensa_api.record_score_set(
  p_application_id uuid,
  p_rubric_label text,
  p_entries jsonb,
  p_expected_version bigint default 0,
  p_actor text default 'scott_bishop',
  p_now timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  rubric_id uuid;
  set_record fidensa_private.score_sets%rowtype;
  entry jsonb;
  criterion_record fidensa_private.rubric_criteria%rowtype;
  entry_count integer;
  numeric_count integer;
  new_state fidensa_private.score_set_state;
  cohort_rubric_id uuid;
begin
  p_now := fidensa_private.authoritative_now();
  if p_actor <> 'scott_bishop' then
    raise exception 'only Scott Bishop may score' using errcode = '42501';
  end if;
  if not exists (
    select 1 from fidensa_private.reviewer_status rs
    join fidensa_private.applications a on a.id = rs.application_id
    where rs.application_id = p_application_id and a.lifecycle = 'active'
      and a.retention_deadline > p_now
  ) then
    raise exception 'active queued application required' using errcode = '55000';
  end if;
  select id into rubric_id from fidensa_private.rubric_versions
    where version_label = p_rubric_label;
  if rubric_id is null then raise exception 'unknown rubric version' using errcode = '22023'; end if;
  select rubric_version_id into cohort_rubric_id
    from fidensa_private.application_score_cohorts
    where application_id = p_application_id;
  if cohort_rubric_id is null then
    if not exists (
      select 1 from fidensa_private.rubric_versions
      where id = rubric_id and active
    ) then
      raise exception 'initial scoring must use the active rubric' using errcode = '55000';
    end if;
  elsif cohort_rubric_id <> rubric_id and not exists (
    select 1 from fidensa_private.rubric_rescore_requirements requirement
    join fidensa_private.rubric_versions version on version.id = requirement.rubric_version_id
    where requirement.application_id = p_application_id
      and requirement.rubric_version_id = rubric_id
      and requirement.completed_at is null
      and version.active
  ) then
    raise exception 'cross-version scoring requires an active material-change rescore requirement' using errcode = '55000';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 5 then
    raise exception 'score entries must be an array of at most five criteria' using errcode = '22023';
  end if;
  if (select count(distinct value->>'criterion') from jsonb_array_elements(p_entries))
       <> jsonb_array_length(p_entries) then
    raise exception 'score criterion entries must be unique' using errcode = '22023';
  end if;

  perform set_config('fidensa.score_write', p_application_id::text, true);

  insert into fidensa_private.application_score_cohorts
    (application_id, rubric_version_id, first_scored_at)
  values (p_application_id, rubric_id, p_now)
  on conflict (application_id) do nothing;

  select * into set_record from fidensa_private.score_sets
    where application_id = p_application_id and rubric_version_id = rubric_id
      and superseded_at is null
    for update;
  if found and set_record.version <> p_expected_version then
    raise exception 'score version conflict' using errcode = '40001';
  end if;
  if not found and p_expected_version <> 0 then
    raise exception 'score version conflict' using errcode = '40001';
  end if;
  if not found then
    insert into fidensa_private.score_sets
      (application_id, rubric_version_id, assessor, assessed_at)
    values (p_application_id, rubric_id, p_actor, p_now)
    returning * into set_record;
  end if;

  for entry in select value from jsonb_array_elements(p_entries)
  loop
    select * into criterion_record from fidensa_private.rubric_criteria
      where rubric_version_id = rubric_id and criterion_key = entry->>'criterion';
    if not found then raise exception 'unknown score criterion' using errcode = '22023'; end if;
    if nullif(btrim(entry->>'rationale'), '') is null
       or char_length(entry->>'rationale') > 500 then
      raise exception 'every score requires a bounded rationale' using errcode = '22023';
    end if;

    update fidensa_private.scores set superseded_at = p_now
      where score_set_id = set_record.id and criterion_id = criterion_record.id
        and superseded_at is null;
    if entry->>'value' = 'N/A' then
      insert into fidensa_private.scores
        (score_set_id, criterion_id, value_kind, rationale, assessor, assessed_at)
      values (set_record.id, criterion_record.id, 'na', entry->>'rationale', p_actor, p_now);
    elsif (entry->>'value') ~ '^[0-4]$' then
      insert into fidensa_private.scores
        (score_set_id, criterion_id, value_kind, numeric_value, rationale, assessor, assessed_at)
      values (set_record.id, criterion_record.id, 'numeric', (entry->>'value')::smallint,
              entry->>'rationale', p_actor, p_now);
    else
      raise exception 'score value must be N/A or 0 through 4' using errcode = '22023';
    end if;
  end loop;

  select count(*), count(*) filter (where value_kind = 'numeric')
    into entry_count, numeric_count
    from fidensa_private.scores
    where score_set_id = set_record.id and superseded_at is null;
  new_state := case when entry_count = 5 and numeric_count = 5 then 'complete' else 'incomplete' end;

  update fidensa_private.score_sets
    set state = new_state, assessed_at = p_now, version = version + 1, updated_at = p_now
    where id = set_record.id
    returning * into set_record;

  update fidensa_private.rubric_versions
    set first_scored_at = coalesce(first_scored_at, p_now),
        calibration_anchor_at = coalesce(calibration_anchor_at, p_now),
        scored_since_calibration = scored_since_calibration + case when p_expected_version = 0 then 1 else 0 end
    where id = rubric_id;

  if new_state = 'complete' then
    update fidensa_private.rubric_rescore_requirements
      set completed_at = p_now
      where application_id = p_application_id and rubric_version_id = rubric_id
        and completed_at is null;
  end if;
  return set_record.id;
end
$function$;

create function fidensa_api.activate_rubric_version(
  p_version_label text,
  p_cohort_label text,
  p_criteria jsonb,
  p_actor text default 'scott_bishop',
  p_now timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  rubric_id uuid := gen_random_uuid();
  entry jsonb;
begin
  p_now := fidensa_private.authoritative_now();
  if p_actor <> 'scott_bishop' then raise exception 'only Scott Bishop may activate a rubric' using errcode = '42501'; end if;
  if jsonb_typeof(p_criteria) <> 'array' or jsonb_array_length(p_criteria) <> 5 then
    raise exception 'a rubric must define exactly five criteria' using errcode = '22023';
  end if;
  update fidensa_private.rubric_versions set active = false where active;
  insert into fidensa_private.rubric_versions
    (id, version_label, cohort_label, prohibited_factors, active, material_change, created_by, created_at)
  values (rubric_id, p_version_label, p_cohort_label,
          array['protected characteristics', 'company prestige', 'marketing consent'],
          true, true, p_actor, p_now);
  for entry in select value from jsonb_array_elements(p_criteria)
  loop
    insert into fidensa_private.rubric_criteria
      (rubric_version_id, ordinal, criterion_key, label)
    values (rubric_id, (entry->>'ordinal')::smallint, entry->>'criterion', entry->>'label');
  end loop;
  insert into fidensa_private.rubric_rescore_requirements
    (application_id, rubric_version_id, required_at)
  select rs.application_id, rubric_id, p_now
  from fidensa_private.reviewer_status rs
  join fidensa_private.applications a on a.id = rs.application_id
  where a.lifecycle = 'active' and a.retention_deadline > p_now
  on conflict (application_id, rubric_version_id) do update
    set required_at = excluded.required_at, completed_at = null;
  return rubric_id;
end
$function$;

create function fidensa_api.record_manual_communication(
  p_application_id uuid,
  p_type text,
  p_template_version text,
  p_outcome text,
  p_note text default null,
  p_now timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare communication_id uuid;
begin
  p_now := fidensa_private.authoritative_now();
  if p_type in ('verification', 'receipt', 'reviewer_notification') then
    raise exception 'automatic message types cannot be recorded as manual' using errcode = '22023';
  end if;
  if not exists (
    select 1 from fidensa_private.applications
    where id = p_application_id and lifecycle = 'active'
      and retention_deadline > p_now
  ) then
    raise exception 'active unexpired application required' using errcode = '55000';
  end if;
  insert into fidensa_private.communications (
    application_id, type, class, actor, recipient_class, template_version,
    operation_id, outcome, note, occurred_at
  ) values (
    p_application_id, p_type, 'manual', 'scott_bishop', 'applicant',
    p_template_version, gen_random_uuid(), p_outcome::fidensa_private.communication_outcome, p_note, p_now
  ) returning id into communication_id;
  return communication_id;
end
$function$;

create function fidensa_api.create_privacy_request(
  p_type text,
  p_canonical_email text,
  p_delivery_email text,
  p_route text,
  p_operation_digest text,
  p_explanation text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare request_id uuid := gen_random_uuid();
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if p_canonical_email <> lower(p_canonical_email) then
    raise exception 'canonical address must be lowercase' using errcode = '22023';
  end if;
  if exists (select 1 from fidensa_private.privacy_requests where route = p_route and operation_digest = p_operation_digest) then
    return null;
  end if;
  if exists (
    select 1 from fidensa_private.privacy_requests
    where canonical_email = p_canonical_email and request_type::text = p_type
      and state not in ('fulfilled', 'denied', 'withdrawn', 'expired')
  ) then return null; end if;
  perform set_config('fidensa.privacy_write', request_id::text, true);
  insert into fidensa_private.privacy_requests (
    id, request_type, canonical_email, delivery_email, route, operation_digest,
    explanation, received_at, confirmation_intent_due_at, target_due_at
  ) values (
    request_id, p_type::fidensa_private.privacy_request_type, p_canonical_email, p_delivery_email, p_route,
    p_operation_digest, p_explanation, operation_time, operation_time + interval '24 hours',
    operation_time + interval '30 days'
  );
  insert into fidensa_private.privacy_request_history (
    privacy_request_id, prior_state, new_state, event_class, actor, reason,
    occurred_at, transition_version
  ) values (request_id, null, 'awaiting_confirmation', 'transition', 'requester',
            'request_received', operation_time, 1);
  return request_id;
exception when unique_violation then return null;
end
$function$;

create function fidensa_api.transition_privacy_request(
  p_request_id uuid,
  p_expected_version bigint,
  p_target text,
  p_scope text[],
  p_reason text,
  p_actor text default 'scott_bishop',
  p_now timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare current_record fidensa_private.privacy_requests%rowtype;
declare permitted boolean := false;
declare next_version bigint;
begin
  p_now := fidensa_private.authoritative_now();
  if p_actor <> 'scott_bishop' then raise exception 'operator authority required' using errcode = '42501'; end if;
  select * into current_record from fidensa_private.privacy_requests where id = p_request_id for update;
  if not found then raise exception 'privacy request not found' using errcode = '55000'; end if;
  if current_record.version <> p_expected_version then raise exception 'privacy version conflict' using errcode = '40001'; end if;
  if current_record.state::text = p_target then raise exception 'privacy no-op is forbidden' using errcode = '22023'; end if;
  permitted :=
    (current_record.state = 'awaiting_confirmation' and p_target in ('verified', 'withdrawn', 'denied', 'expired'))
    or (current_record.state = 'verified' and p_target in ('under_review', 'withdrawn'))
    or (current_record.state = 'under_review' and p_target in ('fulfilled', 'denied', 'withdrawn'));
  if not permitted then raise exception 'invalid privacy transition' using errcode = '55000'; end if;
  if p_target = 'expired' and (current_record.confirmation_sent_at is null or p_now < current_record.confirmation_sent_at + interval '30 days') then
    raise exception 'privacy request cannot expire before a sent confirmation ages 30 days' using errcode = '55000';
  end if;
  if p_target in ('verified', 'under_review', 'fulfilled') and (p_scope is null or cardinality(p_scope) = 0) then
    raise exception 'verified scope is required' using errcode = '22023';
  end if;
  if current_record.state <> 'awaiting_confirmation'
     and p_scope is distinct from current_record.verified_scope then
    raise exception 'verified privacy scope cannot change without a newly verified case' using errcode = '55000';
  end if;
  next_version := current_record.version + 1;
  perform set_config('fidensa.privacy_write', p_request_id::text, true);
  update fidensa_private.privacy_requests
    set state = p_target::fidensa_private.privacy_request_state,
        verified_scope = coalesce(p_scope, verified_scope),
        terminal_at = case when p_target in ('fulfilled', 'denied', 'withdrawn', 'expired') then p_now else null end,
        closed_record_deletion_deadline = case when p_target in ('fulfilled', 'denied', 'withdrawn', 'expired') then p_now + interval '24 months' else null end,
        version = next_version, updated_at = p_now
    where id = p_request_id;
  insert into fidensa_private.privacy_request_history (
    privacy_request_id, prior_state, new_state, event_class, actor, reason,
    occurred_at, transition_version
  ) values (p_request_id, current_record.state, p_target::fidensa_private.privacy_request_state, 'transition', p_actor,
            p_reason, p_now, next_version);
  return next_version;
end
$function$;

create function fidensa_api.transition_exercise_control(
  p_exercise_id uuid,
  p_expected_version bigint,
  p_target text,
  p_review_run_identity text default null,
  p_verdict text default null,
  p_reason text default null,
  p_now timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare current_record fidensa_private.exercise_controls%rowtype;
declare permitted boolean := false;
declare next_version bigint;
begin
  p_now := fidensa_private.authoritative_now();
  select * into current_record from fidensa_private.exercise_controls where id = p_exercise_id for update;
  if not found then raise exception 'exercise control not found' using errcode = '55000'; end if;
  if current_record.version <> p_expected_version then raise exception 'exercise version conflict' using errcode = '40001'; end if;
  if current_record.state::text = p_target then return current_record.version; end if;
  permitted :=
    (current_record.state = 'intake_closed' and p_target = 'intake_open')
    or (current_record.state = 'executed' and p_target = 'review_pending')
    or (current_record.state = 'review_pending' and p_target = 'review_verified')
    or (current_record.state = 'review_verified' and p_target = 'cleanup_pending')
    or (current_record.state = 'invalidated' and p_target = 'cleanup_pending')
    or (p_target = 'invalidated' and current_record.state <> 'cleanup_pending');
  if not permitted then raise exception 'invalid exercise transition' using errcode = '55000'; end if;
  if p_target = 'intake_open' and (p_now < current_record.opens_at or p_now >= current_record.expires_at) then
    raise exception 'exercise intake window is not current' using errcode = '55000';
  end if;
  if p_target = 'review_verified' and (p_review_run_identity is null or p_verdict <> 'approve') then
    raise exception 'durable approve verdict is required' using errcode = '55000';
  end if;
  if p_target = 'invalidated' and nullif(btrim(p_reason), '') is null then
    raise exception 'invalidation reason is required' using errcode = '22023';
  end if;
  next_version := current_record.version + 1;
  perform set_config('fidensa.exercise_write', p_exercise_id::text, true);
  update fidensa_private.exercise_controls
    set state = p_target::fidensa_private.exercise_state, review_run_identity = coalesce(p_review_run_identity, review_run_identity),
        independent_verdict = coalesce(p_verdict, independent_verdict),
        invalidation_reason = case when p_target = 'invalidated' then p_reason else invalidation_reason end,
        version = next_version, updated_at = p_now
    where id = p_exercise_id;
  return next_version;
end
$function$;

create function fidensa_api.transition_acceptance_record(
  p_record_id uuid,
  p_expected_version bigint,
  p_target text,
  p_reviewer_run_identity text default null,
  p_verdict text default null,
  p_now timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare current_record fidensa_private.acceptance_records%rowtype;
declare permitted boolean := false;
declare next_version bigint;
begin
  p_now := fidensa_private.authoritative_now();
  select * into current_record from fidensa_private.acceptance_records where id = p_record_id for update;
  if not found then raise exception 'acceptance record not found' using errcode = '55000'; end if;
  if current_record.version <> p_expected_version then raise exception 'acceptance version conflict' using errcode = '40001'; end if;
  if current_record.state::text = p_target then return current_record.version; end if;
  permitted :=
    (current_record.state = 'candidate' and p_target in ('accepted', 'rejected', 'invalidated'))
    or (current_record.state in ('accepted', 'rejected') and p_target in ('invalidated', 'cleanup_verified'))
    or (current_record.state = 'invalidated' and p_target = 'invalidated_cleanup_verified');
  if not permitted then raise exception 'invalid acceptance transition' using errcode = '55000'; end if;
  if p_target in ('accepted', 'rejected') and (p_reviewer_run_identity is null or p_verdict is null) then
    raise exception 'review identity and verdict are required' using errcode = '55000';
  end if;
  if p_target = 'accepted' and p_verdict <> 'approve' then raise exception 'accepted requires approve verdict' using errcode = '55000'; end if;
  if p_target = 'rejected' and p_verdict <> 'reject' then raise exception 'rejected requires reject verdict' using errcode = '55000'; end if;
  next_version := current_record.version + 1;
  perform set_config('fidensa.acceptance_write', p_record_id::text, true);
  update fidensa_private.acceptance_records
    set state = p_target::fidensa_private.acceptance_state,
        reviewer_run_identity = coalesce(p_reviewer_run_identity, reviewer_run_identity),
        verdict = coalesce(p_verdict, verdict),
        cleanup_verified_at = case when p_target in ('cleanup_verified', 'invalidated_cleanup_verified') then p_now else cleanup_verified_at end,
        version = next_version, updated_at = p_now
    where id = p_record_id;
  return next_version;
end
$function$;

create view fidensa_private.score_displays
with (security_invoker = true)
as
select
  ss.application_id,
  rv.version_label as rubric_version,
  rv.cohort_label,
  count(s.id) filter (where s.value_kind = 'numeric')::integer as criteria_assessed,
  coalesce(sum(s.numeric_value) filter (where s.value_kind = 'numeric'), 0)::integer as assessed_points,
  (4 * count(s.id) filter (where s.value_kind = 'numeric'))::integer as possible_assessed_points,
  case
    when count(s.id) filter (where s.value_kind = 'numeric') = 5
      then sum(s.numeric_value) filter (where s.value_kind = 'numeric')::text || '/20'
    else coalesce(sum(s.numeric_value) filter (where s.value_kind = 'numeric'), 0)::text
      || '/' || (4 * count(s.id) filter (where s.value_kind = 'numeric'))::text
      || ' assessed points — '
      || count(s.id) filter (where s.value_kind = 'numeric')::text
      || ' of 5 criteria assessed'
  end as display,
  count(s.id) filter (where s.value_kind = 'numeric') = 5 as complete_total
from fidensa_private.score_sets ss
join fidensa_private.rubric_versions rv on rv.id = ss.rubric_version_id
left join fidensa_private.scores s on s.score_set_id = ss.id and s.superseded_at is null
where ss.superseded_at is null
group by ss.application_id, rv.version_label, rv.cohort_label;

create view fidensa_private.rubric_calibration_due
with (security_invoker = true)
as
select id as rubric_version_id, version_label,
       calibration_anchor_at as reference_time,
       (scored_since_calibration >= 20
        or (calibration_anchor_at is not null and fidensa_private.authoritative_now() >= calibration_anchor_at + interval '30 days')) as calibration_due,
       scored_since_calibration,
       case when calibration_anchor_at is null then null else calibration_anchor_at + interval '30 days' end as time_due_at
from fidensa_private.rubric_versions;

create view fidensa_private.reviewer_queue
with (security_invoker = true)
as
select
  a.id as application_id,
  a.applicant_name,
  a.delivery_email,
  a.role_function,
  a.context,
  a.organization,
  a.intended_use_case,
  a.workflow_stage,
  a.deployment_preference,
  a.evaluation_timeline,
  a.design_partner_willingness,
  a.integration_constraints,
  a.referral_source,
  a.additional_context,
  a.submitted_at,
  a.last_direct_interaction_at,
  rs.state as reviewer_status,
  rs.changed_at as status_changed_at,
  rs.version as status_version,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'prior', h.prior_state, 'new', h.new_state, 'actor', h.actor,
      'reason', h.reason, 'at', h.occurred_at, 'version', h.transition_version
    ) order by h.transition_version)
    from fidensa_private.reviewer_status_history h where h.application_id = a.id
  ), '[]'::jsonb) as status_history,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'rubric', rv.version_label, 'criterion', rc.criterion_key,
      'value', case when s.value_kind = 'na' then 'N/A' else s.numeric_value::text end,
      'rationale', s.rationale, 'assessor', s.assessor, 'at', s.assessed_at
    ) order by rv.version_label, rc.ordinal)
    from fidensa_private.score_sets ss
    join fidensa_private.rubric_versions rv on rv.id = ss.rubric_version_id
    join fidensa_private.scores s on s.score_set_id = ss.id and s.superseded_at is null
    join fidensa_private.rubric_criteria rc on rc.id = s.criterion_id
    where ss.application_id = a.id and ss.superseded_at is null
  ), '[]'::jsonb) as scores,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'rubric', d.rubric_version, 'cohort', d.cohort_label,
      'display', d.display, 'complete', d.complete_total
    ) order by d.rubric_version)
    from fidensa_private.score_displays d where d.application_id = a.id
  ), '[]'::jsonb) as score_displays,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'type', c.type, 'class', c.class, 'actor', c.actor,
      'recipient_class', c.recipient_class, 'template', c.template_version,
      'outcome', c.outcome, 'note', c.note, 'at', c.occurred_at
    ) order by c.occurred_at)
    from fidensa_private.communications c where c.application_id = a.id
  ), '[]'::jsonb) as communications
from fidensa_private.applications a
join fidensa_private.reviewer_status rs on rs.application_id = a.id
where a.lifecycle = 'active' and a.retention_deadline > clock_timestamp();

revoke all on fidensa_private.score_displays from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.rubric_calibration_due from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.reviewer_queue from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

-- Server and job roles can execute only named operations. They never receive
-- private-schema USAGE or base-relation privileges.
revoke all on all functions in schema fidensa_api from public, anon, authenticated;
grant execute on function fidensa_api.submit_application(boolean, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) to fidensa_server;
grant execute on function fidensa_api.verify_application(text, text) to fidensa_server;
grant execute on function fidensa_api.create_privacy_request(text, text, text, text, text, text) to fidensa_server;

commit;

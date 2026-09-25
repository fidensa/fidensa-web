begin;

-- The accepted application workflow keeps all product data outside exposed
-- schemas. The fidensa_api schema contains operations only, never relations.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fidensa_server') then
    create role fidensa_server nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fidensa_job') then
    create role fidensa_job nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fidensa_mutator') then
    create role fidensa_mutator nologin noinherit bypassrls;
  end if;
end
$roles$;

grant fidensa_server to service_role;

create schema fidensa_private;
create schema fidensa_api;

revoke all on schema fidensa_private from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on schema fidensa_api from public, anon, authenticated;
grant usage on schema fidensa_api to service_role, fidensa_server, fidensa_job;

alter default privileges in schema fidensa_private revoke all on tables from public;
alter default privileges in schema fidensa_private revoke all on sequences from public;
alter default privileges in schema fidensa_private revoke execute on functions from public;
alter default privileges in schema fidensa_api revoke execute on functions from public;

create table fidensa_private.runtime_authority (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment in ('Local', 'Test', 'Staged-production', 'Production')),
  test_clock_at timestamptz,
  test_clock_enabled boolean not null default false,
  retention_monitoring_started_at timestamptz not null,
  intake_closed_at timestamptz,
  intake_close_reason text check (intake_close_reason is null or char_length(intake_close_reason) between 1 and 200),
  updated_at timestamptz not null default clock_timestamp(),
  check (not test_clock_enabled or (environment in ('Test', 'Staged-production') and test_clock_at is not null)),
  check ((intake_closed_at is null) = (intake_close_reason is null))
);

insert into fidensa_private.runtime_authority
  (environment, retention_monitoring_started_at)
values ('Staged-production', clock_timestamp());

create function fidensa_private.authoritative_now()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case when test_clock_enabled and environment in ('Test', 'Staged-production')
    then test_clock_at else clock_timestamp() end
  from fidensa_private.runtime_authority where singleton
$function$;

create function fidensa_private.authoritative_environment()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select environment from fidensa_private.runtime_authority where singleton
$function$;

-- Fixed-clock injection exists only in this private, owner-only test operation.
-- No server or scheduler role receives schema usage or execute authority for it.
create function fidensa_private.configure_test_authority(p_environment text, p_now timestamptz)
returns void
language plpgsql
set search_path = ''
as $function$
begin
  if current_user in ('service_role', 'fidensa_server', 'fidensa_job', 'fidensa_mutator') then
    raise exception 'test authority is reserved to the database owner' using errcode = '42501';
  end if;
  if p_environment not in ('Test', 'Staged-production') then
    raise exception 'test authority permits only isolated test environments' using errcode = '22023';
  end if;
  update fidensa_private.runtime_authority
    set environment = p_environment, test_clock_at = p_now, test_clock_enabled = true,
        retention_monitoring_started_at = least(retention_monitoring_started_at, p_now),
        updated_at = clock_timestamp()
    where singleton;
end
$function$;

create type fidensa_private.application_lifecycle as enum
  ('pending_verification', 'active', 'anonymized', 'transferred');
create type fidensa_private.verification_state as enum
  ('issued', 'consumed', 'expired', 'superseded', 'delivery_unknown');
create type fidensa_private.subscription_state as enum
  ('pending_confirmation', 'active', 'unsubscribed', 'deleted');
create type fidensa_private.suppression_scope as enum ('marketing_topic', 'global');
create type fidensa_private.suppression_state as enum ('effective', 'released');
create type fidensa_private.queue_state as enum
  ('new', 'shortlist', 'contacted', 'accepted', 'waitlisted', 'declined');
create type fidensa_private.score_kind as enum ('na', 'numeric');
create type fidensa_private.score_set_state as enum ('incomplete', 'complete');
create type fidensa_private.communication_class as enum ('automatic', 'manual');
create type fidensa_private.communication_outcome as enum
  ('intended', 'submitted', 'accepted_by_provider', 'delivery_unknown', 'delivered', 'failed', 'suppressed');
create type fidensa_private.privacy_request_type as enum ('access', 'correction', 'export', 'deletion');
create type fidensa_private.privacy_request_state as enum
  ('awaiting_confirmation', 'verified', 'under_review', 'fulfilled', 'denied', 'withdrawn', 'expired');
create type fidensa_private.provider_event_state as enum
  ('authenticated', 'applied', 'duplicate', 'stale', 'needs_reconciliation');
create type fidensa_private.exercise_state as enum
  ('intake_closed', 'intake_open', 'executed', 'review_pending', 'review_verified', 'cleanup_pending', 'invalidated');
create type fidensa_private.fixture_verifier_state as enum ('issued', 'consumed', 'revoked');
create type fidensa_private.acceptance_state as enum
  ('candidate', 'accepted', 'rejected', 'invalidated', 'cleanup_verified', 'invalidated_cleanup_verified');
create type fidensa_private.job_outcome as enum ('started', 'succeeded', 'failed', 'partial', 'superseded');
create type fidensa_private.artifact_state as enum ('prepared', 'available', 'retrieved', 'expired', 'deleted');

create function fidensa_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

create function fidensa_private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
     and current_user = 'fidensa_mutator'
     and current_setting('fidensa.governed_delete', true) = 'on' then
    return old;
  end if;
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end
$function$;

create table fidensa_private.applications (
  id uuid primary key default gen_random_uuid(),
  canonical_email text not null check (
    canonical_email = lower(canonical_email)
    and canonical_email ~ '^[[:ascii:]]+@[[:alnum:].-]+$'
    and length(canonical_email) between 3 and 254
  ),
  delivery_email text not null check (length(delivery_email) between 3 and 254),
  operation_digest text not null check (operation_digest ~ '^[0-9a-f]{64}$'),
  correlation_id uuid,
  synthetic boolean not null default false,
  lifecycle fidensa_private.application_lifecycle not null default 'pending_verification',
  applicant_name text not null check (char_length(applicant_name) between 1 and 120),
  role_function text not null check (char_length(role_function) between 1 and 120),
  context text not null check (context in ('Work', 'Personal', 'Both')),
  organization text check (organization is null or char_length(organization) between 1 and 160),
  intended_use_case text not null check (char_length(intended_use_case) between 1 and 2000),
  workflow_stage text not null check (char_length(workflow_stage) between 1 and 1000),
  deployment_preference text not null check (deployment_preference in (
    'Fidensa-managed cloud', 'Customer cloud', 'Private/on-premises', 'Hybrid', 'Not sure yet'
  )),
  evaluation_timeline text not null check (evaluation_timeline in (
    'Within 30 days', '1–3 months', '3–6 months', 'More than 6 months', 'No fixed timeline'
  )),
  design_partner_willingness text not null check (design_partner_willingness in ('Yes', 'Maybe', 'No')),
  integration_constraints text check (integration_constraints is null or char_length(integration_constraints) <= 1500),
  referral_source text check (referral_source is null or char_length(referral_source) <= 300),
  additional_context text check (additional_context is null or char_length(additional_context) <= 2000),
  submitted_at timestamptz not null,
  last_direct_interaction_at timestamptz,
  retention_deadline timestamptz not null,
  verified_at timestamptz,
  terminal_at timestamptz,
  transfer_policy_identity text,
  transfer_recorded_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((context = 'Personal') or (organization is not null)),
  check ((lifecycle = 'pending_verification') = (verified_at is null)),
  check (
    retention_deadline = case
      when lifecycle = 'pending_verification' then submitted_at + interval '7 days'
      else greatest(submitted_at, coalesce(last_direct_interaction_at, submitted_at)) + interval '12 months'
    end
  ),
  check ((lifecycle in ('anonymized', 'transferred')) = (terminal_at is not null)),
  check ((lifecycle = 'transferred') = (transfer_policy_identity is not null and transfer_recorded_at is not null)),
  unique (operation_digest)
);

create unique index applications_one_current_email
  on fidensa_private.applications (canonical_email)
  where lifecycle in ('pending_verification', 'active');
create index applications_retention_due on fidensa_private.applications (retention_deadline);

create table fidensa_private.application_operation_guards (
  route text not null check (route = 'application_submission'),
  operation_digest text not null check (operation_digest ~ '^[0-9a-f]{64}$'),
  application_id uuid,
  result_class text not null check (result_class in ('committed', 'duplicate', 'terminal')),
  first_seen_at timestamptz not null,
  terminal_at timestamptz,
  retention_purpose text not null default 'route replay and terminal-state protection'
    check (char_length(retention_purpose) between 1 and 200),
  retention_owner text not null default 'database_owner' check (retention_owner = 'database_owner'),
  retention_anchor_at timestamptz not null,
  review_or_disposal_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (route, operation_digest),
  check (review_or_disposal_at > retention_anchor_at)
);

create table fidensa_private.application_terminal_guards (
  application_id uuid primary key,
  email_rate_digest text not null check (email_rate_digest ~ '^[0-9a-f]{64}$'),
  digest_key_id text not null check (digest_key_id = 'server-hmac-v1'),
  terminal_state text not null check (terminal_state in ('deleted', 'anonymized', 'transferred')),
  terminal_at timestamptz not null,
  reason text not null check (char_length(reason) between 1 and 500),
  retention_purpose text not null default 'restore quarantine and resurrection denial'
    check (char_length(retention_purpose) between 1 and 200),
  retention_owner text not null default 'database_owner' check (retention_owner = 'database_owner'),
  retention_anchor_at timestamptz not null,
  review_or_disposal_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (retention_anchor_at = terminal_at),
  check (review_or_disposal_at > retention_anchor_at)
);

create table fidensa_private.verifications (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  purpose text not null check (purpose = 'application_verification'),
  credential_digest text not null check (credential_digest ~ '^[0-9a-f]{64}$'),
  email_rate_digest text not null check (email_rate_digest ~ '^[0-9a-f]{64}$'),
  digest_key_id text not null default 'server-hmac-v1' check (digest_key_id = 'server-hmac-v1'),
  generation integer not null check (generation > 0),
  state fidensa_private.verification_state not null default 'issued',
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  delivery_operation_id uuid not null,
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (expires_at = issued_at + interval '60 minutes'),
  check ((state = 'consumed') = (consumed_at is not null)),
  unique (application_id, purpose, generation),
  unique (credential_digest),
  unique (delivery_operation_id)
);

create unique index verifications_one_usable_generation
  on fidensa_private.verifications (application_id, purpose)
  where state in ('issued', 'delivery_unknown');

create table fidensa_private.privacy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  notice_version text not null check (char_length(notice_version) between 1 and 80),
  acknowledged boolean not null check (acknowledged),
  acknowledged_at timestamptz not null,
  correction_of uuid references fidensa_private.privacy_acknowledgements(id),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (application_id, notice_version, acknowledged_at)
);

create trigger privacy_acknowledgements_immutable
before update or delete on fidensa_private.privacy_acknowledgements
for each row execute function fidensa_private.reject_mutation();

create table fidensa_private.subscriptions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references fidensa_private.applications(id) on delete set null,
  canonical_email text not null check (canonical_email = lower(canonical_email) and length(canonical_email) <= 254),
  delivery_email text not null check (length(delivery_email) <= 254),
  state fidensa_private.subscription_state not null,
  consent_source text not null check (char_length(consent_source) between 1 and 100),
  consent_text_version text not null check (char_length(consent_text_version) between 1 and 80),
  consented_at timestamptz not null,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  review_identity text,
  review_outcome text check (review_outcome is null or review_outcome in ('permissive', 'denied', 'unavailable')),
  next_review_due_at timestamptz,
  correlation_id uuid,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((state = 'active') = (confirmed_at is not null and unsubscribed_at is null)),
  check ((state = 'unsubscribed') = (unsubscribed_at is not null))
);

create unique index subscriptions_one_current_email
  on fidensa_private.subscriptions (canonical_email)
  where state <> 'deleted';

create table fidensa_private.consent_acts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  subscription_id uuid references fidensa_private.subscriptions(id) on delete set null,
  canonical_email text not null check (canonical_email = lower(canonical_email) and length(canonical_email) <= 254),
  consent_source text not null check (char_length(consent_source) between 1 and 100),
  consent_text_version text not null check (char_length(consent_text_version) between 1 and 80),
  selected_at timestamptz not null,
  confirmed_at timestamptz,
  state text not null check (state in ('pending_confirmation', 'confirmed')),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (application_id),
  check ((state = 'confirmed') = (confirmed_at is not null))
);

create table fidensa_private.consent_history (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references fidensa_private.subscriptions(id) on delete cascade,
  prior_state fidensa_private.subscription_state,
  new_state fidensa_private.subscription_state not null,
  source text not null check (char_length(source) between 1 and 100),
  text_version text not null check (char_length(text_version) between 1 and 80),
  actor text not null check (char_length(actor) between 1 and 100),
  occurred_at timestamptz not null,
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check (prior_state is null or prior_state <> new_state)
);

create trigger consent_history_immutable
before update or delete on fidensa_private.consent_history
for each row execute function fidensa_private.reject_mutation();

create table fidensa_private.suppressions (
  id uuid primary key default gen_random_uuid(),
  canonical_email text not null check (canonical_email = lower(canonical_email) and length(canonical_email) <= 254),
  scope fidensa_private.suppression_scope not null,
  state fidensa_private.suppression_state not null default 'effective',
  reason text not null check (char_length(reason) between 1 and 200),
  source_event text not null check (char_length(source_event) between 1 and 150),
  effective_at timestamptz not null,
  released_at timestamptz,
  release_authority text,
  retention_purpose text not null check (char_length(retention_purpose) between 1 and 200),
  review_or_disposal_at timestamptz not null,
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check ((state = 'released') = (released_at is not null and release_authority is not null))
);

create table fidensa_private.suppression_reviews (
  id uuid primary key default gen_random_uuid(),
  suppression_id uuid not null references fidensa_private.suppressions(id) on delete cascade,
  review_due_at timestamptz not null,
  detected_at timestamptz not null,
  owner text not null check (owner = 'scott_bishop'),
  state text not null default 'pending' check (state in ('pending', 'completed')),
  completed_at timestamptz,
  outcome text check (outcome is null or char_length(outcome) between 1 and 300),
  created_at timestamptz not null default clock_timestamp(),
  unique (suppression_id, review_due_at),
  check ((state = 'completed') = (completed_at is not null and outcome is not null))
);

create unique index suppressions_one_effective_scope
  on fidensa_private.suppressions (canonical_email, scope)
  where state = 'effective';

create table fidensa_private.reviewer_status (
  application_id uuid primary key references fidensa_private.applications(id) on delete cascade,
  state fidensa_private.queue_state not null,
  actor text not null check (actor in ('system', 'scott_bishop')),
  reason text not null check (char_length(reason) between 1 and 500),
  changed_at timestamptz not null,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.reviewer_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  prior_state fidensa_private.queue_state,
  new_state fidensa_private.queue_state not null,
  actor text not null check (actor in ('system', 'scott_bishop')),
  reason text not null check (char_length(reason) between 1 and 500),
  occurred_at timestamptz not null,
  transition_version bigint not null check (transition_version > 0),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check (prior_state is null or prior_state <> new_state),
  unique (application_id, transition_version)
);

create trigger reviewer_status_history_immutable
before update or delete on fidensa_private.reviewer_status_history
for each row execute function fidensa_private.reject_mutation();

create function fidensa_private.enforce_queue_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  gate text := current_setting('fidensa.queue_write', true);
begin
  if current_user <> 'fidensa_mutator'
     or gate is null or gate <> new.application_id::text then
    raise exception 'reviewer queue writes require a constrained operation' using errcode = '42501';
  end if;
  return new;
end
$function$;

create trigger reviewer_status_constrained_insert
before insert or update on fidensa_private.reviewer_status
for each row execute function fidensa_private.enforce_queue_write();
create trigger reviewer_status_history_constrained_insert
before insert on fidensa_private.reviewer_status_history
for each row execute function fidensa_private.enforce_queue_write();

create table fidensa_private.rubric_versions (
  id uuid primary key default gen_random_uuid(),
  version_label text not null unique check (char_length(version_label) between 1 and 80),
  cohort_label text not null unique check (char_length(cohort_label) between 1 and 80),
  prohibited_factors text[] not null,
  active boolean not null default false,
  material_change boolean not null default false,
  first_scored_at timestamptz,
  scored_since_calibration integer not null default 0 check (scored_since_calibration >= 0),
  calibration_anchor_at timestamptz,
  created_by text not null check (created_by = 'scott_bishop'),
  created_at timestamptz not null default clock_timestamp(),
  check (array_length(prohibited_factors, 1) = 3)
);

create unique index rubric_versions_one_active on fidensa_private.rubric_versions ((true)) where active;

create table fidensa_private.rubric_criteria (
  id uuid primary key default gen_random_uuid(),
  rubric_version_id uuid not null references fidensa_private.rubric_versions(id) on delete restrict,
  ordinal smallint not null check (ordinal between 1 and 5),
  criterion_key text not null check (criterion_key in (
    'real_ai_security_need', 'contained_runner_fit', 'design_partner_willingness',
    'deployment_feasibility', 'feedback_urgency'
  )),
  label text not null check (char_length(label) between 1 and 160),
  created_at timestamptz not null default clock_timestamp(),
  unique (rubric_version_id, ordinal),
  unique (rubric_version_id, criterion_key)
);

create trigger rubric_versions_immutable
before delete on fidensa_private.rubric_versions
for each row execute function fidensa_private.reject_mutation();
create trigger rubric_criteria_immutable
before update or delete on fidensa_private.rubric_criteria
for each row execute function fidensa_private.reject_mutation();

create table fidensa_private.application_score_cohorts (
  application_id uuid primary key references fidensa_private.applications(id) on delete cascade,
  rubric_version_id uuid not null references fidensa_private.rubric_versions(id) on delete restrict,
  first_scored_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.score_sets (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  rubric_version_id uuid not null references fidensa_private.rubric_versions(id) on delete restrict,
  state fidensa_private.score_set_state not null default 'incomplete',
  assessor text not null check (assessor = 'scott_bishop'),
  assessed_at timestamptz not null,
  superseded_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (application_id, rubric_version_id, version)
);

create unique index score_sets_one_effective
  on fidensa_private.score_sets (application_id, rubric_version_id)
  where superseded_at is null;

create table fidensa_private.scores (
  id uuid primary key default gen_random_uuid(),
  score_set_id uuid not null references fidensa_private.score_sets(id) on delete cascade,
  criterion_id uuid not null references fidensa_private.rubric_criteria(id) on delete restrict,
  value_kind fidensa_private.score_kind not null,
  numeric_value smallint,
  rationale text not null check (char_length(rationale) between 1 and 500),
  assessor text not null check (assessor = 'scott_bishop'),
  assessed_at timestamptz not null,
  superseded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (value_kind = 'na' and numeric_value is null)
    or (value_kind = 'numeric' and numeric_value between 0 and 4)
  )
);

create unique index scores_one_effective_criterion
  on fidensa_private.scores (score_set_id, criterion_id)
  where superseded_at is null;

create table fidensa_private.rubric_calibrations (
  id uuid primary key default gen_random_uuid(),
  rubric_version_id uuid not null references fidensa_private.rubric_versions(id) on delete restrict,
  actor text not null check (actor = 'scott_bishop'),
  findings text not null check (char_length(findings) between 1 and 1000),
  scored_application_count integer not null check (scored_application_count >= 0),
  recorded_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.rubric_rescore_requirements (
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  rubric_version_id uuid not null references fidensa_private.rubric_versions(id) on delete cascade,
  required_at timestamptz not null,
  completed_at timestamptz,
  primary key (application_id, rubric_version_id)
);

create table fidensa_private.communications (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references fidensa_private.applications(id) on delete cascade,
  subscription_id uuid references fidensa_private.subscriptions(id) on delete cascade,
  type text not null check (type in (
    'verification', 'receipt', 'reviewer_notification', 'privacy_confirmation',
    'interview', 'waitlist', 'decision', 'early_access', 'status', 'privacy_response'
  )),
  class fidensa_private.communication_class not null,
  actor text not null check (char_length(actor) between 1 and 100),
  recipient_class text not null check (recipient_class in ('applicant', 'reviewer', 'privacy_requester')),
  template_version text not null check (char_length(template_version) between 1 and 80),
  operation_id uuid not null unique,
  provider_message_digest text check (provider_message_digest is null or provider_message_digest ~ '^[0-9a-f]{64}$'),
  outcome fidensa_private.communication_outcome not null,
  note text check (note is null or char_length(note) <= 500),
  occurred_at timestamptz not null,
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check (application_id is not null or subscription_id is not null),
  check (
    (class = 'automatic' and type in ('verification', 'receipt', 'reviewer_notification') and actor = 'system')
    or (class = 'manual' and type not in ('verification', 'receipt', 'reviewer_notification') and actor = 'scott_bishop')
  )
);

create table fidensa_private.communication_outcomes (
  id uuid primary key default gen_random_uuid(),
  communication_id uuid not null references fidensa_private.communications(id) on delete cascade,
  prior_outcome fidensa_private.communication_outcome,
  new_outcome fidensa_private.communication_outcome not null,
  provider_event_digest text check (provider_event_digest is null or provider_event_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (prior_outcome is null or prior_outcome <> new_outcome)
);

create trigger communication_outcomes_immutable
before update or delete on fidensa_private.communication_outcomes
for each row execute function fidensa_private.reject_mutation();

create table fidensa_private.abuse_events (
  id uuid primary key default gen_random_uuid(),
  event_class text not null check (event_class in ('submission', 'verification', 'delivery', 'privacy_intake', 'invalid_webhook')),
  ip_digest text not null check (ip_digest ~ '^[0-9a-f]{64}$'),
  email_digest text check (email_digest is null or email_digest ~ '^[0-9a-f]{64}$'),
  rate_class text not null check (char_length(rate_class) between 1 and 80),
  result_class text not null check (char_length(result_class) between 1 and 80),
  occurred_at timestamptz not null,
  deletion_deadline timestamptz not null check (deletion_deadline = occurred_at + interval '48 hours'),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp()
);

create index abuse_events_rate_lookup on fidensa_private.abuse_events (event_class, ip_digest, occurred_at);
create index abuse_events_deletion_due on fidensa_private.abuse_events (deletion_deadline);

create table fidensa_private.abuse_investigations (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (char_length(purpose) between 1 and 300),
  selected_at timestamptz not null,
  owner text not null check (owner = 'scott_bishop'),
  event_ids uuid[] not null check (cardinality(event_ids) between 1 and 100),
  deletion_deadline timestamptz not null check (deletion_deadline = selected_at + interval '30 days'),
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.operational_logs (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('Local', 'Test', 'Staged-production', 'Production')),
  event_class text not null check (char_length(event_class) between 1 and 80),
  operation_id uuid not null,
  result_class text not null check (char_length(result_class) between 1 and 80),
  occurred_at timestamptz not null,
  deletion_deadline timestamptz not null check (deletion_deadline = occurred_at + interval '30 days'),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (environment, event_class, operation_id)
);

create table fidensa_private.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  request_type fidensa_private.privacy_request_type not null,
  canonical_email text not null check (canonical_email = lower(canonical_email) and length(canonical_email) <= 254),
  delivery_email text not null check (length(delivery_email) <= 254),
  route text not null check (route in ('privacy_public', 'privacy_mailbox')),
  operation_digest text not null check (operation_digest ~ '^[0-9a-f]{64}$'),
  explanation text check (explanation is null or char_length(explanation) <= 1000),
  matching_name text check (matching_name is null or char_length(matching_name) <= 120),
  matching_organization text check (matching_organization is null or char_length(matching_organization) <= 160),
  matching_submission_date date,
  state fidensa_private.privacy_request_state not null default 'awaiting_confirmation',
  verified_scope text[] check (verified_scope is null or verified_scope <@ array['application','subscription','suppression','all']::text[]),
  received_at timestamptz not null,
  confirmation_intent_due_at timestamptz not null check (confirmation_intent_due_at = received_at + interval '24 hours'),
  confirmation_sent_at timestamptz,
  target_due_at timestamptz not null check (target_due_at = received_at + interval '30 days'),
  terminal_at timestamptz,
  closed_record_deletion_deadline timestamptz,
  version bigint not null default 1 check (version > 0),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (route, operation_digest),
  check ((state in ('fulfilled', 'denied', 'withdrawn', 'expired')) = (terminal_at is not null)),
  check (closed_record_deletion_deadline is not distinct from (
    case when terminal_at is null then null else terminal_at + interval '24 months' end
  )),
  check (state = 'awaiting_confirmation' or verified_scope is not null)
);

create unique index privacy_requests_one_open_type
  on fidensa_private.privacy_requests (canonical_email, request_type)
  where state not in ('fulfilled', 'denied', 'withdrawn', 'expired');

create table fidensa_private.privacy_request_history (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  prior_state fidensa_private.privacy_request_state,
  new_state fidensa_private.privacy_request_state not null,
  event_class text not null check (event_class in ('transition', 'partially_fulfilled')),
  actor text not null check (char_length(actor) between 1 and 100),
  reason text not null check (char_length(reason) between 1 and 500),
  occurred_at timestamptz not null,
  transition_version bigint not null check (transition_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (privacy_request_id, transition_version),
  check (event_class = 'partially_fulfilled' or prior_state is null or prior_state <> new_state)
);

create trigger privacy_request_history_immutable
before update or delete on fidensa_private.privacy_request_history
for each row execute function fidensa_private.reject_mutation();

create table fidensa_private.privacy_credentials (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  purpose text not null check (purpose in ('privacy_confirmation', 'export_retrieval')),
  credential_digest text not null check (credential_digest ~ '^[0-9a-f]{64}$'),
  generation integer not null check (generation > 0),
  state fidensa_private.verification_state not null default 'issued',
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at = issued_at + interval '30 minutes'),
  check ((state = 'consumed') = (consumed_at is not null)),
  unique (privacy_request_id, purpose, generation),
  unique (credential_digest)
);

create unique index privacy_credentials_one_usable
  on fidensa_private.privacy_credentials (privacy_request_id, purpose)
  where state in ('issued', 'delivery_unknown');

create table fidensa_private.identity_proofs (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  proof_reference_digest text not null check (proof_reference_digest ~ '^[0-9a-f]{64}$'),
  evidence_class text not null check (evidence_class in ('mismatch', 'fraud', 'inaccessible_email', 'representative')),
  result text not null check (char_length(result) between 1 and 100),
  purpose_ended_at timestamptz,
  deletion_deadline timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (deletion_deadline is not distinct from (
    case when purpose_ended_at is null then null else purpose_ended_at + interval '24 hours' end
  ))
);

create table fidensa_private.privacy_export_artifacts (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  export_version integer not null check (export_version > 0),
  encrypted_bytes bytea,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  state fidensa_private.artifact_state not null,
  created_at timestamptz not null,
  byte_deletion_deadline timestamptz not null check (byte_deletion_deadline = created_at + interval '24 hours'),
  retrieved_at timestamptz,
  deleted_at timestamptz,
  unique (privacy_request_id, export_version),
  check ((state in ('retrieved', 'expired', 'deleted')) = (encrypted_bytes is null))
);

create unique index privacy_export_one_current
  on fidensa_private.privacy_export_artifacts (privacy_request_id)
  where state in ('prepared', 'available');

create table fidensa_private.privacy_export_sessions (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references fidensa_private.privacy_export_artifacts(id) on delete cascade,
  authorization_generation integer not null check (authorization_generation > 0),
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  check (expires_at = created_at + interval '10 minutes'),
  unique (artifact_id, authorization_generation),
  unique (session_digest)
);

create table fidensa_private.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_digest text not null unique check (provider_event_digest ~ '^[0-9a-f]{64}$'),
  event_type text not null check (char_length(event_type) between 1 and 100),
  occurred_at timestamptz not null,
  first_authenticated_received_at timestamptz not null,
  linked_domain text not null check (linked_domain in ('subscription', 'suppression', 'communication', 'exercise')),
  linked_id uuid,
  normalized_outcome text not null check (char_length(normalized_outcome) between 1 and 100),
  state fidensa_private.provider_event_state not null,
  deletion_deadline timestamptz not null check (deletion_deadline = first_authenticated_received_at + interval '90 days'),
  correlation_id uuid,
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.exercise_controls (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null unique,
  checklist_version text not null check (checklist_version = 'controlled-exercise-v1.0'),
  checklist_digest text not null check (checklist_digest ~ '^[0-9a-f]{64}$'),
  deployment_identity text not null check (char_length(deployment_identity) between 1 and 200),
  config_digest text not null check (config_digest ~ '^[0-9a-f]{64}$'),
  commit_identity text not null check (commit_identity ~ '^[0-9a-f]{40}$'),
  exact_recipient text not null check (exact_recipient = lower(exact_recipient) and length(exact_recipient) <= 254),
  synthetic boolean not null check (synthetic),
  state fidensa_private.exercise_state not null default 'intake_closed',
  opens_at timestamptz not null,
  expires_at timestamptz not null,
  creator text not null check (creator = 'scott_bishop'),
  cleanup_owner text not null check (cleanup_owner = 'controlled-exercise-cleanup'),
  executed_at timestamptz,
  review_run_identity text,
  independent_verdict text check (independent_verdict is null or independent_verdict in ('approve', 'reject')),
  invalidation_reason text check (invalidation_reason is null or char_length(invalidation_reason) <= 500),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (expires_at > opens_at),
  check ((state in ('executed', 'review_pending', 'review_verified', 'cleanup_pending')) = (executed_at is not null)),
  check (state <> 'review_verified' or (review_run_identity is not null and independent_verdict = 'approve')),
  check (state <> 'invalidated' or invalidation_reason is not null)
);

create unique index exercise_controls_one_working_gate
  on fidensa_private.exercise_controls ((true));

create table fidensa_private.fixture_verifiers (
  id uuid primary key default gen_random_uuid(),
  exercise_control_id uuid not null references fidensa_private.exercise_controls(id) on delete restrict,
  purpose text not null check (purpose = 'synthetic_fixture_ingress'),
  generation integer not null check (generation > 0),
  credential_digest text not null check (credential_digest ~ '^[0-9a-f]{64}$'),
  state fidensa_private.fixture_verifier_state not null default 'issued',
  issued_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((state = 'consumed') = (consumed_at is not null)),
  check ((state = 'revoked') = (revoked_at is not null)),
  unique (exercise_control_id, purpose, generation),
  unique (credential_digest)
);

create unique index fixture_verifiers_one_usable
  on fidensa_private.fixture_verifiers (exercise_control_id, purpose)
  where state = 'issued';

create table fidensa_private.acceptance_records (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null unique,
  checklist_version text not null check (checklist_version = 'controlled-exercise-v1.0'),
  checklist_digest text not null check (checklist_digest ~ '^[0-9a-f]{64}$'),
  synthetic boolean not null check (synthetic),
  commit_identity text not null check (commit_identity ~ '^[0-9a-f]{40}$'),
  deployment_identity text not null check (char_length(deployment_identity) between 1 and 200),
  config_digest text not null check (config_digest ~ '^[0-9a-f]{64}$'),
  member_manifest_digest text not null check (member_manifest_digest ~ '^[0-9a-f]{64}$'),
  reviewer_run_identity text,
  verdict text check (verdict is null or verdict in ('approve', 'reject')),
  access_revoked_at timestamptz,
  cleanup_verified_at timestamptz,
  exception_summary text check (exception_summary is null or char_length(exception_summary) <= 500),
  state fidensa_private.acceptance_state not null default 'candidate',
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (state = 'candidate' or reviewer_run_identity is not null or state = 'invalidated'),
  check (state not in ('cleanup_verified', 'invalidated_cleanup_verified') or cleanup_verified_at is not null)
);

create table fidensa_private.job_schedules (
  job_type text primary key,
  version text not null,
  cron_expression text not null,
  deadline_budget interval not null,
  advance_horizon interval not null,
  owner text not null,
  provider_execution boolean not null default false,
  backup_caveat text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  version text not null,
  scheduled_bucket timestamptz not null,
  selection_cutoff timestamptz not null,
  oldest_due_deadline timestamptz,
  first_started_at timestamptz not null,
  first_terminal_at timestamptz,
  outcome fidensa_private.job_outcome not null,
  selected_count integer not null default 0 check (selected_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  remaining_count integer not null default 0 check (remaining_count >= 0),
  cursor_digest text check (cursor_digest is null or cursor_digest ~ '^[0-9a-f]{64}$'),
  correlation_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (job_type, version, scheduled_bucket),
  check (selection_cutoff = scheduled_bucket + interval '25 minutes'),
  check ((outcome = 'started') = (first_terminal_at is null)),
  check (expires_at is not distinct from (
    case when first_terminal_at is null then null else first_terminal_at + interval '90 days' end
  ))
);

create table fidensa_private.job_run_attempts (
  id uuid primary key default gen_random_uuid(),
  job_run_id uuid not null references fidensa_private.job_runs(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  started_at timestamptz not null,
  completed_at timestamptz,
  outcome fidensa_private.job_outcome not null,
  selected_count integer not null default 0 check (selected_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  remaining_count integer not null default 0 check (remaining_count >= 0),
  retry_of uuid references fidensa_private.job_run_attempts(id),
  delay_observed boolean not null default false,
  incident boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique (job_run_id, attempt),
  check ((outcome = 'started') = (completed_at is null))
);

create table fidensa_private.retention_incidents (
  id uuid primary key default gen_random_uuid(),
  job_run_id uuid not null references fidensa_private.job_runs(id) on delete cascade,
  incident_class text not null check (incident_class in ('late_start', 'late_commit', 'not_started', 'overdue_row', 'provider_cleanup')),
  detected_at timestamptz not null,
  oldest_overdue_at timestamptz,
  intake_close_due_at timestamptz,
  resolved_at timestamptz,
  resolution_owner text not null check (resolution_owner = 'scott_bishop'),
  created_at timestamptz not null default clock_timestamp(),
  unique (job_run_id, incident_class)
);

create table fidensa_private.retention_health_reviews (
  id uuid primary key default gen_random_uuid(),
  scheduled_bucket timestamptz not null unique,
  observed_at timestamptz not null,
  checked_bucket_count integer not null check (checked_bucket_count >= 0),
  missed_bucket_count integer not null check (missed_bucket_count >= 0),
  overdue_row_count integer not null check (overdue_row_count >= 0),
  unresolved_incident_count integer not null check (unresolved_incident_count >= 0),
  intake_closed boolean not null,
  outcome text not null check (outcome in ('healthy', 'incident')),
  created_at timestamptz not null default clock_timestamp()
);

insert into fidensa_private.job_schedules
  (job_type, version, cron_expression, deadline_budget, advance_horizon, owner, provider_execution, backup_caveat)
values
  ('database_retention', 'v1', '*/15 * * * *', interval '5 minutes', interval '25 minutes', 'fidensa_job', false,
   'Deleted data may persist only in the provider normal backup cycle; physical restores may restart pg_cron jobs immediately and remain quarantined until jobs are controlled and terminal and retention guards replay.'),
  ('provider_reconciliation', 'v1', '10 * * * *', interval '50 minutes', interval '0', 'website_job_owner', true,
   'The database scheduler never receives provider credentials; unresolved provider cleanup keeps the run partial.'),
  ('retention_health', 'v1', '0 14 * * *', interval '5 minutes', interval '0', 'fidensa_job', false,
   'Daily health review records zero-overdue evidence independently of endpoint access denial.'),
  ('cron_history_retention', 'v1', '30 14 * * *', interval '60 minutes', interval '0', 'fidensa_job', false,
   'Supabase Cron run history is provider-managed operational residue; retain only 90 days for job accountability.');

-- All base relations are protected by both grants and RLS. No browser policy
-- exists, so even an accidental future table grant still yields zero rows.
do $secure_tables$
declare
  relation_name text;
begin
  for relation_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'fidensa_private' and c.relkind in ('r', 'p')
  loop
    execute format('alter table fidensa_private.%I enable row level security', relation_name);
    execute format('revoke all on table fidensa_private.%I from public, anon, authenticated, service_role, fidensa_server, fidensa_job', relation_name);
  end loop;
end
$secure_tables$;

commit;

begin;

alter table fidensa_private.subscriptions
  add column reviewed_at timestamptz;

alter table fidensa_private.subscriptions
  add constraint subscriptions_quarterly_review check (
    (reviewed_at is null and review_identity is null and review_outcome is null and next_review_due_at is null)
    or (
      reviewed_at is not null
      and review_identity is not null
      and review_outcome is not null
      and next_review_due_at = reviewed_at + interval '3 months'
    )
  );

create table fidensa_private.provider_contact_state (
  canonical_email text primary key check (
    canonical_email = lower(canonical_email) and length(canonical_email) between 3 and 254
  ),
  subscription_id uuid references fidensa_private.subscriptions(id) on delete set null,
  subscription_version bigint check (subscription_version is null or subscription_version > 0),
  available boolean not null default false,
  contact_subscribed boolean,
  marketing_topic_subscribed boolean,
  globally_restricted boolean,
  observed_at timestamptz,
  first_active_read_back_at timestamptz,
  last_provider_event_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (
    available or (
      contact_subscribed is null and marketing_topic_subscribed is null
      and globally_restricted is null
    )
  )
);

create table fidensa_private.subscription_sync_operations (
  operation_id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references fidensa_private.subscriptions(id) on delete cascade,
  subscription_version bigint not null check (subscription_version > 0),
  canonical_email text not null check (
    canonical_email = lower(canonical_email) and length(canonical_email) between 3 and 254
  ),
  desired_state fidensa_private.subscription_state not null check (
    desired_state in ('active', 'unsubscribed', 'deleted')
  ),
  state text not null default 'pending' check (
    state in ('pending', 'claimed', 'needs_reconciliation', 'applied', 'failed', 'superseded')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (subscription_id, subscription_version)
);

create index subscription_sync_claimable
  on fidensa_private.subscription_sync_operations (state, created_at);

create table fidensa_private.provider_suppression_sync_operations (
  operation_id uuid primary key default gen_random_uuid(),
  suppression_id uuid not null references fidensa_private.suppressions(id) on delete cascade,
  canonical_email text not null check (
    canonical_email = lower(canonical_email) and length(canonical_email) between 3 and 254
  ),
  scope fidensa_private.suppression_scope not null,
  state text not null default 'pending' check (
    state in ('pending','claimed','needs_reconciliation','applied','failed')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (suppression_id)
);

create index provider_suppression_sync_claimable
  on fidensa_private.provider_suppression_sync_operations (state, created_at);

create table fidensa_private.manual_message_templates (
  type text not null check (type in ('interview', 'waitlist', 'decision', 'early_access')),
  version text not null check (char_length(version) between 1 and 80),
  subject text not null check (char_length(subject) between 1 and 200),
  body text not null check (char_length(body) between 1 and 2000),
  state text not null default 'draft' check (state in ('draft', 'approved', 'retired')),
  approved_by text check (approved_by is null or approved_by = 'scott_bishop'),
  approved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (type, version),
  check ((state = 'approved') = (approved_by is not null and approved_at is not null))
);

insert into fidensa_private.manual_message_templates (type, version, subject, body)
values
  ('interview', 'interview-draft-v1', 'Fidensa application: interview invitation',
   'We would like to continue the conversation about your Fidensa application. Reply to arrange a time. This invitation does not guarantee access.'),
  ('waitlist', 'waitlist-draft-v1', 'Fidensa application update',
   'Your application remains under consideration, but we cannot offer access now. We do not promise a future invitation or review date.'),
  ('decision', 'decision-draft-v1', 'Fidensa application decision',
   'We are writing with a decision about your Fidensa application. This message concerns only your application and is not a marketing message.'),
  ('early_access', 'early-access-draft-v1', 'Fidensa early-access invitation',
   'We would like to invite you to discuss limited Fidensa early access. Reply for the next steps; do not send secrets or sensitive system data by email.');

create table fidensa_private.privacy_operation_audit (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  operation text not null check (operation in ('access', 'correction', 'export', 'deletion', 'partial_cleanup')),
  verified_scope text[] not null check (
    cardinality(verified_scope) > 0
    and verified_scope <@ array['application','subscription','suppression','all']::text[]
  ),
  actor text not null check (actor = 'scott_bishop'),
  outcome text not null check (outcome in ('completed', 'partial', 'denied')),
  reason text not null check (char_length(reason) between 1 and 500),
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table fidensa_private.privacy_application_authorizations (
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  application_id uuid not null references fidensa_private.applications(id) on delete cascade,
  operation text not null check (operation in ('correction', 'deletion')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (privacy_request_id, application_id, operation),
  check (expires_at = created_at + interval '5 minutes')
);

create table fidensa_private.privacy_subscription_authorizations (
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  subscription_id uuid not null references fidensa_private.subscriptions(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (privacy_request_id, subscription_id),
  check (expires_at = created_at + interval '5 minutes')
);

create table fidensa_private.privacy_confirmation_intents (
  id uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null references fidensa_private.privacy_requests(id) on delete cascade,
  application_id uuid references fidensa_private.applications(id) on delete cascade,
  subscription_id uuid references fidensa_private.subscriptions(id) on delete cascade,
  generation integer not null check (generation > 0),
  verified_scope text[] not null check (
    cardinality(verified_scope) > 0
    and verified_scope <@ array['application','subscription','suppression','all']::text[]
  ),
  target_delivery_email text not null check (char_length(target_delivery_email) between 3 and 254),
  state text not null default 'pending' check (
    state in ('pending','claimed','issued','failed','superseded')
  ),
  actor text not null check (actor = 'scott_bishop'),
  manual_intent_at timestamptz not null,
  lease_expires_at timestamptz,
  issued_at timestamptz,
  operation_id uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (privacy_request_id, generation),
  check ((application_id is not null)::integer + (subscription_id is not null)::integer = 1),
  check ((state in ('issued','superseded')) = (issued_at is not null))
);

create unique index privacy_confirmation_one_in_flight
  on fidensa_private.privacy_confirmation_intents (privacy_request_id)
  where state in ('pending','claimed');

alter table fidensa_private.provider_contact_state enable row level security;
alter table fidensa_private.subscription_sync_operations enable row level security;
alter table fidensa_private.provider_suppression_sync_operations enable row level security;
alter table fidensa_private.manual_message_templates enable row level security;
alter table fidensa_private.privacy_operation_audit enable row level security;
alter table fidensa_private.privacy_application_authorizations enable row level security;
alter table fidensa_private.privacy_subscription_authorizations enable row level security;
alter table fidensa_private.privacy_confirmation_intents enable row level security;

revoke all on fidensa_private.provider_contact_state from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.subscription_sync_operations from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.provider_suppression_sync_operations from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.manual_message_templates from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.privacy_operation_audit from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.privacy_application_authorizations from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.privacy_subscription_authorizations from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke all on fidensa_private.privacy_confirmation_intents from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

create function fidensa_private.queue_subscription_sync()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.state in ('active', 'unsubscribed', 'deleted')
     and (tg_op = 'INSERT' or old.version <> new.version or old.state <> new.state) then
    update fidensa_private.subscription_sync_operations
       set state = 'superseded', lease_expires_at = null,
           updated_at = fidensa_private.authoritative_now()
     where subscription_id = new.id and subscription_version < new.version
       and state in ('pending', 'claimed', 'needs_reconciliation', 'failed');
    insert into fidensa_private.subscription_sync_operations (
      subscription_id, subscription_version, canonical_email, desired_state
    ) values (new.id, new.version, new.canonical_email, new.state)
    on conflict (subscription_id, subscription_version) do nothing;
  end if;
  return new;
end
$function$;

create trigger subscriptions_queue_provider_sync
after insert or update on fidensa_private.subscriptions
for each row execute function fidensa_private.queue_subscription_sync();

create function fidensa_private.queue_global_suppression_sync()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.state = 'effective' then
    insert into fidensa_private.provider_suppression_sync_operations (
      suppression_id, canonical_email, scope
    ) values (new.id, new.canonical_email, new.scope)
    on conflict (suppression_id) do nothing;
  end if;
  return new;
end
$function$;

create trigger suppressions_queue_provider_sync
after insert on fidensa_private.suppressions
for each row execute function fidensa_private.queue_global_suppression_sync();

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
    if pg_trigger_depth() <= 1 then
      if exists (
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
        raise exception 'subscription deletion requires parent retention, verified privacy scope, or cascade' using errcode = '55000';
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

create or replace function fidensa_private.enforce_application_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare rate_digest text;
declare cleanup_allowed boolean := false;
declare retention_allowed boolean := false;
declare privacy_request uuid;
declare terminal_reason text;
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
    select privacy_request_id into privacy_request
      from fidensa_private.privacy_application_authorizations
     where application_id = old.id and operation = 'deletion'
       and consumed_at is null and expires_at > operation_time
     for update;
    select exists (
      select 1 from fidensa_private.exercise_controls
      where correlation_id = old.correlation_id and state = 'cleanup_pending'
    ) into cleanup_allowed;
    retention_allowed := old.lifecycle <> 'transferred'
      and old.retention_deadline <= operation_time + interval '25 minutes';
    if privacy_request is null and not cleanup_allowed and not retention_allowed then
      raise exception 'application deletion requires retention, exercise cleanup, or verified privacy scope' using errcode = '55000';
    end if;

    select email_rate_digest into rate_digest
      from fidensa_private.verifications
      where application_id = old.id order by generation desc limit 1;
    if rate_digest is null then
      raise exception 'application deletion requires its rate-keyed terminal evidence' using errcode = '55000';
    end if;
    terminal_reason := case
      when privacy_request is not null then 'verified_privacy_deletion'
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
        and terminal_state = 'deleted' and reason = terminal_reason
    ) then
      raise exception 'application deletion requires an immutable terminal guard' using errcode = '55000';
    end if;
    if privacy_request is not null then
      update fidensa_private.privacy_application_authorizations
         set consumed_at = operation_time
       where privacy_request_id = privacy_request and application_id = old.id
         and operation = 'deletion';
    end if;
    return old;
  end if;

  if old.lifecycle in ('anonymized', 'transferred') then
    raise exception 'terminal application state cannot be changed' using errcode = '55000';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'application updates advance exactly one version' using errcode = '55000';
  end if;
  select privacy_request_id into privacy_request
    from fidensa_private.privacy_application_authorizations
   where application_id = old.id and operation = 'correction'
     and consumed_at is null and expires_at > operation_time
   for update;
  if privacy_request is not null
     and old.lifecycle = 'active' and new.lifecycle = 'active'
     and (to_jsonb(new) - array['applicant_name','delivery_email','organization','version','updated_at'])
       is not distinct from
         (to_jsonb(old) - array['applicant_name','delivery_email','organization','version','updated_at']) then
    update fidensa_private.privacy_application_authorizations
       set consumed_at = operation_time
     where privacy_request_id = privacy_request and application_id = old.id
       and operation = 'correction';
    return new;
  end if;
  if old.lifecycle = 'pending_verification' and new.lifecycle = 'active' then
    if new.verified_at is null or new.terminal_at is not null
       or new.verified_at > operation_time
       or new.verified_at < operation_time - interval '5 seconds'
       or new.updated_at <> new.verified_at
       or new.retention_deadline < new.verified_at
       or new.retention_deadline < new.submitted_at + interval '12 months'
       or (to_jsonb(new) - array['lifecycle','verified_at','retention_deadline','version','updated_at'])
          is distinct from
          (to_jsonb(old) - array['lifecycle','verified_at','retention_deadline','version','updated_at']) then
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
      raise exception 'active application updates are limited to a non-future direct interaction or verified correction' using errcode = '55000';
    end if;
  else
    raise exception 'invalid application lifecycle transition' using errcode = '55000';
  end if;
  return new;
end
$function$;

create or replace function fidensa_private.enforce_terminal_guard_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare app_record fidensa_private.applications%rowtype;
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare expected_digest text;
declare cleanup_allowed boolean := false;
declare retention_allowed boolean := false;
declare privacy_allowed boolean := false;
begin
  if tg_op <> 'INSERT' then
    raise exception 'terminal guards are append-only anti-resurrection evidence' using errcode = '55000';
  end if;
  select * into app_record from fidensa_private.applications where id = new.application_id;
  if not found then
    if fidensa_private.authoritative_environment() = 'Test'
       and new.reason = 'synthetic guard review' then return new; end if;
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
    if app_record.lifecycle <> 'transferred' or app_record.terminal_at <> new.terminal_at
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

create function fidensa_api.record_subscription_review(
  p_subscription_id uuid,
  p_expected_version bigint,
  p_review_identity text,
  p_outcome text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare next_version bigint;
begin
  if p_outcome not in ('permissive', 'denied', 'unavailable')
     or char_length(p_review_identity) not between 1 and 200 then
    raise exception 'subscription review is malformed' using errcode = '22023';
  end if;
  select version + 1 into next_version
    from fidensa_private.subscriptions
   where id = p_subscription_id and state = 'active' and version = p_expected_version
   for update;
  if next_version is null then
    raise exception 'active subscription review version conflict' using errcode = '40001';
  end if;
  update fidensa_private.subscriptions
     set reviewed_at = operation_time,
         review_identity = p_review_identity,
         review_outcome = p_outcome,
         next_review_due_at = operation_time + interval '3 months',
         version = next_version,
         updated_at = operation_time
   where id = p_subscription_id;
  return next_version;
end
$function$;

create function fidensa_api.record_provider_event_v2(
  p_event_digest text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_canonical_email text,
  p_scope text default null,
  p_reason text default null,
  p_relaxation_claimed boolean default false
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare existing_event fidensa_private.provider_events%rowtype;
declare current_provider fidensa_private.provider_contact_state%rowtype;
declare subscription_record fidensa_private.subscriptions%rowtype;
declare event_state fidensa_private.provider_event_state;
declare result text;
begin
  if p_event_digest !~ '^[0-9a-f]{64}$'
     or p_canonical_email <> lower(p_canonical_email)
     or p_event_type not in (
       'email.bounced','email.complained','email.suppressed','contact.updated',
       'contact.deleted','suppression.added','suppression.removed'
     )
     or p_occurred_at > operation_time + interval '5 minutes'
     or (p_scope is not null and p_scope not in ('marketing_topic','global')) then
    raise exception 'provider event is malformed' using errcode = '22023';
  end if;
  select * into existing_event from fidensa_private.provider_events
   where provider_event_digest = p_event_digest;
  if found then return 'duplicate'; end if;

  select * into current_provider from fidensa_private.provider_contact_state
   where canonical_email = p_canonical_email for update;
  if found and current_provider.last_provider_event_at is not null
     and p_occurred_at < current_provider.last_provider_event_at
     and p_scope is null then
    event_state := 'stale'; result := 'stale';
  elsif p_relaxation_claimed then
    event_state := 'needs_reconciliation'; result := 'needs_reconciliation';
  else
    event_state := 'applied'; result := 'applied';
  end if;

  select * into subscription_record from fidensa_private.subscriptions
   where canonical_email = p_canonical_email and state <> 'deleted'
   order by created_at desc limit 1 for update;

  insert into fidensa_private.provider_events (
    provider_event_digest, event_type, occurred_at, first_authenticated_received_at,
    linked_domain, linked_id, normalized_outcome, state, deletion_deadline
  ) values (
    p_event_digest, p_event_type, p_occurred_at, operation_time,
    case when subscription_record.id is null then 'suppression' else 'subscription' end,
    subscription_record.id,
    coalesce(p_reason, case when p_relaxation_claimed then 'provider_relaxation_requires_reconciliation' else 'provider_state_observed' end),
    event_state, operation_time + interval '90 days'
  );

  if p_scope is not null then
    insert into fidensa_private.suppressions (
      canonical_email, scope, state, reason, source_event, effective_at,
      retention_purpose, review_or_disposal_at
    ) values (
      p_canonical_email, p_scope::fidensa_private.suppression_scope, 'effective',
      p_reason, p_event_digest, operation_time, 'honor messaging restriction',
      operation_time + interval '24 months'
    ) on conflict (canonical_email, scope) where state = 'effective' do nothing;
  end if;

  if p_scope = 'marketing_topic' and subscription_record.state = 'active' then
    update fidensa_private.subscriptions
       set state = 'unsubscribed', unsubscribed_at = operation_time,
           version = version + 1, updated_at = operation_time
     where id = subscription_record.id;
    insert into fidensa_private.consent_history (
      subscription_id, prior_state, new_state, source, text_version, actor, occurred_at
    ) values (
      subscription_record.id, 'active', 'unsubscribed', 'authenticated_provider_event',
      subscription_record.consent_text_version, 'resend', operation_time
    );
  end if;

  insert into fidensa_private.provider_contact_state (
    canonical_email, subscription_id, subscription_version, available,
    contact_subscribed, marketing_topic_subscribed, globally_restricted,
    observed_at, last_provider_event_at, updated_at
  ) values (
    p_canonical_email, subscription_record.id, subscription_record.version,
    false, null, null, null, null, p_occurred_at, operation_time
  ) on conflict (canonical_email) do update set
    subscription_id = coalesce(excluded.subscription_id, fidensa_private.provider_contact_state.subscription_id),
    subscription_version = coalesce(excluded.subscription_version, fidensa_private.provider_contact_state.subscription_version),
    available = false,
    contact_subscribed = null,
    marketing_topic_subscribed = null,
    globally_restricted = null,
    observed_at = null,
    last_provider_event_at = greatest(fidensa_private.provider_contact_state.last_provider_event_at, excluded.last_provider_event_at),
    updated_at = operation_time;
  return result;
end
$function$;

create function fidensa_api.record_complete_do_not_contact(
  p_canonical_email text,
  p_source_identity text,
  p_actor text default 'scott_bishop'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare suppression_id uuid;
declare subscription_record fidensa_private.subscriptions%rowtype;
begin
  if p_actor <> 'scott_bishop'
     or p_canonical_email <> lower(p_canonical_email)
     or char_length(p_source_identity) not between 1 and 150 then
    raise exception 'complete do-not-contact request is malformed or unauthorized' using errcode = '42501';
  end if;
  insert into fidensa_private.suppressions (
    canonical_email, scope, state, reason, source_event, effective_at,
    retention_purpose, review_or_disposal_at
  ) values (
    p_canonical_email, 'global', 'effective', 'complete_do_not_contact',
    p_source_identity, operation_time, 'honor complete do-not-contact restriction',
    operation_time + interval '24 months'
  ) on conflict (canonical_email, scope) where state = 'effective' do nothing
  returning id into suppression_id;
  if suppression_id is null then
    select id into suppression_id from fidensa_private.suppressions
     where canonical_email = p_canonical_email and scope = 'global' and state = 'effective';
  end if;
  select * into subscription_record from fidensa_private.subscriptions
   where canonical_email = p_canonical_email and state = 'active'
   order by created_at desc limit 1 for update;
  if subscription_record.id is not null then
    update fidensa_private.subscriptions
       set state = 'unsubscribed', unsubscribed_at = operation_time,
           version = version + 1, updated_at = operation_time
     where id = subscription_record.id;
    insert into fidensa_private.consent_history (
      subscription_id, prior_state, new_state, source, text_version, actor, occurred_at
    ) values (
      subscription_record.id, 'active', 'unsubscribed',
      'complete_do_not_contact', subscription_record.consent_text_version,
      p_actor, operation_time
    );
  end if;
  return suppression_id;
end
$function$;

create function fidensa_api.claim_subscription_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare chosen fidensa_private.subscription_sync_operations%rowtype;
begin
  update fidensa_private.subscription_sync_operations
     set state = 'needs_reconciliation', lease_expires_at = null,
         updated_at = operation_time
   where state = 'claimed' and lease_expires_at <= operation_time;
  select * into chosen from fidensa_private.subscription_sync_operations
   where state in ('pending','needs_reconciliation','failed')
   order by created_at, operation_id
   for update skip locked limit 1;
  if chosen.operation_id is null then return null; end if;
  update fidensa_private.subscription_sync_operations
     set state = 'claimed', attempt_count = attempt_count + 1,
         last_attempt_at = operation_time,
         lease_expires_at = operation_time + interval '5 minutes',
         updated_at = operation_time
   where operation_id = chosen.operation_id;
  return jsonb_build_object(
    'operationId', chosen.operation_id,
    'subscriptionId', chosen.subscription_id,
    'canonicalEmail', chosen.canonical_email,
    'subscriptionVersion', chosen.subscription_version,
    'desiredState', chosen.desired_state,
    'reconcileFirst', chosen.attempt_count > 0,
    'firstActivationConfirmed', exists (
      select 1 from fidensa_private.provider_contact_state provider
       where provider.canonical_email = chosen.canonical_email
         and provider.first_active_read_back_at is not null
    )
  );
end
$function$;

create function fidensa_api.record_subscription_sync_result(
  p_operation_id uuid,
  p_outcome text,
  p_contact_subscribed boolean,
  p_topic_subscribed boolean,
  p_globally_restricted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare chosen fidensa_private.subscription_sync_operations%rowtype;
declare current_subscription fidensa_private.subscriptions%rowtype;
declare restriction_scope fidensa_private.suppression_scope;
declare restriction_reason text;
begin
  if p_outcome not in ('applied','needs_reconciliation','failed') then
    raise exception 'subscription sync outcome is malformed' using errcode = '22023';
  end if;
  select * into chosen from fidensa_private.subscription_sync_operations
   where operation_id = p_operation_id for update;
  if chosen.state = 'superseded' then
    if chosen.desired_state = 'active' and p_outcome = 'applied'
       and p_contact_subscribed and p_topic_subscribed
       and not p_globally_restricted then
      insert into fidensa_private.provider_contact_state (
        canonical_email, subscription_id, subscription_version, available,
        first_active_read_back_at, updated_at
      ) values (
        chosen.canonical_email, chosen.subscription_id,
        chosen.subscription_version, false, operation_time, operation_time
      ) on conflict (canonical_email) do update set
        first_active_read_back_at = coalesce(
          fidensa_private.provider_contact_state.first_active_read_back_at,
          excluded.first_active_read_back_at
        ),
        updated_at = excluded.updated_at;
    end if;
    return;
  end if;
  if chosen.operation_id is null or chosen.state <> 'claimed' then
    raise exception 'subscription sync result requires a claim' using errcode = '55000';
  end if;
  select * into current_subscription from fidensa_private.subscriptions
   where id = chosen.subscription_id;
  if current_subscription.id is null
     or current_subscription.version is distinct from chosen.subscription_version
     or current_subscription.state is distinct from chosen.desired_state then
    update fidensa_private.subscription_sync_operations
       set state = 'superseded', lease_expires_at = null, updated_at = operation_time
     where operation_id = p_operation_id;
    return;
  end if;
  if p_outcome = 'applied' and (
    p_contact_subscribed is null or p_topic_subscribed is null
    or p_globally_restricted is null
  ) then
    raise exception 'applied sync requires provider read-back' using errcode = '22023';
  end if;
  update fidensa_private.subscription_sync_operations
     set state = p_outcome, lease_expires_at = null, updated_at = operation_time
   where operation_id = p_operation_id;
  insert into fidensa_private.provider_contact_state (
    canonical_email, subscription_id, subscription_version, available,
    contact_subscribed, marketing_topic_subscribed, globally_restricted,
    observed_at, first_active_read_back_at, updated_at
  ) values (
    chosen.canonical_email, chosen.subscription_id, chosen.subscription_version,
    p_outcome = 'applied', p_contact_subscribed, p_topic_subscribed,
    p_globally_restricted,
    case when p_outcome = 'applied' then operation_time else null end,
    case when chosen.desired_state = 'active' and p_outcome = 'applied'
                   and p_contact_subscribed and p_topic_subscribed
                   and not p_globally_restricted
         then operation_time else null end,
    operation_time
  ) on conflict (canonical_email) do update set
    subscription_id = excluded.subscription_id,
    subscription_version = excluded.subscription_version,
    available = excluded.available,
    contact_subscribed = excluded.contact_subscribed,
    marketing_topic_subscribed = excluded.marketing_topic_subscribed,
    globally_restricted = excluded.globally_restricted,
    observed_at = excluded.observed_at,
    first_active_read_back_at = coalesce(
      fidensa_private.provider_contact_state.first_active_read_back_at,
      excluded.first_active_read_back_at
    ),
    updated_at = excluded.updated_at;

  -- A restrictive provider read-back is authoritative in the restrictive
  -- direction. Import it locally and advance the subscription rather than
  -- allowing a later review/version sync to overwrite the provider opt-out.
  if p_outcome = 'applied' and chosen.desired_state = 'active'
     and (p_globally_restricted or not p_contact_subscribed or not p_topic_subscribed) then
    restriction_scope := case when p_globally_restricted then 'global' else 'marketing_topic' end;
    restriction_reason := case when p_globally_restricted
      then 'provider_suppression' else 'provider_marketing_opt_out' end;
    insert into fidensa_private.suppressions (
      canonical_email, scope, state, reason, source_event, effective_at,
      retention_purpose, review_or_disposal_at
    ) values (
      chosen.canonical_email, restriction_scope, 'effective', restriction_reason,
      'provider_reconciliation_read_back', operation_time,
      'honor provider messaging restriction', operation_time + interval '24 months'
    ) on conflict (canonical_email, scope) where state = 'effective' do nothing;

    update fidensa_private.subscriptions
       set state = 'unsubscribed', version = version + 1,
           unsubscribed_at = operation_time, updated_at = operation_time
     where id = current_subscription.id and state = 'active'
       and version = current_subscription.version;
    if found then
      insert into fidensa_private.consent_history (
        subscription_id, prior_state, new_state, source, text_version, actor, occurred_at
      ) values (
        current_subscription.id, 'active', 'unsubscribed',
        'provider_reconciliation_read_back', current_subscription.consent_text_version,
        'resend', operation_time
      );
    end if;
  end if;
end
$function$;

create function fidensa_api.claim_global_suppression_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare chosen fidensa_private.provider_suppression_sync_operations%rowtype;
begin
  update fidensa_private.provider_suppression_sync_operations
     set state = 'needs_reconciliation', lease_expires_at = null,
         updated_at = operation_time
   where state = 'claimed' and lease_expires_at <= operation_time;
  select * into chosen from fidensa_private.provider_suppression_sync_operations
   where state in ('pending','needs_reconciliation','failed')
   order by created_at, operation_id
   for update skip locked limit 1;
  if chosen.operation_id is null then return null; end if;
  update fidensa_private.provider_suppression_sync_operations
     set state = 'claimed', attempt_count = attempt_count + 1,
         last_attempt_at = operation_time,
         lease_expires_at = operation_time + interval '5 minutes',
         updated_at = operation_time
   where operation_id = chosen.operation_id;
  return jsonb_build_object(
    'operationId', chosen.operation_id,
    'canonicalEmail', chosen.canonical_email,
    'scope', chosen.scope
  );
end
$function$;

create function fidensa_api.record_global_suppression_sync_result(
  p_operation_id uuid,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare chosen fidensa_private.provider_suppression_sync_operations%rowtype;
begin
  if p_outcome not in ('applied','needs_reconciliation','failed') then
    raise exception 'global suppression sync outcome is malformed' using errcode = '22023';
  end if;
  select * into chosen from fidensa_private.provider_suppression_sync_operations
   where operation_id = p_operation_id for update;
  if chosen.operation_id is null or chosen.state <> 'claimed' then
    raise exception 'global suppression sync result requires a claim' using errcode = '55000';
  end if;
  if not exists (
    select 1 from fidensa_private.suppressions
     where id = chosen.suppression_id and state = 'effective'
       and scope = chosen.scope
  ) then
    p_outcome := 'applied';
  end if;
  update fidensa_private.provider_suppression_sync_operations
     set state = p_outcome, lease_expires_at = null, updated_at = operation_time
   where operation_id = p_operation_id;
end
$function$;

create function fidensa_api.promotional_eligibility(
  p_canonical_email text,
  p_expected_consent_version text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare subscription_record fidensa_private.subscriptions%rowtype;
declare provider_record fidensa_private.provider_contact_state%rowtype;
begin
  select * into subscription_record from fidensa_private.subscriptions
   where canonical_email = p_canonical_email and state <> 'deleted'
   order by created_at desc limit 1;
  if subscription_record.id is null then return 'absent_consent'; end if;
  if subscription_record.state <> 'active' then return 'inactive_consent'; end if;
  if subscription_record.confirmed_at is null then return 'unconfirmed_consent'; end if;
  if subscription_record.consent_text_version <> p_expected_consent_version then return 'stale_consent_version'; end if;
  if subscription_record.review_outcome is distinct from 'permissive' then return 'review_not_permissive'; end if;
  if subscription_record.next_review_due_at is null or subscription_record.next_review_due_at <= operation_time then return 'review_overdue'; end if;
  if exists (select 1 from fidensa_private.suppressions where canonical_email = p_canonical_email and state = 'effective' and scope = 'global') then return 'local_global_suppression'; end if;
  if exists (select 1 from fidensa_private.suppressions where canonical_email = p_canonical_email and state = 'effective' and scope = 'marketing_topic') then return 'local_topic_suppression'; end if;
  select * into provider_record from fidensa_private.provider_contact_state
   where canonical_email = p_canonical_email;
  if provider_record.canonical_email is null or not provider_record.available then return 'provider_unavailable'; end if;
  if provider_record.observed_at is null or provider_record.observed_at < operation_time - interval '1 hour' then return 'provider_state_stale'; end if;
  if provider_record.subscription_version <> subscription_record.version then return 'provider_version_conflict'; end if;
  if provider_record.globally_restricted is distinct from false then return 'provider_global_restriction'; end if;
  if provider_record.contact_subscribed is distinct from true then return 'provider_contact_restricted'; end if;
  if provider_record.marketing_topic_subscribed is distinct from true then return 'provider_topic_restricted'; end if;
  return 'eligible';
end
$function$;

create function fidensa_api.create_privacy_request_v2(
  p_type text,
  p_canonical_email text,
  p_delivery_email text,
  p_operation_digest text,
  p_ip_digest text,
  p_email_digest text,
  p_explanation text default null,
  p_matching_name text default null,
  p_matching_organization text default null,
  p_matching_submission_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare request_id uuid := gen_random_uuid();
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare rate_denied boolean := false;
begin
  if p_type not in ('access','correction','export','deletion')
     or p_canonical_email <> lower(p_canonical_email)
     or p_operation_digest !~ '^[0-9a-f]{64}$'
     or p_ip_digest !~ '^[0-9a-f]{64}$'
     or p_email_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'privacy request is malformed' using errcode = '22023';
  end if;
  select
    count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 hour') >= 10
    or count(*) filter (where ip_digest = p_ip_digest and occurred_at > operation_time - interval '1 day') >= 30
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 hour') >= 3
    or count(*) filter (where email_digest = p_email_digest and occurred_at > operation_time - interval '1 day') >= 5
  into rate_denied
  from fidensa_private.abuse_events
  where event_class = 'privacy_intake' and occurred_at <= operation_time;

  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline
  ) values (
    'privacy_intake', p_ip_digest, p_email_digest, 'privacy_request_intake',
    case when rate_denied then 'denied' else 'allowed' end,
    operation_time, operation_time + interval '48 hours'
  );
  if rate_denied then return null; end if;

  if exists (select 1 from fidensa_private.privacy_requests
             where route = 'privacy_public' and operation_digest = p_operation_digest)
     or exists (select 1 from fidensa_private.privacy_requests
                where canonical_email = p_canonical_email
                  and request_type::text = p_type
                  and state not in ('fulfilled','denied','withdrawn','expired')) then
    return null;
  end if;
  insert into fidensa_private.privacy_requests (
    id, request_type, canonical_email, delivery_email, route, operation_digest,
    explanation, matching_name, matching_organization, matching_submission_date,
    received_at, confirmation_intent_due_at, target_due_at
  ) values (
    request_id, p_type::fidensa_private.privacy_request_type, p_canonical_email,
    p_delivery_email, 'privacy_public', p_operation_digest, p_explanation,
    p_matching_name, p_matching_organization, p_matching_submission_date,
    operation_time, operation_time + interval '24 hours', operation_time + interval '30 days'
  );
  insert into fidensa_private.privacy_request_history (
    privacy_request_id, prior_state, new_state, event_class, actor, reason,
    occurred_at, transition_version
  ) values (
    request_id, null, 'awaiting_confirmation', 'transition', 'requester',
    'request_received', operation_time, 1
  );
  return request_id;
exception when unique_violation then return null;
end
$function$;

create function fidensa_api.record_privacy_confirmation_intent(
  p_request_id uuid,
  p_expected_version bigint,
  p_scope text[],
  p_actor text default 'scott_bishop'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare request_record fidensa_private.privacy_requests%rowtype;
declare application_record fidensa_private.applications%rowtype;
declare subscription_record fidensa_private.subscriptions%rowtype;
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare next_generation integer;
declare intent_id uuid;
begin
  if p_actor <> 'scott_bishop' or p_scope is null or cardinality(p_scope) = 0
     or not (p_scope <@ array['application','subscription','suppression','all']::text[]) then
    raise exception 'privacy confirmation intent is not authorized or scoped' using errcode = '42501';
  end if;
  select * into request_record from fidensa_private.privacy_requests
   where id = p_request_id and state = 'awaiting_confirmation'
   for update;
  if request_record.id is null or request_record.version <> p_expected_version then
    raise exception 'privacy confirmation intent version conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from fidensa_private.privacy_confirmation_intents
     where privacy_request_id = p_request_id and state in ('pending','claimed')
  ) then
    raise exception 'privacy confirmation delivery is already in flight' using errcode = '55000';
  end if;
  select * into application_record from fidensa_private.applications
   where canonical_email = request_record.canonical_email
     and lifecycle in ('pending_verification','active')
   order by submitted_at desc limit 1;
  if application_record.id is null then
    select * into subscription_record from fidensa_private.subscriptions
     where canonical_email = request_record.canonical_email and state <> 'deleted'
     order by created_at desc limit 1;
  end if;
  if application_record.id is null and subscription_record.id is null then
    raise exception 'privacy confirmation requires an address already on record' using errcode = '55000';
  end if;
  select coalesce(max(generation), 0) + 1 into next_generation
    from fidensa_private.privacy_confirmation_intents
   where privacy_request_id = p_request_id;
  update fidensa_private.privacy_credentials
     set state = 'superseded'
   where privacy_request_id = p_request_id and purpose = 'privacy_confirmation'
     and state in ('issued','delivery_unknown');
  update fidensa_private.privacy_confirmation_intents
     set state = 'superseded', updated_at = operation_time
   where privacy_request_id = p_request_id and state = 'issued';
  insert into fidensa_private.privacy_confirmation_intents (
    privacy_request_id, application_id, subscription_id, generation,
    verified_scope, target_delivery_email, actor, manual_intent_at
  ) values (
    p_request_id, application_record.id, subscription_record.id, next_generation,
    p_scope,
    coalesce(application_record.delivery_email, subscription_record.delivery_email),
    p_actor, operation_time
  ) returning id into intent_id;
  return intent_id;
end
$function$;

create function fidensa_api.claim_privacy_confirmation_intent()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare chosen fidensa_private.privacy_confirmation_intents%rowtype;
begin
  update fidensa_private.privacy_confirmation_intents
     set state = 'pending', lease_expires_at = null, updated_at = operation_time
   where state = 'claimed' and lease_expires_at <= operation_time;
  select * into chosen from fidensa_private.privacy_confirmation_intents
   where state = 'pending' order by manual_intent_at, id
   for update skip locked limit 1;
  if chosen.id is null then return null; end if;
  update fidensa_private.privacy_confirmation_intents
     set state = 'claimed', lease_expires_at = operation_time + interval '5 minutes',
         updated_at = operation_time
   where id = chosen.id;
  return jsonb_build_object(
    'intentId', chosen.id,
    'privacyRequestId', chosen.privacy_request_id,
    'generation', chosen.generation,
    'recipient', chosen.target_delivery_email,
    'operationId', chosen.operation_id
  );
end
$function$;

create function fidensa_api.issue_privacy_confirmation(
  p_intent_id uuid,
  p_credential_digest text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare intent_record fidensa_private.privacy_confirmation_intents%rowtype;
begin
  if p_credential_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'privacy credential digest is malformed' using errcode = '22023';
  end if;
  select * into intent_record from fidensa_private.privacy_confirmation_intents
   where id = p_intent_id and state = 'claimed' and lease_expires_at > operation_time
   for update;
  if intent_record.id is null then
    raise exception 'privacy confirmation intent is not claimable' using errcode = '55000';
  end if;
  insert into fidensa_private.privacy_credentials (
    privacy_request_id, purpose, credential_digest, generation, state,
    issued_at, expires_at
  ) values (
    intent_record.privacy_request_id, 'privacy_confirmation',
    p_credential_digest, intent_record.generation, 'issued',
    operation_time, operation_time + interval '30 minutes'
  );
  update fidensa_private.privacy_requests
     set confirmation_sent_at = coalesce(confirmation_sent_at, operation_time),
         updated_at = operation_time
   where id = intent_record.privacy_request_id
     and confirmation_sent_at is null;
  insert into fidensa_private.communications (
    application_id, subscription_id, type, class, actor, recipient_class,
    template_version, operation_id, outcome, occurred_at
  ) values (
    intent_record.application_id, intent_record.subscription_id,
    'privacy_confirmation', 'manual', 'scott_bishop', 'privacy_requester',
    'privacy-confirmation-v1', intent_record.operation_id, 'intended', operation_time
  );
  update fidensa_private.privacy_confirmation_intents
     set state = 'issued', issued_at = operation_time, lease_expires_at = null,
         updated_at = operation_time
   where id = p_intent_id;
end
$function$;

create function fidensa_api.consume_privacy_confirmation(
  p_credential_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare credential_record fidensa_private.privacy_credentials%rowtype;
declare request_record fidensa_private.privacy_requests%rowtype;
declare intent_record fidensa_private.privacy_confirmation_intents%rowtype;
declare application_record fidensa_private.applications%rowtype;
declare details_match boolean := false;
begin
  if p_credential_digest !~ '^[0-9a-f]{64}$' then return false; end if;
  select * into credential_record from fidensa_private.privacy_credentials
   where credential_digest = p_credential_digest
     and purpose = 'privacy_confirmation' and state = 'issued'
     and expires_at > operation_time
   for update;
  if credential_record.id is null then return false; end if;
  select * into request_record from fidensa_private.privacy_requests
   where id = credential_record.privacy_request_id and state = 'awaiting_confirmation'
   for update;
  select * into intent_record from fidensa_private.privacy_confirmation_intents
   where privacy_request_id = credential_record.privacy_request_id
     and generation = credential_record.generation and state = 'issued';
  if request_record.id is null or intent_record.id is null then return false; end if;

  if request_record.request_type in ('access','export') then
    select * into application_record from fidensa_private.applications
     where canonical_email = request_record.canonical_email
     order by submitted_at desc limit 1;
    details_match := application_record.id is not null
      and request_record.matching_name is not distinct from application_record.applicant_name
      and (
        request_record.matching_organization is not distinct from application_record.organization
        or request_record.matching_submission_date = application_record.submitted_at::date
      );
    if not details_match then return false; end if;
  end if;

  update fidensa_private.privacy_credentials
     set state = 'consumed', consumed_at = operation_time
   where id = credential_record.id;
  perform fidensa_api.transition_privacy_request(
    request_record.id, request_record.version, 'verified',
    intent_record.verified_scope, 'single_use_mailbox_confirmation', 'scott_bishop'
  );
  return true;
end
$function$;

create function fidensa_api.record_privacy_confirmation_delivery(
  p_intent_id uuid,
  p_outcome text,
  p_provider_message_digest text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare intent_record fidensa_private.privacy_confirmation_intents%rowtype;
declare communication_record fidensa_private.communications%rowtype;
declare operation_time timestamptz := fidensa_private.authoritative_now();
begin
  if p_outcome not in ('accepted_by_provider','delivery_unknown','failed')
     or (p_provider_message_digest is not null
         and p_provider_message_digest !~ '^[0-9a-f]{64}$') then
    raise exception 'privacy confirmation delivery outcome is malformed' using errcode = '22023';
  end if;
  select * into intent_record from fidensa_private.privacy_confirmation_intents
   where id = p_intent_id and state = 'issued';
  select * into communication_record from fidensa_private.communications
   where operation_id = intent_record.operation_id;
  if intent_record.id is null or communication_record.id is null then
    raise exception 'privacy confirmation delivery intent is unavailable' using errcode = '55000';
  end if;
  if exists (
    select 1 from fidensa_private.communication_outcomes
     where communication_id = communication_record.id
       and new_outcome::text = p_outcome
       and provider_event_digest is not distinct from p_provider_message_digest
  ) then return; end if;
  insert into fidensa_private.communication_outcomes (
    communication_id, prior_outcome, new_outcome, provider_event_digest, occurred_at
  ) values (
    communication_record.id, communication_record.outcome,
    p_outcome::fidensa_private.communication_outcome,
    p_provider_message_digest, operation_time
  );
end
$function$;

create function fidensa_api.verify_privacy_request_identity(
  p_request_id uuid,
  p_expected_version bigint,
  p_scope text[],
  p_email_confirmed boolean,
  p_identity_proof_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare request_record fidensa_private.privacy_requests%rowtype;
declare application_record fidensa_private.applications%rowtype;
declare proof_valid boolean := false;
declare details_match boolean := false;
declare next_version bigint;
begin
  select * into request_record from fidensa_private.privacy_requests
   where id = p_request_id and state = 'awaiting_confirmation'
   for update;
  if request_record.id is null or request_record.version <> p_expected_version then
    raise exception 'privacy verification version conflict' using errcode = '40001';
  end if;
  if p_identity_proof_id is not null then
    select exists (
      select 1 from fidensa_private.identity_proofs
       where id = p_identity_proof_id and privacy_request_id = p_request_id
         and evidence_class in ('mismatch','fraud','inaccessible_email','representative')
         and result = 'accepted' and purpose_ended_at is null
    ) into proof_valid;
  end if;
  if p_email_confirmed then
    raise exception 'routine mailbox confirmation must use the single-use credential exchange' using errcode = '55000';
  end if;
  if not proof_valid then
    raise exception 'exceptional proof is required' using errcode = '55000';
  end if;
  select * into application_record from fidensa_private.applications
   where canonical_email = request_record.canonical_email
     and lifecycle in ('pending_verification','active')
   order by submitted_at desc limit 1;
  details_match := application_record.id is not null
    and request_record.matching_name is not distinct from application_record.applicant_name
    and (
      request_record.matching_organization is not distinct from application_record.organization
      or request_record.matching_submission_date = application_record.submitted_at::date
    );
  if request_record.request_type in ('access','export')
     and not details_match and not proof_valid then
    raise exception 'access or export requires matching existing details' using errcode = '55000';
  end if;
  next_version := fidensa_api.transition_privacy_request(
    p_request_id, p_expected_version, 'verified', p_scope,
    'exceptional_identity_proof',
    'scott_bishop'
  );
  if proof_valid then
    update fidensa_private.identity_proofs
       set purpose_ended_at = fidensa_private.authoritative_now(),
           deletion_deadline = fidensa_private.authoritative_now() + interval '24 hours'
     where id = p_identity_proof_id and purpose_ended_at is null;
  end if;
  return next_version;
end
$function$;

create function fidensa_api.fulfill_privacy_deletion(
  p_request_id uuid,
  p_expected_version bigint,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare request_record fidensa_private.privacy_requests%rowtype;
declare application_record fidensa_private.applications%rowtype;
declare subscription_record fidensa_private.subscriptions%rowtype;
declare scope_application boolean;
declare scope_subscription boolean;
declare provider_pending boolean := false;
begin
  select * into request_record from fidensa_private.privacy_requests
   where id = p_request_id and state = 'under_review' and request_type = 'deletion'
   for update;
  if request_record.id is null or request_record.version <> p_expected_version then
    raise exception 'privacy deletion version conflict' using errcode = '40001';
  end if;
  scope_application := 'all' = any(request_record.verified_scope)
    or 'application' = any(request_record.verified_scope);
  scope_subscription := 'all' = any(request_record.verified_scope)
    or 'subscription' = any(request_record.verified_scope);
  if scope_application then
    for application_record in
      select * from fidensa_private.applications
       where canonical_email = request_record.canonical_email
         and lifecycle <> 'transferred'
       order by submitted_at for update
    loop
      insert into fidensa_private.privacy_application_authorizations (
        privacy_request_id, application_id, operation, expires_at, created_at
      ) values (
        p_request_id, application_record.id, 'deletion',
        operation_time + interval '5 minutes', operation_time
      );
      delete from fidensa_private.applications where id = application_record.id;
    end loop;
  end if;
  if scope_subscription then
    insert into fidensa_private.suppressions (
      canonical_email, scope, state, reason, source_event, effective_at,
      retention_purpose, review_or_disposal_at
    ) select
      request_record.canonical_email, 'marketing_topic', 'effective',
      'verified_privacy_deletion', p_request_id::text, operation_time,
      'honor deletion and marketing opt-out', operation_time + interval '24 months'
    where not exists (
      select 1 from fidensa_private.suppressions
       where canonical_email = request_record.canonical_email
         and scope = 'global' and state = 'effective'
    )
    on conflict (canonical_email, scope) where state = 'effective' do nothing;

    for subscription_record in
      select * from fidensa_private.subscriptions
       where canonical_email = request_record.canonical_email
       order by created_at for update
    loop
      insert into fidensa_private.privacy_subscription_authorizations (
        privacy_request_id, subscription_id, expires_at, created_at
      ) values (
        p_request_id, subscription_record.id,
        operation_time + interval '5 minutes', operation_time
      ) on conflict (privacy_request_id, subscription_id) do update
        set expires_at = excluded.expires_at, consumed_at = null,
            created_at = excluded.created_at;
      delete from fidensa_private.consent_acts
       where subscription_id = subscription_record.id;
      delete from fidensa_private.subscriptions where id = subscription_record.id;
    end loop;
    delete from fidensa_private.provider_contact_state
     where canonical_email = request_record.canonical_email;
  end if;
  if scope_subscription then
    select exists (
      select 1 from fidensa_private.provider_suppression_sync_operations o
      join fidensa_private.suppressions s on s.id = o.suppression_id
      where s.canonical_email = request_record.canonical_email
        and s.state = 'effective'
        and o.state <> 'applied'
    ) into provider_pending;
  end if;
  insert into fidensa_private.privacy_operation_audit (
    privacy_request_id, operation, verified_scope, actor, outcome, reason, occurred_at
  ) values (
    p_request_id, 'deletion', request_record.verified_scope, 'scott_bishop',
    case when provider_pending then 'partial' else 'completed' end,
    case when provider_pending then p_reason || ': provider reconciliation pending' else p_reason end,
    operation_time
  );
  if provider_pending then return request_record.version; end if;
  return fidensa_api.transition_privacy_request(
    p_request_id, p_expected_version, 'fulfilled', request_record.verified_scope,
    p_reason, 'scott_bishop'
  );
end
$function$;

create function fidensa_api.fulfill_privacy_correction(
  p_request_id uuid,
  p_expected_version bigint,
  p_applicant_name text,
  p_delivery_email text,
  p_organization text,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare request_record fidensa_private.privacy_requests%rowtype;
declare application_record fidensa_private.applications%rowtype;
begin
  select * into request_record from fidensa_private.privacy_requests
   where id = p_request_id and state = 'under_review' and request_type = 'correction'
   for update;
  if request_record.id is null or request_record.version <> p_expected_version
     or not ('all' = any(request_record.verified_scope) or 'application' = any(request_record.verified_scope))
     or char_length(p_applicant_name) not between 1 and 120
     or char_length(p_delivery_email) not between 3 and 254
     or (p_organization is not null and char_length(p_organization) not between 1 and 160) then
    raise exception 'privacy correction is not authorized or bounded' using errcode = '55000';
  end if;
  select * into application_record from fidensa_private.applications
   where canonical_email = request_record.canonical_email and lifecycle = 'active'
   order by submitted_at desc limit 1 for update;
  if application_record.id is null then
    raise exception 'verified correction target is unavailable' using errcode = '55000';
  end if;
  insert into fidensa_private.privacy_application_authorizations (
    privacy_request_id, application_id, operation, expires_at, created_at
  ) values (
    p_request_id, application_record.id, 'correction', operation_time + interval '5 minutes', operation_time
  );
  update fidensa_private.applications
     set applicant_name = p_applicant_name, delivery_email = p_delivery_email,
         organization = p_organization, version = version + 1, updated_at = operation_time
   where id = application_record.id;
  insert into fidensa_private.privacy_operation_audit (
    privacy_request_id, operation, verified_scope, actor, outcome, reason, occurred_at
  ) values (
    p_request_id, 'correction', request_record.verified_scope, 'scott_bishop',
    'completed', p_reason, operation_time
  );
  return fidensa_api.transition_privacy_request(
    p_request_id, p_expected_version, 'fulfilled', request_record.verified_scope,
    p_reason, 'scott_bishop'
  );
end
$function$;

create function fidensa_api.fulfill_privacy_read(
  p_request_id uuid,
  p_expected_version bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare operation_time timestamptz := fidensa_private.authoritative_now();
declare request_record fidensa_private.privacy_requests%rowtype;
declare result jsonb;
begin
  select * into request_record from fidensa_private.privacy_requests
   where id = p_request_id and state = 'under_review'
     and request_type in ('access','export') for update;
  if request_record.id is null or request_record.version <> p_expected_version then
    raise exception 'privacy read version conflict' using errcode = '40001';
  end if;
  select jsonb_build_object(
    'requestType', request_record.request_type,
    'scope', request_record.verified_scope,
    'applications', case when 'all' = any(request_record.verified_scope)
      or 'application' = any(request_record.verified_scope) then (
        select coalesce(jsonb_agg(
          (to_jsonb(a) - array['operation_digest','correlation_id','version','created_at','updated_at'])
          || jsonb_build_object(
            'privacyAcknowledgements', (
              select coalesce(jsonb_agg(to_jsonb(pa) - array['correlation_id','created_at']), '[]'::jsonb)
                from fidensa_private.privacy_acknowledgements pa
               where pa.application_id = a.id
            ),
            'status', (
              select to_jsonb(rs) - array['version','created_at','updated_at']
                from fidensa_private.reviewer_status rs
               where rs.application_id = a.id
            ),
            'statusHistory', (
              select coalesce(jsonb_agg(to_jsonb(rh) - array['correlation_id','created_at'] order by rh.transition_version), '[]'::jsonb)
                from fidensa_private.reviewer_status_history rh
               where rh.application_id = a.id
            ),
            'scoreSets', (
              select coalesce(jsonb_agg(
                (to_jsonb(ss) - array['created_at','updated_at'])
                || jsonb_build_object('scores', (
                  select coalesce(jsonb_agg(to_jsonb(sc) - array['created_at'] order by sc.assessed_at), '[]'::jsonb)
                    from fidensa_private.scores sc where sc.score_set_id = ss.id
                )) order by ss.assessed_at
              ), '[]'::jsonb)
                from fidensa_private.score_sets ss where ss.application_id = a.id
            ),
            'communications', (
              select coalesce(jsonb_agg(
                (to_jsonb(c) - array['provider_message_digest','correlation_id','created_at'])
                || jsonb_build_object('outcomes', (
                  select coalesce(jsonb_agg(to_jsonb(co) - array['provider_event_digest','created_at'] order by co.occurred_at), '[]'::jsonb)
                    from fidensa_private.communication_outcomes co where co.communication_id = c.id
                )) order by c.occurred_at
              ), '[]'::jsonb)
                from fidensa_private.communications c where c.application_id = a.id
            ),
            'consentActs', (
              select coalesce(jsonb_agg(to_jsonb(ca) - array['correlation_id','created_at']), '[]'::jsonb)
                from fidensa_private.consent_acts ca where ca.application_id = a.id
            )
          ) order by a.submitted_at
        ), '[]'::jsonb)
          from fidensa_private.applications a
         where a.canonical_email = request_record.canonical_email
      ) else null end,
    'subscriptions', case when 'all' = any(request_record.verified_scope)
      or 'subscription' = any(request_record.verified_scope) then (
        select coalesce(jsonb_agg(
          (to_jsonb(s) - array['correlation_id','version','created_at','updated_at'])
          || jsonb_build_object(
            'consentHistory', (
              select coalesce(jsonb_agg(to_jsonb(ch) - array['correlation_id','created_at'] order by ch.occurred_at), '[]'::jsonb)
                from fidensa_private.consent_history ch where ch.subscription_id = s.id
            ),
            'communications', (
              select coalesce(jsonb_agg(to_jsonb(c) - array['provider_message_digest','correlation_id','created_at'] order by c.occurred_at), '[]'::jsonb)
                from fidensa_private.communications c where c.subscription_id = s.id
            )
          ) order by s.created_at
        ), '[]'::jsonb)
          from fidensa_private.subscriptions s
         where s.canonical_email = request_record.canonical_email
      ) else null end,
    'suppressions', case when 'all' = any(request_record.verified_scope)
      or 'suppression' = any(request_record.verified_scope) then (
        select coalesce(jsonb_agg(to_jsonb(x) - array['correlation_id','created_at']), '[]'::jsonb)
          from fidensa_private.suppressions x
         where x.canonical_email = request_record.canonical_email
      ) else null end
  ) into result;
  insert into fidensa_private.privacy_operation_audit (
    privacy_request_id, operation, verified_scope, actor, outcome, reason, occurred_at
  ) values (
    p_request_id, request_record.request_type::text, request_record.verified_scope,
    'scott_bishop', 'completed', p_reason, operation_time
  );
  perform fidensa_api.transition_privacy_request(
    p_request_id, p_expected_version, 'fulfilled', request_record.verified_scope,
    p_reason, 'scott_bishop'
  );
  return result;
end
$function$;

create or replace function fidensa_api.record_manual_communication(
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
  if p_type not in ('interview','waitlist','decision','early_access')
     or not exists (
       select 1 from fidensa_private.manual_message_templates
        where type = p_type and version = p_template_version
          and state = 'approved' and approved_by = 'scott_bishop'
     ) then
    raise exception 'exact manual template approval is required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from fidensa_private.applications
     where id = p_application_id and lifecycle = 'active' and retention_deadline > p_now
  ) then
    raise exception 'active unexpired application required' using errcode = '55000';
  end if;
  insert into fidensa_private.communications (
    application_id, type, class, actor, recipient_class, template_version,
    operation_id, outcome, note, occurred_at
  ) values (
    p_application_id, p_type, 'manual', 'scott_bishop', 'applicant',
    p_template_version, gen_random_uuid(), p_outcome::fidensa_private.communication_outcome,
    p_note, p_now
  ) returning id into communication_id;
  return communication_id;
end
$function$;

create function fidensa_private.deny_governed_truncate_v2()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'governed private tables cannot be truncated' using errcode = '55000';
end
$function$;

create trigger governed_truncate_guard before truncate on fidensa_private.provider_contact_state
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.subscription_sync_operations
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.provider_suppression_sync_operations
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.manual_message_templates
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.privacy_operation_audit
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.privacy_application_authorizations
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.privacy_subscription_authorizations
for each statement execute function fidensa_private.deny_governed_truncate_v2();
create trigger governed_truncate_guard before truncate on fidensa_private.privacy_confirmation_intents
for each statement execute function fidensa_private.deny_governed_truncate_v2();

alter table fidensa_private.subscriptions
  enable always trigger subscriptions_queue_provider_sync;
alter table fidensa_private.suppressions
  enable always trigger suppressions_queue_provider_sync;
alter table fidensa_private.provider_contact_state
  enable always trigger governed_truncate_guard;
alter table fidensa_private.subscription_sync_operations
  enable always trigger governed_truncate_guard;
alter table fidensa_private.provider_suppression_sync_operations
  enable always trigger governed_truncate_guard;
alter table fidensa_private.manual_message_templates
  enable always trigger governed_truncate_guard;
alter table fidensa_private.privacy_operation_audit
  enable always trigger governed_truncate_guard;
alter table fidensa_private.privacy_application_authorizations
  enable always trigger governed_truncate_guard;
alter table fidensa_private.privacy_subscription_authorizations
  enable always trigger governed_truncate_guard;
alter table fidensa_private.privacy_confirmation_intents
  enable always trigger governed_truncate_guard;

revoke execute on all functions in schema fidensa_private from public, anon, authenticated, service_role, fidensa_server, fidensa_job;
revoke execute on all functions in schema fidensa_api from public, anon, authenticated;
revoke execute on function fidensa_api.record_provider_event_v2(text,text,timestamptz,text,text,text,boolean) from public, anon, authenticated;
revoke execute on function fidensa_api.claim_subscription_sync() from public, anon, authenticated;
revoke execute on function fidensa_api.record_subscription_sync_result(uuid,text,boolean,boolean,boolean) from public, anon, authenticated;
revoke execute on function fidensa_api.claim_global_suppression_sync() from public, anon, authenticated;
revoke execute on function fidensa_api.record_global_suppression_sync_result(uuid,text) from public, anon, authenticated;
revoke execute on function fidensa_api.promotional_eligibility(text,text) from public, anon, authenticated;
revoke execute on function fidensa_api.create_privacy_request_v2(text,text,text,text,text,text,text,text,text,date) from public, anon, authenticated;
revoke execute on function fidensa_api.consume_privacy_confirmation(text) from public, anon, authenticated;
revoke execute on function fidensa_api.claim_privacy_confirmation_intent() from public, anon, authenticated;
revoke execute on function fidensa_api.issue_privacy_confirmation(uuid,text) from public, anon, authenticated;
revoke execute on function fidensa_api.record_privacy_confirmation_delivery(uuid,text,text) from public, anon, authenticated;

grant execute on function fidensa_api.record_provider_event_v2(text,text,timestamptz,text,text,text,boolean) to fidensa_server;
grant execute on function fidensa_api.claim_subscription_sync() to fidensa_server;
grant execute on function fidensa_api.record_subscription_sync_result(uuid,text,boolean,boolean,boolean) to fidensa_server;
grant execute on function fidensa_api.claim_global_suppression_sync() to fidensa_server;
grant execute on function fidensa_api.record_global_suppression_sync_result(uuid,text) to fidensa_server;
grant execute on function fidensa_api.promotional_eligibility(text,text) to fidensa_server;
grant execute on function fidensa_api.create_privacy_request_v2(text,text,text,text,text,text,text,text,text,date) to fidensa_server;
grant execute on function fidensa_api.consume_privacy_confirmation(text) to fidensa_server;
grant execute on function fidensa_api.claim_privacy_confirmation_intent() to fidensa_server;
grant execute on function fidensa_api.issue_privacy_confirmation(uuid,text) to fidensa_server;
grant execute on function fidensa_api.record_privacy_confirmation_delivery(uuid,text,text) to fidensa_server;

commit;

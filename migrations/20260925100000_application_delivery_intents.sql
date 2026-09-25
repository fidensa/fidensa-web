begin;

create table fidensa_private.application_message_outbox (
  communication_id uuid primary key references fidensa_private.communications(id) on delete cascade,
  state text not null default 'pending'
    check (state in ('pending', 'claimed', 'delivery_unknown', 'accepted', 'failed', 'needs_reconciliation')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  first_attempt_at timestamptz,
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  owner_reason text check (owner_reason is null or owner_reason in (
    'credential_unavailable', 'provider_window_expired', 'attempt_cap_reached'
  )),
  available_at timestamptz not null,
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((state = 'claimed') = (lease_expires_at is not null)),
  check ((attempt_count = 0) = (first_attempt_at is null)),
  check ((state = 'needs_reconciliation') = (owner_reason is not null))
);
alter table fidensa_private.application_message_outbox enable row level security;
alter table fidensa_private.application_message_outbox force row level security;
revoke all on fidensa_private.application_message_outbox from public, anon, authenticated, service_role;
create trigger governed_truncate_guard
before truncate on fidensa_private.application_message_outbox
for each statement execute function fidensa_private.deny_governed_truncate();
alter table fidensa_private.application_message_outbox
  enable always trigger governed_truncate_guard;

-- Provider ambiguity is a usable verification state. Only the credential
-- digest is durable; the raw credential exists in the sending worker only.
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
  if old.state in ('issued', 'delivery_unknown')
     and new.state in ('issued', 'delivery_unknown')
     and (to_jsonb(new) - array['state','updated_at'])
         is not distinct from (to_jsonb(old) - array['state','updated_at']) then
    return new;
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

-- These wrappers expose only the delivery data needed by the server outbox.
-- Base tables and the reviewer queue remain unavailable to the server role.
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
  p_consent_text_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_uuid uuid;
  delivery_operation uuid;
begin
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

create function fidensa_api.verify_application_intake(
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
  delivery_address text;
  receipt_operation uuid;
  reviewer_operation uuid;
begin
  select application_id into application_uuid
    from fidensa_private.verifications
   where credential_digest = p_credential_digest
     and purpose = 'application_verification'
     and state in ('issued', 'delivery_unknown');

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

create function fidensa_api.resend_application_verification_intake(
  p_canonical_email text,
  p_credential_digest text,
  p_ip_digest text,
  p_email_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_uuid uuid;
  delivery_operation uuid;
  delivery_address text;
begin
  if not fidensa_api.resend_application_verification(
    p_canonical_email, p_credential_digest, p_ip_digest, p_email_digest
  ) then
    return null;
  end if;
  select a.id, a.delivery_email, c.operation_id
    into strict application_uuid, delivery_address, delivery_operation
    from fidensa_private.applications a
    join fidensa_private.communications c on c.application_id = a.id
   where a.canonical_email = p_canonical_email
     and a.lifecycle = 'pending_verification'
     and c.type = 'verification' and c.class = 'automatic'
   order by c.occurred_at desc, c.id desc
   limit 1;
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
    'deliveryEmail', delivery_address,
    'operationId', delivery_operation
  );
end
$function$;

create function fidensa_api.claim_application_message(p_operation_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  chosen fidensa_private.application_message_outbox%rowtype;
  communication_record fidensa_private.communications%rowtype;
  application_record fidensa_private.applications%rowtype;
  prior_outcome fidensa_private.communication_outcome;
  is_reconciliation boolean;
begin
  update fidensa_private.application_message_outbox o
     set state = 'needs_reconciliation', lease_expires_at = null,
         owner_reason = case when o.attempt_count >= 3
           then 'attempt_cap_reached' else 'provider_window_expired' end,
         updated_at = operation_time
   where (o.state = 'delivery_unknown'
          or (o.state = 'claimed' and o.lease_expires_at <= operation_time))
     and o.provider_message_id is null
     and (o.attempt_count >= 3
          or o.first_attempt_at <= operation_time - interval '12 hours');

  select o.* into chosen
    from fidensa_private.application_message_outbox o
    join fidensa_private.communications c on c.id = o.communication_id
   where (p_operation_id is null or c.operation_id = p_operation_id)
     and o.available_at <= operation_time
     and (o.state in ('pending', 'delivery_unknown')
          or (o.state = 'claimed' and o.lease_expires_at <= operation_time))
     and (o.state <> 'delivery_unknown'
          or o.provider_message_id is not null
          or (o.attempt_count < 3
              and o.first_attempt_at > operation_time - interval '12 hours'))
   order by o.available_at, o.created_at, o.communication_id
   for update of o skip locked
   limit 1;
  if chosen.communication_id is null then return null; end if;

  select * into strict communication_record
    from fidensa_private.communications where id = chosen.communication_id;
  select * into strict application_record
    from fidensa_private.applications where id = communication_record.application_id;
  prior_outcome := case chosen.state
    when 'pending' then communication_record.outcome
    when 'delivery_unknown' then 'delivery_unknown'::fidensa_private.communication_outcome
    else 'submitted'::fidensa_private.communication_outcome end;
  is_reconciliation := chosen.attempt_count > 0;

  update fidensa_private.application_message_outbox
     set state = 'claimed',
         attempt_count = attempt_count + case when provider_message_id is null then 1 else 0 end,
         first_attempt_at = coalesce(first_attempt_at, operation_time),
         lease_expires_at = operation_time + interval '5 minutes', updated_at = operation_time
   where communication_id = chosen.communication_id;
  if prior_outcome <> 'submitted' then
    insert into fidensa_private.communication_outcomes (
      communication_id, prior_outcome, new_outcome, occurred_at
    ) values (chosen.communication_id, prior_outcome, 'submitted', operation_time);
  end if;

  return jsonb_build_object(
    'applicationId', application_record.id,
    'deliveryEmail', application_record.delivery_email,
    'operationId', communication_record.operation_id,
    'messageType', case communication_record.type
      when 'verification' then 'application_verification'
      when 'receipt' then 'application_receipt'
      else 'reviewer_notification' end,
    'providerMessageId', chosen.provider_message_id,
    'reconciliation', is_reconciliation,
    'attemptCount', chosen.attempt_count + case when chosen.provider_message_id is null then 1 else 0 end,
    'firstAttemptAt', coalesce(chosen.first_attempt_at, operation_time)
  );
end
$function$;

create function fidensa_api.record_application_message_outcome(
  p_operation_id uuid,
  p_outcome text,
  p_provider_message_digest text default null,
  p_provider_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  chosen fidensa_private.application_message_outbox%rowtype;
  communication_record fidensa_private.communications%rowtype;
  mapped_state text;
begin
  if p_outcome not in ('accepted_by_provider', 'delivery_unknown', 'failed') then
    raise exception 'unsupported provider outcome' using errcode = '22023';
  end if;
  if p_provider_message_digest is not null
     and p_provider_message_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'provider message digest is malformed' using errcode = '22023';
  end if;
  if p_provider_message_id is not null
     and char_length(p_provider_message_id) not between 1 and 200 then
    raise exception 'provider message identifier is malformed' using errcode = '22023';
  end if;
  select o.* into chosen
    from fidensa_private.application_message_outbox o
    join fidensa_private.communications c on c.id = o.communication_id
   where c.operation_id = p_operation_id
   for update of o;
  if chosen.communication_id is null or chosen.state <> 'claimed' then
    raise exception 'message outcome requires an active claim' using errcode = '55000';
  end if;
  select * into strict communication_record
    from fidensa_private.communications where id = chosen.communication_id;
  mapped_state := case p_outcome
    when 'accepted_by_provider' then 'accepted'
    when 'delivery_unknown' then case
      when communication_record.type = 'verification' and p_provider_message_id is null
        then 'needs_reconciliation'
      when chosen.attempt_count >= 3 and p_provider_message_id is null
        then 'needs_reconciliation'
      when chosen.first_attempt_at <= operation_time - interval '12 hours'
           and p_provider_message_id is null
        then 'needs_reconciliation'
      else 'delivery_unknown' end
    else 'failed' end;
  update fidensa_private.application_message_outbox
     set state = mapped_state, lease_expires_at = null,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         owner_reason = case
           when mapped_state <> 'needs_reconciliation' then null
           when communication_record.type = 'verification' then 'credential_unavailable'
           when chosen.attempt_count >= 3 then 'attempt_cap_reached'
           else 'provider_window_expired' end,
         available_at = case when mapped_state = 'delivery_unknown'
           then operation_time + interval '60 seconds' else available_at end,
         updated_at = operation_time
   where communication_id = chosen.communication_id;
  insert into fidensa_private.communication_outcomes (
    communication_id, prior_outcome, new_outcome, provider_event_digest, occurred_at
  ) values (
    chosen.communication_id, 'submitted', p_outcome::fidensa_private.communication_outcome,
    p_provider_message_digest, operation_time
  );

  if communication_record.type = 'verification' then
    perform set_config('fidensa.verification_write', communication_record.application_id::text, true);
    update fidensa_private.verifications
       set state = case when p_outcome = 'delivery_unknown' then 'delivery_unknown'::fidensa_private.verification_state
                        else 'issued'::fidensa_private.verification_state end,
           updated_at = operation_time
     where application_id = communication_record.application_id
       and purpose = 'application_verification'
       and state in ('issued', 'delivery_unknown');
  end if;
end
$function$;

create function fidensa_api.escalate_application_message(
  p_operation_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  chosen fidensa_private.application_message_outbox%rowtype;
begin
  if p_reason not in (
    'credential_unavailable', 'provider_window_expired', 'attempt_cap_reached'
  ) then
    raise exception 'unsupported escalation reason' using errcode = '22023';
  end if;
  select o.* into chosen
    from fidensa_private.application_message_outbox o
    join fidensa_private.communications c on c.id = o.communication_id
   where c.operation_id = p_operation_id
   for update of o;
  if chosen.communication_id is null or chosen.state <> 'claimed' then
    raise exception 'message escalation requires an active claim' using errcode = '55000';
  end if;
  update fidensa_private.application_message_outbox
     set state = 'needs_reconciliation', lease_expires_at = null,
         owner_reason = p_reason, updated_at = fidensa_private.authoritative_now()
   where communication_id = chosen.communication_id;
end
$function$;

create function fidensa_api.record_application_honeypot(
  p_ip_digest text,
  p_email_digest text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  chosen_correlation uuid;
begin
  select correlation_id into chosen_correlation
    from fidensa_private.exercise_controls
   where state = 'intake_open' and opens_at <= operation_time and expires_at > operation_time;
  insert into fidensa_private.abuse_events (
    event_class, ip_digest, email_digest, rate_class, result_class,
    occurred_at, deletion_deadline, correlation_id
  ) values (
    'submission', p_ip_digest, p_email_digest, 'application_submission',
    'denied', operation_time, operation_time + interval '48 hours', chosen_correlation
  );
end
$function$;

revoke execute on all functions in schema fidensa_api from public, anon, authenticated;
grant execute on function fidensa_api.submit_application_intake(boolean, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) to fidensa_server;
grant execute on function fidensa_api.verify_application_intake(text, text) to fidensa_server;
grant execute on function fidensa_api.resend_application_verification_intake(text, text, text, text) to fidensa_server;
grant execute on function fidensa_api.claim_application_message(uuid) to fidensa_server;
grant execute on function fidensa_api.record_application_message_outcome(uuid, text, text, text) to fidensa_server;
grant execute on function fidensa_api.escalate_application_message(uuid, text) to fidensa_server;
grant execute on function fidensa_api.record_application_honeypot(text, text) to fidensa_server;

commit;

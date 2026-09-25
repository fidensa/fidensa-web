begin;

create or replace function fidensa_api.record_subscription_sync_result(
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
declare first_activation_confirmed boolean;
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

  select exists (
    select 1 from fidensa_private.provider_contact_state provider
     where provider.canonical_email = chosen.canonical_email
       and provider.first_active_read_back_at is not null
  ) into first_activation_confirmed;

  -- A contact can exist with an opt-out topic because contact creation
  -- succeeded while the first topic mutation failed. Until an active contact
  -- and active topic have both been read back durably, this provider default
  -- is unresolved activation work rather than recipient opt-out evidence.
  if p_outcome = 'applied' and chosen.desired_state = 'active'
     and p_contact_subscribed and not p_topic_subscribed
     and not p_globally_restricted and not first_activation_confirmed then
    p_outcome := 'needs_reconciliation';
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
    p_outcome = 'applied',
    case when p_outcome = 'applied' then p_contact_subscribed else null end,
    case when p_outcome = 'applied' then p_topic_subscribed else null end,
    case when p_outcome = 'applied' then p_globally_restricted else null end,
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

revoke execute on function fidensa_api.record_subscription_sync_result(uuid,text,boolean,boolean,boolean)
  from public, anon, authenticated;
grant execute on function fidensa_api.record_subscription_sync_result(uuid,text,boolean,boolean,boolean)
  to fidensa_server;

commit;

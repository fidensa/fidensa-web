begin;

create or replace function fidensa_api.claim_application_message(
  p_operation_id uuid default null
)
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
     and (
       c.type = 'reviewer_notification'
       or not exists (
         select 1
           from fidensa_private.applications suppressed_application
           join fidensa_private.suppressions suppression
             on suppression.canonical_email = suppressed_application.canonical_email
          where suppressed_application.id = c.application_id
            and suppression.scope = 'global'
            and suppression.state = 'effective'
       )
     )
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

revoke execute on function fidensa_api.claim_application_message(uuid)
  from public, anon, authenticated;
grant execute on function fidensa_api.claim_application_message(uuid)
  to fidensa_server;

commit;

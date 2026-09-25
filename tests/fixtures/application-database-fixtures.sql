-- Fixed-clock boundary tests need records immediately on both sides of a
-- deadline. This owner-only helper is unavailable unless the authoritative
-- environment is Test and accepts only enumerated synthetic fixture classes.
create function fidensa_private.create_test_fixture(
  p_kind text,
  p_anchor timestamptz default null,
  p_parent_id uuid default null,
  p_digest text default null,
  p_after boolean default false
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare fixture_id uuid;
declare offset_interval interval := case when p_after then interval '1 second' else interval '0 seconds' end;
begin
  if fidensa_private.authoritative_environment() <> 'Test' then
    raise exception 'synthetic fixtures require Test authority' using errcode = '42501';
  end if;
  if p_digest is not null and p_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'fixture digest must be SHA-256 hex' using errcode = '22023';
  end if;

  case p_kind
    when 'abuse_event' then
      perform fidensa_private.configure_test_authority(
        'Test', p_anchor - interval '48 hours' + offset_interval
      );
      insert into fidensa_private.abuse_events
        (event_class, ip_digest, rate_class, result_class, occurred_at, deletion_deadline)
      values ('submission', p_digest, 'boundary', 'allowed',
              p_anchor - interval '48 hours' + offset_interval, p_anchor + offset_interval)
      returning id into fixture_id;
    when 'abuse_investigation' then
      perform fidensa_private.configure_test_authority(
        'Test', p_anchor - interval '30 days' + offset_interval
      );
      insert into fidensa_private.abuse_investigations
        (purpose, selected_at, owner, event_ids, deletion_deadline)
      values ('synthetic boundary', p_anchor - interval '30 days' + offset_interval,
              'scott_bishop', array[gen_random_uuid()], p_anchor + offset_interval)
      returning id into fixture_id;
    when 'operational_log' then
      perform fidensa_private.configure_test_authority(
        'Test', p_anchor - interval '30 days' + offset_interval
      );
      insert into fidensa_private.operational_logs
        (environment, event_class, operation_id, result_class, occurred_at, deletion_deadline)
      values ('Test', 'boundary', gen_random_uuid(), 'synthetic',
              p_anchor - interval '30 days' + offset_interval, p_anchor + offset_interval)
      returning id into fixture_id;
    when 'provider_event' then
      perform fidensa_private.configure_test_authority(
        'Test', p_anchor - interval '90 days' + offset_interval
      );
      insert into fidensa_private.provider_events
        (provider_event_digest, event_type, occurred_at, first_authenticated_received_at,
         linked_domain, normalized_outcome, state, deletion_deadline)
      values (p_digest, 'contact.updated', p_anchor - interval '90 days' + offset_interval,
              p_anchor - interval '90 days' + offset_interval, 'subscription', 'synthetic',
              'needs_reconciliation', p_anchor + offset_interval)
      returning id into fixture_id;
    when 'suppression' then
      insert into fidensa_private.suppressions
        (canonical_email, scope, state, reason, source_event, effective_at,
         retention_purpose, review_or_disposal_at)
      values (case when p_after then 'suppression-after@synthetic.invalid'
                   else 'suppression-exact@synthetic.invalid' end,
              'global', 'effective', 'synthetic', 'fixture', p_anchor,
              'bounded fixture', p_anchor + offset_interval)
      returning id into fixture_id;
    when 'identity_proof' then
      insert into fidensa_private.identity_proofs
        (privacy_request_id, proof_reference_digest, evidence_class, result,
         purpose_ended_at, deletion_deadline)
      values (p_parent_id, p_digest, 'mismatch', 'synthetic',
              p_anchor - interval '24 hours' + offset_interval, p_anchor + offset_interval)
      returning id into fixture_id;
    when 'export_artifact' then
      insert into fidensa_private.privacy_export_artifacts
        (privacy_request_id, export_version, encrypted_bytes, content_digest,
         state, created_at, byte_deletion_deadline)
      values (p_parent_id, 1, decode('aa', 'hex'), p_digest, 'available',
              p_anchor - interval '24 hours' + offset_interval, p_anchor + offset_interval)
      returning id into fixture_id;
    when 'job_run' then
      insert into fidensa_private.job_runs
        (job_type, version, scheduled_bucket, selection_cutoff, first_started_at,
         first_terminal_at, outcome, expires_at)
      values (case when p_after then 'fixture_after' else 'fixture_exact' end, 'v1',
              case when p_after then '2039-01-01T00:15:00Z'::timestamptz
                   else '2039-01-01T00:00:00Z'::timestamptz end,
              case when p_after then '2039-01-01T00:40:00Z'::timestamptz
                   else '2039-01-01T00:25:00Z'::timestamptz end,
              p_anchor - interval '90 days' + offset_interval,
              p_anchor - interval '90 days' + offset_interval,
              'succeeded', p_anchor + offset_interval)
      returning id into fixture_id;
    when 'operation_guard' then
      insert into fidensa_private.application_operation_guards
        (route, operation_digest, result_class, first_seen_at,
         retention_anchor_at, review_or_disposal_at)
      values ('application_submission', p_digest, 'duplicate',
              '2039-01-01T00:00:00Z', '2039-01-01T00:00:00Z', p_anchor);
      return p_digest;
    when 'terminal_guard' then
      insert into fidensa_private.application_terminal_guards
        (application_id, email_rate_digest, digest_key_id, terminal_state,
         terminal_at, reason, retention_anchor_at, review_or_disposal_at)
      values (p_parent_id, p_digest, 'server-hmac-v1', 'deleted',
              '2039-01-01T00:00:00Z', 'synthetic guard review',
              '2039-01-01T00:00:00Z', p_anchor)
      returning application_id into fixture_id;
    when 'privacy_confirmation' then
      perform set_config('fidensa.privacy_write', p_parent_id::text, true);
      update fidensa_private.privacy_requests
        set confirmation_sent_at = p_anchor where id = p_parent_id;
      if not found then raise exception 'privacy fixture parent not found' using errcode = '22023'; end if;
      fixture_id := p_parent_id;
    when 'rubric_calibration_count' then
      update fidensa_private.rubric_versions
        set scored_since_calibration = 20 where version_label = 'rubric-v2';
      if not found then raise exception 'rubric-v2 fixture not found' using errcode = '22023'; end if;
      return '20';
    when 'suppression_guard' then
      insert into fidensa_private.suppressions
        (canonical_email, scope, state, reason, source_event, effective_at,
         retention_purpose, review_or_disposal_at)
      values ('studio-guard@synthetic.invalid', 'global', 'effective', 'synthetic',
              'fixture', p_anchor, 'bounded fixture', p_anchor + interval '24 months')
      returning id into fixture_id;
    when 'job_guard' then
      insert into fidensa_private.job_runs
        (job_type, version, scheduled_bucket, selection_cutoff, first_started_at,
         first_terminal_at, outcome, expires_at)
      values ('studio_guard', 'v1', p_anchor, p_anchor + interval '25 minutes',
              p_anchor, p_anchor + interval '1 second', 'failed',
              p_anchor + interval '90 days 1 second')
      returning id into fixture_id;
    when 'incident_guard' then
      perform fidensa_private.configure_test_authority(
        'Test', p_anchor + interval '1 second'
      );
      insert into fidensa_private.retention_incidents
        (job_run_id, incident_class, detected_at, intake_close_due_at, resolution_owner)
      values (p_parent_id, 'late_commit', p_anchor + interval '1 second',
              p_anchor + interval '1 day 1 second', 'scott_bishop')
      returning id into fixture_id;
    else
      raise exception 'unknown synthetic fixture kind' using errcode = '22023';
  end case;
  return fixture_id::text;
end
$function$;

revoke execute on function fidensa_private.create_test_fixture(text,timestamptz,uuid,text,boolean)
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

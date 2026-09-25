begin;

-- Schedule-authority hardening: schedule rows are migration authority, not mutable owner data.  The
-- five-minute retention budget and every other registered schedule value are
-- therefore fixed against ordinary INSERT, UPDATE, DELETE, and TRUNCATE.
create function fidensa_private.deny_job_schedule_data_command()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'job schedules are immutable migration authority' using errcode = '55000';
end
$function$;

create trigger job_schedules_data_command_guard
before insert or update or delete on fidensa_private.job_schedules
for each statement execute function fidensa_private.deny_job_schedule_data_command();

alter table fidensa_private.job_schedules
  enable always trigger job_schedules_data_command_guard;

-- Governed-truncate hardening: row triggers do not fire for TRUNCATE.  Every governed private table
-- receives a statement trigger, including empty tables and CASCADE targets,
-- so an ordinary owner cannot erase lifecycle, history, incident, authority,
-- exercise, or acceptance state with a data command.
create function fidensa_private.deny_governed_truncate()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'governed private tables cannot be truncated' using errcode = '55000';
end
$function$;

do $truncate_guards$
declare
  relation_name text;
begin
  for relation_name in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'fidensa_private'
       and c.relkind in ('r', 'p')
     order by c.relname
  loop
    execute format(
      'create trigger governed_truncate_guard before truncate on fidensa_private.%I for each statement execute function fidensa_private.deny_governed_truncate()',
      relation_name
    );
    execute format(
      'alter table fidensa_private.%I enable always trigger governed_truncate_guard',
      relation_name
    );
  end loop;
end
$truncate_guards$;

-- Fixed-retention update safety: UPDATE rejection for tables without a state column must reach the
-- intended fixed-retention guard instead of dereferencing NEW.state.
create or replace function fidensa_private.enforce_fixed_retention_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  operation_time timestamptz := fidensa_private.authoritative_now();
  anchor_time timestamptz;
  deadline_time timestamptz;
  row_correlation uuid;
  cleanup_allowed boolean := false;
  old_state text;
  new_state text;
begin
  if tg_table_name = 'abuse_events' then
    anchor_time := coalesce(new.occurred_at, old.occurred_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  elsif tg_table_name = 'abuse_investigations' then
    anchor_time := coalesce(new.selected_at, old.selected_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
  elsif tg_table_name = 'operational_logs' then
    anchor_time := coalesce(new.occurred_at, old.occurred_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  else
    anchor_time := coalesce(new.first_authenticated_received_at, old.first_authenticated_received_at);
    deadline_time := coalesce(new.deletion_deadline, old.deletion_deadline);
    row_correlation := coalesce(new.correlation_id, old.correlation_id);
  end if;

  if tg_op = 'INSERT' then
    if anchor_time > operation_time
       or anchor_time < operation_time - interval '5 seconds' then
      raise exception 'fixed-retention rows must begin at authoritative time' using errcode = '55000';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if tg_table_name <> 'provider_events' then
      raise exception 'fixed-retention rows are immutable outside provider state normalization' using errcode = '55000';
    end if;
    old_state := to_jsonb(old)->>'state';
    new_state := to_jsonb(new)->>'state';
    if (to_jsonb(new) - 'state') is distinct from (to_jsonb(old) - 'state')
       or not (
         new_state = old_state
         or (old_state = 'authenticated' and new_state in ('applied','duplicate','stale','needs_reconciliation'))
         or (old_state = 'needs_reconciliation' and new_state in ('applied','stale'))
       ) then
      raise exception 'fixed-retention rows are immutable outside provider state normalization' using errcode = '55000';
    end if;
    return new;
  end if;

  if row_correlation is not null then
    select exists (
      select 1 from fidensa_private.exercise_controls
       where correlation_id = row_correlation and state = 'cleanup_pending'
    ) into cleanup_allowed;
  end if;
  if not cleanup_allowed
     and deadline_time > operation_time + interval '25 minutes' then
    raise exception 'fixed-retention row deletion requires its immutable deadline or exercise cleanup' using errcode = '55000';
  end if;
  return old;
end
$function$;

revoke execute on all functions in schema fidensa_private
  from public, anon, authenticated, service_role, fidensa_server, fidensa_job;

commit;

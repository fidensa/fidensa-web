begin;

do $cron_remove$
declare job_identifier bigint;
begin
  if to_regclass('cron.job') is not null then
    for job_identifier in select jobid from cron.job
      where jobname in (
        'fidensa-database-retention-v1',
        'fidensa-retention-health-v1',
        'fidensa-cron-history-retention-v1'
      )
    loop
      perform cron.unschedule(job_identifier);
    end loop;
  end if;
end
$cron_remove$;

drop schema if exists fidensa_api cascade;
drop schema if exists fidensa_private cascade;

revoke fidensa_server from service_role;
revoke fidensa_job from service_role;
drop role if exists fidensa_server;
drop role if exists fidensa_job;
drop role if exists fidensa_mutator;

commit;

# Migration contract

This directory is the website-owned database migration boundary. The protected
application database is implemented by the timestamped SQL files in this
directory.

When an approved task adds migrations:

1. Name each immutable file `YYYYMMDDHHMMSS_short_description.sql` in UTC order.
2. Keep application, verification, privacy, subscription, suppression, communication, scoring, rights, and abuse-control lifecycles separated.
3. Use private schemas, least privilege, explicit grants/revocations, and transaction-safe forward changes as required by the accepted architecture.
4. Record an explicit recovery migration or operator recovery procedure; never edit an applied migration.
5. Test role behavior and migration ordering against disposable state before any provider-side action.

## Protected application database

Apply the timestamped migrations in lexical order. They create:

- `fidensa_private`, an unexposed schema containing every application,
  verification, acknowledgment, consent, suppression, reviewer, scoring,
  communication, abuse, rights, provider, exercise, acceptance, and job
  lifecycle;
- `fidensa_api`, an operations-only schema whose functions are granted to the
  server or job role individually; and
- database-held environment/time authority, data-bound deferred invariants and
  append-only controls that do not trust caller roles, GUCs, or call-stack
  text, the 15-minute retention schedule, and the daily 14:00 UTC retention
  health schedule when the host advertises `pg_cron`, plus an immutable
  schedule registry available to isolated tests. The final authority-hardening
  migrations derive disposal from each row's fixed deadline and authoritative
  time, reject future or misaligned retention buckets, bind registered job-run
  and attempt times to the database clock, make recovery and terminal evidence
  append-only, freeze incident deadlines while permitting exact health-review
  retries, prevent a non-Test runtime from acquiring test-clock authority,
  pair verification and accepted-transfer lifecycle writes with their required
  credential/queue/terminal evidence, bind abuse/log/provider anchors to the
  authoritative clock, and reject late successful retention evidence.
  The final schedule/truncate hardening freezes the schedule registry against
  owner data commands, installs an always-enabled statement-level truncate
  denial trigger on every private base table (including CASCADE targets), and
  keeps fixed-retention update rejection deterministic on tables without a
  provider-event state column.

The sole recovery migration is
`recovery/20260924223000_drop_protected_application_database.sql`. It first
unschedules the named Cron jobs if present, then removes both application schemas
and the two migration-owned runtime roles. It deliberately does not drop Supabase's built-in
`anon`, `authenticated`, or `service_role` roles. Recovery is destructive and
is for a disposable database or an operator-approved rollback before applicant
data exists; after data collection, restore or migration-forward recovery is
owned by the database owner.

The database test starts a fresh in-process PostgreSQL-compatible PGlite
instance, bootstraps the platform roles, and applies every forward and recovery
migration as one `NOSUPERUSER CREATEROLE BYPASSRLS` Studio-like owner. It
explicitly selects `Test` before the final authority lock for the fixed-clock
suite; the recovery/rebuild applies the ordinary chain without that harness
selection and proves the staged default cannot enable Test authority. It
exercises role/grant/RLS, queue,
scoring, material-change rescoring, exercise, fixed-clock retention,
scheduled-entry, resumable daily-health, governed recovery, guard disposal,
calibration, and 24-hour containment behavior; probes direct owner writes,
forged transaction markers, `DO`-block comment/newline frames, and
`session_replication_role` for queue, rubric, calibration, suppression,
incident, job, runtime-authority, application-clock, and communication state;
verifies every private-table guard trigger is `ENABLE ALWAYS`; rejects forged future and
backdated job authority in Test and Staged-production, terminal times before
starts, unresolved-incident cascades, future calibration/application anchors,
future direct interactions, recovery/terminal evidence rewrites, incident
deadline changes, overdue intake reopening, and unpaired calibration-anchor
changes; probes future abuse-event, investigation, operational-log, and
provider-event anchors in Test and Staged-production; rejects schedule-budget
edits and direct or CASCADE truncation in both environments, proves the full
private-table inventory carries always-enabled truncate guards, and exercises
late-run incident containment with the immutable five-minute budget; proves an unchanged
same-window health retry preserves its incident deadline; and rebuilds from
the same immutable files.
Synthetic boundary setup is loaded only by the
isolated harness from `tests/fixtures/application-database-fixtures.sql`; it is
not a production migration. The harness never connects to a remote or
production database.

The final application-delivery migration adds server-only wrapper operations
that create and claim durable message-outbox rows after a committed intake,
verification, or resend. Verification credentials exist only transiently in the sending worker;
the wrapper returns only stable delivery identities and the address already
stored with the application. Provider outcomes append to communication history.
When a provider message identity exists, reconciliation retrieves that exact
message; otherwise identical-key retries stop after 12 hours or three attempts,
whichever comes first, and become owner-visible `needs_reconciliation` work.
The server-only reconciliation route is intended for the `10 * * * *` UTC
schedule configured by the deployment task. The migration also records
honeypot denials as 48-hour abuse events. It grants no table, private-schema,
or queue access.

The consent/suppression/privacy migration adds a separate durable subscription
sync outbox, provider read-back snapshots, quarterly review authority,
most-restrictive promotional eligibility, signed-event normalization targets,
draft-only manual templates, and scope-bound privacy operations. Retry always
reads provider state before mutation; a newer or terminal Supabase version
supersedes older provider work. Application-only rights deletion preserves an
active minimal subscription, while subscription scope creates a terminal
versioned opt-out operation. The `25 * * * *` reconciliation entry point is
server-authenticated and remains inert until the deployment task installs the
separate contact-management credential and marketing topic identity.

A forward delivery-guard migration, applied only after the suppression domain
exists, makes the existing transactional outbox refuse applicant delivery under
an effective global suppression while preserving the minimal internal reviewer
notification. The accepted application-delivery migration remains byte-clean.

The following forward migration hardens partial first activation without
editing the consent migration: an existing contact with a non-opted-in topic is
kept in reconciliation until a successful active topic read-back exists. Only
after that durable first-activation evidence may a later provider topic opt-out
be imported as a recipient restriction. The migration repeats the narrow
function revoke/grant boundary and is exercised both as an upgrade over the
prior chain and in clean rebuilds.

The controlled-exercise acceptance migration binds staged submission and
verification wrappers to one open, unexpired exercise correlation and exact
recipient, carries that correlation into terminal and job-run guards, and
extends cleanup across application, consent, privacy, provider-state, and
operational residue while preserving only the acceptance record. Recovery is
forward-only: halt a remote apply before execution when possible; otherwise add
a reviewed follow-up migration that restores the prior wrapper signatures and
guard behavior without editing an applied migration.

Resend's primary Webhooks verification, Event Types, Contacts, and Topics
documentation and the provider OpenAPI 1.5.0 contract were rechecked on
2026-09-25. Verification uses the untouched raw body with `svix-id`,
`svix-timestamp`, and `svix-signature`. The implemented event set is
`email.bounced`, `email.complained`, `email.suppressed`, `contact.updated`,
`contact.deleted`, `suppression.added`, and `suppression.removed`; uncertain or
relaxing events close eligibility until authenticated read-back reconciles.
Contact-topic read-back follows every `has_more` page before deciding whether
the marketing topic is present. First-activation retry updates an existing
contact rather than issuing a duplicate create, and treats an absent or unset
topic as incomplete activation work until an active topic read-back succeeds.

Current Supabase Cron and database-backup documentation was rechecked on
2026-09-24. Cron uses `pg_cron`, can invoke database functions directly, and
records provider run history in `cron.job_run_details`; the migration bounds
that provider-managed history to 90 days. Supabase also warns that binary
restores carry scheduled extensions and can start their jobs immediately, so a
restore remains quarantined until the database owner controls those jobs and
replays the retention, suppression, rights, and terminal guards. Backups are a
recovery mechanism, not active-data retention authority.

Provider provisioning, credentials, production identifiers, and account mutations remain outside this directory and outside the local migration contract.

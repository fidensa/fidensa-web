import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

const root = new URL("../", import.meta.url);
const migrationsDirectory = new URL("migrations/", root);
const recoveryMigration = new URL(
  "migrations/recovery/20260924223000_drop_protected_application_database.sql",
  root,
);
const testFixtureSetup = new URL(
  "tests/fixtures/application-database-fixtures.sql",
  root,
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

async function expectRejected(action, label) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`Expected rejection: ${label}`);
}

async function expectRejectedTransaction(db, action, label) {
  await db.exec("begin");
  try {
    await action();
    await db.exec("set constraints all immediate");
  } catch {
    await db.exec("rollback");
    await db.exec("reset role");
    await db.exec("set session authorization postgres");
    return;
  }
  await db.exec("rollback");
  await db.exec("reset role");
  await db.exec("set session authorization postgres");
  throw new Error(`Expected rejection: ${label}`);
}

async function scalar(db, sql, params = []) {
  const result = await db.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0];
}

async function createTestFixture(
  db,
  kind,
  { anchor = null, parentId = null, fixtureDigest = null, after = false } = {},
) {
  return scalar(
    db,
    "select fidensa_private.create_test_fixture($1,$2,$3,$4,$5)",
    [kind, anchor, parentId, fixtureDigest, after],
  );
}

async function withRole(db, role, action) {
  await db.exec(`set role ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("reset role");
  }
}

async function expectStudioOwnerRejected(db, statements, label) {
  await db.exec("begin");
  try {
    await db.exec("set local role fidensa_studio_owner");
    for (const statement of statements) await db.exec(statement);
    await db.exec("set constraints all immediate");
  } catch {
    await db.exec("rollback");
    return;
  }
  await db.exec("rollback");
  throw new Error(`Expected Studio-owner rejection: ${label}`);
}

async function expectStudioOwnerRejectedMatching(
  db,
  statements,
  expectedMessage,
  label,
) {
  await db.exec("begin");
  try {
    await db.exec("set local role fidensa_studio_owner");
    for (const statement of statements) await db.exec(statement);
    await db.exec("set constraints all immediate");
  } catch (error) {
    await db.exec("rollback");
    invariant(
      String(error).includes(expectedMessage),
      `${label} rejected for the wrong reason: ${String(error)}`,
    );
    return;
  }
  await db.exec("rollback");
  throw new Error(`Expected Studio-owner rejection: ${label}`);
}

function quoteIdentifier(identifier) {
  invariant(/^[a-z][a-z0-9_]*$/.test(identifier), "unsafe catalog identifier");
  return `"${identifier}"`;
}

async function testScheduleAndTruncateOwnerDenial(db, environment) {
  await expectStudioOwnerRejected(
    db,
    [
      "update fidensa_private.job_schedules set deadline_budget=interval '100 years' where job_type='database_retention'",
    ],
    `${environment} schedule budget widening`,
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_schedules
         (job_type,version,cron_expression,deadline_budget,advance_horizon,owner,
          provider_execution,backup_caveat)
       values ('forged_retention','v1','* * * * *',interval '100 years',
               interval '100 years','fidensa_job',false,'forged')`,
    ],
    `${environment} schedule insertion`,
  );
  await expectStudioOwnerRejected(
    db,
    [
      "delete from fidensa_private.job_schedules where job_type='database_retention'",
    ],
    `${environment} schedule deletion`,
  );
  invariant(
    await scalar(
      db,
      `select deadline_budget=interval '5 minutes'
          and advance_horizon=interval '25 minutes'
       from fidensa_private.job_schedules
       where job_type='database_retention' and version='v1'`,
    ),
    `${environment} retention schedule must remain fixed at five minutes`,
  );

  const tables = (
    await db.query(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='fidensa_private' and c.relkind in ('r','p')
        order by c.relname`,
    )
  ).rows.map((row) => String(row.relname));
  invariant(tables.length >= 25, "truncate probe inventory is incomplete");
  for (const table of tables) {
    await expectStudioOwnerRejected(
      db,
      [`truncate table fidensa_private.${quoteIdentifier(table)}`],
      `${environment} direct truncate ${table}`,
    );
  }
  for (const table of [
    "applications",
    "application_terminal_guards",
    "job_runs",
  ]) {
    await expectStudioOwnerRejected(
      db,
      [`truncate table fidensa_private.${quoteIdentifier(table)} cascade`],
      `${environment} cascade truncate ${table}`,
    );
  }
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.runtime_authority where singleton",
      ),
    ) === 1 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.job_schedules where job_type='database_retention'",
        ),
      ) === 1,
    `${environment} rejected truncate probes must preserve authority rows`,
  );
  console.log(
    `PASS ${environment} immutable five-minute schedule and ${tables.length}-table direct/CASCADE truncate denial`,
  );
}

async function forwardMigrations() {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function applyForward(db) {
  for (const name of await forwardMigrations()) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
  }
}

async function bootstrapSupabaseRoleSurface(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role fidensa_studio_owner login nosuperuser noinherit createrole bypassrls;
    grant create on database postgres to fidensa_studio_owner;
  `);
}

async function applyForwardAsStudioOwner(db) {
  await db.exec("set role fidensa_studio_owner");
  try {
    for (const name of await forwardMigrations()) {
      // A production apply keeps the migration's Staged-production default.
      // The isolated harness opts into Test before the final authority lock;
      // once locked, test-clock configuration requires that existing state.
      if (name === "20260924224000_owner_authority_hardening.sql") {
        await db.query(
          "select fidensa_private.configure_test_authority('Test',$1)",
          ["2039-01-01T00:00:00Z"],
        );
      }
      await db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
    }
  } catch (error) {
    await db.exec("rollback");
    throw error;
  } finally {
    await db.exec("reset role");
  }
}

async function installTestFixturesAsStudioOwner(db) {
  await db.exec("set role fidensa_studio_owner");
  try {
    await db.exec(await readFile(testFixtureSetup, "utf8"));
  } catch (error) {
    await db.exec("rollback");
    throw error;
  } finally {
    await db.exec("reset role");
  }
}

async function configureTestAuthority(db, now, environment = "Test") {
  if (environment === "Staged-production") {
    const currentEnvironment = await scalar(
      db,
      "select environment from fidensa_private.runtime_authority where singleton",
    );
    if (currentEnvironment !== "Staged-production") {
      await db.query(
        "select fidensa_private.configure_staged_exercise_environment()",
      );
    }
  } else {
    await db.query("select fidensa_private.configure_test_authority($1,$2)", [
      environment,
      now,
    ]);
  }
}

async function submit(
  db,
  {
    label,
    email = `${label}@synthetic.invalid`,
    deliveryEmail = email,
    now = "2039-01-01T00:00:00Z",
    environment = "Test",
    marketing = false,
    operationDigest = digest(`${label}:operation`),
    verificationDigest = digest(`${label}:verification`),
    ipDigest = digest(`${label}:ip`),
    emailDigest = digest(`${label}:email`),
  },
) {
  await configureTestAuthority(db, now, environment);
  const parameters = [
    true,
    email,
    deliveryEmail,
    operationDigest,
    verificationDigest,
    ipDigest,
    emailDigest,
    "Synthetic Applicant",
    "Synthetic Role",
    "Work",
    "Synthetic Organization",
    "[synthetic fixture]",
    "[synthetic fixture]",
    "Not sure yet",
    "No fixed timeline",
    "Maybe",
    null,
    null,
    null,
    "privacy-v1",
    marketing,
    marketing ? "updates-v1" : null,
  ];
  const placeholders = parameters.map((_, index) => `$${index + 1}`).join(",");
  return withRole(db, "service_role", () =>
    scalar(
      db,
      `select fidensa_api.submit_application(${placeholders}) as application_id`,
      parameters,
    ),
  );
}

async function verify(db, label, now = "2039-01-01T00:01:00Z") {
  await configureTestAuthority(db, now);
  return withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.verify_application($1,$2) as verified", [
      digest(`${label}:verification`),
      digest(`${label}:verify-ip`),
    ]),
  );
}

async function resend(
  db,
  { email, credentialLabel, now, ipDigest, emailDigest },
) {
  await configureTestAuthority(db, now);
  return withRole(db, "service_role", () =>
    scalar(
      db,
      "select fidensa_api.resend_application_verification($1,$2,$3,$4)",
      [email, digest(credentialLabel), ipDigest, emailDigest],
    ),
  );
}

async function seedAbuseEvent(
  db,
  { eventClass, ipDigest, emailDigest = null, now },
) {
  await configureTestAuthority(db, now);
  await db.query(
    `insert into fidensa_private.abuse_events (
       event_class,ip_digest,email_digest,rate_class,result_class,
       occurred_at,deletion_deadline
     ) values ($1,$2,$3,'fixed_clock_boundary_fixture','allowed',
       fidensa_private.authoritative_now(),
       fidensa_private.authoritative_now()+interval '48 hours')`,
    [eventClass, ipDigest, emailDigest],
  );
}

async function testCatalogAndAccess(db) {
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from pg_namespace where nspname in ('fidensa_private','fidensa_api')",
      ),
    ) === 2,
    "both protected schemas must exist",
  );
  invariant(
    await scalar(
      db,
      `select not rolsuper and rolcreaterole and rolbypassrls
       from pg_roles where rolname='fidensa_studio_owner'`,
    ),
    "migration actor must match the non-superuser Studio owner privilege class",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from pg_roles where rolname in ('fidensa_mutator','fidensa_executor')",
      ),
    ) === 0 &&
      (await scalar(
        db,
        "select pg_has_role('service_role','fidensa_server','member')",
      )),
    "legacy owner roles must be absent and the server membership must be installed",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='fidensa_private' and c.relkind='r' and not c.relrowsecurity`,
      ),
    ) === 0,
    "every private table must enable RLS",
  );
  invariant(
    await scalar(
      db,
      `select reloptions @> array['security_invoker=true'] from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='fidensa_private' and c.relname='reviewer_queue'`,
    ),
    "reviewer queue must use security_invoker",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from information_schema.columns
         where table_schema='fidensa_private' and table_name='reviewer_queue'
           and column_name in ('credential_digest','ip_digest','operation_digest','provider_message_digest')`,
      ),
    ) === 0,
    "reviewer queue must exclude restricted locator and digest columns",
  );
  for (const role of ["anon", "authenticated"]) {
    invariant(
      !(await scalar(
        db,
        "select has_schema_privilege($1,'fidensa_private','usage')",
        [role],
      )),
      `${role} must not have private-schema usage`,
    );
    await withRole(db, role, () =>
      expectRejected(
        () => db.query("select count(*) from fidensa_private.applications"),
        `${role} private-table read`,
      ),
    );
    await withRole(db, role, () =>
      expectRejected(
        () =>
          db.query("select fidensa_api.verify_application($1,$2)", [
            digest("denied"),
            digest("denied-ip"),
          ]),
        `${role} RPC execution`,
      ),
    );
    invariant(
      Number(
        await scalar(
          db,
          `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='fidensa_api' and has_function_privilege($1,p.oid,'execute')`,
          [role],
        ),
      ) === 0,
      `${role} must not execute any interface operation`,
    );
  }
  invariant(
    !(await scalar(
      db,
      "select has_schema_privilege('service_role','fidensa_private','usage')",
    )),
    "service role must not have private-schema usage",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='fidensa_private'
           and has_function_privilege('anon',p.oid,'execute')`,
      ),
    ) === 0,
    "PUBLIC execute must be explicitly absent from every private function",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname in ('fidensa_api','fidensa_private')
           and p.proowner <> (select oid from pg_roles where rolname='fidensa_studio_owner')`,
      ),
    ) === 0 &&
      Number(
        await scalar(
          db,
          `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='fidensa_private' and c.relkind in ('r','p','S')
             and c.relowner <> (select oid from pg_roles where rolname='fidensa_studio_owner')`,
        ),
      ) === 0,
    "the non-superuser Studio/migration principal must own the migration surface",
  );
  invariant(
    (await scalar(
      db,
      "select role_name::text from fidensa_private.test_authority_owners",
    )) === "fidensa_studio_owner" &&
      Number(
        await scalar(
          db,
          `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='fidensa_private' and p.prokind='f'
             and (pg_get_functiondef(p.oid) ilike '%pg_context%'
               or pg_get_functiondef(p.oid) ilike '%current_setting(''fidensa.%')`,
        ),
      ) === 0,
    "install evidence must name the Studio owner and contain no stack-text or caller-GUC authorization",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_trigger t
         join pg_class c on c.oid=t.tgrelid
         join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='fidensa_private' and not t.tgisinternal and t.tgenabled<>'A'`,
      ),
    ) === 0,
    "every task trigger must be ENABLE ALWAYS",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*)
           from pg_class c
           join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='fidensa_private' and c.relkind in ('r','p')
            and not exists (
              select 1 from pg_trigger t
               where t.tgrelid=c.oid and not t.tgisinternal
                 and t.tgenabled='A'
                 and pg_get_triggerdef(t.oid) ilike '%before truncate%'
            )`,
      ),
    ) === 0,
    "every private table must carry an ENABLE ALWAYS BEFORE TRUNCATE guard",
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_private.configure_test_authority('Staged-production','2039-01-01T00:00:00Z')",
      ),
    "fixed clock outside Test",
  );
  await withRole(db, "service_role", () =>
    expectRejected(
      () => db.query("select count(*) from fidensa_private.applications"),
      "service role base-table read",
    ),
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='fidensa_api' and has_function_privilege('service_role',p.oid,'execute')`,
      ),
    ) === 13,
    "server secret role must receive only the thirteen server operations",
  );
  for (const operation of ["run_current_retention", "run_retention_health"]) {
    await withRole(db, "service_role", () =>
      expectRejected(
        () => db.query(`select fidensa_api.${operation}()`),
        `service role ${operation}`,
      ),
    );
  }
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_proc p
         join pg_namespace n on n.oid=p.pronamespace
         cross join lateral unnest(coalesce(p.proargnames,array[]::text[])) arg
         where n.nspname='fidensa_api' and has_function_privilege('service_role',p.oid,'execute')
           and arg in ('p_environment','p_now','p_received_at')`,
      ),
    ) === 0,
    "server operations must not accept caller-asserted environment or time authority",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='fidensa_private' and c.relkind in ('r','v')
           and (has_table_privilege('anon',c.oid,'select')
             or has_table_privilege('authenticated',c.oid,'select')
             or has_table_privilege('service_role',c.oid,'select'))`,
      ),
    ) === 0,
    "browser and server roles must have no private relation read grant",
  );
  console.log("PASS catalog, grants, RLS, and public denial");
}

async function testApplicationDeliveryIntents(db) {
  await db.exec("begin");
  const now = "2039-01-02T00:00:00Z";
  await configureTestAuthority(db, now);
  const label = "delivery-intent";
  const email = `${label}@synthetic.invalid`;
  const parameters = [
    true,
    email,
    email,
    digest(`${label}:operation`),
    digest(`${label}:verification`),
    digest(`${label}:ip`),
    digest(`${label}:email`),
    "Synthetic Applicant",
    "Synthetic Role",
    "Work",
    "Synthetic Organization",
    "[synthetic fixture]",
    "[synthetic fixture]",
    "Not sure yet",
    "No fixed timeline",
    "Maybe",
    null,
    null,
    null,
    "privacy-v1",
    true,
    "updates-v1",
  ];
  const placeholders = parameters.map((_, index) => `$${index + 1}`).join(",");
  const submissionIntent = await withRole(db, "service_role", () =>
    scalar(
      db,
      `select fidensa_api.submit_application_intake(${placeholders})`,
      parameters,
    ),
  );
  invariant(
    submissionIntent?.applicationId &&
      submissionIntent?.deliveryEmail === email &&
      submissionIntent?.operationId,
    "submission wrapper must return one minimal delivery intent",
  );
  invariant(
    (await scalar(
      db,
      `select state||':'||attempt_count::text
         from fidensa_private.application_message_outbox
        where communication_id=(select id from fidensa_private.communications where operation_id=$1)`,
      [submissionIntent.operationId],
    )) === "claimed:1" &&
      (await withRole(db, "service_role", () =>
        scalar(db, "select fidensa_api.claim_application_message($1)", [
          submissionIntent.operationId,
        ]),
      )) === null,
    "verification intent must be atomically leased to its credential-bearing worker",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'accepted_by_provider',$2,$3)",
      [
        submissionIntent.operationId,
        digest("synthetic-verification-provider-message"),
        "synthetic-verification-provider-message",
      ],
    ),
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from information_schema.columns
          where table_schema='fidensa_private'
            and table_name='application_message_outbox'
            and column_name like '%credential%'`,
      ),
    ) === 0,
    "outbox schema must have no reversible credential column",
  );
  invariant(
    (await scalar(
      db,
      "select state from fidensa_private.application_message_outbox where communication_id=(select id from fidensa_private.communications where operation_id=$1)",
      [submissionIntent.operationId],
    )) === "accepted",
    "initial verification acceptance must close its outbox intent",
  );
  invariant(
    await scalar(
      db,
      `select pa.acknowledged and pa.notice_version='privacy-v1'
              and pa.acknowledged_at='2039-01-02T00:00:00Z'::timestamptz
              and s.state='pending_confirmation'
              and s.consent_text_version='updates-v1'
              and s.consented_at='2039-01-02T00:00:00Z'::timestamptz
         from fidensa_private.privacy_acknowledgements pa
         join fidensa_private.subscriptions s on s.application_id=pa.application_id
        where pa.application_id=$1`,
      [submissionIntent.applicationId],
    ),
    "submission must separately capture authoritative acknowledgment and selected-consent versions/timestamps",
  );

  await configureTestAuthority(db, "2039-01-02T00:02:00Z");
  const verificationIntent = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.verify_application_intake($1,$2)", [
      digest(`${label}:verification`),
      digest(`${label}:verify-ip`),
    ]),
  );
  invariant(
    verificationIntent?.applicationId === submissionIntent.applicationId &&
      verificationIntent?.deliveryEmail === email &&
      verificationIntent?.receiptOperationId &&
      verificationIntent?.reviewerOperationId,
    "verification wrapper must return the two committed outbox identities",
  );
  invariant(
    (await scalar(
      db,
      "select state::text from fidensa_private.subscriptions where application_id=$1",
      [submissionIntent.applicationId],
    )) === "active",
    "first verification must activate only the existing pending consent",
  );
  const receiptClaim = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      verificationIntent.receiptOperationId,
    ]),
  );
  invariant(
    receiptClaim?.attemptCount === 1 &&
      receiptClaim?.providerMessageId === null,
    "receipt must begin as a first bounded delivery attempt",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',null,null)",
      [verificationIntent.receiptOperationId],
    ),
  );
  await configureTestAuthority(db, "2039-01-02T00:03:01Z");
  const retryClaim = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      verificationIntent.receiptOperationId,
    ]),
  );
  invariant(
    retryClaim?.attemptCount === 2 && retryClaim?.reconciliation === true,
    "unknown receipt must retry with the stable operation only inside the bounded window",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'accepted_by_provider',$2,$3)",
      [
        verificationIntent.receiptOperationId,
        digest("synthetic-receipt-provider-message"),
        "synthetic-receipt-provider-message",
      ],
    ),
  );
  const reviewerClaim = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      verificationIntent.reviewerOperationId,
    ]),
  );
  invariant(
    reviewerClaim?.attemptCount === 1,
    "reviewer notice must be claimable",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',$2,$3)",
      [
        verificationIntent.reviewerOperationId,
        digest("synthetic-reviewer-provider-message"),
        "synthetic-reviewer-provider-message",
      ],
    ),
  );
  await configureTestAuthority(db, "2039-01-02T00:04:02Z");
  const lookupClaim = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      verificationIntent.reviewerOperationId,
    ]),
  );
  invariant(
    lookupClaim?.providerMessageId === "synthetic-reviewer-provider-message" &&
      lookupClaim?.attemptCount === 1,
    "provider identity must reconcile by lookup without consuming a send attempt",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'accepted_by_provider',$2,$3)",
      [
        verificationIntent.reviewerOperationId,
        digest("synthetic-reviewer-provider-message"),
        "synthetic-reviewer-provider-message",
      ],
    ),
  );
  const replay = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.verify_application_intake($1,$2)", [
      digest(`${label}:verification`),
      digest(`${label}:verify-ip-replay`),
    ]),
  );
  invariant(
    replay === null,
    "verification wrapper replay must return no intent",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.communications where application_id=$1 and class='automatic'",
        [submissionIntent.applicationId],
      ),
    ) === 3 &&
      (await scalar(
        db,
        "select string_agg(type::text,',' order by type::text) from fidensa_private.communications where application_id=$1 and class='automatic'",
        [submissionIntent.applicationId],
      )) === "receipt,reviewer_notification,verification",
    "first verification and replay must leave exactly the three approved automatic communications",
  );
  const uncheckedId = await submit(db, {
    label: "delivery-unchecked",
    now: "2039-01-02T00:02:00Z",
    marketing: false,
  });
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.subscriptions where application_id=$1",
        [uncheckedId],
      ),
    ) === 0,
    "unchecked marketing consent must create no subscription",
  );
  const unknownVerificationOperation = await scalar(
    db,
    "select operation_id from fidensa_private.communications where application_id=$1 and type='verification'",
    [uncheckedId],
  );
  await db.query(
    `insert into fidensa_private.application_message_outbox (
       communication_id,state,attempt_count,first_attempt_at,available_at,
       lease_expires_at,created_at,updated_at
     ) select id,'claimed',1,fidensa_private.authoritative_now(),
              fidensa_private.authoritative_now(),
              fidensa_private.authoritative_now()+interval '5 minutes',
              fidensa_private.authoritative_now(),fidensa_private.authoritative_now()
         from fidensa_private.communications where operation_id=$1`,
    [unknownVerificationOperation],
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',null,null)",
      [unknownVerificationOperation],
    ),
  );
  invariant(
    (await scalar(
      db,
      `select state||':'||owner_reason
         from fidensa_private.application_message_outbox
        where communication_id=(select id from fidensa_private.communications where operation_id=$1)`,
      [unknownVerificationOperation],
    )) === "needs_reconciliation:credential_unavailable",
    "an ambiguous verification send without provider identity must never retry an unrecoverable credential",
  );

  async function seedOutbox(type, operationTime) {
    await configureTestAuthority(db, operationTime);
    const operationId = await scalar(
      db,
      `with communication as (
         insert into fidensa_private.communications (
           application_id,type,class,actor,recipient_class,template_version,
           operation_id,outcome,occurred_at
         ) values (
           $1,$2,'automatic','system',
           case when $2='reviewer_notification' then 'reviewer' else 'applicant' end,
           'synthetic-outbox-probe-v1',gen_random_uuid(),'intended',
           fidensa_private.authoritative_now()
         ) returning id,operation_id
       ), inserted as (
         insert into fidensa_private.application_message_outbox (
           communication_id,available_at,created_at,updated_at
         ) select id,fidensa_private.authoritative_now(),
                  fidensa_private.authoritative_now(),fidensa_private.authoritative_now()
             from communication
       ) select operation_id from communication`,
      [submissionIntent.applicationId, type],
    );
    return operationId;
  }

  const missedOperation = await seedOutbox("receipt", "2039-01-02T01:00:00Z");
  await configureTestAuthority(db, "2039-01-02T03:00:00Z");
  const missedClaim = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      missedOperation,
    ]),
  );
  invariant(
    missedClaim?.attemptCount === 1,
    "a missed hourly run must leave pending work claimable by the next run",
  );
  await configureTestAuthority(db, "2039-01-02T03:05:01Z");
  const recoveredLease = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      missedOperation,
    ]),
  );
  invariant(
    recoveredLease?.attemptCount === 2,
    "an abandoned five-minute lease must recover as a bounded retry",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'accepted_by_provider',null,null)",
      [missedOperation],
    ),
  );

  const windowOperation = await seedOutbox("receipt", "2039-01-03T00:00:00Z");
  await withRole(db, "service_role", async () => {
    await db.query("select fidensa_api.claim_application_message($1)", [
      windowOperation,
    ]);
    await db.query(
      "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',null,null)",
      [windowOperation],
    );
  });
  await configureTestAuthority(db, "2039-01-03T11:59:59Z");
  const beforeWindow = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.claim_application_message($1)", [
      windowOperation,
    ]),
  );
  invariant(
    beforeWindow?.attemptCount === 2,
    "an identical-key retry must remain eligible just before 12 hours",
  );
  await withRole(db, "service_role", () =>
    db.query(
      "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',null,null)",
      [windowOperation],
    ),
  );
  await configureTestAuthority(db, "2039-01-03T12:00:00Z");
  invariant(
    (await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.claim_application_message($1)", [
        windowOperation,
      ]),
    )) === null &&
      (await scalar(
        db,
        `select state||':'||owner_reason
           from fidensa_private.application_message_outbox
          where communication_id=(select id from fidensa_private.communications where operation_id=$1)`,
        [windowOperation],
      )) === "needs_reconciliation:provider_window_expired",
    "the 12-hour boundary must stop automatic resend and surface owner reconciliation",
  );

  const cappedOperation = await seedOutbox(
    "reviewer_notification",
    "2039-01-04T00:00:00Z",
  );
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await configureTestAuthority(db, `2039-01-04T00:0${(attempt - 1) * 2}:01Z`);
    const claim = await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.claim_application_message($1)", [
        cappedOperation,
      ]),
    );
    invariant(
      claim?.attemptCount === attempt,
      `outbox attempt ${attempt} must be bounded and observable`,
    );
    await withRole(db, "service_role", () =>
      db.query(
        "select fidensa_api.record_application_message_outcome($1,'delivery_unknown',null,null)",
        [cappedOperation],
      ),
    );
  }
  invariant(
    (await scalar(
      db,
      `select state||':'||owner_reason
         from fidensa_private.application_message_outbox
        where communication_id=(select id from fidensa_private.communications where operation_id=$1)`,
      [cappedOperation],
    )) === "needs_reconciliation:attempt_cap_reached",
    "the third unknown send must stop and expose the attempt-cap escalation",
  );

  const beforeHoneypot = Number(
    await scalar(
      db,
      "select count(*) from fidensa_private.abuse_events where rate_class='application_submission' and result_class='denied'",
    ),
  );
  await withRole(db, "service_role", () =>
    db.query("select fidensa_api.record_application_honeypot($1,$2)", [
      digest("honeypot:ip"),
      digest("honeypot:email"),
    ]),
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.abuse_events where rate_class='application_submission' and result_class='denied'",
      ),
    ) ===
      beforeHoneypot + 1,
    "honeypot wrapper must retain one bounded abuse event",
  );
  await db.exec("rollback");
  console.log(
    "PASS minimal delivery intents, single verification emission, replay, and honeypot event",
  );
}

async function testApplicationRateLimits(db) {
  await db.exec("begin");

  const sharedEmail = "rate-email@synthetic.invalid";
  const sharedEmailDigest = digest("rate-email:digest");
  for (let index = 0; index < 3; index += 1) {
    await submit(db, {
      label: `rate-email-hour-${index}`,
      email: sharedEmail,
      now: "2039-02-01T00:00:00Z",
      operationDigest: digest(`rate-email-hour:operation:${index}`),
      emailDigest: sharedEmailDigest,
    });
  }
  await submit(db, {
    label: "rate-email-hour-denied",
    email: sharedEmail,
    now: "2039-02-01T00:00:00Z",
    operationDigest: digest("rate-email-hour:operation:denied"),
    emailDigest: sharedEmailDigest,
  });
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.abuse_events where event_class='submission' and email_digest=$1 and result_class='denied'",
        [sharedEmailDigest],
      ),
    ) === 1,
    "submission must enforce the 3/hour normalized-email cap",
  );

  const dailyEmail = "rate-email-day@synthetic.invalid";
  const dailyEmailDigest = digest("rate-email-day:digest");
  for (let index = 0; index < 6; index += 1) {
    const hour = String(index * 2).padStart(2, "0");
    await submit(db, {
      label: `rate-email-day-${index}`,
      email: dailyEmail,
      now: `2039-02-02T${hour}:00:00Z`,
      operationDigest: digest(`rate-email-day:operation:${index}`),
      emailDigest: dailyEmailDigest,
    });
  }
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.abuse_events where event_class='submission' and email_digest=$1 and result_class='allowed'",
        [dailyEmailDigest],
      ),
    ) === 5 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.abuse_events where event_class='submission' and email_digest=$1 and result_class='denied'",
          [dailyEmailDigest],
        ),
      ) === 1,
    "submission must enforce the rolling 5/day normalized-email cap",
  );

  const hourlyIp = digest("rate-ip-hour:digest");
  for (let index = 0; index < 11; index += 1) {
    await submit(db, {
      label: `rate-ip-hour-${index}`,
      now: "2039-02-03T00:00:00Z",
      ipDigest: hourlyIp,
    });
  }
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.applications where canonical_email like 'rate-ip-hour-%'",
      ),
    ) === 10,
    "submission must enforce the 10/hour IP cap",
  );

  const cooldownDeniedEmail = "cooldown-denied@synthetic.invalid";
  const cooldownDeniedDigest = digest("cooldown-denied:email");
  await submit(db, {
    label: "cooldown-denied",
    email: cooldownDeniedEmail,
    now: "2039-02-04T00:00:00Z",
    emailDigest: cooldownDeniedDigest,
  });
  invariant(
    !(await resend(db, {
      email: cooldownDeniedEmail,
      credentialLabel: "cooldown-denied:at-59",
      now: "2039-02-04T00:00:59Z",
      ipDigest: digest("cooldown-denied:ip"),
      emailDigest: cooldownDeniedDigest,
    })),
    "resend must deny before the shared 60-second boundary",
  );
  const cooldownAllowedEmail = "cooldown-allowed@synthetic.invalid";
  const cooldownAllowedDigest = digest("cooldown-allowed:email");
  await submit(db, {
    label: "cooldown-allowed",
    email: cooldownAllowedEmail,
    now: "2039-02-04T01:00:00Z",
    emailDigest: cooldownAllowedDigest,
  });
  invariant(
    await resend(db, {
      email: cooldownAllowedEmail,
      credentialLabel: "cooldown-allowed:at-60",
      now: "2039-02-04T01:01:00Z",
      ipDigest: digest("cooldown-allowed:ip"),
      emailDigest: cooldownAllowedDigest,
    }),
    "resend must allow exactly at the shared 60-second boundary",
  );

  const resendEmail = "resend-hour@synthetic.invalid";
  const resendEmailDigest = digest("resend-hour:email");
  await submit(db, {
    label: "resend-hour",
    email: resendEmail,
    now: "2039-02-04T02:00:00Z",
    emailDigest: resendEmailDigest,
  });
  for (let index = 1; index <= 2; index += 1) {
    invariant(
      await resend(db, {
        email: resendEmail,
        credentialLabel: `resend-hour:${index}`,
        now: `2039-02-04T02:0${index}:00Z`,
        ipDigest: digest(`resend-hour:ip:${index}`),
        emailDigest: resendEmailDigest,
      }),
      `resend ${index} inside the 3/hour combined budget must be allowed`,
    );
  }
  invariant(
    !(await resend(db, {
      email: resendEmail,
      credentialLabel: "resend-hour:denied",
      now: "2039-02-04T02:03:00Z",
      ipDigest: digest("resend-hour:ip:denied"),
      emailDigest: resendEmailDigest,
    })),
    "resend must enforce the combined 3/hour email cap",
  );

  const resendDailyEmail = "resend-day@synthetic.invalid";
  const resendDailyDigest = digest("resend-day:email");
  await submit(db, {
    label: "resend-day",
    email: resendDailyEmail,
    now: "2039-02-05T00:00:00Z",
    emailDigest: resendDailyDigest,
  });
  for (let index = 1; index <= 4; index += 1) {
    invariant(
      await resend(db, {
        email: resendDailyEmail,
        credentialLabel: `resend-day:${index}`,
        now: `2039-02-05T${String(index * 2).padStart(2, "0")}:00:00Z`,
        ipDigest: digest(`resend-day:ip:${index}`),
        emailDigest: resendDailyDigest,
      }),
      `resend ${index} inside the 5/day combined budget must be allowed`,
    );
  }
  invariant(
    !(await resend(db, {
      email: resendDailyEmail,
      credentialLabel: "resend-day:denied",
      now: "2039-02-05T10:00:00Z",
      ipDigest: digest("resend-day:ip:denied"),
      emailDigest: resendDailyDigest,
    })),
    "resend must enforce the combined 5/day email cap",
  );

  const verificationIp = digest("verification-rate:ip");
  await configureTestAuthority(db, "2039-02-06T00:00:00Z");
  for (let index = 0; index < 31; index += 1) {
    await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest(`verification-rate:unknown:${index}`),
        verificationIp,
      ]),
    );
  }
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.abuse_events where event_class='verification' and ip_digest=$1 and result_class='denied'",
        [verificationIp],
      ),
    ) === 1 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.abuse_events where event_class='verification' and ip_digest=$1 and result_class='allowed'",
          [verificationIp],
        ),
      ) === 30,
    "verification must allow N-1 and N, then enforce the 30/hour IP cap",
  );

  const submissionDailyIp = digest("submission-daily-boundary:ip");
  const submissionDailyStart = Date.parse("2039-02-07T00:00:00Z");
  for (let index = 0; index < 40; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "submission",
      ipDigest: submissionDailyIp,
      now: new Date(submissionDailyStart + index * 30 * 60_000).toISOString(),
    });
  }
  invariant(
    (await submit(db, {
      label: "submission-ip-day-denied",
      now: new Date(submissionDailyStart + 20 * 60 * 60_000).toISOString(),
      ipDigest: submissionDailyIp,
    })) === null,
    "submission must behaviorally enforce the 40/day IP cap",
  );
  const submissionDailyNMinusOneIp = digest("submission-daily-n-minus-one:ip");
  for (let index = 0; index < 39; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "submission",
      ipDigest: submissionDailyNMinusOneIp,
      now: new Date(submissionDailyStart + index * 30 * 60_000).toISOString(),
    });
  }
  invariant(
    await submit(db, {
      label: "submission-ip-day-n-minus-one",
      now: new Date(submissionDailyStart + 20 * 60 * 60_000).toISOString(),
      ipDigest: submissionDailyNMinusOneIp,
    }),
    "submission must allow the daily IP boundary after N-1 prior events",
  );

  const verificationHourlyEmail = digest("verification-email-hour:email");
  await submit(db, {
    label: "verification-email-hour",
    now: "2039-02-08T00:00:00Z",
    emailDigest: verificationHourlyEmail,
  });
  for (let index = 0; index < 10; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "verification",
      ipDigest: digest(`verification-email-hour:seed-ip:${index}`),
      emailDigest: verificationHourlyEmail,
      now: "2039-02-08T00:01:00Z",
    });
  }
  await configureTestAuthority(db, "2039-02-08T00:02:00Z");
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("verification-email-hour:verification"),
        digest("verification-email-hour:attempt-ip"),
      ]),
    )),
    "verification must behaviorally enforce the 10/hour email cap",
  );

  const verificationDailyEmail = digest("verification-email-day:email");
  await submit(db, {
    label: "verification-email-day",
    now: "2039-02-09T00:00:00Z",
    emailDigest: verificationDailyEmail,
  });
  const verificationDailyStart = Date.parse("2039-02-09T01:00:00Z");
  for (let index = 0; index < 20; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "verification",
      ipDigest: digest(`verification-email-day:seed-ip:${index}`),
      emailDigest: verificationDailyEmail,
      now: new Date(verificationDailyStart + index * 60 * 60_000).toISOString(),
    });
  }
  await configureTestAuthority(db, "2039-02-09T21:00:00Z");
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("verification-email-day:verification"),
        digest("verification-email-day:attempt-ip"),
      ]),
    )),
    "verification must behaviorally enforce the 20/day email cap",
  );

  const verificationDailyIp = digest("verification-ip-day:ip");
  const verificationDailyIpStart = Date.parse("2039-02-09T22:00:00Z");
  for (let index = 0; index < 99; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "verification",
      ipDigest: verificationDailyIp,
      now: new Date(
        verificationDailyIpStart + index * 14 * 60_000,
      ).toISOString(),
    });
  }
  await configureTestAuthority(db, "2039-02-10T21:30:00Z");
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("verification-ip-day:n-minus-one"),
        verificationDailyIp,
      ]),
    )),
    "an unmatched verification remains a generic no-op at the daily IP N-1 boundary",
  );
  await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.verify_application($1,$2)", [
      digest("verification-ip-day:denied"),
      verificationDailyIp,
    ]),
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.abuse_events where event_class='verification' and ip_digest=$1 and result_class='allowed'",
        [verificationDailyIp],
      ),
    ) === 100 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.abuse_events where event_class='verification' and ip_digest=$1 and result_class='denied'",
          [verificationDailyIp],
        ),
      ) === 1,
    "verification must allow N-1 and N, then enforce the 100/day IP cap",
  );

  const resendHourlyIp = digest("resend-ip-hour:ip");
  const resendHourlyEmail = "resend-ip-hour@synthetic.invalid";
  const resendHourlyEmailDigest = digest("resend-ip-hour:email");
  await submit(db, {
    label: "resend-ip-hour",
    email: resendHourlyEmail,
    now: "2039-02-10T00:00:00Z",
    emailDigest: resendHourlyEmailDigest,
  });
  for (let index = 0; index < 10; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "delivery",
      ipDigest: resendHourlyIp,
      emailDigest: digest(`resend-ip-hour:seed-email:${index}`),
      now: "2039-02-10T00:01:00Z",
    });
  }
  invariant(
    !(await resend(db, {
      email: resendHourlyEmail,
      credentialLabel: "resend-ip-hour:replacement",
      now: "2039-02-10T00:02:00Z",
      ipDigest: resendHourlyIp,
      emailDigest: resendHourlyEmailDigest,
    })),
    "resend must behaviorally enforce the 10/hour IP cap",
  );
  const resendHourlyNMinusOneIp = digest("resend-ip-hour-n-minus-one:ip");
  for (let index = 0; index < 8; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "delivery",
      ipDigest: resendHourlyNMinusOneIp,
      emailDigest: digest(`resend-ip-hour-n-minus-one:email:${index}`),
      now: "2039-02-10T01:01:00Z",
    });
  }
  const resendHourlyNMinusOneEmail =
    "resend-ip-hour-n-minus-one@synthetic.invalid";
  const resendHourlyNMinusOneEmailDigest = digest(
    "resend-ip-hour-n-minus-one:email",
  );
  await submit(db, {
    label: "resend-ip-hour-n-minus-one",
    email: resendHourlyNMinusOneEmail,
    now: "2039-02-10T01:00:00Z",
    emailDigest: resendHourlyNMinusOneEmailDigest,
  });
  invariant(
    await resend(db, {
      email: resendHourlyNMinusOneEmail,
      credentialLabel: "resend-ip-hour-n-minus-one:replacement",
      now: "2039-02-10T01:02:00Z",
      ipDigest: resendHourlyNMinusOneIp,
      emailDigest: resendHourlyNMinusOneEmailDigest,
    }),
    "resend must allow the hourly IP boundary after N-1 prior events",
  );

  const resendDailyIp = digest("resend-ip-day:ip");
  const resendDailyIpEmail = "resend-ip-day@synthetic.invalid";
  const resendDailyIpEmailDigest = digest("resend-ip-day:email");
  await submit(db, {
    label: "resend-ip-day",
    email: resendDailyIpEmail,
    now: "2039-02-11T00:00:00Z",
    emailDigest: resendDailyIpEmailDigest,
  });
  const resendDailyIpStart = Date.parse("2039-02-11T01:00:00Z");
  for (let index = 0; index < 30; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "delivery",
      ipDigest: resendDailyIp,
      emailDigest: digest(`resend-ip-day:seed-email:${index}`),
      now: new Date(resendDailyIpStart + index * 40 * 60_000).toISOString(),
    });
  }
  invariant(
    !(await resend(db, {
      email: resendDailyIpEmail,
      credentialLabel: "resend-ip-day:replacement",
      now: "2039-02-11T21:00:00Z",
      ipDigest: resendDailyIp,
      emailDigest: resendDailyIpEmailDigest,
    })),
    "resend must behaviorally enforce the 30/day IP cap",
  );
  const resendDailyNMinusOneIp = digest("resend-ip-day-n-minus-one:ip");
  for (let index = 0; index < 28; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "delivery",
      ipDigest: resendDailyNMinusOneIp,
      emailDigest: digest(`resend-ip-day-n-minus-one:email:${index}`),
      now: new Date(resendDailyIpStart + index * 40 * 60_000).toISOString(),
    });
  }
  const resendDailyNMinusOneEmail =
    "resend-ip-day-n-minus-one@synthetic.invalid";
  const resendDailyNMinusOneEmailDigest = digest(
    "resend-ip-day-n-minus-one:email",
  );
  await submit(db, {
    label: "resend-ip-day-n-minus-one",
    email: resendDailyNMinusOneEmail,
    now: "2039-02-11T00:00:00Z",
    emailDigest: resendDailyNMinusOneEmailDigest,
  });
  invariant(
    await resend(db, {
      email: resendDailyNMinusOneEmail,
      credentialLabel: "resend-ip-day-n-minus-one:replacement",
      now: "2039-02-11T21:00:00Z",
      ipDigest: resendDailyNMinusOneIp,
      emailDigest: resendDailyNMinusOneEmailDigest,
    }),
    "resend must allow the daily IP boundary after N-1 prior events",
  );

  const hourlyLeftBoundaryIp = digest("submission-hour-left-boundary:ip");
  for (let index = 0; index < 10; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "submission",
      ipDigest: hourlyLeftBoundaryIp,
      now: "2039-02-12T00:00:00Z",
    });
  }
  invariant(
    await submit(db, {
      label: "submission-hour-left-boundary",
      now: "2039-02-12T01:00:00Z",
      ipDigest: hourlyLeftBoundaryIp,
    }),
    "an event exactly at the rolling hourly left boundary must be excluded",
  );

  const dailyLeftBoundaryIp = digest("submission-day-left-boundary:ip");
  const dailyLeftStart = Date.parse("2039-02-13T00:00:00Z");
  for (let index = 0; index < 40; index += 1) {
    await seedAbuseEvent(db, {
      eventClass: "submission",
      ipDigest: dailyLeftBoundaryIp,
      now: new Date(dailyLeftStart + index * 35 * 60_000).toISOString(),
    });
  }
  invariant(
    await submit(db, {
      label: "submission-day-left-boundary",
      now: "2039-02-14T00:00:00Z",
      ipDigest: dailyLeftBoundaryIp,
    }),
    "an event exactly at the rolling daily left boundary must be excluded",
  );

  const operationSource = await scalar(
    db,
    `select pg_get_functiondef('fidensa_api.verify_application(text,text)'::regprocedure)`,
  );
  invariant(
    operationSource.includes(">= 100") &&
      operationSource.includes(">= 10") &&
      operationSource.includes(">= 20"),
    "verification operation must retain the approved IP daily and email hourly/daily caps",
  );
  const submissionSource = await scalar(
    db,
    `select pg_get_functiondef('fidensa_api.submit_application(boolean,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)'::regprocedure)`,
  );
  invariant(
    submissionSource.includes(">= 10") &&
      submissionSource.includes(">= 40") &&
      submissionSource.includes(">= 3") &&
      submissionSource.includes(">= 5"),
    "submission operation must retain the approved IP and email hourly/daily caps",
  );
  const resendSource = await scalar(
    db,
    `select pg_get_functiondef('fidensa_api.resend_application_verification(text,text,text,text)'::regprocedure)`,
  );
  invariant(
    resendSource.includes(">= 10") &&
      resendSource.includes(">= 30") &&
      resendSource.includes(">= 3") &&
      resendSource.includes(">= 5") &&
      resendSource.includes("interval '60 seconds'"),
    "resend operation must retain the approved IP/email hourly/daily caps and cooldown",
  );

  await db.exec("rollback");
  console.log(
    "PASS fixed-clock submission, verification, and resend cooldown/hour/day rate limits",
  );
}

async function testApplicationFailurePaths(db) {
  await db.exec("begin");

  const duplicateEmail = "duplicate@synthetic.invalid";
  const firstDuplicate = await submit(db, {
    label: "duplicate-first",
    email: duplicateEmail,
    now: "2039-01-10T00:00:00Z",
  });
  const secondDuplicate = await submit(db, {
    label: "duplicate-second",
    email: duplicateEmail,
    deliveryEmail: "Duplicate@Synthetic.Invalid",
    now: "2039-01-10T00:00:01Z",
  });
  invariant(
    firstDuplicate && secondDuplicate === null,
    "case-only different-key duplicate submissions must retain one application",
  );

  const beforeExpiryId = await submit(db, {
    label: "before-expiry-boundary",
    now: "2039-01-10T00:00:00Z",
  });
  invariant(
    beforeExpiryId &&
      (await verify(db, "before-expiry-boundary", "2039-01-10T00:59:59Z")),
    "credential must remain valid one second before the 60-minute boundary",
  );

  const expiredId = await submit(db, {
    label: "expired-boundary",
    now: "2039-01-10T01:00:00Z",
  });
  invariant(expiredId, "expiry fixture must commit");
  invariant(
    !(await verify(db, "expired-boundary", "2039-01-10T02:00:00Z")),
    "credential must be invalid at the exact 60-minute boundary",
  );

  await configureTestAuthority(db, "2039-01-10T02:10:00Z");
  const wrongPurposeDigest = digest("wrong-purpose:privacy-confirmation");
  const privacyRequestId = await withRole(db, "service_role", () =>
    scalar(
      db,
      "select fidensa_api.create_privacy_request('access',$1,$1,'privacy_public',$2,null)",
      ["wrong-purpose@synthetic.invalid", digest("wrong-purpose:operation")],
    ),
  );
  await db.query(
    `insert into fidensa_private.privacy_credentials (
       privacy_request_id,purpose,credential_digest,generation,issued_at,expires_at
     ) values ($1,'privacy_confirmation',$2,1,
       fidensa_private.authoritative_now(),
       fidensa_private.authoritative_now()+interval '30 minutes')`,
    [privacyRequestId, wrongPurposeDigest],
  );
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        wrongPurposeDigest,
        digest("wrong-purpose:ip"),
      ]),
    )) &&
      (await scalar(
        db,
        "select state::text from fidensa_private.privacy_credentials where privacy_request_id=$1",
        [privacyRequestId],
      )) === "issued",
    "a database credential issued for another purpose must not verify an application",
  );

  const supersededEmail = "superseded@synthetic.invalid";
  const supersededEmailDigest = digest("superseded:email");
  const supersededId = await submit(db, {
    label: "superseded",
    email: supersededEmail,
    now: "2039-01-10T03:00:00Z",
    emailDigest: supersededEmailDigest,
  });
  invariant(
    await resend(db, {
      email: supersededEmail,
      credentialLabel: "superseded:new",
      now: "2039-01-10T03:01:00Z",
      ipDigest: digest("superseded:resend-ip"),
      emailDigest: supersededEmailDigest,
    }),
    "resend must issue a replacement credential",
  );
  await configureTestAuthority(db, "2039-01-10T03:02:00Z");
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("superseded:verification"),
        digest("superseded:old-ip"),
      ]),
    )) &&
      (await withRole(db, "service_role", () =>
        scalar(db, "select fidensa_api.verify_application($1,$2)", [
          digest("superseded:new"),
          digest("superseded:new-ip"),
        ]),
      )),
    "supersession must reject the old credential and consume only the new one",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.reviewer_status where application_id=$1",
        [supersededId],
      ),
    ) === 1,
    "supersession must create exactly one queue entry",
  );

  const concurrentId = await submit(db, {
    label: "concurrent-verify",
    now: "2039-01-10T04:00:00Z",
  });
  await configureTestAuthority(db, "2039-01-10T04:01:00Z");
  await db.exec("set role service_role");
  let concurrentResults;
  try {
    concurrentResults = await Promise.all([
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("concurrent-verify:verification"),
        digest("concurrent-verify:ip-one"),
      ]),
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("concurrent-verify:verification"),
        digest("concurrent-verify:ip-two"),
      ]),
    ]);
  } finally {
    await db.exec("reset role");
  }
  invariant(
    concurrentResults.filter(Boolean).length === 1 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.reviewer_status where application_id=$1",
          [concurrentId],
        ),
      ) === 1,
    "serialized concurrent first use must promote exactly once",
  );

  await db.exec("savepoint rollback_probe");
  const rollbackId = await submit(db, {
    label: "rollback-probe",
    now: "2039-01-10T05:00:00Z",
  });
  invariant(rollbackId, "rollback fixture must initially commit");
  await db.exec("rollback to savepoint rollback_probe");
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.applications where canonical_email='rollback-probe@synthetic.invalid'",
      ),
    ) === 0,
    "database rollback must remove the application and its message outbox",
  );

  await db.exec("rollback");
  console.log(
    "PASS duplicate, expiry, supersession, concurrent first-use, and rollback paths",
  );
}

async function testApplicationQueueAndScoring(db) {
  const applicationId = await submit(db, { label: "queue" });
  invariant(applicationId, "synthetic application should commit");
  invariant(
    Number(
      await scalar(db, "select count(*) from fidensa_private.reviewer_queue"),
    ) === 0,
    "pending verification must be excluded from the queue",
  );
  await expectRejected(
    () =>
      db.query(
        `insert into fidensa_private.reviewer_status
         (application_id,state,actor,reason,changed_at)
         values ($1,'new','scott_bishop','direct',clock_timestamp())`,
        [applicationId],
      ),
    "direct queue entry",
  );
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.verify_application($1,$2)", [
        digest("wrong"),
        digest("queue:verify-ip"),
      ]),
    )),
    "unknown verification digest must be a no-op",
  );
  invariant(await verify(db, "queue"), "current verification must succeed");
  invariant(
    (await scalar(
      db,
      "select actor from fidensa_private.reviewer_status where application_id=$1",
      [applicationId],
    )) === "system",
    "verification-driven queue entry must be attributed to system",
  );
  invariant(
    Number(
      await scalar(db, "select count(*) from fidensa_private.reviewer_queue"),
    ) === 1,
    "verified application must enter the private queue",
  );
  await expectRejected(
    () =>
      db.query(
        "update fidensa_private.reviewer_status set state='shortlist' where application_id=$1",
        [applicationId],
      ),
    "direct queue update",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.queue_write',$1,true)", [
        applicationId,
      ]);
      await db.query(
        "update fidensa_private.reviewer_status set state='shortlist' where application_id=$1",
        [applicationId],
      );
    },
    "forged queue-write setting",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.queue_write',$1,true)", [
        applicationId,
      ]);
      await db.query(
        `insert into fidensa_private.reviewer_status_history
         (application_id,prior_state,new_state,actor,reason,occurred_at,transition_version)
         values ($1,'new','shortlist','scott_bishop','forged',clock_timestamp(),2)`,
        [applicationId],
      );
    },
    "forged status-history insert",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.application_write',$1,true)", [
        applicationId,
      ]);
      await db.query(
        "update fidensa_private.applications set version=version+1 where id=$1",
        [applicationId],
      );
    },
    "forged application-write setting",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.score_write',$1,true)", [
        applicationId,
      ]);
      await db.query(
        `insert into fidensa_private.application_score_cohorts
         (application_id,rubric_version_id,first_scored_at)
         values ($1,'00000000-0000-4000-8000-000000000101',clock_timestamp())`,
        [applicationId],
      );
    },
    "forged score-write setting",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.governed_delete','on',true)");
      await db.query(
        "delete from fidensa_private.reviewer_status_history where application_id=$1",
        [applicationId],
      );
    },
    "forged governed-delete setting",
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_reviewer_status($1,1,'new','no-op','scott_bishop',$2)",
        [applicationId, "2039-01-01T00:02:00Z"],
      ),
    "queue no-op",
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_reviewer_status($1,1,'shortlist','reason','provider',$2)",
        [applicationId, "2039-01-01T00:02:00Z"],
      ),
    "non-Scott queue transition",
  );
  await withRole(db, "service_role", () =>
    expectRejected(
      () =>
        db.query(
          "select fidensa_api.transition_reviewer_status($1,1,'shortlist','reason','scott_bishop',$2)",
          [applicationId, "2039-01-01T00:02:00Z"],
        ),
      "server secret reviewer transition",
    ),
  );
  const mailBefore = Number(
    await scalar(
      db,
      "select count(*) from fidensa_private.communications where application_id=$1",
      [applicationId],
    ),
  );
  invariant(
    Number(
      await scalar(
        db,
        "select fidensa_api.transition_reviewer_status($1,1,'shortlist','manual review','scott_bishop',$2)",
        [applicationId, "2039-01-01T00:02:00Z"],
      ),
    ) === 2,
    "allowed queue transition must advance version",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.communications where application_id=$1",
        [applicationId],
      ),
    ) === mailBefore,
    "queue transition must not create email",
  );

  const partialEntries = [
    ["real_ai_security_need", "3"],
    ["contained_runner_fit", "3"],
    ["design_partner_willingness", "3"],
    ["deployment_feasibility", "3"],
  ].map(([criterion, value]) => ({
    criterion,
    value,
    rationale: "Synthetic rationale",
  }));
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,0,'scott_bishop',$3)",
    [applicationId, JSON.stringify(partialEntries), "2039-01-01T00:03:00Z"],
  );
  invariant(
    (await scalar(
      db,
      "select display from fidensa_private.score_displays where application_id=$1",
      [applicationId],
    )) === "12/16 assessed points — 4 of 5 criteria assessed",
    "partial-score display must be exact",
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,2,'scott_bishop',$3)",
        [
          applicationId,
          JSON.stringify([
            { criterion: "feedback_urgency", value: "N/A", rationale: "" },
          ]),
          "2039-01-01T00:04:00Z",
        ],
      ),
    "N/A without rationale",
  );
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,2,'scott_bishop',$3)",
    [
      applicationId,
      JSON.stringify([
        {
          criterion: "feedback_urgency",
          value: "N/A",
          rationale: "Insufficient synthetic information",
        },
      ]),
      "2039-01-01T00:04:00Z",
    ],
  );
  invariant(
    (await scalar(
      db,
      "select display from fidensa_private.score_displays where application_id=$1",
      [applicationId],
    )) === "12/16 assessed points — 4 of 5 criteria assessed",
    "N/A must not inflate assessed points",
  );
  invariant(
    (await scalar(
      db,
      "select state::text from fidensa_private.reviewer_status where application_id=$1",
      [applicationId],
    )) === "shortlist",
    "scoring must not change status",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.communications where application_id=$1",
        [applicationId],
      ),
    ) === mailBefore,
    "scoring must not create email",
  );
  const completeEntries = [
    "real_ai_security_need",
    "contained_runner_fit",
    "design_partner_willingness",
    "deployment_feasibility",
    "feedback_urgency",
  ].map((criterion) => ({
    criterion,
    value: "4",
    rationale: "Synthetic rationale",
  }));
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,3,'scott_bishop',$3)",
    [applicationId, JSON.stringify(completeEntries), "2039-01-01T00:05:00Z"],
  );
  invariant(
    (await scalar(
      db,
      "select display from fidensa_private.score_displays where application_id=$1",
      [applicationId],
    )) === "20/20",
    "complete five-criterion score must use the 0–20 display",
  );
  const emptyScoreApplication = await submit(db, {
    label: "score-empty",
    now: "2039-01-01T00:10:00Z",
  });
  await verify(db, "score-empty", "2039-01-01T00:11:00Z");
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1','[]'::jsonb,0,'scott_bishop',$2)",
    [emptyScoreApplication, "2039-01-01T00:12:00Z"],
  );
  invariant(
    (await scalar(
      db,
      "select display from fidensa_private.score_displays where application_id=$1",
      [emptyScoreApplication],
    )) === "0/0 assessed points — 0 of 5 criteria assessed",
    "wholly unscored display must remain 0/0 rather than converting missing to N/A",
  );
  const allNaEntries = [
    "real_ai_security_need",
    "contained_runner_fit",
    "design_partner_willingness",
    "deployment_feasibility",
    "feedback_urgency",
  ].map((criterion) => ({
    criterion,
    value: "N/A",
    rationale: "Insufficient synthetic information",
  }));
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,2,'scott_bishop',$3)",
    [
      emptyScoreApplication,
      JSON.stringify(allNaEntries),
      "2039-01-01T00:13:00Z",
    ],
  );
  invariant(
    (await scalar(
      db,
      "select display from fidensa_private.score_displays where application_id=$1",
      [emptyScoreApplication],
    )) === "0/0 assessed points — 0 of 5 criteria assessed",
    "an all-N/A score must remain 0/0 assessed points",
  );
  const prohibited = await db.query(
    "select unnest(prohibited_factors) as factor from fidensa_private.rubric_versions where version_label='rubric-v1' order by factor",
  );
  invariant(
    prohibited.rows.map((row) => row.factor).join("|") ===
      "company prestige|marketing consent|protected characteristics",
    "all prohibited scoring factors must be recorded",
  );
  await expectRejected(
    () =>
      db.query(
        "update fidensa_private.rubric_criteria set label='changed' where criterion_key='feedback_urgency'",
      ),
    "immutable rubric criterion",
  );

  const rubricV2 = [
    [1, "real_ai_security_need", "Real AI-security evaluation need"],
    [2, "contained_runner_fit", "Fit with current contained-runner capability"],
    [3, "design_partner_willingness", "Design-partner willingness"],
    [4, "deployment_feasibility", "Deployment and integration feasibility"],
    [5, "feedback_urgency", "Urgency and ability to provide useful feedback"],
  ].map(([ordinal, criterion, label]) => ({ ordinal, criterion, label }));
  await db.query(
    "select fidensa_api.activate_rubric_version('rubric-v2','cohort-v2',$1::jsonb,'scott_bishop',$2)",
    [JSON.stringify(rubricV2), "2039-01-02T00:00:00Z"],
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.rubric_rescore_requirements r
         join fidensa_private.rubric_versions v on v.id=r.rubric_version_id
         where r.application_id=$1 and r.completed_at is null and v.version_label='rubric-v2'`,
        [applicationId],
      ),
    ) === 1,
    "material rubric change must require active-candidate rescore",
  );
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v2',$2::jsonb,0,'scott_bishop',$3)",
    [applicationId, JSON.stringify(completeEntries), "2099-01-02T00:01:00Z"],
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.rubric_rescore_requirements r
         join fidensa_private.rubric_versions v on v.id=r.rubric_version_id
         where r.application_id=$1 and r.completed_at is not null and v.version_label='rubric-v2'`,
        [applicationId],
      ),
    ) === 1 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.score_sets where application_id=$1 and superseded_at is null",
          [applicationId],
        ),
      ) === 2,
    "material-change rescore must complete under the new rubric and retain the prior set",
  );
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,4,'scott_bishop',$3)",
    [applicationId, JSON.stringify(completeEntries), "2039-01-02T00:02:00Z"],
  );
  const newCohortApplication = await submit(db, {
    label: "new-cohort",
    now: "2039-01-02T00:03:00Z",
  });
  await verify(db, "new-cohort", "2039-01-02T00:04:00Z");
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.record_score_set($1,'rubric-v1',$2::jsonb,0,'scott_bishop',$3)",
        [
          newCohortApplication,
          JSON.stringify(completeEntries),
          "2039-01-02T00:05:00Z",
        ],
      ),
    "inactive initial rubric",
  );
  await db.query(
    "select fidensa_api.record_score_set($1,'rubric-v2',$2::jsonb,0,'scott_bishop',$3)",
    [
      newCohortApplication,
      JSON.stringify(completeEntries),
      "2039-01-02T00:06:00Z",
    ],
  );
  await createTestFixture(db, "rubric_calibration_count");
  invariant(
    await scalar(
      db,
      "select calibration_due from fidensa_private.rubric_calibration_due where version_label='rubric-v2'",
    ),
    "twentieth score must trigger calibration",
  );
  const calibrationId = await scalar(
    db,
    "select fidensa_api.record_rubric_calibration('rubric-v2','Synthetic calibration findings','scott_bishop')",
  );
  invariant(
    calibrationId &&
      Number(
        await scalar(
          db,
          "select scored_since_calibration from fidensa_private.rubric_versions where version_label='rubric-v2'",
        ),
      ) === 0,
    "calibration operation must append findings and reset the score counter",
  );
  await configureTestAuthority(db, "2039-02-02T00:00:01Z");
  invariant(
    await scalar(
      db,
      "select calibration_due from fidensa_private.rubric_calibration_due where version_label='rubric-v2'",
    ),
    "30 elapsed days must trigger calibration",
  );
  invariant(
    (await scalar(
      db,
      `select rv.version_label from fidensa_private.application_score_cohorts c
       join fidensa_private.rubric_versions rv on rv.id=c.rubric_version_id
       where c.application_id=$1`,
      [applicationId],
    )) === "rubric-v1",
    "first-score cohort assignment must remain stable across rubric activation",
  );
  await configureTestAuthority(db, "2039-01-02T00:10:00Z");
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.record_direct_interaction($1,$2,'scott_bishop')",
        [applicationId, "2039-01-02T00:10:01Z"],
      ),
    "future direct interaction",
  );

  await db.query(
    "select fidensa_api.transition_reviewer_status($1,2,'accepted','separate manual decision','scott_bishop',$2)",
    [applicationId, "2039-01-03T00:00:00Z"],
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_reviewer_status($1,3,'declined','forbidden','scott_bishop',$2)",
        [applicationId, "2039-01-03T00:01:00Z"],
      ),
    "transition out of accepted",
  );
  console.log("PASS application, queue, scoring, and communication invariants");
}

async function testExerciseControl(db) {
  const correlation = "00000000-0000-4000-8000-000000000201";
  const stagedClock = Date.now();
  const stagedOpensAt = new Date(stagedClock - 60_000).toISOString();
  const stagedExpiresAt = new Date(stagedClock + 86_400_000).toISOString();
  const createParameters = [
    correlation,
    digest("checklist"),
    "deployment-synthetic-identity",
    digest("config"),
    "1".repeat(40),
    "exercise@synthetic.invalid",
    stagedOpensAt,
    stagedExpiresAt,
    digest("members"),
    "2040-12-31T23:00:00Z",
  ];
  const exerciseId = await scalar(
    db,
    `select fidensa_api.create_exercise_control(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
    )`,
    createParameters,
  );
  await expectRejected(
    () =>
      db.query(
        `select fidensa_api.create_exercise_control(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        )`,
        ["00000000-0000-4000-8000-000000000202", ...createParameters.slice(1)],
      ),
    "second active exercise gate",
  );
  await expectRejected(
    () =>
      db.query(
        "update fidensa_private.exercise_controls set state='intake_open' where id=$1",
        [exerciseId],
      ),
    "direct exercise mutation",
  );
  await db.query("select fidensa_api.issue_fixture_verifier($1,$2,$3)", [
    exerciseId,
    digest("fixture-verifier"),
    "2041-01-01T00:00:00Z",
  ]);
  await configureTestAuthority(
    db,
    new Date(stagedClock).toISOString(),
    "Staged-production",
  );
  await db.query(
    "select fidensa_api.transition_exercise_control($1,1,'intake_open',null,null,null,$2)",
    [exerciseId, "2041-01-01T00:00:00Z"],
  );

  const stagedApplication = await submit(db, {
    label: "exercise",
    email: "exercise@synthetic.invalid",
    now: "2041-01-01T00:01:00Z",
    environment: "Staged-production",
  });
  invariant(
    stagedApplication,
    "exact allowlisted staged submission must commit",
  );
  invariant(
    !(await submit(db, {
      label: "exercise-second",
      email: "exercise@synthetic.invalid",
      now: "2041-01-01T00:02:00Z",
      environment: "Staged-production",
    })),
    "consumed exercise gate must deny a second submission",
  );
  invariant(
    await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.authorize_fixture_operation($1,$2)", [
        correlation,
        digest("fixture-verifier"),
      ]),
    ),
    "issued verifier must authorize only the bounded exercise",
  );
  await db.query(
    "select fidensa_api.transition_exercise_control($1,3,'review_pending',null,null,null,$2)",
    [exerciseId, "2041-01-01T01:00:00Z"],
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_exercise_control($1,4,'review_verified',null,null,null,$2)",
        [exerciseId, "2041-01-01T01:01:00Z"],
      ),
    "review verification without verdict",
  );
  await db.query(
    "select fidensa_api.transition_exercise_control($1,4,'review_verified','review-run-synthetic','approve',null,$2)",
    [exerciseId, "2041-01-01T01:02:00Z"],
  );
  const acceptance = await db.query(
    "select id,version from fidensa_private.acceptance_records where correlation_id=$1",
    [correlation],
  );
  await db.query(
    "select fidensa_api.transition_acceptance_record($1,$2,'accepted','review-run-synthetic','approve',$3)",
    [acceptance.rows[0].id, acceptance.rows[0].version, "2041-01-01T01:03:00Z"],
  );
  await db.query(
    "select fidensa_api.transition_exercise_control($1,5,'cleanup_pending',null,null,null,$2)",
    [exerciseId, "2041-01-01T01:04:00Z"],
  );
  await db.query("select fidensa_api.cleanup_exercise($1,$2)", [
    exerciseId,
    "2041-01-01T01:05:00Z",
  ]);
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.exercise_controls",
      ),
    ) === 0,
    "successful cleanup must remove the working exercise control",
  );
  invariant(
    (await scalar(
      db,
      "select state::text from fidensa_private.acceptance_records where correlation_id=$1",
      [correlation],
    )) === "cleanup_verified",
    "cleanup must preserve the acceptance record",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.application_operation_guards where operation_digest=$1",
        [digest("exercise:operation")],
      ),
    ) === 0,
    "exercise cleanup must remove the tagged application operation guard",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.application_terminal_guards
         where application_id=$1 and terminal_state='deleted'
           and reason='controlled_exercise_cleanup'`,
        [stagedApplication],
      ),
    ) === 1,
    "exercise cleanup must leave immutable terminal anti-resurrection evidence",
  );
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(db, "select fidensa_api.authorize_fixture_operation($1,$2)", [
        correlation,
        digest("fixture-verifier"),
      ]),
    )),
    "removed authoritative verifier must deny the old credential",
  );
  console.log("PASS correlation-bound exercise gate and cleanup authority");
}

async function testStudioOwnerBypassDenial(db) {
  const applicationId = await submit(db, {
    label: "studio-owner-guard",
    now: "2039-03-01T00:00:00Z",
  });
  await verify(db, "studio-owner-guard", "2039-03-01T00:01:00Z");
  await db.query(
    "select fidensa_api.transition_reviewer_status($1,1,'accepted','Synthetic owner-guard fixture','scott_bishop',$2)",
    [applicationId, "2099-01-01T00:00:00Z"],
  );
  const communicationId = await scalar(
    db,
    "select id from fidensa_private.communications where application_id=$1 order by occurred_at limit 1",
    [applicationId],
  );
  const suppressionId = await createTestFixture(db, "suppression_guard", {
    anchor: "2039-03-01T00:00:00Z",
  });
  const jobRunId = await createTestFixture(db, "job_guard", {
    anchor: "2039-03-01T00:00:00Z",
  });
  const incidentId = await createTestFixture(db, "incident_guard", {
    anchor: "2039-03-01T00:00:00Z",
    parentId: jobRunId,
  });
  const terminalGuardApplicationId = "00000000-0000-4000-8000-000000000198";
  await createTestFixture(db, "terminal_guard", {
    anchor: "2039-03-01T00:00:00Z",
    parentId: terminalGuardApplicationId,
    fixtureDigest: digest("studio-terminal-guard"),
  });
  await db.query(
    `insert into fidensa_private.terminal_guard_reviews
       (application_id,review_due_at,detected_at,owner)
     values ($1,'2039-03-01T00:00:00Z','2039-03-01T00:00:00Z','scott_bishop')`,
    [terminalGuardApplicationId],
  );
  await createTestFixture(db, "rubric_calibration_count");

  const unacceptedTransferId = await submit(db, {
    label: "owner-unaccepted-transfer",
    now: "2039-03-01T13:58:00Z",
  });
  await verify(db, "owner-unaccepted-transfer", "2039-03-01T13:59:00Z");
  const pendingVerificationId = await submit(db, {
    label: "owner-skipped-verification",
    now: "2039-03-01T13:59:30Z",
  });
  await configureTestAuthority(db, "2039-03-01T14:00:30Z");

  await testScheduleAndTruncateOwnerDenial(db, "Test");

  const fixedRetentionProbeId = await createTestFixture(db, "abuse_event", {
    anchor: "2039-03-01T14:00:30Z",
    fixtureDigest: digest("fixed-retention-update-rejection"),
  });
  await expectStudioOwnerRejectedMatching(
    db,
    [
      `update fidensa_private.abuse_events
          set result_class='forged' where id='${fixedRetentionProbeId}'`,
    ],
    "fixed-retention rows are immutable outside provider state normalization",
    "fixed-retention update rejection",
  );

  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       values ('00000000-0000-4000-8000-000000000421','database_retention','v1',
               '2039-03-01T03:00:00Z','2039-03-01T03:25:00Z',
               '2039-03-01T14:00:30Z','2039-03-01T14:00:30Z','succeeded',
               '2039-05-30T14:00:30Z')`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome,delay_observed,incident)
       values ('00000000-0000-4000-8000-000000000421',1,
               '2039-03-01T14:00:30Z','2039-03-01T14:00:30Z','succeeded',true,false)`,
    ],
    "late succeeded run hiding a missed Test bucket",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.applications
          set lifecycle='transferred',terminal_at='2039-03-01T14:00:30Z',
              transfer_policy_identity='not-a-policy',
              transfer_recorded_at='2000-01-01T00:00:00Z',
              version=version+1,updated_at='2039-03-01T14:00:30Z'
        where id='${unacceptedTransferId}'`,
      "select fidensa_private.configure_test_authority('Test','2040-04-01T00:00:30Z')",
      "select fidensa_private.perform_retention('2040-04-01T00:00:00Z')",
      `do $assert$
       begin
         if not exists (
           select 1 from fidensa_private.applications
            where id='${unacceptedTransferId}' and lifecycle='transferred'
         ) then
           raise exception 'forged transfer did not survive retention';
         end if;
       end
       $assert$`,
    ],
    "unaccepted transfer with invalid policy and no terminal guard surviving retention",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.applications
          set lifecycle='active',verified_at='2039-03-01T14:00:30Z',
              retention_deadline=submitted_at+interval '12 months',
              version=version+1,updated_at='2039-03-01T14:00:30Z'
        where id='${pendingVerificationId}'`,
    ],
    "pending application activated without credential consumption or queue history",
  );

  for (const [statements, label] of [
    [
      [
        `insert into fidensa_private.abuse_events
           (event_class,ip_digest,rate_class,result_class,occurred_at,deletion_deadline)
         values ('submission','${digest("future-abuse-insert")}','boundary','allowed',
                 '2199-01-01T00:00:00Z','2199-01-03T00:00:00Z')`,
      ],
      "future abuse-event retention anchor",
    ],
    [
      [
        `update fidensa_private.abuse_events
            set occurred_at='2199-01-01T00:00:00Z',
                deletion_deadline='2199-01-03T00:00:00Z'
          where id=(select id from fidensa_private.abuse_events order by created_at limit 1)`,
      ],
      "abuse-event retention-anchor rewrite",
    ],
    [
      [
        `insert into fidensa_private.abuse_investigations
           (purpose,selected_at,owner,event_ids,deletion_deadline)
         values ('future owner probe','2199-01-01T00:00:00Z','scott_bishop',
                 array[gen_random_uuid()],'2199-01-31T00:00:00Z')`,
      ],
      "future abuse-investigation retention anchor",
    ],
    [
      [
        `insert into fidensa_private.operational_logs
           (environment,event_class,operation_id,result_class,occurred_at,deletion_deadline)
         values ('Test','owner_probe',gen_random_uuid(),'synthetic',
                 '2199-01-01T00:00:00Z','2199-01-31T00:00:00Z')`,
      ],
      "future operational-log retention anchor",
    ],
    [
      [
        `insert into fidensa_private.provider_events
           (provider_event_digest,event_type,occurred_at,first_authenticated_received_at,
            linked_domain,normalized_outcome,state,deletion_deadline)
         values ('${digest("future-provider-event")}','contact.updated',
                 '2199-01-01T00:00:00Z','2199-01-01T00:00:00Z',
                 'subscription','synthetic','needs_reconciliation',
                 '2199-04-01T00:00:00Z')`,
      ],
      "future provider-event retention anchor",
    ],
    [
      [
        `insert into fidensa_private.rubric_versions
           (version_label,cohort_label,prohibited_factors,active,material_change,created_by)
         values ('owner-first-score-probe','owner-first-score-probe',
                 array['protected characteristics','company prestige','marketing consent'],
                 false,false,'scott_bishop')`,
        `update fidensa_private.rubric_versions
            set first_scored_at='2199-01-01T00:00:00Z'
          where version_label='owner-first-score-probe'`,
      ],
      "first-score anchor without a scoring act",
    ],
  ]) {
    await expectStudioOwnerRejected(db, statements, label);
  }
  for (const [statements, label] of [
    [
      [
        `insert into fidensa_private.abuse_events
           (id,event_class,ip_digest,rate_class,result_class,occurred_at,deletion_deadline)
         values ('00000000-0000-4000-8000-000000000431','submission',
                 '${digest("premature-delete-abuse")}','boundary','allowed',
                 '2039-03-01T14:00:30Z','2039-03-03T14:00:30Z')`,
        "delete from fidensa_private.abuse_events where id='00000000-0000-4000-8000-000000000431'",
      ],
      "premature abuse-event deletion",
    ],
    [
      [
        `insert into fidensa_private.abuse_investigations
           (id,purpose,selected_at,owner,event_ids,deletion_deadline)
         values ('00000000-0000-4000-8000-000000000432','owner delete probe',
                 '2039-03-01T14:00:30Z','scott_bishop',array[gen_random_uuid()],
                 '2039-03-31T14:00:30Z')`,
        "delete from fidensa_private.abuse_investigations where id='00000000-0000-4000-8000-000000000432'",
      ],
      "premature abuse-investigation deletion",
    ],
    [
      [
        `insert into fidensa_private.operational_logs
           (id,environment,event_class,operation_id,result_class,occurred_at,deletion_deadline)
         values ('00000000-0000-4000-8000-000000000433','Test','delete_probe',
                 gen_random_uuid(),'synthetic','2039-03-01T14:00:30Z',
                 '2039-03-31T14:00:30Z')`,
        "delete from fidensa_private.operational_logs where id='00000000-0000-4000-8000-000000000433'",
      ],
      "premature operational-log deletion",
    ],
    [
      [
        `insert into fidensa_private.provider_events
           (id,provider_event_digest,event_type,occurred_at,first_authenticated_received_at,
            linked_domain,normalized_outcome,state,deletion_deadline)
         values ('00000000-0000-4000-8000-000000000434',
                 '${digest("premature-delete-provider")}','contact.updated',
                 '2039-03-01T14:00:30Z','2039-03-01T14:00:30Z',
                 'subscription','synthetic','needs_reconciliation',
                 '2039-05-30T14:00:30Z')`,
        "delete from fidensa_private.provider_events where id='00000000-0000-4000-8000-000000000434'",
      ],
      "premature provider-event deletion",
    ],
  ]) {
    await expectStudioOwnerRejected(db, statements, label);
  }

  await expectStudioOwnerRejected(
    db,
    ["set session_replication_role = replica"],
    "non-superuser session_replication_role bypass",
  );

  await expectStudioOwnerRejected(
    db,
    [
      `select set_config('fidensa.queue_write','${applicationId}',true)`,
      `update fidensa_private.reviewer_status set state='new',version=3 where application_id='${applicationId}'`,
    ],
    "forged queue transition with a direct owner marker",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `do $attack$
       begin
         perform set_config('fidensa.queue_write','${applicationId}',true);
         update /* function fidensa_api.transition_reviewer_status( */
                fidensa_private.reviewer_status
            set state='declined', version=6
          where application_id='${applicationId}';
       end
       $attack$`,
    ],
    "DO-block comment-forged governed frame",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `do $attack$
       begin
         update /* forged frame follows a newline:
                   function fidensa_api.activate_rubric_version( */
                fidensa_private.rubric_versions
            set active=not active
          where version_label='rubric-v2';
       end
       $attack$`,
    ],
    "newline-forged governed frame",
  );
  for (const [statement, label] of [
    [
      "update fidensa_private.rubric_versions set active=not active where version_label='rubric-v2'",
      "rubric activation",
    ],
    [
      "update fidensa_private.rubric_versions set scored_since_calibration=0 where version_label='rubric-v2'",
      "calibration counter reset",
    ],
    [
      `delete from fidensa_private.suppressions where id='${suppressionId}'`,
      "effective suppression deletion",
    ],
    [
      `delete from fidensa_private.retention_incidents where id='${incidentId}'`,
      "incident deletion",
    ],
    [
      `update fidensa_private.retention_incidents
          set resolved_at=clock_timestamp(),
              resolution_evidence_digest='${"0".repeat(64)}',
              resolution_note='forged'
        where id='${incidentId}'`,
      "incident resolution without recovery row",
    ],
    [
      `delete from fidensa_private.job_runs where id='${jobRunId}'`,
      "job-run deletion",
    ],
    [
      `update fidensa_private.job_runs set outcome='succeeded' where id='${jobRunId}'`,
      "job-run rewrite without attempt",
    ],
    [
      "update fidensa_private.runtime_authority set intake_closed_at=clock_timestamp(),intake_close_reason='forged',updated_at=clock_timestamp() where singleton",
      "intake authority rewrite",
    ],
    [
      `update fidensa_private.communications set note='forged' where id='${communicationId}'`,
      "communication rewrite",
    ],
  ]) {
    await expectStudioOwnerRejected(db, [statement], label);
  }

  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (job_type,version,scheduled_bucket,selection_cutoff,first_started_at,outcome)
       values ('database_retention','v1','2199-01-01T00:00:00Z',
               '2199-01-01T00:25:00Z','2199-01-01T00:00:00Z','started')`,
      `delete from fidensa_private.applications where id='${applicationId}'`,
    ],
    "forged future retention run and premature accepted-application deletion",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (job_type,version,scheduled_bucket,selection_cutoff,first_started_at,outcome)
       values ('database_retention','v1','2039-02-28T23:45:00Z',
               '2039-03-01T00:10:00Z','2039-03-01T00:00:00Z','started')`,
    ],
    "fabricated started retention run without an attempt",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       values ('00000000-0000-4000-8000-000000000401','database_retention','v1',
               '2039-02-28T23:45:00Z','2039-03-01T00:10:00Z',
               '2039-02-28T23:46:00Z','2039-02-28T23:47:00Z','succeeded',
               '2039-05-29T23:47:00Z')`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome)
       values ('00000000-0000-4000-8000-000000000401',1,
               '2039-02-28T23:46:00Z','2039-02-28T23:47:00Z','succeeded')`,
    ],
    "backdated succeeded run hiding a missed Test bucket",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       values ('00000000-0000-4000-8000-000000000402','database_retention','v1',
               '2039-02-28T23:30:00Z','2039-02-28T23:55:00Z',
               '2039-03-01T00:01:00Z','2000-01-01T00:00:00Z','failed',
               '2000-03-31T00:00:00Z')`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome,incident)
       values ('00000000-0000-4000-8000-000000000402',1,
               '2039-03-01T00:01:00Z','2000-01-01T00:00:00Z','failed',true)`,
      `insert into fidensa_private.retention_incidents
         (job_run_id,incident_class,detected_at,intake_close_due_at,resolution_owner)
       values ('00000000-0000-4000-8000-000000000402','overdue_row',
               '2039-03-01T00:01:00Z','2039-03-02T00:01:00Z','scott_bishop')`,
      "delete from fidensa_private.job_runs where id='00000000-0000-4000-8000-000000000402'",
    ],
    "forged expired Test run cascading an unresolved incident",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.rubric_calibrations
         (rubric_version_id,actor,findings,scored_application_count,recorded_at)
       select id,'scott_bishop','forged future calibration',
              scored_since_calibration,'2199-01-01T00:00:00Z'
         from fidensa_private.rubric_versions where version_label='rubric-v2'`,
      "update fidensa_private.rubric_versions set scored_since_calibration=0,calibration_anchor_at='2199-01-01T00:00:00Z' where version_label='rubric-v2'",
    ],
    "future calibration evidence and anchor",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.applications
          set last_direct_interaction_at='2199-03-01T00:00:00Z',
              retention_deadline='2200-03-01T00:00:00Z',version=version+1,
              updated_at='2199-03-01T00:00:00Z'
        where id='${applicationId}'`,
    ],
    "future direct interaction and retention extension",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.applications
         (canonical_email,delivery_email,operation_digest,synthetic,lifecycle,
          applicant_name,role_function,context,organization,intended_use_case,
          workflow_stage,deployment_preference,evaluation_timeline,
          design_partner_willingness,submitted_at,retention_deadline)
       values ('future-insert@synthetic.invalid','future-insert@synthetic.invalid',
               '${digest("future-application-insert")}',true,'pending_verification',
               'Synthetic Applicant','Synthetic Role','Work','Synthetic Organization',
               '[synthetic fixture]','[synthetic fixture]','Not sure yet',
               'No fixed timeline','Maybe','2199-01-01T00:00:00Z',
               '2199-01-08T00:00:00Z')`,
    ],
    "future application submission and retention anchor",
  );
  await expectStudioOwnerRejected(
    db,
    [
      "update fidensa_private.runtime_authority set environment='Production',test_clock_at=null,test_clock_enabled=false,updated_at=clock_timestamp() where singleton",
    ],
    "test runtime switched directly to Production",
  );
  await expectStudioOwnerRejected(
    db,
    [
      "update fidensa_private.runtime_authority set environment='Production',test_clock_at=null,test_clock_enabled=false,updated_at=clock_timestamp() where singleton",
      "select fidensa_private.configure_test_authority('Test','2000-01-01T00:00:00Z')",
    ],
    "test authority configured from a non-Test state",
  );
  await expectStudioOwnerRejected(
    db,
    [
      "update fidensa_private.runtime_authority set retention_monitoring_started_at='2199-01-01T00:00:00Z',updated_at=clock_timestamp() where singleton",
    ],
    "retention monitoring start moved forward",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.retention_recoveries
         (actor,action,incident_id,evidence_digest,physical_absence_proved,
          provider_reconciled,no_resurrection_proved,occurred_at)
       values ('scott_bishop','incident_resolved','${incidentId}','${"1".repeat(64)}',true,true,true,'2039-03-01T00:00:00Z')`,
      `update fidensa_private.retention_recoveries
          set evidence_digest='${"2".repeat(64)}' where incident_id='${incidentId}'`,
    ],
    "recovery evidence rewrite",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `delete from fidensa_private.application_terminal_guards
        where application_id='${terminalGuardApplicationId}'`,
    ],
    "terminal anti-resurrection guard deletion",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.terminal_guard_reviews
          set state='resolved',resolved_at='2039-03-01T00:00:00Z',
              evidence_digest='${"3".repeat(64)}'
        where application_id='${terminalGuardApplicationId}'`,
    ],
    "terminal-guard review rewrite",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.retention_incidents
          set intake_close_due_at='2199-01-01T00:00:00Z'
        where id='${incidentId}'`,
    ],
    "retention incident deadline deferral",
  );
  await expectStudioOwnerRejected(
    db,
    [
      "update fidensa_private.rubric_versions set calibration_anchor_at='2199-01-01T00:00:00Z' where version_label='rubric-v2'",
    ],
    "calibration anchor advance without a paired calibration",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `update fidensa_private.retention_incidents
          set intake_close_due_at='2039-03-01T00:00:00Z'
        where id='${incidentId}'`,
      "update fidensa_private.runtime_authority set intake_closed_at='2039-03-01T00:00:00Z',intake_close_reason='unresolved_retention_overdue_24_hours',updated_at='2039-03-01T00:00:00Z' where singleton",
      `insert into fidensa_private.retention_recoveries
         (actor,action,incident_id,evidence_digest,physical_absence_proved,
          provider_reconciled,no_resurrection_proved,occurred_at)
       values ('scott_bishop','incident_resolved','${incidentId}','${"4".repeat(64)}',true,true,true,'2039-03-01T00:00:00Z')`,
      `update fidensa_private.retention_incidents
          set resolved_at='2039-03-01T00:00:00Z',
              resolution_evidence_digest='${"4".repeat(64)}',resolution_note='forged recovery'
        where id='${incidentId}'`,
      `insert into fidensa_private.retention_recoveries
         (actor,action,evidence_digest,physical_absence_proved,
          provider_reconciled,no_resurrection_proved,occurred_at)
       values ('scott_bishop','intake_reopened','${"5".repeat(64)}',true,true,true,'2039-03-01T00:00:01Z')`,
      `insert into fidensa_private.abuse_events
         (event_class,ip_digest,rate_class,result_class,occurred_at,deletion_deadline)
       values ('submission','${digest("forged-overdue-ip")}','boundary','allowed',
               '2039-02-27T00:00:00Z','2039-03-01T00:00:00Z')`,
      "update fidensa_private.runtime_authority set intake_closed_at=null,intake_close_reason=null,updated_at='2039-03-01T00:00:01Z' where singleton",
    ],
    "intake reopening with forged recovery evidence and an overdue row",
  );
  await db.query(
    "select fidensa_api.resolve_retention_incident($1,$2,'Synthetic append-only proof',true,true,true,'scott_bishop')",
    [incidentId, digest("append-only-recovery-proof")],
  );
  const recoveryId = await scalar(
    db,
    "select id from fidensa_private.retention_recoveries where incident_id=$1",
    [incidentId],
  );
  await expectStudioOwnerRejected(
    db,
    [
      `delete from fidensa_private.retention_recoveries where id='${recoveryId}'`,
    ],
    "recovery evidence deletion",
  );
  invariant(
    (await scalar(
      db,
      "select state::text='accepted' and version=2 from fidensa_private.reviewer_status where application_id=$1",
      [applicationId],
    )) &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.reviewer_status_history where application_id=$1",
          [applicationId],
        ),
      ) === 2 &&
      (await scalar(
        db,
        `select occurred_at='2039-03-01T00:01:00Z'::timestamptz
         from fidensa_private.reviewer_status_history
         where application_id=$1 and transition_version=2`,
        [applicationId],
      )),
    "Studio-owner probes must leave governed state/history unchanged and caller time must be ignored",
  );
  console.log(
    "PASS non-superuser Studio-owner direct-DML, row-authority, comment/newline/GUC, and replication bypass denial",
  );
}

async function testRetention(db) {
  const bucket = "2040-01-01T00:00:00Z";
  const cutoff = "2040-01-01T00:25:00Z";
  const before = await submit(db, {
    label: "retention-before",
    now: "2039-12-25T00:24:59Z",
  });
  const exact = await submit(db, {
    label: "retention-exact",
    now: "2039-12-25T00:25:00Z",
  });
  const after = await submit(db, {
    label: "retention-after",
    now: "2039-12-25T00:25:01Z",
  });
  invariant(
    before && exact && after,
    "retention boundary fixtures must commit",
  );
  invariant(
    await configureTestAuthority(db, bucket)
      .then(() =>
        withRole(db, "service_role", () =>
          scalar(
            db,
            "select fidensa_api.resend_application_verification($1,$2,$3,$4)",
            [
              "retention-exact@synthetic.invalid",
              digest("retention-exact:resend"),
              digest("retention-exact:resend-ip"),
              digest("retention-exact:email"),
            ],
          ),
        ),
      )
      .then((result) => !result),
    "resend must stop at the advance-selection boundary",
  );

  const boundaryIds = {};
  boundaryIds.abuseExact = await createTestFixture(db, "abuse_event", {
    anchor: cutoff,
    fixtureDigest: digest("boundary-abuse-exact"),
  });
  boundaryIds.abuseAfter = await createTestFixture(db, "abuse_event", {
    anchor: cutoff,
    fixtureDigest: digest("boundary-abuse-after"),
    after: true,
  });
  boundaryIds.investigationExact = await createTestFixture(
    db,
    "abuse_investigation",
    { anchor: cutoff },
  );
  boundaryIds.investigationAfter = await createTestFixture(
    db,
    "abuse_investigation",
    { anchor: cutoff, after: true },
  );
  boundaryIds.logExact = await createTestFixture(db, "operational_log", {
    anchor: cutoff,
  });
  boundaryIds.logAfter = await createTestFixture(db, "operational_log", {
    anchor: cutoff,
    after: true,
  });
  boundaryIds.providerExact = await createTestFixture(db, "provider_event", {
    anchor: cutoff,
    fixtureDigest: digest("boundary-provider-exact"),
  });
  boundaryIds.providerAfter = await createTestFixture(db, "provider_event", {
    anchor: cutoff,
    fixtureDigest: digest("boundary-provider-after"),
    after: true,
  });
  boundaryIds.suppressionExact = await createTestFixture(db, "suppression", {
    anchor: cutoff,
  });
  boundaryIds.suppressionAfter = await createTestFixture(db, "suppression", {
    anchor: cutoff,
    after: true,
  });

  await configureTestAuthority(db, "2039-12-01T00:00:00Z");
  const artifactRequest = await withRole(db, "service_role", () =>
    scalar(
      db,
      "select fidensa_api.create_privacy_request('export',$1,$1,'privacy_public',$2,'Synthetic request')",
      ["artifact@synthetic.invalid", digest("artifact-request")],
    ),
  );
  boundaryIds.proofExact = await createTestFixture(db, "identity_proof", {
    anchor: cutoff,
    parentId: artifactRequest,
    fixtureDigest: digest("proof-exact"),
  });
  boundaryIds.proofAfter = await createTestFixture(db, "identity_proof", {
    anchor: cutoff,
    parentId: artifactRequest,
    fixtureDigest: digest("proof-after"),
    after: true,
  });
  boundaryIds.artifactExact = await createTestFixture(db, "export_artifact", {
    anchor: cutoff,
    parentId: artifactRequest,
    fixtureDigest: digest("artifact-exact"),
  });
  const artifactAfterRequest = await withRole(db, "service_role", () =>
    scalar(
      db,
      "select fidensa_api.create_privacy_request('export',$1,$1,'privacy_public',$2,'Synthetic request')",
      ["artifact-after@synthetic.invalid", digest("artifact-after-request")],
    ),
  );
  boundaryIds.artifactAfter = await createTestFixture(db, "export_artifact", {
    anchor: cutoff,
    parentId: artifactAfterRequest,
    fixtureDigest: digest("artifact-after"),
    after: true,
  });

  async function closedPrivacyCase(label, terminalOffset) {
    await configureTestAuthority(db, "2037-11-01T00:00:00Z");
    const requestId = await withRole(db, "service_role", () =>
      scalar(
        db,
        "select fidensa_api.create_privacy_request('deletion',$1,$1,'privacy_public',$2,'Synthetic request')",
        [`${label}@synthetic.invalid`, digest(`${label}:privacy`)],
      ),
    );
    const terminalExpression = `${terminalOffset} seconds`;
    await configureTestAuthority(
      db,
      new Date(
        Date.parse("2038-01-01T00:25:00Z") + terminalOffset * 1000,
      ).toISOString(),
    );
    await db.query(
      "select fidensa_api.transition_privacy_request($1,1,'verified',array['application'],'verified','scott_bishop',$2::timestamptz-interval '24 months'+$3::interval)",
      [requestId, cutoff, terminalExpression],
    );
    await db.query(
      "select fidensa_api.transition_privacy_request($1,2,'under_review',array['application'],'review','scott_bishop',$2::timestamptz-interval '24 months'+$3::interval)",
      [requestId, cutoff, terminalExpression],
    );
    await db.query(
      "select fidensa_api.transition_privacy_request($1,3,'fulfilled',array['application'],'fulfilled','scott_bishop',$2::timestamptz-interval '24 months'+$3::interval)",
      [requestId, cutoff, terminalExpression],
    );
    return requestId;
  }
  boundaryIds.caseExact = await closedPrivacyCase("case-exact", 0);
  boundaryIds.caseAfter = await closedPrivacyCase("case-after", 1);
  boundaryIds.jobExact = await createTestFixture(db, "job_run", {
    anchor: cutoff,
  });
  boundaryIds.jobAfter = await createTestFixture(db, "job_run", {
    anchor: cutoff,
    after: true,
  });

  await configureTestAuthority(db, "2040-01-01T00:04:00Z");
  const runId = await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_current_retention()"),
  );
  const remaining = await db.query(
    "select id from fidensa_private.applications where id = any($1::uuid[]) order by id",
    [[before, exact, after]],
  );
  invariant(
    remaining.rows.length === 1 && remaining.rows[0].id === after,
    "retention must delete before/at cutoff and preserve immediately-after rows",
  );
  for (const [table, exactKey, afterKey] of [
    ["abuse_events", "abuseExact", "abuseAfter"],
    ["abuse_investigations", "investigationExact", "investigationAfter"],
    ["operational_logs", "logExact", "logAfter"],
    ["provider_events", "providerExact", "providerAfter"],
    ["identity_proofs", "proofExact", "proofAfter"],
    ["privacy_requests", "caseExact", "caseAfter"],
    ["job_runs", "jobExact", "jobAfter"],
  ]) {
    invariant(
      Number(
        await scalar(
          db,
          `select count(*) from fidensa_private.${table} where id=$1`,
          [boundaryIds[exactKey]],
        ),
      ) === 0 &&
        Number(
          await scalar(
            db,
            `select count(*) from fidensa_private.${table} where id=$1`,
            [boundaryIds[afterKey]],
          ),
        ) === 1,
      `${table} must delete exactly-at and preserve immediately-after its fixed boundary`,
    );
  }
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.suppressions where id in ($1,$2) and state='effective'",
        [boundaryIds.suppressionExact, boundaryIds.suppressionAfter],
      ),
    ) === 2 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.suppression_reviews where suppression_id=$1 and state='pending'",
          [boundaryIds.suppressionExact],
        ),
      ) === 1,
    "an effective suppression review date must create owner review without removing suppression",
  );
  invariant(
    (await scalar(
      db,
      "select encrypted_bytes is null and state='expired' from fidensa_private.privacy_export_artifacts where id=$1",
      [boundaryIds.artifactExact],
    )) &&
      (await scalar(
        db,
        "select encrypted_bytes is not null and state='available' from fidensa_private.privacy_export_artifacts where id=$1",
        [boundaryIds.artifactAfter],
      )),
    "export bytes must delete at the fixed 24-hour boundary without extending the artifact",
  );
  const compliantAttempt = await db.query(
    "select delay_observed,incident,outcome::text from fidensa_private.job_run_attempts where job_run_id=$1",
    [runId],
  );
  invariant(
    compliantAttempt.rows[0].delay_observed &&
      !compliantAttempt.rows[0].incident &&
      compliantAttempt.rows[0].outcome === "succeeded",
    "delayed start inside the five-minute budget must be observable and compliant",
  );

  await configureTestAuthority(db, "2040-01-01T00:21:00Z");
  const lateRun = await scalar(
    db,
    "select fidensa_private.perform_retention($1)",
    ["2040-01-01T00:15:00Z"],
  );
  invariant(
    (await scalar(
      db,
      "select outcome::text from fidensa_private.job_runs where id=$1",
      [lateRun],
    )) === "failed",
    "a start after the bucket budget must be an immediate incident",
  );
  await configureTestAuthority(db, "2040-01-01T00:35:01Z");
  const missedRun = await scalar(
    db,
    "select fidensa_private.record_missed_retention_bucket($1,$2)",
    ["2040-01-01T00:30:00Z", "2040-01-01T00:35:01Z"],
  );
  invariant(
    (await scalar(
      db,
      "select outcome::text from fidensa_private.job_runs where id=$1",
      [missedRun],
    )) === "failed",
    "no start by budget end must be an immediate incident",
  );

  const survivor = await submit(db, {
    label: "subscription-survival",
    now: "2039-01-01T00:00:00Z",
    marketing: true,
  });
  invariant(
    await verify(db, "subscription-survival", "2039-01-01T00:01:00Z"),
    "consented fixture verifies",
  );
  await configureTestAuthority(db, "2040-01-01T00:45:30Z");
  await scalar(db, "select fidensa_private.perform_retention($1)", [
    "2040-01-01T00:45:00Z",
  ]);
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.applications where id=$1",
        [survivor],
      ),
    ) === 0 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.subscriptions where canonical_email='subscription-survival@synthetic.invalid' and state='active' and application_id is null",
        ),
      ) === 1,
    "active minimal subscription must survive application retention",
  );
  const renewedApplication = await submit(db, {
    label: "subscription-renewal",
    email: "subscription-survival@synthetic.invalid",
    now: "2040-01-02T00:00:00Z",
    marketing: true,
  });
  invariant(
    renewedApplication,
    "a post-retention application may record a new consent act",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.subscriptions where canonical_email='subscription-survival@synthetic.invalid' and state='active'",
      ),
    ) === 1 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.consent_acts where application_id=$1 and state='pending_confirmation'",
          [renewedApplication],
        ),
      ) === 1,
    "new selected consent must not downgrade or duplicate an existing active subscription",
  );

  const accepted = await submit(db, {
    label: "accepted-transfer",
    now: "2039-01-01T00:00:00Z",
  });
  await verify(db, "accepted-transfer", "2039-01-01T00:01:00Z");
  await db.query(
    "select fidensa_api.transition_reviewer_status($1,1,'accepted','manual decision','scott_bishop',$2)",
    [accepted, "2039-01-01T00:02:00Z"],
  );
  await db.query(
    "select fidensa_api.transfer_accepted_application($1,'accepted-application-transfer-policy-v1:synthetic','scott_bishop',$2)",
    [accepted, "2039-01-01T00:03:00Z"],
  );
  await configureTestAuthority(db, "2041-01-01T00:00:10Z");
  await scalar(db, "select fidensa_private.perform_retention($1)", [
    "2041-01-01T00:00:00Z",
  ]);
  invariant(
    (await scalar(
      db,
      "select lifecycle::text from fidensa_private.applications where id=$1",
      [accepted],
    )) === "transferred",
    "accepted policy transfer must survive application retention",
  );

  const backupCaveat = await scalar(
    db,
    "select backup_caveat from fidensa_private.job_schedules where job_type='database_retention'",
  );
  invariant(
    backupCaveat.includes("backup cycle") &&
      backupCaveat.includes("quarantined"),
    "schedule registry must preserve the backup-cycle and quarantine caveat",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.application_terminal_guards
         where application_id in ($1,$2) and digest_key_id='server-hmac-v1'
           and retention_purpose<>'' and retention_owner='database_owner'
           and review_or_disposal_at>retention_anchor_at`,
        [before, exact],
      ),
    ) === 2 &&
      Number(
        await scalar(
          db,
          `select count(*) from information_schema.columns
           where table_schema='fidensa_private' and table_name='application_terminal_guards'
             and column_name='canonical_email_digest'`,
        ),
      ) === 0,
    "terminal residue must use keyed email digests with explicit purpose, owner, anchor, and review date",
  );

  await configureTestAuthority(db, "2041-01-02T13:59:00Z");
  await createTestFixture(db, "abuse_event", {
    anchor: "2041-01-02T13:59:00Z",
    fixtureDigest: digest("same-window-overdue-abuse"),
  });
  await configureTestAuthority(db, "2041-01-02T14:00:00Z");
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       values ('00000000-0000-4000-8000-000000000435','database_retention','v1',
               '2041-01-02T13:45:00Z','2041-01-02T14:10:00Z',
               '2041-01-02T14:00:00Z','2041-01-02T14:00:00Z','succeeded',
               '2041-04-02T14:00:00Z')`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome,delay_observed,incident)
       values ('00000000-0000-4000-8000-000000000435',1,
               '2041-01-02T14:00:00Z','2041-01-02T14:00:00Z','succeeded',true,false)`,
    ],
    "late successful terminal record before the daily health entry point",
  );
  const firstHealth = await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  invariant(
    Number(
      await scalar(
        db,
        "select missed_bucket_count from fidensa_private.retention_health_reviews where id=$1",
        [firstHealth],
      ),
    ) > 0,
    "14:00 UTC health review must persist not-started bucket detection",
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.retention_incidents incident
         join fidensa_private.job_runs run on run.id=incident.job_run_id
         where run.job_type='database_retention'
           and run.scheduled_bucket='2041-01-02T13:45:00Z'
           and incident.incident_class='not_started'
           and incident.intake_close_due_at='2041-01-03T13:50:00Z'`,
      ),
    ) === 1,
    "a rejected late terminal record must remain visible as a missed bucket with bucket-bound containment",
  );
  const latestRunIncident = await db.query(
    `select incident.id,incident.intake_close_due_at,run.id=latest.id as on_latest_run
       from fidensa_private.retention_incidents incident
       join fidensa_private.job_runs run on run.id=incident.job_run_id
       cross join lateral (
         select id from fidensa_private.job_runs
          where job_type='database_retention'
          order by scheduled_bucket desc limit 1
       ) latest
      where incident.incident_class='overdue_row' and incident.resolved_at is null
      order by incident.detected_at desc limit 1`,
  );
  invariant(
    latestRunIncident.rows.length === 1 &&
      latestRunIncident.rows[0].on_latest_run,
    "the same-window retry fixture must place an overdue incident on the latest run",
  );
  await configureTestAuthority(db, "2041-01-02T14:03:00Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  invariant(
    (await scalar(
      db,
      "select intake_close_due_at=$2 from fidensa_private.retention_incidents where id=$1",
      [
        latestRunIncident.rows[0].id,
        latestRunIncident.rows[0].intake_close_due_at,
      ],
    )) &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.retention_health_reviews where scheduled_bucket='2041-01-02T14:00:00Z'",
        ),
      ) === 1,
    "a same-window health rerun must succeed without changing the frozen incident deadline",
  );
  await configureTestAuthority(db, "2041-01-03T14:06:00Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  invariant(
    await scalar(
      db,
      "select intake_closed_at is not null from fidensa_private.runtime_authority where singleton",
    ),
    "unresolved overdue retention must close intake after 24 hours",
  );
  invariant(
    !(await submit(db, {
      label: "retention-contained",
      now: "2041-01-03T14:07:00Z",
    })),
    "retention containment must deny new application intake",
  );

  const dueOperationDigest = digest("due-duplicate-operation-guard");
  const dueTerminalApplication = "00000000-0000-4000-8000-000000000299";
  await createTestFixture(db, "operation_guard", {
    anchor: "2041-01-03T14:10:00Z",
    fixtureDigest: dueOperationDigest,
  });
  await createTestFixture(db, "terminal_guard", {
    anchor: "2041-01-03T14:10:00Z",
    parentId: dueTerminalApplication,
    fixtureDigest: digest("due-terminal-email"),
  });
  await configureTestAuthority(db, "2041-01-03T14:10:00Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_current_retention()"),
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.application_operation_guards where operation_digest=$1",
        [dueOperationDigest],
      ),
    ) === 0 &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.terminal_guard_reviews where application_id=$1 and state='pending'",
          [dueTerminalApplication],
        ),
      ) === 1,
    "due duplicate guards must dispose and due terminal guards must create an owner review",
  );

  await configureTestAuthority(db, "2041-01-04T14:00:30Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  await configureTestAuthority(db, "2041-01-05T14:20:00Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.job_runs
         where job_type='database_retention' and scheduled_bucket='2041-01-04T14:00:00Z'
           and outcome='failed'`,
      ),
    ) === 1,
    "a late next-day health review must resume after the persisted scan end without skipping 14:00",
  );
  await configureTestAuthority(db, "2041-01-07T14:06:00Z");
  await withRole(db, "fidensa_job", () =>
    scalar(db, "select fidensa_api.run_retention_health()"),
  );
  invariant(
    Number(
      await scalar(
        db,
        `select count(*) from fidensa_private.retention_incidents incident
         join fidensa_private.job_runs run on run.id=incident.job_run_id
         where incident.incident_class='health_not_started'
           and run.scheduled_bucket='2041-01-06T14:00:00Z'`,
      ),
    ) === 1,
    "a missed daily health run must be persisted as an incident",
  );

  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.reopen_application_intake($1,false,true,true,'scott_bishop')",
        [digest("incomplete-recovery")],
      ),
    "intake reopen without full proof",
  );
  const incidents = await db.query(
    "select id from fidensa_private.retention_incidents where resolved_at is null order by id",
  );
  for (const incident of incidents.rows) {
    await db.query(
      "select fidensa_api.resolve_retention_incident($1,$2,'Synthetic absence and reconciliation proof',true,true,true,'scott_bishop')",
      [incident.id, digest(`incident-recovery:${incident.id}`)],
    );
  }
  await db.query(
    "select fidensa_api.reopen_application_intake($1,true,true,true,'scott_bishop')",
    [digest("complete-recovery")],
  );
  invariant(
    !(await scalar(
      db,
      "select intake_closed_at is not null from fidensa_private.runtime_authority where singleton",
    )) &&
      Number(
        await scalar(
          db,
          "select count(*) from fidensa_private.retention_recoveries where action='intake_reopened'",
        ),
      ) === 1,
    "Scott recovery must preserve proof history and reopen intake only after all incidents resolve",
  );
  console.log(
    "PASS retention boundaries, resumable health, guard disposition, containment, and governed recovery",
  );
}

async function testProviderAndPrivacyDomains(db) {
  await configureTestAuthority(db, "2042-01-01T00:00:01Z");
  const eventDigest = digest("provider-event");
  invariant(
    await withRole(db, "service_role", () =>
      scalar(
        db,
        "select fidensa_api.record_provider_event($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          eventDigest,
          "email.complained",
          "2042-01-01T00:00:00Z",
          "suppression",
          null,
          "complaint",
          "provider@synthetic.invalid",
          null,
        ],
      ),
    ),
    "authenticated restrictive provider event must apply",
  );
  invariant(
    !(await withRole(db, "service_role", () =>
      scalar(
        db,
        "select fidensa_api.record_provider_event($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          eventDigest,
          "email.complained",
          "2042-01-01T00:00:00Z",
          "suppression",
          null,
          "complaint",
          "provider@synthetic.invalid",
          null,
        ],
      ),
    )),
    "provider event replay must be idempotent",
  );
  invariant(
    Number(
      await scalar(
        db,
        "select count(*) from fidensa_private.suppressions where canonical_email='provider@synthetic.invalid' and state='effective'",
      ),
    ) === 1,
    "restrictive provider event must create minimum suppression state",
  );
  await expectRejected(
    () =>
      withRole(db, "service_role", () =>
        db.query(
          "select fidensa_api.record_provider_event($1,'contact.updated',$2,'subscription',null,'synthetic',null,null)",
          [digest("future-provider-event"), "2042-01-01T00:00:02Z"],
        ),
      ),
    "future provider occurrence",
  );

  const privacyId = await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.create_privacy_request($1,$2,$3,$4,$5,$6)", [
      "deletion",
      "privacy@synthetic.invalid",
      "privacy@synthetic.invalid",
      "privacy_public",
      digest("privacy-operation"),
      "Synthetic request",
    ]),
  );
  invariant(privacyId, "privacy intake must create a minimal case");
  for (const target of ["denied", "withdrawn"]) {
    const requestId = await withRole(db, "service_role", () =>
      scalar(
        db,
        "select fidensa_api.create_privacy_request('deletion',$1,$1,'privacy_public',$2,'Synthetic request')",
        [
          `${target}@synthetic.invalid`,
          digest(`unverified-${target}-operation`),
        ],
      ),
    );
    await db.query(
      `select fidensa_api.transition_privacy_request($1,1,'${target}',null,'Synthetic unverified closure','scott_bishop',$2)`,
      [requestId, "1900-01-01T00:00:00Z"],
    );
    invariant(
      await scalar(
        db,
        "select verified_scope is null and state::text=$2 from fidensa_private.privacy_requests where id=$1",
        [requestId, target],
      ),
      `unverified privacy case must close as ${target} without fabricated scope`,
    );
  }
  const expiringRequest = await withRole(db, "service_role", () =>
    scalar(
      db,
      "select fidensa_api.create_privacy_request('deletion',$1,$1,'privacy_public',$2,'Synthetic request')",
      ["expired@synthetic.invalid", digest("unverified-expired-operation")],
    ),
  );
  await createTestFixture(db, "privacy_confirmation", {
    anchor: "2042-01-01T00:00:01Z",
    parentId: expiringRequest,
  });
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_privacy_request($1,1,'expired',null,'Synthetic expiry','scott_bishop','2099-01-01T00:00:00Z')",
        [expiringRequest],
      ),
    "caller-supplied future time bypass of privacy expiry",
  );
  await configureTestAuthority(db, "2042-02-01T00:00:02Z");
  await db.query(
    "select fidensa_api.transition_privacy_request($1,1,'expired',null,'Synthetic expiry','scott_bishop','1900-01-01T00:00:00Z')",
    [expiringRequest],
  );
  invariant(
    await scalar(
      db,
      "select verified_scope is null and state='expired' from fidensa_private.privacy_requests where id=$1",
      [expiringRequest],
    ),
    "unverified privacy case must expire without fabricated scope using authoritative time",
  );
  await configureTestAuthority(db, "2042-01-01T00:00:01Z");
  await expectRejected(
    () =>
      db.query(
        "update fidensa_private.privacy_requests set state='fulfilled' where id=$1",
        [privacyId],
      ),
    "direct privacy transition",
  );
  await expectRejectedTransaction(
    db,
    async () => {
      await db.query("select set_config('fidensa.privacy_write',$1,true)", [
        privacyId,
      ]);
      await db.query(
        `insert into fidensa_private.privacy_request_history
         (privacy_request_id,prior_state,new_state,event_class,actor,reason,occurred_at,transition_version)
         values ($1,'awaiting_confirmation','verified','transition','scott_bishop','forged',clock_timestamp(),2)`,
        [privacyId],
      );
    },
    "forged privacy-history insert",
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_privacy_request($1,1,'expired',null,'too early','scott_bishop',$2)",
        [privacyId, "2099-01-02T00:00:00Z"],
      ),
    "privacy expiry without a sent confirmation",
  );
  await db.query(
    "select fidensa_api.transition_privacy_request($1,1,'verified',array['application'],'verified','scott_bishop',$2)",
    [privacyId, "2042-01-01T00:01:00Z"],
  );
  await expectRejected(
    () =>
      db.query(
        "select fidensa_api.transition_privacy_request($1,2,'under_review',array['application','subscription'],'scope expansion','scott_bishop',$2)",
        [privacyId, "2042-01-01T00:02:00Z"],
      ),
    "privacy scope change after verification",
  );
  await db.query(
    "select fidensa_api.transition_privacy_request($1,2,'under_review',array['application'],'same verified scope','scott_bishop',$2)",
    [privacyId, "2042-01-01T00:02:00Z"],
  );
  console.log(
    "PASS provider replay, suppression, and privacy transition denial",
  );
}

async function testRecoveryAndRebuild(db, initialTableCount) {
  await db.exec("set role fidensa_studio_owner");
  try {
    await db.exec(await readFile(recoveryMigration, "utf8"));
    invariant(
      Number(
        await scalar(
          db,
          "select count(*) from pg_namespace where nspname in ('fidensa_private','fidensa_api')",
        ),
      ) === 0,
      "recovery must remove both schemas",
    );
    invariant(
      Number(
        await scalar(
          db,
          "select count(*) from pg_roles where rolname in ('fidensa_server','fidensa_job','fidensa_mutator')",
        ),
      ) === 0,
      "recovery must remove task-owned roles",
    );
    await applyForward(db);
  } catch (error) {
    await db.exec("rollback");
    throw error;
  } finally {
    await db.exec("reset role");
  }
  invariant(
    (await scalar(
      db,
      "select environment from fidensa_private.runtime_authority where singleton",
    )) === "Staged-production",
    "an ordinary forward rebuild must preserve the staged non-Test default",
  );
  await testScheduleAndTruncateOwnerDenial(db, "Staged-production");
  await expectStudioOwnerRejected(
    db,
    [
      "select fidensa_private.configure_test_authority('Test','2000-01-01T00:00:00Z')",
    ],
    "fresh staged rebuild cannot enable Test clock authority",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       select '00000000-0000-4000-8000-000000000411','database_retention','v1',
              bucket,bucket+interval '25 minutes',bucket+interval '1 minute',
              bucket+interval '2 minutes','succeeded',
              bucket+interval '90 days 2 minutes'
         from (select date_trunc('hour',fidensa_private.authoritative_now())-
                      interval '1 hour' as bucket) clock`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome)
       select '00000000-0000-4000-8000-000000000411',1,
              scheduled_bucket+interval '1 minute',scheduled_bucket+interval '2 minutes',
              'succeeded'
         from fidensa_private.job_runs
        where id='00000000-0000-4000-8000-000000000411'`,
    ],
    "backdated succeeded run hiding a missed Staged-production bucket",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       select '00000000-0000-4000-8000-000000000422','database_retention','v1',
              bucket,bucket+interval '25 minutes',operation_time,operation_time,
              'succeeded',operation_time+interval '90 days'
         from (select date_trunc('hour',fidensa_private.authoritative_now())-
                      interval '3 hours' as bucket,
                      fidensa_private.authoritative_now() as operation_time) clock`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome,delay_observed,incident)
       select '00000000-0000-4000-8000-000000000422',1,first_started_at,
              first_terminal_at,'succeeded',true,false
         from fidensa_private.job_runs
        where id='00000000-0000-4000-8000-000000000422'`,
    ],
    "late succeeded run hiding a missed Staged-production bucket",
  );

  await db.exec("begin");
  try {
    await db.exec("set local role fidensa_studio_owner");
    await db.exec(`
      with clock as (
        select fidensa_private.authoritative_now() as operation_time,
               date_trunc('hour',fidensa_private.authoritative_now())-
                 interval '25 hours' as bucket
      )
      insert into fidensa_private.job_runs
        (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
         first_terminal_at,outcome,expires_at)
      select '00000000-0000-4000-8000-000000000423','database_retention','v1',
             bucket,bucket+interval '25 minutes',operation_time,operation_time,
             'failed',operation_time+interval '90 days'
        from clock;
      insert into fidensa_private.job_run_attempts
        (job_run_id,attempt,started_at,completed_at,outcome,delay_observed,incident)
      select id,1,first_started_at,first_terminal_at,'failed',true,true
        from fidensa_private.job_runs
       where id='00000000-0000-4000-8000-000000000423';
      insert into fidensa_private.retention_incidents
        (job_run_id,incident_class,detected_at,resolution_owner)
      values ('00000000-0000-4000-8000-000000000423','late_start',
              fidensa_private.authoritative_now(),'scott_bishop');
      set constraints all immediate;
    `);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  invariant(
    await scalar(
      db,
      `select intake_close_due_at=
                scheduled_bucket+interval '24 hours 5 minutes'
       from fidensa_private.retention_incidents incident
       join fidensa_private.job_runs run on run.id=incident.job_run_id
       where run.id='00000000-0000-4000-8000-000000000423'`,
    ),
    "Staged-production late-run containment must use the fixed five-minute budget",
  );
  await withRole(db, "fidensa_job", () =>
    db.query("select fidensa_api.run_current_retention()"),
  );
  invariant(
    await scalar(
      db,
      `select intake_closed_at is not null
          and intake_close_reason='unresolved_retention_overdue_24_hours'
       from fidensa_private.runtime_authority where singleton`,
    ),
    "the actual Staged-production retention entry point must enforce 24-hour containment",
  );
  console.log(
    "PASS Staged-production late-run incident and actual-entry-point containment",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.job_runs
         (id,job_type,version,scheduled_bucket,selection_cutoff,first_started_at,
          first_terminal_at,outcome,expires_at)
       select '00000000-0000-4000-8000-000000000412','database_retention','v1',
              bucket,bucket+interval '25 minutes',operation_time,
              '2000-01-01T00:00:00Z','failed','2000-03-31T00:00:00Z'
         from (select date_trunc('hour',fidensa_private.authoritative_now())-
                      interval '2 hours' as bucket,
                      fidensa_private.authoritative_now() as operation_time) clock`,
      `insert into fidensa_private.job_run_attempts
         (job_run_id,attempt,started_at,completed_at,outcome,incident)
       select '00000000-0000-4000-8000-000000000412',1,first_started_at,
              '2000-01-01T00:00:00Z','failed',true
         from fidensa_private.job_runs
        where id='00000000-0000-4000-8000-000000000412'`,
      `insert into fidensa_private.retention_incidents
         (job_run_id,incident_class,detected_at,intake_close_due_at,resolution_owner)
       values ('00000000-0000-4000-8000-000000000412','overdue_row',
               clock_timestamp(),clock_timestamp()+interval '24 hours','scott_bishop')`,
      "delete from fidensa_private.job_runs where id='00000000-0000-4000-8000-000000000412'",
    ],
    "forged expired Staged-production run cascading an unresolved incident",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.rubric_calibrations
         (rubric_version_id,actor,findings,scored_application_count,recorded_at)
       select id,'scott_bishop','forged future calibration',
              scored_since_calibration,fidensa_private.authoritative_now()+interval '100 years'
         from fidensa_private.rubric_versions where active`,
      `update fidensa_private.rubric_versions
          set scored_since_calibration=0,
              calibration_anchor_at=fidensa_private.authoritative_now()+interval '100 years'
        where active`,
    ],
    "future Staged-production calibration evidence and anchor",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.applications
         (id,canonical_email,delivery_email,operation_digest,synthetic,lifecycle,
          applicant_name,role_function,context,organization,intended_use_case,
          workflow_stage,deployment_preference,evaluation_timeline,
          design_partner_willingness,submitted_at,retention_deadline)
       select '00000000-0000-4000-8000-000000000413',
              'staged-owner@synthetic.invalid','staged-owner@synthetic.invalid',
              '${digest("staged-owner-application")}',true,'pending_verification',
              'Synthetic Applicant','Synthetic Role','Work','Synthetic Organization',
              '[synthetic fixture]','[synthetic fixture]','Not sure yet',
              'No fixed timeline','Maybe',operation_time,operation_time+interval '7 days'
         from (select fidensa_private.authoritative_now() as operation_time) clock`,
      `update fidensa_private.applications
          set lifecycle='active',verified_at=fidensa_private.authoritative_now(),
              retention_deadline=submitted_at+interval '12 months',version=2,
              updated_at=fidensa_private.authoritative_now()
        where id='00000000-0000-4000-8000-000000000413'`,
      `update fidensa_private.applications
          set last_direct_interaction_at=fidensa_private.authoritative_now()+interval '100 years',
              retention_deadline=fidensa_private.authoritative_now()+interval '101 years',
              version=3,updated_at=fidensa_private.authoritative_now()
        where id='00000000-0000-4000-8000-000000000413'`,
    ],
    "future Staged-production direct interaction and retention extension",
  );
  await expectStudioOwnerRejected(
    db,
    [
      `insert into fidensa_private.applications
         (canonical_email,delivery_email,operation_digest,synthetic,lifecycle,
          applicant_name,role_function,context,organization,intended_use_case,
          workflow_stage,deployment_preference,evaluation_timeline,
          design_partner_willingness,submitted_at,retention_deadline)
       select 'future-staged@synthetic.invalid','future-staged@synthetic.invalid',
              '${digest("future-staged-application")}',true,'pending_verification',
              'Synthetic Applicant','Synthetic Role','Work','Synthetic Organization',
              '[synthetic fixture]','[synthetic fixture]','Not sure yet',
              'No fixed timeline','Maybe',operation_time+interval '100 years',
              operation_time+interval '100 years 7 days'
         from (select fidensa_private.authoritative_now() as operation_time) clock`,
    ],
    "future Staged-production application submission and retention anchor",
  );
  for (const [statement, label] of [
    [
      `insert into fidensa_private.abuse_events
         (event_class,ip_digest,rate_class,result_class,occurred_at,deletion_deadline)
       values ('submission','${digest("staged-future-abuse")}','boundary','allowed',
               '2199-01-01T00:00:00Z','2199-01-03T00:00:00Z')`,
      "future Staged-production abuse-event anchor",
    ],
    [
      `insert into fidensa_private.abuse_investigations
         (purpose,selected_at,owner,event_ids,deletion_deadline)
       values ('staged future owner probe','2199-01-01T00:00:00Z','scott_bishop',
               array[gen_random_uuid()],'2199-01-31T00:00:00Z')`,
      "future Staged-production abuse-investigation anchor",
    ],
    [
      `insert into fidensa_private.operational_logs
         (environment,event_class,operation_id,result_class,occurred_at,deletion_deadline)
       values ('Staged-production','owner_probe',gen_random_uuid(),'synthetic',
               '2199-01-01T00:00:00Z','2199-01-31T00:00:00Z')`,
      "future Staged-production operational-log anchor",
    ],
    [
      `insert into fidensa_private.provider_events
         (provider_event_digest,event_type,occurred_at,first_authenticated_received_at,
          linked_domain,normalized_outcome,state,deletion_deadline)
       values ('${digest("staged-future-provider-event")}','contact.updated',
               '2199-01-01T00:00:00Z','2199-01-01T00:00:00Z',
               'subscription','synthetic','needs_reconciliation',
               '2199-04-01T00:00:00Z')`,
      "future Staged-production provider-event anchor",
    ],
  ]) {
    await expectStudioOwnerRejected(db, [statement], label);
  }
  const rebuiltTableCount = Number(
    await scalar(
      db,
      `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='fidensa_private' and c.relkind='r'`,
    ),
  );
  invariant(
    rebuiltTableCount === initialTableCount,
    "rebuild must reproduce the same table inventory",
  );
  console.log("PASS deterministic recovery and fresh rebuild");
}

async function main() {
  const db = new PGlite();
  try {
    await bootstrapSupabaseRoleSurface(db);
    await applyForwardAsStudioOwner(db);
    await installTestFixturesAsStudioOwner(db);
    const initialTableCount = Number(
      await scalar(
        db,
        `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='fidensa_private' and c.relkind='r'`,
      ),
    );
    invariant(
      initialTableCount >= 25,
      "domain table inventory is unexpectedly small",
    );
    console.log(
      `PASS fresh migration apply (${initialTableCount} private domain tables)`,
    );
    await testCatalogAndAccess(db);
    await testApplicationDeliveryIntents(db);
    await testApplicationFailurePaths(db);
    await testApplicationRateLimits(db);
    await testApplicationQueueAndScoring(db);
    await testStudioOwnerBypassDenial(db);
    await testRetention(db);
    await testProviderAndPrivacyDomains(db);
    await testExerciseControl(db);
    await testRecoveryAndRebuild(db, initialTableCount);
    console.log("DATABASE CONTRACT PASS");
  } finally {
    await db.close();
  }
}

await main();

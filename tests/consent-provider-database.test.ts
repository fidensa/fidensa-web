import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type {
  ConsentSyncClaim,
  ConsentSyncStore,
} from "../src/server/governance-database";
import {
  createResendMarketingContactProvider,
  reconcileOneSubscription,
} from "../src/server/resend-contact-sync";

const migrationsDirectory = new URL("../migrations/", import.meta.url);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function scalar(
  db: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<unknown> {
  const result = await db.query<Record<string, unknown>>(sql, params);
  return Object.values(result.rows[0] ?? {})[0];
}

async function withRole<T>(
  db: PGlite,
  role: string,
  action: () => Promise<T>,
): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("reset role");
  }
}

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role fidensa_studio_owner login nosuperuser noinherit createrole bypassrls;
    grant create on database postgres to fidensa_studio_owner;
    set role fidensa_studio_owner;
  `);
  try {
    const migrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    for (const name of migrations) {
      if (name === "20260924224000_owner_authority_hardening.sql") {
        await db.query(
          "select fidensa_private.configure_test_authority('Test',$1)",
          ["2046-01-01T00:00:00Z"],
        );
      }
      await db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
    }
  } finally {
    await db.exec("reset role");
  }
  return db;
}

async function createActivation(db: PGlite): Promise<void> {
  const label = "adapter-database-partial-activation";
  const email = `${label}@synthetic.invalid`;
  await db.query("select fidensa_private.configure_test_authority('Test',$1)", [
    "2046-01-01T00:00:00Z",
  ]);
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
    null,
    null,
  ];
  const placeholders = parameters.map((_, index) => `$${index + 1}`).join(",");
  await withRole(db, "service_role", () =>
    scalar(
      db,
      `select fidensa_api.submit_application_intake(${placeholders})`,
      parameters,
    ),
  );
  await db.query("select fidensa_private.configure_test_authority('Test',$1)", [
    "2046-01-01T00:01:00Z",
  ]);
  await withRole(db, "service_role", () =>
    scalar(db, "select fidensa_api.verify_application($1,$2)", [
      digest(`${label}:verification`),
      digest(`${label}:verify-ip`),
    ]),
  );
}

function databaseStore(db: PGlite): ConsentSyncStore {
  return {
    async claim() {
      return withRole(db, "service_role", async () => {
        const value = await scalar(
          db,
          "select fidensa_api.claim_subscription_sync()",
        );
        return value as ConsentSyncClaim | null;
      });
    },
    async recordResult(operationId, result) {
      await withRole(db, "service_role", () =>
        db.query(
          "select fidensa_api.record_subscription_sync_result($1,$2,$3,$4,$5)",
          [
            operationId,
            result.outcome,
            result.contactSubscribed,
            result.topicSubscribed,
            result.globallyRestricted,
          ],
        ),
      );
    },
  };
}

describe("Resend adapter with migrated consent storage", () => {
  let db: PGlite | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it.each([
    ["unlisted", null],
    ["listed opt-out", "opt_out"],
  ] as const)(
    "recovers a %s partial create without a duplicate contact create",
    async (_label, initialSubscription) => {
      db = await migratedDatabase();
      await createActivation(db);

      let contactExists = false;
      let topicActive = false;
      let contactCreates = 0;
      let contactUpdates = 0;
      let topicUpdates = 0;
      const provider = createResendMarketingContactProvider({
        accessCredential: `re_${"x".repeat(40)}`,
        marketingTopicId: "topic_marketing",
        fetchImplementation: vi.fn(async (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (url.pathname.includes("/suppressions/")) {
            return new Response(null, { status: 404 });
          }
          if (url.pathname.endsWith("/topics") && method === "GET") {
            return Response.json({
              object: "list",
              has_more: false,
              data: topicActive
                ? [{ id: "topic_marketing", subscription: "opt_in" }]
                : initialSubscription
                  ? [
                      {
                        id: "topic_marketing",
                        subscription: initialSubscription,
                      },
                    ]
                  : [],
            });
          }
          if (url.pathname.endsWith("/topics") && method === "PATCH") {
            topicUpdates += 1;
            if (topicUpdates === 1) return new Response(null, { status: 503 });
            topicActive = true;
            return Response.json({ object: "contact_topics", id: "synthetic" });
          }
          if (url.pathname === "/contacts" && method === "POST") {
            contactCreates += 1;
            contactExists = true;
            return Response.json({ object: "contact", id: "synthetic" });
          }
          if (url.pathname.includes("/contacts/") && method === "PATCH") {
            contactUpdates += 1;
            return Response.json({ object: "contact", id: "synthetic" });
          }
          if (url.pathname.includes("/contacts/") && method === "GET") {
            return contactExists
              ? Response.json({ object: "contact", unsubscribed: false })
              : new Response(null, { status: 404 });
          }
          throw new Error(`Unexpected provider request: ${method} ${url}`);
        }) as typeof fetch,
      });
      const store = databaseStore(db);

      await reconcileOneSubscription(store, provider);
      await reconcileOneSubscription(store, provider);

      expect({
        contactCreates,
        contactUpdates,
        topicUpdates,
        topicActive,
      }).toEqual({
        contactCreates: 1,
        contactUpdates: 1,
        topicUpdates: 2,
        topicActive: true,
      });
      await expect(
        scalar(
          db,
          `select operation.state='applied'
                and provider.first_active_read_back_at is not null
           from fidensa_private.subscription_sync_operations operation
           join fidensa_private.provider_contact_state provider
             on provider.subscription_id=operation.subscription_id
          order by operation.created_at desc limit 1`,
        ),
      ).resolves.toBe(true);
    },
  );
});

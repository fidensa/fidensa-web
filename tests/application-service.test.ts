import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ApplicationDatabase } from "../src/server/application-database";
import {
  AUTOMATIC_MESSAGE_TYPES,
  createResendAutomaticMessageSender,
  type AutomaticMessage,
} from "../src/server/application-messages";
import {
  GENERIC_APPLICATION_RESPONSE,
  GENERIC_VERIFICATION_RESPONSE,
  createApplicationService,
} from "../src/server/application-service";

function application(overrides: Record<string, unknown> = {}) {
  return {
    operationKey: "AAAAAAAAAAAAAAAAAAAAAA",
    name: "Synthetic Applicant",
    email: "Applicant@Example.invalid",
    roleFunction: "AI security engineer",
    context: "Work",
    organization: "Synthetic Organization",
    intendedUseCase: "Synthetic answer sentinel.",
    workflowStage: "Prototype",
    deploymentPreference: "Not sure yet",
    evaluationTimeline: "No fixed timeline",
    designPartnerWillingness: "Maybe",
    integrationConstraints: "",
    referralSource: "",
    additionalContext: "",
    privacyAcknowledged: true,
    marketingSelected: false,
    companyWebsite: "",
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request("https://fidensa.example/api/applications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "192.0.2.10",
    },
    body: JSON.stringify(body),
  });
}

function database(
  overrides: Partial<ApplicationDatabase> = {},
): ApplicationDatabase {
  return {
    submit: vi.fn(async () => null),
    verify: vi.fn(async () => null),
    resendVerification: vi.fn(async () => null),
    claimMessage: vi.fn(async () => null),
    recordMessageOutcome: vi.fn(async () => undefined),
    escalateMessage: vi.fn(async () => undefined),
    recordHoneypot: vi.fn(async () => undefined),
    ...overrides,
  };
}

function service(db: ApplicationDatabase, sent: AutomaticMessage[] = []) {
  const deferred: Array<() => Promise<void>> = [];
  const applicationService = createApplicationService({
    database: db,
    messages: {
      async deliver(message) {
        sent.push(message);
        return {
          outcome: "accepted_by_provider" as const,
          providerMessageDigest: null,
          providerMessageId: null,
        };
      },
      async reconcile(providerMessageId) {
        return {
          outcome: "accepted_by_provider" as const,
          providerMessageDigest: "a".repeat(64),
          providerMessageId,
        };
      },
    },
    tokenMaterial: "t".repeat(64),
    siteOrigin: "https://fidensa.example",
    reviewerRecordBaseUrl:
      "https://supabase.example/dashboard/project/site/editor/records",
    synthetic: true,
    defer(task) {
      deferred.push(task);
    },
  });
  return {
    ...applicationService,
    async runDeferred() {
      while (deferred.length > 0) await deferred.shift()!();
    },
  };
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("application service", () => {
  it("returns precise pre-lookup validation and rejects extra input", async () => {
    const db = database();
    const response = await service(db).submit(
      request(application({ unexpected: "value" })),
    );
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({
      errors: { request: "The request contains unsupported fields." },
    });
    expect(db.submit).not.toHaveBeenCalled();
  });

  it("server-enforces conditional company and enum rules", async () => {
    const db = database();
    const work = await service(db).submit(
      request(application({ organization: "" })),
    );
    const personal = await service(db).submit(
      request(application({ context: "Personal", organization: "" })),
    );
    const malformed = await service(db).submit(
      request(application({ deploymentPreference: "Anywhere" })),
    );
    expect(work.status).toBe(422);
    expect(personal.status).toBe(200);
    expect(malformed.status).toBe(422);
  });

  it("records honeypot abuse but creates and sends nothing", async () => {
    const db = database();
    const sent: AutomaticMessage[] = [];
    const app = service(db, sent);
    const response = await app.submit(
      request(application({ companyWebsite: "https://bot.invalid" })),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      message: GENERIC_APPLICATION_RESPONSE,
    });
    expect(db.recordHoneypot).not.toHaveBeenCalled();
    await app.runDeferred();
    expect(db.recordHoneypot).toHaveBeenCalledOnce();
    expect(db.submit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("sends one fragment-only verification message only after commit", async () => {
    const db = database({
      submit: vi.fn(async () => ({
        applicationId: "00000000-0000-4000-8000-000000000301",
        deliveryEmail: "Applicant@Example.invalid",
        operationId: "00000000-0000-4000-8000-000000000302",
      })),
    });
    const sent: AutomaticMessage[] = [];
    const app = service(db, sent);
    const response = await app.submit(request(application()));
    expect(response.status).toBe(200);
    expect(db.submit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    vi.mocked(db.claimMessage).mockImplementation(async (operationId) =>
      operationId
        ? {
            applicationId: "00000000-0000-4000-8000-000000000301",
            deliveryEmail: "Applicant@Example.invalid",
            operationId: "00000000-0000-4000-8000-000000000302",
            messageType: "application_verification",
            providerMessageId: null,
            reconciliation: false,
            attemptCount: 1,
            firstAttemptAt: "2039-01-01T00:00:00.000Z",
          }
        : null,
    );
    await app.runDeferred();
    expect(
      JSON.stringify(vi.mocked(db.submit).mock.calls[0]?.[0]),
    ).not.toContain("av1.");
    expect(db.recordMessageOutcome).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000302",
      "accepted_by_provider",
      null,
      null,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "application_verification" });
    if (sent[0].type === "application_verification") {
      expect(sent[0].verificationUrl).toMatch(
        /^https:\/\/fidensa\.example\/apply\/verify#av1\.[A-Za-z0-9_-]{43}$/u,
      );
      expect(sent[0].verificationUrl).not.toContain("?");
    }
  });

  it("keeps rejected and duplicate submissions generic with no delivery", async () => {
    const db = database();
    const sent: AutomaticMessage[] = [];
    const response = await service(db, sent).submit(request(application()));
    expect(await body(response)).toEqual({
      message: GENERIC_APPLICATION_RESPONSE,
    });
    expect(sent).toHaveLength(0);
  });

  it("emits receipt and minimal reviewer notification exactly once", async () => {
    const first = {
      applicationId: "00000000-0000-4000-8000-000000000401",
      deliveryEmail: "Applicant@Example.invalid",
      receiptOperationId: "00000000-0000-4000-8000-000000000402",
      reviewerOperationId: "00000000-0000-4000-8000-000000000403",
    };
    const verify = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(null);
    const claims = new Map([
      [
        first.receiptOperationId,
        {
          applicationId: first.applicationId,
          deliveryEmail: first.deliveryEmail,
          operationId: first.receiptOperationId,
          messageType: "application_receipt" as const,
          providerMessageId: null,
          reconciliation: false,
          attemptCount: 1,
          firstAttemptAt: "2039-01-01T00:00:00.000Z",
        },
      ],
      [
        first.reviewerOperationId,
        {
          applicationId: first.applicationId,
          deliveryEmail: first.deliveryEmail,
          operationId: first.reviewerOperationId,
          messageType: "reviewer_notification" as const,
          providerMessageId: null,
          reconciliation: false,
          attemptCount: 1,
          firstAttemptAt: "2039-01-01T00:00:00.000Z",
        },
      ],
    ]);
    const db = database({
      verify,
      claimMessage: vi.fn(async (operationId) => {
        if (!operationId) return null;
        const claim = claims.get(operationId) ?? null;
        claims.delete(operationId);
        return claim;
      }),
    });
    const sent: AutomaticMessage[] = [];
    const verifyRequest = () =>
      request({ credential: `av1.${"A".repeat(43)}` });
    const app = service(db, sent);
    expect(await body(await app.verify(verifyRequest()))).toEqual({
      message: GENERIC_VERIFICATION_RESPONSE,
    });
    expect(sent).toHaveLength(0);
    await app.runDeferred();
    await app.verify(verifyRequest());
    await app.runDeferred();
    expect(sent.map((message) => message.type)).toEqual([
      "application_receipt",
      "reviewer_notification",
    ]);
    const reviewer = sent[1];
    expect(JSON.stringify(reviewer)).not.toContain("Synthetic answer sentinel");
    expect(reviewer).toMatchObject({
      applicationId: first.applicationId,
      operationId: first.reviewerOperationId,
    });
  });

  it("returns the same resend response for committed and absent records", async () => {
    const intent = {
      applicationId: "00000000-0000-4000-8000-000000000501",
      deliveryEmail: "Applicant@Example.invalid",
      operationId: "00000000-0000-4000-8000-000000000502",
    };
    const resendVerification = vi
      .fn()
      .mockResolvedValueOnce(intent)
      .mockResolvedValueOnce(null);
    const sent: AutomaticMessage[] = [];
    const db = database({ resendVerification });
    const app = service(db, sent);
    const first = await body(
      await app.resend(request({ email: "Applicant@Example.invalid" })),
    );
    const second = await body(
      await app.resend(request({ email: "absent@example.invalid" })),
    );
    expect(first).toEqual(second);
    expect(resendVerification).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    await app.runDeferred();
  });

  it("reconciles a durable unknown outcome before processing new work", async () => {
    const operationId = "00000000-0000-4000-8000-000000000901";
    const claim = {
      applicationId: "00000000-0000-4000-8000-000000000902",
      deliveryEmail: "Applicant@Example.invalid",
      operationId,
      messageType: "application_receipt" as const,
      providerMessageId: "provider-message-901",
      reconciliation: true,
      attemptCount: 1,
      firstAttemptAt: "2039-01-01T00:00:00.000Z",
    };
    const db = database({
      claimMessage: vi
        .fn()
        .mockResolvedValueOnce(claim)
        .mockResolvedValueOnce(null),
    });
    const modes: string[] = [];
    const deferred: Array<() => Promise<void>> = [];
    const app = createApplicationService({
      database: db,
      messages: {
        async deliver() {
          modes.push("deliver");
          return {
            outcome: "accepted_by_provider" as const,
            providerMessageDigest: null,
            providerMessageId: null,
          };
        },
        async reconcile(providerMessageId) {
          modes.push(`reconcile:${providerMessageId}`);
          return {
            outcome: "accepted_by_provider" as const,
            providerMessageDigest: "a".repeat(64),
            providerMessageId,
          };
        },
      },
      tokenMaterial: "t".repeat(64),
      siteOrigin: "https://fidensa.example",
      reviewerRecordBaseUrl: "https://supabase.example/records",
      synthetic: true,
      defer(task) {
        deferred.push(task);
      },
    });
    await app.submit(request(application()));
    expect(modes).toEqual([]);
    while (deferred.length) await deferred.shift()!();
    expect(modes).toEqual(["reconcile:provider-message-901"]);
    expect(db.recordMessageOutcome).toHaveBeenCalledWith(
      operationId,
      "accepted_by_provider",
      "a".repeat(64),
      "provider-message-901",
    );
  });

  it("escalates a verification claim when its transient credential is gone", async () => {
    const operationId = "00000000-0000-4000-8000-000000000911";
    const db = database({
      claimMessage: vi
        .fn()
        .mockResolvedValueOnce({
          applicationId: "00000000-0000-4000-8000-000000000912",
          deliveryEmail: "Applicant@Example.invalid",
          operationId,
          messageType: "application_verification" as const,
          providerMessageId: null,
          reconciliation: true,
          attemptCount: 2,
          firstAttemptAt: "2039-01-01T00:00:00.000Z",
        })
        .mockResolvedValueOnce(null),
    });
    const app = service(db);
    await expect(app.reconcile()).resolves.toBe(1);
    expect(db.escalateMessage).toHaveBeenCalledWith(
      operationId,
      "credential_unavailable",
    );
    expect(db.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("does not blindly retry a partial verification delivery", async () => {
    const intent = {
      applicationId: "00000000-0000-4000-8000-000000000701",
      deliveryEmail: "Applicant@Example.invalid",
      receiptOperationId: "00000000-0000-4000-8000-000000000702",
      reviewerOperationId: "00000000-0000-4000-8000-000000000703",
    };
    const verify = vi.fn().mockResolvedValueOnce(intent);
    const attempted: AutomaticMessage[] = [];
    const claim = {
      applicationId: intent.applicationId,
      deliveryEmail: intent.deliveryEmail,
      operationId: intent.receiptOperationId,
      messageType: "application_receipt" as const,
      providerMessageId: null,
      reconciliation: false,
      attemptCount: 1,
      firstAttemptAt: "2039-01-01T00:00:00.000Z",
    };
    const db = database({
      verify,
      claimMessage: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(claim)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const deferred: Array<() => Promise<void>> = [];
    const app = createApplicationService({
      database: db,
      messages: {
        async deliver(message) {
          attempted.push(message);
          return {
            outcome: "delivery_unknown" as const,
            providerMessageDigest: null,
            providerMessageId: null,
          };
        },
        async reconcile(providerMessageId) {
          return {
            outcome: "delivery_unknown" as const,
            providerMessageDigest: "a".repeat(64),
            providerMessageId,
          };
        },
      },
      tokenMaterial: "t".repeat(64),
      siteOrigin: "https://fidensa.example",
      reviewerRecordBaseUrl: "https://supabase.example/records",
      synthetic: true,
      defer(task) {
        deferred.push(task);
      },
    });
    const verificationRequest = () =>
      request({ credential: `av1.${"A".repeat(43)}` });
    await app.verify(verificationRequest());
    while (deferred.length) await deferred.shift()!();
    expect(attempted.map((message) => message.type)).toEqual([
      "application_receipt",
    ]);
    expect(db.recordMessageOutcome).toHaveBeenCalledWith(
      intent.receiptOperationId,
      "delivery_unknown",
      null,
      null,
    );
  });
});

describe("automatic communication boundary", () => {
  it("exports exactly the three approved automation identities", () => {
    expect(AUTOMATIC_MESSAGE_TYPES).toEqual([
      "application_verification",
      "application_receipt",
      "reviewer_notification",
    ]);
  });

  it("builds a reviewer message with only identifier and link", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const sender = createResendAutomaticMessageSender({
      accessCredential: "m".repeat(64),
      reviewerRecipient: "reviewer@fidensa.example",
      fetchImplementation: vi.fn(async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response("{}", { status: 200 });
      }),
    });
    await sender.deliver({
      type: "reviewer_notification",
      recipient: "reviewer",
      operationId: "00000000-0000-4000-8000-000000000601",
      applicationId: "00000000-0000-4000-8000-000000000602",
      recordUrl:
        "https://supabase.example/record/00000000-0000-4000-8000-000000000602",
    });
    const providerBody = String(calls[0].init?.body);
    expect(providerBody).toContain("00000000-0000-4000-8000-000000000602");
    expect(providerBody).not.toContain("Synthetic answer sentinel");
    expect(providerBody).not.toContain("fidensa_private");
    expect(providerBody).toContain(
      '"from":"Fidensa Applications <apply@fidensa.com>"',
    );
    expect(calls[0].init?.headers).toMatchObject({
      "Idempotency-Key": "00000000-0000-4000-8000-000000000601",
    });
  });

  it("classifies an ambiguous provider response without a blind retry", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response("temporary detail", { status: 503 }),
    );
    const sender = createResendAutomaticMessageSender({
      accessCredential: "m".repeat(64),
      reviewerRecipient: "reviewer@fidensa.example",
      fetchImplementation,
    });
    await expect(
      sender.deliver({
        type: "application_receipt",
        recipient: "applicant@example.invalid",
        operationId: "00000000-0000-4000-8000-000000000801",
      }),
    ).resolves.toEqual({
      outcome: "delivery_unknown",
      providerMessageDigest: null,
      providerMessageId: null,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("treats only the retryable idempotency conflict as ambiguous", async () => {
    const responses = [
      Response.json(
        { name: "concurrent_idempotent_requests" },
        { status: 409 },
      ),
      Response.json({ name: "invalid_idempotent_request" }, { status: 409 }),
    ];
    const sender = createResendAutomaticMessageSender({
      accessCredential: "m".repeat(64),
      reviewerRecipient: "reviewer@fidensa.example",
      fetchImplementation: vi.fn(async () => responses.shift()!),
    });
    const message = {
      type: "application_receipt" as const,
      recipient: "applicant@example.invalid",
      operationId: "00000000-0000-4000-8000-000000000821",
    };
    await expect(sender.deliver(message)).resolves.toMatchObject({
      outcome: "delivery_unknown",
    });
    await expect(sender.deliver(message)).resolves.toMatchObject({
      outcome: "failed",
    });
  });

  it("uses the approved verification and receipt content boundaries", async () => {
    const bodies: string[] = [];
    const sender = createResendAutomaticMessageSender({
      accessCredential: "m".repeat(64),
      reviewerRecipient: "reviewer@fidensa.example",
      fetchImplementation: vi.fn(async (_input, init) => {
        bodies.push(String(init?.body));
        return Response.json({ id: "provider-message" });
      }),
    });
    await sender.deliver({
      type: "application_verification",
      recipient: "applicant@example.invalid",
      operationId: "00000000-0000-4000-8000-000000000811",
      verificationUrl: `https://fidensa.example/apply/verify#av1.${"A".repeat(43)}`,
    });
    await sender.deliver({
      type: "application_receipt",
      recipient: "applicant@example.invalid",
      operationId: "00000000-0000-4000-8000-000000000812",
    });
    expect(bodies[0]).toContain("expires in 60 minutes");
    expect(bodies[0]).toContain("privacy@fidensa.com");
    expect(bodies[1]).toContain("has entered consideration");
    expect(bodies[1]).toContain("privacy@fidensa.com");
    expect(bodies[1]).toContain(
      "decision notices beyond the automated receipt",
    );
    expect(bodies[1]).not.toContain(
      "decision notices beyond this automated receipt",
    );
  });

  it("reconciles from a provider identity without re-posting the message", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const sender = createResendAutomaticMessageSender({
      accessCredential: "m".repeat(64),
      reviewerRecipient: "reviewer@fidensa.example",
      fetchImplementation: vi.fn(async (input, init) => {
        calls.push({ input: String(input), init });
        return Response.json({
          id: "provider-message-lookup",
          last_event: "delivered",
        });
      }),
    });
    await expect(
      sender.reconcile("provider-message-lookup"),
    ).resolves.toMatchObject({
      outcome: "accepted_by_provider",
      providerMessageId: "provider-message-lookup",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        input: "https://api.resend.com/emails/provider-message-lookup",
        init: expect.objectContaining({ method: "GET" }),
      }),
    ]);
  });
});

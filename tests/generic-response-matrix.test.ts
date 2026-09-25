import { isDeepStrictEqual } from "node:util";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ApplicationDatabase } from "../src/server/application-database";
import { createApplicationService } from "../src/server/application-service";
import { writeSafeLog } from "../src/server/log";
import { createPrivacyIntakeHandler } from "../src/server/privacy-rights";

const states = [
  "absent",
  "existing",
  "pending",
  "verified",
  "expired",
  "used",
  "deleted",
  "throttled",
  "suppressed",
] as const;
const operations = ["submission", "resend", "verification", "privacy"] as const;
type MatrixState = (typeof states)[number];
type MatrixOperation = (typeof operations)[number];
type ObservationChannel = keyof Observation;

interface MatrixCase {
  readonly operation: MatrixOperation;
  readonly state: MatrixState;
  readonly applicable: boolean;
  readonly reason?: string;
  readonly commits: boolean;
}

interface Observation {
  readonly body: unknown;
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly logs: readonly string[];
  readonly providerEffects: readonly string[];
  readonly orderedOperations: readonly string[];
}

const inapplicable = new Map<string, string>([
  [
    "submission:expired",
    "credential expiry is not consulted by new submission",
  ],
  ["submission:used", "credential use is not consulted by new submission"],
  [
    "privacy:expired",
    "application credential expiry does not apply to privacy intake",
  ],
  [
    "privacy:used",
    "application credential use does not apply to privacy intake",
  ],
]);

function commits(operation: MatrixOperation, state: MatrixState): boolean {
  if (operation === "submission")
    return ["absent", "deleted", "suppressed"].includes(state);
  if (operation === "resend")
    return ["existing", "pending", "expired", "suppressed"].includes(state);
  if (operation === "verification")
    return ["existing", "pending", "suppressed"].includes(state);
  return state !== "throttled";
}

const matrix: MatrixCase[] = operations.flatMap((operation) =>
  states.map((state) => {
    const reason = inapplicable.get(`${operation}:${state}`);
    return {
      operation,
      state,
      applicable: !reason,
      reason,
      commits: !reason && commits(operation, state),
    };
  }),
);

function application() {
  return {
    operationKey: "AAAAAAAAAAAAAAAAAAAAAA",
    name: "Synthetic Applicant",
    email: "matrix@synthetic.invalid",
    roleFunction: "Synthetic role",
    context: "Work",
    organization: "Synthetic Organization",
    intendedUseCase: "[synthetic]",
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
  };
}

function request(body: unknown): Request {
  return new Request("https://fidensa.example/operation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "192.0.2.40",
    },
    body: JSON.stringify(body),
  });
}

const privacyStoreBehavior: Record<MatrixState, () => Promise<void>> = {
  absent: async () => undefined,
  existing: async () => undefined,
  pending: async () => undefined,
  verified: async () => undefined,
  expired: async () => undefined,
  used: async () => undefined,
  deleted: async () => undefined,
  throttled: async () => {
    throw new Error("synthetic throttled store");
  },
  suppressed: async () => undefined,
};

function injectResponseDivergence(
  response: Response,
  fault?: ObservationChannel,
): Response {
  if (fault === "body") {
    return new Response(JSON.stringify({ message: "injected divergence" }), {
      status: response.status,
      headers: response.headers,
    });
  }
  if (fault === "status") {
    return new Response(response.body, {
      status: 201,
      headers: response.headers,
    });
  }
  if (fault === "headers") {
    const headers = new Headers(response.headers);
    headers.set("x-injected-divergence", "true");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

async function observe(
  entry: MatrixCase,
  fault?: ObservationChannel,
): Promise<Observation> {
  const orderedOperations: string[] = [];
  const providerEffects: string[] = [];
  const logs: string[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const consoleInfo = vi
    .spyOn(console, "info")
    .mockImplementation((value) => logs.push(String(value)));
  const log = () => {
    writeSafeLog({
      environment: "test",
      eventClass: "request_completed",
      resultClass: "succeeded",
    });
    if (fault === "logs") {
      writeSafeLog({
        environment: "test",
        eventClass: "request_completed",
        resultClass: "failed",
      });
    }
  };
  const intent = entry.commits
    ? {
        applicationId: "00000000-0000-4000-8000-000000000301",
        deliveryEmail: "matrix@synthetic.invalid",
        operationId: "00000000-0000-4000-8000-000000000302",
      }
    : null;
  const verificationIntent = entry.commits
    ? {
        applicationId: "00000000-0000-4000-8000-000000000301",
        deliveryEmail: "matrix@synthetic.invalid",
        receiptOperationId: "00000000-0000-4000-8000-000000000303",
        reviewerOperationId: "00000000-0000-4000-8000-000000000304",
      }
    : null;
  const db: ApplicationDatabase = {
    async submit() {
      orderedOperations.push("store.submit");
      return intent;
    },
    async verify() {
      orderedOperations.push("store.verify");
      return verificationIntent;
    },
    async resendVerification() {
      orderedOperations.push("store.resend");
      return intent;
    },
    async claimMessage(operationId) {
      orderedOperations.push(`store.claim:${operationId ?? "outstanding"}`);
      if (!entry.commits || !operationId) return null;
      const messageType =
        operationId === verificationIntent?.receiptOperationId
          ? "application_receipt"
          : operationId === verificationIntent?.reviewerOperationId
            ? "reviewer_notification"
            : null;
      if (!messageType) return null;
      return {
        applicationId: verificationIntent!.applicationId,
        deliveryEmail: verificationIntent!.deliveryEmail,
        operationId,
        messageType,
        providerMessageId: null,
        reconciliation: false,
        attemptCount: 1,
        firstAttemptAt: null,
      };
    },
    async recordMessageOutcome(operationId) {
      orderedOperations.push(`store.outcome:${operationId}`);
    },
    async escalateMessage(operationId) {
      orderedOperations.push(`store.escalate:${operationId}`);
    },
    async recordHoneypot() {
      orderedOperations.push("store.honeypot");
    },
  };
  const service = createApplicationService({
    database: db,
    messages: {
      async deliver(message) {
        providerEffects.push(`deliver:${message.type}`);
        orderedOperations.push(`provider.deliver:${message.type}`);
        return {
          outcome: "accepted_by_provider" as const,
          providerMessageDigest: null,
          providerMessageId: null,
        };
      },
      async reconcile(providerMessageId) {
        providerEffects.push(`reconcile:${providerMessageId}`);
        orderedOperations.push(`provider.reconcile:${providerMessageId}`);
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
    log,
    defer(task) {
      deferred.push(task);
    },
  });

  try {
    let response: Response;
    if (entry.operation === "submission") {
      response = await service.submit(request(application()));
    } else if (entry.operation === "resend") {
      response = await service.resend(
        request({ email: "matrix@synthetic.invalid" }),
      );
    } else if (entry.operation === "verification") {
      response = await service.verify(
        request({ credential: `av1.${"A".repeat(43)}` }),
      );
    } else {
      const handler = createPrivacyIntakeHandler({
        store: {
          async createRequest() {
            orderedOperations.push("store.privacy");
            await privacyStoreBehavior[entry.state]();
          },
        },
        digestOperationKey: () => "o".repeat(64),
        digestIpIdentity: () => "i".repeat(64),
        digestEmailIdentity: () => "e".repeat(64),
        requestIpIdentity: () => "192.0.2.40",
        log,
      });
      response = await handler(
        request({
          operationKey: "BBBBBBBBBBBBBBBBBBBBBB",
          type: "access",
          email: "matrix@synthetic.invalid",
        }),
      );
    }
    while (deferred.length > 0) await deferred.shift()!();
    if (fault === "providerEffects") providerEffects.push("injected");
    if (fault === "orderedOperations") orderedOperations.push("injected");
    response = injectResponseDivergence(response, fault);
    return {
      body: await response.json(),
      status: response.status,
      headers: [...response.headers.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      logs,
      providerEffects,
      orderedOperations,
    };
  } finally {
    consoleInfo.mockRestore();
  }
}

function expectedEffects(
  entry: MatrixCase,
): Pick<Observation, "providerEffects" | "orderedOperations"> {
  const orderedOperations: string[] = [];
  const providerEffects: string[] = [];
  if (entry.operation === "privacy") {
    orderedOperations.push("store.privacy");
  } else {
    orderedOperations.push(
      "store.claim:outstanding",
      entry.operation === "verification"
        ? "store.verify"
        : entry.operation === "submission"
          ? "store.submit"
          : `store.${entry.operation}`,
    );
    if (entry.commits && entry.operation !== "verification") {
      providerEffects.push("deliver:application_verification");
      orderedOperations.push(
        "provider.deliver:application_verification",
        "store.outcome:00000000-0000-4000-8000-000000000302",
      );
    } else if (entry.commits) {
      providerEffects.push(
        "deliver:application_receipt",
        "deliver:reviewer_notification",
      );
      orderedOperations.push(
        "store.claim:00000000-0000-4000-8000-000000000303",
        "store.claim:00000000-0000-4000-8000-000000000304",
        "provider.deliver:application_receipt",
        "provider.deliver:reviewer_notification",
        "store.outcome:00000000-0000-4000-8000-000000000303",
        "store.outcome:00000000-0000-4000-8000-000000000304",
      );
    }
  }
  return { providerEffects, orderedOperations };
}

function assertObservation(expected: Observation, actual: Observation): void {
  for (const channel of [
    "body",
    "status",
    "headers",
    "logs",
    "providerEffects",
    "orderedOperations",
  ] as const) {
    if (!isDeepStrictEqual(actual[channel], expected[channel])) {
      throw new Error(`generic-response oracle divergence: ${channel}`);
    }
  }
}

describe("fixed-clock operation-by-state generic-response matrix", () => {
  it("covers every operation/state pair and explains every inapplicable pair", () => {
    expect(matrix).toHaveLength(operations.length * states.length);
    expect(
      matrix
        .filter((entry) => !entry.applicable)
        .every((entry) => entry.reason),
    ).toBe(true);
  });

  it("passes every applicable case through one six-channel comparator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2041-01-01T00:00:00.000Z"));
    try {
      const publicBaselines = new Map<MatrixOperation, Observation>();
      for (const entry of matrix.filter((candidate) => candidate.applicable)) {
        const actual = await observe(entry);
        const baseline = publicBaselines.get(entry.operation) ?? actual;
        publicBaselines.set(entry.operation, baseline);
        assertObservation(
          {
            body: baseline.body,
            status: baseline.status,
            headers: baseline.headers,
            logs: baseline.logs,
            ...expectedEffects(entry),
          },
          actual,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects every channel when the observed route or its doubles diverge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2041-01-01T00:00:00.000Z"));
    try {
      const entry = matrix.find(
        (candidate) =>
          candidate.operation === "submission" && candidate.state === "absent",
      )!;
      const expected = await observe(entry);
      for (const channel of [
        "body",
        "status",
        "headers",
        "logs",
        "providerEffects",
        "orderedOperations",
      ] as const) {
        const actual = await observe(entry, channel);
        expect(() => assertObservation(expected, actual)).toThrow(channel);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

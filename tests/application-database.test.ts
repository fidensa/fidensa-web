import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createSupabaseApplicationDatabase,
  type ApplicationSubmissionRecord,
} from "../src/server/application-database";

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function submission(): ApplicationSubmissionRecord {
  return {
    synthetic: true,
    canonicalEmail: "adapter@synthetic.invalid",
    deliveryEmail: "adapter@synthetic.invalid",
    operationDigest: digest("operation"),
    verificationDigest: digest("verification"),
    ipDigest: digest("ip"),
    emailDigest: digest("email"),
    applicantName: "Synthetic Applicant",
    roleFunction: "Synthetic Role",
    context: "Work",
    organization: "Synthetic Organization",
    intendedUseCase: "[synthetic fixture]",
    workflowStage: "[synthetic fixture]",
    deploymentPreference: "Not sure yet",
    evaluationTimeline: "No fixed timeline",
    designPartnerWillingness: "Maybe",
    integrationConstraints: null,
    referralSource: null,
    additionalContext: null,
    noticeVersion: "privacy-v1",
    marketingSelected: false,
    consentTextVersion: null,
  };
}

describe("application database boundary", () => {
  it("calls only the operations schema with a server credential and no caching", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          applicationId: "00000000-0000-4000-8000-000000000301",
          deliveryEmail: "adapter@synthetic.invalid",
          operationId: "00000000-0000-4000-8000-000000000302",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const credential = ["synthetic", "server", "credential", "material"].join(
      "-",
    );
    const database = createSupabaseApplicationDatabase({
      baseUrl: "https://project.invalid",
      serviceCredential: credential,
      fetchImplementation,
    });

    await expect(database.submit(submission())).resolves.toMatchObject({
      applicationId: "00000000-0000-4000-8000-000000000301",
      operationId: "00000000-0000-4000-8000-000000000302",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://project.invalid/rest/v1/rpc/submit_application_intake",
    );
    expect(requests[0].init?.cache).toBe("no-store");
    expect(requests[0].init?.headers).toMatchObject({
      "Accept-Profile": "fidensa_api",
      "Content-Profile": "fidensa_api",
      Authorization: `Bearer ${credential}`,
      apikey: credential,
    });
    expect(String(requests[0].init?.body)).not.toContain("credentialDigest");
    expect(String(requests[0].init?.body)).not.toContain("p_environment");
    expect(String(requests[0].init?.body)).not.toContain("p_now");
  });

  it("does not reflect provider response detail or credential material", async () => {
    const credential = ["synthetic", "server", "credential", "material"].join(
      "-",
    );
    const database = createSupabaseApplicationDatabase({
      baseUrl: "https://project.invalid",
      serviceCredential: credential,
      fetchImplementation: vi.fn(
        async () =>
          new Response(`sensitive detail ${credential}`, { status: 503 }),
      ),
    });

    let observed = "";
    try {
      await database.verify(digest("verification"), digest("ip"));
    } catch (error) {
      observed = String(error);
    }
    expect(observed).toContain("503");
    expect(observed).not.toContain("sensitive detail");
    expect(observed).not.toContain(credential);
  });

  it("rejects raw or malformed values at digest-only boundaries", async () => {
    const database = createSupabaseApplicationDatabase({
      baseUrl: "http://localhost:54321",
      serviceCredential: "x".repeat(40),
      fetchImplementation: vi.fn(),
    });
    await expect(database.verify("raw-value", digest("ip"))).rejects.toThrow(
      "digest",
    );
  });

  it("rejects malformed privileged-operation results", async () => {
    const database = createSupabaseApplicationDatabase({
      baseUrl: "https://project.invalid",
      serviceCredential: "x".repeat(40),
      fetchImplementation: vi.fn(
        async () =>
          new Response(JSON.stringify({ deliveryEmail: "redirect@invalid" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });
    await expect(database.submit(submission())).rejects.toThrow(
      "malformed delivery intent",
    );
  });

  it("lets resend delivery use only the address stored by the database", async () => {
    const requests: RequestInit[] = [];
    const database = createSupabaseApplicationDatabase({
      baseUrl: "https://project.invalid",
      serviceCredential: "x".repeat(40),
      fetchImplementation: vi.fn(async (_input, init) => {
        requests.push(init ?? {});
        return Response.json({
          applicationId: "00000000-0000-4000-8000-000000000321",
          deliveryEmail: "Stored.Address@Example.invalid",
          operationId: "00000000-0000-4000-8000-000000000322",
        });
      }),
    });
    const result = await database.resendVerification(
      "stored.address@example.invalid",
      digest("replacement"),
      digest("ip"),
      digest("email"),
    );
    expect(result?.deliveryEmail).toBe("Stored.Address@Example.invalid");
    expect(String(requests[0].body)).not.toContain("p_delivery_email");
    expect(String(requests[0].body)).not.toContain("sealed");
  });
});

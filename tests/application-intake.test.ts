import { describe, expect, it } from "vitest";

import {
  APPLICATION_LIMITS,
  parseApplicationSubmission,
  parseVerificationRequest,
} from "../src/application/contract";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    operationKey: "AAAAAAAAAAAAAAAAAAAAAA",
    name: "Synthetic Applicant",
    email: "Applicant@Example.invalid",
    roleFunction: "AI security engineer",
    context: "Work",
    organization: "Synthetic Organization",
    intendedUseCase: "A synthetic evaluation workflow.",
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

describe("application intake contract", () => {
  it("accepts the exact bounded application shape", () => {
    const result = parseApplicationSubmission(valid());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canonicalEmail).toBe("applicant@example.invalid");
      expect(result.value.organization).toBe("Synthetic Organization");
      expect(result.value.marketingSelected).toBe(false);
    }
  });

  it("exposes the accepted text caps", () => {
    expect(APPLICATION_LIMITS).toMatchObject({
      name: 120,
      email: 254,
      roleFunction: 120,
      organization: 160,
      intendedUseCase: 2_000,
      workflowStage: 1_000,
      integrationConstraints: 1_500,
      referralSource: 300,
      additionalContext: 2_000,
      requestBytes: 128 * 1024,
    });
  });

  it.each([
    ["name", APPLICATION_LIMITS.name],
    ["roleFunction", APPLICATION_LIMITS.roleFunction],
    ["organization", APPLICATION_LIMITS.organization],
    ["intendedUseCase", APPLICATION_LIMITS.intendedUseCase],
    ["workflowStage", APPLICATION_LIMITS.workflowStage],
    ["integrationConstraints", APPLICATION_LIMITS.integrationConstraints],
    ["referralSource", APPLICATION_LIMITS.referralSource],
    ["additionalContext", APPLICATION_LIMITS.additionalContext],
  ] as const)("rejects %s above its Unicode-scalar cap", (field, maximum) => {
    const result = parseApplicationSubmission(
      valid({ [field]: "🧪".repeat(maximum + 1) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toContain("or fewer");
  });

  it("enforces every closed enumeration and separate consent types", () => {
    for (const [field, value] of [
      ["context", "Corporate"],
      ["deploymentPreference", "Anywhere"],
      ["evaluationTimeline", "Soon"],
      ["designPartnerWillingness", "Definitely"],
      ["privacyAcknowledged", false],
      ["marketingSelected", "yes"],
    ] as const) {
      const result = parseApplicationSubmission(valid({ [field]: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[field]).toBeTruthy();
    }
  });

  it("requires company only for Work and Both", () => {
    expect(parseApplicationSubmission(valid({ organization: "" })).ok).toBe(
      false,
    );
    expect(
      parseApplicationSubmission(valid({ context: "Both", organization: "" }))
        .ok,
    ).toBe(false);
    expect(
      parseApplicationSubmission(
        valid({ context: "Personal", organization: "" }),
      ).ok,
    ).toBe(true);
  });

  it("accepts only the purpose-prefixed verification credential", () => {
    expect(
      parseVerificationRequest({ credential: `av1.${"A".repeat(43)}` }).ok,
    ).toBe(true);
    expect(
      parseVerificationRequest({ credential: `privacy.${"A".repeat(43)}` }).ok,
    ).toBe(false);
  });

  it.each([
    "victim@example.com/path",
    "victim@example.com?query",
    "victim@example.com#fragment",
    "victim@example.com:25",
    "victim@example.com\\suffix",
    "bad<>local@example.com",
    "bad,local@example.com",
    "victim@ｅxample.com",
    "victim@exam\u00adple.com",
  ])("rejects malformed or identity-changing email %s", (email) => {
    const result = parseApplicationSubmission(valid({ email }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeTruthy();
  });

  it("retains only case as delivery/canonical divergence", () => {
    const result = parseApplicationSubmission(
      valid({ email: "Applicant.Name+tag@Example.COM" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deliveryEmail).toBe("Applicant.Name+tag@Example.COM");
      expect(result.value.canonicalEmail).toBe(
        "applicant.name+tag@example.com",
      );
    }
  });

  it("accepts a U-label domain only when its IDNA A-label round-trips exactly", () => {
    const result = parseApplicationSubmission(
      valid({ email: "Applicant@bücher.example" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deliveryEmail).toBe("Applicant@bücher.example");
      expect(result.value.canonicalEmail).toBe(
        "applicant@xn--bcher-kva.example",
      );
    }
    expect(
      parseApplicationSubmission(
        valid({ email: "Applicant@xn--bcher-kva.example" }),
      ).ok,
    ).toBe(true);
  });
});

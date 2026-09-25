import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CONTROLLED_EVIDENCE_CHECKLIST,
  CONTROLLED_EVIDENCE_CHECKLIST_DIGEST,
  CONTROLLED_EVIDENCE_MEMBERS,
  sealControlledEvidencePacket,
  validateControlledEvidencePacket,
  type ControlledEvidencePacket,
} from "../src/server/controlled-evidence-packet";

const correlationId = "00000000-0000-4000-8000-000000000201";
const deploymentIdentity = "dpl_synthetic_exact_candidate";
const configurationDigest = "c".repeat(64);

function completePacket(): ControlledEvidencePacket {
  return sealControlledEvidencePacket({
    checklistIdentity: CONTROLLED_EVIDENCE_CHECKLIST,
    checklistDigest: CONTROLLED_EVIDENCE_CHECKLIST_DIGEST,
    correlationId,
    commitIdentity: "a".repeat(40),
    deploymentIdentity,
    configurationDigest,
    captureActor: "scott_bishop",
    exerciseOpenedAt: "2041-01-01T00:00:00.000Z",
    submittedAt: "2041-01-01T00:01:00.000Z",
    verifiedAt: "2041-01-01T00:02:00.000Z",
    reviewCompletedAt: "2041-01-01T01:00:00.000Z",
    accessRevokedAt: "2041-01-01T01:01:00.000Z",
    cleanupVerifiedAt: "2041-01-01T01:02:00.000Z",
    evidenceMode: {
      identity: "controlled-exercise",
      result: "passed",
    },
    publicDenialAndReviewerAccess: {
      publicDenied: true,
      soleReviewer: "scott_bishop",
      mfaObserved: true,
    },
    productionVariables: {
      productionOnly: true,
      presenceObserved: true,
      valuesIncluded: false,
    },
    deploymentPosture: {
      protected: true,
      automaticDomainAssigned: false,
      promoted: false,
    },
    independentReview: {
      runIdentity: "independent-run-synthetic-001",
      verdict: "approve",
      independent: true,
      completedAt: "2041-01-01T01:00:00.000Z",
    },
    syntheticProvenance: {
      synthetic: true,
      identityNamespace: "synthetic.invalid",
      containsRealPersonalData: false,
    },
    redactionAttestation: {
      complete: true,
      actor: "scott_bishop",
      attestedAt: "2041-01-01T01:02:00.000Z",
    },
    access: {
      expired: true,
      revoked: true,
      fixtureVerifierRevoked: true,
      usableCredentialPresent: false,
    },
    cleanup: {
      applicationRows: 0,
      verificationRows: 0,
      acknowledgmentRows: 0,
      statusAndScoreRows: 0,
      communicationRows: 0,
      subscriptionAndTopicRows: 0,
      suppressionRows: 0,
      providerEventRows: 0,
      allowlistRows: 0,
      abuseRows: 0,
      privacyRows: 0,
      jobRows: 0,
      exerciseControlRows: 0,
      providerContactRemoved: true,
      providerTopicRemoved: true,
      untaggedExerciseWindowRows: 0,
      laterMarketingEligible: false,
      resurrectionObserved: false,
      onlyAcceptanceRecordRemains: true,
    },
    exceptions: [],
    members: CONTROLLED_EVIDENCE_MEMBERS.map((name, index) => ({
      name,
      correlationId,
      deploymentIdentity,
      configurationDigest,
      capturedAt: `2041-01-01T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
      capturedBy:
        name === "independent-run-verdict"
          ? ("independent_reviewer" as const)
          : ("scott_bishop" as const),
      redacted: true,
      content: `[synthetic redacted ${name} observation]`,
    })),
  });
}

function changed(
  change: (packet: ControlledEvidencePacket) => void,
  reseal = true,
): ControlledEvidencePacket {
  const packet = structuredClone(completePacket());
  change(packet);
  if (!reseal) return packet;
  return sealControlledEvidencePacket(packet);
}

function rejectionErrors(packet: ControlledEvidencePacket): readonly string[] {
  const result = validateControlledEvidencePacket(packet);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("CE-02-v1.0 controlled evidence packet", () => {
  it("accepts one complete internally consistent packet", () => {
    expect(validateControlledEvidencePacket(completePacket())).toEqual({
      ok: true,
    });
  });

  it.each(CONTROLLED_EVIDENCE_MEMBERS)(
    "rejects the missing %s member with its exact reason",
    (name) => {
      const packet = changed((value) => {
        Reflect.set(
          value,
          "members",
          value.members.filter((member) => member.name !== name),
        );
      });
      expect(rejectionErrors(packet)).toContain(
        `required member ${name} is missing`,
      );
    },
  );

  it.each([
    [
      "duplicated member",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "members", [
          ...packet.members,
          structuredClone(packet.members[0]!),
        ]);
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} is duplicated`,
    ],
    [
      "mixed correlation",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(
          packet.members[0]!,
          "correlationId",
          "00000000-0000-4000-8000-000000000202",
        );
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} has mixed correlation`,
    ],
    [
      "mixed configuration",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.members[0]!, "configurationDigest", "d".repeat(64));
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} has mixed configuration`,
    ],
    [
      "mixed deployment",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.members[0]!, "deploymentIdentity", "dpl_other");
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} has mixed deployment`,
    ],
    [
      "wrong checklist identity",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "checklistIdentity", "CE-02-v0.9");
      },
      "checklist identity or frozen design digest is invalid",
    ],
    [
      "wrong commit identity",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "commitIdentity", "a".repeat(39));
      },
      "commit is invalid",
    ],
    [
      "invalid chronology",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "verifiedAt", "2040-12-31T23:59:00.000Z");
      },
      "packet chronology is invalid",
    ],
    [
      "unzoned time",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "submittedAt", "2041-01-01T00:01:00.000");
      },
      "all evidence timestamps must include an explicit zone",
    ],
    [
      "capture actor",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.members[0]!, "capturedBy", "unknown");
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} capture actor is invalid`,
    ],
    [
      "redaction failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.members[0]!, "redacted", false);
      },
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} is not redacted`,
    ],
    [
      "cleanup failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.cleanup, "providerContactRemoved", false);
      },
      "cleanup or no-marketing-eligibility proof is incomplete",
    ],
    [
      "synthetic provenance failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(
          packet.syntheticProvenance,
          "containsRealPersonalData",
          true,
        );
      },
      "synthetic provenance is invalid",
    ],
    [
      "evidence mode failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.evidenceMode, "result", "failed");
      },
      "evidence mode result is invalid",
    ],
    [
      "public denial failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(
          packet.publicDenialAndReviewerAccess,
          "publicDenied",
          false,
        );
      },
      "public denial or sole-reviewer/MFA observation is invalid",
    ],
    [
      "MFA observation failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.publicDenialAndReviewerAccess, "mfaObserved", false);
      },
      "public denial or sole-reviewer/MFA observation is invalid",
    ],
    [
      "Production-only variable value exposure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.productionVariables, "valuesIncluded", true);
      },
      "Production-only variable-presence evidence is invalid",
    ],
    [
      "deployment promotion",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.deploymentPosture, "promoted", true);
      },
      "protection, no-domain, or no-promotion posture is invalid",
    ],
    [
      "independent verdict identity",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.independentReview, "runIdentity", "");
      },
      "independent run or verdict identity is invalid",
    ],
    [
      "access revocation failure",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet.access, "revoked", false);
      },
      "access expiry, revocation, or credential disposition is invalid",
    ],
    [
      "unexplained exception",
      (packet: ControlledEvidencePacket) => {
        Reflect.set(packet, "exceptions", [
          {
            summary: "provider residue",
            authority: "",
            consequence: "eligibility remains closed",
            disposition: "",
          },
        ]);
      },
      "an exception is unexplained",
    ],
  ] as const)("rejects %s with a specific reason", (_label, mutate, reason) => {
    expect(rejectionErrors(changed(mutate))).toContain(reason);
  });

  it.each([
    `credential=av1.${"A".repeat(43)}`,
    "https://candidate.vercel.app/?_vercel_share=share_bearer_value",
    "x-vercel-protection-bypass: automation_bearer_value",
  ])("rejects usable bearer material: %s", (content) => {
    const packet = changed((value) => {
      Reflect.set(value.members[0]!, "content", content);
    });
    expect(rejectionErrors(packet)).toContain(
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} contains usable credential material`,
    );
  });

  it("rejects an unbound member digest with the targeted reason", () => {
    const packet = changed((value) => {
      Reflect.set(value.members[0]!, "digest", "0".repeat(64));
    }, false);
    expect(rejectionErrors(packet)).toContain(
      `member ${CONTROLLED_EVIDENCE_MEMBERS[0]} digest is unbound`,
    );
  });

  it("rejects a post-hash edit with the targeted reason", () => {
    const packet = changed((value) => {
      Reflect.set(value.cleanup, "laterMarketingEligible", true);
    }, false);
    expect(rejectionErrors(packet)).toContain(
      "packet digest does not bind the final bytes",
    );
  });
});

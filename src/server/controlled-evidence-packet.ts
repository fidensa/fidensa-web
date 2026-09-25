import "server-only";

import { createHash } from "node:crypto";

export const CONTROLLED_EVIDENCE_CHECKLIST = "CE-02-v1.0";
export const CONTROLLED_EVIDENCE_CHECKLIST_DIGEST =
  "efe3dfb07e27d4cf8920a0b243cda94c02e5a951dc59fdff2718eca4877ecb95";

// This is an explicit projection of every semicolon-delimited evidence member
// in DESIGN-02-001 section 9.1. Structured packet fields below bind the facts;
// these named members bind the corresponding redacted observation bytes.
export const CONTROLLED_EVIDENCE_MEMBERS = [
  "synthetic-provenance",
  "zoned-times",
  "capture-actor",
  "commit-identity",
  "deployment-configuration",
  "checklist-identity-digest",
  "evidence-mode-result",
  "public-route-response-headers",
  "analytics-absence",
  "public-generic-behavior",
  "access-token-transport",
  "mailbox-events",
  "provider-events",
  "studio-pending-exclusion",
  "studio-queue",
  "studio-status-history",
  "studio-score",
  "studio-consent",
  "studio-communications",
  "public-denial",
  "sole-reviewer-mfa",
  "production-variable-presence",
  "protection-posture",
  "no-domain-posture",
  "no-promotion-posture",
  "source-currentness",
  "member-manifest-hashes",
  "redaction-attestation",
  "independent-run-verdict",
  "access-expiry-revocation",
  "cleanup",
  "no-marketing-eligibility",
] as const;

export type ControlledEvidenceCaptureActor =
  "scott_bishop" | "independent_reviewer" | "system";

export interface ControlledEvidenceMember {
  readonly name: (typeof CONTROLLED_EVIDENCE_MEMBERS)[number];
  readonly correlationId: string;
  readonly deploymentIdentity: string;
  readonly configurationDigest: string;
  readonly capturedAt: string;
  readonly capturedBy: ControlledEvidenceCaptureActor;
  readonly redacted: boolean;
  readonly content: string;
  readonly digest: string;
}

export interface ControlledEvidencePacket {
  readonly checklistIdentity: typeof CONTROLLED_EVIDENCE_CHECKLIST;
  readonly checklistDigest: string;
  readonly correlationId: string;
  readonly commitIdentity: string;
  readonly deploymentIdentity: string;
  readonly configurationDigest: string;
  readonly captureActor: "scott_bishop";
  readonly exerciseOpenedAt: string;
  readonly submittedAt: string;
  readonly verifiedAt: string;
  readonly reviewCompletedAt: string;
  readonly accessRevokedAt: string;
  readonly cleanupVerifiedAt: string;
  readonly evidenceMode: {
    readonly identity: "controlled-exercise";
    readonly result: "passed";
  };
  readonly publicDenialAndReviewerAccess: {
    readonly publicDenied: true;
    readonly soleReviewer: "scott_bishop";
    readonly mfaObserved: true;
  };
  readonly productionVariables: {
    readonly productionOnly: true;
    readonly presenceObserved: true;
    readonly valuesIncluded: false;
  };
  readonly deploymentPosture: {
    readonly protected: true;
    readonly automaticDomainAssigned: false;
    readonly promoted: false;
  };
  readonly independentReview: {
    readonly runIdentity: string;
    readonly verdict: "approve" | "reject";
    readonly independent: true;
    readonly completedAt: string;
  };
  readonly syntheticProvenance: {
    readonly synthetic: true;
    readonly identityNamespace: "synthetic.invalid";
    readonly containsRealPersonalData: false;
  };
  readonly redactionAttestation: {
    readonly complete: true;
    readonly actor: "scott_bishop";
    readonly attestedAt: string;
  };
  readonly access: {
    readonly expired: true;
    readonly revoked: true;
    readonly fixtureVerifierRevoked: true;
    readonly usableCredentialPresent: false;
  };
  readonly cleanup: {
    readonly applicationRows: 0;
    readonly verificationRows: 0;
    readonly acknowledgmentRows: 0;
    readonly statusAndScoreRows: 0;
    readonly communicationRows: 0;
    readonly subscriptionAndTopicRows: 0;
    readonly suppressionRows: 0;
    readonly providerEventRows: 0;
    readonly allowlistRows: 0;
    readonly abuseRows: 0;
    readonly privacyRows: 0;
    readonly jobRows: 0;
    readonly exerciseControlRows: 0;
    readonly providerContactRemoved: true;
    readonly providerTopicRemoved: true;
    readonly untaggedExerciseWindowRows: 0;
    readonly laterMarketingEligible: false;
    readonly resurrectionObserved: false;
    readonly onlyAcceptanceRecordRemains: true;
  };
  readonly exceptions: ReadonlyArray<{
    readonly summary: string;
    readonly authority: string;
    readonly consequence: string;
    readonly disposition: string;
  }>;
  readonly members: ReadonlyArray<ControlledEvidenceMember>;
  readonly memberManifestDigest: string;
  readonly packetDigest: string;
}

type PacketDraft = Omit<
  ControlledEvidencePacket,
  "members" | "memberManifestDigest" | "packetDigest"
> & {
  readonly members: ReadonlyArray<
    Omit<ControlledEvidenceMember, "digest"> & { readonly digest?: string }
  >;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function memberManifest(members: ReadonlyArray<ControlledEvidenceMember>) {
  return members
    .map((member) => `${member.name}:${member.digest}`)
    .sort()
    .join("\n");
}

function packetBinding(
  packet: Omit<ControlledEvidencePacket, "packetDigest">,
): string {
  return JSON.stringify({
    checklistIdentity: packet.checklistIdentity,
    checklistDigest: packet.checklistDigest,
    correlationId: packet.correlationId,
    commitIdentity: packet.commitIdentity,
    deploymentIdentity: packet.deploymentIdentity,
    configurationDigest: packet.configurationDigest,
    captureActor: packet.captureActor,
    exerciseOpenedAt: packet.exerciseOpenedAt,
    submittedAt: packet.submittedAt,
    verifiedAt: packet.verifiedAt,
    reviewCompletedAt: packet.reviewCompletedAt,
    accessRevokedAt: packet.accessRevokedAt,
    cleanupVerifiedAt: packet.cleanupVerifiedAt,
    evidenceMode: packet.evidenceMode,
    publicDenialAndReviewerAccess: packet.publicDenialAndReviewerAccess,
    productionVariables: packet.productionVariables,
    deploymentPosture: packet.deploymentPosture,
    independentReview: packet.independentReview,
    syntheticProvenance: packet.syntheticProvenance,
    redactionAttestation: packet.redactionAttestation,
    access: packet.access,
    cleanup: packet.cleanup,
    exceptions: packet.exceptions,
    members: packet.members,
    memberManifestDigest: packet.memberManifestDigest,
  });
}

export function sealControlledEvidencePacket(
  draft: PacketDraft,
): ControlledEvidencePacket {
  const members = draft.members.map((member) => ({
    ...member,
    digest: sha256(member.content),
  }));
  const memberManifestDigest = sha256(memberManifest(members));
  const bound = { ...draft, members, memberManifestDigest };
  return { ...bound, packetDigest: sha256(packetBinding(bound)) };
}

export type ControlledEvidenceValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const digestPattern = /^[0-9a-f]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const zonedTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const rawEmailPattern = /(?<!\*)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const usableCredentialPattern =
  /(?:av1\.[A-Za-z0-9_-]{43}|pr1\.[A-Za-z0-9_-]{22}|(?:secret|token|credential|api[_-]?key)\s*[:=]\s*\S+|(?:[?&]|\b)_vercel_share\s*=\s*[^\s&]+|x-vercel-protection-bypass\s*[:=]\s*\S+)/iu;
const captureActors = new Set<ControlledEvidenceCaptureActor>([
  "scott_bishop",
  "independent_reviewer",
  "system",
]);

function isZonedTimestamp(value: string): boolean {
  return (
    zonedTimestampPattern.test(value) && Number.isFinite(Date.parse(value))
  );
}

export function validateControlledEvidencePacket(
  packet: ControlledEvidencePacket,
): ControlledEvidenceValidation {
  const errors: string[] = [];
  const reject = (condition: boolean, message: string) => {
    if (condition) errors.push(message);
  };

  reject(
    packet.checklistIdentity !== CONTROLLED_EVIDENCE_CHECKLIST ||
      packet.checklistDigest !== CONTROLLED_EVIDENCE_CHECKLIST_DIGEST,
    "checklist identity or frozen design digest is invalid",
  );
  reject(!uuidPattern.test(packet.correlationId), "correlation is invalid");
  reject(!/^[0-9a-f]{40}$/u.test(packet.commitIdentity), "commit is invalid");
  reject(!packet.deploymentIdentity.trim(), "deployment identity is missing");
  reject(
    !digestPattern.test(packet.configurationDigest),
    "configuration digest is invalid",
  );
  reject(packet.captureActor !== "scott_bishop", "capture actor is invalid");
  reject(
    packet.evidenceMode.identity !== "controlled-exercise" ||
      packet.evidenceMode.result !== "passed",
    "evidence mode result is invalid",
  );
  reject(
    !packet.publicDenialAndReviewerAccess.publicDenied ||
      packet.publicDenialAndReviewerAccess.soleReviewer !== "scott_bishop" ||
      !packet.publicDenialAndReviewerAccess.mfaObserved,
    "public denial or sole-reviewer/MFA observation is invalid",
  );
  reject(
    !packet.productionVariables.productionOnly ||
      !packet.productionVariables.presenceObserved ||
      packet.productionVariables.valuesIncluded,
    "Production-only variable-presence evidence is invalid",
  );
  reject(
    !packet.deploymentPosture.protected ||
      packet.deploymentPosture.automaticDomainAssigned ||
      packet.deploymentPosture.promoted,
    "protection, no-domain, or no-promotion posture is invalid",
  );
  reject(
    !packet.independentReview.runIdentity.trim() ||
      !["approve", "reject"].includes(packet.independentReview.verdict) ||
      !packet.independentReview.independent,
    "independent run or verdict identity is invalid",
  );

  const requiredMembers = new Set<string>(CONTROLLED_EVIDENCE_MEMBERS);
  const names = new Set<string>();
  for (const member of packet.members) {
    reject(names.has(member.name), `member ${member.name} is duplicated`);
    names.add(member.name);
    requiredMembers.delete(member.name);
    reject(
      member.correlationId !== packet.correlationId,
      `member ${member.name} has mixed correlation`,
    );
    reject(
      member.configurationDigest !== packet.configurationDigest,
      `member ${member.name} has mixed configuration`,
    );
    reject(
      member.deploymentIdentity !== packet.deploymentIdentity,
      `member ${member.name} has mixed deployment`,
    );
    reject(
      !captureActors.has(member.capturedBy),
      `member ${member.name} capture actor is invalid`,
    );
    reject(!member.redacted, `member ${member.name} is not redacted`);
    reject(
      rawEmailPattern.test(member.content),
      `member ${member.name} contains an unredacted address`,
    );
    reject(
      usableCredentialPattern.test(member.content),
      `member ${member.name} contains usable credential material`,
    );
    reject(
      member.digest !== sha256(member.content),
      `member ${member.name} digest is unbound`,
    );
  }
  for (const name of requiredMembers) {
    errors.push(`required member ${name} is missing`);
  }
  reject(
    packet.memberManifestDigest !== sha256(memberManifest(packet.members)),
    "member manifest digest is unbound",
  );
  reject(
    packet.packetDigest !==
      sha256(
        packetBinding(packet as Omit<ControlledEvidencePacket, "packetDigest">),
      ),
    "packet digest does not bind the final bytes",
  );

  const packetTimes = [
    packet.exerciseOpenedAt,
    packet.submittedAt,
    packet.verifiedAt,
    packet.reviewCompletedAt,
    packet.accessRevokedAt,
    packet.cleanupVerifiedAt,
  ];
  reject(
    packetTimes.some((value) => !isZonedTimestamp(value)) ||
      !isZonedTimestamp(packet.independentReview.completedAt) ||
      !isZonedTimestamp(packet.redactionAttestation.attestedAt) ||
      packet.members.some((member) => !isZonedTimestamp(member.capturedAt)),
    "all evidence timestamps must include an explicit zone",
  );
  const chronology = packetTimes.map((value) => Date.parse(value));
  reject(
    chronology.some((value) => !Number.isFinite(value)) ||
      chronology.some(
        (value, index) => index > 0 && value < chronology[index - 1]!,
      ),
    "packet chronology is invalid",
  );
  reject(
    packet.members.some(
      (member) =>
        !Number.isFinite(Date.parse(member.capturedAt)) ||
        Date.parse(member.capturedAt) < chronology[0]! ||
        Date.parse(member.capturedAt) > chronology.at(-1)!,
    ),
    "member chronology is invalid",
  );
  reject(
    Date.parse(packet.independentReview.completedAt) !==
      Date.parse(packet.reviewCompletedAt),
    "independent review completion is not bound to packet chronology",
  );
  reject(
    !packet.redactionAttestation.complete ||
      packet.redactionAttestation.actor !== "scott_bishop" ||
      !Number.isFinite(Date.parse(packet.redactionAttestation.attestedAt)) ||
      Date.parse(packet.redactionAttestation.attestedAt) < chronology[0]! ||
      Date.parse(packet.redactionAttestation.attestedAt) > chronology.at(-1)!,
    "redaction attestation is invalid",
  );
  reject(
    !packet.syntheticProvenance.synthetic ||
      packet.syntheticProvenance.identityNamespace !== "synthetic.invalid" ||
      packet.syntheticProvenance.containsRealPersonalData,
    "synthetic provenance is invalid",
  );
  reject(
    !packet.access.expired ||
      !packet.access.revoked ||
      !packet.access.fixtureVerifierRevoked ||
      packet.access.usableCredentialPresent,
    "access expiry, revocation, or credential disposition is invalid",
  );
  reject(
    Object.entries(packet.cleanup).some(([key, value]) =>
      key.endsWith("Rows") ? value !== 0 : false,
    ) ||
      !packet.cleanup.providerContactRemoved ||
      !packet.cleanup.providerTopicRemoved ||
      packet.cleanup.laterMarketingEligible ||
      packet.cleanup.resurrectionObserved ||
      !packet.cleanup.onlyAcceptanceRecordRemains,
    "cleanup or no-marketing-eligibility proof is incomplete",
  );
  reject(
    packet.exceptions.some(
      (exception) =>
        !exception.summary.trim() ||
        !exception.authority.trim() ||
        !exception.consequence.trim() ||
        !exception.disposition.trim(),
    ),
    "an exception is unexplained",
  );

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

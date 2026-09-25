import "server-only";

type Fetch = typeof fetch;

export interface ApplicationSubmissionRecord {
  readonly synthetic: boolean;
  readonly canonicalEmail: string;
  readonly deliveryEmail: string;
  readonly operationDigest: string;
  readonly verificationDigest: string;
  readonly ipDigest: string;
  readonly emailDigest: string;
  readonly applicantName: string;
  readonly roleFunction: string;
  readonly context: "Work" | "Personal" | "Both";
  readonly organization: string | null;
  readonly intendedUseCase: string;
  readonly workflowStage: string;
  readonly deploymentPreference:
    | "Fidensa-managed cloud"
    | "Customer cloud"
    | "Private/on-premises"
    | "Hybrid"
    | "Not sure yet";
  readonly evaluationTimeline:
    | "Within 30 days"
    | "1–3 months"
    | "3–6 months"
    | "More than 6 months"
    | "No fixed timeline";
  readonly designPartnerWillingness: "Yes" | "Maybe" | "No";
  readonly integrationConstraints: string | null;
  readonly referralSource: string | null;
  readonly additionalContext: string | null;
  readonly noticeVersion: string;
  readonly marketingSelected: boolean;
  readonly consentTextVersion: string | null;
}

export interface ApplicationDeliveryIntent {
  readonly applicationId: string;
  readonly deliveryEmail: string;
  readonly operationId: string;
}

export interface VerificationDeliveryIntents {
  readonly applicationId: string;
  readonly deliveryEmail: string;
  readonly receiptOperationId: string;
  readonly reviewerOperationId: string;
}

export type ApplicationMessageOutcome =
  "accepted_by_provider" | "delivery_unknown" | "failed";

export type ApplicationMessageEscalationReason =
  "credential_unavailable" | "provider_window_expired" | "attempt_cap_reached";

export interface ApplicationMessageClaim {
  readonly applicationId: string;
  readonly deliveryEmail: string;
  readonly operationId: string;
  readonly messageType:
    | "application_verification"
    | "application_receipt"
    | "reviewer_notification";
  readonly providerMessageId: string | null;
  readonly reconciliation: boolean;
  readonly attemptCount: number;
  readonly firstAttemptAt: string | null;
}

export interface ApplicationDatabase {
  submit(
    record: ApplicationSubmissionRecord,
  ): Promise<ApplicationDeliveryIntent | null>;
  verify(
    credentialDigest: string,
    ipDigest: string,
  ): Promise<VerificationDeliveryIntents | null>;
  resendVerification(
    canonicalEmail: string,
    credentialDigest: string,
    ipDigest: string,
    emailDigest: string,
  ): Promise<ApplicationDeliveryIntent | null>;
  claimMessage(operationId?: string): Promise<ApplicationMessageClaim | null>;
  recordMessageOutcome(
    operationId: string,
    outcome: ApplicationMessageOutcome,
    providerMessageDigest: string | null,
    providerMessageId: string | null,
  ): Promise<void>;
  escalateMessage(
    operationId: string,
    reason: ApplicationMessageEscalationReason,
  ): Promise<void>;
  recordHoneypot(ipDigest: string, emailDigest: string): Promise<void>;
}

interface SupabaseApplicationDatabaseOptions {
  readonly baseUrl: string;
  readonly serviceCredential: string;
  readonly fetchImplementation?: Fetch;
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(
      "The database API origin must use HTTPS outside local development.",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function deliveryIntent(value: unknown): ApplicationDeliveryIntent | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !isUuid(Reflect.get(value, "applicationId")) ||
    !isUuid(Reflect.get(value, "operationId")) ||
    typeof Reflect.get(value, "deliveryEmail") !== "string" ||
    String(Reflect.get(value, "deliveryEmail")).length > 254
  ) {
    throw new Error(
      "Application database returned a malformed delivery intent.",
    );
  }
  return value as ApplicationDeliveryIntent;
}

function verificationIntents(
  value: unknown,
): VerificationDeliveryIntents | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !isUuid(Reflect.get(value, "applicationId")) ||
    !isUuid(Reflect.get(value, "receiptOperationId")) ||
    !isUuid(Reflect.get(value, "reviewerOperationId")) ||
    typeof Reflect.get(value, "deliveryEmail") !== "string" ||
    String(Reflect.get(value, "deliveryEmail")).length > 254
  ) {
    throw new Error(
      "Application database returned malformed verification intents.",
    );
  }
  return value as VerificationDeliveryIntents;
}

function messageClaim(value: unknown): ApplicationMessageClaim | null {
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new Error("Application database returned a malformed message claim.");
  }
  const messageType = Reflect.get(value as object, "messageType");
  const providerMessageId = Reflect.get(value as object, "providerMessageId");
  const firstAttemptAt = Reflect.get(value as object, "firstAttemptAt");
  if (
    !isUuid(Reflect.get(value, "applicationId")) ||
    !isUuid(Reflect.get(value, "operationId")) ||
    typeof Reflect.get(value, "deliveryEmail") !== "string" ||
    String(Reflect.get(value, "deliveryEmail")).length > 254 ||
    ![
      "application_verification",
      "application_receipt",
      "reviewer_notification",
    ].includes(String(messageType)) ||
    (providerMessageId !== null &&
      (typeof providerMessageId !== "string" ||
        providerMessageId.length > 200)) ||
    typeof Reflect.get(value, "reconciliation") !== "boolean" ||
    !Number.isInteger(Reflect.get(value, "attemptCount")) ||
    Number(Reflect.get(value, "attemptCount")) < 1 ||
    (firstAttemptAt !== null &&
      (typeof firstAttemptAt !== "string" ||
        !Number.isFinite(Date.parse(firstAttemptAt))))
  ) {
    throw new Error("Application database returned a malformed message claim.");
  }
  return value as ApplicationMessageClaim;
}

export function createSupabaseApplicationDatabase({
  baseUrl,
  serviceCredential,
  fetchImplementation = fetch,
}: SupabaseApplicationDatabaseOptions): ApplicationDatabase {
  const origin = validatedBaseUrl(baseUrl);
  if (serviceCredential.length < 32) {
    throw new Error(
      "The server data-access credential is missing or malformed.",
    );
  }

  async function rpc<T>(
    operation: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetchImplementation(
      `${origin}/rest/v1/rpc/${operation}`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Accept-Profile": "fidensa_api",
          apikey: serviceCredential,
          Authorization: `Bearer ${serviceCredential}`,
          "Content-Profile": "fidensa_api",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      // Provider response bodies can contain database detail. Never reflect or
      // log them, and never include the credential in an error.
      throw new Error(
        `Application database operation failed (${response.status}).`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    async submit(record) {
      assertDigest(record.operationDigest, "Operation identity");
      assertDigest(record.verificationDigest, "Verification identity");
      assertDigest(record.ipDigest, "IP key");
      assertDigest(record.emailDigest, "Email key");
      return deliveryIntent(
        await rpc<unknown>("submit_application_intake", {
          p_synthetic: record.synthetic,
          p_canonical_email: record.canonicalEmail,
          p_delivery_email: record.deliveryEmail,
          p_operation_digest: record.operationDigest,
          p_credential_digest: record.verificationDigest,
          p_ip_digest: record.ipDigest,
          p_email_digest: record.emailDigest,
          p_applicant_name: record.applicantName,
          p_role_function: record.roleFunction,
          p_context: record.context,
          p_organization: record.organization,
          p_intended_use_case: record.intendedUseCase,
          p_workflow_stage: record.workflowStage,
          p_deployment_preference: record.deploymentPreference,
          p_evaluation_timeline: record.evaluationTimeline,
          p_design_partner_willingness: record.designPartnerWillingness,
          p_integration_constraints: record.integrationConstraints,
          p_referral_source: record.referralSource,
          p_additional_context: record.additionalContext,
          p_notice_version: record.noticeVersion,
          p_marketing_selected: record.marketingSelected,
          p_consent_text_version: record.consentTextVersion,
        }),
      );
    },

    async verify(credentialDigest, ipDigest) {
      assertDigest(credentialDigest, "Verification identity");
      assertDigest(ipDigest, "IP key");
      return verificationIntents(
        await rpc<unknown>("verify_application_intake", {
          p_credential_digest: credentialDigest,
          p_ip_digest: ipDigest,
        }),
      );
    },

    async resendVerification(
      canonicalEmail,
      credentialDigest,
      ipDigest,
      emailDigest,
    ) {
      assertDigest(credentialDigest, "Verification identity");
      assertDigest(ipDigest, "IP key");
      assertDigest(emailDigest, "Email key");
      return deliveryIntent(
        await rpc<unknown>("resend_application_verification_intake", {
          p_canonical_email: canonicalEmail,
          p_credential_digest: credentialDigest,
          p_ip_digest: ipDigest,
          p_email_digest: emailDigest,
        }),
      );
    },

    async claimMessage(operationId) {
      if (operationId !== undefined && !isUuid(operationId)) {
        throw new Error("Message operation identity must be a UUID.");
      }
      return messageClaim(
        await rpc<unknown>("claim_application_message", {
          p_operation_id: operationId ?? null,
        }),
      );
    },

    async recordMessageOutcome(
      operationId,
      outcome,
      providerMessageDigest,
      providerMessageId,
    ) {
      if (!isUuid(operationId)) {
        throw new Error("Message operation identity must be a UUID.");
      }
      if (
        !["accepted_by_provider", "delivery_unknown", "failed"].includes(
          outcome,
        )
      ) {
        throw new Error("Message outcome is malformed.");
      }
      if (
        providerMessageDigest !== null &&
        !/^[0-9a-f]{64}$/u.test(providerMessageDigest)
      ) {
        throw new Error("Provider message identity must be a digest.");
      }
      if (
        providerMessageId !== null &&
        (providerMessageId.length === 0 || providerMessageId.length > 200)
      ) {
        throw new Error("Provider message identifier is malformed.");
      }
      await rpc<null>("record_application_message_outcome", {
        p_operation_id: operationId,
        p_outcome: outcome,
        p_provider_message_digest: providerMessageDigest,
        p_provider_message_id: providerMessageId,
      });
    },

    async escalateMessage(operationId, reason) {
      if (!isUuid(operationId)) {
        throw new Error("Message operation identity must be a UUID.");
      }
      if (
        ![
          "credential_unavailable",
          "provider_window_expired",
          "attempt_cap_reached",
        ].includes(reason)
      ) {
        throw new Error("Message escalation reason is malformed.");
      }
      await rpc<null>("escalate_application_message", {
        p_operation_id: operationId,
        p_reason: reason,
      });
    },

    async recordHoneypot(ipDigest, emailDigest) {
      assertDigest(ipDigest, "IP key");
      assertDigest(emailDigest, "Email key");
      await rpc<null>("record_application_honeypot", {
        p_ip_digest: ipDigest,
        p_email_digest: emailDigest,
      });
    },
  };
}

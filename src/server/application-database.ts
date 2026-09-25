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

export interface ApplicationDatabase {
  submit(record: ApplicationSubmissionRecord): Promise<string | null>;
  verify(credentialDigest: string, ipDigest: string): Promise<boolean>;
  resendVerification(
    canonicalEmail: string,
    credentialDigest: string,
    ipDigest: string,
    emailDigest: string,
  ): Promise<boolean>;
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
      return rpc<string | null>("submit_application", {
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
      });
    },

    async verify(credentialDigest, ipDigest) {
      assertDigest(credentialDigest, "Verification identity");
      assertDigest(ipDigest, "IP key");
      return rpc<boolean>("verify_application", {
        p_credential_digest: credentialDigest,
        p_ip_digest: ipDigest,
      });
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
      return rpc<boolean>("resend_application_verification", {
        p_canonical_email: canonicalEmail,
        p_credential_digest: credentialDigest,
        p_ip_digest: ipDigest,
        p_email_digest: emailDigest,
      });
    },
  };
}

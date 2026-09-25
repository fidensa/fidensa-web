import { toASCII, toUnicode } from "tr46";

export const APPLICATION_LIMITS = {
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
} as const;

export const PRIVACY_NOTICE_VERSION = "privacy-notice-v1";
export const MARKETING_CONSENT_VERSION = "marketing-consent-v1";
export const MARKETING_CONSENT_TEXT =
  "Send me launch announcements and general product updates.";

export const APPLICATION_CONTEXTS = ["Work", "Personal", "Both"] as const;
export const DEPLOYMENT_PREFERENCES = [
  "Fidensa-managed cloud",
  "Customer cloud",
  "Private/on-premises",
  "Hybrid",
  "Not sure yet",
] as const;
export const EVALUATION_TIMELINES = [
  "Within 30 days",
  "1–3 months",
  "3–6 months",
  "More than 6 months",
  "No fixed timeline",
] as const;
export const DESIGN_PARTNER_ANSWERS = ["Yes", "Maybe", "No"] as const;

export type ApplicationContext = (typeof APPLICATION_CONTEXTS)[number];
export type DeploymentPreference = (typeof DEPLOYMENT_PREFERENCES)[number];
export type EvaluationTimeline = (typeof EVALUATION_TIMELINES)[number];
export type DesignPartnerAnswer = (typeof DESIGN_PARTNER_ANSWERS)[number];

export type ApplicationField =
  | "operationKey"
  | "name"
  | "email"
  | "roleFunction"
  | "context"
  | "organization"
  | "intendedUseCase"
  | "workflowStage"
  | "deploymentPreference"
  | "evaluationTimeline"
  | "designPartnerWillingness"
  | "integrationConstraints"
  | "referralSource"
  | "additionalContext"
  | "privacyAcknowledged"
  | "marketingSelected"
  | "companyWebsite";

export interface ApplicationSubmission {
  readonly operationKey: string;
  readonly name: string;
  readonly canonicalEmail: string;
  readonly deliveryEmail: string;
  readonly roleFunction: string;
  readonly context: ApplicationContext;
  readonly organization: string | null;
  readonly intendedUseCase: string;
  readonly workflowStage: string;
  readonly deploymentPreference: DeploymentPreference;
  readonly evaluationTimeline: EvaluationTimeline;
  readonly designPartnerWillingness: DesignPartnerAnswer;
  readonly integrationConstraints: string | null;
  readonly referralSource: string | null;
  readonly additionalContext: string | null;
  readonly privacyAcknowledged: true;
  readonly marketingSelected: boolean;
  readonly companyWebsite: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<ApplicationField | "request", string>>;
    };

const submissionKeys = new Set<ApplicationField>([
  "operationKey",
  "name",
  "email",
  "roleFunction",
  "context",
  "organization",
  "intendedUseCase",
  "workflowStage",
  "deploymentPreference",
  "evaluationTimeline",
  "designPartnerWillingness",
  "integrationConstraints",
  "referralSource",
  "additionalContext",
  "privacyAcknowledged",
  "marketingSelected",
  "companyWebsite",
]);

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" ? value.normalize("NFC").trim() : null;
}

function validateText(
  input: Record<string, unknown>,
  field: ApplicationField,
  maximum: number,
  errors: Partial<Record<ApplicationField | "request", string>>,
  required: boolean,
): string | null {
  const value = normalizedText(input[field]);
  if (value === null) {
    errors[field] = "Enter text in the expected format.";
    return null;
  }
  if (required && value.length === 0) {
    errors[field] = "This field is required.";
  } else if (Array.from(value).length > maximum) {
    errors[field] =
      `Use ${maximum.toLocaleString("en-US")} characters or fewer.`;
  }
  return value || null;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | null {
  return typeof value === "string" && allowed.includes(value)
    ? (value as T[number])
    : null;
}

export function normalizeEmailAddress(
  value: unknown,
): { readonly canonical: string; readonly delivery: string } | null {
  const delivery = normalizedText(value);
  if (!delivery || Array.from(delivery).length > APPLICATION_LIMITS.email) {
    return null;
  }
  const separator = delivery.lastIndexOf("@");
  if (separator <= 0 || separator === delivery.length - 1) return null;
  const local = delivery.slice(0, separator);
  const domain = delivery.slice(separator + 1);
  if (
    !/^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/iu.test(
      local,
    )
  ) {
    return null;
  }
  if (
    /[\u0000-\u0020\u007f/\\?#:@\[\]]/u.test(domain) ||
    domain.endsWith(".") ||
    Array.from(domain).some(
      (character) =>
        character.codePointAt(0)! < 128 && !/[A-Z0-9.-]/iu.test(character),
    )
  ) {
    return null;
  }
  const idnaOptions = {
    checkBidi: true,
    checkHyphens: true,
    checkJoiners: true,
    transitionalProcessing: false,
    useSTD3ASCIIRules: true,
  } as const;
  const asciiDomain = toASCII(domain, {
    ...idnaOptions,
    verifyDNSLength: true,
  });
  if (!asciiDomain) return null;
  if (
    !asciiDomain.includes(".") ||
    asciiDomain.length > 253 ||
    !/^[a-z0-9.-]+$/u.test(asciiDomain) ||
    asciiDomain.split(".").some((label) => {
      return (
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-")
      );
    }) ||
    /^\d+$/u.test(asciiDomain.split(".").at(-1) ?? "")
  ) {
    return null;
  }
  const normalizedUnicodeDomain = domain.toLowerCase().normalize("NFC");
  const unicodeResult = toUnicode(asciiDomain, idnaOptions);
  if (unicodeResult.error) return null;
  const roundTrippedDomain = unicodeResult.domain
    .toLowerCase()
    .normalize("NFC");
  if (
    normalizedUnicodeDomain !== asciiDomain &&
    roundTrippedDomain !== normalizedUnicodeDomain
  )
    return null;
  const canonical = `${local.toLowerCase()}@${asciiDomain}`;
  if (canonical.length > APPLICATION_LIMITS.email) return null;
  // The local part may differ only by ASCII case. A U-label domain is retained
  // for delivery only when its canonical A-label decodes to the exact NFC
  // spelling supplied by the applicant, apart from case.
  if (local !== local.normalize("NFC") || !/^[\x21-\x7e]+$/u.test(local))
    return null;
  return { canonical, delivery };
}

export function parseApplicationSubmission(
  input: unknown,
): ValidationResult<ApplicationSubmission> {
  if (!isRecord(input)) {
    return { ok: false, errors: { request: "Submit a JSON object." } };
  }
  const errors: Partial<Record<ApplicationField | "request", string>> = {};
  const extraKeys = Object.keys(input).filter(
    (key) => !submissionKeys.has(key as ApplicationField),
  );
  if (extraKeys.length > 0) {
    errors.request = "The request contains unsupported fields.";
  }

  const operationKey = normalizedText(input.operationKey);
  if (!operationKey || !/^[A-Za-z0-9_-]{22}$/u.test(operationKey)) {
    errors.operationKey = "Start a new form and try again.";
  }
  const name = validateText(
    input,
    "name",
    APPLICATION_LIMITS.name,
    errors,
    true,
  );
  const email = normalizeEmailAddress(input.email);
  if (!email) errors.email = "Enter a valid email address.";
  const roleFunction = validateText(
    input,
    "roleFunction",
    APPLICATION_LIMITS.roleFunction,
    errors,
    true,
  );
  const context = enumValue(input.context, APPLICATION_CONTEXTS);
  if (!context) errors.context = "Choose work, personal, or both.";
  const organization = validateText(
    input,
    "organization",
    APPLICATION_LIMITS.organization,
    errors,
    context === "Work" || context === "Both",
  );
  const intendedUseCase = validateText(
    input,
    "intendedUseCase",
    APPLICATION_LIMITS.intendedUseCase,
    errors,
    true,
  );
  const workflowStage = validateText(
    input,
    "workflowStage",
    APPLICATION_LIMITS.workflowStage,
    errors,
    true,
  );
  const deploymentPreference = enumValue(
    input.deploymentPreference,
    DEPLOYMENT_PREFERENCES,
  );
  if (!deploymentPreference) {
    errors.deploymentPreference = "Choose a deployment preference.";
  }
  const evaluationTimeline = enumValue(
    input.evaluationTimeline,
    EVALUATION_TIMELINES,
  );
  if (!evaluationTimeline) {
    errors.evaluationTimeline = "Choose an evaluation timeline.";
  }
  const designPartnerWillingness = enumValue(
    input.designPartnerWillingness,
    DESIGN_PARTNER_ANSWERS,
  );
  if (!designPartnerWillingness) {
    errors.designPartnerWillingness = "Choose yes, maybe, or no.";
  }
  const integrationConstraints = validateText(
    input,
    "integrationConstraints",
    APPLICATION_LIMITS.integrationConstraints,
    errors,
    false,
  );
  const referralSource = validateText(
    input,
    "referralSource",
    APPLICATION_LIMITS.referralSource,
    errors,
    false,
  );
  const additionalContext = validateText(
    input,
    "additionalContext",
    APPLICATION_LIMITS.additionalContext,
    errors,
    false,
  );
  if (input.privacyAcknowledged !== true) {
    errors.privacyAcknowledged =
      "Acknowledge that you read the Privacy Notice.";
  }
  if (typeof input.marketingSelected !== "boolean") {
    errors.marketingSelected = "Choose whether to receive product updates.";
  }
  const companyWebsite = normalizedText(input.companyWebsite);
  if (companyWebsite === null || Array.from(companyWebsite).length > 200) {
    errors.companyWebsite = "The anti-abuse field is malformed.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      operationKey: operationKey!,
      name: name!,
      canonicalEmail: email!.canonical,
      deliveryEmail: email!.delivery,
      roleFunction: roleFunction!,
      context: context!,
      organization,
      intendedUseCase: intendedUseCase!,
      workflowStage: workflowStage!,
      deploymentPreference: deploymentPreference!,
      evaluationTimeline: evaluationTimeline!,
      designPartnerWillingness: designPartnerWillingness!,
      integrationConstraints,
      referralSource,
      additionalContext,
      privacyAcknowledged: true,
      marketingSelected: input.marketingSelected as boolean,
      companyWebsite: companyWebsite!,
    },
  };
}

export interface ResendRequest {
  readonly canonicalEmail: string;
  readonly deliveryEmail: string;
}

export function parseResendRequest(
  input: unknown,
):
  | { readonly ok: true; readonly value: ResendRequest }
  | { readonly ok: false; readonly errors: { readonly email: string } } {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "email")) {
    return { ok: false, errors: { email: "Enter a valid email address." } };
  }
  const email = normalizeEmailAddress(input.email);
  return email
    ? {
        ok: true,
        value: {
          canonicalEmail: email.canonical,
          deliveryEmail: email.delivery,
        },
      }
    : { ok: false, errors: { email: "Enter a valid email address." } };
}

export function parseVerificationRequest(
  input: unknown,
): { readonly ok: true; readonly credential: string } | { readonly ok: false } {
  if (!isRecord(input) || Object.keys(input).length !== 1) return { ok: false };
  return typeof input.credential === "string" &&
    /^av1\.[A-Za-z0-9_-]{43}$/u.test(input.credential)
    ? { ok: true, credential: input.credential }
    : { ok: false };
}

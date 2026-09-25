import "server-only";

import { normalizeEmailAddress } from "../application/contract";
import { readBoundedJson } from "./bounded-json";

export const GENERIC_PRIVACY_RESPONSE =
  "Your privacy request has been received. If confirmation or additional information is needed, Fidensa will contact you.";

export const PRIVACY_REQUEST_TYPES = [
  "access",
  "correction",
  "export",
  "deletion",
] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export type ExceptionalProofReason =
  "mismatch" | "suspected_fraud" | "inaccessible_email" | "representative";

export interface PrivacyIntake {
  readonly operationKey: string;
  readonly type: PrivacyRequestType;
  readonly canonicalEmail: string;
  readonly deliveryEmail: string;
  readonly explanation: string | null;
  readonly matchingName: string | null;
  readonly matchingOrganization: string | null;
  readonly matchingSubmissionDate: string | null;
}

export interface PrivacyRequestStore {
  createRequest(
    input: PrivacyIntake,
    rateKeys: {
      readonly ipDigest: string;
      readonly emailDigest: string;
    },
  ): Promise<void>;
  consumeConfirmation(credentialDigest: string): Promise<boolean>;
}

export const GENERIC_PRIVACY_CONFIRMATION_RESPONSE =
  "If the confirmation is valid and current, the privacy request has been confirmed.";

export function createPrivacyConfirmationHandler(options: {
  readonly store: Pick<PrivacyRequestStore, "consumeConfirmation">;
  readonly digestCredential: (credential: string) => string;
}) {
  return async function handle(request: Request): Promise<Response> {
    let credential: string | null = null;
    try {
      const value = await readBoundedJson(request, 128 * 1024);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof Reflect.get(value, "credential") !== "string"
      ) {
        throw new Error();
      }
      credential = Reflect.get(value, "credential") as string;
      if (!/^pr1\.[A-Za-z0-9_-]{22}$/u.test(credential)) throw new Error();
    } catch {
      return Response.json(
        { message: GENERIC_PRIVACY_CONFIRMATION_RESPONSE },
        { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    await options.store
      .consumeConfirmation(options.digestCredential(credential))
      .catch(() => false);
    return Response.json(
      { message: GENERIC_PRIVACY_CONFIRMATION_RESPONSE },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  };
}

function boundedText(
  value: unknown,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  if (Array.from(normalized).length > maximum) return undefined;
  return normalized || null;
}

export function parsePrivacyIntake(value: unknown): PrivacyIntake | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "operationKey",
    "type",
    "email",
    "explanation",
    "matchingName",
    "matchingOrganization",
    "matchingSubmissionDate",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const email = normalizeEmailAddress(input.email);
  const explanation = boundedText(input.explanation, 1_000);
  const matchingName = boundedText(input.matchingName, 120);
  const matchingOrganization = boundedText(input.matchingOrganization, 160);
  if (
    !email ||
    typeof input.operationKey !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(input.operationKey) ||
    typeof input.type !== "string" ||
    !PRIVACY_REQUEST_TYPES.includes(input.type as PrivacyRequestType) ||
    explanation === undefined ||
    matchingName === undefined ||
    matchingOrganization === undefined
  ) {
    return null;
  }
  let matchingSubmissionDate: string | null = null;
  if (input.matchingSubmissionDate) {
    if (
      typeof input.matchingSubmissionDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(input.matchingSubmissionDate) ||
      !Number.isFinite(Date.parse(`${input.matchingSubmissionDate}T00:00:00Z`))
    ) {
      return null;
    }
    matchingSubmissionDate = input.matchingSubmissionDate;
  }
  return {
    operationKey: input.operationKey,
    type: input.type as PrivacyRequestType,
    canonicalEmail: email.canonical,
    deliveryEmail: email.delivery,
    explanation,
    matchingName,
    matchingOrganization,
    matchingSubmissionDate,
  };
}

export function requiredIdentityMethod(input: {
  readonly type: PrivacyRequestType | "unsubscribe";
  readonly emailConfirmed: boolean;
  readonly existingDetailsMatch: boolean;
  readonly exceptionalReason?: ExceptionalProofReason;
}): "none" | "email_confirmation" | "matching_details" | "formal_proof" {
  if (input.type === "unsubscribe") return "none";
  if (input.exceptionalReason) return "formal_proof";
  if (!input.emailConfirmed) return "email_confirmation";
  if (
    (input.type === "access" || input.type === "export") &&
    !input.existingDetailsMatch
  ) {
    return "matching_details";
  }
  return "email_confirmation";
}

export function createPrivacyIntakeHandler(options: {
  readonly store: Pick<PrivacyRequestStore, "createRequest">;
  readonly digestOperationKey: (operationKey: string) => string;
  readonly digestIpIdentity: (ip: string) => string;
  readonly digestEmailIdentity: (email: string) => string;
  readonly requestIpIdentity: (request: Request) => string;
}) {
  return async function handle(request: Request): Promise<Response> {
    let parsed: PrivacyIntake | null = null;
    try {
      parsed = parsePrivacyIntake(await readBoundedJson(request, 128 * 1024));
    } catch {
      return Response.json(
        { errors: { request: "Submit a valid bounded privacy request." } },
        { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    if (!parsed) {
      return Response.json(
        { errors: { request: "Submit a valid bounded privacy request." } },
        { status: 422, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    await options.store
      .createRequest(
        {
          ...parsed,
          operationKey: options.digestOperationKey(parsed.operationKey),
        },
        {
          ipDigest: options.digestIpIdentity(
            options.requestIpIdentity(request),
          ),
          emailDigest: options.digestEmailIdentity(parsed.canonicalEmail),
        },
      )
      .catch(() => undefined);
    return Response.json(
      { message: GENERIC_PRIVACY_RESPONSE },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  };
}

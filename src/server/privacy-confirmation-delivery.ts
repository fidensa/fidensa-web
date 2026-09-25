import "server-only";

import { createHash } from "node:crypto";

import {
  digestPrivacyConfirmationCredential,
  issuePrivacyConfirmationCredential,
} from "./application-crypto";

export interface PrivacyConfirmationClaim {
  readonly intentId: string;
  readonly privacyRequestId: string;
  readonly generation: number;
  readonly recipient: string;
  readonly operationId: string;
}

export interface PrivacyConfirmationDeliveryStore {
  claimPrivacyConfirmation(): Promise<PrivacyConfirmationClaim | null>;
  issuePrivacyConfirmation(
    intentId: string,
    credentialDigest: string,
  ): Promise<void>;
  recordPrivacyConfirmationDelivery(
    intentId: string,
    outcome: "accepted_by_provider" | "delivery_unknown" | "failed",
    providerMessageDigest: string | null,
  ): Promise<void>;
}

export interface PrivacyConfirmationSender {
  deliver(input: {
    readonly recipient: string;
    readonly operationId: string;
    readonly confirmationUrl: string;
  }): Promise<{
    readonly outcome: "accepted_by_provider" | "delivery_unknown" | "failed";
    readonly providerMessageDigest: string | null;
  }>;
}

export async function deliverOnePrivacyConfirmation(options: {
  readonly store: PrivacyConfirmationDeliveryStore;
  readonly sender: PrivacyConfirmationSender;
  readonly tokenMaterial: string;
  readonly siteOrigin: string;
}): Promise<boolean> {
  const claim = await options.store.claimPrivacyConfirmation();
  if (!claim) return false;
  const credential = issuePrivacyConfirmationCredential();
  const digest = digestPrivacyConfirmationCredential(
    options.tokenMaterial,
    credential,
  );
  await options.store.issuePrivacyConfirmation(claim.intentId, digest);
  const url = new URL("/privacy/confirm", options.siteOrigin);
  url.hash = credential;
  let result: Awaited<ReturnType<PrivacyConfirmationSender["deliver"]>>;
  try {
    result = await options.sender.deliver({
      recipient: claim.recipient,
      operationId: claim.operationId,
      confirmationUrl: url.toString(),
    });
  } catch {
    result = { outcome: "delivery_unknown", providerMessageDigest: null };
  }
  await options.store.recordPrivacyConfirmationDelivery(
    claim.intentId,
    result.outcome,
    result.providerMessageDigest,
  );
  return true;
}

export function createResendPrivacyConfirmationSender(options: {
  readonly accessCredential: string;
  readonly fetchImplementation?: typeof fetch;
}): PrivacyConfirmationSender {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  if (options.accessCredential.length < 32) {
    throw new Error("The privacy confirmation provider is not configured.");
  }
  return {
    async deliver(input) {
      let response: Response;
      try {
        response = await fetchImplementation("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.accessCredential}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.operationId,
          },
          body: JSON.stringify({
            from: "Fidensa Privacy <apply@fidensa.com>",
            to: [input.recipient],
            reply_to: "privacy@fidensa.com",
            subject: "Confirm your Fidensa privacy request",
            text: [
              "Scott Bishop manually initiated this confirmation for a privacy request.",
              "Open the single-use link below to confirm mailbox control:",
              "",
              input.confirmationUrl,
              "",
              "The link expires in 30 minutes. If you did not make a request, ignore this message or contact privacy@fidensa.com.",
            ].join("\n"),
          }),
        });
      } catch {
        return { outcome: "delivery_unknown", providerMessageDigest: null };
      }
      const body = await response
        .json()
        .catch(() => ({}) as Record<string, unknown>);
      const providerId =
        typeof body === "object" &&
        body !== null &&
        typeof Reflect.get(body, "id") === "string"
          ? (Reflect.get(body, "id") as string)
          : null;
      const providerMessageDigest = providerId
        ? createHash("sha256").update(providerId).digest("hex")
        : null;
      return {
        outcome: response.ok
          ? "accepted_by_provider"
          : response.status >= 500 ||
              response.status === 408 ||
              response.status === 409 ||
              response.status === 429
            ? "delivery_unknown"
            : "failed",
        providerMessageDigest,
      };
    },
  };
}

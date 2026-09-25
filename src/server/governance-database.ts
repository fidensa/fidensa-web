import "server-only";

import type { PrivacyIntake, PrivacyRequestStore } from "./privacy-rights";
import type {
  PrivacyConfirmationClaim,
  PrivacyConfirmationDeliveryStore,
} from "./privacy-confirmation-delivery";
import type {
  NormalizedResendEvent,
  ProviderEventStore,
} from "./resend-webhooks";
import type {
  GlobalSuppressionSyncClaim,
  GlobalSuppressionSyncStore,
} from "./resend-contact-sync";

type Fetch = typeof fetch;

export interface ConsentSyncClaim {
  readonly operationId: string;
  readonly subscriptionId: string;
  readonly canonicalEmail: string;
  readonly subscriptionVersion: number;
  readonly desiredState: "active" | "unsubscribed" | "deleted";
  readonly reconcileFirst: boolean;
  readonly firstActivationConfirmed: boolean;
}

export interface ConsentSyncStore {
  claim(): Promise<ConsentSyncClaim | null>;
  recordResult(
    operationId: string,
    input: {
      readonly outcome: "applied" | "needs_reconciliation" | "failed";
      readonly contactSubscribed: boolean | null;
      readonly topicSubscribed: boolean | null;
      readonly globallyRestricted: boolean | null;
    },
  ): Promise<void>;
}

interface Options {
  readonly baseUrl: string;
  readonly serviceCredential: string;
  readonly fetchImplementation?: Fetch;
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The governance data origin must use HTTPS.");
  }
  return url.origin;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

export function createSupabaseGovernanceDatabase({
  baseUrl,
  serviceCredential,
  fetchImplementation = fetch,
}: Options): ProviderEventStore &
  PrivacyRequestStore &
  ConsentSyncStore &
  PrivacyConfirmationDeliveryStore &
  GlobalSuppressionSyncStore {
  const origin = validatedBaseUrl(baseUrl);
  if (serviceCredential.length < 32) {
    throw new Error("The governance data credential is malformed.");
  }
  async function rpc(operation: string, body: Record<string, unknown>) {
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
      throw new Error(
        `Governance database operation failed (${response.status}).`,
      );
    }
    return response.status === 204 ? null : await response.json();
  }
  return {
    async recordAuthenticatedEvent(event: NormalizedResendEvent) {
      const result = await rpc("record_provider_event_v2", {
        p_event_digest: event.eventIdentity,
        p_event_type: event.eventType,
        p_occurred_at: event.occurredAt,
        p_canonical_email: event.canonicalEmail,
        p_scope: event.restriction?.scope ?? null,
        p_reason: event.restriction?.reason ?? null,
        p_relaxation_claimed: event.providerRelaxationClaimed,
      });
      if (
        !["applied", "duplicate", "stale", "needs_reconciliation"].includes(
          String(result),
        )
      ) {
        throw new Error(
          "Governance database returned a malformed event result.",
        );
      }
      return result as
        "applied" | "duplicate" | "stale" | "needs_reconciliation";
    },

    async createRequest(input: PrivacyIntake, rateKeys) {
      await rpc("create_privacy_request_v2", {
        p_type: input.type,
        p_canonical_email: input.canonicalEmail,
        p_delivery_email: input.deliveryEmail,
        p_operation_digest: input.operationKey,
        p_explanation: input.explanation,
        p_matching_name: input.matchingName,
        p_matching_organization: input.matchingOrganization,
        p_matching_submission_date: input.matchingSubmissionDate,
        p_ip_digest: rateKeys.ipDigest,
        p_email_digest: rateKeys.emailDigest,
      });
    },

    async consumeConfirmation(credentialDigest: string) {
      const result = await rpc("consume_privacy_confirmation", {
        p_credential_digest: credentialDigest,
      });
      return result === true;
    },

    async claimPrivacyConfirmation() {
      const value = await rpc("claim_privacy_confirmation_intent", {});
      if (value === null) return null;
      if (
        typeof value !== "object" ||
        !uuid(Reflect.get(value, "intentId")) ||
        !uuid(Reflect.get(value, "privacyRequestId")) ||
        !uuid(Reflect.get(value, "operationId")) ||
        !Number.isInteger(Reflect.get(value, "generation")) ||
        typeof Reflect.get(value, "recipient") !== "string"
      ) {
        throw new Error(
          "Governance database returned a malformed confirmation claim.",
        );
      }
      return value as PrivacyConfirmationClaim;
    },

    async issuePrivacyConfirmation(intentId, credentialDigest) {
      if (!uuid(intentId) || !/^[0-9a-f]{64}$/u.test(credentialDigest)) {
        throw new Error("Privacy confirmation issuance is malformed.");
      }
      await rpc("issue_privacy_confirmation", {
        p_intent_id: intentId,
        p_credential_digest: credentialDigest,
      });
    },

    async recordPrivacyConfirmationDelivery(
      intentId,
      outcome,
      providerMessageDigest,
    ) {
      if (!uuid(intentId)) {
        throw new Error("Privacy confirmation outcome is malformed.");
      }
      await rpc("record_privacy_confirmation_delivery", {
        p_intent_id: intentId,
        p_outcome: outcome,
        p_provider_message_digest: providerMessageDigest,
      });
    },

    async claim() {
      const value = await rpc("claim_subscription_sync", {});
      if (value === null) return null;
      if (
        typeof value !== "object" ||
        !uuid(Reflect.get(value, "operationId")) ||
        !uuid(Reflect.get(value, "subscriptionId")) ||
        typeof Reflect.get(value, "canonicalEmail") !== "string" ||
        !Number.isInteger(Reflect.get(value, "subscriptionVersion")) ||
        !["active", "unsubscribed", "deleted"].includes(
          String(Reflect.get(value, "desiredState")),
        ) ||
        typeof Reflect.get(value, "reconcileFirst") !== "boolean" ||
        typeof Reflect.get(value, "firstActivationConfirmed") !== "boolean"
      ) {
        throw new Error("Governance database returned a malformed sync claim.");
      }
      return value as ConsentSyncClaim;
    },

    async recordResult(operationId, input) {
      if (!uuid(operationId))
        throw new Error("Sync operation identity is malformed.");
      await rpc("record_subscription_sync_result", {
        p_operation_id: operationId,
        p_outcome: input.outcome,
        p_contact_subscribed: input.contactSubscribed,
        p_topic_subscribed: input.topicSubscribed,
        p_globally_restricted: input.globallyRestricted,
      });
    },

    async claimGlobalSuppression() {
      const value = await rpc("claim_global_suppression_sync", {});
      if (value === null) return null;
      if (
        typeof value !== "object" ||
        !uuid(Reflect.get(value, "operationId")) ||
        typeof Reflect.get(value, "canonicalEmail") !== "string" ||
        !["global", "marketing_topic"].includes(
          String(Reflect.get(value, "scope")),
        )
      ) {
        throw new Error(
          "Governance database returned a malformed suppression claim.",
        );
      }
      return value as GlobalSuppressionSyncClaim;
    },

    async recordGlobalSuppressionResult(operationId, outcome) {
      if (!uuid(operationId)) {
        throw new Error("Suppression operation identity is malformed.");
      }
      await rpc("record_global_suppression_sync_result", {
        p_operation_id: operationId,
        p_outcome: outcome,
      });
    },
  };
}

import "server-only";

export const SUBSCRIPTION_REVIEW_INTERVAL_MONTHS = 3;
export const PROVIDER_STATE_MAX_AGE_MS = 60 * 60 * 1_000;

export type SubscriptionStatus =
  "pending_confirmation" | "active" | "unsubscribed" | "deleted";

export interface SubscriptionAuthority {
  readonly status: SubscriptionStatus;
  readonly consentTextVersion: string;
  readonly consentedAt: Date;
  readonly confirmedAt: Date | null;
  readonly reviewOutcome: "permissive" | "denied" | "unavailable" | null;
  readonly nextReviewDueAt: Date | null;
  readonly version: number;
}

export interface ProviderMarketingState {
  readonly available: boolean;
  readonly observedAt: Date | null;
  readonly subscriptionVersion: number | null;
  readonly contactSubscribed: boolean | null;
  readonly marketingTopicSubscribed: boolean | null;
  readonly globallyRestricted: boolean | null;
}

export interface PromotionDecisionInput {
  readonly subscription: SubscriptionAuthority | null;
  readonly expectedConsentTextVersion: string;
  readonly topicSuppressed: boolean;
  readonly globallySuppressed: boolean;
  readonly provider: ProviderMarketingState | null;
  readonly now: Date;
  readonly providerStateMaxAgeMs?: number;
}

export type PromotionDenialReason =
  | "absent_consent"
  | "inactive_consent"
  | "unconfirmed_consent"
  | "stale_consent_version"
  | "review_not_permissive"
  | "review_overdue"
  | "local_topic_suppression"
  | "local_global_suppression"
  | "provider_unavailable"
  | "provider_state_unknown"
  | "provider_state_stale"
  | "provider_version_conflict"
  | "provider_contact_restricted"
  | "provider_topic_restricted"
  | "provider_global_restriction";

export type PromotionDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: PromotionDenialReason };

function denied(reason: PromotionDenialReason): PromotionDecision {
  return { eligible: false, reason };
}

/**
 * The send guard is deliberately conjunctive. Supabase consent is necessary,
 * but never sufficient: any missing, stale, conflicting, or restrictive
 * provider/local fact wins and closes promotional delivery.
 */
export function evaluatePromotionalEligibility(
  input: PromotionDecisionInput,
): PromotionDecision {
  const subscription = input.subscription;
  if (!subscription) return denied("absent_consent");
  if (subscription.status !== "active") return denied("inactive_consent");
  if (!subscription.confirmedAt) return denied("unconfirmed_consent");
  if (subscription.consentTextVersion !== input.expectedConsentTextVersion) {
    return denied("stale_consent_version");
  }
  if (subscription.reviewOutcome !== "permissive") {
    return denied("review_not_permissive");
  }
  if (
    !subscription.nextReviewDueAt ||
    subscription.nextReviewDueAt.getTime() <= input.now.getTime()
  ) {
    return denied("review_overdue");
  }
  if (input.globallySuppressed) return denied("local_global_suppression");
  if (input.topicSuppressed) return denied("local_topic_suppression");

  const provider = input.provider;
  if (!provider?.available) return denied("provider_unavailable");
  if (
    !provider.observedAt ||
    provider.subscriptionVersion === null ||
    provider.contactSubscribed === null ||
    provider.marketingTopicSubscribed === null ||
    provider.globallyRestricted === null
  ) {
    return denied("provider_state_unknown");
  }
  const maximumAge = input.providerStateMaxAgeMs ?? PROVIDER_STATE_MAX_AGE_MS;
  if (input.now.getTime() - provider.observedAt.getTime() > maximumAge) {
    return denied("provider_state_stale");
  }
  if (provider.subscriptionVersion !== subscription.version) {
    return denied("provider_version_conflict");
  }
  if (provider.globallyRestricted) {
    return denied("provider_global_restriction");
  }
  if (!provider.contactSubscribed) {
    return denied("provider_contact_restricted");
  }
  if (!provider.marketingTopicSubscribed) {
    return denied("provider_topic_restricted");
  }
  return { eligible: true };
}

export type ProviderRestriction =
  | {
      readonly scope: "marketing_topic";
      readonly reason: "marketing_unsubscribe";
      readonly blocksApplicationMail: false;
    }
  | {
      readonly scope: "global";
      readonly reason:
        | "bounce"
        | "complaint"
        | "provider_suppression"
        | "complete_do_not_contact";
      readonly blocksApplicationMail: true;
    };

export function restrictionForEvent(
  eventType: string,
  contactUnsubscribed = false,
): ProviderRestriction | null {
  if (eventType === "contact.updated" && contactUnsubscribed) {
    return {
      scope: "marketing_topic",
      reason: "marketing_unsubscribe",
      blocksApplicationMail: false,
    };
  }
  switch (eventType) {
    case "email.bounced":
      return { scope: "global", reason: "bounce", blocksApplicationMail: true };
    case "email.complained":
      return {
        scope: "global",
        reason: "complaint",
        blocksApplicationMail: true,
      };
    case "email.suppressed":
    case "suppression.added":
      return {
        scope: "global",
        reason: "provider_suppression",
        blocksApplicationMail: true,
      };
    default:
      return null;
  }
}

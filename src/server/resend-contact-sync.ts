import "server-only";

import type { ConsentSyncClaim, ConsentSyncStore } from "./governance-database";

export interface ProviderSnapshot {
  readonly exists: boolean;
  readonly contactSubscribed: boolean | null;
  readonly topicSubscribed: boolean | null;
  readonly globallyRestricted: boolean | null;
}

export interface MarketingContactProvider {
  read(email: string): Promise<ProviderSnapshot>;
  apply(claim: ConsentSyncClaim, snapshot: ProviderSnapshot): Promise<void>;
  applyGlobalSuppression(email: string): Promise<void>;
  applyMarketingTopicSuppression(email: string): Promise<void>;
}

export interface MarketingContactCleanupProvider {
  read(email: string): Promise<ProviderSnapshot>;
  remove(email: string): Promise<void>;
}

export async function removeExerciseMarketingContact(
  provider: MarketingContactCleanupProvider,
  email: string,
): Promise<void> {
  await provider.remove(email);
  const snapshot = await provider.read(email);
  if (snapshot.exists || snapshot.topicSubscribed === true) {
    throw new Error(
      "Provider contact cleanup did not remove contact/topic state.",
    );
  }
}

export interface GlobalSuppressionSyncClaim {
  readonly operationId: string;
  readonly canonicalEmail: string;
  readonly scope: "global" | "marketing_topic";
}

export interface GlobalSuppressionSyncStore {
  claimGlobalSuppression(): Promise<GlobalSuppressionSyncClaim | null>;
  recordGlobalSuppressionResult(
    operationId: string,
    outcome: "applied" | "needs_reconciliation" | "failed",
  ): Promise<void>;
}

function desiredMatches(
  claim: ConsentSyncClaim,
  snapshot: ProviderSnapshot,
): boolean {
  if (claim.desiredState === "active") {
    return (
      snapshot.exists &&
      snapshot.contactSubscribed === true &&
      snapshot.topicSubscribed === true &&
      snapshot.globallyRestricted === false
    );
  }
  return !snapshot.exists || snapshot.topicSubscribed === false;
}

function providerStateUnknown(
  claim: ConsentSyncClaim,
  snapshot: ProviderSnapshot,
): boolean {
  return (
    snapshot.globallyRestricted === null ||
    (snapshot.exists &&
      (snapshot.contactSubscribed === null ||
        (snapshot.topicSubscribed === null && claim.firstActivationConfirmed)))
  );
}

function providerRestrictionMustBePreserved(
  claim: ConsentSyncClaim,
  snapshot: ProviderSnapshot,
): boolean {
  if (snapshot.globallyRestricted === true) return true;
  if (!snapshot.exists) return claim.firstActivationConfirmed;
  if (snapshot.contactSubscribed === false) return true;
  if (snapshot.topicSubscribed === false) {
    // Before a durable successful activation, topic opt-out is also the
    // provider's ordinary default and the residue of a partial first create.
    // Only a later topic opt-out can be imported as recipient intent.
    return claim.firstActivationConfirmed;
  }
  return false;
}

export async function reconcileOneSubscription(
  store: ConsentSyncStore,
  provider: MarketingContactProvider,
): Promise<boolean> {
  const claim = await store.claim();
  if (!claim) return false;
  try {
    // Every attempt reads current provider state before mutation. This closes
    // the create-succeeded/response-lost gap without resurrecting terminal
    // consent on retry.
    let snapshot = await provider.read(claim.canonicalEmail);
    const preserveRestriction =
      claim.desiredState === "active" &&
      providerRestrictionMustBePreserved(claim, snapshot);
    const unknownActiveState =
      claim.desiredState === "active" && providerStateUnknown(claim, snapshot);
    if (
      !desiredMatches(claim, snapshot) &&
      !preserveRestriction &&
      !unknownActiveState
    ) {
      await provider.apply(claim, snapshot);
      snapshot = await provider.read(claim.canonicalEmail);
    }
    // A later provider opt-out is a successful restrictive reconciliation,
    // not an instruction to re-subscribe. The database imports it locally.
    const applied =
      desiredMatches(claim, snapshot) ||
      (preserveRestriction && !providerStateUnknown(claim, snapshot));
    await store.recordResult(claim.operationId, {
      outcome: applied ? "applied" : "needs_reconciliation",
      contactSubscribed: snapshot.contactSubscribed,
      topicSubscribed: snapshot.topicSubscribed,
      globallyRestricted: snapshot.globallyRestricted,
    });
  } catch {
    await Promise.resolve(
      store.recordResult(claim.operationId, {
        outcome: "needs_reconciliation",
        contactSubscribed: null,
        topicSubscribed: null,
        globallyRestricted: null,
      }),
    ).catch(() => undefined);
  }
  return true;
}

export async function reconcileOneGlobalSuppression(
  store: GlobalSuppressionSyncStore,
  provider: MarketingContactProvider,
): Promise<boolean> {
  const claim = await store.claimGlobalSuppression();
  if (!claim) return false;
  try {
    let snapshot = await provider.read(claim.canonicalEmail);
    const matches = () =>
      claim.scope === "global"
        ? snapshot.globallyRestricted === true
        : !snapshot.exists ||
          snapshot.contactSubscribed === false ||
          snapshot.topicSubscribed === false;
    if (!matches()) {
      if (claim.scope === "global") {
        await provider.applyGlobalSuppression(claim.canonicalEmail);
      } else {
        await provider.applyMarketingTopicSuppression(claim.canonicalEmail);
      }
      snapshot = await provider.read(claim.canonicalEmail);
    }
    await store.recordGlobalSuppressionResult(
      claim.operationId,
      matches() ? "applied" : "needs_reconciliation",
    );
  } catch {
    await Promise.resolve(
      store.recordGlobalSuppressionResult(
        claim.operationId,
        "needs_reconciliation",
      ),
    ).catch(() => undefined);
  }
  return true;
}

export function createResendMarketingContactProvider(options: {
  readonly accessCredential: string;
  readonly marketingTopicId: string;
  readonly fetchImplementation?: typeof fetch;
}): MarketingContactProvider & MarketingContactCleanupProvider {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  if (options.accessCredential.length < 32 || !options.marketingTopicId) {
    throw new Error("The marketing reconciliation provider is not configured.");
  }
  const headers = {
    Authorization: `Bearer ${options.accessCredential}`,
    "Content-Type": "application/json",
  } as const;
  async function json(response: Response): Promise<Record<string, unknown>> {
    const value = (await response.json()) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  }
  return {
    async read(email) {
      const contactResponse = await fetchImplementation(
        `https://api.resend.com/contacts/${encodeURIComponent(email)}`,
        { method: "GET", headers, cache: "no-store" },
      );
      if (!contactResponse.ok && contactResponse.status !== 404) {
        throw new Error("Contact read-back failed.");
      }
      const exists = contactResponse.status !== 404;
      const contact = exists ? await json(contactResponse) : {};

      let subscription: unknown = null;
      if (exists) {
        const topicBase = `https://api.resend.com/contacts/${encodeURIComponent(email)}/topics`;
        let after: string | null = null;
        let readBackComplete = false;
        const seenCursors = new Set<string>();
        for (let page = 0; page < 1_000; page += 1) {
          const topicUrl = new URL(topicBase);
          if (after) {
            topicUrl.searchParams.set("limit", "100");
            topicUrl.searchParams.set("after", after);
          }
          const topicsResponse = await fetchImplementation(topicUrl, {
            method: "GET",
            headers,
            cache: "no-store",
          });
          if (!topicsResponse.ok) throw new Error("Topic read-back failed.");
          const topicBody = await json(topicsResponse);
          const topics = Array.isArray(topicBody.data)
            ? topicBody.data
            : Array.isArray(topicBody.topics)
              ? topicBody.topics
              : [];
          const topic = topics.find(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              Reflect.get(item, "id") === options.marketingTopicId,
          );
          if (topic) {
            subscription = Reflect.get(topic, "subscription");
            readBackComplete = true;
            break;
          }
          if (topicBody.has_more !== true) {
            readBackComplete = true;
            break;
          }
          const lastTopic = topics.at(-1);
          const nextCursor =
            typeof lastTopic === "object" &&
            lastTopic !== null &&
            typeof Reflect.get(lastTopic, "id") === "string"
              ? (Reflect.get(lastTopic, "id") as string)
              : null;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error("Topic read-back pagination was malformed.");
          }
          seenCursors.add(nextCursor);
          after = nextCursor;
        }
        if (!readBackComplete) {
          throw new Error("Topic read-back pagination did not terminate.");
        }
      }

      // Resend's current Contact representation has no suppression field.
      // Suppression is account-wide and must be read from its authoritative
      // endpoint; only an explicit 404 establishes absence.
      const suppressionResponse = await fetchImplementation(
        `https://api.resend.com/suppressions/${encodeURIComponent(email)}`,
        { method: "GET", headers, cache: "no-store" },
      );
      let globallyRestricted: boolean;
      if (suppressionResponse.status === 404) {
        globallyRestricted = false;
      } else if (suppressionResponse.ok) {
        const suppression = await json(suppressionResponse);
        if (
          suppression.object !== "suppression" ||
          typeof suppression.email !== "string" ||
          suppression.email.toLowerCase() !== email.toLowerCase()
        ) {
          throw new Error("Suppression read-back was malformed.");
        }
        globallyRestricted = true;
      } else {
        throw new Error("Suppression read-back failed.");
      }

      const unsubscribed = contact.unsubscribed;
      return {
        exists,
        contactSubscribed:
          exists && typeof unsubscribed === "boolean"
            ? !unsubscribed
            : exists
              ? null
              : false,
        topicSubscribed:
          subscription === "opt_in"
            ? true
            : subscription === "opt_out"
              ? false
              : exists
                ? null
                : false,
        globallyRestricted,
      };
    },

    async apply(claim, snapshot) {
      if (claim.desiredState === "active") {
        const contactResponse = await fetchImplementation(
          snapshot.exists
            ? `https://api.resend.com/contacts/${encodeURIComponent(claim.canonicalEmail)}`
            : "https://api.resend.com/contacts",
          {
            method: snapshot.exists ? "PATCH" : "POST",
            headers,
            body: JSON.stringify(
              snapshot.exists
                ? { unsubscribed: false }
                : { email: claim.canonicalEmail, unsubscribed: false },
            ),
          },
        );
        if (!contactResponse.ok) {
          throw new Error("Contact activation failed.");
        }
      }
      const response = await fetchImplementation(
        `https://api.resend.com/contacts/${encodeURIComponent(claim.canonicalEmail)}/topics`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify([
            {
              id: options.marketingTopicId,
              subscription:
                claim.desiredState === "active" ? "opt_in" : "opt_out",
            },
          ]),
        },
      );
      if (
        !response.ok &&
        !(response.status === 404 && claim.desiredState !== "active")
      ) {
        throw new Error("Contact topic update failed.");
      }
    },

    async applyGlobalSuppression(email) {
      const response = await fetchImplementation(
        "https://api.resend.com/suppressions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ email }),
        },
      );
      if (!response.ok && response.status !== 409) {
        throw new Error("Global suppression activation failed.");
      }
    },

    async applyMarketingTopicSuppression(email) {
      const response = await fetchImplementation(
        `https://api.resend.com/contacts/${encodeURIComponent(email)}/topics`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify([
            { id: options.marketingTopicId, subscription: "opt_out" },
          ]),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error("Marketing topic suppression failed.");
      }
    },

    async remove(email) {
      const response = await fetchImplementation(
        `https://api.resend.com/contacts/${encodeURIComponent(email)}`,
        { method: "DELETE", headers },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error("Contact cleanup failed.");
      }
    },
  };
}

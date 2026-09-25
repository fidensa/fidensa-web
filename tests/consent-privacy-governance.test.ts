import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluatePromotionalEligibility,
  restrictionForEvent,
  type PromotionDecisionInput,
} from "../src/server/consent-governance";
import {
  MANUAL_MESSAGE_TEMPLATES,
  recordApprovedManualCommunication,
} from "../src/server/manual-communications";
import {
  createPrivacyConfirmationHandler,
  createPrivacyIntakeHandler,
  requiredIdentityMethod,
  parsePrivacyIntake,
} from "../src/server/privacy-rights";
import {
  createResendMarketingContactProvider,
  reconcileOneGlobalSuppression,
  reconcileOneSubscription,
  removeExerciseMarketingContact,
} from "../src/server/resend-contact-sync";
import { deliverOnePrivacyConfirmation } from "../src/server/privacy-confirmation-delivery";

const now = new Date("2039-02-01T00:00:00.000Z");

function eligibleInput(
  overrides: Partial<PromotionDecisionInput> = {},
): PromotionDecisionInput {
  return {
    subscription: {
      status: "active",
      consentTextVersion: "marketing-consent-v1",
      consentedAt: new Date("2039-01-01T00:00:00.000Z"),
      confirmedAt: new Date("2039-01-01T00:05:00.000Z"),
      reviewOutcome: "permissive",
      nextReviewDueAt: new Date("2039-04-01T00:00:00.000Z"),
      version: 3,
    },
    expectedConsentTextVersion: "marketing-consent-v1",
    topicSuppressed: false,
    globallySuppressed: false,
    provider: {
      available: true,
      observedAt: new Date("2039-01-31T23:30:00.000Z"),
      subscriptionVersion: 3,
      contactSubscribed: true,
      marketingTopicSubscribed: true,
      globallyRestricted: false,
    },
    now,
    ...overrides,
  };
}

describe("most-restrictive promotion eligibility", () => {
  it("allows only current matching consent, review, and provider state", () => {
    expect(evaluatePromotionalEligibility(eligibleInput())).toEqual({
      eligible: true,
    });
  });

  it.each([
    ["absent consent", { subscription: null }, "absent_consent"],
    [
      "pending consent",
      {
        subscription: {
          ...eligibleInput().subscription!,
          status: "pending_confirmation" as const,
          confirmedAt: null,
        },
      },
      "inactive_consent",
    ],
    [
      "failed review",
      {
        subscription: {
          ...eligibleInput().subscription!,
          reviewOutcome: "denied" as const,
        },
      },
      "review_not_permissive",
    ],
    [
      "overdue review",
      {
        subscription: {
          ...eligibleInput().subscription!,
          nextReviewDueAt: now,
        },
      },
      "review_overdue",
    ],
    ["provider outage", { provider: null }, "provider_unavailable"],
    [
      "stale provider state",
      {
        provider: {
          ...eligibleInput().provider!,
          observedAt: new Date("2039-01-31T20:00:00.000Z"),
        },
      },
      "provider_state_stale",
    ],
    [
      "version conflict",
      {
        provider: {
          ...eligibleInput().provider!,
          subscriptionVersion: 2,
        },
      },
      "provider_version_conflict",
    ],
    [
      "provider topic opt-out",
      {
        provider: {
          ...eligibleInput().provider!,
          marketingTopicSubscribed: false,
        },
      },
      "provider_topic_restricted",
    ],
    [
      "local global suppression",
      { globallySuppressed: true },
      "local_global_suppression",
    ],
  ])("denies %s", (_label, overrides, reason) => {
    expect(
      evaluatePromotionalEligibility(
        eligibleInput(overrides as Partial<PromotionDecisionInput>),
      ),
    ).toEqual({ eligible: false, reason });
  });

  it("keeps marketing unsubscribe separate from necessary application mail", () => {
    expect(restrictionForEvent("contact.updated", true)).toEqual({
      scope: "marketing_topic",
      reason: "marketing_unsubscribe",
      blocksApplicationMail: false,
    });
    expect(restrictionForEvent("email.bounced")).toMatchObject({
      scope: "global",
      blocksApplicationMail: true,
    });
    expect(restrictionForEvent("email.complained")).toMatchObject({
      scope: "global",
      blocksApplicationMail: true,
    });
  });
});

describe("provider synchronization", () => {
  const claim = {
    operationId: "00000000-0000-4000-8000-000000000101",
    subscriptionId: "00000000-0000-4000-8000-000000000102",
    canonicalEmail: "sync@synthetic.invalid",
    subscriptionVersion: 4,
    desiredState: "active" as const,
    reconcileFirst: true,
    firstActivationConfirmed: false,
  };

  it("removes the controlled contact and its topic state through a deterministic provider double", async () => {
    let exists = true;
    let topicSubscribed = true;
    const remove = vi.fn(async () => {
      exists = false;
      topicSubscribed = false;
    });
    await removeExerciseMarketingContact(
      {
        remove,
        async read() {
          return {
            exists,
            contactSubscribed: exists,
            topicSubscribed,
            globallyRestricted: false,
          };
        },
      },
      "exercise@synthetic.invalid",
    );
    expect(remove).toHaveBeenCalledWith("exercise@synthetic.invalid");
  });

  it.each([
    [
      "contact",
      {
        exists: true,
        contactSubscribed: false,
        topicSubscribed: false,
        globallyRestricted: false,
      },
    ],
    [
      "topic",
      {
        exists: false,
        contactSubscribed: false,
        topicSubscribed: true,
        globallyRestricted: false,
      },
    ],
  ])(
    "fails cleanup when provider %s read-back persists",
    async (_label, snapshot) => {
      await expect(
        removeExerciseMarketingContact(
          {
            remove: vi.fn(async () => undefined),
            read: vi.fn(async () => snapshot),
          },
          "exercise@synthetic.invalid",
        ),
      ).rejects.toThrow(
        "Provider contact cleanup did not remove contact/topic state.",
      );
    },
  );

  it("uses Resend contact deletion and verifies absence by read-back", async () => {
    const requests: string[] = [];
    let exists = true;
    const provider = createResendMarketingContactProvider({
      accessCredential: "r".repeat(40),
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input, init) => {
        const url = new URL(input.toString());
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        if (method === "DELETE" && url.pathname.includes("/contacts/")) {
          exists = false;
          return new Response(null, { status: 204 });
        }
        if (url.pathname.includes("/contacts/") && method === "GET") {
          return exists
            ? Response.json({
                object: "contact",
                email: "exercise@synthetic.invalid",
                unsubscribed: false,
              })
            : new Response(null, { status: 404 });
        }
        if (url.pathname.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        throw new Error(`Unexpected provider request: ${method} ${url}`);
      }) as typeof fetch,
    });
    await removeExerciseMarketingContact(
      provider,
      "exercise@synthetic.invalid",
    );
    expect(requests).toContain("DELETE /contacts/exercise%40synthetic.invalid");
    expect(requests).not.toContain(
      "GET /contacts/exercise%40synthetic.invalid/topics",
    );
  });

  it("reconciles read-back before retrying a partial create", async () => {
    const apply = vi.fn();
    const recordResult = vi.fn(async () => undefined);
    await reconcileOneSubscription(
      {
        claim: vi.fn(async () => claim),
        recordResult,
      },
      {
        read: vi.fn(async () => ({
          exists: true,
          contactSubscribed: true,
          topicSubscribed: true,
          globallyRestricted: false,
        })),
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );
    expect(apply).not.toHaveBeenCalled();
    expect(recordResult).toHaveBeenCalledWith(
      claim.operationId,
      expect.objectContaining({ outcome: "applied" }),
    );
  });

  it("leaves provider outage and partial cleanup closed for reconciliation", async () => {
    const recordResult = vi.fn();
    await reconcileOneSubscription(
      { claim: vi.fn(async () => claim), recordResult },
      {
        read: vi.fn(async () => {
          throw new Error("synthetic provider outage");
        }),
        apply: vi.fn(),
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );
    expect(recordResult).toHaveBeenCalledWith(claim.operationId, {
      outcome: "needs_reconciliation",
      contactSubscribed: null,
      topicSubscribed: null,
      globallyRestricted: null,
    });
  });

  it("imports a later-version provider topic opt-out without re-subscribing", async () => {
    const laterReview = {
      ...claim,
      subscriptionVersion: 7,
      firstActivationConfirmed: true,
    };
    const apply = vi.fn();
    const recordResult = vi.fn(async () => undefined);
    await reconcileOneSubscription(
      { claim: vi.fn(async () => laterReview), recordResult },
      {
        read: vi.fn(async () => ({
          exists: true,
          contactSubscribed: true,
          topicSubscribed: false,
          globallyRestricted: false,
        })),
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );
    expect(apply).not.toHaveBeenCalled();
    expect(recordResult).toHaveBeenCalledWith(laterReview.operationId, {
      outcome: "applied",
      contactSubscribed: true,
      topicSubscribed: false,
      globallyRestricted: false,
    });
  });

  it("creates an absent provider contact when review precedes first activation read-back", async () => {
    const reviewedBeforeActivation = { ...claim, subscriptionVersion: 3 };
    const apply = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        exists: false,
        contactSubscribed: false,
        topicSubscribed: false,
        globallyRestricted: false,
      })
      .mockResolvedValueOnce({
        exists: true,
        contactSubscribed: true,
        topicSubscribed: true,
        globallyRestricted: false,
      });
    const recordResult = vi.fn(async () => undefined);

    await reconcileOneSubscription(
      {
        claim: vi.fn(async () => reviewedBeforeActivation),
        recordResult,
      },
      {
        read,
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );

    expect(apply).toHaveBeenCalledWith(reviewedBeforeActivation, {
      exists: false,
      contactSubscribed: false,
      topicSubscribed: false,
      globallyRestricted: false,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(recordResult).toHaveBeenCalledWith(
      reviewedBeforeActivation.operationId,
      {
        outcome: "applied",
        contactSubscribed: true,
        topicSubscribed: true,
        globallyRestricted: false,
      },
    );
  });

  it("retries topic opt-in after a partial first contact create through the real adapter", async () => {
    let contactExists = false;
    let topicSubscription: "opt_in" | "opt_out" = "opt_out";
    let topicPatchAttempts = 0;
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        if (url.endsWith("/topics") && method === "GET") {
          return Response.json({
            object: "list",
            data: [{ id: "topic_marketing", subscription: topicSubscription }],
          });
        }
        if (url.endsWith("/topics") && method === "PATCH") {
          topicPatchAttempts += 1;
          if (topicPatchAttempts === 1) {
            return new Response(null, { status: 503 });
          }
          topicSubscription = "opt_in";
          return Response.json({ object: "contact_topics", id: "synthetic" });
        }
        if (url.endsWith("/contacts") && method === "POST") {
          if (contactExists) return new Response(null, { status: 409 });
          contactExists = true;
          return Response.json({ object: "contact", id: "synthetic" });
        }
        if (url.includes("/contacts/") && method === "PATCH") {
          return Response.json({ object: "contact", id: "synthetic" });
        }
        if (url.includes("/contacts/") && method === "GET") {
          return contactExists
            ? Response.json({
                object: "contact",
                email: claim.canonicalEmail,
                unsubscribed: false,
              })
            : new Response(null, { status: 404 });
        }
        throw new Error(`Unexpected provider request: ${method} ${url}`);
      }) as typeof fetch,
    });
    const recordResult = vi.fn(async () => undefined);
    const store = { claim: vi.fn(async () => claim), recordResult };

    await reconcileOneSubscription(store, provider);
    await reconcileOneSubscription(store, provider);

    expect(topicPatchAttempts).toBe(2);
    expect(topicSubscription).toBe("opt_in");
    expect(recordResult).toHaveBeenLastCalledWith(claim.operationId, {
      outcome: "applied",
      contactSubscribed: true,
      topicSubscribed: true,
      globallyRestricted: false,
    });
  });

  it("retries first activation when the provider omits an unset topic", async () => {
    let contactExists = false;
    let topicSubscription: "opt_in" | null = null;
    let contactCreates = 0;
    let contactUpdates = 0;
    let topicPatchAttempts = 0;
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.endsWith("/topics") && method === "GET") {
          return Response.json({
            object: "list",
            has_more: false,
            data: topicSubscription
              ? [
                  {
                    id: "topic_marketing",
                    subscription: topicSubscription,
                  },
                ]
              : [],
          });
        }
        if (url.pathname.endsWith("/topics") && method === "PATCH") {
          topicPatchAttempts += 1;
          if (topicPatchAttempts === 1) {
            return new Response(null, { status: 503 });
          }
          topicSubscription = "opt_in";
          return Response.json({ object: "contact_topics", id: "synthetic" });
        }
        if (url.pathname === "/contacts" && method === "POST") {
          contactCreates += 1;
          contactExists = true;
          return Response.json({ object: "contact", id: "synthetic" });
        }
        if (url.pathname.includes("/contacts/") && method === "PATCH") {
          contactUpdates += 1;
          return Response.json({ object: "contact", id: "synthetic" });
        }
        if (url.pathname.includes("/contacts/") && method === "GET") {
          return contactExists
            ? Response.json({
                object: "contact",
                email: claim.canonicalEmail,
                unsubscribed: false,
              })
            : new Response(null, { status: 404 });
        }
        throw new Error(`Unexpected provider request: ${method} ${url}`);
      }) as typeof fetch,
    });
    const recordResult = vi.fn(async () => undefined);
    const store = { claim: vi.fn(async () => claim), recordResult };

    await reconcileOneSubscription(store, provider);
    await reconcileOneSubscription(store, provider);

    expect(contactCreates).toBe(1);
    expect(contactUpdates).toBe(1);
    expect(topicPatchAttempts).toBe(2);
    expect(topicSubscription).toBe("opt_in");
    expect(recordResult).toHaveBeenLastCalledWith(claim.operationId, {
      outcome: "applied",
      contactSubscribed: true,
      topicSubscribed: true,
      globallyRestricted: false,
    });
  });

  it("updates an existing first-activation contact without a duplicate create", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    let topicSubscription: "opt_out" | "opt_in" = "opt_out";
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname });
        if (url.pathname.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.endsWith("/topics") && method === "GET") {
          return Response.json({
            object: "list",
            has_more: false,
            data: [{ id: "topic_marketing", subscription: topicSubscription }],
          });
        }
        if (url.pathname.endsWith("/topics") && method === "PATCH") {
          topicSubscription = "opt_in";
          return Response.json({ object: "contact_topics", id: "synthetic" });
        }
        if (url.pathname.includes("/contacts/") && method === "PATCH") {
          return Response.json({ object: "contact", id: "synthetic" });
        }
        if (url.pathname.includes("/contacts/") && method === "GET") {
          return Response.json({
            object: "contact",
            email: claim.canonicalEmail,
            unsubscribed: false,
          });
        }
        throw new Error(`Unexpected provider request: ${method} ${url}`);
      }) as typeof fetch,
    });

    await reconcileOneSubscription(
      {
        claim: vi.fn(async () => claim),
        recordResult: vi.fn(async () => undefined),
      },
      provider,
    );

    expect(requests).toContainEqual({
      method: "PATCH",
      path: "/contacts/sync%40synthetic.invalid",
    });
    expect(requests).not.toContainEqual({ method: "POST", path: "/contacts" });
  });

  it("paginates topic read-back before treating the marketing topic as absent", async () => {
    const topicRequests: string[] = [];
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.endsWith("/topics")) {
          topicRequests.push(url.toString());
          if (!url.searchParams.has("after")) {
            return Response.json({
              object: "list",
              has_more: true,
              data: [{ id: "topic_other", subscription: "opt_in" }],
            });
          }
          expect(url.searchParams.get("after")).toBe("topic_other");
          return Response.json({
            object: "list",
            has_more: false,
            data: [{ id: "topic_marketing", subscription: "opt_out" }],
          });
        }
        return Response.json({
          object: "contact",
          email: claim.canonicalEmail,
          unsubscribed: false,
        });
      }) as typeof fetch,
    });

    await expect(provider.read(claim.canonicalEmail)).resolves.toEqual({
      exists: true,
      contactSubscribed: true,
      topicSubscribed: false,
      globallyRestricted: false,
    });
    expect(topicRequests).toHaveLength(2);
  });

  it("treats provider contact removal after first activation as restrictive", async () => {
    const previouslyActivated = {
      ...claim,
      subscriptionVersion: 8,
      firstActivationConfirmed: true,
    };
    const apply = vi.fn(async () => undefined);
    const recordResult = vi.fn(async () => undefined);

    await reconcileOneSubscription(
      { claim: vi.fn(async () => previouslyActivated), recordResult },
      {
        read: vi.fn(async () => ({
          exists: false,
          contactSubscribed: false,
          topicSubscribed: false,
          globallyRestricted: false,
        })),
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );

    expect(apply).not.toHaveBeenCalled();
    expect(recordResult).toHaveBeenCalledWith(previouslyActivated.operationId, {
      outcome: "applied",
      contactSubscribed: false,
      topicSubscribed: false,
      globallyRestricted: false,
    });
  });

  it("does not overwrite an existing contact with unknown provider fields", async () => {
    const apply = vi.fn(async () => undefined);
    const recordResult = vi.fn(async () => undefined);

    await reconcileOneSubscription(
      { claim: vi.fn(async () => claim), recordResult },
      {
        read: vi.fn(async () => ({
          exists: true,
          contactSubscribed: null,
          topicSubscribed: null,
          globallyRestricted: false,
        })),
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );

    expect(apply).not.toHaveBeenCalled();
    expect(recordResult).toHaveBeenCalledWith(claim.operationId, {
      outcome: "needs_reconciliation",
      contactSubscribed: null,
      topicSubscribed: null,
      globallyRestricted: false,
    });
  });

  it("never creates a provider contact for terminal consent", async () => {
    const terminal = { ...claim, desiredState: "deleted" as const };
    const apply = vi.fn();
    await reconcileOneSubscription(
      {
        claim: vi.fn(async () => terminal),
        recordResult: vi.fn(),
      },
      {
        read: vi.fn(async () => ({
          exists: false,
          contactSubscribed: null,
          topicSubscribed: null,
          globallyRestricted: null,
        })),
        apply,
        applyGlobalSuppression: vi.fn(),
        applyMarketingTopicSuppression: vi.fn(),
      },
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("reads account suppression through the real Resend adapter", async () => {
    const requests: string[] = [];
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/topics")) {
          return Response.json({
            object: "list",
            data: [
              {
                id: "topic_marketing",
                subscription: "opt_in",
              },
            ],
          });
        }
        if (url.includes("/suppressions/")) {
          return Response.json({
            object: "suppression",
            id: "suppression_synthetic",
            email: "sync@synthetic.invalid",
            origin: "bounce",
          });
        }
        return Response.json({
          object: "contact",
          email: "sync@synthetic.invalid",
          unsubscribed: false,
        });
      }) as typeof fetch,
    });

    await expect(provider.read("sync@synthetic.invalid")).resolves.toEqual({
      exists: true,
      contactSubscribed: true,
      topicSubscribed: true,
      globallyRestricted: true,
    });
    expect(requests).toContain(
      "https://api.resend.com/suppressions/sync%40synthetic.invalid",
    );
  });

  it("fails closed when suppression read-back is unavailable", async () => {
    const claimStore = {
      claim: vi.fn(async () => claim),
      recordResult: vi.fn(async () => undefined),
    };
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/topics")) {
          return Response.json({
            data: [{ id: "topic_marketing", subscription: "opt_in" }],
          });
        }
        if (url.includes("/suppressions/")) {
          return new Response(null, { status: 503 });
        }
        return Response.json({ unsubscribed: false });
      }) as typeof fetch,
    });

    await reconcileOneSubscription(claimStore, provider);
    expect(claimStore.recordResult).toHaveBeenCalledWith(claim.operationId, {
      outcome: "needs_reconciliation",
      contactSubscribed: null,
      topicSubscribed: null,
      globallyRestricted: null,
    });
  });

  it("preserves a provider topic opt-out on a later version through the real adapter", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/topics")) {
          return Response.json({
            data: [{ id: "topic_marketing", subscription: "opt_out" }],
          });
        }
        if (url.includes("/suppressions/")) {
          return new Response(null, { status: 404 });
        }
        return Response.json({ unsubscribed: false });
      }) as typeof fetch,
    });
    const laterReview = {
      ...claim,
      subscriptionVersion: 9,
      firstActivationConfirmed: true,
    };
    const recordResult = vi.fn(async () => undefined);

    await reconcileOneSubscription(
      { claim: vi.fn(async () => laterReview), recordResult },
      provider,
    );

    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(recordResult).toHaveBeenCalledWith(laterReview.operationId, {
      outcome: "applied",
      contactSubscribed: true,
      topicSubscribed: false,
      globallyRestricted: false,
    });
  });

  it("uses Resend's current array body for topic mutations", async () => {
    const bodies: unknown[] = [];
    const provider = createResendMarketingContactProvider({
      accessCredential: `re_${"x".repeat(40)}`,
      marketingTopicId: "topic_marketing",
      fetchImplementation: vi.fn(async (_input, init) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return Response.json({ id: "synthetic" });
      }) as typeof fetch,
    });

    await provider.apply(claim, {
      exists: false,
      contactSubscribed: false,
      topicSubscribed: false,
      globallyRestricted: false,
    });
    await provider.applyMarketingTopicSuppression("sync@synthetic.invalid");

    expect(bodies).toEqual([
      { email: claim.canonicalEmail, unsubscribed: false },
      [{ id: "topic_marketing", subscription: "opt_in" }],
      [{ id: "topic_marketing", subscription: "opt_out" }],
    ]);
  });

  it("reconciles a global restriction by read-back before and after mutation", async () => {
    const store = {
      claimGlobalSuppression: vi.fn(async () => ({
        operationId: "00000000-0000-4000-8000-000000000109",
        canonicalEmail: "restricted@synthetic.invalid",
        scope: "global" as const,
      })),
      recordGlobalSuppressionResult: vi.fn(async () => undefined),
    };
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        exists: false,
        contactSubscribed: false,
        topicSubscribed: false,
        globallyRestricted: false,
      })
      .mockResolvedValueOnce({
        exists: false,
        contactSubscribed: false,
        topicSubscribed: false,
        globallyRestricted: true,
      });
    const applyGlobalSuppression = vi.fn(async () => undefined);
    await reconcileOneGlobalSuppression(store, {
      read,
      apply: vi.fn(),
      applyGlobalSuppression,
      applyMarketingTopicSuppression: vi.fn(),
    });
    expect(applyGlobalSuppression).toHaveBeenCalledWith(
      "restricted@synthetic.invalid",
    );
    expect(store.recordGlobalSuppressionResult).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000109",
      "applied",
    );
  });
});

describe("manual communication safety", () => {
  it("keeps all four templates draft until exact Scott approval", async () => {
    expect(Object.keys(MANUAL_MESSAGE_TEMPLATES)).toEqual([
      "interview",
      "waitlist",
      "decision",
      "early_access",
    ]);
    const recorder = { record: vi.fn(async () => "recorded") };
    await expect(
      recordApprovedManualCommunication(
        {
          applicationId: "00000000-0000-4000-8000-000000000201",
          type: "interview",
          now,
        },
        null,
        recorder,
      ),
    ).rejects.toThrow("not approved");
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("records actor, exact type/version, time, and optional note after approval", async () => {
    const recorder = { record: vi.fn(async () => "recorded") };
    await expect(
      recordApprovedManualCommunication(
        {
          applicationId: "00000000-0000-4000-8000-000000000202",
          type: "waitlist",
          note: "Synthetic operator note",
          now,
        },
        {
          type: "waitlist",
          version: "waitlist-draft-v1",
          approvedBy: "scott_bishop",
          approvedAt: "2039-01-31T00:00:00.000Z",
        },
        recorder,
      ),
    ).resolves.toBe("recorded");
    expect(recorder.record).toHaveBeenCalledWith({
      applicationId: "00000000-0000-4000-8000-000000000202",
      type: "waitlist",
      templateVersion: "waitlist-draft-v1",
      actor: "scott_bishop",
      occurredAt: now.toISOString(),
      note: "Synthetic operator note",
    });
  });
});

describe("privacy identity proportionality", () => {
  it("accepts only bounded generic intake data", () => {
    expect(
      parsePrivacyIntake({
        operationKey: "AAAAAAAAAAAAAAAAAAAAAA",
        type: "export",
        email: "Rights@Synthetic.invalid",
        explanation: "Synthetic rights fixture",
        matchingName: "Synthetic Applicant",
        matchingOrganization: "Synthetic Organization",
        matchingSubmissionDate: "2039-01-01",
      }),
    ).toMatchObject({
      type: "export",
      canonicalEmail: "rights@synthetic.invalid",
    });
  });

  it.each([
    ["ordinary unsubscribe", "unsubscribe", true, true, undefined, "none"],
    [
      "routine correction",
      "correction",
      true,
      false,
      undefined,
      "email_confirmation",
    ],
    [
      "routine deletion",
      "deletion",
      true,
      false,
      undefined,
      "email_confirmation",
    ],
    ["access mismatch", "access", true, false, undefined, "matching_details"],
    ["export mismatch", "export", true, false, undefined, "matching_details"],
    [
      "inaccessible email",
      "deletion",
      false,
      false,
      "inaccessible_email",
      "formal_proof",
    ],
    [
      "suspected fraud",
      "access",
      true,
      true,
      "suspected_fraud",
      "formal_proof",
    ],
    ["representative", "export", true, true, "representative", "formal_proof"],
  ])(
    "uses proportional verification for %s",
    (
      _label,
      type,
      emailConfirmed,
      detailsMatch,
      exceptionalReason,
      expected,
    ) => {
      expect(
        requiredIdentityMethod({
          type: type as Parameters<typeof requiredIdentityMethod>[0]["type"],
          emailConfirmed: emailConfirmed as boolean,
          existingDetailsMatch: detailsMatch as boolean,
          exceptionalReason: exceptionalReason as Parameters<
            typeof requiredIdentityMethod
          >[0]["exceptionalReason"],
        }),
      ).toBe(expected);
    },
  );

  it("passes separate IP and canonical-email rate keys to intake storage", async () => {
    const createRequest = vi.fn(async () => undefined);
    const handler = createPrivacyIntakeHandler({
      store: { createRequest },
      digestOperationKey: (value) => `operation:${value}`,
      digestIpIdentity: (value) => `ip:${value}`,
      digestEmailIdentity: (value) => `email:${value}`,
      requestIpIdentity: () => "192.0.2.45",
    });
    const response = await handler(
      new Request("https://fidensa.example/api/privacy/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "192.0.2.45",
        },
        body: JSON.stringify({
          operationKey: "AAAAAAAAAAAAAAAAAAAAAA",
          type: "deletion",
          email: "Rights@Synthetic.invalid",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalEmail: "rights@synthetic.invalid",
        operationKey: "operation:AAAAAAAAAAAAAAAAAAAAAA",
      }),
      {
        ipDigest: "ip:192.0.2.45",
        emailDigest: "email:rights@synthetic.invalid",
      },
    );
  });

  it("consumes a privacy confirmation credential server-side with a generic response", async () => {
    const consumeConfirmation = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = createPrivacyConfirmationHandler({
      store: { consumeConfirmation },
      digestCredential: (credential) => `digest:${credential}`,
    });
    const credential = "pr1.AAAAAAAAAAAAAAAAAAAAAA";
    const request = () =>
      new Request("https://fidensa.example/api/privacy/requests/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });

    const first = await handler(request());
    const replay = await handler(request());
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await first.json()).toEqual(await replay.json());
    expect(consumeConfirmation).toHaveBeenNthCalledWith(
      1,
      `digest:${credential}`,
    );
  });

  it("stores only a credential digest before delivering a manually initiated confirmation", async () => {
    const events: string[] = [];
    const issuePrivacyConfirmation = vi.fn(async (_intent, digest) => {
      events.push("issued");
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(digest).not.toContain("pr1.");
    });
    const sender = {
      deliver: vi.fn(async (input) => {
        events.push("delivered");
        expect(input.confirmationUrl).toMatch(
          /^https:\/\/fidensa\.example\/privacy\/confirm#pr1\.[A-Za-z0-9_-]{22}$/u,
        );
        return {
          outcome: "accepted_by_provider" as const,
          providerMessageDigest: "a".repeat(64),
        };
      }),
    };
    const recordPrivacyConfirmationDelivery = vi.fn(async () => undefined);
    await expect(
      deliverOnePrivacyConfirmation({
        store: {
          claimPrivacyConfirmation: vi.fn(async () => ({
            intentId: "00000000-0000-4000-8000-000000000301",
            privacyRequestId: "00000000-0000-4000-8000-000000000302",
            generation: 1,
            recipient: "rights@synthetic.invalid",
            operationId: "00000000-0000-4000-8000-000000000303",
          })),
          issuePrivacyConfirmation,
          recordPrivacyConfirmationDelivery,
        },
        sender,
        tokenMaterial: "synthetic-token-material".repeat(4),
        siteOrigin: "https://fidensa.example",
      }),
    ).resolves.toBe(true);
    expect(events).toEqual(["issued", "delivered"]);
    expect(recordPrivacyConfirmationDelivery).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000301",
      "accepted_by_provider",
      "a".repeat(64),
    );
  });
});

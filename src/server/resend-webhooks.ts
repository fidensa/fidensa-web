import "server-only";

import { createHash } from "node:crypto";

import { Webhook } from "svix";

import { normalizeEmailAddress } from "../application/contract";
import { RequestBodyError, readBoundedText } from "./bounded-json";
import {
  restrictionForEvent,
  type ProviderRestriction,
} from "./consent-governance";

export const RESEND_WEBHOOK_MAX_BYTES = 256 * 1024;
export const RESEND_EVENT_TYPES = [
  "email.bounced",
  "email.complained",
  "email.suppressed",
  "contact.updated",
  "contact.deleted",
  "suppression.added",
  "suppression.removed",
] as const;

export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number];

export interface NormalizedResendEvent {
  readonly eventIdentity: string;
  readonly eventType: ResendEventType;
  readonly occurredAt: string;
  readonly canonicalEmail: string;
  readonly restriction: ProviderRestriction | null;
  readonly providerRelaxationClaimed: boolean;
}

export interface ProviderEventStore {
  recordAuthenticatedEvent(
    event: NormalizedResendEvent,
  ): Promise<"applied" | "duplicate" | "stale" | "needs_reconciliation">;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function eventEmail(type: ResendEventType, data: JsonRecord): string | null {
  if (type.startsWith("contact.")) {
    return typeof data.email === "string" ? data.email : null;
  }
  if (type.startsWith("suppression.")) {
    return typeof data.email === "string" ? data.email : null;
  }
  const recipients = data.to;
  return Array.isArray(recipients) && recipients.length === 1
    ? typeof recipients[0] === "string"
      ? recipients[0]
      : null
    : null;
}

function normalizeVerifiedEvent(
  value: unknown,
  svixId: string,
): NormalizedResendEvent {
  const payload = record(value);
  const data = record(payload?.data);
  const eventType = payload?.type;
  const occurredAt = payload?.created_at;
  if (
    !payload ||
    !data ||
    typeof eventType !== "string" ||
    !RESEND_EVENT_TYPES.includes(eventType as ResendEventType) ||
    typeof occurredAt !== "string" ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    throw new Error("Unsupported provider event.");
  }
  const typedEvent = eventType as ResendEventType;
  const email = eventEmail(typedEvent, data);
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) throw new Error("Provider event address is malformed.");

  const contactUnsubscribed = data.unsubscribed === true;
  return {
    eventIdentity: createHash("sha256").update(svixId).digest("hex"),
    eventType: typedEvent,
    occurredAt: new Date(occurredAt).toISOString(),
    canonicalEmail: normalizedEmail.canonical,
    restriction: restrictionForEvent(typedEvent, contactUnsubscribed),
    // Provider events can restrict immediately, but never release local state.
    providerRelaxationClaimed:
      typedEvent === "suppression.removed" ||
      (typedEvent === "contact.updated" && data.unsubscribed === false),
  };
}

function isUnsupportedVerifiedEvent(value: unknown): boolean {
  const payload = record(value);
  return (
    typeof payload?.type === "string" &&
    !RESEND_EVENT_TYPES.includes(payload.type as ResendEventType)
  );
}

function noStore(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export function createResendWebhookHandler(options: {
  readonly webhookSecret: string;
  readonly store: ProviderEventStore;
}) {
  if (
    !options.webhookSecret.startsWith("whsec_") ||
    options.webhookSecret.length < 20
  ) {
    throw new Error("The provider webhook verifier is not configured.");
  }
  const webhook = new Webhook(options.webhookSecret);
  return async function handle(request: Request): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > RESEND_WEBHOOK_MAX_BYTES
    ) {
      return noStore(413);
    }
    const id = request.headers.get("svix-id");
    const timestamp = request.headers.get("svix-timestamp");
    const signature = request.headers.get("svix-signature");
    if (!id || !timestamp || !signature || id.length > 200) return noStore(400);

    let raw: string;
    try {
      raw = await readBoundedText(request, RESEND_WEBHOOK_MAX_BYTES);
    } catch (error) {
      return noStore(
        error instanceof RequestBodyError && error.reason === "size"
          ? 413
          : 400,
      );
    }

    let verified: unknown;
    try {
      // Svix validates the signed raw bytes and timestamp before returning the
      // call. Parsing remains explicitly after this successful verification.
      webhook.verify(raw, {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      });
      verified = JSON.parse(raw) as unknown;
    } catch {
      return noStore(400);
    }

    let event: NormalizedResendEvent;
    try {
      event = normalizeVerifiedEvent(verified, id);
    } catch {
      // Validly signed event types outside this deliberately narrow consumer
      // contract are acknowledged so Resend does not retry them indefinitely.
      if (isUnsupportedVerifiedEvent(verified)) return noStore(204);
      return noStore(422);
    }
    await options.store.recordAuthenticatedEvent(event);
    return noStore(204);
  };
}

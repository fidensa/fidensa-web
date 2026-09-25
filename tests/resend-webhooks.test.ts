import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

vi.mock("server-only", () => ({}));

import {
  RESEND_WEBHOOK_MAX_BYTES,
  createResendWebhookHandler,
} from "../src/server/resend-webhooks";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

function signedRequest(payload: string, id = "msg_synthetic_webhook_01") {
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(id, timestamp, payload);
  return new Request("https://fidensa.example/api/webhooks/resend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}

describe("authenticated Resend webhook boundary", () => {
  it("verifies signed raw bytes before persisting a normalized topic opt-out", async () => {
    const recordAuthenticatedEvent = vi.fn(async () => "applied" as const);
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    const payload = JSON.stringify({
      type: "contact.updated",
      created_at: "2039-01-01T00:00:00.000Z",
      data: {
        id: "contact_synthetic_01",
        email: "Applicant@Synthetic.invalid",
        unsubscribed: true,
      },
    });
    expect((await handler(signedRequest(payload))).status).toBe(204);
    expect(recordAuthenticatedEvent).toHaveBeenCalledWith({
      eventIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      eventType: "contact.updated",
      occurredAt: "2039-01-01T00:00:00.000Z",
      canonicalEmail: "applicant@synthetic.invalid",
      restriction: {
        scope: "marketing_topic",
        reason: "marketing_unsubscribe",
        blocksApplicationMail: false,
      },
      providerRelaxationClaimed: false,
    });
  });

  it("rejects invalid signatures and malformed signed events without state change", async () => {
    const recordAuthenticatedEvent = vi.fn();
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    const invalid = signedRequest(
      JSON.stringify({
        type: "email.bounced",
        created_at: "2039-01-01T00:00:00.000Z",
        data: { to: ["bounce@synthetic.invalid"] },
      }),
    );
    invalid.headers.set("svix-signature", "v1,invalid");
    expect((await handler(invalid)).status).toBe(400);
    expect((await handler(signedRequest("not-json"))).status).toBe(400);
    expect(recordAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("acknowledges a signed unsupported event without state change", async () => {
    const recordAuthenticatedEvent = vi.fn();
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: "2039-01-01T00:00:00.000Z",
      data: { to: ["unsupported@synthetic.invalid"] },
    });
    expect(
      (await handler(signedRequest(payload, "msg_unsupported_signed"))).status,
    ).toBe(204);
    expect(recordAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as the raw-byte cap is crossed", async () => {
    const recordAuthenticatedEvent = vi.fn();
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    let cancelled = false;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (emitted > 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://fidensa.example/api/webhooks/resend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": "msg_chunked_oversize",
        "svix-timestamp": "2177452800",
        "svix-signature": "v1,synthetic",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await handler(request)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(emitted * 64 * 1024).toBeLessThanOrEqual(
      RESEND_WEBHOOK_MAX_BYTES + 64 * 1024,
    );
    expect(recordAuthenticatedEvent).not.toHaveBeenCalled();
  });

  it("uses stable event identity for replay and never applies provider relaxation", async () => {
    const events: unknown[] = [];
    const identities = new Set<string>();
    const recordAuthenticatedEvent = vi.fn(async (event) => {
      events.push(event);
      if (identities.has(event.eventIdentity)) return "duplicate" as const;
      identities.add(event.eventIdentity);
      return event.providerRelaxationClaimed
        ? ("needs_reconciliation" as const)
        : ("applied" as const);
    });
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    const removal = JSON.stringify({
      type: "suppression.removed",
      created_at: "2038-12-01T00:00:00.000Z",
      data: { email: "restricted@synthetic.invalid" },
    });
    await handler(signedRequest(removal, "msg_replay_identity"));
    await handler(signedRequest(removal, "msg_replay_identity"));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ providerRelaxationClaimed: true });
    expect(Reflect.get(events[0] as object, "eventIdentity")).toBe(
      Reflect.get(events[1] as object, "eventIdentity"),
    );
  });

  it.each([
    ["email.bounced", "bounce"],
    ["email.complained", "complaint"],
    ["email.suppressed", "provider_suppression"],
    ["suppression.added", "provider_suppression"],
  ])("normalizes %s as a global restriction", async (eventType, reason) => {
    const recordAuthenticatedEvent = vi.fn(async () => "applied" as const);
    const handler = createResendWebhookHandler({
      webhookSecret: secret,
      store: { recordAuthenticatedEvent },
    });
    const data = eventType.startsWith("email.")
      ? { to: ["global@synthetic.invalid"] }
      : { email: "global@synthetic.invalid" };
    await handler(
      signedRequest(
        JSON.stringify({
          type: eventType,
          created_at: "2039-01-01T00:00:00.000Z",
          data,
        }),
        `msg_${eventType}`,
      ),
    );
    expect(recordAuthenticatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        restriction: {
          scope: "global",
          reason,
          blocksApplicationMail: true,
        },
      }),
    );
  });
});

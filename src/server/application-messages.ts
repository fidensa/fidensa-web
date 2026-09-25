import "server-only";

import { createHash } from "node:crypto";

export const AUTOMATIC_MESSAGE_TYPES = [
  "application_verification",
  "application_receipt",
  "reviewer_notification",
] as const;

export type AutomaticMessage =
  | {
      readonly type: "application_verification";
      readonly recipient: string;
      readonly operationId: string;
      readonly verificationUrl: string;
    }
  | {
      readonly type: "application_receipt";
      readonly recipient: string;
      readonly operationId: string;
    }
  | {
      readonly type: "reviewer_notification";
      readonly recipient: string;
      readonly operationId: string;
      readonly applicationId: string;
      readonly recordUrl: string;
    };

export interface AutomaticMessageSender {
  deliver(message: AutomaticMessage): Promise<{
    readonly outcome: "accepted_by_provider" | "delivery_unknown" | "failed";
    readonly providerMessageDigest: string | null;
    readonly providerMessageId: string | null;
  }>;
  reconcile(providerMessageId: string): Promise<{
    readonly outcome: "accepted_by_provider" | "delivery_unknown" | "failed";
    readonly providerMessageDigest: string;
    readonly providerMessageId: string;
  }>;
}

interface ResendSenderOptions {
  readonly accessCredential: string;
  readonly reviewerRecipient: string;
  readonly fetchImplementation?: typeof fetch;
}

function messageContent(message: AutomaticMessage): {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
} {
  switch (message.type) {
    case "application_verification":
      return {
        to: message.recipient,
        subject: "Verify your Fidensa application email",
        text: [
          "Confirm that this email address belongs to you.",
          "",
          message.verificationUrl,
          "",
          "This single-use link expires in 60 minutes. If it expires, request another from the application page.",
          "If you did not submit an application, you can ignore this message.",
          "Questions or safety concerns: privacy@fidensa.com.",
        ].join("\n"),
      };
    case "application_receipt":
      return {
        to: message.recipient,
        subject: "Your Fidensa application is verified",
        text: [
          "Your email address is verified and your application has entered consideration.",
          "",
          "Applications are considered on a rolling basis and access is limited. Submission does not guarantee selection or access. We do not promise a review timeframe and may be unable to provide individual status updates or decision notices beyond the automated receipt. We will contact you if we wish to continue the conversation.",
          "Privacy questions: privacy@fidensa.com.",
        ].join("\n"),
      };
    case "reviewer_notification":
      return {
        to: message.recipient,
        subject: `New application ${message.applicationId}`,
        text: `New application ${message.applicationId}\n${message.recordUrl}`,
      };
  }
}

export function createResendAutomaticMessageSender({
  accessCredential,
  reviewerRecipient,
  fetchImplementation = fetch,
}: ResendSenderOptions): AutomaticMessageSender {
  if (accessCredential.length < 32 || !reviewerRecipient.includes("@")) {
    throw new Error("The message provider configuration is invalid.");
  }
  function digestProviderId(providerId: string): string {
    return createHash("sha256").update(providerId).digest("hex");
  }
  async function responseMetadata(response: Response): Promise<{
    readonly providerId: string | null;
    readonly errorName: string | null;
  }> {
    return response
      .json()
      .then((value: unknown) => {
        const record = typeof value === "object" && value !== null ? value : {};
        const id = Reflect.get(record, "id");
        const name = Reflect.get(record, "name");
        return {
          providerId:
            typeof id === "string" && id.length > 0 && id.length <= 200
              ? id
              : null,
          errorName: typeof name === "string" ? name : null,
        };
      })
      .catch(() => ({ providerId: null, errorName: null }));
  }
  return {
    async deliver(message) {
      const content = messageContent(
        message.type === "reviewer_notification"
          ? { ...message, recipient: reviewerRecipient }
          : message,
      );
      let response: Response;
      try {
        response = await fetchImplementation("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessCredential}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.operationId,
          },
          body: JSON.stringify({
            from: "Fidensa Applications <apply@fidensa.com>",
            to: [content.to],
            subject: content.subject,
            text: content.text,
          }),
        });
      } catch {
        return {
          outcome: "delivery_unknown",
          providerMessageDigest: null,
          providerMessageId: null,
        };
      }
      const { providerId, errorName } = await responseMetadata(response);
      if (response.ok) {
        return {
          outcome: "accepted_by_provider",
          providerMessageDigest: providerId
            ? digestProviderId(providerId)
            : null,
          providerMessageId: providerId,
        };
      }
      return {
        outcome:
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429 ||
          (response.status === 409 &&
            errorName === "concurrent_idempotent_requests")
            ? "delivery_unknown"
            : "failed",
        providerMessageDigest: providerId ? digestProviderId(providerId) : null,
        providerMessageId: providerId,
      };
    },

    async reconcile(providerMessageId) {
      if (providerMessageId.length === 0 || providerMessageId.length > 200) {
        throw new Error("Provider message identifier is malformed.");
      }
      const providerMessageDigest = digestProviderId(providerMessageId);
      let response: Response;
      try {
        response = await fetchImplementation(
          `https://api.resend.com/emails/${encodeURIComponent(providerMessageId)}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${accessCredential}` },
          },
        );
      } catch {
        return {
          outcome: "delivery_unknown",
          providerMessageDigest,
          providerMessageId,
        };
      }
      return {
        outcome: response.ok
          ? "accepted_by_provider"
          : response.status >= 500 ||
              response.status === 408 ||
              response.status === 429
            ? "delivery_unknown"
            : "failed",
        providerMessageDigest,
        providerMessageId,
      };
    },
  };
}

import "server-only";

import {
  APPLICATION_LIMITS,
  MARKETING_CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  parseApplicationSubmission,
  parseResendRequest,
  parseVerificationRequest,
  type ApplicationSubmission,
} from "../application/contract";
import type {
  ApplicationDatabase,
  ApplicationSubmissionRecord,
} from "./application-database";
import {
  digestEmailIdentity,
  digestIpIdentity,
  digestOperationKey,
  digestVerificationCredential,
  issueVerificationCredential,
  requestIpIdentity,
} from "./application-crypto";
import type {
  AutomaticMessage,
  AutomaticMessageSender,
} from "./application-messages";
import { readBoundedJson } from "./bounded-json";

export const GENERIC_APPLICATION_RESPONSE =
  "If the request is eligible, an email with the next step will be sent.";
export const GENERIC_VERIFICATION_RESPONSE =
  "The verification request has been processed.";

interface ApplicationServiceOptions {
  readonly database: ApplicationDatabase;
  readonly messages: AutomaticMessageSender;
  readonly tokenMaterial: string;
  readonly siteOrigin: string;
  readonly reviewerRecordBaseUrl: string;
  readonly synthetic: boolean;
  readonly defer: (task: () => Promise<void>) => void;
}

const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: noStoreHeaders,
  });
}

function generic(message: string): Response {
  return json(200, { message });
}

function recordFor(
  input: ApplicationSubmission,
  options: ApplicationServiceOptions,
  credentialDigest: string,
  ipDigest: string,
  emailDigest: string,
): ApplicationSubmissionRecord {
  return {
    synthetic: options.synthetic,
    canonicalEmail: input.canonicalEmail,
    deliveryEmail: input.deliveryEmail,
    operationDigest: digestOperationKey(
      options.tokenMaterial,
      input.operationKey,
    ),
    verificationDigest: credentialDigest,
    ipDigest,
    emailDigest,
    applicantName: input.name,
    roleFunction: input.roleFunction,
    context: input.context,
    organization: input.organization,
    intendedUseCase: input.intendedUseCase,
    workflowStage: input.workflowStage,
    deploymentPreference: input.deploymentPreference,
    evaluationTimeline: input.evaluationTimeline,
    designPartnerWillingness: input.designPartnerWillingness,
    integrationConstraints: input.integrationConstraints,
    referralSource: input.referralSource,
    additionalContext: input.additionalContext,
    noticeVersion: PRIVACY_NOTICE_VERSION,
    marketingSelected: input.marketingSelected,
    consentTextVersion: input.marketingSelected
      ? MARKETING_CONSENT_VERSION
      : null,
  };
}

async function reconcileMessage(
  options: ApplicationServiceOptions,
  operationId?: string,
): Promise<boolean> {
  const claim = await options.database.claimMessage(operationId);
  if (!claim) return false;
  try {
    const result = claim.providerMessageId
      ? await options.messages.reconcile(claim.providerMessageId)
      : await (async () => {
          let message: AutomaticMessage;
          switch (claim.messageType) {
            case "application_verification": {
              await options.database.escalateMessage(
                claim.operationId,
                "credential_unavailable",
              );
              return null;
            }
            case "application_receipt":
              message = {
                type: claim.messageType,
                recipient: claim.deliveryEmail,
                operationId: claim.operationId,
              };
              break;
            case "reviewer_notification":
              message = {
                type: claim.messageType,
                recipient: "reviewer",
                operationId: claim.operationId,
                applicationId: claim.applicationId,
                recordUrl: new URL(
                  claim.applicationId,
                  `${options.reviewerRecordBaseUrl}/`,
                ).toString(),
              };
              break;
          }
          return options.messages.deliver(message);
        })();
    if (!result) return true;
    await options.database.recordMessageOutcome(
      claim.operationId,
      result.outcome,
      result.providerMessageDigest,
      result.providerMessageId,
    );
  } catch {
    await options.database
      .recordMessageOutcome(claim.operationId, "failed", null, null)
      .catch(() => undefined);
  }
  return true;
}

async function deliverTransientVerification(
  options: ApplicationServiceOptions,
  intent: { readonly deliveryEmail: string; readonly operationId: string },
  credential: string,
): Promise<void> {
  try {
    const result = await options.messages.deliver({
      type: "application_verification",
      recipient: intent.deliveryEmail,
      operationId: intent.operationId,
      verificationUrl: `${options.siteOrigin}/apply/verify#${credential}`,
    });
    await options.database.recordMessageOutcome(
      intent.operationId,
      result.outcome,
      result.providerMessageDigest,
      result.providerMessageId,
    );
  } catch {
    await options.database
      .recordMessageOutcome(intent.operationId, "failed", null, null)
      .catch(() => undefined);
  }
}

async function reconcileOutstanding(
  options: ApplicationServiceOptions,
  limit = 5,
): Promise<number> {
  let processed = 0;
  for (; processed < limit; processed += 1) {
    if (!(await reconcileMessage(options))) return processed;
  }
  return processed;
}

function defer(options: ApplicationServiceOptions, task: () => Promise<void>) {
  options.defer(async () => {
    try {
      await task();
    } catch {
      // Public request completion and background integration failures are
      // deliberately separated. Durable outbox state remains observable.
    }
  });
}

export function createApplicationService(options: ApplicationServiceOptions) {
  if (options.tokenMaterial.length < 32) {
    throw new Error("Token derivation material is missing or malformed.");
  }

  return {
    async submit(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await readBoundedJson(request, APPLICATION_LIMITS.requestBytes);
      } catch {
        return json(400, {
          errors: { request: "Submit a valid bounded JSON request." },
        });
      }
      const parsed = parseApplicationSubmission(raw);
      if (!parsed.ok) return json(422, { errors: parsed.errors });

      const ipDigest = digestIpIdentity(
        options.tokenMaterial,
        requestIpIdentity(request),
      );
      const emailDigest = digestEmailIdentity(
        options.tokenMaterial,
        parsed.value.canonicalEmail,
      );
      if (parsed.value.companyWebsite) {
        defer(options, () =>
          options.database.recordHoneypot(ipDigest, emailDigest),
        );
        return generic(GENERIC_APPLICATION_RESPONSE);
      }

      const credential = issueVerificationCredential();
      defer(options, async () => {
        await reconcileOutstanding(options);
        const intent = await options.database.submit(
          recordFor(
            parsed.value,
            options,
            digestVerificationCredential(options.tokenMaterial, credential),
            ipDigest,
            emailDigest,
          ),
        );
        if (intent)
          await deliverTransientVerification(options, intent, credential);
      });
      return generic(GENERIC_APPLICATION_RESPONSE);
    },

    async verify(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await readBoundedJson(request, APPLICATION_LIMITS.requestBytes);
      } catch {
        return generic(GENERIC_VERIFICATION_RESPONSE);
      }
      const parsed = parseVerificationRequest(raw);
      if (!parsed.ok) return generic(GENERIC_VERIFICATION_RESPONSE);
      const ipDigest = digestIpIdentity(
        options.tokenMaterial,
        requestIpIdentity(request),
      );
      defer(options, async () => {
        await reconcileOutstanding(options);
        const intent = await options.database.verify(
          digestVerificationCredential(
            options.tokenMaterial,
            parsed.credential,
          ),
          ipDigest,
        );
        if (intent) {
          await Promise.all([
            reconcileMessage(options, intent.receiptOperationId),
            reconcileMessage(options, intent.reviewerOperationId),
          ]);
        }
      });
      return generic(GENERIC_VERIFICATION_RESPONSE);
    },

    async resend(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await readBoundedJson(request, APPLICATION_LIMITS.requestBytes);
      } catch {
        return json(400, { errors: { email: "Enter a valid email address." } });
      }
      const parsed = parseResendRequest(raw);
      if (!parsed.ok) return json(422, { errors: parsed.errors });
      const credential = issueVerificationCredential();
      const ipDigest = digestIpIdentity(
        options.tokenMaterial,
        requestIpIdentity(request),
      );
      const emailDigest = digestEmailIdentity(
        options.tokenMaterial,
        parsed.value.canonicalEmail,
      );
      defer(options, async () => {
        await reconcileOutstanding(options);
        const intent = await options.database.resendVerification(
          parsed.value.canonicalEmail,
          digestVerificationCredential(options.tokenMaterial, credential),
          ipDigest,
          emailDigest,
        );
        if (intent)
          await deliverTransientVerification(options, intent, credential);
      });
      return generic(GENERIC_APPLICATION_RESPONSE);
    },

    async reconcile(): Promise<number> {
      return reconcileOutstanding(options, 100);
    },
  };
}

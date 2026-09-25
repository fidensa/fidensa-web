import "server-only";

import { createHash } from "node:crypto";
import { after } from "next/server";

import type { ApplicationDatabase } from "./application-database";
import { createSupabaseApplicationDatabase } from "./application-database";
import { createResendAutomaticMessageSender } from "./application-messages";
import { createApplicationService } from "./application-service";
import { getServerConfig } from "./config";
import { writeSafeLog } from "./log";

const closedDatabase: ApplicationDatabase = {
  async submit() {
    return null;
  },
  async verify() {
    return null;
  },
  async resendVerification() {
    return null;
  },
  async claimMessage() {
    return null;
  },
  async recordMessageOutcome() {},
  async escalateMessage() {},
  async recordHoneypot() {},
};

const captureMessages = {
  async deliver() {
    return {
      outcome: "accepted_by_provider" as const,
      providerMessageDigest: null,
      providerMessageId: null,
    };
  },
  async reconcile(providerMessageId: string) {
    return {
      outcome: "accepted_by_provider" as const,
      providerMessageDigest: createHash("sha256")
        .update(providerMessageId)
        .digest("hex"),
      providerMessageId,
    };
  },
};

export function createRuntimeApplicationService() {
  const config = getServerConfig();
  const productionClass =
    config.environment === "production" ||
    config.environment === "staged-production";
  if (!productionClass) {
    const material = createHash("sha256")
      .update("fidensa-local-application-fixture")
      .update(config.public.siteOrigin)
      .digest("hex");
    return createApplicationService({
      database: closedDatabase,
      messages: captureMessages,
      tokenMaterial: material,
      siteOrigin: config.public.siteOrigin,
      reviewerRecordBaseUrl: `${config.public.siteOrigin}/closed-reviewer-records`,
      synthetic: true,
      log: () =>
        writeSafeLog({
          environment: config.environment,
          eventClass: "request_completed",
          resultClass: "succeeded",
        }),
      defer: (task) => after(task),
    });
  }

  if (!config.serverCredentials || !config.serverServices) {
    throw new Error(
      "The application service is closed: runtime configuration is incomplete.",
    );
  }
  return createApplicationService({
    database: createSupabaseApplicationDatabase({
      baseUrl: config.serverServices.dataApiOrigin,
      serviceCredential: config.serverCredentials.dataAccess,
    }),
    messages: createResendAutomaticMessageSender({
      accessCredential: config.serverCredentials.messageAccess,
      reviewerRecipient: config.serverServices.reviewerNotificationRecipient,
    }),
    tokenMaterial: config.serverCredentials.tokenMaterial,
    siteOrigin: config.public.siteOrigin,
    reviewerRecordBaseUrl: config.serverServices.reviewerRecordBaseUrl,
    synthetic: config.environment !== "production",
    log: () =>
      writeSafeLog({
        environment: config.environment,
        eventClass: "request_completed",
        resultClass: "succeeded",
      }),
    exerciseAuthority:
      config.environment === "staged-production"
        ? {
            correlationId: config.serverServices.exerciseCorrelationId!,
            exactRecipient: config.serverServices.exerciseRecipient!,
          }
        : undefined,
    defer: (task) => after(task),
  });
}

export const APPLICATION_RECONCILIATION_CRON = "10 * * * *";

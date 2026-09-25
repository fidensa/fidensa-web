import "server-only";

import {
  digestEmailIdentity,
  digestIpIdentity,
  digestOperationKey,
  digestPrivacyConfirmationCredential,
  requestIpIdentity,
} from "./application-crypto";
import { getServerConfig } from "./config";
import { createSupabaseGovernanceDatabase } from "./governance-database";
import {
  createResendPrivacyConfirmationSender,
  deliverOnePrivacyConfirmation,
} from "./privacy-confirmation-delivery";
import {
  createPrivacyConfirmationHandler,
  createPrivacyIntakeHandler,
} from "./privacy-rights";
import {
  createResendMarketingContactProvider,
  reconcileOneGlobalSuppression,
  reconcileOneSubscription,
} from "./resend-contact-sync";
import { createResendWebhookHandler } from "./resend-webhooks";

export const CONSENT_RECONCILIATION_CRON = "25 * * * *";
export const PRIVACY_CONFIRMATION_RECONCILIATION_CRON = "40 * * * *";

function unavailable(): Response {
  return new Response(null, {
    status: 503,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export function createRuntimeResendWebhookHandler() {
  const config = getServerConfig();
  if (!config.serverCredentials || !config.serverServices) {
    return async () => unavailable();
  }
  const store = createSupabaseGovernanceDatabase({
    baseUrl: config.serverServices.dataApiOrigin,
    serviceCredential: config.serverCredentials.dataAccess,
  });
  return createResendWebhookHandler({
    webhookSecret: config.serverCredentials.resendWebhookSecret,
    store,
  });
}

export function createRuntimePrivacyIntakeHandler() {
  const config = getServerConfig();
  if (!config.serverCredentials || !config.serverServices) {
    return async () => unavailable();
  }
  const store = createSupabaseGovernanceDatabase({
    baseUrl: config.serverServices.dataApiOrigin,
    serviceCredential: config.serverCredentials.dataAccess,
  });
  return createPrivacyIntakeHandler({
    store,
    digestOperationKey: (key) =>
      digestOperationKey(config.serverCredentials!.tokenMaterial, key),
    digestIpIdentity: (ip) =>
      digestIpIdentity(config.serverCredentials!.tokenMaterial, ip),
    digestEmailIdentity: (email) =>
      digestEmailIdentity(config.serverCredentials!.tokenMaterial, email),
    requestIpIdentity,
  });
}

export function createRuntimePrivacyConfirmationHandler() {
  const config = getServerConfig();
  if (!config.serverCredentials || !config.serverServices) {
    return async () => unavailable();
  }
  const store = createSupabaseGovernanceDatabase({
    baseUrl: config.serverServices.dataApiOrigin,
    serviceCredential: config.serverCredentials.dataAccess,
  });
  return createPrivacyConfirmationHandler({
    store,
    digestCredential: (credential) =>
      digestPrivacyConfirmationCredential(
        config.serverCredentials!.tokenMaterial,
        credential,
      ),
  });
}

export async function reconcileRuntimeConsent(): Promise<void> {
  const config = getServerConfig();
  if (!config.serverCredentials || !config.serverServices) return;
  const store = createSupabaseGovernanceDatabase({
    baseUrl: config.serverServices.dataApiOrigin,
    serviceCredential: config.serverCredentials.dataAccess,
  });
  const provider = createResendMarketingContactProvider({
    accessCredential: config.serverCredentials.marketingReconcileAccess,
    marketingTopicId: config.serverServices.marketingTopicId,
  });
  for (let index = 0; index < 25; index += 1) {
    if (!(await reconcileOneSubscription(store, provider))) break;
  }
  for (let index = 0; index < 25; index += 1) {
    if (!(await reconcileOneGlobalSuppression(store, provider))) break;
  }
}

export async function reconcileRuntimePrivacyConfirmations(): Promise<void> {
  const config = getServerConfig();
  if (!config.serverCredentials || !config.serverServices) return;
  const store = createSupabaseGovernanceDatabase({
    baseUrl: config.serverServices.dataApiOrigin,
    serviceCredential: config.serverCredentials.dataAccess,
  });
  const sender = createResendPrivacyConfirmationSender({
    accessCredential: config.serverCredentials.messageAccess,
  });
  for (let index = 0; index < 10; index += 1) {
    if (
      !(await deliverOnePrivacyConfirmation({
        store,
        sender,
        tokenMaterial: config.serverCredentials.tokenMaterial,
        siteOrigin: config.public.siteOrigin,
      }))
    ) {
      break;
    }
  }
}

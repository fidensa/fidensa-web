export const environmentClasses = [
  "local",
  "test",
  "staged-production",
  "production",
] as const;

export type EnvironmentClass = (typeof environmentClasses)[number];
export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export type PublicConfig = Readonly<{
  siteOrigin: string;
}>;

export type BuildConfig = Readonly<{
  environment: EnvironmentClass;
  public: PublicConfig;
  providerProfile: "synthetic" | "deterministic" | "production";
  deliveryProfile: "capture" | "controlled" | "production";
  buildIdentity?: string;
  deploymentIdentity?: string;
  configurationDigest?: string;
}>;

export type RuntimeConfig = BuildConfig &
  Readonly<{
    serverCredentials?: Readonly<{
      dataAccess: string;
      messageAccess: string;
      tokenMaterial: string;
      reconciliationAccess: string;
      marketingReconcileAccess: string;
      resendWebhookSecret: string;
    }>;
    serverServices?: Readonly<{
      dataApiOrigin: string;
      reviewerRecordBaseUrl: string;
      reviewerNotificationRecipient: string;
      marketingTopicId: string;
    }>;
  }>;

export class EnvironmentValidationError extends Error {
  constructor(category: string, reason: string) {
    super(`Invalid ${category} configuration: ${reason}.`);
    this.name = "EnvironmentValidationError";
  }
}

function readRequired(
  input: EnvironmentInput,
  name: string,
  category: string,
): string {
  const value = input[name]?.trim();
  if (!value) {
    throw new EnvironmentValidationError(
      category,
      "a required value is missing",
    );
  }
  return value;
}

function readEnvironment(input: EnvironmentInput): EnvironmentClass {
  const raw = readRequired(input, "APP_ENV", "environment identity");
  if (!environmentClasses.includes(raw as EnvironmentClass)) {
    throw new EnvironmentValidationError(
      "environment identity",
      "the class is not supported",
    );
  }
  return raw as EnvironmentClass;
}

function readOrigin(
  input: EnvironmentInput,
  environment: EnvironmentClass,
): string {
  const raw = readRequired(
    input,
    "NEXT_PUBLIC_SITE_ORIGIN",
    "canonical origin",
  );

  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new EnvironmentValidationError(
      "canonical origin",
      "the value is not an absolute URL",
    );
  }

  if (origin.origin !== raw || origin.username || origin.password) {
    throw new EnvironmentValidationError(
      "canonical origin",
      "the URL must contain only scheme, host, and optional port",
    );
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  const isProductionClass =
    environment === "production" || environment === "staged-production";

  if (isProductionClass && (origin.protocol !== "https:" || isLoopback)) {
    throw new EnvironmentValidationError(
      "canonical origin",
      "production-class environments require non-loopback HTTPS",
    );
  }

  if (!isProductionClass && !isLoopback) {
    throw new EnvironmentValidationError(
      "canonical origin",
      "local and test environments require a loopback host",
    );
  }

  if (!isProductionClass && !["http:", "https:"].includes(origin.protocol)) {
    throw new EnvironmentValidationError(
      "canonical origin",
      "the URL scheme is not allowed",
    );
  }

  return origin.origin;
}

function readProviderProfile(
  input: EnvironmentInput,
  environment: EnvironmentClass,
): BuildConfig["providerProfile"] {
  const profile = readRequired(input, "PROVIDER_PROFILE", "provider posture");
  if (!["synthetic", "deterministic", "production"].includes(profile)) {
    throw new EnvironmentValidationError(
      "provider posture",
      "the profile is not supported",
    );
  }

  const requiresProduction =
    environment === "production" || environment === "staged-production";
  if ((profile === "production") !== requiresProduction) {
    throw new EnvironmentValidationError(
      "provider posture",
      "the profile contradicts the environment class",
    );
  }
  return profile as BuildConfig["providerProfile"];
}

function readDeliveryProfile(
  input: EnvironmentInput,
  environment: EnvironmentClass,
): BuildConfig["deliveryProfile"] {
  const profile = readRequired(input, "DELIVERY_PROFILE", "delivery posture");
  if (!["capture", "controlled", "production"].includes(profile)) {
    throw new EnvironmentValidationError(
      "delivery posture",
      "the profile is not supported",
    );
  }

  const isProduction = environment === "production";
  const isStaged = environment === "staged-production";
  const valid = isProduction
    ? profile === "production"
    : isStaged
      ? profile === "controlled"
      : profile === "capture";

  if (!valid) {
    throw new EnvironmentValidationError(
      "delivery posture",
      "the profile contradicts the environment class",
    );
  }
  return profile as BuildConfig["deliveryProfile"];
}

const sensitiveName =
  /(CREDENTIAL|PASSWORD|PRIVATE|SECRET|TOKEN|(?:^|_)KEY(?:_|$)|SERVICE_ROLE|SB_SECRET)/u;
const providerName = /^(SUPABASE|RESEND)_/u;

function rejectPublicSensitiveConfiguration(input: EnvironmentInput): void {
  for (const name of Object.keys(input)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    const publicName = name.slice("NEXT_PUBLIC_".length);
    if (sensitiveName.test(publicName) || providerName.test(publicName)) {
      throw new EnvironmentValidationError(
        "public configuration boundary",
        "a public variable uses a server-only category name",
      );
    }
  }
}

function rejectPublicServerValueCollisions(input: EnvironmentInput): void {
  const publicValues = new Set(
    Object.entries(input)
      .filter(([name]) => name.startsWith("NEXT_PUBLIC_"))
      .map(([, value]) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const serverValues = Object.entries(input)
    .filter(([name]) => {
      if (name.startsWith("NEXT_PUBLIC_")) return false;
      if (name.startsWith("NEXT_") || name.startsWith("__NEXT_")) return false;
      return (
        name.startsWith("SERVER_") ||
        sensitiveName.test(name) ||
        providerName.test(name)
      );
    })
    .map(([, value]) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (serverValues.some((value) => publicValues.has(value))) {
    throw new EnvironmentValidationError(
      "public configuration boundary",
      "a public value collides with server-only material",
    );
  }
}

function productionIdentity(
  input: EnvironmentInput,
  environment: EnvironmentClass,
  name: string,
  category: string,
): string | undefined {
  if (environment === "production" || environment === "staged-production") {
    return readRequired(input, name, category);
  }
  return input[name]?.trim() || undefined;
}

export function validateBuildEnvironment(input: EnvironmentInput): BuildConfig {
  rejectPublicSensitiveConfiguration(input);
  rejectPublicServerValueCollisions(input);
  const environment = readEnvironment(input);

  return {
    environment,
    public: { siteOrigin: readOrigin(input, environment) },
    providerProfile: readProviderProfile(input, environment),
    deliveryProfile: readDeliveryProfile(input, environment),
    buildIdentity: productionIdentity(
      input,
      environment,
      "BUILD_ID",
      "build identity",
    ),
    deploymentIdentity: productionIdentity(
      input,
      environment,
      "DEPLOYMENT_ID",
      "deployment identity",
    ),
    configurationDigest: productionIdentity(
      input,
      environment,
      "CONFIG_DIGEST",
      "configuration identity",
    ),
  };
}

function readServerCredential(
  input: EnvironmentInput,
  name: string,
  category: string,
): string {
  const value = readRequired(input, name, category);
  if (value.length < 32 || /(example|placeholder|changeme)/iu.test(value)) {
    throw new EnvironmentValidationError(
      category,
      "the supplied material does not meet the production policy",
    );
  }
  return value;
}

function readServerUrl(
  input: EnvironmentInput,
  name: string,
  category: string,
): string {
  const value = readRequired(input, name, category);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentValidationError(category, "the URL is malformed");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new EnvironmentValidationError(
      category,
      "the URL must be credential-free HTTPS without a query or fragment",
    );
  }
  return value.replace(/\/$/u, "");
}

export function validateRuntimeEnvironment(
  input: EnvironmentInput,
): RuntimeConfig {
  const build = validateBuildEnvironment(input);
  const isProductionClass =
    build.environment === "production" ||
    build.environment === "staged-production";

  const credentialNames = [
    "SERVER_DATA_ACCESS_CREDENTIAL",
    "SERVER_MESSAGE_ACCESS_CREDENTIAL",
    "SERVER_TOKEN_DERIVATION_MATERIAL",
    "SERVER_RECONCILIATION_CREDENTIAL",
    "SERVER_MARKETING_RECONCILE_CREDENTIAL",
    "SERVER_RESEND_WEBHOOK_SECRET",
  ] as const;

  if (!isProductionClass) {
    if (credentialNames.some((name) => Boolean(input[name]))) {
      throw new EnvironmentValidationError(
        "server credential boundary",
        "production credential material is forbidden in this environment",
      );
    }
    return build;
  }

  const serverCredentials = {
    dataAccess: readServerCredential(
      input,
      credentialNames[0],
      "data provider credential",
    ),
    messageAccess: readServerCredential(
      input,
      credentialNames[1],
      "message provider credential",
    ),
    tokenMaterial: readServerCredential(
      input,
      credentialNames[2],
      "token derivation material",
    ),
    reconciliationAccess: readServerCredential(
      input,
      credentialNames[3],
      "reconciliation entry credential",
    ),
    marketingReconcileAccess: readServerCredential(
      input,
      credentialNames[4],
      "marketing reconciliation credential",
    ),
    resendWebhookSecret: readServerCredential(
      input,
      credentialNames[5],
      "Resend webhook signing secret",
    ),
  };

  const reviewerNotificationRecipient = readRequired(
    input,
    "SERVER_REVIEWER_NOTIFICATION_RECIPIENT",
    "reviewer notification recipient",
  ).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(reviewerNotificationRecipient)) {
    throw new EnvironmentValidationError(
      "reviewer notification recipient",
      "the address is malformed",
    );
  }
  const serverServices = {
    dataApiOrigin: readServerUrl(
      input,
      "SERVER_DATA_API_ORIGIN",
      "data API origin",
    ),
    reviewerRecordBaseUrl: readServerUrl(
      input,
      "SERVER_REVIEWER_RECORD_BASE_URL",
      "reviewer record location",
    ),
    reviewerNotificationRecipient,
    marketingTopicId: readRequired(
      input,
      "SERVER_RESEND_MARKETING_TOPIC_ID",
      "Resend marketing topic identity",
    ),
  };

  return { ...build, serverCredentials, serverServices };
}

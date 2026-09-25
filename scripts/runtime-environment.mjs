const exactNames = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "APP_ENV",
  "VERCEL_ENV",
  "NEXT_PUBLIC_SITE_ORIGIN",
  "PROVIDER_PROFILE",
  "DELIVERY_PROFILE",
  "BUILD_ID",
  "DEPLOYMENT_ID",
  "CONFIG_DIGEST",
  "NODE_ENV",
  "NODE_OPTIONS",
]);

export function runtimeEnvironment(overrides = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (exactNames.has(name) ||
        name.startsWith("SERVER_") ||
        name.startsWith("npm_"))
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, ...overrides, PWD: process.cwd() };
}

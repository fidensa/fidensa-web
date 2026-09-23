import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertSupportedToolchain } from "./toolchain.mjs";

const command = process.argv[2];
if (!new Set(["build", "dev", "start"]).has(command)) {
  throw new Error("Expected one Next.js command: build, dev, or start.");
}

const npmVersion = (process.env.npm_config_user_agent ?? "").match(
  /npm\/(\d+\.\d+\.\d+)/u,
)?.[1];
if (!npmVersion) {
  throw new Error("Unable to determine npm version from the package runner.");
}
assertSupportedToolchain(process.versions.node, npmVersion);

const environment = { ...process.env };
if (!environment.APP_ENV && !environment.VERCEL_ENV) {
  const development = command === "dev";
  environment.APP_ENV = development ? "local" : "test";
  environment.NEXT_PUBLIC_SITE_ORIGIN = development
    ? "http://localhost:3000"
    : "http://127.0.0.1:3000";
  environment.PROVIDER_PROFILE = development ? "synthetic" : "deterministic";
  environment.DELIVERY_PROFILE = "capture";
}

if (!environment.APP_ENV && environment.VERCEL_ENV) {
  const mapping = {
    development: "local",
    preview: "staged-production",
    production: "production",
  };
  environment.APP_ENV = mapping[environment.VERCEL_ENV];
}

const nextBinary = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const child = spawn(
  process.execPath,
  [nextBinary, command, ...process.argv.slice(3)],
  {
    env: environment,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git",
  ".next",
  ".npm-cache",
  ".claude",
  "node_modules",
  "coverage",
  "test-results",
]);

async function filesBelow(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const nextRelative = path.join(relative, entry.name);
    const nextPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await filesBelow(nextPath, nextRelative)));
    else if (entry.isFile()) files.push(nextRelative);
  }
  return files;
}

async function scanFiles(files, forbidden, label) {
  const findings = [];
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8").catch(
      () => "",
    );
    for (const value of forbidden) {
      if (content.toLowerCase().includes(value.toLowerCase())) {
        findings.push(`${file}: ${label}`);
      }
    }
  }
  if (findings.length) {
    throw new Error(`Artifact inspection failed:\n${findings.join("\n")}`);
  }
}

const sourceFiles = await filesBelow(root);
if (
  await readdir(path.join(root, ".next", "cache")).then(
    () => true,
    () => false,
  )
) {
  throw new Error("Generated build cache must be absent from the work root.");
}
const clientFiles = await filesBelow(path.join(root, ".next", "static")).then(
  (files) => files.map((file) => path.join(".next", "static", file)),
);
const serverFiles = await filesBelow(path.join(root, ".next", "server")).then(
  (files) => files.map((file) => path.join(".next", "server", file)),
);

const privilegedIdentifiers = [
  ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_"),
  ["RESEND", "API", "KEY"].join("_"),
  ["VERIFICATION", "SECRET"].join("_"),
  ["ADMIN", "PASSWORD"].join("_"),
  ["fixture", "privileged", "browser", "sentinel"].join("-"),
];
const prohibitedIntegrations = [
  ["@vercel", "analytics"].join("/"),
  ["@vercel", "speed-insights"].join("/"),
  ["google", "tagmanager"].join(""),
  ["hot", "jar"].join(""),
  ["full", "story"].join(""),
];

await scanFiles(
  [...sourceFiles, ...clientFiles, ...serverFiles],
  privilegedIdentifiers,
  "privileged identifier or sentinel",
);
await scanFiles(
  [...sourceFiles, ...clientFiles, ...serverFiles],
  prohibitedIntegrations,
  "prohibited analytics integration",
);

const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const dependencyNames = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
].map((name) => name.toLowerCase());
for (const integration of prohibitedIntegrations) {
  if (dependencyNames.includes(integration.toLowerCase())) {
    throw new Error("A prohibited analytics dependency is installed.");
  }
}

const competingLocks = ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
if (sourceFiles.some((file) => competingLocks.includes(file))) {
  throw new Error("More than one dependency lockfile is present.");
}

const migrationFiles = sourceFiles.filter((file) =>
  file.startsWith("migrations/"),
);
const approvedMigrationFiles = new Set([
  "migrations/README.md",
  "migrations/20260924221000_protected_application_database.sql",
  "migrations/20260924222000_constrained_operations_and_queue.sql",
  "migrations/20260924222500_security_and_exercise_operations.sql",
  "migrations/20260924223000_retention_jobs.sql",
  "migrations/20260924223500_review_closure_guards.sql",
  "migrations/20260924224000_owner_authority_hardening.sql",
  "migrations/20260924224500_authoritative_time_and_health_retry_guards.sql",
  "migrations/20260924225000_lifecycle_and_retention_anchor_guards.sql",
  "migrations/20260924225500_schedule_and_truncate_guards.sql",
  "migrations/20260925100000_application_delivery_intents.sql",
  "migrations/20260925101000_consent_suppression_privacy_operations.sql",
  "migrations/20260925101500_global_suppression_delivery_guard.sql",
  "migrations/20260925102000_first_activation_reconciliation_guard.sql",
  "migrations/20260925103000_controlled_exercise_acceptance_guards.sql",
  "migrations/recovery/20260924223000_drop_protected_application_database.sql",
]);
if (
  migrationFiles.length !== approvedMigrationFiles.size ||
  migrationFiles.some((file) => !approvedMigrationFiles.has(file))
) {
  throw new Error(
    "The migration inventory differs from the approved application database set.",
  );
}

await scanFiles(
  clientFiles,
  ["fidensa_private", "SERVER_DATA_ACCESS_CREDENTIAL"],
  "private database locator or server credential category in client output",
);

process.stdout.write(
  `Artifact inspection passed: ${sourceFiles.length} governed source files, ${clientFiles.length} client build files, ${serverFiles.length} server build files.\n`,
);

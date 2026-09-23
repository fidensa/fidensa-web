import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git",
  ".next",
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
if (migrationFiles.some((file) => file !== "migrations/README.md")) {
  throw new Error("A production migration appeared before its approved phase.");
}

process.stdout.write(
  `Artifact inspection passed: ${sourceFiles.length} governed source files, ${clientFiles.length} client build files, ${serverFiles.length} server build files.\n`,
);

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSecurityBaselineHeaders,
  assertSecurityHeaders,
} from "../src/security/header-oracle.ts";

const port = Number(process.env.FOUNDATION_TEST_PORT ?? "43173");
const baseUrl = `http://127.0.0.1:${port}`;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(
    new URL("../config/security-routes.json", import.meta.url),
    "utf8",
  ),
);
if (manifest.version !== 2 || !Array.isArray(manifest.routes)) {
  throw new Error("Unknown or malformed security route manifest.");
}

const routeClasses = new Set([
  "public-html",
  "public-error",
  "framework-error",
  "fingerprinted-asset",
]);
for (const route of manifest.routes) {
  if (
    !routeClasses.has(route.class) ||
    !Number.isInteger(route.status) ||
    !Array.isArray(route.methods) ||
    !["html-nonce", "non-html"].includes(route.representation)
  ) {
    throw new Error("Security route manifest contains an unknown route class.");
  }
}

async function filesBelow(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const nextRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await filesBelow(path.join(directory, entry.name), nextRelative)),
      );
    } else if (entry.isFile()) {
      files.push(nextRelative);
    }
  }
  return files;
}

async function firstFingerprintedAsset() {
  const staticRoot = path.join(projectRoot, ".next", "static");
  const files = await filesBelow(staticRoot);
  const asset = files.find((file) =>
    /(?:^|[-.])[a-z0-9]{8,}\.(?:css|js|woff2?)$/iu.test(file),
  );
  if (!asset) {
    throw new Error("Built output contains no fingerprinted static asset.");
  }
  return `/_next/static/${asset.split(path.sep).join("/")}`;
}

const resolvedRoutes = [];
for (const route of manifest.routes) {
  resolvedRoutes.push({
    ...route,
    path:
      route.path === "$FIRST_FINGERPRINTED_STATIC_ASSET"
        ? await firstFingerprintedAsset()
        : route.path,
  });
}

const nextBinary = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);
const server = spawn(
  process.execPath,
  [nextBinary, "start", "-H", "127.0.0.1", "-p", String(port)],
  {
    env: {
      ...process.env,
      APP_ENV: "test",
      NEXT_PUBLIC_SITE_ORIGIN: baseUrl,
      PROVIDER_PROFILE: "deterministic",
      DELIVERY_PROFILE: "capture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
server.stdout.on("data", (chunk) => (output += chunk.toString()));
server.stderr.on("data", (chunk) => (output += chunk.toString()));

async function waitUntilReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Route server exited before readiness.\n${output}`);
    }
    try {
      await fetch(baseUrl, { redirect: "manual" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for route server.\n${output}`);
}

function assertRouteHeaders(route, headers) {
  try {
    if (route.class === "fingerprinted-asset") {
      assertSecurityBaselineHeaders(headers, "test", "http:");
    } else {
      assertSecurityHeaders(headers, "test", "http:");
    }
  } catch (error) {
    throw new Error(`${route.class} ${route.path}: ${String(error)}`);
  }
}

try {
  await waitUntilReady();
  for (const route of resolvedRoutes) {
    let getHeaders;
    for (const method of route.methods) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method,
        redirect: "manual",
      });
      if (response.status !== route.status) {
        throw new Error(
          `${method} ${route.path} returned ${response.status}, expected ${route.status}.`,
        );
      }
      assertRouteHeaders(route, response.headers);
      if (method === "GET") {
        getHeaders = response.headers;
        const body = await response.text();
        if (route.representation === "html-nonce") {
          const nonce = /'nonce-([^']+)'/u.exec(
            response.headers.get("content-security-policy") ?? "",
          )?.[1];
          const scripts = body.match(/<script\b[^>]*>/giu) ?? [];
          if (
            !nonce ||
            scripts.length === 0 ||
            scripts.some((tag) => !tag.includes(`nonce="${nonce}"`))
          ) {
            throw new Error(
              `GET ${route.path} did not bind every script to its response nonce.`,
            );
          }
        }
      }
      if (method === "HEAD" && (await response.text()) !== "") {
        throw new Error(`HEAD ${route.path} returned a response body.`);
      }
      if (method === "HEAD" && getHeaders) {
        for (const name of [
          "cache-control",
          "content-type",
          "permissions-policy",
          "referrer-policy",
          "x-content-type-options",
        ]) {
          if (response.headers.get(name) !== getHeaders.get(name)) {
            throw new Error(`HEAD ${route.path} differs from GET for ${name}.`);
          }
        }
      }
    }
  }

  const evidence = await (await fetch(`${baseUrl}/evidence`)).text();
  if (!evidence.includes("Application-only mode")) {
    throw new Error("Evidence route did not render the fallback state.");
  }
  const gatedTerms = [
    ["offline", "verifiable"].join("-"),
    ["ver", "ifier"].join(""),
    ["down", "load"].join(""),
    ["trust", "material"].join(" "),
    ["rele", "ase"].join(""),
    ["bund", "le"].join(""),
  ];
  if (gatedTerms.some((term) => evidence.toLowerCase().includes(term))) {
    throw new Error("Evidence fallback exposed gated wording.");
  }

  process.stdout.write(
    `Route verification passed: ${routeClasses.size} route classes, ${resolvedRoutes.length} routes, GET/HEAD, fallback, and shared security oracles.\n`,
  );
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", resolve);
  });
}

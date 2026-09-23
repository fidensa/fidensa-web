import type { EnvironmentClass } from "../config/environment";

export class HeaderOracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderOracleError";
  }
}

function parseDirectives(value: string): Map<string, Set<string>> {
  const directives = new Map<string, Set<string>>();
  for (const raw of value.split(";")) {
    const parts = raw.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) continue;
    const [rawName, ...values] = parts;
    const name = rawName.toLowerCase();
    if (directives.has(name)) {
      throw new HeaderOracleError(`Duplicate policy directive: ${name}`);
    }
    if (new Set(values).size !== values.length) {
      throw new HeaderOracleError(
        `Policy directive ${name} contains a duplicate source.`,
      );
    }
    directives.set(name, new Set(values));
  }
  return directives;
}

function parsePermissionsPolicy(value: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const raw of value.split(",")) {
    const match = /^\s*([a-z][a-z0-9-]*)\s*=\s*(\([^)]*\))\s*$/iu.exec(raw);
    if (!match) {
      throw new HeaderOracleError("Permissions policy is malformed.");
    }
    const name = match[1].toLowerCase();
    if (directives.has(name)) {
      throw new HeaderOracleError(
        `Duplicate permissions policy directive: ${name}`,
      );
    }
    directives.set(name, match[2]);
  }
  return directives;
}

function requireHeader(headers: Headers, name: string, expected: string): void {
  const actual = headers.get(name);
  if (actual?.toLowerCase() !== expected.toLowerCase()) {
    throw new HeaderOracleError(`Header ${name} does not match policy.`);
  }
}

function assertExactSet(
  actual: Set<string> | undefined,
  expected: ReadonlySet<string>,
  label: string,
): void {
  if (
    !actual ||
    actual.size !== expected.size ||
    [...actual].some((value) => !expected.has(value))
  ) {
    throw new HeaderOracleError(`${label} does not match policy.`);
  }
}

function assertTransportSecurity(
  headers: Headers,
  environment: EnvironmentClass,
  protocol: "http:" | "https:",
): void {
  const productionClass =
    environment === "production" || environment === "staged-production";
  if (productionClass && protocol === "https:") {
    const hsts = headers.get("Strict-Transport-Security") ?? "";
    if (!hsts || hsts.includes(",")) {
      throw new HeaderOracleError(
        "Transport security policy is missing or duplicated.",
      );
    }

    const directives = new Map<string, string | null>();
    for (const raw of hsts.split(";")) {
      const directive = raw.trim();
      if (!directive) continue;

      const match = /^([a-z][a-z0-9-]*)(?:\s*=\s*(\S+))?$/iu.exec(directive);
      if (!match) {
        throw new HeaderOracleError("Transport security policy is malformed.");
      }

      const name = match[1].toLowerCase();
      if (directives.has(name)) {
        throw new HeaderOracleError(
          `Duplicate transport security directive: ${name}`,
        );
      }
      directives.set(name, match[2] ?? null);
    }

    const maxAge = directives.get("max-age");
    const includeSubDomains = directives.get("includesubdomains");
    if (
      maxAge === null ||
      maxAge === undefined ||
      !/^\d+$/u.test(maxAge) ||
      Number(maxAge) < 31_536_000 ||
      includeSubDomains !== null
    ) {
      throw new HeaderOracleError("Transport security policy is incomplete.");
    }
  } else if (headers.has("Strict-Transport-Security")) {
    throw new HeaderOracleError(
      "Transport security policy must be absent for this request class.",
    );
  }
}

export function assertSecurityBaselineHeaders(
  headers: Headers,
  environment: EnvironmentClass,
  protocol: "http:" | "https:",
): void {
  requireHeader(headers, "X-Content-Type-Options", "nosniff");
  requireHeader(headers, "Referrer-Policy", "no-referrer");
  requireHeader(headers, "X-Frame-Options", "DENY");
  requireHeader(headers, "Cross-Origin-Opener-Policy", "same-origin");
  requireHeader(headers, "Cross-Origin-Resource-Policy", "same-origin");
  requireHeader(headers, "X-DNS-Prefetch-Control", "off");

  const permissions = parsePermissionsPolicy(
    headers.get("Permissions-Policy") ?? "",
  );
  const expectedPermissions = new Map([
    ["camera", "()"],
    ["microphone", "()"],
    ["geolocation", "()"],
    ["payment", "()"],
    ["usb", "()"],
    ["browsing-topics", "()"],
  ]);
  if (
    permissions.size !== expectedPermissions.size ||
    [...expectedPermissions].some(
      ([name, value]) => permissions.get(name) !== value,
    )
  ) {
    throw new HeaderOracleError("Permissions policy does not match policy.");
  }

  assertTransportSecurity(headers, environment, protocol);
}

function assertNoStore(headers: Headers): void {
  const cacheControl = headers.get("Cache-Control") ?? "";
  if (
    !cacheControl
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .includes("no-store")
  ) {
    throw new HeaderOracleError("Cache policy does not contain no-store.");
  }
}

function assertContentSecurityPolicy(
  headers: Headers,
  environment: EnvironmentClass,
): void {
  const policy = headers.get("Content-Security-Policy");
  if (!policy || policy.includes(",")) {
    throw new HeaderOracleError(
      "Content security policy is missing or duplicated.",
    );
  }

  const directives = parseDirectives(policy);
  const expected = new Map<string, ReadonlySet<string>>([
    ["default-src", new Set(["'self'"])],
    ["base-uri", new Set(["'none'"])],
    ["object-src", new Set(["'none'"])],
    ["frame-ancestors", new Set(["'none'"])],
    ["form-action", new Set(["'self'"])],
    ["style-src", new Set(["'self'", "'unsafe-inline'"])],
    ["img-src", new Set(["'self'", "data:"])],
    ["font-src", new Set(["'self'"])],
    [
      "connect-src",
      new Set(
        environment === "local"
          ? [
              "'self'",
              "http://localhost:*",
              "http://127.0.0.1:*",
              "ws://localhost:*",
              "ws://127.0.0.1:*",
            ]
          : ["'self'"],
      ),
    ],
    ["media-src", new Set(["'none'"])],
    ["frame-src", new Set(["'none'"])],
    ["worker-src", new Set(["'self'"])],
    ["manifest-src", new Set(["'self'"])],
    ["upgrade-insecure-requests", new Set()],
  ]);

  const scripts = directives.get("script-src");
  const nonceSources = [...(scripts ?? [])].filter((value) =>
    /^'nonce-[A-Za-z0-9+/=_-]{16,128}'$/u.test(value),
  );
  if (nonceSources.length !== 1) {
    throw new HeaderOracleError(
      "Script policy must contain exactly one valid nonce source.",
    );
  }
  expected.set(
    "script-src",
    new Set([
      "'self'",
      nonceSources[0],
      ...(environment === "local" ? ["'unsafe-eval'"] : []),
    ]),
  );

  if (
    directives.size !== expected.size ||
    [...directives].some(([name]) => !expected.has(name))
  ) {
    throw new HeaderOracleError(
      "Content security policy contains an unapproved directive.",
    );
  }
  for (const [name, values] of expected) {
    assertExactSet(directives.get(name), values, `Policy directive ${name}`);
  }
}

export function assertSecurityHeaders(
  headers: Headers,
  environment: EnvironmentClass,
  protocol: "http:" | "https:",
): void {
  assertSecurityBaselineHeaders(headers, environment, protocol);
  assertNoStore(headers);
  assertContentSecurityPolicy(headers, environment);
}

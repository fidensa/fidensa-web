import type { EnvironmentClass } from "../config/environment";

export const securityPolicyVersion = 1;

export const baselineSecurityHeaderEntries = [
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  ],
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-DNS-Prefetch-Control", "off"],
  ["X-Frame-Options", "DENY"],
] as const;

export type SecurityHeaderInput = Readonly<{
  environment: EnvironmentClass;
  nonce: string;
  protocol: "http:" | "https:";
}>;

function buildContentSecurityPolicy(
  environment: EnvironmentClass,
  nonce: string,
): string {
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/u.test(nonce)) {
    throw new Error("Cannot construct security policy: invalid nonce shape.");
  }

  const local = environment === "local";
  const scriptSources = ["'self'", `'nonce-${nonce}'`];
  const connectSources = ["'self'"];

  if (local) {
    scriptSources.push("'unsafe-eval'");
    connectSources.push(
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws://localhost:*",
      "ws://127.0.0.1:*",
    );
  }

  const directives = [
    ["default-src", "'self'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["script-src", ...scriptSources],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", ...connectSources],
    ["media-src", "'none'"],
    ["frame-src", "'none'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["upgrade-insecure-requests"],
  ];

  return directives.map((parts) => parts.join(" ")).join("; ");
}

export function buildSecurityHeaders(input: SecurityHeaderInput): Headers {
  const headers = new Headers(
    baselineSecurityHeaderEntries.map(([name, value]) => [name, value]),
  );
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(input.environment, input.nonce),
  );

  const productionClass =
    input.environment === "production" ||
    input.environment === "staged-production";
  if (productionClass && input.protocol === "https:") {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  return headers;
}

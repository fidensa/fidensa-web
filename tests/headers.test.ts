import { describe, expect, it } from "vitest";

import {
  HeaderOracleError,
  assertSecurityBaselineHeaders,
  assertSecurityHeaders,
} from "../src/security/header-oracle";
import { buildSecurityHeaders } from "../src/security/headers";

const nonce = "0123456789abcdef0123456789abcdef";

describe("security header policy", () => {
  it.each([
    ["local", "http:"],
    ["test", "http:"],
    ["staged-production", "https:"],
    ["production", "https:"],
  ] as const)(
    "passes the fixed oracle for %s over %s",
    (environment, protocol) => {
      const headers = buildSecurityHeaders({ environment, protocol, nonce });
      expect(() =>
        assertSecurityHeaders(headers, environment, protocol),
      ).not.toThrow();
    },
  );

  it("uses production CSP semantics in test and omits HSTS in process", () => {
    const headers = buildSecurityHeaders({
      environment: "test",
      protocol: "http:",
      nonce,
    });
    const policy = headers.get("Content-Security-Policy") ?? "";
    expect(policy).not.toContain("'unsafe-eval'");
    expect(headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("adds only the enumerated local hot-reload exceptions", () => {
    const policy =
      buildSecurityHeaders({
        environment: "local",
        protocol: "http:",
        nonce,
      }).get("Content-Security-Policy") ?? "";
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("ws://localhost:*");
    expect(policy).not.toContain("https://*");
  });

  it("requires production transport security only over HTTPS", () => {
    const https = buildSecurityHeaders({
      environment: "production",
      protocol: "https:",
      nonce,
    });
    expect(https.get("Strict-Transport-Security")).toContain(
      "max-age=31536000",
    );
    expect(https.get("Strict-Transport-Security")).toContain(
      "includeSubDomains",
    );

    const http = buildSecurityHeaders({
      environment: "production",
      protocol: "http:",
      nonce,
    });
    expect(http.has("Strict-Transport-Security")).toBe(false);
  });

  it.each([
    ["max-age=0", "max-age=0"],
    ["max-age=0 with includeSubDomains", "max-age=0; includeSubDomains"],
  ])("rejects contradictory duplicate HSTS: %s", (_label, duplicate) => {
    const headers = buildSecurityHeaders({
      environment: "production",
      protocol: "https:",
      nonce,
    });
    headers.append("Strict-Transport-Security", duplicate);

    expect(() =>
      assertSecurityHeaders(headers, "production", "https:"),
    ).toThrow(HeaderOracleError);
  });

  it.each([
    ["image wildcard", "img-src 'self' data:", "img-src 'self' data: *"],
    ["default wildcard", "default-src 'self'", "default-src 'self' *"],
    [
      "analytics origin",
      "connect-src 'self'",
      "connect-src 'self' https://www.google-analytics.com",
    ],
    [
      "local WebSocket source in production",
      "connect-src 'self'",
      "connect-src 'self' ws://localhost:*",
    ],
    [
      "local HTTP source in production",
      "connect-src 'self'",
      "connect-src 'self' http://127.0.0.1:*",
    ],
    [
      "unapproved script scheme",
      `script-src 'self' 'nonce-${nonce}'`,
      `script-src 'self' https: 'nonce-${nonce}'`,
    ],
  ])("rejects %s", (_label, from, to) => {
    const headers = buildSecurityHeaders({
      environment: "production",
      protocol: "https:",
      nonce,
    });
    headers.set(
      "Content-Security-Policy",
      (headers.get("Content-Security-Policy") ?? "").replace(from, to),
    );
    expect(() =>
      assertSecurityHeaders(headers, "production", "https:"),
    ).toThrow(HeaderOracleError);
  });

  it("rejects a duplicate content-security directive", () => {
    const headers = buildSecurityHeaders({
      environment: "production",
      protocol: "https:",
      nonce,
    });
    headers.set(
      "Content-Security-Policy",
      `${headers.get("Content-Security-Policy")}; default-src 'self'`,
    );
    expect(() =>
      assertSecurityHeaders(headers, "production", "https:"),
    ).toThrow(HeaderOracleError);
  });

  it("rejects contradictory permissions-policy directives", () => {
    const headers = buildSecurityHeaders({
      environment: "production",
      protocol: "https:",
      nonce,
    });
    headers.set(
      "Permissions-Policy",
      `${headers.get("Permissions-Policy")}, camera=(self)`,
    );
    expect(() =>
      assertSecurityHeaders(headers, "production", "https:"),
    ).toThrow(HeaderOracleError);
  });

  it("checks the fixed baseline independently for immutable assets", () => {
    const headers = buildSecurityHeaders({
      environment: "test",
      protocol: "http:",
      nonce,
    });
    headers.delete("Cache-Control");
    headers.delete("Content-Security-Policy");
    expect(() =>
      assertSecurityBaselineHeaders(headers, "test", "http:"),
    ).not.toThrow();
    headers.delete("Cross-Origin-Resource-Policy");
    expect(() =>
      assertSecurityBaselineHeaders(headers, "test", "http:"),
    ).toThrow(HeaderOracleError);
  });

  it("refuses an invalid nonce", () => {
    expect(() =>
      buildSecurityHeaders({
        environment: "test",
        protocol: "http:",
        nonce: "bad nonce",
      }),
    ).toThrow("invalid nonce shape");
  });
});

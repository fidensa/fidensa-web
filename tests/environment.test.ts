import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  validateBuildEnvironment,
  validateRuntimeEnvironment,
  type EnvironmentInput,
} from "../src/config/environment";

const testEnvironment: EnvironmentInput = {
  APP_ENV: "test",
  NEXT_PUBLIC_SITE_ORIGIN: "http://127.0.0.1:3000",
  PROVIDER_PROFILE: "deterministic",
  DELIVERY_PROFILE: "capture",
};

function productionEnvironment(
  environment: "production" | "staged-production" = "production",
): Record<string, string> {
  const credential = (kind: string) =>
    ["fixture", kind, "material", "0123456789abcdef0123456789abcdef"].join("-");
  return {
    APP_ENV: environment,
    NEXT_PUBLIC_SITE_ORIGIN:
      environment === "production"
        ? "https://fidensa.example"
        : "https://staged.fidensa.example",
    PROVIDER_PROFILE: "production",
    DELIVERY_PROFILE:
      environment === "production" ? "production" : "controlled",
    BUILD_ID: "build-fixture-full-identity",
    DEPLOYMENT_ID: "deployment-fixture-identity",
    CONFIG_DIGEST: "configuration-fixture-digest",
    SERVER_DATA_ACCESS_CREDENTIAL: credential("data"),
    SERVER_MESSAGE_ACCESS_CREDENTIAL: credential("message"),
    SERVER_TOKEN_DERIVATION_MATERIAL: credential("token"),
    SERVER_RECONCILIATION_CREDENTIAL: credential("reconciliation"),
    SERVER_MARKETING_RECONCILE_CREDENTIAL: credential("marketing"),
    SERVER_RESEND_WEBHOOK_SECRET: `whsec_${"x".repeat(40)}`,
    SERVER_DATA_API_ORIGIN: "https://project.supabase.co",
    SERVER_REVIEWER_RECORD_BASE_URL:
      "https://supabase.com/dashboard/project/project/editor/records",
    SERVER_REVIEWER_NOTIFICATION_RECIPIENT: "reviewer@fidensa.example",
    SERVER_RESEND_MARKETING_TOPIC_ID: "00000000-0000-4000-8000-000000000001",
  };
}

describe("environment validation", () => {
  it("accepts the bounded local and test classes", () => {
    expect(validateRuntimeEnvironment(testEnvironment).environment).toBe(
      "test",
    );
    expect(
      validateRuntimeEnvironment({
        APP_ENV: "local",
        NEXT_PUBLIC_SITE_ORIGIN: "http://localhost:3000",
        PROVIDER_PROFILE: "synthetic",
        DELIVERY_PROFILE: "capture",
      }).environment,
    ).toBe("local");
  });

  it("accepts complete staged-production and production classes", () => {
    expect(
      validateRuntimeEnvironment(productionEnvironment()).environment,
    ).toBe("production");
    expect(
      validateRuntimeEnvironment(productionEnvironment("staged-production"))
        .environment,
    ).toBe("staged-production");
  });

  it.each([
    [{ ...testEnvironment, APP_ENV: undefined }, "environment identity"],
    [{ ...testEnvironment, APP_ENV: "unknown" }, "environment identity"],
    [
      { ...testEnvironment, NEXT_PUBLIC_SITE_ORIGIN: "https://public.example" },
      "canonical origin",
    ],
    [
      { ...testEnvironment, PROVIDER_PROFILE: "production" },
      "provider posture",
    ],
    [
      { ...testEnvironment, DELIVERY_PROFILE: "production" },
      "delivery posture",
    ],
  ])(
    "rejects missing, malformed, or contradictory input",
    (input, category) => {
      expect(() => validateBuildEnvironment(input)).toThrow(category as string);
    },
  );

  it("requires immutable identities for a production-class build", () => {
    const input = productionEnvironment();
    delete input.DEPLOYMENT_ID;
    expect(() => validateBuildEnvironment(input)).toThrow(
      "deployment identity",
    );
  });

  it("requires credential categories only at runtime", () => {
    const input = productionEnvironment();
    delete input.SERVER_MESSAGE_ACCESS_CREDENTIAL;
    expect(validateBuildEnvironment(input).environment).toBe("production");
    expect(() => validateRuntimeEnvironment(input)).toThrow(
      "message provider credential",
    );
  });

  it("rejects production credential material in local or test", () => {
    expect(() =>
      validateRuntimeEnvironment({
        ...testEnvironment,
        SERVER_DATA_ACCESS_CREDENTIAL: "x".repeat(40),
      }),
    ).toThrow("server credential boundary");
  });

  it.each([
    [["NEXT_PUBLIC", "PROVIDER", "TOKEN"].join("_")],
    [["NEXT_PUBLIC", "SUPABASE", "SERVICE", "ROLE", "KEY"].join("_")],
    [["NEXT_PUBLIC", "RESEND", "API", "KEY"].join("_")],
    [["NEXT_PUBLIC", "SB", "SECRET", "VALUE"].join("_")],
  ])("rejects unsafe public name %s", (name) => {
    expect(() =>
      validateBuildEnvironment({
        ...testEnvironment,
        [name]: "not-public",
      }),
    ).toThrow("public configuration boundary");
  });

  it("rejects public/server value collisions during build validation", () => {
    const input = productionEnvironment();
    input.NEXT_PUBLIC_ACCIDENTAL_VALUE = input.SERVER_DATA_ACCESS_CREDENTIAL;
    expect(() => validateBuildEnvironment(input)).toThrow(
      "public configuration boundary",
    );
  });

  it("never echoes rejected credential material", () => {
    const input = productionEnvironment();
    const rejected = ["private", "fixture", "value"].join("-");
    input.SERVER_DATA_ACCESS_CREDENTIAL = rejected;
    try {
      validateRuntimeEnvironment(input);
      throw new Error("Expected validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(String(error)).not.toContain(rejected);
    }
  });
});

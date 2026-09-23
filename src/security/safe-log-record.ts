import type { EnvironmentClass } from "../config/environment";

const eventClasses = new Set([
  "configuration_checked",
  "provider_operation",
  "request_completed",
  "security_boundary",
]);
const resultClasses = new Set(["accepted", "blocked", "failed", "succeeded"]);
const validEnvironments = new Set([
  "local",
  "test",
  "staged-production",
  "production",
]);

export type SafeLogRecord = Readonly<{
  timestamp: string;
  environment: EnvironmentClass | "unknown";
  eventClass: string;
  resultClass: string;
  correlationId?: string;
}>;

export function createSafeLogRecord(
  untrusted: unknown,
  now: Date = new Date(),
): SafeLogRecord {
  const input =
    typeof untrusted === "object" && untrusted !== null
      ? (untrusted as Record<string, unknown>)
      : {};
  const eventClass =
    typeof input.eventClass === "string" && eventClasses.has(input.eventClass)
      ? input.eventClass
      : "security_boundary";
  const resultClass =
    typeof input.resultClass === "string" &&
    resultClasses.has(input.resultClass)
      ? input.resultClass
      : "blocked";
  const environment =
    typeof input.environment === "string" &&
    validEnvironments.has(input.environment)
      ? (input.environment as EnvironmentClass)
      : "unknown";
  const correlationId =
    typeof input.correlationId === "string" &&
    /^fx-[A-Za-z0-9-]{8,80}$/u.test(input.correlationId)
      ? input.correlationId
      : undefined;

  return {
    timestamp: now.toISOString(),
    environment,
    eventClass,
    resultClass,
    ...(correlationId ? { correlationId } : {}),
  };
}

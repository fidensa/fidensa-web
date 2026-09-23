import { describe, expect, it } from "vitest";

import { createSafeLogRecord } from "../src/security/safe-log-record";

describe("safe structured logging", () => {
  it("retains only the allowlisted operational fields", () => {
    const sensitive = ["fixture", "privileged", "browser", "sentinel"].join(
      "-",
    );
    const encoded = Buffer.from(sensitive).toString("base64");
    const record = createSafeLogRecord(
      {
        environment: "test",
        eventClass: "request_completed",
        resultClass: "succeeded",
        correlationId: "fx-corr-SYNTHETIC-0001",
        applicantPayload: { answer: sensitive },
        requestHeaders: { authorization: sensitive },
        query: encoded,
        providerResponse: sensitive,
        token: sensitive,
      },
      new Date("2026-09-23T12:00:00.000Z"),
    );
    const serialized = JSON.stringify(record);

    expect(record).toEqual({
      timestamp: "2026-09-23T12:00:00.000Z",
      environment: "test",
      eventClass: "request_completed",
      resultClass: "succeeded",
      correlationId: "fx-corr-SYNTHETIC-0001",
    });
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain(encoded);
  });

  it("replaces unrecognized values instead of forwarding them", () => {
    const record = createSafeLogRecord({
      environment: "unexpected",
      eventClass: "arbitrary-event-with-details",
      resultClass: "arbitrary-result-with-details",
      correlationId: "address@example.invalid",
    });
    expect(record.environment).toBe("unknown");
    expect(record.eventClass).toBe("security_boundary");
    expect(record.resultClass).toBe("blocked");
    expect(record).not.toHaveProperty("correlationId");
  });
});

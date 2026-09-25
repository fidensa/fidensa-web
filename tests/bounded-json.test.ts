import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RequestBodyError, readBoundedJson } from "../src/server/bounded-json";

describe("bounded JSON request parsing", () => {
  it("accepts a bounded JSON object", async () => {
    const request = new Request("https://fidensa.example/api", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ value: "ok" }),
    });
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({
      value: "ok",
    });
  });

  it("rejects actual bytes over the limit without trusting content-length", async () => {
    const request = new Request("https://fidensa.example/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1024) }),
    });
    await expect(readBoundedJson(request, 128)).rejects.toMatchObject<
      Partial<RequestBodyError>
    >({ reason: "size" });
  });

  it("rejects malformed JSON and unsupported media types", async () => {
    await expect(
      readBoundedJson(
        new Request("https://fidensa.example/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
        128,
      ),
    ).rejects.toMatchObject({ reason: "json" });
    await expect(
      readBoundedJson(
        new Request("https://fidensa.example/api", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
        128,
      ),
    ).rejects.toMatchObject({ reason: "content-type" });
  });
});

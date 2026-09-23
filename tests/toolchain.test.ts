import { describe, expect, it } from "vitest";

import { assertSupportedToolchain } from "../scripts/toolchain.mjs";

describe("toolchain guard", () => {
  it("accepts the documented versions", () => {
    expect(() => assertSupportedToolchain("24.21.0", "11.19.0")).not.toThrow();
  });

  it("fails legibly for an unsupported runtime or package manager", () => {
    expect(() => assertSupportedToolchain("22.0.0", "11.19.0")).toThrow(
      "Unsupported Node.js version",
    );
    expect(() => assertSupportedToolchain("24.21.0", "10.0.0")).toThrow(
      "Unsupported npm version",
    );
  });
});

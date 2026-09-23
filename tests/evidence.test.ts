import { describe, expect, it } from "vitest";

import {
  applicationOnlyEvidenceMode,
  resolveEvidenceMode,
} from "../src/config/evidence";

describe("evidence mode", () => {
  it.each([
    undefined,
    "",
    "unknown",
    "green",
    "accepted",
    "?mode=green",
    "contradictory-record",
  ])("keeps untrusted input in the application-only state", (input) => {
    expect(resolveEvidenceMode(input)).toBe(applicationOnlyEvidenceMode);
  });
});

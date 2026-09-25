import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("baseline route source", () => {
  it.each([
    ["/", "src/app/page.tsx"],
    ["/apply", "src/app/apply/page.tsx"],
    ["/apply/verify", "src/app/apply/verify/page.tsx"],
    ["/privacy", "src/app/privacy/page.tsx"],
    ["/evidence", "src/app/evidence/page.tsx"],
  ])("maps %s to a governed route module", async (_route, file) => {
    await expect(readFile(path.join(root, file), "utf8")).resolves.toContain(
      "export default function",
    );
  });

  it("keeps gated wording out of the evidence route", async () => {
    const source = (
      await readFile(path.join(root, "src/app/evidence/page.tsx"), "utf8")
    ).toLowerCase();
    const forbidden = [
      ["offline", "verifiable"].join("-"),
      ["ver", "ifier"].join(""),
      ["down", "load"].join(""),
      ["trust", "material"].join(" "),
      ["rele", "ase"].join(""),
      ["bund", "le"].join(""),
    ];
    for (const term of forbidden) expect(source).not.toContain(term);
  });

  it("enumerates application, error, framework, and asset response classes", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "config/security-routes.json"), "utf8"),
    ) as {
      version: number;
      routes: Array<{ path: string; class: string; status: number }>;
    };
    expect(manifest.version).toBe(2);
    expect(new Set(manifest.routes.map((route) => route.class))).toEqual(
      new Set([
        "public-html",
        "public-error",
        "framework-error",
        "fingerprinted-asset",
      ]),
    );
    expect(manifest.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/favicon.ico", status: 404 }),
        expect.objectContaining({
          path: "/_next/static/does-not-exist.js",
          status: 404,
        }),
        expect.objectContaining({ path: "/_next/image", status: 400 }),
        expect.objectContaining({
          path: "$FIRST_FINGERPRINTED_STATIC_ASSET",
          status: 200,
        }),
      ]),
    );
  });

  it("defines the server-only reconciliation entry point at minute 10 UTC", async () => {
    const source = await readFile(
      path.join(
        root,
        "src/app/api/internal/application-messages/reconcile/route.ts",
      ),
      "utf8",
    );
    const runtime = await readFile(
      path.join(root, "src/server/application-runtime.ts"),
      "utf8",
    );
    expect(source).toContain("reconciliationAccess");
    expect(source).toContain("timingSafeEqual");
    expect(runtime).toContain('APPLICATION_RECONCILIATION_CRON = "10 * * * *"');
  });
});

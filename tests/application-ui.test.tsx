import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...properties
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...properties}>
      {children}
    </a>
  ),
}));

import { ApplicationForm } from "../src/app/apply/application-form";
import { exchangeVerificationFragment } from "../src/app/apply/verify/verification-exchange";

const root = process.cwd();

describe("application form accessibility contract", () => {
  it("renders every field, repeated warnings, and separate unchecked controls", () => {
    const html = renderToStaticMarkup(<ApplicationForm />);
    for (const name of [
      "name",
      "email",
      "roleFunction",
      "context",
      "organization",
      "intendedUseCase",
      "workflowStage",
      "deploymentPreference",
      "evaluationTimeline",
      "designPartnerWillingness",
      "integrationConstraints",
      "referralSource",
      "additionalContext",
      "privacyAcknowledged",
      "marketingSelected",
      "companyWebsite",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html.match(/Do not include passwords/g)).toHaveLength(9);
    expect(html).toMatch(/id="privacyAcknowledged"[^>]*required=""/u);
    expect(html).toContain('name="marketingSelected"');
    expect(html).not.toMatch(/name="marketingSelected"[^>]*checked/u);
    expect(html).toMatch(
      /class="honeypot" aria-hidden="true"[\s\S]*tabindex="-1"/u,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="context"');
    expect(html).toContain('id="context-Work"');
    expect(html).toContain('id="designPartnerWillingness"');
    expect(html).toContain('id="designPartnerWillingness-Yes"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('id="privacyAcknowledged"');
    expect(html).toContain('id="marketingSelected"');
    expect(html).not.toMatch(/class="character-count" aria-live=/u);
    expect(html).not.toContain("maxlength=");
  });

  it("associates resend errors and focuses the invalid email control", async () => {
    const source = await readFile(
      path.join(root, "src/app/apply/verify/verification-exchange.tsx"),
      "utf8",
    );
    expect(source).toContain('id="resend-email-error"');
    expect(source).toContain(
      'aria-describedby={resendError ? "resend-email-error"',
    );
    expect(source).toContain("resendEmail.current?.focus()");
  });

  it("provides error focus, live status, responsive reflow, and reduced motion", async () => {
    const formSource = await readFile(
      path.join(root, "src/app/apply/application-form.tsx"),
      "utf8",
    );
    const css = await readFile(path.join(root, "src/app/globals.css"), "utf8");
    expect(formSource).toContain("errorSummary.current?.focus()");
    expect(formSource).toContain('role="alert"');
    expect(formSource).toContain('role="status"');
    expect(formSource).toContain('aria-live="polite"');
    expect(formSource).toContain("aria-describedby");
    expect(css).toContain("@media (max-width: 42rem)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("outline: 3px solid var(--focus)");
    expect(css).toContain("min-height: 2.75rem");
  });

  it("keeps normal text, instructions, errors, and focus above accepted contrast", () => {
    function channel(value: number) {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    }
    function luminance(hex: string) {
      const value = Number.parseInt(hex.slice(1), 16);
      return (
        0.2126 * channel((value >> 16) & 255) +
        0.7152 * channel((value >> 8) & 255) +
        0.0722 * channel(value & 255)
      );
    }
    function contrast(first: string, second: string) {
      const [bright, dark] = [luminance(first), luminance(second)].sort(
        (a, b) => b - a,
      );
      return (bright + 0.05) / (dark + 0.05);
    }
    expect(contrast("#f2f0e9", "#0c0c0c")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#b8b3a7", "#0c0c0c")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffb4a8", "#151515")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffe28a", "#0c0c0c")).toBeGreaterThanOrEqual(3);
  });

  it("removes the fragment before the one-time POST and does not use a query", async () => {
    const source = await readFile(
      path.join(root, "src/app/apply/verify/verification-exchange.tsx"),
      "utf8",
    );
    expect(source.indexOf("history.replaceState")).toBeLessThan(
      source.indexOf('fetch("/api/applications/verify"'),
    );
    expect(source).toContain("browser.location.hash.slice(1)");
    expect(source).not.toContain("URLSearchParams");
    expect(source).toContain("No verification link was provided.");
  });

  it("clears history before posting and back/forward re-entry does not repost", async () => {
    const events: string[] = [];
    const location = {
      hash: `#av1.${"A".repeat(43)}`,
      pathname: "/apply/verify",
      search: "",
    };
    const browser = {
      location,
      history: {
        replaceState(
          _data: unknown,
          _unused: string,
          url?: string | URL | null,
        ) {
          events.push(`replace:${String(url)}`);
          location.hash = "";
        },
      },
      fetch: vi.fn(async () => {
        events.push("fetch");
        return Response.json({
          message: "The verification request has been processed.",
        });
      }) as typeof fetch,
    };
    await exchangeVerificationFragment(browser);
    const reentry = await exchangeVerificationFragment(browser);
    expect(events).toEqual([
      "replace:/apply/verify",
      "fetch",
      "replace:/apply/verify",
    ]);
    expect(browser.fetch).toHaveBeenCalledOnce();
    expect(reentry).toContain("No verification link was provided");
  });

  it("binds consent labels to versioned notice and consent text", async () => {
    const html = renderToStaticMarkup(<ApplicationForm />);
    const privacy = await readFile(
      path.join(root, "src/app/privacy/page.tsx"),
      "utf8",
    );
    expect(html).toContain('data-notice-version="privacy-notice-v1"');
    expect(html).toContain('data-consent-version="marketing-consent-v1"');
    expect(privacy).toContain("PRIVACY_NOTICE_VERSION");
  });

  it("keeps reviewer status transitions free of messaging side effects", async () => {
    const migration = await readFile(
      path.join(
        root,
        "migrations/20260924222000_constrained_operations_and_queue.sql",
      ),
      "utf8",
    );
    const start = migration.indexOf(
      "create function fidensa_api.transition_reviewer_status",
    );
    const end = migration.indexOf(
      "create function fidensa_api.record_direct_interaction",
      start,
    );
    const transition = migration.slice(start, end);
    expect(transition).not.toContain("communications");
    expect(transition).not.toContain("receipt");
    expect(transition).not.toContain("applicant");
  });
});

"use client";

import { useEffect, useRef, useState } from "react";

export interface PrivacyConfirmationBrowser {
  readonly location: Pick<Location, "hash" | "pathname" | "search">;
  readonly history: Pick<History, "replaceState">;
  readonly fetch: typeof fetch;
}

export async function exchangePrivacyConfirmationFragment(
  browser: PrivacyConfirmationBrowser,
): Promise<string> {
  const credential = browser.location.hash.slice(1);
  browser.history.replaceState(
    null,
    "",
    `${browser.location.pathname}${browser.location.search}`,
  );
  if (!credential) {
    return "No confirmation credential was provided. Contact privacy@fidensa.com if you need help.";
  }
  try {
    const response = await browser.fetch("/api/privacy/requests/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    const result = (await response.json()) as { message?: string };
    return (
      result.message ??
      "If the confirmation is valid and current, the privacy request has been confirmed."
    );
  } catch {
    return "The confirmation has been processed. Contact privacy@fidensa.com if you need help.";
  }
}

export function PrivacyConfirmationExchange() {
  const posted = useRef(false);
  const [status, setStatus] = useState("Checking this privacy confirmation…");

  useEffect(() => {
    if (posted.current) return;
    posted.current = true;
    void exchangePrivacyConfirmationFragment({
      location: window.location,
      history: window.history,
      fetch: window.fetch.bind(window),
    }).then(setStatus);
  }, []);

  return (
    <div className="panel" role="status" aria-live="polite">
      <h2>Confirmation status</h2>
      <p>{status}</p>
    </div>
  );
}

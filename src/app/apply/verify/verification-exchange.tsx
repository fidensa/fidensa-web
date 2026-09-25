"use client";

import { useEffect, useRef, useState } from "react";

export interface VerificationBrowser {
  readonly location: Pick<Location, "hash" | "pathname" | "search">;
  readonly history: Pick<History, "replaceState">;
  readonly fetch: typeof fetch;
}

export async function exchangeVerificationFragment(
  browser: VerificationBrowser,
): Promise<string> {
  const credential = browser.location.hash.slice(1);
  browser.history.replaceState(
    null,
    "",
    `${browser.location.pathname}${browser.location.search}`,
  );
  if (!credential) {
    return "No verification link was provided. Request a new link below if needed.";
  }
  try {
    const response = await browser.fetch("/api/applications/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    const result = (await response.json()) as { message?: string };
    return result.message ?? "The verification request has been processed.";
  } catch {
    return "The verification request has been processed. Request a new link below if needed.";
  }
}

export function VerificationExchange() {
  const posted = useRef(false);
  const [verificationStatus, setVerificationStatus] = useState(
    "Checking this verification request…",
  );
  const [email, setEmail] = useState("");
  const [resendStatus, setResendStatus] = useState("");
  const [resendError, setResendError] = useState("");
  const [sending, setSending] = useState(false);
  const resendEmail = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (posted.current) return;
    posted.current = true;
    void exchangeVerificationFragment({
      location: window.location,
      history: window.history,
      fetch: window.fetch.bind(window),
    }).then(setVerificationStatus);
  }, []);

  async function resend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setResendStatus("");
    setResendError("");
    try {
      const response = await fetch("/api/applications/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = (await response.json()) as {
        message?: string;
        errors?: { email?: string };
      };
      if (!response.ok && result.errors?.email) {
        setResendError(result.errors.email);
        requestAnimationFrame(() => resendEmail.current?.focus());
      } else {
        setResendStatus(
          result.message ??
            "If the request is eligible, an email with the next step will be sent.",
        );
      }
    } catch {
      setResendStatus(
        "The request could not be completed. You can try again safely.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="panel" role="status" aria-live="polite">
        <h2>Verification status</h2>
        <p>{verificationStatus}</p>
      </div>
      <form className="panel resend-form" onSubmit={resend}>
        <h2>Request another link</h2>
        <p>
          Links are single-use and expire after 60 minutes. Requests are
          limited, including a 60-second cooldown. The response is the same
          whether or not a pending application exists. Allow up to 10 minutes
          for delivery before retrying. For help, contact{" "}
          <a href="mailto:privacy@fidensa.com">privacy@fidensa.com</a>.
        </p>
        <label htmlFor="resend-email">Application email</label>
        <input
          id="resend-email"
          ref={resendEmail}
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          aria-invalid={Boolean(resendError)}
          aria-describedby={resendError ? "resend-email-error" : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            setResendError("");
          }}
        />
        {resendError ? (
          <span className="field-error" id="resend-email-error">
            {resendError}
          </span>
        ) : null}
        <button className="primary-button" type="submit" disabled={sending}>
          {sending ? "Requesting…" : "Request verification link"}
        </button>
        <p role="status" aria-live="polite">
          {resendStatus}
        </p>
      </form>
    </>
  );
}

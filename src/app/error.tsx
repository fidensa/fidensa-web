"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section aria-labelledby="request-error-title">
      <p className="eyebrow">Request error</p>
      <h1 id="request-error-title">This page could not be displayed.</h1>
      <p>Try the request again without including any sensitive information.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}

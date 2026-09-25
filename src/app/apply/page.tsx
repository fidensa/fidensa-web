import type { Metadata } from "next";
import Link from "next/link";

import { ApplicationForm } from "./application-form";

export const metadata: Metadata = {
  title: "Apply",
};

export default function ApplyPage() {
  return (
    <>
      <p className="eyebrow">Application</p>
      <h1>Apply to work with Fidensa.</h1>
      <p className="lede">
        Tell us about the AI agent or workflow you want to evaluate. Do not
        submit secrets, credentials, production data, or confidential customer
        information.
      </p>
      <div className="panel application-intro">
        <h2>Before you begin</h2>
        <p>
          Applications are considered on a rolling basis and access is limited.
          Submission does not guarantee selection or access. We do not promise a
          review timeframe and may be unable to provide individual status
          updates or decision notices beyond the automated receipt. We will
          contact you if we wish to continue the conversation.
        </p>
        <p>
          After submission, use the single-use link sent to your email within 60
          minutes. Unverified applications are deleted after seven days. If a
          link is missing or expired,{" "}
          <Link href="/apply/verify">request another</Link>. Allow up to 10
          minutes for delivery before retrying. For help, contact{" "}
          <a href="mailto:privacy@fidensa.com">privacy@fidensa.com</a>.
        </p>
      </div>
      <ApplicationForm />
    </>
  );
}

import type { Metadata } from "next";

import { VerificationExchange } from "./verification-exchange";

export const metadata: Metadata = {
  title: "Verify application email",
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function VerifyApplicationPage() {
  return (
    <>
      <p className="eyebrow">Application</p>
      <h1>Verify your email address.</h1>
      <p className="lede">
        A valid single-use link moves a pending application into consideration.
        Verification confirms address reachability; it does not create marketing
        consent.
      </p>
      <VerificationExchange />
    </>
  );
}

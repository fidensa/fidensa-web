import type { Metadata } from "next";

import { PrivacyConfirmationExchange } from "./privacy-confirmation-exchange";

export const metadata: Metadata = {
  title: "Confirm privacy request",
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function ConfirmPrivacyRequestPage() {
  return (
    <>
      <p className="eyebrow">Privacy</p>
      <h1>Confirm your privacy request.</h1>
      <p className="lede">
        This single-use confirmation checks control of the email address already
        on record. It does not disclose whether a matching record exists.
      </p>
      <PrivacyConfirmationExchange />
    </>
  );
}

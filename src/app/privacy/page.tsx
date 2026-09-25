import type { Metadata } from "next";

import { PRIVACY_NOTICE_VERSION } from "../../application/contract";

export const metadata: Metadata = {
  title: "Privacy",
};

export default function PrivacyPage() {
  return (
    <>
      <p className="eyebrow">Privacy</p>
      <h1>Privacy route reserved.</h1>
      <p className="lede" data-notice-version={PRIVACY_NOTICE_VERSION}>
        Final privacy information will be added through its approved content and
        implementation task. The application acknowledgment records notice
        version <code>{PRIVACY_NOTICE_VERSION}</code>. The site does not run
        visitor analytics.
      </p>
    </>
  );
}

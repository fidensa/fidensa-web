import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
};

export default function PrivacyPage() {
  return (
    <>
      <p className="eyebrow">Privacy</p>
      <h1>Privacy route reserved.</h1>
      <p className="lede">
        Final privacy information will be added through its approved content and
        implementation task. This foundation does not collect application data
        or run visitor analytics.
      </p>
    </>
  );
}

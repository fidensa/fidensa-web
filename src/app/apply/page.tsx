import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Apply",
};

export default function ApplyPage() {
  return (
    <>
      <p className="eyebrow">Application</p>
      <h1>Application route reserved.</h1>
      <div className="panel">
        <h2>Current status</h2>
        <p>
          The application workflow is not part of this foundation task. No
          applicant information is collected on this page.
        </p>
      </div>
    </>
  );
}

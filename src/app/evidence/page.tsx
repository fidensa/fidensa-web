import type { Metadata } from "next";

import { resolveEvidenceMode } from "../../config/evidence";

export const metadata: Metadata = {
  title: "Evidence status",
};

export default function EvidencePage() {
  const mode = resolveEvidenceMode(process.env.EVIDENCE_GATE_RECORD);

  return (
    <>
      <p className="eyebrow">Evidence status</p>
      <h1>Application-only mode.</h1>
      <div
        className="panel"
        aria-labelledby="evidence-state"
        data-evidence-mode={mode}
      >
        <h2 id="evidence-state">Current presentation</h2>
        <p>Public evidence materials are not available in this foundation.</p>
      </div>
    </>
  );
}

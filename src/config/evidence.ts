export const applicationOnlyEvidenceMode = "application-only" as const;

export type EvidenceMode = typeof applicationOnlyEvidenceMode;

export function resolveEvidenceMode(untrustedInput?: string): EvidenceMode {
  void untrustedInput;
  return applicationOnlyEvidenceMode;
}

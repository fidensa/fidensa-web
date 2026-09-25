import "server-only";

export const MANUAL_MESSAGE_TEMPLATES = {
  interview: {
    version: "interview-draft-v1",
    subject: "Fidensa application: interview invitation",
    body: "We would like to continue the conversation about your Fidensa application. Reply to arrange a time. This invitation does not guarantee access.",
  },
  waitlist: {
    version: "waitlist-draft-v1",
    subject: "Fidensa application update",
    body: "Your application remains under consideration, but we cannot offer access now. We do not promise a future invitation or review date.",
  },
  decision: {
    version: "decision-draft-v1",
    subject: "Fidensa application decision",
    body: "We are writing with a decision about your Fidensa application. This message concerns only your application and is not a marketing message.",
  },
  early_access: {
    version: "early-access-draft-v1",
    subject: "Fidensa early-access invitation",
    body: "We would like to invite you to discuss limited Fidensa early access. Reply for the next steps; do not send secrets or sensitive system data by email.",
  },
} as const;

export type ManualMessageType = keyof typeof MANUAL_MESSAGE_TEMPLATES;

export interface ManualTemplateApproval {
  readonly type: ManualMessageType;
  readonly version: string;
  readonly approvedBy: "scott_bishop";
  readonly approvedAt: string;
}

export interface ManualCommunicationRecorder {
  record(input: {
    readonly applicationId: string;
    readonly type: ManualMessageType;
    readonly templateVersion: string;
    readonly actor: "scott_bishop";
    readonly occurredAt: string;
    readonly note: string | null;
  }): Promise<string>;
}

export async function recordApprovedManualCommunication(
  input: {
    readonly applicationId: string;
    readonly type: ManualMessageType;
    readonly note?: string;
    readonly now: Date;
  },
  approval: ManualTemplateApproval | null,
  recorder: ManualCommunicationRecorder,
): Promise<string> {
  const template = MANUAL_MESSAGE_TEMPLATES[input.type];
  if (
    !approval ||
    approval.type !== input.type ||
    approval.version !== template.version ||
    approval.approvedBy !== "scott_bishop"
  ) {
    throw new Error("The exact manual-message template is not approved.");
  }
  const note = input.note?.normalize("NFC").trim() || null;
  if (note && Array.from(note).length > 500) {
    throw new Error("The communication note exceeds 500 characters.");
  }
  return recorder.record({
    applicationId: input.applicationId,
    type: input.type,
    templateVersion: template.version,
    actor: "scott_bishop",
    occurredAt: input.now.toISOString(),
    note,
  });
}

import {
  MAIL_DRAFT_FAILURE_DETAIL_PREFIXES,
  MAIL_DRAFT_FAILURE_REASONS,
  type MailDraftFailureDetailKey,
  type MailDraftFailureReasonKey,
} from "@goatcitadel/contracts";

/** Operator copy for a draft's recorded failure; the raw reason only ever travels as `technicalDetail`. */
export interface MailDraftFailureCopy {
  summary: string;
  /** The Gateway's raw reason, for a technical-details disclosure; absent when the summary says it all. */
  technicalDetail?: string;
}

const MAX_TECHNICAL_DETAIL_CHARS = 600;

const KNOWN_REASON_COPY: Record<MailDraftFailureReasonKey, string> = {
  rejected: "The send approval was rejected. Nothing was sent.",
  expired: "The send approval expired before it was decided. Nothing was sent.",
  outcomeUnknown:
    "The delivery outcome is unknown: the message may have been delivered. Check the sent mailbox before sending it again.",
  payloadChanged: "The message changed after it was approved, so nothing was sent.",
  connectionChanged: "The mail account's settings changed after approval, so nothing was sent. Request approval again.",
  connectionMissing: "The mail account is no longer connected. Nothing was sent.",
  approvalMissingWorkspace: "The approval names no workspace, so nothing was sent.",
  approvalForeignWorkspace: "The mail account belongs to a different workspace, so nothing was sent.",
  approvalAlreadyUsed: "This approval was already used. Nothing was sent again.",
};

const DETAIL_REASON_COPY: Record<MailDraftFailureDetailKey, string> = {
  deliveryFailed: "The mail provider refused the message. Nothing was sent.",
  notExecuted: "Policy stopped the send before it ran. Nothing was sent.",
  approvalRequestFailed: "The send approval could not be requested. Nothing was sent.",
  providerCannotSend: "This mail account cannot send mail. Connect Gmail or an SMTP account.",
};

const knownByReason = new Map<string, string>(
  (Object.keys(MAIL_DRAFT_FAILURE_REASONS) as MailDraftFailureReasonKey[]).map((key) => [
    MAIL_DRAFT_FAILURE_REASONS[key],
    KNOWN_REASON_COPY[key],
  ]),
);

const detailPrefixes = Object.keys(MAIL_DRAFT_FAILURE_DETAIL_PREFIXES) as MailDraftFailureDetailKey[];

function bounded(value: string): string {
  return value.length > MAX_TECHNICAL_DETAIL_CHARS ? `${value.slice(0, MAX_TECHNICAL_DETAIL_CHARS)}…` : value;
}

/**
 * Maps the failure reason the Gateway recorded on a `failed` or `send_unavailable` draft (nothing was
 * sent on either) to operator copy. Known reasons get their own wording; reasons that carry provider or
 * Gateway text keep that text out of the summary and return it as `technicalDetail`.
 */
export function describeMailDraftFailure(reason: string | undefined): MailDraftFailureCopy {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return { summary: "Nothing was sent. The Gateway did not record a reason." };
  }
  const known = knownByReason.get(trimmed);
  if (known) {
    return { summary: known };
  }
  const detailKey = detailPrefixes.find((key) => trimmed.startsWith(MAIL_DRAFT_FAILURE_DETAIL_PREFIXES[key]));
  return {
    summary: detailKey
      ? DETAIL_REASON_COPY[detailKey]
      : "Nothing was sent. The Gateway recorded a reason this view does not recognize.",
    technicalDetail: bounded(trimmed),
  };
}

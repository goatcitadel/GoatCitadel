import type { MailDraftRecord } from "@goatcitadel/contracts";

export type MailCompose = { accountId: string; to: string; cc: string; bcc: string; subject: string; bodyText: string };
export type MailDraftRequest = {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
};
export type MailComposeErrors = Partial<Record<keyof MailCompose, string>>;

export const EMPTY_MAIL_COMPOSE: MailCompose = { accountId: "", to: "", cc: "", bcc: "", subject: "", bodyText: "" };

// The Gateway remains the address authority; this only catches obvious typing errors before a request.
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function recipientError(list: string[], required: boolean): string | undefined {
  if (required && !list.length) return "Enter at least one recipient.";
  const invalid = list.filter((item) => !ADDRESS.test(item));
  return invalid.length ? `Check these addresses: ${invalid.join(", ")}` : undefined;
}

/** Produces the exact owner request, or a named error per field. The body is never trimmed. */
export function validateMailCompose(
  value: MailCompose,
  accounts: readonly { accountId: string }[],
): { ok: true; request: MailDraftRequest } | { ok: false; errors: MailComposeErrors } {
  const request: MailDraftRequest = {
    accountId: value.accountId,
    to: parseRecipients(value.to),
    cc: parseRecipients(value.cc),
    bcc: parseRecipients(value.bcc),
    subject: value.subject.trim(),
    bodyText: value.bodyText,
  };
  const errors: MailComposeErrors = {};
  if (!accounts.some((account) => account.accountId === request.accountId))
    errors.accountId = "Choose a connected mail account for this workspace.";
  const to = recipientError(request.to, true),
    cc = recipientError(request.cc, false),
    bcc = recipientError(request.bcc, false);
  if (to) errors.to = to;
  if (cc) errors.cc = cc;
  if (bcc) errors.bcc = bcc;
  if (!request.subject) errors.subject = "Enter a subject.";
  if (!request.bodyText.trim()) errors.bodyText = "Enter the message text.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, request };
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** A Gateway draft confirms the request only when every reviewed field and the workspace are identical. */
export function draftMatchesRequest(record: MailDraftRecord, request: MailDraftRequest, workspaceId: string): boolean {
  return (
    record.workspaceId === workspaceId &&
    record.accountId === request.accountId &&
    sameList(record.to, request.to) &&
    sameList(record.cc, request.cc) &&
    sameList(record.bcc, request.bcc) &&
    record.subject === request.subject &&
    record.bodyText === request.bodyText
  );
}

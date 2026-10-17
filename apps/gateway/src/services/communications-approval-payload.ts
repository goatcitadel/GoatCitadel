import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";

/**
 * Communications approvals bind the exact effect the operator approved. The approval
 * payload carries `payloadHash` over the hashed fields below; the executor re-reads the
 * payload, recomputes the hash, and refuses to act on a mismatch. The idempotency key
 * needs the approval id, which exists only after creation, so it is derived here.
 *
 * `connectionRevision` is the integration connection's storage revision when the
 * approval was requested, so execution is bound to the account state the operator
 * approved. It is optional only so a payload without it still parses: the executor
 * treats a missing or different revision as a changed connection and sends nothing.
 */
export const COMMUNICATIONS_IDEMPOTENCY_PREFIX = "communications:";

export interface MailSendApprovalInput {
  draftId: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  connectionRevision?: string;
}

export interface CalendarCreateApprovalInput {
  eventId: string;
  accountId: string;
  calendarId?: string;
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  location?: string;
  connectionRevision?: string;
}

const MAIL_SEND_ACTION = "mail_send";
const CALENDAR_CREATE_ACTION = "calendar_event_create";
const CALENDAR_OPTIONAL_KEYS = ["calendarId", "description", "location", "connectionRevision"] as const;

export function communicationsIdempotencyKey(approvalId: string): string {
  return `${COMMUNICATIONS_IDEMPOTENCY_PREFIX}${approvalId}`;
}

/** SHA-256 hex of the canonical JSON of the hashed fields; absent optionals are omitted. */
export function computeCommunicationsPayloadHash(input: MailSendApprovalInput | CalendarCreateApprovalInput): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

/** Returns only the hashed mail-send fields, or undefined when the payload is not a well-formed send. */
export function readMailSendApprovalInput(payload: Record<string, unknown>): MailSendApprovalInput | undefined {
  if (payload.action !== MAIL_SEND_ACTION) {
    return undefined;
  }
  const { draftId, accountId, to, cc, bcc, subject, bodyText, connectionRevision } = payload;
  if (
    !isString(draftId) ||
    !isString(accountId) ||
    !isStringArray(to) ||
    !isStringArray(cc) ||
    !isStringArray(bcc) ||
    !isString(subject) ||
    !isString(bodyText) ||
    (connectionRevision !== undefined && !isString(connectionRevision))
  ) {
    return undefined;
  }
  return {
    draftId,
    accountId,
    to: [...to],
    cc: [...cc],
    bcc: [...bcc],
    subject,
    bodyText,
    ...(connectionRevision === undefined ? {} : { connectionRevision }),
  };
}

/** Returns only the hashed calendar-create fields, or undefined when the payload is malformed. */
export function readCalendarCreateApprovalInput(
  payload: Record<string, unknown>,
): CalendarCreateApprovalInput | undefined {
  if (payload.action !== CALENDAR_CREATE_ACTION) {
    return undefined;
  }
  const { eventId, accountId, title, startIso, endIso, attendees } = payload;
  if (
    !isString(eventId) ||
    !isString(accountId) ||
    !isString(title) ||
    !isString(startIso) ||
    !isString(endIso) ||
    !isStringArray(attendees)
  ) {
    return undefined;
  }
  const optionals: Partial<Pick<CalendarCreateApprovalInput, (typeof CALENDAR_OPTIONAL_KEYS)[number]>> = {};
  for (const key of CALENDAR_OPTIONAL_KEYS) {
    const value = payload[key];
    if (value === undefined) {
      continue;
    }
    if (!isString(value)) {
      return undefined;
    }
    optionals[key] = value;
  }
  return { eventId, accountId, title, startIso, endIso, attendees: [...attendees], ...optionals };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * The text of an errand approval sent to a channel conversation. It carries no ids, risk levels, kinds, token ids or
 * expiry times: only what GoatCitadel wants to do, the page it is on, and how to answer.
 */

/** Telegram's photo caption limit; the whole message must fit so the buttons stay on the photo. */
export const ERRAND_APPROVAL_MESSAGE_MAX_LENGTH = 1024;

export const ERRAND_APPROVAL_BUTTONS_LINE = "Tap Approve or Deny.";
export const ERRAND_APPROVAL_REPLY_LINE = "Reply APPROVE or DENY. Reply STOP to end the errand.";
export const ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE = "Screenshots are only sent in a private conversation.";

const SUMMARY_PREFIX = "GoatCitadel wants to: ";
const PAGE_PREFIX = "Page: ";
const ELLIPSIS = "…";
const SUMMARY_RESERVED_LENGTH = 256;

export interface ErrandApprovalMessageInput {
  summary: string;
  /** Already stored as origin and path only, without query or fragment. */
  pageUrl?: string;
  buttons: boolean;
  /** Extra lines after the instruction, such as the private-only screenshot note. */
  notes?: readonly string[];
}

/**
 * Builds the message. Lengths are UTF-16 code units, as Telegram counts them. When the message would exceed 1024
 * characters the summary is shortened with `…`, and a page address that would leave the summary under 256 characters
 * is shortened too; the instruction and notes are
 * always kept whole.
 */
export function buildErrandApprovalMessage(input: ErrandApprovalMessageInput): string {
  const instruction = [
    input.buttons ? ERRAND_APPROVAL_BUTTONS_LINE : ERRAND_APPROVAL_REPLY_LINE,
    ...(input.notes ?? []),
  ];
  const summary = input.summary.trim();
  const pageUrl = input.pageUrl?.trim();
  const pageLine = pageUrl ? `${PAGE_PREFIX}${pageUrl}` : undefined;
  // The summary line's prefix, the instruction lines, and the newlines between the lines.
  const fixedLength = SUMMARY_PREFIX.length + instruction.join("\n").length + (pageLine ? 2 : 1);
  // A very long page address gives way first, down to whatever leaves the summary its reserved share.
  const minimumSummary = Math.min(summary.length, SUMMARY_RESERVED_LENGTH);
  const pageRoom = ERRAND_APPROVAL_MESSAGE_MAX_LENGTH - fixedLength - minimumSummary;
  const fittedPage = pageLine ? fitText(pageLine, Math.max(pageRoom, PAGE_PREFIX.length + ELLIPSIS.length)) : undefined;
  const summaryRoom = ERRAND_APPROVAL_MESSAGE_MAX_LENGTH - fixedLength - (fittedPage?.length ?? 0);
  return [
    `${SUMMARY_PREFIX}${fitText(summary, summaryRoom)}`,
    ...(fittedPage ? [fittedPage] : []),
    ...instruction,
  ].join("\n");
}

/** Shortens `text` to at most `room` UTF-16 code units, ending in `…`, without splitting a surrogate pair. */
function fitText(text: string, room: number): string {
  if (text.length <= room) {
    return text;
  }
  if (room < ELLIPSIS.length) {
    return "";
  }
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > room - ELLIPSIS.length) {
      break;
    }
    kept += character;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/**
 * The conversation where waiting browser errand approvals go: the Chat session id of one of the operator's own private
 * conversations on a channel. An approval a PC errand has waited on for 30 seconds is sent there and to the phone.
 * Empty means no channel conversation; the phone still gets its push.
 */

/** The one answer for a conversation that is not the operator's own private one. */
export const ERRAND_APPROVAL_CONVERSATION_NOT_OWN = "Pick one of your own private conversations.";

/** Chat session ids are short opaque identifiers; anything longer is not one. */
export const ERRAND_APPROVAL_SESSION_ID_MAX_LENGTH = 256;

/** The Change Plan operation that picks the conversation, or clears it with `null`. */
export interface BrowserErrandApprovalConversationRuntimeOperation {
  readonly operation: "browser_errand_approval_conversation";
  readonly config: { readonly approvalSessionId: string | null };
}

/** A session id as stored: trimmed, non-empty, bounded and free of control characters. Anything else is undefined. */
export function readErrandApprovalSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > ERRAND_APPROVAL_SESSION_ID_MAX_LENGTH) return undefined;
  return [...sessionId].every((character) => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f)
    ? sessionId
    : undefined;
}

/** Shape only. The settings owner checks that the session is the operator's own private conversation. */
export function isBrowserErrandApprovalConversationRuntimeOperation(
  value: unknown,
): value is BrowserErrandApprovalConversationRuntimeOperation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operation", "config"])) return false;
  const { config } = value;
  if (value.operation !== "browser_errand_approval_conversation" || !isRecord(config)) return false;
  if (!hasOnlyKeys(config, ["approvalSessionId"])) return false;
  const sessionId = config.approvalSessionId;
  return sessionId === null || (typeof sessionId === "string" && readErrandApprovalSessionId(sessionId) === sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

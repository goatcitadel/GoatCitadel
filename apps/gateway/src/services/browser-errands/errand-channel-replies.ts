/**
 * Whole-message `APPROVE` / `DENY` / `STOP` replies in a channel conversation. They answer only the newest errand
 * approval still pending that was delivered to that conversation; anything else in the conversation stays ordinary
 * chat.
 */

import { ConflictError } from "@goatcitadel/contracts";
import { ErrandOwnerOnlyError, ERRAND_OWNER_ONLY_COPY, type ErrandPressInput } from "./errand-approval-press-guard.js";

export const ERRAND_REPLY_NEAR_MISS_COPY = "Reply APPROVE in capitals to approve.";
export const ERRAND_REPLY_APPROVED_COPY = "Approved.";
export const ERRAND_REPLY_DENIED_COPY = "Denied. The errand will stop.";
export const ERRAND_REPLY_STOPPING_COPY = "Stopping the errand.";
export const ERRAND_REPLY_ALREADY_ANSWERED_COPY = "This was already answered.";

export type ErrandReplyKind = "approve" | "deny" | "stop" | "near_miss";

const EXACT_REPLIES: Readonly<Record<string, Exclude<ErrandReplyKind, "near_miss">>> = {
  APPROVE: "approve",
  DENY: "deny",
  STOP: "stop",
};
const NEAR_MISS_WORDS = new Set(["yes", "ok"]);

/** Exact `APPROVE` / `DENY` / `STOP` after trimming; another casing of them, or `yes` / `ok`, is a near miss. */
export function classifyErrandReply(text: string): ErrandReplyKind | null {
  const trimmed = text.trim();
  const exact = EXACT_REPLIES[trimmed];
  if (exact) {
    return exact;
  }
  const lowered = trimmed.toLowerCase();
  return EXACT_REPLIES[trimmed.toUpperCase()] || NEAR_MISS_WORDS.has(lowered) ? "near_miss" : null;
}

export interface ErrandReplyInput {
  connectionId: string;
  channelKey: string;
  /** The conversation the message came from. */
  target: string;
  /** The provider user id that sent the message. */
  actorId: string;
  text: string;
}

export type ErrandReplyResult = { handled: false } | { handled: true; reply: string };

/** The newest errand approval still pending that was delivered to one conversation, and its errand. */
export interface PendingErrandDelivery {
  approvalId: string;
  errandId: string;
}

export interface ErrandReplyHandlerOptions {
  pendingDeliveryFor(connectionId: string, target: string): Promise<PendingErrandDelivery | undefined>;
  /** Throws `ErrandOwnerOnlyError` unless the sender is the operator's own account (see `isErrandOwner`). */
  assertOwner(input: ErrandPressInput): Promise<void>;
  resolveApproval(approvalId: string, decision: "approve" | "reject", resolvedBy: string): Promise<unknown>;
  stopErrand(errandId: string, actorId: string): Promise<boolean>;
}

/** A short plain-text answer to one conversation. */
export interface ErrandChannelReplySend {
  connectionId: string;
  target: string;
  message: string;
  /** Names this answer, so a retried inbound message sends it once. */
  idempotencyKey: string;
}

/** What the inbound channel owner calls before a message becomes a Chat turn, and how it sends the answer. */
export interface ErrandChannelReplies {
  handle(input: ErrandReplyInput): Promise<ErrandReplyResult>;
  send(input: ErrandChannelReplySend): Promise<void>;
}

/** Builds the hook the inbound channel owner calls before a message becomes a Chat turn. */
export function createErrandReplyHandler(
  options: ErrandReplyHandlerOptions,
): (input: ErrandReplyInput) => Promise<ErrandReplyResult> {
  const { pendingDeliveryFor, assertOwner, resolveApproval, stopErrand } = options;
  return async (input) => {
    const kind = classifyErrandReply(input.text);
    if (!kind) {
      return { handled: false };
    }
    const pending = await pendingDeliveryFor(input.connectionId, input.target);
    if (!pending) {
      return { handled: false };
    }
    const owner = await assertOwner({ connectorId: `integration:${input.connectionId}`, actorId: input.actorId }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof ErrandOwnerOnlyError) {
          return false;
        }
        throw error;
      },
    );
    if (!owner) {
      return { handled: true, reply: ERRAND_OWNER_ONLY_COPY };
    }
    if (kind === "near_miss") {
      return { handled: true, reply: ERRAND_REPLY_NEAR_MISS_COPY };
    }
    const actor = `${input.channelKey}:${input.actorId}`;
    if (kind === "stop") {
      await stopErrand(pending.errandId, actor);
      return { handled: true, reply: ERRAND_REPLY_STOPPING_COPY };
    }
    try {
      await resolveApproval(pending.approvalId, kind === "approve" ? "approve" : "reject", actor);
    } catch (error) {
      if (error instanceof ConflictError) {
        return { handled: true, reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY };
      }
      throw error;
    }
    return { handled: true, reply: kind === "approve" ? ERRAND_REPLY_APPROVED_COPY : ERRAND_REPLY_DENIED_COPY };
  };
}

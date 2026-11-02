/**
 * Whole-message `APPROVE` / `DENY` / `STOP` replies in a channel conversation. They answer only the approval the
 * running errand is waiting on, when it was delivered to that conversation before the reply arrived; anything else in
 * the conversation stays ordinary chat.
 */

import { ConflictError } from "@goatcitadel/contracts";
import { ErrandOwnerOnlyError, ERRAND_OWNER_ONLY_COPY, type ErrandPressInput } from "./errand-approval-press-guard.js";

export const ERRAND_REPLY_NEAR_MISS_COPY = "Reply APPROVE in capitals to approve.";
export const ERRAND_REPLY_STOP_NEAR_MISS_COPY = "Reply STOP in capitals to end the errand.";
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

/** The hint for a near miss: a stop variant gets the STOP hint, anything else the APPROVE one. */
export function errandNearMissCopy(text: string): string {
  return text.trim().toUpperCase() === "STOP" ? ERRAND_REPLY_STOP_NEAR_MISS_COPY : ERRAND_REPLY_NEAR_MISS_COPY;
}

/** A refusal or a near-miss hint goes to one conversation at most this often. */
export const ERRAND_REPLY_HINT_INTERVAL_MS = 30_000;

export interface ErrandReplyInput {
  connectionId: string;
  channelKey: string;
  /** The conversation the message came from. */
  target: string;
  /** The provider user id that sent the message. */
  actorId: string;
  text: string;
  /** When the message arrived (epoch ms); only an approval delivered no later than this can be answered by it. */
  sentAt: number;
  /**
   * Durably records, before anything is resolved or stopped, which approval this message answers, so a retry of the
   * same message never answers a later approval.
   */
  recordAnswer(approvalId: string): Promise<void>;
}

/** `reply` is absent when a hint or refusal was already sent to the conversation in the last 30 seconds. */
export type ErrandReplyResult = { handled: false } | { handled: true; reply?: string };

/** The approval the running errand is waiting on in one conversation, and its errand. */
export interface PendingErrandDelivery {
  approvalId: string;
  errandId: string;
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

export interface ErrandReplyHandlerOptions {
  pendingDeliveryFor(connectionId: string, target: string, sentAt: number): Promise<PendingErrandDelivery | undefined>;
  /** Throws `ErrandOwnerOnlyError` unless the sender is the operator's own account (see `isErrandOwner`). */
  assertOwner(input: ErrandPressInput): Promise<void>;
  resolveApproval(approvalId: string, decision: "approve" | "reject", resolvedBy: string): Promise<unknown>;
  stopErrand(errandId: string, actorId: string): Promise<boolean>;
  now?(): number;
}

/** Builds the hook the inbound channel owner calls before a message becomes a Chat turn. */
export function createErrandReplyHandler(
  options: ErrandReplyHandlerOptions,
): (input: ErrandReplyInput) => Promise<ErrandReplyResult> {
  const { pendingDeliveryFor, assertOwner, resolveApproval, stopErrand, now = Date.now } = options;
  /** When each conversation last got a refusal or hint; in memory only. */
  const lastHintAt = new Map<string, number>();
  const hint = (input: ErrandReplyInput, reply: string): ErrandReplyResult => {
    const key = JSON.stringify([input.connectionId, input.target]);
    const at = now();
    const last = lastHintAt.get(key);
    if (last !== undefined && at - last < ERRAND_REPLY_HINT_INTERVAL_MS) {
      return { handled: true };
    }
    lastHintAt.set(key, at);
    return { handled: true, reply };
  };
  return async (input) => {
    const kind = classifyErrandReply(input.text);
    if (!kind) {
      return { handled: false };
    }
    const pending = await pendingDeliveryFor(input.connectionId, input.target, input.sentAt);
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
      return hint(input, ERRAND_OWNER_ONLY_COPY);
    }
    if (kind === "near_miss") {
      return hint(input, errandNearMissCopy(input.text));
    }
    await input.recordAnswer(pending.approvalId);
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

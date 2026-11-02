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

/** An exact reply: what the operator decided. */
export type ErrandReplyDecision = Exclude<ErrandReplyKind, "near_miss">;

/** The approval one inbound message answered, as recorded on that message before anything was resolved. */
export interface ErrandReplyAnswer {
  approvalId: string;
  decision: ErrandReplyDecision;
}

const ERRAND_REPLY_MARKER_PREFIX = "errand-reply:";
const ERRAND_REPLY_DECISIONS: readonly ErrandReplyDecision[] = ["approve", "deny", "stop"];

/** The marker kept on the inbound event: `errand-reply:<decision>:<approvalId>`. */
export function encodeErrandReplyMarker(answer: ErrandReplyAnswer): string {
  return `${ERRAND_REPLY_MARKER_PREFIX}${answer.decision}:${answer.approvalId}`;
}

/** Whether an inbound event already answered an errand approval (any marker, readable or not). */
export function isErrandReplyMarker(value: string | undefined): value is string {
  return Boolean(value?.startsWith(ERRAND_REPLY_MARKER_PREFIX));
}

/** The answer a marker records; undefined for a marker that cannot be read. */
export function parseErrandReplyMarker(value: string): ErrandReplyAnswer | undefined {
  const rest = value.slice(ERRAND_REPLY_MARKER_PREFIX.length);
  const separator = rest.indexOf(":");
  const decision = rest.slice(0, separator) as ErrandReplyDecision;
  const approvalId = rest.slice(separator + 1);
  return separator > 0 && approvalId && ERRAND_REPLY_DECISIONS.includes(decision)
    ? { approvalId, decision }
    : undefined;
}

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
  recordAnswer(answer: ErrandReplyAnswer): Promise<void>;
  /**
   * Set on a retry of a message that already recorded its answer. The same decision is retried on that approval only,
   * while the errand is still waiting on it; otherwise the reply is "This was already answered."
   */
  answered?: ErrandReplyAnswer;
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

const ALREADY_ANSWERED: ErrandReplyResult = { handled: true, reply: ERRAND_REPLY_ALREADY_ANSWERED_COPY };

/** Builds the hook the inbound channel owner calls before a message becomes a Chat turn. */
export function createErrandReplyHandler(
  options: ErrandReplyHandlerOptions,
): (input: ErrandReplyInput) => Promise<ErrandReplyResult> {
  const { pendingDeliveryFor, assertOwner, resolveApproval, stopErrand, now = Date.now } = options;
  /** When each conversation last got a refusal or hint; in memory only, entries older than the interval pruned. */
  const lastHintAt = new Map<string, number>();
  const hint = (input: ErrandReplyInput, reply: string): ErrandReplyResult => {
    const key = JSON.stringify([input.connectionId, input.target]);
    const at = now();
    const last = lastHintAt.get(key);
    if (last !== undefined && at - last < ERRAND_REPLY_HINT_INTERVAL_MS) {
      return { handled: true };
    }
    for (const [staleKey, staleAt] of lastHintAt) {
      if (at - staleAt >= ERRAND_REPLY_HINT_INTERVAL_MS) {
        lastHintAt.delete(staleKey);
      }
    }
    lastHintAt.set(key, at);
    return { handled: true, reply };
  };
  const isOwner = (input: ErrandReplyInput): Promise<boolean> =>
    assertOwner({ connectorId: `integration:${input.connectionId}`, actorId: input.actorId }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof ErrandOwnerOnlyError) {
          return false;
        }
        throw error;
      },
    );
  const decide = async (
    input: ErrandReplyInput,
    pending: PendingErrandDelivery,
    decision: ErrandReplyDecision,
  ): Promise<ErrandReplyResult> => {
    const actor = `${input.channelKey}:${input.actorId}`;
    if (decision === "stop") {
      await stopErrand(pending.errandId, actor);
      return { handled: true, reply: ERRAND_REPLY_STOPPING_COPY };
    }
    try {
      await resolveApproval(pending.approvalId, decision === "approve" ? "approve" : "reject", actor);
    } catch (error) {
      if (error instanceof ConflictError) {
        return ALREADY_ANSWERED;
      }
      throw error;
    }
    return { handled: true, reply: decision === "approve" ? ERRAND_REPLY_APPROVED_COPY : ERRAND_REPLY_DENIED_COPY };
  };
  return async (input) => {
    const pendingNow = () => pendingDeliveryFor(input.connectionId, input.target, input.sentAt);
    const { answered } = input;
    if (answered) {
      // A retry: only the recorded approval, while the errand still waits on it. Never another one.
      const pending = await pendingNow();
      if (pending?.approvalId !== answered.approvalId) {
        return ALREADY_ANSWERED;
      }
      // Owner status is checked again: a pairing revoked since the first attempt no longer answers.
      if (!(await isOwner(input))) {
        return { handled: true, reply: ERRAND_OWNER_ONLY_COPY };
      }
      return await decide(input, pending, answered.decision);
    }
    const kind = classifyErrandReply(input.text);
    if (!kind) {
      return { handled: false };
    }
    const pending = await pendingNow();
    if (!pending) {
      return { handled: false };
    }
    if (!(await isOwner(input))) {
      // Someone else's "ok" or lowercase word is ordinary chat; only an exact reply gets the refusal.
      return kind === "near_miss" ? { handled: false } : hint(input, ERRAND_OWNER_ONLY_COPY);
    }
    if (kind === "near_miss") {
      return hint(input, errandNearMissCopy(input.text));
    }
    await input.recordAnswer({ approvalId: pending.approvalId, decision: kind });
    return await decide(input, pending, kind);
  };
}

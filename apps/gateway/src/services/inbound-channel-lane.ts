import { classifyErrandReply, type ErrandChannelReplies } from "./browser-errands/errand-channel-replies.js";

/**
 * The ordering lane of one channel conversation.
 *
 * The inbound worker claims an event only once every earlier unsettled event in its lane has settled, and it processes
 * claims from different lanes concurrently. Every event about one conversation, from the channel or from the desk,
 * must therefore carry the same lane, or a later message can be answered before an earlier one is recorded.
 */
export interface InboundConversationLaneInput {
  channel: string;
  connectionId: string;
  bindingTarget?: string;
  message: { account: string; peer?: string; room?: string; threadId?: string };
}

/** `channel:connection:conversation[:thread]`, with the room or else the peer naming the conversation. */
export function buildInboundConversationLaneKey(input: InboundConversationLaneInput): string {
  const conversation = input.message.room ?? input.message.peer ?? input.bindingTarget ?? input.message.account;
  return [input.channel, input.connectionId, conversation, input.message.threadId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join(":");
}

/**
 * The lane of a conversation's errand control events: an exact APPROVE / DENY / STOP reply to an errand approval
 * waiting there, and approval buttons or approval commands. The turn that started a channel errand stays in flight
 * until the errand ends, so control events queued behind it in the conversation's own lane could never answer it.
 * They keep their order among themselves, and run while that turn waits.
 */
export const INBOUND_ERRAND_CONTROL_LANE_PREFIX = "errand-control:";

/** Event types of the Telegram and Discord Approve / Deny buttons (kept equal to their owners' constants). */
const APPROVAL_BUTTON_EVENT_TYPES: ReadonlySet<string> = new Set([
  "telegram-approval-callback",
  "discord-approval-button",
]);
/** Secret-free metadata an accepted approval command carries (Telegram callback, Discord slash command or button). */
const APPROVAL_DECISION_METADATA_KEYS = ["approvalDecision", "discordApprovalDecision"] as const;

export function buildInboundErrandControlLaneKey(conversationLaneKey: string): string {
  return `${INBOUND_ERRAND_CONTROL_LANE_PREFIX}${conversationLaneKey}`;
}

/** An approval button press or approval command, read from the accepted event alone. */
export function isInboundApprovalCommand(input: {
  dispatchKind: string;
  eventType: string;
  message: { metadata?: Record<string, unknown> };
}): boolean {
  if (input.dispatchKind !== "command") {
    return false;
  }
  if (APPROVAL_BUTTON_EVENT_TYPES.has(input.eventType)) {
    return true;
  }
  const metadata = input.message.metadata;
  return APPROVAL_DECISION_METADATA_KEYS.some((key) => typeof metadata?.[key] === "string");
}

/** One drain loop of the inbound worker: the whole queue, or only the lanes that start with `laneKeyPrefix`. */
export interface InboundDrainLoop {
  promise?: Promise<void>;
  requested: boolean;
  readonly limit: number;
  readonly laneKeyPrefix?: string;
}

/**
 * The main loop claims every lane and waits for its whole batch, including a channel errand's turn that waits on an
 * approval. The control loop claims only errand control lanes, four at a time, so an answer to that approval still runs.
 */
export const INBOUND_DRAIN_LOOPS: readonly InboundDrainLoop[] = [
  { requested: false, limit: 25 },
  { requested: false, limit: 4, laneKeyPrefix: INBOUND_ERRAND_CONTROL_LANE_PREFIX },
];

/** What deciding an event's lane reads. */
export interface InboundLaneDecisionHooks {
  awaitsAnswer: ErrandChannelReplies["awaitsAnswer"];
  events: {
    getByIdentity(identity: {
      channelKey: string;
      connectionId: string;
      idempotencyKey: string;
    }): Promise<{ laneKey: string } | undefined>;
  };
  /** The errand could not say whether it waits; the reply stays in the conversation's lane. */
  undecided(error: unknown): void;
}

/**
 * The conversation's lane, or its errand control lane for an approval button or command, and for an exact
 * APPROVE / DENY / STOP while an errand approval delivered to the conversation waits. A provider retry keeps the lane
 * its first acceptance chose, whatever the errand has done since.
 */
export async function resolveInboundLaneKey(
  input: InboundConversationLaneInput & {
    dispatchKind: string;
    eventType: string;
    idempotencyKey: string;
    message: { content?: string; metadata?: Record<string, unknown> };
  },
  hooks: InboundLaneDecisionHooks,
): Promise<string> {
  const conversationLane = buildInboundConversationLaneKey(input);
  const controlLane = buildInboundErrandControlLaneKey(conversationLane);
  if (isInboundApprovalCommand(input)) {
    return controlLane;
  }
  const text = input.message.content ?? "";
  const target = input.bindingTarget?.trim();
  const kind = classifyErrandReply(text);
  const typed = input.dispatchKind === "agent_turn" || input.dispatchKind === "record_only";
  const { awaitsAnswer, events, undecided } = hooks;
  if (!typed || !target || !awaitsAnswer || !kind || kind === "near_miss") {
    return conversationLane;
  }
  const existing = await events.getByIdentity({
    channelKey: input.channel,
    connectionId: input.connectionId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    return existing.laneKey === controlLane ? controlLane : conversationLane;
  }
  const waiting = await awaitsAnswer({ connectionId: input.connectionId, target, text, sentAt: Date.now() }).catch(
    (error: unknown) => {
      undecided(error);
      return false;
    },
  );
  return waiting ? controlLane : conversationLane;
}

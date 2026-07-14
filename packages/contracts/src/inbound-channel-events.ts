/**
 * Durable ingress acceptance contract for channel/webhook adapters.
 *
 * The persisted payload is deliberately bounded and normalized by storage
 * before a provider acknowledgement is allowed. Raw request bodies, headers,
 * credentials, and transport clients do not belong in this record.
 */
export const INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_DEPTH = 24;
export const INBOUND_CHANNEL_EVENT_MAX_PAYLOAD_KEYS = 512;
export const INBOUND_CHANNEL_COMMAND_RESULT_MAX_BYTES = 16 * 1024;

export type InboundChannelEventStatus =
  | "accepted"
  | "processing"
  | "message_recorded"
  | "command_execution_started"
  | "turn_admitted"
  | "waiting"
  | "reply_enqueued"
  | "retry_wait"
  | "completed"
  | "suppressed"
  | "failed"
  | "manual_reconciliation_required";

export type InboundChannelEventTerminalStatus = Exclude<
  InboundChannelEventStatus,
  | "accepted"
  | "processing"
  | "message_recorded"
  | "command_execution_started"
  | "turn_admitted"
  | "waiting"
  | "reply_enqueued"
  | "retry_wait"
>;

export type InboundChannelDispatchKind = "agent_turn" | "voice_agent_turn" | "record_only" | "command";

/**
 * Durable admission state for the process-local bot-loop guard.
 *
 * `evaluating` is committed before consulting the guard. A recovered worker
 * must not consult the guard again for that event, which prevents claim
 * retries and approval polling from being counted as new bot-loop traffic.
 */
export type InboundChannelBotLoopDecision = "evaluating" | "allow" | "suppress";

export interface InboundChannelEventLinkage {
  sessionKey?: string;
  sessionId?: string;
  messageId?: string;
  turnId?: string;
  assistantMessageId?: string;
  durableRunId?: string;
  deliveryId?: string;
  providerMessageId?: string;
  messageContentHash?: string;
  deliveryPayloadHash?: string;
  commandOperationKey?: string;
  commandResultText?: string;
}

export interface InboundChannelEventRecord extends InboundChannelEventLinkage {
  sequence: number;
  eventId: string;
  channelKey: string;
  connectionId: string;
  transport: string;
  dispatchKind: InboundChannelDispatchKind;
  providerSourceId?: string;
  idempotencyKey: string;
  laneKey: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  status: InboundChannelEventStatus;
  attemptCount: number;
  claimGeneration: number;
  claimToken?: string;
  claimOwnerId?: string;
  claimExpiresAt?: string;
  claimHeartbeatAt?: string;
  nextAttemptAt?: string;
  botLoopDecision?: InboundChannelBotLoopDecision;
  botLoopReason?: string;
  lastError?: string;
  reconciliationReason?: string;
  receivedAt: string;
  acceptedAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface InboundChannelEventAcceptInput {
  eventId?: string;
  channelKey: string;
  connectionId: string;
  transport: string;
  dispatchKind: InboundChannelDispatchKind;
  providerSourceId?: string;
  idempotencyKey: string;
  laneKey: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}

export interface InboundChannelEventClaimToken {
  eventId: string;
  ownerId: string;
  generation: number;
  claimToken: string;
}

export interface InboundChannelEventClaim extends InboundChannelEventClaimToken {
  event: InboundChannelEventRecord;
}

export type InboundChannelEventAcceptResult =
  | { outcome: "accepted"; event: InboundChannelEventRecord }
  | { outcome: "duplicate"; event: InboundChannelEventRecord };

export interface InboundChannelEventClaimedTransition {
  status:
    | InboundChannelEventTerminalStatus
    | "message_recorded"
    | "command_execution_started"
    | "turn_admitted"
    | "waiting"
    | "reply_enqueued"
    | "retry_wait";
  nextAttemptAt?: string;
  lastError?: string;
  reconciliationReason?: string;
  linkage?: InboundChannelEventLinkage;
}

export function isInboundChannelEventTerminalStatus(
  status: InboundChannelEventStatus,
): status is InboundChannelEventTerminalStatus {
  return (
    status === "completed" ||
    status === "suppressed" ||
    status === "failed" ||
    status === "manual_reconciliation_required"
  );
}

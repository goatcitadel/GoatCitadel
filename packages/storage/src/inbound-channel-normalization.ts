import {
  ValidationError,
  type InboundChannelBotLoopDecision,
  type InboundChannelEventRecord,
  type InboundChannelEventStatus,
} from "@goatcitadel/contracts";

const DISPATCH_KINDS = new Set(["agent_turn", "voice_agent_turn", "record_only", "command", "operator_desk_turn"]);

export function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

export function normalizeOptional(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeRequired(value, field);
}

export function normalizeTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ValidationError({ field, message: `${field} must be a valid timestamp.` });
  }
  return new Date(time).toISOString();
}

export function normalizeSafeInteger(value: number | string, field: string, minimum: number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

export function normalizeLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError({ field: "leaseDurationMs", message: "leaseDurationMs must be a positive integer." });
  }
  return value;
}

export function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new ValidationError({ field: "limit", message: "limit must be an integer from 1 through 1000." });
  }
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeDispatchKind(value: unknown): InboundChannelEventRecord["dispatchKind"] {
  if (typeof value === "string" && DISPATCH_KINDS.has(value)) {
    return value as InboundChannelEventRecord["dispatchKind"];
  }
  throw new ValidationError({ field: "dispatchKind", message: "dispatchKind is not supported." });
}

export function normalizeInboundStatus(value: string): InboundChannelEventStatus {
  if (
    value === "accepted" ||
    value === "processing" ||
    value === "message_recorded" ||
    value === "command_execution_started" ||
    value === "turn_admitted" ||
    value === "waiting" ||
    value === "reply_enqueued" ||
    value === "retry_wait" ||
    value === "completed" ||
    value === "suppressed" ||
    value === "failed" ||
    value === "manual_reconciliation_required"
  ) {
    return value;
  }
  throw new TypeError(`inbound_channel_events status is not supported: ${value}`);
}

export function normalizeBotLoopDecision(value: string | null): InboundChannelBotLoopDecision | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "evaluating" || value === "allow" || value === "suppress") {
    return value;
  }
  throw new TypeError(`inbound_channel_events bot_loop_decision is not supported: ${value}`);
}

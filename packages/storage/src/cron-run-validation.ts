import {
  isCronRunTerminalStatus,
  PayloadTooLargeError,
  ValidationError,
  type CronJobAction,
  type CronRunActiveStatus,
  type CronRunBeginInput,
  type CronRunPhase,
  type CronRunStatus,
  type CronRunTerminalStatus,
  type CronRunTrigger,
} from "@goatcitadel/contracts";

const CRON_RUN_MAX_JSON_BYTES = 64 * 1024;
const CRON_RUN_MAX_JSON_DEPTH = 24;
const CRON_RUN_MAX_JSON_KEYS = 512;

export function parseActionConfig(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  return parseStoredObject(value, "action_config_json", "cron_job");
}

export function parseStoredObject(value: string, field: string, id: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${field} for ${id} is invalid JSON`, { cause: error });
  }
  if (!isPlainRecord(parsed)) {
    throw new TypeError(`${field} for ${id} must contain a JSON object`);
  }
  return parsed;
}

export function normalizeBoundedJson(value: Record<string, unknown>, field: string): string {
  const seen = new WeakSet<object>();
  let keyCount = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > CRON_RUN_MAX_JSON_DEPTH) {
      throw new PayloadTooLargeError(`${field} exceeds the maximum nesting depth.`);
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new ValidationError({ field, message: `${field} numbers must be finite.` });
      return item;
    }
    if (typeof item !== "object") {
      throw new ValidationError({ field, message: `${field} must contain only JSON values.` });
    }
    if (seen.has(item)) throw new ValidationError({ field, message: `${field} must not contain cycles.` });
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
      if (!isPlainRecord(item)) throw new ValidationError({ field, message: `${field} objects must be plain.` });
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        keyCount += 1;
        if (keyCount > CRON_RUN_MAX_JSON_KEYS) throw new PayloadTooLargeError(`${field} contains too many keys.`);
        normalized[key] = visit(item[key], depth + 1);
      }
      return normalized;
    } finally {
      seen.delete(item);
    }
  };
  const json = JSON.stringify(visit(value, 0));
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > CRON_RUN_MAX_JSON_BYTES) {
    throw new PayloadTooLargeError(`${field} is ${bytes} bytes; maximum is ${CRON_RUN_MAX_JSON_BYTES}.`, {
      field,
      bytes,
      maxBytes: CRON_RUN_MAX_JSON_BYTES,
    });
  }
  return json;
}

export function normalizeTrigger(value: unknown): CronRunTrigger {
  if (value !== "scheduled_due" && value !== "manual" && value !== "forced") {
    throw new ValidationError({ field: "trigger" });
  }
  return value;
}

export function normalizeStatus(value: unknown): CronRunStatus {
  if (
    value === "admitting" ||
    value === "admitted" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "dead_lettered" ||
    value === "manual_reconciliation_required"
  ) {
    return value;
  }
  throw new TypeError(`cron_runs status is not supported: ${String(value)}`);
}

export function normalizeActiveStatus(value: unknown): CronRunActiveStatus {
  const status = normalizeStatus(value);
  if (!isCronRunTerminalStatus(status)) {
    return status;
  }
  throw new ValidationError({ field: "status", message: "Active cron run status is required." });
}

export function normalizeTerminalStatus(value: unknown): CronRunTerminalStatus {
  const status = normalizeStatus(value);
  if (isCronRunTerminalStatus(status)) {
    return status;
  }
  throw new ValidationError({ field: "status", message: "Terminal cron run status is required." });
}

export function normalizeReconciliationStatus(
  value: unknown,
): Exclude<CronRunTerminalStatus, "manual_reconciliation_required"> {
  const status = normalizeTerminalStatus(value);
  if (status !== "manual_reconciliation_required") {
    return status;
  }
  throw new ValidationError({ field: "status", message: "Reconciliation must resolve to a final terminal status." });
}

export function normalizePhase(value: unknown): CronRunPhase {
  if (
    value === "child_admission" ||
    value === "chat_execution" ||
    value === "autonomous_post_commit" ||
    value === "delivery" ||
    value === "settlement"
  ) {
    return value;
  }
  throw new ValidationError({ field: "phase", message: "Cron run phase is not supported." });
}

export function normalizeAction(value: unknown): CronJobAction {
  if (
    value === "task" ||
    value === "improvement" ||
    value === "curator" ||
    value === "backup" ||
    value === "memory_flush" ||
    value === "memory_consolidation" ||
    value === "cost_report" ||
    value === "update_review" ||
    value === "watchdog" ||
    value === "no_agent" ||
    value === "agent_turn"
  ) {
    return value;
  }
  throw new TypeError(`cron_runs action is not supported: ${String(value)}`);
}

export function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  return normalized;
}

export function normalizeOptional(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : normalizeRequired(value, field);
}

export function normalizeTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new ValidationError({ field, message: `${field} must be a valid timestamp.` });
  return new Date(timestamp).toISOString();
}

export function normalizeInteger(value: number | string, field: string, minimum: number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

export function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ValidationError({ field: "limit", message: "limit must be an integer from 1 through 1000." });
  }
  return limit;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeCronEventSource(value: CronRunBeginInput["eventSource"]): CronRunBeginInput["eventSource"] {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 5 ||
    Object.keys(value).some(
      (key) => !["eventId", "eventType", "workspaceId", "sourceConnectionId", "payloadHash"].includes(key),
    ) ||
    value.eventType !== "subagent.end" ||
    typeof value.payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.payloadHash)
  )
    throw new ValidationError({ message: "Invalid canonical follow-through event reference." });
  return {
    eventId: normalizeRequired(value.eventId, "eventId"),
    eventType: "subagent.end",
    workspaceId: normalizeRequired(value.workspaceId, "workspaceId"),
    sourceConnectionId: normalizeRequired(value.sourceConnectionId, "sourceConnectionId"),
    payloadHash: value.payloadHash,
  };
}

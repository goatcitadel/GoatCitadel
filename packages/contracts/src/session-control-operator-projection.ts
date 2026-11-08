import type { SessionControlDetailResponse, SessionControlEventReasonCode } from "./session-control.js";

export const SESSION_CONTROL_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u;
export const SESSION_CONTROL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const OPERATOR_CURRENT_EVENT_REASONS = new Set<string>([
  "session_initialized",
  "request_created",
  "request_rejected",
  "request_expired",
  "request_cancelled",
  "identity_revoked",
  "release",
  "operator_revoke",
  "emergency_takeover",
  "auth_revoked",
  "session_reactivated",
  "heartbeat_preempted",
  "mutation_denied",
]);

const OPERATOR_EXTERNAL_RETURN_EVENT_REASONS = new Set<string>([
  "identity_revoked",
  "release",
  "operator_revoke",
  "emergency_takeover",
  "auth_revoked",
]);

export function isCanonicalSessionControlTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isOperatorControlEvent(reason: unknown, generation: number): reason is SessionControlEventReasonCode {
  return (
    typeof reason === "string" &&
    OPERATOR_CURRENT_EVENT_REASONS.has(reason) &&
    (reason !== "session_initialized" || generation === 1) &&
    (!OPERATOR_EXTERNAL_RETURN_EVENT_REASONS.has(reason) || generation >= 3) &&
    (reason !== "session_reactivated" || generation >= 2)
  );
}

export function snapshotSessionControlData(value: unknown): unknown {
  return snapshotPlainData(value, { nodes: 0 }, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && SESSION_CONTROL_IDENTIFIER_PATTERN.test(value);
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** Validates the common idle operator projection without loading the full control protocol. */
export function readIdleOperatorControlDetail(input: unknown): SessionControlDetailResponse | undefined {
  let snapshot: unknown;
  try {
    snapshot = snapshotSessionControlData(input);
  } catch {
    return undefined;
  }
  if (!record(snapshot) || Object.keys(snapshot).length !== 2 || !emptyArray(snapshot.pendingRequests)) return;
  const control = snapshot.control;
  if (!record(control) || Object.keys(control).length !== 9) return;
  const { workspaceId, sessionId, generation, lastEventId, lastEventReasonCode, updatedAt } = control;
  if (
    control.ownerKind !== "operator" ||
    control.leaseState !== "operator_active" ||
    !emptyArray(control.capabilities) ||
    !identifier(workspaceId) ||
    !identifier(sessionId) ||
    !identifier(lastEventId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !isOperatorControlEvent(lastEventReasonCode, generation) ||
    typeof updatedAt !== "string" ||
    !SESSION_CONTROL_TIMESTAMP_PATTERN.test(updatedAt) ||
    !isCanonicalSessionControlTimestamp(updatedAt)
  ) {
    return;
  }
  return Object.freeze({
    control: Object.freeze({
      workspaceId,
      sessionId,
      generation,
      lastEventId,
      lastEventReasonCode,
      updatedAt,
      ownerKind: "operator" as const,
      leaseState: "operator_active" as const,
      capabilities: Object.freeze([] as const),
    }),
    pendingRequests: Object.freeze([] as const),
  });
}

function snapshotPlainData(value: unknown, state: { nodes: number }, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  state.nodes += 1;
  if (depth > 12 || state.nodes > 10_000) throw new TypeError("Untrusted value exceeds structural bounds.");

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 1_000) {
      throw new TypeError("Untrusted array is invalid.");
    }
    const expectedKeys = value.length + 1;
    if (keys.length !== expectedKeys || !keys.includes("length")) throw new TypeError("Untrusted array is invalid.");
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Untrusted array is invalid.");
      }
      snapshot.push(snapshotPlainData(descriptor.value, state, depth + 1));
    }
    return snapshot;
  }

  if (prototype !== Object.prototype || keys.length > 64) throw new TypeError("Untrusted object is invalid.");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("Untrusted object is invalid.");
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Untrusted object is invalid.");
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotPlainData(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
}

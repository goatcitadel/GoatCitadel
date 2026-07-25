import { canonicalJsonString } from "./canonical-json.js";

/**
 * HX-503 assignment-bound remote-worker inference contract (production-dark).
 *
 * The worker may supply ONLY the identities below, the raw assignment lease
 * token, bounded text-only messages, the exact input/context/model-intent
 * hashes, and bounded output/reasoning/temperature ceilings. It can never
 * supply a provider, model, API style, provider URL, credential reference,
 * key, header, tool, memory, metadata, service tier, fallback list, or a
 * multimodal body; `assertExactKeys` rejects every such field. The Gateway
 * hashes the raw lease immediately (`remoteWorkerInferenceLeaseTokenSha256`)
 * and never persists or logs it, then chooses the effective provider/model and
 * owns every credential. Output frames are secret-free: raw provider errors,
 * headers, bodies, private reasoning, and credentials never enter a frame.
 */

export const REMOTE_WORKER_INFERENCE_REQUEST_SCHEMA_VERSION = "goatcitadel.remote-worker-inference-request.v1" as const;
export const REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION = "goatcitadel.remote-worker-inference-frame.v1" as const;
export const REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-inference-governance.v1" as const;
export const REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION = "goatcitadel.remote-worker-inference-budget.v1" as const;

export const REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256 = "0".repeat(64);

export const REMOTE_WORKER_INFERENCE_MAX_MESSAGES = 256;
export const REMOTE_WORKER_INFERENCE_MAX_MESSAGE_CHARS = 131_072;
export const REMOTE_WORKER_INFERENCE_MAX_REQUEST_CHARS = 1_048_576;
export const REMOTE_WORKER_INFERENCE_MAX_OUTPUT_TOKEN_CEILING = 1_000_000;
export const REMOTE_WORKER_INFERENCE_MAX_REASONING_TOKEN_CEILING = 1_000_000;
export const REMOTE_WORKER_INFERENCE_MAX_TEMPERATURE_MILLI = 2_000;
export const REMOTE_WORKER_INFERENCE_MAX_FRAMES = 100_000;
export const REMOTE_WORKER_INFERENCE_MAX_FRAME_TEXT_CHARS = 131_072;
export const REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS = 8_388_608;

export const REMOTE_WORKER_INFERENCE_MESSAGE_ROLES = ["system", "user", "assistant"] as const;
export type RemoteWorkerInferenceMessageRole = (typeof REMOTE_WORKER_INFERENCE_MESSAGE_ROLES)[number];

export const REMOTE_WORKER_INFERENCE_STATES = [
  "admitted",
  "waiting_approval",
  "blocked",
  "dispatch_claimed",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "dispatch_unknown",
] as const;
export type RemoteWorkerInferenceState = (typeof REMOTE_WORKER_INFERENCE_STATES)[number];

export const REMOTE_WORKER_INFERENCE_TERMINAL_STATES = [
  "completed",
  "failed",
  "cancelled",
  "dispatch_unknown",
] as const;
export type RemoteWorkerInferenceTerminalState = (typeof REMOTE_WORKER_INFERENCE_TERMINAL_STATES)[number];

export const REMOTE_WORKER_INFERENCE_GOVERNANCE_DECISIONS = ["allowed", "approval_required", "denied"] as const;
export type RemoteWorkerInferenceGovernanceDecision = (typeof REMOTE_WORKER_INFERENCE_GOVERNANCE_DECISIONS)[number];

export const REMOTE_WORKER_INFERENCE_FRAME_KINDS = ["output_text", "terminal"] as const;
export type RemoteWorkerInferenceFrameKind = (typeof REMOTE_WORKER_INFERENCE_FRAME_KINDS)[number];

const STATE_TRANSITIONS: Readonly<Record<RemoteWorkerInferenceState, readonly RemoteWorkerInferenceState[]>> = {
  admitted: ["waiting_approval", "blocked", "dispatch_claimed"],
  waiting_approval: ["admitted", "blocked"],
  blocked: [],
  dispatch_claimed: ["streaming", "completed", "failed", "cancelled", "dispatch_unknown"],
  streaming: ["completed", "failed", "cancelled", "dispatch_unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  dispatch_unknown: [],
};

/** True when the state machine permits the transition (identity transitions are rejected). */
export function remoteWorkerInferenceStateCanTransition(
  from: RemoteWorkerInferenceState,
  to: RemoteWorkerInferenceState,
): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isRemoteWorkerInferenceTerminalState(value: string): value is RemoteWorkerInferenceTerminalState {
  return (REMOTE_WORKER_INFERENCE_TERMINAL_STATES as readonly string[]).includes(value);
}

// --- Worker-supplied submission ---------------------------------------------

export interface RemoteWorkerInferenceMessage {
  readonly role: RemoteWorkerInferenceMessageRole;
  readonly text: string;
}

export interface RemoteWorkerInferenceRequestSubmission {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  /** Raw assignment lease token. Hashed immediately by the Gateway, never persisted or logged. */
  readonly leaseToken: string;
  readonly messages: readonly RemoteWorkerInferenceMessage[];
  readonly inputSha256: string;
  readonly contextSha256: string;
  readonly modelIntentSha256: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly temperatureMilli: number;
}

export interface NormalizedRemoteWorkerInferenceRequestSubmission {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  readonly messages: readonly RemoteWorkerInferenceMessage[];
  readonly inputSha256: string;
  readonly contextSha256: string;
  readonly modelIntentSha256: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly temperatureMilli: number;
}

const SUBMISSION_KEYS = [
  "registryWorkspaceId",
  "assignmentId",
  "assignmentGeneration",
  "inferenceRequestId",
  "attempt",
  "idempotencyKey",
  "leaseToken",
  "messages",
  "inputSha256",
  "contextSha256",
  "modelIntentSha256",
  "outputTokenCeiling",
  "reasoningTokenCeiling",
  "temperatureMilli",
] as const;

export function normalizeRemoteWorkerInferenceRequestSubmission(
  input: RemoteWorkerInferenceRequestSubmission,
): NormalizedRemoteWorkerInferenceRequestSubmission {
  assertRecord(input, "inference request submission");
  assertExactKeys(input, [...SUBMISSION_KEYS], "inference request submission");
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    inferenceRequestId: identifier(input.inferenceRequestId, "inferenceRequestId"),
    attempt: positiveInteger(input.attempt, "attempt"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    leaseToken: leaseToken(input.leaseToken),
    messages: normalizeMessages(input.messages),
    inputSha256: digest(input.inputSha256, "inputSha256"),
    contextSha256: digest(input.contextSha256, "contextSha256"),
    modelIntentSha256: digest(input.modelIntentSha256, "modelIntentSha256"),
    outputTokenCeiling: positiveInteger(
      input.outputTokenCeiling,
      "outputTokenCeiling",
      REMOTE_WORKER_INFERENCE_MAX_OUTPUT_TOKEN_CEILING,
    ),
    reasoningTokenCeiling: nonNegativeInteger(
      input.reasoningTokenCeiling,
      "reasoningTokenCeiling",
      REMOTE_WORKER_INFERENCE_MAX_REASONING_TOKEN_CEILING,
    ),
    temperatureMilli: nonNegativeInteger(
      input.temperatureMilli,
      "temperatureMilli",
      REMOTE_WORKER_INFERENCE_MAX_TEMPERATURE_MILLI,
    ),
  });
}

function normalizeMessages(value: unknown): readonly RemoteWorkerInferenceMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKER_INFERENCE_MAX_MESSAGES) {
    throw new TypeError("Remote worker inference messages must be a bounded non-empty array.");
  }
  let totalChars = 0;
  const messages = value.map((entry, index) => {
    assertRecord(entry, `inference message[${index}]`);
    assertExactKeys(entry, ["role", "text"], `inference message[${index}]`);
    enumValue(entry.role, REMOTE_WORKER_INFERENCE_MESSAGE_ROLES, `inference message[${index}] role`);
    const text = boundedText(entry.text, `inference message[${index}] text`, REMOTE_WORKER_INFERENCE_MAX_MESSAGE_CHARS);
    totalChars += text.length;
    return Object.freeze({ role: entry.role, text });
  });
  if (totalChars > REMOTE_WORKER_INFERENCE_MAX_REQUEST_CHARS) {
    throw new TypeError("Remote worker inference request exceeds the bounded total character budget.");
  }
  return Object.freeze(messages);
}

/**
 * The canonical bounded request body persisted verbatim and delivered to the
 * provider. It excludes all identities and the raw lease so the same logical
 * request under a renewed lease hashes identically.
 */
export function remoteWorkerInferenceCanonicalRequestBody(input: RemoteWorkerInferenceRequestSubmission): object {
  const normalized = normalizeRemoteWorkerInferenceRequestSubmission(input);
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_INFERENCE_REQUEST_SCHEMA_VERSION,
    messages: normalized.messages,
    inputSha256: normalized.inputSha256,
    contextSha256: normalized.contextSha256,
    modelIntentSha256: normalized.modelIntentSha256,
    outputTokenCeiling: normalized.outputTokenCeiling,
    reasoningTokenCeiling: normalized.reasoningTokenCeiling,
    temperatureMilli: normalized.temperatureMilli,
  });
}

/**
 * Replay material folds identity and body together (never the lease). A reused
 * idempotency key with any changed identity or body byte conflicts.
 */
export function remoteWorkerInferenceRequestReplayMaterial(input: RemoteWorkerInferenceRequestSubmission): object {
  const normalized = normalizeRemoteWorkerInferenceRequestSubmission(input);
  return Object.freeze({
    registryWorkspaceId: normalized.registryWorkspaceId,
    assignmentId: normalized.assignmentId,
    assignmentGeneration: normalized.assignmentGeneration,
    inferenceRequestId: normalized.inferenceRequestId,
    attempt: normalized.attempt,
    idempotencyKey: normalized.idempotencyKey,
    body: remoteWorkerInferenceCanonicalRequestBody(input),
  });
}

export function remoteWorkerInferenceRequestSha256(input: RemoteWorkerInferenceRequestSubmission): string {
  return remoteWorkerInferenceCanonicalSha256(remoteWorkerInferenceRequestReplayMaterial(input));
}

export function remoteWorkerInferenceCanonicalRequestBodySha256(input: RemoteWorkerInferenceRequestSubmission): string {
  return remoteWorkerInferenceCanonicalSha256(remoteWorkerInferenceCanonicalRequestBody(input));
}

/** Hash the raw lease token the moment it arrives; the plaintext never travels further. */
export function remoteWorkerInferenceLeaseTokenSha256(rawLeaseToken: string): string {
  return sha256Utf8(leaseToken(rawLeaseToken));
}

// --- Output frames (secret-free outbox payloads) ----------------------------

export interface RemoteWorkerInferenceOutputTextPayload {
  readonly schemaVersion: typeof REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION;
  readonly kind: "output_text";
  readonly text: string;
}

export interface RemoteWorkerInferenceTerminalPayload {
  readonly schemaVersion: typeof REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION;
  readonly kind: "terminal";
  readonly terminalState: RemoteWorkerInferenceTerminalState;
  readonly usageEventId?: string;
}

export type RemoteWorkerInferenceFramePayload =
  | RemoteWorkerInferenceOutputTextPayload
  | RemoteWorkerInferenceTerminalPayload;

export function normalizeRemoteWorkerInferenceFramePayload(
  input: RemoteWorkerInferenceFramePayload,
): RemoteWorkerInferenceFramePayload {
  assertRecord(input, "inference frame payload");
  if (input.schemaVersion !== REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION) {
    throw new TypeError("Remote worker inference frame payload schema version is unsupported.");
  }
  enumValue(input.kind, REMOTE_WORKER_INFERENCE_FRAME_KINDS, "inference frame kind");
  if (input.kind === "output_text") {
    assertExactKeys(input, ["schemaVersion", "kind", "text"], "inference output_text frame");
    return Object.freeze({
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "output_text",
      text: boundedText(input.text, "inference frame text", REMOTE_WORKER_INFERENCE_MAX_FRAME_TEXT_CHARS),
    });
  }
  assertExactKeys(input, ["schemaVersion", "kind", "terminalState", "usageEventId"], "inference terminal frame", [
    "usageEventId",
  ]);
  enumValue(input.terminalState, REMOTE_WORKER_INFERENCE_TERMINAL_STATES, "inference terminal frame terminalState");
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
    kind: "terminal",
    terminalState: input.terminalState,
    ...(input.usageEventId === undefined ? {} : { usageEventId: identifier(input.usageEventId, "usageEventId") }),
  });
}

export function remoteWorkerInferenceFramePayloadSha256(input: RemoteWorkerInferenceFramePayload): string {
  return remoteWorkerInferenceCanonicalSha256(normalizeRemoteWorkerInferenceFramePayload(input));
}

export interface RemoteWorkerInferenceFrameHashInput {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly frameSequence: number;
  readonly frameKind: RemoteWorkerInferenceFrameKind;
  readonly payloadSha256: string;
  readonly previousFrameSha256: string;
  readonly effectiveRouteSha256: string;
}

export function remoteWorkerInferenceFrameHashMaterial(input: RemoteWorkerInferenceFrameHashInput): object {
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    inferenceRequestId: identifier(input.inferenceRequestId, "inferenceRequestId"),
    attempt: positiveInteger(input.attempt, "attempt"),
    frameSequence: positiveInteger(input.frameSequence, "frameSequence", REMOTE_WORKER_INFERENCE_MAX_FRAMES),
    frameKind: assertFrameKind(input.frameKind),
    payloadSha256: digest(input.payloadSha256, "payloadSha256"),
    previousFrameSha256: digest(input.previousFrameSha256, "previousFrameSha256"),
    effectiveRouteSha256: digest(input.effectiveRouteSha256, "effectiveRouteSha256"),
  });
}

export function remoteWorkerInferenceFrameSha256(input: RemoteWorkerInferenceFrameHashInput): string {
  return remoteWorkerInferenceCanonicalSha256(remoteWorkerInferenceFrameHashMaterial(input));
}

// --- Governance + budget receipts (mandatory injected owners) ---------------

export interface RemoteWorkerInferenceGovernanceReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION;
  readonly decision: RemoteWorkerInferenceGovernanceDecision;
  readonly effectiveRouteSha256: string;
  readonly policyRevision: number;
  readonly policySha256: string;
  readonly approvalReceiptSha256?: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly expiresAt: string;
}

const GOVERNANCE_KEYS = [
  "schemaVersion",
  "decision",
  "effectiveRouteSha256",
  "policyRevision",
  "policySha256",
  "approvalReceiptSha256",
  "outputTokenCeiling",
  "reasoningTokenCeiling",
  "expiresAt",
] as const;

export function normalizeRemoteWorkerInferenceGovernanceReceipt(
  input: RemoteWorkerInferenceGovernanceReceipt,
): RemoteWorkerInferenceGovernanceReceipt {
  assertRecord(input, "inference governance receipt");
  assertExactKeys(input, [...GOVERNANCE_KEYS], "inference governance receipt", ["approvalReceiptSha256"]);
  if (input.schemaVersion !== REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION) {
    throw new TypeError("Remote worker inference governance receipt schema version is unsupported.");
  }
  enumValue(input.decision, REMOTE_WORKER_INFERENCE_GOVERNANCE_DECISIONS, "inference governance decision");
  if ((input.decision === "approval_required") !== (input.approvalReceiptSha256 !== undefined)) {
    throw new TypeError(
      "Remote worker inference approval receipt must accompany exactly an approval_required decision.",
    );
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision: input.decision,
    effectiveRouteSha256: digest(input.effectiveRouteSha256, "effectiveRouteSha256"),
    policyRevision: positiveInteger(input.policyRevision, "policyRevision"),
    policySha256: digest(input.policySha256, "policySha256"),
    ...(input.approvalReceiptSha256 === undefined
      ? {}
      : { approvalReceiptSha256: digest(input.approvalReceiptSha256, "approvalReceiptSha256") }),
    outputTokenCeiling: positiveInteger(
      input.outputTokenCeiling,
      "outputTokenCeiling",
      REMOTE_WORKER_INFERENCE_MAX_OUTPUT_TOKEN_CEILING,
    ),
    reasoningTokenCeiling: nonNegativeInteger(
      input.reasoningTokenCeiling,
      "reasoningTokenCeiling",
      REMOTE_WORKER_INFERENCE_MAX_REASONING_TOKEN_CEILING,
    ),
    expiresAt: isoTimestamp(input.expiresAt, "expiresAt"),
  });
}

export interface RemoteWorkerInferenceBudgetReservation {
  readonly schemaVersion: typeof REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION;
  readonly reservationId: string;
  readonly reservedOutputTokens: number;
  readonly expiresAt: string;
}

export function normalizeRemoteWorkerInferenceBudgetReservation(
  input: RemoteWorkerInferenceBudgetReservation,
): RemoteWorkerInferenceBudgetReservation {
  assertRecord(input, "inference budget reservation");
  assertExactKeys(
    input,
    ["schemaVersion", "reservationId", "reservedOutputTokens", "expiresAt"],
    "inference budget reservation",
  );
  if (input.schemaVersion !== REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION) {
    throw new TypeError("Remote worker inference budget reservation schema version is unsupported.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
    reservationId: boundedIdentifier(input.reservationId, "reservationId", 256),
    reservedOutputTokens: positiveInteger(
      input.reservedOutputTokens,
      "reservedOutputTokens",
      REMOTE_WORKER_INFERENCE_MAX_OUTPUT_TOKEN_CEILING,
    ),
    expiresAt: isoTimestamp(input.expiresAt, "expiresAt"),
  });
}

export function remoteWorkerInferenceCanonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalJsonString(value));
}

// --- Local validation helpers (browser-safe, dependency-free) ---------------

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Remote worker inference ${field} must be an object.`);
  }
}

function assertExactKeys(value: object, allowed: string[], field: string, optional: string[] = []): void {
  const keys = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`Remote worker inference ${field} contains unknown fields.`);
  }
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`Remote worker inference ${field} is missing required fields.`);
  }
}

function identifier(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker inference ${field} is invalid.`);
  }
  return value;
}

function boundedIdentifier(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Remote worker inference ${field} is invalid.`);
  }
  return value;
}

function leaseToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /\p{Cc}/u.test(value)) {
    throw new TypeError("Remote worker inference lease token is invalid.");
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.length < 1 || value.length > max) {
    throw new TypeError(`Remote worker inference ${field} is invalid.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker inference ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`Remote worker inference ${field} must be a bounded positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`Remote worker inference ${field} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Remote worker inference ${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`Remote worker inference ${field} is unsupported.`);
  }
}

function assertFrameKind(value: unknown): RemoteWorkerInferenceFrameKind {
  enumValue(value, REMOTE_WORKER_INFERENCE_FRAME_KINDS, "frame kind");
  return value;
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function sha256Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = schedule[index - 15]!;
      const y = schedule[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + upper + choice + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const lower = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { projectPublicSecretValue } from "./public-secret-projection.js";

/**
 * Citadel Ward `require_approval` effects on integration actions, A2A outbound sends and
 * A2A push deliveries become operator approvals. The approval payload carries the exact
 * request plus a `payloadHash` over it; the executor re-reads the payload, recomputes the
 * hash, re-checks the ward and only then performs the action once.
 */
export const CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND = "citadel_ward.integration_action";
export const CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND = "citadel_ward.a2a_outbound";
export const CITADEL_WARD_A2A_PUSH_APPROVAL_KIND = "citadel_ward.a2a_push";

export type CitadelWardApprovalKind =
  | typeof CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_PUSH_APPROVAL_KIND;

export interface CitadelWardApprovalPayload<TRequest extends Record<string, unknown> = Record<string, unknown>> {
  wardAction: string;
  citadelId: string;
  workspaceId?: string;
  payloadHash: string;
  request: TRequest;
}

export interface CitadelWardApprovalRef {
  approvalId: string;
  wardAction: string;
}

const REPLAY_IDEMPOTENCY_PREFIX = "citadel-ward:";
const WARD_KINDS: readonly string[] = [
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
];

/** SHA-256 hex of the canonical (key-sorted) JSON of the request. */
export function computeCitadelWardPayloadHash(request: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJsonString(request)).digest("hex");
}

export function buildCitadelWardApprovalPayload<T extends Record<string, unknown>>(
  input: Omit<CitadelWardApprovalPayload<T>, "payloadHash">,
): CitadelWardApprovalPayload<T> {
  return { ...input, payloadHash: computeCitadelWardPayloadHash(input.request) };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the payload when well formed, otherwise undefined. Does not verify the hash. */
export function readCitadelWardApprovalPayload(payload: unknown): CitadelWardApprovalPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const { wardAction, citadelId, workspaceId, payloadHash, request } = payload as Record<string, unknown>;
  if (!nonBlank(wardAction) || !nonBlank(citadelId) || !nonBlank(payloadHash)) {
    return undefined;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  if (workspaceId !== undefined && !nonBlank(workspaceId)) {
    return undefined;
  }
  return {
    wardAction,
    citadelId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    payloadHash,
    request: request as Record<string, unknown>,
  };
}

/**
 * The key an approved replay runs under: the original request's own idempotency key when it
 * carried one (so a client retry that opened a second approval still executes once), otherwise
 * `citadel-ward:<approvalId>`.
 */
export function citadelWardReplayIdempotencyKey(approvalId: string, requestIdempotencyKey?: unknown): string {
  return typeof requestIdempotencyKey === "string" && requestIdempotencyKey.trim()
    ? requestIdempotencyKey
    : `${REPLAY_IDEMPOTENCY_PREFIX}${approvalId}`;
}

/** One labelled line of the bounded, redacted request summary a ward approval's preview carries. */
export interface CitadelWardRequestSummaryEntry {
  label: string;
  value: string;
}

const SUMMARY_VALUE_MAX_CHARS = 200;
const SUMMARY_MAX_ENTRIES = 20;
const SUMMARY_REDACTED = "[REDACTED]";
const SECRET_LOOKING_KEY =
  /token|secret|passw(?:or)?d|authorization|credential|cookie|api[-_]?key|private[-_]?key|access[-_]?key|^key$/i;

function redactSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_LOOKING_KEY.test(key) ? SUMMARY_REDACTED : redactSecretKeys(item),
    ]),
  );
}

/** Redacts secret-looking keys (and secret-shaped values), renders as text and truncates. */
function summarizeValue(value: unknown): string {
  const projected = projectPublicSecretValue(redactSecretKeys(value));
  const text = typeof projected === "string" ? projected : (JSON.stringify(projected) ?? String(projected));
  return text.length > SUMMARY_VALUE_MAX_CHARS ? `${text.slice(0, SUMMARY_VALUE_MAX_CHARS - 1)}…` : text;
}

/**
 * Builds the inbox summary of what a ward approval would execute. It is display-only: the
 * executor never reads it (it replays the hash-bound payload). Undefined fields are dropped,
 * values are redacted and truncated, and the entry count is bounded.
 */
export function buildCitadelWardRequestSummary(
  fields: ReadonlyArray<readonly [label: string, value: unknown]>,
): CitadelWardRequestSummaryEntry[] {
  const present = fields.filter(([, value]) => value !== undefined);
  const entries = present.slice(0, SUMMARY_MAX_ENTRIES).map(([label, value]) => ({
    label,
    value: SECRET_LOOKING_KEY.test(label) ? SUMMARY_REDACTED : summarizeValue(value),
  }));
  const omitted = present.length - entries.length;
  return omitted > 0 ? [...entries, { label: "More fields", value: `${omitted} not shown` }] : entries;
}

/** Summary fields for a request input object: one `Input <key>` line per top-level field. */
export function citadelWardInputSummaryFields(input: Record<string, unknown>): Array<readonly [string, unknown]> {
  return Object.entries(input).map(([key, value]) => [
    `Input ${key}`,
    SECRET_LOOKING_KEY.test(key) ? SUMMARY_REDACTED : value,
  ]);
}

/** The origin of a push URL (never its path, query or credentials). */
export function citadelWardUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unparseable URL";
  }
}

export function isCitadelWardApprovalKind(kind: string): kind is CitadelWardApprovalKind {
  return WARD_KINDS.includes(kind);
}

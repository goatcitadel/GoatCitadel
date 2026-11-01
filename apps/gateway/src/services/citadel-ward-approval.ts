import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { openReplayEnvelope, sealReplayEnvelope, type ReplayEnvelope } from "./external-side-effect-replay-record.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

/**
 * Citadel Ward `require_approval` effects on integration actions, A2A outbound sends and
 * A2A push deliveries become operator approvals. The approval payload binds the exact request
 * by a `payloadHash` over it; the executor recovers the request, recomputes the hash, re-checks
 * the ward and only then performs the action once.
 *
 * Integration and outbound requests can carry secrets (action input, call params), and
 * approvals are ordinary durable records returned by the approval APIs, so those requests are
 * stored only as `sealedRequest`: an AES-256-GCM envelope under the external side-effect replay
 * key, bound to the approval kind and payload hash. A push request names only the task, peer,
 * event and a URL hash, so it stays plaintext and its refusal can always be recorded.
 */
export const CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND = "citadel_ward.integration_action";
export const CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND = "citadel_ward.a2a_outbound";
export const CITADEL_WARD_A2A_PUSH_APPROVAL_KIND = "citadel_ward.a2a_push";

export type CitadelWardApprovalKind =
  | typeof CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND
  | typeof CITADEL_WARD_A2A_PUSH_APPROVAL_KIND;

interface CitadelWardApprovalBinding {
  wardAction: string;
  citadelId: string;
  workspaceId?: string;
  payloadHash: string;
}

/** Integration and outbound approvals: the request exists only inside the sealed envelope. */
export interface CitadelWardSealedApprovalPayload extends CitadelWardApprovalBinding {
  sealedRequest: ReplayEnvelope;
}

/** Push approvals: the request holds no secrets and stays readable. */
export interface CitadelWardPlainApprovalPayload<
  TRequest extends Record<string, unknown> = Record<string, unknown>,
> extends CitadelWardApprovalBinding {
  request: TRequest;
}

export type CitadelWardApprovalPayload = CitadelWardSealedApprovalPayload | CitadelWardPlainApprovalPayload;

export interface CitadelWardApprovalPayloadInput<TRequest extends Record<string, unknown> = Record<string, unknown>> {
  wardAction: string;
  citadelId: string;
  workspaceId?: string;
  request: TRequest;
}

export interface CitadelWardApprovalRef {
  approvalId: string;
  wardAction: string;
}

const REPLAY_IDEMPOTENCY_PREFIX = "citadel-ward:";
const SEAL_AAD_PREFIX = "goatcitadel:citadel-ward-approval:v1";
const WARD_KINDS: readonly string[] = [
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
];

/** SHA-256 hex of the canonical (key-sorted) JSON of the request. */
export function computeCitadelWardPayloadHash(request: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJsonString(request)).digest("hex");
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function bindingFor(input: CitadelWardApprovalPayloadInput): CitadelWardApprovalBinding {
  return {
    wardAction: input.wardAction,
    citadelId: input.citadelId,
    ...(nonBlank(input.workspaceId) ? { workspaceId: input.workspaceId } : {}),
    payloadHash: computeCitadelWardPayloadHash(input.request),
  };
}

/** Whether approvals of this kind must carry their request sealed (every kind but push). */
export function citadelWardKindSealsRequest(kind: string): boolean {
  return kind !== CITADEL_WARD_A2A_PUSH_APPROVAL_KIND;
}

/** The plaintext payload of a push approval. */
export function buildCitadelWardApprovalPayload<T extends Record<string, unknown>>(
  input: CitadelWardApprovalPayloadInput<T>,
): CitadelWardPlainApprovalPayload<T> {
  return { ...bindingFor(input), request: input.request };
}

function sealAad(kind: string, payloadHash: string): string {
  return `${SEAL_AAD_PREFIX}\0${kind}\0${payloadHash}`;
}

/** Seals the request under `key`, bound to the approval kind and payload hash. */
export function sealCitadelWardApprovalPayload(
  key: Buffer,
  kind: string,
  input: CitadelWardApprovalPayloadInput,
): CitadelWardSealedApprovalPayload {
  const binding = bindingFor(input);
  return { ...binding, sealedRequest: sealReplayEnvelope(key, sealAad(kind, binding.payloadHash), input.request) };
}

/** The sealed request, or undefined when the envelope does not open under `key` for this kind and hash. */
export function openCitadelWardApprovalRequest(
  key: Buffer,
  kind: string,
  payload: CitadelWardSealedApprovalPayload,
): Record<string, unknown> | undefined {
  const opened = openReplayEnvelope(key, sealAad(kind, payload.payloadHash), payload.sealedRequest);
  const request = opened?.payload;
  return request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>)
    : undefined;
}

/**
 * The key store (or its sealed-record guard) threw while opening a ward request. This is
 * transient infrastructure, not a refusal: the approval effect retries rather than failing.
 */
export class CitadelWardRequestVaultUnavailableError extends Error {
  public constructor(cause: unknown) {
    super("The Citadel Ward request key store is unavailable; the sealed request was not opened.", { cause });
    this.name = "CitadelWardRequestVaultUnavailableError";
  }
}

/**
 * Seals and opens ward approval requests under the shared external side-effect replay key.
 * Without a key (no keychain, unsafe write custody, a lookup miss) or on any cipher failure,
 * `seal` and `open` return undefined, and callers fail closed. `seal` never throws; `open`
 * throws `CitadelWardRequestVaultUnavailableError` only when resolving the key throws.
 */
export interface CitadelWardRequestVault {
  seal(kind: string, input: CitadelWardApprovalPayloadInput): Promise<CitadelWardSealedApprovalPayload | undefined>;
  open(kind: string, payload: CitadelWardSealedApprovalPayload): Promise<Record<string, unknown> | undefined>;
}

export function createCitadelWardRequestVault(
  resolveKey: () => Buffer | undefined | Promise<Buffer | undefined>,
): CitadelWardRequestVault {
  return {
    seal: async (kind, input) => {
      try {
        const key = await resolveKey();
        return key ? sealCitadelWardApprovalPayload(key, kind, input) : undefined;
      } catch {
        return undefined;
      }
    },
    open: async (kind, payload) => {
      let key: Buffer | undefined;
      try {
        key = await resolveKey();
      } catch (error) {
        throw new CitadelWardRequestVaultUnavailableError(error);
      }
      return key ? openCitadelWardApprovalRequest(key, kind, payload) : undefined;
    },
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

/** Replaces every secret-looking key's value with its SHA-256, recursively. */
function hashSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hashSecretValues);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_LOOKING_KEY.test(key) ? hashJson(item ?? null) : hashSecretValues(item),
    ]),
  );
}

/**
 * SHA-256 of the canonical JSON of an integration action's effective target: the catalog, the
 * action and the connection config (where every destination, such as an Activepieces
 * `webhookUrl` or a bridge URL, lives), with secret-looking values replaced by their own hash.
 * An approval binds it so a replay never reaches a target the operator did not approve.
 */
export function computeCitadelWardIntegrationTargetFingerprint(
  connection: { catalogId: string; config: Record<string, unknown> },
  actionId: string,
): string {
  return hashJson({ catalogId: connection.catalogId, actionId, config: hashSecretValues(connection.config) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns the payload when well formed for `kind`, otherwise undefined: a push approval must
 * carry its plaintext `request`, every other kind only a `sealedRequest` (a plaintext request is
 * refused). Neither opens the envelope nor verifies the hash.
 */
export function readCitadelWardApprovalPayload(kind: string, payload: unknown): CitadelWardApprovalPayload | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const { wardAction, citadelId, workspaceId, payloadHash, request, sealedRequest } = payload;
  if (!nonBlank(wardAction) || !nonBlank(citadelId) || !nonBlank(payloadHash)) {
    return undefined;
  }
  if (workspaceId !== undefined && !nonBlank(workspaceId)) {
    return undefined;
  }
  const binding = { wardAction, citadelId, ...(workspaceId !== undefined ? { workspaceId } : {}), payloadHash };
  if (citadelWardKindSealsRequest(kind)) {
    return request === undefined && isRecord(sealedRequest)
      ? { ...binding, sealedRequest: sealedRequest as unknown as ReplayEnvelope }
      : undefined;
  }
  return sealedRequest === undefined && isRecord(request) ? { ...binding, request } : undefined;
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

/**
 * Whether a push approval was opened for this push config: a config deleted and set again gets a
 * new `createdAt`, so an approval of the old one cannot settle it. An approval opened before its
 * request recorded `configCreatedAt` matches any config.
 */
export function isCitadelWardApprovedPushConfig(
  config: { createdAt: string },
  configCreatedAt: string | undefined,
): boolean {
  return configCreatedAt === undefined || config.createdAt === configCreatedAt;
}

export function isCitadelWardApprovalKind(kind: string): kind is CitadelWardApprovalKind {
  return WARD_KINDS.includes(kind);
}

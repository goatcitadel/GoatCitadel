import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

const UTF8 = new TextEncoder();

function sha256Utf8(value: string): string {
  return sha256Hex(value);
}

/**
 * HX-506 remote-worker settlement contract (production-dark).
 *
 * The Gateway owns remote-worker upload parts, immutable artifact manifests,
 * Gateway-trusted verification evidence, remote effect intents, and exact
 * correlations to canonical effect outcomes for ONE assignment generation.
 *
 * It CONSUMES (never recreates): HX-501 admitted identity, HX-502 assignment/
 * lease/settlement authority, HX-504 ordered events, HX-505 capacity/staging/
 * cleanup, HX-305 canonical tool/effect outcome truth, HX-306 usage/cost, and
 * HX-411 session-control generation. Workers never become artifact, verifier,
 * policy, approval, effect, usage, session, or settlement authorities. A stale
 * worker may read an exact committed receipt but cannot append a part, commit a
 * manifest, satisfy verification, dispatch an effect, mutate Chat, or settle an
 * assignment.
 *
 * Every hash preimage here is a canonical JSON object; this module never writes
 * a raw byte separator into a hash preimage.
 */

export const REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION = "goatcitadel.remote-worker-artifact-manifest.v1" as const;
export const REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA_VERSION = "goatcitadel.remote-worker-artifact-upload.v1" as const;
export const REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-verification-evidence.v1" as const;
export const REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION = "goatcitadel.remote-worker-effect-intent.v1" as const;
export const REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-effect-correlation.v1" as const;

export const REMOTE_WORKER_SETTLEMENT_GENESIS_SHA256 = "0".repeat(64);

// --- Frozen bounds (packet) -------------------------------------------------

export const REMOTE_WORKER_SETTLEMENT_BOUNDS = Object.freeze({
  /** one active upload and at most four upload attempts per assignment generation */
  maxUploadAttempts: 4,
  /** at most 64 files and 64 MiB total (further capped by assignment maxArtifactBytes) */
  maxFiles: 64,
  maxTotalBytes: 67_108_864,
  /** 256 KiB maximum raw part; non-final parts are exactly this size */
  maxPartBytes: 262_144,
  minFinalPartBytes: 1,
  /** at most 320 parts in one global contiguous sequence */
  maxParts: 320,
  /** canonical unpadded base64url part body ceiling (below the 512 KiB PoP body ceiling) */
  maxPartBodyBytes: 524_288,
  /** 64 KiB maximum canonical manifest JSON */
  maxManifestJsonBytes: 65_536,
  /** logical path bounds */
  maxLogicalPathBytes: 512,
  maxLogicalPathSegments: 32,
  maxLogicalSegmentBytes: 128,
  /** MIME at most 128 ASCII bytes without parameters */
  maxMimeBytes: 128,
  /** at most 16 worker claims and 16 Gateway verification attempts per manifest */
  maxWorkerClaims: 16,
  maxGatewayVerificationAttempts: 16,
  maxVerificationEvidenceJsonBytes: 16_384,
  maxVerificationSummaryBytes: 4_096,
  /** 15-minute maximum trusted-verifier wall time and 8 MiB combined captured output */
  maxVerifierWallMs: 900_000,
  maxVerifierCapturedOutputBytes: 8_388_608,
  /** at most 64 effect intents per assignment generation */
  maxEffectIntents: 64,
  maxEffectArgsBytes: 65_536,
  maxEffectTransitions: 16,
  maxProvenPreBoundaryAttempts: 3,
  maxHx305EvidenceReferences: 8,
  maxSanitizedErrorBytes: 2_048,
  maxEffectCorrelationJsonBytes: 16_384,
  /** upload expiry window and cleanup claim */
  uploadExpiryWindowSeconds: 900,
  cleanupClaimSeconds: 300,
  /** effect/tool selector bound */
  maxEffectSelectorBytes: 256,
} as const);

// --- Upload state machine ---------------------------------------------------

export const REMOTE_WORKER_UPLOAD_STATES = ["open", "assembling", "committed", "abandoned", "quarantined"] as const;
export type RemoteWorkerUploadState = (typeof REMOTE_WORKER_UPLOAD_STATES)[number];

const UPLOAD_TRANSITIONS: Readonly<Record<RemoteWorkerUploadState, readonly RemoteWorkerUploadState[]>> = {
  open: ["assembling", "committed", "abandoned", "quarantined"],
  assembling: ["committed", "abandoned", "quarantined"],
  committed: [],
  abandoned: [],
  quarantined: [],
};

export function remoteWorkerUploadCanTransition(from: RemoteWorkerUploadState, to: RemoteWorkerUploadState): boolean {
  return (UPLOAD_TRANSITIONS[from] ?? []).includes(to);
}

export const REMOTE_WORKER_UPLOAD_TERMINAL_STATES: readonly RemoteWorkerUploadState[] = [
  "committed",
  "abandoned",
  "quarantined",
];

// --- Cleanup state machine --------------------------------------------------

export const REMOTE_WORKER_CLEANUP_STATES = ["not_due", "pending", "cleaned", "manual_reconciliation"] as const;
export type RemoteWorkerCleanupState = (typeof REMOTE_WORKER_CLEANUP_STATES)[number];

const CLEANUP_TRANSITIONS: Readonly<Record<RemoteWorkerCleanupState, readonly RemoteWorkerCleanupState[]>> = {
  not_due: ["pending"],
  pending: ["cleaned", "manual_reconciliation"],
  cleaned: [],
  manual_reconciliation: [],
};

export function remoteWorkerCleanupCanTransition(
  from: RemoteWorkerCleanupState,
  to: RemoteWorkerCleanupState,
): boolean {
  return (CLEANUP_TRANSITIONS[from] ?? []).includes(to);
}

// --- Verification attempt state machine -------------------------------------

export const REMOTE_WORKER_VERIFICATION_KINDS = ["worker_claim", "gateway_attempt"] as const;
export type RemoteWorkerVerificationKind = (typeof REMOTE_WORKER_VERIFICATION_KINDS)[number];

export const REMOTE_WORKER_VERIFICATION_ATTEMPT_STATES = [
  "worker_reported",
  "queued",
  "running",
  "passed",
  "failed",
  "indeterminate",
  "blocked",
] as const;
export type RemoteWorkerVerificationAttemptState = (typeof REMOTE_WORKER_VERIFICATION_ATTEMPT_STATES)[number];

const VERIFICATION_ATTEMPT_TRANSITIONS: Readonly<
  Record<RemoteWorkerVerificationAttemptState, readonly RemoteWorkerVerificationAttemptState[]>
> = {
  worker_reported: [],
  queued: ["running", "blocked"],
  running: ["passed", "failed", "indeterminate", "blocked"],
  passed: [],
  failed: [],
  indeterminate: [],
  blocked: [],
};

export function remoteWorkerVerificationAttemptCanTransition(
  from: RemoteWorkerVerificationAttemptState,
  to: RemoteWorkerVerificationAttemptState,
): boolean {
  return (VERIFICATION_ATTEMPT_TRANSITIONS[from] ?? []).includes(to);
}

/** Only a passed Gateway attempt may satisfy the gate; a worker claim never does. */
export function remoteWorkerVerificationAttemptSatisfiesGate(
  kind: RemoteWorkerVerificationKind,
  state: RemoteWorkerVerificationAttemptState,
): boolean {
  return kind === "gateway_attempt" && state === "passed";
}

// --- Verification gate ------------------------------------------------------

export const REMOTE_WORKER_VERIFICATION_GATE_STATES = ["not_required", "pending", "satisfied"] as const;
export type RemoteWorkerVerificationGateState = (typeof REMOTE_WORKER_VERIFICATION_GATE_STATES)[number];

/** Settlement with an output manifest allows only a resolved verification gate. */
export function remoteWorkerVerificationGateAllowsSettlement(state: RemoteWorkerVerificationGateState): boolean {
  return state === "not_required" || state === "satisfied";
}

// --- Effect transition / receipt state machines -----------------------------

export const REMOTE_WORKER_EFFECT_TRANSITION_STATES = [
  "recorded",
  "approval_wait",
  "dispatch_claimed",
  "external_boundary_started",
  "blocked_before_dispatch",
  "failed_before_boundary",
  "completed_no_effect",
  "completed_with_effect",
  "manual_reconciliation",
  "manual_reconciliation_resolved",
] as const;
export type RemoteWorkerEffectTransitionState = (typeof REMOTE_WORKER_EFFECT_TRANSITION_STATES)[number];

const EFFECT_TRANSITIONS: Readonly<
  Record<RemoteWorkerEffectTransitionState, readonly RemoteWorkerEffectTransitionState[]>
> = {
  recorded: ["approval_wait", "dispatch_claimed", "blocked_before_dispatch", "failed_before_boundary"],
  approval_wait: ["dispatch_claimed", "blocked_before_dispatch", "failed_before_boundary"],
  dispatch_claimed: [
    "external_boundary_started",
    "blocked_before_dispatch",
    "failed_before_boundary",
    "manual_reconciliation",
  ],
  external_boundary_started: ["completed_no_effect", "completed_with_effect", "manual_reconciliation"],
  blocked_before_dispatch: [],
  failed_before_boundary: [],
  completed_no_effect: [],
  completed_with_effect: [],
  manual_reconciliation: ["manual_reconciliation_resolved"],
  manual_reconciliation_resolved: [],
};

export function remoteWorkerEffectCanTransition(
  from: RemoteWorkerEffectTransitionState,
  to: RemoteWorkerEffectTransitionState,
): boolean {
  return (EFFECT_TRANSITIONS[from] ?? []).includes(to);
}

/** Terminal transition states that may back a durable receipt. */
export const REMOTE_WORKER_EFFECT_RECEIPT_STATES = [
  "blocked_before_dispatch",
  "failed_before_boundary",
  "completed_no_effect",
  "completed_with_effect",
  "manual_reconciliation",
] as const;
export type RemoteWorkerEffectReceiptState = (typeof REMOTE_WORKER_EFFECT_RECEIPT_STATES)[number];

/** A crossed boundary that lost authority becomes manual reconciliation, never a silent retry. */
export function remoteWorkerEffectReceiptIsManual(state: RemoteWorkerEffectReceiptState): boolean {
  return state === "manual_reconciliation";
}

export function remoteWorkerEffectReceiptAllowsSettlement(state: RemoteWorkerEffectReceiptState): boolean {
  return state !== "manual_reconciliation";
}

// --- Physical publication path (server-derived only) ------------------------

/**
 * Server-derived physical CAS address. Worker logical paths never become
 * filesystem paths: only server-derived workspace and content hashes appear.
 *
 *   remote-workers/artifacts/<sha256(workspace)>/sha256/<prefix>/<blobSha256>
 */
export const REMOTE_WORKER_ARTIFACT_PATH_PREFIX = "remote-workers/artifacts";

export function remoteWorkerArtifactWorkspaceShard(executionWorkspaceId: string): string {
  return sha256Utf8(
    canonicalJsonString({ executionWorkspaceId: identifier(executionWorkspaceId, "executionWorkspaceId") }),
  );
}

export function remoteWorkerArtifactBlobRelPath(workspaceShardSha256: string, blobSha256: string): string {
  const shard = digest(workspaceShardSha256, "workspaceShardSha256");
  const blob = digest(blobSha256, "blobSha256");
  return `${REMOTE_WORKER_ARTIFACT_PATH_PREFIX}/${shard}/sha256/${blob.slice(0, 2)}/${blob}`;
}

export function remoteWorkerArtifactStagingRelPath(input: {
  workspaceShardSha256: string;
  uploadStagingSha256: string;
  globalSequence: number;
}): string {
  const shard = digest(input.workspaceShardSha256, "workspaceShardSha256");
  const staging = digest(input.uploadStagingSha256, "uploadStagingSha256");
  const sequence = positiveInteger(input.globalSequence, "globalSequence", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxParts);
  return `${REMOTE_WORKER_ARTIFACT_PATH_PREFIX}/${shard}/staging/${staging}/${String(sequence).padStart(4, "0")}`;
}

// --- Logical path validation ------------------------------------------------

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function isValidRemoteWorkerLogicalPath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (candidate !== candidate.normalize("NFKC")) return false;
  if (utf8ByteLength(candidate) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxLogicalPathBytes) return false;
  if (/\p{Cc}/u.test(candidate)) return false;
  if (candidate.includes("\\") || candidate.includes(":")) return false;
  if (candidate.startsWith("/")) return false;
  if (candidate.startsWith("//") || candidate.startsWith("\\\\")) return false;
  const segments = candidate.split("/");
  if (segments.length < 1 || segments.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxLogicalPathSegments) return false;
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (utf8ByteLength(segment) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxLogicalSegmentBytes) return false;
    if (segment === "." || segment === "..") return false;
    if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) return false;
    const base = (segment.split(".")[0] ?? "").toLowerCase();
    if (WINDOWS_RESERVED.has(base) || WINDOWS_RESERVED.has(segment.toLowerCase())) return false;
  }
  return true;
}

export function assertRemoteWorkerLogicalPath(candidate: unknown, field = "logicalPath"): string {
  if (!isValidRemoteWorkerLogicalPath(candidate)) {
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return candidate;
}

/** NFKC-lowercase collision key; two paths sharing it cannot coexist in one manifest. */
export function remoteWorkerLogicalPathCollisionKey(candidate: string): string {
  return assertRemoteWorkerLogicalPath(candidate).normalize("NFKC").toLowerCase();
}

// --- MIME validation --------------------------------------------------------

const FORBIDDEN_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

export function isValidRemoteWorkerMime(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (candidate.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxMimeBytes) return false;
  if (!/^[\x20-\x7e]+$/u.test(candidate)) return false;
  if (candidate !== candidate.toLowerCase()) return false;
  if (candidate.includes(";") || candidate.includes(" ")) return false;
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(candidate)) return false;
  if (FORBIDDEN_MIME.has(candidate)) return false;
  return true;
}

export function assertRemoteWorkerMime(candidate: unknown, field = "mimeType"): string {
  if (!isValidRemoteWorkerMime(candidate)) {
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return candidate;
}

// --- Full-identity binding --------------------------------------------------

export interface RemoteWorkerSettlementIdentity {
  registryWorkspaceId: string;
  executionWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  workerId: string;
  workerGeneration: number;
  runtimeManifestSha256: string;
  workspaceCeilingSha256: string;
  capabilityCeilingSha256: string;
  assignmentManifestSha256: string;
}

export function normalizeRemoteWorkerSettlementIdentity(
  input: RemoteWorkerSettlementIdentity,
): RemoteWorkerSettlementIdentity {
  assertRecord(input, "identity");
  assertExactKeys(
    input,
    [
      "registryWorkspaceId",
      "executionWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "workerId",
      "workerGeneration",
      "runtimeManifestSha256",
      "workspaceCeilingSha256",
      "capabilityCeilingSha256",
      "assignmentManifestSha256",
    ],
    "identity",
  );
  return Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    executionWorkspaceId: identifier(input.executionWorkspaceId, "executionWorkspaceId"),
    assignmentId: identifier(input.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(input.assignmentGeneration, "assignmentGeneration"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "workerGeneration"),
    runtimeManifestSha256: digest(input.runtimeManifestSha256, "runtimeManifestSha256"),
    workspaceCeilingSha256: digest(input.workspaceCeilingSha256, "workspaceCeilingSha256"),
    capabilityCeilingSha256: digest(input.capabilityCeilingSha256, "capabilityCeilingSha256"),
    assignmentManifestSha256: digest(input.assignmentManifestSha256, "assignmentManifestSha256"),
  });
}

// --- Manifest -------------------------------------------------------------

export interface RemoteWorkerArtifactManifestEntry {
  entryIndex: number;
  logicalPath: string;
  logicalPathSha256: string;
  blobSha256: string;
  byteCount: number;
  mimeType: string;
}

export interface RemoteWorkerArtifactManifest {
  schemaVersion: typeof REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  identity: RemoteWorkerSettlementIdentity;
  pathJailSha256: string;
  workerClaimIds: readonly string[];
  workerClaimSha256: string;
  requiredVerifierProfileSha256: string | null;
  fileCount: number;
  totalBytes: number;
  entries: readonly RemoteWorkerArtifactManifestEntry[];
}

export function normalizeRemoteWorkerArtifactManifest(
  input: RemoteWorkerArtifactManifest,
): RemoteWorkerArtifactManifest {
  assertRecord(input, "manifest");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "identity",
      "pathJailSha256",
      "workerClaimIds",
      "workerClaimSha256",
      "requiredVerifierProfileSha256",
      "fileCount",
      "totalBytes",
      "entries",
    ],
    "manifest",
  );
  if (input.schemaVersion !== REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError("Remote worker artifact manifest schemaVersion is invalid.");
  }
  const identity = normalizeRemoteWorkerSettlementIdentity(input.identity);
  if (!Array.isArray(input.entries)) throw new TypeError("Remote worker artifact manifest entries must be an array.");
  if (input.entries.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles) {
    throw new TypeError("Remote worker artifact manifest exceeds the file bound.");
  }
  const collisionKeys = new Set<string>();
  const blobKeys = new Set<string>();
  let total = 0;
  const entries = input.entries.map((entry, index) => {
    assertRecord(entry, "manifest entry");
    assertExactKeys(
      entry,
      ["entryIndex", "logicalPath", "logicalPathSha256", "blobSha256", "byteCount", "mimeType"],
      "manifest entry",
    );
    if (entry.entryIndex !== index) throw new TypeError("Remote worker artifact manifest entry index is out of order.");
    const logicalPath = assertRemoteWorkerLogicalPath(entry.logicalPath);
    const collisionKey = remoteWorkerLogicalPathCollisionKey(logicalPath);
    if (collisionKeys.has(collisionKey)) {
      throw new TypeError("Remote worker artifact manifest has NFKC-lowercase-colliding paths.");
    }
    collisionKeys.add(collisionKey);
    const logicalPathSha256 = digest(entry.logicalPathSha256, "logicalPathSha256");
    if (logicalPathSha256 !== sha256Utf8(canonicalJsonString({ logicalPath }))) {
      throw new TypeError("Remote worker artifact manifest entry logicalPathSha256 does not bind its path.");
    }
    const byteCount = nonNegativeInteger(entry.byteCount, "byteCount", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes);
    total += byteCount;
    blobKeys.add(digest(entry.blobSha256, "blobSha256"));
    return Object.freeze({
      entryIndex: index,
      logicalPath,
      logicalPathSha256,
      blobSha256: digest(entry.blobSha256, "blobSha256"),
      byteCount,
      mimeType: assertRemoteWorkerMime(entry.mimeType),
    });
  });
  if (entries.length !== nonNegativeInteger(input.fileCount, "fileCount", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles)) {
    throw new TypeError("Remote worker artifact manifest fileCount mismatch.");
  }
  if (total !== nonNegativeInteger(input.totalBytes, "totalBytes", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes)) {
    throw new TypeError("Remote worker artifact manifest totalBytes mismatch.");
  }
  const workerClaimIds = Object.freeze(
    (Array.isArray(input.workerClaimIds) ? input.workerClaimIds : []).map((claim, index) =>
      identifier(claim, `workerClaimIds[${index}]`),
    ),
  );
  if (workerClaimIds.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxWorkerClaims) {
    throw new TypeError("Remote worker artifact manifest exceeds the worker-claim bound.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity,
    pathJailSha256: digest(input.pathJailSha256, "pathJailSha256"),
    workerClaimIds,
    workerClaimSha256: digest(input.workerClaimSha256, "workerClaimSha256"),
    requiredVerifierProfileSha256:
      input.requiredVerifierProfileSha256 === null
        ? null
        : digest(input.requiredVerifierProfileSha256, "requiredVerifierProfileSha256"),
    fileCount: entries.length,
    totalBytes: total,
    entries,
  });
}

export function remoteWorkerArtifactManifestSha256(manifest: RemoteWorkerArtifactManifest): string {
  return sha256Utf8(canonicalJsonString(normalizeRemoteWorkerArtifactManifest(manifest)));
}

export function remoteWorkerArtifactManifestJson(manifest: RemoteWorkerArtifactManifest): string {
  return canonicalJsonString(normalizeRemoteWorkerArtifactManifest(manifest));
}

// --- Part descriptor --------------------------------------------------------

export interface RemoteWorkerArtifactPartDescriptor {
  globalSequence: number;
  logicalPathSha256: string;
  filePartIndex: number;
  isFinalPart: boolean;
  partBytes: number;
  partSha256: string;
}

export function normalizeRemoteWorkerArtifactPart(
  input: RemoteWorkerArtifactPartDescriptor,
): RemoteWorkerArtifactPartDescriptor {
  assertRecord(input, "part");
  assertExactKeys(
    input,
    ["globalSequence", "logicalPathSha256", "filePartIndex", "isFinalPart", "partBytes", "partSha256"],
    "part",
  );
  const partBytes = positiveInteger(input.partBytes, "partBytes", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBytes);
  if (typeof input.isFinalPart !== "boolean")
    throw new TypeError("Remote worker artifact part isFinalPart is invalid.");
  if (!input.isFinalPart && partBytes !== REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBytes) {
    throw new TypeError("Remote worker artifact non-final part must be exactly 256 KiB.");
  }
  return Object.freeze({
    globalSequence: positiveInteger(input.globalSequence, "globalSequence", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxParts),
    logicalPathSha256: digest(input.logicalPathSha256, "logicalPathSha256"),
    filePartIndex: nonNegativeInteger(input.filePartIndex, "filePartIndex", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxParts),
    isFinalPart: input.isFinalPart,
    partBytes,
    partSha256: digest(input.partSha256, "partSha256"),
  });
}

export function remoteWorkerArtifactPartReplayMaterial(input: {
  identity: RemoteWorkerSettlementIdentity;
  uploadId: string;
  part: RemoteWorkerArtifactPartDescriptor;
}): object {
  return Object.freeze({
    identity: normalizeRemoteWorkerSettlementIdentity(input.identity),
    uploadId: identifier(input.uploadId, "uploadId"),
    part: normalizeRemoteWorkerArtifactPart(input.part),
  });
}

// --- Verification evidence --------------------------------------------------

export interface RemoteWorkerVerificationEvidence {
  schemaVersion: typeof REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION;
  kind: RemoteWorkerVerificationKind;
  attemptState: RemoteWorkerVerificationAttemptState;
  verifierProfileSha256: string | null;
  preExecutionManifestSha256: string;
  postExecutionManifestSha256: string;
  summary: string;
  capturedOutputBytes: number;
}

export function normalizeRemoteWorkerVerificationEvidence(
  input: RemoteWorkerVerificationEvidence,
): RemoteWorkerVerificationEvidence {
  assertRecord(input, "verification evidence");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "kind",
      "attemptState",
      "verifierProfileSha256",
      "preExecutionManifestSha256",
      "postExecutionManifestSha256",
      "summary",
      "capturedOutputBytes",
    ],
    "verification evidence",
  );
  if (input.schemaVersion !== REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError("Remote worker verification evidence schemaVersion is invalid.");
  }
  const kind = enumValue(input.kind, REMOTE_WORKER_VERIFICATION_KINDS, "kind");
  const attemptState = enumValue(input.attemptState, REMOTE_WORKER_VERIFICATION_ATTEMPT_STATES, "attemptState");
  if (kind === "worker_claim" && attemptState !== "worker_reported") {
    throw new TypeError("Remote worker verification worker claim must be worker_reported.");
  }
  if (kind === "gateway_attempt" && attemptState === "worker_reported") {
    throw new TypeError("Remote worker verification gateway attempt cannot be worker_reported.");
  }
  if (
    typeof input.summary !== "string" ||
    utf8ByteLength(input.summary) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerificationSummaryBytes
  ) {
    throw new TypeError("Remote worker verification summary is invalid.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    kind,
    attemptState,
    verifierProfileSha256:
      input.verifierProfileSha256 === null ? null : digest(input.verifierProfileSha256, "verifierProfileSha256"),
    preExecutionManifestSha256: digest(input.preExecutionManifestSha256, "preExecutionManifestSha256"),
    postExecutionManifestSha256: digest(input.postExecutionManifestSha256, "postExecutionManifestSha256"),
    summary: input.summary,
    capturedOutputBytes: nonNegativeInteger(
      input.capturedOutputBytes,
      "capturedOutputBytes",
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerifierCapturedOutputBytes,
    ),
  });
}

export function remoteWorkerVerificationEvidenceSha256(input: RemoteWorkerVerificationEvidence): string {
  return sha256Utf8(canonicalJsonString(normalizeRemoteWorkerVerificationEvidence(input)));
}

// --- Effect intent ----------------------------------------------------------

export interface RemoteWorkerEffectIntent {
  schemaVersion: typeof REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION;
  identity: RemoteWorkerSettlementIdentity;
  intentIndex: number;
  effectSelector: string;
  canonicalArgsSha256: string;
  workerIdempotencyKey: string;
}

export function normalizeRemoteWorkerEffectIntent(input: RemoteWorkerEffectIntent): RemoteWorkerEffectIntent {
  assertRecord(input, "effect intent");
  assertExactKeys(
    input,
    ["schemaVersion", "identity", "intentIndex", "effectSelector", "canonicalArgsSha256", "workerIdempotencyKey"],
    "effect intent",
  );
  if (input.schemaVersion !== REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION) {
    throw new TypeError("Remote worker effect intent schemaVersion is invalid.");
  }
  if (
    typeof input.effectSelector !== "string" ||
    utf8ByteLength(input.effectSelector) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectSelectorBytes
  ) {
    throw new TypeError("Remote worker effect intent selector is invalid.");
  }
  if (input.effectSelector !== input.effectSelector.normalize("NFKC").trim() || /\p{Cc}/u.test(input.effectSelector)) {
    throw new TypeError("Remote worker effect intent selector is invalid.");
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION,
    identity: normalizeRemoteWorkerSettlementIdentity(input.identity),
    intentIndex: nonNegativeInteger(
      input.intentIndex,
      "intentIndex",
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectIntents - 1,
    ),
    effectSelector: input.effectSelector,
    canonicalArgsSha256: digest(input.canonicalArgsSha256, "canonicalArgsSha256"),
    workerIdempotencyKey: identifier(input.workerIdempotencyKey, "workerIdempotencyKey", 512),
  });
}

export function remoteWorkerEffectIntentSha256(input: RemoteWorkerEffectIntent): string {
  return sha256Utf8(canonicalJsonString(normalizeRemoteWorkerEffectIntent(input)));
}

// --- Effect correlation (records ONLY exact correlations, never authority) --

export interface RemoteWorkerEffectCorrelation {
  schemaVersion: typeof REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION;
  transitionState: RemoteWorkerEffectTransitionState;
  externalSideEffectRunId: string | null;
  approvalRecordSha256: string | null;
  boundaryReceiptSha256: string | null;
  hx305OutcomeSha256: string | null;
  reconciliationRecordSha256: string | null;
  sanitizedError: string | null;
}

export function normalizeRemoteWorkerEffectCorrelation(
  input: RemoteWorkerEffectCorrelation,
): RemoteWorkerEffectCorrelation {
  assertRecord(input, "effect correlation");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "transitionState",
      "externalSideEffectRunId",
      "approvalRecordSha256",
      "boundaryReceiptSha256",
      "hx305OutcomeSha256",
      "reconciliationRecordSha256",
      "sanitizedError",
    ],
    "effect correlation",
  );
  if (input.schemaVersion !== REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION) {
    throw new TypeError("Remote worker effect correlation schemaVersion is invalid.");
  }
  const transitionState = enumValue(input.transitionState, REMOTE_WORKER_EFFECT_TRANSITION_STATES, "transitionState");
  // completed_with_effect requires an exact completed HX-305 canonical owner.
  if (transitionState === "completed_with_effect" && input.hx305OutcomeSha256 === null) {
    throw new TypeError("Remote worker completed_with_effect requires a canonical HX-305 outcome.");
  }
  // A result payload can never conjure a boundary receipt; only a real boundary can.
  if (
    (transitionState === "external_boundary_started" ||
      transitionState === "completed_no_effect" ||
      transitionState === "completed_with_effect") &&
    input.boundaryReceiptSha256 === null
  ) {
    throw new TypeError("Remote worker boundary-crossing transition requires a boundary receipt.");
  }
  if (input.sanitizedError !== null) {
    if (
      typeof input.sanitizedError !== "string" ||
      utf8ByteLength(input.sanitizedError) > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxSanitizedErrorBytes
    ) {
      throw new TypeError("Remote worker effect correlation sanitizedError is invalid.");
    }
  }
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
    transitionState,
    externalSideEffectRunId:
      input.externalSideEffectRunId === null
        ? null
        : identifier(input.externalSideEffectRunId, "externalSideEffectRunId"),
    approvalRecordSha256:
      input.approvalRecordSha256 === null ? null : digest(input.approvalRecordSha256, "approvalRecordSha256"),
    boundaryReceiptSha256:
      input.boundaryReceiptSha256 === null ? null : digest(input.boundaryReceiptSha256, "boundaryReceiptSha256"),
    hx305OutcomeSha256:
      input.hx305OutcomeSha256 === null ? null : digest(input.hx305OutcomeSha256, "hx305OutcomeSha256"),
    reconciliationRecordSha256:
      input.reconciliationRecordSha256 === null
        ? null
        : digest(input.reconciliationRecordSha256, "reconciliationRecordSha256"),
    sanitizedError: input.sanitizedError,
  });
}

export function remoteWorkerEffectCorrelationSha256(input: RemoteWorkerEffectCorrelation): string {
  return sha256Utf8(canonicalJsonString(normalizeRemoteWorkerEffectCorrelation(input)));
}

export function remoteWorkerEffectTransitionHashMaterial(input: {
  intentSha256: string;
  transitionSequence: number;
  correlationSha256: string;
  previousTransitionSha256: string;
}): object {
  return Object.freeze({
    intentSha256: digest(input.intentSha256, "intentSha256"),
    transitionSequence: positiveInteger(
      input.transitionSequence,
      "transitionSequence",
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectTransitions,
    ),
    correlationSha256: digest(input.correlationSha256, "correlationSha256"),
    previousTransitionSha256: digest(input.previousTransitionSha256, "previousTransitionSha256"),
  });
}

export function remoteWorkerEffectTransitionSha256(input: {
  intentSha256: string;
  transitionSequence: number;
  correlationSha256: string;
  previousTransitionSha256: string;
}): string {
  return sha256Utf8(canonicalJsonString(remoteWorkerEffectTransitionHashMaterial(input)));
}

export function remoteWorkerSettlementCanonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalJsonString(value));
}

// --- Local validation helpers (browser-safe, dependency-free) ---------------

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Remote worker settlement ${field} must be an object.`);
  }
}

function assertExactKeys(value: object, allowed: string[], field: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new TypeError(`Remote worker settlement ${field} contains unknown fields.`);
  }
  if (allowed.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`Remote worker settlement ${field} is missing required fields.`);
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
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker settlement ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return value as number;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`Remote worker settlement ${field} is invalid.`);
  }
  return value as T[number];
}

function utf8ByteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type {
  ApprovalEffectRecord,
  CapabilityArtifactRecord,
  CodeModeRunRecord,
  DurableRunRecord,
  ExternalSideEffectRunRecord,
} from "@goatcitadel/contracts";

/**
 * Evidence Receipts — signed, portable, third-party-verifiable proof bundles for any run.
 *
 * The receipt is the flagship "destroyer" feature: a tamper-evident bundle that anyone can
 * verify OFFLINE (no GoatCitadel install, no DB) given only the receipt JSON. Correctness of
 * the canonicalization + sign/verify is the moat, so this module is deliberately self-contained
 * and dependency-light:
 *
 *   manifest  --canonicalize-->  canonical bytes  --sha256-->  contentHash
 *                                       |
 *                                       +--Ed25519 sign (private key)--> signature (+ publicKey travels in receipt)
 *
 * Verification re-runs the exact same pipeline on `receipt.manifest`, re-derives the contentHash,
 * checks it matches `receipt.contentHash`, then verifies the Ed25519 signature over the *canonical
 * bytes* against `receipt.publicKey`. Tampering any manifest field changes the canonical bytes ->
 * the hash mismatches and/or the signature fails.
 *
 * follow-up: ZIP packaging of the receipt + referenced artifact blobs (currently artifacts are
 *   referenced by sha256 hash only — the bytes are not bundled).
 * follow-up: Run Detail UI "Download receipt" button.
 * follow-up: Batch compliance export (many receipts -> one signed archive).
 */

export const EVIDENCE_RECEIPT_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM = "ed25519" as const;
export const EVIDENCE_RECEIPT_HASH_ALGORITHM = "sha256" as const;

/** A run-lineage view assembled from the durable run record (the anchor of the receipt). */
export interface EvidenceReceiptLineage {
  runId: string;
  workflowKey: string;
  status: DurableRunRecord["status"];
  attemptCount: number;
  maxAttempts: number;
  outcome: "succeeded" | "failed" | "in_progress" | "unknown";
  lastError?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  /** Best-effort correlation handles sourced from the run payload/metadata (may be absent). */
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  workspaceId?: string;
}

/** An explicit follow-on effect record tied to the run's approval (deny/allow/wake lineage). */
export interface EvidenceReceiptApprovalEffect {
  effectId: string;
  approvalId: string;
  effectKind: ApprovalEffectRecord["effectKind"];
  targetKind: ApprovalEffectRecord["targetKind"];
  targetId: string;
  status: ApprovalEffectRecord["status"];
  attemptCount: number;
  completedAt?: string;
}

/** A pre-boundary / external side-effect ledger entry (idempotent external write lineage). */
export interface EvidenceReceiptSideEffect {
  runId: string;
  boundary: string;
  routePath: string;
  status: ExternalSideEffectRunRecord["status"];
  idempotencyKey: string;
  payloadHash: string;
  externalReferenceId?: string;
  attemptCount: number;
  externalCallStartedAt?: string;
  completedAt?: string;
}

/** A content-addressed artifact reference (Code Mode + tool artifacts), hash-only (no bytes). */
export interface EvidenceReceiptArtifact {
  source: string;
  artifactId: string;
  relPath: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

/**
 * The proof manifest. This object — and ONLY this object — is canonicalized, hashed, and signed.
 * Everything required to understand what happened in the run lives here so the receipt is
 * self-describing. `notes` documents anything that could not be sourced.
 */
export interface EvidenceReceiptManifest {
  schemaVersion: string;
  runId: string;
  generatedAt: string;
  lineage: EvidenceReceiptLineage;
  approvalEffects: EvidenceReceiptApprovalEffect[];
  sideEffects: EvidenceReceiptSideEffect[];
  artifacts: EvidenceReceiptArtifact[];
  notes: string[];
}

export interface EvidenceReceipt {
  manifest: EvidenceReceiptManifest;
  /** sha256 of the canonical manifest bytes, hex-encoded. */
  contentHash: string;
  hashAlgorithm: typeof EVIDENCE_RECEIPT_HASH_ALGORITHM;
  signatureAlgorithm: typeof EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM;
  /** Ed25519 signature over the canonical manifest bytes, base64-encoded. */
  signature: string;
  /** SPKI DER public key, base64-encoded. Travels with the receipt for offline verification. */
  publicKey: string;
}

export interface EvidenceReceiptVerification {
  valid: boolean;
  reasons: string[];
}

/** Read-only data port. Narrow on purpose so the service stays testable and lineage is explicit. */
export interface EvidenceReceiptDataPort {
  getDurableRun(runId: string): DurableRunRecord;
  findCodeModeRun(runId: string): CodeModeRunRecord | undefined;
  listApprovalEffects(approvalId: string): ApprovalEffectRecord[];
  listSideEffectsForWorkspace(workspaceId: string): ExternalSideEffectRunRecord[];
}

/**
 * Persistent signing-key provider. The private key is reused across receipts so that every
 * receipt this host issues shares one verifiable public identity. See `createKeychainSigningKeyProvider`.
 */
export interface EvidenceReceiptSigningKeyProvider {
  /** Returns a stable Ed25519 keypair, generating + persisting one on first use. */
  getSigningKeyPair(): EvidenceReceiptKeyPair;
}

export interface EvidenceReceiptKeyPair {
  privateKey: KeyObject;
  /** SPKI DER public key, base64-encoded — the form that travels in the receipt. */
  publicKeySpkiBase64: string;
}

export interface EvidenceReceiptServiceDeps {
  data: EvidenceReceiptDataPort;
  signingKeys: EvidenceReceiptSigningKeyProvider;
  now?: () => Date;
}

export class EvidenceReceiptService {
  private readonly data: EvidenceReceiptDataPort;
  private readonly signingKeys: EvidenceReceiptSigningKeyProvider;
  private readonly now: () => Date;

  public constructor(deps: EvidenceReceiptServiceDeps) {
    this.data = deps.data;
    this.signingKeys = deps.signingKeys;
    this.now = deps.now ?? (() => new Date());
  }

  /** Assemble, canonicalize, hash, and sign an Evidence Receipt for a run. */
  public buildEvidenceReceipt(runId: string): EvidenceReceipt {
    const trimmedRunId = runId.trim();
    if (!trimmedRunId) {
      throw new Error("runId is required to build an evidence receipt");
    }
    const manifest = this.assembleManifest(trimmedRunId);
    return signManifest(manifest, this.signingKeys.getSigningKeyPair());
  }

  /**
   * Offline-verifiable: re-canonicalize the manifest, re-hash, and verify the signature against
   * the receipt's own public key. NEVER touches the data port — a provided receipt verifies
   * without any DB or run present.
   */
  public verifyEvidenceReceipt(receipt: unknown): EvidenceReceiptVerification {
    return verifyEvidenceReceipt(receipt);
  }

  private assembleManifest(runId: string): EvidenceReceiptManifest {
    const notes: string[] = [];
    const run = this.data.getDurableRun(runId);
    const correlation = extractCorrelation(run);

    const lineage: EvidenceReceiptLineage = {
      runId: run.runId,
      workflowKey: run.workflowKey,
      status: run.status,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      outcome: deriveOutcome(run.status),
      lastError: run.lastError,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      updatedAt: run.updatedAt,
      sessionId: correlation.sessionId,
      turnId: correlation.turnId,
      approvalId: correlation.approvalId,
      workspaceId: correlation.workspaceId,
    };

    // Code Mode artifacts: code-mode runs are keyed by the same runId. The artifact hashes
    // (code, wrapper manifest, policy snapshot, stdout/stderr) are the verifiable lineage.
    const artifacts: EvidenceReceiptArtifact[] = [];
    const codeModeRun = this.data.findCodeModeRun(runId);
    if (codeModeRun) {
      if (!lineage.approvalId && codeModeRun.approvalId) {
        lineage.approvalId = codeModeRun.approvalId;
      }
      if (!lineage.sessionId && codeModeRun.sessionId) {
        lineage.sessionId = codeModeRun.sessionId;
      }
      if (!lineage.turnId && codeModeRun.turnId) {
        lineage.turnId = codeModeRun.turnId;
      }
      if (!lineage.workspaceId && codeModeRun.workspaceId) {
        lineage.workspaceId = codeModeRun.workspaceId;
      }
      pushArtifact(artifacts, "code_mode.code", codeModeRun.codeArtifact);
      pushArtifact(artifacts, "code_mode.wrapper_manifest", codeModeRun.wrapperManifestArtifact);
      pushArtifact(artifacts, "code_mode.policy_snapshot", codeModeRun.policySnapshotArtifact);
      pushArtifact(artifacts, "code_mode.stdout", codeModeRun.stdoutArtifact);
      pushArtifact(artifacts, "code_mode.stderr", codeModeRun.stderrArtifact);
    } else {
      notes.push(
        "No Code Mode run is associated with this runId; artifact hash lineage is unavailable for this run.",
      );
    }

    // Approval effects: the explicit follow-on effect records tied to the run's approval.
    let approvalEffects: EvidenceReceiptApprovalEffect[] = [];
    if (lineage.approvalId) {
      approvalEffects = this.data
        .listApprovalEffects(lineage.approvalId)
        .map(toReceiptApprovalEffect);
      if (approvalEffects.length === 0) {
        notes.push(`No approval effects were recorded for approval ${lineage.approvalId}.`);
      }
    } else {
      notes.push(
        "Run is not linked to an approval (no approvalId in run payload/metadata or Code Mode run); approval-effect lineage omitted.",
      );
    }

    // External side-effects: the pre-boundary/started/completed ledger. These are keyed by their
    // own extfx_ runId and scoped to a workspace, NOT to the durable run. We surface the workspace
    // ledger when a workspaceId is known, and document that the correlation is workspace-scoped.
    let sideEffects: EvidenceReceiptSideEffect[] = [];
    if (lineage.workspaceId) {
      sideEffects = this.data
        .listSideEffectsForWorkspace(lineage.workspaceId)
        .map(toReceiptSideEffect);
      notes.push(
        `Side-effects are workspace-scoped (workspace ${lineage.workspaceId}); the external side-effect ledger is not keyed by durable runId, so entries reflect the run's workspace rather than this run alone.`,
      );
    } else {
      notes.push(
        "No workspaceId resolved for the run; external side-effect ledger lineage omitted.",
      );
    }

    return {
      schemaVersion: EVIDENCE_RECEIPT_SCHEMA_VERSION,
      runId: run.runId,
      generatedAt: this.now().toISOString(),
      lineage,
      approvalEffects,
      sideEffects,
      artifacts,
      notes,
    };
  }
}

/** Sign an already-assembled manifest. Exposed for callers that build manifests out-of-band. */
export function signManifest(
  manifest: EvidenceReceiptManifest,
  keyPair: EvidenceReceiptKeyPair,
): EvidenceReceipt {
  const canonicalBytes = canonicalJsonBytes(manifest);
  const contentHash = createHash(EVIDENCE_RECEIPT_HASH_ALGORITHM).update(canonicalBytes).digest("hex");
  // Ed25519: the algorithm argument to sign()/verify() MUST be null (the digest is implied).
  const signature = cryptoSign(null, canonicalBytes, keyPair.privateKey).toString("base64");
  return {
    manifest,
    contentHash,
    hashAlgorithm: EVIDENCE_RECEIPT_HASH_ALGORITHM,
    signatureAlgorithm: EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM,
    signature,
    publicKey: keyPair.publicKeySpkiBase64,
  };
}

/**
 * Self-contained, offline verification. Validates structure, re-derives the content hash from the
 * canonical manifest, and verifies the Ed25519 signature against the receipt's public key.
 * Returns every failure reason rather than throwing.
 */
export function verifyEvidenceReceipt(receipt: unknown): EvidenceReceiptVerification {
  const reasons: string[] = [];
  if (!isRecord(receipt)) {
    return { valid: false, reasons: ["Receipt is not an object."] };
  }
  const { manifest, contentHash, signature, publicKey, signatureAlgorithm, hashAlgorithm } =
    receipt as Partial<EvidenceReceipt>;

  if (!isRecord(manifest)) {
    reasons.push("Receipt is missing a manifest object.");
  }
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    reasons.push("Receipt is missing a contentHash.");
  }
  if (typeof signature !== "string" || signature.length === 0) {
    reasons.push("Receipt is missing a signature.");
  }
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    reasons.push("Receipt is missing a publicKey.");
  }
  if (signatureAlgorithm !== undefined && signatureAlgorithm !== EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM) {
    reasons.push(`Unsupported signatureAlgorithm: ${String(signatureAlgorithm)}.`);
  }
  if (hashAlgorithm !== undefined && hashAlgorithm !== EVIDENCE_RECEIPT_HASH_ALGORITHM) {
    reasons.push(`Unsupported hashAlgorithm: ${String(hashAlgorithm)}.`);
  }
  if (reasons.length > 0) {
    return { valid: false, reasons };
  }

  // Re-canonicalize + re-hash the manifest exactly as it was signed.
  const canonicalBytes = canonicalJsonBytes(manifest as EvidenceReceiptManifest);
  const recomputedHash = createHash(EVIDENCE_RECEIPT_HASH_ALGORITHM).update(canonicalBytes).digest("hex");
  if (recomputedHash !== contentHash) {
    reasons.push(
      `Content hash mismatch: manifest hashes to ${recomputedHash} but receipt claims ${String(contentHash)} (manifest was modified after signing).`,
    );
  }

  let publicKeyObject: KeyObject | undefined;
  try {
    publicKeyObject = createPublicKey({
      key: Buffer.from(publicKey as string, "base64"),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    reasons.push(`Public key could not be parsed: ${errorMessage(error)}.`);
  }

  if (publicKeyObject) {
    let signatureValid = false;
    try {
      signatureValid = cryptoVerify(
        null,
        canonicalBytes,
        publicKeyObject,
        Buffer.from(signature as string, "base64"),
      );
    } catch (error) {
      reasons.push(`Signature verification raised an error: ${errorMessage(error)}.`);
    }
    if (!signatureValid) {
      reasons.push("Ed25519 signature does not verify against the receipt's public key.");
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Deterministic, canonical JSON serialization: object keys are recursively sorted, arrays keep
 * their order, `undefined` object properties are dropped (mirrors JSON.stringify semantics so the
 * receipt round-trips through JSON transport without changing its hash). This is what makes the
 * content hash stable regardless of the key order the manifest was built with.
 */
export function canonicalJsonString(value: unknown): string {
  return canonicalize(value);
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJsonString(value), "utf8");
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize a non-finite number in an evidence receipt manifest.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("Cannot canonicalize a bigint in an evidence receipt manifest.");
  }
  if (Array.isArray(value)) {
    // Arrays are order-significant; `undefined`/function entries serialize to null (JSON semantics).
    return `[${value.map((entry) => canonicalizeArrayEntry(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${members.join(",")}}`;
  }
  // undefined / function at the top level — represent as null so output stays valid JSON.
  return "null";
}

function canonicalizeArrayEntry(entry: unknown): string {
  if (entry === undefined || typeof entry === "function") {
    return "null";
  }
  return canonicalize(entry);
}

function extractCorrelation(run: DurableRunRecord): {
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  workspaceId?: string;
} {
  const sources: Array<Record<string, unknown>> = [];
  if (isRecord(run.payload)) {
    sources.push(run.payload);
  }
  if (isRecord(run.metadata)) {
    sources.push(run.metadata);
  }
  return {
    sessionId: pickString(sources, "sessionId"),
    turnId: pickString(sources, "turnId"),
    approvalId: pickString(sources, "approvalId"),
    workspaceId: pickString(sources, "workspaceId") ?? pickString(sources, "workspace_id"),
  };
}

function pickString(sources: Array<Record<string, unknown>>, key: string): string | undefined {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function deriveOutcome(status: DurableRunRecord["status"]): EvidenceReceiptLineage["outcome"] {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
    case "dead_lettered":
    case "cancelled":
      return "failed";
    case "queued":
    case "running":
    case "waiting":
    case "paused":
      return "in_progress";
    default:
      return "unknown";
  }
}

function pushArtifact(
  target: EvidenceReceiptArtifact[],
  source: string,
  artifact: CapabilityArtifactRecord | undefined,
): void {
  if (!artifact) {
    return;
  }
  target.push({
    source,
    artifactId: artifact.artifactId,
    relPath: artifact.relPath,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    mimeType: artifact.mimeType,
  });
}

function toReceiptApprovalEffect(effect: ApprovalEffectRecord): EvidenceReceiptApprovalEffect {
  return {
    effectId: effect.effectId,
    approvalId: effect.approvalId,
    effectKind: effect.effectKind,
    targetKind: effect.targetKind,
    targetId: effect.targetId,
    status: effect.status,
    attemptCount: effect.attemptCount,
    completedAt: effect.completedAt,
  };
}

function toReceiptSideEffect(record: ExternalSideEffectRunRecord): EvidenceReceiptSideEffect {
  return {
    runId: record.runId,
    boundary: record.boundary,
    routePath: record.routePath,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    externalReferenceId: record.externalReferenceId,
    attemptCount: record.attemptCount,
    externalCallStartedAt: record.externalCallStartedAt,
    completedAt: record.completedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the Ed25519 keypair from a PKCS#8 PEM private key (the form persisted in the keychain).
 * Derives the SPKI public key from the private key so the receipt always carries the matching
 * public half.
 */
export function keyPairFromPrivatePkcs8Pem(privateKeyPem: string): EvidenceReceiptKeyPair {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateKey, publicKeySpkiBase64 };
}

/** Generates a fresh Ed25519 keypair and returns it alongside its PKCS#8 PEM (for persistence). */
export function generateEvidenceReceiptKeyPair(): {
  keyPair: EvidenceReceiptKeyPair;
  privateKeyPkcs8Pem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    keyPair: { privateKey, publicKeySpkiBase64 },
    privateKeyPkcs8Pem,
  };
}

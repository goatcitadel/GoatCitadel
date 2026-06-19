import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import {
  EvidenceReceiptService,
  canonicalJsonBytes,
  verifyEvidenceReceipt,
  EVIDENCE_RECEIPT_HASH_ALGORITHM,
  EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM,
  type EvidenceReceipt,
  type EvidenceReceiptDataPort,
  type EvidenceReceiptServiceDeps,
  type EvidenceReceiptSigningKeyProvider,
} from "./evidence-receipt-service.js";

/**
 * C3 — Offline-verifiable Compliance Export.
 *
 * A Compliance Bundle packages MANY Evidence Receipts (B1) spanning a time range into ONE
 * tamper-evident, independently-verifiable archive. This is the moat for regulated AI-agent
 * deployment: a regulator can take the bundle JSON to an air-gapped machine and confirm, with no
 * GoatCitadel install and no database, that every run in the period is accounted for and untampered.
 *
 * Trust pipeline (built ENTIRELY on B1 primitives — nothing about signing/canonicalization is
 * reimplemented here):
 *
 *   for each run in [fromTs, toTs]:
 *       receipt = EvidenceReceiptService.buildEvidenceReceipt(runId)   // B1 sign pipeline
 *
 *   commitments = receipts.map(r => ({ runId, contentHash, signature }))   // ordered, stable
 *   bundleContentHash = sha256( canonicalJson(commitments) )               // B1 canonicalizer + sha256
 *   bundleSignature   = Ed25519( bundleContentHash bytes )                 // B1 host signing key
 *
 * The bundle commits to EXACTLY the listed receipts: the content hash is taken over an ordered list
 * of each receipt's {runId, contentHash, signature}, so adding, dropping, reordering, or swapping a
 * receipt changes the bundle hash. Each receipt also stays independently verifiable via its own
 * embedded public key, so verification re-checks every receipt AND the bundle-level commitment.
 *
 * Bounding: the source run list is large and unindexed by time/workspace (durable_runs has no
 * workspace column — workspaceId lives in the run payload/metadata), so the service lists a page of
 * recent runs, filters in-memory to the requested range/workspace, then applies a hard `limit`
 * (default 500). When the in-range matches exceed the limit, `truncated` is set true and the bundle
 * carries only the newest `limit` receipts — callers must narrow the range to capture the rest.
 *
 * NOTE on the source page: the durable-run repo's `listRuns` is itself capped (currently 500 newest
 * runs, ordered by created_at DESC). So today an export reflects at most the 500 most recent runs;
 * runs older than that window are not visible to the exporter until the native range-query follow-up
 * lands. `COMPLIANCE_BUNDLE_SOURCE_SCAN_LIMIT` requests more than that so the bound moves with the
 * repo if/when its cap is raised, without this service changing.
 *
 * follow-up: ZIP packaging of the bundle (one .zip with bundle.json + each receipt.json) for easier
 *   hand-off, mirroring the B1 "ZIP packaging of the receipt" follow-up.
 * follow-up: a Compliance UI page (pick range + workspace, download bundle, drag-drop to verify).
 * follow-up: a native durable-run range query (indexed by created_at + workspace) so the export does
 *   not depend on the recent-runs page size.
 */

export const COMPLIANCE_BUNDLE_SCHEMA_VERSION = "1.0.0";

/** Default hard cap on receipts per bundle. Bounds work + output size; documented in `truncated`. */
export const COMPLIANCE_BUNDLE_DEFAULT_LIMIT = 500;
/** Absolute ceiling on `limit` regardless of what the caller requests. */
export const COMPLIANCE_BUNDLE_MAX_LIMIT = 1000;
/**
 * How many recent runs to pull from the source before in-memory range/workspace filtering. We
 * over-fetch beyond MAX_LIMIT so that runs OUTSIDE the range interleaved with in-range runs do not
 * starve the result. Still bounded so a single export can never scan unboundedly.
 */
export const COMPLIANCE_BUNDLE_SOURCE_SCAN_LIMIT = 5000;

/**
 * Read-only data port for the export. Extends the B1 receipt data port (so the same object can build
 * receipts) with a single listing method. `listDurableRunsForExport` returns recent runs (newest
 * first); the service does range + workspace filtering itself.
 */
export interface ComplianceExportDataPort extends EvidenceReceiptDataPort {
  listDurableRunsForExport(scanLimit: number): DurableRunRecord[];
}

export interface ComplianceExportServiceDeps extends Omit<EvidenceReceiptServiceDeps, "data"> {
  data: ComplianceExportDataPort;
  signingKeys: EvidenceReceiptSigningKeyProvider;
  now?: () => Date;
}

export interface BuildComplianceBundleInput {
  /** Optional workspace filter. When set, only runs correlated to this workspace are included. */
  workspaceId?: string;
  /** Inclusive lower bound (ISO-8601). A run is in-range if its effective timestamp >= fromTs. */
  fromTs: string;
  /** Inclusive upper bound (ISO-8601). A run is in-range if its effective timestamp <= toTs. */
  toTs: string;
  /** Hard cap on receipts in the bundle. Defaults to COMPLIANCE_BUNDLE_DEFAULT_LIMIT. */
  limit?: number;
}

/** The per-receipt commitment the bundle hash is computed over. Ordering is significant. */
export interface ComplianceReceiptCommitment {
  runId: string;
  contentHash: string;
  signature: string;
}

export interface ComplianceBundle {
  schemaVersion: string;
  generatedAt: string;
  range: { fromTs: string; toTs: string };
  /** Present only when the export was scoped to a workspace. */
  workspaceId?: string;
  receiptCount: number;
  /** True when in-range matches exceeded `limit`; the bundle holds only the newest `limit`. */
  truncated: boolean;
  receipts: EvidenceReceipt[];
  hashAlgorithm: typeof EVIDENCE_RECEIPT_HASH_ALGORITHM;
  signatureAlgorithm: typeof EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM;
  /** sha256 (hex) over canonical JSON of the ordered receipt commitments. */
  bundleContentHash: string;
  /** Ed25519 signature (base64) over the bundle content hash bytes. */
  bundleSignature: string;
  /** SPKI DER public key (base64). Travels with the bundle for offline verification. */
  publicKey: string;
}

export interface ComplianceBundleVerification {
  valid: boolean;
  reasons: string[];
  perReceipt: Array<{ runId: string; valid: boolean }>;
}

export class ComplianceExportService {
  private readonly data: ComplianceExportDataPort;
  private readonly signingKeys: EvidenceReceiptSigningKeyProvider;
  private readonly now: () => Date;
  private readonly receiptService: EvidenceReceiptService;

  public constructor(deps: ComplianceExportServiceDeps) {
    this.data = deps.data;
    this.signingKeys = deps.signingKeys;
    this.now = deps.now ?? (() => new Date());
    // Reuse the B1 service verbatim for per-run receipt building (same canonicalize/hash/sign).
    this.receiptService = new EvidenceReceiptService({
      data: deps.data,
      signingKeys: deps.signingKeys,
      now: this.now,
    });
  }

  /**
   * List runs in [fromTs, toTs] (optionally workspace-scoped), build a B1 Evidence Receipt for each,
   * and assemble a signed, offline-verifiable bundle committing to exactly those receipts.
   */
  public buildComplianceBundle(input: BuildComplianceBundleInput): ComplianceBundle {
    const range = normalizeRange(input.fromTs, input.toTs);
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const limit = clampLimit(input.limit);

    const runs = this.data.listDurableRunsForExport(COMPLIANCE_BUNDLE_SOURCE_SCAN_LIMIT);
    const matched = runs
      .filter((run) => runMatchesWorkspace(run, workspaceId))
      .filter((run) => runMatchesRange(run, range))
      // Deterministic newest-first order; ties broken by runId so the bundle hash is stable.
      .sort(compareRunsNewestFirst);

    const truncated = matched.length > limit;
    const selected = truncated ? matched.slice(0, limit) : matched;

    const receipts = selected.map((run) => this.receiptService.buildEvidenceReceipt(run.runId));

    const keyPair = this.signingKeys.getSigningKeyPair();
    const commitments = receipts.map(toReceiptCommitment);
    const bundleContentHash = computeBundleContentHash(commitments);
    const bundleSignature = signBundleContentHash(bundleContentHash, keyPair.privateKey);

    return {
      schemaVersion: COMPLIANCE_BUNDLE_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      range: { fromTs: range.fromTs, toTs: range.toTs },
      ...(workspaceId ? { workspaceId } : {}),
      receiptCount: receipts.length,
      truncated,
      receipts,
      hashAlgorithm: EVIDENCE_RECEIPT_HASH_ALGORITHM,
      signatureAlgorithm: EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM,
      bundleContentHash,
      bundleSignature,
      publicKey: keyPair.publicKeySpkiBase64,
    };
  }

  /** Offline-verifiable: never touches the data port. Delegates to the module-level verifier. */
  public verifyComplianceBundle(bundle: unknown): ComplianceBundleVerification {
    return verifyComplianceBundle(bundle);
  }
}

/**
 * Self-contained, offline verification of a bundle:
 *   1. Validate structure.
 *   2. Re-verify EVERY receipt with the B1 verifier (each carries its own public key).
 *   3. Recompute the bundle content hash from the receipts' commitments and check it matches.
 *   4. Verify the bundle Ed25519 signature over the (claimed) bundle content hash against publicKey.
 *
 * Returns every failure reason rather than throwing, plus a per-receipt validity breakdown.
 */
export function verifyComplianceBundle(bundle: unknown): ComplianceBundleVerification {
  const reasons: string[] = [];
  const perReceipt: Array<{ runId: string; valid: boolean }> = [];

  if (!isRecord(bundle)) {
    return { valid: false, reasons: ["Bundle is not an object."], perReceipt };
  }

  const {
    receipts,
    bundleContentHash,
    bundleSignature,
    publicKey,
    signatureAlgorithm,
    hashAlgorithm,
    receiptCount,
  } = bundle as Partial<ComplianceBundle>;

  if (!Array.isArray(receipts)) {
    reasons.push("Bundle is missing a receipts array.");
  }
  if (typeof bundleContentHash !== "string" || bundleContentHash.length === 0) {
    reasons.push("Bundle is missing a bundleContentHash.");
  }
  if (typeof bundleSignature !== "string" || bundleSignature.length === 0) {
    reasons.push("Bundle is missing a bundleSignature.");
  }
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    reasons.push("Bundle is missing a publicKey.");
  }
  if (signatureAlgorithm !== undefined && signatureAlgorithm !== EVIDENCE_RECEIPT_SIGNATURE_ALGORITHM) {
    reasons.push(`Unsupported signatureAlgorithm: ${String(signatureAlgorithm)}.`);
  }
  if (hashAlgorithm !== undefined && hashAlgorithm !== EVIDENCE_RECEIPT_HASH_ALGORITHM) {
    reasons.push(`Unsupported hashAlgorithm: ${String(hashAlgorithm)}.`);
  }

  // Structural problems are fatal — we cannot meaningfully check commitments without the parts.
  if (reasons.length > 0) {
    return { valid: false, reasons, perReceipt };
  }

  const receiptList = receipts as EvidenceReceipt[];

  if (typeof receiptCount === "number" && receiptCount !== receiptList.length) {
    reasons.push(
      `receiptCount (${receiptCount}) does not match the number of receipts present (${receiptList.length}).`,
    );
  }

  // 2. Re-verify every receipt independently (B1). A single tampered receipt fails here AND below
  //    (its contentHash/signature no longer match what the receipt now hashes to).
  const commitments: ComplianceReceiptCommitment[] = [];
  receiptList.forEach((receipt, index) => {
    const runId = readReceiptRunId(receipt, index);
    const result = verifyEvidenceReceipt(receipt);
    perReceipt.push({ runId, valid: result.valid });
    if (!result.valid) {
      reasons.push(`Receipt ${runId} is invalid: ${result.reasons.join(" ")}`);
    }
    commitments.push(toReceiptCommitment(receipt));
  });

  // 3. Recompute the bundle content hash over the receipts' commitments and compare.
  const recomputedHash = computeBundleContentHash(commitments);
  if (recomputedHash !== bundleContentHash) {
    reasons.push(
      `Bundle content hash mismatch: receipts commit to ${recomputedHash} but the bundle claims ` +
        `${String(bundleContentHash)} (a receipt was added, removed, reordered, or swapped).`,
    );
  }

  // 4. Verify the bundle signature over the CLAIMED bundle content hash bytes. Pairing this with the
  //    recompute check above means a forged hash+signature pair still fails step 3.
  let publicKeyObject: KeyObject | undefined;
  try {
    publicKeyObject = createPublicKey({
      key: Buffer.from(publicKey as string, "base64"),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    reasons.push(`Bundle public key could not be parsed: ${errorMessage(error)}.`);
  }

  if (publicKeyObject) {
    let signatureValid = false;
    try {
      signatureValid = cryptoVerify(
        null,
        bundleContentHashBytes(bundleContentHash as string),
        publicKeyObject,
        Buffer.from(bundleSignature as string, "base64"),
      );
    } catch (error) {
      reasons.push(`Bundle signature verification raised an error: ${errorMessage(error)}.`);
    }
    if (!signatureValid) {
      reasons.push("Bundle Ed25519 signature does not verify against the bundle's public key.");
    }
  }

  return { valid: reasons.length === 0, reasons, perReceipt };
}

/** sha256 (hex) over the canonical JSON of the ordered receipt commitments. */
export function computeBundleContentHash(commitments: ComplianceReceiptCommitment[]): string {
  const canonicalBytes = canonicalJsonBytes(commitments);
  return createHash(EVIDENCE_RECEIPT_HASH_ALGORITHM).update(canonicalBytes).digest("hex");
}

function toReceiptCommitment(receipt: EvidenceReceipt): ComplianceReceiptCommitment {
  return {
    runId: receipt.manifest.runId,
    contentHash: receipt.contentHash,
    signature: receipt.signature,
  };
}

function signBundleContentHash(bundleContentHash: string, privateKey: KeyObject): string {
  // Ed25519: the algorithm argument MUST be null (the digest is implied). We sign the hash bytes so
  // the signature commits to the same value the verifier checks against `bundleContentHash`.
  return cryptoSign(null, bundleContentHashBytes(bundleContentHash), privateKey).toString("base64");
}

function bundleContentHashBytes(bundleContentHash: string): Buffer {
  return Buffer.from(bundleContentHash, "utf8");
}

function readReceiptRunId(receipt: unknown, index: number): string {
  if (isRecord(receipt) && isRecord(receipt.manifest) && typeof receipt.manifest.runId === "string") {
    return receipt.manifest.runId;
  }
  return `receipt[${index}]`;
}

interface NormalizedRange {
  fromTs: string;
  toTs: string;
  fromMs: number;
  toMs: number;
}

function normalizeRange(fromTs: unknown, toTs: unknown): NormalizedRange {
  const fromMs = parseTimestamp(fromTs, "fromTs");
  const toMs = parseTimestamp(toTs, "toTs");
  if (fromMs > toMs) {
    throw new Error("fromTs must be less than or equal to toTs for a compliance export.");
  }
  return {
    fromTs: new Date(fromMs).toISOString(),
    toTs: new Date(toMs).toISOString(),
    fromMs,
    toMs,
  };
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required and must be an ISO-8601 timestamp string.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} is not a valid ISO-8601 timestamp: ${value}`);
  }
  return ms;
}

function normalizeWorkspaceId(workspaceId: unknown): string | undefined {
  if (typeof workspaceId !== "string") {
    return undefined;
  }
  const trimmed = workspaceId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return COMPLIANCE_BUNDLE_DEFAULT_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) {
    return 1;
  }
  return Math.min(floored, COMPLIANCE_BUNDLE_MAX_LIMIT);
}

/**
 * The effective timestamp for range membership: prefer when the run finished, then when it was
 * created. (createdAt is always present; finishedAt only for terminal runs.)
 */
function runEffectiveTimestampMs(run: DurableRunRecord): number {
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (Number.isFinite(finished)) {
    return finished;
  }
  const created = Date.parse(run.createdAt);
  return Number.isFinite(created) ? created : NaN;
}

function runMatchesRange(run: DurableRunRecord, range: NormalizedRange): boolean {
  const ms = runEffectiveTimestampMs(run);
  if (!Number.isFinite(ms)) {
    return false;
  }
  return ms >= range.fromMs && ms <= range.toMs;
}

function runMatchesWorkspace(run: DurableRunRecord, workspaceId: string | undefined): boolean {
  if (!workspaceId) {
    return true;
  }
  return extractWorkspaceId(run) === workspaceId;
}

/** Mirrors the B1 correlation extraction: workspaceId lives in run payload/metadata, not a column. */
function extractWorkspaceId(run: DurableRunRecord): string | undefined {
  const sources: Array<Record<string, unknown>> = [];
  if (isRecord(run.payload)) {
    sources.push(run.payload);
  }
  if (isRecord(run.metadata)) {
    sources.push(run.metadata);
  }
  for (const source of sources) {
    const direct = source.workspaceId;
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }
    const snake = source.workspace_id;
    if (typeof snake === "string" && snake.trim().length > 0) {
      return snake.trim();
    }
  }
  return undefined;
}

function compareRunsNewestFirst(left: DurableRunRecord, right: DurableRunRecord): number {
  const leftMs = runEffectiveTimestampMs(left);
  const rightMs = runEffectiveTimestampMs(right);
  if (leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  // Stable tiebreaker so selection + the bundle hash are deterministic across equal timestamps.
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

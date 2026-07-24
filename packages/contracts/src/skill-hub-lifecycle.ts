import { canonicalJsonString } from "./canonical-json.js";
import type { SkillContentIntegrityManifest } from "./skills.js";

export const SKILL_HUB_ARTIFACT_MAX_FILES = 96 as const;
export const SKILL_HUB_ARTIFACT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SKILL_HUB_ARTIFACT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const SKILL_HUB_ARTIFACT_MANIFEST_MAX_BYTES = 256 * 1024;
export const SKILL_HUB_OPERATION_METADATA_MAX_BYTES = 16 * 1024;

export const SKILL_HUB_LIFECYCLE_APPROVAL_KIND = "skill_hub.lifecycle" as const;
export const SKILL_HUB_LIFECYCLE_EVIDENCE_EVENT_KIND = "approval_resolution" as const;
export const SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE = "skill_hub_lifecycle" as const;
export const SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND = "skill" as const;
export const SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND = "upstream_snapshot" as const;
export const SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA = "goatcitadel.skill-hub-operation-intent.v1" as const;

export const SKILL_HUB_OPERATION_KINDS = [
  "install_inactive",
  "stage_update_candidate",
  "stage_rollback_candidate",
  "activate",
  "revoke",
] as const;

export const SKILL_HUB_OPERATION_SETTLEMENT_DISPOSITIONS = ["applied", "blocked", "manual_reconciliation"] as const;

export type SkillHubOperationKind = (typeof SKILL_HUB_OPERATION_KINDS)[number];
export type SkillHubOperationSettlementDisposition = (typeof SKILL_HUB_OPERATION_SETTLEMENT_DISPOSITIONS)[number];

/**
 * Immutable database linkage from an upstream review snapshot to the exact,
 * content-addressed bytes retained by the Gateway artifact store.
 */
export interface SkillHubSnapshotArtifactRecord {
  artifactId: string;
  workspaceId: string;
  snapshotId: string;
  contentTreeSha256: string;
  bundleRelPath: string;
  manifest: SkillContentIntegrityManifest;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

/**
 * Immutable, approval-bound request. The approval effect stores only the
 * operation ID and request digest, then reloads this canonical intent.
 */
export interface SkillHubOperationIntentRecord {
  operationId: string;
  idempotencyKey: string;
  workspaceId: string;
  operationKind: SkillHubOperationKind;
  approvalId: string;
  snapshotId: string;
  contentTreeSha256: string;
  skillId: string;
  targetCandidateId?: string;
  targetVersionId?: string;
  supersedesVersionId?: string;
  expectedCandidateRevision?: number;
  expectedRuntimeRevision?: number;
  expectedCandidateAbsent: boolean;
  expectedRuntimeAbsent: boolean;
  actorId: string;
  sessionId?: string;
  turnId?: string;
  requestSha256: string;
  createdAt: string;
}

/** Approval-time request body. Approval identity is a parent binding, not part of the request digest. */
export type SkillHubOperationIntentTemplate = Omit<SkillHubOperationIntentRecord, "approvalId" | "requestSha256">;

export interface SkillHubOperationIntentPreview {
  schemaVersion: typeof SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA;
  intent: SkillHubOperationIntentTemplate;
}

/** One immutable terminal result. Retryable attempts remain in approval_effects. */
export interface SkillHubOperationSettlementRecord {
  settlementId: string;
  operationId: string;
  workspaceId: string;
  approvalId: string;
  contentTreeSha256: string;
  disposition: SkillHubOperationSettlementDisposition;
  observedTreeSha256: string;
  candidateVersionId?: string;
  runtimeSkillId?: string;
  candidateRevision?: number;
  runtimeRevision?: number;
  evidenceEnvelopeId: string;
  journeyEventId: string;
  result: Record<string, unknown>;
  resultSha256: string;
  settledAt: string;
}

export function isSkillHubOperationKind(value: unknown): value is SkillHubOperationKind {
  return typeof value === "string" && (SKILL_HUB_OPERATION_KINDS as readonly string[]).includes(value);
}

export function isSkillHubOperationSettlementDisposition(
  value: unknown,
): value is SkillHubOperationSettlementDisposition {
  return (
    typeof value === "string" && (SKILL_HUB_OPERATION_SETTLEMENT_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export function skillHubArtifactBundleRelPath(contentTreeSha256: string): string {
  assertSkillHubSha256(contentTreeSha256, "content tree");
  return `sha256/${contentTreeSha256.slice(0, 2)}/${contentTreeSha256}`;
}

export function assertSkillHubArtifactManifest(
  value: SkillContentIntegrityManifest,
): asserts value is SkillContentIntegrityManifest {
  if (
    !value ||
    typeof value !== "object" ||
    value.manifestVersion !== "goatcitadel.skill-tree.v1" ||
    value.algorithm !== "sha256" ||
    !Array.isArray(value.excludedPaths) ||
    value.excludedPaths.length !== 2 ||
    value.excludedPaths[0] !== "source.json" ||
    value.excludedPaths[1] !== ".git/**"
  ) {
    throw new TypeError("Skill Hub artifact manifest header is malformed.");
  }
  assertSkillHubSha256(value.treeSha256, "manifest tree");
  if (
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    value.fileCount > SKILL_HUB_ARTIFACT_MAX_FILES ||
    !Array.isArray(value.files) ||
    value.files.length !== value.fileCount
  ) {
    throw new TypeError("Skill Hub artifact manifest file count is malformed or oversized.");
  }
  if (
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > SKILL_HUB_ARTIFACT_MAX_TOTAL_BYTES
  ) {
    throw new TypeError("Skill Hub artifact manifest byte count is malformed or oversized.");
  }

  let totalBytes = 0;
  let priorPath: string | undefined;
  for (const file of value.files) {
    assertSkillHubArtifactPath(file.path);
    if (priorPath !== undefined && priorPath >= file.path) {
      throw new TypeError("Skill Hub artifact manifest paths must be unique and bytewise sorted.");
    }
    assertSkillHubSha256(file.sha256, `artifact file ${file.path}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > SKILL_HUB_ARTIFACT_MAX_FILE_BYTES) {
      throw new TypeError(`Skill Hub artifact file ${file.path} is malformed or oversized.`);
    }
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SKILL_HUB_ARTIFACT_MAX_TOTAL_BYTES) {
      throw new TypeError("Skill Hub artifact manifest exceeds the total byte limit.");
    }
    priorPath = file.path;
  }
  if (totalBytes !== value.totalBytes) {
    throw new TypeError("Skill Hub artifact manifest total bytes do not match its files.");
  }
  if (utf8Bytes(canonicalJsonString(value)) > SKILL_HUB_ARTIFACT_MANIFEST_MAX_BYTES) {
    throw new TypeError("Skill Hub artifact manifest exceeds the canonical JSON byte limit.");
  }
}

export function assertSkillHubBoundedMetadata(
  value: unknown,
  label = "operation result",
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Skill Hub ${label} must be an object.`);
  }
  const counter = { entries: 0 };
  inspectMetadata(value, 0, counter, label);
  if (utf8Bytes(canonicalJsonString(value)) > SKILL_HUB_OPERATION_METADATA_MAX_BYTES) {
    throw new TypeError(`Skill Hub ${label} exceeds the canonical JSON byte limit.`);
  }
}

export function assertSkillHubSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Skill Hub ${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertSkillHubArtifactPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\\")) {
    throw new TypeError("Skill Hub artifact manifest contains an invalid path.");
  }
  if (
    value.startsWith("/") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`Skill Hub artifact manifest path escapes its root: ${value}`);
  }
  if (value === "source.json" || value === ".git" || value.startsWith(".git/")) {
    throw new TypeError(`Skill Hub artifact manifest contains an excluded path: ${value}`);
  }
  if (utf8Bytes(value) > 4_096) {
    throw new TypeError("Skill Hub artifact manifest contains an oversized path.");
  }
}

function inspectMetadata(value: unknown, depth: number, counter: { entries: number }, label: string): void {
  if (depth > 6) throw new TypeError(`Skill Hub ${label} exceeds the nesting depth limit.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Skill Hub ${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_048) throw new TypeError(`Skill Hub ${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    counter.entries += value.length;
    assertMetadataEntryBudget(counter, label);
    for (const item of value) inspectMetadata(item, depth + 1, counter, label);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`Skill Hub ${label} contains an unsupported value.`);
  }
  const entries = Object.entries(value);
  counter.entries += entries.length;
  assertMetadataEntryBudget(counter, label);
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError(`Skill Hub ${label} contains an invalid key.`);
    }
    inspectMetadata(item, depth + 1, counter, label);
  }
}

function assertMetadataEntryBudget(counter: { entries: number }, label: string): void {
  if (counter.entries > 128) throw new TypeError(`Skill Hub ${label} exceeds the entry limit.`);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

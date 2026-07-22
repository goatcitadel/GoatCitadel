import { createHash } from "node:crypto";
import {
  CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION,
  CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION,
  CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REFS,
  CHAT_ROUTED_CONTEXT_MAX_SNAPSHOT_BYTES,
  CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION,
  NotFoundError,
  canonicalJsonString,
  type ChatRoutedContextInspection,
  type ChatRoutedContextSnapshotRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_KEYS = [
  "snapshotId",
  "schemaVersion",
  "turnId",
  "sessionId",
  "workspaceId",
  "capabilityProfileId",
  "capabilityProfileHash",
  "sourceRequestHash",
  "contentHash",
  "snapshotHash",
  "budget",
  "entries",
  "contextText",
  "createdAt",
] as const;
const BUDGET_KEYS = [
  "effectiveProviderId",
  "effectiveModel",
  "contextWindowTokens",
  "promptReservedTokens",
  "outputReservedTokens",
  "hardCapTokens",
  "effectiveBudgetTokens",
  "usedTokens",
  "usedBytes",
  "estimatorVersion",
  "budgetPolicyVersion",
] as const;
const ENTRY_KEYS = [
  "index",
  "kind",
  "ref",
  "label",
  "disposition",
  "sourceScope",
  "sourceWorkspaceId",
  "sourceVersion",
  "sourceHash",
  "externalProvenance",
  "originalBytes",
  "originalTokens",
  "admittedBytes",
  "admittedTokens",
  "truncated",
  "admittedText",
] as const;
const EXTERNAL_PROVENANCE_KEYS = [
  "sourceId",
  "importId",
  "itemId",
  "attachmentId",
  "attachmentRevision",
  "normalizedArtifactSha256",
] as const;

interface RoutedContextSnapshotRow {
  snapshot_id: string;
  schema_version: string;
  turn_id: string;
  session_id: string;
  workspace_id: string;
  capability_profile_id: string;
  capability_profile_hash: string;
  source_request_hash: string;
  content_hash: string;
  snapshot_hash: string;
  effective_provider_id: string;
  effective_model: string;
  context_window_tokens: number;
  prompt_reserved_tokens: number;
  output_reserved_tokens: number;
  hard_cap_tokens: number;
  effective_budget_tokens: number;
  used_tokens: number;
  source_count: number;
  included_count: number;
  truncated_count: number;
  omitted_count: number;
  already_attached_count: number;
  estimator_version: string;
  budget_policy_version: string;
  snapshot_json: string;
  created_at: string;
}

export type ChatRoutedContextSnapshotDraft = Omit<ChatRoutedContextSnapshotRecord, "snapshotHash">;

export class RoutedContextSnapshotRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly findByTurnStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_routed_context_snapshots (
        snapshot_id, schema_version, turn_id, session_id, workspace_id,
        capability_profile_id, capability_profile_hash, source_request_hash,
        content_hash, snapshot_hash, effective_provider_id, effective_model,
        context_window_tokens, prompt_reserved_tokens, output_reserved_tokens,
        hard_cap_tokens, effective_budget_tokens, used_tokens, source_count,
        included_count, truncated_count, omitted_count, already_attached_count,
        estimator_version, budget_policy_version, snapshot_json, created_at
      ) VALUES (
        @snapshotId, @schemaVersion, @turnId, @sessionId, @workspaceId,
        @capabilityProfileId, @capabilityProfileHash, @sourceRequestHash,
        @contentHash, @snapshotHash, @effectiveProviderId, @effectiveModel,
        @contextWindowTokens, @promptReservedTokens, @outputReservedTokens,
        @hardCapTokens, @effectiveBudgetTokens, @usedTokens, @sourceCount,
        @includedCount, @truncatedCount, @omittedCount, @alreadyAttachedCount,
        @estimatorVersion, @budgetPolicyVersion, @snapshotJson, @createdAt
      ) ON CONFLICT(snapshot_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM chat_routed_context_snapshots WHERE snapshot_id = ?");
    this.findByTurnStmt = db.prepare("SELECT * FROM chat_routed_context_snapshots WHERE turn_id = ?");
  }

  public create(input: ChatRoutedContextSnapshotRecord): ChatRoutedContextSnapshotRecord {
    verifyChatRoutedContextSnapshot(input);
    const snapshotJson = canonicalJsonString(input);
    if (Buffer.byteLength(snapshotJson, "utf8") > CHAT_ROUTED_CONTEXT_MAX_SNAPSHOT_BYTES) {
      throw new Error(`Routed context snapshot ${input.snapshotId} exceeds the immutable storage limit.`);
    }
    const counts = countDispositions(input);
    this.insertStmt.run({
      snapshotId: input.snapshotId,
      schemaVersion: input.schemaVersion,
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      capabilityProfileId: input.capabilityProfileId,
      capabilityProfileHash: input.capabilityProfileHash,
      sourceRequestHash: input.sourceRequestHash,
      contentHash: input.contentHash,
      snapshotHash: input.snapshotHash,
      effectiveProviderId: input.budget.effectiveProviderId,
      effectiveModel: input.budget.effectiveModel,
      contextWindowTokens: input.budget.contextWindowTokens,
      promptReservedTokens: input.budget.promptReservedTokens,
      outputReservedTokens: input.budget.outputReservedTokens,
      hardCapTokens: input.budget.hardCapTokens,
      effectiveBudgetTokens: input.budget.effectiveBudgetTokens,
      usedTokens: input.budget.usedTokens,
      sourceCount: input.entries.length,
      ...counts,
      estimatorVersion: input.budget.estimatorVersion,
      budgetPolicyVersion: input.budget.budgetPolicyVersion,
      snapshotJson,
      createdAt: input.createdAt,
    });
    const stored = this.get(input.snapshotId);
    if (canonicalJsonString(stored) !== snapshotJson) {
      throw new Error(`Routed context snapshot ${input.snapshotId} conflicts with an existing immutable record.`);
    }
    return stored;
  }

  public get(snapshotId: string): ChatRoutedContextSnapshotRecord {
    const row = toRow(this.getStmt.get(snapshotId));
    if (!row) {
      throw new NotFoundError({ entity: "chat routed context snapshot", id: snapshotId });
    }
    return mapVerifiedRow(row);
  }

  public findByTurn(turnId: string): ChatRoutedContextSnapshotRecord | undefined {
    const row = toRow(this.findByTurnStmt.get(turnId));
    return row ? mapVerifiedRow(row) : undefined;
  }

  public inspectByTurn(turnId: string): ChatRoutedContextInspection | undefined {
    const snapshot = this.findByTurn(turnId);
    return snapshot ? projectChatRoutedContextInspection(snapshot) : undefined;
  }
}

export function sealChatRoutedContextSnapshot(draft: ChatRoutedContextSnapshotDraft): ChatRoutedContextSnapshotRecord {
  return { ...draft, snapshotHash: digest(buildSnapshotHashPayload(draft)) };
}

export function rebindChatRoutedContextSnapshot(
  snapshot: ChatRoutedContextSnapshotRecord,
  binding: { profileId: string; profileHash: string },
): ChatRoutedContextSnapshotRecord {
  const { snapshotHash: _snapshotHash, ...draft } = snapshot;
  return sealChatRoutedContextSnapshot({
    ...draft,
    capabilityProfileId: binding.profileId,
    capabilityProfileHash: binding.profileHash,
  });
}

export function verifyChatRoutedContextSnapshot(input: ChatRoutedContextSnapshotRecord): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.entries)) {
    throw new Error("Routed context snapshot is malformed.");
  }
  assertExactKeys(input, SNAPSHOT_KEYS, "snapshot");
  if (!input.budget || typeof input.budget !== "object" || Array.isArray(input.budget)) {
    throw new Error(`Routed context snapshot ${String(input.snapshotId)} has a malformed budget.`);
  }
  assertExactKeys(input.budget, BUDGET_KEYS, "budget");
  assertBoundedIdentifier(input.snapshotId, "snapshotId", 256);
  assertBoundedIdentifier(input.turnId, "turnId", 256);
  assertBoundedIdentifier(input.sessionId, "sessionId", 256);
  assertBoundedIdentifier(input.workspaceId, "workspaceId", 80);
  assertBoundedIdentifier(input.capabilityProfileId, "capabilityProfileId", 256);
  assertBoundedIdentifier(input.budget.effectiveProviderId, "effectiveProviderId", 128);
  assertBoundedIdentifier(input.budget.effectiveModel, "effectiveModel", 256);
  if (input.schemaVersion !== CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has an unsupported schema version.`);
  }
  if (
    typeof input.createdAt !== "string" ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has invalid creation evidence.`);
  }
  for (const [field, value] of [
    ["capabilityProfileHash", input.capabilityProfileHash],
    ["sourceRequestHash", input.sourceRequestHash],
    ["contentHash", input.contentHash],
    ["snapshotHash", input.snapshotHash],
  ] as const) {
    if (!SHA256.test(value)) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has an invalid ${field}.`);
    }
  }
  if (input.budget.estimatorVersion !== CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has an unsupported estimator.`);
  }
  if (input.budget.budgetPolicyVersion !== CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has an unsupported budget policy.`);
  }
  const integers = [
    input.budget.contextWindowTokens,
    input.budget.promptReservedTokens,
    input.budget.outputReservedTokens,
    input.budget.hardCapTokens,
    input.budget.effectiveBudgetTokens,
    input.budget.usedTokens,
    input.budget.usedBytes,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Routed context snapshot ${input.snapshotId} contains an invalid budget value.`);
  }
  if (
    input.budget.contextWindowTokens <= 0 ||
    input.budget.outputReservedTokens <= 0 ||
    input.budget.hardCapTokens <= 0 ||
    input.budget.effectiveBudgetTokens > input.budget.hardCapTokens ||
    input.budget.usedTokens > input.budget.effectiveBudgetTokens ||
    input.budget.promptReservedTokens + input.budget.outputReservedTokens > input.budget.contextWindowTokens ||
    input.budget.usedTokens + input.budget.promptReservedTokens + input.budget.outputReservedTokens >
      input.budget.contextWindowTokens
  ) {
    throw new Error(`Routed context snapshot ${input.snapshotId} violates its governed context budget.`);
  }
  if (input.entries.length > CHAT_ROUTED_CONTEXT_MAX_REFS) {
    throw new Error(`Routed context snapshot ${input.snapshotId} contains too many references.`);
  }
  input.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has a malformed entry.`);
    }
    assertExactKeys(entry, ENTRY_KEYS, `entry ${index}`, new Set(["sourceWorkspaceId", "externalProvenance"]));
    if (entry.index !== index) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has unstable reference ordering.`);
    }
    if (
      typeof entry.ref !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.sourceVersion !== "string" ||
      typeof entry.sourceHash !== "string" ||
      typeof entry.admittedText !== "string"
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has malformed entry fields.`);
    }
    assertBoundedIdentifier(entry.ref, `entries[${index}].ref`, CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH);
    if (entry.kind !== "attachment" && entry.kind !== "memory_item" && entry.kind !== "external_attachment") {
      throw new Error(`Routed context snapshot ${input.snapshotId} has an invalid entry kind.`);
    }
    assertEntryExternalProvenance(input.snapshotId, entry);
    if (
      entry.disposition !== "included" &&
      entry.disposition !== "truncated" &&
      entry.disposition !== "omitted" &&
      entry.disposition !== "already_attached"
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has an invalid entry disposition.`);
    }
    if (entry.sourceScope !== "workspace" && entry.sourceScope !== "global") {
      throw new Error(`Routed context snapshot ${input.snapshotId} has an invalid source scope.`);
    }
    if (
      !entry.label.trim() ||
      entry.label !== entry.label.trim() ||
      entry.label.length > CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has an invalid entry label.`);
    }
    if (
      !SHA256.test(entry.sourceHash) ||
      !entry.sourceVersion.trim() ||
      entry.sourceVersion !== entry.sourceVersion.trim() ||
      entry.sourceVersion.length > 256
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has invalid source provenance.`);
    }
    for (const value of [entry.originalBytes, entry.originalTokens, entry.admittedBytes, entry.admittedTokens]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Routed context snapshot ${input.snapshotId} has invalid entry accounting.`);
      }
    }
    if (Buffer.byteLength(entry.admittedText, "utf8") !== entry.admittedBytes) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has mismatched admitted bytes.`);
    }
    if (entry.originalBytes < entry.admittedBytes || entry.originalTokens < entry.admittedTokens) {
      throw new Error(`Routed context snapshot ${input.snapshotId} admits more context than its source.`);
    }
    if ((entry.disposition === "omitted" || entry.disposition === "already_attached") && entry.admittedText) {
      throw new Error(`Routed context snapshot ${input.snapshotId} contains text for an omitted entry.`);
    }
    if ((entry.disposition === "included" || entry.disposition === "truncated") && !entry.admittedText) {
      throw new Error(`Routed context snapshot ${input.snapshotId} is missing admitted entry text.`);
    }
    if ((entry.disposition === "truncated") !== entry.truncated) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has inconsistent truncation evidence.`);
    }
    if (
      entry.disposition === "included" &&
      (entry.originalBytes !== entry.admittedBytes || entry.originalTokens !== entry.admittedTokens)
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has incomplete included-entry accounting.`);
    }
    if (
      entry.disposition === "truncated" &&
      (entry.originalBytes <= entry.admittedBytes || entry.originalTokens <= entry.admittedTokens)
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has non-reducing truncation evidence.`);
    }
    if (
      (entry.disposition === "omitted" || entry.disposition === "already_attached") &&
      (entry.admittedBytes !== 0 || entry.admittedTokens !== 0)
    ) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has non-zero omitted-entry accounting.`);
    }
    if (entry.sourceScope === "workspace" && entry.sourceWorkspaceId !== input.workspaceId) {
      throw new Error(`Routed context snapshot ${input.snapshotId} contains foreign workspace provenance.`);
    }
    if (entry.sourceWorkspaceId !== undefined && entry.sourceWorkspaceId.length > 80) {
      throw new Error(`Routed context snapshot ${input.snapshotId} has oversized workspace provenance.`);
    }
    if (entry.sourceScope === "global" && entry.sourceWorkspaceId !== undefined) {
      throw new Error(`Routed context snapshot ${input.snapshotId} contains malformed global provenance.`);
    }
  });
  const expectedSourceRequestHash = digest(input.entries.map(({ kind, ref }) => ({ kind, ref })));
  if (input.sourceRequestHash !== expectedSourceRequestHash) {
    throw new Error(`Routed context snapshot ${input.snapshotId} failed source request hash verification.`);
  }
  if (typeof input.contextText !== "string") {
    throw new Error(`Routed context snapshot ${input.snapshotId} has malformed context bytes.`);
  }
  if (Buffer.byteLength(input.contextText, "utf8") !== input.budget.usedBytes) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has mismatched context bytes.`);
  }
  if (input.entries.reduce((sum, entry) => sum + entry.admittedTokens, 0) > input.budget.usedTokens) {
    throw new Error(`Routed context snapshot ${input.snapshotId} has impossible entry token accounting.`);
  }
  if (digestText(input.contextText) !== input.contentHash) {
    throw new Error(`Routed context snapshot ${input.snapshotId} failed content hash verification.`);
  }
  if (input.contextText !== renderChatRoutedContextEntries(input.entries)) {
    throw new Error(`Routed context snapshot ${input.snapshotId} failed deterministic context reconstruction.`);
  }
  const expectedHash = digest(buildSnapshotHashPayload(input));
  if (expectedHash !== input.snapshotHash) {
    throw new Error(`Routed context snapshot ${input.snapshotId} failed snapshot hash verification.`);
  }
}

export function projectChatRoutedContextInspection(
  input: ChatRoutedContextSnapshotRecord,
): ChatRoutedContextInspection {
  verifyChatRoutedContextSnapshot(input);
  const counts = countDispositions(input);
  return {
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
    sourceRequestHash: input.sourceRequestHash,
    contentHash: input.contentHash,
    ...counts,
    budget: input.budget,
    entries: input.entries.map(
      ({ admittedText: _admittedText, originalTokens: _originalTokens, truncated: _truncated, ...entry }) => entry,
    ),
  };
}

export function renderChatRoutedContextEntries(entries: ChatRoutedContextSnapshotRecord["entries"]): string {
  const admitted = entries.filter((entry) => entry.disposition === "included" || entry.disposition === "truncated");
  if (admitted.length === 0) {
    return "";
  }
  return [
    "Routed context snapshot (immutable). Use only the admitted bytes below; provenance is operator-inspectable.",
    ...admitted.map((entry) => `[${entry.index + 1}:${entry.kind}]\n${entry.admittedText}`),
  ].join("\n\n");
}

function mapVerifiedRow(row: RoutedContextSnapshotRow): ChatRoutedContextSnapshotRecord {
  const parsed = safeJsonParse<ChatRoutedContextSnapshotRecord | undefined>(row.snapshot_json, undefined);
  if (!parsed) {
    throw new Error(`Routed context snapshot ${row.snapshot_id} contains invalid JSON.`);
  }
  verifyChatRoutedContextSnapshot(parsed);
  const counts = countDispositions(parsed);
  const expected = {
    snapshot_id: parsed.snapshotId,
    schema_version: parsed.schemaVersion,
    turn_id: parsed.turnId,
    session_id: parsed.sessionId,
    workspace_id: parsed.workspaceId,
    capability_profile_id: parsed.capabilityProfileId,
    capability_profile_hash: parsed.capabilityProfileHash,
    source_request_hash: parsed.sourceRequestHash,
    content_hash: parsed.contentHash,
    snapshot_hash: parsed.snapshotHash,
    effective_provider_id: parsed.budget.effectiveProviderId,
    effective_model: parsed.budget.effectiveModel,
    context_window_tokens: parsed.budget.contextWindowTokens,
    prompt_reserved_tokens: parsed.budget.promptReservedTokens,
    output_reserved_tokens: parsed.budget.outputReservedTokens,
    hard_cap_tokens: parsed.budget.hardCapTokens,
    effective_budget_tokens: parsed.budget.effectiveBudgetTokens,
    used_tokens: parsed.budget.usedTokens,
    source_count: parsed.entries.length,
    estimator_version: parsed.budget.estimatorVersion,
    budget_policy_version: parsed.budget.budgetPolicyVersion,
    created_at: parsed.createdAt,
    ...snakeCounts(counts),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (row[key as keyof RoutedContextSnapshotRow] !== value) {
      throw new Error(`Routed context snapshot ${row.snapshot_id} failed indexed-column verification.`);
    }
  }
  return parsed;
}

function countDispositions(input: ChatRoutedContextSnapshotRecord) {
  return {
    includedCount: input.entries.filter((entry) => entry.disposition === "included").length,
    truncatedCount: input.entries.filter((entry) => entry.disposition === "truncated").length,
    omittedCount: input.entries.filter((entry) => entry.disposition === "omitted").length,
    alreadyAttachedCount: input.entries.filter((entry) => entry.disposition === "already_attached").length,
  };
}

function snakeCounts(counts: ReturnType<typeof countDispositions>) {
  return {
    included_count: counts.includedCount,
    truncated_count: counts.truncatedCount,
    omitted_count: counts.omittedCount,
    already_attached_count: counts.alreadyAttachedCount,
  };
}

function assertBoundedIdentifier(value: string, field: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`Routed context ${field} is invalid.`);
  }
}

/**
 * External entries freeze exact managed-artifact bytes: provenance is required,
 * hash-bound to the admitted bytes, and truncation is never a legal state.
 */
function assertEntryExternalProvenance(
  snapshotId: string,
  entry: ChatRoutedContextSnapshotRecord["entries"][number],
): void {
  if (entry.kind !== "external_attachment") {
    if (entry.externalProvenance !== undefined) {
      throw new Error(`Routed context snapshot ${snapshotId} carries external provenance on an internal entry.`);
    }
    return;
  }
  const provenance = entry.externalProvenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error(`Routed context snapshot ${snapshotId} is missing external provenance.`);
  }
  assertExactKeys(provenance, EXTERNAL_PROVENANCE_KEYS, `entry ${entry.index} external provenance`);
  assertBoundedIdentifier(provenance.sourceId, `entries[${entry.index}].externalProvenance.sourceId`, 256);
  assertBoundedIdentifier(provenance.importId, `entries[${entry.index}].externalProvenance.importId`, 256);
  assertBoundedIdentifier(provenance.itemId, `entries[${entry.index}].externalProvenance.itemId`, 256);
  assertBoundedIdentifier(provenance.attachmentId, `entries[${entry.index}].externalProvenance.attachmentId`, 256);
  if (!Number.isSafeInteger(provenance.attachmentRevision) || provenance.attachmentRevision < 1) {
    throw new Error(`Routed context snapshot ${snapshotId} has an invalid external attachment revision.`);
  }
  if (!SHA256.test(provenance.normalizedArtifactSha256)) {
    throw new Error(`Routed context snapshot ${snapshotId} has an invalid external artifact hash.`);
  }
  if (provenance.attachmentId !== entry.ref) {
    throw new Error(`Routed context snapshot ${snapshotId} external provenance does not bind its reference.`);
  }
  if (provenance.normalizedArtifactSha256 !== entry.sourceHash) {
    throw new Error(`Routed context snapshot ${snapshotId} external provenance does not bind its source hash.`);
  }
  if (entry.sourceScope !== "workspace") {
    throw new Error(`Routed context snapshot ${snapshotId} external entry must carry workspace provenance.`);
  }
  if (entry.disposition === "truncated" || entry.disposition === "already_attached") {
    throw new Error(`Routed context snapshot ${snapshotId} external entry admits non-exact external bytes.`);
  }
}

function digest(value: unknown): string {
  return digestText(canonicalJsonString(value));
}

function assertExactKeys(value: object, allowed: readonly string[], label: string, optional = new Set<string>()): void {
  const actual = Object.keys(value);
  const allowedSet = new Set(allowed);
  if (actual.some((key) => !allowedSet.has(key))) {
    throw new Error(`Routed context ${label} contains unsupported fields.`);
  }
  if (allowed.some((key) => !optional.has(key) && !actual.includes(key))) {
    throw new Error(`Routed context ${label} is missing required fields.`);
  }
}

function buildSnapshotHashPayload(
  input: ChatRoutedContextSnapshotDraft | ChatRoutedContextSnapshotRecord,
): Omit<ChatRoutedContextSnapshotDraft, "snapshotId" | "createdAt"> {
  const {
    snapshotHash: _snapshotHash,
    snapshotId: _snapshotId,
    createdAt: _createdAt,
    ...semantic
  } = {
    ...input,
    snapshotHash: "snapshotHash" in input ? input.snapshotHash : undefined,
  };
  return semantic;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toRow(value: unknown): RoutedContextSnapshotRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as RoutedContextSnapshotRow;
}

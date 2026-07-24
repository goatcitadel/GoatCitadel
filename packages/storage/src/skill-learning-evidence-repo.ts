import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  isSkillCorrectionProvenanceV1,
} from "@goatcitadel/contracts";
import type { SkillCorrectionProvenanceV1 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export type SkillLearningPoisoningStatus = "clean" | "blocked" | "quarantined" | "conflicting";
export type SkillLearningSourceKind = "chat_turn" | "library_text";
export const SKILL_LEARNING_ARTIFACT_MAX_BYTES = 16_777_216 as const;
export const SKILL_LEARNING_RECURRENCE_MAX_ROWS = 10_000 as const;

export interface SkillLearningArtifactRef {
  artifactId: string;
  sha256: string;
  bytes: number;
}

export type SkillLearningCorrectionProvenance = SkillCorrectionProvenanceV1;

export interface SkillLearningEvidenceRecord {
  evidenceId: string;
  idempotencyKey: string;
  workspaceId: string;
  targetKey: string;
  fingerprint: string;
  sourceKind: SkillLearningSourceKind;
  sourceSessionId?: string;
  sourceTurnId?: string;
  sourceMessageId?: string;
  correctionActionId: string;
  actorId: string;
  sourceSha256: string;
  correctionSha256: string;
  sourceArtifact?: SkillLearningArtifactRef;
  correctionArtifact?: SkillLearningArtifactRef;
  provenance: SkillLearningCorrectionProvenance;
  poisoningStatus: SkillLearningPoisoningStatus;
  blockerCodes: string[];
  createdAt: string;
}

export interface SkillLearningRecurrenceSummary {
  workspaceId: string;
  targetKey: string;
  fingerprint: string;
  distinctSessionCount: number;
  hasConflictingFingerprint: boolean;
  hasNonCleanEvidence: boolean;
  minimumDistinctSessions: number;
  automaticStagingEligible: boolean;
}

export interface CandidateSkillEvidenceLinkRecord {
  versionId: string;
  evidenceId: string;
  linkedAt: string;
}

interface SkillLearningEvidenceRow {
  evidence_id: string;
  idempotency_key: string;
  workspace_id: string;
  target_key: string;
  fingerprint: string;
  source_kind: SkillLearningSourceKind;
  source_session_id: string | null;
  source_turn_id: string | null;
  source_message_id: string | null;
  correction_action_id: string;
  actor_id: string;
  source_sha256: string;
  correction_sha256: string;
  source_artifact_json: string | null;
  correction_artifact_json: string | null;
  provenance_json: string;
  poisoning_status: SkillLearningPoisoningStatus;
  blocker_codes_json: string;
  created_at: string;
}

interface CandidateSkillEvidenceLinkRow {
  version_id: string;
  evidence_id: string;
  linked_at: string;
}

export class SkillLearningEvidenceRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByIdempotencyKeyStmt;
  private readonly listByFingerprintStmt;
  private readonly listTargetEvidenceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO skill_learning_evidence (
        evidence_id, idempotency_key, workspace_id, target_key, fingerprint, source_kind,
        source_session_id, source_turn_id, source_message_id, correction_action_id, actor_id,
        source_sha256, correction_sha256, source_artifact_json, correction_artifact_json,
        provenance_json, poisoning_status, blocker_codes_json, created_at
      ) VALUES (
        @evidenceId, @idempotencyKey, @workspaceId, @targetKey, @fingerprint, @sourceKind,
        @sourceSessionId, @sourceTurnId, @sourceMessageId, @correctionActionId, @actorId,
        @sourceSha256, @correctionSha256, @sourceArtifactJson, @correctionArtifactJson,
        @provenanceJson, @poisoningStatus, @blockerCodesJson, @createdAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM skill_learning_evidence WHERE evidence_id = ?");
    this.getByIdempotencyKeyStmt = db.prepare("SELECT * FROM skill_learning_evidence WHERE idempotency_key = ?");
    this.listByFingerprintStmt = db.prepare(`
      SELECT * FROM skill_learning_evidence
      WHERE workspace_id = @workspaceId
        AND target_key = @targetKey
        AND fingerprint = @fingerprint
      ORDER BY created_at DESC, evidence_id DESC
      LIMIT @limit
    `);
    this.listTargetEvidenceStmt = db.prepare(`
      SELECT *
      FROM skill_learning_evidence
      WHERE workspace_id = @workspaceId
        AND target_key = @targetKey
      ORDER BY created_at DESC, evidence_id DESC
      LIMIT @limit
    `);
  }

  public create(input: SkillLearningEvidenceRecord): SkillLearningEvidenceRecord {
    validateEvidence(input);
    this.insertStmt.run(toBindings(input));
    const stored = this.findByIdempotencyKey(input.idempotencyKey) ?? this.find(input.evidenceId);
    if (!stored) throw new Error(`Skill learning evidence ${input.evidenceId} was not persisted.`);
    assertImmutableReplay(stored, input);
    return stored;
  }

  public get(evidenceId: string): SkillLearningEvidenceRecord {
    const found = this.find(evidenceId);
    if (!found) throw new NotFoundError({ entity: "skill learning evidence", id: evidenceId });
    return found;
  }

  public find(evidenceId: string): SkillLearningEvidenceRecord | undefined {
    assertCanonicalIdentity(evidenceId, "evidence ID", 256);
    const row = this.getStmt.get(evidenceId) as SkillLearningEvidenceRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public findByIdempotencyKey(idempotencyKey: string): SkillLearningEvidenceRecord | undefined {
    assertCanonicalIdentity(idempotencyKey, "idempotency key", 512);
    const row = this.getByIdempotencyKeyStmt.get(idempotencyKey) as SkillLearningEvidenceRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public listByFingerprint(
    workspaceId: string,
    targetKey: string,
    fingerprint: string,
    limit = 100,
  ): SkillLearningEvidenceRecord[] {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    assertCanonicalIdentity(targetKey, "target key", 256);
    assertSha256(fingerprint, "fingerprint");
    return (
      this.listByFingerprintStmt.all({
        workspaceId,
        targetKey,
        fingerprint,
        limit: normalizeQueryLimit(limit),
      }) as unknown as SkillLearningEvidenceRow[]
    ).map(mapRow);
  }

  public summarizeRecurrence(input: {
    workspaceId: string;
    targetKey: string;
    fingerprint: string;
    minimumDistinctSessions?: number;
  }): SkillLearningRecurrenceSummary {
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
    assertCanonicalIdentity(input.targetKey, "target key", 256);
    assertSha256(input.fingerprint, "fingerprint");
    const minimumDistinctSessions = normalizeMinimumDistinctSessions(input.minimumDistinctSessions);
    const rows = this.listTargetEvidenceStmt.all({
      workspaceId: input.workspaceId,
      targetKey: input.targetKey,
      limit: SKILL_LEARNING_RECURRENCE_MAX_ROWS + 1,
    }) as unknown as SkillLearningEvidenceRow[];
    if (rows.length > SKILL_LEARNING_RECURRENCE_MAX_ROWS) {
      throw new Error(
        `Skill learning recurrence exceeds the ${SKILL_LEARNING_RECURRENCE_MAX_ROWS}-row validation bound.`,
      );
    }
    // One statement supplies a coherent snapshot. Mapping every contributing
    // row also prevents malformed direct-SQL records from silently increasing
    // a recurrence count or hiding a conflict.
    const records = rows.map(mapRow);
    const distinctSessions = new Set(
      records
        .filter(
          (record) =>
            record.fingerprint === input.fingerprint &&
            record.poisoningStatus === "clean" &&
            record.sourceKind === "chat_turn",
        )
        .map((record) => record.sourceSessionId as string),
    );
    const distinctSessionCount = distinctSessions.size;
    const hasConflictingFingerprint = records.some(
      (record) => record.fingerprint !== input.fingerprint && record.poisoningStatus === "clean",
    );
    const hasNonCleanEvidence = records.some(
      (record) => record.fingerprint === input.fingerprint && record.poisoningStatus !== "clean",
    );
    return {
      workspaceId: input.workspaceId,
      targetKey: input.targetKey,
      fingerprint: input.fingerprint,
      distinctSessionCount,
      hasConflictingFingerprint,
      hasNonCleanEvidence,
      minimumDistinctSessions,
      automaticStagingEligible:
        distinctSessionCount >= minimumDistinctSessions && !hasConflictingFingerprint && !hasNonCleanEvidence,
    };
  }
}

export class CandidateSkillEvidenceLinkRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listByVersionStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO candidate_skill_evidence_links (version_id, evidence_id, linked_at)
      VALUES (@versionId, @evidenceId, @linkedAt)
      ON CONFLICT(version_id, evidence_id) DO NOTHING
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM candidate_skill_evidence_links
      WHERE version_id = @versionId AND evidence_id = @evidenceId
    `);
    this.listByVersionStmt = db.prepare(`
      SELECT * FROM candidate_skill_evidence_links
      WHERE version_id = @versionId
      ORDER BY linked_at ASC, evidence_id ASC
      LIMIT @limit
    `);
  }

  public create(input: CandidateSkillEvidenceLinkRecord): CandidateSkillEvidenceLinkRecord {
    validateLink(input);
    this.insertStmt.run(input);
    const stored = this.getStmt.get({
      versionId: input.versionId,
      evidenceId: input.evidenceId,
    }) as CandidateSkillEvidenceLinkRow | undefined;
    if (!stored) throw new Error(`Candidate evidence link ${input.versionId}:${input.evidenceId} was not persisted.`);
    const mapped = mapLinkRow(stored);
    if (canonicalJsonString(mapped) !== canonicalJsonString(input)) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Candidate evidence link ${input.versionId}:${input.evidenceId} conflicts with an immutable record.`,
      });
    }
    return mapped;
  }

  public listByVersion(versionId: string, limit = 100): CandidateSkillEvidenceLinkRecord[] {
    assertBounded(versionId, "candidate version ID", 256);
    return (
      this.listByVersionStmt.all({
        versionId,
        limit: normalizeQueryLimit(limit),
      }) as unknown as CandidateSkillEvidenceLinkRow[]
    ).map(mapLinkRow);
  }
}

export function createSkillLearningFingerprint(input: {
  workspaceId: string;
  targetKey: string;
  title: string;
  correctedBehavior: string;
  permissionEnvelopeSha256: string;
}): string {
  assertSha256(input.permissionEnvelopeSha256, "permission envelope");
  const material = `goatcitadel.skill-learning-fingerprint.v1\u0000${canonicalJsonString({
    version: "goatcitadel.skill-learning-fingerprint.v1",
    workspaceId: normalizeRequired(input.workspaceId, "workspace ID", 256),
    targetKey: normalizeRequired(input.targetKey, "target key", 256),
    normalizedTitle: normalizeTitle(input.title),
    normalizedCorrectedBehavior: normalizeCorrectedBehavior(input.correctedBehavior),
    permissionEnvelopeSha256: input.permissionEnvelopeSha256.toLowerCase(),
  })}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function validateEvidence(input: SkillLearningEvidenceRecord): void {
  assertCanonicalIdentity(input.evidenceId, "evidence ID", 256);
  assertCanonicalIdentity(input.idempotencyKey, "idempotency key", 512);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  assertCanonicalIdentity(input.targetKey, "target key", 256);
  assertSha256(input.fingerprint, "fingerprint");
  assertCanonicalIdentity(input.correctionActionId, "correction action ID", 256);
  assertCanonicalIdentity(input.actorId, "actor ID", 256);
  assertSha256(input.sourceSha256, "source");
  assertSha256(input.correctionSha256, "correction");
  if (input.sourceKind === "chat_turn") {
    assertCanonicalIdentity(input.sourceSessionId, "source session ID", 256);
    assertCanonicalIdentity(input.sourceTurnId, "source turn ID", 256);
    assertCanonicalIdentity(input.sourceMessageId, "source message ID", 256);
  } else if (input.sourceKind !== "library_text") {
    throw new TypeError("Unsupported skill learning source kind.");
  } else if (input.sourceSessionId || input.sourceTurnId || input.sourceMessageId) {
    throw new TypeError("Library learning evidence cannot claim Chat source identity.");
  }
  if (input.sourceArtifact) validateArtifact(input.sourceArtifact);
  if (input.correctionArtifact) validateArtifact(input.correctionArtifact);
  if (input.sourceArtifact && input.sourceArtifact.sha256 !== input.sourceSha256) {
    throw new TypeError("Source artifact hash does not match source evidence hash.");
  }
  if (input.correctionArtifact && input.correctionArtifact.sha256 !== input.correctionSha256) {
    throw new TypeError("Correction artifact hash does not match correction evidence hash.");
  }
  if (
    input.poisoningStatus !== "clean" &&
    input.poisoningStatus !== "blocked" &&
    input.poisoningStatus !== "quarantined" &&
    input.poisoningStatus !== "conflicting"
  ) {
    throw new TypeError("Unsupported skill learning poisoning status.");
  }
  const blockers = normalizeBlockerCodes(input.blockerCodes);
  if (input.poisoningStatus === "clean" && blockers.length > 0) {
    throw new TypeError("Clean skill learning evidence cannot carry blocker codes.");
  }
  if (input.poisoningStatus !== "clean" && blockers.length === 0) {
    throw new TypeError("Non-clean skill learning evidence requires blocker codes.");
  }
  if (blockers.includes("SECRET_LIKE_CONTENT") && (input.sourceArtifact || input.correctionArtifact)) {
    throw new TypeError("Secret-like learning evidence must retain hashes only, never raw artifact references.");
  }
  validateProvenance(input);
  validateTimestamp(input.createdAt, "created-at");
}

function validateProvenance(input: SkillLearningEvidenceRecord): void {
  const provenance = input.provenance;
  const expectedSource =
    input.sourceKind === "chat_turn"
      ? {
          kind: "chat_turn" as const,
          sessionId: input.sourceSessionId as string,
          turnId: input.sourceTurnId as string,
          messageId: input.sourceMessageId as string,
        }
      : { kind: "library_text" as const };
  if (
    !isSkillCorrectionProvenanceV1(provenance) ||
    provenance.correctionActionId !== input.correctionActionId ||
    provenance.actorId !== input.actorId ||
    provenance.workspaceId !== input.workspaceId ||
    canonicalJsonString(provenance.source) !== canonicalJsonString(expectedSource) ||
    provenance.sourceSha256 !== input.sourceSha256 ||
    provenance.correctionSha256 !== input.correctionSha256 ||
    provenance.fingerprint !== input.fingerprint ||
    canonicalJsonString(provenance.sourceArtifact) !== canonicalJsonString(input.sourceArtifact) ||
    canonicalJsonString(provenance.correctionArtifact) !== canonicalJsonString(input.correctionArtifact) ||
    !isCanonicalTimestamp(provenance.capturedAt)
  ) {
    throw new TypeError("Skill learning correction provenance does not match its immutable evidence columns.");
  }
}

function toBindings(input: SkillLearningEvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: input.evidenceId,
    idempotencyKey: input.idempotencyKey,
    workspaceId: input.workspaceId,
    targetKey: input.targetKey,
    fingerprint: input.fingerprint,
    sourceKind: input.sourceKind,
    sourceSessionId: input.sourceSessionId ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    correctionActionId: input.correctionActionId,
    actorId: input.actorId,
    sourceSha256: input.sourceSha256,
    correctionSha256: input.correctionSha256,
    sourceArtifactJson: input.sourceArtifact ? canonicalJsonString(input.sourceArtifact) : null,
    correctionArtifactJson: input.correctionArtifact ? canonicalJsonString(input.correctionArtifact) : null,
    provenanceJson: canonicalJsonString(input.provenance),
    poisoningStatus: input.poisoningStatus,
    blockerCodesJson: canonicalJsonString(normalizeBlockerCodes(input.blockerCodes)),
    createdAt: input.createdAt,
  };
}

function mapRow(row: SkillLearningEvidenceRow): SkillLearningEvidenceRecord {
  const record: SkillLearningEvidenceRecord = {
    evidenceId: row.evidence_id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    targetKey: row.target_key,
    fingerprint: row.fingerprint,
    sourceKind: row.source_kind,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceTurnId: row.source_turn_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    correctionActionId: row.correction_action_id,
    actorId: row.actor_id,
    sourceSha256: row.source_sha256,
    correctionSha256: row.correction_sha256,
    sourceArtifact: parseArtifact(row.source_artifact_json),
    correctionArtifact: parseArtifact(row.correction_artifact_json),
    provenance: parseProvenance(row.provenance_json),
    poisoningStatus: row.poisoning_status,
    blockerCodes: parseBlockers(row.blocker_codes_json),
    createdAt: row.created_at,
  };
  validateEvidence(record);
  return record;
}

function assertImmutableReplay(stored: SkillLearningEvidenceRecord, attempted: SkillLearningEvidenceRecord): void {
  const normalizedAttempt = {
    ...attempted,
    sourceSessionId: attempted.sourceSessionId ?? undefined,
    sourceTurnId: attempted.sourceTurnId ?? undefined,
    sourceMessageId: attempted.sourceMessageId ?? undefined,
    sourceArtifact: attempted.sourceArtifact ?? undefined,
    correctionArtifact: attempted.correctionArtifact ?? undefined,
    blockerCodes: normalizeBlockerCodes(attempted.blockerCodes),
  };
  if (canonicalJsonString(stored) !== canonicalJsonString(normalizedAttempt)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill learning evidence ${attempted.evidenceId} conflicts with an existing immutable record.`,
    });
  }
}

function parseArtifact(value: string | null): SkillLearningArtifactRef | undefined {
  if (!value) return undefined;
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill learning evidence contains malformed artifact JSON.");
  }
  const artifact = parsed as SkillLearningArtifactRef;
  validateArtifact(artifact);
  return artifact;
}

function parseProvenance(value: string): SkillLearningCorrectionProvenance {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill learning evidence contains malformed provenance JSON.");
  }
  return parsed as SkillLearningCorrectionProvenance;
}

function parseBlockers(value: string): string[] {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Skill learning evidence contains malformed blocker JSON.");
  }
  return normalizeBlockerCodes(parsed);
}

function validateArtifact(input: SkillLearningArtifactRef): void {
  assertCanonicalIdentity(input.artifactId, "artifact ID", 256);
  assertSha256(input.sha256, "artifact");
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > SKILL_LEARNING_ARTIFACT_MAX_BYTES) {
    throw new TypeError(`Artifact bytes must be between 0 and ${SKILL_LEARNING_ARTIFACT_MAX_BYTES}.`);
  }
  if (Object.keys(input).some((key) => !new Set(["artifactId", "sha256", "bytes"]).has(key))) {
    throw new TypeError("Learning artifact references may not embed raw content.");
  }
}

function mapLinkRow(row: CandidateSkillEvidenceLinkRow): CandidateSkillEvidenceLinkRecord {
  const record = { versionId: row.version_id, evidenceId: row.evidence_id, linkedAt: row.linked_at };
  validateLink(record);
  return record;
}

function normalizeTitle(value: string): string {
  return normalizeRequired(value, "skill title", 512).replace(/[\t ]+/gu, " ");
}

function normalizeCorrectedBehavior(value: string): string {
  if (typeof value !== "string") throw new TypeError("Corrected behavior must be a string.");
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^(?:\n)+|(?:\n)+$/gu, "");
  if (!normalized.trim() || normalized.length > 100_000) {
    throw new TypeError("Corrected behavior is missing or too long.");
  }
  return normalized;
}

function normalizeRequired(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError(`${label} is missing or too long.`);
  return normalized;
}

function normalizeBlockerCodes(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 64) {
    throw new TypeError("Skill learning blocker codes are bounded to 64 entries.");
  }
  return [
    ...new Set(
      values.map((value) => {
        if (typeof value !== "string") throw new TypeError("Skill learning blocker codes must be strings.");
        const normalized = value.trim();
        if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
          throw new TypeError("Skill learning blocker code is missing, oversized, or invalid.");
        }
        return normalized;
      }),
    ),
  ].sort(compareStrings);
}

function validateLink(input: CandidateSkillEvidenceLinkRecord): void {
  assertCanonicalIdentity(input.versionId, "candidate version ID", 256);
  assertCanonicalIdentity(input.evidenceId, "evidence ID", 256);
  validateTimestamp(input.linkedAt, "linked-at");
}

function validateTimestamp(value: string, label: string): void {
  if (!isCanonicalTimestamp(value)) throw new TypeError(`Skill learning ${label} must be a canonical ISO timestamp.`);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizeMinimumDistinctSessions(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError("Skill learning minimum distinct sessions must be a finite integer.");
  }
  return Math.max(3, Math.min(value, 100));
}

function normalizeQueryLimit(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError("Skill learning query limit must be a finite integer.");
  }
  return Math.max(1, Math.min(value, 500));
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Skill learning ${label} hash must be SHA-256 hex.`);
}

function assertBounded(value: string | undefined, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Skill learning ${label} is missing or too long.`);
  }
}

function assertCanonicalIdentity(value: string | undefined, label: string, maxLength: number): asserts value is string {
  assertBounded(value, label, maxLength);
  if (value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Skill learning ${label} must use its canonical identity form.`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

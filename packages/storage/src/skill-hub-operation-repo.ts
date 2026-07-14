import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_LIFECYCLE_EVIDENCE_EVENT_KIND,
  SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE,
  SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
  SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
  assertSkillHubBoundedMetadata,
  assertSkillHubSha256,
  canonicalJsonString,
  isSkillHubOperationKind,
  isSkillHubOperationSettlementDisposition,
  type SkillHubOperationIntentRecord,
  type SkillHubOperationSettlementRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface SkillHubOperationIntentRow {
  operation_id: string;
  idempotency_key: string;
  workspace_id: string;
  operation_kind: SkillHubOperationIntentRecord["operationKind"];
  approval_id: string;
  snapshot_id: string;
  content_tree_sha256: string;
  skill_id: string;
  target_candidate_id: string | null;
  target_version_id: string | null;
  supersedes_version_id: string | null;
  expected_candidate_revision: number | string | null;
  expected_runtime_revision: number | string | null;
  expected_candidate_absent: number | string;
  expected_runtime_absent: number | string;
  actor_id: string;
  session_id: string | null;
  turn_id: string | null;
  request_sha256: string;
  created_at: string;
}

interface SkillHubOperationSettlementRow {
  settlement_id: string;
  operation_id: string;
  workspace_id: string;
  approval_id: string;
  content_tree_sha256: string;
  disposition: SkillHubOperationSettlementRecord["disposition"];
  observed_tree_sha256: string;
  candidate_version_id: string | null;
  runtime_skill_id: string | null;
  candidate_revision: number | string | null;
  runtime_revision: number | string | null;
  evidence_envelope_id: string;
  journey_event_id: string;
  result_json: string;
  result_sha256: string;
  settled_at: string;
}

interface SkillHubApprovalBindingRow {
  approval_id: string;
  kind: string;
  status: string;
  linkage_json: string | null;
  payload_json: string;
}

interface SkillHubArtifactBindingRow {
  artifact_id: string;
}

interface SkillHubEvidenceBindingRow {
  event_kind: string;
  workspace_id: string | null;
  approval_id: string | null;
  payload_hash: string;
  metadata_json: string;
}

interface SkillHubJourneyBindingRow {
  scope_kind: string;
  workspace_id: string | null;
  event_type: string;
  subject_kind: string;
  subject_id: string;
  action: string;
  actor_type: string;
  approval_id: string | null;
  fingerprint: string | null;
  source_kind: string | null;
  source_id: string | null;
  evidence_refs_json: string;
  provenance_json: string;
  summary_json: string;
}

export class SkillHubOperationRepository {
  private readonly insertIntentStmt;
  private readonly getIntentStmt;
  private readonly findIntentByIdempotencyStmt;
  private readonly findIntentByApprovalStmt;
  private readonly insertSettlementStmt;
  private readonly getSettlementStmt;
  private readonly findSettlementByOperationStmt;
  private readonly getApprovalBindingStmt;
  private readonly getArtifactBindingStmt;
  private readonly getEvidenceBindingStmt;
  private readonly getJourneyBindingStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertIntentStmt = db.prepare(`
      INSERT INTO skill_hub_operation_intents (
        operation_id, idempotency_key, workspace_id, operation_kind, approval_id,
        snapshot_id, content_tree_sha256, skill_id, target_candidate_id, target_version_id,
        supersedes_version_id, expected_candidate_revision, expected_runtime_revision,
        expected_candidate_absent, expected_runtime_absent, actor_id, session_id, turn_id,
        request_sha256, created_at
      ) VALUES (
        @operationId, @idempotencyKey, @workspaceId, @operationKind, @approvalId,
        @snapshotId, @contentTreeSha256, @skillId, @targetCandidateId, @targetVersionId,
        @supersedesVersionId, @expectedCandidateRevision, @expectedRuntimeRevision,
        @expectedCandidateAbsent, @expectedRuntimeAbsent, @actorId, @sessionId, @turnId,
        @requestSha256, @createdAt
      )
      ON CONFLICT(operation_id) DO NOTHING
    `);
    this.getIntentStmt = db.prepare("SELECT * FROM skill_hub_operation_intents WHERE operation_id = ?");
    this.findIntentByIdempotencyStmt = db.prepare(
      "SELECT * FROM skill_hub_operation_intents WHERE idempotency_key = ?",
    );
    this.findIntentByApprovalStmt = db.prepare("SELECT * FROM skill_hub_operation_intents WHERE approval_id = ?");
    this.getApprovalBindingStmt = db.prepare(`
      SELECT approval_id, kind, status, linkage_json, payload_json
      FROM approvals
      WHERE approval_id = ?
    `);
    this.getArtifactBindingStmt = db.prepare(`
      SELECT artifact_id
      FROM skill_hub_snapshot_artifacts
      WHERE workspace_id = @workspaceId
        AND snapshot_id = @snapshotId
        AND content_tree_sha256 = @contentTreeSha256
    `);
    this.getEvidenceBindingStmt = db.prepare(`
      SELECT event_kind, workspace_id, approval_id, payload_hash, metadata_json
      FROM runtime_evidence_envelopes
      WHERE envelope_id = ?
    `);
    this.getJourneyBindingStmt = db.prepare(`
      SELECT scope_kind, workspace_id, event_type, subject_kind, subject_id, action,
        actor_type, approval_id, fingerprint, source_kind, source_id,
        evidence_refs_json, provenance_json, summary_json
      FROM governance_journey_events
      WHERE event_id = ?
    `);
    this.insertSettlementStmt = db.prepare(`
      INSERT INTO skill_hub_operation_settlements (
        settlement_id, operation_id, workspace_id, approval_id, content_tree_sha256,
        disposition, observed_tree_sha256,
        candidate_version_id, runtime_skill_id, candidate_revision, runtime_revision,
        evidence_envelope_id, journey_event_id, result_json, result_sha256, settled_at
      ) VALUES (
        @settlementId, @operationId, @workspaceId, @approvalId, @contentTreeSha256,
        @disposition, @observedTreeSha256,
        @candidateVersionId, @runtimeSkillId, @candidateRevision, @runtimeRevision,
        @evidenceEnvelopeId, @journeyEventId, @resultJson, @resultSha256, @settledAt
      )
      ON CONFLICT(settlement_id) DO NOTHING
    `);
    this.getSettlementStmt = db.prepare("SELECT * FROM skill_hub_operation_settlements WHERE settlement_id = ?");
    this.findSettlementByOperationStmt = db.prepare(
      "SELECT * FROM skill_hub_operation_settlements WHERE operation_id = ?",
    );
  }

  public createIntent(input: SkillHubOperationIntentRecord): SkillHubOperationIntentRecord {
    validateIntent(input);
    this.assertIntentParents(input);
    const existing =
      this.findIntent(input.operationId) ??
      this.findIntentByIdempotencyKey(input.idempotencyKey) ??
      this.findIntentByApprovalId(input.approvalId);
    if (existing) return assertIntentReplay(existing, input);
    try {
      this.insertIntentStmt.run({
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId,
        operationKind: input.operationKind,
        approvalId: input.approvalId,
        snapshotId: input.snapshotId,
        contentTreeSha256: input.contentTreeSha256,
        skillId: input.skillId,
        targetCandidateId: input.targetCandidateId ?? null,
        targetVersionId: input.targetVersionId ?? null,
        supersedesVersionId: input.supersedesVersionId ?? null,
        expectedCandidateRevision: input.expectedCandidateRevision ?? null,
        expectedRuntimeRevision: input.expectedRuntimeRevision ?? null,
        expectedCandidateAbsent: input.expectedCandidateAbsent ? 1 : 0,
        expectedRuntimeAbsent: input.expectedRuntimeAbsent ? 1 : 0,
        actorId: input.actorId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        requestSha256: input.requestSha256,
        createdAt: input.createdAt,
      });
    } catch (error) {
      const raced =
        this.findIntent(input.operationId) ??
        this.findIntentByIdempotencyKey(input.idempotencyKey) ??
        this.findIntentByApprovalId(input.approvalId);
      if (raced) return assertIntentReplay(raced, input);
      throw error;
    }
    return assertIntentReplay(this.getIntent(input.operationId), input);
  }

  public getIntent(operationId: string): SkillHubOperationIntentRecord {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.getIntentStmt.get(operationId) as SkillHubOperationIntentRow | undefined;
    if (!row) throw new NotFoundError({ entity: "Skill Hub operation intent", id: operationId });
    return mapAndValidateIntent(row);
  }

  public findIntent(operationId: string): SkillHubOperationIntentRecord | undefined {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.getIntentStmt.get(operationId) as SkillHubOperationIntentRow | undefined;
    return row ? mapAndValidateIntent(row) : undefined;
  }

  public findIntentByIdempotencyKey(idempotencyKey: string): SkillHubOperationIntentRecord | undefined {
    assertCanonicalIdentity(idempotencyKey, "idempotency key", 512);
    const row = this.findIntentByIdempotencyStmt.get(idempotencyKey) as SkillHubOperationIntentRow | undefined;
    return row ? mapAndValidateIntent(row) : undefined;
  }

  public findIntentByApprovalId(approvalId: string): SkillHubOperationIntentRecord | undefined {
    assertCanonicalIdentity(approvalId, "approval ID", 256);
    const row = this.findIntentByApprovalStmt.get(approvalId) as SkillHubOperationIntentRow | undefined;
    return row ? mapAndValidateIntent(row) : undefined;
  }

  public createSettlement(input: SkillHubOperationSettlementRecord): SkillHubOperationSettlementRecord {
    validateSettlement(input);
    this.assertSettlementParents(input);
    const existing = this.findSettlement(input.settlementId) ?? this.findSettlementByOperationId(input.operationId);
    if (existing) return assertSettlementReplay(existing, input);
    try {
      this.insertSettlementStmt.run({
        settlementId: input.settlementId,
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        contentTreeSha256: input.contentTreeSha256,
        disposition: input.disposition,
        observedTreeSha256: input.observedTreeSha256,
        candidateVersionId: input.candidateVersionId ?? null,
        runtimeSkillId: input.runtimeSkillId ?? null,
        candidateRevision: input.candidateRevision ?? null,
        runtimeRevision: input.runtimeRevision ?? null,
        evidenceEnvelopeId: input.evidenceEnvelopeId,
        journeyEventId: input.journeyEventId,
        resultJson: canonicalJsonString(input.result),
        resultSha256: input.resultSha256,
        settledAt: input.settledAt,
      });
    } catch (error) {
      const raced = this.findSettlement(input.settlementId) ?? this.findSettlementByOperationId(input.operationId);
      if (raced) return assertSettlementReplay(raced, input);
      throw error;
    }
    return assertSettlementReplay(this.getSettlement(input.settlementId), input);
  }

  public getSettlement(settlementId: string): SkillHubOperationSettlementRecord {
    assertCanonicalIdentity(settlementId, "settlement ID", 256);
    const row = this.getSettlementStmt.get(settlementId) as SkillHubOperationSettlementRow | undefined;
    if (!row) throw new NotFoundError({ entity: "Skill Hub operation settlement", id: settlementId });
    return mapAndValidateSettlement(row);
  }

  public findSettlement(settlementId: string): SkillHubOperationSettlementRecord | undefined {
    assertCanonicalIdentity(settlementId, "settlement ID", 256);
    const row = this.getSettlementStmt.get(settlementId) as SkillHubOperationSettlementRow | undefined;
    return row ? mapAndValidateSettlement(row) : undefined;
  }

  public findSettlementByOperationId(operationId: string): SkillHubOperationSettlementRecord | undefined {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.findSettlementByOperationStmt.get(operationId) as SkillHubOperationSettlementRow | undefined;
    return row ? mapAndValidateSettlement(row) : undefined;
  }

  private assertIntentParents(input: SkillHubOperationIntentRecord): void {
    const artifact = this.getArtifactBindingStmt.get({
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      contentTreeSha256: input.contentTreeSha256,
    }) as SkillHubArtifactBindingRow | undefined;
    if (!artifact) {
      throw new TypeError("Skill Hub operation intent is not linked to an artifact in the same workspace.");
    }
    const approval = this.getApprovalBindingStmt.get(input.approvalId) as SkillHubApprovalBindingRow | undefined;
    assertApprovalBinding(approval, input);
  }

  private assertSettlementParents(input: SkillHubOperationSettlementRecord): void {
    const intent = this.getIntent(input.operationId);
    if (
      input.workspaceId !== intent.workspaceId ||
      input.approvalId !== intent.approvalId ||
      input.contentTreeSha256 !== intent.contentTreeSha256
    ) {
      throw new TypeError("Skill Hub settlement identity does not match its immutable operation intent.");
    }
    if (input.disposition === "applied" && input.observedTreeSha256 !== intent.contentTreeSha256) {
      throw new TypeError("Applied Skill Hub settlement must observe the exact intent tree.");
    }
    const artifact = this.getArtifactBindingStmt.get({
      workspaceId: intent.workspaceId,
      snapshotId: intent.snapshotId,
      contentTreeSha256: intent.contentTreeSha256,
    }) as SkillHubArtifactBindingRow | undefined;
    if (!artifact) throw new TypeError("Skill Hub settlement artifact lineage is missing.");
    const approval = this.getApprovalBindingStmt.get(intent.approvalId) as SkillHubApprovalBindingRow | undefined;
    assertApprovalBinding(approval, intent);
    const evidence = this.getEvidenceBindingStmt.get(input.evidenceEnvelopeId) as
      | SkillHubEvidenceBindingRow
      | undefined;
    assertEvidenceBinding(evidence, intent, input);
    const journey = this.getJourneyBindingStmt.get(input.journeyEventId) as SkillHubJourneyBindingRow | undefined;
    assertJourneyBinding(journey, intent, input, artifact.artifact_id);
  }
}

export function computeSkillHubOperationRequestSha256(
  input: Omit<SkillHubOperationIntentRecord, "requestSha256">,
): string {
  // The generated approval ID is the immutable parent linkage. Excluding it
  // lets the exact request be hashed before ApprovalRepository allocates that
  // ID, while createIntent still verifies the one-to-one approval binding.
  const { approvalId: _approvalId, ...request } = input;
  return hashCanonical(request);
}

export function computeSkillHubOperationResultSha256(result: Record<string, unknown>): string {
  assertSkillHubBoundedMetadata(result);
  return hashCanonical(result);
}

function mapAndValidateIntent(row: SkillHubOperationIntentRow): SkillHubOperationIntentRecord {
  const record: SkillHubOperationIntentRecord = {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    operationKind: row.operation_kind,
    approvalId: row.approval_id,
    snapshotId: row.snapshot_id,
    contentTreeSha256: row.content_tree_sha256,
    skillId: row.skill_id,
    targetCandidateId: row.target_candidate_id ?? undefined,
    targetVersionId: row.target_version_id ?? undefined,
    supersedesVersionId: row.supersedes_version_id ?? undefined,
    expectedCandidateRevision: optionalPositiveInteger(row.expected_candidate_revision),
    expectedRuntimeRevision: optionalPositiveInteger(row.expected_runtime_revision),
    expectedCandidateAbsent: Number(row.expected_candidate_absent) === 1,
    expectedRuntimeAbsent: Number(row.expected_runtime_absent) === 1,
    actorId: row.actor_id,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    requestSha256: row.request_sha256,
    createdAt: row.created_at,
  };
  validateIntent(record);
  return record;
}

function mapAndValidateSettlement(row: SkillHubOperationSettlementRow): SkillHubOperationSettlementRecord {
  const record: SkillHubOperationSettlementRecord = {
    settlementId: row.settlement_id,
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    approvalId: row.approval_id,
    contentTreeSha256: row.content_tree_sha256,
    disposition: row.disposition,
    observedTreeSha256: row.observed_tree_sha256,
    candidateVersionId: row.candidate_version_id ?? undefined,
    runtimeSkillId: row.runtime_skill_id ?? undefined,
    candidateRevision: optionalPositiveInteger(row.candidate_revision),
    runtimeRevision: optionalPositiveInteger(row.runtime_revision),
    evidenceEnvelopeId: row.evidence_envelope_id,
    journeyEventId: row.journey_event_id,
    result: safeJsonParse<Record<string, unknown>>(row.result_json, {}),
    resultSha256: row.result_sha256,
    settledAt: row.settled_at,
  };
  validateSettlement(record);
  return record;
}

function validateIntent(input: SkillHubOperationIntentRecord): void {
  assertCanonicalIdentity(input.operationId, "operation ID", 256);
  assertCanonicalIdentity(input.idempotencyKey, "idempotency key", 512);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  if (!isSkillHubOperationKind(input.operationKind)) throw new TypeError("Invalid Skill Hub operation kind.");
  assertCanonicalIdentity(input.approvalId, "approval ID", 256);
  assertCanonicalIdentity(input.snapshotId, "snapshot ID", 256);
  assertSkillHubSha256(input.contentTreeSha256, "content tree");
  assertCanonicalIdentity(input.skillId, "skill ID", 256);
  assertOptionalCanonicalIdentity(input.targetCandidateId, "target candidate ID", 256);
  assertOptionalCanonicalIdentity(input.targetVersionId, "target version ID", 256);
  assertOptionalCanonicalIdentity(input.supersedesVersionId, "superseded version ID", 256);
  assertOptionalPositiveInteger(input.expectedCandidateRevision, "candidate revision");
  assertOptionalPositiveInteger(input.expectedRuntimeRevision, "runtime revision");
  if (!input.targetCandidateId || !input.targetVersionId) {
    throw new TypeError("Skill Hub operation intent requires target candidate and version IDs.");
  }
  if (input.expectedCandidateAbsent !== (input.expectedCandidateRevision === undefined)) {
    throw new TypeError("Skill Hub candidate absence and expected revision are inconsistent.");
  }
  if (input.expectedRuntimeAbsent !== (input.expectedRuntimeRevision === undefined)) {
    throw new TypeError("Skill Hub runtime absence and expected revision are inconsistent.");
  }
  if (input.operationKind === "install_inactive") {
    if (!input.expectedCandidateAbsent || !input.expectedRuntimeAbsent || input.supersedesVersionId) {
      throw new TypeError("Skill Hub inactive install intent has inconsistent expectations.");
    }
  } else if (input.operationKind === "stage_update_candidate" || input.operationKind === "stage_rollback_candidate") {
    if (input.expectedCandidateAbsent || input.expectedRuntimeAbsent || !input.supersedesVersionId) {
      throw new TypeError("Skill Hub update or rollback intent has inconsistent lineage expectations.");
    }
  } else if (input.operationKind === "activate") {
    if (input.expectedCandidateAbsent) throw new TypeError("Skill Hub activation requires an existing candidate.");
  } else if (input.expectedCandidateAbsent || input.expectedRuntimeAbsent) {
    throw new TypeError("Skill Hub revoke requires existing candidate and runtime aggregates.");
  }
  assertCanonicalIdentity(input.actorId, "actor ID", 256);
  assertOptionalCanonicalIdentity(input.sessionId, "session ID", 256);
  assertOptionalCanonicalIdentity(input.turnId, "turn ID", 256);
  if (input.turnId && !input.sessionId) throw new TypeError("Skill Hub turn lineage requires a session ID.");
  assertSkillHubSha256(input.requestSha256, "request");
  const expectedRequestSha256 = computeSkillHubOperationRequestSha256(withoutRequestSha256(input));
  if (expectedRequestSha256 !== input.requestSha256) {
    throw new TypeError("Skill Hub operation request digest does not match its immutable intent.");
  }
  assertCanonicalTimestamp(input.createdAt, "operation created-at");
}

function validateSettlement(input: SkillHubOperationSettlementRecord): void {
  assertCanonicalIdentity(input.settlementId, "settlement ID", 256);
  assertCanonicalIdentity(input.operationId, "operation ID", 256);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  assertCanonicalIdentity(input.approvalId, "approval ID", 256);
  assertSkillHubSha256(input.contentTreeSha256, "content tree");
  if (!isSkillHubOperationSettlementDisposition(input.disposition)) {
    throw new TypeError("Invalid Skill Hub operation settlement disposition.");
  }
  assertSkillHubSha256(input.observedTreeSha256, "observed tree");
  assertOptionalCanonicalIdentity(input.candidateVersionId, "candidate version ID", 256);
  assertOptionalCanonicalIdentity(input.runtimeSkillId, "runtime skill ID", 256);
  assertOptionalPositiveInteger(input.candidateRevision, "candidate revision");
  assertOptionalPositiveInteger(input.runtimeRevision, "runtime revision");
  assertCanonicalIdentity(input.evidenceEnvelopeId, "evidence envelope ID", 256);
  assertCanonicalIdentity(input.journeyEventId, "Journey event ID", 256);
  assertSkillHubBoundedMetadata(input.result);
  assertSkillHubSha256(input.resultSha256, "result");
  if (computeSkillHubOperationResultSha256(input.result) !== input.resultSha256) {
    throw new TypeError("Skill Hub operation result digest does not match canonical JSON.");
  }
  assertCanonicalTimestamp(input.settledAt, "settled-at");
}

function assertApprovalBinding(
  approval: SkillHubApprovalBindingRow | undefined,
  intent: SkillHubOperationIntentRecord,
): void {
  if (!approval) throw new TypeError("Skill Hub operation approval is missing.");
  if (approval.status !== "approved" || approval.kind !== SKILL_HUB_LIFECYCLE_APPROVAL_KIND) {
    throw new TypeError("Skill Hub operation requires an approved dedicated lifecycle approval.");
  }
  const payload = parseRecord(approval.payload_json, "approval payload");
  // ApprovalRepository embeds linkage in payload_json for backward-compatible
  // readers while also persisting canonical linkage_json. It is transport
  // metadata, not part of the dedicated lifecycle payload.
  delete payload.__gcApprovalLinkage;
  const expectedPayload = {
    operationId: intent.operationId,
    requestSha256: intent.requestSha256,
    workspaceId: intent.workspaceId,
    operationKind: intent.operationKind,
    skillId: intent.skillId,
    snapshotId: intent.snapshotId,
    contentTreeSha256: intent.contentTreeSha256,
  };
  assertExactRecord(payload, expectedPayload, "approval payload");
  const linkage = parseRecord(approval.linkage_json, "approval linkage");
  const expectedLinkage: Record<string, string> = { workspaceId: intent.workspaceId };
  if (intent.sessionId) expectedLinkage.sessionId = intent.sessionId;
  if (intent.turnId) expectedLinkage.turnId = intent.turnId;
  assertExactRecord(linkage, expectedLinkage, "approval linkage");
}

function assertEvidenceBinding(
  evidence: SkillHubEvidenceBindingRow | undefined,
  intent: SkillHubOperationIntentRecord,
  settlement: SkillHubOperationSettlementRecord,
): void {
  if (!evidence) throw new TypeError("Skill Hub settlement evidence is missing.");
  if (
    evidence.event_kind !== SKILL_HUB_LIFECYCLE_EVIDENCE_EVENT_KIND ||
    evidence.workspace_id !== intent.workspaceId ||
    evidence.approval_id !== intent.approvalId ||
    evidence.payload_hash !== settlement.resultSha256
  ) {
    throw new TypeError("Skill Hub settlement evidence does not match its operation identity.");
  }
  const metadata = parseRecord(evidence.metadata_json, "evidence metadata");
  assertRecordFields(
    metadata,
    {
      operationId: intent.operationId,
      action: intent.operationKind,
      subjectKind: SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND,
      subjectId: intent.skillId,
      sourceKind: SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND,
      sourceId: intent.snapshotId,
      contentTreeSha256: intent.contentTreeSha256,
      requestSha256: intent.requestSha256,
      resultSha256: settlement.resultSha256,
    },
    "evidence metadata",
  );
}

function assertJourneyBinding(
  journey: SkillHubJourneyBindingRow | undefined,
  intent: SkillHubOperationIntentRecord,
  settlement: SkillHubOperationSettlementRecord,
  artifactId: string,
): void {
  if (!journey) throw new TypeError("Skill Hub settlement Journey event is missing.");
  if (
    journey.scope_kind !== "workspace" ||
    journey.workspace_id !== intent.workspaceId ||
    journey.event_type !== SKILL_HUB_LIFECYCLE_JOURNEY_EVENT_TYPE ||
    journey.subject_kind !== SKILL_HUB_LIFECYCLE_JOURNEY_SUBJECT_KIND ||
    journey.subject_id !== intent.skillId ||
    journey.action !== intent.operationKind ||
    journey.actor_type !== "approval_effect" ||
    journey.approval_id !== intent.approvalId ||
    journey.fingerprint !== intent.requestSha256 ||
    journey.source_kind !== SKILL_HUB_LIFECYCLE_JOURNEY_SOURCE_KIND ||
    journey.source_id !== intent.snapshotId
  ) {
    throw new TypeError("Skill Hub settlement Journey event does not match its operation identity.");
  }
  const refs = safeJsonParse<unknown>(journey.evidence_refs_json, undefined);
  if (
    !Array.isArray(refs) ||
    !hasEvidenceRef(refs, "approval", intent.approvalId) ||
    !hasEvidenceRef(refs, "upstream_snapshot", intent.snapshotId) ||
    !hasEvidenceRef(refs, "artifact", artifactId)
  ) {
    throw new TypeError("Skill Hub settlement Journey evidence references are incomplete.");
  }
  const provenance = parseRecord(journey.provenance_json, "Journey provenance");
  if (provenance.approvalRequired !== true || provenance.sourceRequired !== true) {
    throw new TypeError("Skill Hub settlement Journey provenance must require approval and source evidence.");
  }
  const summary = parseRecord(journey.summary_json, "Journey summary");
  assertRecordFields(
    summary,
    {
      operationId: intent.operationId,
      requestSha256: intent.requestSha256,
      contentTreeSha256: intent.contentTreeSha256,
      resultSha256: settlement.resultSha256,
    },
    "Journey summary",
  );
}

function parseRecord(value: string | null, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new TypeError(`Skill Hub ${label} is missing.`);
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Skill Hub ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function assertRecordFields(record: Record<string, unknown>, expected: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) throw new TypeError(`Skill Hub ${label} does not match ${key}.`);
  }
}

function assertExactRecord(record: Record<string, unknown>, expected: Record<string, unknown>, label: string): void {
  if (canonicalJsonString(record) !== canonicalJsonString(expected)) {
    throw new TypeError(`Skill Hub ${label} must exactly match the dedicated lifecycle binding.`);
  }
}

function hasEvidenceRef(refs: unknown[], owner: string, refId: string): boolean {
  return refs.some(
    (ref) =>
      Boolean(ref) &&
      typeof ref === "object" &&
      !Array.isArray(ref) &&
      (ref as Record<string, unknown>).owner === owner &&
      (ref as Record<string, unknown>).refId === refId,
  );
}

function withoutRequestSha256(
  input: SkillHubOperationIntentRecord,
): Omit<SkillHubOperationIntentRecord, "requestSha256"> {
  const { requestSha256: _requestSha256, ...request } = input;
  return request;
}

function assertIntentReplay(
  stored: SkillHubOperationIntentRecord,
  attempted: SkillHubOperationIntentRecord,
): SkillHubOperationIntentRecord {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill Hub operation intent ${attempted.operationId} conflicts with an immutable record.`,
    });
  }
  return stored;
}

function assertSettlementReplay(
  stored: SkillHubOperationSettlementRecord,
  attempted: SkillHubOperationSettlementRecord,
): SkillHubOperationSettlementRecord {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill Hub operation settlement ${attempted.settlementId} conflicts with an immutable record.`,
    });
  }
  return stored;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function optionalPositiveInteger(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError("Skill Hub stored revision is malformed.");
  }
  return normalized;
}

function assertOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`Skill Hub ${label} must be a positive integer.`);
  }
}

function assertOptionalCanonicalIdentity(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertCanonicalIdentity(value, label, maxLength);
}

function assertCanonicalIdentity(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || !value || value.length > maxLength || value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Skill Hub ${label} must use its bounded canonical identity form.`);
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Skill Hub ${label} must be a canonical ISO timestamp.`);
  }
}

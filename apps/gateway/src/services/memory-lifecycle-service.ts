/* eslint-disable max-lines -- MemoryLifecycleService centralizes memory lifecycle writes, write-gate evidence, and structured memory governance until repository ownership is split. */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ChatTurnTraceRecord,
  DurableRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  MemoryWriteAuthority,
  MemoryChangeEvent,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryDecisionInput,
  MemoryDecisionRecord,
  MemoryDecisionRetrospective,
  MemoryDecisionRetrospectiveInput,
  MemoryEntityInput,
  MemoryEntityRecord,
  MemoryItemRecord,
  MemoryLearningInput,
  MemoryLearningRecord,
  MemoryLearningStalenessIssue,
  MemoryLearningStalenessReport,
  MemoryLearningStatus,
  MemoryLearningType,
  MemoryLifecyclePatch,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemoryRelationInput,
  MemoryRelationRecord,
  MemoryQmdStatsResponse,
  StructuredMemoryAuthority,
  StructuredMemoryScope,
  StructuredMemorySourceRef,
  StructuredMemoryStatus,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import {
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  deriveMemoryItemLifecycleState,
  type BrowserContentGuardResult,
} from "@goatcitadel/contracts";
import { assertWritePathInJail, scanBrowserContentGuard } from "@goatcitadel/policy-engine";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { MemoryContextService } from "./memory-context-service.js";
import { mapMemoryItemRow, recordMemoryChange, requireMemoryItem, type MemoryItemHost } from "./memory-item-helpers.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { normalizeMemoryForgetCriteria } from "./security-utils.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

interface MemoryLifecycleAdminDependencies extends MemoryItemHost {
  requireFeatureEnabled(flag: string): void;
  publishRealtime(channel: string, topic: string, payload: Record<string, unknown>): void;
}

export interface MemoryLifecycleDependencies {
  readonly context: MemoryContextService;
  readonly learned: ChatLearnedMemoryService;
  readonly maintenance: MemoryMaintenanceService;
  readonly admin: MemoryLifecycleAdminDependencies;
  resolveLearnedMemoryPolicy(sessionId: string): {
    allowWrite: boolean;
    memoryMode?: "off" | "auto" | "on";
    reason?: "memory_mode_off" | "replay_scratch" | "allowed";
  };
  readonly files?: {
    rootDir: string;
    workspaceDir: string;
    writeJailRoots: string[];
    normalizeRelativePath(relativePath: string): string;
  };
  readonly writeGate?: MemoryWriteGateService;
  readonly evidence?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
}

/**
 * Canonical coordinator for memory lifecycle policy and operator-facing entry
 * points. Lower-level services remain focused collaborators for context
 * composition, learned-memory persistence, and maintenance execution.
 */
export class MemoryLifecycleService {
  public constructor(private readonly deps: MemoryLifecycleDependencies) {}

  public listMemoryLearnings(
    input: {
      workspaceId?: string;
      status?: MemoryLearningStatus | "all";
      query?: string;
      key?: string;
      limit?: number;
    } = {},
  ): MemoryLearningRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureLearningSchema();
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.key?.trim()) {
      clauses.push("learning_key = @key");
      params.key = input.key.trim();
    }
    if (input.query?.trim()) {
      clauses.push("(LOWER(learning_key) LIKE @query OR LOWER(insight) LIKE @query)");
      params.query = `%${input.query.trim().toLowerCase()}%`;
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_learnings
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryLearningRow[];
    return rows.map((row) => mapLearningRow(this.deps.admin, row));
  }

  public createMemoryLearning(input: MemoryLearningInput, actorId = "operator"): MemoryLearningRecord {
    return this.insertMemoryLearning(input, actorId, input.authority === "agent_proposed" ? "proposed" : "trusted");
  }

  public proposeMemoryLearning(input: MemoryLearningInput, actorId = "agent"): MemoryLearningRecord {
    return this.insertMemoryLearning({ ...input, authority: "agent_proposed" }, actorId, "proposed");
  }

  public supersedeMemoryLearning(
    learningId: string,
    input: MemoryLearningInput,
    actorId = "operator",
  ): { previous: MemoryLearningRecord; next: MemoryLearningRecord } {
    this.ensureLearningSchema();
    const previous = this.requireMemoryLearning(learningId);
    const next = this.insertMemoryLearning(
      {
        ...input,
        workspaceId: input.workspaceId ?? previous.workspaceId,
        key: input.key || previous.key,
      },
      actorId,
      input.authority === "agent_proposed" ? "proposed" : "trusted",
    );
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_learnings
      SET status = 'superseded', superseded_by_id = @nextId, updated_at = @updatedAt
      WHERE learning_id = @learningId
    `,
      )
      .run({ learningId, nextId: next.learningId, updatedAt: now });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_learning_superseded",
      learningId,
      supersededById: next.learningId,
      workspaceId: previous.workspaceId,
    });
    return { previous: this.requireMemoryLearning(learningId), next };
  }

  public forgetMemoryLearning(learningId: string, actorId = "operator"): MemoryLearningRecord {
    this.ensureLearningSchema();
    const current = this.requireMemoryLearning(learningId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_learnings
      SET status = 'forgotten', updated_at = @updatedAt
      WHERE learning_id = @learningId
    `,
      )
      .run({ learningId, updatedAt: now });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_learning_forgotten",
      learningId,
      actorId,
      workspaceId: current.workspaceId,
    });
    return this.requireMemoryLearning(learningId);
  }

  public checkMemoryLearningStaleness(
    input: {
      learningId?: string;
      workspaceId?: string;
      limit?: number;
    } = {},
  ): MemoryLearningStalenessReport {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureLearningSchema();
    const checkedAt = new Date().toISOString();
    const learnings = input.learningId
      ? [this.requireMemoryLearning(input.learningId)]
      : this.listMemoryLearnings({ workspaceId: input.workspaceId, status: "all", limit: input.limit });
    const issues = learnings.flatMap((learning) => this.inspectLearningIssues(learning));
    return { checkedAt, issues };
  }

  public listMemoryEntities(
    input: { workspaceId?: string; status?: StructuredMemoryStatus | "all"; query?: string; limit?: number } = {},
  ): MemoryEntityRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    const query = input.query?.trim().toLowerCase();
    if (query) {
      clauses.push(
        "(LOWER(title) LIKE @query OR LOWER(entity_type) LIKE @query OR LOWER(COALESCE(summary, '')) LIKE @query)",
      );
      params.query = `%${query}%`;
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_entities
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryEntityRow[];
    return rows.map((row) => mapMemoryEntityRow(this.deps.admin, row));
  }

  public createMemoryEntity(input: MemoryEntityInput, actorId = "operator"): MemoryEntityRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const entity: MemoryEntityRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title: requireTrimmedText(input.title, "title"),
      entityType: input.entityType?.trim() || "concept",
      aliases: normalizeStringArray(input.aliases),
      summary: optionalTrimmedText(input.summary),
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata: input.metadata ?? {},
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(entity.authority, serializeStructuredMemoryForGate(entity));
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_entities (
        entity_id, workspace_id, scope, title, entity_type, aliases_json, summary, status, confidence,
        source_refs_json, metadata_json, authority, created_at, updated_at, forgotten_at, superseded_by_id
      ) VALUES (
        @id, @workspaceId, @scope, @title, @entityType, @aliasesJson, @summary, @status, @confidence,
        @sourceRefsJson, @metadataJson, @authority, @createdAt, @updatedAt, NULL, NULL
      )
    `,
      )
      .run({
        id: entity.id,
        workspaceId: entity.workspaceId,
        scope: entity.scope,
        title: entity.title,
        entityType: entity.entityType,
        aliasesJson: JSON.stringify(entity.aliases),
        summary: entity.summary ?? null,
        status: entity.status,
        confidence: entity.confidence,
        sourceRefsJson: JSON.stringify(entity.sourceRefs),
        metadataJson: JSON.stringify(entity.metadata),
        authority: entity.authority,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      });
    this.recordStructuredMemoryChange("entity", entity.id, "created", actorId, { title: entity.title });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_entity_created",
      entityId: entity.id,
      workspaceId: entity.workspaceId,
    });
    return entity;
  }

  public forgetMemoryEntity(entityId: string, actorId = "operator"): MemoryEntityRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = this.requireMemoryEntity(entityId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_entities
      SET status = 'forgotten',
          forgotten_at = @forgottenAt,
          updated_at = @updatedAt
      WHERE entity_id = @entityId
    `,
      )
      .run({ entityId, forgottenAt: now, updatedAt: now });
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_relations
      SET status = 'superseded',
          degraded_reason = @degradedReason,
          updated_at = @updatedAt
      WHERE status = 'active'
        AND (from_entity_id = @entityId OR to_entity_id = @entityId)
    `,
      )
      .run({
        entityId,
        degradedReason: "linked_entity_forgotten",
        updatedAt: now,
      });
    this.recordStructuredMemoryChange("entity", entityId, "forgotten", actorId, { previousStatus: current.status });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_entity_forgotten",
      entityId,
      workspaceId: current.workspaceId,
    });
    return this.requireMemoryEntity(entityId);
  }

  public listMemoryRelations(
    input: { workspaceId?: string; status?: StructuredMemoryStatus | "all"; entityId?: string; limit?: number } = {},
  ): MemoryRelationRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.entityId?.trim()) {
      clauses.push("(from_entity_id = @entityId OR to_entity_id = @entityId)");
      params.entityId = input.entityId.trim();
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_relations
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryRelationRow[];
    return rows.map((row) => mapMemoryRelationRow(this.deps.admin, row));
  }

  public createMemoryRelation(input: MemoryRelationInput, actorId = "operator"): MemoryRelationRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const from = this.requireMemoryEntity(input.fromEntityId);
    const to = this.requireMemoryEntity(input.toEntityId);
    if (from.status !== "active" || to.status !== "active") {
      throw new ValidationError({
        field: "entityId",
        message: "Relations require active source and target entities.",
      });
    }
    const now = new Date().toISOString();
    const relationType = input.relationType.trim() || "related_to";
    const relation: MemoryRelationRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId ?? from.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title: input.title?.trim() || `${from.title} ${relationType} ${to.title}`,
      fromEntityId: from.id,
      toEntityId: to.id,
      relationType,
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata: input.metadata ?? {},
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(relation.authority, serializeStructuredMemoryForGate(relation));
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_relations (
        relation_id, workspace_id, scope, title, from_entity_id, to_entity_id, relation_type, status, confidence,
        source_refs_json, metadata_json, authority, degraded_reason, created_at, updated_at, forgotten_at, superseded_by_id
      ) VALUES (
        @id, @workspaceId, @scope, @title, @fromEntityId, @toEntityId, @relationType, @status, @confidence,
        @sourceRefsJson, @metadataJson, @authority, NULL, @createdAt, @updatedAt, NULL, NULL
      )
    `,
      )
      .run({
        id: relation.id,
        workspaceId: relation.workspaceId,
        scope: relation.scope,
        title: relation.title,
        fromEntityId: relation.fromEntityId,
        toEntityId: relation.toEntityId,
        relationType: relation.relationType,
        status: relation.status,
        confidence: relation.confidence,
        sourceRefsJson: JSON.stringify(relation.sourceRefs),
        metadataJson: JSON.stringify(relation.metadata),
        authority: relation.authority,
        createdAt: relation.createdAt,
        updatedAt: relation.updatedAt,
      });
    this.recordStructuredMemoryChange("relation", relation.id, "created", actorId, { title: relation.title });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_relation_created",
      relationId: relation.id,
      workspaceId: relation.workspaceId,
    });
    return relation;
  }

  public listMemoryDecisions(
    input: {
      workspaceId?: string;
      status?: StructuredMemoryStatus | "all";
      dueForReview?: boolean;
      limit?: number;
    } = {},
  ): MemoryDecisionRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.dueForReview) {
      clauses.push("review_at IS NOT NULL AND review_at <= @now AND status = 'active'");
      params.now = new Date().toISOString();
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(review_at, updated_at) DESC, updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryDecisionRow[];
    return rows.map((row) => mapMemoryDecisionRow(this.deps.admin, row));
  }

  public createMemoryDecision(input: MemoryDecisionInput, actorId = "operator"): MemoryDecisionRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const decisionText = requireTrimmedText(input.decision, "decision");
    const decision: MemoryDecisionRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title: input.title?.trim() || decisionText.slice(0, 120),
      decision: decisionText,
      alternatives: normalizeStringArray(input.alternatives),
      rationale: requireTrimmedText(input.rationale, "rationale"),
      expectedOutcome: optionalTrimmedText(input.expectedOutcome),
      reviewAt: optionalTrimmedText(input.reviewAt),
      linkedEntityIds: normalizeStringArray(input.linkedEntityIds),
      linkedRelationIds: normalizeStringArray(input.linkedRelationIds),
      sessionId: optionalTrimmedText(input.sessionId),
      runId: optionalTrimmedText(input.runId),
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata: input.metadata ?? {},
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(decision.authority, serializeStructuredMemoryForGate(decision));
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_decisions (
        decision_id, workspace_id, scope, title, decision_text, alternatives_json, rationale, expected_outcome,
        review_at, retrospective_json, linked_entity_ids_json, linked_relation_ids_json, session_id, run_id,
        improvement_candidate_id, status, confidence, source_refs_json, metadata_json, authority, created_at,
        updated_at, forgotten_at, superseded_by_id
      ) VALUES (
        @id, @workspaceId, @scope, @title, @decision, @alternativesJson, @rationale, @expectedOutcome,
        @reviewAt, NULL, @linkedEntityIdsJson, @linkedRelationIdsJson, @sessionId, @runId,
        NULL, @status, @confidence, @sourceRefsJson, @metadataJson, @authority, @createdAt,
        @updatedAt, NULL, NULL
      )
    `,
      )
      .run({
        id: decision.id,
        workspaceId: decision.workspaceId,
        scope: decision.scope,
        title: decision.title,
        decision: decision.decision,
        alternativesJson: JSON.stringify(decision.alternatives),
        rationale: decision.rationale,
        expectedOutcome: decision.expectedOutcome ?? null,
        reviewAt: decision.reviewAt ?? null,
        linkedEntityIdsJson: JSON.stringify(decision.linkedEntityIds),
        linkedRelationIdsJson: JSON.stringify(decision.linkedRelationIds),
        sessionId: decision.sessionId ?? null,
        runId: decision.runId ?? null,
        status: decision.status,
        confidence: decision.confidence,
        sourceRefsJson: JSON.stringify(decision.sourceRefs),
        metadataJson: JSON.stringify(decision.metadata),
        authority: decision.authority,
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt,
      });
    this.recordStructuredMemoryChange("decision", decision.id, "created", actorId, { title: decision.title });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_created",
      decisionId: decision.id,
      workspaceId: decision.workspaceId,
    });
    return decision;
  }

  public addMemoryDecisionRetrospective(
    decisionId: string,
    input: MemoryDecisionRetrospectiveInput,
    actorId = "operator",
  ): MemoryDecisionRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = this.requireMemoryDecision(decisionId);
    const now = new Date().toISOString();
    const retrospective: MemoryDecisionRetrospective = {
      reviewedAt: now,
      outcome: input.outcome,
      notes: requireTrimmedText(input.notes, "notes"),
      improvementCandidateId: optionalTrimmedText(input.improvementCandidateId),
    };
    this.assertStructuredMemoryWriteAllowed(
      "operator",
      `${current.title}\n${current.decision}\n${retrospective.outcome}\n${retrospective.notes}`,
    );
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_decisions
      SET retrospective_json = @retrospectiveJson,
          improvement_candidate_id = COALESCE(@improvementCandidateId, improvement_candidate_id),
          updated_at = @updatedAt
      WHERE decision_id = @decisionId
    `,
      )
      .run({
        decisionId,
        retrospectiveJson: JSON.stringify(retrospective),
        improvementCandidateId: retrospective.improvementCandidateId ?? null,
        updatedAt: now,
      });
    this.recordStructuredMemoryChange("decision", decisionId, "retrospective_added", actorId, { ...retrospective });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_retrospective_added",
      decisionId,
      workspaceId: current.workspaceId,
    });
    return this.requireMemoryDecision(decisionId);
  }

  public forgetMemoryDecision(decisionId: string, actorId = "operator"): MemoryDecisionRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = this.requireMemoryDecision(decisionId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_decisions
      SET status = 'forgotten',
          forgotten_at = @forgottenAt,
          updated_at = @updatedAt
      WHERE decision_id = @decisionId
    `,
      )
      .run({ decisionId, forgottenAt: now, updatedAt: now });
    this.recordStructuredMemoryChange("decision", decisionId, "forgotten", actorId, { previousStatus: current.status });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_forgotten",
      decisionId,
      workspaceId: current.workspaceId,
    });
    return this.requireMemoryDecision(decisionId);
  }

  public listStructuredMemoryHistory(
    recordKind: "entity" | "relation" | "decision",
    recordId: string,
    limit = 100,
  ): MemoryChangeEvent[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT change_id, record_id, change_type, actor_id, payload_json, created_at
      FROM memory_structured_change_history
      WHERE record_kind = ? AND record_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(recordKind, recordId, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
      change_id: string;
      record_id: string;
      change_type: MemoryChangeEvent["changeType"];
      actor_id: string | null;
      payload_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      changeId: row.change_id,
      itemId: row.record_id,
      changeType: row.change_type,
      actorId: row.actor_id ?? undefined,
      payload: this.deps.admin.tryParseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  public async listMemoryFiles(relativeDir = "memory"): Promise<MemoryFileEntry[]> {
    if (!this.deps.files) {
      throw new Error("Memory lifecycle file access is not configured.");
    }
    const normalized = this.deps.files.normalizeRelativePath(relativeDir);
    const baseDir = path.resolve(this.deps.files.rootDir, this.deps.files.workspaceDir, normalized);
    assertWritePathInJail(baseDir, this.deps.files.writeJailRoots);

    let entries: Array<{ isFile(): boolean; name: string }>;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files: MemoryFileEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(baseDir, entry.name);
      const stat = await fs.stat(fullPath);
      files.push({
        relativePath: path.posix.join(normalized, entry.name),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    files.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    return files;
  }

  public listMemoryItems(
    input: {
      namespace?: string;
      status?: MemoryItemRecord["status"] | "all";
      query?: string;
      limit?: number;
    } = {},
  ): MemoryItemRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const namespace = input.namespace?.trim();
    const status = input.status && input.status !== "all" ? input.status : undefined;
    const query = input.query?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
    const nowIso = new Date().toISOString();
    const clauses = ["1 = 1"];
    const params: Record<string, string | number | null> = { limit };
    if (namespace) {
      clauses.push("namespace = @namespace");
      params.namespace = namespace;
    }
    if (status) {
      clauses.push("status = @status");
      params.status = status;
      if (status === "active") {
        params.now = nowIso;
        clauses.push("(expires_at IS NULL OR expires_at > @now)");
      }
    }
    if (query) {
      clauses.push(`(
        LOWER(title) LIKE @query
        OR LOWER(content) LIKE @query
        OR LOWER(namespace) LIKE @query
      )`);
      params.query = `%${query}%`;
    }

    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as Array<{
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    }>;

    return rows.map((row) => mapMemoryItemRow(this.deps.admin, row));
  }

  public inspectExpiredActiveMemoryItems(input: { limit?: number; nowIso?: string } = {}): {
    totalCount: number;
    items: MemoryItemRecord[];
  } {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const countRow = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
    `,
      )
      .get({ now: nowIso }) as { count?: number | null } | undefined;
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
      ORDER BY expires_at ASC, updated_at DESC
      LIMIT @limit
    `,
      )
      .all({ now: nowIso, limit }) as Array<{
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    }>;

    return {
      totalCount: Number(countRow?.count ?? 0),
      items: rows.map((row) => mapMemoryItemRow(this.deps.admin, row)),
    };
  }

  public forgetExpiredActiveMemoryItems(input: { limit?: number; nowIso?: string; actorId?: string } = {}): {
    totalCount: number;
    retainedPinnedCount: number;
    remainingUnpinnedCount: number;
    retainedPinnedItems: MemoryItemRecord[];
    forgottenItems: MemoryItemRecord[];
  } {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const ledger = this.inspectExpiredActiveMemoryLedger({ nowIso });
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
        AND pinned = 0
      ORDER BY expires_at ASC, updated_at DESC
      LIMIT @limit
    `,
      )
      .all({ now: nowIso, limit }) as Array<{
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    }>;

    const forgottenItems = rows.map((row) =>
      this.forgetMemoryItemInternal(row.item_id, input.actorId ?? "memory-flush", { requireFeature: false }),
    );
    return {
      totalCount: ledger.totalCount,
      retainedPinnedCount: ledger.retainedPinnedCount,
      remainingUnpinnedCount: Math.max(0, ledger.unpinnedCount - forgottenItems.length),
      retainedPinnedItems: ledger.retainedPinnedItems,
      forgottenItems,
    };
  }

  public inspectExpiredActiveMemoryLedger(input: { nowIso?: string; retainedPinnedLimit?: number } = {}): {
    totalCount: number;
    retainedPinnedCount: number;
    unpinnedCount: number;
    retainedPinnedItems: MemoryItemRecord[];
  } {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const retainedPinnedLimit = Math.max(0, Math.min(25, Math.floor(input.retainedPinnedLimit ?? 10)));
    const countRows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT
        COUNT(*) AS totalCount,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS retainedPinnedCount,
        SUM(CASE WHEN pinned = 0 THEN 1 ELSE 0 END) AS unpinnedCount
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
    `,
      )
      .get({ now: nowIso }) as
      | { totalCount?: number | null; retainedPinnedCount?: number | null; unpinnedCount?: number | null }
      | undefined;
    const retainedRows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
        AND pinned = 1
      ORDER BY expires_at ASC, updated_at DESC
      LIMIT @limit
    `,
      )
      .all({ now: nowIso, limit: retainedPinnedLimit }) as Array<{
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string | null;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: MemoryItemRecord["status"];
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    }>;
    return {
      totalCount: Number(countRows?.totalCount ?? 0),
      retainedPinnedCount: Number(countRows?.retainedPinnedCount ?? 0),
      unpinnedCount: Number(countRows?.unpinnedCount ?? 0),
      retainedPinnedItems: retainedRows.map((row) => mapMemoryItemRow(this.deps.admin, row)),
    };
  }

  public patchMemoryItem(itemId: string, patch: MemoryLifecyclePatch, actorId = "operator"): MemoryItemRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = requireMemoryItem(this.deps.admin, itemId);
    const now = new Date().toISOString();
    const nextTtlOverrideSeconds =
      patch.ttlOverrideSeconds === null
        ? null
        : patch.ttlOverrideSeconds !== undefined
          ? Math.max(1, Math.min(31_536_000, Math.floor(patch.ttlOverrideSeconds)))
          : (current.ttlOverrideSeconds ?? null);
    const nextExpiresAt =
      patch.ttlOverrideSeconds === null
        ? null
        : patch.ttlOverrideSeconds !== undefined
          ? new Date(Date.parse(now) + Number(nextTtlOverrideSeconds) * 1000).toISOString()
          : (current.expiresAt ?? null);
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : current.title,
      content: patch.content !== undefined ? patch.content : current.content,
      metadata: patch.metadata !== undefined ? patch.metadata : current.metadata,
      pinned: patch.pinned !== undefined ? patch.pinned : current.pinned,
      ttlOverrideSeconds: nextTtlOverrideSeconds,
      expiresAt: nextExpiresAt,
    };
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_items
      SET title = @title,
          content = @content,
          metadata_json = @metadataJson,
          pinned = @pinned,
          ttl_override_seconds = @ttlOverrideSeconds,
          expires_at = @expiresAt,
          updated_at = @updatedAt
      WHERE item_id = @itemId
    `,
      )
      .run({
        itemId,
        title: next.title,
        content: next.content,
        metadataJson: JSON.stringify(next.metadata ?? {}),
        pinned: next.pinned ? 1 : 0,
        ttlOverrideSeconds: next.ttlOverrideSeconds,
        expiresAt: next.expiresAt,
        updatedAt: now,
      });
    if (patch.pinned !== undefined) {
      recordMemoryChange(this.deps.admin, itemId, "pin_changed", actorId, { pinned: next.pinned });
    }
    if (patch.ttlOverrideSeconds !== undefined) {
      const lifecycleState = deriveMemoryItemLifecycleState(
        {
          status: current.status,
          expiresAt: next.expiresAt ?? undefined,
          forgottenAt: current.forgottenAt,
        },
        now,
      );
      recordMemoryChange(this.deps.admin, itemId, "ttl_changed", actorId, {
        ttlOverrideSeconds: next.ttlOverrideSeconds,
        expiresAt: next.expiresAt,
        lifecycleState,
      });
    }
    recordMemoryChange(this.deps.admin, itemId, "updated", actorId, {
      title: next.title,
      metadata: next.metadata ?? {},
    });
    const updated = requireMemoryItem(this.deps.admin, itemId);
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_item_updated",
      itemId: updated.itemId,
      namespace: updated.namespace,
      lifecycleState: updated.lifecycleState,
      expiresAt: updated.expiresAt,
    });
    return updated;
  }

  public forgetMemoryItem(itemId: string, actorId = "operator"): MemoryItemRecord {
    return this.forgetMemoryItemInternal(itemId, actorId, { requireFeature: true });
  }

  private forgetMemoryItemInternal(
    itemId: string,
    actorId = "operator",
    options: { requireFeature: boolean },
  ): MemoryItemRecord {
    if (options.requireFeature) {
      this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    }
    const current = requireMemoryItem(this.deps.admin, itemId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_items
      SET status = 'forgotten',
          forgotten_at = @forgottenAt,
          updated_at = @updatedAt
      WHERE item_id = @itemId
    `,
      )
      .run({
        itemId,
        forgottenAt: now,
        updatedAt: now,
      });
    recordMemoryChange(this.deps.admin, itemId, "forgotten", actorId, {
      previousStatus: current.status,
    });
    const forgotten = requireMemoryItem(this.deps.admin, itemId);
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_item_forgotten",
      itemId,
      namespace: forgotten.namespace,
      lifecycleState: forgotten.lifecycleState,
    });
    return forgotten;
  }

  public forgetMemory(
    input: {
      itemIds?: string[];
      namespace?: string;
      query?: string;
      actorId?: string;
    } = {},
  ): { forgottenCount: number; itemIds: string[]; items: MemoryItemRecord[] } {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const criteria = normalizeMemoryForgetCriteria(input);
    if (!criteria.hasCriteria) {
      throw new Error("Memory forget requires at least one criterion: itemIds, namespace, or query.");
    }
    const actorId = input.actorId?.trim() || "operator";
    const targets = criteria.hasItemIds
      ? criteria.itemIds
      : this.listMemoryItems({
          namespace: criteria.namespace,
          status: "active",
          query: criteria.query,
          limit: 2_000,
        }).map((item) => item.itemId);
    const forgottenItems = targets.map((itemId) => this.forgetMemoryItem(itemId, actorId));
    return {
      forgottenCount: forgottenItems.length,
      itemIds: forgottenItems.map((item) => item.itemId),
      items: forgottenItems,
    };
  }

  public listMemoryItemHistory(itemId: string, limit = 200): MemoryChangeEvent[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
      FROM memory_change_history
      WHERE item_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(itemId, safeLimit) as Array<{
      change_id: string;
      item_id: string;
      change_type: MemoryChangeEvent["changeType"];
      actor_id: string | null;
      payload_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      changeId: row.change_id,
      itemId: row.item_id,
      changeType: row.change_type,
      actorId: row.actor_id ?? undefined,
      payload: this.deps.admin.tryParseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }

  public composeContext(input: MemoryContextComposeRequest): Promise<MemoryContextPack> {
    return this.deps.context.compose(input);
  }

  public async prewarmContext(input: MemoryContextComposeRequest): Promise<void> {
    await this.deps.context.compose({
      ...input,
      forceRefresh: input.forceRefresh ?? true,
    });
  }

  public getContext(contextId: string): MemoryContextPack {
    return this.deps.context.get(contextId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.deps.context.listByRun(runId);
  }

  public listRecentContexts(limit = 60): MemoryContextPack[] {
    return this.deps.context.listRecent(limit);
  }

  public getContextStats(from: string, to: string): MemoryQmdStatsResponse {
    return this.deps.context.stats(from, to);
  }

  public extractLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void {
    const policy = this.deps.resolveLearnedMemoryPolicy(sessionId);
    if (!policy.allowWrite) {
      return;
    }
    if (this.scanBrowserContentGuardForMemory(content, { sessionId, sourceRef: source.sourceRef }).blocked) {
      return;
    }
    if (this.deps.writeGate) {
      const authority: MemoryWriteAuthority = source.role === "user" ? "operator" : "agent_proposed";
      const existingClaims = this.deps.learned
        .listChatSessionLearnedMemory(sessionId, 200)
        .items.map((item) => item.content);
      const gateDecision = this.deps.writeGate.evaluate({
        authority,
        content,
        existingClaims,
      });
      this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        sessionId,
        memoryLineage: [source.sourceRef],
        metadata: {
          decision: gateDecision,
          sourceRole: source.role,
          sourceRef: source.sourceRef,
          claimPreview: gateDecision.redactionStatus === "blocked_secret" ? "[redacted]" : content.slice(0, 240),
        },
      });
      if (gateDecision.decision !== "allowed") {
        return;
      }
    }
    this.deps.learned.extractAndPersistLearnedMemory(sessionId, content, source);
  }

  public listSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): {
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  } {
    return this.deps.learned.listChatSessionLearnedMemory(sessionId, limit);
  }

  public updateSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): LearnedMemoryItemRecord {
    return this.deps.learned.updateChatSessionLearnedMemory(sessionId, itemId, input);
  }

  public rebuildSessionLearnedMemory(sessionId: string): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    return this.deps.learned.rebuildChatSessionLearnedMemory(sessionId, (sid) => this.deps.readTranscriptOrEmpty(sid));
  }

  public getMaintenancePolicy(workspaceId?: string): MemoryMaintenancePolicyRecord {
    return this.deps.maintenance.getPolicy(workspaceId);
  }

  public patchMaintenancePolicy(
    workspaceId: string | undefined,
    patch: MemoryMaintenancePolicyPatchInput,
  ): MemoryMaintenancePolicyRecord {
    return this.deps.maintenance.patchPolicy(workspaceId, patch);
  }

  public getMaintenanceStatus(workspaceId?: string): MemoryMaintenanceStatusRecord {
    return this.deps.maintenance.getStatus(workspaceId);
  }

  public listMaintenanceRuns(workspaceId?: string, limit = 50): MemoryMaintenanceRunRecord[] {
    return this.deps.maintenance.listRuns(workspaceId, limit);
  }

  public runMaintenanceNow(input: MemoryMaintenanceRunNowInput): MemoryMaintenanceRunRecord {
    return this.deps.maintenance.runNow(input);
  }

  public getMaintenanceRunProvenance(runId: string): MemoryMaintenanceProvenanceRecord {
    return this.deps.maintenance.getRunProvenance(runId);
  }

  public listMaintenanceRecommendations(workspaceId?: string, limit = 50): MemoryMaintenanceRecommendationRecord[] {
    return this.deps.maintenance.listRecommendations(workspaceId, limit);
  }

  public acceptMaintenanceRecommendation(recommendationId: string): {
    recommendation: MemoryMaintenanceRecommendationRecord;
    policy: MemoryMaintenancePolicyRecord;
  } {
    return this.deps.maintenance.acceptRecommendation(recommendationId);
  }

  public rejectMaintenanceRecommendation(recommendationId: string): MemoryMaintenanceRecommendationRecord {
    return this.deps.maintenance.rejectRecommendation(recommendationId);
  }

  public runDueEvaluation(): Promise<void> {
    return this.deps.maintenance.runDueEvaluation();
  }

  public noteSuccessfulRootTurn(sessionId: string): Promise<void> {
    return this.deps.maintenance.noteSuccessfulRootTurn(sessionId);
  }

  public parseMaintenanceWorkflowPayload(run: DurableRunRecord): { workspaceId: string } | undefined {
    const payload = this.deps.maintenance.parseWorkflowPayload(run);
    if (!payload?.workspaceId) {
      return undefined;
    }
    return {
      workspaceId: payload.workspaceId,
    };
  }

  public syncMaintenanceFromDurableRun(run: DurableRunRecord): void {
    this.deps.maintenance.syncFromDurableRun(run);
  }

  public executeMaintenanceDurableRun(
    run: DurableRunRecord,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    return this.deps.maintenance.executeDurableRun(run, options);
  }

  private requireMemoryEntity(entityId: string): MemoryEntityRecord {
    const row = this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_entities WHERE entity_id = ?")
      .get(entityId) as MemoryEntityRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory entity", id: entityId });
    }
    return mapMemoryEntityRow(this.deps.admin, row);
  }

  private requireMemoryDecision(decisionId: string): MemoryDecisionRecord {
    const row = this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_decisions WHERE decision_id = ?")
      .get(decisionId) as MemoryDecisionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory decision", id: decisionId });
    }
    return mapMemoryDecisionRow(this.deps.admin, row);
  }

  private requireMemoryLearning(learningId: string): MemoryLearningRecord {
    const row = this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_learnings WHERE learning_id = ?")
      .get(learningId) as MemoryLearningRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory learning", id: learningId });
    }
    return mapLearningRow(this.deps.admin, row);
  }

  private insertMemoryLearning(
    input: MemoryLearningInput,
    actorId: string,
    status: MemoryLearningStatus,
  ): MemoryLearningRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureLearningSchema();
    const now = new Date().toISOString();
    const authority = normalizeAuthority(input.authority ?? (status === "proposed" ? "agent_proposed" : "operator"));
    const learning: MemoryLearningRecord = {
      learningId: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      key: requireTrimmedText(input.key, "key"),
      type: normalizeLearningType(input.type),
      insight: requireTrimmedText(input.insight, "insight"),
      confidence: normalizeConfidence(input.confidence),
      status,
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      fileRefs: this.normalizeLearningFileRefs(input.fileRefs),
      authority,
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(learning.authority, serializeLearningForGate(learning));
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_learnings (
        learning_id, workspace_id, learning_key, learning_type, insight, confidence, status,
        source_refs_json, file_refs_json, authority, superseded_by_id, created_at, updated_at
      ) VALUES (
        @learningId, @workspaceId, @key, @type, @insight, @confidence, @status,
        @sourceRefsJson, @fileRefsJson, @authority, NULL, @createdAt, @updatedAt
      )
    `,
      )
      .run({
        learningId: learning.learningId,
        workspaceId: learning.workspaceId,
        key: learning.key,
        type: learning.type,
        insight: learning.insight,
        confidence: learning.confidence,
        status: learning.status,
        sourceRefsJson: JSON.stringify(learning.sourceRefs),
        fileRefsJson: JSON.stringify(learning.fileRefs),
        authority: learning.authority,
        createdAt: learning.createdAt,
        updatedAt: learning.updatedAt,
      });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_learning_created",
      learningId: learning.learningId,
      status: learning.status,
      workspaceId: learning.workspaceId,
    });
    return learning;
  }

  private normalizeLearningFileRefs(
    fileRefs: MemoryLearningInput["fileRefs"] | undefined,
  ): MemoryLearningRecord["fileRefs"] {
    return (fileRefs ?? []).map((ref) => {
      const normalizedPath = requireTrimmedText(ref.path, "fileRefs.path");
      const absolutePath = this.resolveLearningFilePath(normalizedPath);
      return {
        path: normalizedPath,
        contentHash: ref.contentHash?.trim() || hashFileIfPresent(absolutePath),
      };
    });
  }

  private resolveLearningFilePath(filePath: string): string {
    const rootDir = this.deps.files?.rootDir;
    if (!rootDir) {
      return path.resolve(filePath);
    }
    const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(rootDir, filePath);
    const root = path.resolve(rootDir);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new ValidationError({
        field: "fileRefs.path",
        message: "Learning file refs must stay inside the GoatCitadel repository root.",
      });
    }
    return absolutePath;
  }

  private inspectLearningIssues(learning: MemoryLearningRecord): MemoryLearningStalenessIssue[] {
    const issues: MemoryLearningStalenessIssue[] = [];
    for (const fileRef of learning.fileRefs) {
      const absolutePath = this.resolveLearningFilePath(fileRef.path);
      if (!fsSync.existsSync(absolutePath)) {
        issues.push({
          learningId: learning.learningId,
          path: fileRef.path,
          issue: "missing_file",
          message: `Referenced file ${fileRef.path} no longer exists.`,
        });
        continue;
      }
      const currentHash = hashFileIfPresent(absolutePath);
      if (fileRef.contentHash && currentHash && fileRef.contentHash !== currentHash) {
        issues.push({
          learningId: learning.learningId,
          path: fileRef.path,
          issue: "changed_hash",
          message: `Referenced file ${fileRef.path} changed since the learning was recorded.`,
        });
      }
    }
    for (const sourceRef of learning.sourceRefs) {
      const maybePath = sourceRef.sourceType === "artifact" ? sourceRef.sourceRef.replace(/^file:/, "") : "";
      if (maybePath && !maybePath.startsWith("http") && (maybePath.includes("/") || maybePath.includes("\\"))) {
        const absolutePath = this.resolveLearningFilePath(maybePath);
        if (!fsSync.existsSync(absolutePath)) {
          issues.push({
            learningId: learning.learningId,
            path: maybePath,
            issue: "stale_source_ref",
            message: `Source reference ${sourceRef.sourceRef} no longer resolves to a local file.`,
          });
        }
      }
    }
    if (learning.confidence < 0.5 && learning.status !== "forgotten") {
      issues.push({
        learningId: learning.learningId,
        issue: "low_confidence",
        message: "Learning confidence is below the trusted-review threshold.",
      });
    }
    const contradictions = this.listMemoryLearnings({
      workspaceId: learning.workspaceId,
      key: learning.key,
      status: "all",
      limit: 20,
    }).filter(
      (candidate) =>
        candidate.learningId !== learning.learningId &&
        candidate.status !== "forgotten" &&
        candidate.insight.trim().toLowerCase() !== learning.insight.trim().toLowerCase(),
    );
    if (contradictions.length > 0 && learning.status !== "forgotten") {
      issues.push({
        learningId: learning.learningId,
        issue: "likely_contradiction",
        message: `Learning conflicts with ${contradictions.length} other active/proposed record(s) for key ${learning.key}.`,
      });
    }
    return issues;
  }

  private ensureLearningSchema(): void {
    this.deps.admin.gatewaySql
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS memory_learnings (
        learning_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        learning_key TEXT NOT NULL,
        learning_type TEXT NOT NULL,
        insight TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        file_refs_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        superseded_by_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
      )
      .run();
    this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_learnings_workspace_status ON memory_learnings(workspace_id, status)",
      )
      .run();
    this.deps.admin.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_memory_learnings_key ON memory_learnings(workspace_id, learning_key)")
      .run();
  }

  private assertStructuredMemoryWriteAllowed(authority: StructuredMemoryAuthority, content: string): void {
    const browserContentGuard = this.scanBrowserContentGuardForMemory(content, {
      structuredMemory: true,
      authority,
    });
    if (browserContentGuard.blocked) {
      throw new PolicyViolationError({
        message: "Browser content guard blocked memory write candidate.",
        details: { browserContentGuard },
      });
    }
    const decision = this.deps.writeGate?.evaluate({
      authority: authority as MemoryWriteAuthority,
      content,
      existingClaims: [],
    });
    if (decision && decision.decision !== "allowed") {
      this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        metadata: {
          decision,
          claimPreview: decision.redactionStatus === "blocked_secret" ? "[redacted]" : content.slice(0, 240),
          structuredMemory: true,
        },
      });
      throw new PolicyViolationError({
        message: `Structured memory write requires review: ${decision.reasons.join(", ") || decision.decision}.`,
        details: { decision },
      });
    }
  }

  private scanBrowserContentGuardForMemory(
    content: string,
    metadata: Record<string, unknown>,
  ): BrowserContentGuardResult {
    const browserContentGuard = scanBrowserContentGuard(content);
    if (browserContentGuard.blocked) {
      this.deps.evidence?.createEnvelope({
        eventKind: "browser_content_guard",
        metadata: {
          ...metadata,
          browserContentGuard,
          shieldWarning: "Untrusted browser content canary leaked into a memory-write candidate.",
          claimPreview: "[blocked-browser-content]",
        },
      });
    }
    return browserContentGuard;
  }

  private recordStructuredMemoryChange(
    recordKind: "entity" | "relation" | "decision",
    recordId: string,
    changeType: MemoryChangeEvent["changeType"],
    actorId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_structured_change_history (
        change_id, record_kind, record_id, change_type, actor_id, payload_json, created_at
      ) VALUES (
        @changeId, @recordKind, @recordId, @changeType, @actorId, @payloadJson, @createdAt
      )
    `,
      )
      .run({
        changeId: randomUUID(),
        recordKind,
        recordId,
        changeType,
        actorId: actorId?.trim() || null,
        payloadJson: JSON.stringify(payload ?? {}),
        createdAt: new Date().toISOString(),
      });
  }
}

interface MemoryEntityRow {
  entity_id: string;
  workspace_id: string;
  scope: StructuredMemoryScope;
  title: string;
  entity_type: string;
  aliases_json: string | null;
  summary: string | null;
  status: StructuredMemoryStatus;
  confidence: number;
  source_refs_json: string | null;
  metadata_json: string | null;
  authority: StructuredMemoryAuthority;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
  superseded_by_id: string | null;
}

interface MemoryLearningRow {
  learning_id: string;
  workspace_id: string;
  learning_key: string;
  learning_type: string;
  insight: string;
  confidence: number;
  status: MemoryLearningStatus;
  source_refs_json: string | null;
  file_refs_json: string | null;
  authority: StructuredMemoryAuthority;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryRelationRow {
  relation_id: string;
  workspace_id: string;
  scope: StructuredMemoryScope;
  title: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  status: StructuredMemoryStatus;
  confidence: number;
  source_refs_json: string | null;
  metadata_json: string | null;
  authority: StructuredMemoryAuthority;
  degraded_reason: string | null;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
  superseded_by_id: string | null;
}

interface MemoryDecisionRow {
  decision_id: string;
  workspace_id: string;
  scope: StructuredMemoryScope;
  title: string;
  decision_text: string;
  alternatives_json: string | null;
  rationale: string;
  expected_outcome: string | null;
  review_at: string | null;
  retrospective_json: string | null;
  linked_entity_ids_json: string | null;
  linked_relation_ids_json: string | null;
  session_id: string | null;
  run_id: string | null;
  improvement_candidate_id: string | null;
  status: StructuredMemoryStatus;
  confidence: number;
  source_refs_json: string | null;
  metadata_json: string | null;
  authority: StructuredMemoryAuthority;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
  superseded_by_id: string | null;
}

function mapMemoryEntityRow(host: MemoryLifecycleAdminDependencies, row: MemoryEntityRow): MemoryEntityRecord {
  return {
    id: row.entity_id,
    workspaceId: row.workspace_id,
    scope: normalizeStructuredScope(row.scope),
    title: row.title,
    entityType: row.entity_type,
    aliases: parseMemoryJson(host, row.aliases_json, []),
    summary: row.summary ?? undefined,
    status: normalizeStructuredStatus(row.status),
    confidence: normalizeConfidence(row.confidence),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    metadata: parseMemoryJson(host, row.metadata_json, {}),
    authority: normalizeAuthority(row.authority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
  };
}

function mapLearningRow(host: MemoryLifecycleAdminDependencies, row: MemoryLearningRow): MemoryLearningRecord {
  return {
    learningId: row.learning_id,
    workspaceId: row.workspace_id,
    key: row.learning_key,
    type: normalizeLearningType(row.learning_type),
    insight: row.insight,
    confidence: normalizeConfidence(row.confidence),
    status: normalizeLearningStatus(row.status),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    fileRefs: parseMemoryJson(host, row.file_refs_json, []),
    authority: normalizeAuthority(row.authority),
    supersededById: row.superseded_by_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemoryRelationRow(host: MemoryLifecycleAdminDependencies, row: MemoryRelationRow): MemoryRelationRecord {
  return {
    id: row.relation_id,
    workspaceId: row.workspace_id,
    scope: normalizeStructuredScope(row.scope),
    title: row.title,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relationType: row.relation_type,
    status: normalizeStructuredStatus(row.status),
    confidence: normalizeConfidence(row.confidence),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    metadata: parseMemoryJson(host, row.metadata_json, {}),
    authority: normalizeAuthority(row.authority),
    degradedReason: row.degraded_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
  };
}

function mapMemoryDecisionRow(host: MemoryLifecycleAdminDependencies, row: MemoryDecisionRow): MemoryDecisionRecord {
  return {
    id: row.decision_id,
    workspaceId: row.workspace_id,
    scope: normalizeStructuredScope(row.scope),
    title: row.title,
    decision: row.decision_text,
    alternatives: parseMemoryJson(host, row.alternatives_json, []),
    rationale: row.rationale,
    expectedOutcome: row.expected_outcome ?? undefined,
    reviewAt: row.review_at ?? undefined,
    retrospective: row.retrospective_json ? parseMemoryJson(host, row.retrospective_json, undefined) : undefined,
    linkedEntityIds: parseMemoryJson(host, row.linked_entity_ids_json, []),
    linkedRelationIds: parseMemoryJson(host, row.linked_relation_ids_json, []),
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    improvementCandidateId: row.improvement_candidate_id ?? undefined,
    status: normalizeStructuredStatus(row.status),
    confidence: normalizeConfidence(row.confidence),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    metadata: parseMemoryJson(host, row.metadata_json, {}),
    authority: normalizeAuthority(row.authority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
  };
}

function parseMemoryJson<T>(host: MemoryLifecycleAdminDependencies, value: string | null | undefined, fallback: T): T {
  return host.tryParseJson<T>(value, fallback);
}

function normalizeStructuredWorkspaceId(value: string | undefined): string {
  return value?.trim() || "default";
}

function normalizeStructuredScope(value: string | undefined): StructuredMemoryScope {
  return value === "global" || value === "session" || value === "run" ? value : "workspace";
}

function normalizeStructuredStatus(value: string | undefined): StructuredMemoryStatus {
  return value === "forgotten" || value === "superseded" ? value : "active";
}

function normalizeLearningStatus(value: string | undefined): MemoryLearningStatus {
  return value === "trusted" || value === "superseded" || value === "forgotten" ? value : "proposed";
}

function normalizeLearningType(value: string | undefined): MemoryLearningType {
  return value === "workflow" ||
    value === "bug_pattern" ||
    value === "operator_preference" ||
    value === "repo_fact" ||
    value === "tooling"
    ? value
    : "repo_fact";
}

function normalizeAuthority(value: string | undefined): StructuredMemoryAuthority {
  return value === "agent_proposed" || value === "trusted_lifecycle" || value === "imported_skill" ? value : "operator";
}

function normalizeStructuredLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.floor(value ?? 100)));
}

function normalizeConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Number(Math.max(0, Math.min(1, Number(value))).toFixed(3));
}

function normalizeStringArray(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((item) => item.trim()).filter(Boolean)));
}

function normalizeSourceRefs(
  value: StructuredMemorySourceRef[] | undefined,
  actorId: string,
): StructuredMemorySourceRef[] {
  const normalized = (value ?? [])
    .map((item) => ({
      sourceType: item.sourceType,
      sourceRef: item.sourceRef.trim(),
      title: item.title?.trim() || undefined,
    }))
    .filter((item) => item.sourceRef);
  if (normalized.length > 0) {
    return normalized;
  }
  return [{ sourceType: "manual", sourceRef: actorId?.trim() || "operator" }];
}

function requireTrimmedText(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function optionalTrimmedText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function serializeStructuredMemoryForGate(
  value: MemoryEntityRecord | MemoryRelationRecord | MemoryDecisionRecord,
): string {
  return JSON.stringify({
    title: value.title,
    status: value.status,
    confidence: value.confidence,
    metadata: value.metadata,
    ...("summary" in value ? { summary: value.summary, aliases: value.aliases } : {}),
    ...("relationType" in value ? { relationType: value.relationType } : {}),
    ...("decision" in value
      ? {
          decision: value.decision,
          alternatives: value.alternatives,
          rationale: value.rationale,
          expectedOutcome: value.expectedOutcome,
        }
      : {}),
  });
}

function serializeLearningForGate(value: MemoryLearningRecord): string {
  return JSON.stringify({
    key: value.key,
    type: value.type,
    insight: value.insight,
    confidence: value.confidence,
    status: value.status,
    sourceRefs: value.sourceRefs,
    fileRefs: value.fileRefs,
  });
}

function hashFileIfPresent(filePath: string): string | undefined {
  if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) {
    return undefined;
  }
  return createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex");
}

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
  MemoryActionLedgerEntry,
  MemoryBatchMutationOperation,
  MemoryBatchMutationRequest,
  MemoryBatchMutationResponse,
  MemoryBatchMutationResult,
  MemoryChangeEvent,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryDecisionInput,
  MemoryDecisionRecord,
  MemoryDecisionRetrospective,
  MemoryDecisionRetrospectiveInput,
  MemoryEntityInput,
  MemoryEntityRecord,
  MemoryFeedbackInput,
  MemoryFeedbackKind,
  MemoryFeedbackRecord,
  MemoryFeedbackStatus,
  MemoryFeedbackTargetKind,
  MemoryForgetRequest,
  MemoryForgetResponse,
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
  MemoryQualityIssueInput,
  MemoryQualityIssueKind,
  MemoryQualityIssueListRequest,
  MemoryQualityIssuePatchInput,
  MemoryQualityIssueRecord,
  MemoryQualityIssueSeverity,
  MemoryQualityIssueStatus,
  MemoryQualityScanRequest,
  MemoryQualityScanResponse,
  MemoryRelationInput,
  MemoryRelationRecord,
  MemoryQmdStatsResponse,
  MemoryRetrievalBenchmarkItem,
  MemoryRetrievalBenchmarkRequest,
  MemoryRetrievalBenchmarkResponse,
  MemoryRetrievalStatusResponse,
  MemoryRetrievalStrategy,
  MemoryRecallRequest,
  MemoryRecallResponse,
  StructuredMemoryAuthority,
  StructuredMemoryLineage,
  StructuredMemoryScope,
  StructuredMemorySourceRef,
  StructuredMemoryStatus,
  TraceMemoryCandidateInput,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateStatus,
  TraceMemoryCandidateType,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import {
  ConflictError,
  MEMORY_FORGET_MAX_ITEM_IDS,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  deriveMemoryItemLifecycleState,
  type BrowserContentGuardResult,
} from "@goatcitadel/contracts";
import { assertWritePathInJail, scanBrowserContentGuard } from "@goatcitadel/policy-engine";
import { buildMemoryWorkspaceScopeSql } from "@goatcitadel/storage";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { MemoryContextService } from "./memory-context-service.js";
import { mapMemoryItemRow, recordMemoryChange, requireMemoryItem, type MemoryItemHost } from "./memory-item-helpers.js";
import { withMemoryEmbeddingMetadata } from "./memory-embedding-metadata.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { normalizeMemoryForgetCriteria } from "./security-utils.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import {
  buildMemoryActionContext,
  buildMemoryActionLedgerEntry,
  buildMemoryChangeLedgerPayload,
} from "./memory-action-ledger.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";
import { matchesMemoryWorkspaceScope } from "./memory-lifecycle-policy.js";

export interface MemoryFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export interface MemoryForgetCommitHooks {
  /** Runs as the final write inside the canonical memory transaction. */
  onCommit?: () => void;
  /** Runs immediately after the canonical memory transaction commits. */
  afterCommit?: () => void;
}

export interface MemoryForgetItemOptions extends MemoryForgetCommitHooks {
  actionId?: string;
  source?: string;
}

interface MemoryForgetSelectionRow {
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
  workspace_id: string | null;
}

interface MemoryLifecycleAdminDependencies extends MemoryItemHost {
  gatewaySql: MemoryItemHost["gatewaySql"] & {
    runImmediateTransaction?<T>(callback: () => T): T;
  };
  memoryQualityIssues: {
    list(input?: MemoryQualityIssueListRequest): MemoryQualityIssueRecord[];
    upsertOpenIssue(input: MemoryQualityIssueInput & { dedupKey?: string }): {
      record: MemoryQualityIssueRecord;
      created: boolean;
    };
    patchStatus(issueId: string, input: MemoryQualityIssuePatchInput): MemoryQualityIssueRecord;
  };
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
  resolveSessionWorkspaceId?: (sessionId: string) => string | undefined;
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

  public async createMemoryEntity(input: MemoryEntityInput, actorId = "operator"): Promise<MemoryEntityRecord> {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const title = requireTrimmedText(input.title, "title");
    const summary = optionalTrimmedText(input.summary);
    const aliases = normalizeStringArray(input.aliases);
    const metadata = await withMemoryEmbeddingMetadata(
      input.metadata ?? {},
      buildStructuredMemoryEmbeddingText([title, summary, ...aliases]),
    );
    const entity: MemoryEntityRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title,
      entityType: input.entityType?.trim() || "concept",
      aliases,
      summary,
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata,
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(
      entity.authority,
      serializeStructuredMemoryForGate(entity),
      entity.workspaceId,
    );
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

  public async createMemoryRelation(input: MemoryRelationInput, actorId = "operator"): Promise<MemoryRelationRecord> {
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
    const title = input.title?.trim() || `${from.title} ${relationType} ${to.title}`;
    const metadata = await withMemoryEmbeddingMetadata(
      input.metadata ?? {},
      buildStructuredMemoryEmbeddingText([title]),
    );
    const relation: MemoryRelationRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId ?? from.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title,
      fromEntityId: from.id,
      toEntityId: to.id,
      relationType,
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata,
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(
      relation.authority,
      serializeStructuredMemoryForGate(relation),
      relation.workspaceId,
    );
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

  public async createMemoryDecision(input: MemoryDecisionInput, actorId = "operator"): Promise<MemoryDecisionRecord> {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const decisionText = requireTrimmedText(input.decision, "decision");
    const rationale = requireTrimmedText(input.rationale, "rationale");
    const title = input.title?.trim() || decisionText.slice(0, 120);
    const metadata = await withMemoryEmbeddingMetadata(
      input.metadata ?? {},
      buildStructuredMemoryEmbeddingText([title, decisionText, rationale]),
    );
    const decision: MemoryDecisionRecord = {
      id: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      scope: normalizeStructuredScope(input.scope),
      title,
      decision: decisionText,
      alternatives: normalizeStringArray(input.alternatives),
      rationale,
      expectedOutcome: optionalTrimmedText(input.expectedOutcome),
      reviewAt: optionalTrimmedText(input.reviewAt),
      linkedEntityIds: normalizeStringArray(input.linkedEntityIds),
      linkedRelationIds: normalizeStringArray(input.linkedRelationIds),
      sessionId: optionalTrimmedText(input.sessionId),
      runId: optionalTrimmedText(input.runId),
      status: "active",
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeSourceRefs(input.sourceRefs, actorId),
      metadata,
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    this.assertStructuredMemoryWriteAllowed(
      decision.authority,
      serializeStructuredMemoryForGate(decision),
      decision.workspaceId,
    );
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
      current.workspaceId,
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
      workspaceId?: string;
      status?: MemoryItemRecord["status"] | "all";
      query?: string;
      limit?: number;
    } = {},
  ): MemoryItemRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const namespace = input.namespace?.trim();
    const workspaceId = input.workspaceId?.trim();
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
    if (workspaceId) {
      clauses.push(buildMemoryWorkspaceScopeSql(this.deps.admin.gatewaySql.dialect));
      params.workspaceId = workspaceId;
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
             created_at, updated_at, forgotten_at, workspace_id
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
      workspace_id: string | null;
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
             created_at, updated_at, forgotten_at, workspace_id
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
      workspace_id: string | null;
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
             created_at, updated_at, forgotten_at, workspace_id
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
      workspace_id: string | null;
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
             created_at, updated_at, forgotten_at, workspace_id
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
      workspace_id: string | null;
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

  public forgetMemoryItem(
    itemId: string,
    actorId = "operator",
    options: MemoryForgetItemOptions = {},
  ): MemoryItemRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = requireMemoryItem(this.deps.admin, itemId);
    const result = this.forgetMemory(
      {
        itemIds: [itemId],
        actorId,
        actionId: options.actionId,
        source: options.source?.trim() || "gateway.memory.forget_item",
      },
      {
        onCommit: options.onCommit,
        afterCommit: options.afterCommit,
      },
    );
    return result.items[0] ?? (current.status === "forgotten" ? current : requireMemoryItem(this.deps.admin, itemId));
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
    input: MemoryForgetRequest & { actorId?: string } = {},
    hooks: MemoryForgetCommitHooks = {},
  ): MemoryForgetResponse {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    if ((input.itemIds?.length ?? 0) > MEMORY_FORGET_MAX_ITEM_IDS) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "itemIds",
        message: `Memory forget accepts at most ${MEMORY_FORGET_MAX_ITEM_IDS} explicit item IDs.`,
      });
    }
    if (input.itemIds?.some((itemId) => typeof itemId !== "string" || !itemId.trim())) {
      throw new ValidationError({ code: "FIELD_INVALID", field: "itemIds" });
    }

    const criteria = normalizeMemoryForgetCriteria(input);
    if (!criteria.hasCriteria) {
      throw new ValidationError({
        code: "FIELD_REQUIRED",
        field: "itemIds",
        message: "Memory forget requires at least one criterion: itemIds, namespace, or query.",
      });
    }

    const workspaceId = input.workspaceId?.trim() || undefined;
    const includeGlobal = input.includeGlobal === true;
    if (input.includeGlobal !== undefined && !workspaceId) {
      throw new ValidationError({
        code: "FIELD_REQUIRED",
        field: "workspaceId",
        message: "Memory forget includeGlobal requires an explicit workspaceId.",
      });
    }
    const effectiveIncludeGlobal = workspaceId ? includeGlobal : true;

    const action = buildMemoryActionContext({
      actionId: input.actionId,
      ownerId: input.actorId?.trim() || "operator",
      source: input.source,
      defaultSource: "gateway.memory.forget",
    });
    const normalizedItemIds = [...criteria.itemIds].sort(compareMemoryItemIds);
    const criteriaDigest = createHash("sha256")
      .update(
        JSON.stringify({
          itemIds: normalizedItemIds,
          namespace: criteria.namespace ?? null,
          query: criteria.query ?? null,
          workspaceId: workspaceId ?? null,
          includeGlobal: effectiveIncludeGlobal,
        }),
      )
      .digest("hex");
    const gatewaySql = this.deps.admin.gatewaySql;
    const runTransaction = requireMemoryBatchTransaction(gatewaySql);

    const transactionResult = runTransaction(() => {
      if (gatewaySql.dialect === "postgres") {
        gatewaySql
          .prepare("SELECT set_config('lock_timeout', @lockTimeout, true)")
          .run({ lockTimeout: `${MEMORY_FORGET_POSTGRES_LOCK_TIMEOUT_MS}ms` });
      }
      const clauses = ["1 = 1"];
      const params: Record<string, string | number | null> = {};
      if (normalizedItemIds.length > 0) {
        const placeholders = normalizedItemIds.map((itemId, index) => {
          const key = `itemId${index}`;
          params[key] = itemId;
          return `@${key}`;
        });
        clauses.push(`item_id IN (${placeholders.join(", ")})`);
      }
      if (criteria.namespace) {
        clauses.push("namespace = @namespace");
        params.namespace = criteria.namespace;
      }
      if (workspaceId) {
        clauses.push(
          buildMemoryWorkspaceScopeSql(gatewaySql.dialect, {
            includeGlobal,
          }),
        );
        params.workspaceId = workspaceId;
      }
      if (criteria.query) {
        clauses.push(`(
          LOWER(title) LIKE @query ESCAPE @escapeCharacter
          OR LOWER(content) LIKE @query ESCAPE @escapeCharacter
          OR LOWER(namespace) LIKE @query ESCAPE @escapeCharacter
        )`);
        params.query = `%${escapeMemoryLikePattern(criteria.query.toLowerCase())}%`;
        params.escapeCharacter = "\\";
      }
      if (!criteria.hasItemIds) {
        clauses.push("status = 'active'");
        clauses.push("(expires_at IS NULL OR expires_at > @now)");
        params.now = new Date().toISOString();
      }

      const lockClause = gatewaySql.dialect === "postgres" ? " FOR UPDATE" : "";
      const matchedRows = gatewaySql
        .prepare(
          `
          SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
                 created_at, updated_at, forgotten_at, workspace_id
          FROM memory_items
          WHERE ${clauses.join(" AND ")}
          ORDER BY item_id${lockClause}
        `,
        )
        .all(params) as MemoryForgetSelectionRow[];

      if (criteria.hasItemIds && matchedRows.length !== normalizedItemIds.length) {
        throw new ValidationError({
          code: "FIELD_INVALID",
          field: "itemIds",
          message: "Every explicit memory item must exist and satisfy the requested workspace and filters.",
        });
      }

      const activeItemIds = matchedRows
        .filter((row) => row.status === "active")
        .map((row) => row.item_id)
        .sort(compareMemoryItemIds);
      const alreadyForgottenCount = matchedRows.filter((row) => row.status === "forgotten").length;
      const forgottenAt = new Date().toISOString();
      const changedRows: MemoryForgetSelectionRow[] = [];
      for (const itemIdChunk of chunkMemoryItemIds(activeItemIds)) {
        const updateParams: Record<string, string | number | null> = {
          forgottenAt,
          updatedAt: forgottenAt,
        };
        const placeholders = itemIdChunk.map((itemId, index) => {
          const key = `itemId${index}`;
          updateParams[key] = itemId;
          return `@${key}`;
        });
        changedRows.push(
          ...(gatewaySql
            .prepare(
              `
              UPDATE memory_items
              SET status = 'forgotten',
                  forgotten_at = @forgottenAt,
                  updated_at = @updatedAt
              WHERE status = 'active'
                AND item_id IN (${placeholders.join(", ")})
              RETURNING item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at,
                        status, created_at, updated_at, forgotten_at, workspace_id
            `,
            )
            .all(updateParams) as MemoryForgetSelectionRow[]),
        );
      }
      changedRows.sort((left, right) => compareMemoryItemIds(left.item_id, right.item_id));
      if (
        changedRows.length !== activeItemIds.length ||
        changedRows.some((row, index) => row.item_id !== activeItemIds[index])
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory forget targets changed during the atomic mutation.",
        });
      }

      for (const row of changedRows) {
        recordMemoryChange(this.deps.admin, row.item_id, "forgotten", action.ownerId, {
          previousStatus: "active",
          actionId: action.actionId,
          ownerId: action.ownerId,
          source: action.source,
          timestamp: action.timestamp,
          operationKind: "forget_item",
          operationCount: changedRows.length,
          criteriaDigest,
          requestedWorkspaceId: workspaceId ?? null,
          effectiveWorkspaceId: resolveMemoryForgetEffectiveWorkspaceId(this.deps.admin, row) ?? null,
          includeGlobal: effectiveIncludeGlobal,
          storesRawContent: false,
        });
      }
      hooks.onCommit?.();

      return {
        matchedCount: matchedRows.length,
        alreadyForgottenCount,
        changedRows,
      };
    });

    hooks.afterCommit?.();
    const forgottenItems = transactionResult.changedRows.map((row) => mapMemoryItemRow(this.deps.admin, row));
    let realtimeError: unknown;
    for (const [index, item] of forgottenItems.entries()) {
      const sourceRow = transactionResult.changedRows[index];
      try {
        this.deps.admin.publishRealtime("system", "memory", {
          type: "memory_item_forgotten",
          itemId: item.itemId,
          namespace: item.namespace,
          lifecycleState: item.lifecycleState,
          actionId: action.actionId,
          requestedWorkspaceId: workspaceId,
          effectiveWorkspaceId: sourceRow
            ? resolveMemoryForgetEffectiveWorkspaceId(this.deps.admin, sourceRow)
            : undefined,
          includeGlobal: effectiveIncludeGlobal,
          source: action.source,
        });
      } catch (error) {
        realtimeError ??= error;
      }
    }
    if (realtimeError) {
      throw realtimeError;
    }

    return {
      actionId: action.actionId,
      matchedCount: transactionResult.matchedCount,
      alreadyForgottenCount: transactionResult.alreadyForgottenCount,
      forgottenCount: forgottenItems.length,
      itemIds: forgottenItems.map((item) => item.itemId),
      items: forgottenItems,
    };
  }

  public batchMutateMemoryItems(input: MemoryBatchMutationRequest, actorId = "operator"): MemoryBatchMutationResponse {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const operations = normalizeBatchMutationOperations(input.operations);
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const ownerId = actorId.trim() || "operator";

    for (const operation of operations) {
      requireMemoryItem(this.deps.admin, operation.itemId);
    }

    const ledgerOperations = operations.map((operation) => ({
      kind: operation.kind,
      itemId: operation.itemId,
      changedFields: operation.kind === "patch_item" ? getBatchPatchChangedFields(operation.patch) : undefined,
    }));
    const ledger = buildMemoryActionLedgerEntry({
      actionId: input.actionId,
      ownerId,
      source: input.source,
      status: "applied",
      operations: ledgerOperations,
    });

    const results = runTransaction(() =>
      operations.map((operation, operationIndex) =>
        this.applyBatchMemoryItemMutation(operation, operationIndex, ownerId, ledger),
      ),
    );

    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_batch_mutation_applied",
      actionId: ledger.actionId,
      operationKind: ledger.operationKind,
      itemIds: ledger.targetItemIds,
      appliedCount: results.length,
    });

    return {
      actionId: ledger.actionId,
      status: "applied",
      appliedCount: results.length,
      targetItemIds: ledger.targetItemIds,
      results,
      ledger,
    };
  }

  private applyBatchMemoryItemMutation(
    operation: MemoryBatchMutationOperation,
    operationIndex: number,
    actorId: string,
    ledger: MemoryActionLedgerEntry,
  ): MemoryBatchMutationResult {
    const item =
      operation.kind === "patch_item"
        ? this.applyBatchMemoryItemPatch(operation, actorId, ledger)
        : this.applyBatchMemoryItemForget(operation.itemId, actorId, ledger);
    return {
      operationIndex,
      kind: operation.kind,
      itemId: item.itemId,
      status: "applied",
      item,
    };
  }

  private applyBatchMemoryItemPatch(
    operation: Extract<MemoryBatchMutationOperation, { kind: "patch_item" }>,
    actorId: string,
    ledger: MemoryActionLedgerEntry,
  ): MemoryItemRecord {
    const current = requireMemoryItem(this.deps.admin, operation.itemId);
    const now = new Date().toISOString();
    const patch = operation.patch;
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
        itemId: operation.itemId,
        title: next.title,
        content: next.content,
        metadataJson: JSON.stringify(next.metadata ?? {}),
        pinned: next.pinned ? 1 : 0,
        ttlOverrideSeconds: next.ttlOverrideSeconds,
        expiresAt: next.expiresAt,
        updatedAt: now,
      });

    const changedFields = getBatchPatchChangedFields(patch);
    recordMemoryChange(
      this.deps.admin,
      operation.itemId,
      resolveBatchPatchChangeType(changedFields),
      actorId,
      buildMemoryChangeLedgerPayload(ledger, {
        kind: operation.kind,
        itemId: operation.itemId,
        changedFields,
      }),
    );
    return requireMemoryItem(this.deps.admin, operation.itemId);
  }

  private applyBatchMemoryItemForget(
    itemId: string,
    actorId: string,
    ledger: MemoryActionLedgerEntry,
  ): MemoryItemRecord {
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
    recordMemoryChange(
      this.deps.admin,
      itemId,
      "forgotten",
      actorId,
      buildMemoryChangeLedgerPayload(ledger, {
        kind: "forget_item",
        itemId,
      }),
    );
    return requireMemoryItem(this.deps.admin, itemId);
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

  public getRetrievalStatus(): MemoryRetrievalStatusResponse {
    return this.deps.context.retrievalStatus();
  }

  public listMemoryFeedback(
    input: {
      workspaceId?: string;
      kind?: MemoryFeedbackKind | "all";
      status?: MemoryFeedbackStatus | "all";
      targetKind?: MemoryFeedbackTargetKind;
      limit?: number;
    } = {},
  ): MemoryFeedbackRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureFeedbackSchema();
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.kind && input.kind !== "all") {
      clauses.push("kind = @kind");
      params.kind = input.kind;
    }
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.targetKind) {
      clauses.push("target_kind = @targetKind");
      params.targetKind = input.targetKind;
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_feedback
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryFeedbackRow[];
    return rows.map((row) => mapMemoryFeedbackRow(this.deps.admin, row));
  }

  public recordMemoryFeedback(input: MemoryFeedbackInput, actorId = "operator"): MemoryFeedbackRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureFeedbackSchema();
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId);
    this.assertMemoryFeedbackContentAllowed(
      JSON.stringify({
        note: input.note ?? "",
        metadata: input.metadata ?? {},
      }),
      workspaceId,
    );
    const now = new Date().toISOString();
    const feedback: MemoryFeedbackRecord = {
      feedbackId: randomUUID(),
      workspaceId,
      kind: normalizeMemoryFeedbackKind(input.kind),
      status: "open",
      targetKind: normalizeMemoryFeedbackTargetKind(input.targetKind),
      targetRef: optionalTrimmedText(input.targetRef),
      contextId: optionalTrimmedText(input.contextId),
      citationId: optionalTrimmedText(input.citationId),
      note: optionalTrimmedText(input.note),
      metadata: input.metadata ?? {},
      actorId: optionalTrimmedText(actorId),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_feedback (
        feedback_id, workspace_id, kind, status, target_kind, target_ref, context_id, citation_id,
        note, metadata_json, actor_id, created_at, updated_at
      ) VALUES (
        @feedbackId, @workspaceId, @kind, @status, @targetKind, @targetRef, @contextId, @citationId,
        @note, @metadataJson, @actorId, @createdAt, @updatedAt
      )
    `,
      )
      .run({
        feedbackId: feedback.feedbackId,
        workspaceId: feedback.workspaceId,
        kind: feedback.kind,
        status: feedback.status,
        targetKind: feedback.targetKind,
        targetRef: feedback.targetRef ?? null,
        contextId: feedback.contextId ?? null,
        citationId: feedback.citationId ?? null,
        note: feedback.note ?? null,
        metadataJson: JSON.stringify(feedback.metadata ?? {}),
        actorId: feedback.actorId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_feedback_recorded",
      feedbackId: feedback.feedbackId,
      kind: feedback.kind,
      targetKind: feedback.targetKind,
    });
    return feedback;
  }

  public listMemoryQualityIssues(input: MemoryQualityIssueListRequest = {}): MemoryQualityIssueRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    return this.deps.admin.memoryQualityIssues.list({
      ...input,
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    });
  }

  public runMemoryQualityScan(input: MemoryQualityScanRequest = {}, actorId = "operator"): MemoryQualityScanResponse {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureFeedbackSchema();
    this.ensureLearningSchema();
    const generatedAt = new Date().toISOString();
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId);
    const limit = normalizeStructuredLimit(input.limit);
    const warnings: string[] = [];
    const candidateIssues = new Map<string, MemoryQualityIssueInput & { dedupKey: string }>();
    const rememberIssue = (candidate: MemoryQualityIssueInput & { dedupKey: string }) => {
      const contentForGuard = JSON.stringify({
        summary: candidate.summary,
        rationale: candidate.rationale,
        metadata: candidate.metadata ?? {},
      });
      this.assertMemoryFeedbackContentAllowed(contentForGuard, workspaceId);
      candidateIssues.set(candidate.dedupKey, candidate);
    };

    const memoryItems = this.listMemoryItems({ workspaceId, status: "all", limit }).filter((item) =>
      matchesMemoryWorkspaceScope(item, workspaceId, normalizeStructuredWorkspaceId),
    );
    const learnings = this.listMemoryLearnings({ workspaceId, status: "all", limit });
    const feedback = this.listMemoryFeedback({ workspaceId, status: "open", limit });

    for (const item of memoryItems) {
      if (item.lifecycleState === "expired" && !item.pinned) {
        rememberIssue({
          workspaceId,
          kind: "stale_low_value",
          severity: "medium",
          targetKind: "memory_item",
          targetRef: item.itemId,
          relatedRefs: [],
          evidenceRefs: [{ sourceType: "memory_item", sourceRef: item.itemId, title: item.title }],
          summary: `Memory item "${item.title}" is expired and unpinned.`,
          rationale: "Expired unpinned memory is likely lower-value unless an operator refreshes or pins it.",
          metadata: {
            namespace: item.namespace,
            expiresAt: item.expiresAt,
            lifecycleState: item.lifecycleState,
            scannedBy: actorId,
          },
          dedupKey: buildMemoryQualityDedupKey(workspaceId, "stale_low_value", "memory_item", item.itemId),
        });
      }
    }

    for (const issue of this.checkMemoryLearningStaleness({ workspaceId, limit }).issues) {
      const kind = mapLearningStalenessToQualityKind(issue.issue);
      rememberIssue({
        workspaceId,
        kind,
        severity: mapLearningStalenessToQualitySeverity(issue.issue),
        targetKind: "learning",
        targetRef: issue.learningId,
        relatedRefs: issue.path ? [issue.path] : [],
        evidenceRefs: [
          {
            sourceType: issue.path ? "artifact" : "external",
            sourceRef: issue.path ?? issue.learningId,
            title: "Learning staleness check",
          },
        ],
        summary: issue.message,
        rationale: "Learning staleness checks compare recorded source refs, confidence, and sibling learning keys.",
        metadata: {
          stalenessIssue: issue.issue,
          path: issue.path,
          scannedBy: actorId,
        },
        dedupKey: buildMemoryQualityDedupKey(
          workspaceId,
          kind,
          "learning",
          issue.learningId,
          issue.path ? [issue.issue, issue.path] : [issue.issue],
        ),
      });
    }

    for (const duplicate of detectNearDuplicateMemoryItems(memoryItems)) {
      rememberIssue({
        workspaceId,
        kind: "near_duplicate",
        severity: "medium",
        targetKind: "memory_item",
        targetRef: duplicate.primary.itemId,
        relatedRefs: duplicate.related.map((item) => `memory_item:${item.itemId}`),
        evidenceRefs: [
          { sourceType: "memory_item", sourceRef: duplicate.primary.itemId, title: duplicate.primary.title },
          ...duplicate.related.map((item) => ({
            sourceType: "memory_item" as const,
            sourceRef: item.itemId,
            title: item.title,
          })),
        ],
        summary: `Memory item "${duplicate.primary.title}" has ${duplicate.related.length} near-duplicate record(s).`,
        rationale: "Duplicate memory can inflate recall and make why-used provenance harder to audit.",
        metadata: {
          namespace: duplicate.primary.namespace,
          duplicateScore: duplicate.score,
          scannedBy: actorId,
        },
        dedupKey: buildMemoryQualityDedupKey(
          workspaceId,
          "near_duplicate",
          "memory_item",
          duplicate.primary.itemId,
          duplicate.related.map((item) => item.itemId),
        ),
      });
    }

    for (const retrievalGap of detectRetrievalGaps(feedback)) {
      rememberIssue({
        workspaceId,
        kind: "retrieval_gap",
        severity: retrievalGap.feedback.length > 1 ? "high" : "medium",
        targetKind: retrievalGap.targetKind,
        targetRef: retrievalGap.targetRef,
        relatedRefs: retrievalGap.feedback.map((item) => `feedback:${item.feedbackId}`),
        evidenceRefs: retrievalGap.feedback.map((item) => ({
          sourceType: "external" as const,
          sourceRef: item.feedbackId,
          title: item.note ?? item.kind,
        })),
        summary: `Open missing-memory feedback for ${retrievalGap.targetKind}:${shortMemoryRef(retrievalGap.targetRef)}.`,
        rationale: "Missing-memory feedback means recall did not surface context the operator expected.",
        metadata: {
          feedbackIds: retrievalGap.feedback.map((item) => item.feedbackId),
          notes: retrievalGap.feedback.map((item) => item.note).filter(Boolean),
          scannedBy: actorId,
        },
        dedupKey: buildMemoryQualityDedupKey(
          workspaceId,
          "retrieval_gap",
          retrievalGap.targetKind,
          retrievalGap.targetRef,
          retrievalGap.feedback.map((item) => item.feedbackId),
        ),
      });
    }

    if (learnings.length === 0 && memoryItems.length === 0 && feedback.length === 0) {
      warnings.push("No memory items, learnings, or open feedback were available to scan.");
    }

    const issueInputs = [...candidateIssues.values()].slice(0, limit);
    let createdCount = 0;
    let updatedCount = 0;
    const issues = input.dryRun
      ? issueInputs.map((candidate, index) => dryRunQualityIssue(candidate, generatedAt, index))
      : issueInputs.map((candidate) => {
          const result = this.deps.admin.memoryQualityIssues.upsertOpenIssue(candidate);
          if (result.created) {
            createdCount += 1;
          } else {
            updatedCount += 1;
          }
          return result.record;
        });

    if (!input.dryRun) {
      this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_quality_scan_completed",
        workspaceId,
        issueCount: issues.length,
        createdCount,
        updatedCount,
      });
    }

    return {
      generatedAt,
      workspaceId,
      scannedCount: memoryItems.length + learnings.length + feedback.length,
      issueCount: issues.length,
      createdCount,
      updatedCount,
      dryRun: input.dryRun ?? false,
      issues,
      warnings,
    };
  }

  public patchMemoryQualityIssue(
    issueId: string,
    input: MemoryQualityIssuePatchInput,
    actorId = "operator",
  ): MemoryQualityIssueRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const record = this.deps.admin.memoryQualityIssues.patchStatus(issueId, {
      status: normalizeMemoryQualityIssueStatus(input.status),
      resolutionNote: optionalTrimmedText(input.resolutionNote),
    });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_quality_issue_updated",
      issueId: record.issueId,
      status: record.status,
      actorId,
      workspaceId: record.workspaceId,
    });
    return record;
  }

  public listTraceMemoryCandidates(
    input: {
      workspaceId?: string;
      status?: TraceMemoryCandidateStatus | "all";
      limit?: number;
    } = {},
  ): TraceMemoryCandidateRecord[] {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureTraceCandidateSchema();
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    const rows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_trace_candidates
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as TraceMemoryCandidateRow[];
    return rows.map((row) => mapTraceMemoryCandidateRow(this.deps.admin, row));
  }

  public async proposeTraceMemoryCandidate(
    input: TraceMemoryCandidateInput,
    actorId = "agent",
  ): Promise<TraceMemoryCandidateRecord> {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureTraceCandidateSchema();
    const sourceText = normalizeTraceCandidateText(
      await this.resolveTraceCandidateSourceText(input),
      "sourceText",
      1_200,
    );
    const proposedInsight = normalizeTraceCandidateText(input.proposedInsight, "proposedInsight", 1_000);
    const contentForGuard = JSON.stringify({
      sourceText,
      proposedInsight,
      sourceRefs: input.sourceRefs ?? [],
      metadata: input.metadata ?? {},
    });
    this.assertTraceCandidateContentAllowed(contentForGuard, input.workspaceId);
    const now = new Date().toISOString();
    const metadata = await withMemoryEmbeddingMetadata(
      input.metadata ?? {},
      buildStructuredMemoryEmbeddingText([proposedInsight, sourceText]),
    );
    const candidate: TraceMemoryCandidateRecord = {
      candidateId: randomUUID(),
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      candidateType: normalizeTraceCandidateType(input.candidateType),
      status: "proposed",
      sourceText,
      proposedInsight,
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeTraceCandidateSourceRefs(input, actorId),
      metadata,
      authority: "agent_proposed",
      actorId: optionalTrimmedText(actorId),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_trace_candidates (
        candidate_id, workspace_id, candidate_type, status, source_text, proposed_insight, confidence,
        source_refs_json, metadata_json, authority, actor_id, promoted_learning_id, created_at, updated_at
      ) VALUES (
        @candidateId, @workspaceId, @candidateType, @status, @sourceText, @proposedInsight, @confidence,
        @sourceRefsJson, @metadataJson, @authority, @actorId, NULL, @createdAt, @updatedAt
      )
    `,
      )
      .run({
        candidateId: candidate.candidateId,
        workspaceId: candidate.workspaceId,
        candidateType: candidate.candidateType,
        status: candidate.status,
        sourceText: candidate.sourceText,
        proposedInsight: candidate.proposedInsight,
        confidence: candidate.confidence,
        sourceRefsJson: JSON.stringify(candidate.sourceRefs),
        metadataJson: JSON.stringify(candidate.metadata ?? {}),
        authority: candidate.authority,
        actorId: candidate.actorId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    this.deps.evidence?.createEnvelope({
      eventKind: "memory_write",
      workspaceId: candidate.workspaceId,
      metadata: {
        traceMemoryCandidate: true,
        authority: candidate.authority,
        status: candidate.status,
        candidateType: candidate.candidateType,
        claimPreview: candidate.proposedInsight.slice(0, 240),
      },
    });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_trace_candidate_proposed",
      candidateId: candidate.candidateId,
      candidateType: candidate.candidateType,
    });
    return candidate;
  }

  public promoteTraceMemoryCandidate(candidateId: string, actorId = "operator"): MemoryLearningRecord {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    this.ensureTraceCandidateSchema();
    const candidate = this.requireTraceMemoryCandidate(candidateId);
    if (candidate.status !== "proposed") {
      throw new ValidationError({ message: "Only proposed trace memory candidates can be promoted." });
    }
    const key =
      readRecordString(candidate.metadata ?? {}, "key") ?? `trace.${candidate.candidateType}.${candidate.candidateId}`;
    const learning = this.createMemoryLearning(
      {
        workspaceId: candidate.workspaceId,
        key,
        type: mapTraceCandidateToLearningType(candidate.candidateType),
        insight: candidate.proposedInsight,
        confidence: candidate.confidence,
        sourceRefs: candidate.sourceRefs,
        authority: "operator",
      },
      actorId,
    );
    const now = new Date().toISOString();
    this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_trace_candidates
      SET status = 'promoted',
          promoted_learning_id = @learningId,
          updated_at = @updatedAt
      WHERE candidate_id = @candidateId
    `,
      )
      .run({ candidateId, learningId: learning.learningId, updatedAt: now });
    this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_trace_candidate_promoted",
      candidateId,
      learningId: learning.learningId,
    });
    return learning;
  }

  public async recallMemory(input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const limit = Math.max(1, Math.min(25, Math.floor(input.limit ?? 8)));
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId ?? input.workspace);
    const feedback = this.listMemoryFeedback({ workspaceId, limit: 12 });
    const traceCandidates = this.listTraceMemoryCandidates({ workspaceId, status: "proposed", limit: 12 });
    const qualityIssues = this.listMemoryQualityIssues({ workspaceId, status: "open", limit: 12 });
    const recentContexts = this.listRecentContexts(limit);
    const warnings: string[] = [];
    if (input.mode === "targeted") {
      const prompt = requireTrimmedText(input.prompt, "prompt");
      const context = await this.composeContext({
        scope: input.scope ?? "chat",
        prompt,
        // Finding 1: scope targeted recall's memory-item retrieval to the resolved
        // workspace (already computed above), not the unfiltered cross-workspace query.
        workspaceId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        phaseId: input.phaseId,
        workspace: input.workspace,
        relationScope: input.relationScope,
        maxContextTokens: input.maxContextTokens,
        queryEmbedding: input.queryEmbedding,
      });
      return {
        mode: input.mode,
        generatedAt: new Date().toISOString(),
        summary: `Targeted recall selected ${context.citations.length} cited memories. Context is returned for the caller to inspect; it is not automatically injected.`,
        context,
        recentContexts: [context, ...recentContexts.filter((item) => item.contextId !== context.contextId)].slice(
          0,
          limit,
        ),
        feedback,
        traceCandidates,
        qualityIssues,
        warnings,
      };
    }
    if (input.mode === "post_compaction_resume") {
      warnings.push(
        "Post-compaction recall is explicit context for resume planning; callers must choose what to reuse.",
      );
    }
    return {
      mode: input.mode,
      generatedAt: new Date().toISOString(),
      summary: buildRecallSummary(input.mode, recentContexts, feedback, traceCandidates, qualityIssues),
      recentContexts,
      feedback,
      traceCandidates,
      qualityIssues,
      warnings,
    };
  }

  public async runRetrievalBenchmark(
    input: MemoryRetrievalBenchmarkRequest,
  ): Promise<MemoryRetrievalBenchmarkResponse> {
    const requestedPrompts = input.prompts.map((prompt) => prompt.trim()).filter(Boolean);
    const prompts = Array.from(new Set(requestedPrompts)).slice(0, 25);
    if (prompts.length === 0) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "prompts" });
    }
    const warnings: string[] = [];
    if (requestedPrompts.length !== input.prompts.length) {
      warnings.push("Blank benchmark prompts were ignored.");
    }
    if (requestedPrompts.length > prompts.length) {
      warnings.push("Duplicate or excess benchmark prompts were ignored.");
    }
    const items: MemoryRetrievalBenchmarkItem[] = [];
    for (const prompt of prompts) {
      const startedAt = Date.now();
      try {
        const pack = await this.composeContext({
          scope: "chat",
          prompt,
          // Finding 1: scope benchmark retrieval to the requested workspace hint.
          workspaceId: normalizeStructuredWorkspaceId(input.workspace),
          workspace: input.workspace,
          relationScope: input.relationScope,
          maxContextTokens: input.maxContextTokens,
          forceRefresh: true,
        });
        const sourceText = [pack.contextText, ...pack.citations.map((citation) => citation.snippet ?? "")]
          .filter(Boolean)
          .join("\n");
        items.push({
          prompt,
          status: "completed",
          latencyMs: Date.now() - startedAt,
          contextId: pack.contextId,
          citationsCount: pack.citations.length,
          originalTokenEstimate: pack.originalTokenEstimate,
          distilledTokenEstimate: pack.distilledTokenEstimate,
          overlapScore: calculateLexicalOverlap(prompt, sourceText),
          retrievalStrategy: resolveBenchmarkRetrievalStrategy(pack),
          semanticCoverageNote: buildMemoryBenchmarkCoverageNote(pack),
          qmdStatus: pack.quality.status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Benchmark prompt failed: ${message}`);
        items.push({
          prompt,
          status: "failed",
          latencyMs: Date.now() - startedAt,
          citationsCount: 0,
          originalTokenEstimate: 0,
          distilledTokenEstimate: 0,
          overlapScore: 0,
          error: message,
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      itemCount: items.length,
      avgLatencyMs: average(items.map((item) => item.latencyMs)),
      avgOverlapScore: average(items.filter((item) => item.status === "completed").map((item) => item.overlapScore)),
      retrievalStrategies: Array.from(
        new Set(
          items.map((item) => item.retrievalStrategy).filter((item): item is MemoryRetrievalStrategy => Boolean(item)),
        ),
      ),
      semanticCoverageNote:
        "Retrieval benchmark overlap is lexical and provenance-aware. Hybrid ranking uses BM25-style lexical signals, operator-visible semantic hints, optional caller-supplied embeddings, recency, and source diversity.",
      items,
      warnings,
    };
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
    const workspaceId = this.deps.resolveSessionWorkspaceId?.(sessionId);
    if (
      this.scanBrowserContentGuardForMemory(content, { sessionId, workspaceId, sourceRef: source.sourceRef }).blocked
    ) {
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
        workspaceId,
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
    this.assertStructuredMemoryWriteAllowed(
      learning.authority,
      serializeLearningForGate(learning),
      learning.workspaceId,
    );
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

  private ensureFeedbackSchema(): void {
    this.deps.admin.gatewaySql
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS memory_feedback (
        feedback_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_ref TEXT,
        context_id TEXT,
        citation_id TEXT,
        note TEXT,
        metadata_json TEXT NOT NULL,
        actor_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
      )
      .run();
    this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_feedback_workspace_status ON memory_feedback(workspace_id, status)",
      )
      .run();
    this.deps.admin.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_memory_feedback_target ON memory_feedback(target_kind, target_ref)")
      .run();
  }

  private ensureTraceCandidateSchema(): void {
    this.deps.admin.gatewaySql
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS memory_trace_candidates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        candidate_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_text TEXT NOT NULL,
        proposed_insight TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        actor_id TEXT,
        promoted_learning_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
      )
      .run();
    this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_trace_candidates_workspace_status ON memory_trace_candidates(workspace_id, status)",
      )
      .run();
  }

  private requireTraceMemoryCandidate(candidateId: string): TraceMemoryCandidateRecord {
    const row = this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_trace_candidates WHERE candidate_id = ?")
      .get(candidateId) as TraceMemoryCandidateRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "memory_trace_candidate", id: candidateId });
    }
    return mapTraceMemoryCandidateRow(this.deps.admin, row);
  }

  private async resolveTraceCandidateSourceText(input: TraceMemoryCandidateInput): Promise<string> {
    if (input.sourceText?.trim()) {
      return input.sourceText;
    }
    const sessionId =
      input.sourceSessionId?.trim() ||
      input.sourceRefs?.find((ref) => ref.sourceType === "session")?.sourceRef.trim() ||
      undefined;
    if (sessionId) {
      const events = await this.deps.readTranscriptOrEmpty(sessionId);
      const turnId =
        input.sourceTurnId?.trim() || input.sourceRefs?.find((ref) => ref.sourceType === "turn")?.sourceRef;
      const relevant = turnId
        ? events.filter((event) => event.eventId === turnId || event.actionId === turnId)
        : events;
      const summarized = relevant
        .slice(-6)
        .map((event) => summarizeTranscriptEventForMemory(event))
        .filter(Boolean)
        .join("\n");
      if (summarized.trim()) {
        return summarized;
      }
    }
    const runId =
      input.sourceRunId?.trim() || input.sourceRefs?.find((ref) => ref.sourceType === "run")?.sourceRef.trim() || "";
    if (runId) {
      const summarized = this.listRunContexts(runId)
        .slice(0, 3)
        .map((context) => `${context.scope} context ${context.contextId}: ${context.quality.status}`)
        .join("\n");
      if (summarized.trim()) {
        return summarized;
      }
    }
    throw new ValidationError({
      field: "sourceText",
      message: "Trace memory candidates require sourceText or a resolvable session/run/turn source reference.",
    });
  }

  private assertTraceCandidateContentAllowed(content: string, workspaceId?: string): void {
    if (SECRET_LIKE_TRACE_PATTERN.test(content)) {
      this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId: normalizeStructuredWorkspaceId(workspaceId),
        metadata: {
          traceMemoryCandidate: true,
          decision: "blocked_secret_like_content",
          claimPreview: "[redacted]",
        },
      });
      throw new PolicyViolationError({
        message: "Trace-derived memory candidates cannot store secret-like payloads.",
      });
    }
    const browserContentGuard = this.scanBrowserContentGuardForMemory(content, {
      workspaceId: normalizeStructuredWorkspaceId(workspaceId),
      structuredMemory: true,
      traceMemoryCandidate: true,
      authority: "agent_proposed",
    });
    if (browserContentGuard.blocked) {
      throw new PolicyViolationError({
        message: "Browser content guard blocked trace-derived memory candidate.",
        details: { browserContentGuard },
      });
    }
  }

  private assertMemoryFeedbackContentAllowed(content: string, workspaceId?: string): void {
    if (SECRET_LIKE_TRACE_PATTERN.test(content)) {
      this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId: normalizeStructuredWorkspaceId(workspaceId),
        metadata: {
          memoryFeedback: true,
          decision: "blocked_secret_like_content",
          claimPreview: "[redacted]",
        },
      });
      throw new PolicyViolationError({
        message: "Memory feedback cannot store secret-like payloads.",
      });
    }
    const browserContentGuard = this.scanBrowserContentGuardForMemory(content, {
      workspaceId: normalizeStructuredWorkspaceId(workspaceId),
      structuredMemory: true,
      memoryFeedback: true,
      authority: "operator",
    });
    if (browserContentGuard.blocked) {
      throw new PolicyViolationError({
        message: "Browser content guard blocked memory feedback.",
        details: { browserContentGuard },
      });
    }
  }

  private assertStructuredMemoryWriteAllowed(
    authority: StructuredMemoryAuthority,
    content: string,
    workspaceId?: string,
  ): void {
    const browserContentGuard = this.scanBrowserContentGuardForMemory(content, {
      workspaceId: normalizeStructuredWorkspaceId(workspaceId),
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
        workspaceId: normalizeStructuredWorkspaceId(workspaceId),
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
        workspaceId: readRecordString(metadata, "workspaceId"),
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

interface MemoryFeedbackRow {
  feedback_id: string;
  workspace_id: string;
  kind: string;
  status: string;
  target_kind: string;
  target_ref: string | null;
  context_id: string | null;
  citation_id: string | null;
  note: string | null;
  metadata_json: string | null;
  actor_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TraceMemoryCandidateRow {
  candidate_id: string;
  workspace_id: string;
  candidate_type: string;
  status: string;
  source_text: string;
  proposed_insight: string;
  confidence: number;
  source_refs_json: string | null;
  metadata_json: string | null;
  authority: string;
  actor_id: string | null;
  promoted_learning_id: string | null;
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
  const sourceRefs = parseMemoryJson<StructuredMemorySourceRef[]>(host, row.source_refs_json, []);
  const metadata = parseMemoryJson<Record<string, unknown>>(host, row.metadata_json, {});
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
    sourceRefs,
    metadata,
    authority: normalizeAuthority(row.authority),
    lineage: extractStructuredLineage(metadata, sourceRefs),
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

function mapMemoryFeedbackRow(host: MemoryLifecycleAdminDependencies, row: MemoryFeedbackRow): MemoryFeedbackRecord {
  return {
    feedbackId: row.feedback_id,
    workspaceId: row.workspace_id,
    kind: normalizeMemoryFeedbackKind(row.kind),
    status: normalizeMemoryFeedbackStatus(row.status),
    targetKind: normalizeMemoryFeedbackTargetKind(row.target_kind),
    targetRef: row.target_ref ?? undefined,
    contextId: row.context_id ?? undefined,
    citationId: row.citation_id ?? undefined,
    note: row.note ?? undefined,
    metadata: parseMemoryJson(host, row.metadata_json, {}),
    actorId: row.actor_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTraceMemoryCandidateRow(
  host: MemoryLifecycleAdminDependencies,
  row: TraceMemoryCandidateRow,
): TraceMemoryCandidateRecord {
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    candidateType: normalizeTraceCandidateType(row.candidate_type),
    status: normalizeTraceCandidateStatus(row.status),
    sourceText: row.source_text,
    proposedInsight: row.proposed_insight,
    confidence: normalizeConfidence(row.confidence),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    metadata: parseMemoryJson(host, row.metadata_json, {}),
    authority: "agent_proposed",
    actorId: row.actor_id ?? undefined,
    promotedLearningId: row.promoted_learning_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemoryRelationRow(host: MemoryLifecycleAdminDependencies, row: MemoryRelationRow): MemoryRelationRecord {
  const sourceRefs = parseMemoryJson<StructuredMemorySourceRef[]>(host, row.source_refs_json, []);
  const metadata = parseMemoryJson<Record<string, unknown>>(host, row.metadata_json, {});
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
    sourceRefs,
    metadata,
    authority: normalizeAuthority(row.authority),
    lineage: extractStructuredLineage(metadata, sourceRefs),
    degradedReason: row.degraded_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
  };
}

function mapMemoryDecisionRow(host: MemoryLifecycleAdminDependencies, row: MemoryDecisionRow): MemoryDecisionRecord {
  const sourceRefs = parseMemoryJson<StructuredMemorySourceRef[]>(host, row.source_refs_json, []);
  const metadata = parseMemoryJson<Record<string, unknown>>(host, row.metadata_json, {});
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
    sourceRefs,
    metadata,
    authority: normalizeAuthority(row.authority),
    lineage: extractStructuredLineage(metadata, sourceRefs, row.run_id ?? undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
    supersededById: row.superseded_by_id ?? undefined,
  };
}

function parseMemoryJson<T>(host: MemoryLifecycleAdminDependencies, value: string | null | undefined, fallback: T): T {
  return host.tryParseJson<T>(value, fallback);
}

function normalizeBatchMutationOperations(
  operations: MemoryBatchMutationRequest["operations"] | undefined,
): MemoryBatchMutationOperation[] {
  if (!operations || operations.length === 0) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "operations" });
  }
  if (operations.length > 100) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "operations" });
  }
  return operations.map((operation, index) => {
    const itemId = operation.itemId.trim();
    if (!itemId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: `operations.${index}.itemId` });
    }
    if (operation.kind === "patch_item") {
      return {
        kind: operation.kind,
        itemId,
        patch: operation.patch ?? {},
      };
    }
    return {
      kind: operation.kind,
      itemId,
    };
  });
}

function requireMemoryBatchTransaction(
  gatewaySql: MemoryLifecycleAdminDependencies["gatewaySql"],
): <T>(callback: () => T) => T {
  const runImmediateTransaction = gatewaySql.runImmediateTransaction;
  if (typeof runImmediateTransaction !== "function") {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Atomic memory batch mutations require transactional gateway storage.",
    });
  }
  return runImmediateTransaction.bind(gatewaySql) as <T>(callback: () => T) => T;
}

const MEMORY_FORGET_UPDATE_CHUNK_SIZE = 500;
const MEMORY_FORGET_POSTGRES_LOCK_TIMEOUT_MS = 5_000;

function chunkMemoryItemIds(itemIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < itemIds.length; index += MEMORY_FORGET_UPDATE_CHUNK_SIZE) {
    chunks.push(itemIds.slice(index, index + MEMORY_FORGET_UPDATE_CHUNK_SIZE));
  }
  return chunks;
}

function compareMemoryItemIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeMemoryLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function resolveMemoryForgetEffectiveWorkspaceId(
  host: MemoryItemHost,
  row: Pick<MemoryForgetSelectionRow, "metadata_json" | "workspace_id">,
): string | undefined {
  if (row.workspace_id !== null) {
    return row.workspace_id;
  }
  const metadata = host.tryParseJson<unknown>(row.metadata_json, {});
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const legacyWorkspaceId = (metadata as Record<string, unknown>).workspaceId;
  return typeof legacyWorkspaceId === "string" && legacyWorkspaceId.trim() ? legacyWorkspaceId.trim() : undefined;
}

function getBatchPatchChangedFields(patch: MemoryLifecyclePatch): string[] {
  const fields: Array<keyof MemoryLifecyclePatch> = ["title", "content", "metadata", "pinned", "ttlOverrideSeconds"];
  return fields.filter((field) => patch[field] !== undefined);
}

function resolveBatchPatchChangeType(changedFields: string[]): MemoryChangeEvent["changeType"] {
  if (changedFields.length === 1 && changedFields[0] === "pinned") {
    return "pin_changed";
  }
  if (changedFields.length === 1 && changedFields[0] === "ttlOverrideSeconds") {
    return "ttl_changed";
  }
  return "updated";
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

function normalizeMemoryFeedbackKind(value: string | undefined): MemoryFeedbackKind {
  return value === "stale" || value === "missing" || value === "irrelevant" || value === "useful" ? value : "useful";
}

function normalizeMemoryFeedbackStatus(value: string | undefined): MemoryFeedbackStatus {
  return value === "reviewed" || value === "dismissed" ? value : "open";
}

function normalizeMemoryFeedbackTargetKind(value: string | undefined): MemoryFeedbackTargetKind {
  return value === "context" ||
    value === "citation" ||
    value === "memory_item" ||
    value === "entity" ||
    value === "relation" ||
    value === "decision" ||
    value === "learning" ||
    value === "trace_candidate"
    ? value
    : "context";
}

function normalizeMemoryQualityIssueStatus(value: string | undefined): MemoryQualityIssueStatus {
  return value === "resolved" || value === "dismissed" ? value : "open";
}

function normalizeMemoryQualityIssueSeverity(value: string | undefined): MemoryQualityIssueSeverity {
  return value === "low" || value === "high" ? value : "medium";
}

function mapLearningStalenessToQualityKind(issue: MemoryLearningStalenessIssue["issue"]): MemoryQualityIssueKind {
  if (issue === "low_confidence") {
    return "stale_low_value";
  }
  if (issue === "likely_contradiction") {
    return "likely_contradiction";
  }
  return "source_drift";
}

function mapLearningStalenessToQualitySeverity(
  issue: MemoryLearningStalenessIssue["issue"],
): MemoryQualityIssueSeverity {
  if (issue === "likely_contradiction" || issue === "missing_file") {
    return "high";
  }
  if (issue === "low_confidence") {
    return "low";
  }
  return "medium";
}

interface NearDuplicateMemoryItems {
  primary: MemoryItemRecord;
  related: MemoryItemRecord[];
  score: number;
}

function detectNearDuplicateMemoryItems(items: MemoryItemRecord[]): NearDuplicateMemoryItems[] {
  const activeItems = items.filter((item) => item.status === "active").slice(0, 125);
  const groups = new Map<string, NearDuplicateMemoryItems>();
  for (let leftIndex = 0; leftIndex < activeItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeItems.length; rightIndex += 1) {
      const left = activeItems[leftIndex];
      const right = activeItems[rightIndex];
      if (!left || !right) {
        continue;
      }
      const score = calculateMemoryDuplicateScore(left, right);
      if (score < 0.82) {
        continue;
      }
      const primary = Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left : right;
      const related = primary.itemId === left.itemId ? right : left;
      const group = groups.get(primary.itemId) ?? { primary, related: [] as MemoryItemRecord[], score };
      if (!group.related.some((item) => item.itemId === related.itemId)) {
        group.related.push(related);
      }
      group.score = Math.max(group.score, score);
      groups.set(primary.itemId, group);
    }
  }
  return [...groups.values()].filter((group) => group.related.length > 0).slice(0, 25);
}

function calculateMemoryDuplicateScore(left: MemoryItemRecord, right: MemoryItemRecord): number {
  const leftTitle = normalizeQualityText(left.title);
  const rightTitle = normalizeQualityText(right.title);
  const titleMatch = leftTitle.length >= 6 && leftTitle === rightTitle;
  const leftContent = normalizeQualityText(left.content);
  const rightContent = normalizeQualityText(right.content);
  if (leftContent.length >= 80 && leftContent.slice(0, 240) === rightContent.slice(0, 240)) {
    return 0.94;
  }
  const leftTerms = significantTerms(`${left.title} ${left.content}`);
  const rightTerms = significantTerms(`${right.title} ${right.content}`);
  const overlap = calculateSetOverlap(leftTerms, rightTerms);
  if (titleMatch && overlap >= 0.5) {
    return Number(Math.max(0.86, overlap).toFixed(3));
  }
  return Number(overlap.toFixed(3));
}

function calculateSetOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersections = 0;
  for (const term of left) {
    if (right.has(term)) {
      intersections += 1;
    }
  }
  return intersections / Math.min(left.size, right.size);
}

interface RetrievalGapIssueGroup {
  targetKind: MemoryFeedbackTargetKind;
  targetRef: string;
  feedback: MemoryFeedbackRecord[];
}

function detectRetrievalGaps(feedback: MemoryFeedbackRecord[]): RetrievalGapIssueGroup[] {
  const groups = new Map<string, RetrievalGapIssueGroup>();
  for (const item of feedback) {
    if (item.kind !== "missing" || item.status !== "open") {
      continue;
    }
    const targetRef = item.targetRef ?? item.contextId ?? item.citationId ?? item.feedbackId;
    const noteKey = normalizeQualityText(item.note ?? "missing").slice(0, 80);
    const key = `${item.targetKind}|${targetRef}|${noteKey}`;
    const group = groups.get(key) ?? {
      targetKind: item.targetKind,
      targetRef,
      feedback: [],
    };
    group.feedback.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].slice(0, 25);
}

function buildMemoryQualityDedupKey(
  workspaceId: string,
  kind: MemoryQualityIssueKind,
  targetKind: MemoryFeedbackTargetKind,
  targetRef: string,
  relatedRefs: string[] = [],
): string {
  return [
    workspaceId,
    kind,
    targetKind,
    targetRef,
    ...relatedRefs
      .map((item) => item.trim())
      .filter(Boolean)
      .sort(),
  ].join("|");
}

function dryRunQualityIssue(
  input: MemoryQualityIssueInput & { dedupKey: string },
  generatedAt: string,
  index: number,
): MemoryQualityIssueRecord {
  return {
    issueId: `dry-run-${index + 1}`,
    workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
    kind: input.kind,
    status: "open",
    severity: normalizeMemoryQualityIssueSeverity(input.severity),
    targetKind: input.targetKind,
    targetRef: input.targetRef,
    relatedRefs: input.relatedRefs ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    summary: input.summary,
    rationale: input.rationale,
    metadata: input.metadata ?? {},
    dedupKey: input.dedupKey,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
}

function normalizeQualityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortMemoryRef(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function normalizeTraceCandidateType(value: string | undefined): TraceMemoryCandidateType {
  return value === "decision" ||
    value === "tool_outcome" ||
    value === "operator_preference" ||
    value === "repo_fact" ||
    value === "workflow"
    ? value
    : "fact";
}

function normalizeTraceCandidateStatus(value: string | undefined): TraceMemoryCandidateStatus {
  return value === "rejected" || value === "promoted" ? value : "proposed";
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

/**
 * Join the salient text fields of a structured-memory record into a single
 * string for embedding generation, dropping empties.
 */
function buildStructuredMemoryEmbeddingText(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function calculateLexicalOverlap(prompt: string, contextText: string): number {
  const promptTerms = significantTerms(prompt);
  if (promptTerms.size === 0) {
    return 0;
  }
  const contextTerms = significantTerms(contextText);
  let matches = 0;
  for (const term of promptTerms) {
    if (contextTerms.has(term)) {
      matches += 1;
    }
  }
  return Number((matches / promptTerms.size).toFixed(3));
}

function resolveBenchmarkRetrievalStrategy(pack: MemoryContextPack): MemoryRetrievalStrategy | undefined {
  return pack.citations.find((citation) => citation.provenance?.retrievalStrategy)?.provenance?.retrievalStrategy;
}

function buildMemoryBenchmarkCoverageNote(pack: MemoryContextPack): string {
  const strategies = new Set(
    pack.citations
      .map((citation) => citation.provenance?.retrievalStrategy)
      .filter((strategy): strategy is MemoryRetrievalStrategy => Boolean(strategy)),
  );
  if (strategies.has("hybrid_rank")) {
    return "Context used hybrid BM25, optional embedding, semantic hint, recency, and source-diversity scoring.";
  }
  if (strategies.has("semantic_vector")) {
    return "Context used caller-supplied embedding similarity over active memory items plus lexical/recency provenance.";
  }
  if (strategies.has("semantic_hints")) {
    return "Context used operator-visible semantic hints plus lexical/recency scoring; vector semantic search was not used.";
  }
  if (strategies.has("lexical_recency")) {
    return "Context was selected with lexical/recency provenance; vector semantic search was not used.";
  }
  if (pack.citations.length === 0) {
    return "No citations were selected, so retrieval strategy coverage is unavailable.";
  }
  return "Citation provenance did not record a retrieval strategy.";
}

function significantTerms(value: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "but",
    "for",
    "from",
    "has",
    "have",
    "how",
    "into",
    "that",
    "the",
    "this",
    "was",
    "what",
    "when",
    "where",
    "with",
    "you",
  ]);
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !stopWords.has(term)),
  );
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

const SECRET_LIKE_TRACE_PATTERN =
  /(?:(?:api[_-]?key|auth|cookie|credential|password|secret|token)\s*[:=]\s*["']?[a-z0-9._/-]{8,}|sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,}|bearer\s+[a-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

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

function normalizeTraceCandidateSourceRefs(
  input: TraceMemoryCandidateInput,
  actorId: string,
): StructuredMemorySourceRef[] {
  const refs: StructuredMemorySourceRef[] = [...(input.sourceRefs ?? [])];
  if (input.sourceSessionId?.trim()) {
    refs.push({ sourceType: "session", sourceRef: input.sourceSessionId.trim() });
  }
  if (input.sourceRunId?.trim()) {
    refs.push({ sourceType: "run", sourceRef: input.sourceRunId.trim() });
  }
  if (input.sourceTurnId?.trim()) {
    refs.push({ sourceType: "turn", sourceRef: input.sourceTurnId.trim() });
  }
  return normalizeSourceRefs(refs, actorId);
}

function normalizeTraceCandidateText(value: string | undefined, field: string, maxLength: number): string {
  const text = requireTrimmedText(value, field);
  const lineCount = text.split(/\r?\n/u).length;
  if (text.length > maxLength || lineCount > 20) {
    throw new ValidationError({
      field,
      message: "Trace memory candidates must be concise extracted insights, not raw tool outputs or logs.",
    });
  }
  return text;
}

function summarizeTranscriptEventForMemory(event: TranscriptEvent): string | undefined {
  const payload = event.payload ?? {};
  const candidate =
    readRecordString(payload, "summary") ??
    readRecordString(payload, "message") ??
    readRecordString(payload, "content") ??
    readRecordString(payload, "status") ??
    readRecordString(payload, "toolName");
  if (!candidate) {
    return undefined;
  }
  const prefix = `${event.type} ${event.eventId}`;
  return `${prefix}: ${candidate.slice(0, 220)}`;
}

function mapTraceCandidateToLearningType(candidateType: TraceMemoryCandidateType): MemoryLearningType {
  if (candidateType === "operator_preference") {
    return "operator_preference";
  }
  if (candidateType === "tool_outcome") {
    return "tooling";
  }
  if (candidateType === "workflow") {
    return "workflow";
  }
  return "repo_fact";
}

function readRecordString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function extractStructuredLineage(
  metadata: Record<string, unknown>,
  sourceRefs: StructuredMemorySourceRef[],
  fallbackRunId?: string,
): StructuredMemoryLineage | undefined {
  const sourceTurnId = readRecordString(metadata, "sourceTurnId") ?? firstSourceRefOfType(sourceRefs, "turn");
  const sourceRunId =
    readRecordString(metadata, "sourceRunId") ?? fallbackRunId ?? firstSourceRefOfType(sourceRefs, "run");
  const sourceSummaryRef =
    readRecordString(metadata, "sourceSummaryRef") ?? firstSourceRefOfType(sourceRefs, "summary");
  const mentionCount = readPositiveInteger(metadata.mentionCount);
  const freshness = normalizeMemoryFreshness(readRecordString(metadata, "freshness"));
  const supersedesIds = readStringArray(metadata.supersedesIds);
  const forgottenByChangeId = readRecordString(metadata, "forgottenByChangeId");
  const lineage: StructuredMemoryLineage = {
    sourceTurnId,
    sourceRunId,
    sourceSummaryRef,
    mentionCount,
    freshness,
    supersedesIds: supersedesIds.length > 0 ? supersedesIds : undefined,
    forgottenByChangeId,
  };
  return Object.values(lineage).some((value) => value !== undefined) ? lineage : undefined;
}

function firstSourceRefOfType(
  sourceRefs: StructuredMemorySourceRef[],
  sourceType: StructuredMemorySourceRef["sourceType"],
) {
  return sourceRefs.find((ref) => ref.sourceType === sourceType)?.sourceRef;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function normalizeMemoryFreshness(value: string | undefined) {
  return value === "fresh" || value === "recent" || value === "stale" || value === "unknown" ? value : undefined;
}

function buildRecallSummary(
  mode: MemoryRecallRequest["mode"],
  recentContexts: MemoryContextPack[],
  feedback: MemoryFeedbackRecord[],
  traceCandidates: TraceMemoryCandidateRecord[],
  qualityIssues: MemoryQualityIssueRecord[],
): string {
  const citationCount = recentContexts.reduce((sum, context) => sum + context.citations.length, 0);
  const usefulCount = feedback.filter((item) => item.kind === "useful").length;
  const feedbackIssueCount = feedback.length - usefulCount;
  if (mode === "post_compaction_resume") {
    return `${recentContexts.length} recent context packs with ${citationCount} citations are available for explicit resume context. ${traceCandidates.length} trace-derived candidates remain proposed, and ${qualityIssues.length} open quality issues are queued for review.`;
  }
  return `${recentContexts.length} recent context packs, ${citationCount} citations, ${usefulCount} useful feedback records, ${feedbackIssueCount} feedback issues, and ${qualityIssues.length} open quality issues are available for explicit summary recall.`;
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

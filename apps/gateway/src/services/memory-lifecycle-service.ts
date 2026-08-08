/* eslint-disable max-lines -- MemoryLifecycleService centralizes memory lifecycle writes, write-gate evidence, and structured memory governance until repository ownership is split. */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ChatTurnTraceRecord,
  ChatMessageSourceAuthority,
  DurableRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  MemoryWriteAuthority,
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
  ModelUsageAttributionContext,
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
  TraceMemoryCandidateAuthority,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateStatus,
  TraceMemoryCandidateType,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import {
  ConflictError,
  MEMORY_FORGET_MAX_ITEM_IDS,
  MEMORY_LIFECYCLE_APPROVAL_KIND,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  canonicalJsonString,
  type ApprovalRequest,
  type BrowserContentGuardResult,
} from "@goatcitadel/contracts";
import type { AsyncGatewaySqlRepository, AsyncStorage } from "@goatcitadel/storage";
import {
  assertWritePathInJail,
  scanBrowserContentGuard,
  type AcquireLocalEmbeddingLease,
  type PrepareEmbeddingUsageDispatch,
} from "@goatcitadel/policy-engine";
import { buildMemoryWorkspaceScopeSql } from "@goatcitadel/storage";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { extractLearnedMemoryCandidates, shouldExtractLearnedMemoryContent } from "./learned-memory-utils.js";
import { MemoryContextService } from "./memory-context-service.js";
import { mapMemoryItemRow, recordMemoryChange, requireMemoryItem, type MemoryItemHost } from "./memory-item-helpers.js";
import { withMemoryEmbeddingMetadata, type MemoryEmbeddingRuntimeOptions } from "./memory-embedding-metadata.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { normalizeMemoryForgetCriteria } from "./security-utils.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { buildMemoryActionLedgerEntry } from "./memory-action-ledger.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";
import { matchesMemoryWorkspaceScope } from "./memory-lifecycle-policy.js";
import {
  buildMemoryItemApprovalStateMaterial,
  buildMemoryItemsApprovalStateMaterial,
  buildMemoryLifecycleApprovalBinding,
  buildMemoryLifecycleRequestSha256,
  buildMemoryLifecycleStateSha256,
  deriveApprovedMemoryHistoryId,
  parseMemoryLifecycleApprovalBinding,
  resolveApprovedMemoryMutation,
  type ApprovedMemoryMutationContext,
  type ApprovedMemoryMutationAuthority,
  type MemoryJourneyApprovalAction,
  type MemoryJourneySubjectKind,
  type MemoryJourneyEventAction,
  type MemoryLifecycleApprovalBindingV1,
} from "./memory-journey-producer.js";
import {
  buildMemoryLifecycleApprovalPayload,
  buildMemoryLifecycleRequestJourneyEvent,
  buildStructuredMemoryJourneyEvent,
  createMemoryGovernedLifecycleRepository,
  deriveMemoryLifecycleApprovalId,
  MemoryLifecycleApplyError,
  memoryLifecycleRequestJourneyIdempotencyKey,
  mintMemoryMaintenanceSystemAuthority,
  parseMemoryLifecycleRequestEnvelope,
  persistApprovedMemoryMutationEvidence,
  persistMemorySystemExpiryEvidence,
  type MemoryMaintenanceSystemAuthority,
  type MemoryGovernedLifecycleRepository,
} from "./memory-domain-journey-producer.js";

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
  /** Explicit canonical approval authority for the HX-402 Journey producer. */
  approvedMutation?: ApprovedMemoryMutationContext;
}

export interface MemoryForgetItemOptions extends MemoryForgetCommitHooks {
  actionId?: string;
  source?: string;
}

/** Route-time commit hooks for the approval-request write (idempotency truth). */
export interface MemoryMutationRequestHooks {
  onCommit?: () => void;
  afterCommit?: () => void;
}

export interface MemoryLifecyclePendingApproval {
  approvalId: string;
  status: ApprovalRequest["status"];
  kind: typeof MEMORY_LIFECYCLE_APPROVAL_KIND;
  action: MemoryJourneyApprovalAction;
  subjectKind: MemoryJourneySubjectKind;
  subjectId?: string;
  workspaceId: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
  itemIds: string[];
}

export interface MemoryMutationApprovalEnvelope {
  pendingApproval: MemoryLifecyclePendingApproval;
}

export type MemoryForgetApprovalOutcome =
  | MemoryMutationApprovalEnvelope
  | {
      pendingApproval: null;
      noMutationRequired: true;
      matchedCount: number;
      alreadyForgottenCount: number;
    };

export interface MemoryLifecycleApplyResult {
  disposition: "applied" | "no_op";
  action: MemoryJourneyApprovalAction;
  subjectKind: MemoryJourneySubjectKind;
  subjectId?: string;
  workspaceId: string;
  itemIds: string[];
  changedCount: number;
}

const MEMORY_LIFECYCLE_APPROVAL_TTL_MS = 15 * 60_000;

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
  gatewaySql: AsyncGatewaySqlRepository;
  memoryQualityIssues: Pick<AsyncStorage["memoryQualityIssues"], "list" | "upsertOpenIssue" | "patchStatus">;
  requireFeatureEnabled(flag: string): void | Promise<void>;
  publishRealtime(channel: string, topic: string, payload: Record<string, unknown>): Promise<unknown>;
}

/**
 * Canonical approval-authority collaborators for the HX-402 P1 approval-first
 * memory surface. Optional so read-only harnesses can omit them; every
 * mutation entry point fails closed when the host is absent.
 */
export interface MemoryLifecycleApprovalAuthorityHost {
  approvals: Pick<AsyncStorage["approvals"], "createDeterministicDetachedWithTtlDuration" | "get">;
  approvalEvents: Pick<AsyncStorage["approvalEvents"], "append">;
  governanceJourneyEvents: Pick<AsyncStorage["governanceJourneyEvents"], "create" | "findByIdempotencyKey">;
}

export interface MemoryLifecycleDependencies {
  readonly context: MemoryContextService;
  readonly learned: ChatLearnedMemoryService;
  readonly maintenance: MemoryMaintenanceService;
  readonly admin: MemoryLifecycleAdminDependencies;
  readonly approvalAuthority?: MemoryLifecycleApprovalAuthorityHost;
  resolveLearnedMemoryPolicy(sessionId: string): Promise<{
    allowWrite: boolean;
    memoryMode?: "off" | "auto" | "on";
    reason?: "memory_mode_off" | "replay_scratch" | "allowed";
  }>;
  readonly files?: {
    rootDir: string;
    workspaceDir: string;
    writeJailRoots: string[];
    normalizeRelativePath(relativePath: string): string;
  };
  readonly writeGate?: MemoryWriteGateService;
  readonly evidence?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  readonly acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;
  readonly prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch;
  resolveSessionWorkspaceId?: (sessionId: string) => Promise<string | undefined>;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
}

/**
 * Canonical coordinator for memory lifecycle policy and operator-facing entry
 * points. Lower-level services remain focused collaborators for context
 * composition, learned-memory persistence, and maintenance execution.
 */
export class MemoryLifecycleService {
  private governedLifecycleRepository?: MemoryGovernedLifecycleRepository;
  private maintenanceSystemAuthority?: MemoryMaintenanceSystemAuthority;

  public constructor(private readonly deps: MemoryLifecycleDependencies) {}

  private getGovernedLifecycleRepository(): MemoryGovernedLifecycleRepository {
    this.governedLifecycleRepository ??= createMemoryGovernedLifecycleRepository(this.deps.admin.gatewaySql);
    return this.governedLifecycleRepository;
  }

  private requireApprovalAuthority(): MemoryLifecycleApprovalAuthorityHost {
    const authority = this.deps.approvalAuthority;
    if (!authority) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Operator memory mutations require the canonical approval authority host.",
      });
    }
    return authority;
  }

  // ── HX-402 P1: approval-first operator mutation requests ─────────────

  /**
   * Request one approved memory-item patch. The route surface never mutates:
   * it commits a canonical `memory.lifecycle` approval (deterministic
   * payload-hash UUID identity over the exact request AND the exact reviewed
   * state) plus immutable requester Journey evidence, and only the recovered
   * approval effect may later execute the mutation.
   */
  public async requestMemoryItemPatchApproval(
    itemId: string,
    patch: MemoryLifecyclePatch,
    requesterId: string,
    hooks: MemoryMutationRequestHooks = {},
  ): Promise<MemoryMutationApprovalEnvelope> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const approvedPatch = snapshotApprovedMemoryItemPatch(patch);
    const current = requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, itemId));
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: current.workspaceId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: approvedPatch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const pendingApproval = await this.commitMemoryLifecycleApproval({
      binding,
      requesterId,
      mutation: approvedPatch,
      itemIds: [current.itemId],
      preview: {
        title: "Approve memory item update",
        action: binding.action,
        subjectKind: binding.subjectKind,
        subjectId: current.itemId,
        workspaceId: current.workspaceId,
        fieldCodes: Object.keys(approvedPatch).sort(),
      },
      hooks,
    });
    return { pendingApproval };
  }

  /**
   * Request one approved forget. Criteria (namespace/query/workspace scope)
   * resolve to exact item IDs at request time; the approval binds those IDs
   * and their reviewed state, so scope can never widen between review and
   * execution. Zero matching active items is a pure no-op: no approval row,
   * no evidence, no mutation.
   */
  public async requestMemoryForgetApproval(
    input: MemoryForgetRequest & { requesterId: string },
    hooks: MemoryMutationRequestHooks = {},
  ): Promise<MemoryForgetApprovalOutcome> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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
    const matchedRows = await this.selectForgetCandidateRows(criteria, workspaceId, includeGlobal);
    if (criteria.hasItemIds && matchedRows.length !== criteria.itemIds.length) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "itemIds",
        message: "Every explicit memory item must exist and satisfy the requested workspace and filters.",
      });
    }
    const activeRows = matchedRows.filter((row) => row.status === "active");
    const alreadyForgottenCount = matchedRows.filter((row) => row.status === "forgotten").length;
    if (activeRows.length === 0) {
      return {
        pendingApproval: null,
        noMutationRequired: true,
        matchedCount: matchedRows.length,
        alreadyForgottenCount,
      };
    }
    const activeItems = activeRows
      .map((row) => requireWorkspaceOwnedMemoryItem(mapMemoryItemRow(this.deps.admin, row)))
      .sort((left, right) => compareMemoryItemIds(left.itemId, right.itemId));
    const approvalWorkspaceId = workspaceId ?? activeItems[0]?.workspaceId;
    if (!approvalWorkspaceId || activeItems.some((item) => item.workspaceId !== approvalWorkspaceId)) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Approved memory forget requires items owned by exactly one workspace.",
      });
    }
    const itemIds = activeItems.map((item) => item.itemId);
    const actionId = normalizeApprovedMemoryActionId(
      input.actionId,
      `approved-memory-forget-${deriveApprovedMemoryRequestDigest({ workspaceId: approvalWorkspaceId, itemIds })}`,
    );
    const subjectKind: MemoryJourneySubjectKind = itemIds.length === 1 ? "memory_item" : "memory_item_batch";
    const subjectId = itemIds.length === 1 ? itemIds[0] : undefined;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: approvalWorkspaceId,
      subjectKind,
      subjectId,
      action: "items_forgotten",
      mutation: { actionId, itemIds },
      expectedState: buildMemoryItemsApprovalStateMaterial(activeItems),
    });
    const pendingApproval = await this.commitMemoryLifecycleApproval({
      binding,
      requesterId: input.requesterId,
      mutation: { actionId, itemIds },
      itemIds,
      preview: {
        title: "Approve memory forget",
        action: binding.action,
        subjectKind,
        ...(subjectId === undefined ? {} : { subjectId }),
        workspaceId: approvalWorkspaceId,
        itemCount: itemIds.length,
        alreadyForgottenCount,
      },
      hooks,
    });
    return { pendingApproval };
  }

  /**
   * Request one approved atomic batch mutation. One approval governs the whole
   * batch; the recovered effect applies every operation in one transaction or
   * none at all.
   */
  public async requestMemoryBatchMutationApproval(
    input: MemoryBatchMutationRequest,
    requesterId: string,
    hooks: MemoryMutationRequestHooks = {},
  ): Promise<MemoryMutationApprovalEnvelope> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const operations = snapshotApprovedBatchOperations(normalizeBatchMutationOperations(input.operations));
    const items = await Promise.all(
      operations.map(async (operation) =>
        requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, operation.itemId)),
      ),
    );
    const workspaceId = items[0]?.workspaceId;
    if (!workspaceId || items.some((item) => item.workspaceId !== workspaceId)) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Approved memory batch mutations require items owned by exactly one workspace.",
      });
    }
    const distinctItems = [...items].sort((left, right) => compareMemoryItemIds(left.itemId, right.itemId));
    const actionId = normalizeApprovedMemoryActionId(
      input.actionId,
      `approved-memory-batch-${deriveApprovedMemoryRequestDigest({ workspaceId, operations })}`,
    );
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId,
      subjectKind: "memory_item_batch",
      action: "batch_mutated",
      mutation: { actionId, operations },
      expectedState: buildMemoryItemsApprovalStateMaterial(distinctItems),
    });
    const pendingApproval = await this.commitMemoryLifecycleApproval({
      binding,
      requesterId,
      mutation: { actionId, operations },
      itemIds: distinctItems.map((item) => item.itemId),
      preview: {
        title: "Approve memory batch mutation",
        action: binding.action,
        subjectKind: binding.subjectKind,
        workspaceId,
        operationCount: operations.length,
        patchCount: operations.filter((operation) => operation.kind === "patch_item").length,
        forgetCount: operations.filter((operation) => operation.kind === "forget_item").length,
      },
      hooks,
    });
    return { pendingApproval };
  }

  private async commitMemoryLifecycleApproval(input: {
    binding: MemoryLifecycleApprovalBindingV1;
    requesterId: string;
    mutation: unknown;
    itemIds: string[];
    preview: Record<string, unknown>;
    hooks: MemoryMutationRequestHooks;
  }): Promise<MemoryLifecyclePendingApproval> {
    const authority = this.requireApprovalAuthority();
    const requesterId = requireCanonicalMemoryActorId(input.requesterId);
    const approvalId = deriveMemoryLifecycleApprovalId(input.binding);
    const payload = buildMemoryLifecycleApprovalPayload({
      binding: input.binding,
      requesterId,
      mutation: input.mutation,
    });
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const committed = await runTransaction(async () => {
      const stored = await authority.approvals.createDeterministicDetachedWithTtlDuration(
        {
          approvalId,
          kind: MEMORY_LIFECYCLE_APPROVAL_KIND,
          riskLevel: "danger",
          payload,
          preview: { ...input.preview },
          linkage: {
            workspaceId: input.binding.workspaceId,
            ...(input.binding.sessionId === undefined ? {} : { sessionId: input.binding.sessionId }),
            ...(input.binding.turnId === undefined ? {} : { turnId: input.binding.turnId }),
          },
        },
        MEMORY_LIFECYCLE_APPROVAL_TTL_MS,
      );
      if (stored.created) {
        await authority.approvalEvents.append({
          approvalId,
          eventType: "created",
          actorId: "system",
          timestamp: stored.approval.createdAt,
          payload: {
            kind: stored.approval.kind,
            riskLevel: stored.approval.riskLevel,
            status: stored.approval.status,
          },
        });
        await authority.governanceJourneyEvents.create(
          buildMemoryLifecycleRequestJourneyEvent({
            approval: stored.approval,
            binding: input.binding,
            requesterId,
            itemCount: input.itemIds.length,
          }),
        );
      } else {
        // The original requester remains the immutable evidence. A byte-exact
        // replay from the SAME requester converges; a different requester's
        // identical mutation conflicts in the approvals owner because the
        // requester is payload material. A missing evidence row self-heals so
        // the recovered effect can never execute without requester evidence.
        const evidence = await authority.governanceJourneyEvents.findByIdempotencyKey(
          memoryLifecycleRequestJourneyIdempotencyKey(approvalId),
        );
        if (!evidence) {
          await authority.governanceJourneyEvents.create(
            buildMemoryLifecycleRequestJourneyEvent({
              approval: stored.approval,
              binding: input.binding,
              requesterId,
              itemCount: input.itemIds.length,
            }),
          );
        }
      }
      input.hooks.onCommit?.();
      return stored;
    });
    input.hooks.afterCommit?.();
    if (committed.created) {
      await this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_mutation_approval_requested",
        approvalId,
        action: input.binding.action,
        subjectKind: input.binding.subjectKind,
        subjectId: input.binding.subjectId,
        workspaceId: input.binding.workspaceId,
        itemCount: input.itemIds.length,
      });
    }
    return {
      approvalId,
      status: committed.approval.status,
      kind: MEMORY_LIFECYCLE_APPROVAL_KIND,
      action: input.binding.action,
      subjectKind: input.binding.subjectKind,
      ...(input.binding.subjectId === undefined ? {} : { subjectId: input.binding.subjectId }),
      workspaceId: input.binding.workspaceId,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      ...(committed.approval.expiresAt ? { expiresAt: committed.approval.expiresAt } : {}),
      createdAt: committed.approval.createdAt,
      replayed: !committed.created,
      itemIds: [...input.itemIds],
    };
  }

  private async selectForgetCandidateRows(
    criteria: ReturnType<typeof normalizeMemoryForgetCriteria>,
    workspaceId: string | undefined,
    includeGlobal: boolean,
  ): Promise<MemoryForgetSelectionRow[]> {
    const clauses = ["1 = 1"];
    const params: Record<string, string | number | null> = {};
    const normalizedItemIds = [...criteria.itemIds].sort(compareMemoryItemIds);
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
      clauses.push(buildMemoryWorkspaceScopeSql(this.deps.admin.gatewaySql.dialect, { includeGlobal }));
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
    return await this.deps.admin.gatewaySql
      .prepare(
        `
        SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
               created_at, updated_at, forgotten_at, workspace_id
        FROM memory_items
        WHERE ${clauses.join(" AND ")}
        ORDER BY item_id
      `,
      )
      .all<MemoryForgetSelectionRow>(params);
  }

  // ── HX-402 P1: the recovered `memory.lifecycle` approval effect ──────

  /**
   * Execute one approved `memory.lifecycle` mutation as the recovered
   * approval effect. Revalidates the exact approval (kind, deterministic
   * identity, workspace linkage, status, expiry), recovers the requester from
   * the immutable request Journey evidence, byte-verifies the request hash
   * against the rebuilt mutation, re-checks current policy, and then executes
   * ONLY through the approved producer — which revalidates everything again
   * inside its own transaction. Governance violations throw the terminal
   * {@link MemoryLifecycleApplyError}; infrastructure errors propagate raw so
   * the approval-effect worker defers the effect for bounded retry.
   */
  public async executeApprovedMemoryLifecycleMutation(input: {
    workspaceId: string;
    approvalId: string;
  }): Promise<MemoryLifecycleApplyResult> {
    const authority = this.requireApprovalAuthority();
    let approval: ApprovalRequest;
    try {
      approval = await authority.approvals.get(input.approvalId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
      }
      throw error;
    }
    if (approval.kind !== MEMORY_LIFECYCLE_APPROVAL_KIND) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
    }
    const payload = approval.payload as Record<string, unknown> | undefined;
    const binding = parseMemoryLifecycleApprovalBinding(payload?.memoryLifecycle);
    const envelope = parseMemoryLifecycleRequestEnvelope(payload);
    if (
      !binding ||
      !envelope ||
      binding.workspaceId !== input.workspaceId ||
      approval.linkage?.workspaceId !== input.workspaceId ||
      deriveMemoryLifecycleApprovalId(binding) !== approval.approvalId
    ) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
    }
    try {
      await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    } catch {
      throw new MemoryLifecycleApplyError("memory_lifecycle_policy_blocked");
    }
    if (approval.status !== "approved" || !approval.resolvedBy) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_approval_expired");
    }
    const evidence = await authority.governanceJourneyEvents.findByIdempotencyKey(
      memoryLifecycleRequestJourneyIdempotencyKey(approval.approvalId),
    );
    if (!evidence || evidence.approvalId !== approval.approvalId || evidence.actorId !== envelope.requesterId) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_request_evidence_missing");
    }
    if (
      buildMemoryLifecycleRequestSha256({
        workspaceId: binding.workspaceId,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        action: binding.action,
        mutation: envelope.mutation,
      }) !== binding.requestSha256
    ) {
      throw new MemoryLifecycleApplyError("memory_lifecycle_request_drift");
    }
    const resolvedBy = approval.resolvedBy;
    const approvedMutation: ApprovedMemoryMutationContext = { approvalId: approval.approvalId };
    try {
      if (binding.action === "item_updated") {
        const itemId = binding.subjectId;
        if (!itemId || !isRecordValue(envelope.mutation)) {
          throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
        }
        const applied = await this.patchApprovedMemoryItem(
          itemId,
          envelope.mutation as MemoryLifecyclePatch,
          resolvedBy,
          approvedMutation,
        );
        return {
          disposition: applied.changed ? "applied" : "no_op",
          action: binding.action,
          subjectKind: binding.subjectKind,
          subjectId: itemId,
          workspaceId: binding.workspaceId,
          itemIds: [itemId],
          changedCount: applied.changed ? 1 : 0,
        };
      }
      if (binding.action === "items_forgotten") {
        const mutation = parseApprovedForgetMutation(envelope.mutation);
        if (!mutation) {
          throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
        }
        const response = await this.forgetMemory(
          {
            itemIds: mutation.itemIds,
            workspaceId: binding.workspaceId,
            actorId: resolvedBy,
            actionId: mutation.actionId,
          },
          { approvedMutation },
        );
        return {
          disposition: response.forgottenCount > 0 ? "applied" : "no_op",
          action: binding.action,
          subjectKind: binding.subjectKind,
          ...(binding.subjectId === undefined ? {} : { subjectId: binding.subjectId }),
          workspaceId: binding.workspaceId,
          itemIds: mutation.itemIds,
          changedCount: response.forgottenCount,
        };
      }
      const mutation = parseApprovedBatchMutation(envelope.mutation);
      if (!mutation) {
        throw new MemoryLifecycleApplyError("memory_lifecycle_approval_not_executable");
      }
      const response = await this.batchMutateMemoryItems(
        { actionId: mutation.actionId, source: "approved_memory_lifecycle", operations: mutation.operations },
        resolvedBy,
        approvedMutation,
      );
      return {
        disposition: response.appliedCount > 0 ? "applied" : "no_op",
        action: binding.action,
        subjectKind: binding.subjectKind,
        workspaceId: binding.workspaceId,
        itemIds: response.targetItemIds,
        changedCount: response.appliedCount,
      };
    } catch (error) {
      if (error instanceof MemoryLifecycleApplyError) throw error;
      if (
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof ValidationError ||
        error instanceof PolicyViolationError ||
        error instanceof TypeError
      ) {
        throw new MemoryLifecycleApplyError("memory_lifecycle_apply_conflict");
      }
      throw error;
    }
  }

  private memoryEmbeddingRuntimeOptions(attribution: ModelUsageAttributionContext): MemoryEmbeddingRuntimeOptions {
    return {
      ...(this.deps.acquireLocalEmbeddingLease
        ? { acquireLocalServiceLease: this.deps.acquireLocalEmbeddingLease }
        : {}),
      ...(this.deps.prepareEmbeddingUsageDispatch
        ? { prepareModelUsageDispatch: this.deps.prepareEmbeddingUsageDispatch }
        : {}),
      modelUsageAttribution: attribution,
    };
  }

  public async listMemoryLearnings(
    input: {
      workspaceId?: string;
      status?: MemoryLearningStatus | "all";
      query?: string;
      key?: string;
      limit?: number;
    } = {},
  ): Promise<MemoryLearningRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureLearningSchema();
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
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_learnings
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all<MemoryLearningRow>(params);
    return rows.map((row) => mapLearningRow(this.deps.admin, row));
  }

  public async createMemoryLearning(input: MemoryLearningInput, actorId = "operator"): Promise<MemoryLearningRecord> {
    return await this.insertMemoryLearning(
      input,
      actorId,
      input.authority === "agent_proposed" ? "proposed" : "trusted",
    );
  }

  public async proposeMemoryLearning(input: MemoryLearningInput, actorId = "agent"): Promise<MemoryLearningRecord> {
    return await this.insertMemoryLearning({ ...input, authority: "agent_proposed" }, actorId, "proposed");
  }

  public async supersedeMemoryLearning(
    learningId: string,
    input: MemoryLearningInput,
    actorId = "operator",
  ): Promise<{ previous: MemoryLearningRecord; next: MemoryLearningRecord }> {
    await this.ensureLearningSchema();
    const previous = await this.requireMemoryLearning(learningId);
    // Atomic supersession with explicit correction provenance: the successor
    // insert and the predecessor's superseded_by linkage commit together.
    const next = await this.runStructuredMemoryTransaction(async () => {
      const inserted = await this.insertMemoryLearning(
        {
          ...input,
          workspaceId: input.workspaceId ?? previous.workspaceId,
          key: input.key || previous.key,
        },
        actorId,
        input.authority === "agent_proposed" ? "proposed" : "trusted",
      );
      const now = new Date().toISOString();
      await this.deps.admin.gatewaySql
        .prepare(
          `
      UPDATE memory_learnings
      SET status = 'superseded', superseded_by_id = @nextId, updated_at = @updatedAt
      WHERE learning_id = @learningId
    `,
        )
        .run({ learningId, nextId: inserted.learningId, updatedAt: now });
      return inserted;
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_learning_superseded",
      learningId,
      supersededById: next.learningId,
      workspaceId: previous.workspaceId,
    });
    return { previous: await this.requireMemoryLearning(learningId), next };
  }

  public async forgetMemoryLearning(learningId: string, actorId = "operator"): Promise<MemoryLearningRecord> {
    await this.ensureLearningSchema();
    const current = await this.requireMemoryLearning(learningId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    await this.deps.admin.gatewaySql
      .prepare(
        `
      UPDATE memory_learnings
      SET status = 'forgotten', updated_at = @updatedAt
      WHERE learning_id = @learningId
    `,
      )
      .run({ learningId, updatedAt: now });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_learning_forgotten",
      learningId,
      actorId,
      workspaceId: current.workspaceId,
    });
    return await this.requireMemoryLearning(learningId);
  }

  public async checkMemoryLearningStaleness(
    input: {
      learningId?: string;
      workspaceId?: string;
      limit?: number;
    } = {},
  ): Promise<MemoryLearningStalenessReport> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureLearningSchema();
    const checkedAt = new Date().toISOString();
    const learnings = input.learningId
      ? [await this.requireMemoryLearning(input.learningId)]
      : await this.listMemoryLearnings({ workspaceId: input.workspaceId, status: "all", limit: input.limit });
    const issues = (
      await Promise.all(learnings.map(async (learning) => await this.inspectLearningIssues(learning)))
    ).flat();
    return { checkedAt, issues };
  }

  public async listMemoryEntities(
    input: { workspaceId?: string; status?: StructuredMemoryStatus | "all"; query?: string; limit?: number } = {},
  ): Promise<MemoryEntityRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_entities
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all<MemoryEntityRow>(params);
    return rows.map((row) => mapMemoryEntityRow(this.deps.admin, row));
  }

  public async createMemoryEntity(input: MemoryEntityInput, actorId = "operator"): Promise<MemoryEntityRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const title = requireTrimmedText(input.title, "title");
    const summary = optionalTrimmedText(input.summary);
    const aliases = normalizeStringArray(input.aliases);
    const entityWithoutEmbedding: MemoryEntityRecord = {
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
      metadata: { ...(input.metadata ?? {}) },
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    await this.assertStructuredMemoryWriteAllowed(
      entityWithoutEmbedding.authority,
      serializeStructuredMemoryForGate(entityWithoutEmbedding),
      entityWithoutEmbedding.workspaceId,
    );
    const entity: MemoryEntityRecord = {
      ...entityWithoutEmbedding,
      metadata: await withMemoryEmbeddingMetadata(
        entityWithoutEmbedding.metadata,
        buildStructuredMemoryEmbeddingText([title, summary, ...aliases]),
        undefined,
        this.memoryEmbeddingRuntimeOptions({
          operationId: `memory-entity:${entityWithoutEmbedding.id}:embedding`,
          dispatchGeneration: "initial-write",
          workspaceId: entityWithoutEmbedding.workspaceId,
          sessionId: firstSourceRefOfType(entityWithoutEmbedding.sourceRefs, "session"),
          turnId: firstSourceRefOfType(entityWithoutEmbedding.sourceRefs, "turn"),
          durableRunId: firstSourceRefOfType(entityWithoutEmbedding.sourceRefs, "run"),
          utilityKind: "memory_entity_write_embedding",
          agentId: actorId,
        }),
      ),
    };
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      await this.recordStructuredMemoryChange(
        "entity",
        entity.id,
        "created",
        actorId,
        { title: entity.title },
        {
          workspaceId: entity.workspaceId,
        },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_entity_created",
      entityId: entity.id,
      workspaceId: entity.workspaceId,
    });
    return entity;
  }

  public async forgetMemoryEntity(entityId: string, actorId = "operator"): Promise<MemoryEntityRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = await this.requireMemoryEntity(entityId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      await this.deps.admin.gatewaySql
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
      await this.recordStructuredMemoryChange(
        "entity",
        entityId,
        "forgotten",
        actorId,
        { previousStatus: current.status },
        {
          workspaceId: current.workspaceId,
        },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_entity_forgotten",
      entityId,
      workspaceId: current.workspaceId,
    });
    return await this.requireMemoryEntity(entityId);
  }

  public async listMemoryRelations(
    input: { workspaceId?: string; status?: StructuredMemoryStatus | "all"; entityId?: string; limit?: number } = {},
  ): Promise<MemoryRelationRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_relations
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all<MemoryRelationRow>(params);
    return rows.map((row) => mapMemoryRelationRow(this.deps.admin, row));
  }

  public async createMemoryRelation(input: MemoryRelationInput, actorId = "operator"): Promise<MemoryRelationRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const from = await this.requireMemoryEntity(input.fromEntityId);
    const to = await this.requireMemoryEntity(input.toEntityId);
    if (from.status !== "active" || to.status !== "active") {
      throw new ValidationError({
        field: "entityId",
        message: "Relations require active source and target entities.",
      });
    }
    const now = new Date().toISOString();
    const relationType = input.relationType.trim() || "related_to";
    const title = input.title?.trim() || `${from.title} ${relationType} ${to.title}`;
    const relationWithoutEmbedding: MemoryRelationRecord = {
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
      metadata: { ...(input.metadata ?? {}) },
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    await this.assertStructuredMemoryWriteAllowed(
      relationWithoutEmbedding.authority,
      serializeStructuredMemoryForGate(relationWithoutEmbedding),
      relationWithoutEmbedding.workspaceId,
    );
    const relation: MemoryRelationRecord = {
      ...relationWithoutEmbedding,
      metadata: await withMemoryEmbeddingMetadata(
        relationWithoutEmbedding.metadata,
        buildStructuredMemoryEmbeddingText([title]),
        undefined,
        this.memoryEmbeddingRuntimeOptions({
          operationId: `memory-relation:${relationWithoutEmbedding.id}:embedding`,
          dispatchGeneration: "initial-write",
          workspaceId: relationWithoutEmbedding.workspaceId,
          sessionId: firstSourceRefOfType(relationWithoutEmbedding.sourceRefs, "session"),
          turnId: firstSourceRefOfType(relationWithoutEmbedding.sourceRefs, "turn"),
          durableRunId: firstSourceRefOfType(relationWithoutEmbedding.sourceRefs, "run"),
          utilityKind: "memory_relation_write_embedding",
          agentId: actorId,
        }),
      ),
    };
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      await this.recordStructuredMemoryChange(
        "relation",
        relation.id,
        "created",
        actorId,
        { title: relation.title },
        {
          workspaceId: relation.workspaceId,
        },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_relation_created",
      relationId: relation.id,
      workspaceId: relation.workspaceId,
    });
    return relation;
  }

  public async listMemoryDecisions(
    input: {
      workspaceId?: string;
      status?: StructuredMemoryStatus | "all";
      dueForReview?: boolean;
      limit?: number;
    } = {},
  ): Promise<MemoryDecisionRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(review_at, updated_at) DESC, updated_at DESC
      LIMIT @limit
    `,
      )
      .all<MemoryDecisionRow>(params);
    return rows.map((row) => mapMemoryDecisionRow(this.deps.admin, row));
  }

  public async createMemoryDecision(input: MemoryDecisionInput, actorId = "operator"): Promise<MemoryDecisionRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const now = new Date().toISOString();
    const decisionText = requireTrimmedText(input.decision, "decision");
    const rationale = requireTrimmedText(input.rationale, "rationale");
    const title = input.title?.trim() || decisionText.slice(0, 120);
    const decisionWithoutEmbedding: MemoryDecisionRecord = {
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
      metadata: { ...(input.metadata ?? {}) },
      authority: normalizeAuthority(input.authority),
      createdAt: now,
      updatedAt: now,
    };
    await this.assertStructuredMemoryWriteAllowed(
      decisionWithoutEmbedding.authority,
      serializeStructuredMemoryForGate(decisionWithoutEmbedding),
      decisionWithoutEmbedding.workspaceId,
    );
    const decision: MemoryDecisionRecord = {
      ...decisionWithoutEmbedding,
      metadata: await withMemoryEmbeddingMetadata(
        decisionWithoutEmbedding.metadata,
        buildStructuredMemoryEmbeddingText([title, decisionText, rationale]),
        undefined,
        this.memoryEmbeddingRuntimeOptions({
          operationId: `memory-decision:${decisionWithoutEmbedding.id}:embedding`,
          dispatchGeneration: "initial-write",
          workspaceId: decisionWithoutEmbedding.workspaceId,
          sessionId:
            decisionWithoutEmbedding.sessionId ?? firstSourceRefOfType(decisionWithoutEmbedding.sourceRefs, "session"),
          turnId: firstSourceRefOfType(decisionWithoutEmbedding.sourceRefs, "turn"),
          durableRunId:
            decisionWithoutEmbedding.runId ?? firstSourceRefOfType(decisionWithoutEmbedding.sourceRefs, "run"),
          utilityKind: "memory_decision_write_embedding",
          agentId: actorId,
        }),
      ),
    };
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      await this.recordStructuredMemoryChange(
        "decision",
        decision.id,
        "created",
        actorId,
        { title: decision.title },
        {
          workspaceId: decision.workspaceId,
        },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_created",
      decisionId: decision.id,
      workspaceId: decision.workspaceId,
    });
    return decision;
  }

  public async addMemoryDecisionRetrospective(
    decisionId: string,
    input: MemoryDecisionRetrospectiveInput,
    actorId = "operator",
  ): Promise<MemoryDecisionRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = await this.requireMemoryDecision(decisionId);
    const now = new Date().toISOString();
    const retrospective: MemoryDecisionRetrospective = {
      reviewedAt: now,
      outcome: input.outcome,
      notes: requireTrimmedText(input.notes, "notes"),
      improvementCandidateId: optionalTrimmedText(input.improvementCandidateId),
    };
    await this.assertStructuredMemoryWriteAllowed(
      "operator",
      `${current.title}\n${current.decision}\n${retrospective.outcome}\n${retrospective.notes}`,
      current.workspaceId,
    );
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      // Explicit correction provenance: the retrospective is a correction of
      // the decision record, and its improvement-candidate linkage (when
      // given) is carried verbatim in history and Journey evidence.
      await this.recordStructuredMemoryChange(
        "decision",
        decisionId,
        "retrospective_added",
        actorId,
        { ...retrospective, correctionProvenance: "explicit" },
        {
          workspaceId: current.workspaceId,
          ...(retrospective.improvementCandidateId === undefined
            ? {}
            : { correctionRefId: retrospective.improvementCandidateId }),
        },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_retrospective_added",
      decisionId,
      workspaceId: current.workspaceId,
    });
    return await this.requireMemoryDecision(decisionId);
  }

  public async forgetMemoryDecision(decisionId: string, actorId = "operator"): Promise<MemoryDecisionRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const current = await this.requireMemoryDecision(decisionId);
    if (current.status === "forgotten") {
      return current;
    }
    const now = new Date().toISOString();
    await this.runStructuredMemoryTransaction(async () => {
      await this.deps.admin.gatewaySql
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
      await this.recordStructuredMemoryChange(
        "decision",
        decisionId,
        "forgotten",
        actorId,
        { previousStatus: current.status },
        { workspaceId: current.workspaceId },
      );
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_decision_forgotten",
      decisionId,
      workspaceId: current.workspaceId,
    });
    return await this.requireMemoryDecision(decisionId);
  }

  public async listStructuredMemoryHistory(
    recordKind: "entity" | "relation" | "decision",
    recordId: string,
    limit = 100,
  ): Promise<MemoryChangeEvent[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT change_id, record_id, change_type, actor_id, payload_json, created_at
      FROM memory_structured_change_history
      WHERE record_kind = ? AND record_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all<{
        change_id: string;
        record_id: string;
        change_type: MemoryChangeEvent["changeType"];
        actor_id: string | null;
        payload_json: string | null;
        created_at: string;
      }>(recordKind, recordId, Math.max(1, Math.min(500, Math.floor(limit))));
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

  public async listMemoryItems(
    input: {
      namespace?: string;
      workspaceId?: string;
      status?: MemoryItemRecord["status"] | "all";
      query?: string;
      limit?: number;
    } = {},
  ): Promise<MemoryItemRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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

    const rows = await this.deps.admin.gatewaySql
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
      .all<{
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
      }>(params);

    return rows.map((row) => mapMemoryItemRow(this.deps.admin, row));
  }

  /**
   * Canonical runtime read for an explicitly routed memory item. It applies the
   * same workspace/global compatibility scope as normal memory reads while
   * excluding forgotten, expired, foreign-workspace, and malformed rows.
   */
  public async getActiveMemoryItemForRoutedContext(
    itemId: string,
    workspaceId: string,
    options: { allowGlobal?: boolean; nowIso?: string } = {},
  ): Promise<MemoryItemRecord | undefined> {
    const normalizedItemId = itemId.trim();
    if (!normalizedItemId || normalizedItemId.length > 256) {
      return undefined;
    }
    const normalizedWorkspaceId = normalizeStructuredWorkspaceId(workspaceId);
    const nowIso = options.nowIso ?? new Date().toISOString();
    if (!isCanonicalIsoTimestamp(nowIso)) {
      return undefined;
    }
    const row = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
             created_at, updated_at, forgotten_at, workspace_id
      FROM memory_items
      WHERE item_id = @itemId
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > @now)
        AND ${buildMemoryWorkspaceScopeSql(this.deps.admin.gatewaySql.dialect, {
          includeGlobal: options.allowGlobal === true,
        })}
      LIMIT 1
    `,
      )
      .get<MemoryForgetSelectionRow>({ itemId: normalizedItemId, workspaceId: normalizedWorkspaceId, now: nowIso });
    if (
      !row ||
      !isActiveRoutedContextMemoryRow(row, {
        itemId: normalizedItemId,
        workspaceId: normalizedWorkspaceId,
        allowGlobal: options.allowGlobal === true,
        nowIso,
      })
    ) {
      return undefined;
    }
    return mapMemoryItemRow(this.deps.admin, row);
  }

  public async inspectExpiredActiveMemoryItems(input: { limit?: number; nowIso?: string } = {}): Promise<{
    totalCount: number;
    items: MemoryItemRecord[];
  }> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const countRow = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
    `,
      )
      .get<{ count?: number | null }>({ now: nowIso });
    const rows = await this.deps.admin.gatewaySql
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
      .all<{
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
      }>({ now: nowIso, limit });

    return {
      totalCount: Number(countRow?.count ?? 0),
      items: rows.map((row) => mapMemoryItemRow(this.deps.admin, row)),
    };
  }

  /**
   * Scheduled-maintenance expiry flush. HX-402 P1: runs under the
   * module-private branded system authority — never a caller-supplied actor —
   * and every expiry commits its status flip, history row, governed
   * `maintenance_expired` event (system-actor-only in the frozen registry),
   * and Journey evidence in one transaction.
   */
  public async forgetExpiredActiveMemoryItems(input: { limit?: number; nowIso?: string } = {}): Promise<{
    totalCount: number;
    retainedPinnedCount: number;
    remainingUnpinnedCount: number;
    retainedPinnedItems: MemoryItemRecord[];
    forgottenItems: MemoryItemRecord[];
  }> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const ledger = await this.inspectExpiredActiveMemoryLedger({ nowIso });
    const rows = await this.deps.admin.gatewaySql
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
      .all<MemoryForgetSelectionRow>({ now: nowIso, limit });

    const authority = (this.maintenanceSystemAuthority ??= mintMemoryMaintenanceSystemAuthority());
    const governedEvidence = this.getGovernedLifecycleRepository();
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const forgottenItems: MemoryItemRecord[] = [];
    for (const row of rows) {
      const forgotten = await runTransaction(async () => {
        const current = await requireMemoryItem(this.deps.admin, row.item_id);
        if (current.status === "forgotten") {
          return current;
        }
        const occurredAt = new Date().toISOString();
        const updateResult = await this.deps.admin.gatewaySql
          .prepare(
            `
          UPDATE memory_items
          SET status = 'forgotten', forgotten_at = @forgottenAt, updated_at = @updatedAt
          WHERE item_id = @itemId AND status = 'active'
        `,
          )
          .run({ itemId: current.itemId, forgottenAt: occurredAt, updatedAt: occurredAt });
        if (updateResult.changes !== 1) {
          return await requireMemoryItem(this.deps.admin, current.itemId);
        }
        const change = await recordMemoryChange(this.deps.admin, current.itemId, "forgotten", authority.actorId, {
          previousStatus: "active",
          systemAuthority: "memory_maintenance",
          expiredAt: current.expiresAt ?? null,
          storesRawContent: false,
        });
        const updated = await requireMemoryItem(this.deps.admin, current.itemId);
        await persistMemorySystemExpiryEvidence(governedEvidence, {
          authority,
          change,
          item: updated,
          occurredAt: change.createdAt,
        });
        return updated;
      });
      forgottenItems.push(forgotten);
      await this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_item_forgotten",
        itemId: forgotten.itemId,
        namespace: forgotten.namespace,
        lifecycleState: forgotten.lifecycleState,
      });
    }
    return {
      totalCount: ledger.totalCount,
      retainedPinnedCount: ledger.retainedPinnedCount,
      remainingUnpinnedCount: Math.max(0, ledger.unpinnedCount - forgottenItems.length),
      retainedPinnedItems: ledger.retainedPinnedItems,
      forgottenItems,
    };
  }

  public async inspectExpiredActiveMemoryLedger(
    input: { nowIso?: string; retainedPinnedLimit?: number } = {},
  ): Promise<{
    totalCount: number;
    retainedPinnedCount: number;
    unpinnedCount: number;
    retainedPinnedItems: MemoryItemRecord[];
  }> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const retainedPinnedLimit = Math.max(0, Math.min(25, Math.floor(input.retainedPinnedLimit ?? 10)));
    const countRows = await this.deps.admin.gatewaySql
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
      .get<{ totalCount?: number | null; retainedPinnedCount?: number | null; unpinnedCount?: number | null }>({
        now: nowIso,
      });
    const retainedRows = await this.deps.admin.gatewaySql
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
      .all<{
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
      }>({ now: nowIso, limit: retainedPinnedLimit });
    return {
      totalCount: Number(countRows?.totalCount ?? 0),
      retainedPinnedCount: Number(countRows?.retainedPinnedCount ?? 0),
      unpinnedCount: Number(countRows?.unpinnedCount ?? 0),
      retainedPinnedItems: retainedRows.map((row) => mapMemoryItemRow(this.deps.admin, row)),
    };
  }

  /**
   * HX-402 P1: the unapproved direct-patch branch is retired. This entry point
   * only executes with a resolved `memory.lifecycle` approval; the route
   * surface requests approvals via {@link requestMemoryItemPatchApproval}.
   */
  public async patchMemoryItem(
    itemId: string,
    patch: MemoryLifecyclePatch,
    actorId = "operator",
    approvedMutation?: ApprovedMemoryMutationContext,
  ): Promise<MemoryItemRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    if (!approvedMutation) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Direct memory item mutation is retired; request a memory.lifecycle approval instead.",
      });
    }
    return (await this.patchApprovedMemoryItem(itemId, patch, actorId, approvedMutation)).item;
  }

  private async patchApprovedMemoryItem(
    itemId: string,
    patch: MemoryLifecyclePatch,
    actorId: string,
    approvedMutation: ApprovedMemoryMutationContext,
  ): Promise<{ item: MemoryItemRecord; changed: boolean }> {
    // Snapshot the approved material once. Service callers are not assumed to
    // hand us an inert JSON.parse result, so re-reading a getter/proxy-backed
    // patch after hashing could otherwise apply bytes the approval never bound.
    const approvedPatch = snapshotApprovedMemoryItemPatch(patch);
    const initial = requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, itemId));
    const requestSha256 = buildMemoryLifecycleRequestSha256({
      workspaceId: initial.workspaceId,
      subjectKind: "memory_item",
      subjectId: initial.itemId,
      action: "item_updated",
      mutation: approvedPatch,
    });
    const governedEvidence = this.getGovernedLifecycleRepository();
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const transactionResult = await runTransaction(async () => {
      await applyPostgresRowLockTimeout(this.deps.admin.gatewaySql);
      const current = requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, itemId));
      if (current.workspaceId !== initial.workspaceId) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory item workspace ownership changed before the approved mutation.",
        });
      }
      const authority = await resolveApprovedMemoryMutation(this.deps.admin.gatewaySql, {
        context: approvedMutation,
        workspaceId: current.workspaceId,
        actorId,
        subjectKind: "memory_item",
        subjectId: current.itemId,
        action: "item_updated",
        requestSha256,
      });
      const eventPlans = approvedMemoryPatchEventPlans(approvedPatch, authority, current);
      const replayEntries = await Promise.all(
        eventPlans.map(async (plan) => ({ plan, change: await this.findMemoryChange(plan.changeId) })),
      );
      const replayCount = replayEntries.filter((entry) => entry.change !== undefined).length;
      if (replayCount > 0) {
        if (replayCount !== eventPlans.length) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: "Approved memory patch contains a partial immutable replay.",
          });
        }
        for (const entry of replayEntries) {
          const { plan, change: existingChange } = entry;
          if (!existingChange) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "Approved memory patch contains a partial immutable replay.",
            });
          }
          const actualFieldCodes = approvedMemoryReplayFieldCodes(existingChange.payload, plan.fieldCodes);
          const historyPayload = approvedMemoryHistoryPayload(authority, "approved_patch", actualFieldCodes);
          const change = await recordMemoryChange(
            this.deps.admin,
            current.itemId,
            plan.changeType,
            authority.actorId,
            historyPayload,
            { changeId: plan.changeId, createdAt: authority.occurredAt },
          );
          await persistApprovedMemoryMutationEvidence(governedEvidence, {
            authority,
            change,
            subjectId: current.itemId,
            action: plan.action,
            lifecycleState: current.lifecycleState,
            fieldCodes: actualFieldCodes,
          });
        }
        return { item: current, changed: false };
      }
      if (
        buildMemoryLifecycleStateSha256(buildMemoryItemApprovalStateMaterial(current)) !== authority.expectedStateSha256
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory item state changed after approval review.",
        });
      }

      const next = buildApprovedMemoryItemPatch(current, approvedPatch, authority.occurredAt);
      const changedFields = approvedMemoryPatchChangedFields(current, next);
      if (changedFields.length === 0) {
        return { item: current, changed: false };
      }
      const updateResult = await this.deps.admin.gatewaySql
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
          WHERE item_id = @itemId AND updated_at = @expectedUpdatedAt
        `,
        )
        .run({
          itemId: current.itemId,
          title: next.title,
          content: next.content,
          metadataJson: canonicalJsonString(next.metadata),
          pinned: next.pinned ? 1 : 0,
          ttlOverrideSeconds: next.ttlOverrideSeconds,
          expiresAt: next.expiresAt,
          updatedAt: authority.occurredAt,
          expectedUpdatedAt: current.updatedAt,
        });
      if (updateResult.changes !== 1) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory item changed during the approved atomic mutation.",
        });
      }
      const updated = await requireMemoryItem(this.deps.admin, current.itemId);
      for (const plan of eventPlans) {
        const actualFieldCodes = plan.fieldCodes.filter((field) => changedFields.includes(field));
        if (actualFieldCodes.length === 0) continue;
        const historyPayload = approvedMemoryHistoryPayload(authority, "approved_patch", actualFieldCodes);
        const change = await recordMemoryChange(
          this.deps.admin,
          current.itemId,
          plan.changeType,
          authority.actorId,
          historyPayload,
          { changeId: plan.changeId, createdAt: authority.occurredAt },
        );
        await persistApprovedMemoryMutationEvidence(governedEvidence, {
          authority,
          change,
          subjectId: current.itemId,
          action: plan.action,
          lifecycleState: updated.lifecycleState,
          fieldCodes: actualFieldCodes,
        });
      }
      return { item: updated, changed: true };
    });
    if (transactionResult.changed) {
      await this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_item_updated",
        itemId: transactionResult.item.itemId,
        namespace: transactionResult.item.namespace,
        lifecycleState: transactionResult.item.lifecycleState,
        expiresAt: transactionResult.item.expiresAt,
      });
    }
    return transactionResult;
  }

  /**
   * HX-402 P1: the unapproved single-item forget branch is retired. This entry
   * point only executes with a resolved `memory.lifecycle` approval; the route
   * surface requests approvals via {@link requestMemoryForgetApproval}.
   */
  public async forgetMemoryItem(
    itemId: string,
    actorId = "operator",
    options: MemoryForgetItemOptions = {},
  ): Promise<MemoryItemRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    if (!options.approvedMutation) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Direct memory item forget is retired; request a memory.lifecycle approval instead.",
      });
    }
    const current = await requireMemoryItem(this.deps.admin, itemId);
    const result = await this.forgetMemory(
      {
        itemIds: [itemId],
        workspaceId: current.workspaceId,
        actorId,
        actionId: options.actionId,
        source: options.source?.trim() || "gateway.memory.forget_item",
      },
      {
        onCommit: options.onCommit,
        afterCommit: options.afterCommit,
        approvedMutation: options.approvedMutation,
      },
    );
    return (
      result.items[0] ?? (current.status === "forgotten" ? current : await requireMemoryItem(this.deps.admin, itemId))
    );
  }

  public async forgetMemory(
    input: MemoryForgetRequest & { actorId?: string } = {},
    hooks: MemoryForgetCommitHooks = {},
  ): Promise<MemoryForgetResponse> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
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
    if (!hooks.approvedMutation) {
      // HX-402 P1: the unapproved criteria-forget branch is retired. Criteria
      // resolve to exact item IDs at request time inside
      // requestMemoryForgetApproval; only the recovered approval effect
      // executes, and it always carries the resolved approval context.
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Direct memory forget is retired; request a memory.lifecycle approval instead.",
      });
    }
    const approvedHooks = {
      ...hooks,
      approvedMutation: hooks.approvedMutation,
    };
    const approvedItemIds = input.itemIds;
    const approvedWorkspaceId = input.workspaceId;
    const approvedActorId = input.actorId ?? "operator";
    if (
      !approvedWorkspaceId ||
      approvedWorkspaceId !== approvedWorkspaceId.normalize("NFKC").trim() ||
      approvedWorkspaceId.length > 256 ||
      !Array.isArray(approvedItemIds) ||
      approvedItemIds.length === 0 ||
      approvedItemIds.some(
        (itemId) => itemId !== itemId.normalize("NFKC").trim() || itemId.length === 0 || itemId.length > 256,
      ) ||
      new Set(approvedItemIds).size !== approvedItemIds.length ||
      approvedActorId !== approvedActorId.normalize("NFKC").trim() ||
      approvedActorId.length === 0 ||
      approvedActorId.length > 256 ||
      includeGlobal ||
      !criteria.hasItemIds ||
      criteria.namespace !== undefined ||
      criteria.query !== undefined
    ) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "itemIds",
        message: "Approved memory forget requires explicit workspace-owned item IDs only.",
      });
    }
    return await this.forgetApprovedMemoryItems(
      [...approvedItemIds].sort(compareMemoryItemIds),
      approvedWorkspaceId,
      approvedActorId,
      input.actionId,
      approvedHooks,
    );
  }

  private async forgetApprovedMemoryItems(
    itemIds: string[],
    workspaceId: string,
    actorId: string,
    actionId: string | undefined,
    hooks: MemoryForgetCommitHooks & { approvedMutation: ApprovedMemoryMutationContext },
  ): Promise<MemoryForgetResponse> {
    const canonicalActionId = actionId?.normalize("NFKC").trim();
    if (!canonicalActionId || canonicalActionId !== actionId || canonicalActionId.length > 120) {
      throw new ValidationError({
        code: "FIELD_REQUIRED",
        field: "actionId",
        message: "Approved memory forget requires a stable actionId.",
      });
    }
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length !== itemIds.length) {
      throw new ValidationError({ code: "FIELD_INVALID", field: "itemIds" });
    }
    const subjectKind = uniqueItemIds.length === 1 ? "memory_item" : "memory_item_batch";
    const subjectId = uniqueItemIds.length === 1 ? uniqueItemIds[0] : undefined;
    const requestSha256 = buildMemoryLifecycleRequestSha256({
      workspaceId,
      subjectKind,
      subjectId,
      action: "items_forgotten",
      mutation: { actionId: canonicalActionId, itemIds: uniqueItemIds },
    });
    const governedEvidence = this.getGovernedLifecycleRepository();
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const transactionResult = await runTransaction(async () => {
      await applyPostgresRowLockTimeout(this.deps.admin.gatewaySql);
      const params: Record<string, string> = { workspaceId };
      const placeholders = uniqueItemIds.map((itemId, index) => {
        params[`itemId${index}`] = itemId;
        return `@itemId${index}`;
      });
      const rows = await this.deps.admin.gatewaySql
        .prepare(
          `
          SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, status,
                 created_at, updated_at, forgotten_at, workspace_id
          FROM memory_items
          WHERE workspace_id = @workspaceId AND item_id IN (${placeholders.join(", ")})
          ORDER BY item_id${this.deps.admin.gatewaySql.dialect === "postgres" ? " FOR UPDATE" : ""}
        `,
        )
        .all<MemoryForgetSelectionRow>(params);
      if (rows.length !== uniqueItemIds.length || rows.some((row, index) => row.item_id !== uniqueItemIds[index])) {
        throw new ValidationError({
          code: "FIELD_INVALID",
          field: "itemIds",
          message: "Every approved memory item must exist in the approval workspace.",
        });
      }
      const authority = await resolveApprovedMemoryMutation(this.deps.admin.gatewaySql, {
        context: hooks.approvedMutation,
        workspaceId,
        actorId,
        subjectKind,
        subjectId,
        action: "items_forgotten",
        requestSha256,
      });
      const items = rows.map((row) => mapMemoryItemRow(this.deps.admin, row));
      const plans = items.map((item) => approvedMemoryForgetEventPlan(item, authority));
      const replayChanges = await Promise.all(plans.map(async (plan) => await this.findMemoryChange(plan.changeId)));
      const replayCount = replayChanges.filter((change) => change !== undefined).length;
      if (replayCount > 0) {
        if (replayCount !== plans.length) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: "Approved memory forget contains a partial immutable replay.",
          });
        }
        for (const [index, plan] of plans.entries()) {
          const item = items[index] as MemoryItemRecord;
          const change = await recordMemoryChange(
            this.deps.admin,
            item.itemId,
            "forgotten",
            authority.actorId,
            plan.historyPayload,
            { changeId: plan.changeId, createdAt: authority.occurredAt },
          );
          await persistApprovedMemoryMutationEvidence(governedEvidence, {
            authority,
            change,
            subjectId: item.itemId,
            action: "forgotten",
            lifecycleState: item.lifecycleState,
            fieldCodes: ["status"],
            batchOperationIndex: uniqueItemIds.length > 1 ? index : undefined,
          });
        }
        hooks.onCommit?.();
        return { items, changed: false, replayed: true };
      }
      if (
        buildMemoryLifecycleStateSha256(buildMemoryItemsApprovalStateMaterial(items)) !== authority.expectedStateSha256
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory forget targets changed after approval review.",
        });
      }
      if (items.every((item) => item.status === "forgotten")) {
        hooks.onCommit?.();
        return { items: [], changed: false, replayed: false, alreadyForgottenCount: items.length };
      }
      if (items.some((item) => item.status !== "active")) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Approved memory forget target states are mixed or unsupported.",
        });
      }
      const changedItems: MemoryItemRecord[] = [];
      for (const [index, item] of items.entries()) {
        const update = await this.deps.admin.gatewaySql
          .prepare(
            `
            UPDATE memory_items
            SET status = 'forgotten', forgotten_at = @forgottenAt, updated_at = @updatedAt
            WHERE item_id = @itemId AND workspace_id = @workspaceId
              AND status = 'active' AND updated_at = @expectedUpdatedAt
          `,
          )
          .run({
            itemId: item.itemId,
            workspaceId,
            forgottenAt: authority.occurredAt,
            updatedAt: authority.occurredAt,
            expectedUpdatedAt: item.updatedAt,
          });
        if (update.changes !== 1) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: "Memory forget target changed during the approved atomic mutation.",
          });
        }
        const plan = plans[index] as ReturnType<typeof approvedMemoryForgetEventPlan>;
        const change = await recordMemoryChange(
          this.deps.admin,
          item.itemId,
          "forgotten",
          authority.actorId,
          plan.historyPayload,
          { changeId: plan.changeId, createdAt: authority.occurredAt },
        );
        const forgotten = await requireMemoryItem(this.deps.admin, item.itemId);
        await persistApprovedMemoryMutationEvidence(governedEvidence, {
          authority,
          change,
          subjectId: item.itemId,
          action: "forgotten",
          lifecycleState: forgotten.lifecycleState,
          fieldCodes: ["status"],
          batchOperationIndex: uniqueItemIds.length > 1 ? index : undefined,
        });
        changedItems.push(forgotten);
      }
      hooks.onCommit?.();
      return { items: changedItems, changed: true, replayed: false, alreadyForgottenCount: 0 };
    });

    hooks.afterCommit?.();
    if (transactionResult.changed) {
      for (const item of transactionResult.items) {
        await this.deps.admin.publishRealtime("system", "memory", {
          type: "memory_item_forgotten",
          itemId: item.itemId,
          namespace: item.namespace,
          lifecycleState: item.lifecycleState,
          actionId: canonicalActionId,
          requestedWorkspaceId: workspaceId,
          effectiveWorkspaceId: workspaceId,
          includeGlobal: false,
          source: "approved_memory_lifecycle",
        });
      }
    }
    const replayedItems = transactionResult.replayed ? transactionResult.items : [];
    const resultItems = transactionResult.changed ? transactionResult.items : replayedItems;
    return {
      actionId: canonicalActionId,
      matchedCount: uniqueItemIds.length,
      alreadyForgottenCount: transactionResult.replayed ? 0 : (transactionResult.alreadyForgottenCount ?? 0),
      forgottenCount: resultItems.length,
      itemIds: resultItems.map((item) => item.itemId),
      items: resultItems,
    };
  }

  /**
   * HX-402 P1: the unapproved batch branch is retired. One resolved
   * `memory.lifecycle` approval governs the whole batch and the recovered
   * effect applies every operation in one transaction (all-or-nothing) after
   * the same authority revalidation as single-item mutations.
   */
  public async batchMutateMemoryItems(
    input: MemoryBatchMutationRequest,
    actorId = "operator",
    approvedMutation?: ApprovedMemoryMutationContext,
  ): Promise<MemoryBatchMutationResponse> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    if (!approvedMutation) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Direct memory batch mutation is retired; request a memory.lifecycle approval instead.",
      });
    }
    return await this.applyApprovedMemoryBatchMutation(input, actorId, approvedMutation);
  }

  private async applyApprovedMemoryBatchMutation(
    input: MemoryBatchMutationRequest,
    actorId: string,
    approvedMutation: ApprovedMemoryMutationContext,
  ): Promise<MemoryBatchMutationResponse> {
    const operations = snapshotApprovedBatchOperations(normalizeBatchMutationOperations(input.operations));
    const actionId = input.actionId?.normalize("NFKC").trim();
    if (!actionId || actionId !== input.actionId || actionId.length > 120) {
      throw new ValidationError({
        code: "FIELD_REQUIRED",
        field: "actionId",
        message: "Approved memory batch mutation requires a stable actionId.",
      });
    }
    const initialItems = await Promise.all(
      operations.map(async (operation) =>
        requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, operation.itemId)),
      ),
    );
    const workspaceId = initialItems[0]?.workspaceId;
    if (!workspaceId || initialItems.some((item) => item.workspaceId !== workspaceId)) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Approved memory batch mutations require items owned by exactly one workspace.",
      });
    }
    const requestSha256 = buildMemoryLifecycleRequestSha256({
      workspaceId,
      subjectKind: "memory_item_batch",
      action: "batch_mutated",
      mutation: { actionId, operations },
    });
    const governedEvidence = this.getGovernedLifecycleRepository();
    const runTransaction = requireMemoryBatchTransaction(this.deps.admin.gatewaySql);
    const transactionResult = await runTransaction(async () => {
      await applyPostgresRowLockTimeout(this.deps.admin.gatewaySql);
      const items = await Promise.all(
        operations.map(async (operation) =>
          requireWorkspaceOwnedMemoryItem(await requireMemoryItem(this.deps.admin, operation.itemId)),
        ),
      );
      if (items.some((item) => item.workspaceId !== workspaceId)) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory batch workspace ownership changed before the approved mutation.",
        });
      }
      const authority = await resolveApprovedMemoryMutation(this.deps.admin.gatewaySql, {
        context: approvedMutation,
        workspaceId,
        actorId,
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        action: "batch_mutated",
        requestSha256,
      });
      const plans = operations.map((operation, operationIndex) => ({
        operation,
        operationIndex,
        changeId: deriveApprovedMemoryHistoryId({
          approvalId: authority.approvalId,
          subjectId: operation.itemId,
          action: "batch_mutated",
          ordinal: operationIndex,
        }),
      }));
      const replayChanges = await Promise.all(plans.map(async (plan) => await this.findMemoryChange(plan.changeId)));
      const replayCount = replayChanges.filter((change) => change !== undefined).length;
      if (replayCount > 0) {
        if (replayCount !== plans.length) {
          throw new ConflictError({
            code: "WRITE_CONFLICT",
            message: "Approved memory batch contains a partial immutable replay.",
          });
        }
        const results: MemoryBatchMutationResult[] = [];
        for (const plan of plans) {
          const item = await requireMemoryItem(this.deps.admin, plan.operation.itemId);
          const change = await recordMemoryChange(
            this.deps.admin,
            item.itemId,
            approvedBatchChangeType(plan.operation),
            authority.actorId,
            approvedBatchHistoryPayload(authority, plan.operation, plan.operationIndex),
            { changeId: plan.changeId, createdAt: authority.occurredAt },
          );
          await persistApprovedMemoryMutationEvidence(governedEvidence, {
            authority,
            change,
            subjectId: item.itemId,
            action: "batch_mutated",
            lifecycleState: item.lifecycleState,
            fieldCodes: approvedBatchFieldCodes(plan.operation),
            batchOperationIndex: plan.operationIndex,
            batchActionId: actionId,
          });
          results.push(buildApprovedBatchResult(plan.operationIndex, plan.operation, item));
        }
        return { results, changed: false, authorityActorId: authority.actorId };
      }
      const sortedItems = [...items].sort((left, right) => compareMemoryItemIds(left.itemId, right.itemId));
      if (
        buildMemoryLifecycleStateSha256(buildMemoryItemsApprovalStateMaterial(sortedItems)) !==
        authority.expectedStateSha256
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Memory batch targets changed after approval review.",
        });
      }
      const results: MemoryBatchMutationResult[] = [];
      for (const plan of plans) {
        const current = requireWorkspaceOwnedMemoryItem(
          await requireMemoryItem(this.deps.admin, plan.operation.itemId),
        );
        let updatedItem: MemoryItemRecord;
        let fieldCodes: string[];
        if (plan.operation.kind === "patch_item") {
          const next = buildApprovedMemoryItemPatch(current, plan.operation.patch, authority.occurredAt);
          fieldCodes = approvedMemoryPatchChangedFields(current, next);
          if (fieldCodes.length === 0) {
            updatedItem = current;
          } else {
            const updateResult = await this.deps.admin.gatewaySql
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
                WHERE item_id = @itemId AND workspace_id = @workspaceId AND updated_at = @expectedUpdatedAt
              `,
              )
              .run({
                itemId: current.itemId,
                workspaceId,
                title: next.title,
                content: next.content,
                metadataJson: canonicalJsonString(next.metadata),
                pinned: next.pinned ? 1 : 0,
                ttlOverrideSeconds: next.ttlOverrideSeconds,
                expiresAt: next.expiresAt,
                updatedAt: authority.occurredAt,
                expectedUpdatedAt: current.updatedAt,
              });
            if (updateResult.changes !== 1) {
              throw new ConflictError({
                code: "WRITE_CONFLICT",
                message: "Memory batch target changed during the approved atomic mutation.",
              });
            }
            updatedItem = await requireMemoryItem(this.deps.admin, current.itemId);
          }
        } else {
          if (current.status !== "active") {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "Approved memory batch forget targets must be active.",
            });
          }
          const updateResult = await this.deps.admin.gatewaySql
            .prepare(
              `
              UPDATE memory_items
              SET status = 'forgotten', forgotten_at = @forgottenAt, updated_at = @updatedAt
              WHERE item_id = @itemId AND workspace_id = @workspaceId
                AND status = 'active' AND updated_at = @expectedUpdatedAt
            `,
            )
            .run({
              itemId: current.itemId,
              workspaceId,
              forgottenAt: authority.occurredAt,
              updatedAt: authority.occurredAt,
              expectedUpdatedAt: current.updatedAt,
            });
          if (updateResult.changes !== 1) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "Memory batch target changed during the approved atomic mutation.",
            });
          }
          fieldCodes = ["status"];
          updatedItem = await requireMemoryItem(this.deps.admin, current.itemId);
        }
        const change = await recordMemoryChange(
          this.deps.admin,
          current.itemId,
          approvedBatchChangeType(plan.operation),
          authority.actorId,
          approvedBatchHistoryPayload(authority, plan.operation, plan.operationIndex),
          { changeId: plan.changeId, createdAt: authority.occurredAt },
        );
        await persistApprovedMemoryMutationEvidence(governedEvidence, {
          authority,
          change,
          subjectId: current.itemId,
          action: "batch_mutated",
          lifecycleState: updatedItem.lifecycleState,
          fieldCodes: fieldCodes.length > 0 ? fieldCodes : approvedBatchFieldCodes(plan.operation),
          batchOperationIndex: plan.operationIndex,
          batchActionId: actionId,
        });
        results.push(buildApprovedBatchResult(plan.operationIndex, plan.operation, updatedItem));
      }
      return { results, changed: true, authorityActorId: authority.actorId };
    });

    const targetItemIds = [...new Set(operations.map((operation) => operation.itemId))];
    const ledger = buildMemoryActionLedgerEntry({
      actionId,
      ownerId: transactionResult.authorityActorId,
      source: input.source ?? "approved_memory_lifecycle",
      status: "applied",
      operations: operations.map((operation) => ({
        kind: operation.kind,
        itemId: operation.itemId,
        changedFields: operation.kind === "patch_item" ? getBatchPatchChangedFields(operation.patch) : undefined,
      })),
    });
    if (transactionResult.changed) {
      await this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_batch_mutation_applied",
        actionId,
        operationKind: ledger.operationKind,
        itemIds: targetItemIds,
        appliedCount: transactionResult.results.length,
      });
    }
    return {
      actionId,
      status: "applied",
      appliedCount: transactionResult.results.length,
      targetItemIds,
      results: transactionResult.results,
      ledger,
    };
  }

  private async findMemoryChange(changeId: string): Promise<MemoryChangeEvent | undefined> {
    const row = await this.deps.admin.gatewaySql
      .prepare(
        `
        SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
        FROM memory_change_history
        WHERE change_id = ?
      `,
      )
      .get<{
        change_id: string;
        item_id: string;
        change_type: MemoryChangeEvent["changeType"];
        actor_id: string | null;
        payload_json: string | null;
        created_at: string;
      }>(changeId);
    return row
      ? {
          changeId: row.change_id,
          itemId: row.item_id,
          changeType: row.change_type,
          actorId: row.actor_id ?? undefined,
          payload: this.deps.admin.tryParseJson<Record<string, unknown>>(row.payload_json, {}),
          createdAt: row.created_at,
        }
      : undefined;
  }

  public async listMemoryItemHistory(itemId: string, limit = 200): Promise<MemoryChangeEvent[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
      FROM memory_change_history
      WHERE item_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all<{
        change_id: string;
        item_id: string;
        change_type: MemoryChangeEvent["changeType"];
        actor_id: string | null;
        payload_json: string | null;
        created_at: string;
      }>(itemId, safeLimit);
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

  public async getContext(contextId: string): Promise<MemoryContextPack> {
    return this.deps.context.get(contextId);
  }

  public async listRunContexts(runId: string): Promise<MemoryContextPack[]> {
    return this.deps.context.listByRun(runId);
  }

  public async listRecentContexts(limit = 60): Promise<MemoryContextPack[]> {
    return this.deps.context.listRecent(limit);
  }

  public async getContextStats(from: string, to: string): Promise<MemoryQmdStatsResponse> {
    return this.deps.context.stats(from, to);
  }

  public async getRetrievalStatus(): Promise<MemoryRetrievalStatusResponse> {
    return this.deps.context.retrievalStatus();
  }

  public async listMemoryFeedback(
    input: {
      workspaceId?: string;
      kind?: MemoryFeedbackKind | "all";
      status?: MemoryFeedbackStatus | "all";
      targetKind?: MemoryFeedbackTargetKind;
      limit?: number;
    } = {},
  ): Promise<MemoryFeedbackRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureFeedbackSchema();
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
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_feedback
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all<MemoryFeedbackRow>(params);
    return rows.map((row) => mapMemoryFeedbackRow(this.deps.admin, row));
  }

  public async recordMemoryFeedback(input: MemoryFeedbackInput, actorId = "operator"): Promise<MemoryFeedbackRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureFeedbackSchema();
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId);
    await this.assertMemoryFeedbackContentAllowed(
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
    await this.deps.admin.gatewaySql
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
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_feedback_recorded",
      feedbackId: feedback.feedbackId,
      kind: feedback.kind,
      targetKind: feedback.targetKind,
    });
    return feedback;
  }

  public async listMemoryQualityIssues(input: MemoryQualityIssueListRequest = {}): Promise<MemoryQualityIssueRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    return await this.deps.admin.memoryQualityIssues.list({
      ...input,
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    });
  }

  public async runMemoryQualityScan(
    input: MemoryQualityScanRequest = {},
    actorId = "operator",
  ): Promise<MemoryQualityScanResponse> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureFeedbackSchema();
    await this.ensureLearningSchema();
    const generatedAt = new Date().toISOString();
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId);
    const limit = normalizeStructuredLimit(input.limit);
    const warnings: string[] = [];
    const candidateIssues = new Map<string, MemoryQualityIssueInput & { dedupKey: string }>();
    const rememberIssue = async (candidate: MemoryQualityIssueInput & { dedupKey: string }) => {
      const contentForGuard = JSON.stringify({
        summary: candidate.summary,
        rationale: candidate.rationale,
        metadata: candidate.metadata ?? {},
      });
      await this.assertMemoryFeedbackContentAllowed(contentForGuard, workspaceId);
      candidateIssues.set(candidate.dedupKey, candidate);
    };

    const memoryItems = (await this.listMemoryItems({ workspaceId, status: "all", limit })).filter((item) =>
      matchesMemoryWorkspaceScope(item, workspaceId, normalizeStructuredWorkspaceId),
    );
    const learnings = await this.listMemoryLearnings({ workspaceId, status: "all", limit });
    const feedback = await this.listMemoryFeedback({ workspaceId, status: "open", limit });

    for (const item of memoryItems) {
      if (item.lifecycleState === "expired" && !item.pinned) {
        await rememberIssue({
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

    for (const issue of (await this.checkMemoryLearningStaleness({ workspaceId, limit })).issues) {
      const kind = mapLearningStalenessToQualityKind(issue.issue);
      await rememberIssue({
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
      await rememberIssue({
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
      await rememberIssue({
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
    const issues: MemoryQualityIssueRecord[] = [];
    if (input.dryRun) {
      issues.push(...issueInputs.map((candidate, index) => dryRunQualityIssue(candidate, generatedAt, index)));
    } else {
      for (const candidate of issueInputs) {
        const result = await this.deps.admin.memoryQualityIssues.upsertOpenIssue(candidate);
        if (result.created) {
          createdCount += 1;
        } else {
          updatedCount += 1;
        }
        issues.push(result.record);
      }
    }

    if (!input.dryRun) {
      await this.deps.admin.publishRealtime("system", "memory", {
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

  public async patchMemoryQualityIssue(
    issueId: string,
    input: MemoryQualityIssuePatchInput,
    actorId = "operator",
  ): Promise<MemoryQualityIssueRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const record = await this.deps.admin.memoryQualityIssues.patchStatus(issueId, {
      status: normalizeMemoryQualityIssueStatus(input.status),
      resolutionNote: optionalTrimmedText(input.resolutionNote),
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_quality_issue_updated",
      issueId: record.issueId,
      status: record.status,
      actorId,
      workspaceId: record.workspaceId,
    });
    return record;
  }

  public async listTraceMemoryCandidates(
    input: {
      workspaceId?: string;
      status?: TraceMemoryCandidateStatus | "all";
      limit?: number;
    } = {},
  ): Promise<TraceMemoryCandidateRecord[]> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureTraceCandidateSchema();
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeStructuredWorkspaceId(input.workspaceId),
      limit: normalizeStructuredLimit(input.limit),
    };
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    const rows = await this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT *
      FROM memory_trace_candidates
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
      )
      .all<TraceMemoryCandidateRow>(params);
    return rows.map((row) => mapTraceMemoryCandidateRow(this.deps.admin, row));
  }

  public async proposeTraceMemoryCandidate(
    input: TraceMemoryCandidateInput,
    actorId = "agent",
    authority: TraceMemoryCandidateAuthority = "agent_proposed",
  ): Promise<TraceMemoryCandidateRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureTraceCandidateSchema();
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
    await this.assertTraceCandidateContentAllowed(contentForGuard, input.workspaceId);
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId);
    const candidateType = normalizeTraceCandidateType(input.candidateType);
    const dedupeKey = buildTraceMemoryCandidateDedupeKey({
      workspaceId,
      sourceSessionId: optionalTrimmedText(input.sourceSessionId),
      sourceMessageId: optionalTrimmedText(input.sourceMessageId),
      candidateType,
      proposedInsight,
      authority,
    });
    const existing = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_trace_candidates WHERE dedupe_key = ?")
      .get<TraceMemoryCandidateRow>(dedupeKey);
    if (existing) {
      return mapTraceMemoryCandidateRow(this.deps.admin, existing);
    }
    const now = new Date().toISOString();
    const candidateId = `trace-${dedupeKey.slice(0, 40)}`;
    const metadata = await withMemoryEmbeddingMetadata(
      {
        ...(input.metadata ?? {}),
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      buildStructuredMemoryEmbeddingText([proposedInsight, sourceText]),
      undefined,
      this.memoryEmbeddingRuntimeOptions({
        operationId: `memory-trace-candidate:${candidateId}:embedding`,
        dispatchGeneration: "initial-write",
        workspaceId,
        sessionId: optionalTrimmedText(input.sourceSessionId),
        turnId: optionalTrimmedText(input.sourceTurnId),
        durableRunId: optionalTrimmedText(input.sourceRunId),
        utilityKind: "memory_trace_candidate_write_embedding",
        agentId: actorId,
      }),
    );
    const candidate: TraceMemoryCandidateRecord = {
      candidateId,
      workspaceId,
      candidateType,
      status: "proposed",
      sourceText,
      proposedInsight,
      confidence: normalizeConfidence(input.confidence),
      sourceRefs: normalizeTraceCandidateSourceRefs(input, actorId),
      metadata,
      authority,
      dedupeKey,
      actorId: optionalTrimmedText(actorId),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.admin.gatewaySql
      .prepare(
        `
      INSERT INTO memory_trace_candidates (
        candidate_id, workspace_id, candidate_type, status, source_text, proposed_insight, confidence,
        source_refs_json, metadata_json, authority, actor_id, promoted_learning_id, dedupe_key, created_at, updated_at
      ) VALUES (
        @candidateId, @workspaceId, @candidateType, @status, @sourceText, @proposedInsight, @confidence,
        @sourceRefsJson, @metadataJson, @authority, @actorId, NULL, @dedupeKey, @createdAt, @updatedAt
      )
      ON CONFLICT(dedupe_key) DO NOTHING
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
        dedupeKey: candidate.dedupeKey,
        actorId: candidate.actorId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    const canonical = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_trace_candidates WHERE dedupe_key = ?")
      .get<TraceMemoryCandidateRow>(dedupeKey);
    if (!canonical) {
      throw new ConflictError({ message: "Trace memory candidate could not be persisted." });
    }
    const persistedCandidate = mapTraceMemoryCandidateRow(this.deps.admin, canonical);
    await this.deps.evidence?.createEnvelope({
      eventKind: "memory_write",
      workspaceId: candidate.workspaceId,
      metadata: {
        traceMemoryCandidate: true,
        authority: persistedCandidate.authority,
        status: persistedCandidate.status,
        candidateType: persistedCandidate.candidateType,
        dedupeKey: persistedCandidate.dedupeKey,
        claimPreview:
          persistedCandidate.authority === "external_channel" || persistedCandidate.authority === "unknown"
            ? "[redacted external proposal]"
            : persistedCandidate.proposedInsight.slice(0, 240),
      },
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_trace_candidate_proposed",
      candidateId: persistedCandidate.candidateId,
      candidateType: persistedCandidate.candidateType,
    });
    return persistedCandidate;
  }

  public async promoteTraceMemoryCandidate(candidateId: string, actorId = "operator"): Promise<MemoryLearningRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureTraceCandidateSchema();
    const candidate = await this.requireTraceMemoryCandidate(candidateId);
    if (candidate.status !== "proposed") {
      throw new ValidationError({ message: "Only proposed trace memory candidates can be promoted." });
    }
    const key =
      readRecordString(candidate.metadata ?? {}, "key") ?? `trace.${candidate.candidateType}.${candidate.candidateId}`;
    // Atomic promotion: the trusted learning and the candidate's promoted
    // linkage commit together, so a crash can never leave a candidate that
    // reads as promoted without its learning (or vice versa).
    const learning = await this.runStructuredMemoryTransaction(async () => {
      const created = await this.createMemoryLearning(
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
      await this.deps.admin.gatewaySql
        .prepare(
          `
      UPDATE memory_trace_candidates
      SET status = 'promoted',
          promoted_learning_id = @learningId,
          updated_at = @updatedAt
      WHERE candidate_id = @candidateId
    `,
        )
        .run({ candidateId, learningId: created.learningId, updatedAt: now });
      return created;
    });
    await this.deps.admin.publishRealtime("system", "memory", {
      type: "memory_trace_candidate_promoted",
      candidateId,
      learningId: learning.learningId,
    });
    return learning;
  }

  public async rejectTraceMemoryCandidate(
    candidateId: string,
    actorId = "operator",
  ): Promise<TraceMemoryCandidateRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureTraceCandidateSchema();
    const candidate = await this.requireTraceMemoryCandidate(candidateId);
    if (candidate.status === "promoted") {
      throw new ValidationError({ message: "Promoted trace memory candidates cannot be rejected." });
    }
    if (candidate.status === "proposed") {
      const updatedAt = new Date().toISOString();
      await this.deps.admin.gatewaySql
        .prepare(
          `UPDATE memory_trace_candidates
           SET status = 'rejected', actor_id = @actorId, updated_at = @updatedAt
           WHERE candidate_id = @candidateId AND status = 'proposed'`,
        )
        .run({ candidateId, actorId, updatedAt });
      await this.deps.admin.publishRealtime("system", "memory", {
        type: "memory_trace_candidate_rejected",
        candidateId,
      });
      await this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId: candidate.workspaceId,
        sessionId: candidate.sourceSessionId,
        metadata: {
          traceMemoryCandidate: true,
          status: "rejected",
          authority: candidate.authority,
          dedupeKey: candidate.dedupeKey,
          rejectedBy: actorId,
        },
      });
    }
    return await this.requireTraceMemoryCandidate(candidateId);
  }

  public async recallMemory(input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    const limit = Math.max(1, Math.min(25, Math.floor(input.limit ?? 8)));
    const workspaceId = normalizeStructuredWorkspaceId(input.workspaceId ?? input.workspace);
    const feedback = await this.listMemoryFeedback({ workspaceId, limit: 12 });
    const traceCandidates = await this.listTraceMemoryCandidates({ workspaceId, status: "proposed", limit: 12 });
    const qualityIssues = await this.listMemoryQualityIssues({ workspaceId, status: "open", limit: 12 });
    const recentContexts = await this.listRecentContexts(limit);
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

  public async extractLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      authority?: ChatMessageSourceAuthority;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): Promise<void> {
    const policy = await this.deps.resolveLearnedMemoryPolicy(sessionId);
    if (!policy.allowWrite) {
      return;
    }
    const workspaceId = await this.deps.resolveSessionWorkspaceId?.(sessionId);
    if (
      (
        await this.scanBrowserContentGuardForMemory(content, {
          sessionId,
          workspaceId,
          sourceRef: source.sourceRef,
        })
      ).blocked
    ) {
      return;
    }
    let storedSource: { source_authority?: string; role?: string; content?: string } | undefined;
    try {
      storedSource = await this.deps.admin.gatewaySql
        .prepare("SELECT source_authority, role, content FROM chat_messages WHERE message_id = ? AND session_id = ?")
        .get<{ source_authority?: string; role?: string; content?: string }>(source.sourceRef, sessionId);
    } catch {
      // Missing or unreadable canonical message authority is untrusted. The
      // normalization below deliberately fails closed to `unknown`.
      storedSource = undefined;
    }
    const canonicalSourceMatches =
      storedSource !== undefined && storedSource.role === source.role && storedSource.content === content;
    const sourceAuthority = canonicalSourceMatches
      ? normalizeChatMessageSourceAuthority(storedSource?.source_authority)
      : "unknown";
    let gateDecision: ReturnType<MemoryWriteGateService["evaluate"]> | undefined;
    if (this.deps.writeGate) {
      const authority: MemoryWriteAuthority = sourceAuthority === "unknown" ? "external_channel" : sourceAuthority;
      const existingClaims = (await this.deps.learned.listChatSessionLearnedMemory(sessionId, 200)).items.map(
        (item) => item.content,
      );
      gateDecision = this.deps.writeGate.evaluate({
        authority,
        content,
        existingClaims,
      });
      await this.deps.evidence?.createEnvelope({
        eventKind: "memory_write",
        workspaceId,
        sessionId,
        memoryLineage: [source.sourceRef],
        metadata: {
          decision: gateDecision,
          sourceRole: source.role,
          sourceAuthority,
          sourceRef: source.sourceRef,
          claimPreview:
            sourceAuthority === "external_channel" || sourceAuthority === "unknown"
              ? "[redacted external evidence]"
              : gateDecision.redactionStatus === "blocked_secret"
                ? "[redacted]"
                : content.slice(0, 240),
        },
      });
      if (gateDecision.decision === "blocked") {
        return;
      }
    }

    if (sourceAuthority === "external_channel" || sourceAuthority === "unknown") {
      if (!shouldExtractLearnedMemoryContent(content, source)) {
        return;
      }
      const candidates = extractLearnedMemoryCandidates(content, source.role);
      for (const candidate of candidates) {
        try {
          const evidenceHash = createHash("sha256").update(content).digest("hex");
          await this.proposeTraceMemoryCandidate(
            {
              workspaceId,
              candidateType: mapLearnedItemTypeToTraceCandidateType(candidate.itemType),
              sourceText: `[redacted external evidence sha256:${evidenceHash}]`,
              sourceSessionId: sessionId,
              sourceMessageId: source.sourceRef,
              proposedInsight: candidate.content,
              confidence: candidate.confidence,
              sourceRefs: [{ sourceType: "external", sourceRef: source.sourceRef }],
              metadata: {
                sourceAuthority,
                sourceSessionId: sessionId,
                sourceMessageId: source.sourceRef,
                learnedMemoryItemType: candidate.itemType,
                evidenceSha256: evidenceHash,
                gateDecision,
              },
            },
            "external-channel-ingest",
            sourceAuthority,
          );
        } catch (error) {
          await this.deps.evidence?.createEnvelope({
            eventKind: "memory_write",
            workspaceId,
            sessionId,
            memoryLineage: [source.sourceRef],
            metadata: {
              decision: "candidate_storage_unavailable",
              sourceAuthority,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          });
        }
      }
      return;
    }

    if (gateDecision && gateDecision.decision !== "allowed") {
      return;
    }
    await this.deps.learned.extractAndPersistLearnedMemory(sessionId, content, source);
  }

  public async listSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): Promise<{
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    return await this.deps.learned.listChatSessionLearnedMemory(sessionId, limit);
  }

  public async updateSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): Promise<LearnedMemoryItemRecord> {
    return await this.deps.learned.updateChatSessionLearnedMemory(sessionId, itemId, input);
  }

  public async rebuildSessionLearnedMemory(sessionId: string): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    await this.deps.learned.clearChatSessionLearnedMemory(sessionId);
    const messages = await this.deps.admin.gatewaySql
      .prepare(
        `SELECT message_id, role, content, source_authority
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all<CanonicalLearnedMemoryMessageRow>(sessionId);
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      await this.extractLearnedMemory(sessionId, message.content, {
        role: message.role,
        sourceRef: message.message_id,
        authority: normalizeChatMessageSourceAuthority(message.source_authority ?? undefined),
      });
    }
    const snapshot = await this.listSessionLearnedMemory(sessionId, 500);
    return { rebuiltAt: new Date().toISOString(), ...snapshot };
  }

  public async getMaintenancePolicy(workspaceId?: string): Promise<MemoryMaintenancePolicyRecord> {
    return this.deps.maintenance.getPolicy(workspaceId);
  }

  public patchMaintenancePolicy(
    workspaceId: string | undefined,
    patch: MemoryMaintenancePolicyPatchInput,
  ): Promise<MemoryMaintenancePolicyRecord> {
    return this.deps.maintenance.patchPolicy(workspaceId, patch);
  }

  public async getMaintenanceStatus(workspaceId?: string): Promise<MemoryMaintenanceStatusRecord> {
    return this.deps.maintenance.getStatus(workspaceId);
  }

  public async listMaintenanceRuns(workspaceId?: string, limit = 50): Promise<MemoryMaintenanceRunRecord[]> {
    return this.deps.maintenance.listRuns(workspaceId, limit);
  }

  public async runMaintenanceNow(input: MemoryMaintenanceRunNowInput): Promise<MemoryMaintenanceRunRecord> {
    return this.deps.maintenance.runNow(input);
  }

  public async getMaintenanceRunProvenance(runId: string): Promise<MemoryMaintenanceProvenanceRecord> {
    return this.deps.maintenance.getRunProvenance(runId);
  }

  public async listMaintenanceRecommendations(
    workspaceId?: string,
    limit = 50,
  ): Promise<MemoryMaintenanceRecommendationRecord[]> {
    return this.deps.maintenance.listRecommendations(workspaceId, limit);
  }

  public async acceptMaintenanceRecommendation(recommendationId: string): Promise<{
    recommendation: MemoryMaintenanceRecommendationRecord;
    policy: MemoryMaintenancePolicyRecord;
  }> {
    return this.deps.maintenance.acceptRecommendation(recommendationId);
  }

  public async rejectMaintenanceRecommendation(
    recommendationId: string,
  ): Promise<MemoryMaintenanceRecommendationRecord> {
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

  public async syncMaintenanceFromDurableRun(run: DurableRunRecord): Promise<void> {
    await this.deps.maintenance.syncFromDurableRun(run);
  }

  public executeMaintenanceDurableRun(
    run: DurableRunRecord,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    return this.deps.maintenance.executeDurableRun(run, options);
  }

  private async requireMemoryEntity(entityId: string): Promise<MemoryEntityRecord> {
    const row = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_entities WHERE entity_id = ?")
      .get<MemoryEntityRow>(entityId);
    if (!row) {
      throw new NotFoundError({ entity: "Memory entity", id: entityId });
    }
    return mapMemoryEntityRow(this.deps.admin, row);
  }

  private async requireMemoryDecision(decisionId: string): Promise<MemoryDecisionRecord> {
    const row = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_decisions WHERE decision_id = ?")
      .get<MemoryDecisionRow>(decisionId);
    if (!row) {
      throw new NotFoundError({ entity: "Memory decision", id: decisionId });
    }
    return mapMemoryDecisionRow(this.deps.admin, row);
  }

  private async requireMemoryLearning(learningId: string): Promise<MemoryLearningRecord> {
    const row = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_learnings WHERE learning_id = ?")
      .get<MemoryLearningRow>(learningId);
    if (!row) {
      throw new NotFoundError({ entity: "Memory learning", id: learningId });
    }
    return mapLearningRow(this.deps.admin, row);
  }

  private async insertMemoryLearning(
    input: MemoryLearningInput,
    actorId: string,
    status: MemoryLearningStatus,
  ): Promise<MemoryLearningRecord> {
    await this.deps.admin.requireFeatureEnabled("memoryLifecycleAdminV1Enabled");
    await this.ensureLearningSchema();
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
    await this.assertStructuredMemoryWriteAllowed(
      learning.authority,
      serializeLearningForGate(learning),
      learning.workspaceId,
    );
    await this.deps.admin.gatewaySql
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
    await this.deps.admin.publishRealtime("system", "memory", {
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

  private async inspectLearningIssues(learning: MemoryLearningRecord): Promise<MemoryLearningStalenessIssue[]> {
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
    const contradictions = (
      await this.listMemoryLearnings({
        workspaceId: learning.workspaceId,
        key: learning.key,
        status: "all",
        limit: 20,
      })
    ).filter(
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

  private async ensureLearningSchema(): Promise<void> {
    await this.deps.admin.gatewaySql
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
    await this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_learnings_workspace_status ON memory_learnings(workspace_id, status)",
      )
      .run();
    await this.deps.admin.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_memory_learnings_key ON memory_learnings(workspace_id, learning_key)")
      .run();
  }

  private async ensureFeedbackSchema(): Promise<void> {
    await this.deps.admin.gatewaySql
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
    await this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_feedback_workspace_status ON memory_feedback(workspace_id, status)",
      )
      .run();
    await this.deps.admin.gatewaySql
      .prepare("CREATE INDEX IF NOT EXISTS idx_memory_feedback_target ON memory_feedback(target_kind, target_ref)")
      .run();
  }

  private async ensureTraceCandidateSchema(): Promise<void> {
    await this.deps.admin.gatewaySql
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
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
      )
      .run();
    await this.deps.admin.gatewaySql
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_trace_candidates_workspace_status ON memory_trace_candidates(workspace_id, status)",
      )
      .run();
    await this.deps.admin.gatewaySql
      .prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_trace_candidates_dedupe_key ON memory_trace_candidates(dedupe_key)",
      )
      .run();
  }

  private async requireTraceMemoryCandidate(candidateId: string): Promise<TraceMemoryCandidateRecord> {
    const row = await this.deps.admin.gatewaySql
      .prepare("SELECT * FROM memory_trace_candidates WHERE candidate_id = ?")
      .get<TraceMemoryCandidateRow>(candidateId);
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
      const summarized = (await this.listRunContexts(runId))
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

  private async assertTraceCandidateContentAllowed(content: string, workspaceId?: string): Promise<void> {
    if (SECRET_LIKE_TRACE_PATTERN.test(content)) {
      await this.deps.evidence?.createEnvelope({
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
    const browserContentGuard = await this.scanBrowserContentGuardForMemory(content, {
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

  private async assertMemoryFeedbackContentAllowed(content: string, workspaceId?: string): Promise<void> {
    if (SECRET_LIKE_TRACE_PATTERN.test(content)) {
      await this.deps.evidence?.createEnvelope({
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
    const browserContentGuard = await this.scanBrowserContentGuardForMemory(content, {
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

  private async assertStructuredMemoryWriteAllowed(
    authority: StructuredMemoryAuthority,
    content: string,
    workspaceId?: string,
  ): Promise<void> {
    const browserContentGuard = await this.scanBrowserContentGuardForMemory(content, {
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
      await this.deps.evidence?.createEnvelope({
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

  private async scanBrowserContentGuardForMemory(
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<BrowserContentGuardResult> {
    const browserContentGuard = scanBrowserContentGuard(content);
    if (browserContentGuard.blocked) {
      await this.deps.evidence?.createEnvelope({
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

  /**
   * HX-402 P1: structured record mutations commit their history row AND their
   * Journey evidence inside the caller's transaction. The Journey event is
   * explicit review-only provenance (`approvalRequired: false`, never
   * promotion or callability); when the Journey host is absent (read-only
   * harnesses) the history row still commits atomically with the record.
   */
  private async recordStructuredMemoryChange(
    recordKind: "entity" | "relation" | "decision",
    recordId: string,
    changeType: MemoryChangeEvent["changeType"],
    actorId: string | undefined,
    payload: Record<string, unknown>,
    options: { workspaceId?: string; correctionRefId?: string } = {},
  ): Promise<string> {
    const changeId = randomUUID();
    const createdAt = new Date().toISOString();
    await this.deps.admin.gatewaySql
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
        changeId,
        recordKind,
        recordId,
        changeType,
        actorId: actorId?.trim() || null,
        payloadJson: JSON.stringify(payload ?? {}),
        createdAt,
      });
    const journeyHost = this.deps.approvalAuthority?.governanceJourneyEvents;
    const workspaceId = options.workspaceId?.trim();
    if (journeyHost && workspaceId) {
      await journeyHost.create(
        buildStructuredMemoryJourneyEvent({
          recordKind,
          recordId,
          changeId,
          changeType,
          actorId: actorId?.trim() || "operator",
          workspaceId,
          occurredAt: createdAt,
          ...(options.correctionRefId === undefined ? {} : { correctionRefId: options.correctionRefId }),
        }),
      );
    }
    return changeId;
  }

  /** One transaction for a structured record write, its history row, and its Journey evidence. */
  private async runStructuredMemoryTransaction<T>(write: () => T | Promise<T>): Promise<Awaited<T>> {
    return await requireMemoryBatchTransaction(this.deps.admin.gatewaySql)(write);
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
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

interface CanonicalLearnedMemoryMessageRow {
  message_id: string;
  role: string;
  content: string;
  source_authority: string | null;
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
  const metadata = parseMemoryJson<Record<string, unknown>>(host, row.metadata_json, {});
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    candidateType: normalizeTraceCandidateType(row.candidate_type),
    status: normalizeTraceCandidateStatus(row.status),
    sourceText: row.source_text,
    proposedInsight: row.proposed_insight,
    confidence: normalizeConfidence(row.confidence),
    sourceRefs: parseMemoryJson(host, row.source_refs_json, []),
    metadata,
    authority: normalizeTraceCandidateAuthority(row.authority),
    dedupeKey: row.dedupe_key?.trim() || `legacy:${row.candidate_id}`,
    sourceSessionId: readRecordString(metadata, "sourceSessionId"),
    sourceMessageId: readRecordString(metadata, "sourceMessageId"),
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
): <T>(callback: () => T | Promise<T>) => Promise<Awaited<T>> {
  return gatewaySql.runImmediateTransaction.bind(gatewaySql);
}

const MEMORY_MUTATION_POSTGRES_LOCK_TIMEOUT_MS = 5_000;

/**
 * Bounded row-lock wait for the approved mutation transactions on PostgreSQL:
 * a stalled foreign lock fails the mutation loudly (and rolls it back) instead
 * of stalling the recovered effect worker indefinitely.
 */
async function applyPostgresRowLockTimeout(gatewaySql: MemoryLifecycleAdminDependencies["gatewaySql"]): Promise<void> {
  if (gatewaySql.dialect !== "postgres") return;
  await gatewaySql
    .prepare("SELECT set_config('lock_timeout', @lockTimeout, true)")
    .run({ lockTimeout: `${MEMORY_MUTATION_POSTGRES_LOCK_TIMEOUT_MS}ms` });
}

function requireWorkspaceOwnedMemoryItem(item: MemoryItemRecord): MemoryItemRecord & { workspaceId: string } {
  const workspaceId = item.workspaceId?.normalize("NFKC").trim();
  if (!workspaceId || workspaceId !== item.workspaceId || workspaceId.length > 256) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Approved memory mutations require an exact workspace-owned item.",
    });
  }
  return { ...item, workspaceId };
}

function approvedMemoryItemPatchMaterial(patch: MemoryLifecyclePatch): Record<string, unknown> {
  const material: Record<string, unknown> = {};
  if (patch.title !== undefined) material.title = patch.title;
  if (patch.content !== undefined) material.content = patch.content;
  if (patch.metadata !== undefined) material.metadata = patch.metadata;
  if (patch.pinned !== undefined) material.pinned = patch.pinned;
  if (patch.ttlOverrideSeconds !== undefined) material.ttlOverrideSeconds = patch.ttlOverrideSeconds;
  return material;
}

function snapshotApprovedMemoryItemPatch(patch: MemoryLifecyclePatch): MemoryLifecyclePatch {
  validateApprovedMemoryItemPatch(patch);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(canonicalJsonString(approvedMemoryItemPatchMaterial(patch))) as unknown;
  } catch {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "patch",
      message: "Approved memory patch must be canonical JSON data.",
    });
  }
  validateApprovedMemoryItemPatch(snapshot as MemoryLifecyclePatch);
  return snapshot as MemoryLifecyclePatch;
}

function validateApprovedMemoryItemPatch(patch: MemoryLifecyclePatch): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "patch" });
  }
  const allowedFields = new Set(["title", "content", "metadata", "pinned", "ttlOverrideSeconds"]);
  if (Object.keys(patch).some((field) => !allowedFields.has(field))) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "patch",
      message: "Approved memory patch contains an unsupported field.",
    });
  }
  if (
    patch.title !== undefined &&
    (typeof patch.title !== "string" || !patch.title.trim() || patch.title !== patch.title.normalize("NFKC").trim())
  ) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "title",
      message: "Approved memory title must already be a non-empty canonical value.",
    });
  }
  if (patch.content !== undefined && (typeof patch.content !== "string" || patch.content.length === 0)) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "content" });
  }
  if (
    patch.metadata !== undefined &&
    (!patch.metadata ||
      typeof patch.metadata !== "object" ||
      Array.isArray(patch.metadata) ||
      !isApprovedMemoryJsonData(patch.metadata))
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "metadata" });
  }
  if (patch.metadata !== undefined) {
    try {
      canonicalJsonString(patch.metadata);
    } catch {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "metadata",
        message: "Approved memory metadata must be canonical JSON data.",
      });
    }
  }
  if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
    throw new ValidationError({ code: "FIELD_INVALID", field: "pinned" });
  }
  if (
    patch.ttlOverrideSeconds !== undefined &&
    patch.ttlOverrideSeconds !== null &&
    (!Number.isInteger(patch.ttlOverrideSeconds) ||
      patch.ttlOverrideSeconds < 1 ||
      patch.ttlOverrideSeconds > 31_536_000)
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "ttlOverrideSeconds" });
  }
}

function isApprovedMemoryJsonData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isApprovedMemoryJsonData(entry, seen, depth + 1))
    : Object.values(value).every((entry) => isApprovedMemoryJsonData(entry, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function buildApprovedMemoryItemPatch(
  current: MemoryItemRecord,
  patch: MemoryLifecyclePatch,
  occurredAt: string,
): {
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  pinned: boolean;
  ttlOverrideSeconds: number | null;
  expiresAt: string | null;
} {
  const ttlOverrideSeconds =
    patch.ttlOverrideSeconds !== undefined ? patch.ttlOverrideSeconds : (current.ttlOverrideSeconds ?? null);
  return {
    title: patch.title !== undefined ? patch.title : current.title,
    content: patch.content !== undefined ? patch.content : current.content,
    metadata: patch.metadata !== undefined ? patch.metadata : current.metadata,
    pinned: patch.pinned !== undefined ? patch.pinned : current.pinned,
    ttlOverrideSeconds,
    expiresAt:
      patch.ttlOverrideSeconds === null
        ? null
        : patch.ttlOverrideSeconds !== undefined
          ? new Date(Date.parse(occurredAt) + Number(ttlOverrideSeconds) * 1_000).toISOString()
          : (current.expiresAt ?? null),
  };
}

function approvedMemoryPatchChangedFields(
  current: MemoryItemRecord,
  next: ReturnType<typeof buildApprovedMemoryItemPatch>,
): string[] {
  const fields: string[] = [];
  if (current.title !== next.title) fields.push("title");
  if (current.content !== next.content) fields.push("content");
  if (canonicalJsonString(current.metadata) !== canonicalJsonString(next.metadata)) fields.push("metadata");
  if (current.pinned !== next.pinned) fields.push("pinned");
  if ((current.ttlOverrideSeconds ?? null) !== next.ttlOverrideSeconds) fields.push("ttl_override");
  if ((current.expiresAt ?? null) !== next.expiresAt) fields.push("expires_at");
  return fields;
}

function approvedMemoryPatchEventPlans(
  patch: MemoryLifecyclePatch,
  authority: ApprovedMemoryMutationAuthority,
  current: MemoryItemRecord,
): Array<{
  action: MemoryJourneyEventAction;
  changeType: MemoryChangeEvent["changeType"];
  changeId: string;
  fieldCodes: string[];
}> {
  const fieldCodes = getBatchPatchChangedFields(patch).flatMap((field) =>
    field === "ttlOverrideSeconds" ? ["ttl_override", "expires_at"] : [field],
  );
  const action = "item_updated" as const;
  return [
    {
      action,
      changeType: "updated",
      changeId: deriveApprovedMemoryHistoryId({
        approvalId: authority.approvalId,
        subjectId: current.itemId,
        action,
      }),
      fieldCodes,
    },
  ];
}

function approvedMemoryReplayFieldCodes(payload: Record<string, unknown>, allowedFieldCodes: string[]): string[] {
  const value = payload.fieldCodes;
  if (!Array.isArray(value) || value.length === 0 || value.some((field) => typeof field !== "string")) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Approved memory patch history has invalid changed-field evidence.",
    });
  }
  const normalized = [...new Set(value as string[])].sort(compareMemoryItemIds);
  if (
    canonicalJsonString(normalized) !== canonicalJsonString(value) ||
    normalized.some((field) => !allowedFieldCodes.includes(field))
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Approved memory patch history has invalid changed-field evidence.",
    });
  }
  return normalized;
}

function approvedMemoryForgetEventPlan(
  item: MemoryItemRecord,
  authority: ApprovedMemoryMutationAuthority,
): {
  changeId: string;
  historyPayload: Record<string, unknown>;
} {
  return {
    changeId: deriveApprovedMemoryHistoryId({
      approvalId: authority.approvalId,
      subjectId: item.itemId,
      action: "forgotten",
    }),
    historyPayload: approvedMemoryHistoryPayload(authority, "approved_forget", ["status"]),
  };
}

function approvedMemoryHistoryPayload(
  authority: ApprovedMemoryMutationAuthority,
  operationKind: "approved_patch" | "approved_forget" | "approved_batch",
  fieldCodes: string[],
): Record<string, unknown> {
  return {
    approvalId: authority.approvalId,
    requestSha256: authority.requestSha256,
    expectedStateSha256: authority.expectedStateSha256,
    operationKind,
    fieldCodes: [...new Set(fieldCodes)].sort(compareMemoryItemIds),
    correctionProvenance: authority.correctionActionId ? "explicit" : "not_applicable",
    ...(authority.correctionActionId ? { correctionActionId: authority.correctionActionId } : {}),
    storesRawContent: false,
  };
}

/**
 * Canonical, snapshotted batch operations for approval hashing and approved
 * execution: patches are validated/cloned exactly like single-item approved
 * patches, and target item IDs must be distinct so the batch's expected-state
 * material, replay identity, and CAS guards stay exact.
 */
function snapshotApprovedBatchOperations(operations: MemoryBatchMutationOperation[]): MemoryBatchMutationOperation[] {
  const itemIds = operations.map((operation) => operation.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "operations",
      message: "Approved memory batch operations must target distinct items.",
    });
  }
  return operations.map((operation) => {
    if (operation.itemId !== operation.itemId.normalize("NFKC").trim() || operation.itemId.length > 256) {
      throw new ValidationError({ code: "FIELD_INVALID", field: "operations" });
    }
    if (operation.kind === "forget_item") {
      return { kind: "forget_item", itemId: operation.itemId };
    }
    return { kind: "patch_item", itemId: operation.itemId, patch: snapshotApprovedMemoryItemPatch(operation.patch) };
  });
}

function approvedBatchChangeType(operation: MemoryBatchMutationOperation): MemoryChangeEvent["changeType"] {
  if (operation.kind === "forget_item") return "forgotten";
  return resolveBatchPatchChangeType(getBatchPatchChangedFields(operation.patch));
}

function approvedBatchFieldCodes(operation: MemoryBatchMutationOperation): string[] {
  if (operation.kind === "forget_item") return ["status"];
  return getBatchPatchChangedFields(operation.patch).flatMap((field) =>
    field === "ttlOverrideSeconds" ? ["ttl_override", "expires_at"] : [field],
  );
}

function approvedBatchHistoryPayload(
  authority: ApprovedMemoryMutationAuthority,
  operation: MemoryBatchMutationOperation,
  operationIndex: number,
): Record<string, unknown> {
  return {
    ...approvedMemoryHistoryPayload(authority, "approved_batch", approvedBatchFieldCodes(operation)),
    batchOperationIndex: operationIndex,
    batchOperationKind: operation.kind,
  };
}

function buildApprovedBatchResult(
  operationIndex: number,
  operation: MemoryBatchMutationOperation,
  item: MemoryItemRecord,
): MemoryBatchMutationResult {
  return {
    operationIndex,
    kind: operation.kind,
    itemId: item.itemId,
    status: "applied",
    item,
  };
}

function normalizeApprovedMemoryActionId(actionId: string | undefined, fallback: string): string {
  if (actionId === undefined) return fallback;
  const canonical = actionId.normalize("NFKC").trim();
  if (!canonical || canonical !== actionId || canonical.length > 120) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "actionId",
      message: "Memory mutation actionId must be a canonical identifier of at most 120 characters.",
    });
  }
  return canonical;
}

function deriveApprovedMemoryRequestDigest(material: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJsonString({ schemaVersion: "goatcitadel.memory-lifecycle-action-id.v1", material }), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function requireCanonicalMemoryActorId(value: string): string {
  const canonical = value.normalize("NFKC").trim();
  if (!canonical || canonical !== value || canonical.length > 256) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "requesterId",
      message: "Memory mutation requester identity must be canonical.",
    });
  }
  return canonical;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApprovedForgetMutation(value: unknown): { actionId: string; itemIds: string[] } | undefined {
  if (!isRecordValue(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["actionId", "itemIds"])) return undefined;
  const actionId = value.actionId;
  const itemIds = value.itemIds;
  if (
    typeof actionId !== "string" ||
    !actionId.trim() ||
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    itemIds.some((itemId) => typeof itemId !== "string" || !itemId.trim())
  ) {
    return undefined;
  }
  return { actionId, itemIds: itemIds as string[] };
}

function parseApprovedBatchMutation(
  value: unknown,
): { actionId: string; operations: MemoryBatchMutationOperation[] } | undefined {
  if (!isRecordValue(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["actionId", "operations"])) return undefined;
  const actionId = value.actionId;
  if (typeof actionId !== "string" || !actionId.trim() || !Array.isArray(value.operations)) return undefined;
  try {
    return {
      actionId,
      operations: normalizeBatchMutationOperations(value.operations as MemoryBatchMutationOperation[]),
    };
  } catch {
    return undefined;
  }
}

function compareMemoryItemIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeMemoryLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isActiveRoutedContextMemoryRow(
  row: MemoryForgetSelectionRow,
  input: { itemId: string; workspaceId: string; allowGlobal: boolean; nowIso: string },
): boolean {
  if (!isCanonicalIsoTimestamp(input.nowIso)) {
    return false;
  }
  if (
    row.item_id !== input.itemId ||
    row.status !== "active" ||
    row.forgotten_at !== null ||
    (row.expires_at !== null &&
      (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(input.nowIso)))
  ) {
    return false;
  }

  let metadata: unknown;
  try {
    metadata = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json);
  } catch {
    return false;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }

  if (row.workspace_id !== null) {
    return row.workspace_id === input.workspaceId;
  }

  const metadataRecord = metadata as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(metadataRecord, "workspaceId")) {
    const legacyWorkspaceId = metadataRecord.workspaceId;
    return (
      typeof legacyWorkspaceId === "string" &&
      legacyWorkspaceId.trim().length > 0 &&
      legacyWorkspaceId.trim() === input.workspaceId
    );
  }
  return input.allowGlobal;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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

function normalizeTraceCandidateAuthority(value: string | undefined): TraceMemoryCandidateAuthority {
  return value === "external_channel" || value === "unknown" ? value : "agent_proposed";
}

function normalizeChatMessageSourceAuthority(value: string | undefined): ChatMessageSourceAuthority {
  return value === "operator" ||
    value === "external_channel" ||
    value === "agent_proposed" ||
    value === "trusted_lifecycle"
    ? value
    : "unknown";
}

function mapLearnedItemTypeToTraceCandidateType(value: LearnedMemoryItemType): TraceMemoryCandidateType {
  if (value === "preference") return "operator_preference";
  if (value === "goal" || value === "constraint") return "decision";
  if (value === "project_context") return "repo_fact";
  return "fact";
}

function buildTraceMemoryCandidateDedupeKey(input: {
  workspaceId: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  candidateType: TraceMemoryCandidateType;
  proposedInsight: string;
  authority: TraceMemoryCandidateAuthority;
}): string {
  const normalizedContentHash = createHash("sha256")
    .update(input.proposedInsight.toLowerCase().replace(/\s+/gu, " ").trim())
    .digest("hex");
  return createHash("sha256")
    .update(
      [
        input.workspaceId,
        input.sourceSessionId ?? "",
        input.sourceMessageId ?? "",
        input.candidateType,
        normalizedContentHash,
        input.authority,
      ].join("|"),
    )
    .digest("hex");
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

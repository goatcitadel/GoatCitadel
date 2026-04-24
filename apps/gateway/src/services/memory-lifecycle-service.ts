import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatTurnTraceRecord,
  DurableRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  MemoryChangeEvent,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryItemRecord,
  MemoryLifecyclePatch,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  MemoryQmdStatsResponse,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { deriveMemoryItemLifecycleState } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { ChatLearnedMemoryService } from "./chat-learned-memory-service.js";
import { MemoryContextService } from "./memory-context-service.js";
import { mapMemoryItemRow, recordMemoryChange, requireMemoryItem, type MemoryItemHost } from "./memory-item-helpers.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { normalizeMemoryForgetCriteria } from "./security-utils.js";

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
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
}

/**
 * Canonical coordinator for memory lifecycle policy and operator-facing entry
 * points. Lower-level services remain focused collaborators for context
 * composition, learned-memory persistence, and maintenance execution.
 */
export class MemoryLifecycleService {
  public constructor(private readonly deps: MemoryLifecycleDependencies) {}

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
    forgottenItems: MemoryItemRecord[];
  } {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const countRows = this.deps.admin.gatewaySql
      .prepare(
        `
      SELECT
        COUNT(*) AS totalCount,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS retainedPinnedCount
      FROM memory_items
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now
    `,
      )
      .get({ now: nowIso }) as { totalCount?: number | null; retainedPinnedCount?: number | null } | undefined;
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
      totalCount: Number(countRows?.totalCount ?? 0),
      retainedPinnedCount: Number(countRows?.retainedPinnedCount ?? 0),
      forgottenItems,
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
  ): { forgottenCount: number; itemIds: string[] } {
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
    for (const itemId of targets) {
      this.forgetMemoryItem(itemId, actorId);
    }
    return {
      forgottenCount: targets.length,
      itemIds: targets,
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
}

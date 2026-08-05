/* eslint-disable max-lines -- Memory maintenance remains centralized so compaction, retention, and repair rules stay auditable together. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionResponse,
  DurableRunCreateRequest,
  DurableRunRecord,
  LlmRuntimeConfig,
  MemoryItemRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationKind,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceRunSourceRecord,
  MemoryMaintenanceStateRecord,
  MemoryMaintenanceStatusRecord,
  RealtimeEvent,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { LlmService } from "./llm-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import {
  DEFAULT_MEMORY_WORKSPACE_ID,
  matchesMemoryWorkspaceScope,
  MEMORY_RECOMMENDATION_DEDUP_WINDOW_MS,
  shouldSuppressMaintenanceRecommendation,
} from "./memory-lifecycle-policy.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

const MEMORY_MAINTENANCE_WORKFLOW_KEY = "memory.maintenance";
const MEMORY_MAINTENANCE_WORKFLOW_VERSION = "memory.maintenance.v1";
const MAX_TRANSCRIPT_SOURCES = 24;
const MAX_MEMORY_FILE_SOURCES = 24;
const MAX_MEMORY_ITEM_SOURCES = 24;
const MAX_TOOL_ARTIFACT_SOURCES = 16;
const MAX_FILE_BYTES = 12_000;
const MAX_EXCERPT_CHARS = 1_400;
const MAX_MODEL_EVIDENCE_TOKENS = 7_000;
const MAX_MAINTENANCE_OUTPUT_TOKENS = 1_800;
const SCHEDULE_SCAN_WINDOW_MINUTES = 8 * 24 * 60;

interface MemoryMaintenanceWorkflowPayload {
  version: typeof MEMORY_MAINTENANCE_WORKFLOW_VERSION;
  workspaceId: string;
  memoryMaintenanceRunId: string;
  triggerSource: MemoryMaintenanceRunRecord["triggerSource"];
  requestedAt: string;
}

interface MemoryMaintenanceServiceCallbacks {
  createDurableRun(input: DurableRunCreateRequest, options?: { deferRealtime?: boolean }): Promise<DurableRunRecord>;
  getDurableRun(runId: string): Promise<DurableRunRecord>;
}

interface EligibleWorkspaceSession {
  sessionId: string;
  modifiedAt: string;
}

interface MemoryFileSource {
  relativePath: string;
  modifiedAt?: string;
  excerpt: string;
  tokenEstimate: number;
}

interface MaintenanceSourceBundle {
  transcriptSources: MemoryMaintenanceRunSourceRecord[];
  fileSources: MemoryMaintenanceRunSourceRecord[];
  maintenanceSources: MemoryMaintenanceRunSourceRecord[];
  memoryItemSources: MemoryMaintenanceRunSourceRecord[];
  artifactSources: MemoryMaintenanceRunSourceRecord[];
  markdownSections: string[];
}

interface DueEvaluation {
  nextDueAt?: string;
  dueBySchedule: boolean;
  thresholdsMet: boolean;
}

export interface MemoryMaintenancePostTurnEvaluationResult {
  status: "skipped" | "evaluated" | "enqueued";
  workspaceId?: string;
  reason?: string;
  memoryMaintenanceRunId?: string;
  durableRunId?: string;
}

export interface MemoryMaintenanceServiceContext {
  readonly storage: Storage;
  readonly config: GatewayRuntimeConfig;
  readonly llmService: LlmService;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<void>;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<boolean>;
  normalizeWorkspaceId(workspaceId?: string): string;
}

export class MemoryMaintenanceService {
  public constructor(
    private readonly ctx: MemoryMaintenanceServiceContext,
    private readonly callbacks: MemoryMaintenanceServiceCallbacks,
  ) {}

  public parseWorkflowPayload(run: DurableRunRecord): MemoryMaintenanceWorkflowPayload | undefined {
    const payload = toPlainRecord(run.payload) as Partial<MemoryMaintenanceWorkflowPayload> | undefined;
    if (!payload || payload.version !== MEMORY_MAINTENANCE_WORKFLOW_VERSION) {
      return undefined;
    }
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.memoryMaintenanceRunId !== "string" ||
      typeof payload.triggerSource !== "string" ||
      typeof payload.requestedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: MEMORY_MAINTENANCE_WORKFLOW_VERSION,
      workspaceId: this.normalizeWorkspaceId(payload.workspaceId),
      memoryMaintenanceRunId: payload.memoryMaintenanceRunId,
      triggerSource: payload.triggerSource,
      requestedAt: payload.requestedAt,
    };
  }

  public async getPolicy(workspaceId?: string): Promise<MemoryMaintenancePolicyRecord> {
    await this.requireReady();
    return await this.ensurePolicy(this.normalizeWorkspaceId(workspaceId));
  }

  public async patchPolicy(
    workspaceId: string | undefined,
    patch: MemoryMaintenancePolicyPatchInput,
  ): Promise<MemoryMaintenancePolicyRecord> {
    await this.requireReady();
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    const policy = await this.ctx.storage.memoryMaintenance.patchPolicy(
      normalizedWorkspaceId,
      patch,
      this.defaultPolicy(normalizedWorkspaceId),
    );
    await this.refreshState(normalizedWorkspaceId, { touchEligibility: false });
    return policy;
  }

  public async getStatus(workspaceId?: string): Promise<MemoryMaintenanceStatusRecord> {
    await this.requireReady();
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    const policy = await this.ensurePolicy(normalizedWorkspaceId);
    const state = await this.refreshState(normalizedWorkspaceId, { touchEligibility: false });
    const lastRun = (await this.ctx.storage.memoryMaintenance.listRuns(normalizedWorkspaceId, 1))[0];
    const evaluation = this.evaluateDue(policy, state, lastRun, new Date());
    return {
      workspaceId: normalizedWorkspaceId,
      policy,
      state,
      lastRun,
      nextDueAt: evaluation.nextDueAt,
    };
  }

  public async listRuns(workspaceId?: string, limit = 50): Promise<MemoryMaintenanceRunRecord[]> {
    await this.requireReady();
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    await this.refreshState(normalizedWorkspaceId, { touchEligibility: false });
    return await this.ctx.storage.memoryMaintenance.listRuns(normalizedWorkspaceId, limit);
  }

  public async getRunProvenance(runId: string): Promise<MemoryMaintenanceProvenanceRecord> {
    await this.requireReady();
    const run = await this.ctx.storage.memoryMaintenance.getRun(runId);
    await this.syncRunFromDurableIfNeeded(run);
    return {
      run: await this.ctx.storage.memoryMaintenance.getRun(runId),
      sources: await this.ctx.storage.memoryMaintenance.listRunSources(runId),
      changes: await this.ctx.storage.memoryMaintenance.listRunChanges(runId),
    };
  }

  public async listRecommendations(workspaceId?: string, limit = 50): Promise<MemoryMaintenanceRecommendationRecord[]> {
    await this.requireReady();
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    return await this.ctx.storage.memoryMaintenance.listRecommendations(normalizedWorkspaceId, limit);
  }

  public async acceptRecommendation(recommendationId: string): Promise<{
    recommendation: MemoryMaintenanceRecommendationRecord;
    policy: MemoryMaintenancePolicyRecord;
  }> {
    await this.requireReady();
    const recommendation = await this.ctx.storage.memoryMaintenance.getRecommendation(recommendationId);
    const policy = await this.patchPolicy(
      recommendation.workspaceId,
      recommendation.proposedPatch as MemoryMaintenancePolicyPatchInput,
    );
    const now = new Date().toISOString();
    const applied = await this.ctx.storage.memoryMaintenance.updateRecommendation({
      ...recommendation,
      status: "applied",
      updatedAt: now,
      appliedAt: now,
    });
    return {
      recommendation: applied,
      policy,
    };
  }

  public async rejectRecommendation(recommendationId: string): Promise<MemoryMaintenanceRecommendationRecord> {
    await this.requireReady();
    const recommendation = await this.ctx.storage.memoryMaintenance.getRecommendation(recommendationId);
    return await this.ctx.storage.memoryMaintenance.updateRecommendation({
      ...recommendation,
      status: "rejected",
      updatedAt: new Date().toISOString(),
    });
  }

  public async runNow(input: MemoryMaintenanceRunNowInput): Promise<MemoryMaintenanceRunRecord> {
    await this.requireReady();
    const workspaceId = this.normalizeWorkspaceId(input.workspaceId);
    const policy = await this.ensurePolicy(workspaceId);
    return await this.enqueueRun(workspaceId, policy, input.triggerSource ?? "manual");
  }

  public async runDueEvaluation(): Promise<void> {
    if (!(await this.isOperational())) {
      return;
    }
    const workspaceIds = await this.ctx.storage.memoryMaintenance.listEnabledPolicyWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      await this.evaluateWorkspace(this.normalizeWorkspaceId(workspaceId), "scheduler");
    }
  }

  public async noteSuccessfulRootTurn(sessionId: string): Promise<void> {
    await this.evaluateSuccessfulRootTurn(sessionId, false);
  }

  /**
   * Synchronous post-turn evaluation used by a durable child while its live
   * lease and stage receipt are locked in the surrounding storage transaction.
   * All recommendation, due-decision, maintenance-run, and durable-run writes
   * therefore commit with that receipt or roll back with it.
   */
  public async noteSuccessfulRootTurnSync(sessionId: string): Promise<MemoryMaintenancePostTurnEvaluationResult> {
    return await this.evaluateSuccessfulRootTurn(sessionId, true);
  }

  private async evaluateSuccessfulRootTurn(
    sessionId: string,
    deferRealtime: boolean,
  ): Promise<MemoryMaintenancePostTurnEvaluationResult> {
    if (!(await this.isOperational())) {
      return { status: "skipped", reason: "not_operational" };
    }
    const sessionInfo = await this.getEligibleSession(sessionId);
    if (!sessionInfo) {
      return { status: "skipped", reason: "ineligible_session" };
    }
    return await this.evaluateWorkspace(sessionInfo.workspaceId, "post_turn", deferRealtime);
  }

  public async executeDurableRun(
    run: DurableRunRecord,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    throwIfMemoryMaintenanceAborted(options?.signal);
    await this.requireReady();
    const payload = this.parseWorkflowPayload(run);
    if (!payload) {
      throw new Error("Durable memory maintenance payload is invalid or incomplete.");
    }

    const workspaceId = this.normalizeWorkspaceId(payload.workspaceId);
    const policy = await this.ensurePolicy(workspaceId);
    const now = new Date().toISOString();
    let maintenanceRun = await this.ctx.storage.memoryMaintenance.getRun(payload.memoryMaintenanceRunId);
    maintenanceRun = await this.ctx.storage.memoryMaintenance.updateRun({
      ...maintenanceRun,
      durableRunId: run.runId,
      status: "running",
      startedAt: maintenanceRun.startedAt ?? now,
      updatedAt: now,
    });
    await this.ctx.storage.memoryMaintenance.upsertState({
      ...(await this.ensureState(workspaceId)),
      activeRunId: maintenanceRun.runId,
      updatedAt: now,
    });

    const resolvedModel = this.resolveProviderAndModel(policy);
    const availability = await this.checkExecutionAvailability(policy, resolvedModel.providerId, resolvedModel.model);
    throwIfMemoryMaintenanceAborted(options?.signal);
    if (!availability.available) {
      const unavailableReason = availability.reason ?? "Memory maintenance model is unavailable.";
      if (policy.unavailableModelPolicy === "error") {
        await this.finalizeRunFailure(maintenanceRun.runId, unavailableReason);
        throw new Error(unavailableReason);
      }
      const skipped = await this.finalizeRunStatus(maintenanceRun.runId, workspaceId, {
        status: "skipped",
        summary: unavailableReason,
        error: unavailableReason,
        sourceSessionCount: 0,
        changedArtifactCount: 0,
      });
      await this.maybeCreateUnavailableModelRecommendation(workspaceId, policy, unavailableReason);
      return {
        memoryMaintenanceRunId: skipped.runId,
        workspaceId,
        status: skipped.status,
        summary: skipped.summary,
        providerId: skipped.providerId,
        model: skipped.model,
      };
    }

    try {
      const state = await this.ensureState(workspaceId);
      const sources = await this.collectSources(workspaceId, state.lastSuccessfulRunAt, maintenanceRun.runId);
      throwIfMemoryMaintenanceAborted(options?.signal);
      const generated = await this.generateConsolidatedArtifact({
        workspaceId,
        runId: maintenanceRun.runId,
        triggerSource: payload.triggerSource,
        policy,
        providerId: resolvedModel.providerId,
        model: resolvedModel.model,
        sources,
      });
      throwIfMemoryMaintenanceAborted(options?.signal);
      const output = await this.writeMaintenanceArtifacts({
        workspaceId,
        runId: maintenanceRun.runId,
        triggerSource: payload.triggerSource,
        policy,
        consolidatedMarkdown: generated.markdown,
        generatedSummary: generated.summary,
      });
      throwIfMemoryMaintenanceAborted(options?.signal);
      const allSources = [
        ...sources.transcriptSources,
        ...sources.fileSources,
        ...sources.maintenanceSources,
        ...sources.memoryItemSources,
        ...sources.artifactSources,
      ];
      const sourceSessionCount = sources.transcriptSources.length;
      await this.ctx.storage.memoryMaintenance.replaceRunSources(maintenanceRun.runId, allSources);
      await this.ctx.storage.memoryMaintenance.replaceRunChanges(maintenanceRun.runId, output.changes);

      const completed = await this.finalizeRunStatus(maintenanceRun.runId, workspaceId, {
        status: "completed",
        summary: output.summary,
        sourceSessionCount,
        changedArtifactCount: output.changes.length,
      });

      const refreshedState = await this.refreshState(workspaceId, {
        touchEligibility: false,
        overrideLastSuccessfulRunAt: completed.finishedAt ?? new Date().toISOString(),
      });
      await this.maybeCreateBacklogRecommendation(workspaceId, policy, refreshedState);
      await this.maybeCreateActivityWindowRecommendation(workspaceId, policy);

      return {
        memoryMaintenanceRunId: completed.runId,
        workspaceId,
        status: completed.status,
        summary: completed.summary,
        snapshotPath: output.snapshotPath,
        latestPath: output.latestPath,
        sourceSessionCount,
        changedArtifactCount: output.changes.length,
      };
    } catch (error) {
      if (isMemoryMaintenanceAbortError(error, options?.signal)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Memory maintenance execution failed.";
      await this.finalizeRunFailureIfCurrent(maintenanceRun.runId, run.runId, message);
      throw error;
    }
  }

  public async syncFromDurableRun(run: DurableRunRecord): Promise<void> {
    if (run.workflowKey !== MEMORY_MAINTENANCE_WORKFLOW_KEY) {
      return;
    }
    const payload = this.parseWorkflowPayload(run);
    if (!payload) {
      return;
    }
    const workspaceId = this.normalizeWorkspaceId(payload.workspaceId);
    let maintenanceRun: MemoryMaintenanceRunRecord;
    try {
      maintenanceRun = await this.ctx.storage.memoryMaintenance.getRun(payload.memoryMaintenanceRunId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return;
      }
      throw error;
    }

    if (run.status === "queued" || run.status === "running") {
      const nextStatus = run.status === "running" ? "running" : "queued";
      await this.ctx.storage.memoryMaintenance.updateRun({
        ...maintenanceRun,
        durableRunId: run.runId,
        status: nextStatus,
        startedAt: maintenanceRun.startedAt ?? run.startedAt ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.ctx.storage.memoryMaintenance.upsertState({
        ...(await this.ensureState(workspaceId)),
        activeRunId: maintenanceRun.runId,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (
      maintenanceRun.status === "completed" ||
      maintenanceRun.status === "skipped" ||
      maintenanceRun.status === "cancelled"
    ) {
      if (run.status === "cancelled") {
        await this.ctx.storage.memoryMaintenance.upsertState({
          ...(await this.ensureState(workspaceId)),
          activeRunId: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (run.status === "cancelled") {
      await this.finalizeRunStatus(maintenanceRun.runId, workspaceId, {
        status: "cancelled",
        summary: maintenanceRun.summary ?? "Run cancelled.",
        error: run.lastError ?? maintenanceRun.error,
        sourceSessionCount: maintenanceRun.sourceSessionCount,
        changedArtifactCount: maintenanceRun.changedArtifactCount,
      });
      return;
    }

    if (run.status === "failed" || run.status === "dead_lettered") {
      await this.finalizeRunFailure(
        maintenanceRun.runId,
        run.lastError ?? maintenanceRun.error ?? "Memory maintenance durable run failed.",
      );
    }
  }

  private async requireReady(): Promise<void> {
    await this.ctx.requireFeatureEnabled("memoryMaintenanceV1Enabled");
    await this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
  }

  private async isOperational(): Promise<boolean> {
    return (
      (await this.ctx.isFeatureEnabled("memoryMaintenanceV1Enabled")) &&
      (await this.ctx.isFeatureEnabled("durableKernelV1Enabled"))
    );
  }

  private normalizeWorkspaceId(workspaceId?: string): string {
    return this.ctx.normalizeWorkspaceId(workspaceId);
  }

  private async ensurePolicy(workspaceId: string): Promise<MemoryMaintenancePolicyRecord> {
    const existing = await this.ctx.storage.memoryMaintenance.findPolicy(workspaceId);
    return existing ?? (await this.ctx.storage.memoryMaintenance.upsertPolicy(this.defaultPolicy(workspaceId)));
  }

  private async ensureState(workspaceId: string): Promise<MemoryMaintenanceStateRecord> {
    const existing = await this.ctx.storage.memoryMaintenance.findState(workspaceId);
    return existing ?? (await this.ctx.storage.memoryMaintenance.upsertState(this.defaultState(workspaceId)));
  }

  private defaultPolicy(workspaceId: string, now = new Date().toISOString()): MemoryMaintenancePolicyRecord {
    return {
      workspaceId,
      enabled: false,
      runMode: "hybrid",
      timingStrategy: "recommendation_first",
      schedule: {
        frequency: "daily",
        hour: 3,
        minute: 0,
      },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      minHoursSinceLastSuccess: 24,
      minChangedSessions: 3,
      executionTarget: "local",
      unavailableModelPolicy: "skip",
      createdAt: now,
      updatedAt: now,
    };
  }

  private defaultState(workspaceId: string, now = new Date().toISOString()): MemoryMaintenanceStateRecord {
    return {
      workspaceId,
      changedSessionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async refreshState(
    workspaceId: string,
    options: {
      touchEligibility: boolean;
      overrideLastSuccessfulRunAt?: string;
    },
  ): Promise<MemoryMaintenanceStateRecord> {
    let state = await this.ensureState(workspaceId);
    state = await this.syncWorkspaceActiveRun(state);
    const now = new Date().toISOString();
    const lastSuccessfulRunAt = options.overrideLastSuccessfulRunAt ?? state.lastSuccessfulRunAt;
    const changedSessionCount = await this.countChangedSessions(workspaceId, lastSuccessfulRunAt);
    return await this.ctx.storage.memoryMaintenance.upsertState({
      ...state,
      lastSuccessfulRunAt,
      changedSessionCount,
      lastEligibilityAt: options.touchEligibility ? now : state.lastEligibilityAt,
      updatedAt: now,
    });
  }

  private async syncWorkspaceActiveRun(state: MemoryMaintenanceStateRecord): Promise<MemoryMaintenanceStateRecord> {
    if (!state.activeRunId) {
      return state;
    }
    let maintenanceRun: MemoryMaintenanceRunRecord | undefined;
    try {
      maintenanceRun = await this.ctx.storage.memoryMaintenance.getRun(state.activeRunId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return await this.ctx.storage.memoryMaintenance.upsertState({
          ...state,
          activeRunId: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
    await this.syncRunFromDurableIfNeeded(maintenanceRun);
    const refreshed = await this.ctx.storage.memoryMaintenance.getRun(state.activeRunId);
    if (refreshed.status === "queued" || refreshed.status === "running") {
      return state;
    }
    return await this.ctx.storage.memoryMaintenance.upsertState({
      ...state,
      activeRunId: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  private async syncRunFromDurableIfNeeded(run: MemoryMaintenanceRunRecord): Promise<void> {
    if (!run.durableRunId || (run.status !== "queued" && run.status !== "running")) {
      return;
    }
    try {
      const durable = await this.callbacks.getDurableRun(run.durableRunId);
      await this.syncFromDurableRun(durable);
    } catch {
      // Ignore stale durable references and let state cleanup handle them.
    }
  }

  private async countChangedSessions(workspaceId: string, since?: string): Promise<number> {
    return await this.ctx.storage.memoryMaintenance.countChangedSessions(workspaceId, since);
  }

  private async listEligibleSessions(
    workspaceId: string,
    since?: string,
    limit = MAX_TRANSCRIPT_SOURCES,
  ): Promise<EligibleWorkspaceSession[]> {
    return await this.ctx.storage.memoryMaintenance.listEligibleSessions(workspaceId, since, limit);
  }

  private async getEligibleSession(sessionId: string): Promise<{ sessionId: string; workspaceId: string } | undefined> {
    const meta = await this.ctx.storage.chatSessionMeta.get(sessionId);
    if (!meta || !meta.includeInHistory || (meta.origin && meta.origin !== "operator")) {
      return undefined;
    }
    const binding = await this.ctx.storage.chatSessionBindings.get(sessionId);
    if (!binding || binding.transport !== "llm" || !binding.writable) {
      return undefined;
    }
    if (await this.ctx.storage.taskSubagents.findByAgentSessionId(sessionId)) {
      return undefined;
    }
    return {
      sessionId,
      workspaceId: this.normalizeWorkspaceId(meta.workspaceId),
    };
  }

  private evaluateDue(
    policy: MemoryMaintenancePolicyRecord,
    state: MemoryMaintenanceStateRecord,
    lastRun: MemoryMaintenanceRunRecord | undefined,
    now: Date,
  ): DueEvaluation {
    if (policy.runMode === "manual" || !policy.schedule) {
      return {
        nextDueAt: undefined,
        dueBySchedule: false,
        thresholdsMet: this.thresholdsMet(policy, state, now),
      };
    }
    const mostRecentScheduledAt = findScheduledMinute(now, policy.schedule, policy.timeZone, "backward");
    const nextScheduledAt = findScheduledMinute(now, policy.schedule, policy.timeZone, "forward");
    const lastAttemptAt = lastRun?.createdAt ? Date.parse(lastRun.createdAt) : Number.NaN;
    const mostRecentScheduledMs = mostRecentScheduledAt ? Date.parse(mostRecentScheduledAt) : Number.NaN;
    const dueBySchedule = Boolean(
      mostRecentScheduledAt &&
      Number.isFinite(mostRecentScheduledMs) &&
      mostRecentScheduledMs <= now.getTime() &&
      (!Number.isFinite(lastAttemptAt) || lastAttemptAt < mostRecentScheduledMs),
    );
    return {
      nextDueAt: dueBySchedule ? mostRecentScheduledAt : nextScheduledAt,
      dueBySchedule,
      thresholdsMet: this.thresholdsMet(policy, state, now),
    };
  }

  private thresholdsMet(
    policy: MemoryMaintenancePolicyRecord,
    state: MemoryMaintenanceStateRecord,
    now: Date,
  ): boolean {
    if (state.changedSessionCount < Math.max(1, policy.minChangedSessions)) {
      return false;
    }
    if (!state.lastSuccessfulRunAt) {
      return true;
    }
    const deltaMs = now.getTime() - Date.parse(state.lastSuccessfulRunAt);
    if (!Number.isFinite(deltaMs)) {
      return true;
    }
    return deltaMs >= policy.minHoursSinceLastSuccess * 60 * 60 * 1000;
  }

  private async evaluateWorkspace(
    workspaceId: string,
    source: "scheduler" | "post_turn",
    deferRealtime = false,
  ): Promise<MemoryMaintenancePostTurnEvaluationResult> {
    if (deferRealtime) {
      await this.ctx.storage.memoryMaintenance.lockStateForUpdate(this.defaultState(workspaceId));
    }
    const policy = await this.ensurePolicy(workspaceId);
    const state = await this.refreshState(workspaceId, { touchEligibility: true });
    await this.maybeCreateBacklogRecommendation(workspaceId, policy, state);
    await this.maybeCreateActivityWindowRecommendation(workspaceId, policy);

    if (!policy.enabled) {
      return { status: "evaluated", workspaceId, reason: "policy_disabled" };
    }
    const normalizedState = await this.syncWorkspaceActiveRun(state);
    if (normalizedState.activeRunId) {
      return { status: "evaluated", workspaceId, reason: "active_run" };
    }
    if (policy.runMode === "manual") {
      return { status: "evaluated", workspaceId, reason: "manual_mode" };
    }

    const lastRun = (await this.ctx.storage.memoryMaintenance.listRuns(workspaceId, 1))[0];
    const due = this.evaluateDue(policy, normalizedState, lastRun, new Date());
    if (!due.dueBySchedule || !due.thresholdsMet) {
      return { status: "evaluated", workspaceId, reason: "not_due" };
    }
    if (source === "post_turn" && policy.runMode !== "hybrid") {
      return { status: "evaluated", workspaceId, reason: "post_turn_not_hybrid" };
    }
    const triggerSource = policy.runMode === "scheduled" ? "scheduled" : "hybrid_due";
    const run = await this.enqueueRun(workspaceId, policy, triggerSource, deferRealtime);
    return {
      status: "enqueued",
      workspaceId,
      memoryMaintenanceRunId: run.runId,
      ...(run.durableRunId ? { durableRunId: run.durableRunId } : {}),
    };
  }

  private async enqueueRun(
    workspaceId: string,
    policy: MemoryMaintenancePolicyRecord,
    triggerSource: MemoryMaintenanceRunRecord["triggerSource"],
    deferRealtime = false,
  ): Promise<MemoryMaintenanceRunRecord> {
    const state = await this.refreshState(workspaceId, { touchEligibility: false });
    if (state.activeRunId) {
      throw new Error(`Workspace ${workspaceId} already has an active memory maintenance run.`);
    }

    const now = new Date().toISOString();
    const modelSelection = this.resolveProviderAndModel(policy);
    const runId = `mmrun_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const durableRun = await this.callbacks.createDurableRun(
      {
        workflowKey: MEMORY_MAINTENANCE_WORKFLOW_KEY,
        payload: {
          version: MEMORY_MAINTENANCE_WORKFLOW_VERSION,
          workspaceId,
          memoryMaintenanceRunId: runId,
          triggerSource,
          requestedAt: now,
        } satisfies MemoryMaintenanceWorkflowPayload,
        metadata: {
          workspaceId,
          triggerSource,
        },
      },
      deferRealtime ? { deferRealtime: true } : undefined,
    );
    const record = await this.ctx.storage.memoryMaintenance.createRun({
      runId,
      durableRunId: durableRun.runId,
      workspaceId,
      triggerSource,
      status: "queued",
      providerId: modelSelection.providerId,
      model: modelSelection.model,
      policySnapshot: policyToRecord(policy),
      sourceSessionCount: 0,
      changedArtifactCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.ctx.storage.memoryMaintenance.upsertState({
      ...state,
      activeRunId: record.runId,
      updatedAt: now,
    });
    if (!deferRealtime) {
      await this.ctx.publishRealtime("system", "memory", {
        type: "memory_maintenance_run_created",
        workspaceId,
        runId: record.runId,
        durableRunId: durableRun.runId,
        triggerSource,
      });
    }
    return record;
  }

  private resolveProviderAndModel(policy: MemoryMaintenancePolicyRecord): {
    runtime: LlmRuntimeConfig;
    providerId: string | undefined;
    model: string | undefined;
  } {
    const runtime = this.ctx.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const providerId = policy.providerId ?? runtime.activeProviderId;
    const provider = runtime.providers.find((item) => item.providerId === providerId);
    const model = policy.model ?? provider?.defaultModel ?? runtime.activeModel;
    return {
      runtime,
      providerId,
      model,
    };
  }

  private async checkExecutionAvailability(
    policy: MemoryMaintenancePolicyRecord,
    providerId: string | undefined,
    model: string | undefined,
  ): Promise<{ available: boolean; reason?: string }> {
    if (!providerId || !model) {
      return {
        available: false,
        reason: "No provider/model is configured for memory maintenance.",
      };
    }
    if (policy.executionTarget !== "local") {
      return { available: true };
    }
    const runtime = this.ctx.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    const provider = runtime.providers.find((item) => item.providerId === providerId);
    if (!provider || !isProviderLikelyLocal(provider.baseUrl)) {
      return {
        available: false,
        reason: `Configured local execution target requires a local provider, but ${providerId} is not local.`,
      };
    }
    try {
      const models = await this.ctx.llmService.listModels(providerId);
      if (models.length > 0 && !models.some((item) => item.id === model)) {
        return {
          available: false,
          reason: `Configured local model ${providerId}/${model} is unavailable.`,
        };
      }
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error
            ? `Configured local model ${providerId}/${model} is unavailable: ${error.message}`
            : `Configured local model ${providerId}/${model} is unavailable.`,
      };
    }
    return { available: true };
  }

  private async collectSources(
    workspaceId: string,
    since: string | undefined,
    runId: string,
  ): Promise<MaintenanceSourceBundle> {
    const transcriptSessions = await this.listEligibleSessions(workspaceId, since, MAX_TRANSCRIPT_SOURCES);
    const transcriptSources: MemoryMaintenanceRunSourceRecord[] = [];
    const markdownSections: string[] = [];

    for (const session of transcriptSessions) {
      const transcript = await this.readTranscriptOrEmpty(session.sessionId);
      const excerpt = buildTranscriptExcerpt(transcript);
      transcriptSources.push({
        sourceId: randomUUID(),
        runId,
        sourceKind: "transcript",
        sourceRef: session.sessionId,
        modifiedAt: session.modifiedAt,
        excerpt,
        tokenEstimate: estimateTokens(excerpt),
        createdAt: new Date().toISOString(),
      });
      markdownSections.push(renderTranscriptSection(session.sessionId, session.modifiedAt, excerpt));
    }

    const memoryFileSources = await this.readWorkspaceMemoryFiles(workspaceId, runId);
    for (const fileSource of memoryFileSources) {
      markdownSections.push(renderMemoryFileSection(fileSource.sourceRef, fileSource.modifiedAt, fileSource.excerpt));
    }

    const maintenanceSources = await this.readExistingMaintenanceArtifacts(workspaceId, runId);
    for (const maintenanceSource of maintenanceSources) {
      markdownSections.push(
        renderExistingMaintenanceSection(
          maintenanceSource.sourceRef,
          maintenanceSource.modifiedAt,
          maintenanceSource.excerpt,
        ),
      );
    }

    const memoryItemSources = await this.readRelevantMemoryItems(workspaceId, runId);
    for (const memoryItem of memoryItemSources) {
      markdownSections.push(renderMemoryItemSection(memoryItem.sourceRef, memoryItem.modifiedAt, memoryItem.excerpt));
    }

    const artifactSources = await this.readRecentToolArtifacts(workspaceId, since, runId);
    for (const artifactSource of artifactSources) {
      markdownSections.push(
        renderToolArtifactSection(artifactSource.sourceRef, artifactSource.modifiedAt, artifactSource.excerpt),
      );
    }

    if (markdownSections.length === 0) {
      markdownSections.push(
        "## Signals\n\nNo eligible transcript, file, memory-item, or retained artifact sources were found for this workspace.",
      );
    }

    return {
      transcriptSources,
      fileSources: memoryFileSources,
      maintenanceSources,
      memoryItemSources,
      artifactSources,
      markdownSections,
    };
  }

  private async readWorkspaceMemoryFiles(
    workspaceId: string,
    runId: string,
  ): Promise<MemoryMaintenanceRunSourceRecord[]> {
    const workspaceRoot = this.getWorkspaceRootDir();
    const memoryRelativeDir = getWorkspaceMemoryRelativeDir(workspaceId);
    const maintenanceRelativeDir = getWorkspaceMaintenanceRelativeDir(workspaceId);
    const baseDir = path.resolve(workspaceRoot, ...memoryRelativeDir.split("/"));
    const maintenanceDir = path.resolve(workspaceRoot, ...maintenanceRelativeDir.split("/"));
    const files = await walkMemoryFiles(baseDir, {
      maxFiles: MAX_MEMORY_FILE_SOURCES,
      maintenanceDir,
    });

    return files.map((file) => ({
      sourceId: randomUUID(),
      runId,
      sourceKind: "file",
      sourceRef: `${memoryRelativeDir}/${file.relativePath}`,
      modifiedAt: file.modifiedAt,
      excerpt: file.excerpt,
      tokenEstimate: file.tokenEstimate,
      createdAt: new Date().toISOString(),
    }));
  }

  private async readRelevantMemoryItems(
    workspaceId: string,
    runId: string,
  ): Promise<MemoryMaintenanceRunSourceRecord[]> {
    const items = (
      await (
        await this.ctx.storage.memoryMaintenance.listActiveMemoryItems(200, workspaceId)
      ).filter((item) => this.memoryItemMatchesWorkspace(item, workspaceId))
    ).slice(0, MAX_MEMORY_ITEM_SOURCES);

    return items.map((item) => {
      const excerpt = truncateText(`${item.title}\n${item.content}`, MAX_EXCERPT_CHARS);
      return {
        sourceId: randomUUID(),
        runId,
        sourceKind: "memory_item",
        sourceRef: item.itemId,
        modifiedAt: item.updatedAt,
        excerpt,
        tokenEstimate: estimateTokens(excerpt),
        createdAt: new Date().toISOString(),
      } satisfies MemoryMaintenanceRunSourceRecord;
    });
  }

  private async readExistingMaintenanceArtifacts(
    workspaceId: string,
    runId: string,
  ): Promise<MemoryMaintenanceRunSourceRecord[]> {
    const workspaceRoot = this.getWorkspaceRootDir();
    const maintenanceRelativeDir = getWorkspaceMaintenanceRelativeDir(workspaceId);
    const latestPath = `${maintenanceRelativeDir}/latest.md`;
    const latestAbs = path.resolve(workspaceRoot, ...latestPath.split("/"));
    if (!(await fileExists(latestAbs))) {
      return [];
    }
    try {
      const [stat, content] = await Promise.all([fs.stat(latestAbs), fs.readFile(latestAbs, "utf8")]);
      const excerpt = truncateText(content, Math.min(MAX_FILE_BYTES, MAX_EXCERPT_CHARS));
      return [
        {
          sourceId: randomUUID(),
          runId,
          sourceKind: "file",
          sourceRef: latestPath,
          modifiedAt: stat.mtime.toISOString(),
          excerpt,
          tokenEstimate: estimateTokens(excerpt),
          createdAt: new Date().toISOString(),
        },
      ];
    } catch {
      return [];
    }
  }

  private async readRecentToolArtifacts(
    workspaceId: string,
    since: string | undefined,
    runId: string,
  ): Promise<MemoryMaintenanceRunSourceRecord[]> {
    return await (
      await this.ctx.storage.memoryMaintenance.listRecentToolArtifacts(workspaceId, since, MAX_TOOL_ARTIFACT_SOURCES)
    ).map((artifact) => {
      const header = `${artifact.toolName} (${artifact.sessionId}, ${artifact.byteLength} bytes${artifact.contentType ? `, ${artifact.contentType}` : ""})`;
      const excerpt = truncateText(
        `${header}\n${artifact.snippet ?? "Artifact retained without inline snippet."}`,
        MAX_EXCERPT_CHARS,
      );
      return {
        sourceId: randomUUID(),
        runId,
        sourceKind: "artifact",
        sourceRef: artifact.artifactId,
        modifiedAt: artifact.createdAt,
        excerpt,
        tokenEstimate: estimateTokens(excerpt),
        createdAt: new Date().toISOString(),
      } satisfies MemoryMaintenanceRunSourceRecord;
    });
  }

  private memoryItemMatchesWorkspace(
    item: Pick<MemoryItemRecord, "metadata" | "workspaceId"> & { metadata: Record<string, unknown> },
    workspaceId: string,
  ): boolean {
    return matchesMemoryWorkspaceScope(item, workspaceId, this.normalizeWorkspaceId.bind(this));
  }

  private async generateConsolidatedArtifact(input: {
    workspaceId: string;
    runId: string;
    triggerSource: MemoryMaintenanceRunRecord["triggerSource"];
    policy: MemoryMaintenancePolicyRecord;
    providerId?: string;
    model?: string;
    sources: MaintenanceSourceBundle;
  }): Promise<{
    markdown: string;
    summary: string;
  }> {
    const response = await this.ctx.llmService.chatCompletions(
      {
        providerId: input.providerId,
        model: input.model,
        max_tokens: MAX_MAINTENANCE_OUTPUT_TOKENS,
        timeoutMs: 45_000,
        messages: [
          {
            role: "system",
            content: [
              "You are Dream, GoatCitadel's workspace memory maintenance agent.",
              "Use only the provided workspace evidence.",
              "Produce a concise markdown artifact for future retrieval and operator inspection.",
              "Do not copy raw transcripts verbatim unless a direct quote is necessary.",
              "Do not invent facts, decisions, file paths, or open issues.",
              "When evidence is thin or conflicting, say so explicitly.",
              "Return markdown only with these sections in order:",
              "# Workspace Memory",
              "## Stable Context",
              "## Active Threads",
              "## Watchlist",
              "## References",
              "In the References section, cite exact source refs from the provided catalog.",
            ].join("\n"),
          },
          {
            role: "user",
            content: buildMaintenanceConsolidationPrompt({
              workspaceId: input.workspaceId,
              runId: input.runId,
              triggerSource: input.triggerSource,
              policy: input.policy,
              sources: input.sources,
            }),
          },
        ],
        metadata: {
          surface: "memory_maintenance",
          workspaceId: input.workspaceId,
          runId: input.runId,
        },
      },
      createUtilityModelUsageAttribution({
        operationId: `memory-maintenance:${encodeURIComponent(input.runId)}:consolidate`,
        utilityKind: "memory_maintenance_consolidation",
        requestedProviderId: input.providerId,
        requestedModelId: input.model,
        lineage: {
          workspaceId: input.workspaceId,
          taskId: input.runId,
          agentId: "memory-maintenance",
        },
      }),
    );

    const markdown = normalizeGeneratedMaintenanceMarkdown(
      extractCompletionText(response),
      buildFallbackMaintenanceMarkdown(input.workspaceId, input.sources),
    );
    return {
      markdown,
      summary: summarizeMaintenanceMarkdown(markdown),
    };
  }

  private async writeMaintenanceArtifacts(input: {
    workspaceId: string;
    runId: string;
    triggerSource: MemoryMaintenanceRunRecord["triggerSource"];
    policy: MemoryMaintenancePolicyRecord;
    consolidatedMarkdown: string;
    generatedSummary: string;
  }): Promise<{
    summary: string;
    latestPath: string;
    snapshotPath: string;
    changes: Array<{
      changeId: string;
      runId: string;
      changeKind: "created" | "updated";
      targetKind: "file";
      targetRef: string;
      beforeRef?: string;
      afterRef?: string;
      summary: string;
      createdAt: string;
    }>;
  }> {
    const now = new Date();
    const createdAt = now.toISOString();
    const workspaceRoot = this.getWorkspaceRootDir();
    const maintenanceRelativeDir = getWorkspaceMaintenanceRelativeDir(input.workspaceId);
    const maintenanceDir = path.resolve(workspaceRoot, ...maintenanceRelativeDir.split("/"));
    await fs.mkdir(maintenanceDir, { recursive: true });

    const snapshotPath = `${maintenanceRelativeDir}/${formatTimestampForFile(createdAt)}-${input.runId.slice(-8)}.md`;
    const latestPath = `${maintenanceRelativeDir}/latest.md`;
    const snapshotAbs = path.resolve(workspaceRoot, ...snapshotPath.split("/"));
    const latestAbs = path.resolve(workspaceRoot, ...latestPath.split("/"));
    const previousSnapshotPath = await findPreviousSnapshotPath(maintenanceDir, maintenanceRelativeDir);
    const latestExists = await fileExists(latestAbs);

    const markdown = renderMaintenanceSnapshot({
      workspaceId: input.workspaceId,
      runId: input.runId,
      triggerSource: input.triggerSource,
      createdAt,
      policy: input.policy,
      consolidatedMarkdown: input.consolidatedMarkdown,
    });

    await fs.writeFile(snapshotAbs, markdown, "utf8");
    await fs.writeFile(latestAbs, markdown, "utf8");

    const changes = [
      {
        changeId: randomUUID(),
        runId: input.runId,
        changeKind: "created" as const,
        targetKind: "file" as const,
        targetRef: snapshotPath,
        afterRef: snapshotPath,
        summary: "Created an immutable maintenance snapshot artifact.",
        createdAt,
      },
      {
        changeId: randomUUID(),
        runId: input.runId,
        changeKind: latestExists ? ("updated" as const) : ("created" as const),
        targetKind: "file" as const,
        targetRef: latestPath,
        beforeRef: latestExists ? (previousSnapshotPath ?? latestPath) : undefined,
        afterRef: snapshotPath,
        summary: latestExists
          ? "Updated the workspace maintenance latest snapshot."
          : "Created the workspace maintenance latest snapshot.",
        createdAt,
      },
    ];

    return {
      summary: input.generatedSummary,
      latestPath,
      snapshotPath,
      changes,
    };
  }

  private async maybeCreateBacklogRecommendation(
    workspaceId: string,
    policy: MemoryMaintenancePolicyRecord,
    state: MemoryMaintenanceStateRecord,
  ): Promise<void> {
    if (policy.minChangedSessions <= 1) {
      return;
    }
    if (state.changedSessionCount < Math.max(policy.minChangedSessions * 2, 6)) {
      return;
    }
    const proposedThreshold = Math.max(1, Math.floor(policy.minChangedSessions / 2));
    if (proposedThreshold >= policy.minChangedSessions) {
      return;
    }
    await this.maybeCreateRecommendation(workspaceId, {
      kind: "threshold_adjustment",
      summary: `Workspace backlog is consistently above the current Dream threshold (${state.changedSessionCount} changed sessions waiting).`,
      rationale: `Lowering the minimum changed-session threshold to ${proposedThreshold} will make maintenance eligible sooner when backlog density grows.`,
      proposedPatch: {
        minChangedSessions: proposedThreshold,
      },
    });
  }

  private async maybeCreateActivityWindowRecommendation(
    workspaceId: string,
    policy: MemoryMaintenancePolicyRecord,
  ): Promise<void> {
    if (!policy.schedule || policy.runMode === "manual") {
      return;
    }
    const sessions = await this.listEligibleSessions(workspaceId, undefined, 20);
    if (sessions.length < 4) {
      return;
    }
    const counts = new Map<number, number>();
    for (const session of sessions) {
      const hour = getZonedParts(new Date(session.modifiedAt), policy.timeZone).hour;
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    const preferredHour = Array.from(counts.entries()).sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0]?.[0];
    if (preferredHour === undefined) {
      return;
    }
    if (Math.abs(preferredHour - policy.schedule.hour) < 4) {
      return;
    }
    await this.maybeCreateRecommendation(workspaceId, {
      kind: "schedule_adjustment",
      summary: `Recent workspace activity clusters around ${preferredHour}:00 ${policy.timeZone}, away from the current Dream schedule.`,
      rationale:
        "Recent transcript activity suggests that a different scheduled hour may be a better fit for maintenance windows.",
      proposedPatch: {
        schedule: {
          ...policy.schedule,
          hour: preferredHour,
        },
      },
    });
  }

  private async maybeCreateUnavailableModelRecommendation(
    workspaceId: string,
    policy: MemoryMaintenancePolicyRecord,
    reason: string,
  ): Promise<void> {
    const proposedPatch =
      policy.executionTarget === "local" ? { executionTarget: "cloud" } : { unavailableModelPolicy: "error" };
    await this.maybeCreateRecommendation(workspaceId, {
      kind: policy.executionTarget === "local" ? "execution_target_adjustment" : "model_adjustment",
      summary: reason,
      rationale: "The configured local model or provider was unavailable for maintenance execution.",
      proposedPatch,
    });
  }

  private async maybeCreateRecommendation(
    workspaceId: string,
    input: {
      kind: MemoryMaintenanceRecommendationKind;
      summary: string;
      rationale?: string;
      proposedPatch: Record<string, unknown>;
    },
  ): Promise<MemoryMaintenanceRecommendationRecord | undefined> {
    const existing = await this.ctx.storage.memoryMaintenance.listRecommendations(workspaceId, 25);
    if (
      shouldSuppressMaintenanceRecommendation({
        existing,
        kind: input.kind,
        proposedPatch: input.proposedPatch,
        dedupeWindowMs: MEMORY_RECOMMENDATION_DEDUP_WINDOW_MS,
      })
    ) {
      return undefined;
    }
    const now = new Date().toISOString();
    const created = await this.ctx.storage.memoryMaintenance.createRecommendation({
      workspaceId,
      kind: input.kind,
      status: "queued",
      summary: input.summary,
      proposedPatch: input.proposedPatch,
      rationale: input.rationale,
      createdAt: now,
      updatedAt: now,
    });
    await this.ctx.storage.memoryMaintenance.upsertState({
      ...(await this.ensureState(workspaceId)),
      lastRecommendationAt: now,
      updatedAt: now,
    });
    return created;
  }

  private async finalizeRunStatus(
    runId: string,
    workspaceId: string,
    input: {
      status: MemoryMaintenanceRunRecord["status"];
      summary?: string;
      error?: string;
      sourceSessionCount: number;
      changedArtifactCount: number;
    },
  ): Promise<MemoryMaintenanceRunRecord> {
    const current = await this.ctx.storage.memoryMaintenance.getRun(runId);
    const now = new Date().toISOString();
    const updated = await this.ctx.storage.memoryMaintenance.updateRun({
      ...current,
      status: input.status,
      summary: input.summary ?? current.summary,
      error: input.error ?? current.error,
      sourceSessionCount: input.sourceSessionCount,
      changedArtifactCount: input.changedArtifactCount,
      finishedAt: input.status === "running" || input.status === "queued" ? current.finishedAt : now,
      updatedAt: now,
    });
    await this.ctx.storage.memoryMaintenance.upsertState({
      ...(await this.ensureState(workspaceId)),
      activeRunId: input.status === "running" || input.status === "queued" ? runId : undefined,
      updatedAt: now,
    });
    return updated;
  }

  private async finalizeRunFailure(runId: string, errorText: string): Promise<MemoryMaintenanceRunRecord> {
    const current = await this.ctx.storage.memoryMaintenance.getRun(runId);
    return await this.finalizeRunStatus(runId, current.workspaceId, {
      status: "failed",
      summary: current.summary ?? "Memory maintenance run failed.",
      error: errorText,
      sourceSessionCount: current.sourceSessionCount,
      changedArtifactCount: current.changedArtifactCount,
    });
  }

  private async finalizeRunFailureIfCurrent(
    memoryMaintenanceRunId: string,
    durableRunId: string,
    errorText: string,
  ): Promise<MemoryMaintenanceRunRecord | undefined> {
    const current = await this.ctx.storage.memoryMaintenance.getRun(memoryMaintenanceRunId);
    if (current.durableRunId !== durableRunId) {
      return undefined;
    }
    const state = await this.ctx.storage.memoryMaintenance.findState(current.workspaceId);
    if (state?.activeRunId !== memoryMaintenanceRunId) {
      return undefined;
    }
    try {
      const durableRun = await this.callbacks.getDurableRun(durableRunId);
      if (durableRun.status !== "queued" && durableRun.status !== "running") {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return await this.finalizeRunFailure(memoryMaintenanceRunId, errorText);
  }

  private async readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]> {
    try {
      return await this.ctx.storage.transcripts.read(sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private getWorkspaceRootDir(): string {
    return path.resolve(this.ctx.config.rootDir, this.ctx.config.assistant.workspaceDir);
  }
}

function throwIfMemoryMaintenanceAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Memory maintenance aborted.");
}

function isMemoryMaintenanceAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason === error) {
      return true;
    }
    if (reason instanceof Error && error instanceof Error) {
      return reason.message === error.message;
    }
  }
  return error instanceof Error && error.message === "Memory maintenance aborted.";
}

function getWorkspaceMemoryRelativeDir(workspaceId: string): string {
  return workspaceId === DEFAULT_MEMORY_WORKSPACE_ID ? "memory" : `workspaces/${workspaceId}/memory`;
}

function getWorkspaceMaintenanceRelativeDir(workspaceId: string): string {
  return workspaceId === DEFAULT_MEMORY_WORKSPACE_ID
    ? "memory/maintenance"
    : `workspaces/${workspaceId}/memory/maintenance`;
}

function isProviderLikelyLocal(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function estimateTokens(value: string): number {
  if (!value.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / 4));
}

function buildTranscriptExcerpt(events: TranscriptEvent[]): string {
  const lines = events
    .filter((event) => event.type === "message.user" || event.type === "message.assistant")
    .slice(-8)
    .map((event) => {
      const role = event.type === "message.user" ? "User" : "Assistant";
      const content = truncateText(getTranscriptMessageContent(event.payload), 220);
      return content ? `${role}: ${content}` : "";
    })
    .filter((line) => line.length > 0);
  return truncateText(lines.join("\n"), MAX_EXCERPT_CHARS);
}

function getTranscriptMessageContent(payload: Record<string, unknown>): string {
  const message = asRecord(payload.message);
  return typeof message?.content === "string" ? message.content : "";
}

function renderTranscriptSection(sessionId: string, modifiedAt: string, excerpt: string): string {
  return [
    `## Transcript ${sessionId}`,
    ``,
    `Last changed: ${modifiedAt}`,
    ``,
    excerpt || "No retained transcript excerpt.",
    ``,
  ].join("\n");
}

function renderMemoryFileSection(
  sourceRef: string,
  modifiedAt: string | undefined,
  excerpt: string | undefined,
): string {
  return [
    `## Memory File ${sourceRef}`,
    ``,
    `Last changed: ${modifiedAt ?? "unknown"}`,
    ``,
    excerpt || "No retained file excerpt.",
    ``,
  ].join("\n");
}

function renderMemoryItemSection(
  sourceRef: string,
  modifiedAt: string | undefined,
  excerpt: string | undefined,
): string {
  return [
    `## Memory Item ${sourceRef}`,
    ``,
    `Last changed: ${modifiedAt ?? "unknown"}`,
    ``,
    excerpt || "No retained memory-item excerpt.",
    ``,
  ].join("\n");
}

function renderToolArtifactSection(
  sourceRef: string,
  modifiedAt: string | undefined,
  excerpt: string | undefined,
): string {
  return [
    `## Retained Tool Artifact ${sourceRef}`,
    ``,
    `Last changed: ${modifiedAt ?? "unknown"}`,
    ``,
    excerpt || "No retained artifact excerpt.",
    ``,
  ].join("\n");
}

function renderExistingMaintenanceSection(
  sourceRef: string,
  modifiedAt: string | undefined,
  excerpt: string | undefined,
): string {
  return [
    `## Prior Maintenance Artifact ${sourceRef}`,
    ``,
    `Last changed: ${modifiedAt ?? "unknown"}`,
    ``,
    excerpt || "No retained maintenance excerpt.",
    ``,
  ].join("\n");
}

function renderMaintenanceSnapshot(input: {
  workspaceId: string;
  runId: string;
  triggerSource: MemoryMaintenanceRunRecord["triggerSource"];
  createdAt: string;
  policy: MemoryMaintenancePolicyRecord;
  consolidatedMarkdown: string;
}): string {
  return [
    `---`,
    `workspace: ${input.workspaceId}`,
    `runId: ${input.runId}`,
    `trigger: ${input.triggerSource}`,
    `generatedAt: ${input.createdAt}`,
    `policyMode: ${input.policy.runMode}`,
    `schedule: ${formatSchedule(input.policy)}`,
    `executionTarget: ${input.policy.executionTarget}`,
    `provider: ${input.policy.providerId ?? "(active provider)"}`,
    `model: ${input.policy.model ?? "(active model)"}`,
    `---`,
    ``,
    input.consolidatedMarkdown.trim(),
  ].join("\n");
}

function buildMaintenanceConsolidationPrompt(input: {
  workspaceId: string;
  runId: string;
  triggerSource: MemoryMaintenanceRunRecord["triggerSource"];
  policy: MemoryMaintenancePolicyRecord;
  sources: MaintenanceSourceBundle;
}): string {
  const allSources = [
    ...input.sources.transcriptSources,
    ...input.sources.fileSources,
    ...input.sources.maintenanceSources,
    ...input.sources.memoryItemSources,
    ...input.sources.artifactSources,
  ];
  const sourceCatalog =
    allSources.length > 0
      ? allSources
          .map((source) => {
            const details = [
              source.sourceKind,
              source.sourceRef,
              source.modifiedAt ? `modified=${source.modifiedAt}` : undefined,
              source.tokenEstimate ? `tokens=${source.tokenEstimate}` : undefined,
            ].filter(Boolean);
            return `- ${details.join(" | ")}`;
          })
          .join("\n")
      : "- none";
  const evidence = selectMaintenanceEvidenceSections(input.sources.markdownSections);
  return [
    `Workspace: ${input.workspaceId}`,
    `Run ID: ${input.runId}`,
    `Trigger: ${input.triggerSource}`,
    `Policy mode: ${input.policy.runMode}`,
    `Schedule: ${formatSchedule(input.policy)}`,
    ``,
    `Source Catalog`,
    sourceCatalog,
    ``,
    `Evidence`,
    evidence,
    ``,
    `Focus on durable facts, active workstreams, unresolved items, and references worth keeping for future turns.`,
  ].join("\n");
}

function selectMaintenanceEvidenceSections(sections: string[]): string {
  if (sections.length === 0) {
    return "No evidence provided.";
  }
  const selected: string[] = [];
  let usedTokens = 0;
  for (const section of sections) {
    const sectionTokens = estimateTokens(section);
    if (selected.length > 0 && usedTokens + sectionTokens > MAX_MODEL_EVIDENCE_TOKENS) {
      selected.push(
        "## Evidence Truncated\n\nAdditional evidence was omitted from the prompt after reaching the maintenance prompt budget.",
      );
      break;
    }
    selected.push(section);
    usedTokens += sectionTokens;
  }
  return selected.join("\n");
}

function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const value = part as Record<string, unknown>;
        return typeof value.text === "string" ? value.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

function normalizeGeneratedMaintenanceMarkdown(generated: string, fallback: string): string {
  const trimmed = generated.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.startsWith("# Workspace Memory") ? trimmed : `# Workspace Memory\n\n${trimmed}`;
}

function buildFallbackMaintenanceMarkdown(workspaceId: string, sources: MaintenanceSourceBundle): string {
  const references = [
    ...sources.transcriptSources.map((source) => `- transcript: ${source.sourceRef}`),
    ...sources.fileSources.map((source) => `- file: ${source.sourceRef}`),
    ...sources.maintenanceSources.map((source) => `- prior-maintenance: ${source.sourceRef}`),
    ...sources.memoryItemSources.map((source) => `- memory-item: ${source.sourceRef}`),
    ...sources.artifactSources.map((source) => `- artifact: ${source.sourceRef}`),
  ];
  return [
    `# Workspace Memory`,
    ``,
    `## Stable Context`,
    `- Automatic consolidation fallback was used for workspace ${workspaceId} because the model returned no markdown output.`,
    ``,
    `## Active Threads`,
    `- Review the captured provenance for the latest Dream run to inspect the raw evidence set.`,
    ``,
    `## Watchlist`,
    `- Re-run memory maintenance if the provider continues returning empty output.`,
    ``,
    `## References`,
    references.length > 0 ? references.join("\n") : "- none",
  ].join("\n");
}

function summarizeMaintenanceMarkdown(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-"));
  const firstSentence = lines[0];
  if (!firstSentence) {
    return "Updated consolidated workspace memory artifact.";
  }
  return truncateText(firstSentence, 220);
}

function formatSchedule(policy: MemoryMaintenancePolicyRecord): string {
  if (!policy.schedule) {
    return "manual";
  }
  if (policy.schedule.frequency === "weekly") {
    return `weekly weekday=${policy.schedule.weekday ?? 0} ${String(policy.schedule.hour).padStart(2, "0")}:${String(policy.schedule.minute).padStart(2, "0")} ${policy.timeZone}`;
  }
  return `daily ${String(policy.schedule.hour).padStart(2, "0")}:${String(policy.schedule.minute).padStart(2, "0")} ${policy.timeZone}`;
}

function formatTimestampForFile(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

async function walkMemoryFiles(
  baseDir: string,
  options: {
    maxFiles: number;
    maintenanceDir: string;
  },
): Promise<MemoryFileSource[]> {
  if (!(await fileExists(baseDir))) {
    return [];
  }
  const queue = [baseDir];
  const files: MemoryFileSource[] = [];
  while (queue.length > 0 && files.length < options.maxFiles) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= options.maxFiles) {
        break;
      }
      const absolutePath = path.join(current, entry.name);
      if (absolutePath === options.maintenanceDir || absolutePath.startsWith(`${options.maintenanceDir}${path.sep}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(baseDir, absolutePath).split(path.sep).join("/");
      let content: string;
      let stat;
      try {
        stat = await fs.stat(absolutePath);
        content = await fs.readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      const excerpt = truncateText(content, Math.min(MAX_FILE_BYTES, MAX_EXCERPT_CHARS));
      files.push({
        relativePath,
        modifiedAt: stat.mtime.toISOString(),
        excerpt,
        tokenEstimate: estimateTokens(excerpt),
      });
    }
  }
  return files;
}

async function findPreviousSnapshotPath(
  maintenanceDir: string,
  maintenanceRelativeDir: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await fs.readdir(maintenanceDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates: Array<{ name: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "latest.md") {
      continue;
    }
    const absolutePath = path.join(maintenanceDir, entry.name);
    try {
      const stat = await fs.stat(absolutePath);
      candidates.push({
        name: entry.name,
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
  const previous = candidates[0];
  return previous ? `${maintenanceRelativeDir}/${previous.name}` : undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getZonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const weekdayRaw = read("weekday").toLowerCase();
  const weekday = weekdayRaw.startsWith("sun")
    ? 0
    : weekdayRaw.startsWith("mon")
      ? 1
      : weekdayRaw.startsWith("tue")
        ? 2
        : weekdayRaw.startsWith("wed")
          ? 3
          : weekdayRaw.startsWith("thu")
            ? 4
            : weekdayRaw.startsWith("fri")
              ? 5
              : 6;
  return {
    year: Number.parseInt(read("year"), 10),
    month: Number.parseInt(read("month"), 10),
    day: Number.parseInt(read("day"), 10),
    hour: Number.parseInt(read("hour"), 10),
    minute: Number.parseInt(read("minute"), 10),
    weekday,
  };
}

function matchesSchedule(
  date: Date,
  schedule: NonNullable<MemoryMaintenancePolicyRecord["schedule"]>,
  timeZone: string,
): boolean {
  const parts = getZonedParts(date, timeZone);
  if (parts.hour !== schedule.hour || parts.minute !== schedule.minute) {
    return false;
  }
  if (schedule.frequency === "weekly" && schedule.weekday !== undefined && parts.weekday !== schedule.weekday) {
    return false;
  }
  return true;
}

function findScheduledMinute(
  now: Date,
  schedule: NonNullable<MemoryMaintenancePolicyRecord["schedule"]>,
  timeZone: string,
  direction: "forward" | "backward",
): string | undefined {
  const stepMs = direction === "forward" ? 60_000 : -60_000;
  let cursor = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  if (direction === "forward") {
    cursor = new Date(cursor.getTime() + 60_000);
  }
  for (let index = 0; index < SCHEDULE_SCAN_WINDOW_MINUTES; index += 1) {
    if (matchesSchedule(cursor, schedule, timeZone)) {
      return cursor.toISOString();
    }
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function policyToRecord(policy: MemoryMaintenancePolicyRecord): Record<string, unknown> {
  return { ...policy };
}

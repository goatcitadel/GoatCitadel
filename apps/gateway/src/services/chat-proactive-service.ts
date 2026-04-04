import { randomUUID } from "node:crypto";
import {
  DEFAULT_SESSION_AUTONOMY_PREFS,
  type SessionAutonomyPrefsPatchInput,
  type SessionAutonomyPrefsRecord,
} from "@goatcitadel/storage";
import type {
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ProactiveActionRecord,
  ProactiveOriginSurface,
  ProactivePolicy,
  ProactiveReferenceRootRecord,
  ProactiveRunRecord,
  ProactiveRunStatus,
  ProactiveStopReason,
  ProactiveTriggerSource,
  SessionMeta,
  TaskRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";

// ── constants ────────────────────────────────────────────────────────
const PROACTIVE_SCHEDULER_INTERVAL_MS = 120_000;
const PROACTIVE_SCHEDULER_CONCURRENCY = 8;
const PROACTIVE_MIN_IDLE_SECONDS = 90;
const PROACTIVE_REFERENCE_ROOTS: ProactiveReferenceRootRecord[] = [
  {
    label: "claude-code-reference",
    rootPath: "F:\\code\\claude-code",
    access: "read_only",
  },
];
const PROACTIVE_SAFE_TOOL_ALLOWLIST = new Set([
  "time.now",
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
]);

// ── helper types ─────────────────────────────────────────────────────
type SessionAutonomyPrefs = SessionAutonomyPrefsRecord;

interface ProactiveTriggerInput {
  source?: ProactiveTriggerSource;
  reason?: string;
  prefs?: SessionAutonomyPrefs;
}

interface ProactivePlannedAction {
  kind: "tool" | "delegate" | "note";
  toolName?: string;
  args?: Record<string, unknown>;
  note?: string;
  objective?: string;
  roles?: string[];
}

/**
 * Callbacks needed from GatewayService that we avoid a circular reference for.
 */
export interface ChatProactiveServiceCallbacks {
  listChatSessions(query: {
    scope: "mission" | "external" | "all";
    view: "active" | "archived" | "all";
    limit: number;
  }): Array<{ sessionId: string; lastActivityAt: string }>;

  getSession(sessionId: string): SessionMeta;

  hasRunningTurn(sessionId: string): boolean;

  getSessionIdleSeconds(sessionId: string): number;

  listChatMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: string }>>;

  invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult>;

  detectDelegationRoles(text: string): string[];

  readonly backgroundTasks: Set<Promise<void>>;
  closing: boolean;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface ProactiveRunRow {
  run_id: string;
  session_id: string;
  linked_task_id: string | null;
  linked_durable_run_id: string | null;
  approval_id: string | null;
  status: ProactiveRunStatus;
  mode: ChatProactiveMode;
  trigger_source: ProactiveTriggerSource | null;
  origin_surface: ProactiveOriginSurface | null;
  confidence: number;
  reasoning_summary: string | null;
  suggested_actions_json: string;
  executed_actions_json: string;
  next_wake_at: string | null;
  stop_reason: ProactiveStopReason | null;
  external_reference_roots_json: string | null;
  resume_metadata_json: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

interface ProactiveActionRow {
  action_id: string;
  run_id: string;
  session_id: string;
  linked_task_id: string | null;
  linked_durable_run_id: string | null;
  approval_id: string | null;
  kind: ProactiveActionRecord["kind"];
  status: ProactiveActionRecord["status"];
  trigger_source: ProactiveTriggerSource | null;
  origin_surface: ProactiveOriginSurface | null;
  tool_name: string | null;
  args_json: string | null;
  result_json: string | null;
  error: string | null;
  external_reference_roots_json: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Encapsulates all proactive-mode scheduling, policy management, run
 * execution and action CRUD previously inlined in GatewayService.
 */
export class ChatProactiveService {
  private scheduler?: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly callbacks: ChatProactiveServiceCallbacks,
  ) {}

  // ── scheduler lifecycle ──────────────────────────────────────────

  startScheduler(): void {
    if (this.scheduler) {
      return;
    }
    this.scheduler = setInterval(() => {
      const task = this.runSchedulerTick().catch((error) => {
        console.error("[goatcitadel] proactive scheduler tick failed", error);
        this.ctx.publishRealtime("system", "chat", {
          type: "proactive_scheduler_error",
          message: (error as Error).message,
        });
      });
      this.callbacks.backgroundTasks.add(task);
      task.finally(() => this.callbacks.backgroundTasks.delete(task));
    }, PROACTIVE_SCHEDULER_INTERVAL_MS);
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = undefined;
    }
  }

  // ── scheduler tick ───────────────────────────────────────────────

  private async runSchedulerTick(): Promise<void> {
    if (this.callbacks.closing) {
      return;
    }
    const sessions = this.callbacks.listChatSessions({
      scope: "mission",
      view: "active",
      limit: 300,
    });
    const prefsBySessionId = this.ctx.storage.sessionAutonomyPrefs.listBySessionIds(
      sessions.map((session) => session.sessionId),
    );
    const eligible = sessions
      .map((session) => ({
        sessionId: session.sessionId,
        prefs: prefsBySessionId.get(session.sessionId) ?? {
          sessionId: session.sessionId,
          ...DEFAULT_SESSION_AUTONOMY_PREFS,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }))
      .filter((item) => item.prefs.proactiveMode !== "off");

    if (eligible.length === 0) {
      return;
    }

    const maxWorkers = Math.min(PROACTIVE_SCHEDULER_CONCURRENCY, eligible.length);
    let cursor = 0;
    const workers = Array.from({ length: maxWorkers }, async () => {
      while (cursor < eligible.length) {
        const index = cursor;
        cursor += 1;
        const current = eligible[index];
        if (!current) {
          continue;
        }
        try {
          await this.triggerChatSessionProactive(current.sessionId, {
            source: "scheduler",
            reason: "Background proactive scheduler tick.",
            prefs: current.prefs,
          });
        } catch (error) {
          console.error(
            "[goatcitadel] proactive scheduler session trigger failed",
            { sessionId: current.sessionId, error },
          );
          this.ctx.publishRealtime("system", "chat", {
            type: "proactive_scheduler_session_error",
            sessionId: current.sessionId,
            message: (error as Error).message,
          });
        }
      }
    });
    await Promise.all(workers);
  }

  // ── policy helpers ───────────────────────────────────────────────

  toProactivePolicy(sessionId: string, prefs: SessionAutonomyPrefs): ProactivePolicy {
    return {
      sessionId,
      mode: prefs.proactiveMode,
      autonomyBudget: {
        maxActionsPerHour: prefs.maxActionsPerHour,
        maxActionsPerTurn: prefs.maxActionsPerTurn,
        cooldownSeconds: prefs.cooldownSeconds,
      },
      retrievalMode: prefs.retrievalMode,
      reflectionMode: prefs.reflectionMode,
      updatedAt: prefs.updatedAt,
    };
  }

  private getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefs {
    return this.ctx.storage.sessionAutonomyPrefs.ensure(sessionId);
  }

  private getSessionOriginSurface(sessionId: string): ProactiveOriginSurface {
    const mode = this.ctx.storage.chatSessionPrefs.ensure(sessionId).mode;
    if (mode === "cowork" || mode === "code") {
      return mode;
    }
    return "chat";
  }

  private getSessionWorkspaceId(sessionId: string): string {
    return this.ctx.storage.chatSessionMeta.ensure(sessionId).workspaceId ?? "default";
  }

  private patchSessionAutonomyPrefs(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
  ): SessionAutonomyPrefs {
    return this.ctx.storage.sessionAutonomyPrefs.patch(sessionId, input);
  }

  private getProactiveCooldownRemainingSeconds(prefs: SessionAutonomyPrefs): number {
    if (!prefs.lastProactiveAt || prefs.cooldownSeconds <= 0) {
      return 0;
    }
    const elapsedSeconds = Math.floor((Date.now() - Date.parse(prefs.lastProactiveAt)) / 1000);
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds >= prefs.cooldownSeconds) {
      return 0;
    }
    return Math.max(0, prefs.cooldownSeconds - elapsedSeconds);
  }

  private countProactiveActionsLastHour(sessionId: string): number {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = this.ctx.gatewaySql.prepare(`
      SELECT COUNT(*) AS count
      FROM proactive_actions
      WHERE session_id = ? AND status = 'executed' AND created_at >= ?
    `).get(sessionId, cutoff) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  // ── planning ─────────────────────────────────────────────────────

  private async planProactiveActions(sessionId: string): Promise<{
    confidence: number;
    reasoningSummary: string;
    actions: ProactivePlannedAction[];
  }> {
    const messages = await this.callbacks.listChatMessages(sessionId, 60);
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    if (!latestUser) {
      return {
        confidence: 0.1,
        reasoningSummary: "No recent user prompt found.",
        actions: [],
      };
    }
    const text = latestUser.content.trim();
    if (!text) {
      return {
        confidence: 0.1,
        reasoningSummary: "Latest user prompt is empty.",
        actions: [],
      };
    }
    const actions: ProactivePlannedAction[] = [];
    const roles = this.callbacks.detectDelegationRoles(text);
    if (roles.length > 1 || /\b(prd|architecture|qa|ops|handoff|route this)\b/i.test(text)) {
      actions.push({
        kind: "delegate",
        objective: text,
        roles,
      });
    }

    if (/\b(weather|price|latest|news|current|today|time)\b/i.test(text)) {
      actions.push({
        kind: "tool",
        toolName: /\btime\b/i.test(text) ? "time.now" : "browser.search",
        args: /\btime\b/i.test(text) ? {} : { query: text, maxResults: 5 },
      });
    }

    if (actions.length === 0) {
      actions.push({
        kind: "note",
        note: "Consider running /delegate for structured multi-role output.",
      });
    }

    return {
      confidence: actions.some((action) => action.kind !== "note") ? 0.78 : 0.42,
      reasoningSummary: "Generated actions from latest user intent and route hints.",
      actions,
    };
  }

  private readProactiveRun(runId: string): ProactiveRunRecord {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_runs
      WHERE run_id = ?
    `).get(runId) as ProactiveRunRow | undefined;
    if (!row) {
      throw new Error(`Proactive run ${runId} not found.`);
    }
    return mapProactiveRunRow(row);
  }

  // ── run persistence ──────────────────────────────────────────────

  private insertProactiveRun(run: ProactiveRunRecord): void {
    this.ctx.gatewaySql.prepare(`
      INSERT INTO proactive_runs (
        run_id, session_id, status, mode, confidence, reasoning_summary, action_count,
        suggested_actions_json, executed_actions_json, linked_task_id, linked_durable_run_id, approval_id,
        trigger_source, origin_surface, next_wake_at, stop_reason, external_reference_roots_json,
        resume_metadata_json, error, started_at, finished_at
      ) VALUES (
        @runId, @sessionId, @status, @mode, @confidence, @reasoningSummary, @actionCount,
        @suggestedActionsJson, @executedActionsJson, @linkedTaskId, @linkedDurableRunId, @approvalId,
        @triggerSource, @originSurface, @nextWakeAt, @stopReason, @externalReferenceRootsJson,
        @resumeMetadataJson, @error, @startedAt, @finishedAt
      )
    `).run({
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      mode: run.mode,
      confidence: run.confidence,
      reasoningSummary: run.reasoningSummary,
      actionCount: run.suggestedActions.length,
      suggestedActionsJson: JSON.stringify(run.suggestedActions),
      executedActionsJson: JSON.stringify(run.executedActions),
      linkedTaskId: run.linkedTaskId ?? null,
      linkedDurableRunId: run.linkedDurableRunId ?? null,
      approvalId: run.approvalId ?? null,
      triggerSource: run.triggerSource ?? null,
      originSurface: run.originSurface ?? null,
      nextWakeAt: run.nextWakeAt ?? null,
      stopReason: run.stopReason ?? null,
      externalReferenceRootsJson: run.externalReferenceRoots ? JSON.stringify(run.externalReferenceRoots) : null,
      resumeMetadataJson: run.resumeMetadata ? JSON.stringify(run.resumeMetadata) : null,
      error: run.error ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    });
  }

  private patchProactiveRun(
    runId: string,
    patch: Partial<ProactiveRunRecord>,
    finish = false,
  ): ProactiveRunRecord {
    const current = this.readProactiveRun(runId);
    const next: ProactiveRunRecord = {
      ...current,
      ...patch,
      runId: current.runId,
      sessionId: current.sessionId,
      mode: patch.mode ?? current.mode,
      finishedAt: finish ? new Date().toISOString() : (patch.finishedAt ?? current.finishedAt),
    };
    this.ctx.gatewaySql.prepare(`
      UPDATE proactive_runs
      SET
        status = @status,
        confidence = @confidence,
        reasoning_summary = @reasoningSummary,
        action_count = @actionCount,
        suggested_actions_json = @suggestedActionsJson,
        executed_actions_json = @executedActionsJson,
        linked_task_id = @linkedTaskId,
        linked_durable_run_id = @linkedDurableRunId,
        approval_id = @approvalId,
        trigger_source = @triggerSource,
        origin_surface = @originSurface,
        next_wake_at = @nextWakeAt,
        stop_reason = @stopReason,
        external_reference_roots_json = @externalReferenceRootsJson,
        resume_metadata_json = @resumeMetadataJson,
        error = @error,
        finished_at = @finishedAt
      WHERE run_id = @runId
    `).run({
      runId: next.runId,
      status: next.status,
      confidence: next.confidence,
      reasoningSummary: next.reasoningSummary,
      actionCount: next.suggestedActions.length,
      suggestedActionsJson: JSON.stringify(next.suggestedActions),
      executedActionsJson: JSON.stringify(next.executedActions),
      linkedTaskId: next.linkedTaskId ?? null,
      linkedDurableRunId: next.linkedDurableRunId ?? null,
      approvalId: next.approvalId ?? null,
      triggerSource: next.triggerSource ?? null,
      originSurface: next.originSurface ?? null,
      nextWakeAt: next.nextWakeAt ?? null,
      stopReason: next.stopReason ?? null,
      externalReferenceRootsJson: next.externalReferenceRoots ? JSON.stringify(next.externalReferenceRoots) : null,
      resumeMetadataJson: next.resumeMetadata ? JSON.stringify(next.resumeMetadata) : null,
      error: next.error ?? null,
      finishedAt: next.finishedAt ?? null,
    });
    return this.readProactiveRun(runId);
  }

  private finishProactiveRun(
    runId: string,
    patch: Partial<ProactiveRunRecord>,
  ): ProactiveRunRecord {
    return this.patchProactiveRun(runId, patch, true);
  }

  // ── action persistence ───────────────────────────────────────────

  private insertProactiveAction(action: ProactiveActionRecord): void {
    this.ctx.gatewaySql.prepare(`
      INSERT INTO proactive_actions (
        action_id, run_id, session_id, kind, status, tool_name, args_json, result_json,
        linked_task_id, linked_durable_run_id, approval_id, trigger_source, origin_surface,
        external_reference_roots_json, error, created_at, updated_at
      ) VALUES (
        @actionId, @runId, @sessionId, @kind, @status, @toolName, @argsJson, @resultJson,
        @linkedTaskId, @linkedDurableRunId, @approvalId, @triggerSource, @originSurface,
        @externalReferenceRootsJson, @error, @createdAt, @updatedAt
      )
    `).run({
      actionId: action.actionId,
      runId: action.runId,
      sessionId: action.sessionId,
      kind: action.kind,
      status: action.status,
      toolName: action.toolName ?? null,
      argsJson: action.args ? JSON.stringify(action.args) : null,
      resultJson: action.result ? JSON.stringify(action.result) : null,
      linkedTaskId: action.linkedTaskId ?? null,
      linkedDurableRunId: action.linkedDurableRunId ?? null,
      approvalId: action.approvalId ?? null,
      triggerSource: action.triggerSource ?? null,
      originSurface: action.originSurface ?? null,
      externalReferenceRootsJson: action.externalReferenceRoots ? JSON.stringify(action.externalReferenceRoots) : null,
      error: action.error ?? null,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt ?? action.createdAt,
    });
  }

  private updateProactiveAction(
    actionId: string,
    patch: Partial<ProactiveActionRecord>,
  ): ProactiveActionRecord {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_actions
      WHERE action_id = ?
    `).get(actionId) as ProactiveActionRow | undefined;
    if (!row) {
      throw new Error(`Proactive action ${actionId} not found.`);
    }
    const updatedAt = new Date().toISOString();
    const next: ProactiveActionRecord = {
      actionId: row.action_id,
      runId: row.run_id,
      sessionId: row.session_id,
      linkedTaskId: patch.linkedTaskId ?? row.linked_task_id ?? undefined,
      linkedDurableRunId: patch.linkedDurableRunId ?? row.linked_durable_run_id ?? undefined,
      approvalId: patch.approvalId ?? row.approval_id ?? undefined,
      kind: row.kind,
      status: patch.status ?? row.status,
      triggerSource: patch.triggerSource ?? row.trigger_source ?? undefined,
      originSurface: patch.originSurface ?? row.origin_surface ?? undefined,
      toolName: row.tool_name ?? undefined,
      args: row.args_json ? safeJsonParse<Record<string, unknown>>(row.args_json, {}) : undefined,
      result: patch.result ?? (row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined),
      error: patch.error ?? row.error ?? undefined,
      externalReferenceRoots: patch.externalReferenceRoots
        ?? (row.external_reference_roots_json
          ? safeJsonParse<ProactiveReferenceRootRecord[]>(row.external_reference_roots_json, [])
          : undefined),
      createdAt: row.created_at,
      updatedAt,
    };
    this.ctx.gatewaySql.prepare(`
      UPDATE proactive_actions
      SET
        status = @status,
        result_json = @resultJson,
        linked_task_id = @linkedTaskId,
        linked_durable_run_id = @linkedDurableRunId,
        approval_id = @approvalId,
        trigger_source = @triggerSource,
        origin_surface = @originSurface,
        external_reference_roots_json = @externalReferenceRootsJson,
        error = @error,
        updated_at = @updatedAt
      WHERE action_id = @actionId
    `).run({
      actionId: next.actionId,
      status: next.status,
      resultJson: next.result ? JSON.stringify(next.result) : null,
      linkedTaskId: next.linkedTaskId ?? null,
      linkedDurableRunId: next.linkedDurableRunId ?? null,
      approvalId: next.approvalId ?? null,
      triggerSource: next.triggerSource ?? null,
      originSurface: next.originSurface ?? null,
      externalReferenceRootsJson: next.externalReferenceRoots ? JSON.stringify(next.externalReferenceRoots) : null,
      error: next.error ?? null,
      updatedAt,
    });
    return next;
  }

  private findReusableTask(sessionId: string): TaskRecord | undefined {
    const latestRun = this.listChatSessionProactiveRuns(sessionId, 20)
      .find((item) => item.linkedTaskId);
    if (!latestRun?.linkedTaskId) {
      return undefined;
    }
    const task = this.ctx.storage.tasks.find(latestRun.linkedTaskId);
    if (!task || task.status === "done") {
      return undefined;
    }
    return task;
  }

  private ensureLinkedTask(input: {
    sessionId: string;
    runId: string;
    originSurface: ProactiveOriginSurface;
    reasoningSummary: string;
  }): TaskRecord {
    const existing = this.findReusableTask(input.sessionId);
    if (existing) {
      const updated = this.ctx.storage.tasks.update(existing.taskId, {
        status: existing.status === "blocked" ? "in_progress" : existing.status,
        proactiveContext: {
          ...(existing.proactiveContext ?? {}),
          sessionId: input.sessionId,
          originSurface: input.originSurface,
          proactiveRunId: input.runId,
        },
      });
      this.ctx.publishRealtime("task_updated", "tasks", { task: updated });
      return updated;
    }

    const latestUser = this.ctx.storage.chatMessages
      .list(input.sessionId, 40)
      .slice()
      .reverse()
      .find((message) => message.role === "user");
    const titleSeed = latestUser?.content?.trim() || input.reasoningSummary || "Continue proactive work";
    const title = titleSeed.length > 96 ? `${titleSeed.slice(0, 93).trimEnd()}...` : titleSeed;
    const created = this.ctx.storage.tasks.create({
      workspaceId: this.getSessionWorkspaceId(input.sessionId),
      title,
      description: "Operator-visible task created for proactive orchestration follow-up.",
      status: "in_progress",
      priority: input.originSurface === "chat" ? "normal" : "high",
      createdBy: "system-proactive",
      proactiveContext: {
        sessionId: input.sessionId,
        originSurface: input.originSurface,
        proactiveRunId: input.runId,
      },
    });
    this.ctx.publishRealtime("task_created", "tasks", { task: created });
    return created;
  }

  private syncTaskForRun(taskId: string, patch: {
    sessionId: string;
    originSurface: ProactiveOriginSurface;
    proactiveRunId: string;
    durableRunId?: string;
    approvalId?: string;
    nextWakeAt?: string;
    stopReason?: ProactiveStopReason;
    externalReferenceRoots?: ProactiveReferenceRootRecord[];
    status?: TaskRecord["status"];
  }): TaskRecord {
    const updated = this.ctx.storage.tasks.update(taskId, {
      ...(patch.status ? { status: patch.status } : {}),
      proactiveContext: {
        ...(this.ctx.storage.tasks.get(taskId).proactiveContext ?? {}),
        sessionId: patch.sessionId,
        originSurface: patch.originSurface,
        proactiveRunId: patch.proactiveRunId,
        durableRunId: patch.durableRunId,
        approvalId: patch.approvalId,
        nextWakeAt: patch.nextWakeAt,
        stopReason: patch.stopReason,
        externalReferenceRoots: patch.externalReferenceRoots,
      },
    });
    this.ctx.publishRealtime("task_updated", "tasks", { task: updated });
    return updated;
  }

  private detectExternalReferenceRoots(...sources: Array<Record<string, unknown> | undefined>): ProactiveReferenceRootRecord[] | undefined {
    const matched = PROACTIVE_REFERENCE_ROOTS.filter((root) =>
      sources.some((source) => source && objectContainsPathPrefix(source, root.rootPath)),
    );
    return matched.length > 0 ? matched : undefined;
  }

  private resolveProactiveAction(
    action: ProactiveActionRecord,
    mode: ChatProactiveMode,
    remainingHourBudget: number,
    remainingTurnBudget: number,
  ): { execute: boolean; reason?: string } {
    if (remainingHourBudget <= 0) {
      return { execute: false, reason: "Autonomy hour budget exhausted." };
    }
    if (remainingTurnBudget <= 0) {
      return { execute: false, reason: "Autonomy turn budget exhausted." };
    }
    if (action.kind !== "tool" || !action.toolName) {
      return { execute: false, reason: "Only tool actions are eligible for automatic execution." };
    }
    if (mode === "auto_full") {
      return { execute: true };
    }
    if (!PROACTIVE_SAFE_TOOL_ALLOWLIST.has(action.toolName)) {
      return { execute: false, reason: `Tool ${action.toolName} is not allowlisted for auto_safe mode.` };
    }
    return { execute: true };
  }

  private async executeProactiveToolAction(action: ProactiveActionRecord): Promise<ProactiveActionRecord> {
    if (!action.toolName) {
      return this.updateProactiveAction(action.actionId, {
        status: "blocked",
        error: "Missing tool name.",
      });
    }
    try {
      const result = await this.callbacks.invokeTool({
        toolName: action.toolName,
        args: action.args ?? {},
        agentId: "proactive",
        sessionId: action.sessionId,
        taskId: action.linkedTaskId,
        consentContext: {
          source: "agent",
          reason: "proactive auto_safe execution",
        },
      });
      const externalReferenceRoots = this.detectExternalReferenceRoots(action.args, result.result);
      if (result.outcome === "executed") {
        return this.updateProactiveAction(action.actionId, {
          status: "executed",
          result: result.result ?? {},
          externalReferenceRoots,
        });
      }
      if (result.outcome === "approval_required") {
        let approval = result.approvalId ? this.ctx.storage.approvals.get(result.approvalId) : undefined;
        if (approval?.approvalId) {
          approval = this.ctx.storage.approvals.mergeLinkage(approval.approvalId, {
            sessionId: action.sessionId,
            taskId: action.linkedTaskId,
            proactiveRunId: action.runId,
            originSurface: action.originSurface,
            externalReferenceRoots,
          });
        }
        return this.updateProactiveAction(action.actionId, {
          status: "blocked",
          approvalId: result.approvalId,
          linkedDurableRunId: approval?.linkage?.durableRunId,
          error: "Approval required by policy.",
          result: {
            approvalId: result.approvalId,
            policyReason: result.policyReason,
          },
          externalReferenceRoots,
        });
      }
      return this.updateProactiveAction(action.actionId, {
        status: "blocked",
        error: result.policyReason,
        externalReferenceRoots,
      });
    } catch (error) {
      return this.updateProactiveAction(action.actionId, {
        status: "failed",
        error: (error as Error).message,
      });
    }
  }

  private touchSessionProactiveTick(sessionId: string, runId: string): void {
    this.ctx.storage.sessionAutonomyPrefs.touch(sessionId, runId);
  }

  // ── public methods ───────────────────────────────────────────────

  getChatSessionProactiveStatus(sessionId: string): {
    policy: ProactivePolicy;
    idleSeconds: number;
    hasRunningTurn: boolean;
    pendingSuggestions: number;
    actionsLastHour: number;
    lastRun?: ProactiveRunRecord;
  } {
    this.callbacks.getSession(sessionId);
    const policy = this.toProactivePolicy(sessionId, this.getSessionAutonomyPrefs(sessionId));
    const idleSeconds = this.callbacks.getSessionIdleSeconds(sessionId);
    const hasRunningTurn = this.callbacks.hasRunningTurn(sessionId);
    const pendingSuggestions = this.ctx.gatewaySql.prepare(
      "SELECT COUNT(*) AS count FROM proactive_actions WHERE session_id = ? AND status = 'suggested'",
    ).get(sessionId) as { count?: number } | undefined;
    const actionsLastHour = this.countProactiveActionsLastHour(sessionId);
    const lastRun = this.listChatSessionProactiveRuns(sessionId, 1)[0];
    return {
      policy,
      idleSeconds,
      hasRunningTurn,
      pendingSuggestions: Number(pendingSuggestions?.count ?? 0),
      actionsLastHour,
      lastRun,
    };
  }

  updateChatSessionProactivePolicy(
    sessionId: string,
    input: Partial<{
      proactiveMode: ChatProactiveMode;
      autonomyBudget: {
        maxActionsPerHour?: number;
        maxActionsPerTurn?: number;
        cooldownSeconds?: number;
      };
      retrievalMode: ChatRetrievalMode;
      reflectionMode: ChatReflectionMode;
    }>,
  ): ProactivePolicy {
    this.callbacks.getSession(sessionId);
    const next = this.patchSessionAutonomyPrefs(sessionId, {
      proactiveMode: input.proactiveMode,
      maxActionsPerHour: input.autonomyBudget?.maxActionsPerHour,
      maxActionsPerTurn: input.autonomyBudget?.maxActionsPerTurn,
      cooldownSeconds: input.autonomyBudget?.cooldownSeconds,
      retrievalMode: input.retrievalMode,
      reflectionMode: input.reflectionMode,
    });
    const policy = this.toProactivePolicy(sessionId, next);
    this.ctx.publishRealtime("system", "chat", {
      type: "proactive_policy_updated",
      sessionId,
      policy,
    });
    return policy;
  }

  async triggerChatSessionProactive(
    sessionId: string,
    input: ProactiveTriggerInput = {},
  ): Promise<ProactiveRunRecord> {
    this.callbacks.getSession(sessionId);
    const prefs = input.prefs ?? this.getSessionAutonomyPrefs(sessionId);
    const source = input.source ?? "manual";
    const originSurface = this.getSessionOriginSurface(sessionId);
    const now = new Date().toISOString();
    const runId = randomUUID();
    const initialRun: ProactiveRunRecord = {
      runId,
      sessionId,
      status: "running",
      mode: prefs.proactiveMode,
      triggerSource: source,
      originSurface,
      confidence: 0,
      reasoningSummary: input.reason ?? `proactive tick (${source})`,
      suggestedActions: [],
      executedActions: [],
      startedAt: now,
    };
    this.insertProactiveRun(initialRun);
    this.ctx.publishRealtime("proactive_tick_started", "chat", {
      sessionId,
      runId,
      mode: prefs.proactiveMode,
      source,
    });

    if (prefs.proactiveMode === "off") {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0,
        reasoningSummary: "Proactive mode is off.",
        stopReason: "no_action",
      });
    }

    if (this.callbacks.hasRunningTurn(sessionId)) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.2,
        reasoningSummary: "Skipped because a chat turn is still running.",
        stopReason: "no_action",
      });
    }

    const idleSeconds = this.callbacks.getSessionIdleSeconds(sessionId);
    if (idleSeconds < PROACTIVE_MIN_IDLE_SECONDS) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.2,
        reasoningSummary: `Skipped because session idle time (${idleSeconds}s) is below ${PROACTIVE_MIN_IDLE_SECONDS}s.`,
        stopReason: "no_action",
      });
    }

    const cooldownRemaining = this.getProactiveCooldownRemainingSeconds(prefs);
    if (cooldownRemaining > 0) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.25,
        reasoningSummary: `Skipped because cooldown is active (${cooldownRemaining}s remaining).`,
        stopReason: "cooldown",
        nextWakeAt: new Date(Date.now() + cooldownRemaining * 1000).toISOString(),
      });
    }

    const plan = await this.planProactiveActions(sessionId);
    if (plan.actions.length === 0) {
      const completed = this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: plan.confidence,
        reasoningSummary: plan.reasoningSummary,
        stopReason: "no_action",
      });
      this.ctx.publishRealtime("proactive_no_action", "chat", {
        sessionId,
        runId,
        reason: completed.reasoningSummary,
      });
      this.touchSessionProactiveTick(sessionId, runId);
      return completed;
    }

    const linkedTask = this.ensureLinkedTask({
      sessionId,
      runId,
      originSurface,
      reasoningSummary: plan.reasoningSummary,
    });
    this.patchProactiveRun(runId, {
      linkedTaskId: linkedTask.taskId,
      originSurface,
      triggerSource: source,
    });

    const suggestedActions: ProactiveActionRecord[] = [];
    const executedActions: ProactiveActionRecord[] = [];
    for (const action of plan.actions) {
      const actionId = randomUUID();
      const base: ProactiveActionRecord = {
        actionId,
        runId,
        sessionId,
        linkedTaskId: linkedTask.taskId,
        kind: action.kind,
        status: "suggested",
        triggerSource: source,
        originSurface,
        toolName: action.toolName,
        args: action.args,
        result: action.note
          ? { note: action.note }
          : action.objective
            ? { objective: action.objective, roles: action.roles }
            : undefined,
        createdAt: new Date().toISOString(),
      };
      suggestedActions.push(base);
      this.insertProactiveAction(base);
    }

    if (prefs.proactiveMode === "suggest") {
      const completed = this.finishProactiveRun(runId, {
        status: "suggested",
        linkedTaskId: linkedTask.taskId,
        confidence: plan.confidence,
        reasoningSummary: plan.reasoningSummary,
        triggerSource: source,
        originSurface,
        suggestedActions,
        executedActions: [],
        stopReason: "no_action",
      });
      this.syncTaskForRun(linkedTask.taskId, {
        sessionId,
        originSurface,
        proactiveRunId: runId,
        stopReason: completed.stopReason,
        status: "in_progress",
      });
      this.ctx.publishRealtime("proactive_suggestion_created", "chat", {
        sessionId,
        runId,
        actionCount: suggestedActions.length,
      });
      this.touchSessionProactiveTick(sessionId, runId);
      return completed;
    }

    const actionsLastHour = this.countProactiveActionsLastHour(sessionId);
    let remainingHourBudget = Math.max(0, prefs.maxActionsPerHour - actionsLastHour);
    let remainingTurnBudget = Math.max(0, prefs.maxActionsPerTurn);
    for (const action of suggestedActions) {
      const status = this.resolveProactiveAction(
        action,
        prefs.proactiveMode,
        remainingHourBudget,
        remainingTurnBudget,
      );
      if (status.execute) {
        remainingHourBudget -= 1;
        remainingTurnBudget -= 1;
        const executed = await this.executeProactiveToolAction(action);
        executedActions.push(executed);
      } else {
        const blocked = this.updateProactiveAction(action.actionId, {
          status: "blocked",
          error: status.reason,
        });
        executedActions.push(blocked);
        this.ctx.publishRealtime("proactive_action_blocked", "chat", {
          sessionId,
          runId,
          actionId: action.actionId,
          reason: status.reason,
        });
      }
    }

    const executedCount = executedActions.filter((item) => item.status === "executed").length;
    const approvalAction = executedActions.find((item) => item.approvalId);
    const runStatus: ProactiveRunRecord["status"] = executedCount > 0 ? "executed" : "blocked";
    const externalReferenceRoots = dedupeReferenceRoots(executedActions.flatMap((item) => item.externalReferenceRoots ?? []));
    const completed = this.finishProactiveRun(runId, {
      status: runStatus,
      linkedTaskId: linkedTask.taskId,
      linkedDurableRunId: approvalAction?.linkedDurableRunId,
      approvalId: approvalAction?.approvalId,
      confidence: plan.confidence,
      reasoningSummary: plan.reasoningSummary,
      triggerSource: source,
      originSurface,
      stopReason: approvalAction?.approvalId
        ? "approval_block"
        : executedCount > 0
          ? "completed"
          : "budget_exhausted",
      externalReferenceRoots: externalReferenceRoots.length > 0 ? externalReferenceRoots : undefined,
      resumeMetadata: approvalAction?.approvalId
        ? {
          resumableFromApproval: true,
          approvalId: approvalAction.approvalId,
        }
        : undefined,
      suggestedActions,
      executedActions,
    });
    this.syncTaskForRun(linkedTask.taskId, {
      sessionId,
      originSurface,
      proactiveRunId: runId,
      durableRunId: completed.linkedDurableRunId,
      approvalId: completed.approvalId,
      stopReason: completed.stopReason,
      externalReferenceRoots: completed.externalReferenceRoots,
      status: completed.approvalId ? "blocked" : "in_progress",
    });
    if (executedCount > 0) {
      this.ctx.publishRealtime("proactive_action_executed", "chat", {
        sessionId,
        runId,
        actionCount: executedCount,
      });
    }
    this.touchSessionProactiveTick(sessionId, runId);
    return completed;
  }

  listChatSessionProactiveRuns(sessionId: string, limit = 50): ProactiveRunRecord[] {
    this.callbacks.getSession(sessionId);
    const rows = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_runs
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(limit, 500))) as unknown as ProactiveRunRow[];
    return rows.map(mapProactiveRunRow);
  }
}

function mapProactiveRunRow(row: ProactiveRunRow): ProactiveRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    linkedTaskId: row.linked_task_id ?? undefined,
    linkedDurableRunId: row.linked_durable_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    status: row.status,
    mode: row.mode,
    triggerSource: row.trigger_source ?? undefined,
    originSurface: row.origin_surface ?? undefined,
    confidence: Number(row.confidence || 0),
    reasoningSummary: row.reasoning_summary ?? "",
    nextWakeAt: row.next_wake_at ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    externalReferenceRoots: row.external_reference_roots_json
      ? safeJsonParse<ProactiveReferenceRootRecord[]>(row.external_reference_roots_json, [])
      : undefined,
    resumeMetadata: row.resume_metadata_json
      ? safeJsonParse<Record<string, unknown>>(row.resume_metadata_json, {})
      : undefined,
    suggestedActions: safeJsonParse<ProactiveActionRecord[]>(row.suggested_actions_json, []),
    executedActions: safeJsonParse<ProactiveActionRecord[]>(row.executed_actions_json, []),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function objectContainsPathPrefix(value: Record<string, unknown>, prefix: string): boolean {
  const normalizedPrefix = normalizePath(prefix);
  const queue: unknown[] = Object.values(value);
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      if (normalizePath(current).startsWith(normalizedPrefix)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      queue.push(...Object.values(current as Record<string, unknown>));
    }
  }
  return false;
}

function normalizePath(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

function dedupeReferenceRoots(items: ProactiveReferenceRootRecord[]): ProactiveReferenceRootRecord[] {
  const seen = new Set<string>();
  const deduped: ProactiveReferenceRootRecord[] = [];
  for (const item of items) {
    const key = `${item.label}:${normalizePath(item.rootPath)}:${item.access}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

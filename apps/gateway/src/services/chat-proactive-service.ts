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
  DurableRunCreateRequest,
  DurableRunRecord,
  ProactivePolicy,
  ProactiveActionRecord,
  ProactiveOriginSurface,
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

interface ProactiveTickWorkflowPayload {
  version: "proactive.tick.v1";
  sessionId: string;
  proactiveRunId: string;
  taskId?: string;
  originSurface: ProactiveOriginSurface;
  triggerSource: ProactiveTriggerSource;
  policySnapshot: ProactivePolicy;
  requestedAt: string;
}

interface ProactiveDurableState {
  phase?: "planning" | "awaiting_approval" | "completed";
  taskId?: string;
  approvalId?: string;
  blockedActionId?: string;
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

  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;

  requestDurableRunProcessing(runId?: string): void;

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

  private getProactiveAction(actionId: string): ProactiveActionRecord {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_actions
      WHERE action_id = ?
    `).get(actionId) as ProactiveActionRow | undefined;
    if (!row) {
      throw new Error(`Proactive action ${actionId} not found.`);
    }
    return mapProactiveActionRow(row);
  }

  private listProactiveRunActions(runId: string): ProactiveActionRecord[] {
    const rows = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_actions
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(runId) as unknown as ProactiveActionRow[];
    return rows.map(mapProactiveActionRow);
  }

  private refreshProactiveRunSummary(
    runId: string,
    patch: Partial<ProactiveRunRecord>,
    finish = false,
  ): ProactiveRunRecord {
    const actions = this.listProactiveRunActions(runId);
    return this.patchProactiveRun(runId, {
      ...patch,
      suggestedActions: actions,
      executedActions: actions.filter((action) => action.status !== "suggested"),
    }, finish);
  }

  private parseProactiveTickWorkflowPayload(run: DurableRunRecord): ProactiveTickWorkflowPayload | undefined {
    const payload = run.payload as Partial<ProactiveTickWorkflowPayload> | undefined;
    if (!payload || payload.version !== "proactive.tick.v1") {
      return undefined;
    }
    if (
      typeof payload.sessionId !== "string"
      || typeof payload.proactiveRunId !== "string"
      || typeof payload.originSurface !== "string"
      || typeof payload.triggerSource !== "string"
      || typeof payload.requestedAt !== "string"
      || !payload.policySnapshot
      || typeof payload.policySnapshot !== "object"
    ) {
      return undefined;
    }
    return payload as ProactiveTickWorkflowPayload;
  }

  private readProactiveDurableState(run: DurableRunRecord): ProactiveDurableState {
    const metadata = run.metadata;
    if (!isRecord(metadata) || !isRecord(metadata.proactive)) {
      return {};
    }
    const proactive = metadata.proactive;
    return {
      phase: typeof proactive.phase === "string" ? proactive.phase as ProactiveDurableState["phase"] : undefined,
      taskId: typeof proactive.taskId === "string" ? proactive.taskId : undefined,
      approvalId: typeof proactive.approvalId === "string" ? proactive.approvalId : undefined,
      blockedActionId: typeof proactive.blockedActionId === "string" ? proactive.blockedActionId : undefined,
    };
  }

  private updateProactiveDurableRunState(
    run: DurableRunRecord,
    patch: Partial<ProactiveDurableState>,
    status?: DurableRunRecord["status"],
  ): DurableRunRecord {
    const currentMetadata = isRecord(run.metadata) ? { ...run.metadata } : {};
    const currentState = this.readProactiveDurableState(run);
    const nextState = {
      ...currentState,
      ...patch,
    };
    const now = new Date().toISOString();
    return this.ctx.storage.durableRuns.updateRun({
      runId: run.runId,
      status: status ?? run.status,
      metadata: {
        ...currentMetadata,
        proactive: nextState,
      },
      startedAt: run.startedAt ?? now,
      finishedAt: status === "completed" || status === "failed" ? now : undefined,
      lastError: status === "failed" ? run.lastError : undefined,
      updatedAt: now,
    });
  }

  private recordDurableTimelineEvent(
    runId: string,
    eventType: "run_waiting" | "run_completed",
    payload: Record<string, unknown>,
  ): void {
    this.ctx.gatewaySql.prepare(`
      INSERT INTO durable_run_events (event_id, run_id, event_type, step_key, payload_json, created_at)
      VALUES (@eventId, @runId, @eventType, NULL, @payloadJson, @createdAt)
    `).run({
      eventId: randomUUID(),
      runId,
      eventType,
      payloadJson: JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    });
  }

  private markDurableRunWaiting(
    run: DurableRunRecord,
    waitForEvent: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
    statePatch: Partial<ProactiveDurableState>,
  ): DurableRunRecord {
    const currentMetadata = isRecord(run.metadata) ? { ...run.metadata } : {};
    const currentState = this.readProactiveDurableState(run);
    const nextMetadata = {
      ...currentMetadata,
      waitForEvent: {
        eventKey: waitForEvent.eventKey,
        correlationId: waitForEvent.correlationId ?? null,
      },
      proactive: {
        ...currentState,
        ...statePatch,
      },
    };
    const now = new Date().toISOString();
    const updated = this.ctx.storage.durableRuns.updateRun({
      runId: run.runId,
      status: "waiting",
      metadata: nextMetadata,
      startedAt: run.startedAt ?? now,
      finishedAt: undefined,
      lastError: undefined,
      updatedAt: now,
    });
    const checkpointState = {
      waitForEvent: nextMetadata.waitForEvent,
      proactive: nextMetadata.proactive,
      ...(waitForEvent.payload ?? {}),
    };
    this.ctx.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_waiting",
      state: checkpointState,
      createdAt: now,
    });
    this.recordDurableTimelineEvent(run.runId, "run_waiting", checkpointState);
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_waiting",
      runId: run.runId,
      checkpoint: checkpointState,
    });
    return updated;
  }

  private completeDurableRun(runId: string, checkpointState: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "completed",
      updatedAt: now,
      finishedAt: now,
      lastError: undefined,
    });
    this.ctx.storage.durableRuns.createCheckpoint({
      runId,
      checkpointKind: "run_completed",
      state: checkpointState,
      createdAt: now,
    });
    this.recordDurableTimelineEvent(runId, "run_completed", checkpointState);
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_completed",
      runId,
      checkpoint: checkpointState,
    });
  }

  private findActiveProactiveTickRun(sessionId: string): ProactiveRunRecord | undefined {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT pr.*
      FROM proactive_runs pr
      JOIN durable_runs dr
        ON dr.run_id = pr.linked_durable_run_id
      WHERE pr.session_id = ?
        AND dr.workflow_key = 'proactive.tick'
        AND dr.status IN ('queued', 'running', 'waiting', 'paused')
      ORDER BY pr.started_at DESC
      LIMIT 1
    `).get(sessionId) as ProactiveRunRow | undefined;
    return row ? mapProactiveRunRow(row) : undefined;
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

  private async executeProactiveToolAction(
    action: ProactiveActionRecord,
    durableRunId: string,
  ): Promise<ProactiveActionRecord> {
    if (!action.toolName) {
      return this.updateProactiveAction(action.actionId, {
        status: "blocked",
        linkedDurableRunId: durableRunId,
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
          reason: "proactive durable execution",
        },
      });
      const externalReferenceRoots = this.detectExternalReferenceRoots(action.args, result.result);
      if (result.outcome === "executed") {
        return this.updateProactiveAction(action.actionId, {
          status: "executed",
          linkedDurableRunId: durableRunId,
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
          linkedDurableRunId: approval?.linkage?.durableRunId ?? durableRunId,
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
        linkedDurableRunId: durableRunId,
        error: result.policyReason,
        externalReferenceRoots,
      });
    } catch (error) {
      return this.updateProactiveAction(action.actionId, {
        status: "failed",
        linkedDurableRunId: durableRunId,
        error: (error as Error).message,
      });
    }
  }

  private createProactiveTickWorkflowPayload(input: {
    sessionId: string;
    proactiveRunId: string;
    taskId?: string;
    originSurface: ProactiveOriginSurface;
    triggerSource: ProactiveTriggerSource;
    policySnapshot: ProactivePolicy;
    requestedAt: string;
  }): ProactiveTickWorkflowPayload {
    return {
      version: "proactive.tick.v1",
      sessionId: input.sessionId,
      proactiveRunId: input.proactiveRunId,
      taskId: input.taskId,
      originSurface: input.originSurface,
      triggerSource: input.triggerSource,
      policySnapshot: input.policySnapshot,
      requestedAt: input.requestedAt,
    };
  }

  private ensureProactiveRunActions(
    proactiveRunId: string,
    sessionId: string,
    linkedTaskId: string | undefined,
    originSurface: ProactiveOriginSurface,
    triggerSource: ProactiveTriggerSource,
    actions: ProactivePlannedAction[],
  ): ProactiveActionRecord[] {
    const existing = this.listProactiveRunActions(proactiveRunId);
    if (existing.length > 0) {
      return existing;
    }
    const createdAt = new Date().toISOString();
    for (const action of actions) {
      this.insertProactiveAction({
        actionId: randomUUID(),
        runId: proactiveRunId,
        sessionId,
        linkedTaskId,
        kind: action.kind,
        status: "suggested",
        triggerSource,
        originSurface,
        toolName: action.toolName,
        args: action.args,
        result: action.note
          ? { note: action.note }
          : action.objective
            ? { objective: action.objective, roles: action.roles }
            : undefined,
        createdAt,
      });
    }
    return this.listProactiveRunActions(proactiveRunId);
  }

  private finishProactiveDurableRun(
    run: DurableRunRecord,
    proactiveRunId: string,
    patch: Partial<ProactiveRunRecord>,
    checkpointState: Record<string, unknown>,
  ): ProactiveRunRecord {
    const completed = this.refreshProactiveRunSummary(proactiveRunId, patch, true);
    const finalizedRun = this.updateProactiveDurableRunState(run, {
      phase: "completed",
      taskId: completed.linkedTaskId,
      approvalId: undefined,
      blockedActionId: undefined,
    });
    this.completeDurableRun(finalizedRun.runId, {
      proactiveRunId,
      status: completed.status,
      stopReason: completed.stopReason,
      taskId: completed.linkedTaskId,
      approvalId: completed.approvalId,
      ...checkpointState,
    });
    return completed;
  }

  private async resumeBlockedApprovalAction(
    run: DurableRunRecord,
    proactiveRun: ProactiveRunRecord,
    approvalId: string,
    blockedActionId: string,
  ): Promise<"continue" | ProactiveRunRecord> {
    const approval = this.ctx.storage.approvals.get(approvalId);
    const blockedAction = this.getProactiveAction(blockedActionId);

    if (approval.status === "approved" || approval.status === "edited") {
      const pendingAction = this.ctx.storage.pendingApprovalActions.find(approvalId);
      const executedOutcome = typeof pendingAction?.result?.outcome === "string"
        ? pendingAction.result.outcome
        : undefined;
      if (pendingAction?.resolutionStatus === "executed" || executedOutcome === "executed") {
        const approvedResult = isRecord(pendingAction?.result?.result)
          ? pendingAction?.result?.result as Record<string, unknown>
          : undefined;
        this.updateProactiveAction(blockedAction.actionId, {
          status: "executed",
          linkedDurableRunId: run.runId,
          approvalId,
          result: {
            approvalId,
            approvalStatus: approval.status,
            approvedResult,
          },
          error: undefined,
          externalReferenceRoots: this.detectExternalReferenceRoots(blockedAction.args, approvedResult),
        });
        this.patchProactiveRun(proactiveRun.runId, {
          status: "running",
          approvalId: undefined,
          stopReason: undefined,
          nextWakeAt: undefined,
          finishedAt: undefined,
          linkedDurableRunId: run.runId,
          error: undefined,
          resumeMetadata: {
            resumedFromApproval: true,
            approvalId,
          },
        });
        return "continue";
      }

      const failureMessage = pendingAction?.result?.policyReason
        ? String(pendingAction.result.policyReason)
        : "Approved action failed during post-approval execution.";
      this.updateProactiveAction(blockedAction.actionId, {
        status: "failed",
        linkedDurableRunId: run.runId,
        approvalId,
        error: failureMessage,
      });
      const failed = this.finishProactiveDurableRun(run, proactiveRun.runId, {
        status: "failed",
        linkedDurableRunId: run.runId,
        linkedTaskId: proactiveRun.linkedTaskId,
        approvalId,
        stopReason: "terminal_failure",
        error: failureMessage,
      }, {
        approvalId,
        resolution: approval.status,
        error: failureMessage,
      });
      if (failed.linkedTaskId) {
        this.syncTaskForRun(failed.linkedTaskId, {
          sessionId: proactiveRun.sessionId,
          originSurface: proactiveRun.originSurface ?? "chat",
          proactiveRunId: proactiveRun.runId,
          durableRunId: run.runId,
          approvalId,
          stopReason: failed.stopReason,
          externalReferenceRoots: failed.externalReferenceRoots,
          status: "blocked",
        });
      }
      return failed;
    }

    this.updateProactiveAction(blockedAction.actionId, {
      status: "blocked",
      linkedDurableRunId: run.runId,
      approvalId,
      error: "Approval rejected by operator.",
      result: {
        approvalId,
        approvalStatus: approval.status,
      },
    });
    const completed = this.finishProactiveDurableRun(run, proactiveRun.runId, {
      status: "blocked",
      linkedDurableRunId: run.runId,
      linkedTaskId: proactiveRun.linkedTaskId,
      approvalId,
      stopReason: "operator_stop",
      error: "Approval rejected by operator.",
    }, {
      approvalId,
      resolution: approval.status,
    });
    if (completed.linkedTaskId) {
      this.syncTaskForRun(completed.linkedTaskId, {
        sessionId: proactiveRun.sessionId,
        originSurface: proactiveRun.originSurface ?? "chat",
        proactiveRunId: proactiveRun.runId,
        durableRunId: run.runId,
        approvalId,
        stopReason: completed.stopReason,
        externalReferenceRoots: completed.externalReferenceRoots,
        status: "blocked",
      });
    }
    this.touchSessionProactiveTick(proactiveRun.sessionId, proactiveRun.runId);
    return completed;
  }

  private async continueDurableProactiveExecution(
    run: DurableRunRecord,
    payload: ProactiveTickWorkflowPayload,
    proactiveRun: ProactiveRunRecord,
  ): Promise<ProactiveRunRecord> {
    const sessionId = payload.sessionId;
    const proactiveRunId = payload.proactiveRunId;
    const policy = payload.policySnapshot;
    const source = payload.triggerSource;
    const originSurface = payload.originSurface;

    if (policy.mode === "off") {
      const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
        status: "no_action",
        linkedDurableRunId: run.runId,
        confidence: 0,
        reasoningSummary: "Proactive mode is off.",
        stopReason: "no_action",
      }, {
        reason: "mode_off",
      });
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    if (this.callbacks.hasRunningTurn(sessionId)) {
      const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
        status: "no_action",
        linkedDurableRunId: run.runId,
        confidence: 0.2,
        reasoningSummary: "Skipped because a chat turn is still running.",
        stopReason: "no_action",
      }, {
        reason: "running_turn",
      });
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    const idleSeconds = this.callbacks.getSessionIdleSeconds(sessionId);
    if (idleSeconds < PROACTIVE_MIN_IDLE_SECONDS) {
      const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
        status: "no_action",
        linkedDurableRunId: run.runId,
        confidence: 0.2,
        reasoningSummary: `Skipped because session idle time (${idleSeconds}s) is below ${PROACTIVE_MIN_IDLE_SECONDS}s.`,
        stopReason: "no_action",
      }, {
        reason: "idle_below_threshold",
        idleSeconds,
      });
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    const currentPrefs = this.getSessionAutonomyPrefs(sessionId);
    const cooldownRemaining = this.getProactiveCooldownRemainingSeconds(currentPrefs);
    if (cooldownRemaining > 0) {
      const nextWakeAt = new Date(Date.now() + cooldownRemaining * 1000).toISOString();
      const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
        status: "no_action",
        linkedDurableRunId: run.runId,
        confidence: proactiveRun.confidence,
        reasoningSummary: `Skipped because cooldown is active (${cooldownRemaining}s remaining).`,
        stopReason: "cooldown",
        nextWakeAt,
      }, {
        reason: "cooldown",
        nextWakeAt,
      });
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    let linkedTaskId = proactiveRun.linkedTaskId;
    let actions = this.listProactiveRunActions(proactiveRunId);
    if (actions.length === 0) {
      const plan = await this.planProactiveActions(sessionId);
      if (plan.actions.length === 0) {
        const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
          status: "no_action",
          linkedDurableRunId: run.runId,
          confidence: plan.confidence,
          reasoningSummary: plan.reasoningSummary,
          stopReason: "no_action",
        }, {
          reason: "planner_no_action",
        });
        this.ctx.publishRealtime("proactive_no_action", "chat", {
          sessionId,
          runId: proactiveRunId,
          reason: completed.reasoningSummary,
        });
        this.touchSessionProactiveTick(sessionId, proactiveRunId);
        return completed;
      }

      if (policy.mode !== "suggest") {
        const linkedTask = this.ensureLinkedTask({
          sessionId,
          runId: proactiveRunId,
          originSurface,
          reasoningSummary: plan.reasoningSummary,
        });
        linkedTaskId = linkedTask.taskId;
      }

      actions = this.ensureProactiveRunActions(
        proactiveRunId,
        sessionId,
        linkedTaskId,
        originSurface,
        source,
        plan.actions,
      );
      proactiveRun = this.refreshProactiveRunSummary(proactiveRunId, {
        status: "running",
        linkedTaskId,
        linkedDurableRunId: run.runId,
        triggerSource: source,
        originSurface,
        confidence: plan.confidence,
        reasoningSummary: plan.reasoningSummary,
      });
      run = this.updateProactiveDurableRunState(run, {
        phase: "planning",
        taskId: linkedTaskId,
      });

      if (policy.mode === "suggest") {
        const suggested = this.finishProactiveDurableRun(run, proactiveRunId, {
          status: "suggested",
          linkedTaskId,
          linkedDurableRunId: run.runId,
          triggerSource: source,
          originSurface,
          confidence: plan.confidence,
          reasoningSummary: plan.reasoningSummary,
          stopReason: "no_action",
        }, {
          reason: "suggest_only",
        });
        this.ctx.publishRealtime("proactive_suggestion_created", "chat", {
          sessionId,
          runId: proactiveRunId,
          actionCount: actions.length,
        });
        this.touchSessionProactiveTick(sessionId, proactiveRunId);
        return suggested;
      }
    }

    const actionsLastHour = this.countProactiveActionsLastHour(sessionId);
    let remainingHourBudget = Math.max(0, policy.autonomyBudget.maxActionsPerHour - actionsLastHour);
    let remainingTurnBudget = Math.max(0, policy.autonomyBudget.maxActionsPerTurn);

    for (const action of actions) {
      if (action.status === "executed") {
        remainingTurnBudget = Math.max(0, remainingTurnBudget - 1);
        continue;
      }
      if (action.status === "failed" || action.status === "blocked") {
        continue;
      }
      const resolution = this.resolveProactiveAction(
        action,
        policy.mode,
        remainingHourBudget,
        remainingTurnBudget,
      );
      if (!resolution.execute) {
        this.updateProactiveAction(action.actionId, {
          status: "blocked",
          linkedDurableRunId: run.runId,
          error: resolution.reason,
        });
        this.ctx.publishRealtime("proactive_action_blocked", "chat", {
          sessionId,
          runId: proactiveRunId,
          actionId: action.actionId,
          reason: resolution.reason,
        });
        continue;
      }

      remainingHourBudget = Math.max(0, remainingHourBudget - 1);
      remainingTurnBudget = Math.max(0, remainingTurnBudget - 1);
      const executed = await this.executeProactiveToolAction(action, run.runId);
      if (executed.approvalId) {
        const waiting = this.refreshProactiveRunSummary(proactiveRunId, {
          status: "blocked",
          linkedTaskId,
          linkedDurableRunId: run.runId,
          approvalId: executed.approvalId,
          triggerSource: source,
          originSurface,
          stopReason: "approval_block",
          resumeMetadata: {
            resumableFromApproval: true,
            approvalId: executed.approvalId,
            blockedActionId: executed.actionId,
          },
        });
        if (linkedTaskId) {
          this.syncTaskForRun(linkedTaskId, {
            sessionId,
            originSurface,
            proactiveRunId,
            durableRunId: run.runId,
            approvalId: executed.approvalId,
            stopReason: waiting.stopReason,
            externalReferenceRoots: waiting.externalReferenceRoots,
            status: "blocked",
          });
        }
        this.markDurableRunWaiting(run, {
          eventKey: "approval.resolved",
          correlationId: executed.approvalId,
          payload: {
            proactiveRunId,
            approvalId: executed.approvalId,
            blockedActionId: executed.actionId,
          },
        }, {
          phase: "awaiting_approval",
          taskId: linkedTaskId,
          approvalId: executed.approvalId,
          blockedActionId: executed.actionId,
        });
        this.touchSessionProactiveTick(sessionId, proactiveRunId);
        return waiting;
      }
    }

    const refreshed = this.listProactiveRunActions(proactiveRunId);
    const executedCount = refreshed.filter((action) => action.status === "executed").length;
    const blockedActions = refreshed.filter((action) => action.status === "blocked");
    const failedActions = refreshed.filter((action) => action.status === "failed");
    const externalReferenceRoots = dedupeReferenceRoots(
      refreshed.flatMap((action) => action.externalReferenceRoots ?? []),
    );

    const stopReason: ProactiveStopReason | undefined = failedActions.length > 0
      ? "terminal_failure"
      : blockedActions.some((action) => action.error?.includes("budget"))
        ? "budget_exhausted"
        : blockedActions.length > 0
          ? "policy_conflict"
          : executedCount > 0
            ? "completed"
            : "no_action";

    const status: ProactiveRunRecord["status"] = failedActions.length > 0
      ? "failed"
      : executedCount > 0
        ? "executed"
        : blockedActions.length > 0
          ? "blocked"
          : "no_action";

    const completed = this.finishProactiveDurableRun(run, proactiveRunId, {
      status,
      linkedTaskId,
      linkedDurableRunId: run.runId,
      approvalId: undefined,
      triggerSource: source,
      originSurface,
      stopReason,
      externalReferenceRoots: externalReferenceRoots.length > 0 ? externalReferenceRoots : undefined,
      error: failedActions[0]?.error,
    }, {
      executedCount,
      blockedCount: blockedActions.length,
      failedCount: failedActions.length,
    });

    if (linkedTaskId) {
      this.syncTaskForRun(linkedTaskId, {
        sessionId,
        originSurface,
        proactiveRunId,
        durableRunId: run.runId,
        stopReason: completed.stopReason,
        externalReferenceRoots: completed.externalReferenceRoots,
        status: completed.status === "failed" || completed.status === "blocked" ? "blocked" : "in_progress",
      });
    }
    if (executedCount > 0) {
      this.ctx.publishRealtime("proactive_action_executed", "chat", {
        sessionId,
        runId: proactiveRunId,
        actionCount: executedCount,
      });
    }
    this.touchSessionProactiveTick(sessionId, proactiveRunId);
    return completed;
  }

  async executeDurableProactiveTickRun(run: DurableRunRecord): Promise<void> {
    const payload = this.parseProactiveTickWorkflowPayload(run);
    if (!payload) {
      throw new Error("Durable proactive tick payload is invalid or incomplete.");
    }
    let proactiveRun = this.readProactiveRun(payload.proactiveRunId);
    if (proactiveRun.linkedDurableRunId !== run.runId) {
      proactiveRun = this.patchProactiveRun(payload.proactiveRunId, {
        linkedDurableRunId: run.runId,
        originSurface: payload.originSurface,
        triggerSource: payload.triggerSource,
      });
    }

    const durableState = this.readProactiveDurableState(run);
    if (durableState.phase === "awaiting_approval" && durableState.approvalId && durableState.blockedActionId) {
      const resumed = await this.resumeBlockedApprovalAction(
        run,
        proactiveRun,
        durableState.approvalId,
        durableState.blockedActionId,
      );
      if (resumed !== "continue") {
        return;
      }
      run = this.updateProactiveDurableRunState(run, {
        phase: "planning",
        approvalId: undefined,
        blockedActionId: undefined,
      });
    }

    await this.continueDurableProactiveExecution(run, payload, proactiveRun);
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
    const existingActiveRun = this.findActiveProactiveTickRun(sessionId);
    if (existingActiveRun) {
      return existingActiveRun;
    }
    const now = new Date().toISOString();
    const proactiveRunId = randomUUID();
    const policySnapshot = this.toProactivePolicy(sessionId, prefs);
    const durableRun = this.callbacks.createDurableRun({
      workflowKey: "proactive.tick",
      payload: this.createProactiveTickWorkflowPayload({
        sessionId,
        proactiveRunId,
        originSurface,
        triggerSource: source,
        policySnapshot,
        requestedAt: now,
      }) as unknown as Record<string, unknown>,
      metadata: {
        proactive: {
          phase: "planning",
        },
      },
    });
    const initialRun: ProactiveRunRecord = {
      runId: proactiveRunId,
      sessionId,
      status: "running",
      mode: prefs.proactiveMode,
      triggerSource: source,
      originSurface,
      linkedDurableRunId: durableRun.runId,
      confidence: 0,
      reasoningSummary: input.reason ?? `proactive tick (${source})`,
      suggestedActions: [],
      executedActions: [],
      startedAt: now,
    };
    this.insertProactiveRun(initialRun);
    this.ctx.publishRealtime("proactive_tick_started", "chat", {
      sessionId,
      runId: proactiveRunId,
      durableRunId: durableRun.runId,
      mode: prefs.proactiveMode,
      source,
    });
    this.callbacks.requestDurableRunProcessing(durableRun.runId);
    return this.readProactiveRun(proactiveRunId);
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

function mapProactiveActionRow(row: ProactiveActionRow): ProactiveActionRecord {
  return {
    actionId: row.action_id,
    runId: row.run_id,
    sessionId: row.session_id,
    linkedTaskId: row.linked_task_id ?? undefined,
    linkedDurableRunId: row.linked_durable_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    kind: row.kind,
    status: row.status,
    triggerSource: row.trigger_source ?? undefined,
    originSurface: row.origin_surface ?? undefined,
    toolName: row.tool_name ?? undefined,
    args: row.args_json ? safeJsonParse<Record<string, unknown>>(row.args_json, {}) : undefined,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
    error: row.error ?? undefined,
    externalReferenceRoots: row.external_reference_roots_json
      ? safeJsonParse<ProactiveReferenceRootRecord[]>(row.external_reference_roots_json, [])
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

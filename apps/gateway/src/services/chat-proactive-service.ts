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
  ProactivePolicy,
  ProactiveRunRecord,
  SessionMeta,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";

// ── constants ────────────────────────────────────────────────────────
const PROACTIVE_SCHEDULER_INTERVAL_MS = 120_000;
const PROACTIVE_SCHEDULER_CONCURRENCY = 8;
const PROACTIVE_MIN_IDLE_SECONDS = 90;
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
  source?: "scheduler" | "manual" | "chat";
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

  // ── run persistence ──────────────────────────────────────────────

  private insertProactiveRun(run: ProactiveRunRecord): void {
    this.ctx.gatewaySql.prepare(`
      INSERT INTO proactive_runs (
        run_id, session_id, status, mode, confidence, reasoning_summary, action_count,
        suggested_actions_json, executed_actions_json, error, started_at, finished_at
      ) VALUES (
        @runId, @sessionId, @status, @mode, @confidence, @reasoningSummary, @actionCount,
        @suggestedActionsJson, @executedActionsJson, @error, @startedAt, @finishedAt
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
      error: run.error ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    });
  }

  private finishProactiveRun(
    runId: string,
    patch: Partial<Pick<ProactiveRunRecord, "status" | "confidence" | "reasoningSummary" | "suggestedActions" | "executedActions" | "error">>,
  ): ProactiveRunRecord {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_runs
      WHERE run_id = ?
    `).get(runId) as {
      run_id: string;
      session_id: string;
      status: ProactiveRunRecord["status"];
      mode: ChatProactiveMode;
      confidence: number;
      reasoning_summary: string;
      suggested_actions_json: string;
      executed_actions_json: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`Proactive run ${runId} not found.`);
    }
    const next: ProactiveRunRecord = {
      runId: row.run_id,
      sessionId: row.session_id,
      status: patch.status ?? row.status,
      mode: row.mode,
      confidence: patch.confidence ?? Number(row.confidence || 0),
      reasoningSummary: patch.reasoningSummary ?? row.reasoning_summary ?? "",
      suggestedActions: patch.suggestedActions ?? safeJsonParse<ProactiveActionRecord[]>(row.suggested_actions_json, []),
      executedActions: patch.executedActions ?? safeJsonParse<ProactiveActionRecord[]>(row.executed_actions_json, []),
      startedAt: row.started_at,
      finishedAt: new Date().toISOString(),
      error: patch.error ?? row.error ?? undefined,
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
      error: next.error ?? null,
      finishedAt: next.finishedAt ?? null,
    });
    return next;
  }

  // ── action persistence ───────────────────────────────────────────

  private insertProactiveAction(action: ProactiveActionRecord): void {
    this.ctx.gatewaySql.prepare(`
      INSERT INTO proactive_actions (
        action_id, run_id, session_id, kind, status, tool_name, args_json, result_json, error, created_at, updated_at
      ) VALUES (
        @actionId, @runId, @sessionId, @kind, @status, @toolName, @argsJson, @resultJson, @error, @createdAt, @updatedAt
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
      error: action.error ?? null,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt ?? action.createdAt,
    });
  }

  private updateProactiveAction(
    actionId: string,
    patch: Partial<Pick<ProactiveActionRecord, "status" | "result" | "error">>,
  ): ProactiveActionRecord {
    const row = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM proactive_actions
      WHERE action_id = ?
    `).get(actionId) as {
      action_id: string;
      run_id: string;
      session_id: string;
      kind: ProactiveActionRecord["kind"];
      status: ProactiveActionRecord["status"];
      tool_name: string | null;
      args_json: string | null;
      result_json: string | null;
      error: string | null;
      created_at: string;
      updated_at: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`Proactive action ${actionId} not found.`);
    }
    const updatedAt = new Date().toISOString();
    const next: ProactiveActionRecord = {
      actionId: row.action_id,
      runId: row.run_id,
      sessionId: row.session_id,
      kind: row.kind,
      status: patch.status ?? row.status,
      toolName: row.tool_name ?? undefined,
      args: row.args_json ? safeJsonParse<Record<string, unknown>>(row.args_json, {}) : undefined,
      result: patch.result ?? (row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined),
      error: patch.error ?? row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt,
    };
    this.ctx.gatewaySql.prepare(`
      UPDATE proactive_actions
      SET status = @status, result_json = @resultJson, error = @error, updated_at = @updatedAt
      WHERE action_id = @actionId
    `).run({
      actionId: next.actionId,
      status: next.status,
      resultJson: next.result ? JSON.stringify(next.result) : null,
      error: next.error ?? null,
      updatedAt,
    });
    return next;
  }

  private resolveProactiveAction(
    action: ProactiveActionRecord,
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
      return { execute: false, reason: "Only safe tool actions are eligible for auto execution." };
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
        consentContext: {
          source: "agent",
          reason: "proactive auto_safe execution",
        },
      });
      if (result.outcome === "executed") {
        return this.updateProactiveAction(action.actionId, {
          status: "executed",
          result: result.result ?? {},
        });
      }
      if (result.outcome === "approval_required") {
        return this.updateProactiveAction(action.actionId, {
          status: "blocked",
          error: "Approval required by policy.",
          result: {
            approvalId: result.approvalId,
            policyReason: result.policyReason,
          },
        });
      }
      return this.updateProactiveAction(action.actionId, {
        status: "blocked",
        error: result.policyReason,
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
    const now = new Date().toISOString();
    const runId = randomUUID();
    const initialRun: ProactiveRunRecord = {
      runId,
      sessionId,
      status: "running",
      mode: prefs.proactiveMode,
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
      });
    }

    if (this.callbacks.hasRunningTurn(sessionId)) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.2,
        reasoningSummary: "Skipped because a chat turn is still running.",
      });
    }

    const idleSeconds = this.callbacks.getSessionIdleSeconds(sessionId);
    if (idleSeconds < PROACTIVE_MIN_IDLE_SECONDS) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.2,
        reasoningSummary: `Skipped because session idle time (${idleSeconds}s) is below ${PROACTIVE_MIN_IDLE_SECONDS}s.`,
      });
    }

    const cooldownRemaining = this.getProactiveCooldownRemainingSeconds(prefs);
    if (cooldownRemaining > 0) {
      return this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: 0.25,
        reasoningSummary: `Skipped because cooldown is active (${cooldownRemaining}s remaining).`,
      });
    }

    const plan = await this.planProactiveActions(sessionId);
    if (plan.actions.length === 0) {
      const completed = this.finishProactiveRun(runId, {
        status: "no_action",
        confidence: plan.confidence,
        reasoningSummary: plan.reasoningSummary,
      });
      this.ctx.publishRealtime("proactive_no_action", "chat", {
        sessionId,
        runId,
        reason: completed.reasoningSummary,
      });
      this.touchSessionProactiveTick(sessionId, runId);
      return completed;
    }

    const suggestedActions: ProactiveActionRecord[] = [];
    const executedActions: ProactiveActionRecord[] = [];
    for (const action of plan.actions) {
      const actionId = randomUUID();
      const base: ProactiveActionRecord = {
        actionId,
        runId,
        sessionId,
        kind: action.kind,
        status: "suggested",
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
        confidence: plan.confidence,
        reasoningSummary: plan.reasoningSummary,
        suggestedActions,
        executedActions: [],
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
    const runStatus: ProactiveRunRecord["status"] = executedCount > 0 ? "executed" : "blocked";
    const completed = this.finishProactiveRun(runId, {
      status: runStatus,
      confidence: plan.confidence,
      reasoningSummary: plan.reasoningSummary,
      suggestedActions,
      executedActions,
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
    `).all(sessionId, Math.max(1, Math.min(limit, 500))) as Array<{
      run_id: string;
      session_id: string;
      status: ProactiveRunRecord["status"];
      mode: ChatProactiveMode;
      confidence: number;
      reasoning_summary: string;
      suggested_actions_json: string;
      executed_actions_json: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      status: row.status,
      mode: row.mode,
      confidence: Number(row.confidence || 0),
      reasoningSummary: row.reasoning_summary ?? "",
      suggestedActions: safeJsonParse<ProactiveActionRecord[]>(row.suggested_actions_json, []),
      executedActions: safeJsonParse<ProactiveActionRecord[]>(row.executed_actions_json, []),
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      error: row.error ?? undefined,
    }));
  }
}

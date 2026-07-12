/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import { SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";

const log = logger.child("chat-proactive-service");
import {
  DEFAULT_SESSION_AUTONOMY_PREFS,
  type Storage,
  type SessionActiveHoursWindow,
  type SessionAutonomyPrefsPatchInput,
  type SessionAutonomyPrefsRecord,
} from "@goatcitadel/storage";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  DurableRunCreateRequest,
  DurableRunRecord,
  LlmApiStyle,
  ProactivePolicy,
  ProactiveActionRecord,
  ProactiveExecutionClass,
  ProactiveOriginSurface,
  ProactiveReferenceRootRecord,
  ProactiveRunRecord,
  ProactiveRunStatus,
  ProactiveStopReason,
  ProactiveTriggerSource,
  RealtimeEvent,
  SessionMeta,
  TaskRecord,
  ToolPolicyActorContext,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { buildAutonomousTurnContext } from "./gateway/autonomous-turn-policy.js";
import { isWithinActiveHours } from "./gateway/commitment-sweep-service.js";
import {
  type DeNovoPlanContext,
  type DeNovoPlannerModelDeps,
  hasDeNovoContext,
  planDeNovoActions,
} from "./chat-proactive-denovo-planner.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";
import { readToolDomainExecutionFailure } from "./tool-domain-result-truth.js";
import type { ToolInvocationRuntimeOptions } from "./tool-invocation-coordinator-service.js";

/** Origination mode for proactive planning (P1-F5). */
export type ProactiveOriginationMode = "reactive" | "de_novo";

// ── constants ────────────────────────────────────────────────────────
const PROACTIVE_SCHEDULER_INTERVAL_MS = 120_000;
const PROACTIVE_SCHEDULER_CONCURRENCY = 8;
const PROACTIVE_MIN_IDLE_SECONDS = 90;
/**
 * De-novo cadence floor (P1-F5): minimum seconds between *unprompted* (de-novo)
 * ticks for an idle session. De-novo can fire without new user activity, so this
 * floor — together with the per-session cooldown + active-hours — bounds it so it
 * never busy-loops on an idle session. Defaults to 1 hour (matches the heartbeat
 * interval default; both are self-wake cadences keyed off `lastProactiveAt`).
 */
const PROACTIVE_DE_NOVO_CADENCE_SECONDS = 3_600;
/** Recent assistant turns fed to the de-novo planner for situational grounding. */
const PROACTIVE_DE_NOVO_RECENT_ASSISTANT_TURNS = 3;
/** Max pending commitments pulled into the de-novo planning context. */
const PROACTIVE_DE_NOVO_COMMITMENT_LIMIT = 20;
const configuredProactiveReferenceRoot = process.env.GOATCITADEL_PROACTIVE_REFERENCE_ROOT?.trim();
const PROACTIVE_REFERENCE_ROOTS: ProactiveReferenceRootRecord[] = configuredProactiveReferenceRoot
  ? [
      {
        label: "configured-reference",
        rootPath: configuredProactiveReferenceRoot,
        access: "read_only",
      },
    ]
  : [];
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
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  surface?: ProactiveOriginSurface;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

interface ProactivePlannedAction {
  kind: "tool" | "delegate" | "note";
  toolName?: string;
  args?: Record<string, unknown>;
  note?: string;
  objective?: string;
  roles?: string[];
}

/** One session selected for a scheduler tick, tagged with its trigger source. */
interface ProactiveSchedulerCandidate {
  sessionId: string;
  prefs: SessionAutonomyPrefs;
  source: ProactiveTriggerSource;
  reason: string;
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

  invokeTool(request: ToolInvokeRequest, options?: ToolInvocationRuntimeOptions): Promise<ToolInvokeResult>;

  resolveToolPolicyContext?(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: ToolPolicyActorContext["surface"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }): ToolPolicyActorContext;

  detectDelegationRoles(text: string): string[];

  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;

  requestDurableRunProcessing(runId?: string): void;

  /**
   * Cheap, read-only model call used by de-novo origination (P1-F5) to plan
   * self-initiated actions from open commitments/tasks. Optional: when absent
   * (or the master autonomy switch is off), de-novo planning yields no actions
   * and the reactive heuristic path is unaffected.
   */
  createChatCompletion?(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /** Cheap-model defaults for the de-novo planner (mirrors the F3 classifier). */
  resolveModelDefaults?(): { providerId?: string; model?: string };
  /** Resolve api-style so the de-novo planner can gate `response_format`/`temperature`. */
  resolveApiStyle?(providerId?: string, model?: string): LlmApiStyle;
  /**
   * Whether a session may originate de-novo turns: human, non-eval, non-scratch.
   * Mirrors the heartbeat eligibility predicate (eval-integrity turns are never
   * affected). When absent, de-novo treats all sessions as eligible (tests).
   */
  isProactiveDeNovoEligibleSession?(sessionId: string): boolean;

  readonly backgroundTasks: Set<Promise<void>>;
  closing: boolean;
}

export interface ChatProactiveServiceContext {
  readonly storage: Pick<
    Storage,
    | "agentCommitments"
    | "approvals"
    | "chatMessages"
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "durableRuns"
    | "externalSideEffectRuns"
    | "mutationIdempotency"
    | "runImmediateTransaction"
    | "pendingApprovalActions"
    | "sessionAutonomyPrefs"
    | "tasks"
  >;
  readonly gatewaySql: Storage["gatewaySql"];
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

class ProactiveSideEffectReconciliationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProactiveSideEffectReconciliationError";
  }
}

class ProactiveSideEffectRetryableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProactiveSideEffectRetryableError";
  }
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAuthActorSource(value: unknown): ToolPolicyActorContext["authActorSource"] | undefined {
  const source = optionalString(value);
  return source === "none" ||
    source === "token" ||
    source === "basic" ||
    source === "loopback" ||
    source === "sse" ||
    source === "device" ||
    source === "companion"
    ? source
    : undefined;
}

function buildTaskRealtimeLinks(task?: TaskRecord, fallbackTaskId?: string): NonNullable<RealtimeEvent["links"]> {
  return {
    ...(task?.taskId || fallbackTaskId ? { taskId: task?.taskId ?? fallbackTaskId } : {}),
    ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task?.proactiveContext?.sessionId ? { sessionId: task.proactiveContext.sessionId } : {}),
    ...(task?.proactiveContext?.durableRunId ? { runId: task.proactiveContext.durableRunId } : {}),
    ...(task?.proactiveContext?.proactiveRunId ? { proactiveRunId: task.proactiveContext.proactiveRunId } : {}),
    ...(task?.proactiveContext?.approvalId ? { approvalId: task.proactiveContext.approvalId } : {}),
  };
}

function buildProactiveRealtimeLinks(input: {
  sessionId?: string;
  workspaceId?: string;
  proactiveRunId?: string;
  durableRunId?: string;
  taskId?: string;
  approvalId?: string;
}): NonNullable<RealtimeEvent["links"]> {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.proactiveRunId ? { proactiveRunId: input.proactiveRunId } : {}),
    ...(input.durableRunId ? { runId: input.durableRunId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
  };
}

function resolveProactiveExecutionClass(mode: ChatProactiveMode): ProactiveExecutionClass {
  return mode === "suggest" ? "prompted_notification" : "autonomous_durable";
}

function annotateProactiveActionExecutionClass(
  action: ProactiveActionRecord,
  mode: ChatProactiveMode,
): ProactiveActionRecord {
  return {
    ...action,
    executionClass: action.executionClass ?? resolveProactiveExecutionClass(mode),
  };
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
    private readonly ctx: ChatProactiveServiceContext,
    private readonly callbacks: ChatProactiveServiceCallbacks,
  ) {}

  private publishRealtimeSafely(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void {
    try {
      if (options) {
        this.ctx.publishRealtime(channel, topic, payload, options);
      } else {
        this.ctx.publishRealtime(channel, topic, payload);
      }
    } catch (error) {
      log.warn("proactive realtime projection failed", {
        channel,
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── scheduler lifecycle ──────────────────────────────────────────

  startScheduler(): void {
    if (this.scheduler) {
      return;
    }
    this.scheduler = setInterval(() => {
      const task = this.runSchedulerTick().catch((error) => {
        log.error("scheduler tick failed", { error: error instanceof Error ? error.message : String(error) });
        this.publishRealtimeSafely("system", "chat", {
          type: "proactive_scheduler_error",
          message: (error as Error).message,
        });
      });
      this.callbacks.backgroundTasks.add(task);
      task.finally(() => this.callbacks.backgroundTasks.delete(task));
    }, PROACTIVE_SCHEDULER_INTERVAL_MS);
    // Don't let the scheduler timer keep the process/test-runner alive in paths that
    // don't call stopScheduler() (matches the shared background-scheduler helper).
    this.scheduler?.unref();
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
    if (!this.ctx.isFeatureEnabled("durableKernelV1Enabled")) {
      return;
    }
    if (this.ctx.isFeatureEnabled("autonomyV1Disabled")) {
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
    const enriched = sessions.map((session) => ({
      session,
      sessionId: session.sessionId,
      prefs:
        prefsBySessionId.get(session.sessionId) ??
        ({
          sessionId: session.sessionId,
          ...DEFAULT_SESSION_AUTONOMY_PREFS,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as SessionAutonomyPrefs),
    }));

    // Reactive candidates: sessions with new user activity since the last tick.
    const reactiveCandidates: ProactiveSchedulerCandidate[] = enriched
      .filter((item) => item.prefs.proactiveMode !== "off")
      .filter((item) => !this.shouldSkipSchedulerSession(item.session, item.prefs))
      .map((item) => ({
        sessionId: item.sessionId,
        prefs: item.prefs,
        source: "scheduler",
        reason: "Background proactive scheduler tick.",
      }));

    // De-novo candidates (P1-F5): sessions WITHOUT new user activity that still
    // have open commitments/tasks to act on, gated by cooldown + active-hours +
    // de-novo cadence so idle sessions never busy-loop. Reactive takes precedence
    // (a session with new activity uses the reactive path this tick).
    const reactiveIds = new Set(reactiveCandidates.map((candidate) => candidate.sessionId));
    const now = new Date();
    const deNovoCandidates: ProactiveSchedulerCandidate[] = enriched
      .filter((item) => !reactiveIds.has(item.sessionId))
      .filter((item) => this.isDeNovoCadenceEligible(item.sessionId, item.prefs, now))
      .map((item) => ({
        sessionId: item.sessionId,
        prefs: item.prefs,
        source: "de_novo",
        reason: "De-novo origination scheduler tick.",
      }));

    const candidates = [...reactiveCandidates, ...deNovoCandidates];
    if (candidates.length === 0) {
      return;
    }

    const maxWorkers = Math.min(PROACTIVE_SCHEDULER_CONCURRENCY, candidates.length);
    let cursor = 0;
    const workers = Array.from({ length: maxWorkers }, async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        const current = candidates[index];
        if (!current) {
          continue;
        }
        try {
          await this.triggerChatSessionProactive(current.sessionId, {
            source: current.source,
            reason: current.reason,
            prefs: current.prefs,
          });
        } catch (error) {
          log.error("scheduler session trigger failed", {
            sessionId: current.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.publishRealtimeSafely("system", "chat", {
            type: "proactive_scheduler_session_error",
            sessionId: current.sessionId,
            message: (error as Error).message,
          });
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Whether a session may fire an *unprompted* de-novo origination tick now
   * (P1-F5). Every gate must pass (in cheap-first order):
   *  1. master autonomy switch on (`autonomyV1Disabled` off),
   *  2. proactive mode != off,
   *  3. de-novo planner wired (cheap-model callbacks present),
   *  4. session is de-novo eligible (human / non-eval / non-scratch),
   *  5. no turn currently running,
   *  6. within the session's active-hours window,
   *  7. per-session proactive cooldown elapsed,
   *  8. the de-novo cadence floor has elapsed since the last self-wake,
   *  9. there are open commitments/tasks to originate from.
   *
   * Gates 1–8 are cheap, in-memory checks; only after all of them do we touch
   * storage (gate 9) so an idle session with no work never pays the query cost.
   */
  private isDeNovoCadenceEligible(sessionId: string, prefs: SessionAutonomyPrefs, now: Date): boolean {
    if (this.ctx.isFeatureEnabled("autonomyV1Disabled")) {
      return false;
    }
    if (prefs.proactiveMode === "off") {
      return false;
    }
    if (!this.resolveDeNovoPlannerModelDeps()) {
      return false;
    }
    if (this.callbacks.isProactiveDeNovoEligibleSession?.(sessionId) === false) {
      return false;
    }
    if (this.callbacks.hasRunningTurn(sessionId)) {
      return false;
    }
    if (!isWithinActiveHours(now, toActiveHoursWindow(prefs.activeHours))) {
      return false;
    }
    if (this.getProactiveCooldownRemainingSeconds(prefs) > 0) {
      return false;
    }
    if (getDeNovoCadenceRemainingSeconds(prefs, now) > 0) {
      return false;
    }
    return this.hasOpenDeNovoWork(sessionId);
  }

  /** True when the session has at least one pending commitment or an open linked task. */
  private hasOpenDeNovoWork(sessionId: string): boolean {
    // Existence probe rather than fetch-and-scan: this runs on every scheduler tick
    // for each eligible session, so we ask the DB "is there ≥1 pending commitment?"
    // (same predicate as the former listBySession(...).some(status === "pending"))
    // without materializing up to PROACTIVE_DE_NOVO_COMMITMENT_LIMIT rows.
    if (this.ctx.storage.agentCommitments.hasOpenBySession(sessionId)) {
      return true;
    }
    return this.findReusableTask(sessionId) !== undefined;
  }

  private shouldSkipSchedulerSession(
    session: { sessionId: string; lastActivityAt: string },
    prefs: Pick<SessionAutonomyPrefs, "lastProactiveAt">,
  ): boolean {
    if (!prefs.lastProactiveAt) {
      return false;
    }
    const lastProactiveAt = Date.parse(prefs.lastProactiveAt);
    const lastActivityAt = Date.parse(session.lastActivityAt);
    if (!Number.isFinite(lastProactiveAt) || !Number.isFinite(lastActivityAt)) {
      return false;
    }
    return lastActivityAt <= lastProactiveAt;
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

  private patchSessionAutonomyPrefs(sessionId: string, input: SessionAutonomyPrefsPatchInput): SessionAutonomyPrefs {
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
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM proactive_actions
      WHERE session_id = ? AND status = 'executed' AND created_at >= ?
    `,
      )
      .get(sessionId, cutoff) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  // ── planning ─────────────────────────────────────────────────────

  private async planProactiveActions(
    sessionId: string,
    originationMode: ProactiveOriginationMode = "reactive",
    signal?: AbortSignal,
  ): Promise<{
    confidence: number;
    reasoningSummary: string;
    actions: ProactivePlannedAction[];
  }> {
    const messages = await this.callbacks.listChatMessages(sessionId, 60);
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    if (!latestUser) {
      // Reactive mode requires a human seed (exact legacy behavior). De-novo mode
      // (P1-F5) instead originates from open commitments/tasks + time signals.
      if (originationMode === "de_novo") {
        return this.planDeNovoProactiveActions(sessionId, messages, signal);
      }
      return {
        confidence: 0.1,
        reasoningSummary: "No recent user prompt found.",
        actions: [],
      };
    }
    const text = latestUser.content.trim();
    if (!text) {
      if (originationMode === "de_novo") {
        return this.planDeNovoProactiveActions(sessionId, messages, signal);
      }
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

  /**
   * De-novo origination (P1-F5): plan self-initiated actions from open
   * commitments + an open linked task + recent assistant state + time signals via
   * a cheap planner model, with NO last-user message. Returns no actions when the
   * planner callbacks are unavailable (master autonomy off / not wired) or there
   * is nothing to originate from — so flag-off / reactive behavior is unchanged.
   *
   * De-novo grants initiative, not authority: every proposed action still flows
   * through `executeProactiveToolAction → invokeTool → engine.invoke` under the
   * restricted profile and the same autonomy budgets.
   */
  private async planDeNovoProactiveActions(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ): Promise<{ confidence: number; reasoningSummary: string; actions: ProactivePlannedAction[] }> {
    const modelDeps = this.resolveDeNovoPlannerModelDeps(signal);
    if (!modelDeps) {
      return { confidence: 0.1, reasoningSummary: "De-novo planner is not available.", actions: [] };
    }
    const context = this.assembleDeNovoContext(sessionId, messages);
    if (!hasDeNovoContext(context)) {
      return {
        confidence: 0.1,
        reasoningSummary: "No open commitments or tasks to originate from.",
        actions: [],
      };
    }
    const plan = await planDeNovoActions(context, modelDeps);
    return {
      confidence: plan.confidence,
      reasoningSummary: plan.reasoningSummary,
      actions: plan.actions.map((action) =>
        action.kind === "tool"
          ? { kind: "tool", toolName: action.toolName, args: action.args }
          : { kind: "note", note: action.note },
      ),
    };
  }

  /**
   * Build the de-novo planner model deps from the optional service callbacks.
   * Returns `undefined` (de-novo disabled) when the cheap-model callbacks are not
   * wired — keeping the reactive path and flag-off behavior byte-identical.
   */
  private resolveDeNovoPlannerModelDeps(signal?: AbortSignal): DeNovoPlannerModelDeps | undefined {
    const { createChatCompletion, resolveModelDefaults, resolveApiStyle } = this.callbacks;
    if (!createChatCompletion || !resolveModelDefaults || !resolveApiStyle) {
      return undefined;
    }
    return {
      createChatCompletion: (request) => createChatCompletion(request),
      resolveModelDefaults: () => resolveModelDefaults(),
      resolveApiStyle: (providerId, model) => resolveApiStyle(providerId, model),
      signal,
    };
  }

  /** Assemble the de-novo planning context (pending commitments + open task + recent assistant state). */
  private assembleDeNovoContext(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): DeNovoPlanContext {
    const commitments = this.ctx.storage.agentCommitments
      .listBySession(sessionId, PROACTIVE_DE_NOVO_COMMITMENT_LIMIT)
      .filter((commitment) => commitment.status === "pending");
    const openTask = this.findReusableTask(sessionId);
    const recentAssistantText = [...messages]
      .reverse()
      .filter((message) => message.role === "assistant")
      .slice(0, PROACTIVE_DE_NOVO_RECENT_ASSISTANT_TURNS)
      .map((message) => message.content.trim())
      .filter((content) => content.length > 0);
    return {
      commitments,
      openTask: openTask ? { taskId: openTask.taskId, title: openTask.title, status: openTask.status } : undefined,
      recentAssistantText,
      nowIso: new Date().toISOString(),
    };
  }

  private readProactiveRun(runId: string): ProactiveRunRecord {
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM proactive_runs
      WHERE run_id = ?
    `,
      )
      .get(runId) as ProactiveRunRow | undefined;
    if (!row) {
      throw new Error(`Proactive run ${runId} not found.`);
    }
    return mapProactiveRunRow(row);
  }

  private readProactiveRunMode(runId: string): ChatProactiveMode {
    const row = this.ctx.gatewaySql.prepare("SELECT mode FROM proactive_runs WHERE run_id = ?").get(runId) as
      | { mode?: ChatProactiveMode }
      | undefined;
    return row?.mode ?? "auto_full";
  }

  private readProactiveRunActor(runId: string): {
    operatorId: string;
    authActorId: string;
    authActorSource: ToolPolicyActorContext["authActorSource"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  } {
    try {
      const metadata = this.readProactiveRun(runId).resumeMetadata;
      const operatorId = optionalString(metadata?.operatorId) ?? "system-proactive";
      return {
        operatorId,
        authActorId: optionalString(metadata?.authActorId) ?? operatorId,
        authActorSource: normalizeAuthActorSource(metadata?.authActorSource) ?? "none",
        permissionProfileId: optionalString(metadata?.permissionProfileId),
        localOperatorOverrideId: optionalString(metadata?.localOperatorOverrideId),
      };
    } catch {
      return {
        operatorId: "system-proactive",
        authActorId: "system-proactive",
        authActorSource: "none",
      };
    }
  }

  // ── run persistence ──────────────────────────────────────────────

  private insertProactiveRun(run: ProactiveRunRecord): void {
    this.ctx.gatewaySql
      .prepare(
        `
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
    `,
      )
      .run({
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

  private patchProactiveRun(runId: string, patch: Partial<ProactiveRunRecord>, finish = false): ProactiveRunRecord {
    // The read (current state), the JS-side merge (mode fallback, finish
    // timestamp, action_count derivation, resume_metadata object spread) and the
    // write must form one atomic unit. Otherwise two concurrent resolutions
    // (e.g. the durable tick re-queue and an approval-resume callback) can each
    // read the same row, merge, and write — silently clobbering the other's
    // field updates (linkedDurableRunId, approvalId, stopReason, …). BEGIN
    // IMMEDIATE takes the write lock before the read, serialising the pair.
    return this.ctx.gatewaySql.runImmediateTransaction(() => {
      const current = this.readProactiveRun(runId);
      const next: ProactiveRunRecord = {
        ...current,
        ...patch,
        runId: current.runId,
        sessionId: current.sessionId,
        mode: patch.mode ?? current.mode,
        finishedAt: finish ? new Date().toISOString() : (patch.finishedAt ?? current.finishedAt),
      };
      this.ctx.gatewaySql
        .prepare(
          `
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
    `,
        )
        .run({
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
    });
  }

  private finishProactiveRun(runId: string, patch: Partial<ProactiveRunRecord>): ProactiveRunRecord {
    return this.patchProactiveRun(runId, patch, true);
  }

  // ── action persistence ───────────────────────────────────────────

  private insertProactiveAction(action: ProactiveActionRecord): void {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO proactive_actions (
        action_id, run_id, session_id, kind, status, tool_name, args_json, result_json,
        linked_task_id, linked_durable_run_id, approval_id, trigger_source, origin_surface,
        external_reference_roots_json, error, created_at, updated_at
      ) VALUES (
        @actionId, @runId, @sessionId, @kind, @status, @toolName, @argsJson, @resultJson,
        @linkedTaskId, @linkedDurableRunId, @approvalId, @triggerSource, @originSurface,
        @externalReferenceRootsJson, @error, @createdAt, @updatedAt
      )
    `,
      )
      .run({
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
        externalReferenceRootsJson: action.externalReferenceRoots
          ? JSON.stringify(action.externalReferenceRoots)
          : null,
        error: action.error ?? null,
        createdAt: action.createdAt,
        updatedAt: action.updatedAt ?? action.createdAt,
      });
  }

  private updateProactiveAction(actionId: string, patch: Partial<ProactiveActionRecord>): ProactiveActionRecord {
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM proactive_actions
      WHERE action_id = ?
    `,
      )
      .get(actionId) as ProactiveActionRow | undefined;
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
      result:
        patch.result ?? (row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined),
      error: patch.error ?? row.error ?? undefined,
      externalReferenceRoots:
        patch.externalReferenceRoots ??
        (row.external_reference_roots_json
          ? safeJsonParse<ProactiveReferenceRootRecord[]>(row.external_reference_roots_json, [])
          : undefined),
      createdAt: row.created_at,
      updatedAt,
    };
    this.ctx.gatewaySql
      .prepare(
        `
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
    `,
      )
      .run({
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
    const row = toProactiveActionRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM proactive_actions
      WHERE action_id = ?
    `,
        )
        .get(actionId),
    );
    if (!row) {
      throw new Error(`Proactive action ${actionId} not found.`);
    }
    return mapProactiveActionRow(row, this.readProactiveRunMode(row.run_id));
  }

  private listProactiveRunActions(runId: string): ProactiveActionRecord[] {
    const mode = this.readProactiveRunMode(runId);
    const rows = toProactiveActionRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM proactive_actions
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
        )
        .all(runId),
    );
    return rows.map((row) => mapProactiveActionRow(row, mode));
  }

  private refreshProactiveRunSummary(
    runId: string,
    patch: Partial<ProactiveRunRecord>,
    finish = false,
  ): ProactiveRunRecord {
    const actions = this.listProactiveRunActions(runId);
    return this.patchProactiveRun(
      runId,
      {
        ...patch,
        suggestedActions: actions,
        executedActions: actions.filter((action) => action.status !== "suggested"),
      },
      finish,
    );
  }

  private parseProactiveTickWorkflowPayload(run: DurableRunRecord): ProactiveTickWorkflowPayload | undefined {
    const payload = toPlainRecord(run.payload) as Partial<ProactiveTickWorkflowPayload>;
    if (!payload || payload.version !== "proactive.tick.v1") {
      return undefined;
    }
    if (
      typeof payload.sessionId !== "string" ||
      typeof payload.proactiveRunId !== "string" ||
      typeof payload.originSurface !== "string" ||
      typeof payload.triggerSource !== "string" ||
      typeof payload.requestedAt !== "string" ||
      !payload.policySnapshot ||
      typeof payload.policySnapshot !== "object"
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
      phase: typeof proactive.phase === "string" ? (proactive.phase as ProactiveDurableState["phase"]) : undefined,
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
    const expectedLeaseOwnerId = this.requireProactiveExecutionLeaseOwner(run);
    let updated!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      const current = this.lockFreshProactiveExecutionLease(run.runId, expectedLeaseOwnerId);
      const currentMetadata = isRecord(current.metadata) ? { ...current.metadata } : {};
      const currentState = this.readProactiveDurableState(current);
      const nextState = {
        ...currentState,
        ...patch,
      };
      const now = new Date().toISOString();
      updated = this.ctx.storage.durableRuns.updateRun({
        runId: run.runId,
        status: status ?? current.status,
        metadata: {
          ...currentMetadata,
          proactive: nextState,
        },
        startedAt: current.startedAt ?? now,
        ...(status === "completed" || status === "failed" ? { finishedAt: now } : { clearFinishedAt: true }),
        clearLease: status === "completed" || status === "failed",
        ...(status === "failed" ? { lastError: current.lastError } : { clearLastError: true }),
        updatedAt: now,
        expectedVersion: current.version,
      });
    });
    return updated;
  }

  private requireProactiveExecutionLeaseOwner(run: DurableRunRecord): string {
    const leaseOwnerId = run.leaseOwnerId?.trim();
    if (!leaseOwnerId) {
      throw this.buildProactiveLeaseLossError(run.runId);
    }
    return leaseOwnerId;
  }

  private lockFreshProactiveExecutionLease(runId: string, expectedLeaseOwnerId: string): DurableRunRecord {
    const locked = this.ctx.storage.durableRuns.lockFreshActiveLeaseForUpdate(runId, expectedLeaseOwnerId);
    if (!locked) {
      throw this.buildProactiveLeaseLossError(runId);
    }
    return locked;
  }

  private buildProactiveLeaseLossError(runId: string): Error {
    const error = new Error(`Proactive durable run ${runId} lost its execution lease`);
    error.name = "DurableWorkerInterruptionError";
    return error;
  }

  private recordDurableTimelineEvent(
    runId: string,
    eventType: "run_waiting" | "run_completed",
    payload: Record<string, unknown>,
  ): void {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO durable_run_events (event_id, run_id, event_type, step_key, payload_json, created_at)
      VALUES (@eventId, @runId, @eventType, NULL, @payloadJson, @createdAt)
    `,
      )
      .run({
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
    const now = new Date().toISOString();
    let updated!: DurableRunRecord;
    let checkpointState!: Record<string, unknown>;
    this.ctx.storage.runImmediateTransaction(() => {
      const locked = this.lockFreshProactiveExecutionLease(run.runId, this.requireProactiveExecutionLeaseOwner(run));
      const currentMetadata = isRecord(locked.metadata) ? { ...locked.metadata } : {};
      const currentState = this.readProactiveDurableState(locked);
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
      checkpointState = {
        waitForEvent: nextMetadata.waitForEvent,
        proactive: nextMetadata.proactive,
        ...(waitForEvent.payload ?? {}),
      };
      updated = this.ctx.storage.durableRuns.updateRun({
        runId: locked.runId,
        status: "waiting",
        metadata: nextMetadata,
        startedAt: locked.startedAt ?? now,
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        updatedAt: now,
        expectedVersion: locked.version,
      });
      this.ctx.storage.durableRuns.createCheckpoint({
        runId: locked.runId,
        checkpointKind: "run_waiting",
        state: checkpointState,
        createdAt: now,
      });
      this.recordDurableTimelineEvent(locked.runId, "run_waiting", checkpointState);
    });
    const checkpointRecord = checkpointState as Record<string, unknown>;
    const proactiveState = toPlainRecord(checkpointRecord.proactive);
    try {
      this.publishRealtimeSafely(
        "system",
        "durable",
        {
          type: "durable_run_waiting",
          runId: run.runId,
          checkpoint: checkpointState,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: buildProactiveRealtimeLinks({
            durableRunId: run.runId,
            proactiveRunId:
              typeof checkpointRecord.proactiveRunId === "string" ? checkpointRecord.proactiveRunId : undefined,
            approvalId: typeof checkpointRecord.approvalId === "string" ? checkpointRecord.approvalId : undefined,
            taskId: typeof proactiveState?.taskId === "string" ? proactiveState.taskId : undefined,
          }),
        },
      );
    } catch {
      // Retained realtime is downstream of the atomic waiting transition.
      return updated;
    }
    return updated;
  }

  private completeDurableRun(run: DurableRunRecord, checkpointState: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.ctx.storage.runImmediateTransaction(() => {
      const current = this.lockFreshProactiveExecutionLease(run.runId, this.requireProactiveExecutionLeaseOwner(run));
      this.ctx.storage.durableRuns.updateRun({
        runId: run.runId,
        status: "completed",
        updatedAt: now,
        finishedAt: now,
        clearLease: true,
        clearLastError: true,
        expectedVersion: current.version,
      });
      this.ctx.storage.durableRuns.createCheckpoint({
        runId: run.runId,
        checkpointKind: "run_completed",
        state: checkpointState,
        createdAt: now,
      });
      this.recordDurableTimelineEvent(run.runId, "run_completed", checkpointState);
    });
    try {
      this.publishRealtimeSafely(
        "system",
        "durable",
        {
          type: "durable_run_completed",
          runId: run.runId,
          checkpoint: checkpointState,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: buildProactiveRealtimeLinks({
            durableRunId: run.runId,
            proactiveRunId:
              typeof checkpointState.proactiveRunId === "string" ? checkpointState.proactiveRunId : undefined,
            approvalId: typeof checkpointState.approvalId === "string" ? checkpointState.approvalId : undefined,
            taskId: typeof checkpointState.taskId === "string" ? checkpointState.taskId : undefined,
          }),
        },
      );
    } catch {
      // Retained realtime is downstream of the atomic completion.
      return;
    }
  }

  private findActiveProactiveTickRun(sessionId: string): ProactiveRunRecord | undefined {
    const row = toProactiveRunRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT pr.*
      FROM proactive_runs pr
      JOIN durable_runs dr
        ON dr.run_id = pr.linked_durable_run_id
      WHERE pr.session_id = ?
        AND dr.workflow_key = 'proactive.tick'
        AND dr.status IN ('queued', 'running', 'waiting', 'paused')
      ORDER BY pr.started_at DESC
      LIMIT 1
    `,
        )
        .get(sessionId),
    );
    return row ? mapProactiveRunRow(row) : undefined;
  }

  private findReusableTask(sessionId: string): TaskRecord | undefined {
    const latestRun = this.listChatSessionProactiveRuns(sessionId, 20).find((item) => item.linkedTaskId);
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
      this.publishRealtimeSafely(
        "task_updated",
        "tasks",
        { task: updated },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: buildTaskRealtimeLinks(updated),
        },
      );
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
    this.publishRealtimeSafely(
      "task_created",
      "tasks",
      { task: created },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: buildTaskRealtimeLinks(created),
      },
    );
    return created;
  }

  private syncTaskForRun(
    taskId: string,
    patch: {
      sessionId: string;
      originSurface: ProactiveOriginSurface;
      proactiveRunId: string;
      durableRunId?: string;
      approvalId?: string;
      nextWakeAt?: string;
      stopReason?: ProactiveStopReason;
      externalReferenceRoots?: ProactiveReferenceRootRecord[];
      status?: TaskRecord["status"];
    },
  ): TaskRecord {
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
    this.publishRealtimeSafely(
      "task_updated",
      "tasks",
      { task: updated },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: buildTaskRealtimeLinks(updated),
      },
    );
    return updated;
  }

  private detectExternalReferenceRoots(
    ...sources: Array<Record<string, unknown> | undefined>
  ): ProactiveReferenceRootRecord[] | undefined {
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
    signal?: AbortSignal,
    expectedLeaseOwnerId?: string,
  ): Promise<ProactiveActionRecord> {
    throwIfProactiveDurableRunAborted(signal);
    if (!action.toolName) {
      return this.updateProactiveAction(action.actionId, {
        status: "blocked",
        linkedDurableRunId: durableRunId,
        error: "Missing tool name.",
      });
    }
    try {
      const workspaceId = this.getSessionWorkspaceId(action.sessionId);
      const surface = action.originSurface ?? this.getSessionOriginSurface(action.sessionId);
      const actor = this.readProactiveRunActor(action.runId);
      // Safety invariant: every proactive/autonomous tool invocation must run under
      // a restricted permission profile (see autonomous-turn-policy.ts). When the
      // host wires `resolveToolPolicyContext`, use it. When it is NOT wired, fail
      // CLOSED to the scheduled-restricted profile rather than passing an undefined
      // `permissionProfileId` — an undefined id would let the gateway resolve to
      // whatever interactive profile is active for the session (potentially a bypass
      // profile), silently widening the autonomous surface.
      const policyContext =
        this.callbacks.resolveToolPolicyContext?.({
          operatorId: actor.operatorId,
          authActorId: actor.authActorId,
          authActorSource: actor.authActorSource,
          workspaceId,
          sessionId: action.sessionId,
          taskId: action.linkedTaskId,
          runId: durableRunId,
          surface,
          permissionProfileId: actor.permissionProfileId,
          localOperatorOverrideId: actor.localOperatorOverrideId,
        }) ??
        buildAutonomousTurnContext({
          kind: "scheduled",
          systemActorId: actor.operatorId,
          runId: durableRunId,
          workspaceId,
          sessionId: action.sessionId,
          taskId: action.linkedTaskId,
          surface,
        }).policyContext;
      const sideEffect = await runIdempotentExternalSideEffect({
        mutationStore: this.ctx.storage.mutationIdempotency,
        sideEffectRunStore: this.ctx.storage.externalSideEffectRuns,
        runClaimTransaction: (work) => this.ctx.storage.runImmediateTransaction(work),
        workspaceId,
        boundary: "proactive_tool_action",
        catalogId: action.toolName,
        actionId: action.actionId,
        actorScope: workspaceId,
        idempotencyKey: `proactive-action:${action.actionId}`,
        checkedAt: new Date().toISOString(),
        payload: {
          actionId: action.actionId,
          toolName: action.toolName,
          args: action.args ?? {},
          sessionId: action.sessionId,
          taskId: action.linkedTaskId,
        },
        label: `Proactive action ${action.actionId}`,
        output: { actionId: action.actionId, proactiveRunId: action.runId, durableRunId },
        requireDurableBoundaryRecord: true,
        execute: async (claim) => {
          const executionFence = expectedLeaseOwnerId
            ? () => {
                this.ctx.storage.runImmediateTransaction(() => {
                  this.lockFreshProactiveExecutionLease(durableRunId, expectedLeaseOwnerId);
                });
              }
            : undefined;
          const result = await this.callbacks.invokeTool(
            {
              toolName: action.toolName!,
              args: action.args ?? {},
              agentId: "proactive",
              sessionId: action.sessionId,
              workspaceId,
              taskId: action.linkedTaskId,
              runId: durableRunId,
              surface,
              permissionProfileId: policyContext?.permissionProfileId,
              localOperatorOverrideId: policyContext?.localOperatorOverrideId,
              policyContext,
              signal,
              consentContext: {
                operatorId: actor.operatorId,
                source: "agent",
                reason: "proactive durable execution",
              },
            },
            {
              ...(executionFence ? { executionFence } : {}),
              externalSideEffect: {
                markStarted: () => claim.markExternalCallStarted(),
                markNotRequired: () => claim.markExternalCallNotRequired(),
              },
            },
          );
          const executionFailure = readProactiveToolExecutionFailure(result);
          if (executionFailure) {
            if (!claim.externalCallStarted) {
              claim.markExternalCallNotRequired();
            }
            throw new Error(executionFailure);
          }
          if (result.outcome !== "executed") {
            if (claim.externalCallStarted) {
              throw new Error(result.policyReason);
            }
            claim.markExternalCallNotRequired();
          }
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
        },
      });
      if (sideEffect.status === "executed") {
        return sideEffect.value;
      }
      if (sideEffect.status === "failed" && signal?.aborted) {
        throwIfProactiveDurableRunAborted(signal);
      }
      const latest = this.getProactiveAction(action.actionId);
      if (latest.status !== "suggested") {
        return latest;
      }
      if (sideEffect.status === "failed" && sideEffect.claim.resumeState === "manual_retry_after_recorded_failure") {
        throw new ProactiveSideEffectRetryableError(sideEffect.error.message);
      }
      if (
        sideEffect.status === "blocked" &&
        (sideEffect.claim.replayOutcome === "in_progress" || sideEffect.claim.replayOutcome === "duplicate")
      ) {
        throw new ProactiveSideEffectReconciliationError(
          `Proactive action ${action.actionId} has durable side-effect state ${sideEffect.claim.replayOutcome} but no terminal action row; manual reconciliation is required.`,
        );
      }
      const error = sideEffect.status === "failed" ? sideEffect.error.message : sideEffect.message;
      return this.updateProactiveAction(action.actionId, {
        status: "failed",
        linkedDurableRunId: durableRunId,
        error,
      });
    } catch (error) {
      throwIfProactiveDurableRunAborted(signal);
      if (
        error instanceof ProactiveSideEffectReconciliationError ||
        error instanceof ProactiveSideEffectRetryableError
      ) {
        throw error;
      }
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
    const executionClass = resolveProactiveExecutionClass(this.readProactiveRun(proactiveRunId).mode);
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
        executionClass,
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
    this.completeDurableRun(finalizedRun, {
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
    context?: { signal?: AbortSignal },
  ): Promise<"continue" | ProactiveRunRecord> {
    throwIfProactiveDurableRunAborted(context?.signal);
    const approval = this.ctx.storage.approvals.get(approvalId);
    const blockedAction = this.getProactiveAction(blockedActionId);

    if (approval.status === "approved" || approval.status === "edited") {
      const pendingAction = this.ctx.storage.pendingApprovalActions.find(approvalId);
      const executedOutcome =
        typeof pendingAction?.result?.outcome === "string" ? pendingAction.result.outcome : undefined;
      const storedExecutionFailure = readStoredProactiveToolExecutionFailure(pendingAction?.result);
      if (
        (pendingAction?.resolutionStatus === "executed" || executedOutcome === "executed") &&
        !storedExecutionFailure
      ) {
        const approvedResult = isRecord(pendingAction?.result?.result)
          ? (pendingAction?.result?.result as Record<string, unknown>)
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
            ...(proactiveRun.resumeMetadata ?? {}),
            resumedFromApproval: true,
            approvalId,
          },
        });
        throwIfProactiveDurableRunAborted(context?.signal);
        return "continue";
      }

      const failureMessage =
        storedExecutionFailure ??
        (pendingAction?.result?.policyReason
          ? String(pendingAction.result.policyReason)
          : "Approved action failed during post-approval execution.");
      this.updateProactiveAction(blockedAction.actionId, {
        status: "failed",
        linkedDurableRunId: run.runId,
        approvalId,
        error: failureMessage,
      });
      const failed = this.finishProactiveDurableRun(
        run,
        proactiveRun.runId,
        {
          status: "failed",
          linkedDurableRunId: run.runId,
          linkedTaskId: proactiveRun.linkedTaskId,
          approvalId,
          stopReason: "terminal_failure",
          error: failureMessage,
        },
        {
          approvalId,
          resolution: approval.status,
          error: failureMessage,
        },
      );
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
    const completed = this.finishProactiveDurableRun(
      run,
      proactiveRun.runId,
      {
        status: "blocked",
        linkedDurableRunId: run.runId,
        linkedTaskId: proactiveRun.linkedTaskId,
        approvalId,
        stopReason: "operator_stop",
        error: "Approval rejected by operator.",
      },
      {
        approvalId,
        resolution: approval.status,
      },
    );
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
    throwIfProactiveDurableRunAborted(context?.signal);
    return completed;
  }

  private async continueDurableProactiveExecution(
    run: DurableRunRecord,
    payload: ProactiveTickWorkflowPayload,
    proactiveRun: ProactiveRunRecord,
    context?: { signal?: AbortSignal },
  ): Promise<ProactiveRunRecord> {
    throwIfProactiveDurableRunAborted(context?.signal);
    const sessionId = payload.sessionId;
    const proactiveRunId = payload.proactiveRunId;
    const policy = payload.policySnapshot;
    const source = payload.triggerSource;
    const originSurface = payload.originSurface;

    if (policy.mode === "off") {
      const completed = this.finishProactiveDurableRun(
        run,
        proactiveRunId,
        {
          status: "no_action",
          linkedDurableRunId: run.runId,
          confidence: 0,
          reasoningSummary: "Proactive mode is off.",
          stopReason: "no_action",
        },
        {
          reason: "mode_off",
        },
      );
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    if (this.callbacks.hasRunningTurn(sessionId)) {
      const completed = this.finishProactiveDurableRun(
        run,
        proactiveRunId,
        {
          status: "no_action",
          linkedDurableRunId: run.runId,
          confidence: 0.2,
          reasoningSummary: "Skipped because a chat turn is still running.",
          stopReason: "no_action",
        },
        {
          reason: "running_turn",
        },
      );
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    const idleSeconds = this.callbacks.getSessionIdleSeconds(sessionId);
    if (idleSeconds < PROACTIVE_MIN_IDLE_SECONDS) {
      const completed = this.finishProactiveDurableRun(
        run,
        proactiveRunId,
        {
          status: "no_action",
          linkedDurableRunId: run.runId,
          confidence: 0.2,
          reasoningSummary: `Skipped because session idle time (${idleSeconds}s) is below ${PROACTIVE_MIN_IDLE_SECONDS}s.`,
          stopReason: "no_action",
        },
        {
          reason: "idle_below_threshold",
          idleSeconds,
        },
      );
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    const currentPrefs = this.getSessionAutonomyPrefs(sessionId);
    const cooldownRemaining = this.getProactiveCooldownRemainingSeconds(currentPrefs);
    if (cooldownRemaining > 0) {
      const nextWakeAt = new Date(Date.now() + cooldownRemaining * 1000).toISOString();
      const completed = this.finishProactiveDurableRun(
        run,
        proactiveRunId,
        {
          status: "no_action",
          linkedDurableRunId: run.runId,
          confidence: proactiveRun.confidence,
          reasoningSummary: `Skipped because cooldown is active (${cooldownRemaining}s remaining).`,
          stopReason: "cooldown",
          nextWakeAt,
        },
        {
          reason: "cooldown",
          nextWakeAt,
        },
      );
      this.touchSessionProactiveTick(sessionId, proactiveRunId);
      return completed;
    }

    let linkedTaskId = proactiveRun.linkedTaskId;
    let actions = this.listProactiveRunActions(proactiveRunId);
    if (actions.length === 0) {
      throwIfProactiveDurableRunAborted(context?.signal);
      const originationMode: ProactiveOriginationMode = source === "de_novo" ? "de_novo" : "reactive";
      const plan = await this.planProactiveActions(sessionId, originationMode, context?.signal);
      throwIfProactiveDurableRunAborted(context?.signal);
      if (plan.actions.length === 0) {
        const completed = this.finishProactiveDurableRun(
          run,
          proactiveRunId,
          {
            status: "no_action",
            linkedDurableRunId: run.runId,
            confidence: plan.confidence,
            reasoningSummary: plan.reasoningSummary,
            stopReason: "no_action",
          },
          {
            reason: "planner_no_action",
          },
        );
        this.touchSessionProactiveTick(sessionId, proactiveRunId);
        this.publishRealtimeSafely(
          "proactive_no_action",
          "chat",
          {
            sessionId,
            runId: proactiveRunId,
            reason: completed.reasoningSummary,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: buildProactiveRealtimeLinks({
              sessionId,
              workspaceId: this.getSessionWorkspaceId(sessionId),
              proactiveRunId,
              durableRunId: run.runId,
            }),
          },
        );
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
      this.refreshProactiveRunSummary(proactiveRunId, {
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
        const suggested = this.finishProactiveDurableRun(
          run,
          proactiveRunId,
          {
            status: "suggested",
            linkedTaskId,
            linkedDurableRunId: run.runId,
            triggerSource: source,
            originSurface,
            confidence: plan.confidence,
            reasoningSummary: plan.reasoningSummary,
            stopReason: "no_action",
          },
          {
            reason: "suggest_only",
          },
        );
        this.touchSessionProactiveTick(sessionId, proactiveRunId);
        this.publishRealtimeSafely(
          "proactive_suggestion_created",
          "chat",
          {
            sessionId,
            runId: proactiveRunId,
            actionCount: actions.length,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: buildProactiveRealtimeLinks({
              sessionId,
              workspaceId: this.getSessionWorkspaceId(sessionId),
              proactiveRunId,
              durableRunId: run.runId,
              taskId: linkedTaskId,
            }),
          },
        );
        return suggested;
      }
    }

    const strandedApprovalAction = actions.find(
      (action) => action.status === "blocked" && typeof action.approvalId === "string",
    );
    if (strandedApprovalAction?.approvalId) {
      const approval = this.ctx.storage.approvals.get(strandedApprovalAction.approvalId);
      if (approval.status !== "pending") {
        const resumed = await this.resumeBlockedApprovalAction(
          run,
          proactiveRun,
          strandedApprovalAction.approvalId,
          strandedApprovalAction.actionId,
          context,
        );
        throwIfProactiveDurableRunAborted(context?.signal);
        if (resumed !== "continue") {
          return resumed;
        }
        run = this.updateProactiveDurableRunState(run, {
          phase: "planning",
          approvalId: undefined,
          blockedActionId: undefined,
        });
        proactiveRun = this.readProactiveRun(proactiveRunId);
        actions = this.listProactiveRunActions(proactiveRunId);
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
      if (action.status === "failed") {
        continue;
      }
      let executed: ProactiveActionRecord;
      if (action.status === "blocked") {
        if (!action.approvalId) {
          continue;
        }
        // A crash can occur after the action row records approval_required but
        // before the proactive/durable wait linkage commits. Rebuild that wait
        // from the terminal action row without invoking the tool again.
        executed = action;
      } else {
        const resolution = this.resolveProactiveAction(action, policy.mode, remainingHourBudget, remainingTurnBudget);
        if (!resolution.execute) {
          this.updateProactiveAction(action.actionId, {
            status: "blocked",
            linkedDurableRunId: run.runId,
            error: resolution.reason,
          });
          this.publishRealtimeSafely(
            "proactive_action_blocked",
            "chat",
            {
              sessionId,
              runId: proactiveRunId,
              actionId: action.actionId,
              reason: resolution.reason,
            },
            {
              eventClass: "operational_signal",
              eventAuthority: "retained_stream",
              links: buildProactiveRealtimeLinks({
                sessionId,
                workspaceId: this.getSessionWorkspaceId(sessionId),
                proactiveRunId,
                durableRunId: run.runId,
                taskId: linkedTaskId,
              }),
            },
          );
          continue;
        }

        remainingHourBudget = Math.max(0, remainingHourBudget - 1);
        remainingTurnBudget = Math.max(0, remainingTurnBudget - 1);
        throwIfProactiveDurableRunAborted(context?.signal);
        executed = await this.executeProactiveToolAction(action, run.runId, context?.signal, run.leaseOwnerId);
      }
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
            ...(proactiveRun.resumeMetadata ?? {}),
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
        this.markDurableRunWaiting(
          run,
          {
            eventKey: "approval.resolved",
            correlationId: executed.approvalId,
            payload: {
              proactiveRunId,
              approvalId: executed.approvalId,
              blockedActionId: executed.actionId,
            },
          },
          {
            phase: "awaiting_approval",
            taskId: linkedTaskId,
            approvalId: executed.approvalId,
            blockedActionId: executed.actionId,
          },
        );
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

    const stopReason: ProactiveStopReason | undefined =
      failedActions.length > 0
        ? "terminal_failure"
        : blockedActions.some((action) => action.error?.includes("budget"))
          ? "budget_exhausted"
          : blockedActions.length > 0
            ? "policy_conflict"
            : executedCount > 0
              ? "completed"
              : "no_action";

    const status: ProactiveRunRecord["status"] =
      failedActions.length > 0
        ? "failed"
        : executedCount > 0
          ? "executed"
          : blockedActions.length > 0
            ? "blocked"
            : "no_action";

    const completed = this.finishProactiveDurableRun(
      run,
      proactiveRunId,
      {
        status,
        linkedTaskId,
        linkedDurableRunId: run.runId,
        approvalId: undefined,
        triggerSource: source,
        originSurface,
        stopReason,
        externalReferenceRoots: externalReferenceRoots.length > 0 ? externalReferenceRoots : undefined,
        error: failedActions[0]?.error,
      },
      {
        executedCount,
        blockedCount: blockedActions.length,
        failedCount: failedActions.length,
      },
    );

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
    this.touchSessionProactiveTick(sessionId, proactiveRunId);
    if (executedCount > 0) {
      this.publishRealtimeSafely(
        "proactive_action_executed",
        "chat",
        {
          sessionId,
          runId: proactiveRunId,
          actionCount: executedCount,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: buildProactiveRealtimeLinks({
            sessionId,
            workspaceId: this.getSessionWorkspaceId(sessionId),
            proactiveRunId,
            durableRunId: run.runId,
            taskId: linkedTaskId,
          }),
        },
      );
    }
    return completed;
  }

  async executeDurableProactiveTickRun(run: DurableRunRecord, context?: { signal?: AbortSignal }): Promise<void> {
    throwIfProactiveDurableRunAborted(context?.signal);
    if (this.ctx.isFeatureEnabled("autonomyV1Disabled")) {
      throw new Error(
        `Durable proactive tick ${run.runId} is blocked while the autonomy kill switch is engaged (autonomyV1Disabled).`,
      );
    }
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
        context,
      );
      throwIfProactiveDurableRunAborted(context?.signal);
      if (resumed !== "continue") {
        return;
      }
      run = this.updateProactiveDurableRunState(run, {
        phase: "planning",
        approvalId: undefined,
        blockedActionId: undefined,
      });
    }

    await this.continueDurableProactiveExecution(run, payload, proactiveRun, context);
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
    const pendingSuggestions = this.ctx.gatewaySql
      .prepare("SELECT COUNT(*) AS count FROM proactive_actions WHERE session_id = ? AND status = 'suggested'")
      .get(sessionId) as { count?: number } | undefined;
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
    this.publishRealtimeSafely("system", "chat", {
      type: "proactive_policy_updated",
      sessionId,
      policy,
    });
    return policy;
  }

  async triggerChatSessionProactive(sessionId: string, input: ProactiveTriggerInput = {}): Promise<ProactiveRunRecord> {
    this.callbacks.getSession(sessionId);
    const prefs = input.prefs ?? this.getSessionAutonomyPrefs(sessionId);
    const source = input.source ?? "manual";
    const originSurface = input.surface ?? this.getSessionOriginSurface(sessionId);
    const existingActiveRun = this.findActiveProactiveTickRun(sessionId);
    if (existingActiveRun) {
      return existingActiveRun;
    }
    const now = new Date().toISOString();
    const proactiveRunId = randomUUID();
    const policySnapshot = this.toProactivePolicy(sessionId, prefs);
    const backgroundAutonomousTrigger = source !== "manual";
    const permissionProfileId =
      input.permissionProfileId ?? (backgroundAutonomousTrigger ? SCHEDULED_TURN_PERMISSION_PROFILE_ID : undefined);
    const operatorId = input.operatorId ?? (backgroundAutonomousTrigger ? "system-proactive" : undefined);
    const authActorId = input.authActorId ?? operatorId;
    const authActorSource = input.authActorSource ?? (backgroundAutonomousTrigger ? "none" : undefined);
    const durableRun = this.callbacks.createDurableRun({
      workflowKey: "proactive.tick",
      payload: proactiveTickWorkflowPayloadToRecord(
        this.createProactiveTickWorkflowPayload({
          sessionId,
          proactiveRunId,
          originSurface,
          triggerSource: source,
          policySnapshot,
          requestedAt: now,
        }),
      ),
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
      executionClass: resolveProactiveExecutionClass(prefs.proactiveMode),
      resumeMetadata:
        operatorId || authActorId || authActorSource || permissionProfileId || input.localOperatorOverrideId
          ? {
              operatorId,
              authActorId,
              authActorSource,
              permissionProfileId,
              localOperatorOverrideId: input.localOperatorOverrideId,
            }
          : undefined,
      suggestedActions: [],
      executedActions: [],
      startedAt: now,
    };
    this.insertProactiveRun(initialRun);
    this.publishRealtimeSafely(
      "proactive_tick_started",
      "chat",
      {
        sessionId,
        runId: proactiveRunId,
        durableRunId: durableRun.runId,
        mode: prefs.proactiveMode,
        source,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: buildProactiveRealtimeLinks({
          sessionId,
          workspaceId: this.getSessionWorkspaceId(sessionId),
          proactiveRunId,
          durableRunId: durableRun.runId,
        }),
      },
    );
    this.callbacks.requestDurableRunProcessing(durableRun.runId);
    return this.readProactiveRun(proactiveRunId);
  }

  listChatSessionProactiveRuns(sessionId: string, limit = 50): ProactiveRunRecord[] {
    this.callbacks.getSession(sessionId);
    const rows = toProactiveRunRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM proactive_runs
      WHERE session_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `,
        )
        .all(sessionId, Math.max(1, Math.min(limit, 500))),
    );
    return rows.map(mapProactiveRunRow);
  }

  findDurableRunIdsForApproval(approvalId: string): string[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT linked_durable_run_id AS run_id
      FROM proactive_runs
      WHERE approval_id = @approvalId
        AND linked_durable_run_id IS NOT NULL
      GROUP BY linked_durable_run_id
      ORDER BY MAX(started_at) DESC
    `,
      )
      .all({ approvalId }) as Array<{ run_id: string | null }>;
    return rows.map((row) => row.run_id?.trim()).filter((value): value is string => Boolean(value));
  }
}

function mapProactiveRunRow(row: ProactiveRunRow): ProactiveRunRecord {
  const executionClass = resolveProactiveExecutionClass(row.mode);
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    linkedTaskId: row.linked_task_id ?? undefined,
    linkedDurableRunId: row.linked_durable_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    status: row.status,
    mode: row.mode,
    executionClass,
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
    suggestedActions: safeJsonParse<ProactiveActionRecord[]>(row.suggested_actions_json, []).map((action) =>
      annotateProactiveActionExecutionClass(action, row.mode),
    ),
    executedActions: safeJsonParse<ProactiveActionRecord[]>(row.executed_actions_json, []).map((action) =>
      annotateProactiveActionExecutionClass(action, row.mode),
    ),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function mapProactiveActionRow(row: ProactiveActionRow, mode?: ChatProactiveMode): ProactiveActionRecord {
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
    executionClass: mode ? resolveProactiveExecutionClass(mode) : "autonomous_durable",
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

function readProactiveToolExecutionFailure(result: ToolInvokeResult): string | undefined {
  if (
    result.outcome === "blocked" &&
    (result.internalResult?.errorKind === "execution_error" || result.policyReason.startsWith("execution error:"))
  ) {
    return result.policyReason;
  }
  if (result.outcome !== "executed" || !isRecord(result.result)) {
    return undefined;
  }
  return readToolDomainExecutionFailure(result.result, result.policyReason)?.message;
}

function readStoredProactiveToolExecutionFailure(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) {
    return undefined;
  }
  const outcome = typeof result.outcome === "string" ? result.outcome : undefined;
  const policyReason = typeof result.policyReason === "string" ? result.policyReason : "allowed";
  if (outcome && outcome !== "executed") {
    return policyReason === "allowed" ? `Approved tool action reported ${outcome}.` : policyReason;
  }
  return isRecord(result.result) ? readToolDomainExecutionFailure(result.result, policyReason)?.message : undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function proactiveTickWorkflowPayloadToRecord(payload: ProactiveTickWorkflowPayload): Record<string, unknown> {
  return {
    ...payload,
  };
}

function toProactiveRunRow(value: unknown): ProactiveRunRow | undefined {
  return isProactiveRunRow(value) ? value : undefined;
}

function toProactiveRunRows(value: unknown): ProactiveRunRow[] {
  return Array.isArray(value) ? value.filter(isProactiveRunRow) : [];
}

function toProactiveActionRow(value: unknown): ProactiveActionRow | undefined {
  return isProactiveActionRow(value) ? value : undefined;
}

function toProactiveActionRows(value: unknown): ProactiveActionRow[] {
  return Array.isArray(value) ? value.filter(isProactiveActionRow) : [];
}

function isProactiveRunRow(value: unknown): value is ProactiveRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.linked_task_id === "string" || value.linked_task_id === null) &&
    (typeof value.linked_durable_run_id === "string" || value.linked_durable_run_id === null) &&
    (typeof value.approval_id === "string" || value.approval_id === null) &&
    typeof value.status === "string" &&
    typeof value.mode === "string" &&
    (typeof value.trigger_source === "string" || value.trigger_source === null) &&
    (typeof value.origin_surface === "string" || value.origin_surface === null) &&
    typeof value.confidence === "number" &&
    (typeof value.reasoning_summary === "string" || value.reasoning_summary === null) &&
    typeof value.suggested_actions_json === "string" &&
    typeof value.executed_actions_json === "string" &&
    (typeof value.next_wake_at === "string" || value.next_wake_at === null) &&
    (typeof value.stop_reason === "string" || value.stop_reason === null) &&
    (typeof value.external_reference_roots_json === "string" || value.external_reference_roots_json === null) &&
    (typeof value.resume_metadata_json === "string" || value.resume_metadata_json === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isProactiveActionRow(value: unknown): value is ProactiveActionRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.action_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.linked_task_id === "string" || value.linked_task_id === null) &&
    (typeof value.linked_durable_run_id === "string" || value.linked_durable_run_id === null) &&
    (typeof value.approval_id === "string" || value.approval_id === null) &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    (typeof value.trigger_source === "string" || value.trigger_source === null) &&
    (typeof value.origin_surface === "string" || value.origin_surface === null) &&
    (typeof value.tool_name === "string" || value.tool_name === null) &&
    (typeof value.args_json === "string" || value.args_json === null) &&
    (typeof value.result_json === "string" || value.result_json === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.external_reference_roots_json === "string" || value.external_reference_roots_json === null) &&
    typeof value.created_at === "string" &&
    (typeof value.updated_at === "string" || value.updated_at === null)
  );
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

/**
 * Remaining seconds before an *unprompted* de-novo origination tick may fire for
 * a session (P1-F5), based on `lastProactiveAt` (the shared self-wake timestamp
 * also touched by reactive proactive + commitment + heartbeat turns) and the
 * de-novo cadence floor. Returns 0 when no prior self-wake is recorded or the
 * cadence has elapsed. This — together with the per-session cooldown and
 * active-hours — bounds de-novo so it never busy-loops on an idle session.
 */
function getDeNovoCadenceRemainingSeconds(prefs: Pick<SessionAutonomyPrefs, "lastProactiveAt">, now: Date): number {
  if (!prefs.lastProactiveAt) {
    return 0;
  }
  const elapsedSeconds = Math.floor((now.getTime() - Date.parse(prefs.lastProactiveAt)) / 1000);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds >= PROACTIVE_DE_NOVO_CADENCE_SECONDS) {
    return 0;
  }
  return Math.max(0, PROACTIVE_DE_NOVO_CADENCE_SECONDS - elapsedSeconds);
}

/** Adapt the persisted `{start,end}` active-hours window to the sweep's shape. */
function toActiveHoursWindow(activeHours: SessionActiveHoursWindow): { startHour: number; endHour: number } {
  return { startHour: activeHours.start, endHour: activeHours.end };
}

function throwIfProactiveDurableRunAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Durable proactive run aborted.");
}

import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  redactSecretText,
  type FollowThroughActionInput,
  type FollowThroughItem,
  type FollowThroughResponse,
  type ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { DEFAULT_SESSION_AUTONOMY_PREFS, type AsyncStorage } from "@goatcitadel/storage";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";
import { isWithinActiveHours } from "./gateway/commitment-sweep-service.js";
export interface FollowThroughDeps {
  storage: Pick<
    AsyncStorage,
    | "chatSessionMeta"
    | "sessions"
    | "agentCommitments"
    | "sessionAutonomyPrefs"
    | "heartbeatOccurrences"
    | "cronRuns"
    | "cronJobs"
  >;
  cron: Pick<CronAutomationService, "listCronJobs" | "setCronJobEnabled" | "runCronJobNow">;
  readFlags(): Promise<Record<string, boolean | undefined>>;
  readProactiveRuns(sessionId: string, limit: number): Promise<ProactiveRunRecord[]>;
  now?: () => Date;
  /** "waiting_for_priced_model": armed, but holding after its model was refused for having no price. */
  readHeartbeatStatus?(sessionId: string): Promise<"off" | "armed" | "waiting_for_priced_model">;
  updateHeartbeat?(input: {
    sessionId: string;
    expectedRevision: number;
    enabled?: boolean;
    heartbeatIntervalSeconds?: number;
  }): Promise<void>;
  cancelCurrentRun?(input: {
    jobId: string;
    runId: string;
    expectedRevision: number;
    workspaceId: string;
    sessionId: string;
    actorId: string;
  }): Promise<void>;
}
const safe = (value: string) => redactSecretText(value, { env: process.env }).value.slice(0, 1000);
export class FollowThroughProjectionService {
  public constructor(private readonly deps: FollowThroughDeps) {}
  public async listFollowThrough(sessionId: string, workspaceId?: string): Promise<FollowThroughResponse> {
    const [meta, session] = await Promise.all([
      this.deps.storage.chatSessionMeta.get(sessionId),
      this.deps.storage.sessions.getBySessionId(sessionId),
    ]);
    if (
      !meta ||
      meta.lifecycleStatus !== "active" ||
      meta.origin !== "operator" ||
      session.kind !== "dm" ||
      (workspaceId !== undefined && workspaceId !== meta.workspaceId)
    )
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    const flags = await this.deps.readFlags(),
      now = this.deps.now?.() ?? new Date(),
      warnings: string[] = [],
      items: FollowThroughItem[] = [];
    const prefs = await this.deps.storage.sessionAutonomyPrefs.get(sessionId),
      window = prefs?.activeHours ?? DEFAULT_SESSION_AUTONOMY_PREFS.activeHours;
    const timezone = window.tz ?? "System timezone",
      quiet = !isWithinActiveHours(now, { startHour: window.start, endHour: window.end, tz: window.tz });
    const restricted = flags.autonomyV1Disabled || !flags.durableKernelV1Enabled;
    const base = {
      timezone,
      delivery: "This conversation",
      permissionSummary: "Current policy, approvals and restricted scheduled profile apply.",
      budgetSummary: "Current installation and model budgets apply; no unlimited grant.",
      actions: [],
      ownerHref: "/work/schedules",
    } satisfies Partial<FollowThroughItem>;
    const commitments = await this.deps.storage.agentCommitments.listBySession(sessionId, 101);
    for (const row of commitments.slice(0, 100)) {
      if (row.workspaceId !== meta.workspaceId) continue;
      const run = row.scheduledRunId ? await this.deps.storage.cronRuns.get(row.scheduledRunId) : undefined;
      const unknown = run?.status === "manual_reconciliation_required";
      const state: FollowThroughItem["state"] = unknown
        ? "unknown"
        : row.status === "proposed"
          ? "awaiting_review"
          : row.status === "sent"
            ? "completed"
            : ["dismissed", "superseded"].includes(row.status)
              ? "cancelled"
              : row.status === "delivery_failed"
                ? "failed"
                : row.status === "delivery_pending"
                  ? "running"
                  : restricted || !flags.commitmentScheduledTurnsV1Enabled
                    ? "paused"
                    : quiet
                      ? "quiet"
                      : "upcoming";
      items.push({
        ...base,
        owner: { kind: "commitment", ownerId: row.commitmentId },
        revision: row.revision ?? 1,
        purpose: safe(row.suggestedText),
        state,
        nextCheckAt: row.status === "pending" ? row.dueAt : undefined,
        lastOutcome: run?.status ?? row.status,
        reason: unknown
          ? "Delivery outcome needs reconciliation. No automatic resend."
          : quiet && row.status === "pending"
            ? "Deferred until the conversation's active hours."
            : undefined,
        actions:
          row.status === "proposed"
            ? [
                { action: "accept", label: "Accept follow-up" },
                { action: "dismiss", label: "Dismiss" },
              ]
            : row.status === "pending" && !row.scheduledRunId
              ? [{ action: "dismiss", label: "Cancel follow-up" }]
              : [],
        ownerHref: `/chat?sessionId=${encodeURIComponent(sessionId)}`,
      });
    }
    let jobs: Awaited<ReturnType<CronAutomationService["listCronJobs"]>> = [];
    try {
      jobs = await this.deps.cron.listCronJobs();
    } catch {
      warnings.push("Schedules could not be read. Refresh before acting.");
    }
    const scoped = jobs.filter(
      (job) =>
        job.actionConfig?.agentTurn?.sessionId === sessionId ||
        (job.action === "task" && job.taskDestinationWorkspaceId === meta.workspaceId),
    );
    for (const job of scoped.slice(0, 100)) {
      const runId = job.activeRunId ?? job.lastRunId,
        run = runId ? await this.deps.storage.cronRuns.get(runId) : undefined;
      const unknown = Boolean(runId && !run) || run?.status === "manual_reconciliation_required";
      const config = job.actionConfig?.agentTurn,
        once = config?.oneShot,
        event = config?.eventWake;
      const executionGeneration =
        typeof job.executionGeneration === "number" &&
        Number.isSafeInteger(job.executionGeneration) &&
        job.executionGeneration >= 0
          ? job.executionGeneration
          : undefined;
      const snapshot = run?.actionSnapshot?.actionConfig as { agentTurn?: { oneShot?: { at?: unknown } } } | undefined;
      const onceFinished = Boolean(
        once &&
        snapshot?.agentTurn?.oneShot?.at === once.at &&
        run &&
        ["completed", "failed", "cancelled", "dead_lettered"].includes(run.status),
      );
      const ended = Boolean(
        job.endAt && Number.isFinite(Date.parse(job.endAt)) && Date.parse(job.endAt) <= now.getTime(),
      );
      const profileWarning =
        typeof run?.outcome?.profileWarning === "string" ? safe(run.outcome.profileWarning) : undefined;
      const state: FollowThroughItem["state"] = unknown
        ? "unknown"
        : run && ["admitting", "admitted", "running"].includes(run.status)
          ? "running"
          : run?.status === "waiting"
            ? "waiting_on_you"
            : profileWarning
              ? "awaiting_review"
              : onceFinished
                ? run?.status === "completed"
                  ? "completed"
                  : run?.status === "cancelled"
                    ? "cancelled"
                    : "failed"
                : ended
                  ? "completed"
                  : !job.enabled || restricted
                    ? "paused"
                    : profileWarning
                      ? "awaiting_review"
                      : job.lastRunStatus === "failed"
                        ? "failed"
                        : job.lastRunStatus === "skipped"
                          ? "quiet"
                          : event && quiet
                            ? "quiet"
                            : "upcoming";
      const zone = once?.timezone ?? event?.timezone ?? (job.schedule.trim().split(/\s+/).slice(5).join(" ") || "UTC");
      items.push({
        ...base,
        owner: { kind: "schedule", ownerId: job.jobId },
        revision: job.revision,
        executionGeneration,
        purpose: safe(job.description || job.name),
        state,
        timezone: zone,
        nextCheckAt:
          event || onceFinished || ended || unknown || !job.enabled || restricted
            ? undefined
            : (once?.at ?? job.nextRunAt),
        lastOutcome: run?.status ?? job.lastRunStatus,
        delivery: job.actionConfig?.agentTurn?.deliveryChannel
          ? `Channel ${safe(job.actionConfig.agentTurn.deliveryChannel.channelKey)}${job.actionConfig.agentTurn.deliveryChannel.target ? ` · ${safe(job.actionConfig.agentTurn.deliveryChannel.target)}` : ""}`
          : job.action === "task"
            ? "Work inbox"
            : "This conversation",
        activeRunId: job.activeRunId,
        actions: [
          ...(!onceFinished && !ended && (job.enabled || !profileWarning)
            ? [
                {
                  action: job.enabled ? ("pause" as const) : ("resume" as const),
                  label: job.enabled ? "Pause schedule" : "Resume schedule",
                },
              ]
            : []),
          ...(!unknown &&
          !onceFinished &&
          !ended &&
          !profileWarning &&
          !job.activeRunId &&
          job.enabled &&
          !restricted &&
          executionGeneration !== undefined
            ? [{ action: "run_now" as const, label: "Run now" }]
            : []),
          ...(this.deps.cancelCurrentRun &&
          job.activeRunId &&
          run?.runId === job.activeRunId &&
          run.phase === "chat_execution" &&
          ["admitted", "running", "waiting"].includes(run.status) &&
          run.childSessionId &&
          run.childTurnId &&
          !run.deliveryRunId &&
          !run.externalSideEffectRunId
            ? [{ action: "cancel_run" as const, label: "Stop current run" }]
            : []),
        ],
        reason: unknown
          ? !run
            ? "The last occurrence receipt is unavailable. Inspect its owner before requesting another run."
            : "Delivery outcome needs reconciliation. No automatic resend."
          : job.activeRunId
            ? "Pause prevents future occurrences. Inspect this run to stop current work safely."
            : (profileWarning ??
              (onceFinished
                ? "This one-shot is finished. Create a new follow-through for another occurrence."
                : ended
                  ? "This schedule ended. Review its timing before starting future work."
                  : event
                    ? "Runs after a verified subagent completion in this conversation. Quiet hours defer event checks."
                    : undefined)),
        ownerHref: `/work/schedules?jobId=${encodeURIComponent(job.jobId)}`,
      });
    }
    const [heartbeat, heartbeatStatus] = await Promise.all([
      this.deps.storage.heartbeatOccurrences.findUnresolved(meta.workspaceId, sessionId),
      this.deps.readHeartbeatStatus?.(sessionId) ?? Promise.resolve(prefs?.heartbeatEnabled ? "armed" : "off"),
    ]);
    const heartbeatArmed = heartbeatStatus !== "off";
    const heartbeatAvailable = !restricted && flags.proactiveHeartbeatTurnsV1Enabled === true;
    const heartbeatWaiting = heartbeatAvailable && heartbeatStatus === "waiting_for_priced_model";
    items.push({
      ...base,
      owner: { kind: "heartbeat", ownerId: sessionId },
      revision: prefs?.revision ?? 1,
      purpose: "Quiet background check",
      state:
        !heartbeatArmed || !heartbeatAvailable
          ? "paused"
          : heartbeat
            ? "running"
            : heartbeatWaiting
              ? "waiting_on_you"
              : quiet
                ? "quiet"
                : "upcoming",
      nextCheckAt:
        heartbeatArmed && heartbeatAvailable && !heartbeatWaiting && prefs?.lastProactiveAt
          ? new Date(Date.parse(prefs.lastProactiveAt) + prefs.heartbeatIntervalSeconds * 1000).toISOString()
          : undefined,
      lastOutcome: heartbeat?.state,
      permissionSummary: "Read-only heartbeat profile; notifies only when attention is needed.",
      reason: !heartbeatAvailable
        ? "Background checks are off in the installation settings."
        : !heartbeatArmed
          ? "Start checks for this conversation to get updates here."
          : heartbeatWaiting
            ? "Checks are waiting: the current model has no per-token price, so background checks can't stay within their daily budget. Switch to a priced model, or checks try again within a day."
            : undefined,
      actions:
        !heartbeatAvailable || !this.deps.updateHeartbeat
          ? []
          : [
              heartbeatArmed ? { action: "pause", label: "Pause checks" } : { action: "resume", label: "Start checks" },
              { action: "set_heartbeat_interval", label: "Save interval" },
            ],
      heartbeatIntervalSeconds:
        prefs?.heartbeatIntervalSeconds ?? DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatIntervalSeconds,
      ownerHref: heartbeatAvailable
        ? `/chat?sessionId=${encodeURIComponent(sessionId)}#background`
        : "/settings/advanced#feature-switches",
    });
    try {
      const last = (await this.deps.readProactiveRuns(sessionId, 1))[0];
      items.push({
        ...base,
        owner: { kind: "proactive", ownerId: sessionId },
        revision: prefs?.revision ?? 1,
        purpose: "Proactive assistance",
        state: !prefs || prefs.proactiveMode === "off" || restricted ? "paused" : quiet ? "quiet" : "upcoming",
        lastOutcome: last?.status,
        permissionSummary: prefs
          ? `${prefs.proactiveMode}; at most ${prefs.maxActionsPerHour} actions/hour, ${prefs.maxActionsPerTurn} per turn.`
          : "Off until configured for this conversation.",
        ownerHref: `/chat?sessionId=${encodeURIComponent(sessionId)}#background`,
      });
    } catch {
      warnings.push("The last proactive outcome is unavailable.");
    }
    return {
      version: 1,
      sessionId,
      workspaceId: meta.workspaceId,
      items,
      warnings,
      truncated: commitments.length > 100 || scoped.length > 100,
    };
  }
  public async requestFollowThroughAction(
    input: FollowThroughActionInput,
    actorId = "operator",
  ): Promise<FollowThroughResponse> {
    const current = await this.listFollowThrough(input.sessionId, input.workspaceId),
      item = current.items.find(
        (item) => item.owner.kind === input.owner.kind && item.owner.ownerId === input.owner.ownerId,
      );
    if (input.owner.kind === "schedule" && input.action === "run_now") {
      if (!Number.isSafeInteger(input.expectedExecutionGeneration) || input.expectedExecutionGeneration! < 0)
        throw new ConflictError({ message: "Review the current execution generation before requesting Run now." });
      if (!item || !input.operationId || !/^[a-zA-Z0-9_-]{16,100}$/u.test(input.operationId))
        throw new ConflictError({ message: "Refresh this follow-through and prepare an exact Run now request." });
      const job = await this.deps.storage.cronJobs.get(input.owner.ownerId),
        once = job?.actionConfig?.agentTurn?.oneShot;
      const admissionKey = `operator-follow-through:${createHash("sha256")
        .update(JSON.stringify([actorId, input.operationId]))
        .digest("hex")}`;
      const lookupKey = once ? `one-shot:${once.at}` : admissionKey;
      const existing = await this.deps.storage.cronRuns.getByAdmission(input.owner.ownerId, lookupKey);
      const operatorAction = {
        actorId,
        operationId: input.operationId,
        expectedExecutionGeneration: input.expectedExecutionGeneration!,
      };
      const receipt = (run: NonNullable<typeof existing>): FollowThroughResponse => {
        const binding = run.actionSnapshot.operatorAction as typeof operatorAction | undefined;
        const exact =
          binding?.actorId === actorId &&
          binding.operationId === input.operationId &&
          binding.expectedExecutionGeneration === input.expectedExecutionGeneration;
        if (
          run.jobId !== input.owner.ownerId ||
          run.jobRevision !== input.expectedRevision ||
          run.executionGeneration !== input.expectedExecutionGeneration! + 1 ||
          (!once && !exact)
        )
          throw new ConflictError({
            message: "This run identity belongs to a different reviewed execution. Inspect its recorded owner.",
          });
        return {
          ...current,
          actionReceipt: {
            operationId: input.operationId!,
            runId: run.runId,
            state: run.status,
            disposition: exact ? "recorded" : "existing_occurrence",
          },
        };
      };
      if (existing) return receipt(existing);
      if (
        item.revision !== input.expectedRevision ||
        item.executionGeneration !== input.expectedExecutionGeneration ||
        !item.actions.some((action) => action.action === "run_now")
      )
        throw new ConflictError({ message: "This schedule or execution changed. Refresh before requesting new work." });
      await this.deps.cron.runCronJobNow(input.owner.ownerId, {
        expectedRevision: input.expectedRevision,
        expectedExecutionGeneration: input.expectedExecutionGeneration,
        admissionKey,
        operatorAction,
      });
      const recorded = await this.deps.storage.cronRuns.getByAdmission(input.owner.ownerId, lookupKey);
      if (!recorded)
        throw new ConflictError({
          message: "The occurrence receipt is unavailable. Keep this exact request and inspect the recorded owner.",
        });
      return {
        ...(await this.listFollowThrough(input.sessionId, input.workspaceId)),
        actionReceipt: receipt(recorded).actionReceipt,
      };
    }
    if (
      !item ||
      item.revision !== input.expectedRevision ||
      !item.actions.some((action) => action.action === input.action)
    )
      throw new ConflictError({
        message: "This follow-through action changed or is unavailable. Refresh and review its current owner.",
      });
    if (input.owner.kind === "commitment" && (input.action === "accept" || input.action === "dismiss"))
      await this.deps.storage.agentCommitments.decideSuggestion({
        commitmentId: input.owner.ownerId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        expectedRevision: input.expectedRevision,
        decision: input.action,
      });
    else if (
      input.owner.kind === "heartbeat" &&
      this.deps.updateHeartbeat &&
      (input.action === "pause" || input.action === "resume" || input.action === "set_heartbeat_interval")
    ) {
      if (
        input.action === "set_heartbeat_interval" &&
        (!Number.isSafeInteger(input.heartbeatIntervalSeconds) ||
          input.heartbeatIntervalSeconds! < 900 ||
          input.heartbeatIntervalSeconds! > 86_400)
      )
        throw new ConflictError({ message: "Choose a background check interval from 15 minutes to 24 hours." });
      await this.deps.updateHeartbeat({
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        ...(input.action === "set_heartbeat_interval"
          ? { heartbeatIntervalSeconds: input.heartbeatIntervalSeconds }
          : { enabled: input.action === "resume" }),
      });
    } else if (input.owner.kind === "schedule" && ["pause", "resume"].includes(input.action))
      await this.deps.cron.setCronJobEnabled(input.owner.ownerId, input.action === "resume", input.expectedRevision);
    else if (input.owner.kind === "schedule" && input.action === "cancel_run") {
      if (!input.expectedRunId || input.expectedRunId !== item.activeRunId || !this.deps.cancelCurrentRun)
        throw new ConflictError({ message: "The active occurrence changed. Refresh before stopping it." });
      await this.deps.cancelCurrentRun({
        jobId: input.owner.ownerId,
        runId: input.expectedRunId,
        expectedRevision: input.expectedRevision,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        actorId,
      });
    } else throw new ConflictError({ message: "Open the canonical owner to review this action." });
    return this.listFollowThrough(input.sessionId, input.workspaceId);
  }
}

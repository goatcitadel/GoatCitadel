import type { CronAgentTurnConfig, CronJobRecord } from "@goatcitadel/contracts";

/**
 * Outcome returned by the gateway-provided agent-turn run handler. The handler
 * ensures/reuses the cron session, persists the user message + turn trace, and
 * enqueues the `chat.turn.execute` durable run (or falls back to the inert
 * inbox task). The support module only records cron bookkeeping around it.
 */
export interface AgentTurnCronRunOutcome {
  /** "agent_turn" when the model was woken; "inbox" when the inert fallback ran. */
  mode: "agent_turn" | "inbox";
  /** Durable run id of the enqueued chat.turn.execute run (agent_turn mode). */
  durableRunId?: string;
  /** Session the scheduled turn ran in (agent_turn mode). */
  sessionId?: string;
  /** Turn id of the scheduled turn (agent_turn mode). */
  turnId?: string;
  /** Task id of the inert inbox record (inbox fallback mode). */
  taskId?: string;
}

export type AgentTurnCronRunHandler = (input: {
  job: CronJobRecord;
  runId: string;
  config: CronAgentTurnConfig;
}) => Promise<AgentTurnCronRunOutcome>;

/**
 * Normalize + validate the `agent_turn` action config. Rejects an empty prompt
 * so a scheduled turn never wakes the model with nothing to do. Mirrors the
 * shape and immutability of `normalizeNoAgentCronActionConfig`.
 */
export function normalizeAgentTurnCronActionConfig(
  rawValue: Record<string, unknown>,
): CronJobRecord["actionConfig"] {
  const rawAgentTurn =
    rawValue.agentTurn && typeof rawValue.agentTurn === "object" && !Array.isArray(rawValue.agentTurn)
      ? (rawValue.agentTurn as Record<string, unknown>)
      : undefined;
  if (!rawAgentTurn || typeof rawAgentTurn.prompt !== "string" || !rawAgentTurn.prompt.trim()) {
    throw new Error("agent_turn cron job requires a non-empty actionConfig.agentTurn.prompt.");
  }
  const sessionId =
    typeof rawAgentTurn.sessionId === "string" && rawAgentTurn.sessionId.trim()
      ? rawAgentTurn.sessionId.trim()
      : undefined;
  const rawChannel =
    rawAgentTurn.deliveryChannel &&
    typeof rawAgentTurn.deliveryChannel === "object" &&
    !Array.isArray(rawAgentTurn.deliveryChannel)
      ? (rawAgentTurn.deliveryChannel as Record<string, unknown>)
      : undefined;
  const deliveryChannel =
    rawChannel && typeof rawChannel.channelKey === "string" && rawChannel.channelKey.trim()
      ? {
          channelKey: rawChannel.channelKey.trim(),
          ...(typeof rawChannel.target === "string" && rawChannel.target.trim()
            ? { target: rawChannel.target.trim() }
            : {}),
        }
      : undefined;
  const deliverMode = rawAgentTurn.deliverMode === "on_notify" ? "on_notify" : "always";
  const inertInboxFallback = rawAgentTurn.inertInboxFallback === true;
  const createdBy = normalizeAgentTurnCreatedBy(rawAgentTurn.createdBy);
  return {
    agentTurn: {
      prompt: rawAgentTurn.prompt.trim(),
      ...(sessionId ? { sessionId } : {}),
      ...(deliveryChannel ? { deliveryChannel } : {}),
      deliverMode,
      ...(inertInboxFallback ? { inertInboxFallback: true } : {}),
      ...(createdBy ? { createdBy } : {}),
    },
  };
}

/**
 * Normalize the creator-provenance block stamped by `schedule.manage` (P1-F2).
 * Preserves only string actor/profile/job ids and a clamped non-negative depth,
 * so the scheduled turn can be fired bounded to ≤ the creator's privileges and
 * the depth-1 anti-recursion cap can be enforced. Returns undefined when the
 * block carries nothing useful. Immutable: builds a fresh object.
 */
function normalizeAgentTurnCreatedBy(
  value: unknown,
): NonNullable<CronAgentTurnConfig["createdBy"]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const operatorId = typeof raw.operatorId === "string" && raw.operatorId.trim() ? raw.operatorId.trim() : undefined;
  const authActorId =
    typeof raw.authActorId === "string" && raw.authActorId.trim() ? raw.authActorId.trim() : undefined;
  const permissionProfileId =
    typeof raw.permissionProfileId === "string" && raw.permissionProfileId.trim()
      ? raw.permissionProfileId.trim()
      : undefined;
  const createdByJobId =
    typeof raw.createdByJobId === "string" && raw.createdByJobId.trim() ? raw.createdByJobId.trim() : undefined;
  const depth =
    typeof raw.depth === "number" && Number.isFinite(raw.depth) ? Math.max(0, Math.floor(raw.depth)) : undefined;
  if (!operatorId && !authActorId && !permissionProfileId && !createdByJobId && depth === undefined) {
    return undefined;
  }
  return {
    ...(operatorId ? { operatorId } : {}),
    ...(authActorId ? { authActorId } : {}),
    ...(permissionProfileId ? { permissionProfileId } : {}),
    ...(createdByJobId ? { createdByJobId } : {}),
    ...(depth !== undefined ? { depth } : {}),
  };
}

/**
 * Run a scheduled `agent_turn` cron job: dispatch the gateway handler (which
 * wakes the model or files the inert inbox fallback), then record the cron run
 * success / next-run window and emit the realtime event — mirroring
 * `runNoAgentCronJob`. Immutable: never mutates the input job.
 */
export async function runAgentTurnCronJob(input: {
  job: CronJobRecord;
  normalizedJobId: string;
  runId: string;
  runHandler: AgentTurnCronRunHandler;
  upsertCronJob: (job: CronJobRecord, updatedAt: string) => CronJobRecord;
  persistCronJobsConfig: () => void;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  computeNextCronRunAt: (schedule: string, from: Date, endAt?: string) => string | undefined;
}): Promise<Record<string, unknown>> {
  const agentTurnConfig = input.job.actionConfig?.agentTurn;
  if (!agentTurnConfig?.prompt?.trim()) {
    throw new Error(`agent_turn cron job missing prompt: ${input.normalizedJobId}`);
  }
  const outcome = await input.runHandler({
    job: input.job,
    runId: input.runId,
    config: agentTurnConfig,
  });
  const finishedAt = new Date().toISOString();
  const saved = input.upsertCronJob(
    {
      ...input.job,
      lastRunAt: finishedAt,
      lastRunId: input.runId,
      lastRunStatus: "ok",
      lastFailureAt: undefined,
      lastFailure: undefined,
      failureCount: 0,
      backoffUntil: undefined,
      nextRunAt: input.computeNextCronRunAt(input.job.schedule, new Date(finishedAt), input.job.endAt),
    },
    finishedAt,
  );
  input.persistCronJobsConfig();
  input.publishRealtime("cron_job_run", "cron", {
    type: outcome.mode === "agent_turn" ? "cron_agent_turn_enqueued" : "scheduled_task_created",
    jobId: saved.jobId,
    name: saved.name,
    runId: input.runId,
    ...(outcome.durableRunId ? { durableRunId: outcome.durableRunId } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
    ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
    ...(agentTurnConfig.deliveryChannel ? { deliveryChannel: agentTurnConfig.deliveryChannel } : {}),
  });
  return {
    action: input.job.action,
    runId: input.runId,
    mode: outcome.mode,
    ...(outcome.durableRunId ? { durableRunId: outcome.durableRunId } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
    ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
    nextRunAt: saved.nextRunAt,
  };
}

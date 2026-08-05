import type {
  CronAgentTurnConfig,
  CronJobRecord,
  CronRunExecutionToken,
  CronRunLinkage,
  CronRunRecord,
} from "@goatcitadel/contracts";

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
  /** Persisted user-message id of the scheduled turn (agent_turn mode). */
  userMessageId?: string;
  /** Reserved assistant-message id of the scheduled turn (agent_turn mode). */
  assistantMessageId?: string;
  /** Effective scheduled profile posture used for this run. */
  profilePosture?:
    | "scheduled_restricted"
    | "creator_intersection"
    | "creator_profile_missing"
    | "creator_profile_archived"
    | "creator_profile_scope_mismatch"
    | "creator_profile_invalid";
  /** Warning recorded when profile provenance fails closed into the inert inbox fallback. */
  profileWarning?: string;
  /** Task id of the inert inbox record (inbox fallback mode). */
  taskId?: string;
}

export type AgentTurnCronRunHandler = (input: {
  job: CronJobRecord;
  runId: string;
  config: CronAgentTurnConfig;
  cronRun: CronRunExecutionToken;
}) => Promise<AgentTurnCronRunOutcome>;

/**
 * Normalize + validate the `agent_turn` action config. Rejects an empty prompt
 * so a scheduled turn never wakes the model with nothing to do. Mirrors the
 * shape and immutability of `normalizeNoAgentCronActionConfig`.
 */
export function normalizeAgentTurnCronActionConfig(rawValue: Record<string, unknown>): CronJobRecord["actionConfig"] {
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
 * so ownership/audit and the depth-1 anti-recursion cap can be enforced. Fired
 * scheduled turns still use the restricted autonomous profile until explicit
 * profile intersection exists. Returns undefined when the block carries nothing
 * useful. Immutable: builds a fresh object.
 */
function normalizeAgentTurnCreatedBy(value: unknown): NonNullable<CronAgentTurnConfig["createdBy"]> | undefined {
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
 * Admit a scheduled `agent_turn` child under the canonical cron execution
 * token. Enqueue/attachment is deliberately non-terminal: the automation
 * owner settles the cron occurrence only after observing the durable child.
 * Immutable: never mutates the input job.
 */
export async function runAgentTurnCronJob(input: {
  job: CronJobRecord;
  normalizedJobId: string;
  runId: string;
  cronRun: CronRunExecutionToken;
  runHandler: AgentTurnCronRunHandler;
  attachDeterministicChild: (
    token: CronRunExecutionToken,
    linkage: CronRunLinkage,
    attachedAt: string,
  ) => CronRunRecord | undefined | Promise<CronRunRecord | undefined>;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  if (
    input.cronRun.runId !== input.runId ||
    input.cronRun.jobId !== input.job.jobId ||
    !Number.isSafeInteger(input.cronRun.executionGeneration) ||
    input.cronRun.executionGeneration < 1
  ) {
    throw new Error(`Canonical cron execution token does not own ${input.job.jobId}/${input.runId}.`);
  }
  const agentTurnConfig = input.job.actionConfig?.agentTurn;
  if (!agentTurnConfig?.prompt?.trim()) {
    throw new Error(`agent_turn cron job missing prompt: ${input.normalizedJobId}`);
  }
  const outcome = await input.runHandler({
    job: input.job,
    runId: input.runId,
    config: agentTurnConfig,
    cronRun: input.cronRun,
  });
  const attachedAt = new Date().toISOString();
  let attached: CronRunRecord | undefined;
  if (outcome.mode === "agent_turn") {
    const linkage = requireDeterministicAgentTurnLinkage(input.cronRun, outcome);
    attached = await input.attachDeterministicChild(input.cronRun, linkage, attachedAt);
    if (!attached) {
      throw new Error(
        `Cron run ${input.cronRun.runId} lost execution ownership before deterministic child attachment.`,
      );
    }
  }
  const summary = {
    action: input.job.action,
    runId: input.runId,
    mode: outcome.mode,
    status: outcome.mode === "agent_turn" ? "admitted" : "inbox_created",
    ...(outcome.durableRunId ? { durableRunId: outcome.durableRunId, childDurableRunId: outcome.durableRunId } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.userMessageId ? { userMessageId: outcome.userMessageId, childMessageId: outcome.userMessageId } : {}),
    ...(outcome.turnId ? { turnId: outcome.turnId, childTurnId: outcome.turnId } : {}),
    ...(outcome.assistantMessageId
      ? { assistantMessageId: outcome.assistantMessageId, childAssistantMessageId: outcome.assistantMessageId }
      : {}),
    ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
    ...(outcome.profilePosture ? { profilePosture: outcome.profilePosture } : {}),
    ...(outcome.profileWarning ? { profileWarning: outcome.profileWarning, cronReviewWarning: true } : {}),
  };
  await input.publishRealtime("cron_job_run", "cron", {
    type: outcome.mode === "agent_turn" ? "cron_agent_turn_admitted" : "scheduled_task_created",
    jobId: input.job.jobId,
    name: input.job.name,
    runId: input.runId,
    executionGeneration: input.cronRun.executionGeneration,
    ...(outcome.durableRunId ? { durableRunId: outcome.durableRunId, childDurableRunId: outcome.durableRunId } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.turnId ? { turnId: outcome.turnId, childTurnId: outcome.turnId } : {}),
    ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
    ...(outcome.profilePosture ? { profilePosture: outcome.profilePosture } : {}),
    ...(outcome.profileWarning ? { profileWarning: outcome.profileWarning } : {}),
    ...(agentTurnConfig.deliveryChannel ? { deliveryChannel: agentTurnConfig.deliveryChannel } : {}),
  });
  return summary;
}

function requireDeterministicAgentTurnLinkage(
  token: CronRunExecutionToken,
  outcome: AgentTurnCronRunOutcome,
): Required<
  Pick<
    CronRunLinkage,
    "childSessionId" | "childMessageId" | "childTurnId" | "childAssistantMessageId" | "childDurableRunId"
  >
> {
  const linkage = {
    childSessionId: outcome.sessionId?.trim(),
    childMessageId: outcome.userMessageId?.trim(),
    childTurnId: outcome.turnId?.trim(),
    childAssistantMessageId: outcome.assistantMessageId?.trim(),
    childDurableRunId: outcome.durableRunId?.trim(),
  };
  const missing = Object.entries(linkage)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Deterministic cron child ${token.runId} is missing required linkage: ${missing.join(", ")}.`);
  }
  return {
    childSessionId: linkage.childSessionId!,
    childMessageId: linkage.childMessageId!,
    childTurnId: linkage.childTurnId!,
    childAssistantMessageId: linkage.childAssistantMessageId!,
    childDurableRunId: linkage.childDurableRunId!,
  };
}

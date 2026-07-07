import { createHash, randomUUID } from "node:crypto";
import type {
  ChatSendMessageRequest,
  CronAgentTurnConfig,
  CronJobRecord,
  PermissionProfileRecord,
  TaskRecord,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { AgentTurnCronRunOutcome } from "./gateway/cron-agent-turn-support.js";
import {
  type AutonomousTurnKind,
  buildAutonomousTurnContext,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
} from "./gateway/autonomous-turn-policy.js";
import {
  buildCommitmentCheckInPrompt,
  runCommitmentSweep as runCommitmentSweepCore,
} from "./gateway/commitment-sweep-service.js";
import {
  buildScheduledCreatorIntersectionProfile,
  permissionProfileAppliesToCreator,
} from "./gateway/scheduled-profile-intersection.js";
import { runHeartbeatTick } from "./gateway/heartbeat-service.js";
import {
  buildScheduleCreateActionConfig,
  isScheduledTurnContext,
  parseScheduleManageArgs,
  resolveScheduleCreatorKey,
  summarizeScheduleJob,
  validateScheduleCreate,
} from "./gateway/schedule-tool-support.js";
import * as chatDurableRunService from "./chat-durable-run-service.js";
import * as chatTurnPrepService from "./chat-turn-prep-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";

/**
 * Autonomous chat-turn execution (B8b extraction): the cron `agent_turn`
 * runner, commitment/heartbeat maintenance sweeps, the shared autonomous-turn
 * enqueue path, and the model-callable `schedule.manage` runtime hook.
 * Verbatim moves from GatewayService behind a narrow deps port — the gateway
 * keeps thin delegators (its facade tests drive them unchanged) plus the
 * synthetic-profile registry, which the interactive policy path also owns.
 */

const DEFAULT_WORKSPACE_ID = "default";

type HeartbeatTickDeps = Parameters<typeof runHeartbeatTick>[0];
type CommitmentSweepCoreDeps = Parameters<typeof runCommitmentSweepCore>[0];
type DurableRunForTrace = Parameters<typeof chatDurableRunService.persistInitialDurableChatTurnTrace>[3];

export interface ChatAutonomousTurnDeps {
  storage: Pick<
    Storage,
    | "agentCommitments"
    | "chatSessionBindings"
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "chatTurnTraces"
    | "permissionProfiles"
    | "sessions"
    | "runImmediateTransaction"
  >;
  cron: Pick<CronAutomationService, "listCronJobs" | "getCronJob" | "deleteCronJob" | "createCronJob">;
  isFeatureEnabled(flag: "autonomyV1Disabled" | "durableKernelV1Enabled"): boolean;
  createCronInboxTask(job: CronJobRecord): TaskRecord;
  getSessionAutonomyPrefs: HeartbeatTickDeps["getSessionAutonomyPrefs"];
  patchSessionAutonomyPrefs(sessionId: string, patch: { proactiveMode: "off" }): void;
  listChatSessions(query: { scope: "mission"; view: "active"; limit?: number }): Array<{
    sessionId: string;
    lastActivityAt: string;
  }>;
  getSessionIdleSeconds: HeartbeatTickDeps["getSessionIdleSeconds"];
  hasRunningTurn(sessionId: string): boolean;
  isReplayScratchSession(sessionId: string): boolean;
  getSession(sessionId: string): unknown;
  normalizeWorkspaceId(workspaceId: string | undefined): string;
  ensureChatSessionRuntimeGrants(sessionId: string): void;
  listConnectorRecords(kind: "integration_connection"): Array<{
    status: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }>;
  listToolCatalog(): Array<{ toolName: string }>;
  registerSyntheticPermissionProfile(profile: PermissionProfileRecord): void;
  prepareAgentChatTurn(
    sessionId: string,
    request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext },
    options: { ingestUserMessage: boolean },
  ): Promise<PreparedAgentChatTurn>;
  buildDurableChatTurnPayloadRecord(
    prepared: PreparedAgentChatTurn,
    request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext },
  ): Record<string, unknown>;
  createDurableRun(input: {
    workflowKey: "chat.turn.execute";
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): DurableRunForTrace & { runId: string };
  persistChatStreamChunk(
    chunk: {
      type: "message_start";
      sessionId: string;
      turnId: string;
      messageId: string;
      parentTurnId: PreparedAgentChatTurn["parentTurnId"];
      branchKind: PreparedAgentChatTurn["branchKind"];
      sourceTurnId: PreparedAgentChatTurn["sourceTurnId"];
    },
    runId: string,
  ): unknown;
  requestDurableRunProcessing(runId: string): void;
}

export async function runCronAgentTurn(
  deps: ChatAutonomousTurnDeps,
  input: {
    job: CronJobRecord;
    runId: string;
    config: CronAgentTurnConfig;
  },
): Promise<AgentTurnCronRunOutcome> {
  const autonomyDisabled = deps.isFeatureEnabled("autonomyV1Disabled");
  if (autonomyDisabled || input.config.inertInboxFallback) {
    const task = deps.createCronInboxTask(input.job);
    return { mode: "inbox", taskId: task.taskId };
  }
  const sessionId = ensureCronAgentSession(deps, input.job.jobId, input.config.sessionId);
  const createdBy = input.config.createdBy;
  const systemActorId = createdBy?.operatorId?.trim() || createdBy?.authActorId?.trim() || "system-cron";
  const scheduledPolicy = resolveScheduledAgentTurnPolicy(deps, {
    config: input.config,
    jobId: input.job.jobId,
    runId: input.runId,
    sessionId,
    systemActorId,
  });
  if ("failClosedReason" in scheduledPolicy) {
    const task = deps.createCronInboxTask(input.job);
    return {
      mode: "inbox",
      taskId: task.taskId,
      profilePosture: scheduledPolicy.profilePosture,
      profileWarning: scheduledPolicy.failClosedReason,
    };
  }
  const run = await enqueueAutonomousChatTurn(deps, {
    sessionId,
    prompt: input.config.prompt,
    runId: input.runId,
    systemActorId,
    reason: `cron agent_turn:${input.job.jobId}`,
    deliveryChannel: input.config.deliveryChannel,
    deliverMode: input.config.deliverMode ?? "always",
    policyContext: scheduledPolicy.policyContext,
    profilePosture: scheduledPolicy.profilePosture,
  });
  return {
    mode: "agent_turn",
    durableRunId: run?.runId,
    sessionId,
    turnId: run?.turnId,
    profilePosture: scheduledPolicy.profilePosture,
  };
}

/**
 * Maintenance-tick commitment sweep (P1-F3). Delivers due + pending inferred
 * check-ins (oldest-due first) as autonomous (restricted-profile) turns seeded
 * with the suggested text, respecting per-session cooldown + active-hours, then
 * marks them delivery-pending. No-op while the master autonomy switch is off
 * or durable execution is disabled (the delivery path requires a durable run).
 * Superseded / dismissed / already-queued rows are excluded by `listDue`
 * (pending-only).
 */
export async function runCommitmentSweep(deps: ChatAutonomousTurnDeps): Promise<void> {
  if (deps.isFeatureEnabled("autonomyV1Disabled") || !deps.isFeatureEnabled("durableKernelV1Enabled")) {
    return;
  }
  await runCommitmentSweepCore({
    isAutonomyEnabled: () => !deps.isFeatureEnabled("autonomyV1Disabled"),
    listDueCommitments: (nowIso, limit) => deps.storage.agentCommitments.listDue(nowIso, limit),
    getSessionAutonomyPrefs: (sessionId) => deps.getSessionAutonomyPrefs(sessionId),
    deliverCommitment: async (commitment) => {
      const deliveryChannel = resolveCommitmentDeliveryChannel(deps, commitment.sessionId);
      if (!deliveryChannel) {
        return false;
      }
      const run = await enqueueAutonomousChatTurn(deps, {
        sessionId: commitment.sessionId,
        prompt: buildCommitmentCheckInPrompt(commitment.suggestedText),
        runId: `commitment_${commitment.commitmentId}`,
        systemActorId: "system-commitment",
        reason: `commitment check-in:${commitment.commitmentId}`,
        deliveryChannel,
        deliverMode: "always",
        commitmentId: commitment.commitmentId,
      });
      return Boolean(run?.runId);
    },
    markDeliveryPending: (commitmentId) => deps.storage.agentCommitments.markDeliveryPending(commitmentId),
    markDeliveryFailed: (commitmentId) => deps.storage.agentCommitments.markDeliveryFailed(commitmentId),
  } satisfies CommitmentSweepCoreDeps);
}

function resolveCommitmentDeliveryChannel(
  deps: ChatAutonomousTurnDeps,
  sessionId: string,
): CronAgentTurnConfig["deliveryChannel"] | undefined {
  const binding = deps.storage.chatSessionBindings.get(sessionId);
  if (
    !binding ||
    binding.transport !== "integration" ||
    !binding.writable ||
    !binding.connectionId ||
    !binding.target
  ) {
    return undefined;
  }
  const connector = deps
    .listConnectorRecords("integration_connection")
    .find((item) => item.status === "active" && item.sourceId === binding.connectionId);
  const channelKey = typeof connector?.metadata?.key === "string" ? connector.metadata.key.trim() : "";
  const target = binding.target.trim();
  if (!channelKey || !target) {
    return undefined;
  }
  return { channelKey, target };
}

/**
 * Maintenance-tick heartbeat sweep (P1-F4). For each eligible idle session,
 * fires a single silent self-wake turn under the read-only `heartbeat-restricted`
 * profile with `deliverMode:"on_notify"` — the turn stays silent unless it emits
 * `{notify:true}`. Multi-gate rate limiting (heartbeat-enabled × eligibility ×
 * active-hours × idle floor × no-running-turn × cooldown × interval) lives in the
 * pure `runHeartbeatTick`. No-op while the master autonomy switch is off or
 * durable execution is disabled (the turn path requires a durable run).
 * Eval-integrity / non-human / replay-scratch sessions are excluded.
 */
export async function runHeartbeatSweep(deps: ChatAutonomousTurnDeps): Promise<void> {
  if (deps.isFeatureEnabled("autonomyV1Disabled") || !deps.isFeatureEnabled("durableKernelV1Enabled")) {
    return;
  }
  await runHeartbeatTick({
    isAutonomyEnabled: () => !deps.isFeatureEnabled("autonomyV1Disabled"),
    listSessions: (limit) =>
      deps.listChatSessions({ scope: "mission", view: "active", limit }).map((session) => ({
        sessionId: session.sessionId,
        lastActivityAt: session.lastActivityAt,
      })),
    getSessionAutonomyPrefs: (sessionId) => deps.getSessionAutonomyPrefs(sessionId),
    isHeartbeatEligibleSession: (sessionId) => isHeartbeatEligibleSession(deps, sessionId),
    getSessionIdleSeconds: (sessionId) => deps.getSessionIdleSeconds(sessionId),
    hasRunningTurn: (sessionId) => deps.hasRunningTurn(sessionId),
    enqueueHeartbeatTurn: async ({ sessionId, prompt }) => {
      const run = await enqueueAutonomousChatTurn(deps, {
        sessionId,
        prompt,
        // Collision-resistant: `Date.now()` could repeat within a tick across
        // sessions/retries; a UUID guarantees a unique durable run id.
        runId: `heartbeat_${randomUUID()}`,
        systemActorId: "system-heartbeat",
        reason: `heartbeat self-wake:${sessionId}`,
        kind: "heartbeat",
        deliverMode: "on_notify",
      });
      return Boolean(run?.runId);
    },
  });
}

/**
 * Whether a session may receive silent heartbeats. Mirrors the human-session /
 * eval-integrity guard used for the commitment classifier: skip `system` and
 * `prompt_pack` origins and replay-scratch sessions (safety invariant:
 * eval-integrity turns are never affected).
 */
export function isHeartbeatEligibleSession(deps: ChatAutonomousTurnDeps, sessionId: string): boolean {
  const origin = deps.storage.chatSessionMeta.get(sessionId)?.origin;
  if (origin === "system" || origin === "prompt_pack") {
    return false;
  }
  return !deps.isReplayScratchSession(sessionId);
}

/**
 * Resolve a stable cron session for an `agent_turn` job. Reuses an explicitly
 * configured session id when present, otherwise derives a deterministic
 * per-job session and creates it (proactiveMode off, system origin) if it does
 * not yet exist. Immutable: reuses existing rows; only creates when missing.
 */
function ensureCronAgentSession(deps: ChatAutonomousTurnDeps, jobId: string, configuredSessionId?: string): string {
  const explicit = configuredSessionId?.trim();
  if (explicit && deps.getSession(explicit)) {
    return explicit;
  }
  const peer = `cron_${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}`;
  const sessionKey = `mission:scheduler:${peer}`;
  const sessionId = `sess_${createHash("sha256").update(sessionKey).digest("hex").slice(0, 24)}`;
  if (deps.getSession(sessionId)) {
    return sessionId;
  }
  const now = new Date().toISOString();
  const workspaceId = deps.normalizeWorkspaceId(undefined);
  deps.storage.runImmediateTransaction(() => {
    deps.storage.sessions.upsert({
      sessionId,
      sessionKey,
      kind: "dm",
      channel: "mission",
      account: "scheduler",
      displayName: `Cron ${jobId}`,
      timestamp: now,
    });
    deps.storage.chatSessionMeta.ensure(sessionId, now, workspaceId);
    deps.storage.chatSessionPrefs.ensure(sessionId, now);
    deps.storage.chatSessionMeta.patch(
      sessionId,
      { workspaceId, title: `Cron ${jobId}`, origin: "system", includeInHistory: false },
      now,
    );
    deps.storage.chatSessionBindings.upsert({ sessionId, workspaceId, transport: "llm", writable: true }, now);
  });
  deps.ensureChatSessionRuntimeGrants(sessionId);
  deps.patchSessionAutonomyPrefs(sessionId, { proactiveMode: "off" });
  return sessionId;
}

function resolveScheduledAgentTurnPolicy(
  deps: ChatAutonomousTurnDeps,
  input: {
    config: CronAgentTurnConfig;
    jobId: string;
    runId: string;
    sessionId: string;
    systemActorId: string;
  },
):
  | { policyContext: ToolPolicyActorContext; profilePosture: "scheduled_restricted" | "creator_intersection" }
  | {
      profilePosture:
        | "creator_profile_missing"
        | "creator_profile_archived"
        | "creator_profile_scope_mismatch"
        | "creator_profile_invalid";
      failClosedReason: string;
    } {
  const base = buildAutonomousTurnContext({
    kind: "scheduled",
    systemActorId: input.systemActorId,
    runId: input.runId,
    sessionId: input.sessionId,
  });
  const createdBy = input.config.createdBy;
  if (!createdBy) {
    return { policyContext: base.policyContext, profilePosture: "scheduled_restricted" };
  }
  const creatorProfileId = createdBy.permissionProfileId?.trim();
  if (!creatorProfileId) {
    return {
      profilePosture: "creator_profile_missing",
      failClosedReason: `Scheduled agent_turn ${input.jobId} was created by a model/tool call without permission profile provenance.`,
    };
  }

  const workspaceId = deps.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  let creatorProfile: PermissionProfileRecord;
  try {
    creatorProfile = deps.storage.permissionProfiles.getProfile(creatorProfileId);
  } catch (error) {
    return {
      profilePosture: "creator_profile_missing",
      failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (creatorProfile.status !== "active") {
    return {
      profilePosture: "creator_profile_archived",
      failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is not active.`,
    };
  }
  const creatorActorId = createdBy.operatorId?.trim() || createdBy.authActorId?.trim();
  if (!permissionProfileAppliesToCreator({ profile: creatorProfile, creatorActorId, workspaceId })) {
    return {
      profilePosture: "creator_profile_scope_mismatch",
      failClosedReason: `Scheduled agent_turn ${input.jobId} creator profile ${creatorProfileId} is no longer active for the creator/workspace scope.`,
    };
  }

  const profile = buildScheduledCreatorIntersectionProfile({
    creatorProfile,
    runId: input.runId,
    knownToolNames: deps.listToolCatalog().map((tool) => tool.toolName),
  });
  return {
    profilePosture: "creator_intersection",
    policyContext: {
      ...base.policyContext,
      permissionProfileId: profile.profileId,
      permissionProfile: profile,
      workspaceId,
    },
  };
}

/**
 * Prepare + enqueue a `chat.turn.execute` durable run for an autonomous
 * (cron/heartbeat/proactive) turn. Persists the user message + trace via
 * `prepareAgentChatTurn` (the durable payload's precondition), then creates
 * the durable run tagged with `metadata.autonomous` so the post-turn delivery
 * hook in `durable-execution-service.ts` can route the reply to a channel.
 */
export async function enqueueAutonomousChatTurn(
  deps: ChatAutonomousTurnDeps,
  input: {
    sessionId: string;
    prompt: string;
    runId: string;
    systemActorId: string;
    reason: string;
    /** Restricted profile selector; defaults to `scheduled` (cron/commitment). */
    kind?: AutonomousTurnKind;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
    deliverMode: NonNullable<CronAgentTurnConfig["deliverMode"]>;
    policyContext?: ToolPolicyActorContext;
    profilePosture?: AgentTurnCronRunOutcome["profilePosture"];
    commitmentId?: string;
  },
): Promise<{ runId: string; turnId: string } | undefined> {
  if (!deps.isFeatureEnabled("durableKernelV1Enabled")) {
    throw new Error("agent_turn cron execution requires durable execution (durableKernelV1Enabled).");
  }
  if (deps.isFeatureEnabled("autonomyV1Disabled")) {
    throw new Error("Autonomous chat turn execution is disabled while the autonomy kill switch is engaged.");
  }
  const kind: AutonomousTurnKind = input.kind ?? "scheduled";
  const permissionProfileId =
    kind === "heartbeat" ? HEARTBEAT_PERMISSION_PROFILE_ID : SCHEDULED_TURN_PERMISSION_PROFILE_ID;
  const autonomousContext = buildAutonomousTurnContext({
    kind,
    systemActorId: input.systemActorId,
    runId: input.runId,
    sessionId: input.sessionId,
  });
  const policyContext = input.policyContext ?? autonomousContext.policyContext;
  const request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext } = {
    content: input.prompt,
    operatorId: autonomousContext.policyContext.operatorId,
    authActorId: autonomousContext.policyContext.authActorId,
    authActorSource: autonomousContext.policyContext.authActorSource,
    permissionProfileId,
    policyContext,
  };
  const prepared = await deps.prepareAgentChatTurn(input.sessionId, request, { ingestUserMessage: true });
  const run = deps.createDurableRun({
    workflowKey: "chat.turn.execute",
    payload: deps.buildDurableChatTurnPayloadRecord(prepared, request),
    metadata: {
      surface: chatTurnPrepService.resolvePreparedTurnMode(prepared),
      objective: prepared.content,
      autonomous: {
        kind,
        systemActorId: input.systemActorId,
        reason: input.reason,
        deliverMode: input.deliverMode,
        ...(input.deliveryChannel ? { deliveryChannel: input.deliveryChannel } : {}),
        ...(input.profilePosture ? { profilePosture: input.profilePosture } : {}),
        ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
      },
    },
  });
  if (policyContext.permissionProfile && policyContext.permissionProfileId) {
    deps.registerSyntheticPermissionProfile(policyContext.permissionProfile);
  }
  chatDurableRunService.persistInitialDurableChatTurnTrace(
    { chatTurnTraces: deps.storage.chatTurnTraces },
    prepared,
    request,
    run,
  );
  deps.persistChatStreamChunk(
    {
      type: "message_start",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
    },
    run.runId,
  );
  deps.requestDurableRunProcessing(run.runId);
  return { runId: run.runId, turnId: prepared.turnId };
}

/**
 * Runtime-hook impl for the model-callable `schedule.manage` tool (P1-F2).
 *
 * Routed here by the policy-engine executor (`scheduleManage` hook) *after* the
 * engine has authorized the call — `schedule.manage` is `danger` +
 * `requiresApproval`, so the normal approval gate fires first for interactive
 * operators, and the restricted `scheduled-restricted` profile makes a
 * scheduled turn's call require approval too (anti-recursion). This function:
 *  - maps `op` to the existing `cronAutomationService` create/list/delete,
 *  - forces `action:"agent_turn"` for created jobs,
 *  - stamps the creator actor + permission profile from `policyContext` onto the
 *    job for ownership, anti-recursion, and audit while fired turns stay on the
 *    restricted scheduled profile, and
 *  - enforces the per-creator cap, the >=15min interval floor, and the depth-1
 *    chain cap (all in the pure `schedule-tool-support` validator).
 *
 * The master autonomy kill switch (`autonomyV1Disabled`) hard-disables the
 * whole tool so no schedule can be created/listed/cancelled while autonomy is
 * halted.
 */
export async function scheduleManage(
  deps: ChatAutonomousTurnDeps,
  args: Record<string, unknown>,
  policyContext: ToolPolicyActorContext | undefined,
): Promise<Record<string, unknown>> {
  if (deps.isFeatureEnabled("autonomyV1Disabled")) {
    throw new Error("schedule.manage is disabled while the autonomy kill switch is engaged (autonomyV1Disabled).");
  }
  const parsed = parseScheduleManageArgs(args);
  if (parsed.op === "list") {
    const creatorKey = resolveScheduleCreatorKey(policyContext);
    const jobs = deps.cron
      .listCronJobs()
      .filter((job) => job.action === "agent_turn")
      .filter((job) => {
        if (!creatorKey) {
          return false;
        }
        const createdBy = job.actionConfig?.agentTurn?.createdBy;
        return createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey;
      })
      .map((job) => summarizeScheduleJob(job));
    return { op: "list", count: jobs.length, jobs };
  }
  if (parsed.op === "cancel") {
    const jobId = parsed.jobId?.trim();
    if (!jobId) {
      throw new Error('schedule.manage cancel requires a "jobId".');
    }
    const creatorKey = resolveScheduleCreatorKey(policyContext);
    const existing = deps.cron.getCronJob(jobId);
    if (existing.action !== "agent_turn") {
      throw new Error(`schedule.manage cancel refused: ${jobId} is not an agent_turn schedule.`);
    }
    const createdBy = existing.actionConfig?.agentTurn?.createdBy;
    const owned = !!creatorKey && (createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey);
    if (!owned) {
      throw new Error(`schedule.manage cancel refused: ${jobId} is not owned by the caller.`);
    }
    const result = deps.cron.deleteCronJob(jobId);
    return { op: "cancel", jobId: result.jobId, deleted: result.deleted };
  }
  // op === "create"
  const createdByJobId = resolveSchedulingTurnJobId(deps, policyContext);
  const validated = validateScheduleCreate({
    args: parsed,
    policyContext,
    existingJobs: deps.cron.listCronJobs(),
    ...(createdByJobId ? { createdByJobId } : {}),
  });
  const jobId = generateScheduleJobId(deps, validated.name);
  const created = deps.cron.createCronJob({
    jobId,
    name: validated.name,
    action: "agent_turn",
    schedule: validated.schedule,
    ...(validated.endAt ? { endAt: validated.endAt } : {}),
    actionConfig: buildScheduleCreateActionConfig(validated),
  });
  return {
    op: "create",
    jobId: created.jobId,
    name: created.name,
    schedule: created.schedule,
    enabled: created.enabled,
    ...(created.nextRunAt ? { nextRunAt: created.nextRunAt } : {}),
    requiresApprovalToRun: false,
    createdBy: validated.createdBy,
  };
}

/**
 * Best-effort: when the calling turn is itself a scheduled (restricted) turn,
 * find the cron `agent_turn` job that owns the caller's session so the new job
 * records its parent for the anti-recursion chain. Returns undefined for
 * interactive callers (depth 0).
 */
function resolveSchedulingTurnJobId(
  deps: ChatAutonomousTurnDeps,
  policyContext: ToolPolicyActorContext | undefined,
): string | undefined {
  if (!isScheduledTurnContext(policyContext) || !policyContext?.sessionId) {
    return undefined;
  }
  const sessionId = policyContext.sessionId;
  const match = deps.cron
    .listCronJobs()
    .find((job) => job.action === "agent_turn" && job.actionConfig?.agentTurn?.sessionId === sessionId);
  return match?.jobId;
}

/**
 * Generate a unique cron job id from a human name plus a short random suffix.
 * Conforms to the cron id rules (`^[a-z0-9][a-z0-9_-]{2,63}$`) and retries on
 * the (vanishingly rare) collision so a model-created schedule never clobbers
 * an existing job.
 */
function generateScheduleJobId(deps: ChatAutonomousTurnDeps, name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const slug = base.length >= 3 ? base : "scheduled-turn";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const candidate = `${slug}-${suffix}`.slice(0, 64);
    try {
      deps.cron.getCronJob(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("schedule.manage create: could not allocate a unique job id; please retry.");
}

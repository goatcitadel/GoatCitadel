/* eslint-disable max-lines -- Autonomous admission and recovery stay co-located while the runtime contract is being frozen. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonString, isDurableRunTerminal, NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatTurnTraceRecord,
  ChatSendMessageRequest,
  CronAgentTurnConfig,
  CronJobRecord,
  CronRunExecutionToken,
  DurableRunRecord,
  PermissionProfileRecord,
  TaskRecord,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  sealChatTurnCapabilityProfile,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilityProfile,
  type HeartbeatOccurrenceRecord,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
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
import {
  DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS,
  HEARTBEAT_SYSTEM_PROMPT,
  type HeartbeatDatabaseAdmissionOutcome,
  runHeartbeatTick,
} from "./gateway/heartbeat-service.js";
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
import type { PreparedAgentChatTurn, SystemHeartbeatTurnPrepPosture } from "./chat-turn-prep-service.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";
import type { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import {
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  CRON_CHAT_ADMISSION_IDENTITY_VERSION,
  buildAutonomousChatAdmissionMetadataMaterial,
  hashChatTurnRuntimeAuthorityValue,
  readAutonomousChatAdmissionMetadataSeal,
  readChatTurnRuntimeAuthoritySeal,
  readExactAutonomousChatPostCommitPendingMarker,
  readExactAutonomousChatPostCommitSettlement,
  readExactChatTurnAdmissionHandoff,
  readExactGeneralChatPostCommitPendingMarker,
  readExactGeneralChatPostCommitSettlement,
  readExactLinkedFinalizationPendingMarker,
  readExactLinkedFinalizationSettlement,
  sealAutonomousChatAdmissionMetadata,
  verifyAutonomousChatAdmissionRunMetadata,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
  type AutonomousChatChildIdentity,
  type CanonicalCronChatAdmissionIdentity,
  type ChatTurnRuntimeAuthoritySealV1,
} from "./chat-durable-runtime-authority.js";
import { DURABLE_RETRY_POLICY_DEFAULT, assertDurableRetryPolicyMatchesRun } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
} from "./session-control-service.js";

/**
 * Autonomous chat-turn execution (B8b extraction): the cron `agent_turn`
 * runner, commitment/heartbeat maintenance sweeps, the shared autonomous-turn
 * enqueue path, and the model-callable `schedule.manage` runtime hook.
 * Verbatim moves from GatewayService behind a narrow deps port — the gateway
 * keeps thin delegators (its facade tests drive them unchanged) plus the
 * synthetic-profile registry, which the interactive policy path also owns.
 */

const DEFAULT_WORKSPACE_ID = "default";
const HEARTBEAT_SESSION_PAGE_LIMIT = 500;
const HEARTBEAT_WORKSPACE_PAGE_LIMIT = 100;

type HeartbeatTickDeps = Parameters<typeof runHeartbeatTick>[0];
type CommitmentSweepCoreDeps = Parameters<typeof runCommitmentSweepCore>[0];
type DurableRunForTrace = Parameters<typeof chatDurableRunService.persistInitialDurableChatTurnTrace>[3];

const AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY = "autonomousAdmission" as const;
const AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS = new Set([
  "retryPolicy",
  CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY,
  "waitForEvent",
  "outputText",
  "finalOutput",
  "outputSummary",
  "finalSummary",
  "outputMessageId",
  "outputTraceStatus",
  "linkedFinalizationPending",
  "linkedFinalization",
  "autonomousChatPostCommitPending",
  "autonomousChatPostCommit",
  "generalChatPostCommitPending",
  "generalChatPostCommit",
  "chatTurnAdmissionHandoff",
  "chatRetryExhaustionDeadLetterPending",
  "autonomyKillSwitch",
  "approvalMaterializedPostCommit",
]);
const AUTONOMOUS_CHAT_TERMINAL_OUTPUT_METADATA_KEYS = [
  "outputText",
  "finalOutput",
  "outputSummary",
  "finalSummary",
  "outputMessageId",
  "outputTraceStatus",
] as const;
const AUTONOMOUS_CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS = ["assistantMessageId", "outputText", "outputSummary"] as const;

/**
 * Immutable child identity for one canonically admitted cron occurrence.
 *
 * The cron-run owner token remains the fencing authority. Child ids are
 * derived only from its canonical run id so a crash at any point between the
 * user-message write and durable-run creation can safely re-enter the same
 * admission without creating a second Chat turn.
 */
export type CronChatAdmissionIdentity = CanonicalCronChatAdmissionIdentity;

export interface EnqueuedAutonomousChatTurn {
  runId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  admissionIdentity?: CronChatAdmissionIdentity;
}

export type CronAgentTurnRunOutcome = AgentTurnCronRunOutcome & {
  userMessageId?: string;
  assistantMessageId?: string;
  admissionIdentity?: CronChatAdmissionIdentity;
};

export interface ChatAutonomousTurnDeps {
  storage: Pick<
    Storage,
    | "agentCommitments"
    | "chatSessionBindings"
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "chatTurnTraces"
    | "durableRuns"
    | "heartbeatOccurrences"
    | "capabilityCatalogSnapshots"
    | "chatTurnCapabilityProfiles"
    | "sessionMutationAdmissions"
    | "skillLifecycle"
    | "permissionProfiles"
    | "sessions"
    | "workspaces"
    | "gatewaySql"
    | "runImmediateTransaction"
  >;
  cron: Pick<CronAutomationService, "listCronJobs" | "getCronJob" | "deleteCronJob" | "createCronJob">;
  isFeatureEnabled(flag: "autonomyV1Disabled" | "durableKernelV1Enabled"): Promise<boolean>;
  createCronInboxTask(job: CronJobRecord, options?: { taskId?: string }): Promise<TaskRecord>;
  getSessionAutonomyPrefs: HeartbeatTickDeps["getSessionAutonomyPrefs"];
  patchSessionAutonomyPrefs(sessionId: string, patch: { proactiveMode: "off" }): Promise<void>;
  listChatSessions(query: {
    scope: "mission";
    view: "active";
    workspaceId: string;
    cursor?: string;
    limit?: number;
  }): Promise<
    Array<{
      sessionId: string;
      updatedAt: string;
      lastActivityAt: string;
    }>
  >;
  getSessionIdleSeconds: HeartbeatTickDeps["getSessionIdleSeconds"];
  hasRunningTurn(sessionId: string): Promise<boolean>;
  claimAndEnqueueHeartbeat(input: {
    workspaceId: string;
    sessionId: string;
    expectedPriorCadence: { lastProactiveAt?: string; lastProactiveRunId?: string };
    idleFloorSeconds: number;
  }): Promise<HeartbeatDatabaseAdmissionOutcome>;
  isReplayScratchSession(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<unknown>;
  normalizeWorkspaceId(workspaceId: string | undefined): string;
  ensureChatSessionRuntimeGrants(sessionId: string): Promise<void>;
  listConnectorRecords(kind: "integration_connection"): Promise<
    Array<{
      status: string;
      sourceId?: string;
      metadata?: Record<string, unknown>;
    }>
  >;
  listToolCatalog(): Array<{ toolName: string }>;
  registerSyntheticPermissionProfile(profile: PermissionProfileRecord): void;
  sessionControlRuntimeOwner: Pick<
    SessionControlRuntimeOwner,
    "admitSystemChatTurn" | "startRequestLeaseHeartbeat" | "assertActiveTurnWrite" | "bindDurableRun" | "closeTurnWrite"
  >;
  prepareAgentChatTurn(
    sessionId: string,
    request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext },
    options: {
      ingestUserMessage: boolean;
      userMessageId?: string;
      turnId?: string;
      assistantMessageId?: string;
      parentTurnId?: string;
      capabilityProfileId?: string;
      capabilityProfileHash?: string;
      turnAdmission?: ActiveTurnAdmission;
      serverOnlyPosture?: SystemHeartbeatTurnPrepPosture;
    },
  ): Promise<PreparedAgentChatTurn>;
  buildDurableChatTurnPayloadRecord(
    prepared: PreparedAgentChatTurn,
    request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext },
    durableRunId: string,
  ): Record<string, unknown>;
  createDurableRun(input: {
    runId?: string;
    workflowKey: "chat.turn.execute";
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<DurableRunForTrace & { runId: string }>;
  getDurableRun(runId: string): Promise<DurableRunRecord>;
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
  ): Promise<unknown>;
  onDurableRunCommitted?(run: DurableRunForTrace & { runId: string }): Promise<void>;
  requestDurableRunProcessing(runId: string): Promise<void>;
}

export async function runCronAgentTurn(
  deps: ChatAutonomousTurnDeps,
  input: {
    job: CronJobRecord;
    runId: string;
    config: CronAgentTurnConfig;
    /** Canonical cron-run owner. When present, deterministic child admission is mandatory. */
    cronRun?: CronRunExecutionToken;
  },
): Promise<CronAgentTurnRunOutcome> {
  const cronRun = input.cronRun ? assertCronRunOwnsInvocation(input.cronRun, input) : undefined;
  const admissionIdentity = cronRun ? buildCronChatAdmissionIdentity(cronRun) : undefined;
  const inboxTaskId = cronRun ? buildCronInboxTaskId(cronRun) : undefined;
  const autonomyDisabled = await deps.isFeatureEnabled("autonomyV1Disabled");
  if (autonomyDisabled || input.config.inertInboxFallback) {
    const task = await deps.createCronInboxTask(input.job, inboxTaskId ? { taskId: inboxTaskId } : undefined);
    return { mode: "inbox", taskId: task.taskId };
  }
  // Validate the canonical cron owner before creating or mutating a session.
  const sessionId = await ensureCronAgentSession(deps, input.job.jobId, input.config.sessionId);
  const systemActorId = `system:cron:${input.job.jobId}`;
  const scheduledPolicy = await resolveScheduledAgentTurnPolicy(deps, {
    config: input.config,
    jobId: input.job.jobId,
    runId: input.runId,
    sessionId,
    systemActorId,
  });
  if ("failClosedReason" in scheduledPolicy) {
    const task = await deps.createCronInboxTask(input.job, inboxTaskId ? { taskId: inboxTaskId } : undefined);
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
    admissionIdentity,
  });
  return {
    mode: "agent_turn",
    durableRunId: run?.runId,
    sessionId,
    turnId: run?.turnId,
    userMessageId: run?.userMessageId,
    assistantMessageId: run?.assistantMessageId,
    admissionIdentity: run?.admissionIdentity,
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
  if ((await deps.isFeatureEnabled("autonomyV1Disabled")) || !(await deps.isFeatureEnabled("durableKernelV1Enabled"))) {
    return;
  }
  await runCommitmentSweepCore({
    isAutonomyEnabled: async () => !(await deps.isFeatureEnabled("autonomyV1Disabled")),
    listDueCommitments: async (nowIso, limit) => await deps.storage.agentCommitments.listDue(nowIso, limit),
    getSessionAutonomyPrefs: (sessionId) => deps.getSessionAutonomyPrefs(sessionId),
    deliverCommitment: async (commitment) => {
      const deliveryChannel = await resolveCommitmentDeliveryChannel(deps, commitment.sessionId);
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
    markDeliveryPending: async (commitmentId) => await deps.storage.agentCommitments.markDeliveryPending(commitmentId),
    markDeliveryFailed: async (commitmentId) => await deps.storage.agentCommitments.markDeliveryFailed(commitmentId),
  } satisfies CommitmentSweepCoreDeps);
}

async function resolveCommitmentDeliveryChannel(
  deps: ChatAutonomousTurnDeps,
  sessionId: string,
): Promise<CronAgentTurnConfig["deliveryChannel"] | undefined> {
  const binding = await deps.storage.chatSessionBindings.get(sessionId);
  if (
    !binding ||
    binding.transport !== "integration" ||
    !binding.writable ||
    !binding.connectionId ||
    !binding.target
  ) {
    return undefined;
  }
  const connector = (await deps.listConnectorRecords("integration_connection")).find(
    (item) => item.status === "active" && item.sourceId === binding.connectionId,
  );
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
 * `{notify:true}`. The pure `runHeartbeatTick` applies an advisory wall-clock
 * prefilter; the durable database occurrence claim is the sole cadence and
 * admission authority and rechecks every gate under lock. No-op while the master autonomy switch is off or
 * durable execution is disabled (the turn path requires a durable run).
 * Eval-integrity / non-human / replay-scratch sessions are excluded.
 */
export async function runHeartbeatSweep(deps: ChatAutonomousTurnDeps): Promise<void> {
  if ((await deps.isFeatureEnabled("autonomyV1Disabled")) || !(await deps.isFeatureEnabled("durableKernelV1Enabled"))) {
    return;
  }
  const now = new Date();
  let afterWorkspaceId = "";
  for (;;) {
    const workspaceIds = await listNextActiveHeartbeatWorkspacePage(deps, afterWorkspaceId);
    for (const workspaceId of workspaceIds) {
      await runHeartbeatWorkspacePages(deps, workspaceId, now);
    }
    if (workspaceIds.length < HEARTBEAT_WORKSPACE_PAGE_LIMIT) return;
    const nextWorkspaceId = workspaceIds.at(-1);
    if (!nextWorkspaceId || nextWorkspaceId <= afterWorkspaceId) {
      throw new Error("Heartbeat workspace cursor did not advance.");
    }
    afterWorkspaceId = nextWorkspaceId;
  }
}

function buildHeartbeatTickDeps(
  deps: ChatAutonomousTurnDeps,
  sessions: Array<{ sessionId: string; lastActivityAt: string }>,
  now: Date,
): HeartbeatTickDeps {
  return {
    isAutonomyEnabled: async () => !(await deps.isFeatureEnabled("autonomyV1Disabled")),
    // One bounded cursor page is processed immediately. The pure tick's
    // historical 300-row default must not truncate this page.
    listSessions: () => sessions,
    sessionLimit: Math.max(1, sessions.length),
    now: () => now,
    getSessionAutonomyPrefs: (sessionId) => deps.getSessionAutonomyPrefs(sessionId),
    isHeartbeatEligibleSession: async (sessionId) => await isHeartbeatEligibleSession(deps, sessionId),
    getSessionIdleSeconds: (sessionId) => deps.getSessionIdleSeconds(sessionId),
    hasRunningTurn: (sessionId) => deps.hasRunningTurn(sessionId),
    enqueueHeartbeatTurn: async ({ sessionId, prompt }) => {
      if (prompt !== HEARTBEAT_SYSTEM_PROMPT) {
        throw new Error("Heartbeat sweep objective drifted from its canonical prompt.");
      }
      const meta = await deps.storage.chatSessionMeta.get(sessionId);
      if (!meta) throw new Error(`Heartbeat session ${sessionId} has no controllable Chat lifecycle.`);
      const prefs = await deps.getSessionAutonomyPrefs(sessionId);
      return deps.claimAndEnqueueHeartbeat({
        workspaceId: meta.workspaceId,
        sessionId,
        expectedPriorCadence: {
          lastProactiveAt: prefs.lastProactiveAt,
          lastProactiveRunId: prefs.lastProactiveRunId,
        },
        idleFloorSeconds: DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS,
      });
    },
  };
}

/**
 * Process each session cursor page immediately so discovery has a constant
 * memory bound and useful work is not delayed behind a full-fleet materialize.
 * The database occurrence claim remains the duplicate/cadence authority when
 * concurrent session activity moves a row across cursor pages.
 */
async function runHeartbeatWorkspacePages(deps: ChatAutonomousTurnDeps, workspaceId: string, now: Date): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.listChatSessions({
      scope: "mission",
      view: "active",
      workspaceId,
      ...(cursor ? { cursor } : {}),
      limit: HEARTBEAT_SESSION_PAGE_LIMIT,
    });
    const boundedSessionIds = new Set<string>();
    for (const session of page) {
      assertHeartbeatSessionCursorMaterial(session);
      if (boundedSessionIds.has(session.sessionId)) {
        throw new Error(`Heartbeat session page for workspace ${workspaceId} contains a duplicate session.`);
      }
      boundedSessionIds.add(session.sessionId);
    }
    await runHeartbeatTick(
      buildHeartbeatTickDeps(
        deps,
        page.map((session) => ({ sessionId: session.sessionId, lastActivityAt: session.lastActivityAt })),
        now,
      ),
    );
    if (page.length < HEARTBEAT_SESSION_PAGE_LIMIT) return;
    const last = page.at(-1);
    if (!last) throw new Error(`Heartbeat session page for workspace ${workspaceId} was unexpectedly empty.`);
    const nextCursor = `${last.updatedAt}|${last.sessionId}`;
    if (cursor && compareHeartbeatSessionCursor(nextCursor, cursor) >= 0) {
      throw new Error(`Heartbeat session cursor did not advance for workspace ${workspaceId}.`);
    }
    cursor = nextCursor;
    // Keep each page as a bounded scheduler slice even when a fleet is large.
    await Promise.resolve();
  }
}

async function listNextActiveHeartbeatWorkspacePage(
  deps: ChatAutonomousTurnDeps,
  afterWorkspaceId: string,
): Promise<string[]> {
  const statement = await deps.storage.gatewaySql.prepare(
    `SELECT workspace_id
       FROM workspaces
       WHERE lifecycle_status = 'active'
         AND workspace_id > @afterWorkspaceId
       ORDER BY workspace_id ASC
       LIMIT @limit`,
  );
  const rows = await statement.all<{ workspace_id?: unknown }>({
    afterWorkspaceId,
    limit: HEARTBEAT_WORKSPACE_PAGE_LIMIT,
  });
  const result: string[] = [];
  let prior = afterWorkspaceId;
  for (const row of rows) {
    const workspaceId = row.workspace_id;
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.trim() !== workspaceId) {
      throw new TypeError("Heartbeat workspace enumeration returned an invalid workspace id.");
    }
    if (workspaceId <= prior) {
      throw new Error("Heartbeat workspace cursor did not advance.");
    }
    result.push(workspaceId);
    prior = workspaceId;
  }
  if (result.length > HEARTBEAT_WORKSPACE_PAGE_LIMIT) {
    throw new Error("Heartbeat workspace query exceeded its bounded page limit.");
  }
  return result;
}

function compareHeartbeatSessionCursor(left: string, right: string): number {
  const leftSeparator = left.lastIndexOf("|");
  const rightSeparator = right.lastIndexOf("|");
  const leftTime = left.slice(0, leftSeparator);
  const rightTime = right.slice(0, rightSeparator);
  const timeOrder = leftTime.localeCompare(rightTime);
  return timeOrder !== 0 ? timeOrder : left.slice(leftSeparator + 1).localeCompare(right.slice(rightSeparator + 1));
}

function assertHeartbeatSessionCursorMaterial(session: {
  sessionId: string;
  updatedAt: string;
  lastActivityAt: string;
}): void {
  if (!session.sessionId || session.sessionId.includes("|")) {
    throw new TypeError("Heartbeat session enumeration returned an invalid session id.");
  }
  if (!session.updatedAt || !Number.isFinite(Date.parse(session.updatedAt))) {
    throw new TypeError(`Heartbeat session ${session.sessionId} has invalid cursor material.`);
  }
  if (!session.lastActivityAt || !Number.isFinite(Date.parse(session.lastActivityAt))) {
    throw new TypeError(`Heartbeat session ${session.sessionId} has invalid activity material.`);
  }
}

/**
 * Whether a session may receive silent heartbeats. Mirrors the human-session /
 * eval-integrity guard used for the commitment classifier: skip `system` and
 * `prompt_pack` origins and replay-scratch sessions (safety invariant:
 * eval-integrity turns are never affected).
 */
export async function isHeartbeatEligibleSession(deps: ChatAutonomousTurnDeps, sessionId: string): Promise<boolean> {
  const origin = (await deps.storage.chatSessionMeta.get(sessionId))?.origin;
  if (origin === "system" || origin === "prompt_pack") {
    return false;
  }
  return !(await deps.isReplayScratchSession(sessionId));
}

/**
 * Resolve a stable cron session for an `agent_turn` job. Reuses an explicitly
 * configured session id when present, otherwise derives a deterministic
 * per-job session and creates it (proactiveMode off, system origin) if it does
 * not yet exist. Immutable: reuses existing rows; only creates when missing.
 */
async function ensureCronAgentSession(
  deps: ChatAutonomousTurnDeps,
  jobId: string,
  configuredSessionId?: string,
): Promise<string> {
  const explicit = configuredSessionId?.trim();
  if (explicit && (await deps.getSession(explicit))) {
    if (!(await deps.storage.chatSessionMeta.get(explicit))) {
      throw new Error("configured cron session has no controllable Chat lifecycle");
    }
    return explicit;
  }
  const peer = `cron_${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}`;
  const sessionKey = `mission:scheduler:${peer}`;
  const sessionId = `sess_${createHash("sha256").update(sessionKey).digest("hex").slice(0, 24)}`;
  const now = new Date().toISOString();
  const workspaceId = deps.normalizeWorkspaceId(undefined);
  const existingMeta = await deps.storage.chatSessionMeta.get(sessionId);
  if (existingMeta && deps.normalizeWorkspaceId(existingMeta.workspaceId) !== workspaceId) {
    throw new Error("stable cron session key already belongs to another workspace");
  }
  if ((await deps.getSession(sessionId)) && existingMeta) {
    return sessionId;
  }
  await deps.storage.runImmediateTransaction(async () => {
    const lockedMeta = await deps.storage.chatSessionMeta.get(sessionId);
    if (lockedMeta && deps.normalizeWorkspaceId(lockedMeta.workspaceId) !== workspaceId) {
      throw new Error("stable cron session key already belongs to another workspace");
    }
    await deps.storage.sessions.upsert({
      sessionId,
      sessionKey,
      kind: "dm",
      channel: "mission",
      account: "scheduler",
      displayName: `Cron ${jobId}`,
      timestamp: now,
    });
    await deps.storage.chatSessionMeta.ensure(sessionId, now, workspaceId);
    await deps.storage.chatSessionPrefs.ensure(sessionId, now);
    await deps.storage.chatSessionMeta.patch(
      sessionId,
      { workspaceId, title: `Cron ${jobId}`, origin: "system", includeInHistory: false },
      now,
    );
    await deps.storage.chatSessionBindings.upsert({ sessionId, workspaceId, transport: "llm", writable: true }, now);
  });
  await deps.ensureChatSessionRuntimeGrants(sessionId);
  await deps.patchSessionAutonomyPrefs(sessionId, { proactiveMode: "off" });
  return sessionId;
}

async function resolveScheduledAgentTurnPolicy(
  deps: ChatAutonomousTurnDeps,
  input: {
    config: CronAgentTurnConfig;
    jobId: string;
    runId: string;
    sessionId: string;
    systemActorId: string;
  },
): Promise<
  | { policyContext: ToolPolicyActorContext; profilePosture: "scheduled_restricted" | "creator_intersection" }
  | {
      profilePosture:
        | "creator_profile_missing"
        | "creator_profile_archived"
        | "creator_profile_scope_mismatch"
        | "creator_profile_invalid";
      failClosedReason: string;
    }
> {
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

  const workspaceId = (await deps.storage.chatSessionMeta.get(input.sessionId))?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  let creatorProfile: PermissionProfileRecord;
  try {
    creatorProfile = await deps.storage.permissionProfiles.getProfile(creatorProfileId);
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
    /** Deterministic cron-only child identity. Heartbeat/commitment/proactive callers omit it. */
    admissionIdentity?: CronChatAdmissionIdentity;
    /** Exact storage-claimed heartbeat authority; supplying it forbids a second admission. */
    heartbeatOccurrence?: {
      occurrence: HeartbeatOccurrenceRecord;
      turnAdmission: ActiveTurnAdmission;
      request: ChatSendMessageRequest;
    };
  },
): Promise<EnqueuedAutonomousChatTurn | undefined> {
  if (!(await deps.isFeatureEnabled("durableKernelV1Enabled"))) {
    throw new Error("agent_turn cron execution requires durable execution (durableKernelV1Enabled).");
  }
  if (await deps.isFeatureEnabled("autonomyV1Disabled")) {
    throw new Error("Autonomous chat turn execution is disabled while the autonomy kill switch is engaged.");
  }
  const kind: AutonomousTurnKind = input.kind ?? "scheduled";
  const heartbeatOccurrence = input.heartbeatOccurrence;
  if (kind === "heartbeat" && !heartbeatOccurrence) {
    throw new Error("Heartbeat Chat enqueue requires an exact durable occurrence claim.");
  }
  const permissionProfileId =
    kind === "heartbeat" ? HEARTBEAT_PERMISSION_PROFILE_ID : SCHEDULED_TURN_PERMISSION_PROFILE_ID;
  const autonomousContext = buildAutonomousTurnContext({
    kind,
    systemActorId: input.systemActorId,
    runId: input.runId,
    workspaceId: heartbeatOccurrence?.occurrence.workspaceId,
    sessionId: input.sessionId,
  });
  const policyContext = input.policyContext ?? autonomousContext.policyContext;
  const canonicalRequest: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext } = {
    content: input.prompt,
    operatorId: autonomousContext.policyContext.operatorId,
    authActorId: autonomousContext.policyContext.authActorId,
    authActorSource: autonomousContext.policyContext.authActorSource,
    permissionProfileId,
    policyContext,
  };
  if (heartbeatOccurrence) {
    const occurrence = heartbeatOccurrence.occurrence;
    const admission = heartbeatOccurrence.turnAdmission;
    if (
      kind !== "heartbeat" ||
      input.admissionIdentity !== undefined ||
      input.systemActorId !== "system-heartbeat" ||
      input.sessionId !== occurrence.sessionId ||
      admission.identity.admissionId !== occurrence.admissionId ||
      admission.identity.workspaceId !== occurrence.workspaceId ||
      admission.identity.sessionId !== occurrence.sessionId ||
      admission.identity.sessionIncarnationId !== occurrence.sessionIncarnationId ||
      admission.identity.turnId !== occurrence.turnId ||
      admission.identity.materialSha256 !== occurrence.frozenRequestSha256 ||
      admission.requestActor.actorKind !== "system" ||
      admission.requestActor.actorId !== "system-heartbeat" ||
      canonicalJsonString(heartbeatOccurrence.request) !== canonicalJsonString(canonicalRequest)
    ) {
      throw new Error("Preclaimed heartbeat request conflicts with its canonical autonomous context.");
    }
  }
  const request = heartbeatOccurrence?.request ?? canonicalRequest;
  const admissionIdentity = input.admissionIdentity;
  if (admissionIdentity) {
    assertCronChatAdmissionIdentity(admissionIdentity, input.sessionId);
  }
  // Synthetic creator-intersection profiles must be visible while the
  // server-owned capability profile is resolved, not only after admission.
  if (policyContext.permissionProfile && policyContext.permissionProfileId) {
    deps.registerSyntheticPermissionProfile(policyContext.permissionProfile);
  }
  // The durable run id is part of both the profile binding and the exact
  // server-derived policy-run declaration, so every autonomous turn freezes it
  // before payload construction.
  const childIdentity = heartbeatOccurrence
    ? {
        userMessageId: heartbeatOccurrence.occurrence.userMessageId,
        assistantMessageId: heartbeatOccurrence.occurrence.assistantMessageId,
        turnId: heartbeatOccurrence.occurrence.turnId,
        durableRunId: heartbeatOccurrence.occurrence.durableRunId,
      }
    : (admissionIdentity ?? buildAutonomousChatChildIdentity(input));
  const durableRunId = childIdentity.durableRunId;
  const existingAdmissionTrace = await readOwnedAutonomousChatAdmissionTrace(
    deps,
    input.sessionId,
    childIdentity,
    admissionIdentity ? "cron" : "autonomous",
  );
  if (existingAdmissionTrace) {
    const replay = await assertOwnedAutonomousDurableReplay(deps, {
      identity: childIdentity,
      trace: existingAdmissionTrace,
      request,
      sessionId: input.sessionId,
      systemActorId: input.systemActorId,
      kind,
      sourceRunId: input.runId,
      prompt: input.prompt,
      reason: input.reason,
      deliverMode: input.deliverMode,
      deliveryChannel: input.deliveryChannel,
      profilePosture: input.profilePosture,
      commitmentId: input.commitmentId,
      admissionIdentity,
    });
    if (replay.requestProcessing) await deps.requestDurableRunProcessing(durableRunId);
    return {
      runId: durableRunId,
      turnId: childIdentity.turnId,
      userMessageId: childIdentity.userMessageId,
      assistantMessageId: childIdentity.assistantMessageId,
      ...(admissionIdentity ? { admissionIdentity } : {}),
    };
  }
  const turnAdmission =
    heartbeatOccurrence?.turnAdmission ??
    (await deps.sessionControlRuntimeOwner.admitSystemChatTurn({
      sessionId: input.sessionId,
      turnId: childIdentity.turnId,
      request,
      systemActorId: input.systemActorId,
      occurrenceId: durableRunId,
      idempotencyKey: `chat-turn:autonomous:${durableRunId}`,
      correlationId: input.runId,
    }));
  const requestLease = deps.sessionControlRuntimeOwner.startRequestLeaseHeartbeat(turnAdmission);
  try {
    const prepared = await deps.prepareAgentChatTurn(input.sessionId, request, {
      ingestUserMessage: false,
      userMessageId: childIdentity.userMessageId,
      turnId: childIdentity.turnId,
      assistantMessageId: childIdentity.assistantMessageId,
      turnAdmission,
      ...(heartbeatOccurrence
        ? {
            serverOnlyPosture: {
              kind: "system_heartbeat" as const,
              actorId: "system-heartbeat" as const,
              operation: "chat_system_heartbeat" as const,
              occurrenceId: heartbeatOccurrence.occurrence.occurrenceId,
              claimSha256: heartbeatOccurrence.occurrence.claimSha256,
              durableRunId: heartbeatOccurrence.occurrence.durableRunId,
            },
          }
        : {}),
    });
    assertPreparedAutonomousChatAdmission(prepared, childIdentity);
    requestLease.assertHealthy();
    const capabilityStoresPresent = Boolean(
      deps.storage.capabilityCatalogSnapshots && deps.storage.chatTurnCapabilityProfiles,
    );
    if (Boolean(deps.storage.capabilityCatalogSnapshots) !== Boolean(deps.storage.chatTurnCapabilityProfiles)) {
      throw new Error("Autonomous Chat capability admission stores are incompletely configured.");
    }
    if (capabilityStoresPresent && (!prepared.capabilityProfile || !prepared.capabilityCatalogSnapshot)) {
      throw new Error(`Autonomous Chat turn ${prepared.turnId} cannot be admitted without its capability profile.`);
    }
    if (prepared.capabilityProfile) {
      const boundRunId = prepared.capabilityProfile.identity.durableRunId;
      if (boundRunId && boundRunId !== durableRunId) {
        throw new Error(
          `Autonomous Chat turn ${prepared.turnId} capability profile is bound to a different durable run.`,
        );
      }
      if (!boundRunId) {
        const { hashes: _hashes, ...draft } = prepared.capabilityProfile;
        prepared.capabilityProfile = sealChatTurnCapabilityProfile({
          ...draft,
          identity: { ...draft.identity, durableRunId },
        });
        prepared.history = chatTurnPrepService.upsertChatCapabilityProfileSystemInstruction(
          prepared.history ?? [],
          prepared.capabilityProfile,
        );
      }
    }
    const basePayload = deps.buildDurableChatTurnPayloadRecord(prepared, request, durableRunId);
    const payload = heartbeatOccurrence
      ? {
          ...basePayload,
          heartbeatOccurrenceId: heartbeatOccurrence.occurrence.occurrenceId,
          heartbeatClaimSha256: heartbeatOccurrence.occurrence.claimSha256,
          heartbeatEvaluatedPolicySha256: heartbeatOccurrence.occurrence.evaluatedPolicySha256,
          heartbeatFrozenObjectiveSha256: heartbeatOccurrence.occurrence.frozenObjectiveSha256,
        }
      : admissionIdentity
        ? { ...basePayload, cronAdmission: admissionIdentity }
        : basePayload;
    const autonomousMetadata = {
      kind,
      systemActorId: input.systemActorId,
      sourceRunId: input.runId,
      reason: input.reason,
      deliverMode: input.deliverMode,
      ...(input.deliveryChannel ? { deliveryChannel: input.deliveryChannel } : {}),
      ...(input.profilePosture ? { profilePosture: input.profilePosture } : {}),
      ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
    };
    const autonomousAdmissionMaterial = buildAutonomousChatAdmissionMetadataMaterial({
      identity: toCanonicalAutonomousChatChildIdentity(childIdentity),
      sessionId: input.sessionId,
      objective: prepared.content,
      autonomous: autonomousMetadata,
      payload,
      capabilitySnapshotId: prepared.capabilityProfile?.catalog.snapshotId,
      ...(admissionIdentity ? { cronAdmission: admissionIdentity } : {}),
    });
    const metadata = {
      surface: chatTurnPrepService.resolvePreparedTurnMode(prepared),
      objective: prepared.content,
      autonomous: autonomousMetadata,
      ...(prepared.capabilityProfile
        ? {
            capabilityProfileId: prepared.capabilityProfile.profileId,
            capabilityProfileHash: prepared.capabilityProfile.hashes.profileHash,
          }
        : {}),
      [AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY]: sealAutonomousChatAdmissionMetadata(autonomousAdmissionMaterial),
      ...(admissionIdentity
        ? {
            cronRunId: admissionIdentity.cronRunId,
            cronJobId: admissionIdentity.jobId,
            cronExecutionGeneration: admissionIdentity.executionGeneration,
            cronAdmission: admissionIdentity,
          }
        : {}),
    };
    let run!: DurableRunForTrace & { runId: string };
    const admit = async () => {
      await deps.sessionControlRuntimeOwner.assertActiveTurnWrite(turnAdmission);
      if (prepared.capabilityProfile && prepared.capabilityCatalogSnapshot && capabilityStoresPresent) {
        await chatDurableRunService.persistPreparedChatCapabilityAdmission(
          {
            capabilityCatalogSnapshots: deps.storage.capabilityCatalogSnapshots,
            chatTurnCapabilityProfiles: deps.storage.chatTurnCapabilityProfiles,
            sessionMutationAdmissions: deps.storage.sessionMutationAdmissions,
            skillLifecycle: deps.storage.skillLifecycle,
          },
          prepared,
        );
      }
      run = await deps.createDurableRun({ runId: durableRunId, workflowKey: "chat.turn.execute", payload, metadata });
      if (admissionIdentity) assertOwnedCronChatDurableRun(run, admissionIdentity, payload);
      await deps.sessionControlRuntimeOwner.bindDurableRun(turnAdmission, run.runId);
      await chatDurableRunService.persistInitialDurableChatTurnTrace(
        { chatTurnTraces: deps.storage.chatTurnTraces },
        prepared,
        request,
        run,
      );
      // Heartbeat output is buffered by the durable runtime until its strict
      // notify decision is known. Emitting message_start here would expose an
      // internal turn and advance visible branch/realtime state.
      if (!heartbeatOccurrence) {
        await deps.persistChatStreamChunk(
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
      }
      if (heartbeatOccurrence) {
        if (!prepared.capabilityProfile) {
          throw new Error(`Heartbeat turn ${prepared.turnId} cannot bind without its immutable capability profile.`);
        }
        await deps.storage.heartbeatOccurrences.markDurableBound({
          occurrenceId: heartbeatOccurrence.occurrence.occurrenceId,
          workspaceId: heartbeatOccurrence.occurrence.workspaceId,
          sessionId: heartbeatOccurrence.occurrence.sessionId,
          sessionIncarnationId: heartbeatOccurrence.occurrence.sessionIncarnationId,
          admissionId: heartbeatOccurrence.occurrence.admissionId,
          turnId: heartbeatOccurrence.occurrence.turnId,
          durableRunId: heartbeatOccurrence.occurrence.durableRunId,
          capabilityProfileId: prepared.capabilityProfile.profileId,
          capabilityProfileHash: prepared.capabilityProfile.hashes.profileHash,
        });
      }
    };
    requestLease.assertHealthy();
    if (typeof deps.storage.runImmediateTransaction === "function") await deps.storage.runImmediateTransaction(admit);
    else await admit();
    await deps.onDurableRunCommitted?.(run);
    await deps.requestDurableRunProcessing(run.runId);
    return {
      runId: run.runId,
      turnId: prepared.turnId,
      userMessageId: prepared.userEventId,
      assistantMessageId: prepared.assistantMessageId,
      ...(admissionIdentity ? { admissionIdentity } : {}),
    };
  } finally {
    requestLease.stop();
    if (turnAdmission.requestClaim) {
      await deps.sessionControlRuntimeOwner.closeTurnWrite({
        admission: turnAdmission,
        status: "cancelled",
        actorId: input.systemActorId,
        idempotencyKey: `chat-turn:autonomous:${durableRunId}:prebind-cancel`,
        correlationId: input.runId,
      });
    }
  }
}

function buildAutonomousChatChildIdentity(input: {
  sessionId: string;
  runId: string;
  kind?: AutonomousTurnKind;
}): AutonomousChatChildIdentity {
  const runId = input.runId.trim();
  const sessionId = input.sessionId.trim();
  if (!runId || !sessionId) {
    throw new Error("Autonomous Chat admission requires a canonical session and run identity.");
  }
  const digest = createHash("sha256")
    .update(`autonomous.chat.admission.v1\0${input.kind ?? "scheduled"}\0${sessionId}\0${runId}`)
    .digest("hex")
    .slice(0, 40);
  return {
    userMessageId: `msg_autonomous_user_${digest}`,
    turnId: `turn_autonomous_${digest}`,
    assistantMessageId: `msg_autonomous_assistant_${digest}`,
    durableRunId: `run_autonomous_chat_${digest}`,
  };
}

function toCanonicalAutonomousChatChildIdentity(identity: AutonomousChatChildIdentity): AutonomousChatChildIdentity {
  return {
    userMessageId: identity.userMessageId,
    turnId: identity.turnId,
    assistantMessageId: identity.assistantMessageId,
    durableRunId: identity.durableRunId,
  };
}

/** Build byte-stable child ids from one canonical cron-run id. */
export function buildCronChatAdmissionIdentity(token: CronRunExecutionToken): CronChatAdmissionIdentity {
  const cronRunId = token.runId.trim();
  const jobId = token.jobId.trim();
  const executionGeneration = token.executionGeneration;
  if (!cronRunId) {
    throw new Error("Deterministic cron Chat admission requires a canonical cron run id.");
  }
  if (!jobId) {
    throw new Error("Deterministic cron Chat admission requires a cron job id.");
  }
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 1) {
    throw new Error("Deterministic cron Chat admission requires a positive execution generation.");
  }
  const digest = createHash("sha256")
    .update(`${CRON_CHAT_ADMISSION_IDENTITY_VERSION}\0${cronRunId}`)
    .digest("hex")
    .slice(0, 40);
  return {
    version: CRON_CHAT_ADMISSION_IDENTITY_VERSION,
    cronRunId,
    jobId,
    executionGeneration,
    userMessageId: `msg_cron_user_${digest}`,
    turnId: `turn_cron_${digest}`,
    assistantMessageId: `msg_cron_assistant_${digest}`,
    durableRunId: `run_cron_chat_${digest}`,
  };
}

/** Stable inert-inbox task identity for the same canonical cron occurrence. */
export function buildCronInboxTaskId(token: CronRunExecutionToken): string {
  const cronRunId = token.runId.trim();
  const jobId = token.jobId.trim();
  if (!cronRunId || !jobId || !Number.isSafeInteger(token.executionGeneration) || token.executionGeneration < 1) {
    throw new Error("Deterministic cron inbox admission requires a valid canonical cron-run token.");
  }
  const digest = createHash("sha256").update(`cron.inbox.task.v1\0${cronRunId}`).digest("hex").slice(0, 40);
  return `task_cron_inbox_${digest}`;
}

function assertCronRunOwnsInvocation(
  token: CronRunExecutionToken,
  input: Pick<Parameters<typeof runCronAgentTurn>[1], "job" | "runId">,
): CronRunExecutionToken {
  const cronRunId = input.runId.trim();
  const jobId = input.job.jobId.trim();
  if (token.runId.trim() !== cronRunId || token.jobId.trim() !== jobId) {
    throw new Error(
      `Cron Chat admission owner mismatch: invocation ${jobId}/${cronRunId} does not match the canonical cron-run token.`,
    );
  }
  return token;
}

function assertCronChatAdmissionIdentity(identity: CronChatAdmissionIdentity, sessionId: string): void {
  const expected = buildCronChatAdmissionIdentity({
    runId: identity.cronRunId,
    jobId: identity.jobId,
    executionGeneration: identity.executionGeneration,
  });
  if (!cronChatAdmissionIdentityMatches(identity, expected)) {
    throw new Error(`Cron Chat admission identity for session ${sessionId} is not canonically derived.`);
  }
}

function assertPreparedAutonomousChatAdmission(
  prepared: PreparedAgentChatTurn,
  identity: AutonomousChatChildIdentity,
): void {
  if (
    prepared.userEventId !== identity.userMessageId ||
    prepared.turnId !== identity.turnId ||
    prepared.assistantMessageId !== identity.assistantMessageId
  ) {
    throw new Error(`Prepared autonomous Chat child does not match its immutable admission identity.`);
  }
}

async function readOwnedAutonomousChatAdmissionTrace(
  deps: Pick<ChatAutonomousTurnDeps, "storage">,
  sessionId: string,
  identity: AutonomousChatChildIdentity,
  ownerKind: "cron" | "autonomous",
): Promise<ChatTurnTraceRecord | undefined> {
  let trace: ChatTurnTraceRecord;
  try {
    trace = await deps.storage.chatTurnTraces.get(identity.turnId);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
  const conflicts = [
    trace.sessionId !== sessionId ? "session" : undefined,
    trace.userMessageId !== identity.userMessageId ? "user_message" : undefined,
    trace.assistantMessageId !== identity.assistantMessageId ? "assistant_message" : undefined,
    trace.branchKind !== "append" ? "branch" : undefined,
    trace.sourceTurnId !== undefined ? "source_turn" : undefined,
    trace.durable?.runId !== identity.durableRunId ? "durable_run" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    throw new Error(
      `Deterministic ${ownerKind} Chat trace ${identity.turnId} is owned by a conflicting admission (${conflicts.join(", ")}).`,
    );
  }
  return trace;
}

function assertOwnedCronChatDurableRun(
  run: DurableRunRecord,
  identity: CronChatAdmissionIdentity,
  expectedPayload: Record<string, unknown>,
): void {
  const metadata = run.metadata;
  if (
    run.runId !== identity.durableRunId ||
    run.workflowKey !== "chat.turn.execute" ||
    canonicalJsonString(run.payload) !== canonicalJsonString(expectedPayload) ||
    metadata?.cronRunId !== identity.cronRunId ||
    metadata?.cronJobId !== identity.jobId ||
    metadata?.cronExecutionGeneration !== identity.executionGeneration ||
    !cronChatAdmissionIdentityMatches(metadata?.cronAdmission, identity)
  ) {
    throw new Error(`Deterministic cron Chat child ${identity.durableRunId} is owned by a conflicting admission.`);
  }
}

function omitAutonomousChatRuntimeMutableMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS.has(key)),
  );
}

async function assertOwnedAutonomousDurableReplay(
  deps: Pick<ChatAutonomousTurnDeps, "storage" | "getDurableRun">,
  input: {
    identity: AutonomousChatChildIdentity;
    trace: ChatTurnTraceRecord;
    request: ChatSendMessageRequest;
    sessionId: string;
    systemActorId: string;
    kind: AutonomousTurnKind;
    sourceRunId: string;
    prompt: string;
    reason: string;
    deliverMode: NonNullable<CronAgentTurnConfig["deliverMode"]>;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
    profilePosture?: AgentTurnCronRunOutcome["profilePosture"];
    commitmentId?: string;
    admissionIdentity?: CronChatAdmissionIdentity;
  },
): Promise<{ terminal: boolean; requestProcessing: boolean; runStatus: DurableRunRecord["status"] }> {
  let run: DurableRunRecord;
  try {
    run = await deps.getDurableRun(input.identity.durableRunId);
  } catch (error) {
    throw new Error(
      `Deterministic autonomous Chat replay ${input.identity.durableRunId} has no durable owner: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const payload = run.payload as Record<string, unknown>;
  const frozenRequest = freezeChatTurnExecutionRequest(input.request);
  const expectedAdmissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(frozenRequest);
  const expectedEffectiveMaterialSha256 = computeEffectiveChatTurnRequestMaterialSha256(
    expectedAdmissionMaterialSha256,
    frozenRequest,
  );
  const requestActor =
    payload.requestActor && typeof payload.requestActor === "object" && !Array.isArray(payload.requestActor)
      ? (payload.requestActor as Record<string, unknown>)
      : undefined;
  const admissionId = typeof payload.admissionId === "string" ? payload.admissionId : "";
  const admission = admissionId ? await deps.storage.sessionMutationAdmissions.require(admissionId) : undefined;
  const expectedAutonomousMetadata = {
    kind: input.kind,
    systemActorId: input.systemActorId,
    sourceRunId: input.sourceRunId,
    reason: input.reason,
    deliverMode: input.deliverMode,
    ...(input.deliveryChannel ? { deliveryChannel: input.deliveryChannel } : {}),
    ...(input.profilePosture ? { profilePosture: input.profilePosture } : {}),
    ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
  };
  const expectedAutonomousAdmissionMaterial = buildAutonomousChatAdmissionMetadataMaterial({
    identity: toCanonicalAutonomousChatChildIdentity(input.identity),
    sessionId: input.sessionId,
    objective: frozenRequest.content,
    autonomous: expectedAutonomousMetadata,
    payload,
    capabilitySnapshotId: input.trace.capabilitySnapshotId,
    ...(input.admissionIdentity ? { cronAdmission: input.admissionIdentity } : {}),
  });
  const expectedImmutableMetadata = {
    surface: "chat",
    objective: frozenRequest.content,
    autonomous: expectedAutonomousMetadata,
    ...(typeof payload.capabilityProfileId === "string" && typeof payload.capabilityProfileHash === "string"
      ? {
          capabilityProfileId: payload.capabilityProfileId,
          capabilityProfileHash: payload.capabilityProfileHash,
        }
      : {}),
    [AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY]: sealAutonomousChatAdmissionMetadata(expectedAutonomousAdmissionMaterial),
    ...(input.admissionIdentity
      ? {
          cronRunId: input.admissionIdentity.cronRunId,
          cronJobId: input.admissionIdentity.jobId,
          cronExecutionGeneration: input.admissionIdentity.executionGeneration,
          cronAdmission: input.admissionIdentity,
        }
      : {}),
  };
  const durableMetadata = run.metadata ?? {};
  const immutableDurableMetadata = omitAutonomousChatRuntimeMutableMetadata(durableMetadata);
  const conflicts = [
    run.runId !== input.identity.durableRunId ? "run" : undefined,
    run.workflowKey !== "chat.turn.execute" ? "workflow" : undefined,
    payload.version !== "chat.turn.execute.v2" ? "version" : undefined,
    payload.sessionId !== input.sessionId ? "session" : undefined,
    payload.turnId !== input.identity.turnId ? "turn" : undefined,
    payload.userMessageId !== input.identity.userMessageId ? "user_message" : undefined,
    payload.assistantMessageId !== input.identity.assistantMessageId ? "assistant_message" : undefined,
    canonicalJsonString(payload.request) !== canonicalJsonString(frozenRequest) ? "request" : undefined,
    payload.admissionMaterialSha256 !== expectedAdmissionMaterialSha256 ? "current_admission_material" : undefined,
    payload.effectiveRequestMaterialSha256 !== expectedEffectiveMaterialSha256 ? "effective_material" : undefined,
    canonicalJsonString(payload.policyRunIdDerivation) !==
    canonicalJsonString({ version: 1, kind: "durable_run_id", runId: run.runId })
      ? "policy_run_derivation"
      : undefined,
    canonicalJsonString(requestActor) !== canonicalJsonString({ actorKind: "system", actorId: input.systemActorId })
      ? "actor"
      : undefined,
    !admission ? "admission" : undefined,
    admission && admission.admissionKind !== "turn_write" ? "admission_kind" : undefined,
    admission && admission.actorKind !== "system" ? "admission_actor_kind" : undefined,
    admission && admission.actorId !== input.systemActorId ? "admission_actor" : undefined,
    admission && admission.sessionId !== input.sessionId ? "admission_session" : undefined,
    admission && admission.turnId !== input.identity.turnId ? "admission_turn" : undefined,
    admission && admission.sessionIncarnationId !== payload.sessionIncarnationId ? "incarnation" : undefined,
    admission && admission.workspaceId !== payload.workspaceId ? "workspace" : undefined,
    admission && admission.materialSha256 !== payload.admissionMaterialSha256 ? "material" : undefined,
    admission && admission.aggregateRevision !== payload.admissionAggregateRevision ? "aggregate_revision" : undefined,
    admission && admission.controllerGeneration !== payload.admissionControllerGeneration
      ? "controller_generation"
      : undefined,
    canonicalJsonString(immutableDurableMetadata) !== canonicalJsonString(expectedImmutableMetadata)
      ? "metadata"
      : undefined,
    input.admissionIdentity
      ? canonicalJsonString(payload.cronAdmission) !== canonicalJsonString(input.admissionIdentity)
        ? "cron_admission"
        : undefined
      : payload.cronAdmission !== undefined
        ? "unexpected_cron_admission"
        : undefined,
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} has conflicting v2 admission lineage (${conflicts.join(", ")}).`,
    );
  }
  if (!admission) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no mutation admission.`);
  }
  const expectedAdmissionSeal = sealAutonomousChatAdmissionMetadata(expectedAutonomousAdmissionMaterial);
  const actualAdmissionSeal = readAutonomousChatAdmissionMetadataSeal(
    durableMetadata[AUTONOMOUS_CHAT_ADMISSION_METADATA_KEY],
  );
  if (canonicalJsonString(actualAdmissionSeal) !== canonicalJsonString(expectedAdmissionSeal)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a conflicting admission seal.`);
  }
  verifyAutonomousChatAdmissionRunMetadata(run, { admission, trace: input.trace });
  const capabilityProfileId = typeof payload.capabilityProfileId === "string" ? payload.capabilityProfileId : undefined;
  const capabilityProfileHash =
    typeof payload.capabilityProfileHash === "string" ? payload.capabilityProfileHash : undefined;
  const capabilityStoresPresent = Boolean(
    deps.storage.capabilityCatalogSnapshots && deps.storage.chatTurnCapabilityProfiles,
  );
  if (Boolean(deps.storage.capabilityCatalogSnapshots) !== Boolean(deps.storage.chatTurnCapabilityProfiles)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete capability stores.`);
  }
  if (Boolean(capabilityProfileId) !== Boolean(capabilityProfileHash)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete capability lineage.`);
  }
  if (capabilityStoresPresent && (!capabilityProfileId || !capabilityProfileHash)) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} is missing its v2 capability lineage.`);
  }
  if (capabilityProfileId && capabilityProfileHash) {
    const profile = await deps.storage.chatTurnCapabilityProfiles.findByTurn(input.identity.turnId);
    const snapshot = profile
      ? await deps.storage.capabilityCatalogSnapshots.find(profile.catalog.snapshotId)
      : undefined;
    const frozenRequestRecord = frozenRequest as typeof frozenRequest & { policyContext?: unknown };
    const frozenPolicyContext =
      frozenRequestRecord.policyContext &&
      typeof frozenRequestRecord.policyContext === "object" &&
      !Array.isArray(frozenRequestRecord.policyContext)
        ? (frozenRequestRecord.policyContext as Record<string, unknown>)
        : undefined;
    const frozenPermissionProfileId =
      typeof frozenPolicyContext?.permissionProfileId === "string"
        ? frozenPolicyContext.permissionProfileId
        : typeof frozenRequest.permissionProfileId === "string"
          ? frozenRequest.permissionProfileId
          : undefined;
    if (
      !profile ||
      profile.profileId !== capabilityProfileId ||
      profile.hashes.profileHash !== capabilityProfileHash ||
      profile.identity.durableRunId !== run.runId ||
      profile.identity.sessionId !== input.sessionId ||
      profile.identity.workspaceId !== payload.workspaceId ||
      profile.identity.turnId !== input.identity.turnId ||
      input.trace.capabilityProfileId !== capabilityProfileId ||
      input.trace.capabilityProfileHash !== capabilityProfileHash ||
      input.trace.capabilitySnapshotId !== profile.catalog.snapshotId ||
      !snapshot ||
      !frozenPermissionProfileId ||
      profile.governance.permission.profileId !== frozenPermissionProfileId
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting capability lineage.`);
    }
    verifyChatTurnCapabilityProfile(profile);
    verifyChatTurnCapabilityCatalogBinding(profile, snapshot);
    await deps.storage.sessionMutationAdmissions.requireCapabilityProfileBinding({
      admissionId: admission.admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: admission.sessionId,
      turnId: input.identity.turnId,
      profileId: profile.profileId,
      profileHash: profile.hashes.profileHash,
      createdAt: profile.createdAt,
    });
  }
  await verifyAutonomousChatReplayRuntimeAuthority(deps, run, admission, input.trace);
  if (admission.status !== "active") {
    const expectedAdmissionStatus = run.status === "completed" ? "completed" : "cancelled";
    if (
      !isDurableRunTerminal(run.status) ||
      admission.status !== expectedAdmissionStatus ||
      admission.terminalAuthorityKind !== "durable_terminal" ||
      admission.terminalDurableRunId !== run.runId ||
      admission.terminalDurableRunStatus !== run.status ||
      input.trace.durable?.runId !== run.runId ||
      input.trace.durable.status !== run.status ||
      !isExactAutonomousTerminalTraceStatus(run.status, input.trace.status)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting terminal authority.`);
    }
    return { terminal: true, requestProcessing: false, runStatus: run.status };
  }
  if (isDurableRunTerminal(run.status)) {
    if (
      run.leaseOwnerId !== undefined ||
      run.leaseExpiresAt !== undefined ||
      input.trace.durable?.runId !== run.runId ||
      input.trace.durable.status !== run.status ||
      !isExactAutonomousTerminalTraceStatus(run.status, input.trace.status)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting pending terminal authority.`);
    }
  }
  if (!admission.runtimeOwnerId || !admission.runtimeLeaseRevision) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no request-owner binding evidence.`);
  }
  const binding = await deps.storage.sessionMutationAdmissions.bindDurableRun({
    admissionId: admission.admissionId,
    workspaceId: admission.workspaceId,
    sessionId: admission.sessionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    turnId: input.identity.turnId,
    durableRunId: run.runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admission.runtimeOwnerId,
      leaseRevision: admission.runtimeLeaseRevision,
    },
  });
  if (binding.disposition !== "replayed") {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} had no committed durable binding.`);
  }
  return {
    terminal: false,
    requestProcessing: run.status === "queued" || isDurableRunTerminal(run.status),
    runStatus: run.status,
  };
}

function isExactAutonomousTerminalTraceStatus(
  runStatus: DurableRunRecord["status"],
  traceStatus: ChatTurnTraceRecord["status"],
): boolean {
  if (runStatus === "completed") return traceStatus === "completed" || traceStatus === "partial";
  if (runStatus === "failed" || runStatus === "dead_lettered") return traceStatus === "failed";
  if (runStatus === "cancelled") return traceStatus === "cancelled";
  return false;
}

async function verifyAutonomousChatReplayRuntimeAuthority(
  deps: Pick<ChatAutonomousTurnDeps, "storage">,
  run: DurableRunRecord,
  admission: Awaited<ReturnType<ChatAutonomousTurnDeps["storage"]["sessionMutationAdmissions"]["require"]>>,
  trace: ChatTurnTraceRecord,
): Promise<void> {
  const metadata = run.metadata ?? {};
  const authorityValue = metadata[CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY];
  const authority = readChatTurnRuntimeAuthoritySeal(authorityValue);
  const runtimeEvidenceWithoutAuthority = [...AUTONOMOUS_CHAT_RUNTIME_MUTABLE_METADATA_KEYS].filter(
    (key) =>
      key !== "retryPolicy" &&
      key !== CHAT_TURN_RUNTIME_AUTHORITY_METADATA_KEY &&
      !(key === "waitForEvent" && metadata[key] === null) &&
      metadata[key] !== undefined,
  );
  if (!authority) {
    if (run.status === "waiting" || isDurableRunTerminal(run.status) || runtimeEvidenceWithoutAuthority.length > 0) {
      throw new Error(
        `Deterministic autonomous Chat replay ${run.runId} has no checkpoint-anchored runtime authority.`,
      );
    }
    if (metadata.retryPolicy !== undefined) {
      assertDurableRetryPolicyMatchesRun(metadata.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
    }
    return;
  }
  if (run.status !== "waiting" && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} carries runtime authority for status ${run.status}.`,
    );
  }
  const payload = run.payload as { turnId?: unknown };
  const checkpointKind =
    run.status === "waiting"
      ? "run_waiting"
      : run.status === "completed"
        ? "run_completed"
        : run.status === "failed"
          ? "run_failed"
          : "run_cancelled";
  if (
    authority.material.runId !== run.runId ||
    authority.material.turnId !== payload.turnId ||
    authority.material.durableStatus !== run.status ||
    trace.status !== authority.material.traceStatus ||
    trace.durable?.runId !== run.runId ||
    trace.durable.status !== run.status ||
    trace.durable.checkpointKind !== checkpointKind ||
    run.leaseOwnerId !== undefined ||
    run.leaseExpiresAt !== undefined
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting runtime authority.`);
  }
  if (
    (run.status === "waiting" && authority.material.transitionKind !== "waiting") ||
    (run.status !== "waiting" &&
      authority.material.transitionKind !== "terminal" &&
      authority.material.transitionKind !== "linked_finalization")
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an invalid runtime transition.`);
  }
  const checkpoint = await deps.storage.durableRuns.getLatestCheckpointByKind(run.runId, checkpointKind);
  if (!checkpoint) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no ${checkpointKind} authority checkpoint.`);
  }
  verifyCheckpointAnchoredChatTurnRuntimeAuthority(metadata, checkpoint.state);
  assertDurableRetryPolicyMatchesRun(metadata.retryPolicy, run.maxAttempts, DURABLE_RETRY_POLICY_DEFAULT);
  verifyAutonomousReplayTerminalOutput(run, checkpoint.state, authority);
  verifyAutonomousReplayAuxiliaryRuntimeReceipts(run, authority);
  verifyAutonomousReplayFinalizerEvidence(run, admission, authority);
}

function verifyAutonomousReplayTerminalOutput(
  run: DurableRunRecord,
  checkpointState: Record<string, unknown>,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  const output = authority.material.terminalOutput;
  if (!output) {
    if (
      AUTONOMOUS_CHAT_TERMINAL_OUTPUT_METADATA_KEYS.some((key) => metadata[key] !== undefined) ||
      AUTONOMOUS_CHAT_TERMINAL_OUTPUT_CHECKPOINT_KEYS.some((key) => checkpointState[key] !== undefined)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stale terminal output evidence.`);
    }
    return;
  }
  if (
    typeof metadata.outputText !== "string" ||
    typeof metadata.outputSummary !== "string" ||
    metadata.finalOutput !== metadata.outputText ||
    metadata.finalSummary !== metadata.outputSummary ||
    metadata.outputMessageId !== undefined ||
    metadata.outputTraceStatus !== undefined ||
    output.assistantMessageId !== checkpointState.assistantMessageId ||
    metadata.outputText !== checkpointState.outputText ||
    metadata.outputSummary !== checkpointState.outputSummary ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputText) !== output.outputTextSha256 ||
    hashChatTurnRuntimeAuthorityValue(metadata.outputSummary) !== output.outputSummarySha256
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has terminal output authority drift.`);
  }
}

function verifyAutonomousReplayFinalizerEvidence(
  run: DurableRunRecord,
  admission: Awaited<ReturnType<ChatAutonomousTurnDeps["storage"]["sessionMutationAdmissions"]["require"]>>,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  const linkedPending = readExactLinkedFinalizationPendingMarker(metadata.linkedFinalizationPending);
  const linkedSettlement = readExactLinkedFinalizationSettlement(metadata.linkedFinalization);
  const autonomousPending = readExactAutonomousChatPostCommitPendingMarker(metadata.autonomousChatPostCommitPending);
  const autonomousSettlement = readExactAutonomousChatPostCommitSettlement(metadata.autonomousChatPostCommit);
  const generalPending = readExactGeneralChatPostCommitPendingMarker(metadata.generalChatPostCommitPending);
  const generalSettlement = readExactGeneralChatPostCommitSettlement(metadata.generalChatPostCommit);
  const handoff = readExactChatTurnAdmissionHandoff(metadata.chatTurnAdmissionHandoff);
  const required = authority.material.requiredFinalizers;

  const linkedRequired = required.includes("linked");
  if (linkedRequired) {
    const linkedAuthority = authority.material.linkedFinalization;
    if (
      !linkedAuthority ||
      Boolean(linkedPending) === Boolean(linkedSettlement) ||
      (linkedPending &&
        (linkedPending.finalizationId !== linkedAuthority.finalizationId ||
          linkedPending.requestedAt !== linkedAuthority.requestedAt ||
          hashChatTurnRuntimeAuthorityValue(linkedPending.reason) !== linkedAuthority.reasonSha256)) ||
      (linkedSettlement &&
        (linkedSettlement.finalizationId !== linkedAuthority.finalizationId ||
          linkedSettlement.requestedAt !== linkedAuthority.requestedAt ||
          linkedSettlement.reasonSha256 !== linkedAuthority.reasonSha256))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting linked finalization.`);
    }
  } else if (linkedPending || linkedSettlement) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stray linked finalization evidence.`);
  }

  const autonomousRequired = required.includes("autonomous");
  if (autonomousRequired) {
    if (
      Boolean(autonomousPending) === Boolean(autonomousSettlement) ||
      (autonomousPending &&
        (autonomousPending.generationId !== authority.material.postCommitGenerationId ||
          autonomousPending.requestedAt !== authority.material.transitionAt)) ||
      (autonomousSettlement &&
        (autonomousSettlement.generationId !== authority.material.postCommitGenerationId ||
          autonomousSettlement.requestedAt !== authority.material.transitionAt))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting autonomous finalization.`);
    }
  } else if (autonomousPending || autonomousSettlement) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} carries stray autonomous finalization evidence.`,
    );
  }

  if (!generalPending && !generalSettlement) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no general finalization evidence.`);
  }
  for (const evidence of [generalPending, generalSettlement]) {
    if (
      evidence &&
      (evidence.generationId !== authority.material.postCommitGenerationId ||
        evidence.traceStatus !== authority.material.traceStatus ||
        evidence.requestedAt !== authority.material.transitionAt ||
        canonicalJsonString(evidence.postCommitEligibility) !==
          canonicalJsonString(authority.material.postCommitEligibility))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has stale general finalization evidence.`);
    }
  }
  const priorFinalizerPending = Boolean(linkedPending || autonomousPending);
  if (priorFinalizerPending && generalSettlement) {
    throw new Error(
      `Deterministic autonomous Chat replay ${run.runId} settled general effects before its prior finalizer.`,
    );
  }
  if (generalPending && generalSettlement) {
    if (
      run.status === "waiting" ||
      (generalSettlement.settlementStatus !== "children_pending" &&
        generalSettlement.settlementStatus !== "waiting_for_parent_finalization") ||
      generalSettlement.completedAt !== undefined
    ) {
      throw new Error(
        `Deterministic autonomous Chat replay ${run.runId} has overlapping general finalization evidence.`,
      );
    }
  } else if (
    generalSettlement &&
    (generalSettlement.settlementStatus === "children_pending" ||
      generalSettlement.settlementStatus === "waiting_for_parent_finalization" ||
      typeof generalSettlement.completedAt !== "string")
  ) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has incomplete general settlement evidence.`);
  }

  if (run.status === "waiting") {
    if (handoff) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries a terminal handoff while waiting.`);
    }
    if (canonicalJsonString(metadata.waitForEvent) !== canonicalJsonString(authority.material.waitForEvent)) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has conflicting wait authority.`);
    }
    return;
  }
  if (metadata.waitForEvent !== undefined) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} carries stale wait authority.`);
  }
  if (generalSettlement) {
    if (!handoff) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has no exact terminal handoff.`);
    }
    const durableEffectRunIds = generalSettlement.durableEffectRunIds as Record<string, string>;
    const childRunIds = [...new Set(Object.values(durableEffectRunIds))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      handoff.admissionId !== admission.admissionId ||
      handoff.sessionIncarnationId !== admission.sessionIncarnationId ||
      handoff.turnId !== admission.turnId ||
      handoff.parentRunId !== run.runId ||
      handoff.postCommitGenerationId !== authority.material.postCommitGenerationId ||
      canonicalJsonString(handoff.childRunIds) !== canonicalJsonString(childRunIds) ||
      handoff.childRunIdsSha256 !== hashChatTurnRuntimeAuthorityValue(childRunIds)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a conflicting terminal handoff.`);
    }
  } else if (handoff) {
    throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an unowned terminal handoff.`);
  }
}

function verifyAutonomousReplayAuxiliaryRuntimeReceipts(
  run: DurableRunRecord,
  authority: ChatTurnRuntimeAuthoritySealV1,
): void {
  const metadata = run.metadata ?? {};
  if (metadata.approvalMaterializedPostCommit !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.approvalMaterializedPostCommit,
      ["version", "approvalId", "turnId", "traceStatus", "generationId", "requestedAt"],
      ["materializationKey"],
      "approval materialization receipt",
    );
    if (
      receipt.version !== 1 ||
      !isNonEmptyString(receipt.approvalId) ||
      receipt.turnId !== authority.material.turnId ||
      receipt.traceStatus !== authority.material.traceStatus ||
      receipt.generationId !== authority.material.postCommitGenerationId ||
      receipt.requestedAt !== authority.material.transitionAt ||
      (receipt.materializationKey !== undefined && !isNonEmptyString(receipt.materializationKey))
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a stale approval receipt.`);
    }
  }
  if (metadata.autonomyKillSwitch !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.autonomyKillSwitch,
      ["reason", "blockedAt", "message"],
      [],
      "autonomy kill-switch receipt",
    );
    if (
      authority.material.transitionKind !== "waiting" ||
      authority.material.waitForEvent?.eventKey !== "autonomy.v1.enabled" ||
      authority.material.waitForEvent.correlationId !== run.runId ||
      receipt.reason !== "autonomyV1Disabled" ||
      receipt.blockedAt !== authority.material.transitionAt ||
      !isNonEmptyString(receipt.message)
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has a stale kill-switch receipt.`);
    }
  }
  if (metadata.chatRetryExhaustionDeadLetterPending !== undefined) {
    const receipt = requireExactRuntimeRecord(
      metadata.chatRetryExhaustionDeadLetterPending,
      ["version", "attemptNo", "maxAttempts", "actorId", "reason", "reasonSha256", "requestedAt"],
      [],
      "retry-exhaustion receipt",
    );
    if (
      receipt.version !== 1 ||
      !Number.isSafeInteger(receipt.attemptNo) ||
      !Number.isSafeInteger(receipt.maxAttempts) ||
      Number(receipt.attemptNo) <= Number(receipt.maxAttempts) ||
      receipt.maxAttempts !== run.maxAttempts ||
      !isNonEmptyString(receipt.actorId) ||
      !isNonEmptyString(receipt.reason) ||
      receipt.reasonSha256 !== hashChatTurnRuntimeAuthorityValue(receipt.reason) ||
      receipt.requestedAt !== authority.material.transitionAt ||
      authority.material.transitionKind !== "linked_finalization" ||
      authority.material.linkedFinalization?.reasonSha256 !== receipt.reasonSha256
    ) {
      throw new Error(`Deterministic autonomous Chat replay ${run.runId} has an invalid retry-exhaustion receipt.`);
    }
  }
}

function requireExactRuntimeRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Autonomous Chat ${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`Autonomous Chat ${label} has an invalid shape.`);
  }
  return record;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function cronChatAdmissionIdentityMatches(value: unknown, expected: CronChatAdmissionIdentity): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CronChatAdmissionIdentity>;
  return (
    candidate.version === expected.version &&
    candidate.cronRunId === expected.cronRunId &&
    candidate.jobId === expected.jobId &&
    candidate.executionGeneration === expected.executionGeneration &&
    candidate.userMessageId === expected.userMessageId &&
    candidate.turnId === expected.turnId &&
    candidate.assistantMessageId === expected.assistantMessageId &&
    candidate.durableRunId === expected.durableRunId
  );
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
  if (await deps.isFeatureEnabled("autonomyV1Disabled")) {
    throw new Error("schedule.manage is disabled while the autonomy kill switch is engaged (autonomyV1Disabled).");
  }
  const parsed = parseScheduleManageArgs(args);
  if (parsed.op === "list") {
    const creatorKey = resolveScheduleCreatorKey(policyContext);
    const jobs = (await deps.cron.listCronJobs())
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
    const existing = await deps.cron.getCronJob(jobId);
    if (existing.action !== "agent_turn") {
      throw new Error(`schedule.manage cancel refused: ${jobId} is not an agent_turn schedule.`);
    }
    const createdBy = existing.actionConfig?.agentTurn?.createdBy;
    const owned = !!creatorKey && (createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey);
    if (!owned) {
      throw new Error(`schedule.manage cancel refused: ${jobId} is not owned by the caller.`);
    }
    const result = await deps.cron.deleteCronJob(jobId, existing.revision);
    return { op: "cancel", jobId: result.jobId, deleted: result.deleted };
  }
  // op === "create"
  const createdByJobId = await resolveSchedulingTurnJobId(deps, policyContext);
  const validated = validateScheduleCreate({
    args: parsed,
    policyContext,
    existingJobs: await deps.cron.listCronJobs(),
    ...(createdByJobId ? { createdByJobId } : {}),
  });
  const jobId = await generateScheduleJobId(deps, validated.name);
  const created = await deps.cron.createCronJob({
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
async function resolveSchedulingTurnJobId(
  deps: ChatAutonomousTurnDeps,
  policyContext: ToolPolicyActorContext | undefined,
): Promise<string | undefined> {
  if (!isScheduledTurnContext(policyContext) || !policyContext?.sessionId) {
    return undefined;
  }
  const sessionId = policyContext.sessionId;
  const match = (await deps.cron.listCronJobs()).find(
    (job) => job.action === "agent_turn" && job.actionConfig?.agentTurn?.sessionId === sessionId,
  );
  return match?.jobId;
}

/**
 * Generate a unique cron job id from a human name plus a short random suffix.
 * Conforms to the cron id rules (`^[a-z0-9][a-z0-9_-]{2,63}$`) and retries on
 * the (vanishingly rare) collision so a model-created schedule never clobbers
 * an existing job.
 */
async function generateScheduleJobId(deps: ChatAutonomousTurnDeps, name: string): Promise<string> {
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
      await deps.cron.getCronJob(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("schedule.manage create: could not allocate a unique job id; please retry.");
}

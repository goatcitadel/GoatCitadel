import { assertOwnedAutonomousDurableReplay, assertOwnedCronChatDurableRun,
  toCanonicalAutonomousChatChildIdentity, cronChatAdmissionIdentityMatches } from "./autonomous-chat-replay-authority.js";
import { createAutonomousOccurrenceAuthorityHost } from "./autonomous-chat-occurrence-guards.js";
/* eslint-disable max-lines -- Autonomous admission and recovery stay co-located while the runtime contract is being frozen. */
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  hasCurrentCronCreatorAuthority,
  NotFoundError,
} from "@goatcitadel/contracts";
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
  ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import {
  sealChatTurnCapabilityProfile,
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
  buildAutonomousChatAdmissionMetadataMaterial,
  sealAutonomousChatAdmissionMetadata,
  type AutonomousChatChildIdentity,
  type CanonicalCronChatAdmissionIdentity,
} from "./chat-durable-runtime-authority.js";
import { assertScheduledConfigMatches, assertScheduledOccurrenceCurrent, buildCronChatAdmissionIdentity,
  buildScheduledOccurrenceReference, readCurrentScheduledOccurrence } from "./scheduled-chat-authority.js";
export { buildCronChatAdmissionIdentity } from "./scheduled-chat-authority.js";
import { assertHeartbeatOccurrenceCurrent, buildHeartbeatOccurrenceReference } from "./heartbeat-chat-authority.js";

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
    | "cronRuns"
    | "cronJobs"
    | "sessions"
    | "workspaces"
    | "gatewaySql"
    | "runImmediateTransaction"
  >;
  cron: Pick<CronAutomationService, "listCronJobs" | "getCronJob" | "deleteCronJob" | "createCronJob" | "processCommitmentOccurrence">;
  isFeatureEnabled(flag: "autonomyV1Disabled" | "durableKernelV1Enabled" | "scheduledChatTurnsV1Enabled" | "proactiveHeartbeatTurnsV1Enabled" | "commitmentScheduledTurnsV1Enabled"): Promise<boolean>;
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
      scheduledOccurrence?: ChatTurnFeatureReferences["scheduledOccurrence"];
      heartbeatOccurrence?: ChatTurnFeatureReferences["heartbeatOccurrence"];
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
  if (autonomyDisabled || input.config.inertInboxFallback ||
    (input.config.commitment && !(await deps.isFeatureEnabled("commitmentScheduledTurnsV1Enabled")))) {
    const task = await deps.createCronInboxTask(input.job, inboxTaskId ? { taskId: inboxTaskId } : undefined);
    return { mode: "inbox", taskId: task.taskId };
  }
  const scheduledEnabled = Boolean(admissionIdentity && await deps.isFeatureEnabled("scheduledChatTurnsV1Enabled"));
  if (!scheduledEnabled) {
    let historicalRunExists = false;
    if (admissionIdentity) {
      try {
        await deps.storage.chatTurnTraces.get(admissionIdentity.turnId);
        historicalRunExists = true;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    if (!historicalRunExists) {
      const task = await deps.createCronInboxTask(input.job, inboxTaskId ? { taskId: inboxTaskId } : undefined);
      return { mode: "inbox", taskId: task.taskId };
    }
  }
  const currentOccurrence = scheduledEnabled && admissionIdentity
    ? await readCurrentScheduledOccurrence(deps, buildScheduledOccurrenceReference(admissionIdentity)) : undefined;
  if (currentOccurrence) assertScheduledConfigMatches(input.config, currentOccurrence.config);
  if (currentOccurrence && !input.config.commitment && !hasCurrentCronCreatorAuthority({
    ...currentOccurrence.job, action: "agent_turn", actionConfig: currentOccurrence.run.actionSnapshot.actionConfig as CronJobRecord["actionConfig"],
  })) {
    const task = await deps.createCronInboxTask(input.job, inboxTaskId ? { taskId: inboxTaskId } : undefined);
    return { mode: "inbox", taskId: task.taskId, profilePosture: "creator_profile_missing",
      profileWarning: "This schedule needs an authenticated action review before agent execution." };
  }
  if (input.config.commitment) {
    if (!currentOccurrence) throw new ConflictError({ message: "Commitment requires current canonical cron authority." });
    await deps.storage.agentCommitments.assertScheduledOccurrence(currentOccurrence.run.runId, currentOccurrence.config);
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
    occurrenceCreatedAt: currentOccurrence?.run.createdAt,
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
  if ((await deps.isFeatureEnabled("autonomyV1Disabled")) || !(await deps.isFeatureEnabled("durableKernelV1Enabled")) ||
    !(await deps.isFeatureEnabled("commitmentScheduledTurnsV1Enabled"))) {
    return;
  }
  await deps.storage.agentCommitments.reconcileScheduled();
  await runCommitmentSweepCore({
    isAutonomyEnabled: async () => !(await deps.isFeatureEnabled("autonomyV1Disabled")),
    listDueCommitments: async (nowIso, limit) => await deps.storage.agentCommitments.listDue(nowIso, limit),
    getSessionAutonomyPrefs: (sessionId) => deps.getSessionAutonomyPrefs(sessionId),
    deliverCommitment: async (commitment) => {
      const deliveryChannel = await resolveCommitmentDeliveryChannel(deps, commitment.sessionId);
      const run = await deps.storage.agentCommitments.claimScheduledOccurrence({
        commitmentId: commitment.commitmentId, expectedRevision: commitment.revision ?? 1, deliveryChannel,
      });
      await deps.cron.processCommitmentOccurrence(run.runId);
      return true;
    },
    // The claim transaction owns the pending transition. A crash after claiming is recovered by cron.
    markDeliveryPending: async () => true,
    markDeliveryFailed: async (commitmentId) => {
      const row = await deps.storage.agentCommitments.get(commitmentId);
      return row?.scheduledRunId ? false : await deps.storage.agentCommitments.markDeliveryFailed(commitmentId);
    },
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
  if ((await deps.isFeatureEnabled("autonomyV1Disabled")) || !(await deps.isFeatureEnabled("durableKernelV1Enabled")) ||
    !(await deps.isFeatureEnabled("proactiveHeartbeatTurnsV1Enabled"))) {
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
  // The session owner throws for missing records. Only look up an existing
  // scheduler session; a fresh one must reach the creation transaction below.
  if (existingMeta && (await deps.getSession(sessionId))) {
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
    occurrenceCreatedAt?: string;
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
    return { profilePosture: "creator_profile_missing", failClosedReason: "Scheduled agent turn has no creator provenance." };
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
    ...(input.occurrenceCreatedAt ? { now: input.occurrenceCreatedAt } : {}),
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
  const scheduledOccurrence = kind === "scheduled" && admissionIdentity && await deps.isFeatureEnabled("scheduledChatTurnsV1Enabled")
    ? buildScheduledOccurrenceReference(admissionIdentity) : undefined;
  const heartbeatReference = kind === "heartbeat" && heartbeatOccurrence && await deps.isFeatureEnabled("proactiveHeartbeatTurnsV1Enabled")
    ? buildHeartbeatOccurrenceReference(heartbeatOccurrence.occurrence) : undefined;
  if (!scheduledOccurrence && !heartbeatReference) {
    throw new Error(
      "Scheduled and heartbeat Chat execution is temporarily unavailable while new turns use live capabilities.",
    );
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
    const scheduledHost = createAutonomousOccurrenceAuthorityHost(deps);
    if (scheduledOccurrence) await assertScheduledOccurrenceCurrent(scheduledHost, { reference: scheduledOccurrence, admission: turnAdmission });
    if (heartbeatReference) await assertHeartbeatOccurrenceCurrent(scheduledHost, { reference: heartbeatReference, admission: turnAdmission });
    const prepared = await deps.prepareAgentChatTurn(input.sessionId, request, {
      ingestUserMessage: false,
      userMessageId: childIdentity.userMessageId,
      turnId: childIdentity.turnId,
      assistantMessageId: childIdentity.assistantMessageId,
      turnAdmission,
      ...(scheduledOccurrence ? { scheduledOccurrence } : {}),
      ...(heartbeatReference ? { heartbeatOccurrence: heartbeatReference } : {}),
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
    const capabilityCatalogSnapshots = deps.storage.capabilityCatalogSnapshots;
    const chatTurnCapabilityProfiles = deps.storage.chatTurnCapabilityProfiles;
    const capabilityStoresPresent = Boolean(capabilityCatalogSnapshots && chatTurnCapabilityProfiles);
    if (Boolean(capabilityCatalogSnapshots) !== Boolean(chatTurnCapabilityProfiles)) {
      throw new Error("Autonomous Chat capability admission stores are incompletely configured.");
    }
    if (scheduledOccurrence && (!prepared.featureAdmission ||
      canonicalJsonString(prepared.featureAdmission.references.scheduledOccurrence) !== canonicalJsonString(scheduledOccurrence))) {
      throw new Error("Scheduled Chat turn has no exact admitted occurrence reference.");
    }
    if (heartbeatReference && (!prepared.featureAdmission ||
      canonicalJsonString(prepared.featureAdmission.references.heartbeatOccurrence) !== canonicalJsonString(heartbeatReference))) {
      throw new Error("Heartbeat Chat turn has no exact admitted occurrence reference.");
    }
    if (capabilityStoresPresent && !scheduledOccurrence && !heartbeatReference && (!prepared.capabilityProfile || !prepared.capabilityCatalogSnapshot)) {
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
      if (scheduledOccurrence) await assertScheduledOccurrenceCurrent(scheduledHost, { reference: scheduledOccurrence, admission: turnAdmission });
      if (heartbeatReference) await assertHeartbeatOccurrenceCurrent(scheduledHost, { reference: heartbeatReference, admission: turnAdmission });
      if (prepared.capabilityProfile && prepared.capabilityCatalogSnapshot && capabilityStoresPresent) {
        await chatDurableRunService.persistPreparedChatCapabilityAdmission(
          {
            capabilityCatalogSnapshots,
            chatTurnCapabilityProfiles,
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
        if (!prepared.capabilityProfile && !prepared.featureAdmission?.references.heartbeatOccurrence) {
          throw new Error(`Heartbeat turn ${prepared.turnId} cannot bind without immutable occurrence authority.`);
        }
        await deps.storage.heartbeatOccurrences.markDurableBound({
          occurrenceId: heartbeatOccurrence.occurrence.occurrenceId,
          workspaceId: heartbeatOccurrence.occurrence.workspaceId,
          sessionId: heartbeatOccurrence.occurrence.sessionId,
          sessionIncarnationId: heartbeatOccurrence.occurrence.sessionIncarnationId,
          admissionId: heartbeatOccurrence.occurrence.admissionId,
          turnId: heartbeatOccurrence.occurrence.turnId,
          durableRunId: heartbeatOccurrence.occurrence.durableRunId,
          ...(heartbeatReference ? { featureReferenceSha256: prepared.featureAdmission!.referenceSha256 } : {
            capabilityProfileId: prepared.capabilityProfile!.profileId,
            capabilityProfileHash: prepared.capabilityProfile!.hashes.profileHash,
          }),
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

export function isNewAutonomousChatTurnAdmissionPaused(): boolean {
  // Generic autonomous/commitment turns remain paused. Canonical cron and
  // heartbeat occurrences have separate flags and exact owner-bound paths.
  return true;
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
  }, { actorId: validated.createdBy.operatorId ?? validated.createdBy.authActorId ?? "", source: "admitted_chat" });
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

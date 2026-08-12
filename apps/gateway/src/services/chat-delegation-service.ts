/* eslint-disable max-lines -- Chat delegation centralizes run persistence, child sessions, dependency ordering, and synthesis truth. */
import { createHash, randomUUID } from "node:crypto";
import type {
  AgenticDiagnosticSignal,
  AgenticSubagentMetadata,
  AgenticTaskContext,
  ChatCitationRecord,
  ChatDelegateAcceptRequest,
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatDelegationSuggestionRecord,
  ChatWorkspaceExplorerReport,
  ChatMode,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  DurableChatTurnRequestActorAuthority,
  PermissionProfileRecord,
  SubagentSessionStatus,
  TaskSubagentSession,
  TaskActivityRecord,
  TaskDeliverableRecord,
  TaskRecord,
  TaskStatus,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  chatModeRequiresProjectBinding,
  isDurableRunTerminal,
  NotFoundError,
  readDurableChatTurnExecutionPayloadAuthority,
  ValidationError,
} from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import { buildDeterministicAgentDurableRunId } from "./chat-turn-entry-service.js";
import type { ChildTimeoutLateSettleEvent } from "./subagent-budget-enforcer.js";
import {
  buildDelegationFailureGuidance,
  buildIncompleteDelegatedTraceFailureGuidance,
  DEFAULT_DELEGATION_ROLES,
  detectDelegationRoles,
  isIncompleteDelegatedTraceFailure,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";
import {
  computeChildDepth,
  enforceMaxDepth,
  runWithChildTimeout,
  SubagentBudgetError,
} from "./subagent-budget-enforcer.js";
import {
  READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID,
  projectWorkspaceExplorerPathValue,
  projectWorkspaceExplorerText,
} from "./workspace-explorer-path-projection.js";

const DEFAULT_SUBAGENT_DEFAULTS = {
  childTimeoutSeconds: 600,
  coworkChildTimeoutSeconds: null,
  maxDepth: 4,
} as const;
const EXPLORER_PRE_ADMISSION_LEASE_MS = 3_000;
const EXPLORER_RECONCILIATION_POLL_MS = 25;

export { READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID } from "./workspace-explorer-path-projection.js";
export const READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE = "read_only_workspace_explorer";
export const READ_ONLY_EXPLORER_ALLOWED_TOOLS = [
  "fs.read",
  "fs.list",
  "fs.stat",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
  "submit_work_result",
] as const;
export const READ_ONLY_EXPLORER_DENIED_TOOLS = [
  "session.*",
  "notify.*",
  "document.*",
  "context.*",
  "memory.*",
  "time.*",
  "fs.write",
  "fs.copy",
  "fs.move",
  "fs.delete",
  "http.*",
  "shell.*",
  "git.*",
  "tests.*",
  "lint.*",
  "build.*",
  "browser.*",
  "local_business.*",
  "mcp.*",
  "schedule.*",
  "citations.*",
  "docs.*",
  "embeddings.*",
  "artifacts.*",
  "documents.*",
  "presentations.*",
  "channel.*",
  "webhook.*",
  "gmail.*",
  "calendar.*",
  "discord.*",
  "imessage.*",
  "line.*",
  "mattermost.*",
  "nextcloud-talk.*",
  "telegram.*",
  "signal.*",
  "whatsapp.*",
  "slack.*",
  "google-chat.*",
  "teams.*",
  "zalo.*",
  "zalouser.*",
  "code_mode.*",
] as const;

export const READ_ONLY_EXPLORER_PERMISSION_PROFILE: PermissionProfileRecord = Object.freeze({
  profileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID,
  label: "Read-only workspace explorer",
  description:
    "Server-owned filesystem reads only; no write, execution, network, MCP, notification, or delegation tools.",
  builtin: true,
  status: "active",
  scope: "global",
  // All callable tools are bounded, side-effect-free reads except the result
  // envelope, whose scope-expansion branch creates its own canonical approval.
  // Requiring ordinary tool approval here would park every read and strand the
  // parent delegation after the child wake.
  approvalMode: "bypass",
  legacyToolProfile: "minimal",
  toolPatterns: [...READ_ONLY_EXPLORER_ALLOWED_TOOLS],
  allow: [...READ_ONLY_EXPLORER_ALLOWED_TOOLS],
  deny: [...READ_ONLY_EXPLORER_DENIED_TOOLS],
  readAccessMode: "roots_only",
  defaultForSurfaces: [],
  createdBy: "system-read-only-explorer",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
});

export function buildReadOnlyExplorerPolicyContext(
  inherited: ToolPolicyActorContext | undefined,
  scope: Pick<ToolPolicyActorContext, "workspaceId" | "sessionId" | "taskId" | "runId">,
): ToolPolicyActorContext {
  return {
    ...inherited,
    ...scope,
    surface: "chat",
    permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID,
    permissionProfile: READ_ONLY_EXPLORER_PERMISSION_PROFILE,
    localOperatorOverrideId: undefined,
    localOperatorOverride: undefined,
    fullWebAccess: false,
  };
}

const ELIGIBLE_EXPLORER_PARENT_STATUSES = new Set<DurableRunRecord["status"]>([
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
]);

export function assertEligibleReadOnlyExplorerDurableParent(input: {
  parentRun: DurableRunRecord | undefined;
  sessionId: string;
  workspaceId: string;
}): ReturnType<typeof readDurableChatTurnExecutionPayloadAuthority> & object {
  const parentRun = input.parentRun;
  if (!parentRun) {
    throw new ValidationError({ message: "Workspace exploration requires an existing durable Chat parent run." });
  }
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: parentRun.workflowKey,
    durableRunId: parentRun.runId,
    payload: parentRun.payload,
  });
  if (!authority) {
    throw new ValidationError({
      message: "Workspace exploration requires a canonical chat.turn.execute parent run.",
    });
  }
  if (authority.sessionId !== input.sessionId) {
    throw new ValidationError({ message: "Workspace exploration parent run belongs to a different Chat session." });
  }
  if (authority.workspaceId !== input.workspaceId) {
    throw new ValidationError({ message: "Workspace exploration parent run belongs to a different workspace." });
  }
  if (authority.requestActor.actorKind !== "operator") {
    throw new ValidationError({
      message: "Workspace exploration requires an operator-owned durable Chat parent run.",
    });
  }
  if (!ELIGIBLE_EXPLORER_PARENT_STATUSES.has(parentRun.status)) {
    throw new ValidationError({
      message: `Workspace exploration cannot attach to a ${parentRun.status} durable Chat parent run.`,
    });
  }
  return authority;
}

interface ChatDelegationProgressStatusEvent {
  runId: string;
  taskId: string;
  message: string;
}

export interface ChatDelegationProgressCallbacks {
  onStatus?: (event: ChatDelegationProgressStatusEvent) => Promise<void> | void;
  onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
}

export interface ChatDelegationRunOptions {
  abortSignal?: AbortSignal;
  /** Internal durable-effect recovery seam; never accepted from the public route. */
  persistedResume?: PersistedDelegationResumeAuthority;
}

export interface WorkspaceExplorerReconciliationOptions {
  /**
   * Rail reads wait only until the recovered child has a canonical durable
   * binding and required watcher (or launch fails). The Gateway continues to
   * own and drain the returned execution through this callback.
   */
  returnAfterDurableLaunch?: boolean;
  trackExecution?: (execution: Promise<unknown>) => void;
}

interface PersistedDelegationResumeAuthority {
  runId: string;
  stepId: string;
  durableRunId: string;
  childSessionId: string;
  childTurnId: string;
  workspaceId: string;
  request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext };
  dispatchAcquired?: boolean;
}

interface NormalizedDelegationStep {
  stepId: string;
  index: number;
  role: string;
  parallelizable: boolean;
  dependsOnStepIds: string[];
}

interface DelegationStepExecutionResult {
  step: ChatDelegationStepRecord;
  output?: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
  completed: boolean;
}

interface DelegationTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

class DelegationDispatchOwnershipError extends Error {
  public constructor(stepId: string) {
    super(`Delegation step ${stepId} dispatch ownership was superseded.`);
    this.name = "DelegationDispatchOwnershipError";
  }
}

class DelegationDurableLaunchRecoveryRequiredError extends Error {
  public constructor(stepId: string, cause: unknown) {
    super(
      `Delegation step ${stepId} launched durably but its required watcher binding must be recovered: ${formatUnknownError(cause)}`,
    );
    this.name = "DelegationDurableLaunchRecoveryRequiredError";
  }
}

export interface ChatDelegationServiceHost {
  storage: {
    chatSessionPrefs: {
      ensure(sessionId: string): Promise<ChatSessionPrefsRecord>;
    };
    chatSessionMeta: {
      ensure(sessionId: string): Promise<{ workspaceId?: string }>;
    };
    chatSessionProjects: {
      get(sessionId: string): Promise<{ projectId: string } | undefined>;
    };
    chatDelegationRuns: {
      create(input: {
        runId: string;
        parentRunId?: string;
        sessionId: string;
        taskId: string;
        objective: string;
        roles: string[];
        mode: "sequential" | "parallel";
        providerId?: string;
        model?: string;
        status: ChatDelegationRunRecord["status"];
        citations: ChatCitationRecord[];
      }): Promise<ChatDelegationRunRecord>;
      patch(
        runId: string,
        patch: Partial<ChatDelegationRunRecord> & { clearFinishedAt?: boolean },
      ): Promise<ChatDelegationRunRecord>;
      get(runId: string): Promise<ChatDelegationRunRecord>;
      getForUpdate(runId: string): Promise<ChatDelegationRunRecord>;
      listRecent?(input: {
        sessionId?: string;
        parentRunId?: string;
        limit?: number;
      }): Promise<ChatDelegationRunRecord[]>;
    };
    chatDelegationSteps: {
      readDatabaseNow(): Promise<string>;
      get(stepId: string): Promise<ChatDelegationStepRecord>;
      getDispatchClaim(stepId: string): Promise<{ token: string; expiresAt: string } | undefined>;
      create(
        input: Partial<ChatDelegationStepRecord> & {
          stepId: string;
          runId: string;
          role: string;
          index: number;
          status: ChatDelegationStepRecord["status"];
          startedAt: string;
        },
      ): Promise<ChatDelegationStepRecord>;
      patch(
        stepId: string,
        patch: Omit<Partial<ChatDelegationStepRecord>, "childSessionId" | "childTurnId"> & {
          childSessionId?: string | null;
          childTurnId?: string | null;
        },
      ): Promise<ChatDelegationStepRecord>;
      listByRun(runId: string): Promise<ChatDelegationStepRecord[]>;
      listByRunForUpdate(runId: string): Promise<ChatDelegationStepRecord[]>;
      claimPendingForDispatch(
        stepId: string,
        claimToken: string,
        claimExpiresAt: string,
        startedAt: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      reclaimRunningForDispatch(
        stepId: string,
        expectedClaimToken: string | undefined,
        claimToken: string,
        claimExpiresAt: string,
        startedAt: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      linkClaimedDispatch(
        stepId: string,
        claimToken: string,
        childSessionId: string,
        dispatchToken: string,
        dispatchExpiresAt: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      claimLinkedForDispatch(
        stepId: string,
        childSessionId: string,
        expectedChildTurnId: string | undefined,
        dispatchToken: string,
        dispatchExpiresAt: string,
        startedAt: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      reclaimLinkedDispatch(
        stepId: string,
        childSessionId: string,
        expectedDispatchToken: string,
        dispatchToken: string,
        dispatchExpiresAt: string,
        startedAt: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      finalizeLinkedDispatch(
        stepId: string,
        childSessionId: string,
        expectedDispatchMarker: string,
        childTurnId: string,
      ): Promise<ChatDelegationStepRecord | undefined>;
      ownsLinkedDispatch(stepId: string, childSessionId: string, dispatchToken: string): Promise<boolean>;
      bindOwnedDurableRun(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        durableRunId: string;
      }): Promise<ChatDelegationStepRecord | undefined>;
      extendOwnedDispatchLease(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        leaseExpiresAt: string;
      }): Promise<ChatDelegationStepRecord | undefined>;
      recoverDurableRunBinding(input: {
        stepId: string;
        childSessionId: string;
        childTurnId: string;
        durableRunId: string;
        releaseDispatch: boolean;
      }): Promise<ChatDelegationStepRecord | undefined>;
      finishOwnedDispatchWithError(input: {
        stepId: string;
        expectedDispatchToken: string;
        expectedChildSessionId?: string;
        status: "failed" | "cancelled";
        label?: string;
        summary?: string;
        error: string;
        failureGuidance?: string;
        finishedAt: string;
        durationMs: number;
      }): Promise<ChatDelegationStepRecord | undefined>;
      finishOwnedDispatchWithResponse(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        childTurnId: string;
        status: "running" | "completed" | "failed" | "cancelled";
        providerId?: string;
        model?: string;
        label?: string;
        summary?: string;
        output: string;
        error?: string;
        failureGuidance?: string;
        durableRunId?: string;
        citations: ChatCitationRecord[];
        workResult?: ChatDelegationStepRecord["workResult"];
        finishedAt?: string;
        durationMs?: number;
      }): Promise<ChatDelegationStepRecord | undefined>;
      releaseOwnedWaitingDispatch(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        childTurnId: string;
      }): Promise<ChatDelegationStepRecord | undefined>;
      finishUnclaimedPendingWithError(input: {
        stepId: string;
        status: "failed" | "cancelled" | "skipped";
        label?: string;
        summary?: string;
        error: string;
        failureGuidance?: string;
        finishedAt: string;
        durationMs: number;
      }): Promise<ChatDelegationStepRecord | undefined>;
    };
    chatTurnTraces: {
      get(turnId: string): Promise<ChatTurnTraceRecord>;
    };
    taskSubagents: {
      findByAgentSessionId(agentSessionId: string): Promise<TaskSubagentSession | undefined>;
    };
    runImmediateTransaction<T>(callback: () => T | Promise<T>): Promise<Awaited<T>>;
  };
  gatewaySql: {
    prepare(sql: string): {
      get(...params: unknown[]): Promise<unknown>;
    };
  };
  taskLifecycleService: {
    createTask(
      input: {
        workspaceId: string;
        title: string;
        description: string;
        status: "in_progress";
        priority: "normal";
        createdBy: string;
        agenticContext?: AgenticTaskContext;
      },
      options?: { taskId?: string },
    ): Promise<{ taskId: string }>;
    getTask(taskId: string): Promise<{
      taskId: string;
      workspaceId?: string;
      title?: string;
      description?: string;
      agenticContext?: AgenticTaskContext;
    }>;
    lockTaskForDelegationAggregate(taskId: string): Promise<{
      taskId: string;
      status: TaskStatus;
      agenticContext?: AgenticTaskContext;
    }>;
    lockDelegationSubagentProjection(agentSessionId: string): Promise<TaskSubagentSession>;
    persistDelegationAggregateTask(
      taskId: string,
      input: { status: TaskStatus; agenticContext: Partial<AgenticTaskContext> },
    ): Promise<TaskRecord>;
    publishDelegationAggregateTask(task: TaskRecord): void;
    persistDelegationSubagentProjection(
      agentSessionId: string,
      patch: { status: SubagentSessionStatus; endedAt?: string; metadata?: AgenticSubagentMetadata },
    ): Promise<TaskSubagentSession>;
    publishDelegationSubagentProjection(session: TaskSubagentSession): Promise<void>;
    persistDelegationActivity(
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
      createdAt: string,
    ): Promise<TaskActivityRecord>;
    persistDelegationActivityOnce(
      activityId: string,
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
      createdAt: string,
    ): Promise<{ activity: TaskActivityRecord; created: boolean }>;
    publishDelegationActivity(activity: TaskActivityRecord): Promise<void>;
    persistDelegationDeliverable(
      taskId: string,
      input: { deliverableType: "artifact"; title: string; description: string },
      createdAt: string,
    ): Promise<TaskDeliverableRecord>;
    publishDelegationDeliverable(deliverable: TaskDeliverableRecord): Promise<void>;
    appendTaskActivity(
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<unknown>;
    appendTaskDeliverable(
      taskId: string,
      input: { deliverableType: "artifact"; title: string; description: string },
    ): Promise<unknown>;
    updateTask(taskId: string, patch: { status: TaskStatus }): Promise<unknown>;
    updateTaskAgenticContext(taskId: string, patch: Partial<AgenticTaskContext>): Promise<unknown>;
    registerTaskSubagent(
      taskId: string,
      input: { agentSessionId: string; agentName: string; metadata?: AgenticSubagentMetadata },
    ): Promise<unknown>;
    updateTaskSubagent(
      agentSessionId: string,
      patch: { status: SubagentSessionStatus; endedAt?: string; metadata?: AgenticSubagentMetadata },
    ): Promise<unknown>;
  };
  getSession(sessionId: string): Promise<unknown>;
  getDurableRun(runId: string): Promise<DurableRunRecord | undefined>;
  listChatMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: string }>>;
  normalizeWorkspaceId(workspaceId?: string): string;
  ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  createChatSession(input: {
    stableKey?: string;
    workspaceId?: string;
    title?: string;
    projectId?: string;
    mode?: ChatMode;
  }): Promise<ChatSessionRecord>;
  inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): Promise<void>;
  configureReadOnlyExplorerSession?(sessionId: string, deniedToolPatterns: readonly string[]): Promise<void>;
  ensureSessionInternalToolGrant?(sessionId: string, toolName: string, reason: string): Promise<void>;
  resolveDelegatedFilesystemScope?(
    parentSessionId: string,
    dispatchGeneration: string,
    current?: ChatDelegationStepRecord["scopeControl"],
  ): Promise<ChatDelegationStepRecord["scopeControl"] | undefined>;
  assertDelegatedFilesystemScopeBinding?(
    parentSessionId: string,
    scope: NonNullable<ChatDelegationStepRecord["scopeControl"]>,
  ): Promise<void>;
  updateChatSessionPrefs(sessionId: string, patch: Partial<ChatSessionPrefsRecord>): Promise<ChatSessionPrefsRecord>;
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
  }): Promise<ToolPolicyActorContext>;
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      abortSignal?: AbortSignal;
      turnIdentity?: DelegationTurnIdentity;
      assertDispatchOwnership?: () => Promise<void>;
      onChildDurableRunLaunched?: (runId: string) => Promise<void>;
    },
  ): Promise<ChatSendMessageResponse>;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): Promise<void>;
  scheduleChatMemoryContextPrewarm(input: { sessionId: string; prompt: string; relationScope: "peer" }): void;
  validateReadOnlyExplorerParent?(input: {
    sessionId: string;
    policyRunId: string;
  }): Promise<{ workspaceId: string; requestActor: DurableChatTurnRequestActorAuthority }>;
  watchDurableChildRun?(input: {
    parentRunId: string;
    childRunId: string;
    watcherId: string;
    source: string;
    metadata: Record<string, unknown>;
    required?: boolean;
  }): Promise<void>;
  /**
   * Runtime budgets enforced on every child delegation step. When omitted the
   * service falls back to `{ childTimeoutSeconds: 600, maxDepth: 4 }`.
   */
  subagentDefaults?: {
    childTimeoutSeconds: number;
    coworkChildTimeoutSeconds?: number | null;
    maxDepth: number;
  };
}

export class ChatDelegationService {
  private readonly explorerReconciliations = new Map<string, Promise<{ repaired: boolean; reentered: boolean }>>();

  public constructor(private readonly deps: ChatDelegationServiceHost) {}

  /**
   * Repairs an Explorer whose durable child outlived the request observer or
   * Gateway process. The signed durable request is the authority for the
   * immutable child identity; no live session preferences or grants are read.
   */
  public async reconcilePersistedWorkspaceExplorer(
    input: {
      sessionId: string;
      delegationRunId: string;
    },
    options: WorkspaceExplorerReconciliationOptions = {},
  ): Promise<{ repaired: boolean; reentered: boolean }> {
    const key = `${input.sessionId}\u0000${input.delegationRunId}`;
    const active = this.explorerReconciliations.get(key);
    if (active) return await active;
    const reconciliation = this.reconcilePersistedWorkspaceExplorerInternal(input, options);
    this.explorerReconciliations.set(key, reconciliation);
    try {
      return await reconciliation;
    } finally {
      if (this.explorerReconciliations.get(key) === reconciliation) this.explorerReconciliations.delete(key);
    }
  }

  private async reconcilePersistedWorkspaceExplorerInternal(
    input: {
      sessionId: string;
      delegationRunId: string;
    },
    options: WorkspaceExplorerReconciliationOptions,
  ): Promise<{ repaired: boolean; reentered: boolean }> {
    const persisted = await this.deps.storage.chatDelegationRuns.get(input.delegationRunId);
    if (
      persisted.sessionId !== input.sessionId ||
      persisted.workflowTemplate !== READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE ||
      !persisted.parentRunId?.trim()
    ) {
      return { repaired: false, reentered: false };
    }
    if (!this.deps.validateReadOnlyExplorerParent) {
      throw new Error("Workspace explorer durable-parent validation is not configured.");
    }
    const validatedParent = await this.deps.validateReadOnlyExplorerParent({
      sessionId: persisted.sessionId,
      policyRunId: persisted.parentRunId,
    });
    const launchActor = normalizeReadOnlyExplorerLaunchActor({}, validatedParent.requestActor, false);
    let repaired = false;
    let reentered = false;
    const steps = await this.deps.storage.chatDelegationSteps.listByRun(persisted.runId);
    for (const observedStep of steps) {
      const expectedIdentity = buildStableDelegationTurnIdentity(persisted.runId, observedStep.stepId);
      const inferredDurableRunId =
        observedStep.durableRunId ?? buildDeterministicAgentDurableRunId(expectedIdentity.turnId);
      const inferredChildRun = observedStep.childSessionId
        ? await this.deps.getDurableRun(inferredDurableRunId)
        : undefined;
      if (
        (observedStep.status === "pending" || observedStep.status === "running") &&
        !observedStep.durableRunId &&
        !inferredChildRun
      ) {
        try {
          if (!observedStep.scopeControl || !this.deps.assertDelegatedFilesystemScopeBinding) {
            throw new Error("Workspace Explorer frozen scope validation is unavailable.");
          }
          await this.deps.assertDelegatedFilesystemScopeBinding(persisted.sessionId, observedStep.scopeControl);
        } catch {
          const terminalized = await terminalizeUnavailableWorkspaceExplorerStep(this.deps, persisted, observedStep);
          repaired ||= terminalized;
          continue;
        }
        let currentStep = observedStep;
        let databaseNowMs = Date.parse(await this.deps.storage.chatDelegationSteps.readDatabaseNow());
        let dispatchClaim = await this.deps.storage.chatDelegationSteps.getDispatchClaim(observedStep.stepId);
        if (!Number.isFinite(databaseNowMs)) {
          throw new Error("Database did not return a valid Workspace Explorer reconciliation clock.");
        }
        if (!isDelegationStepDispatchRecoverable(currentStep, dispatchClaim, expectedIdentity.turnId, databaseNowMs)) {
          const waitMs = dispatchClaim
            ? Math.max(
                0,
                Math.min(EXPLORER_PRE_ADMISSION_LEASE_MS, Date.parse(dispatchClaim.expiresAt) - databaseNowMs),
              )
            : 0;
          if (waitMs > 0) await waitForExplorerPreAdmissionLease(waitMs);
          currentStep = await this.deps.storage.chatDelegationSteps.get(observedStep.stepId);
          databaseNowMs = Date.parse(await this.deps.storage.chatDelegationSteps.readDatabaseNow());
          dispatchClaim = await this.deps.storage.chatDelegationSteps.getDispatchClaim(observedStep.stepId);
          if (
            !isDelegationStepDispatchRecoverable(currentStep, dispatchClaim, expectedIdentity.turnId, databaseNowMs)
          ) {
            continue;
          }
        }
        let recovered = currentStep;
        for (let launchAttempt = 0; launchAttempt < 2 && !recovered.durableRunId; launchAttempt += 1) {
          let releaseLaunchWait!: () => void;
          let launchWaitReleased = false;
          const launchWait = new Promise<void>((resolve) => {
            releaseLaunchWait = () => {
              if (launchWaitReleased) return;
              launchWaitReleased = true;
              resolve();
            };
          });
          const execution = this.runChatDelegation(
            persisted.sessionId,
            {
              objective: persisted.objective,
              roles: persisted.roles,
              mode: persisted.mode,
              providerId: persisted.providerId,
              model: persisted.model,
              ...launchActor,
              policyRunId: persisted.parentRunId,
              policyTaskId: persisted.taskId,
              executionProfile: "read_only_explorer",
            },
            {
              onStep: (step) => {
                if (step.stepId === observedStep.stepId && step.durableRunId) releaseLaunchWait();
              },
            },
          );
          const observedExecution = execution.then(
            (response) => {
              releaseLaunchWait();
              return response;
            },
            (error: unknown) => {
              releaseLaunchWait();
              throw error;
            },
          );
          if (options.returnAfterDurableLaunch) {
            if (!options.trackExecution) {
              throw new Error("Early Workspace Explorer reconciliation requires a Gateway-owned execution tracker.");
            }
            options.trackExecution(observedExecution);
            await launchWait;
          } else {
            await observedExecution;
          }
          recovered = await waitForExplorerStepAdmission(this.deps, observedStep.stepId);
        }
        repaired ||= Boolean(
          recovered.childSessionId || recovered.durableRunId || recovered.status !== observedStep.status,
        );
        reentered ||= repaired;
        continue;
      }
      if (observedStep.status !== "running" || !observedStep.childSessionId) continue;
      const durableRunId = inferredDurableRunId;
      const childRun = inferredChildRun ?? (await this.deps.getDurableRun(durableRunId));
      if (!childRun) continue;
      const authority = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: childRun.workflowKey,
        durableRunId: childRun.runId,
        payload: childRun.payload,
      });
      if (
        !authority ||
        authority.requestActor.actorKind !== "operator" ||
        authority.sessionId !== observedStep.childSessionId ||
        authority.turnId !== expectedIdentity.turnId ||
        authority.userMessageId !== expectedIdentity.userMessageId ||
        authority.assistantMessageId !== expectedIdentity.assistantMessageId ||
        authority.request.parentDelegationStepId !== observedStep.stepId ||
        authority.request.policyRunId !== persisted.runId ||
        authority.request.policyTaskId !== persisted.taskId
      ) {
        throw new Error(
          `Workspace Explorer ${persisted.runId} durable authority does not match step ${observedStep.stepId}.`,
        );
      }
      const terminal = isDurableRunTerminal(childRun.status);
      const bound = await this.deps.storage.runImmediateTransaction(async () => {
        const recovered = await this.deps.storage.chatDelegationSteps.recoverDurableRunBinding({
          stepId: observedStep.stepId,
          childSessionId: observedStep.childSessionId!,
          childTurnId: expectedIdentity.turnId,
          durableRunId,
          releaseDispatch: terminal,
        });
        if (!recovered) return undefined;
        await attachDelegationChildWatcher(this.deps, {
          parentRunId: persisted.parentRunId,
          childRunId: durableRunId,
          required: true,
          watcherId: `delegation-child:${observedStep.stepId}`,
          delegationRunId: persisted.runId,
          stepId: observedStep.stepId,
          childSessionId: observedStep.childSessionId!,
          childTurnId: expectedIdentity.turnId,
        });
        return recovered;
      });
      if (!bound) continue;
      repaired = true;
      if (terminal) {
        const resumed = await this.resumePersistedChatDelegation({
          delegationRunId: persisted.runId,
          stepId: observedStep.stepId,
          durableRunId,
        });
        reentered ||= resumed.reenteredPersistedStep;
      }
    }
    return { repaired, reentered };
  }

  public async resumePersistedChatDelegation(input: {
    delegationRunId: string;
    stepId: string;
    durableRunId: string;
  }): Promise<ChatDelegateResponse & { reenteredPersistedStep: boolean }> {
    const persisted = await this.deps.storage.chatDelegationRuns.get(input.delegationRunId);
    if (!persisted.parentRunId?.trim()) {
      throw new Error(`Delegation scope resume ${input.stepId} has no durable parent binding.`);
    }
    const persistedSteps = await this.deps.storage.chatDelegationSteps.listByRun(persisted.runId);
    const resumeStep = persistedSteps.find((step) => step.stepId === input.stepId);
    if (
      !resumeStep ||
      resumeStep.runId !== persisted.runId ||
      resumeStep.status !== "running" ||
      resumeStep.durableRunId !== input.durableRunId ||
      !resumeStep.childSessionId ||
      !resumeStep.childTurnId
    ) {
      throw new Error(`Delegation scope resume ${input.stepId} has no exact active child binding.`);
    }
    const childRun = await this.deps.getDurableRun(input.durableRunId);
    const authority = childRun
      ? readDurableChatTurnExecutionPayloadAuthority({
          workflowKey: childRun.workflowKey,
          durableRunId: childRun.runId,
          payload: childRun.payload,
        })
      : undefined;
    const expectedIdentity = buildStableDelegationTurnIdentity(persisted.runId, resumeStep.stepId);
    if (
      !authority ||
      authority.requestActor.actorKind !== "operator" ||
      authority.sessionId !== resumeStep.childSessionId ||
      authority.turnId !== resumeStep.childTurnId ||
      authority.turnId !== expectedIdentity.turnId ||
      authority.userMessageId !== expectedIdentity.userMessageId ||
      authority.assistantMessageId !== expectedIdentity.assistantMessageId ||
      authority.request.parentDelegationStepId !== resumeStep.stepId ||
      authority.request.policyRunId !== persisted.runId ||
      authority.request.policyTaskId !== persisted.taskId
    ) {
      throw new Error(`Delegation scope resume ${input.stepId} durable authority does not match its persisted step.`);
    }
    const request = restorePersistedDelegationRequest(authority.request, authority.requestActor);
    const persistedResume: PersistedDelegationResumeAuthority = {
      runId: persisted.runId,
      stepId: resumeStep.stepId,
      durableRunId: input.durableRunId,
      childSessionId: resumeStep.childSessionId,
      childTurnId: resumeStep.childTurnId,
      workspaceId: authority.workspaceId,
      request,
    };
    const response = await this.runChatDelegation(
      persisted.sessionId,
      {
        objective: persisted.objective,
        roles: persisted.roles,
        mode: persisted.mode,
        providerId: asOptionalTrimmedString(request.providerId) ?? persisted.providerId,
        model: asOptionalTrimmedString(request.model) ?? persisted.model,
        steps: persistedSteps.map((step) => ({
          stepId: step.stepId,
          index: step.index,
          role: step.role,
          parallelizable: Boolean(step.parallelizable),
          dependsOnStepIds: [...(step.dependsOnStepIds ?? [])],
        })),
        operatorId: request.operatorId,
        authActorId: request.authActorId,
        authActorSource: request.authActorSource,
        permissionProfileId: request.permissionProfileId,
        localOperatorOverrideId: request.localOperatorOverrideId,
        policyRunId: persisted.parentRunId,
        policyTaskId: persisted.taskId,
        fullWebAccess: request.fullWebAccess,
        ...(persisted.workflowTemplate === READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE
          ? { executionProfile: "read_only_explorer" as const }
          : {}),
      },
      undefined,
      { persistedResume },
    );
    return { ...response, reenteredPersistedStep: persistedResume.dispatchAcquired === true };
  }

  public async runChatDelegation(
    sessionId: string,
    input: ChatDelegateRequest,
    callbacks?: ChatDelegationProgressCallbacks,
    options: ChatDelegationRunOptions = {},
  ): Promise<ChatDelegateResponse> {
    const deps = this.deps;
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("objective is required");
    }
    const roles = normalizeDelegationRoles(input.roles);
    if (roles.length === 0) {
      throw new Error("at least one role is required");
    }
    const requestedMode = input.mode ?? "sequential";
    const explorerProfile = input.executionProfile === "read_only_explorer";
    if (explorerProfile && !input.policyRunId?.trim()) {
      throw new ValidationError({
        message: "Workspace exploration requires a durable parent run for progress and recovery.",
      });
    }
    if (
      explorerProfile &&
      (requestedMode !== "sequential" ||
        roles.length !== 1 ||
        (input.steps?.length && !options.persistedResume) ||
        roles[0] !== "workspace-explorer")
    ) {
      throw new ValidationError({ message: "Workspace exploration requires one sequential delegated child." });
    }
    let validatedExplorerWorkspaceId: string | undefined;
    let validatedExplorerActor: Pick<ChatDelegateRequest, "operatorId" | "authActorId" | "authActorSource"> | undefined;
    if (explorerProfile) {
      if (!deps.validateReadOnlyExplorerParent) {
        throw new Error("Workspace explorer durable-parent validation is not configured.");
      }
      const validatedParent = await deps.validateReadOnlyExplorerParent({
        sessionId,
        policyRunId: input.policyRunId!.trim(),
      });
      validatedExplorerWorkspaceId = validatedParent.workspaceId;
      validatedExplorerActor = normalizeReadOnlyExplorerLaunchActor(input, validatedParent.requestActor, true);
    }
    const parentSession = (await deps.getSession(sessionId)) as { origin?: string } | undefined;
    // Prompt-pack sessions are headless evals: children must inherit the
    // eval-integrity profile or they could park on approvals forever.
    const inheritedNormalizationProfile =
      parentSession?.origin === "prompt_pack" ? ("prompt_pack_harness" as const) : undefined;
    const mode = requestedMode;
    const requestedDelegationSteps = normalizeDelegationSteps({
      roles,
      mode,
      steps: input.steps,
    });
    const basePrefs = await deps.ensureChatSessionModelDefaults(
      sessionId,
      await deps.storage.chatSessionPrefs.ensure(sessionId),
    );
    const prefs = options.persistedResume
      ? restorePersistedDelegationPreferences(basePrefs, options.persistedResume.request)
      : explorerProfile
        ? buildReadOnlyExplorerSessionPrefs(basePrefs)
        : basePrefs;
    const executionMode: ChatMode = "chat";
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId =
      validatedExplorerWorkspaceId ??
      deps.normalizeWorkspaceId((await deps.storage.chatSessionMeta.ensure(sessionId)).workspaceId);
    if (options.persistedResume && options.persistedResume.workspaceId !== sessionWorkspaceId) {
      throw new Error(`Delegation scope resume ${options.persistedResume.stepId} workspace binding changed.`);
    }
    const parentProjectId = (await deps.storage.chatSessionProjects.get(sessionId))?.projectId;
    if (chatModeRequiresProjectBinding(executionMode) && !parentProjectId) {
      throw new ValidationError({ message: "Code delegation requires a project-bound parent session." });
    }
    throwIfChatDelegationAborted(options.abortSignal);

    let stableParentRun = options.persistedResume
      ? await loadExplicitDelegationResumeRun(deps, {
          runId: options.persistedResume.runId,
          sessionId,
          objective,
          mode,
          roles,
          workflowTemplate: explorerProfile ? READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE : undefined,
        })
      : await findStableParentDelegationRun(deps, {
          sessionId,
          policyRunId: input.policyRunId,
          objective,
          mode,
          roles,
          workflowTemplate: explorerProfile ? READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE : undefined,
        });
    let repairStableParentBeforeDispatch = false;
    const stablePolicyRunId = input.policyRunId?.trim();
    const runId =
      stableParentRun?.runId ??
      (stablePolicyRunId ? buildStableDelegationId("delegation-run", sessionId, stablePolicyRunId) : randomUUID());
    let existingSteps = stableParentRun ? await deps.storage.chatDelegationSteps.listByRun(runId) : [];
    const normalizedRequestedSteps = stablePolicyRunId
      ? stabilizeDelegationPlan(runId, requestedDelegationSteps)
      : requestedDelegationSteps;
    let delegationSteps = rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
    let frozenExplorerScope = explorerProfile ? existingSteps[0]?.scopeControl : undefined;
    if (explorerProfile && stableParentRun && !frozenExplorerScope) {
      throw new Error(`Workspace Explorer ${stableParentRun.runId} has no frozen filesystem scope.`);
    }
    if (explorerProfile && frozenExplorerScope) {
      if (!deps.assertDelegatedFilesystemScopeBinding) {
        throw new Error("Workspace explorer scope-binding validation is not configured.");
      }
      await deps.assertDelegatedFilesystemScopeBinding(sessionId, frozenExplorerScope);
      if (parentProjectId !== frozenExplorerScope.projectId) {
        throw new ValidationError({ message: "Workspace exploration project binding changed." });
      }
    }
    if (explorerProfile && !stableParentRun) {
      const initialStep = delegationSteps[0]!;
      const scopeGeneration = buildStableDelegationId("explorer-scope", runId, initialStep.stepId);
      frozenExplorerScope = await deps.resolveDelegatedFilesystemScope?.(sessionId, scopeGeneration);
      if (!frozenExplorerScope || !frozenExplorerScope.projectId || frozenExplorerScope.projectId !== parentProjectId) {
        throw new ValidationError({
          message: "Workspace exploration requires a verified project-bound filesystem scope.",
        });
      }
    }
    if (stableParentRun && stableParentRun.status !== "running") {
      const terminalReplay = await resolveStableTerminalDelegationReplay(
        deps,
        stableParentRun.runId,
        stableParentRun.taskId,
        normalizedRequestedSteps,
      );
      if (terminalReplay.kind === "terminal") {
        if (terminalReplay.committedAggregate) {
          await publishDelegationAggregateCommit(deps, terminalReplay.committedAggregate);
        } else if (terminalReplay.summaryReceipt?.created) {
          await publishDelegationPostCommitSafely("terminal summary", () =>
            deps.taskLifecycleService.publishDelegationActivity(terminalReplay.summaryReceipt!.activity),
          );
        }
        return {
          runId: stableParentRun.runId,
          taskId: stableParentRun.taskId,
          status: terminalReplay.projection.status,
          executionPlanId: stableParentRun.executionPlanId,
          steps: terminalReplay.persistedSteps,
          stitchedOutput: terminalReplay.projection.stitchedOutput,
          citations: terminalReplay.projection.citations,
          trace: stableParentRun.trace,
          ...(explorerProfile
            ? {
                explorer: buildWorkspaceExplorerReport(
                  {
                    ...stableParentRun,
                    status: terminalReplay.projection.status,
                    stitchedOutput: terminalReplay.projection.stitchedOutput,
                  },
                  terminalReplay.persistedSteps,
                ),
              }
            : {}),
        };
      }
      repairStableParentBeforeDispatch = true;
      existingSteps = await deps.storage.chatDelegationSteps.listByRun(runId);
      delegationSteps = rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
    }
    const stages = buildDelegationStages(delegationSteps);
    const maxSpawn = mode === "parallel" ? 4 : 1;
    const childRunIds = delegationSteps.map((step) => `${runId}:${step.stepId}`);
    const taskInput = {
      workspaceId: sessionWorkspaceId,
      title: `Delegation: ${objective.slice(0, 120)}`,
      description: objective,
      status: "in_progress" as const,
      priority: "normal" as const,
      createdBy: "chat",
      agenticContext: {
        boardId: `chat:${sessionWorkspaceId}`,
        runId,
        parentRunId: input.policyRunId,
        childRunIds,
        parentSessionId: sessionId,
        surface: executionMode,
        status: "running" as const,
        contextMode: "fork" as const,
        workspaceScope: {
          kind: "session" as const,
        },
        providerId,
        model,
        maxSpawn,
        activeChildCount: 0,
        deliveryState: {
          status: "not_required" as const,
          attempts: 0,
        },
      },
    };
    const task = await (stableParentRun
      ? { taskId: stableParentRun.taskId }
      : stablePolicyRunId
        ? createOrLoadStableDelegationTask(deps, buildStableDelegationId("delegation-task", runId), taskInput)
        : deps.taskLifecycleService.createTask(taskInput));

    if (repairStableParentBeforeDispatch && stableParentRun) {
      const repaired = await commitDelegationAggregate(deps, {
        runId,
        taskId: task.taskId,
        trace: stableParentRun.trace,
        observedAt: new Date().toISOString(),
      });
      stableParentRun = {
        ...stableParentRun,
        status: repaired.status,
        stitchedOutput: repaired.stitchedOutput,
        citations: repaired.citations,
      };
    }

    let resumedExistingRun = Boolean(stableParentRun);
    const persistPlan = async (): Promise<void> => {
      if (!stableParentRun) {
        await deps.storage.chatDelegationRuns.create({
          runId,
          parentRunId: input.policyRunId,
          sessionId,
          taskId: task.taskId,
          objective,
          roles: dedupeStrings(delegationSteps.map((step) => step.role)),
          mode,
          providerId,
          model,
          status: "running",
          ...(explorerProfile ? { workflowTemplate: READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE } : {}),
          citations: [],
        });
      }
      const existingStepIds = new Set(existingSteps.map((step) => step.stepId));
      const plannedAt = new Date().toISOString();
      for (const step of delegationSteps) {
        if (existingStepIds.has(step.stepId)) {
          continue;
        }
        await deps.storage.chatDelegationSteps.create({
          stepId: step.stepId,
          runId,
          role: step.role,
          label: step.role,
          index: step.index,
          status: "pending",
          parallelizable: step.parallelizable,
          dependsOnStepIds: step.dependsOnStepIds,
          ...(explorerProfile && step.index === 0 ? { scopeControl: frozenExplorerScope } : {}),
          startedAt: plannedAt,
        });
      }
    };
    try {
      if (deps.storage.runImmediateTransaction) {
        await deps.storage.runImmediateTransaction(persistPlan);
      } else {
        await persistPlan();
      }
    } catch (error) {
      const concurrentRun = await findStableParentDelegationRun(deps, {
        sessionId,
        policyRunId: input.policyRunId,
        objective,
        mode,
        roles,
        workflowTemplate: explorerProfile ? READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE : undefined,
      });
      if (!concurrentRun || concurrentRun.runId !== runId || concurrentRun.taskId !== task.taskId) {
        throw error;
      }
      stableParentRun = concurrentRun;
      existingSteps = await deps.storage.chatDelegationSteps.listByRun(runId);
      rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
      resumedExistingRun = true;
    }
    let ownsAnyOutcome = false;
    let ownsTerminalSummary = false;
    await callbacks?.onStatus?.({
      runId,
      taskId: task.taskId,
      message: resumedExistingRun ? "Delegation resumed." : "Delegation started.",
    });
    await deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation ${resumedExistingRun ? "resumed" : "started"} (${delegationSteps.map((step) => step.role).join(mode === "parallel" ? " | " : " -> ")})`,
      metadata: { runId, sessionId, mode, requestedMode, surfaceMode: executionMode },
    });

    let trace: ChatTurnTraceRecord["routing"] | undefined = stableParentRun?.trace;
    const completedOutputs = new Map<string, { role: string; output: string }>();
    const stepResults = new Map<string, DelegationStepExecutionResult>();
    for (const persistedStep of await deps.storage.chatDelegationSteps.listByRun(runId)) {
      stepResults.set(persistedStep.stepId, {
        step: persistedStep,
        output: persistedStep.output,
        citations: persistedStep.citations ?? [],
        completed: persistedStep.status === "completed",
      });
      if (persistedStep.status === "completed" && persistedStep.output?.trim()) {
        completedOutputs.set(persistedStep.stepId, {
          role: persistedStep.role,
          output: persistedStep.output.slice(0, 4000),
        });
      }
    }
    const subagentDefaults = deps.subagentDefaults ?? DEFAULT_SUBAGENT_DEFAULTS;
    const childTimeoutSeconds = subagentDefaults.childTimeoutSeconds;
    const inferredParentDepth = await resolveInferredParentDepth(deps, sessionId);
    const parentDepth = input.parentSubagentDepth ?? inferredParentDepth;
    const childDepth = computeChildDepth(parentDepth);
    let inheritedPolicyContext: ToolPolicyActorContext | undefined;
    try {
      inheritedPolicyContext = options.persistedResume
        ? restorePersistedDelegationPolicyContext(options.persistedResume.request, {
            workspaceId: sessionWorkspaceId,
            sessionId,
            taskId: task.taskId,
            runId,
          })
        : explorerProfile
          ? {
              ...validatedExplorerActor,
              workspaceId: sessionWorkspaceId,
              sessionId,
              taskId: task.taskId,
              runId,
              surface: executionMode,
            }
          : await deps.resolveToolPolicyContext?.({
              operatorId: input.operatorId,
              authActorId: input.authActorId,
              authActorSource: input.authActorSource,
              workspaceId: sessionWorkspaceId,
              sessionId,
              taskId: task.taskId,
              runId,
              surface: executionMode,
              permissionProfileId: input.permissionProfileId,
              localOperatorOverrideId: input.localOperatorOverrideId,
            });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = formatUnknownError(error);
      const committedFailure = await deps.storage.runImmediateTransaction(async () => {
        const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId);
        const aggregate = await persistDelegationAggregateFromLockedTruth(
          deps,
          {
            runId,
            taskId: task.taskId,
            observedAt: finishedAt,
            preDispatchFailure: message,
          },
          locks,
        );
        const activity = aggregate.aggregatePersisted
          ? await deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              {
                activityType: "diagnostic",
                message: `Delegation failed before dispatch: ${message}`,
                metadata: { runId, sessionId, surfaceMode: executionMode, error: message },
              },
              finishedAt,
            )
          : undefined;
        return { aggregate, activity };
      });
      if (committedFailure.activity) {
        await publishDelegationPostCommitSafely("pre-dispatch failure activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(committedFailure.activity!),
        );
      }
      await publishDelegationAggregateCommit(deps, committedFailure.aggregate);
      if (committedFailure.aggregate.aggregatePersisted) {
        await callbacks?.onStatus?.({
          runId,
          taskId: task.taskId,
          message: "Delegation failed before dispatch.",
        });
      }
      throw error;
    }
    const executeDelegationStep = async (step: NormalizedDelegationStep): Promise<DelegationStepExecutionResult> => {
      const startedAt = await deps.storage.chatDelegationSteps.readDatabaseNow();
      const childRunId = `${runId}:${step.stepId}`;
      const turnIdentity = buildStableDelegationTurnIdentity(runId, step.stepId);
      const childMetadataBase: AgenticSubagentMetadata = {
        runId: childRunId,
        parentRunId: runId,
        profileId: step.role,
        contextMode: "isolated",
        index: step.index,
        depth: childDepth,
        dependsOnStepIds: step.dependsOnStepIds,
        heartbeatAt: startedAt,
      };
      const dependencyContext = step.dependsOnStepIds
        .map((dependencyStepId) => completedOutputs.get(dependencyStepId))
        .filter((item): item is { role: string; output: string } => Boolean(item));
      let registeredAgentSessionId: string | undefined;
      let childSessionId: string | undefined;
      let dispatchOwnership: { token: string; childSessionId?: string } | undefined;
      let subagentDiagnostics: AgenticDiagnosticSignal[] = [];
      let timeoutFailureFenceState: "pending" | "won" | "lost" = "pending";
      let bufferedLateSettle: ChildTimeoutLateSettleEvent<ChatSendMessageResponse> | undefined;
      let lateSettleRecordScheduled = false;
      let scheduleLateSettleRecord: ((event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>) => void) | undefined;

      try {
        throwIfChatDelegationAborted(options.abortSignal);
        enforceMaxDepth({ depth: childDepth, maxDepth: subagentDefaults.maxDepth });
        const dispatchLease = await acquireDelegationDispatchLease(deps, {
          stepId: step.stepId,
          turnIdentity,
          startedAt,
          leaseDurationMs: explorerProfile
            ? EXPLORER_PRE_ADMISSION_LEASE_MS
            : Math.max(60_000, (childTimeoutSeconds + 60) * 1000),
        });
        if (!dispatchLease) {
          const current = await deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        dispatchOwnership = {
          token: dispatchLease.childSessionId
            ? dispatchLease.dispatchMarker
            : (dispatchLease.claimMarker ?? dispatchLease.dispatchMarker),
          childSessionId: dispatchLease.childSessionId,
        };

        let agentSessionId = dispatchLease.childSessionId;
        let runningStep = dispatchLease.step;
        if (!agentSessionId) {
          const childSessionInput = {
            ...(stablePolicyRunId ? { stableKey: `chat-delegation:${runId}:${step.stepId}` } : {}),
            workspaceId: sessionWorkspaceId,
            title: `Delegate · ${toTitleCase(step.role)}`,
            projectId: parentProjectId,
            mode: executionMode,
          };
          const childSession = await deps.createChatSession(childSessionInput);
          agentSessionId = childSession.sessionId;
          const linkedStep = await deps.storage.chatDelegationSteps.linkClaimedDispatch(
            step.stepId,
            dispatchLease.claimMarker!,
            agentSessionId,
            dispatchLease.dispatchMarker,
            dispatchLease.dispatchExpiresAt,
          );
          if (!linkedStep) {
            const current = await deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          runningStep = linkedStep;
          dispatchOwnership = {
            token: dispatchLease.dispatchMarker,
            childSessionId: agentSessionId,
          };
        }
        await callbacks?.onStep?.(runningStep);
        registeredAgentSessionId = agentSessionId;
        childSessionId = agentSessionId;
        const persistedResumeStep =
          options.persistedResume?.stepId === step.stepId ? options.persistedResume : undefined;
        if (
          persistedResumeStep &&
          (persistedResumeStep.runId !== runId ||
            persistedResumeStep.childSessionId !== agentSessionId ||
            persistedResumeStep.childTurnId !== turnIdentity.turnId ||
            persistedResumeStep.durableRunId !== runningStep.durableRunId)
        ) {
          throw new Error(`Delegation scope resume ${step.stepId} lost its immutable child binding.`);
        }
        if (persistedResumeStep) {
          persistedResumeStep.dispatchAcquired = true;
        }
        if (!explorerProfile && !options.persistedResume) {
          await deps.inheritDelegatedSessionToolGrants(sessionId, agentSessionId);
        }
        if (explorerProfile && !persistedResumeStep) {
          await deps.configureReadOnlyExplorerSession?.(agentSessionId, READ_ONLY_EXPLORER_DENIED_TOOLS);
        }
        const explorerPolicyContext = explorerProfile
          ? buildReadOnlyExplorerPolicyContext(inheritedPolicyContext, {
              workspaceId: sessionWorkspaceId,
              sessionId: agentSessionId,
              taskId: task.taskId,
              runId,
            })
          : undefined;
        const delegatedScope = persistedResumeStep
          ? runningStep.scopeControl
          : explorerProfile
            ? runningStep.scopeControl
            : await deps.resolveDelegatedFilesystemScope?.(
                sessionId,
                dispatchLease.dispatchMarker,
                runningStep.scopeControl,
              );
        if (explorerProfile && !delegatedScope) {
          throw new ValidationError({
            message: "Workspace exploration requires a verified server-owned filesystem scope.",
          });
        }
        if (explorerProfile && delegatedScope) {
          if (!deps.assertDelegatedFilesystemScopeBinding) {
            throw new Error("Workspace explorer scope-binding validation is not configured.");
          }
          await deps.assertDelegatedFilesystemScopeBinding(sessionId, delegatedScope);
          if (parentProjectId !== delegatedScope.projectId) {
            throw new ValidationError({ message: "Workspace exploration project binding changed." });
          }
        }
        if (delegatedScope && !persistedResumeStep) {
          // The durable patch is the authority; its returned projection is intentionally unused after scope setup.
          await deps.storage.chatDelegationSteps.patch(step.stepId, { scopeControl: delegatedScope });
          await deps.ensureSessionInternalToolGrant?.(
            agentSessionId,
            "submit_work_result",
            "delegated-work-result-envelope",
          );
        }
        if (!persistedResumeStep) {
          await deps.updateChatSessionPrefs(agentSessionId, {
            mode: executionMode,
            planningMode: "off",
            providerId,
            model,
            webMode: explorerProfile ? "off" : prefs.webMode,
            memoryMode: explorerProfile ? "off" : prefs.memoryMode,
            thinkingLevel: prefs.thinkingLevel,
            speedMode: prefs.speedMode,
            subagentPolicy: "off",
            toolAutonomy: explorerProfile ? "safe_auto" : prefs.toolAutonomy,
            orchestrationEnabled: false,
            orchestrationIntensity: "minimal",
            orchestrationVisibility: "explicit",
            orchestrationProviderPreference: prefs.orchestrationProviderPreference,
            orchestrationReviewDepth: prefs.orchestrationReviewDepth,
            orchestrationParallelism: "sequential",
            codeAutoApply: prefs.codeAutoApply,
            proactiveMode: "off",
            retrievalMode: explorerProfile ? "standard" : prefs.retrievalMode,
            reflectionMode: "off",
          });
        }
        const existingSubagent = await deps.storage.taskSubagents.findByAgentSessionId(agentSessionId);
        if (!existingSubagent) {
          await deps.taskLifecycleService.registerTaskSubagent(task.taskId, {
            agentSessionId,
            agentName: step.role,
            metadata: childMetadataBase,
          });
        } else if (existingSubagent.taskId !== task.taskId) {
          throw new Error(
            `Delegated child session ${agentSessionId} is already linked to task ${existingSubagent.taskId}.`,
          );
        }
        const taskFirstMessage = buildSubagentTaskFirstMessage({
          role: step.role,
          objective,
          mode,
          parentDelegationStepId: step.stepId,
          sharedContext: dependencyContext,
          readOnlyExplorer: explorerProfile,
        });
        scheduleLateSettleRecord = (event) => {
          if (lateSettleRecordScheduled) {
            return;
          }
          lateSettleRecordScheduled = true;
          void Promise.resolve()
            .then(async () => {
              const diagnostic = buildLateChildTimeoutDiagnostic({ event, role: step.role, stepId: step.stepId });
              subagentDiagnostics = [...subagentDiagnostics, diagnostic];
              await deps.taskLifecycleService.updateTaskSubagent(agentSessionId, {
                status: "failed",
                endedAt: diagnostic.createdAt,
                metadata: {
                  ...childMetadataBase,
                  heartbeatAt: diagnostic.createdAt,
                  failureClass: "timeout",
                  diagnostics: subagentDiagnostics,
                },
              });
              await deps.taskLifecycleService.appendTaskActivity(task.taskId, {
                activityType: "diagnostic",
                agentId: step.role,
                message: diagnostic.summary,
                metadata: buildLateChildTimeoutActivityMetadata({
                  event,
                  runId,
                  childRunId,
                  stepId: step.stepId,
                  childSessionId: agentSessionId,
                  diagnostic,
                }),
              });
            })
            .catch(() => {
              // The canonical timeout outcome is already committed; diagnostics stay best-effort.
            });
        };
        const delegatedRequest = persistedResumeStep
          ? persistedResumeStep.request
          : buildDelegatedChatSendRequest({
              content: taskFirstMessage,
              parentDelegationStepId: step.stepId,
              providerId,
              model,
              mode: executionMode,
              webMode: explorerProfile ? "off" : prefs.webMode,
              memoryMode: explorerProfile ? "off" : prefs.memoryMode,
              thinkingLevel: prefs.thinkingLevel,
              speedMode: prefs.speedMode,
              subagentPolicy: "off",
              retrievalMode: explorerProfile ? "standard" : (prefs.retrievalMode ?? "standard"),
              toolAutonomy: explorerProfile ? "safe_auto" : prefs.toolAutonomy,
              normalizationProfile: inheritedNormalizationProfile,
              operatorId: validatedExplorerActor?.operatorId ?? input.operatorId,
              authActorId: validatedExplorerActor?.authActorId ?? input.authActorId,
              authActorSource: validatedExplorerActor?.authActorSource ?? input.authActorSource,
              permissionProfileId:
                explorerPolicyContext?.permissionProfileId ?? inheritedPolicyContext?.permissionProfileId,
              localOperatorOverrideId: explorerProfile ? undefined : inheritedPolicyContext?.localOperatorOverrideId,
              policyRunId: runId,
              policyTaskId: task.taskId,
              fullWebAccess: explorerProfile ? false : input.fullWebAccess,
              policyContext: explorerPolicyContext,
            });
        const response = await runWithChildTimeout<ChatSendMessageResponse>({
          timeoutSeconds: childTimeoutSeconds,
          onLateSettle: (event) => {
            if (timeoutFailureFenceState === "lost" || lateSettleRecordScheduled) {
              return;
            }
            if (timeoutFailureFenceState === "pending") {
              bufferedLateSettle ??= event;
              return;
            }
            scheduleLateSettleRecord?.(event);
          },
          run: async (signal) =>
            deps.agentSendChatMessage(agentSessionId, delegatedRequest, {
              // Explorer transport disconnects are observation-only. The
              // server-owned timeout still bounds execution, while standard
              // delegation keeps its existing caller-cancellation behavior.
              abortSignal: composeChatDelegationAbortSignal(signal, explorerProfile ? undefined : options.abortSignal),
              turnIdentity,
              assertDispatchOwnership: async () =>
                await assertDelegationDispatchOwnership(
                  deps,
                  step.stepId,
                  agentSessionId,
                  dispatchLease.dispatchMarker,
                ),
              onChildDurableRunLaunched: async (durableRunId) => {
                let bound: ChatDelegationStepRecord;
                try {
                  bound = await deps.storage.runImmediateTransaction(async () => {
                    const owned = await deps.storage.chatDelegationSteps.bindOwnedDurableRun({
                      stepId: step.stepId,
                      expectedDispatchToken: dispatchLease.dispatchMarker,
                      childSessionId: agentSessionId,
                      durableRunId,
                    });
                    if (!owned) {
                      throw new DelegationDispatchOwnershipError(step.stepId);
                    }
                    if (explorerProfile) {
                      const extended = await deps.storage.chatDelegationSteps.extendOwnedDispatchLease({
                        stepId: step.stepId,
                        expectedDispatchToken: dispatchLease.dispatchMarker,
                        childSessionId: agentSessionId,
                        leaseExpiresAt: new Date(
                          Date.parse(await deps.storage.chatDelegationSteps.readDatabaseNow()) +
                            Math.max(60_000, (childTimeoutSeconds + 60) * 1000),
                        ).toISOString(),
                      });
                      if (!extended) {
                        throw new DelegationDispatchOwnershipError(step.stepId);
                      }
                    }
                    await attachDelegationChildWatcher(deps, {
                      parentRunId: input.policyRunId,
                      childRunId: durableRunId,
                      ...(explorerProfile ? { required: true } : {}),
                      watcherId: `delegation-child:${step.stepId}`,
                      delegationRunId: runId,
                      stepId: step.stepId,
                      childSessionId: agentSessionId,
                      childTurnId: turnIdentity.turnId,
                    });
                    return owned;
                  });
                } catch (error) {
                  if (error instanceof DelegationDispatchOwnershipError || !explorerProfile) throw error;
                  // The child admission is already canonical. Keep the step
                  // recoverable instead of terminally failing an active,
                  // deterministic durable child whose watcher write rolled
                  // back with the binding transaction.
                  throw new DelegationDurableLaunchRecoveryRequiredError(step.stepId, error);
                }
                await callbacks?.onStep?.(bound);
              },
            }),
        });
        const responseTurnId = response.turnId?.trim();
        if (!responseTurnId) {
          throw new Error(`Delegated child ${agentSessionId} returned without a canonical turn identity.`);
        }
        const traceStatus = response.trace?.status;
        const latestStep = await deps.storage.chatDelegationSteps.get(step.stepId);
        const responseDurableRunId = response.trace?.durable?.runId?.trim();
        if (latestStep.durableRunId && responseDurableRunId && latestStep.durableRunId !== responseDurableRunId) {
          throw new Error(`Delegation step ${step.stepId} returned a different durable child binding.`);
        }
        const submittedWorkResult = latestStep.workResult;
        const currentScopedWorkResult =
          !latestStep.scopeControl ||
          (submittedWorkResult?.scopeHash === latestStep.scopeControl.scopeHash &&
            submittedWorkResult.dispatchGeneration === latestStep.scopeControl.dispatchGeneration);
        const pendingScopeExpansion =
          currentScopedWorkResult &&
          submittedWorkResult?.disposition === "scope_expansion" &&
          submittedWorkResult.scopeExpansion?.decision === undefined;
        const blockedWorkResult = currentScopedWorkResult && submittedWorkResult?.disposition === "blocked";
        const waitingForApproval = traceStatus === "waiting_for_approval" || pendingScopeExpansion;
        const waitingForUserInput = traceStatus === "waiting_for_user_input";
        const stillActive = traceStatus === "queued" || traceStatus === "running" || traceStatus === "waiting_for_tool";
        const waiting = waitingForApproval || waitingForUserInput || stillActive;
        const traceFailure = response.trace?.failure;
        const degradedFailure = !waiting && isIncompleteDelegatedTraceFailure(traceFailure);
        const missingScopedTerminalResult =
          Boolean(latestStep.scopeControl) &&
          !waiting &&
          (!currentScopedWorkResult || submittedWorkResult?.disposition !== "completed");
        const failed = traceStatus === "failed" || degradedFailure || blockedWorkResult || missingScopedTerminalResult;
        const cancelled = traceStatus === "cancelled";
        const incomplete = failed || cancelled;
        const stepStatus: ChatDelegationStepRecord["status"] = waiting
          ? "running"
          : cancelled
            ? "cancelled"
            : failed
              ? "failed"
              : "completed";
        const rawOutput =
          response.assistantMessage?.content?.trim() ||
          response.trace?.failure?.message?.trim() ||
          (waitingForApproval
            ? response.trace?.pendingApprovalSummary?.reason?.trim() || "Delegate is waiting for approval."
            : waitingForUserInput
              ? response.trace?.pendingUserInput?.question?.trim() || "Delegate is waiting for user input."
              : stillActive
                ? traceStatus === "waiting_for_tool"
                  ? "Delegate is still waiting on a tool result."
                  : "Delegate turn is still running."
                : "(delegate returned no output)");
        const output = explorerProfile
          ? projectWorkspaceExplorerText(rawOutput, [delegatedScope!.rootPath])
          : rawOutput;
        const responseCitations = explorerProfile
          ? projectWorkspaceExplorerPathValue(response.citations ?? [], [delegatedScope!.rootPath])
          : (response.citations ?? []);
        const authoritativeWorkResult =
          explorerProfile && submittedWorkResult
            ? projectWorkspaceExplorerPathValue(submittedWorkResult, [delegatedScope!.rootPath])
            : submittedWorkResult;
        const observedAt = new Date().toISOString();
        const responseCommitInput = {
          stepId: step.stepId,
          expectedDispatchToken: dispatchLease.dispatchMarker,
          childSessionId: agentSessionId,
          childTurnId: responseTurnId,
          status: stepStatus,
          providerId: response.trace?.routing?.effectiveProviderId ?? providerId,
          model: response.trace?.model ?? model,
          label: step.role,
          summary: truncateSummaryLine(output, 180),
          output,
          error: missingScopedTerminalResult
            ? "Delegated code work ended without a current submit_work_result completion envelope."
            : incomplete
              ? explorerProfile
                ? projectWorkspaceExplorerText(response.trace?.failure?.message ?? output, [delegatedScope!.rootPath])
                : (response.trace?.failure?.message ?? output)
              : undefined,
          failureGuidance: incomplete
            ? explorerProfile
              ? projectWorkspaceExplorerText(
                  buildIncompleteDelegatedTraceFailureGuidance(traceFailure, output, step.role),
                  [delegatedScope!.rootPath],
                )
              : buildIncompleteDelegatedTraceFailureGuidance(traceFailure, output, step.role)
            : undefined,
          durableRunId: response.trace?.durable?.runId,
          citations: responseCitations,
          workResult: authoritativeWorkResult,
          ...(waiting
            ? {}
            : {
                finishedAt: observedAt,
                durationMs: Math.max(0, Date.parse(observedAt) - Date.parse(startedAt)),
              }),
        } satisfies Parameters<
          ChatDelegationServiceHost["storage"]["chatDelegationSteps"]["finishOwnedDispatchWithResponse"]
        >[0];
        const handoffEvidence =
          !incomplete && !waiting
            ? {
                summary: output.slice(0, 1000),
                artifactRefs: [`delegation-step:${step.stepId}`],
                sourceStepId: step.stepId,
                createdAt: observedAt,
              }
            : undefined;
        const subagentStatus: SubagentSessionStatus = waiting
          ? waitingForApproval || waitingForUserInput
            ? "paused"
            : "active"
          : incomplete
            ? "failed"
            : "completed";
        const waitingProjectionStatus = pendingScopeExpansion
          ? ("waiting_for_approval" as const)
          : traceStatus === "queued" ||
              traceStatus === "running" ||
              traceStatus === "waiting_for_approval" ||
              traceStatus === "waiting_for_tool" ||
              traceStatus === "waiting_for_user_input"
            ? traceStatus
            : ("running" as const);
        const subagentPatch = {
          status: subagentStatus,
          ...(waiting ? {} : { endedAt: observedAt }),
          metadata: {
            ...childMetadataBase,
            heartbeatAt: observedAt,
            failureClass: incomplete
              ? traceFailure?.failureClass === "tool_run_budget_exceeded" ||
                traceFailure?.failureClass === "tool_loop_guard" ||
                traceFailure?.failureClass === "global_circuit_breaker"
                ? "repeated_tool_loop"
                : "missing_handoff"
              : undefined,
            handoffEvidence,
            waiting: waiting
              ? {
                  status: waitingProjectionStatus,
                  reason: output,
                  childTurnId: responseTurnId,
                  durableRunId: response.trace?.durable?.runId,
                  observedAt,
                }
              : undefined,
          },
        } satisfies Parameters<
          ChatDelegationServiceHost["taskLifecycleService"]["persistDelegationSubagentProjection"]
        >[1];
        const completionRouting = response.routing ?? response.trace?.routing;
        const aggregateTrace = completionRouting ? { ...(trace ?? {}), ...completionRouting } : trace;
        let completedStep: ChatDelegationStepRecord;
        if (waiting) {
          const committedOutcome = await deps.storage.runImmediateTransaction(async () => {
            const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId, agentSessionId);
            const waitingStep =
              await deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse(responseCommitInput);
            if (!waitingStep) {
              return undefined;
            }
            if (latestStep.durableRunId !== response.trace?.durable?.runId) {
              await attachDelegationChildWatcher(deps, {
                parentRunId: input.policyRunId,
                childRunId: response.trace?.durable?.runId,
                ...(explorerProfile ? { required: true } : {}),
                watcherId: `delegation-child:${step.stepId}`,
                delegationRunId: runId,
                stepId: step.stepId,
                childSessionId: agentSessionId,
                childTurnId: responseTurnId,
              });
            }
            const releasedStep = await deps.storage.chatDelegationSteps.releaseOwnedWaitingDispatch({
              stepId: step.stepId,
              expectedDispatchToken: dispatchLease.dispatchMarker,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
            });
            if (!releasedStep) {
              throw new DelegationDispatchOwnershipError(step.stepId);
            }
            const subagentProjection = await deps.taskLifecycleService.persistDelegationSubagentProjection(
              agentSessionId,
              subagentPatch,
            );
            const aggregate = await persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace: aggregateTrace, observedAt },
              locks,
            );
            return { step: releasedStep, subagentProjection, aggregate };
          });
          if (!committedOutcome) {
            const current = await deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          completedStep = committedOutcome.step;
          ownsAnyOutcome = true;
          ownsTerminalSummary ||= committedOutcome.aggregate.summaryCreated;
          await publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedOutcome.subagentProjection),
          );
          await publishDelegationAggregateCommit(deps, committedOutcome.aggregate);
        } else {
          const activityInput = {
            activityType: incomplete ? ("diagnostic" as const) : ("handoff" as const),
            agentId: step.role,
            message: incomplete
              ? `${step.role} ${cancelled ? "cancelled" : "failed"} delegation step ${step.index + 1}/${delegationSteps.length}.`
              : `${step.role} completed delegation step ${step.index + 1}/${delegationSteps.length}.`,
            metadata: {
              runId,
              childRunId,
              stepId: step.stepId,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
              durableRunId: response.trace?.durable?.runId,
              handoffEvidence,
            },
          };
          const deliverableInput = !incomplete
            ? {
                deliverableType: "artifact" as const,
                title: `${toTitleCase(step.role)} step`,
                description: output.slice(0, 6000),
              }
            : undefined;
          const committedOutcome = await deps.storage.runImmediateTransaction(async () => {
            const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId, agentSessionId);
            const terminalStep =
              await deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse(responseCommitInput);
            if (!terminalStep) {
              return undefined;
            }
            if (latestStep.durableRunId !== response.trace?.durable?.runId) {
              await attachDelegationChildWatcher(deps, {
                parentRunId: input.policyRunId,
                childRunId: response.trace?.durable?.runId,
                ...(explorerProfile ? { required: true } : {}),
                watcherId: `delegation-child:${step.stepId}`,
                delegationRunId: runId,
                stepId: step.stepId,
                childSessionId: agentSessionId,
                childTurnId: responseTurnId,
              });
            }
            const subagentProjection = await deps.taskLifecycleService.persistDelegationSubagentProjection(
              agentSessionId,
              subagentPatch,
            );
            const activity = await deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              activityInput,
              observedAt,
            );
            const deliverable = deliverableInput
              ? await deps.taskLifecycleService.persistDelegationDeliverable(task.taskId, deliverableInput, observedAt)
              : undefined;
            const aggregate = await persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace: aggregateTrace, observedAt },
              locks,
            );
            return { step: terminalStep, subagentProjection, activity, deliverable, aggregate };
          });
          if (!committedOutcome) {
            const current = await deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          completedStep = committedOutcome.step;
          ownsAnyOutcome = true;
          ownsTerminalSummary ||= committedOutcome.aggregate.summaryCreated;
          await publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedOutcome.subagentProjection),
          );
          await publishDelegationPostCommitSafely("step activity", () =>
            deps.taskLifecycleService.publishDelegationActivity(committedOutcome.activity),
          );
          if (committedOutcome.deliverable) {
            await publishDelegationPostCommitSafely("step deliverable", () =>
              deps.taskLifecycleService.publishDelegationDeliverable(committedOutcome.deliverable!),
            );
          }
          await publishDelegationAggregateCommit(deps, committedOutcome.aggregate);
          await callbacks?.onStep?.(completedStep);
        }
        if (!incomplete && !waiting) {
          completedOutputs.set(step.stepId, {
            role: step.role,
            output: output.slice(0, 4000),
          });
        }
        if (completionRouting) {
          trace = aggregateTrace;
        }
        return {
          step: completedStep,
          output,
          citations: responseCitations,
          trace: completionRouting,
          completed: !incomplete && !waiting,
        };
      } catch (error) {
        if (isAuthoritativeModelUsageAccountingError(error)) {
          const authoritativeTimeout = error instanceof SubagentBudgetError && error.code === "timeout_exceeded";
          timeoutFailureFenceState = authoritativeTimeout ? "won" : "lost";
          if (authoritativeTimeout && bufferedLateSettle) {
            const lateSettle = bufferedLateSettle;
            bufferedLateSettle = undefined;
            scheduleLateSettleRecord?.(lateSettle);
          } else if (!authoritativeTimeout) {
            bufferedLateSettle = undefined;
          }
          throw error;
        }
        if (
          error instanceof DelegationDispatchOwnershipError ||
          error instanceof DelegationDurableLaunchRecoveryRequiredError
        ) {
          const current = await deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        const finishedAt = new Date().toISOString();
        const message = formatUnknownError(error);
        const aborted = isChatDelegationAbortError(error, options.abortSignal);
        const isBudgetError = error instanceof SubagentBudgetError;
        const budgetCode = isBudgetError ? error.code : undefined;
        const isTimeoutFailure = isBudgetError && budgetCode === "timeout_exceeded";
        const status = aborted ? "cancelled" : "failed";
        const summary = aborted
          ? "Child cancelled."
          : isBudgetError
            ? budgetCode === "timeout_exceeded"
              ? "Child timed out."
              : "Maximum delegation depth exceeded."
            : undefined;
        const failureGuidance = buildDelegationFailureGuidance(message, step.role);
        const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
        const budgetDiagnostic: AgenticDiagnosticSignal | undefined = isBudgetError
          ? {
              signalId: randomUUID(),
              code: budgetCode as "timeout_exceeded" | "max_depth_exceeded",
              severity: "critical" as const,
              title:
                budgetCode === "timeout_exceeded" ? "Subagent child timed out" : "Subagent maxDepth budget exhausted",
              summary: message,
              createdAt: finishedAt,
            }
          : undefined;
        if (budgetDiagnostic) {
          subagentDiagnostics = [...subagentDiagnostics, budgetDiagnostic];
        }
        const failureSubagentPatch = registeredAgentSessionId
          ? {
              status: aborted ? ("killed" as const) : ("failed" as const),
              endedAt: finishedAt,
              metadata: {
                ...childMetadataBase,
                heartbeatAt: finishedAt,
                failureClass: aborted
                  ? ("other" as const)
                  : isBudgetError
                    ? budgetCode === "timeout_exceeded"
                      ? ("timeout" as const)
                      : ("spawn_failure" as const)
                    : ("crash" as const),
                diagnostics: subagentDiagnostics.length > 0 ? subagentDiagnostics : undefined,
                waiting: undefined,
              },
            }
          : undefined;
        let committedFailure:
          | {
              step: ChatDelegationStepRecord;
              subagentProjection?: TaskSubagentSession;
              activity: TaskActivityRecord;
              aggregate: DelegationAggregateCommitResult;
            }
          | undefined;
        try {
          committedFailure = await deps.storage.runImmediateTransaction(async () => {
            const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId, registeredAgentSessionId);
            const failedStep = dispatchOwnership
              ? await deps.storage.chatDelegationSteps.finishOwnedDispatchWithError({
                  stepId: step.stepId,
                  expectedDispatchToken: dispatchOwnership.token,
                  expectedChildSessionId: dispatchOwnership.childSessionId,
                  status,
                  label: step.role,
                  summary,
                  error: message,
                  failureGuidance,
                  finishedAt,
                  durationMs,
                })
              : await deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
                  stepId: step.stepId,
                  status,
                  label: step.role,
                  error: message,
                  summary,
                  failureGuidance,
                  finishedAt,
                  durationMs,
                });
            if (!failedStep) {
              return undefined;
            }
            const subagentProjection =
              registeredAgentSessionId && failureSubagentPatch
                ? await deps.taskLifecycleService.persistDelegationSubagentProjection(
                    registeredAgentSessionId,
                    failureSubagentPatch,
                  )
                : undefined;
            const activity = await deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              {
                activityType: "diagnostic",
                agentId: step.role,
                message: `${step.role} ${aborted ? "cancelled" : "failed"} delegation step ${step.index + 1}/${delegationSteps.length}: ${message}`,
                metadata: {
                  runId,
                  childRunId,
                  stepId: step.stepId,
                  ...(childSessionId ? { childSessionId } : {}),
                  error: message,
                  ...(aborted ? { cancellation: "abort_signal" } : {}),
                  ...(isBudgetError ? { diagnosticCode: budgetCode } : {}),
                },
              },
              finishedAt,
            );
            const aggregate = await persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace, observedAt: finishedAt },
              locks,
            );
            return { step: failedStep, subagentProjection, activity, aggregate };
          });
        } catch (commitError) {
          timeoutFailureFenceState = "lost";
          bufferedLateSettle = undefined;
          throw commitError;
        }
        if (!committedFailure) {
          timeoutFailureFenceState = "lost";
          bufferedLateSettle = undefined;
          const current = await deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        timeoutFailureFenceState = isTimeoutFailure ? "won" : "lost";
        if (timeoutFailureFenceState === "won" && bufferedLateSettle) {
          const lateSettle = bufferedLateSettle;
          bufferedLateSettle = undefined;
          scheduleLateSettleRecord?.(lateSettle);
        } else if (timeoutFailureFenceState === "lost") {
          bufferedLateSettle = undefined;
        }
        if (committedFailure.subagentProjection) {
          await publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedFailure.subagentProjection!),
          );
        }
        ownsAnyOutcome = true;
        ownsTerminalSummary ||= committedFailure.aggregate.summaryCreated;
        await publishDelegationPostCommitSafely("step failure activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(committedFailure.activity),
        );
        await publishDelegationAggregateCommit(deps, committedFailure.aggregate);
        await callbacks?.onStep?.(committedFailure.step);
        return {
          step: committedFailure.step,
          output: message,
          citations: [],
          completed: false,
        };
      }
    };

    for (const stage of stages) {
      const runnableSteps: NormalizedDelegationStep[] = [];
      for (const step of stage) {
        const persistedStep = stepResults.get(step.stepId)?.step;
        if (persistedStep && persistedStep.status !== "pending" && persistedStep.status !== "running") {
          continue;
        }
        const expectedTurnId = buildStableDelegationTurnIdentity(runId, step.stepId).turnId;
        const databaseNowMs = Date.parse(await deps.storage.chatDelegationSteps.readDatabaseNow());
        const dispatchClaim = persistedStep
          ? await deps.storage.chatDelegationSteps.getDispatchClaim(persistedStep.stepId)
          : undefined;
        if (
          persistedStep &&
          !isDelegationStepDispatchRecoverable(persistedStep, dispatchClaim, expectedTurnId, databaseNowMs)
        ) {
          continue;
        }
        const snapshotDependencies = step.dependsOnStepIds
          .map((dependencyStepId) => stepResults.get(dependencyStepId)?.step)
          .filter((dependency): dependency is ChatDelegationStepRecord => Boolean(dependency));
        const snapshotDependenciesAreComplete =
          snapshotDependencies.length === step.dependsOnStepIds.length &&
          snapshotDependencies.every((dependency) => dependency.status === "completed");
        if (snapshotDependenciesAreComplete) {
          runnableSteps.push(step);
          continue;
        }
        const observedAt = await deps.storage.chatDelegationSteps.readDatabaseNow();
        const dependencyResolution = await deps.storage.runImmediateTransaction(async () => {
          const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId);
          const lockedStepById = new Map(locks.persistedSteps.map((lockedStep) => [lockedStep.stepId, lockedStep]));
          const lockedDependencies = step.dependsOnStepIds
            .map((dependencyStepId) => lockedStepById.get(dependencyStepId))
            .filter((dependency): dependency is ChatDelegationStepRecord => Boolean(dependency));
          const hasMissingOrActiveDependency =
            lockedDependencies.length !== step.dependsOnStepIds.length ||
            lockedDependencies.some((dependency) => dependency.status === "running" || dependency.status === "pending");
          if (hasMissingOrActiveDependency) {
            return { kind: "waiting" as const, dependencies: lockedDependencies };
          }
          const lockedFailedDependencies = lockedDependencies.filter(
            (dependency) =>
              dependency.status === "failed" || dependency.status === "skipped" || dependency.status === "cancelled",
          );
          if (lockedFailedDependencies.length === 0) {
            return { kind: "runnable" as const, dependencies: lockedDependencies };
          }
          const failedDependencyRoles = lockedFailedDependencies.map((dependency) => dependency.role);
          const skippedStep = await deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
            stepId: step.stepId,
            status: "skipped",
            error: `Skipped because dependency did not complete: ${failedDependencyRoles.join(", ")}`,
            failureGuidance: buildDelegationFailureGuidance(
              `Blocked by incomplete dependency from ${failedDependencyRoles.join(", ")}`,
              step.role,
            ),
            finishedAt: observedAt,
            durationMs: 0,
          });
          if (!skippedStep) {
            return { kind: "stale" as const, dependencies: lockedDependencies };
          }
          const activity = await deps.taskLifecycleService.persistDelegationActivity(
            task.taskId,
            {
              activityType: "comment",
              agentId: step.role,
              message: `${step.role} skipped delegation step ${step.index + 1}/${delegationSteps.length} due to incomplete dependency.`,
              metadata: {
                runId,
                stepId: step.stepId,
                failedDependencyStepIds: lockedFailedDependencies.map((dependency) => dependency.stepId),
              },
            },
            observedAt,
          );
          const aggregate = await persistDelegationAggregateFromLockedTruth(
            deps,
            { runId, taskId: task.taskId, trace, observedAt },
            locks,
          );
          return {
            kind: "skipped" as const,
            dependencies: lockedDependencies,
            step: skippedStep,
            activity,
            aggregate,
          };
        });
        for (const dependency of dependencyResolution.dependencies) {
          stepResults.set(dependency.stepId, {
            step: dependency,
            output: dependency.output,
            citations: dependency.citations ?? [],
            completed: dependency.status === "completed",
          });
          if (dependency.status === "completed" && dependency.output?.trim()) {
            completedOutputs.set(dependency.stepId, {
              role: dependency.role,
              output: dependency.output.slice(0, 4000),
            });
          }
        }
        if (dependencyResolution.kind === "runnable") {
          runnableSteps.push(step);
          continue;
        }
        if (dependencyResolution.kind === "waiting") {
          continue;
        }
        if (dependencyResolution.kind === "stale") {
          const current = await deps.storage.chatDelegationSteps.get(step.stepId);
          stepResults.set(step.stepId, {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          });
          continue;
        }
        await publishDelegationPostCommitSafely("dependency resolution activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(dependencyResolution.activity),
        );
        ownsAnyOutcome = true;
        ownsTerminalSummary ||= dependencyResolution.aggregate.summaryCreated;
        await publishDelegationAggregateCommit(deps, dependencyResolution.aggregate);
        await callbacks?.onStep?.(dependencyResolution.step);
        stepResults.set(step.stepId, {
          step: dependencyResolution.step,
          citations: [],
          completed: false,
        });
      }

      await mapWithConcurrency(runnableSteps, 4, async (step) => {
        const result = await executeDelegationStep(step);
        stepResults.set(step.stepId, result);
        return result;
      });
    }

    const repairedAggregate = await deps.storage.runImmediateTransaction(async () => {
      const locks = await lockDelegationAggregateTruth(deps, runId, task.taskId);
      const projection = deriveDelegationAggregate(locks.persistedSteps);
      if (!hasDelegationAggregateDrift(locks, projection)) {
        return undefined;
      }
      return await persistDelegationAggregateFromLockedTruth(
        deps,
        {
          runId,
          taskId: task.taskId,
          trace: locks.parent.trace,
          observedAt: await deps.storage.chatDelegationSteps.readDatabaseNow(),
        },
        locks,
      );
    });
    if (repairedAggregate) {
      ownsAnyOutcome ||= repairedAggregate.summaryCreated;
      ownsTerminalSummary ||= repairedAggregate.summaryCreated;
      await publishDelegationAggregateCommit(deps, repairedAggregate);
    }

    const parent = await deps.storage.chatDelegationRuns.get(runId);
    const persistedSteps = await deps.storage.chatDelegationSteps.listByRun(runId);
    const projection = deriveDelegationAggregate(persistedSteps);
    const stitchedOutput = parent.stitchedOutput ?? projection.stitchedOutput;
    const citations = parent.citations.length > 0 ? parent.citations : projection.citations;
    const status = parent.status;
    if (!explorerProfile && ownsAnyOutcome) {
      await deps.extractAndPersistLearnedMemory(sessionId, objective, {
        role: "user",
        sourceRef: runId,
      });
    }
    if (!explorerProfile && ownsTerminalSummary && status === "completed" && stitchedOutput.trim()) {
      await deps.extractAndPersistLearnedMemory(sessionId, stitchedOutput, {
        role: "assistant",
        sourceRef: runId,
      });
      await deps.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: stitchedOutput,
        relationScope: "peer",
      });
    }

    return {
      runId,
      taskId: task.taskId,
      status,
      steps: persistedSteps,
      stitchedOutput,
      citations,
      trace: parent.trace ?? trace,
      ...(explorerProfile ? { explorer: buildWorkspaceExplorerReport(parent, persistedSteps) } : {}),
    };
  }

  public async *runChatDelegationStream(
    sessionId: string,
    input: ChatDelegateRequest,
    options: ChatDelegationRunOptions = {},
  ): AsyncGenerator<{
    type: "status" | "step" | "done" | "error";
    runId?: string;
    taskId?: string;
    message?: string;
    step?: ChatDelegationStepRecord;
    result?: ChatDelegateResponse;
    error?: string;
  }> {
    const queue: Array<{
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let runError: unknown = null;
    const push = (chunk: {
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }) => {
      queue.push(chunk);
      const notify = wake;
      wake = null;
      notify?.();
    };

    void this.runChatDelegation(
      sessionId,
      input,
      {
        onStatus: async (event) => {
          push({
            type: "status",
            runId: event.runId,
            taskId: event.taskId,
            message: event.message,
          });
        },
        onStep: async (step) => {
          push({
            type: "step",
            runId: step.runId,
            step,
          });
        },
      },
      options,
    )
      .then((result) => {
        push({
          type: "done",
          runId: result.runId,
          taskId: result.taskId,
          result,
        });
      })
      .catch((error) => {
        runError = error;
      })
      .finally(() => {
        finished = true;
        const notify = wake;
        wake = null;
        notify?.();
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
      }
    }

    if (runError) {
      throw runError;
    }
  }

  public async suggestChatDelegation(
    sessionId: string,
    input: ChatDelegateSuggestRequest = {},
  ): Promise<ChatDelegateSuggestResponse> {
    await this.deps.getSession(sessionId);
    const objective = (input.objective?.trim() || (await this.inferLatestUserObjective(sessionId))).trim();
    if (!objective) {
      throw new Error("No objective provided and no recent user request was found.");
    }
    const detectedRoles = normalizeDelegationRoles(
      input.roles?.length ? input.roles : detectDelegationRoles(objective),
    );
    const roles = detectedRoles.length > 0 ? detectedRoles : DEFAULT_DELEGATION_ROLES.slice(0, 3);
    const confidence = computeDelegationSuggestionConfidence(objective, roles);
    const suggestion: ChatDelegationSuggestionRecord = {
      suggestionId: randomUUID(),
      sessionId,
      objective,
      roles,
      mode: "sequential",
      confidence,
      reason: "Detected multi-role objective and generated delegation plan.",
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    return { suggestion };
  }

  public async acceptChatDelegation(
    sessionId: string,
    input: ChatDelegateAcceptRequest,
  ): Promise<ChatDelegateResponse> {
    await this.deps.getSession(sessionId);
    if (input.suggestionId) {
      const actionRow = (await this.deps.gatewaySql
        .prepare(
          `
        SELECT args_json
        FROM proactive_actions
        WHERE action_id = ? AND session_id = ?
      `,
        )
        .get(input.suggestionId, sessionId)) as { args_json?: string } | undefined;
      if (actionRow?.args_json) {
        const parsed = safeJsonParse<Record<string, unknown>>(actionRow.args_json, {});
        const objectiveFromSuggestion = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
        const rolesFromSuggestion = Array.isArray(parsed.roles) ? parsed.roles.map((item) => String(item)) : [];
        return this.runChatDelegation(sessionId, {
          objective: objectiveFromSuggestion || input.objective,
          roles: rolesFromSuggestion.length > 0 ? rolesFromSuggestion : input.roles,
          mode: input.mode ?? "sequential",
          providerId: input.providerId,
          model: input.model,
          surfaceMode: input.surfaceMode,
          steps: input.steps,
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          policyRunId: input.policyRunId,
          policyTaskId: input.policyTaskId,
          fullWebAccess: input.fullWebAccess,
        });
      }
    }
    return this.runChatDelegation(sessionId, {
      objective: input.objective,
      roles: input.roles,
      mode: input.mode ?? "sequential",
      providerId: input.providerId,
      model: input.model,
      surfaceMode: input.surfaceMode,
      steps: input.steps,
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      policyRunId: input.policyRunId,
      policyTaskId: input.policyTaskId,
      fullWebAccess: input.fullWebAccess,
    });
  }

  private async inferLatestUserObjective(sessionId: string): Promise<string> {
    const messages = await this.deps.listChatMessages(sessionId, 40);
    const latestUser = [...messages].reverse().find((item) => item.role === "user");
    return latestUser?.content ?? "";
  }
}

interface DelegationAggregateCommitResult {
  persistedSteps: ChatDelegationStepRecord[];
  stitchedOutput: string;
  citations: ChatCitationRecord[];
  status: ChatDelegationRunRecord["status"];
  completedSteps: number;
  activeChildCount: number;
  committedTask: TaskRecord;
  aggregatePersisted: boolean;
  transitionedPendingSteps: number;
  summaryActivity?: TaskActivityRecord;
  summaryCreated: boolean;
}

interface DelegationAggregateLocks {
  parent: ChatDelegationRunRecord;
  persistedSteps: ChatDelegationStepRecord[];
  task: TaskRecord;
  subagent?: TaskSubagentSession;
}

type StableTerminalDelegationReplay =
  | { kind: "resume" }
  | {
      kind: "terminal";
      persistedSteps: ChatDelegationStepRecord[];
      projection: ReturnType<typeof deriveDelegationAggregate>;
      committedAggregate?: DelegationAggregateCommitResult;
      summaryReceipt?: { activity: TaskActivityRecord; created: boolean };
    };

async function resolveStableTerminalDelegationReplay(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  requestedSteps: readonly NormalizedDelegationStep[],
): Promise<StableTerminalDelegationReplay> {
  return await deps.storage.runImmediateTransaction(async () => {
    const locks = await lockDelegationAggregateTruth(deps, runId, taskId);
    rebuildResumableDelegationPlan(locks.persistedSteps, requestedSteps);
    const projection = deriveDelegationAggregate(locks.persistedSteps);
    if (projection.status === "running") {
      return { kind: "resume" };
    }
    const observedAt = await deps.storage.chatDelegationSteps.readDatabaseNow();
    if (hasDelegationAggregateDrift(locks, projection)) {
      const committedAggregate = await persistDelegationAggregateFromLockedTruth(
        deps,
        {
          runId,
          taskId,
          trace: locks.parent.trace,
          observedAt,
        },
        locks,
      );
      return {
        kind: "terminal",
        persistedSteps: committedAggregate.persistedSteps,
        projection: committedAggregate,
        committedAggregate,
      };
    }
    return {
      kind: "terminal",
      persistedSteps: locks.persistedSteps,
      projection,
      summaryReceipt: await persistDelegationSummaryOnce(
        deps,
        runId,
        taskId,
        locks.persistedSteps,
        projection.status,
        observedAt,
      ),
    };
  });
}

async function commitDelegationAggregate(
  deps: ChatDelegationServiceHost,
  input: {
    runId: string;
    taskId: string;
    trace?: ChatTurnTraceRecord["routing"];
    observedAt: string;
    preDispatchFailure?: string;
  },
): Promise<DelegationAggregateCommitResult> {
  const committed = await deps.storage.runImmediateTransaction(async () => {
    const locks = await lockDelegationAggregateTruth(deps, input.runId, input.taskId);
    return await persistDelegationAggregateFromLockedTruth(deps, input, locks);
  });
  await publishDelegationAggregateCommit(deps, committed);
  return committed;
}

async function publishDelegationAggregateCommit(
  deps: ChatDelegationServiceHost,
  committed: DelegationAggregateCommitResult,
): Promise<void> {
  if (committed.aggregatePersisted) {
    await publishDelegationPostCommitSafely("aggregate task", () =>
      deps.taskLifecycleService.publishDelegationAggregateTask(committed.committedTask),
    );
  }
  if (committed.summaryCreated && committed.summaryActivity) {
    await publishDelegationPostCommitSafely("terminal summary", () =>
      deps.taskLifecycleService.publishDelegationActivity(committed.summaryActivity!),
    );
  }
}

async function publishDelegationPostCommitSafely(label: string, publish: () => void | Promise<void>): Promise<void> {
  try {
    await publish();
  } catch (error) {
    try {
      process.stderr.write(
        `[chat-delegation] ${label} publication failed after commit: ${formatUnknownError(error)}\n`,
      );
    } catch {
      // Canonical database truth is already committed; diagnostics are best-effort too.
    }
  }
}

async function lockDelegationAggregateTruth(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  agentSessionId?: string,
): Promise<DelegationAggregateLocks> {
  const parent = await deps.storage.chatDelegationRuns.getForUpdate(runId);
  const persistedSteps = await deps.storage.chatDelegationSteps.listByRunForUpdate(runId);
  const task = (await deps.taskLifecycleService.lockTaskForDelegationAggregate(taskId)) as TaskRecord;
  const subagent = agentSessionId
    ? await deps.taskLifecycleService.lockDelegationSubagentProjection(agentSessionId)
    : undefined;
  return { parent, persistedSteps, task, subagent };
}

function hasDelegationAggregateDrift(
  locks: DelegationAggregateLocks,
  projection: ReturnType<typeof deriveDelegationAggregate>,
): boolean {
  // A running projection can legitimately be newer than the last published
  // parent snapshot while another dispatch owner is still active. Only a
  // terminal projection is safe for a non-owner wake to repair.
  if (projection.status === "running") {
    return false;
  }
  const parentDrifted =
    locks.parent.status !== projection.status ||
    (locks.parent.stitchedOutput ?? "") !== projection.stitchedOutput ||
    JSON.stringify(locks.parent.citations) !== JSON.stringify(projection.citations) ||
    locks.parent.finishedAt === undefined;
  if (parentDrifted) {
    return true;
  }

  const authoritativeTaskStatus = locks.task.agenticContext?.status;
  if (authoritativeTaskStatus === "paused" || authoritativeTaskStatus === "cancelled") {
    return false;
  }
  const expectedTaskStatus = projection.completedSteps > 0 && projection.status === "completed" ? "review" : "blocked";
  const expectedAgenticStatus = projection.status === "completed" ? "completed" : "failed";
  const expectedFailureClass = projection.status === "completed" ? undefined : "missing_handoff";
  return (
    locks.task.status !== expectedTaskStatus ||
    authoritativeTaskStatus !== expectedAgenticStatus ||
    locks.task.agenticContext?.failureClass !== expectedFailureClass
  );
}

async function persistDelegationAggregateFromLockedTruth(
  deps: ChatDelegationServiceHost,
  input: {
    runId: string;
    taskId: string;
    trace?: ChatTurnTraceRecord["routing"];
    observedAt: string;
    preDispatchFailure?: string;
  },
  locks: DelegationAggregateLocks,
): Promise<DelegationAggregateCommitResult> {
  let persistedSteps = locks.persistedSteps;
  let transitionedPendingSteps = 0;
  if (input.preDispatchFailure) {
    for (const step of persistedSteps) {
      if (step.status !== "pending") {
        continue;
      }
      const transitioned = await deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
        stepId: step.stepId,
        status: "failed",
        label: step.role,
        summary: "Child failed before dispatch.",
        error: input.preDispatchFailure,
        failureGuidance: buildDelegationFailureGuidance(input.preDispatchFailure, step.role),
        finishedAt: input.observedAt,
        durationMs: Math.max(0, Date.parse(input.observedAt) - Date.parse(step.startedAt)),
      });
      if (transitioned) {
        transitionedPendingSteps += 1;
      }
    }
  }
  // Refresh already-locked step truth after an outcome CAS in this transaction.
  persistedSteps = await deps.storage.chatDelegationSteps.listByRunForUpdate(input.runId);
  const projection = deriveDelegationAggregate(persistedSteps);
  if (input.preDispatchFailure && transitionedPendingSteps === 0) {
    return {
      ...projection,
      persistedSteps,
      committedTask: locks.task,
      aggregatePersisted: false,
      transitionedPendingSteps,
      summaryCreated: false,
    };
  }
  await deps.storage.chatDelegationRuns.patch(input.runId, {
    status: projection.status,
    stitchedOutput: projection.stitchedOutput,
    citations: projection.citations,
    trace: input.trace ?? locks.parent.trace,
    ...(projection.status === "running" ? { clearFinishedAt: true } : { finishedAt: input.observedAt }),
  });
  const authoritativeTaskStatus = locks.task.agenticContext?.status;
  const preservesOperatorControl = authoritativeTaskStatus === "paused" || authoritativeTaskStatus === "cancelled";
  const committedTask = await deps.taskLifecycleService.persistDelegationAggregateTask(input.taskId, {
    status: preservesOperatorControl
      ? locks.task.status
      : projection.status === "running"
        ? "in_progress"
        : projection.completedSteps > 0 && projection.status === "completed"
          ? "review"
          : "blocked",
    agenticContext: {
      status: preservesOperatorControl
        ? authoritativeTaskStatus
        : projection.status === "running"
          ? "running"
          : projection.status === "completed"
            ? "completed"
            : "failed",
      activeChildCount: projection.activeChildCount,
      failureClass: preservesOperatorControl
        ? locks.task.agenticContext?.failureClass
        : projection.status === "running" || projection.status === "completed"
          ? undefined
          : "missing_handoff",
      handoffEvidence:
        projection.status !== "running" && projection.stitchedOutput.trim()
          ? [
              {
                summary: projection.stitchedOutput.slice(0, 1000),
                artifactRefs: persistedSteps
                  .filter((step) => step.status === "completed")
                  .map((step) => `delegation-step:${step.stepId}`),
                createdAt: input.observedAt,
              },
            ]
          : undefined,
    },
  });
  const summaryReceipt = await persistDelegationSummaryOnce(
    deps,
    input.runId,
    input.taskId,
    persistedSteps,
    projection.status,
    input.observedAt,
  );
  return {
    ...projection,
    persistedSteps,
    committedTask,
    aggregatePersisted: true,
    transitionedPendingSteps,
    summaryActivity: summaryReceipt?.activity,
    summaryCreated: summaryReceipt?.created ?? false,
  };
}

async function persistDelegationSummaryOnce(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  persistedSteps: ChatDelegationStepRecord[],
  status: ChatDelegationRunRecord["status"],
  observedAt: string,
): Promise<{ activity: TaskActivityRecord; created: boolean } | undefined> {
  if (status === "running") {
    return undefined;
  }
  const counts = {
    completedSteps: persistedSteps.filter((step) => step.status === "completed").length,
    failedSteps: persistedSteps.filter((step) => step.status === "failed").length,
    skippedSteps: persistedSteps.filter((step) => step.status === "skipped").length,
    cancelledSteps: persistedSteps.filter((step) => step.status === "cancelled").length,
    steps: persistedSteps.length,
  };
  const activityInput = {
    activityType: "comment" as const,
    message: `Delegation ${status}.`,
    metadata: { runId, ...counts },
  };
  const legacyActivityId = buildStableDelegationId("delegation-summary-activity", runId);
  try {
    return await deps.taskLifecycleService.persistDelegationActivityOnce(
      legacyActivityId,
      taskId,
      activityInput,
      observedAt,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("conflicting payload")) {
      throw error;
    }
  }
  const correctionActivityId = buildStableDelegationId(
    "delegation-summary-activity",
    runId,
    status,
    String(counts.completedSteps),
    String(counts.failedSteps),
    String(counts.skippedSteps),
    String(counts.cancelledSteps),
    String(counts.steps),
  );
  return await deps.taskLifecycleService.persistDelegationActivityOnce(
    correctionActivityId,
    taskId,
    activityInput,
    observedAt,
  );
}

function deriveDelegationAggregate(
  persistedSteps: ChatDelegationStepRecord[],
): Omit<
  DelegationAggregateCommitResult,
  | "persistedSteps"
  | "committedTask"
  | "aggregatePersisted"
  | "transitionedPendingSteps"
  | "summaryActivity"
  | "summaryCreated"
> {
  const stitchedOutput = buildDelegationStitchedOutput(persistedSteps);
  const completedSteps = persistedSteps.filter((step) => step.status === "completed").length;
  const failedStepsWithPartialOutput = persistedSteps.filter(
    (step) => step.status === "failed" && Boolean(step.output?.trim()),
  ).length;
  const unfinishedSteps = persistedSteps.filter(
    (step) => step.status === "running" || step.status === "pending",
  ).length;
  const terminalSteps = persistedSteps.filter(
    (step) =>
      step.status === "completed" ||
      step.status === "failed" ||
      step.status === "skipped" ||
      step.status === "cancelled",
  ).length;
  const status: ChatDelegationRunRecord["status"] =
    unfinishedSteps > 0
      ? "running"
      : persistedSteps.length > 0 && terminalSteps === persistedSteps.length && completedSteps === persistedSteps.length
        ? "completed"
        : completedSteps > 0 || failedStepsWithPartialOutput > 0
          ? "partial"
          : "failed";
  const citationsById = new Map<string, ChatCitationRecord>();
  for (const citation of persistedSteps.flatMap((step) => step.citations ?? [])) {
    citationsById.set(citation.citationId, citation);
  }
  return {
    stitchedOutput,
    citations: [...citationsById.values()],
    status,
    completedSteps,
    activeChildCount: persistedSteps.filter((step) => step.status === "running").length,
  };
}

export function buildWorkspaceExplorerReport(
  run: ChatDelegationRunRecord,
  steps: readonly ChatDelegationStepRecord[],
): ChatWorkspaceExplorerReport | undefined {
  if (!isReadOnlyWorkspaceExplorerRun(run)) return undefined;
  const rootPaths = dedupeStrings(steps.flatMap((step) => (step.scopeControl ? [step.scopeControl.rootPath] : [])));
  return projectWorkspaceExplorerPathValue(
    {
      profile: "read_only_explorer",
      answer: run.stitchedOutput ?? "",
      evidenceReferences: dedupeStrings(steps.flatMap((step) => step.workResult?.evidenceRefs ?? [])),
      searchedScope: {
        kind: "server_owned_delegated_scope",
        approvedPaths: dedupeStrings(steps.flatMap((step) => step.scopeControl?.approvedPaths ?? [])),
        scopeHashes: dedupeStrings(steps.flatMap((step) => (step.scopeControl ? [step.scopeControl.scopeHash] : []))),
      },
      partialResult: run.status !== "completed",
      gaps: buildExplorerGaps(steps, run.status),
    } satisfies ChatWorkspaceExplorerReport,
    rootPaths,
  );
}

export function isReadOnlyWorkspaceExplorerRun(run: ChatDelegationRunRecord): boolean {
  return run.workflowTemplate === READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE;
}

function buildExplorerGaps(
  steps: readonly ChatDelegationStepRecord[],
  status: ChatDelegateResponse["status"],
): string[] {
  const gaps = dedupeStrings(
    steps.flatMap((step) => {
      const blockedSummary = step.workResult?.disposition === "blocked" ? step.workResult.summary : undefined;
      const waitingReason = step.status === "running" ? (step.output ?? step.summary) : undefined;
      return [step.error, blockedSummary, waitingReason].filter((value): value is string => Boolean(value?.trim()));
    }),
  );
  if (status !== "completed" && gaps.length === 0) {
    gaps.push(`Workspace exploration is ${status}; its result is incomplete.`);
  }
  return gaps;
}

function computeDelegationSuggestionConfidence(objective: string, roles: string[]): number {
  let score = roles.length >= 3 ? 0.84 : roles.length >= 2 ? 0.72 : 0.58;
  if (/\b(prd|architecture|implement|qa|ops|handoff)\b/i.test(objective)) {
    score += 0.12;
  }
  return Math.max(0, Math.min(1, score));
}

function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) {
    return [...DEFAULT_DELEGATION_ROLES];
  }
  return out;
}

function normalizeDelegationSteps(input: {
  roles: string[];
  mode: "sequential" | "parallel";
  steps?: NonNullable<ChatDelegateRequest["steps"]>;
}): NormalizedDelegationStep[] {
  if (!input.steps || input.steps.length === 0) {
    const stepIds = input.roles.map(() => randomUUID());
    return input.roles.map((role, index) => ({
      stepId: stepIds[index]!,
      index,
      role,
      parallelizable: input.mode === "parallel",
      dependsOnStepIds: input.mode === "sequential" && index > 0 ? [stepIds[index - 1]!] : [],
    }));
  }

  const allowedRoles = new Set(input.roles);
  const provisional = input.steps.map((step, index) => {
    const normalizedRole = normalizeDelegationRoles([step.role])[0];
    if (!normalizedRole) {
      throw new Error(`delegation step ${index + 1} is missing a valid role`);
    }
    if (!allowedRoles.has(normalizedRole)) {
      throw new Error(`delegation step role "${normalizedRole}" must also appear in roles`);
    }
    return {
      requestedStepId: step.stepId?.trim(),
      requestedIndex: Number.isFinite(step.index) ? Math.max(0, Math.trunc(step.index!)) : index,
      role: normalizedRole,
      parallelizable: step.parallelizable ?? input.mode === "parallel",
      dependsOnStepIds: dedupeStrings(step.dependsOnStepIds ?? []),
    };
  });

  provisional.sort((left, right) => left.requestedIndex - right.requestedIndex);
  const seenRequestedStepIds = new Set<string>();
  for (const step of provisional) {
    if (!step.requestedStepId) {
      continue;
    }
    if (seenRequestedStepIds.has(step.requestedStepId)) {
      throw new Error(`delegation step id "${step.requestedStepId}" is duplicated`);
    }
    seenRequestedStepIds.add(step.requestedStepId);
  }

  const requestedToActualStepIds = new Map<string, string>();
  const actualStepIds: string[] = provisional.map((step) => {
    const actualStepId = randomUUID();
    if (step.requestedStepId) {
      requestedToActualStepIds.set(step.requestedStepId, actualStepId);
    }
    return actualStepId;
  });
  const normalized = provisional.map((step, index) => {
    const stepId = actualStepIds[index]!;
    return {
      stepId,
      index,
      role: step.role,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds.map(
        (dependencyStepId) => requestedToActualStepIds.get(dependencyStepId) ?? dependencyStepId,
      ),
    };
  });

  const validStepIds = new Set(normalized.map((step) => step.stepId));
  for (const step of normalized) {
    for (const dependencyStepId of step.dependsOnStepIds) {
      if (!validStepIds.has(dependencyStepId)) {
        throw new Error(`delegation step "${step.stepId}" depends on unknown step "${dependencyStepId}"`);
      }
      if (dependencyStepId === step.stepId) {
        throw new Error(`delegation step "${step.stepId}" cannot depend on itself`);
      }
    }
  }
  return normalized;
}

function buildStableDelegationId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function stabilizeDelegationPlan(
  runId: string,
  requestedSteps: readonly NormalizedDelegationStep[],
): NormalizedDelegationStep[] {
  const stableStepIdByRequestedId = new Map(
    requestedSteps.map((step) => [
      step.stepId,
      buildStableDelegationId("delegation-step", runId, String(step.index), step.role),
    ]),
  );
  return requestedSteps.map((step) => ({
    ...step,
    stepId: stableStepIdByRequestedId.get(step.stepId)!,
    dependsOnStepIds: step.dependsOnStepIds.map(
      (dependencyStepId) => stableStepIdByRequestedId.get(dependencyStepId) ?? dependencyStepId,
    ),
  }));
}

async function createOrLoadStableDelegationTask(
  deps: ChatDelegationServiceHost,
  taskId: string,
  input: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0],
): Promise<{ taskId: string }> {
  try {
    return await deps.taskLifecycleService.createTask(input, { taskId });
  } catch (createError) {
    let existing: Awaited<ReturnType<ChatDelegationServiceHost["taskLifecycleService"]["getTask"]>> | undefined;
    try {
      existing = await deps.taskLifecycleService.getTask(taskId);
    } catch {
      // Preserve the original create failure when no canonical task owns the stable identity.
    }
    if (existing?.taskId === taskId) {
      assertStableDelegationTaskMatches(existing, input);
      return existing;
    }
    throw createError;
  }
}

function assertStableDelegationTaskMatches(
  task: Awaited<ReturnType<ChatDelegationServiceHost["taskLifecycleService"]["getTask"]>>,
  expected: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0],
): void {
  const taskContext = task.agenticContext;
  const expectedContext = expected.agenticContext;
  const matches =
    task.workspaceId === expected.workspaceId &&
    task.title === expected.title &&
    task.description === expected.description &&
    taskContext?.runId === expectedContext?.runId &&
    taskContext?.parentRunId === expectedContext?.parentRunId &&
    JSON.stringify(taskContext?.childRunIds ?? []) === JSON.stringify(expectedContext?.childRunIds ?? []);
  if (!matches) {
    throw new Error(`Stable delegation task ${task.taskId} is already owned by a different persisted plan.`);
  }
}

interface DelegationDispatchMarker {
  kind: "claim" | "dispatch";
  expiresAtMs: number;
  turnId: string;
}

interface DelegationDispatchLease {
  step: ChatDelegationStepRecord;
  claimMarker?: string;
  childSessionId?: string;
  dispatchMarker: string;
  dispatchExpiresAt: string;
}

function buildStableDelegationTurnIdentity(runId: string, stepId: string): DelegationTurnIdentity {
  return {
    turnId: buildStableDelegationId("delegation-turn", runId, stepId),
    userMessageId: buildStableDelegationId("delegation-user", runId, stepId),
    assistantMessageId: buildStableDelegationId("delegation-assistant", runId, stepId),
  };
}

function buildDelegationDispatchMarker(
  kind: DelegationDispatchMarker["kind"],
  turnId: string,
  expiresAtMs: number,
): string {
  return `delegation-${kind}:v1:${Math.trunc(expiresAtMs)}:${turnId}:${randomUUID()}`;
}

function parseDelegationDispatchMarker(value: string | undefined): DelegationDispatchMarker | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^delegation-(claim|dispatch):v1:(\d+):([^:]+):([^:]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const expiresAtMs = Number(match[2]);
  if (!Number.isSafeInteger(expiresAtMs)) {
    return undefined;
  }
  return {
    kind: match[1] as DelegationDispatchMarker["kind"],
    expiresAtMs,
    turnId: match[3]!,
  };
}

async function acquireDelegationDispatchLease(
  deps: ChatDelegationServiceHost,
  input: {
    stepId: string;
    turnIdentity: DelegationTurnIdentity;
    startedAt: string;
    leaseDurationMs: number;
  },
): Promise<DelegationDispatchLease | undefined> {
  const current = await deps.storage.chatDelegationSteps.get(input.stepId);
  const nowMs = Date.parse(input.startedAt);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Database did not return a valid delegation dispatch clock.");
  }
  const expiresAtMs = nowMs + input.leaseDurationMs;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const claimMarker = buildDelegationDispatchMarker("claim", input.turnIdentity.turnId, expiresAtMs);
  const dispatchMarker = buildDelegationDispatchMarker("dispatch", input.turnIdentity.turnId, expiresAtMs);
  const existingDispatchClaim = await deps.storage.chatDelegationSteps.getDispatchClaim(input.stepId);

  if (current.status === "pending") {
    const claimed = await deps.storage.chatDelegationSteps.claimPendingForDispatch(
      input.stepId,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return claimed ? { step: claimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }
  if (current.status !== "running") {
    return undefined;
  }

  if (!current.childSessionId && !existingDispatchClaim) {
    const reclaimed = await deps.storage.chatDelegationSteps.reclaimRunningForDispatch(
      input.stepId,
      undefined,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed ? { step: reclaimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }

  if (!current.childSessionId && existingDispatchClaim) {
    const existingClaim = parseDelegationDispatchMarker(existingDispatchClaim.token);
    if (existingClaim?.kind !== "claim") {
      throw new Error(`Delegation step ${input.stepId} has an invalid unlinked dispatch claim.`);
    }
    assertDelegationMarkerTurn(existingClaim, input.turnIdentity.turnId, input.stepId);
    if (Date.parse(existingDispatchClaim.expiresAt) > nowMs) {
      return undefined;
    }
    const reclaimed = await deps.storage.chatDelegationSteps.reclaimRunningForDispatch(
      input.stepId,
      existingDispatchClaim.token,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed ? { step: reclaimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }

  if (!current.childSessionId) {
    return undefined;
  }
  if (current.childTurnId && current.childTurnId !== input.turnIdentity.turnId) {
    return undefined;
  }
  await assertCanonicalDelegationTurnIfPresent(deps, input.turnIdentity, current.childSessionId);
  if (existingDispatchClaim) {
    const existingDispatch = parseDelegationDispatchMarker(existingDispatchClaim.token);
    if (existingDispatch?.kind !== "dispatch") {
      throw new Error(`Delegation step ${input.stepId} has an invalid linked dispatch claim.`);
    }
    assertDelegationMarkerTurn(existingDispatch, input.turnIdentity.turnId, input.stepId);
    if (Date.parse(existingDispatchClaim.expiresAt) > nowMs) {
      return undefined;
    }
    const reclaimed = await deps.storage.chatDelegationSteps.reclaimLinkedDispatch(
      input.stepId,
      current.childSessionId,
      existingDispatchClaim.token,
      dispatchMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed
      ? {
          step: reclaimed,
          childSessionId: current.childSessionId,
          dispatchMarker,
          dispatchExpiresAt: expiresAt,
        }
      : undefined;
  }
  const claimed = await deps.storage.chatDelegationSteps.claimLinkedForDispatch(
    input.stepId,
    current.childSessionId,
    current.childTurnId === input.turnIdentity.turnId ? current.childTurnId : undefined,
    dispatchMarker,
    expiresAt,
    input.startedAt,
  );
  return claimed
    ? {
        step: claimed,
        childSessionId: current.childSessionId,
        dispatchMarker,
        dispatchExpiresAt: expiresAt,
      }
    : undefined;
}

function assertDelegationMarkerTurn(marker: DelegationDispatchMarker, turnId: string, stepId: string): void {
  if (marker.turnId !== turnId) {
    throw new Error(`Delegation step ${stepId} dispatch marker belongs to unexpected turn ${marker.turnId}.`);
  }
}

async function assertCanonicalDelegationTurnIfPresent(
  deps: ChatDelegationServiceHost,
  identity: DelegationTurnIdentity,
  childSessionId: string,
): Promise<void> {
  try {
    const trace = await deps.storage.chatTurnTraces.get(identity.turnId);
    if (trace.sessionId !== childSessionId || trace.userMessageId !== identity.userMessageId) {
      throw new Error(`Canonical delegated turn ${identity.turnId} does not match child session linkage.`);
    }
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }
    throw error;
  }
}

async function assertDelegationDispatchOwnership(
  deps: ChatDelegationServiceHost,
  stepId: string,
  childSessionId: string,
  dispatchMarker: string,
): Promise<void> {
  if (!(await deps.storage.chatDelegationSteps.ownsLinkedDispatch(stepId, childSessionId, dispatchMarker))) {
    throw new DelegationDispatchOwnershipError(stepId);
  }
}

function isDelegationStepDispatchRecoverable(
  step: ChatDelegationStepRecord,
  dispatchClaim: { token: string; expiresAt: string } | undefined,
  expectedTurnId: string,
  nowMs: number,
): boolean {
  if (step.status === "pending") {
    return true;
  }
  if (step.status !== "running") {
    return false;
  }
  if (dispatchClaim) {
    return Date.parse(dispatchClaim.expiresAt) <= nowMs;
  }
  if (!step.childSessionId || !step.childTurnId) {
    return true;
  }
  return step.childTurnId === expectedTurnId;
}

async function findStableParentDelegationRun(
  deps: ChatDelegationServiceHost,
  input: {
    sessionId: string;
    policyRunId?: string;
    objective: string;
    mode: "sequential" | "parallel";
    roles: string[];
    workflowTemplate?: string;
  },
): Promise<ChatDelegationRunRecord | undefined> {
  const parentRunId = input.policyRunId?.trim();
  if (!parentRunId || !deps.storage.chatDelegationRuns.listRecent) {
    return undefined;
  }
  const existing = (
    await deps.storage.chatDelegationRuns.listRecent({
      sessionId: input.sessionId,
      parentRunId,
      limit: 10,
    })
  ).find((run) => run.sessionId === input.sessionId && run.parentRunId === parentRunId);
  if (!existing) {
    return undefined;
  }
  const expectedRoles = dedupeStrings(input.roles);
  if (
    existing.objective !== input.objective ||
    existing.mode !== input.mode ||
    existing.workflowTemplate !== input.workflowTemplate ||
    existing.roles.length !== expectedRoles.length ||
    existing.roles.some((role, index) => role !== expectedRoles[index])
  ) {
    throw new Error(
      `Durable parent ${parentRunId} is already linked to delegation ${existing.runId} with a different persisted plan.`,
    );
  }
  return existing;
}

async function loadExplicitDelegationResumeRun(
  deps: ChatDelegationServiceHost,
  input: {
    runId: string;
    sessionId: string;
    objective: string;
    mode: ChatDelegateRequest["mode"];
    roles: string[];
    workflowTemplate?: string;
  },
): Promise<ChatDelegationRunRecord> {
  const run = await deps.storage.chatDelegationRuns.get(input.runId.trim());
  const expectedRoles = dedupeStrings(input.roles);
  if (
    run.sessionId !== input.sessionId ||
    run.objective !== input.objective ||
    run.mode !== input.mode ||
    run.workflowTemplate !== input.workflowTemplate ||
    run.roles.length !== expectedRoles.length ||
    run.roles.some((role, index) => role !== expectedRoles[index])
  ) {
    throw new Error(`Delegation ${run.runId} cannot resume from drifted persisted input.`);
  }
  return run;
}

async function attachDelegationChildWatcher(
  deps: ChatDelegationServiceHost,
  input: {
    parentRunId?: string;
    childRunId?: string;
    watcherId: string;
    delegationRunId: string;
    stepId: string;
    childSessionId: string;
    childTurnId: string;
    required?: boolean;
  },
): Promise<void> {
  const parentRunId = input.parentRunId?.trim();
  const childRunId = input.childRunId?.trim();
  if (input.required && (!deps.watchDurableChildRun || !parentRunId || !childRunId)) {
    throw new Error("Workspace explorer requires durable parent/child watcher attachment.");
  }
  if (!deps.watchDurableChildRun || !parentRunId || !childRunId) {
    return;
  }
  await deps.watchDurableChildRun({
    parentRunId,
    childRunId,
    watcherId: input.watcherId,
    source: "chat_delegation",
    ...(input.required ? { required: true } : {}),
    metadata: {
      delegationRunId: input.delegationRunId,
      stepId: input.stepId,
      childSessionId: input.childSessionId,
      childTurnId: input.childTurnId,
    },
  });
}

function rebuildResumableDelegationPlan(
  existingSteps: readonly ChatDelegationStepRecord[],
  requestedSteps: readonly NormalizedDelegationStep[],
): NormalizedDelegationStep[] {
  if (existingSteps.length === 0) {
    return [...requestedSteps];
  }
  if (existingSteps.length > requestedSteps.length) {
    throw new Error("Persisted delegation plan has more steps than the durable parent plan.");
  }
  const existingByIndex = new Map<number, ChatDelegationStepRecord>();
  const existingIndexById = new Map<string, number>();
  for (const step of existingSteps) {
    if (existingByIndex.has(step.index) || existingIndexById.has(step.stepId)) {
      throw new Error(`Persisted delegation plan has duplicate step index ${step.index}.`);
    }
    const requested = requestedSteps[step.index];
    if (
      !requested ||
      requested.index !== step.index ||
      requested.role !== step.role ||
      requested.parallelizable !== Boolean(step.parallelizable)
    ) {
      throw new Error(`Persisted delegation step ${step.stepId} does not match the durable parent plan.`);
    }
    existingByIndex.set(step.index, step);
    existingIndexById.set(step.stepId, step.index);
  }

  const requestedIndexById = new Map(requestedSteps.map((step) => [step.stepId, step.index] as const));
  const canonicalIndexById = new Map<string, number>(requestedIndexById);
  for (const [stepId, index] of existingIndexById) {
    canonicalIndexById.set(stepId, index);
  }
  const dependencyIndexes = (stepId: string, dependencyIds: readonly string[]): number[] =>
    dependencyIds
      .map((dependencyId) => {
        const dependencyIndex = canonicalIndexById.get(dependencyId);
        if (dependencyIndex === undefined) {
          throw new Error(
            `Persisted delegation step ${stepId} depends on unknown step ${dependencyId} and does not match the durable parent plan.`,
          );
        }
        return dependencyIndex;
      })
      .sort((left, right) => left - right);
  for (const persisted of existingSteps) {
    const requested = requestedSteps[persisted.index]!;
    const persistedDependencies = dependencyIndexes(persisted.stepId, persisted.dependsOnStepIds ?? []);
    const requestedDependencies = dependencyIndexes(requested.stepId, requested.dependsOnStepIds);
    if (
      persistedDependencies.length !== requestedDependencies.length ||
      persistedDependencies.some((dependencyIndex, index) => dependencyIndex !== requestedDependencies[index])
    ) {
      throw new Error(`Persisted delegation step ${persisted.stepId} does not match the durable parent plan.`);
    }
  }
  const actualIdByIndex = new Map(
    requestedSteps.map((step) => [step.index, existingByIndex.get(step.index)?.stepId ?? step.stepId] as const),
  );
  return requestedSteps.map((requested) => {
    const persisted = existingByIndex.get(requested.index);
    const requestedDependencies = requested.dependsOnStepIds.map((dependencyId) => {
      const dependencyIndex = requestedIndexById.get(dependencyId);
      return dependencyIndex === undefined ? dependencyId : (actualIdByIndex.get(dependencyIndex) ?? dependencyId);
    });
    return {
      stepId: persisted?.stepId ?? requested.stepId,
      index: requested.index,
      role: requested.role,
      parallelizable: requested.parallelizable,
      dependsOnStepIds: dedupeStrings(persisted ? (persisted.dependsOnStepIds ?? []) : requestedDependencies),
    };
  });
}

function buildDelegationStitchedOutput(steps: readonly ChatDelegationStepRecord[]): string {
  return steps
    .map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "running" || step.status === "pending"
            ? `WAITING: ${step.output ?? "Delegate is still running."}`
            : step.status === "cancelled"
              ? `CANCELLED: ${step.error ?? step.output ?? "Delegate was cancelled."}`
              : step.status === "skipped"
                ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
                : [
                    `FAILED: ${step.error ?? "Delegate failed without an error message."}`,
                    step.output?.trim() && step.output.trim() !== step.error?.trim()
                      ? `Partial output:\n${step.output.trim()}`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
      return `### ${toTitleCase(step.role)}\n${body}`;
    })
    .join("\n\n")
    .trim();
}

function buildDelegationStages(steps: readonly NormalizedDelegationStep[]): NormalizedDelegationStep[][] {
  const remaining = new Map(steps.map((step) => [step.stepId, step] as const));
  const resolved = new Set<string>();
  const stages: NormalizedDelegationStep[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => step.dependsOnStepIds.every((dependencyStepId) => resolved.has(dependencyStepId)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      throw new Error("delegation steps contain a dependency cycle or unresolved dependency");
    }
    const stage = ready.some((step) => !step.parallelizable) ? [ready[0]!] : ready;
    stages.push(stage);
    for (const step of stage) {
      remaining.delete(step.stepId);
      resolved.add(step.stepId);
    }
  }

  return stages;
}

function composeChatDelegationAbortSignal(childSignal: AbortSignal, parentSignal?: AbortSignal): AbortSignal {
  if (!parentSignal) {
    return childSignal;
  }
  return AbortSignal.any([childSignal, parentSignal]);
}

function throwIfChatDelegationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Chat delegation cancelled.");
  error.name = "AbortError";
  throw error;
}

function isChatDelegationAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface BuildDelegationSpecialistSystemPromptInput {
  role: string;
}

export function buildDelegationSpecialistSystemPrompt(input: BuildDelegationSpecialistSystemPromptInput): string {
  return [
    "You are a specialist subagent in a multi-step delegation run.",
    `Assigned role: ${input.role}.`,
    "Return concise, practical output in plain markdown.",
    "If you are missing data, call that out explicitly and propose a next best step.",
    "Never claim external data unless it was provided in the current context.",
  ].join("\n");
}

export interface BuildSubagentTaskFirstMessageInput {
  role: string;
  objective: string;
  mode: "sequential" | "parallel";
  parentDelegationStepId: string;
  sharedContext: Array<{ role: string; output: string }>;
  readOnlyExplorer?: boolean;
}

export function buildSubagentTaskFirstMessage(input: BuildSubagentTaskFirstMessageInput): string {
  const dependencyBlock =
    input.sharedContext.length > 0
      ? input.sharedContext.map((item) => `Role ${item.role} output:\n${item.output}`).join("\n\n")
      : "None";
  return [
    `[Subagent Task] ${input.objective}`,
    `Assigned role: ${input.role}`,
    `Execution mode: ${input.mode}`,
    `Parent delegation step: ${input.parentDelegationStepId}`,
    "",
    "Completed dependency outputs available to this role:",
    dependencyBlock,
    "",
    ...(input.readOnlyExplorer
      ? [
          "Read-only workspace explorer posture: inspect only the server-owned delegated filesystem scope.",
          "Do not write files, run shell commands, use browser, MCP, network, or delegate further.",
          "Return Answer, Evidence, Searched scope, and Gaps; state partial results explicitly.",
          "Request additional paths only through the existing scope-expansion work-result envelope.",
          "",
        ]
      : []),
    "Produce your role output now.",
  ].join("\n");
}

function buildLateChildTimeoutDiagnostic(input: {
  event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>;
  role: string;
  stepId: string;
}): AgenticDiagnosticSignal {
  const roleLabel = toTitleCase(input.role);
  const createdAt = new Date().toISOString();
  if (input.event.status === "completed") {
    return {
      signalId: randomUUID(),
      code: "child_timeout",
      severity: "warning",
      title: "Subagent completed after timeout",
      summary: `${roleLabel} completed after its timeout; recorded as diagnostics only and ignored as deliverable truth.`,
      evidenceRef: `delegation-step:${input.stepId}`,
      createdAt,
    };
  }
  return {
    signalId: randomUUID(),
    code: "child_timeout",
    severity: "warning",
    title: "Subagent failed after timeout",
    summary: `${roleLabel} failed after its timeout: ${formatUnknownError(input.event.error)}`,
    evidenceRef: `delegation-step:${input.stepId}`,
    createdAt,
  };
}

function buildLateChildTimeoutActivityMetadata(input: {
  event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>;
  runId: string;
  childRunId: string;
  stepId: string;
  childSessionId: string;
  diagnostic: AgenticDiagnosticSignal;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    runId: input.runId,
    childRunId: input.childRunId,
    stepId: input.stepId,
    childSessionId: input.childSessionId,
    diagnosticCode: input.diagnostic.code,
    diagnosticSignalId: input.diagnostic.signalId,
    lateStatus: input.event.status,
    elapsedMs: input.event.elapsedMs,
    ignoredAsDeliverableTruth: true,
  };
  if (input.event.status === "completed") {
    metadata.childTurnId = input.event.value.turnId;
    metadata.durableRunId = input.event.value.trace?.durable?.runId;
    metadata.citationCount = input.event.value.citations?.length ?? 0;
    metadata.outputPreview = input.event.value.assistantMessage?.content?.slice(0, 1000);
    return metadata;
  }
  metadata.error = formatUnknownError(input.event.error);
  return metadata;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: cappedConcurrency }, () => runWorker()));
  return results;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeReadOnlyExplorerLaunchActor(
  request: Pick<ChatDelegateRequest, "operatorId" | "authActorId" | "authActorSource">,
  parentActor: DurableChatTurnRequestActorAuthority,
  requireExactRequestMatch: boolean,
): Pick<ChatDelegateRequest, "operatorId" | "authActorId" | "authActorSource"> {
  if (parentActor.actorKind !== "operator") {
    throw new ValidationError({
      message: "Workspace exploration requires an operator-owned durable Chat parent run.",
    });
  }
  const actorId = asOptionalTrimmedString(parentActor.actorId);
  const operatorId = asOptionalTrimmedString(parentActor.operatorId) ?? actorId;
  const authActorId = asOptionalTrimmedString(parentActor.authActorId) ?? actorId;
  const authActorSource = readChatAuthActorSource(parentActor.authActorSource);
  if (!actorId || !operatorId || !authActorId || (parentActor.authActorSource !== undefined && !authActorSource)) {
    throw new ValidationError({ message: "Workspace exploration parent actor authority is invalid." });
  }
  if (
    requireExactRequestMatch &&
    (asOptionalTrimmedString(request.operatorId) !== operatorId ||
      asOptionalTrimmedString(request.authActorId) !== authActorId ||
      request.authActorSource !== authActorSource)
  ) {
    throw new ValidationError({
      message: "Workspace exploration actor must match the durable Chat parent actor.",
    });
  }
  return {
    operatorId,
    authActorId,
    ...(authActorSource ? { authActorSource } : {}),
  };
}

function buildReadOnlyExplorerSessionPrefs(base: ChatSessionPrefsRecord): ChatSessionPrefsRecord {
  return {
    ...base,
    mode: "chat",
    planningMode: "off",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "off",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: false,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "sequential",
    codeAutoApply: "manual",
    proactiveMode: "off",
    retrievalMode: "standard",
    reflectionMode: "off",
  };
}

function restorePersistedDelegationRequest(
  frozenRequest: Readonly<Record<string, unknown>>,
  actor: {
    actorKind: "operator" | "external_companion" | "system";
    actorId: string;
    operatorId?: string;
    authActorId?: string;
    authActorSource?: string;
  },
): ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext } {
  const content = asOptionalTrimmedString(frozenRequest.content);
  if (!content) {
    throw new Error("Persisted delegated Chat request has no canonical content.");
  }
  const authActorSource = readChatAuthActorSource(actor.authActorSource);
  const operatorId = actor.operatorId ?? (actor.actorKind === "operator" ? actor.actorId : undefined);
  return {
    ...(frozenRequest as unknown as ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext }),
    content,
    ...(operatorId ? { operatorId } : {}),
    ...(actor.authActorId ? { authActorId: actor.authActorId } : {}),
    ...(authActorSource ? { authActorSource } : {}),
  };
}

function restorePersistedDelegationPreferences(
  base: ChatSessionPrefsRecord,
  request: ChatSendMessageRequest,
): ChatSessionPrefsRecord {
  const override =
    request.prefsOverride && typeof request.prefsOverride === "object" ? request.prefsOverride : undefined;
  const webMode = readEnumValue(request.webMode, ["auto", "off", "quick", "deep"] as const);
  const memoryMode = readEnumValue(request.memoryMode, ["auto", "on", "off"] as const);
  const thinkingLevel = readEnumValue(request.thinkingLevel, [
    "off",
    "minimal",
    "standard",
    "extended",
    "deep",
    "max",
    "ultra",
  ] as const);
  const toolAutonomy = readEnumValue(override?.toolAutonomy, ["safe_auto", "manual"] as const);
  const retrievalMode = readEnumValue(override?.retrievalMode, ["standard", "layered"] as const);
  if (!webMode || !memoryMode || !thinkingLevel || !toolAutonomy || !retrievalMode) {
    throw new Error("Persisted delegated Chat request is missing its frozen execution posture.");
  }
  return {
    ...base,
    providerId: asOptionalTrimmedString(request.providerId),
    model: asOptionalTrimmedString(request.model),
    webMode,
    memoryMode,
    thinkingLevel,
    speedMode: readEnumValue(request.speedMode, ["standard", "fast"] as const),
    subagentPolicy: readEnumValue(request.subagentPolicy, ["off", "ask_when_useful", "auto_when_useful"] as const),
    toolAutonomy,
    retrievalMode,
    // The signed child request does not carry this session-only preference.
    // Resume fail-closed instead of inheriting a later live auto-apply choice.
    codeAutoApply: "manual",
  };
}

function restorePersistedDelegationPolicyContext(
  request: ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext },
  binding: Pick<ToolPolicyActorContext, "workspaceId" | "sessionId" | "taskId" | "runId">,
): ToolPolicyActorContext {
  const embedded = request.policyContext;
  if (
    embedded &&
    (embedded.permissionProfileId !== request.permissionProfileId ||
      embedded.localOperatorOverrideId !== request.localOperatorOverrideId ||
      embedded.fullWebAccess !== request.fullWebAccess)
  ) {
    throw new Error("Persisted delegated Chat policy context conflicts with its frozen request posture.");
  }
  return {
    ...embedded,
    operatorId: request.operatorId,
    authActorId: request.authActorId,
    authActorSource: request.authActorSource,
    permissionProfileId: request.permissionProfileId,
    localOperatorOverrideId: request.localOperatorOverrideId,
    fullWebAccess: request.fullWebAccess,
    surface: "chat",
    ...binding,
  };
}

function readChatAuthActorSource(value: unknown): ChatSendMessageRequest["authActorSource"] | undefined {
  return readEnumValue(value, [
    "none",
    "token",
    "basic",
    "loopback",
    "sse",
    "device",
    "companion",
    "a2a_peer",
    "mesh_node",
  ] as const);
}

function readEnumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}

async function waitForExplorerPreAdmissionLease(waitMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(EXPLORER_RECONCILIATION_POLL_MS, deadline - Date.now())),
    );
  }
}

async function waitForExplorerStepAdmission(
  deps: ChatDelegationServiceHost,
  stepId: string,
): Promise<ChatDelegationStepRecord> {
  const wallDeadline = Date.now() + EXPLORER_PRE_ADMISSION_LEASE_MS + EXPLORER_RECONCILIATION_POLL_MS;
  while (true) {
    const step = await deps.storage.chatDelegationSteps.get(stepId);
    if (step.durableRunId || (step.status !== "pending" && step.status !== "running")) return step;
    const claim = await deps.storage.chatDelegationSteps.getDispatchClaim(stepId);
    const databaseNowMs = Date.parse(await deps.storage.chatDelegationSteps.readDatabaseNow());
    if (!claim || !Number.isFinite(databaseNowMs) || Date.parse(claim.expiresAt) <= databaseNowMs) return step;
    if (Date.now() >= wallDeadline) return step;
    await waitForExplorerPreAdmissionLease(
      Math.max(1, Math.min(EXPLORER_RECONCILIATION_POLL_MS, Date.parse(claim.expiresAt) - databaseNowMs)),
    );
  }
}

async function terminalizeUnavailableWorkspaceExplorerStep(
  deps: ChatDelegationServiceHost,
  run: ChatDelegationRunRecord,
  observedStep: ChatDelegationStepRecord,
): Promise<boolean> {
  const current = await waitForExplorerStepAdmission(deps, observedStep.stepId);
  if (current.durableRunId || (current.status !== "pending" && current.status !== "running")) {
    return false;
  }
  const finishedAt = await deps.storage.chatDelegationSteps.readDatabaseNow();
  const error = "Workspace exploration is unavailable because its verified project or filesystem scope changed.";
  const committed = await deps.storage.runImmediateTransaction(async () => {
    const locks = await lockDelegationAggregateTruth(deps, run.runId, run.taskId);
    const failedStep = await deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
      stepId: current.stepId,
      status: "failed",
      label: current.role,
      summary: "Workspace exploration unavailable.",
      error,
      failureGuidance: "Start a new workspace exploration turn after verifying the current project binding.",
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt)),
    });
    if (!failedStep) return undefined;
    return await persistDelegationAggregateFromLockedTruth(
      deps,
      {
        runId: run.runId,
        taskId: run.taskId,
        trace: run.trace,
        observedAt: finishedAt,
      },
      locks,
    );
  });
  if (!committed) return false;
  await publishDelegationAggregateCommit(deps, committed);
  return true;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * When a chat session that is itself a subagent calls
 * `runChatDelegation`, infer the caller's depth from its registered
 * task-subagent record so the resulting child sits at `depth + 1` and is
 * subject to `maxDepth` enforcement. Returns `undefined` when no record
 * exists or the record has no usable depth (so the caller is treated as
 * a top-level operator -> child depth 1).
 */
async function resolveInferredParentDepth(
  deps: ChatDelegationServiceHost,
  sessionId: string,
): Promise<number | undefined> {
  const record = await deps.storage.taskSubagents.findByAgentSessionId(sessionId);
  const depth = record?.metadata?.depth;
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0) {
    return undefined;
  }
  return depth;
}

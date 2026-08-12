import type {
  ChatSessionStatusAttention,
  ChatSessionStatusBackgroundTask,
  ChatSessionStatusCapabilities,
  ChatSessionStatusContext,
  ChatSessionStatusModel,
  ChatSessionStatusModelProjection,
  ChatSessionStatusResponse,
  ChatSessionStatusSection,
  ChatSessionStatusUsage,
  ChatTurnLifecycleStatus,
  RuntimeBuildIdentity,
} from "@goatcitadel/contracts";
import { CHAT_SESSION_STATUS_VERSION, NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { projectDurableBackgroundTaskRail } from "./durable-background-task-projection.js";

const ACTIVE_TURN_STATUSES = [
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "waiting_for_user_input",
] as const satisfies readonly ChatTurnLifecycleStatus[];

const BACKGROUND_TASK_PARENT_LIMIT = 25;

export interface ChatSessionStatusServiceDependencies {
  storage: Storage;
  getModelContextWindow: (providerId: string, model: string) => number | undefined;
  getRuntimeIdentity: () => RuntimeBuildIdentity;
  now?: () => string;
}

export class ChatSessionStatusService {
  public constructor(private readonly dependencies: ChatSessionStatusServiceDependencies) {}

  public async getOperatorStatus(sessionId: string): Promise<ChatSessionStatusResponse> {
    const session = await this.dependencies.storage.chatSessionMeta.get(sessionId);
    if (!session) {
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    }

    const traces = await this.dependencies.storage.chatTurnTraces.listBySession(sessionId, 1_000);
    const latestTrace = traces[0];
    const prefs = await this.dependencies.storage.chatSessionPrefs.get(sessionId);
    const model = this.resolveModel(latestTrace, prefs);
    const latestSnapshot = latestTrace
      ? await this.dependencies.storage.routedContextSnapshots.findByTurn(latestTrace.turnId)
      : undefined;
    const attachments = await this.dependencies.storage.chatAttachments.listBySession(
      sessionId,
      200,
      session.workspaceId,
    );
    const context = this.resolveContext(model, latestSnapshot, attachments.length);
    const capabilityProfile = latestTrace
      ? await this.dependencies.storage.chatTurnCapabilityProfiles.findByTurn(latestTrace.turnId)
      : undefined;
    const capabilities = this.resolveCapabilities(latestTrace?.turnId, capabilityProfile, latestSnapshot);
    const pendingApprovals = await this.resolvePendingApprovals(sessionId, session.workspaceId);
    const pendingUserInputs = traces
      .filter((trace) => trace.status === "waiting_for_user_input" && trace.pendingUserInput)
      .map((trace) => ({
        turnId: trace.turnId,
        promptId: trace.pendingUserInput!.promptId,
        kind: trace.pendingUserInput!.kind,
        title: trace.pendingUserInput!.title,
        question: trace.pendingUserInput!.question,
      }));
    const delegationRuns = await this.dependencies.storage.chatDelegationRuns.listBySession(sessionId, 100);
    const delegationStepsByRunId = new Map(
      await Promise.all(
        delegationRuns.map(
          async (run) => [run.runId, await this.dependencies.storage.chatDelegationSteps.listByRun(run.runId)] as const,
        ),
      ),
    );
    const orchestrationRuns = delegationRuns.map((run) => {
      const steps = delegationStepsByRunId.get(run.runId) ?? [];
      return {
        runId: run.runId,
        status: run.status,
        objective: run.objective,
        completedSteps: steps.filter((step) => step.status === "completed").length,
        activeSteps: steps.filter((step) => step.status === "pending" || step.status === "running").length,
        totalSteps: steps.length,
      };
    });
    const durableRunIds = [
      ...traces.map((trace) => trace.durable?.runId),
      ...delegationRuns.flatMap((run) =>
        (delegationStepsByRunId.get(run.runId) ?? []).map((step) => step.durableRunId),
      ),
    ];
    const backgroundTaskAttention = await this.resolveBackgroundTaskAttention(
      durableRunIds,
      session.workspaceId,
      sessionId,
    );
    const durableRunsById = await this.dependencies.storage.durableRuns.getRunsByIds(durableRunIds);
    const durableRuns = [...durableRunsById.values()].map((run) => ({
      runId: run.runId,
      status: run.status,
      workerHealth: run.workerHealth ?? "unknown",
      recoveryState: run.recoveryState ?? "none",
      ...(run.recoverySummary ? { recoverySummary: run.recoverySummary } : {}),
    }));
    const usageSummary = (await this.dependencies.storage.modelUsageEvents.list({ sessionId, limit: 200 })).summary;
    const usage: ChatSessionStatusUsage = {
      attemptCount: usageSummary.attemptCount,
      inputTokens: {
        ...(usageSummary.inputTokens !== undefined ? { value: usageSummary.inputTokens } : {}),
        availability: usageSummary.metricAvailability.inputTokens,
      },
      outputTokens: {
        ...(usageSummary.outputTokens !== undefined ? { value: usageSummary.outputTokens } : {}),
        availability: usageSummary.metricAvailability.outputTokens,
      },
      costUsd: {
        ...(usageSummary.costUsd !== undefined ? { value: usageSummary.costUsd } : {}),
        availability: usageSummary.metricAvailability.costUsd,
      },
    };
    const runtimeIdentity = this.dependencies.getRuntimeIdentity();
    const build: ChatSessionStatusResponse["build"] =
      runtimeIdentity.identitySource !== "unavailable" && runtimeIdentity.integrity !== "unknown"
        ? available(runtimeIdentity)
        : unavailable("Runtime build identity is not verifiable in this environment.");

    return {
      schemaVersion: CHAT_SESSION_STATUS_VERSION,
      sessionId,
      workspaceId: session.workspaceId,
      generatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      model,
      context,
      work: available({
        ...(latestTrace ? { latestTurnId: latestTrace.turnId } : {}),
        turnCounts: Object.fromEntries(
          ACTIVE_TURN_STATUSES.map((status) => [status, traces.filter((trace) => trace.status === status).length]),
        ) as Record<(typeof ACTIVE_TURN_STATUSES)[number], number>,
        durableRuns,
      }),
      attention: available({ pendingApprovals, pendingUserInputs, ...backgroundTaskAttention }),
      orchestration: available({ runs: orchestrationRuns }),
      capabilities,
      usage: available(usage),
      build,
    };
  }

  public async getModelProjection(sessionId: string): Promise<ChatSessionStatusModelProjection> {
    const status = await this.getOperatorStatus(sessionId);
    return {
      schemaVersion: status.schemaVersion,
      sessionId: status.sessionId,
      generatedAt: status.generatedAt,
      model: status.model,
      context:
        status.context.availability === "available"
          ? available({
              contextWindowTokens: status.context.value.contextWindowTokens,
              ...(status.context.value.promptReservedTokens !== undefined
                ? { promptReservedTokens: status.context.value.promptReservedTokens }
                : {}),
              ...(status.context.value.outputReservedTokens !== undefined
                ? { outputReservedTokens: status.context.value.outputReservedTokens }
                : {}),
              ...(status.context.value.usedTokens !== undefined ? { usedTokens: status.context.value.usedTokens } : {}),
              attachmentCount: status.context.value.attachmentCount,
            })
          : status.context,
      work:
        status.work.availability === "available"
          ? available({
              turnCounts: status.work.value.turnCounts,
              durableRuns: status.work.value.durableRuns.map((run) => ({
                status: run.status,
                workerHealth: run.workerHealth,
                recoveryState: run.recoveryState,
              })),
            })
          : status.work,
      attention:
        status.attention.availability === "available"
          ? available({
              pendingApprovalCount: status.attention.value.pendingApprovals.length,
              pendingUserInputCount: status.attention.value.pendingUserInputs.length,
              backgroundTaskCount: status.attention.value.backgroundTasks.length,
              backgroundAttentionRequiredCount: status.attention.value.backgroundTasks.filter(
                (task) => task.attention.required,
              ).length,
              backgroundAttention: status.attention.value.backgroundTasks.map((task) => task.attention),
              backgroundTaskProjectionComplete: status.attention.value.backgroundTaskProjection.complete,
            })
          : status.attention,
      orchestration:
        status.orchestration.availability === "available"
          ? available({
              activeRunCount: status.orchestration.value.runs.filter((run) => run.status === "running").length,
              activeStepCount: status.orchestration.value.runs.reduce((total, run) => total + run.activeSteps, 0),
              totalStepCount: status.orchestration.value.runs.reduce((total, run) => total + run.totalSteps, 0),
            })
          : status.orchestration,
      capabilities: status.capabilities,
      usage: status.usage,
    };
  }

  private resolveModel(
    latestTrace: Awaited<ReturnType<Storage["chatTurnTraces"]["listBySession"]>>[number] | undefined,
    prefs: Awaited<ReturnType<Storage["chatSessionPrefs"]["get"]>>,
  ): ChatSessionStatusSection<ChatSessionStatusModel> {
    const traceProvider = latestTrace?.routing.effectiveProviderId;
    const traceModel = latestTrace?.routing.effectiveModel ?? latestTrace?.model;
    if (traceProvider && traceModel) {
      return available({ providerId: traceProvider, model: traceModel, selectionSource: "turn_trace" });
    }
    if (prefs?.providerId && prefs.model) {
      return available({ providerId: prefs.providerId, model: prefs.model, selectionSource: "session_preference" });
    }
    return unavailable("No effective provider and model have been resolved for this session.");
  }

  private resolveContext(
    model: ChatSessionStatusSection<ChatSessionStatusModel>,
    snapshot: Awaited<ReturnType<Storage["routedContextSnapshots"]["findByTurn"]>>,
    attachmentCount: number,
  ): ChatSessionStatusSection<ChatSessionStatusContext> {
    if (snapshot) {
      const includedCount = snapshot.entries.filter((entry) => entry.disposition === "included").length;
      const truncatedCount = snapshot.entries.filter((entry) => entry.disposition === "truncated").length;
      const omittedCount = snapshot.entries.filter((entry) => entry.disposition === "omitted").length;
      return available({
        contextWindowTokens: snapshot.budget.contextWindowTokens,
        promptReservedTokens: snapshot.budget.promptReservedTokens,
        outputReservedTokens: snapshot.budget.outputReservedTokens,
        usedTokens: snapshot.budget.usedTokens,
        attachmentCount,
        latestSnapshot: {
          snapshotId: snapshot.snapshotId,
          snapshotHash: snapshot.snapshotHash,
          turnId: snapshot.turnId,
          createdAt: snapshot.createdAt,
          includedCount,
          truncatedCount,
          omittedCount,
        },
      });
    }
    if (model.availability === "available") {
      const contextWindowTokens = this.dependencies.getModelContextWindow(model.value.providerId, model.value.model);
      if (contextWindowTokens !== undefined) {
        return available({ contextWindowTokens, attachmentCount });
      }
    }
    return unavailable("Context budget is unavailable until a model or routed-context snapshot is resolved.");
  }

  private resolveCapabilities(
    turnId: string | undefined,
    profile: Awaited<ReturnType<Storage["chatTurnCapabilityProfiles"]["findByTurn"]>>,
    snapshot: Awaited<ReturnType<Storage["routedContextSnapshots"]["findByTurn"]>>,
  ): ChatSessionStatusSection<ChatSessionStatusCapabilities> {
    if (!turnId || !profile) {
      return unavailable("No persisted capability profile is available for the latest turn.");
    }
    const attachedContextTools = snapshot?.entries.some(
      (entry) => entry.disposition !== "omitted" && entry.admittedText.length > 0,
    )
      ? ["context.list", "context.grep", "context.query", "context.read_range"]
      : [];
    return available({
      profileTurnId: turnId,
      callableTools: profile.selection.tools.map((tool) => tool.canonicalName),
      trustedSkills: profile.selection.trustedSkills.map((skill) => ({
        skillId: skill.skillId,
        trustLabel: skill.trustLabel,
      })),
      attachedContextTools,
      memory: {
        mode: profile.selection.memory.mode,
        retrievalMode: profile.selection.memory.retrievalMode,
        writeApprovalRequired: profile.selection.memory.writeApprovalRequired,
      },
    });
  }

  private async resolvePendingApprovals(sessionId: string, workspaceId: string) {
    const canonical = (await this.dependencies.storage.approvals.list("pending", 500, workspaceId))
      .filter((approval) => approval.linkage?.sessionId === sessionId)
      .map((approval) => ({
        approvalId: approval.approvalId,
        ...(approval.linkage?.turnId ? { turnId: approval.linkage.turnId } : {}),
        kind: approval.kind,
        riskLevel: approval.riskLevel,
        createdAt: approval.createdAt,
      }));
    const seen = new Set(canonical.map((approval) => approval.approvalId));
    const inline = (await this.dependencies.storage.chatInlineApprovals.listBySession(sessionId))
      .filter((approval) => approval.status === "pending" && !seen.has(approval.approvalId))
      .map((approval) => ({
        approvalId: approval.approvalId,
        turnId: approval.turnId,
        kind: approval.kind ?? approval.toolName ?? "chat_inline",
        ...(approval.riskLevel ? { riskLevel: approval.riskLevel } : {}),
        createdAt: approval.createdAt,
      }));
    return [...canonical, ...inline];
  }

  private async resolveBackgroundTaskAttention(
    durableRunIds: Array<string | undefined>,
    workspaceId: string,
    sessionId: string,
  ): Promise<Pick<ChatSessionStatusAttention, "backgroundTasks" | "backgroundTaskProjection">> {
    const uniqueParentRunIds = [...new Set(durableRunIds.filter((runId): runId is string => Boolean(runId)))];
    const selectedParentRunIds = uniqueParentRunIds.slice(0, BACKGROUND_TASK_PARENT_LIMIT);
    const results = await Promise.allSettled(
      selectedParentRunIds.map((parentRunId) =>
        projectDurableBackgroundTaskRail(this.dependencies.storage, { parentRunId, workspaceId, sessionId }),
      ),
    );
    const tasks = new Map<string, ChatSessionStatusBackgroundTask>();
    let complete = uniqueParentRunIds.length <= BACKGROUND_TASK_PARENT_LIMIT;
    const reasons: string[] = [];
    if (!complete) {
      reasons.push(`Background-task parent coverage reached the ${BACKGROUND_TASK_PARENT_LIMIT} run boundary.`);
    }
    for (const result of results) {
      if (result.status === "rejected") {
        complete = false;
        reasons.push("At least one background-task projection was unavailable.");
        continue;
      }
      if (!result.value.coverage.watchers.complete || !result.value.coverage.parentSignals.complete) {
        complete = false;
        reasons.push("At least one background-task projection reached its bounded evidence limit.");
      }
      for (const task of result.value.tasks) {
        tasks.set(task.watcherId, {
          watcherId: task.watcherId,
          childRunId: task.childRunId,
          label: task.label,
          canonicalStatus: task.canonicalStatus,
          attention: task.attention,
          blockers: task.blockers,
          links: task.links,
        });
      }
    }
    return {
      backgroundTasks: [...tasks.values()],
      backgroundTaskProjection: {
        complete,
        ...(!complete ? { reason: [...new Set(reasons)].join(" ") || "Background-task status is incomplete." } : {}),
      },
    };
  }
}

function available<T>(value: T): ChatSessionStatusSection<T> {
  return { availability: "available", value };
}

function unavailable<T>(reason: string): ChatSessionStatusSection<T> {
  return { availability: "unavailable", reason };
}

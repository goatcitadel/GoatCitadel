import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

vi.mock("./gateway-route-service-composition.js", () => ({
  composeGatewayRouteServices: vi.fn((port) => ({ composed: true, port })),
  createChatThreadKnowledgeDependenciesForGateway: vi.fn((port) => ({ kind: "thread-knowledge", port })),
  createCommsHostForGateway: vi.fn((port, integrationChannel) => ({ kind: "comms", port, integrationChannel })),
  createGatewayRouteCompositionPort: vi.fn((gateway, deps) => ({ kind: "route-port", gateway, deps })),
  createIntegrationChannelServiceForGateway: vi.fn((port, diagnostics) => ({ kind: "channel", port, diagnostics })),
  createIntegrationDiagnosticsServiceForGateway: vi.fn((port) => ({ kind: "diagnostics", port })),
  createSettingsAuthRuntimeDependenciesForGateway: vi.fn((port) => ({ kind: "settings-auth", port })),
  createSettingsRuntimeDependenciesForGateway: vi.fn((port) => ({ kind: "settings", port })),
}));

import type { ApprovalRequest, OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { MEMORY_CONSOLIDATION_WEEKLY_JOB_ID } from "./gateway/cron-job-ids.js";
import * as routeComposition from "./gateway-route-service-composition.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  Object.assign(gateway, {
    backgroundTasks: new Set<Promise<unknown>>(),
    closing: false,
    config: {
      rootDir: "F:/tmp/gc-loop22",
      assistant: {
        mesh: { nodeId: "node-loop22" },
      },
    },
    recordDevDiagnostic: vi.fn(),
    runtimeReleaseTrustService: { close: vi.fn(async () => undefined), start: vi.fn() },
    sharedHostLifecycle: new SharedHostLifecycleService({ enabled: false }),
  });
  Object.assign(gateway, overrides);
  return gateway;
}

function createRouteDependencyHarness() {
  return createGatewayHarness({
    addonsService: { name: "addons" },
    addonSlotService: { name: "addon-slot" },
    approvalRuntime: { name: "approval-runtime" },
    assemblyService: { name: "assembly" },
    backupRetentionService: { name: "backup-retention" },
    capabilityPackService: { name: "capability-pack" },
    capabilitySystemService: { name: "capability-system" },
    chatProjectService: { name: "chat-project" },
    chatTurnRuntime: { name: "chat-turn-runtime" },
    databaseCutoverService: { name: "database-cutover" },
    devDiagnostics: { name: "dev-diagnostics" },
    durableOperatorService: { name: "durable-operator" },
    evidenceEnvelopeService: { name: "evidence-envelope" },
    guidanceService: { name: "guidance" },
    improvementService: { name: "improvement" },
    mediaVoiceService: { name: "media-voice" },
    obsidianVaultService: { name: "obsidian" },
    promptPackService: { name: "prompt-pack" },
    realtimeEventService: { name: "realtime-event" },
    researchService: { name: "research" },
    runtimeLifecycleReadService: { name: "runtime-lifecycle" },
    opsSavedBoardRealtimeEpoch: "epoch-loop22",
    storage: {
      externalSourceConfigs: {},
      externalSourceScans: {},
      governanceJourneyEvents: {},
      opsSavedBoards: {},
      workspacePathBridgeSnapshots: {},
      workspaces: {},
    },
    taskLifecycleService: { name: "task-lifecycle" },
    toolInvocationCoordinator: { name: "tool-invocation" },
    workspacePathBridgeRuntime: { service: { name: "workspace-path-bridge" } },
  });
}

function createDeferredInitHarness(overrides: Record<string, unknown> = {}) {
  const gateway = createGatewayHarness({
    configGenerationService: {
      getRollbackRuntimeOwnerRecoveryIntent: vi.fn(() => undefined),
      getRuntimeOwnerRecoveryIntent: vi.fn(() => undefined),
      isRuntimeOwnerReconciliationPending: vi.fn(() => false),
      completeRuntimeOwnerReconciliation: vi.fn(async () => undefined),
    },
    cronConfigGenerationOwner: {
      reconcileCommittedGeneration: vi.fn(),
      reconcileStartupGeneration: vi.fn(async () => []),
    },
    cronAutomationService: {
      recoverPendingAgentTurnCronRuns: vi.fn(async () => ({
        checkedAt: "2026-07-13T00:00:00.000Z",
        checkedCount: 0,
        launchedCount: 0,
        advancedCount: 0,
        settledCount: 0,
        reconciliationCount: 0,
        staleCount: 0,
        errors: [],
      })),
    },
    approvalEffectsService: { startWorker: vi.fn(), stopWorker: vi.fn() },
    capabilitySystemService: {
      reconcileCodeModeFinalTranscriptDeliveries: vi.fn(() => ({
        checked: 0,
        enqueued: 0,
        errors: [],
        omittedErrors: 0,
      })),
    },
    discordRuntimeService: { close: vi.fn(async () => undefined), sync: vi.fn(async () => undefined) },
    signalInboundRuntimeService: { stop: vi.fn(), sync: vi.fn() },
    drainDueChannelDeliveries: vi.fn(async () => [{ deliveryId: "delivery-1" }]),
    durableRunService: {
      resumeRunsWaitingForAutonomyKillSwitch: vi.fn(),
      startWorker: vi.fn(),
      stopWorker: vi.fn(),
    },
    heartbeatOccurrenceService: {
      recoverAll: vi.fn(async () => ({ scanned: 0, busy: 0, reclaimed: 0, resumed: 0, terminal: 0, closed: 0 })),
    },
    ensureCostReportCronJob: vi.fn(async () => undefined),
    ensureMemoryFlushCronJob: vi.fn(async () => undefined),
    ensureMemoryConsolidationCronJob: vi.fn(async () => undefined),
    ensurePrivateBetaBackupCronJob: vi.fn(async () => undefined),
    ensureUpdateReviewCronJob: vi.fn(async () => undefined),
    eventIngestService: { flushPendingTranscriptOutbox: vi.fn(async () => 1) },
    curatorService: {
      ensureCuratorWeeklyCronJob: vi.fn(async () => undefined),
    },
    improvementService: {
      ensureWeeklyImprovementCronJob: vi.fn(async () => undefined),
      markInterruptedDecisionReplayRuns: vi.fn(),
      startScheduler: vi.fn(),
      stopScheduler: vi.fn(),
    },
    llamaCppRuntime: { close: vi.fn(async () => undefined), init: vi.fn(async () => undefined) },
    isFeatureEnabled: vi.fn((flag: string) => flag === "chatTurnInterruptionRecoveryV1Disabled"),
    mediaVoiceService: { resumeInterruptedMediaJobs: vi.fn() },
    meshService: { init: vi.fn() },
    npuSidecar: { close: vi.fn(async () => undefined), init: vi.fn(async () => undefined) },
    promptPackService: { resumeInterruptedBenchmarkRuns: vi.fn() },
    readFeatureFlags: vi.fn(() => ({ durableKernelV1Enabled: true })),
    startMaintenanceScheduler: vi.fn(),
    startOrchestrationWorktreeReapScheduler: vi.fn(),
    startProactiveScheduler: vi.fn(),
    scheduleProviderCatalogPrewarm: vi.fn(),
    sessionControlRuntimeOwner: {
      cancelExpiredUnboundTurnAdmissions: vi.fn(() => []),
    },
    storage: {
      realtimeStreamLeases: {
        closeOpenForNode: vi.fn(() => 2),
      },
      // Legacy-open stamp migration (runs inside runDeferredInit): empty
      // connection list + absent done-marker → stamps nothing, publishes nothing.
      integrationConnections: {
        list: vi.fn(() => []),
        update: vi.fn(),
      },
      systemSettings: {
        get: vi.fn(() => undefined),
        set: vi.fn(),
      },
    },
  });
  Object.assign(gateway, overrides);
  return gateway;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GatewayService loop 22 route facade composition", () => {
  it("builds route-facing facades from the narrow route composition port", () => {
    const gateway = createRouteDependencyHarness();

    const port = (GatewayService.prototype as any).buildRouteCompositionPort.call(gateway);

    expect(routeComposition.createGatewayRouteCompositionPort).toHaveBeenCalledWith(
      gateway,
      expect.objectContaining({
        backupRetentionService: gateway.backupRetentionService,
        devDiagnostics: gateway.devDiagnostics,
        durableOperatorService: gateway.durableOperatorService,
        realtimeEventService: gateway.realtimeEventService,
        runtimeLifecycleReadService: gateway.runtimeLifecycleReadService,
        toolInvocationCoordinator: gateway.toolInvocationCoordinator,
      }),
    );
    expect(port).toMatchObject({ kind: "route-port", gateway });

    gateway.routeCompositionPort = { kind: "cached-port" };
    expect((GatewayService.prototype as any).getRouteCompositionPort.call(gateway)).toEqual({ kind: "cached-port" });

    gateway.routeCompositionPort = undefined;
    const routeServices = (GatewayService.prototype as any).buildRouteServices.call(gateway);
    expect(routeServices).toMatchObject({ composed: true });
    expect(routeComposition.composeGatewayRouteServices).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "route-port", gateway }),
    );

    const diagnostics = (GatewayService.prototype as any).buildIntegrationDiagnosticsService.call(gateway);
    const channel = (GatewayService.prototype as any).buildIntegrationChannelService.call(gateway, diagnostics);
    const comms = (GatewayService.prototype as any).buildCommsHost.call(gateway, channel);
    expect(diagnostics).toMatchObject({ kind: "diagnostics" });
    expect(channel).toMatchObject({ kind: "channel", diagnostics });
    expect(comms).toMatchObject({ kind: "comms", integrationChannel: channel });
  });
});

describe("GatewayService loop 22 deferred lifecycle", () => {
  it("runs deferred startup collaborators and starts workers after runtime init succeeds", async () => {
    const gateway = createDeferredInitHarness();

    await (GatewayService.prototype as any).runDeferredInit.call(gateway);

    expect(gateway.storage.realtimeStreamLeases.closeOpenForNode).toHaveBeenCalledWith({
      gatewayNodeId: "node-loop22",
      closeReason: "process_restart",
    });
    expect(gateway.eventIngestService.flushPendingTranscriptOutbox).toHaveBeenCalled();
    expect(gateway.capabilitySystemService.reconcileCodeModeFinalTranscriptDeliveries).toHaveBeenCalled();
    expect(gateway.drainDueChannelDeliveries).toHaveBeenCalled();
    expect(gateway.discordRuntimeService.sync).toHaveBeenCalled();
    expect(gateway.improvementService.markInterruptedDecisionReplayRuns).toHaveBeenCalled();
    expect(gateway.cronConfigGenerationOwner.reconcileStartupGeneration).toHaveBeenCalled();
    expect(gateway.improvementService.ensureWeeklyImprovementCronJob).toHaveBeenCalled();
    expect(gateway.ensurePrivateBetaBackupCronJob).toHaveBeenCalled();
    expect(gateway.ensureMemoryFlushCronJob).toHaveBeenCalled();
    expect(gateway.ensureMemoryConsolidationCronJob).toHaveBeenCalled();
    expect(gateway.ensureCostReportCronJob).toHaveBeenCalled();
    expect(gateway.ensureUpdateReviewCronJob).toHaveBeenCalled();
    expect(gateway.meshService.init).toHaveBeenCalled();
    expect(gateway.npuSidecar.init).toHaveBeenCalled();
    expect(gateway.llamaCppRuntime.init).toHaveBeenCalled();
    expect(gateway.configGenerationService.completeRuntimeOwnerReconciliation).toHaveBeenCalled();
    expect(gateway.sessionControlRuntimeOwner.cancelExpiredUnboundTurnAdmissions).toHaveBeenCalledWith({
      actorId: "system:gateway-startup",
      idempotencyKeyPrefix: "gateway-startup:expired-unbound-chat-turn",
      correlationId: expect.stringMatching(/^gateway-startup:/u),
      limit: 100,
    });
    expect(gateway.heartbeatOccurrenceService.recoverAll.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.sessionControlRuntimeOwner.cancelExpiredUnboundTurnAdmissions.mock.invocationCallOrder[0],
    );
    expect(gateway.heartbeatOccurrenceService.recoverAll.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.startProactiveScheduler.mock.invocationCallOrder[0],
    );
    expect(
      gateway.sessionControlRuntimeOwner.cancelExpiredUnboundTurnAdmissions.mock.invocationCallOrder[0],
    ).toBeLessThan(gateway.startProactiveScheduler.mock.invocationCallOrder[0]);
    expect(gateway.startProactiveScheduler).toHaveBeenCalled();
    expect(gateway.startMaintenanceScheduler).toHaveBeenCalled();
    expect(gateway.startOrchestrationWorktreeReapScheduler).toHaveBeenCalled();
    expect(gateway.durableRunService.startWorker).toHaveBeenCalled();
    expect(gateway.durableRunService.resumeRunsWaitingForAutonomyKillSwitch).toHaveBeenCalled();
    expect(gateway.cronAutomationService.recoverPendingAgentTurnCronRuns).toHaveBeenCalled();
    expect(gateway.approvalEffectsService.startWorker).toHaveBeenCalled();
    expect(gateway.mediaVoiceService.resumeInterruptedMediaJobs).toHaveBeenCalled();
    expect(gateway.promptPackService.resumeInterruptedBenchmarkRuns).toHaveBeenCalled();
    expect(gateway.scheduleProviderCatalogPrewarm).toHaveBeenCalled();
  });

  it("recovers occurrences before every advisory heartbeat sweep", async () => {
    const order: string[] = [];
    const gateway = createGatewayHarness({
      heartbeatOccurrenceService: {
        recoverAll: vi.fn(async () => {
          order.push("recover");
        }),
      },
      isFeatureEnabled: vi.fn(() => {
        order.push("advisory-sweep");
        return true;
      }),
    });

    await (GatewayService.prototype as any).runHeartbeatSweep.call(gateway);

    expect(order).toEqual(["recover", "advisory-sweep"]);
  });

  it("reconciles a committed cron generation before clearing the startup marker", async () => {
    const gateway = createDeferredInitHarness();
    gateway.configGenerationService.isRuntimeOwnerReconciliationPending.mockReturnValue(true);

    await (GatewayService.prototype as any).runDeferredInit.call(gateway);

    expect(gateway.cronConfigGenerationOwner.reconcileCommittedGeneration).toHaveBeenCalledOnce();
    expect(gateway.cronConfigGenerationOwner.reconcileCommittedGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.configGenerationService.completeRuntimeOwnerReconciliation.mock.invocationCallOrder[0],
    );
  });

  it("skips deferred startup when closing and stops before workers if closing begins during runtime init", async () => {
    const closingGateway = createDeferredInitHarness({ closing: true });
    await (GatewayService.prototype as any).runDeferredInit.call(closingGateway);
    expect(closingGateway.storage.realtimeStreamLeases.closeOpenForNode).not.toHaveBeenCalled();

    const midCloseGateway = createDeferredInitHarness();
    midCloseGateway.npuSidecar.init = vi.fn(async () => {
      midCloseGateway.closing = true;
    });

    await (GatewayService.prototype as any).runDeferredInit.call(midCloseGateway);

    expect(midCloseGateway.llamaCppRuntime.init).toHaveBeenCalled();
    expect(midCloseGateway.configGenerationService.completeRuntimeOwnerReconciliation).toHaveBeenCalled();
    expect(midCloseGateway.durableRunService.startWorker).not.toHaveBeenCalled();
    expect(midCloseGateway.promptPackService.resumeInterruptedBenchmarkRuns).not.toHaveBeenCalled();
  });

  it("tracks deferred init failures and removes the failed task from background work", async () => {
    const gateway = createGatewayHarness({
      backgroundTasks: new Set<Promise<void>>(),
      criticalInitComplete: true,
      runDeferredInit: vi.fn(async () => {
        throw new Error("deferred boom");
      }),
    });

    const task = GatewayService.prototype.startDeferredInit.call(gateway);
    expect(gateway.backgroundTasks.has(task)).toBe(true);
    await expect(task).rejects.toThrow("deferred boom");
    expect(gateway.backgroundTasks.has(task)).toBe(false);
  });

  it("stops schedulers, clears maintenance interval, waits background work, and closes runtimes", async () => {
    vi.useFakeTimers();
    const backgroundTask = Promise.resolve();
    const maintenanceStop = vi.fn();
    const gateway = createGatewayHarness({
      approvalEffectsService: { stopWorker: vi.fn() },
      assemblyService: { close: vi.fn(async () => undefined) },
      backgroundTasks: new Set<Promise<unknown>>([backgroundTask]),
      chatProactiveService: { stopScheduler: vi.fn() },
      discordRuntimeService: { close: vi.fn(async () => undefined) },
      signalInboundRuntimeService: { stop: vi.fn() },
      durableRunService: { stopWorker: vi.fn() },
      improvementService: { stopScheduler: vi.fn() },
      inboundChannelEventService: { close: vi.fn() },
      llamaCppRuntime: { close: vi.fn(async () => undefined) },
      maintenanceScheduler: { stop: maintenanceStop },
      npuSidecar: { close: vi.fn(async () => undefined) },
      orchestrationWorktreeService: { close: vi.fn() },
      storage: { close: vi.fn() },
    });

    await GatewayService.prototype.close.call(gateway);

    expect(gateway.closing).toBe(true);
    expect(gateway.chatProactiveService.stopScheduler).toHaveBeenCalled();
    expect(gateway.improvementService.stopScheduler).toHaveBeenCalled();
    expect(gateway.durableRunService.stopWorker).toHaveBeenCalled();
    expect(gateway.approvalEffectsService.stopWorker).toHaveBeenCalled();
    expect(gateway.inboundChannelEventService.close).toHaveBeenCalled();
    expect(maintenanceStop).toHaveBeenCalledTimes(1);
    expect(gateway.maintenanceScheduler).toBeUndefined();
    expect(gateway.backgroundTasks.size).toBe(0);
    expect(gateway.discordRuntimeService.close).toHaveBeenCalled();
    expect(gateway.assemblyService.close).toHaveBeenCalled();
    expect(gateway.npuSidecar.close).toHaveBeenCalled();
    expect(gateway.llamaCppRuntime.close).toHaveBeenCalled();
    expect(gateway.orchestrationWorktreeService.close).toHaveBeenCalled();
    expect(gateway.storage.close).toHaveBeenCalled();
  });
});

describe("GatewayService memory consolidation scheduler", () => {
  it("does not advance weekly bookkeeping when consolidation skips after a kill switch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T09:30:00.000Z"));
    const systemSettingSet = vi.fn();
    const cronJobUpsert = vi.fn();
    const runConsolidation = vi.fn(async () => ({
      status: "skipped_kill_switch" as const,
      scannedTurns: 0,
      qualifyingTurns: 0,
      sessionsSampled: 0,
      sessionsFailed: 0,
      drafted: 0,
      deduplicated: 0,
      proposed: 0,
    }));
    const gateway = createGatewayHarness({
      isFeatureEnabled: vi.fn(
        (flag: string) => flag === "memoryConsolidationV1Enabled" || flag === "memoryLifecycleAdminV1Enabled",
      ),
      memoryConsolidationService: {
        runConsolidation,
      },
      storage: {
        cronJobs: {
          get: vi.fn((jobId: string) =>
            jobId === MEMORY_CONSOLIDATION_WEEKLY_JOB_ID
              ? { jobId: MEMORY_CONSOLIDATION_WEEKLY_JOB_ID, enabled: true }
              : undefined,
          ),
          upsert: cronJobUpsert,
        },
        systemSettings: {
          get: vi.fn(() => undefined),
          set: systemSettingSet,
        },
      },
    });

    await (GatewayService.prototype as any).runMemoryConsolidationSchedulerIfDue.call(gateway);

    expect(runConsolidation).toHaveBeenCalledTimes(1);
    expect(systemSettingSet).not.toHaveBeenCalled();
    expect(cronJobUpsert).not.toHaveBeenCalled();
  });
});

describe("GatewayService loop 22 durable and async lifecycle helpers", () => {
  it("delegates durable run-state updates to DurableRunService (body moved in B2)", () => {
    const updateRunState = vi.fn((input: Record<string, unknown>) => ({ ...input, version: 8 }));
    const gateway = createGatewayHarness({
      durableRunService: { updateRunState },
    });

    const input = {
      runId: "run-1",
      status: "completed" as const,
      metadata: { next: true },
      clearLastError: true,
      finishedAt: "2026-05-14T21:30:00.000Z",
    };
    expect(GatewayService.prototype.updateDurableRunState.call(gateway, input)).toMatchObject({
      runId: "run-1",
      status: "completed",
      version: 8,
    });
    expect(updateRunState).toHaveBeenCalledWith(input);
  });

  it("delegates realtime publishing and creates checkpoints with the current git ref", () => {
    const gateway = createGatewayHarness({
      getGitHead: vi.fn(() => "abc123"),
      realtimeEventService: {
        publishRealtime: vi.fn(() => ({ eventId: "event-1" })),
      },
      storage: {
        orchestration: {
          createCheckpoint: vi.fn((input: Record<string, unknown>) => ({ checkpointId: "cp-1", ...input })),
        },
      },
    });

    expect(
      GatewayService.prototype.publishRealtime.call(
        gateway,
        "system",
        "tests",
        { ok: true },
        { eventClass: "operational_signal" },
      ),
    ).toEqual({ eventId: "event-1" });
    expect(gateway.realtimeEventService.publishRealtime).toHaveBeenCalledWith(
      "system",
      "tests",
      { ok: true },
      { eventClass: "operational_signal" },
    );

    expect(
      GatewayService.prototype.createCheckpoint.call(gateway, {
        runId: "run-1",
        phaseId: "phase-1",
        type: "phase_started",
        payload: { ok: true },
      } as never),
    ).toMatchObject({ checkpointId: "cp-1", gitRef: "abc123" });
  });

  it("records approval explanation failures without scheduling invalid or closing requests", async () => {
    const approval = { approvalId: "approval-1" } as ApprovalRequest;
    const gateway = createGatewayHarness({
      approvalExplainer: {
        explainApproval: vi.fn(async () => {
          throw new Error("explain failed");
        }),
      },
      buildApprovalRealtimeLinks: vi.fn(() => ({ approvalId: "approval-1" })),
      publishRealtime: vi.fn(),
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
      },
    });

    gateway.closing = true;
    GatewayService.prototype.scheduleApprovalExplanation.call(gateway, approval);
    GatewayService.prototype.scheduleApprovalExplanationById.call(gateway, "approval-1");
    expect(gateway.approvalExplainer.explainApproval).not.toHaveBeenCalled();

    gateway.closing = false;
    GatewayService.prototype.scheduleApprovalExplanation.call(gateway, { approvalId: "  " } as ApprovalRequest);
    expect(gateway.approvalExplainer.explainApproval).not.toHaveBeenCalled();

    GatewayService.prototype.scheduleApprovalExplanation.call(gateway, approval);
    await Promise.allSettled([...gateway.backgroundTasks]);

    expect(gateway.publishRealtime).toHaveBeenCalledWith(
      "system",
      "approvals",
      expect.objectContaining({
        type: "approval_explainer_error",
        approvalId: "approval-1",
        error: "explain failed",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: { approvalId: "approval-1" },
      }),
    );

    gateway.storage.approvals.get = vi.fn(() => {
      throw new Error("missing");
    });
    GatewayService.prototype.scheduleApprovalExplanationById.call(gateway, "missing");
    expect(gateway.approvalExplainer.explainApproval).toHaveBeenCalledTimes(1);
  });

  it("schedules orchestration memory context and reports context composition failures", async () => {
    const phase = {
      phaseId: "phase-1",
      ownerAgentId: "qa",
      specPath: "plans/phase-1.md",
      loopMode: "fresh-context",
    };
    const plan = {
      goal: "Validate the run",
      waves: [{ waveId: "wave-1", phases: [phase] }],
    } as OrchestrationPlan;
    const run = {
      runId: "run-1",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
    } as OrchestrationRun;
    const composeContext = vi
      .fn()
      .mockResolvedValueOnce({ contextId: "ctx-1", quality: { status: "ready" } })
      .mockRejectedValueOnce(new Error("context offline"));
    const gateway = createGatewayHarness({
      memoryLifecycleService: { composeContext },
      publishRealtime: vi.fn(),
    });

    GatewayService.prototype.scheduleOrchestrationMemoryContext.call(gateway, plan, {
      ...run,
      currentPhaseId: undefined,
    });
    expect(composeContext).not.toHaveBeenCalled();

    GatewayService.prototype.scheduleOrchestrationMemoryContext.call(gateway, plan, run);
    await Promise.allSettled([...gateway.backgroundTasks]);
    expect(composeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "orchestration",
        runId: "run-1",
        phaseId: "phase-1",
        relationScope: "project",
        workspace: "memory",
        forceRefresh: true,
      }),
    );
    expect(gateway.publishRealtime).toHaveBeenCalledWith(
      "memory_qmd_generated",
      "orchestration",
      expect.objectContaining({ runId: "run-1", phaseId: "phase-1", contextId: "ctx-1", status: "ready" }),
      expect.objectContaining({ eventClass: "operational_signal" }),
    );

    GatewayService.prototype.scheduleOrchestrationMemoryContext.call(gateway, plan, run);
    await Promise.allSettled([...gateway.backgroundTasks]);
    expect(gateway.publishRealtime).toHaveBeenLastCalledWith(
      "memory_qmd_failed",
      "orchestration",
      expect.objectContaining({ runId: "run-1", phaseId: "phase-1", error: "context offline" }),
      expect.objectContaining({ eventClass: "operational_signal" }),
    );
  });
});

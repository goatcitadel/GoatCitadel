import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";
import { NotFoundError } from "@goatcitadel/contracts";

function createGatewayHarness() {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  gateway.config = { assistant: { deploymentProfile: "local_dev" } };
  gateway.runtimeDecisionRecorder = { record: vi.fn() };
  return gateway;
}

describe("GatewayService low-hanging facade delegation", () => {
  it("rolls back a policy-context denial when its canonical approval event cannot commit", async () => {
    const gateway = createGatewayHarness();
    let resolutionStatus = "pending";
    let result: Record<string, unknown> | undefined;
    const events: Array<Record<string, unknown>> = [];
    let failEventAppend = true;
    const markResolved = vi.fn((_: string, status: string, nextResult: Record<string, unknown>) => {
      resolutionStatus = status;
      result = nextResult;
    });
    const append = vi.fn((event: Record<string, unknown>) => {
      if (failEventAppend) {
        throw new Error("approval event store unavailable");
      }
      events.push(event);
    });
    const runImmediateTransaction = vi.fn(<T>(work: () => T): T => {
      const previousResolutionStatus = resolutionStatus;
      const previousResult = result;
      const previousEventCount = events.length;
      try {
        return work();
      } catch (error) {
        resolutionStatus = previousResolutionStatus;
        result = previousResult;
        events.splice(previousEventCount);
        throw error;
      }
    });
    gateway.refreshApprovedPendingToolPolicyContext = vi.fn(() => {
      throw new Error("permission profile was revoked");
    });
    gateway.storage = {
      runImmediateTransaction,
      pendingApprovalActions: {
        markResolved,
        find: vi.fn(() => ({ resolutionStatus, result })),
      },
      approvalEvents: { append },
    };

    await expect(
      (GatewayService.prototype as any).executeApprovedPendingAction.call(gateway, "approval-preflight-denied"),
    ).rejects.toThrow("approval event store unavailable");
    expect(resolutionStatus).toBe("pending");
    expect(result).toBeUndefined();
    expect(events).toEqual([]);

    failEventAppend = false;
    await expect(
      (GatewayService.prototype as any).executeApprovedPendingAction.call(gateway, "approval-preflight-denied"),
    ).resolves.toBeUndefined();
    expect(resolutionStatus).toBe("failed");
    expect(result).toEqual({ reason: "permission profile was revoked" });
    expect(events).toEqual([
      expect.objectContaining({
        approvalId: "approval-preflight-denied",
        eventType: "approved_action_executed",
        payload: { outcome: "blocked", reason: "permission profile was revoked" },
      }),
    ]);
    expect(runImmediateTransaction).toHaveBeenCalledTimes(2);
  });

  it("routes approved MCP pending actions through the canonical side-effect executor", async () => {
    const gateway = createGatewayHarness();
    const pending = {
      approvalId: "approval-mcp",
      actionType: "tool.invoke",
      resolutionStatus: "pending",
      createdAt: "2026-05-18T00:00:00.000Z",
      request: {
        toolName: "mcp.invoke",
        args: { serverId: "srv-1", toolName: "tool.echo", arguments: { value: "hello" } },
        agentId: "operator",
        sessionId: "session-1",
        dryRun: true,
      },
    };
    gateway.refreshApprovedPendingToolPolicyContext = vi.fn();
    gateway.storage = {
      pendingApprovalActions: {
        find: vi.fn(() => pending),
      },
    };
    gateway.executeApprovedExternalRuntimePendingAction = vi.fn(async () => ({
      outcome: "executed",
      policyReason: "allowed_via_approval:approval-mcp",
      auditEventId: "audit-1",
      result: { externalRuntime: true, toolName: "mcp.invoke", ok: true },
    }));

    const result = await (GatewayService.prototype as any).executeApprovedPendingAction.call(gateway, "approval-mcp");

    expect(gateway.executeApprovedExternalRuntimePendingAction).toHaveBeenCalledWith(
      "approval-mcp",
      pending,
      undefined,
    );
    expect(result).toMatchObject({
      outcome: "executed",
      result: expect.objectContaining({
        externalRuntime: true,
        toolName: "mcp.invoke",
        ok: true,
      }),
    });
  });

  it.each(["channel.send", "telegram.send", "gmail.send", "calendar.create_event", "http.post", "webhook.send"])(
    "routes approved built-in external mutation %s through the canonical side-effect executor",
    async (toolName) => {
      const gateway = createGatewayHarness();
      const pending = {
        approvalId: `approval-${toolName}`,
        actionType: "tool.invoke",
        resolutionStatus: "pending",
        createdAt: "2026-05-18T00:00:00.000Z",
        request: {
          toolName,
          args: { connectionId: "connection-1", target: "operator", message: "hello" },
          agentId: "operator",
          sessionId: "session-1",
        },
      };
      gateway.refreshApprovedPendingToolPolicyContext = vi.fn();
      gateway.storage = {
        pendingApprovalActions: {
          find: vi.fn(() => pending),
        },
      };
      gateway.executeApprovedExternalRuntimePendingAction = vi.fn(async () => ({
        outcome: "executed",
        policyReason: `allowed_via_approval:${pending.approvalId}`,
        auditEventId: "audit-1",
        result: { status: "sent", providerMessageId: "provider-message-1" },
      }));

      const result = await (GatewayService.prototype as any).executeApprovedPendingAction.call(
        gateway,
        pending.approvalId,
      );

      expect(gateway.executeApprovedExternalRuntimePendingAction).toHaveBeenCalledWith(
        pending.approvalId,
        pending,
        undefined,
      );
      expect(result).toMatchObject({
        outcome: "executed",
        result: { status: "sent", providerMessageId: "provider-message-1" },
      });
    },
  );

  it("uses one deterministic durable child for autonomous delivery retries and create races", () => {
    const gateway = createGatewayHarness();
    const runs = new Map<string, any>();
    let autonomyDisabled = false;
    let connectors = [
      {
        connectorId: "connector-telegram",
        connectorType: "telegram",
        status: "active",
        metadata: { key: "telegram" },
      },
    ];
    gateway.isFeatureEnabled = vi.fn(
      (feature: string) =>
        feature === "durableKernelV1Enabled" || (feature === "autonomyV1Disabled" && autonomyDisabled),
    );
    gateway.listConnectorRecords = vi.fn(() => connectors);
    gateway.storage = {
      chatSessionMeta: { get: vi.fn(() => ({ workspaceId: "workspace-1" })) },
      durableRuns: {
        getRun: vi.fn((runId: string) => {
          const run = runs.get(runId);
          if (!run) throw new NotFoundError({ entity: "Durable run", id: runId });
          return run;
        }),
      },
    };
    const createDurableRun = vi.fn((input: Record<string, any>) => {
      const run = {
        runId: input.runId,
        workflowKey: input.workflowKey,
        status: "queued",
        payload: input.payload,
        metadata: input.metadata,
      };
      runs.set(run.runId, run);
      return run;
    });
    gateway.createDurableRun = createDurableRun;
    const input = {
      runId: "source-run-1",
      sessionId: "session-1",
      assistantText: "Autonomous result",
      deliveryChannel: { channelKey: "telegram", target: "42" },
    };

    expect(GatewayService.prototype.enqueueAutonomousChannelDelivery.call(gateway, input)).toBe(
      "autonomous-delivery:source-run-1",
    );
    expect(GatewayService.prototype.enqueueAutonomousChannelDelivery.call(gateway, input)).toBe(
      "autonomous-delivery:source-run-1",
    );
    expect(createDurableRun).toHaveBeenCalledTimes(1);
    expect(createDurableRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "autonomous-delivery:source-run-1", workflowKey: "connector.delivery" }),
    );

    autonomyDisabled = true;
    connectors = [];
    expect(GatewayService.prototype.enqueueAutonomousChannelDelivery.call(gateway, input)).toBe(
      "autonomous-delivery:source-run-1",
    );
    expect(createDurableRun).toHaveBeenCalledTimes(1);

    runs.clear();
    autonomyDisabled = false;
    connectors = [
      {
        connectorId: "connector-telegram",
        connectorType: "telegram",
        status: "active",
        metadata: { key: "telegram" },
      },
    ];
    createDurableRun.mockImplementationOnce((createInput: Record<string, any>) => {
      runs.set(createInput.runId, {
        runId: createInput.runId,
        workflowKey: createInput.workflowKey,
        status: "queued",
        payload: createInput.payload,
        metadata: createInput.metadata,
      });
      throw new Error("simulated concurrent unique-key winner");
    });
    expect(GatewayService.prototype.enqueueAutonomousChannelDelivery.call(gateway, input)).toBe(
      "autonomous-delivery:source-run-1",
    );
  });

  it("does not rewind a newer Chat branch while retrying silent-heartbeat cleanup", () => {
    const gateway = createGatewayHarness();
    const deleteMessages = vi.fn();
    const deleteTraces = vi.fn();
    const setActiveLeafIfCurrent = vi.fn();
    gateway.storage = {
      runImmediateTransaction: (work: () => unknown) => work(),
      chatSessionBranchState: {
        get: vi.fn(() => ({ activeLeafTurnId: "turn-newer" })),
        setActiveLeafIfCurrent,
        clear: vi.fn(),
      },
      chatMessages: { get: vi.fn(() => ({ content: "silent" })), deleteByMessageIds: deleteMessages },
      chatTurnTraces: { get: vi.fn(() => ({ turnId: "turn-heartbeat" })), deleteByTurnIds: deleteTraces },
    };
    gateway.recordDevDiagnostic = vi.fn();
    gateway.publishRealtime = vi.fn();

    expect(
      GatewayService.prototype.cleanupSilentHeartbeatTurn.call(gateway, {
        sessionId: "session-1",
        turnId: "turn-heartbeat",
        userMessageId: "user-heartbeat",
        assistantMessageId: "assistant-heartbeat",
        parentTurnId: "turn-parent",
      }),
    ).toMatchObject({ status: "manual_reconciliation", reason: expect.stringContaining("turn-newer") });
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteTraces).not.toHaveBeenCalled();
    expect(setActiveLeafIfCurrent).not.toHaveBeenCalled();
  });

  it("treats realtime failure after canonical heartbeat cleanup as committed", () => {
    const gateway = createGatewayHarness();
    const setActiveLeafIfCurrent = vi.fn(() => true);
    gateway.storage = {
      runImmediateTransaction: (work: () => unknown) => work(),
      chatSessionBranchState: {
        get: vi.fn(() => ({ activeLeafTurnId: "turn-heartbeat" })),
        setActiveLeafIfCurrent,
        clear: vi.fn(),
      },
      chatMessages: { get: vi.fn(() => ({ content: "silent" })), deleteByMessageIds: vi.fn() },
      chatTurnTraces: { get: vi.fn(() => ({ turnId: "turn-heartbeat" })), deleteByTurnIds: vi.fn() },
    };
    gateway.recordDevDiagnostic = vi.fn();
    gateway.publishRealtime = vi.fn(() => {
      throw new Error("retained stream unavailable");
    });

    expect(
      GatewayService.prototype.cleanupSilentHeartbeatTurn.call(gateway, {
        sessionId: "session-1",
        turnId: "turn-heartbeat",
        userMessageId: "user-heartbeat",
        assistantMessageId: "assistant-heartbeat",
        parentTurnId: "turn-parent",
      }),
    ).toEqual({ status: "completed" });
    expect(setActiveLeafIfCurrent).toHaveBeenCalledWith(
      "session-1",
      "turn-heartbeat",
      "turn-parent",
      expect.any(String),
    );
    expect(gateway.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.heartbeat.cleanup_projection_failed" }),
    );
  });

  it("treats absent heartbeat artifacts as already cleaned after a newer leaf advances", () => {
    const gateway = createGatewayHarness();
    let activeLeafTurnId: string | undefined = "turn-heartbeat";
    let messagesPresent = true;
    let tracePresent = true;
    const deleteMessages = vi.fn(() => {
      messagesPresent = false;
    });
    const deleteTraces = vi.fn(() => {
      tracePresent = false;
    });
    const setActiveLeafIfCurrent = vi.fn((_: string, expected: string, next: string) => {
      if (activeLeafTurnId !== expected) return false;
      activeLeafTurnId = next;
      return true;
    });
    gateway.storage = {
      runImmediateTransaction: (work: () => unknown) => work(),
      chatSessionBranchState: {
        get: vi.fn(() => (activeLeafTurnId ? { activeLeafTurnId } : undefined)),
        setActiveLeafIfCurrent,
        clear: vi.fn(() => {
          activeLeafTurnId = undefined;
        }),
      },
      chatMessages: {
        get: vi.fn(() => (messagesPresent ? { content: "silent" } : undefined)),
        deleteByMessageIds: deleteMessages,
      },
      chatTurnTraces: {
        get: vi.fn(() => {
          if (!tracePresent) throw new NotFoundError({ entity: "Chat turn trace", id: "turn-heartbeat" });
          return { turnId: "turn-heartbeat" };
        }),
        deleteByTurnIds: deleteTraces,
      },
    };
    gateway.recordDevDiagnostic = vi.fn();
    gateway.publishRealtime = vi.fn();
    const input = {
      sessionId: "session-1",
      turnId: "turn-heartbeat",
      userMessageId: "user-heartbeat",
      assistantMessageId: "assistant-heartbeat",
      parentTurnId: "turn-parent",
    };

    expect(GatewayService.prototype.cleanupSilentHeartbeatTurn.call(gateway, input)).toEqual({ status: "completed" });
    activeLeafTurnId = "turn-newer";
    expect(GatewayService.prototype.cleanupSilentHeartbeatTurn.call(gateway, input)).toEqual({
      status: "already_completed",
    });
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteTraces).toHaveBeenCalledTimes(1);
    expect(setActiveLeafIfCurrent).toHaveBeenCalledTimes(1);
  });

  it("forwards the durable lease owner through the shipped Chat workflow host", () => {
    const gateway = createGatewayHarness();
    gateway.finalizeDurableChatRun = vi.fn();
    const host = (
      GatewayService.prototype as unknown as {
        buildDurableChatTurnWorkflowHost(this: unknown): {
          finalizeDurableChatRun: (...args: unknown[]) => void;
        };
      }
    ).buildDurableChatTurnWorkflowHost.call(gateway);

    host.finalizeDurableChatRun("run-1", {}, {}, "lease-owner-1");

    expect(gateway.finalizeDurableChatRun).toHaveBeenCalledWith("run-1", {}, {}, "lease-owner-1");
  });

  it("delegates dev diagnostics recording and logger attachment", () => {
    const gateway = createGatewayHarness();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    gateway.devDiagnostics = {
      record: vi.fn(),
      setLogger: vi.fn(),
    };

    GatewayService.prototype.recordDevDiagnostic.call(gateway, {
      level: "info",
      category: "gateway",
      event: "facade",
      message: "facade",
    });
    GatewayService.prototype.attachDevDiagnosticsLogger.call(gateway, logger);

    expect(gateway.devDiagnostics.record).toHaveBeenCalledWith({
      level: "info",
      category: "gateway",
      event: "facade",
      message: "facade",
    });
    expect(gateway.devDiagnostics.setLogger).toHaveBeenCalledWith(logger);
  });

  it("delegates guidance, memory, and prompt-pack facade calls", async () => {
    const gateway = createGatewayHarness();
    gateway.storage = {
      sessions: {
        getBySessionId: vi.fn(() => ({ sessionId: "session-1" })),
      },
    };
    gateway.guidanceService = {
      listGlobalGuidance: vi.fn(async () => [{ scope: "global" }]),
      listWorkspaceGuidance: vi.fn(async (workspaceId: string) => [{ workspaceId }]),
      updateGlobalGuidance: vi.fn(async (docType: string, content: string) => ({ docType, content })),
      updateWorkspaceGuidance: vi.fn(async (workspaceId: string, docType: string, content: string) => ({
        workspaceId,
        docType,
        content,
      })),
    };
    gateway.memoryLifecycleService = {
      extractLearnedMemory: vi.fn(),
      listSessionLearnedMemory: vi.fn(() => ({ items: ["memory"], conflicts: [] })),
      updateSessionLearnedMemory: vi.fn((_sessionId: string, itemId: string, input: unknown) => ({ itemId, input })),
      getMaintenanceStatus: vi.fn((workspaceId?: string) => ({ workspaceId, status: "idle" })),
      runMaintenanceNow: vi.fn((input: unknown) => ({ input, status: "completed" })),
    };
    gateway.promptPackService = {
      scorePromptPackLatestRunByCode: vi.fn(async (input: unknown) => ({ input, score: "ok" })),
      runPromptPackFromChat: vi.fn(async (sessionId: string, selector: string) => [{ sessionId, selector }]),
      ensurePromptPackLoaded: vi.fn(async () => ({ packId: "pack-1" })),
    };

    expect(GatewayService.prototype.getSession.call(gateway, "session-1")).toEqual({ sessionId: "session-1" });
    await expect(GatewayService.prototype.listGlobalGuidance.call(gateway)).resolves.toEqual([{ scope: "global" }]);
    await expect(GatewayService.prototype.listWorkspaceGuidance.call(gateway, "workspace-1")).resolves.toEqual([
      { workspaceId: "workspace-1" },
    ]);
    await expect(GatewayService.prototype.updateGlobalGuidance.call(gateway, "agents", "global")).resolves.toEqual({
      docType: "agents",
      content: "global",
    });
    await expect(
      GatewayService.prototype.updateWorkspaceGuidance.call(gateway, "workspace-1", "agents", "workspace"),
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      docType: "agents",
      content: "workspace",
    });

    GatewayService.prototype.extractAndPersistLearnedMemory.call(gateway, "session-1", "remember this", {
      role: "user",
      sourceRef: "message-1",
    });
    expect(gateway.memoryLifecycleService.extractLearnedMemory).toHaveBeenCalledWith("session-1", "remember this", {
      role: "user",
      sourceRef: "message-1",
    });
    expect(GatewayService.prototype.listChatSessionLearnedMemory.call(gateway, "session-1")).toEqual({
      items: ["memory"],
      conflicts: [],
    });
    expect(
      GatewayService.prototype.updateChatSessionLearnedMemory.call(gateway, "session-1", "memory-1", {
        status: "rejected",
      }),
    ).toEqual({ itemId: "memory-1", input: { status: "rejected" } });
    expect(GatewayService.prototype.getMemoryMaintenanceStatus.call(gateway, "workspace-1")).toEqual({
      workspaceId: "workspace-1",
      status: "idle",
    });
    expect(GatewayService.prototype.runMemoryMaintenanceNow.call(gateway, { workspaceId: "workspace-1" })).toEqual({
      input: { workspaceId: "workspace-1" },
      status: "completed",
    });

    await expect(
      GatewayService.prototype.scorePromptPackLatestRunByCode.call(gateway, {
        testCode: "TEST-1",
        routingScore: 1,
        honestyScore: 1,
        handoffScore: 1,
        robustnessScore: 1,
        usabilityScore: 1,
      }),
    ).resolves.toEqual({
      input: {
        testCode: "TEST-1",
        routingScore: 1,
        honestyScore: 1,
        handoffScore: 1,
        robustnessScore: 1,
        usabilityScore: 1,
      },
      score: "ok",
    });
    await expect(GatewayService.prototype.runPromptPackFromChat.call(gateway, "session-1", "pack")).resolves.toEqual([
      { sessionId: "session-1", selector: "pack" },
    ]);
    await expect((GatewayService.prototype as any).ensurePromptPackLoaded.call(gateway)).resolves.toEqual({
      packId: "pack-1",
    });
  });

  it("delegates durable, backup, and database facade calls", async () => {
    const gateway = createGatewayHarness();
    gateway.durableOperatorService = {
      getDiagnostics: vi.fn(() => ({ status: "ok" })),
      listRuns: vi.fn((limit: number) => [{ limit }]),
      listDeadLetters: vi.fn((limit: number) => [{ limit }]),
      listRunCheckpoints: vi.fn((runId: string, limit: number) => [{ runId, limit }]),
      createRun: vi.fn((input: unknown) => ({ input })),
      getRun: vi.fn((runId: string) => ({ runId })),
      listRunTimeline: vi.fn((runId: string, limit: number) => [{ runId, limit }]),
      pauseRun: vi.fn((runId: string, actorId: string) => ({ runId, actorId, action: "pause" })),
      resumeRun: vi.fn((runId: string, actorId: string) => ({ runId, actorId, action: "resume" })),
      cancelRun: vi.fn((runId: string, actorId: string) => ({ runId, actorId, action: "cancel" })),
      retryRun: vi.fn((runId: string, reason: string, actorId: string) => ({ runId, reason, actorId })),
      wakeRun: vi.fn((runId: string, event: unknown) => ({ runId, event })),
      recoverDeadLetter: vi.fn((entryId: string, actorId: string, options: unknown) => ({ entryId, actorId, options })),
    };
    gateway.durableRunService = {
      isDurableFoundationEnabled: vi.fn(() => true),
    };
    gateway.backupRetentionService = {
      listBackups: vi.fn(async (limit: number) => [{ limit }]),
      createBackup: vi.fn(async (input: unknown) => ({ input })),
      verifyBackup: vi.fn(async (input: unknown) => ({ input, valid: true })),
      getRetentionPolicy: vi.fn(() => ({ keepDaily: 7 })),
      updateRetentionPolicy: vi.fn((input: unknown) => ({ input })),
      pruneRetention: vi.fn(async (options: unknown) => ({ options })),
    };
    gateway.databaseCutoverService = {
      runCutover: vi.fn(async (input: unknown) => ({ input, cutover: true })),
      verify: vi.fn(async (input: unknown) => ({ input, verified: true })),
    };

    expect(GatewayService.prototype.getDurableDiagnostics.call(gateway)).toEqual({ status: "ok" });
    expect(GatewayService.prototype.listDurableRuns.call(gateway)).toEqual([{ limit: 50 }]);
    expect(GatewayService.prototype.listDurableDeadLetters.call(gateway, 5)).toEqual([{ limit: 5 }]);
    expect(GatewayService.prototype.listDurableRunCheckpoints.call(gateway, "run-1")).toEqual([
      { runId: "run-1", limit: 200 },
    ]);
    expect(GatewayService.prototype.createDurableRun.call(gateway, { workflow: "chat" })).toEqual({
      input: { workflow: "chat" },
    });
    expect(GatewayService.prototype.getDurableRun.call(gateway, "run-1")).toEqual({ runId: "run-1" });
    expect(GatewayService.prototype.listDurableRunTimeline.call(gateway, "run-1")).toEqual([
      { runId: "run-1", limit: 300 },
    ]);
    expect(GatewayService.prototype.pauseDurableRun.call(gateway, "run-1")).toEqual({
      runId: "run-1",
      actorId: "operator",
      action: "pause",
    });
    expect(GatewayService.prototype.resumeDurableRun.call(gateway, "run-1", "tester")).toEqual({
      runId: "run-1",
      actorId: "tester",
      action: "resume",
    });
    expect(GatewayService.prototype.cancelDurableRun.call(gateway, "run-1")).toEqual({
      runId: "run-1",
      actorId: "operator",
      action: "cancel",
    });
    expect(GatewayService.prototype.retryDurableRun.call(gateway, "run-1")).toEqual({
      runId: "run-1",
      reason: "manual_retry",
      actorId: "operator",
    });
    expect(GatewayService.prototype.wakeDurableRun.call(gateway, "run-1", { eventKey: "manual" })).toEqual({
      runId: "run-1",
      event: { eventKey: "manual" },
    });
    expect(
      GatewayService.prototype.recoverDurableDeadLetter.call(gateway, "dead-1", "tester", { maxAttempts: 2 }),
    ).toEqual({
      entryId: "dead-1",
      actorId: "tester",
      options: { maxAttempts: 2 },
    });
    expect((GatewayService.prototype as any).isDurableFoundationEnabled.call(gateway)).toBe(true);

    await expect(GatewayService.prototype.listBackups.call(gateway)).resolves.toEqual([{ limit: 50 }]);
    await expect(GatewayService.prototype.createBackup.call(gateway, { name: "manual" })).resolves.toEqual({
      input: { name: "manual" },
    });
    await expect(GatewayService.prototype.verifyBackup.call(gateway, { filePath: "backup.zip" })).resolves.toEqual({
      input: { filePath: "backup.zip" },
      valid: true,
    });
    expect(GatewayService.prototype.getRetentionPolicy.call(gateway)).toEqual({ keepDaily: 7 });
    expect(GatewayService.prototype.updateRetentionPolicy.call(gateway, { keepDaily: 3 })).toEqual({
      input: { keepDaily: 3 },
    });
    await expect(GatewayService.prototype.pruneRetention.call(gateway)).resolves.toEqual({ options: {} });
    await expect(
      GatewayService.prototype.runDatabaseCutover.call(gateway, { profile: "sqlite", execute: false }),
    ).resolves.toEqual({
      input: { profile: "sqlite", execute: false },
      cutover: true,
    });
    await expect(GatewayService.prototype.verifyDatabaseCutover.call(gateway, { source: "sqlite" })).resolves.toEqual({
      input: { source: "sqlite" },
      verified: true,
    });
  });

  it("delegates tool access and approval runtime facades", async () => {
    const gateway = createGatewayHarness();
    gateway.policyEngine = {
      listCatalog: vi.fn(() => [{ toolName: "browser.search" }]),
      evaluateAccess: vi.fn((input: unknown) => ({ input, allowed: true })),
    };
    gateway.storage = {
      chatSessionMeta: {
        get: vi.fn(() => ({ workspaceId: "workspace-meta" })),
      },
      permissionProfiles: {
        resolveContext: vi.fn(() => ({ permissionProfile: { profileId: "safe" } })),
      },
    };
    gateway.approvalRuntime = {
      listToolGrants: vi.fn((scope: string, scopeRef: string, limit: number) => [{ scope, scopeRef, limit }]),
      createToolGrant: vi.fn((input: unknown) => ({ input, grantId: "grant-1" })),
      revokeToolGrant: vi.fn((grantId: string) => grantId === "grant-1"),
      createApproval: vi.fn(async (input: unknown) => ({ input, approvalId: "approval-1" })),
      createApprovalRemoteActionToken: vi.fn((approvalId: string, input: unknown) => ({ approvalId, input })),
      resolveApprovalWithRemoteToken: vi.fn(async (input: unknown) => ({ input, source: "token" })),
      resolveApprovalWithRemoteTokenId: vi.fn(async (input: unknown) => ({ input, source: "token-id" })),
      listApprovals: vi.fn((status: string, limit: number) => [{ status, limit }]),
      resolveApprovalsBulk: vi.fn(async (input: unknown) => ({ input, resolved: 2 })),
      getApprovalReplay: vi.fn((approvalId: string, replayedBy: string) => ({ approvalId, replayedBy })),
      resolveApproval: vi.fn(async (approvalId: string, input: unknown) => ({ approvalId, input })),
      resolveChatToolApproval: vi.fn(
        async (sessionId: string, approvalId: string, decision: string, options: unknown) => ({
          sessionId,
          approvalId,
          decision,
          options,
        }),
      ),
    };
    gateway.chatProactiveService = {
      findDurableRunIdsForApproval: vi.fn((approvalId: string) => [`durable:${approvalId}`]),
    };
    gateway.approvalWaitRunService = {
      ensureApprovalWaitDurableRun: vi.fn((approval: unknown) => ({ approval })),
      buildApprovalLinkage: vi.fn((linkage: unknown) => ({ linkage })),
      buildApprovalRealtimeLinks: vi.fn((approval: { approvalId: string }) => ({ approvalId: approval.approvalId })),
      primeApprovalLifecycle: vi.fn((approvalId: string, linkage: unknown) => ({ approvalId, linkage })),
    };
    gateway.approvalEffectsService = {
      enqueueResolutionEffects: vi.fn((approval: unknown, input: unknown) => [{ approval, input }]),
    };

    expect(GatewayService.prototype.listToolCatalog.call(gateway)).toEqual([{ toolName: "browser.search" }]);
    expect(
      GatewayService.prototype.evaluateToolAccess.call(gateway, {
        toolName: "browser.search",
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      input: {
        toolName: "browser.search",
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "workspace-meta",
        policyContext: expect.objectContaining({ permissionProfileId: "safe" }),
      },
      allowed: true,
    });
    expect(gateway.storage.chatSessionMeta.get).toHaveBeenCalledWith("session-1");
    expect(
      GatewayService.prototype.evaluateToolAccess.call(gateway, {
        toolName: "browser.search",
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "workspace-explicit",
      }),
    ).toEqual({
      input: {
        toolName: "browser.search",
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "workspace-explicit",
        policyContext: expect.objectContaining({ permissionProfileId: "safe" }),
      },
      allowed: true,
    });

    expect(GatewayService.prototype.listToolGrants.call(gateway, "session", "session-1", 10)).toEqual([
      { scope: "session", scopeRef: "session-1", limit: 10 },
    ]);
    expect(
      GatewayService.prototype.createToolGrant.call(gateway, {
        toolPattern: "browser.*",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        createdBy: "tester",
      }),
    ).toEqual({
      input: {
        toolPattern: "browser.*",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        createdBy: "tester",
      },
      grantId: "grant-1",
    });
    expect(GatewayService.prototype.revokeToolGrant.call(gateway, "grant-1", "tester")).toBe(true);

    await expect(
      GatewayService.prototype.createApproval.call(gateway, {
        kind: "tool",
        riskLevel: "medium",
        payload: { toolName: "browser.search" },
        preview: { summary: "Search the web" },
      }),
    ).resolves.toEqual({
      input: {
        kind: "tool",
        riskLevel: "medium",
        payload: { toolName: "browser.search" },
        preview: { summary: "Search the web" },
      },
      approvalId: "approval-1",
    });
    expect(
      GatewayService.prototype.createApprovalRemoteActionToken.call(gateway, "approval-1", {
        connectorId: "connector-1",
        issuedBy: "tester",
      }),
    ).toEqual({
      approvalId: "approval-1",
      input: { connectorId: "connector-1", issuedBy: "tester" },
    });
    await expect(
      GatewayService.prototype.resolveApprovalWithRemoteToken.call(gateway, {
        token: "token",
        connectorId: "browser:mission-control",
        decision: "approve",
        resolvedBy: "tester",
      }),
    ).resolves.toEqual({
      input: {
        token: "token",
        connectorId: "browser:mission-control",
        decision: "approve",
        resolvedBy: "tester",
      },
      source: "token",
    });
    await expect(
      GatewayService.prototype.resolveApprovalWithRemoteTokenId.call(gateway, {
        tokenId: "token-id",
        connectorId: "mcp:srv-1",
        decision: "reject",
        resolvedBy: "tester",
      }),
    ).resolves.toEqual({
      input: {
        tokenId: "token-id",
        connectorId: "mcp:srv-1",
        decision: "reject",
        resolvedBy: "tester",
      },
      source: "token-id",
    });
    expect(GatewayService.prototype.listApprovals.call(gateway, "pending", 3)).toEqual([
      { status: "pending", limit: 3 },
    ]);
    await expect(
      GatewayService.prototype.resolveApprovalsBulk.call(gateway, {
        decision: "approve",
        resolvedBy: "tester",
      }),
    ).resolves.toEqual({
      input: { decision: "approve", resolvedBy: "tester" },
      resolved: 2,
    });
    expect(GatewayService.prototype.getApprovalReplay.call(gateway, "approval-1")).toEqual({
      approvalId: "approval-1",
      replayedBy: "operator",
    });
    await expect(
      GatewayService.prototype.resolveApproval.call(gateway, "approval-1", {
        decision: "approve",
        resolvedBy: "tester",
      }),
    ).resolves.toEqual({
      approvalId: "approval-1",
      input: { decision: "approve", resolvedBy: "tester" },
    });
    await expect(
      GatewayService.prototype.resolveChatToolApproval.call(gateway, "session-1", "approval-1", "approve", {
        resolvedBy: "tester",
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      approvalId: "approval-1",
      decision: "approve",
      options: { resolvedBy: "tester" },
    });

    expect(GatewayService.prototype.findProactiveDurableRunIdsForApproval.call(gateway, "approval-1")).toEqual([
      "durable:approval-1",
    ]);
    expect(GatewayService.prototype.ensureApprovalWaitDurableRun.call(gateway, { approvalId: "approval-1" })).toEqual({
      approval: { approvalId: "approval-1" },
    });
    expect(GatewayService.prototype.buildApprovalLinkage.call(gateway, { runId: "run-1" })).toEqual({
      linkage: { runId: "run-1" },
    });
    expect(GatewayService.prototype.buildApprovalRealtimeLinks.call(gateway, { approvalId: "approval-1" })).toEqual({
      approvalId: "approval-1",
    });
    expect(
      GatewayService.prototype.enqueueApprovalResolutionEffects.call(
        gateway,
        { approvalId: "approval-1" },
        { decision: "approve", resolvedBy: "tester" },
      ),
    ).toEqual([
      {
        approval: { approvalId: "approval-1" },
        input: { decision: "approve", resolvedBy: "tester" },
      },
    ]);
    expect(GatewayService.prototype.primeApprovalLifecycle.call(gateway, "approval-1", { runId: "run-1" })).toEqual({
      approvalId: "approval-1",
      linkage: { runId: "run-1" },
    });
  });

  it("reconciles custom permission profile default surfaces into activations", () => {
    const gateway = createGatewayHarness();
    const baseProfile = {
      profileId: "profile-review",
      label: "Review",
      builtin: false,
      status: "active",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status"],
      allow: [],
      deny: [],
      defaultForSurfaces: ["code", "cowork"],
      createdBy: "operator-a",
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    const deactivateProfileActivations = vi.fn(() => 0);
    const activateProfile = vi.fn((input: unknown) => ({ activationId: "activation-1", ...input }));
    gateway.storage = {
      gatewaySql: { runImmediateTransaction: vi.fn((operation: () => unknown) => operation()) },
      permissionProfiles: {
        createProfile: vi.fn(() => baseProfile),
        getProfile: vi.fn(() => baseProfile),
        updateProfile: vi.fn(() => ({
          ...baseProfile,
          defaultForSurfaces: ["chat"],
          updatedAt: "2026-05-17T00:10:00.000Z",
        })),
        deactivateProfileActivations,
        activateProfile,
      },
    };
    gateway.publishRealtime = vi.fn();

    GatewayService.prototype.createPermissionProfile.call(gateway, {
      label: "Review",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      defaultForSurfaces: ["code", "cowork"],
      createdBy: "operator-a",
    });

    expect(deactivateProfileActivations).toHaveBeenCalledWith({
      profileId: "profile-review",
      operatorId: undefined,
      workspaceId: "workspace-a",
    });
    expect(activateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-review", operatorId: undefined, surface: "code" }),
    );
    expect(activateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-review", operatorId: undefined, surface: "cowork" }),
    );

    activateProfile.mockClear();
    GatewayService.prototype.updatePermissionProfile.call(gateway, "profile-review", {
      updatedBy: "operator-a",
      defaultForSurfaces: ["chat"],
    });
    expect(activateProfile).toHaveBeenCalledTimes(1);
    expect(activateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-review", operatorId: undefined, surface: "chat" }),
    );
  });

  it("resolves custom permission profile defaults after create and update", () => {
    const gateway = createGatewayHarness();
    const fallbackProfile = {
      profileId: "safe",
      label: "Safe",
      builtin: true,
      status: "active",
      scope: "global",
      approvalMode: "approve_all",
      toolPatterns: ["*"],
      createdBy: "system",
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    let profile = {
      profileId: "profile-review",
      label: "Review",
      builtin: false,
      status: "active",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status"],
      allow: [],
      deny: [],
      defaultForSurfaces: ["code", "cowork"],
      createdBy: "operator-a",
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    const activeSurfaces = new Set<string>();
    gateway.storage = {
      gatewaySql: { runImmediateTransaction: vi.fn((operation: () => unknown) => operation()) },
      permissionProfiles: {
        createProfile: vi.fn(() => profile),
        getProfile: vi.fn(() => profile),
        updateProfile: vi.fn((_profileId: string, input: { defaultForSurfaces?: string[] }) => {
          profile = {
            ...profile,
            defaultForSurfaces: input.defaultForSurfaces ?? profile.defaultForSurfaces,
            updatedAt: "2026-05-17T00:10:00.000Z",
          };
          return profile;
        }),
        deactivateProfileActivations: vi.fn(() => {
          activeSurfaces.clear();
          return 0;
        }),
        activateProfile: vi.fn((input: { surface?: string }) => {
          if (input.surface) {
            activeSurfaces.add(input.surface);
          }
          return { activationId: `activation-${input.surface}`, ...input };
        }),
        resolveContext: vi.fn((input: { surface?: string }) => ({
          permissionProfile: input.surface && activeSurfaces.has(input.surface) ? profile : fallbackProfile,
        })),
      },
    };
    gateway.publishRealtime = vi.fn();

    GatewayService.prototype.createPermissionProfile.call(gateway, {
      label: "Review",
      scope: "workspace",
      scopeRef: "workspace-a",
      approvalMode: "approve_risky",
      defaultForSurfaces: ["code", "cowork"],
      createdBy: "operator-a",
    });
    expect(
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        surface: "code",
      }).permissionProfileId,
    ).toBe("profile-review");
    expect(
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        surface: "chat",
      }).permissionProfileId,
    ).toBe("safe");

    GatewayService.prototype.updatePermissionProfile.call(gateway, "profile-review", {
      updatedBy: "operator-a",
      defaultForSurfaces: ["chat"],
    });
    expect(
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        surface: "code",
      }).permissionProfileId,
    ).toBe("safe");
    expect(
      GatewayService.prototype.resolveToolPolicyContext.call(gateway, {
        operatorId: "operator-a",
        workspaceId: "workspace-a",
        surface: "chat",
      }).permissionProfileId,
    ).toBe("profile-review");
  });

  it("classifies tool configuration projection failures as committed mutations", () => {
    const gateway = createGatewayHarness();
    const profile = {
      profileId: "profile-review",
      label: "Review",
      builtin: false,
      status: "active",
      scope: "operator",
      scopeRef: "operator-a",
      approvalMode: "approve_risky",
      toolPatterns: ["session.status"],
      allow: [],
      deny: [],
      defaultForSurfaces: [],
      createdBy: "operator-a",
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    const override = {
      overrideId: "override-a",
      operatorId: "operator-a",
      scope: "operator",
      reason: "local review",
      status: "revoked",
      createdBy: "operator-a",
      createdAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2026-05-17T00:05:00.000Z",
      revokedAt: "2026-05-17T00:01:00.000Z",
      revokedBy: "operator-a",
    };
    gateway.storage = {
      gatewaySql: { runImmediateTransaction: vi.fn((operation: () => unknown) => operation()) },
      permissionProfiles: {
        createProfile: vi.fn(() => profile),
        getProfile: vi.fn(() => profile),
        updateProfile: vi.fn(() => profile),
        archiveProfile: vi.fn(() => true),
        activateProfile: vi.fn(() => ({
          activationId: "activation-a",
          profileId: profile.profileId,
          operatorId: "operator-a",
          surface: "chat",
        })),
        createLocalOperatorOverride: vi.fn(() => override),
        getLocalOperatorOverride: vi.fn(() => override),
        revokeLocalOperatorOverride: vi.fn(() => true),
      },
    };
    gateway.publishRealtime = vi.fn(() => {
      throw new Error("realtime projection unavailable");
    });

    const mutations = [
      () =>
        GatewayService.prototype.createPermissionProfile.call(gateway, {
          label: "Review",
          scope: "operator",
          approvalMode: "approve_risky",
          createdBy: "operator-a",
        }),
      () =>
        GatewayService.prototype.updatePermissionProfile.call(gateway, profile.profileId, {
          updatedBy: "operator-a",
          label: "Updated",
        }),
      () => GatewayService.prototype.archivePermissionProfile.call(gateway, profile.profileId, "operator-a"),
      () =>
        GatewayService.prototype.activatePermissionProfile.call(gateway, {
          profileId: profile.profileId,
          operatorId: "operator-a",
          surface: "chat",
          createdBy: "operator-a",
        }),
      () =>
        GatewayService.prototype.createLocalOperatorOverride.call(gateway, {
          operatorId: "operator-a",
          scope: "operator",
          reason: "local review",
          ttlSeconds: 300,
          createdBy: "operator-a",
        }),
      () => GatewayService.prototype.revokeLocalOperatorOverride.call(gateway, override.overrideId, "operator-a"),
    ];

    expect(mutations.map((mutate) => mutate())).toEqual([
      profile,
      profile,
      true,
      expect.objectContaining({ activationId: "activation-a" }),
      override,
      override,
    ]);
    expect(gateway.publishRealtime).toHaveBeenCalledTimes(6);
  });

  it("rejects bypass permission profile mutation and activation in remote hardened mode", () => {
    const gateway = createGatewayHarness();
    gateway.publishRealtime = vi.fn();
    gateway.config.assistant.deploymentProfile = "remote_hardened";
    const safeProfile = {
      profileId: "profile-safe",
      label: "Safe custom",
      builtin: false,
      status: "active",
      scope: "operator",
      scopeRef: "operator-a",
      approvalMode: "approve_all",
      toolPatterns: ["session.status"],
      createdBy: "operator-a",
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    const bypassProfile = {
      ...safeProfile,
      profileId: "profile-bypass",
      approvalMode: "bypass",
    };
    const createProfile = vi.fn(() => bypassProfile);
    const updateProfile = vi.fn((profileId: string, input: Record<string, unknown>) => ({
      ...(profileId === "profile-bypass" ? bypassProfile : safeProfile),
      ...input,
      profileId,
    }));
    const activateProfile = vi.fn(() => ({ activationId: "activation-1" }));
    gateway.storage = {
      gatewaySql: { runImmediateTransaction: vi.fn((operation: () => unknown) => operation()) },
      chatSessionMeta: {
        get: vi.fn(() => ({ workspaceId: "workspace-a" })),
      },
      permissionProfiles: {
        createProfile,
        getProfile: vi.fn((profileId: string) => (profileId === "profile-bypass" ? bypassProfile : safeProfile)),
        updateProfile,
        activateProfile,
      },
    };

    expect(() =>
      GatewayService.prototype.createPermissionProfile.call(gateway, {
        label: "Bypass",
        scope: "operator",
        approvalMode: "bypass",
        createdBy: "operator-a",
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
    expect(createProfile).not.toHaveBeenCalled();

    expect(() =>
      GatewayService.prototype.updatePermissionProfile.call(gateway, "profile-safe", {
        updatedBy: "operator-a",
        approvalMode: "bypass",
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
    expect(updateProfile).not.toHaveBeenCalled();

    expect(() =>
      GatewayService.prototype.updatePermissionProfile.call(gateway, "profile-bypass", {
        updatedBy: "operator-a",
        label: "Still bypass",
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
    expect(updateProfile).not.toHaveBeenCalled();

    expect(
      GatewayService.prototype.updatePermissionProfile.call(gateway, "profile-bypass", {
        updatedBy: "operator-a",
        approvalMode: "approve_risky",
      }),
    ).toMatchObject({
      profileId: "profile-bypass",
      approvalMode: "approve_risky",
    });
    expect(updateProfile).toHaveBeenCalledTimes(1);

    expect(() =>
      GatewayService.prototype.activatePermissionProfile.call(gateway, {
        profileId: "profile-bypass",
        operatorId: "operator-a",
        createdBy: "operator-a",
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
    expect(activateProfile).not.toHaveBeenCalled();

    const resolvedBypassContext = {
      permissionProfileId: "profile-bypass",
      permissionProfile: bypassProfile,
      approvedCodeModeRunId: "code-run-1",
    };
    expect(() =>
      (
        GatewayService.prototype as unknown as {
          enrichToolPolicyContext: (input: unknown) => unknown;
        }
      ).enrichToolPolicyContext.call(gateway, {
        toolName: "fs.write",
        args: {},
        agentId: "agent",
        sessionId: "session-1",
        policyContext: resolvedBypassContext,
      }),
    ).toThrow(/Bypass permission profiles are unavailable/);
    expect(() =>
      (
        GatewayService.prototype as unknown as {
          enrichMcpInvokePolicyContext: (input: unknown) => unknown;
        }
      ).enrichMcpInvokePolicyContext.call(gateway, {
        serverId: "mcp-1",
        toolName: "tool",
        args: {},
        sessionId: "session-1",
        policyContext: {
          permissionProfileId: "profile-safe",
          permissionProfile: safeProfile,
          localOperatorOverrideId: "override-1",
        },
      }),
    ).toThrow(/Local Operator Override is unavailable/);
  });

  it("queues channel sends and merges persisted and runtime delivery status", async () => {
    const gateway = createGatewayHarness();
    gateway.storage = {
      integrationConnections: {
        get: vi.fn(() => ({ key: "discord" })),
      },
      commsDeliveries: {
        list: vi.fn(() => [
          {
            deliveryId: "persisted-stale",
            connectionId: "conn-1",
            channelKey: "discord",
            target: "room-a",
            status: "queued",
            deliveryStatus: "retrying",
            idempotencyKey: "idempotent-stale",
            payloadHash: "hash-stale",
            attempts: 2,
            maxAttempts: 3,
            nextAttemptAt: "2026-05-15T00:00:03.000Z",
            staleReason: "expired",
            createdAt: "2026-05-15T00:00:00.000Z",
            updatedAt: "2026-05-15T00:00:01.000Z",
          },
          {
            deliveryId: "persisted-sent",
            connectionId: "conn-1",
            channelKey: "discord",
            target: "room-b",
            status: "sent",
            deliveryStatus: "sent",
            attempts: 1,
            maxAttempts: 3,
            providerMessageId: "provider-1",
            createdAt: "2026-05-15T00:00:00.000Z",
            updatedAt: "2026-05-15T00:00:02.000Z",
          },
          {
            deliveryId: "runtime-overlap",
            connectionId: "conn-1",
            channelKey: "discord",
            target: "room-c",
            status: "failed",
            deliveryStatus: "failed",
            attempts: 3,
            maxAttempts: 3,
            error: "persisted failure",
            createdAt: "2026-05-15T00:00:00.000Z",
            updatedAt: "2026-05-15T00:00:03.000Z",
          },
        ]),
      },
    };
    gateway.channelDeliveryRuntimeService = {
      enqueue: vi.fn((input: unknown) => ({
        ...(input as Record<string, unknown>),
        deliveryId: "queued-1",
        status: "queued",
        deliveryStatus: "retrying",
        attempts: 0,
        maxAttempts: 3,
        createdAt: "2026-05-15T00:00:04.000Z",
        updatedAt: "2026-05-15T00:00:04.000Z",
        nextAttemptAt: "2026-05-15T00:00:05.000Z",
      })),
      list: vi.fn(() => [
        {
          deliveryId: "runtime-overlap",
          connectionId: "conn-1",
          channelKey: "discord",
          target: "room-c",
          status: "retrying",
          deliveryStatus: "retrying",
          attempts: 4,
          maxAttempts: 5,
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:06.000Z",
        },
      ]),
      drainDue: vi.fn(async (limit: number) => [{ deliveryId: `drained:${limit}` }]),
    };
    gateway.scheduleChannelDeliveryDrain = vi.fn();

    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        target: "room-a",
        message: "hello",
        effectId: "effect-1",
      }),
    ).resolves.toEqual({
      deliveryId: "queued-1",
      status: "queued",
      deliveryStatus: "retrying",
      channelKey: "discord",
      target: "room-a",
      createdAt: "2026-05-15T00:00:04.000Z",
      updatedAt: "2026-05-15T00:00:04.000Z",
      nextAttemptAt: "2026-05-15T00:00:05.000Z",
    });
    expect(gateway.channelDeliveryRuntimeService.enqueue).toHaveBeenCalledWith({
      connectionId: "conn-1",
      channelKey: "discord",
      target: "room-a",
      payload: {
        connectionId: "conn-1",
        target: "room-a",
        message: "hello",
        attachments: undefined,
        attachmentIds: undefined,
        interactiveActions: undefined,
        replyToMessageId: undefined,
        replyToPartIndex: undefined,
        effectId: "effect-1",
        subject: undefined,
        sessionId: undefined,
        agentId: undefined,
        taskId: undefined,
      },
      idempotencyKey: "channel-delivery:effect:effect-1",
    });
    expect(gateway.scheduleChannelDeliveryDrain).toHaveBeenCalledTimes(1);
    await expect(
      GatewayService.prototype.commsReply.call(gateway, {
        connectionId: "conn-1",
        target: "room-a",
        message: "reply",
        replyToMessageId: "  ",
      }),
    ).rejects.toThrow("replyToMessageId is required for channel replies.");
    await expect(GatewayService.prototype.drainDueChannelDeliveries.call(gateway, 7)).resolves.toEqual([
      { deliveryId: "drained:7" },
    ]);

    expect(GatewayService.prototype.listChannelDeliveryRuntime.call(gateway)).toEqual([
      {
        deliveryId: "runtime-overlap",
        connectionId: "conn-1",
        channelKey: "discord",
        target: "room-c",
        status: "retrying",
        deliveryStatus: "retrying",
        attempts: 4,
        maxAttempts: 5,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:06.000Z",
      },
      {
        deliveryId: "persisted-sent",
        connectionId: "conn-1",
        channelKey: "discord",
        target: "room-b",
        status: "sent",
        deliveryStatus: "sent",
        idempotencyKey: undefined,
        payloadHash: undefined,
        attempts: 1,
        maxAttempts: 3,
        nextAttemptAt: undefined,
        staleReason: undefined,
        providerMessageId: "provider-1",
        error: undefined,
        fallbackReason: undefined,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:02.000Z",
      },
      {
        deliveryId: "persisted-stale",
        connectionId: "conn-1",
        channelKey: "discord",
        target: "room-a",
        status: "stale",
        deliveryStatus: "retrying",
        idempotencyKey: "idempotent-stale",
        payloadHash: "hash-stale",
        attempts: 2,
        maxAttempts: 3,
        nextAttemptAt: "2026-05-15T00:00:03.000Z",
        staleReason: "expired",
        providerMessageId: undefined,
        error: undefined,
        fallbackReason: undefined,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:01.000Z",
      },
    ]);
  });

  it("records Discord runtime sync failures and resolves connection secrets", async () => {
    const gateway = createGatewayHarness();
    gateway.discordRuntimeService = {
      sync: vi.fn(async () => undefined),
    };
    gateway.devDiagnostics = {
      record: vi.fn(),
    };

    await GatewayService.prototype.syncDiscordRuntime.call(gateway);
    expect(gateway.discordRuntimeService.sync).toHaveBeenCalledTimes(1);
    expect(gateway.devDiagnostics.record).not.toHaveBeenCalled();

    gateway.discordRuntimeService.sync.mockRejectedValueOnce(new Error("token invalid"));
    await GatewayService.prototype.syncDiscordRuntime.call(gateway);
    expect(gateway.devDiagnostics.record).toHaveBeenCalledWith({
      level: "warn",
      category: "channels",
      event: "discord.runtime.sync_failed",
      message: "Discord runtime sync failed.",
      context: {
        error: "token invalid",
      },
    });

    const originalSecret = process.env.LOOP35_GATEWAY_SECRET;
    process.env.LOOP35_GATEWAY_SECRET = "from-env";
    try {
      expect(
        GatewayService.prototype.readConnectionConfigValue.call(gateway, { token: "  direct-token  " }, "token"),
      ).toBe("direct-token");
      expect(
        GatewayService.prototype.readConnectionConfigValue.call(gateway, { token: "   " }, "token"),
      ).toBeUndefined();
      expect(
        GatewayService.prototype.resolveConnectionSecret.call(
          gateway,
          { direct: " inline ", envName: "LOOP35_GATEWAY_SECRET" },
          "direct",
          "envName",
        ),
      ).toBe("inline");
      expect(
        GatewayService.prototype.resolveConnectionSecret.call(
          gateway,
          { envName: "LOOP35_GATEWAY_SECRET" },
          "direct",
          "envName",
        ),
      ).toBe("from-env");
      expect(
        GatewayService.prototype.resolveConnectionSecret.call(gateway, { envName: "   " }, "direct", "envName"),
      ).toBeUndefined();
    } finally {
      if (originalSecret === undefined) {
        delete process.env.LOOP35_GATEWAY_SECRET;
      } else {
        process.env.LOOP35_GATEWAY_SECRET = originalSecret;
      }
    }
  });

  it("handles integration replies with existing chat messages and channel delivery", async () => {
    const gateway = createGatewayHarness();
    gateway.withChatTurnWriteLease = vi.fn(
      async (_sessionId: string, _operation: string, work: () => Promise<unknown>) => work(),
    );
    gateway.ensureChatMessageProjection = vi.fn(async () => undefined);
    gateway.prepareAgentChatTurn = vi.fn(async (_sessionId: string, request: unknown, options: unknown) => ({
      request,
      options,
      userEventId: "event-user-1",
      turnId: "turn-1",
    }));
    gateway.consumePreparedAgentChatTurn = vi.fn(async (_sessionId: string, _request: unknown, prepared: unknown) => ({
      turnId: "turn-1",
      prepared,
      assistantMessage: {
        content: "  reply from assistant  ",
      },
    }));
    gateway.ensureSessionInternalToolGrant = vi.fn();
    gateway.requireExecutedToolResult = vi.fn();
    gateway.commsSend = vi.fn(async (input: unknown) => ({ outcome: "executed", result: input }));
    gateway.storage = {
      chatMessages: {
        get: vi.fn(() => ({
          messageId: "message-user-1",
          sessionId: "session-1",
          role: "user",
          content: "original user prompt",
        })),
      },
      chatSessionBindings: {
        get: vi.fn(() => ({
          transport: "integration",
          connectionId: "discord-1",
          target: "room-1",
          writable: true,
        })),
      },
    };

    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "message-user-1", {
        providerId: "openai",
        deliveryReplyToMessageId: "  provider-msg-1  ",
        channelSystemInstruction: "Keep the reply concise.",
      }),
    ).resolves.toMatchObject({
      transport: "integration",
      assistantMessage: {
        content: "  reply from assistant  ",
      },
    });

    expect(gateway.withChatTurnWriteLease).toHaveBeenCalledWith("session-1", "integration-reply", expect.any(Function));
    expect(gateway.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      {
        content: "original user prompt",
        providerId: "openai",
      },
      {
        branchKind: "append",
        existingUserMessage: {
          messageId: "message-user-1",
          sessionId: "session-1",
          role: "user",
          content: "original user prompt",
        },
        ingestUserMessage: false,
        extraSystemInstruction: "Keep the reply concise.",
      },
    );
    expect(gateway.ensureSessionInternalToolGrant).toHaveBeenCalledWith(
      "session-1",
      "channel.send",
      "system-integration-reply",
    );
    expect(gateway.commsSend).toHaveBeenCalledWith({
      connectionId: "discord-1",
      target: "room-1",
      message: "reply from assistant",
      replyToMessageId: "provider-msg-1",
      sessionId: "session-1",
      agentId: "assistant",
    });
    expect(gateway.requireExecutedToolResult).toHaveBeenCalledWith("channel.send", {
      outcome: "executed",
      result: {
        connectionId: "discord-1",
        target: "room-1",
        message: "reply from assistant",
        replyToMessageId: "provider-msg-1",
        sessionId: "session-1",
        agentId: "assistant",
      },
    });

    gateway.consumePreparedAgentChatTurn.mockResolvedValueOnce({
      turnId: "turn-blank",
      assistantMessage: {
        content: "   ",
      },
    });
    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "message-user-1"),
    ).resolves.toMatchObject({
      transport: "integration",
      assistantMessage: {
        content: "   ",
      },
    });
    expect(gateway.commsSend).toHaveBeenCalledTimes(1);
  });

  it("rejects integration replies when source message or writable binding is missing", async () => {
    const gateway = createGatewayHarness();
    gateway.withChatTurnWriteLease = vi.fn(
      async (_sessionId: string, _operation: string, work: () => Promise<unknown>) => work(),
    );
    gateway.ensureChatMessageProjection = vi.fn(async () => undefined);
    gateway.storage = {
      chatMessages: {
        get: vi.fn(),
      },
      chatSessionBindings: {
        get: vi.fn(),
      },
    };

    gateway.storage.chatMessages.get.mockReturnValueOnce(undefined);
    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "missing-message"),
    ).rejects.toThrow("existing user message was not found in the requested session");

    gateway.storage.chatMessages.get.mockReturnValueOnce({
      messageId: "message-assistant-1",
      sessionId: "session-1",
      role: "assistant",
      content: "not a user message",
    });
    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "message-assistant-1"),
    ).rejects.toThrow("existing user message was not found in the requested session");

    gateway.storage.chatMessages.get.mockReturnValue({
      messageId: "message-user-1",
      sessionId: "session-1",
      role: "user",
      content: "original user prompt",
    });
    gateway.storage.chatSessionBindings.get.mockReturnValueOnce({
      transport: "llm",
      writable: true,
    });
    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "message-user-1"),
    ).rejects.toThrow("session is not bound to a writable integration target");

    gateway.storage.chatSessionBindings.get.mockReturnValueOnce({
      transport: "integration",
      connectionId: "discord-1",
      target: "room-1",
      writable: false,
    });
    await expect(
      GatewayService.prototype.respondToExistingChatMessage.call(gateway, "session-1", "message-user-1"),
    ).rejects.toThrow("session binding is not writable");
  });

  it("lists chat messages through projection and falls back to transcript scan on projection failure", async () => {
    const gateway = createGatewayHarness();
    gateway.getSession = vi.fn(() => ({ sessionId: "session-1" }));
    gateway.ensureChatMessageProjection = vi.fn(async () => undefined);
    gateway.listChatMessagesFromTranscript = vi.fn(async (sessionId: string, limit: number, cursor?: string) => [
      { sessionId, limit, cursor, source: "transcript" },
    ]);
    gateway.storage = {
      chatMessages: {
        list: vi.fn((sessionId: string, limit: number, cursor?: string) => [
          { sessionId, limit, cursor, source: "projection" },
        ]),
      },
    };

    await expect(
      GatewayService.prototype.listChatMessages.call(gateway, "session-1", 5000, "cursor-1"),
    ).resolves.toEqual([{ sessionId: "session-1", limit: 1000, cursor: "cursor-1", source: "projection" }]);
    expect(gateway.storage.chatMessages.list).toHaveBeenCalledWith("session-1", 1000, "cursor-1");

    gateway.ensureChatMessageProjection.mockRejectedValueOnce(new Error("projection unavailable"));
    await expect(GatewayService.prototype.listChatMessages.call(gateway, "session-1", 0)).resolves.toEqual([
      { sessionId: "session-1", limit: 1, cursor: undefined, source: "transcript" },
    ]);
    expect(gateway.listChatMessagesFromTranscript).toHaveBeenCalledWith("session-1", 1, undefined);
  });

  it("loads chat turn state maps from projected messages and hydrated traces", async () => {
    const gateway = createGatewayHarness();
    gateway.ensureChatMessageProjection = vi.fn(async () => undefined);
    const traces = [
      {
        turnId: "turn-parent",
        userMessageId: "message-user-1",
        startedAt: "2026-05-03T16:00:00.000Z",
      },
      {
        turnId: "turn-child",
        parentTurnId: "turn-parent",
        userMessageId: "message-user-2",
        assistantMessageId: "message-assistant-1",
        startedAt: "2026-05-03T16:01:00.000Z",
      },
    ];
    // Children-map building and active-leaf resolution moved into
    // chat-turn-trace-hydration (B3b); the branch-state store drives the
    // active leaf instead of a gateway-method stub.
    gateway.storage = {
      chatSessionBranchState: {
        get: vi.fn(() => ({ activeLeafTurnId: "turn-child" })),
        setActiveLeaf: vi.fn(),
      },
      chatTurnTraces: {
        listBySession: vi.fn(() => traces),
        listSiblingsByParentTurnIds: vi.fn(
          () =>
            new Map([
              ["__root__", [traces[0]]],
              ["turn-parent", [traces[1]]],
            ]),
        ),
      },
      chatMessages: {
        listByMessageIds: vi.fn(
          () =>
            new Map([
              ["message-user-1", { messageId: "message-user-1", timestamp: "2026-05-03T16:00:00.000Z" }],
              ["message-user-2", { messageId: "message-user-2", timestamp: "2026-05-03T16:01:00.000Z" }],
              ["message-assistant-1", { messageId: "message-assistant-1", timestamp: "2026-05-03T16:01:01.000Z" }],
            ]),
        ),
      },
      chatToolRuns: {
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatExecutionPlans: {
        get: vi.fn(),
      },
    };

    const state = await GatewayService.prototype.loadChatTurnSessionState.call(gateway, "session-1");

    expect(gateway.ensureChatMessageProjection).toHaveBeenCalledWith("session-1");
    expect(gateway.storage.chatTurnTraces.listBySession).toHaveBeenCalledWith("session-1", 2_000);
    expect(gateway.storage.chatTurnTraces.listSiblingsByParentTurnIds).toHaveBeenCalledWith("session-1", [
      undefined,
      "turn-parent",
    ]);
    expect(gateway.storage.chatMessages.listByMessageIds).toHaveBeenCalledWith([
      "message-user-1",
      "message-user-2",
      "message-assistant-1",
    ]);
    expect(state.tracesById.get("turn-child")).toEqual(
      expect.objectContaining({ turnId: "turn-child", parentTurnId: "turn-parent" }),
    );
    expect(state.turnLineageById.get("turn-child")).toEqual({
      turnId: "turn-child",
      parentTurnId: "turn-parent",
    });
    expect(state.messagesById.get("message-assistant-1")).toEqual({
      messageId: "message-assistant-1",
      timestamp: "2026-05-03T16:01:01.000Z",
    });
    expect(state.childrenByTurnId.get("turn-parent")).toEqual(["turn-child"]);
    expect(state.activeLeafTurnId).toBe("turn-child");
  });

  it("normalizes chat session model defaults and hydrates autonomy preferences", () => {
    const gateway = createGatewayHarness();
    const originalPrefs = {
      sessionId: "session-1",
      providerId: "openai",
      model: "claude-sonnet-4-6",
    };
    gateway.llmService = {
      getRuntimeConfig: vi.fn(() => ({
        providers: [
          { providerId: "openai", defaultModel: "gpt-5.4-mini" },
          { providerId: "openrouter", defaultModel: "openrouter/auto" },
        ],
      })),
    };
    gateway.storage = {
      chatSessionPrefs: {
        patch: vi.fn((sessionId: string, patch: unknown) => ({ sessionId, ...originalPrefs, ...patch })),
      },
      sessionAutonomyPrefs: {
        ensure: vi.fn((sessionId: string) => ({
          sessionId,
          proactiveMode: "review",
          maxActionsPerHour: 4,
          maxActionsPerTurn: 2,
          cooldownSeconds: 30,
          retrievalMode: "workspace",
          reflectionMode: "after_turn",
        })),
        patch: vi.fn((sessionId: string, input: unknown) => ({ sessionId, input })),
      },
    };
    gateway.chatProactiveService = {
      toProactivePolicy: vi.fn((sessionId: string, prefs: unknown) => ({ sessionId, prefs, policy: true })),
      startScheduler: vi.fn(),
    };

    expect(
      GatewayService.prototype.ensureChatSessionModelDefaults.call(gateway, "session-1", { model: "gpt-5" }),
    ).toEqual({
      model: "gpt-5",
    });
    expect(
      GatewayService.prototype.ensureChatSessionModelDefaults.call(gateway, "session-1", {
        providerId: "missing-provider",
        model: "claude-sonnet-4-6",
      }),
    ).toEqual({
      providerId: "missing-provider",
      model: "claude-sonnet-4-6",
    });
    expect(
      GatewayService.prototype.ensureChatSessionModelDefaults.call(gateway, "session-1", {
        providerId: "openrouter",
        model: "claude-sonnet-4-6",
      }),
    ).toEqual({
      providerId: "openrouter",
      model: "claude-sonnet-4-6",
    });
    expect(
      GatewayService.prototype.ensureChatSessionModelDefaults.call(gateway, "session-1", {
        providerId: "openai",
        model: "custom-private-model",
      }),
    ).toEqual({
      providerId: "openai",
      model: "custom-private-model",
    });
    expect(GatewayService.prototype.ensureChatSessionModelDefaults.call(gateway, "session-1", originalPrefs)).toEqual({
      sessionId: "session-1",
      providerId: "openai",
      model: "gpt-5.4-mini",
    });
    expect(gateway.storage.chatSessionPrefs.patch).toHaveBeenCalledWith("session-1", {
      model: "gpt-5.4-mini",
    });

    expect(
      GatewayService.prototype.hydrateChatPrefsWithAutonomy.call(gateway, "session-1", {
        providerId: "openai",
        model: "gpt-5.4-mini",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4-mini",
      proactiveMode: "review",
      autonomyBudget: {
        maxActionsPerHour: 4,
        maxActionsPerTurn: 2,
        cooldownSeconds: 30,
      },
      retrievalMode: "workspace",
      reflectionMode: "after_turn",
    });
    expect(GatewayService.prototype.getSessionAutonomyPrefs.call(gateway, "session-1")).toMatchObject({
      sessionId: "session-1",
      proactiveMode: "review",
    });
    expect(
      GatewayService.prototype.patchSessionAutonomyPrefs.call(gateway, "session-1", {
        proactiveMode: "off",
      }),
    ).toEqual({
      sessionId: "session-1",
      input: { proactiveMode: "off" },
    });
    expect(
      (GatewayService.prototype as any).toProactivePolicy.call(gateway, "session-1", { proactiveMode: "review" }),
    ).toEqual({
      sessionId: "session-1",
      prefs: { proactiveMode: "review" },
      policy: true,
    });
    (GatewayService.prototype as any).startProactiveScheduler.call(gateway);
    expect(gateway.chatProactiveService.startScheduler).toHaveBeenCalledTimes(1);
  });

  it("runs the private beta backup scheduler with retention pruning and realtime output", async () => {
    const gateway = createGatewayHarness();
    const getCronJob = vi.fn();
    const setSystemSetting = vi.fn();
    const upsertCronJob = vi.fn();
    const createBackup = vi.fn(async () => ({
      backupId: "backup-1",
      outputPath: "backups/private-beta.zip",
      bytes: 4096,
    }));
    const pruneRetention = vi.fn(async () => ({ pruned: [] }));
    const publishRealtime = vi.fn();
    gateway.storage = {
      cronJobs: {
        get: getCronJob,
        upsert: upsertCronJob,
      },
      systemSettings: {
        get: vi.fn(() => undefined),
        set: setSystemSetting,
      },
    };
    gateway.createBackup = createBackup;
    gateway.pruneRetention = pruneRetention;
    gateway.publishRealtime = publishRealtime;
    gateway.persistCronJobsConfig = vi.fn();

    getCronJob.mockReturnValueOnce({ jobId: "private-beta-backup", enabled: false });
    await (GatewayService.prototype as any).runPrivateBetaBackupSchedulerIfDue.call(gateway, { force: true });
    expect(createBackup).not.toHaveBeenCalled();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    try {
      getCronJob.mockReturnValueOnce({
        jobId: "private-beta-backup",
        name: "Private beta backup",
        enabled: true,
        actionConfig: {},
      });

      await (GatewayService.prototype as any).runPrivateBetaBackupSchedulerIfDue.call(gateway, { force: true });

      expect(createBackup).toHaveBeenCalledWith({ name: "private-beta-20260515" });
      expect(pruneRetention).toHaveBeenCalledWith({ dryRun: false });
      expect(setSystemSetting).toHaveBeenCalledWith(expect.any(String), "2026-05-15");
      expect(upsertCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "private-beta-backup",
          name: "Private beta backup",
          enabled: true,
          lastRunAt: "2026-05-15T12:00:00.000Z",
          lastRunStatus: "ok",
          lastRunId: expect.any(String),
          failureCount: 0,
          nextRunAt: "2026-05-16T12:00:00.000Z",
        }),
      );
      expect(gateway.persistCronJobsConfig).toHaveBeenCalledTimes(1);
      expect(publishRealtime).toHaveBeenCalledWith("backup_created", "system", {
        type: "private_beta_daily_backup",
        backupId: "backup-1",
        outputPath: "backups/private-beta.zip",
        bytes: 4096,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records private beta backup scheduler failure state and backoff", async () => {
    const gateway = createGatewayHarness();
    const upsertCronJob = vi.fn((job) => job);
    const createBackup = vi.fn(async () => {
      throw new Error("backup failed");
    });
    const publishRealtime = vi.fn();
    gateway.storage = {
      cronJobs: {
        get: vi.fn(() => ({
          jobId: "private-beta-backup",
          name: "Private beta backup",
          enabled: true,
          action: "backup",
          actionConfig: {},
          failureCount: 1,
        })),
        upsert: upsertCronJob,
      },
      systemSettings: {
        get: vi.fn(() => undefined),
        set: vi.fn(),
      },
    };
    gateway.createBackup = createBackup;
    gateway.publishRealtime = publishRealtime;
    gateway.persistCronJobsConfig = vi.fn();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    try {
      await expect(
        (GatewayService.prototype as any).runPrivateBetaBackupSchedulerIfDue.call(gateway, { force: true }),
      ).rejects.toThrow("backup failed");

      expect(upsertCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "private-beta-backup",
          lastRunAt: "2026-05-15T12:00:00.000Z",
          lastRunStatus: "failed",
          lastRunId: expect.any(String),
          failureCount: 2,
          backoffUntil: "2026-05-15T12:02:00.000Z",
          lastFailureAt: "2026-05-15T12:00:00.000Z",
          lastFailure: { message: "backup failed", code: "Error" },
        }),
      );
      expect(gateway.persistCronJobsConfig).toHaveBeenCalledTimes(1);
      expect(publishRealtime).toHaveBeenCalledWith(
        "cron_job_run",
        "cron",
        expect.objectContaining({
          type: "cron_job_run_failed",
          jobId: "private-beta-backup",
          message: "backup failed",
          failureCount: 2,
          backoffUntil: "2026-05-15T12:02:00.000Z",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

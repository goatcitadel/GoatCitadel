import { describe, expect, it, vi } from "vitest";
import type { ApprovalEffectRecord, ApprovalRequest, CodeModeRunRecord } from "@goatcitadel/contracts";
import {
  createApproval,
  resolveApproval,
  resolveApprovalsBulk,
  resolveApprovalWithConsumedRemoteToken,
  resolveChatToolApproval,
  type ApprovalLifecycleHost,
} from "./approval-lifecycle-service.js";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";

describe("approval lifecycle service", () => {
  it("creates approvals with explicit wait-run linkage and retained-stream metadata", async () => {
    const host = createApprovalHarness();

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {
        sessionId: "session-1",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(host.approvalWaitRunService.primeApprovalLifecycle).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "approval_created",
      "approvals",
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "pending",
      },
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          approvalId: "approval-1",
          sessionId: "session-1",
          runId: "approval-wait-1",
          workspaceId: "workspace-1",
        },
        correlationId: "approval-1",
      }),
    );
    expect(host.scheduleApprovalExplanation).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        linkage: expect.objectContaining({
          durableRunId: "approval-wait-1",
        }),
      }),
    );
    expect(approval.linkage?.durableRunId).toBe("approval-wait-1");
  });

  it("blocks createApproval when approval.request.before vetoes before approval.create.before fires", async () => {
    const host = createApprovalHarness();
    const seenTriggers: string[] = [];
    host.hooksService.runInlineHooks = vi.fn(async (input: { trigger: string }) => {
      seenTriggers.push(input.trigger);
      if (input.trigger === "approval.request.before") {
        return {
          blockedBy: { type: "block" as const, reason: "policy: blocked" },
          runs: [],
        };
      }
      return { runs: [] };
    });

    await expect(
      createApproval(host, {
        kind: "shell.exec",
        riskLevel: "danger",
        payload: {
          sessionId: "session-1",
        },
        preview: {
          label: "Run shell command",
        },
        linkage: {
          sessionId: "session-1",
          workspaceId: "workspace-1",
        },
      }),
    ).rejects.toThrow(/policy: blocked/);

    expect(seenTriggers).toEqual(["approval.request.before"]);
    expect(host.storage.approvals.create).not.toHaveBeenCalled();
  });

  it("fires approval.request.before then approval.create.before in order on happy path", async () => {
    const host = createApprovalHarness();
    const seenTriggers: string[] = [];
    host.hooksService.runInlineHooks = vi.fn(async (input: { trigger: string }) => {
      seenTriggers.push(input.trigger);
      return { runs: [] };
    });

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {
        sessionId: "session-1",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(seenTriggers).toEqual(["approval.request.before", "approval.create.before"]);
    expect(host.storage.approvals.create).toHaveBeenCalledTimes(1);
    expect(approval.approvalId).toBe("approval-1");
  });

  it("auto-rejects dangerous shell approvals with durable resolution evidence", async () => {
    const host = createApprovalHarness({
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: { toolName: "shell.exec" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      shellExplainerPolicy: {
        enabled: true,
        elevateOnDanger: "danger",
        autoRejectOnDanger: true,
        autoRejectDangerThreshold: "danger",
      },
    });

    const approval = await createApproval(host, {
      kind: "shell.exec",
      riskLevel: "caution",
      payload: {
        sessionId: "session-1",
        command: "rm -rf /tmp/gc-danger",
      },
      preview: {
        label: "Run shell command",
      },
      linkage: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(approval).toMatchObject({
      approvalId: "approval-1",
      riskLevel: "danger",
      status: "rejected",
      resolvedBy: "system",
      resolutionNote: expect.stringContaining("Auto-rejected"),
    });
    expect(host.storage.approvals.setShellExplanations).toHaveBeenCalledWith(
      "approval-1",
      expect.arrayContaining([expect.objectContaining({ command: "rm -rf /tmp/gc-danger", highestRisk: "danger" })]),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "created",
      }),
    );
    expect(host.storage.approvalEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        eventType: "resolved",
        actorId: "system",
        payload: expect.objectContaining({ decision: "reject", status: "rejected" }),
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "rejected",
      expect.objectContaining({ decision: "reject" }),
    );
    expect(host.recordApprovalResolution).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", status: "rejected" }),
      expect.objectContaining({ decision: "reject", resolvedBy: "system" }),
    );
    expect(host.scheduleApprovalExplanation).not.toHaveBeenCalled();
  });

  it("returns durable wake linkage from effect rows when resolving approvals", async () => {
    const host = createApprovalHarness({
      pendingAction: {
        approvalId: "approval-1",
        actionType: "tool.invoke",
        request: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      approvalEffects: [
        {
          effectId: "effect-1",
          approvalId: "approval-1",
          effectKind: "approval_wait_wake",
          targetKind: "durable_run",
          targetId: "approval-wait-42",
          idempotencyKey: "approval-1:approval_wait_wake",
          status: "pending",
          attemptCount: 0,
          payload: {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        },
      ],
    });

    const result = await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });

    expect(host.storage.approvals.resolve).toHaveBeenCalledWith("approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });
    expect(host.enqueueApprovalResolutionEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        status: "approved",
      }),
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );
    expect(host.recordApprovalResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
      }),
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );
    expect(result.durableRunId).toBe("approval-wait-42");
    expect(result.resolutionEffects).toMatchObject({
      approvalWaitDurableRunId: "approval-wait-42",
    });
    expect(result.approval.linkage?.durableRunId).toBe("approval-wait-42");
    expect(host.storage.approvals.mergeLinkage).toHaveBeenCalledWith("approval-1", {
      durableRunId: "approval-wait-42",
    });
  });

  it("rejects expired approvals before mutating state or enqueueing effects", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
    expect(host.enqueueApprovalResolutionEffects).not.toHaveBeenCalled();
    expect(host.recordApprovalResolution).not.toHaveBeenCalled();
  });

  it("marks linked Code Mode runs rejected when approval is rejected", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await resolveApproval(host, "approval-1", {
      decision: "reject",
      resolvedBy: "operator",
    });

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-1",
        status: "rejected",
        error: "Approval approval-1 resolved with reject.",
      }),
    );
  });

  it("marks linked Code Mode runs expired when approval expires", async () => {
    const host = createApprovalHarness({
      approvalKind: "code_mode.run",
      expiresAt: "2020-04-11T00:00:00.000Z",
      pendingAction: {
        approvalId: "approval-1",
        actionType: "code_mode.run",
        request: { runId: "code-run-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      },
      codeModeRun: createCodeModeRunRecord(),
    });

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.codeModeRuns.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "code-run-1",
        status: "expired",
      }),
    );
    expect(host.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "approval-1",
      "failed",
      expect.objectContaining({
        status: "expired",
        runId: "code-run-1",
      }),
    );
  });

  it("resolves remote-token approvals through the approval host with connector linkage", async () => {
    const host = createApprovalHarness();
    host.resolveApproval.mockResolvedValue({
      approval: {
        ...host.storage.approvals.get("approval-1"),
        status: "approved",
      },
      effects: [],
      replay: {
        approval: host.storage.approvals.get("approval-1"),
        events: [],
        pendingAction: undefined,
        effects: [],
      },
      resolutionEffects: {
        proactiveRunIds: [],
      },
    });

    await resolveApprovalWithConsumedRemoteToken(
      host,
      {
        tokenId: "token-1",
        connectorId: "connector-1",
        approvalId: "approval-1",
      },
      {
        decision: "approve",
        editedPayload: {
          shellCommand: "pwd",
        },
        resolutionNote: "approved remotely",
      },
    );

    expect(host.storage.audit.append).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        event: "approval.remote_token.consume",
        approvalId: "approval-1",
        connectorId: "connector-1",
        tokenId: "token-1",
        decision: "approve",
        resolvedBy: "connector:connector-1",
      }),
    );
    expect(host.storage.approvals.mergeLinkage).toHaveBeenCalledWith("approval-1", {
      connectorId: "connector-1",
      tokenId: "token-1",
    });
    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        editedPayload: {
          shellCommand: "pwd",
        },
        resolutionNote: "approved remotely",
        resolvedBy: "connector:connector-1",
      }),
    );
  });

  it("rejects expired remote-token approvals before enqueueing effects", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));

    await expect(
      resolveApprovalWithConsumedRemoteToken(
        host,
        {
          tokenId: "token-1",
          connectorId: "connector-1",
          approvalId: "approval-1",
        },
        {
          decision: "approve",
        },
      ),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
    expect(host.enqueueApprovalResolutionEffects).not.toHaveBeenCalled();
    expect(host.recordApprovalResolution).not.toHaveBeenCalled();
  });

  it("reports expired approvals as failed in bulk resolution without enqueueing effects", async () => {
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));
    host.storage.approvals.list = vi.fn(() => [host.storage.approvals.get("approval-1")]);

    const result = await resolveApprovalsBulk(host, {
      decision: "approve",
      resolvedBy: "operator",
    });

    expect(result.items).toEqual([
      {
        approvalId: "approval-1",
        outcome: "failed",
        error: expect.stringMatching(/has expired and can no longer be resolved/i),
      },
    ]);
    expect(host.storage.approvals.resolve).not.toHaveBeenCalled();
    expect(host.enqueueApprovalResolutionEffects).not.toHaveBeenCalled();
    expect(host.recordApprovalResolution).not.toHaveBeenCalled();
  });

  it("resolves approvals through effect enqueue and durable-run wake processing", async () => {
    const effectRows: Array<Record<string, unknown>> = [];
    const requestRunProcessing = vi.fn();
    const host = createApprovalHarness();
    const approvalEffectsStorage = {
      upsert: vi.fn((input: Record<string, unknown>) => {
        const row = {
          effectId: `effect-${effectRows.length + 1}`,
          approvalId: String(input.approvalId),
          effectKind: input.effectKind,
          targetKind: input.targetKind,
          targetId: String(input.targetId),
          idempotencyKey: `${input.approvalId}:${input.effectKind}:${input.targetId}`,
          status: "pending",
          attemptCount: 0,
          payload: (input.payload as Record<string, unknown>) ?? {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        };
        effectRows.push(row);
        return row;
      }),
      listByApproval: vi.fn((approvalId: string) => effectRows.filter((row) => row.approvalId === approvalId)),
      completeEffect: vi.fn((effectId: string, _workerId: string, _version: number, patch: Record<string, unknown>) => {
        const row = effectRows.find((candidate) => candidate.effectId === effectId);
        if (!row) {
          return undefined;
        }
        Object.assign(row, {
          status: "completed",
          result: patch.result ?? row.result,
          updatedAt: "2026-04-11T00:01:00.000Z",
        });
        return row;
      }),
      failEffect: vi.fn(),
      skipEffect: vi.fn(),
      get: vi.fn((effectId: string) => effectRows.find((candidate) => candidate.effectId === effectId)),
      claimNextPendingEffect: vi.fn(),
    };
    host.storage.approvalEffects = approvalEffectsStorage as never;
    host.storage.approvalWaitRuns = {
      getRunId: vi.fn(() => "approval-wait-1"),
      markResolved: vi.fn(),
    } as never;
    host.storage.pendingApprovalActions.find = vi.fn(() => undefined);
    host.storage.approvalInbox.findByApprovalAndToken = vi.fn(() => undefined);
    host.storage.chatInlineApprovals.get = vi.fn(() => undefined);
    host.findProactiveDurableRunIdsForApproval = vi.fn(() => []);
    host.wakeDurableRun = vi.fn(() => ({
      runId: "approval-wait-1",
      eventKey: "approval.resolved",
      outcome: "woke",
    }));

    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input) =>
      effectsService.enqueueResolutionEffects(approval, input),
    );

    const result = await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator",
    });

    const wakeEffect = effectRows.find((row) => row.effectKind === "approval_wait_wake");
    expect(wakeEffect).toBeDefined();
    expect(result.resolutionEffects.approvalWaitDurableRunId).toBe("approval-wait-1");

    await (
      effectsService as unknown as {
        handleWakeEffect(effect: Record<string, unknown>, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(wakeEffect as Record<string, unknown>, true);

    expect(host.wakeDurableRun).toHaveBeenCalledWith(
      "approval-wait-1",
      expect.objectContaining({
        eventKey: "approval.resolved",
      }),
    );
    expect(host.storage.approvalWaitRuns.markResolved).toHaveBeenCalled();
    expect(requestRunProcessing).toHaveBeenCalledWith("approval-wait-1");
    expect(approvalEffectsStorage.completeEffect).toHaveBeenCalled();
  });

  it("does not enqueue wake effects for expired approvals in the resolve-plus-effects flow", async () => {
    const effectRows: Array<Record<string, unknown>> = [];
    const host = createApprovalHarness({
      expiresAt: "2020-04-11T00:00:00.000Z",
    });
    const getRunId = vi.fn(() => "approval-wait-1");
    host.storage.approvalWaitRuns = {
      getRunId,
      markResolved: vi.fn(),
    } as never;
    host.storage.approvalEffects = {
      upsert: vi.fn((input: Record<string, unknown>) => {
        effectRows.push(input);
        return input;
      }),
      listByApproval: vi.fn(() => effectRows),
      completeEffect: vi.fn(),
      failEffect: vi.fn(),
      skipEffect: vi.fn(),
      get: vi.fn(),
      claimNextPendingEffect: vi.fn(),
    } as never;
    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input) =>
      effectsService.enqueueResolutionEffects(approval, input),
    );

    await expect(
      resolveApproval(host, "approval-1", {
        decision: "approve",
        resolvedBy: "operator",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(effectRows).toEqual([]);
    expect(host.enqueueApprovalResolutionEffects).not.toHaveBeenCalled();
    expect(getRunId).not.toHaveBeenCalled();
    expect(host.wakeDurableRun).not.toHaveBeenCalled();
  });

  it("marks chat inline approvals resolved when the generic approval route is used", async () => {
    const host = createApprovalHarness();
    host.storage.chatInlineApprovals.get = vi.fn(() => ({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "tool_call",
      toolName: "shell.exec",
      status: "pending",
      reason: "Needs approval",
      riskLevel: "danger",
      details: {
        command: "pwd",
      },
      expiresAt: "2026-04-11T00:05:00.000Z",
      createdAt: "2026-04-11T00:00:00.000Z",
    }));
    host.storage.chatInlineApprovals.upsert = vi.fn();

    await resolveApproval(host, "approval-1", {
      decision: "approve",
      resolvedBy: "operator-test",
      resolutionNote: "Approved from approvals queue.",
    });

    expect(host.storage.chatInlineApprovals.upsert).toHaveBeenCalledWith({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "tool_call",
      toolName: "shell.exec",
      status: "approved",
      reason: "Approved from approvals queue.",
      riskLevel: "danger",
      details: {
        command: "pwd",
        decision: "approve",
      },
      expiresAt: "2026-04-11T00:05:00.000Z",
      resolvedBy: "operator-test",
    });
  });

  it("uses the shared approval resolution wake result instead of double-waking the linked turn", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger",
      status: "pending",
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
      explanationStatus: "not_requested",
    };
    const resolvedApproval = {
      ...approval,
      status: "approved" as const,
      resolvedBy: "operator-test",
      resolvedAt: new Date("2026-04-09T12:00:02.000Z").toISOString(),
    };

    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell.exec",
            status: "pending",
            reason: "Needs approval",
            createdAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            updatedAt: new Date("2026-04-09T12:00:00.000Z").toISOString(),
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            status: "waiting_for_approval",
            durable: {
              runId: "durable-turn-1",
            },
          })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        createGrant: vi.fn(),
      },
      resolveApproval: vi.fn(async () => ({
        approval: resolvedApproval,
        effects: [],
        replay: {
          approval: resolvedApproval,
          events: [],
          pendingAction: undefined,
          effects: [],
        },
        durableRunId: "approval-wait-1",
        resolutionEffects: {
          approvalWaitDurableRunId: "approval-wait-1",
          proactiveRunIds: [],
          chatTurnResume: {
            resumed: true,
            turnId: "turn-1",
            durableRunId: "durable-turn-1",
          },
        },
      })),
    } as unknown as ApprovalLifecycleHost;

    const result = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });

    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        resolvedBy: "operator-test",
      }),
    );
    expect(result).toMatchObject({
      allowScope: "once",
      resumed: true,
      resumedTurnId: "turn-1",
      resumedRunId: "durable-turn-1",
    });
  });

  it("rejects expired chat tool approvals before creating persistent grants", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger" as const,
      status: "pending" as const,
      payload: {
        sessionId: "session-1",
      },
      preview: {},
      createdAt: "2020-04-09T12:00:00.000Z",
      expiresAt: "2020-04-09T12:01:00.000Z",
      explanationStatus: "not_requested" as const,
    };
    const createGrant = vi.fn();
    const host = {
      storage: {
        approvals: {
          get: vi.fn(() => approval),
        },
        chatInlineApprovals: {
          get: vi.fn(() => ({
            approvalId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            toolName: "shell.exec",
            status: "pending",
            reason: "Needs approval",
            createdAt: "2020-04-09T12:00:00.000Z",
            details: {},
          })),
          upsert: vi.fn(),
        },
        chatToolRuns: {
          listBySession: vi.fn(() => []),
        },
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
      },
      policyEngine: {
        listGrants: vi.fn(() => []),
        createGrant,
      },
      resolveApproval: vi.fn(),
    } as unknown as ApprovalLifecycleHost;

    await expect(
      resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
        allowScope: "workspace",
        resolvedBy: "operator-test",
      }),
    ).rejects.toThrow(/has expired and can no longer be resolved/i);

    expect(createGrant).not.toHaveBeenCalled();
    expect(host.resolveApproval).not.toHaveBeenCalled();
  });

  it("resumes an approval-blocked chat turn end to end and keeps duplicate wake processing idempotent", async () => {
    const backgroundTasks = new Set<Promise<void>>();
    const requestRunProcessing = vi.fn();
    const markResolved = vi.fn();
    const executeApprovedPendingAction = vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "approved",
      auditEventId: "audit-1",
      result: { ok: true },
    }));
    const effectRows: ApprovalEffectRecord[] = [];
    let pendingAction = {
      approvalId: "approval-1",
      actionType: "tool.invoke",
      request: {
        toolName: "shell.exec",
        args: {
          command: "pwd",
        },
      },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "pending",
      result: undefined as Record<string, unknown> | undefined,
    };
    const runStates = new Map<
      string,
      {
        workflowKey: string;
        status: "waiting" | "queued";
        version: number;
      }
    >([
      ["approval-wait-1", { workflowKey: "approval.wait", status: "waiting", version: 1 }],
      ["durable-turn-1", { workflowKey: "chat.turn.execute", status: "waiting", version: 1 }],
    ]);
    const host = createApprovalHarness({
      pendingAction,
    });
    host.storage.pendingApprovalActions = {
      find: vi.fn(() => pendingAction),
      markResolved: vi.fn((_approvalId: string, resolutionStatus: string, result?: Record<string, unknown>) => {
        pendingAction = {
          ...pendingAction,
          resolutionStatus,
          result,
        };
        return pendingAction;
      }),
    } as never;
    host.storage.approvalWaitRuns = {
      getRunId: vi.fn(() => "approval-wait-1"),
      markResolved,
    } as never;
    host.storage.chatInlineApprovals.get = vi.fn(() => ({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "shell.exec",
      status: "pending",
      reason: "Needs approval",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      details: {},
    }));
    host.storage.chatToolRuns.listBySession = vi.fn(() => [
      {
        toolRunId: "tool-run-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        toolName: "shell.exec",
      },
    ]) as never;
    host.storage.chatTurnTraces.get = vi.fn(() => ({
      turnId: "turn-1",
      sessionId: "session-1",
      status: "waiting_for_approval",
      durable: {
        runId: "durable-turn-1",
      },
    })) as never;
    host.storage.approvalEffects = createInMemoryApprovalEffectsStore(effectRows) as never;
    host.wakeDurableRun = vi.fn((runId: string, event: { eventKey: string; correlationId?: string }) => {
      const current = runStates.get(runId);
      if (!current) {
        throw new Error(`Unknown durable run ${runId}`);
      }
      if (current.status === "waiting") {
        const next = {
          ...current,
          status: "queued" as const,
          version: current.version + 1,
        };
        runStates.set(runId, next);
        return {
          runId,
          eventKey: event.eventKey,
          correlationId: event.correlationId,
          outcome: "woke" as const,
          run: {
            runId,
            workflowKey: current.workflowKey,
            status: next.status,
            attemptCount: 0,
            maxAttempts: 3,
            version: next.version,
            payload: {},
            createdAt: "2026-04-11T00:00:00.000Z",
            updatedAt: "2026-04-11T00:01:00.000Z",
          },
        };
      }
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_not_waiting" as const,
        detail: `Durable run ${runId} is ${current.status}.`,
        run: {
          runId,
          workflowKey: current.workflowKey,
          status: current.status,
          attemptCount: 0,
          maxAttempts: 3,
          version: current.version,
          payload: {},
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
        },
      };
    });
    host.resolveApproval = vi.fn((approvalId, input) => resolveApproval(host, approvalId, input));

    const effectsService = new ApprovalEffectsService(
      {
        storage: host.storage as never,
        publishRealtime: host.publishRealtime,
      } as never,
      {
        backgroundTasks,
        wakeDurableRun: host.wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: host.findProactiveDurableRunIdsForApproval,
        executeCodeModePendingApproval: host.executeCodeModePendingApproval,
        executeApprovedPendingAction,
        enqueueAfterHooks: host.hooksService.enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: host.resolveApprovalHookWorkspaceId,
      },
    );
    host.enqueueApprovalResolutionEffects = vi.fn((approval, input) =>
      effectsService.enqueueResolutionEffects(approval, input),
    );

    const resolution = await resolveChatToolApproval(host, "session-1", "approval-1", "approve", {
      allowScope: "once",
      resolvedBy: "operator-test",
    });
    await Promise.allSettled([...backgroundTasks]);

    const processedEffects = host.storage.approvalEffects.listByApproval("approval-1");
    const processedSummary = deriveApprovalResolutionEffectsResult(processedEffects);

    expect(resolution).toMatchObject({
      allowScope: "once",
      resumed: false,
      resumedTurnId: "turn-1",
    });
    expect(markResolved).toHaveBeenCalledTimes(1);
    expect(requestRunProcessing).toHaveBeenCalledTimes(2);
    expect(requestRunProcessing).toHaveBeenNthCalledWith(1, "approval-wait-1");
    expect(requestRunProcessing).toHaveBeenNthCalledWith(2, "durable-turn-1");
    expect(executeApprovedPendingAction).toHaveBeenCalledTimes(1);
    expect(pendingAction.resolutionStatus).toBe("executed");
    expect(processedEffects.map((effect) => [effect.effectKind, effect.status])).toEqual([
      ["pending_action_execute", "completed"],
      ["approval_wait_wake", "completed"],
      ["linked_chat_turn_wake", "completed"],
      ["approval_after_hooks", "completed"],
    ]);
    expect(processedSummary).toMatchObject({
      approvalWaitDurableRunId: "approval-wait-1",
      chatTurnResume: {
        resumed: true,
        turnId: "turn-1",
        durableRunId: "durable-turn-1",
        wakeOutcome: "woke",
      },
    });

    effectsService.enqueueResolutionEffects(host.storage.approvals.get("approval-1"), {
      decision: "approve",
      resolvedBy: "operator-test",
      resolutionNote: "Approved from chat inline control.",
    });
    await Promise.allSettled([...backgroundTasks]);

    expect(host.storage.approvalEffects.listByApproval("approval-1")).toHaveLength(4);
    expect(requestRunProcessing).toHaveBeenCalledTimes(2);
    expect(executeApprovedPendingAction).toHaveBeenCalledTimes(1);
    expect(host.wakeDurableRun).toHaveBeenCalledTimes(2);
  });
});

function createApprovalHarness(input?: {
  pendingAction?: {
    approvalId: string;
    actionType: string;
    request: Record<string, unknown>;
    createdAt: string;
    resolutionStatus: string;
  };
  approvalEffects?: Array<Record<string, unknown>>;
  expiresAt?: string;
  approvalKind?: string;
  codeModeRun?: CodeModeRunRecord;
  shellExplainerPolicy?: ApprovalLifecycleHost["shellExplainerPolicy"];
}) {
  const pendingAction = input?.pendingAction;
  let approval: ApprovalRequest = {
    approvalId: "approval-1",
    kind: input?.approvalKind ?? "shell.exec",
    riskLevel: "danger" as const,
    status: "pending" as const,
    payload: {
      sessionId: "session-1",
    },
    preview: {},
    linkage: {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    },
    createdAt: "2026-04-11T00:00:00.000Z",
    expiresAt: input?.expiresAt,
    explanationStatus: "not_requested" as const,
  };

  const approvals = {
    create: vi.fn((request: Record<string, unknown>) => {
      approval = {
        ...approval,
        kind: String(request.kind),
        riskLevel: request.riskLevel as typeof approval.riskLevel,
        payload: request.payload as typeof approval.payload,
        preview: request.preview as typeof approval.preview,
        linkage: request.linkage as typeof approval.linkage,
      };
      return approval;
    }),
    get: vi.fn(() => approval),
    resolve: vi.fn((_approvalId: string, request: { decision: "approve" | "reject" | "edit"; resolvedBy: string }) => {
      approval = {
        ...approval,
        status: request.decision === "approve" ? "approved" : request.decision === "reject" ? "rejected" : "edited",
        resolvedBy: request.resolvedBy,
        resolutionNote: request.resolutionNote,
        resolvedAt: "2026-04-11T00:01:00.000Z",
      };
      return approval;
    }),
    mergeLinkage: vi.fn((_approvalId: string, linkage: Record<string, unknown>) => {
      approval = {
        ...approval,
        linkage: {
          ...(approval.linkage ?? {}),
          ...linkage,
        },
      };
      return approval;
    }),
    setShellExplanations: vi.fn((_approvalId: string, explanations: readonly unknown[]) => {
      approval = {
        ...approval,
        shellExplanations: explanations,
      } as ApprovalRequest;
      return true;
    }),
    list: vi.fn(() => []),
  };

  const host = {
    storage: {
      approvals,
      approvalEvents: {
        append: vi.fn(),
        listByApprovalId: vi.fn(() => []),
      },
      pendingApprovalActions: {
        find: vi.fn(() => pendingAction),
        markResolved: vi.fn(),
      },
      remoteActionTokens: {
        create: vi.fn(),
      },
      audit: {
        append: vi.fn(async () => undefined),
      },
      approvalWaitRuns: {
        getRunId: vi.fn(() => "approval-wait-1"),
      },
      approvalEffects: {
        listByApproval: vi.fn(() => input?.approvalEffects ?? []),
      },
      approvalInbox: {
        findByApprovalAndToken: vi.fn(() => undefined),
      },
      chatInlineApprovals: {
        get: vi.fn(() => undefined),
        upsert: vi.fn(),
      },
      chatSessionMeta: {
        get: vi.fn(() => ({ workspaceId: "workspace-1" })),
      },
      chatTurnTraces: {
        get: vi.fn(() => ({
          turnId: "turn-1",
          sessionId: "session-1",
          durable: { runId: "durable-turn-1" },
        })),
      },
      chatToolRuns: {
        listBySession: vi.fn(() => []),
      },
      codeModeRuns: {
        find: vi.fn(() => input?.codeModeRun),
        upsert: vi.fn((record: CodeModeRunRecord) => record),
      },
      runImmediateTransaction: <T>(callback: () => T) => callback(),
    },
    policyEngine: {
      listGrants: vi.fn(() => []),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      executeApprovedAction: vi.fn(),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ blockedBy: undefined, patch: undefined })),
      enqueueAfterHooks: vi.fn(),
    },
    shellExplainerPolicy: input?.shellExplainerPolicy ?? {
      enabled: true,
      elevateOnDanger: "danger" as const,
      autoRejectOnDanger: false,
    },
    approvalWaitRunService: {
      buildApprovalLinkage: vi.fn((linkage?: Record<string, unknown>) => linkage),
      buildApprovalRealtimeLinks: vi.fn((currentApproval: typeof approval) => ({
        approvalId: currentApproval.approvalId,
        sessionId: currentApproval.linkage?.sessionId,
        runId: currentApproval.linkage?.durableRunId,
        workspaceId: currentApproval.linkage?.workspaceId,
      })),
      primeApprovalLifecycle: vi.fn((_approvalId: string) => {
        approval = {
          ...approval,
          linkage: {
            ...(approval.linkage ?? {}),
            durableRunId: "approval-wait-1",
          },
        };
        return approval;
      }),
    },
    publishRealtime: vi.fn(),
    requireConnectorRecord: vi.fn(),
    consumeRemoteActionToken: vi.fn(),
    consumeRemoteActionTokenById: vi.fn(),
    resolveApproval: vi.fn(),
    resolveDeviceAccessApproval: vi.fn(),
    executeCodeModePendingApproval: vi.fn(),
    resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    parseApprovalCreateHookPatch: vi.fn(),
    scheduleApprovalExplanation: vi.fn(),
    findProactiveDurableRunIdsForApproval: vi.fn(() => []),
    wakeDurableRun: vi.fn(),
    recordApprovalResolution: vi.fn(async () => undefined),
    enqueueApprovalResolutionEffects: vi.fn(),
    enqueueApprovalRemoteTokenDelivery: vi.fn(),
  };

  return host as typeof host & ApprovalLifecycleHost;
}

function createCodeModeRunRecord(overrides: Partial<CodeModeRunRecord> = {}): CodeModeRunRecord {
  return {
    runId: "code-run-1",
    status: "approval_pending",
    language: "typescript",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "cap-snap-1",
    codeModeInputHash: "input-hash",
    wrapperManifestHash: "wrapper-hash",
    policySnapshotHash: "policy-hash",
    codeHash: "code-hash",
    approvalId: "approval-1",
    codeArtifact: createArtifact("source.ts"),
    wrapperManifestArtifact: createArtifact("wrapper.json"),
    policySnapshotArtifact: createArtifact("policy.json"),
    stdoutTruncated: false,
    stderrTruncated: false,
    createdAt: "2026-04-11T00:00:00.000Z",
    ...overrides,
  };
}

function createArtifact(label: string) {
  return {
    artifactId: `artifact-${label}`,
    relPath: `code-mode/${label}`,
    sha256: `sha-${label}`,
    sizeBytes: 1,
    mimeType: "application/json",
  };
}

function createInMemoryApprovalEffectsStore(effectRows: ApprovalEffectRecord[]) {
  return {
    upsert: vi.fn(
      (input: {
        approvalId: string;
        effectKind: ApprovalEffectRecord["effectKind"];
        targetKind: ApprovalEffectRecord["targetKind"];
        targetId: string;
        payload?: Record<string, unknown>;
      }) => {
        const idempotencyKey = `${input.approvalId}:${input.effectKind}:${input.targetKind}:${input.targetId}`;
        const existingIndex = effectRows.findIndex((effect) => effect.idempotencyKey === idempotencyKey);
        if (existingIndex >= 0) {
          const existing = effectRows[existingIndex]!;
          const next = {
            ...existing,
            payload: input.payload ?? existing.payload,
            updatedAt: "2026-04-11T00:02:00.000Z",
          };
          effectRows.splice(existingIndex, 1, next);
          return next;
        }
        const effect: ApprovalEffectRecord = {
          effectId: `effect-${effectRows.length + 1}`,
          approvalId: input.approvalId,
          effectKind: input.effectKind,
          targetKind: input.targetKind,
          targetId: input.targetId,
          idempotencyKey,
          status: "pending",
          attemptCount: 0,
          payload: input.payload ?? {},
          result: {},
          version: 1,
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        };
        effectRows.push(effect);
        return effect;
      },
    ),
    listByApproval: vi.fn((approvalId: string) =>
      effectRows.filter((effect) => effect.approvalId === approvalId).map((effect) => ({ ...effect })),
    ),
    claimNextPendingEffect: vi.fn((workerId: string, now: string, leaseExpiresAt: string) => {
      const effect = effectRows.find((candidate) => candidate.status === "pending");
      if (!effect) {
        return undefined;
      }
      Object.assign(effect, {
        status: "running",
        attemptCount: effect.attemptCount + 1,
        claimedBy: workerId,
        claimedAt: now,
        leaseExpiresAt,
        updatedAt: now,
        version: effect.version + 1,
      });
      return { ...effect };
    }),
    get: vi.fn((effectId: string) => {
      const effect = effectRows.find((candidate) => candidate.effectId === effectId);
      if (!effect) {
        throw new Error(`Unknown approval effect ${effectId}`);
      }
      return { ...effect };
    }),
    renewEffectLease: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, now: string, leaseExpiresAt: string) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          leaseExpiresAt,
          updatedAt: now,
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    completeEffect: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, patch: { result?: Record<string, unknown> }) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "completed",
          result: patch.result ?? effect.result,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    skipEffect: vi.fn(
      (effectId: string, workerId: string, expectedVersion: number, patch: { result?: Record<string, unknown> }) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "skipped",
          result: patch.result ?? effect.result,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
    failEffect: vi.fn(
      (
        effectId: string,
        workerId: string,
        expectedVersion: number,
        patch: { result?: Record<string, unknown>; lastError: string },
      ) => {
        const effect = effectRows.find((candidate) => candidate.effectId === effectId);
        if (
          !effect ||
          effect.status !== "running" ||
          effect.claimedBy !== workerId ||
          effect.version !== expectedVersion
        ) {
          return undefined;
        }
        Object.assign(effect, {
          status: "failed",
          result: patch.result ?? effect.result,
          lastError: patch.lastError,
          claimedBy: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          completedAt: "2026-04-11T00:01:00.000Z",
          updatedAt: "2026-04-11T00:01:00.000Z",
          version: effect.version + 1,
        });
        return { ...effect };
      },
    ),
  };
}

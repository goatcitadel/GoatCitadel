import { describe, expect, it, vi } from "vitest";
import {
  createApproval,
  resolveApproval,
  resolveApprovalWithConsumedRemoteToken,
  resolveChatToolApproval,
  type ApprovalLifecycleHost,
} from "./approval-lifecycle-service.js";

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
      resolvedBy: "chat-operator",
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
    });

    expect(host.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        decision: "approve",
        resolvedBy: "chat-operator",
      }),
    );
    expect(result).toMatchObject({
      allowScope: "once",
      resumed: true,
      resumedTurnId: "turn-1",
      resumedRunId: "durable-turn-1",
    });
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
}) {
  const pendingAction = input?.pendingAction;
  let approval: {
    approvalId: string;
    kind: string;
    riskLevel: "danger";
    status: "pending" | "approved" | "rejected" | "edited";
    payload: {
      sessionId: string;
    };
    preview: Record<string, unknown>;
    linkage?: {
      sessionId?: string;
      workspaceId?: string;
      durableRunId?: string;
    };
    createdAt: string;
    explanationStatus: "not_requested";
    resolvedBy?: string;
    resolvedAt?: string;
  } = {
    approvalId: "approval-1",
    kind: "shell.exec",
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

import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  McpServerRecord,
  McpToolRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
} from "./tool-invocation-coordinator-service.js";

function createToolRequest(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "echo hi" },
    agentId: "agent-1",
    sessionId: "session-1",
    ...overrides,
  };
}

function createMcpServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "srv-1",
    label: "Test MCP",
    transport: "stdio",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  } as McpServerRecord;
}

function createMcpTool(overrides: Partial<McpToolRecord> = {}): McpToolRecord {
  return {
    serverId: "srv-1",
    toolName: "tool.echo",
    enabled: true,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  } as McpToolRecord;
}

function createHost(overrides: Partial<ToolInvocationCoordinatorHost> = {}): ToolInvocationCoordinatorHost {
  return {
    approvalInbox: {
      receiveMcpApprovalDelivery: vi.fn(),
      listByReceiver: vi.fn(() => []),
      get: vi.fn(),
      markResolved: vi.fn(),
    },
    policyEngine: {
      invoke: vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-1",
          result: { ok: true },
        }),
      ),
      evaluateAccess: vi.fn(() => ({
        allowed: true,
        requiresApproval: false,
        reasonCodes: [],
      })),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    },
    normalizeToolInvokeRequest: vi.fn((request: ToolInvokeRequest) => ({
      ...request,
      workspaceId: request.workspaceId ?? "workspace-1",
    })),
    isValidToolName: vi.fn(() => true),
    evaluateToolDeploymentGuard: vi.fn(() => undefined),
    resolveToolHookWorkspaceId: vi.fn(() => "workspace-1"),
    parseToolCallHookPatch: vi.fn(() => undefined),
    primeToolApprovalLifecycle: vi.fn(
      (): ApprovalRequest =>
        ({
          approvalId: "approval-1",
          status: "pending",
          kind: "tool",
          riskLevel: "caution",
          payload: {},
          preview: {},
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          linkage: {
            durableRunId: "run-1",
          },
        }) as unknown as ApprovalRequest,
    ),
    scheduleApprovalExplanationById: vi.fn(),
    publishRealtime: vi.fn(),
    requireMcpServer: vi.fn(() => createMcpServer()),
    listMcpTools: vi.fn(() => [createMcpTool()]),
    matchesWildcard: vi.fn((value: string, pattern: string) => value === pattern),
    isMcpToolApproved: vi.fn(() => true),
    invokeMcpRuntimeTool: vi.fn(async () => ({
      ok: true,
      output: {
        payload: "ok",
      },
    })),
    resolveApprovalWithRemoteTokenId: vi.fn(async () => ({
      approval: {
        approvalId: "approval-1",
      } as ApprovalRequest,
    })),
    applyMcpRedaction: vi.fn((output: Record<string, unknown>) => output),
    ...overrides,
  } as ToolInvocationCoordinatorHost;
}

describe("ToolInvocationCoordinatorService", () => {
  it("enqueues tool.call.error hooks when tool policy execution throws", async () => {
    const enqueueAfterHooks = vi.fn();
    const host = createHost({
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ runs: [] })),
        enqueueAfterHooks,
      },
      policyEngine: {
        invoke: vi.fn(async () => {
          throw new Error("boom");
        }),
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: false,
          reasonCodes: [],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    await expect(coordinator.invokeTool(createToolRequest())).rejects.toThrow("boom");

    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "tool.call.error",
        payload: expect.objectContaining({
          toolName: "shell.exec",
          sessionId: "session-1",
          error: "boom",
        }),
      }),
    );
  });

  it("primes approval lifecycle and publishes retained-stream linkage for approval-required tools", async () => {
    const publishRealtime = vi.fn();
    const scheduleApprovalExplanationById = vi.fn();
    const primeToolApprovalLifecycle = vi.fn(
      (): ApprovalRequest =>
        ({
          approvalId: "approval-1",
          linkage: {
            durableRunId: "run-1",
          },
        }) as unknown as ApprovalRequest,
    );
    const host = createHost({
      publishRealtime,
      scheduleApprovalExplanationById,
      primeToolApprovalLifecycle,
      policyEngine: {
        invoke: vi.fn(
          async (): Promise<ToolInvokeResult> => ({
            outcome: "approval_required",
            approvalId: "approval-1",
            policyReason: "needs approval",
            auditEventId: "audit-2",
          }),
        ),
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: false,
          reasonCodes: [],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeTool(createToolRequest());

    expect(result).toMatchObject({
      outcome: "approval_required",
      approvalId: "approval-1",
    });
    expect(primeToolApprovalLifecycle).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        toolName: "shell.exec",
      }),
    );
    expect(scheduleApprovalExplanationById).toHaveBeenCalledWith("approval-1");
    expect(publishRealtime).toHaveBeenCalledWith(
      "tool_invoked",
      "policy",
      expect.objectContaining({
        outcome: "approval_required",
        approvalId: "approval-1",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: expect.objectContaining({
          sessionId: "session-1",
          approvalId: "approval-1",
          runId: "run-1",
        }),
      }),
    );
  });

  it("blocks MCP first-use execution before runtime invocation", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const host = createHost({
      requireMcpServer: vi.fn(() =>
        createMcpServer({
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "off",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        }),
      ),
      isMcpToolApproved: vi.fn(() => false),
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      arguments: {},
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("First-use approval required"),
    });
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("preserves MCP approval-required policy responses without touching runtime", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const host = createHost({
      policyEngine: {
        invoke: vi.fn(
          async (): Promise<ToolInvokeResult> => ({
            outcome: "approval_required",
            approvalId: "approval-mcp-1",
            policyReason: "approval required by risk gate",
            auditEventId: "audit-mcp-1",
          }),
        ),
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: true,
          reasonCodes: ["mcp_approval_required"],
        })),
      },
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({
      ok: false,
      approvalRequired: true,
      approvalId: "approval-mcp-1",
      policyReason: "approval required by risk gate",
      reasonCodes: ["mcp_approval_required"],
    });
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("re-checks MCP policy immediately before runtime invoke and blocks if the second pass tightens", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const host = createHost({
      policyEngine: {
        invoke: vi
          .fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>()
          .mockResolvedValueOnce({
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-preview-1",
            result: { dryRun: true },
          })
          .mockResolvedValueOnce({
            outcome: "blocked",
            policyReason: "blocked by runtime trust gate",
            auditEventId: "audit-preview-2",
          }),
        evaluateAccess: vi
          .fn<ToolInvocationCoordinatorHost["policyEngine"]["evaluateAccess"]>()
          .mockReturnValueOnce({
            allowed: true,
            requiresApproval: false,
            reasonCodes: ["preview_allowed"],
          })
          .mockReturnValueOnce({
            allowed: false,
            requiresApproval: false,
            reasonCodes: ["runtime_blocked"],
          }),
      },
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: "blocked by runtime trust gate",
      policyReason: "blocked by runtime trust gate",
      reasonCodes: ["runtime_blocked"],
    });
    expect(host.policyEngine.evaluateAccess).toHaveBeenCalledTimes(2);
    expect(host.policyEngine.invoke).toHaveBeenCalledTimes(2);
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("surfaces second-pass approval requirements before MCP runtime invoke", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const host = createHost({
      policyEngine: {
        invoke: vi
          .fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>()
          .mockResolvedValueOnce({
            outcome: "executed",
            policyReason: "allowed",
            auditEventId: "audit-preview-1",
            result: { dryRun: true },
          })
          .mockResolvedValueOnce({
            outcome: "approval_required",
            approvalId: "approval-runtime-1",
            policyReason: "late approval required",
            auditEventId: "audit-preview-2",
          }),
        evaluateAccess: vi
          .fn<ToolInvocationCoordinatorHost["policyEngine"]["evaluateAccess"]>()
          .mockReturnValueOnce({
            allowed: true,
            requiresApproval: false,
            reasonCodes: ["preview_allowed"],
          })
          .mockReturnValueOnce({
            allowed: true,
            requiresApproval: true,
            reasonCodes: ["runtime_approval_required"],
          }),
      },
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({
      ok: false,
      approvalRequired: true,
      approvalId: "approval-runtime-1",
      policyReason: "late approval required",
      reasonCodes: ["runtime_approval_required"],
    });
    expect(host.policyEngine.evaluateAccess).toHaveBeenCalledTimes(2);
    expect(host.policyEngine.invoke).toHaveBeenCalledTimes(2);
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "executed",
      invokeResult: {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-executed",
        result: { dryRun: true },
      } satisfies ToolInvokeResult,
      expectedGenericOutcome: "executed",
      expectedMcp: {
        ok: true,
      },
      runtimeCalls: 1,
    },
    {
      label: "blocked",
      invokeResult: {
        outcome: "blocked",
        policyReason: "blocked by risk gate",
        auditEventId: "audit-blocked",
      } satisfies ToolInvokeResult,
      expectedGenericOutcome: "blocked",
      expectedMcp: {
        ok: false,
        error: "blocked by risk gate",
        policyReason: "blocked by risk gate",
      },
      runtimeCalls: 0,
    },
    {
      label: "approval_required",
      invokeResult: {
        outcome: "approval_required",
        approvalId: "approval-shared-1",
        policyReason: "needs approval",
        auditEventId: "audit-approval",
      } satisfies ToolInvokeResult,
      expectedGenericOutcome: "approval_required",
      expectedMcp: {
        ok: false,
        approvalRequired: true,
        approvalId: "approval-shared-1",
        policyReason: "needs approval",
      },
      runtimeCalls: 0,
    },
  ])("keeps generic and MCP policy outcomes aligned for $label decisions", async (scenario) => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: true,
      output: {
        payload: "ok",
      },
    }));
    const invoke = vi.fn(async () => scenario.invokeResult);
    const host = createHost({
      invokeMcpRuntimeTool,
      policyEngine: {
        invoke,
        evaluateAccess: vi.fn(() => ({
          allowed: false,
          requiresApproval: false,
          reasonCodes: ["preview_only"],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const generic = await coordinator.invokeTool(
      createToolRequest({
        toolName: "mcp.invoke",
        args: {
          serverId: "srv-1",
          toolName: "tool.echo",
          arguments: { value: "hello" },
        },
      }),
    );
    const mcp = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(generic.outcome).toBe(scenario.expectedGenericOutcome);
    expect(mcp).toMatchObject(scenario.expectedMcp);
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(scenario.runtimeCalls);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "mcp.invoke",
        dryRun: true,
      }),
    );
  });

  it("emits explicit realtime metadata for successful MCP invocation", async () => {
    const publishRealtime = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        publishRealtime,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      sessionId: "session-1",
      taskId: "task-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({
      ok: true,
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "tool_invoked",
      "mcp",
      expect.objectContaining({
        type: "mcp_tool_invoked",
        serverId: "srv-1",
        toolName: "tool.echo",
        sessionId: "session-1",
        taskId: "task-1",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: expect.objectContaining({
          sessionId: "session-1",
          taskId: "task-1",
        }),
      }),
    );
  });
});

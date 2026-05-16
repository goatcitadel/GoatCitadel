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
import { applyMcpRedaction } from "./mcp-server-policy.js";
import { MCP_APPROVAL_INBOX_LIST_TOOL_NAME, MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";
import { PluginToolOverrideService } from "./plugin-tool-override-service.js";

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

  it("records failed diagnostics before rethrowing policy-engine tool failures", async () => {
    const recordDevDiagnostic = vi.fn();
    const host = createHost({
      recordDevDiagnostic,
      policyEngine: {
        invoke: vi.fn(async () => {
          throw "policy transport unavailable";
        }),
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: false,
          reasonCodes: [],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    await expect(coordinator.invokeTool(createToolRequest({ taskId: "task-failed" }))).rejects.toBe(
      "policy transport unavailable",
    );

    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        category: "tools",
        event: "tool.invocation.failed",
        runtimeKind: "tool.invocation",
        runtimeStatus: "failed",
        toolName: "shell.exec",
        sessionId: "session-1",
        taskId: "task-failed",
        runtimeError: {
          name: undefined,
          message: "policy transport unavailable",
          retryable: false,
        },
      }),
    );
  });

  it("emits runtime diagnostics for tool invocation lifecycle", async () => {
    const recordDevDiagnostic = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(createHost({ recordDevDiagnostic }));

    const result = await coordinator.invokeTool(createToolRequest({ taskId: "task-1" }));

    expect(result.outcome).toBe("executed");
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool.invocation.start",
        runtimeKind: "tool.invocation",
        runtimeStatus: "started",
        toolName: "shell.exec",
        sessionId: "session-1",
        taskId: "task-1",
      }),
    );
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool.invocation.complete",
        runtimeKind: "tool.invocation",
        runtimeStatus: "completed",
        toolName: "shell.exec",
        sessionId: "session-1",
        taskId: "task-1",
      }),
    );
  });

  it("applies before-hook tool patches before policy invocation and after-hook dispatch", async () => {
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-patched",
        result: { ok: true },
      }),
    );
    const enqueueAfterHooks = vi.fn();
    const runInlineHooks = vi.fn(async (request) => {
      const parsed = request.parsePatch({
        toolName: "shell.exec",
        args: {
          command: "pwd",
        },
        ignored: true,
      });
      return {
        runs: [],
        patch: request.mergePatch(undefined, parsed),
      };
    });
    const host = createHost({
      hooksService: {
        runInlineHooks,
        enqueueAfterHooks,
      },
      policyEngine: {
        invoke: policyInvoke,
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: false,
          reasonCodes: [],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "shell.list" }));

    expect(result.outcome).toBe("executed");
    expect(policyInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "shell.exec",
        args: {
          command: "pwd",
        },
      }),
    );
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "tool.call.after",
        payload: expect.objectContaining({
          toolName: "shell.exec",
          args: {
            command: "pwd",
          },
          result: expect.objectContaining({
            auditEventId: "audit-patched",
          }),
        }),
      }),
    );
  });

  it("blocks invalid tool names, deployment guard failures, and before-hook vetoes before execution", async () => {
    await expect(
      new ToolInvocationCoordinatorService(
        createHost({
          isValidToolName: vi.fn(() => false),
        }),
      ).invokeTool(createToolRequest({ toolName: "bad name" })),
    ).resolves.toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: invalid tool name format",
    });

    await expect(
      new ToolInvocationCoordinatorService(
        createHost({
          evaluateToolDeploymentGuard: vi.fn(() => ({ reason: "remote deployment disallows shell" })),
        }),
      ).invokeTool(createToolRequest()),
    ).resolves.toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: remote deployment disallows shell",
    });

    await expect(
      new ToolInvocationCoordinatorService(
        createHost({
          hooksService: {
            runInlineHooks: vi.fn(async () => ({ runs: [], blockedBy: { reason: "operator policy" } })),
            enqueueAfterHooks: vi.fn(),
          },
        }),
      ).invokeTool(createToolRequest()),
    ).resolves.toMatchObject({
      outcome: "blocked",
      policyReason: "hook blocked: operator policy",
    });
  });

  it("blocks tool execution when intercept-mode before-hook returns a block decision", async () => {
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
        result: { ok: true },
      }),
    );
    const enqueueAfterHooks = vi.fn();
    const host = createHost({
      hooksService: {
        runInlineHooks: vi.fn(async () => ({
          runs: [],
          blockedBy: { type: "block" as const, reason: "policy:dryrun-blocked" },
        })),
        enqueueAfterHooks,
      },
      policyEngine: {
        invoke: policyInvoke,
        evaluateAccess: vi.fn(() => ({
          allowed: true,
          requiresApproval: false,
          reasonCodes: [],
        })),
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeTool(createToolRequest());

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toMatch(/policy:dryrun-blocked/);
    expect(policyInvoke).not.toHaveBeenCalled();
    expect(enqueueAfterHooks).not.toHaveBeenCalled();
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

  it("emits runtime after_tool_call hooks with the final tool outcome", async () => {
    const enqueueAfterHooks = vi.fn();
    const host = createHost({
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ runs: [] })),
        enqueueAfterHooks,
      },
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeTool(createToolRequest());

    expect(result.outcome).toBe("executed");
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "after_tool_call",
        payload: expect.objectContaining({
          toolName: "shell.exec",
          outcome: "executed",
          auditEventId: "audit-1",
          policyReason: "allowed",
        }),
      }),
    );
  });

  it("records approval-required policy tool outcomes as retained evidence", async () => {
    const recordEvidenceEnvelope = vi.fn();
    const scheduleApprovalExplanationById = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        recordEvidenceEnvelope,
        scheduleApprovalExplanationById,
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "approval_required",
              approvalId: "approval-policy-1",
              policyReason: "needs operator approval",
              auditEventId: "audit-policy-1",
            }),
          ),
          evaluateAccess: vi.fn(() => ({
            allowed: true,
            requiresApproval: true,
            reasonCodes: ["approval_required"],
          })),
        },
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ taskId: "task-approval" }));

    expect(result).toMatchObject({
      outcome: "approval_required",
      approvalId: "approval-policy-1",
      policyReason: "needs operator approval",
    });
    expect(scheduleApprovalExplanationById).toHaveBeenCalledWith("approval-policy-1");
    expect(recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "tool_invocation",
        sessionId: "session-1",
        runId: "run-1",
        approvalId: "approval-policy-1",
        toolCallHashes: ["audit-policy-1"],
        metadata: expect.objectContaining({
          runtime: "policy",
          toolName: "shell.exec",
          taskId: "task-approval",
          agentId: "agent-1",
          outcome: "approval_required",
          policyReason: "needs operator approval",
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

  it.each([
    {
      label: "disconnected server",
      server: createMcpServer({ enabled: false, status: "disconnected" }),
      tools: [createMcpTool()],
      expectedError: "MCP server is not connected.",
    },
    {
      label: "quarantined server",
      server: createMcpServer({ trustTier: "quarantined" }),
      tools: [createMcpTool()],
      expectedError: "MCP server Test MCP is quarantined and cannot execute tools.",
    },
    {
      label: "missing enabled tool",
      server: createMcpServer(),
      tools: [createMcpTool({ enabled: false })],
      expectedError: "MCP tool tool.echo is not enabled on server srv-1.",
    },
    {
      label: "blocked tool pattern",
      server: createMcpServer({
        policy: {
          requireFirstToolApproval: false,
          redactionMode: "off",
          allowedToolPatterns: [],
          blockedToolPatterns: ["tool.echo"],
        },
      }),
      tools: [createMcpTool()],
      expectedError: "MCP policy blocked tool tool.echo on server srv-1.",
    },
    {
      label: "allowed-list miss",
      server: createMcpServer({
        policy: {
          requireFirstToolApproval: false,
          redactionMode: "off",
          allowedToolPatterns: ["tool.allowed"],
          blockedToolPatterns: [],
        },
      }),
      tools: [createMcpTool()],
      expectedError: "MCP policy does not allow tool tool.echo on server srv-1.",
    },
  ])("blocks MCP runtime before execution for $label", async (scenario) => {
    const invokeMcpRuntimeTool = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        requireMcpServer: vi.fn(() => scenario.server),
        listMcpTools: vi.fn(() => scenario.tools),
        invokeMcpRuntimeTool,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      arguments: { value: "hello" },
    });

    expect(response).toEqual({
      ok: false,
      error: scenario.expectedError,
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

  it("applies MCP redaction policy to normalized content items", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        requireMcpServer: vi.fn(() =>
          createMcpServer({
            policy: {
              requireFirstToolApproval: false,
              redactionMode: "basic",
              allowedToolPatterns: [],
              blockedToolPatterns: [],
            },
          }),
        ),
        applyMcpRedaction: vi.fn((output, mode) => applyMcpRedaction(output, mode)),
        invokeMcpRuntimeTool: vi.fn(async () => ({
          ok: true,
          output: {
            payload: `secret ${secret}`,
          },
          contentItems: [{ type: "text" as const, text: `secret ${secret}` }],
        })),
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      sessionId: "session-1",
      arguments: {},
    });

    expect(JSON.stringify(response.output)).not.toContain(secret);
    expect(JSON.stringify(response.contentItems)).not.toContain(secret);
    expect(JSON.stringify(response.contentItems)).toContain("[REDACTED]");
  });

  it("routes internal MCP approval-inbox list calls without invoking the external MCP runtime", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const listByReceiver = vi.fn(() => [
      {
        inboxItemId: "inbox-1",
        receiverKind: "mcp",
        receiverId: "srv-1",
        state: "pending",
      },
    ]);
    const publishRealtime = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        approvalInbox: {
          receiveMcpApprovalDelivery: vi.fn(),
          listByReceiver,
          get: vi.fn(),
          markResolved: vi.fn(),
        },
        requireMcpServer: vi.fn(() =>
          createMcpServer({
            url: MCP_APPROVAL_INBOX_URL,
          } as Partial<McpServerRecord>),
        ),
        listMcpTools: vi.fn(() => [createMcpTool({ toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME })]),
        invokeMcpRuntimeTool,
        publishRealtime,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
      sessionId: "session-1",
      taskId: "task-approval-inbox",
      arguments: { state: "pending", limit: 2 },
    });

    expect(response).toMatchObject({
      ok: true,
      output: {
        serverId: "srv-1",
        toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
        arguments: { state: "pending", limit: 2 },
        items: [
          expect.objectContaining({
            inboxItemId: "inbox-1",
            state: "pending",
          }),
        ],
      },
    });
    expect(listByReceiver).toHaveBeenCalledWith("mcp", "srv-1", { state: "pending", limit: 2 });
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalledWith(
      "tool_invoked",
      "mcp",
      expect.objectContaining({
        type: "mcp_tool_invoked",
        toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
        trustTier: "restricted",
      }),
      expect.objectContaining({
        links: expect.objectContaining({
          sessionId: "session-1",
          taskId: "task-approval-inbox",
        }),
      }),
    );
  });

  it("emits degraded diagnostics when MCP runtime reconnects an expired session", async () => {
    const recordDevDiagnostic = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        recordDevDiagnostic,
        invokeMcpRuntimeTool: vi.fn(async () => ({
          ok: true,
          retryCount: 1,
          output: {
            payload: "ok",
            degradedReason: "expired_session_reconnect",
          },
        })),
      }),
    );

    await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      sessionId: "session-1",
      taskId: "task-1",
      arguments: { value: "hello" },
    });

    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "mcp",
        event: "mcp.transport.degraded",
        runtimeKind: "mcp.transport",
        runtimeStatus: "degraded",
        toolName: "tool.echo",
        sessionId: "session-1",
        taskId: "task-1",
        context: expect.objectContaining({
          retryCount: 1,
          degradedReason: "expired_session_reconnect",
        }),
      }),
    );
  });

  it("returns redacted failed MCP runtime diagnostics and records evidence", async () => {
    const recordEvidenceEnvelope = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        recordEvidenceEnvelope,
        invokeMcpRuntimeTool: vi.fn(async () => ({
          ok: false,
          degraded: true,
          retryCount: 2,
          error: "upstream secret sk-abcdefghijklmnopqrstuvwx",
          output: {
            payload: "failed with secret sk-abcdefghijklmnopqrstuvwx",
          },
          contentItems: [{ type: "text" as const, text: "secret sk-abcdefghijklmnopqrstuvwx" }],
        })),
        requireMcpServer: vi.fn(() =>
          createMcpServer({
            policy: {
              requireFirstToolApproval: false,
              redactionMode: "basic",
              allowedToolPatterns: [],
              blockedToolPatterns: [],
            },
          }),
        ),
        applyMcpRedaction: vi.fn((output, mode) => applyMcpRedaction(output, mode)),
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
      ok: false,
      diagnostics: {
        transport: "stdio",
        degraded: true,
        retryCount: 2,
        sanitizedError: "upstream secret sk-abcdefghijklmnopqrstuvwx",
      },
      error: "upstream secret sk-abcdefghijklmnopqrstuvwx",
    });
    expect(JSON.stringify(response.output)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(JSON.stringify(response.contentItems)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "tool_invocation",
        sessionId: "session-1",
        toolCallHashes: [expect.stringMatching(/^mcp:srv-1:tool\.echo:/)],
        metadata: expect.objectContaining({
          runtime: "mcp",
          serverId: "srv-1",
          toolName: "tool.echo",
          taskId: "task-1",
          trustTier: "restricted",
          ok: false,
          error: "upstream secret sk-abcdefghijklmnopqrstuvwx",
        }),
      }),
    );
  });

  it("routes execution to plugin override handler when an active override exists", async () => {
    const pluginHandler = vi.fn(
      async (args: Record<string, unknown>): Promise<ToolInvokeResult> => ({
        outcome: "executed" as const,
        result: { source: "plugin", echoed: args },
        auditEventId: "evt-plugin",
        policyReason: "plugin override",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });

    const policyInvoke = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: { q: "foo" } }));

    expect(result.outcome).toBe("executed");
    expect(result.result).toEqual({ source: "plugin", echoed: { q: "foo" } });
    expect(pluginHandler).toHaveBeenCalledWith({ q: "foo" });
    expect(policyInvoke).not.toHaveBeenCalled();
  });

  it("falls through to policy engine when no override is registered", async () => {
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "native" },
        auditEventId: "evt-native",
        policyReason: "native dispatch",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: {} }));

    expect(result.result).toEqual({ source: "native" });
    expect(policyInvoke).toHaveBeenCalled();
  });

  it("after-hooks still fire when the override handler runs", async () => {
    const enqueueAfterHooks = vi.fn();
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: {},
        auditEventId: "evt",
        policyReason: "plugin override",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [] })),
          enqueueAfterHooks,
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    await coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: {} }));

    expect(enqueueAfterHooks).toHaveBeenCalledWith(expect.objectContaining({ trigger: "tool.call.after" }));
  });

  it("rethrows and enqueues tool.call.error hooks when the plugin override handler throws", async () => {
    const enqueueAfterHooks = vi.fn();
    const pluginHandler = vi.fn(async () => {
      throw new Error("plugin boom");
    });
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [] })),
          enqueueAfterHooks,
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    await expect(coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: {} }))).rejects.toThrow(
      "plugin boom",
    );

    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "tool.call.error",
        payload: expect.objectContaining({
          toolName: "web_search",
          error: "plugin boom",
        }),
      }),
    );
  });
});

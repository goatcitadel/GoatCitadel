import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, McpServerRecord, McpToolRecord, ToolInvokeRequest } from "@goatcitadel/contracts";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
} from "./tool-invocation-coordinator-service.js";
import { MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME, MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";

describe("ToolInvocationCoordinatorService loop30 coverage", () => {
  it("routes internal MCP approval-inbox resolve calls through remote token resolution", async () => {
    const invokeMcpRuntimeTool = vi.fn();
    const resolveApprovalWithRemoteTokenId = vi.fn(async () => ({
      approval: {
        approvalId: "approval-remote-1",
        status: "approved",
      } as ApprovalRequest,
    }));
    const inboxItem = {
      inboxItemId: "inbox-1",
      receiverKind: "mcp",
      receiverId: "srv-1",
      state: "pending",
      tokenId: "token-1",
      approvalStatus: "pending",
      expiresAt: "2099-05-15T18:00:00.000Z",
    };
    const get = vi.fn(() => inboxItem);
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        approvalInbox: {
          receiveMcpApprovalDelivery: vi.fn(),
          listByReceiver: vi.fn(() => []),
          get,
          markResolved: vi.fn(),
        },
        requireMcpServer: vi.fn(() =>
          createMcpServer({
            url: MCP_APPROVAL_INBOX_URL,
          } as Partial<McpServerRecord>),
        ),
        listMcpTools: vi.fn(() => [createMcpTool({ toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME })]),
        invokeMcpRuntimeTool,
        resolveApprovalWithRemoteTokenId,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
      sessionId: "session-1",
      arguments: {
        inboxItemId: "inbox-1",
        decision: "edit",
        editedPayload: { command: "echo approved" },
        resolutionNote: "Approved with a safer command.",
      },
    });

    expect(response).toMatchObject({
      ok: true,
      output: {
        serverId: "srv-1",
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: expect.objectContaining({
          inboxItemId: "inbox-1",
          decision: "edit",
        }),
        item: inboxItem,
        approval: expect.objectContaining({
          approvalId: "approval-remote-1",
        }),
      },
    });
    expect(resolveApprovalWithRemoteTokenId).toHaveBeenCalledWith({
      tokenId: "token-1",
      decision: "edit",
      editedPayload: { command: "echo approved" },
      resolutionNote: "Approved with a safer command.",
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("records retained evidence for successful MCP runtime calls without output payloads", async () => {
    const recordEvidenceEnvelope = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        recordEvidenceEnvelope,
        invokeMcpRuntimeTool: vi.fn(async () => ({
          ok: true,
        })),
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      sessionId: "session-1",
      taskId: "task-no-output",
    });

    expect(response).toEqual({
      ok: true,
      output: undefined,
      contentItems: undefined,
      diagnostics: {
        transport: "stdio",
        degraded: undefined,
        retryCount: undefined,
      },
    });
    expect(recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "tool_invocation",
        sessionId: "session-1",
        toolCallHashes: [expect.stringMatching(/^mcp:srv-1:tool\.echo:/)],
        metadata: expect.objectContaining({
          runtime: "mcp",
          serverId: "srv-1",
          toolName: "tool.echo",
          taskId: "task-no-output",
          ok: true,
          error: undefined,
        }),
      }),
    );
  });
});

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
      invoke: vi.fn(async () => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-1",
        result: { ok: true },
      })),
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
    primeToolApprovalLifecycle: vi.fn(),
    scheduleApprovalExplanationById: vi.fn(),
    publishRealtime: vi.fn(),
    assertMcpServerInScope: vi.fn(),
    durableTasks: {
      listRuns: vi.fn(() => []),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
    },
    respondToMcpElicitation: vi.fn(),
    listMcpElicitations: vi.fn(() => []),
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
  } as unknown as ToolInvocationCoordinatorHost;
}

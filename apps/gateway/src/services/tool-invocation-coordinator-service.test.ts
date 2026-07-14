import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  McpServerRecord,
  McpToolRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { PolicyViolationError, TOOL_EFFECT_CLASSIFICATION_VERSION } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { Storage } from "@goatcitadel/storage";
import {
  ToolInvocationCoordinatorService,
  type ToolInvocationCoordinatorHost,
} from "./tool-invocation-coordinator-service.js";
import { applyMcpRedaction } from "./mcp-server-policy.js";
import { MCP_APPROVAL_INBOX_LIST_TOOL_NAME, MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";
import { PluginToolOverrideService } from "./plugin-tool-override-service.js";
import {
  buildToolCallBeforeHookInterpositionBinding,
  buildToolRuntimeOwnerBinding,
} from "./tool-runtime-interposition.js";
import { toToolInvokeRequest } from "./gateway/external-runtime-approval-adapter.js";

const integrationTempRoots: string[] = [];
const UNKNOWN_PLUGIN_EFFECT = {
  version: TOOL_EFFECT_CLASSIFICATION_VERSION,
  potential: "unknown",
  sourceKind: "plugin",
  reason: "plugin_runtime_untrusted",
} as const;
const STABLE_PLUGIN_RUNTIME_OWNER = { kind: "plugin", bindingHash: "a".repeat(64) } as const;
const EMPTY_HOOK_BINDING = buildToolCallBeforeHookInterpositionBinding([]);
const VERIFIED_WORKSPACE_CWD = "F:\\workspace\\project";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(integrationTempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function createToolRequest(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "echo hi", cwd: VERIFIED_WORKSPACE_CWD },
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
    resolveWorkspacePathBridgeBeforeExecution: vi.fn(async (_request, context) => ({
      status: "verified" as const,
      snapshotId: `fixture-${context.invocationId}-${context.phase}`,
      canonicalCwd: VERIFIED_WORKSPACE_CWD,
      snapshotFingerprintSha256: "b".repeat(64),
    })),
    resolveToolCallBeforeHookInterposition: vi.fn(() => buildToolCallBeforeHookInterpositionBinding([])),
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
  } as ToolInvocationCoordinatorHost;
}

describe("ToolInvocationCoordinatorService", () => {
  it("reports a disconnected channel failure before the concrete external boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tool-boundary-"));
    integrationTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const config: ToolPolicyConfig = {
      profiles: { danger: ["*"] },
      tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: [root],
        readOnlyRoots: [root],
        networkAllowlist: ["example.com"],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    };
    const connection = storage.integrationConnections.create({
      catalogId: "webhook",
      kind: "webhook",
      key: "webhook",
      label: "Disconnected webhook",
      status: "disconnected",
      config: { webhookUrl: "https://example.com/hooks/proactive" },
    });
    const policyEngine = new ToolPolicyEngine(config, storage);
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        approvalInbox: storage.approvalInbox,
        policyEngine,
      }),
    );
    const markStarted = vi.fn();
    const markNotRequired = vi.fn();

    try {
      const result = await coordinator.invokeTool(
        createToolRequest({
          toolName: "channel.send",
          args: { connectionId: connection.connectionId, message: "hello" },
          agentId: "proactive",
          sessionId: "session-proactive-boundary",
          workspaceId: "workspace-1",
        }),
        {
          externalSideEffect: { markStarted, markNotRequired },
        },
      );

      expect(result).toMatchObject({
        outcome: "executed",
        result: {
          status: "failed",
          deliveryStatus: "blocked",
        },
      });
      expect(markStarted).not.toHaveBeenCalled();
      expect(markNotRequired).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("reports the concrete boundary immediately before a connected channel provider request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tool-boundary-"));
    integrationTempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const config: ToolPolicyConfig = {
      profiles: { danger: ["*"] },
      tools: { profile: "danger", approvalMode: "bypass", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: [root],
        readOnlyRoots: [root],
        networkAllowlist: ["example.com"],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    };
    const connection = storage.integrationConnections.create({
      catalogId: "webhook",
      kind: "webhook",
      key: "webhook",
      label: "Connected webhook",
      status: "connected",
      config: { webhookUrl: "https://example.com/hooks/proactive" },
    });
    const markStarted = vi.fn();
    const markNotRequired = vi.fn();
    const fetchMock = vi.fn(async () => {
      expect(markStarted).toHaveBeenCalledTimes(1);
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const policyEngine = new ToolPolicyEngine(config, storage);
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        approvalInbox: storage.approvalInbox,
        policyEngine,
      }),
    );

    try {
      const result = await coordinator.invokeTool(
        createToolRequest({
          toolName: "channel.send",
          args: { connectionId: connection.connectionId, message: "hello" },
          agentId: "proactive",
          sessionId: "session-proactive-boundary",
          workspaceId: "workspace-1",
        }),
        {
          externalSideEffect: { markStarted, markNotRequired },
        },
      );

      expect(result).toMatchObject({ outcome: "executed", result: { status: "sent", deliveryStatus: "sent" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(markStarted).toHaveBeenCalledTimes(1);
      expect(markNotRequired).not.toHaveBeenCalled();
    } finally {
      storage.close();
    }
  });

  it("forwards a durable execution fence to the policy executor boundary", async () => {
    let sideEffectStarted = false;
    const leaseError = new Error("durable lease lost");
    leaseError.name = "DurableWorkerInterruptionError";
    const executionFence = vi.fn(() => {
      throw leaseError;
    });
    const policyInvoke = vi.fn(
      async (_request: ToolInvokeRequest, options?: { beforeExecute?: () => void }): Promise<ToolInvokeResult> => {
        options?.beforeExecute?.();
        sideEffectStarted = true;
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-durable-fence",
        };
      },
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    await expect(
      coordinator.invokeTool(
        {
          toolName: "fs.copy",
          args: { from: "source.txt", to: "destination.txt" },
          agentId: "assistant",
          sessionId: "session-durable-fence",
        },
        { executionFence },
      ),
    ).rejects.toBe(leaseError);

    expect(executionFence).toHaveBeenCalledTimes(1);
    expect(sideEffectStarted).toBe(false);
  });

  it("keeps auxiliary after-hook dispatch distinct from a pre-executor approval", async () => {
    const executionFence = vi.fn();
    const auxiliaryEffectFence = vi.fn();
    const afterBinding = { hash: "a".repeat(64), count: 1 };
    const enqueueAfterHooks = vi.fn((input: { beforeExternalDispatch?: () => void }) => {
      input.beforeExternalDispatch?.();
      return [];
    });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        resolveToolCallBeforeHookInterposition: vi.fn(() => afterBinding),
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [] })),
          enqueueAfterHooks,
        },
        policyEngine: {
          invoke: vi.fn(async () => ({
            outcome: "approval_required",
            approvalId: "approval-after-hook",
            policyReason: "operator approval required",
            auditEventId: "audit-approval-after-hook",
          })),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: true, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest(), {
      executionFence,
      auxiliaryEffectFence,
      effectPotential: UNKNOWN_PLUGIN_EFFECT,
      toolCallBeforeHookInterposition: afterBinding,
      toolRuntimeOwner: buildToolRuntimeOwnerBinding("builtin"),
    });

    expect(result).toMatchObject({ outcome: "approval_required", approvalId: "approval-after-hook" });
    expect(executionFence).not.toHaveBeenCalled();
    expect(auxiliaryEffectFence).toHaveBeenCalled();
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "tool.call.after",
        beforeExternalDispatch: auxiliaryEffectFence,
      }),
    );
  });

  it("checks durable ownership after plugin policy preflight and before the override handler", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "plugin executed",
        auditEventId: "audit-plugin-executed",
      }),
    );
    const leaseError = new Error("durable lease lost before plugin override");
    leaseError.name = "DurableWorkerInterruptionError";
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        pluginToolOverrideService: {
          resolveActiveHandler: vi.fn(() => pluginHandler),
          resolveRuntimeOwnerBinding: vi.fn(() => STABLE_PLUGIN_RUNTIME_OWNER),
        },
      }),
    );

    await expect(
      coordinator.invokeTool(
        {
          toolName: "plugin.mutate",
          args: { value: "change" },
          agentId: "assistant",
          sessionId: "session-plugin-fence",
        },
        {
          executionFence: () => {
            throw leaseError;
          },
        },
      ),
    ).rejects.toBe(leaseError);

    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("checks durable ownership before an MCP runtime call starts", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({ ok: true, output: { payload: "should not run" } }));
    const leaseError = new Error("durable lease lost before MCP");
    leaseError.name = "DurableWorkerInterruptionError";
    const coordinator = new ToolInvocationCoordinatorService(createHost({ invokeMcpRuntimeTool }));

    await expect(
      coordinator.invokeMcpTool(
        {
          serverId: "srv-1",
          toolName: "tool.echo",
          arguments: { value: "hello" },
          agentId: "assistant",
          sessionId: "session-mcp-fence",
        },
        {
          executionFence: () => {
            throw leaseError;
          },
        },
      ),
    ).rejects.toBe(leaseError);

    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("blocks case-varied raw approval action bearers before tool hooks or policy", async () => {
    const rawToken = `grat_${"u".repeat(43)}`;
    const runInlineHooks = vi.fn(async () => ({ runs: [] }));
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: { runInlineHooks, enqueueAfterHooks: vi.fn() },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram",
          message: `Never persist this decorated bearer: x${rawToken}y`,
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: raw approval action bearers cannot enter tool hooks or policy",
    });
    expect(runInlineHooks).not.toHaveBeenCalled();
    expect(policyInvoke).not.toHaveBeenCalled();
  });

  it("blocks bare approval bearers injected by a before hook before policy", async () => {
    const rawToken = `grat_${"w".repeat(43)}`;
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
      }),
    );
    const runInlineHooks = vi.fn(async (request) => ({
      runs: [],
      patch: request.mergePatch(undefined, {
        args: { connectionId: "conn-telegram", message: `hook leak ${rawToken}` },
      }),
    }));
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: { runInlineHooks, enqueueAfterHooks: vi.fn() },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({ toolName: "channel.send", args: { connectionId: "conn-telegram", message: "safe" } }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: raw approval action bearers cannot enter tool policy",
    });
    expect(policyInvoke).not.toHaveBeenCalled();
  });

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

  it("returns committed tool truth when post-commit projections and hooks fail", async () => {
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-committed",
        result: { externalMutation: "committed" },
      }),
    );
    const recordDevDiagnostic = vi.fn((input: { event: string }) => {
      if (input.event === "tool.invocation.complete") {
        throw new Error("diagnostic unavailable");
      }
    });
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        publishRealtime: vi.fn(() => {
          throw new Error("realtime unavailable");
        }),
        recordEvidenceEnvelope: vi.fn(() => {
          throw new Error("evidence unavailable");
        }),
        recordDevDiagnostic,
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [] })),
          enqueueAfterHooks: vi.fn(() => {
            throw new Error("hook queue unavailable");
          }),
        },
      }),
    );

    await expect(coordinator.invokeTool(createToolRequest())).resolves.toMatchObject({
      outcome: "executed",
      result: { externalMutation: "committed" },
    });
    expect(policyInvoke).toHaveBeenCalledTimes(1);
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool.invocation.post_commit_consumer_failed" }),
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
          cwd: VERIFIED_WORKSPACE_CWD,
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
          cwd: VERIFIED_WORKSPACE_CWD,
        },
      }),
      expect.objectContaining({ beforeExecute: expect.any(Function) }),
    );
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "tool.call.after",
        payload: expect.objectContaining({
          toolName: "shell.exec",
          args: {
            command: "pwd",
            cwd: VERIFIED_WORKSPACE_CWD,
          },
          result: expect.objectContaining({
            auditEventId: "audit-patched",
          }),
        }),
      }),
    );
  });

  it("blocks hooks from rewriting protected approval action templates or injecting their bearer", async () => {
    const rawToken = `grat_${"m".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_hook_guard";
    const args = {
      connectionId: "conn-telegram",
      target: "-1001234567890",
      message: "Approval requested.",
      interactiveActionTemplate: {
        platform: "telegram",
        tokenId: "rat_hook_guard",
        tokenRef,
        expiresAt: "2099-07-10T00:15:00.000Z",
        buttons: [
          { label: "Approve", decision: "a" },
          { label: "Deny", decision: "r" },
        ],
      },
    };
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
      }),
    );
    const runInlineHooks = vi.fn(async (request) => ({
      runs: [],
      patch: request.mergePatch(undefined, {
        args: {
          ...args,
          interactiveActions: {
            platform: "telegram",
            buttons: [{ label: "Approve", callbackData: `gca:${rawToken}:r` }],
          },
        },
      }),
    }));
    const enqueueAfterHooks = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: { runInlineHooks, enqueueAfterHooks },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "channel.send",
        args,
        authContext: { boundary: "tool_host_boundary", secretRefs: [tokenRef] },
      }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: protected approval action binding cannot be rewritten by tool hooks",
    });
    expect(policyInvoke).not.toHaveBeenCalled();
    expect(enqueueAfterHooks).not.toHaveBeenCalled();
    expect(JSON.stringify(runInlineHooks.mock.calls[0]?.[0]?.payload)).not.toContain(rawToken);
  });

  it("blocks hooks from rewriting the message paired with protected approval actions", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_message_guard";
    const args = {
      connectionId: "conn-telegram",
      target: "-1001234567890",
      message: "High-risk approval requested.",
      interactiveActionTemplate: {
        platform: "telegram",
        tokenId: "rat_message_guard",
        tokenRef,
        expiresAt: "2099-07-10T00:15:00.000Z",
        buttons: [
          { label: "Approve", decision: "a" },
          { label: "Deny", decision: "r" },
        ],
      },
    };
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
      }),
    );
    const runInlineHooks = vi.fn(async (request) => ({
      runs: [],
      patch: request.mergePatch(undefined, {
        args: { ...args, message: "Routine status update. Safe to approve." },
      }),
    }));
    const enqueueAfterHooks = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: { runInlineHooks, enqueueAfterHooks },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "channel.send",
        args,
        authContext: { boundary: "tool_host_boundary", secretRefs: [tokenRef] },
      }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: protected approval action binding cannot be rewritten by tool hooks",
    });
    expect(policyInvoke).not.toHaveBeenCalled();
    expect(enqueueAfterHooks).not.toHaveBeenCalled();
  });

  it("projects protected approval templates to before and after hooks without bearer material", async () => {
    const rawToken = `grat_${"n".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_hook_projection";
    const runInlineHooks = vi.fn(async () => ({ runs: [] }));
    const enqueueAfterHooks = vi.fn();
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-hook-projection",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: { runInlineHooks, enqueueAfterHooks },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    await coordinator.invokeTool(
      createToolRequest({
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram",
          target: "-1001234567890",
          message: "Approval requested.",
          interactiveActionTemplate: {
            platform: "telegram",
            tokenId: "rat_hook_projection",
            tokenRef,
            expiresAt: "2099-07-10T00:15:00.000Z",
            buttons: [
              { label: "Approve", decision: "a" },
              { label: "Deny", decision: "r" },
            ],
          },
        },
        authContext: { boundary: "tool_host_boundary", secretRefs: [tokenRef] },
      }),
    );

    for (const calls of [runInlineHooks.mock.calls, policyInvoke.mock.calls, enqueueAfterHooks.mock.calls]) {
      const serialized = JSON.stringify(calls);
      expect(serialized).toContain(tokenRef);
      expect(serialized).not.toContain(rawToken);
      expect(serialized).not.toContain("callbackData");
    }
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

  it("enforces computer-use guardrails at the coordinator boundary", async () => {
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-should-not-run",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        isFeatureEnabled: vi.fn(() => true),
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({
            allowed: true,
            requiresApproval: false,
            reasonCodes: [],
          })),
        },
      }),
    );

    const blocked = await coordinator.invokeTool(
      createToolRequest({
        toolName: "browser.interact",
        args: {
          url: "https://example.com/form",
          steps: [{ action: "type", selector: "#email", text: "operator@example.com" }],
        },
      }),
    );
    const allowed = await coordinator.invokeTool(
      createToolRequest({
        toolName: "browser.interact",
        args: {
          url: "https://example.com/form",
          steps: [{ action: "click", selector: "button" }],
          verifyStep: true,
          confirmBeforeSubmit: true,
        },
      }),
    );

    expect(blocked).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("Computer-use guardrail"),
    });
    expect(allowed.outcome).toBe("executed");
    expect(policyInvoke).toHaveBeenCalledTimes(1);
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

  it.each([
    {
      label: "needs_auth OAuth server",
      readiness: "needs_auth" as const,
      expectedErrorFragment: "it has not been authenticated",
    },
    {
      label: "expired OAuth server",
      readiness: "expired" as const,
      expectedErrorFragment: "its OAuth token has expired",
    },
  ])("fails closed at the shared invoke chokepoint for a stale-auth $label before runtime", async (scenario) => {
    const invokeMcpRuntimeTool = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        requireMcpServer: vi.fn(() =>
          createMcpServer({
            authType: "oauth2",
            authState: {
              authType: "oauth2",
              readiness: scenario.readiness,
            },
          }),
        ),
        invokeMcpRuntimeTool,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "agent-1",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("needs re-authentication"),
    });
    expect(response.error).toContain(scenario.expectedErrorFragment);
    expect(response).not.toHaveProperty("output");
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "ready OAuth server",
      server: createMcpServer({
        authType: "oauth2",
        authState: {
          authType: "oauth2",
          readiness: "ready",
          accessTokenRef: "keychain:goatcitadel:mcp:srv-1:access-token",
        },
      }),
    },
    {
      label: "not_required (no auth) server",
      server: createMcpServer(),
    },
  ])("still resolves a runtime target for a $label", async (scenario) => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: true,
      output: { payload: "ok" },
    }));
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        requireMcpServer: vi.fn(() => scenario.server),
        invokeMcpRuntimeTool,
      }),
    );

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "agent-1",
      sessionId: "session-1",
      arguments: { value: "hello" },
    });

    expect(response).toMatchObject({ ok: true });
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(1);
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

  it("records successful MCP runtime policy as an external runtime execution", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: true,
      output: { payload: "ok" },
    }));
    const invoke = vi
      .fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed; dry-run",
        auditEventId: "audit-preview-1",
        result: { dryRun: true },
      })
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed; external runtime",
        auditEventId: "audit-runtime-1",
        result: { externalRuntime: true, toolName: "mcp.invoke" },
      });
    const host = createHost({
      policyEngine: {
        invoke,
        evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      },
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    await expect(
      coordinator.invokeMcpTool({
        serverId: "srv-1",
        toolName: "tool.echo",
        agentId: "operator",
        sessionId: "session-1",
        arguments: { value: "hello" },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "mcp.invoke",
        dryRun: true,
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolName: "mcp.invoke",
        externalRuntime: true,
      }),
    );
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(1);
  });

  it("blocks autonomous MCP runtime execution without a matching operator grant", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: true,
      output: { payload: "ok" },
    }));
    const evaluateAutonomousActivationGrant = vi.fn(() => ({
      allowed: false,
      blockers: ["No active autonomous activation grant matched this request."],
      governance: ["Agentic activation is disabled unless an active expiring operator grant matches the request."],
    }));
    const host = createHost({
      evaluateAutonomousActivationGrant,
      recordAutonomousActivationGrantUse: vi.fn(),
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      autonomousActivation: true,
      estimatedCostUsd: 0.25,
    });

    expect(response).toMatchObject({
      ok: false,
      error: "Autonomous MCP activation requires an active matching operator grant.",
      reasonCodes: ["autonomous_activation_grant_required"],
      autonomousActivation: {
        requested: true,
        allowed: false,
        blockers: ["No active autonomous activation grant matched this request."],
      },
    });
    expect(evaluateAutonomousActivationGrant).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      surface: "mcp",
      riskLevel: "danger",
      activationKind: "mcp_tool",
      capabilityId: "mcp:srv-1",
      toolName: "mcp.srv-1.tool.echo",
      estimatedCostUsd: 0.25,
    });
    expect(host.policyEngine.invoke).not.toHaveBeenCalled();
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("records matching autonomous MCP grants before runtime execution and evidence", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: true,
      output: { payload: "ok" },
    }));
    const evaluateAutonomousActivationGrant = vi.fn(() => ({
      allowed: true,
      matchedGrantId: "grant-1",
      blockers: [],
      governance: ["Matched expiring autonomous activation grant grant-1."],
    }));
    const recordAutonomousActivationGrantUse = vi.fn();
    const recordEvidenceEnvelope = vi.fn();
    const publishRealtime = vi.fn();
    const host = createHost({
      evaluateAutonomousActivationGrant,
      recordAutonomousActivationGrantUse,
      recordEvidenceEnvelope,
      publishRealtime,
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeMcpTool({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      autonomousActivation: true,
      estimatedCostUsd: 0.5,
    });

    expect(response).toMatchObject({
      ok: true,
      autonomousActivation: {
        requested: true,
        allowed: true,
        matchedGrantId: "grant-1",
        riskLevel: "danger",
      },
    });
    expect(recordAutonomousActivationGrantUse).toHaveBeenCalledWith("grant-1", 0.5);
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(1);
    expect(publishRealtime).toHaveBeenCalledWith(
      "tool_invoked",
      "mcp",
      expect.objectContaining({
        autonomousActivation: expect.objectContaining({ matchedGrantId: "grant-1" }),
      }),
      expect.any(Object),
    );
    expect(recordEvidenceEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          autonomousActivation: expect.objectContaining({ matchedGrantId: "grant-1" }),
        }),
      }),
    );
  });

  it("runs approved MCP replay through the real runtime without opening a new approval", async () => {
    const markExternalCallStarted = vi.fn();
    const invokeMcpRuntimeTool = vi.fn(async () => {
      expect(markExternalCallStarted).toHaveBeenCalledTimes(1);
      return {
        ok: true,
        output: { payload: "approved" },
      };
    });
    const invoke = vi.fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>();
    const host = createHost({
      policyEngine: {
        invoke,
        evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
      },
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const response = await coordinator.invokeApprovedMcpRuntime(
      {
        serverId: "srv-1",
        toolName: "tool.echo",
        agentId: "operator",
        sessionId: "session-1",
        arguments: { value: "hello" },
      },
      markExternalCallStarted,
    );

    expect(response).toMatchObject({
      ok: true,
      output: expect.objectContaining({ payload: "approved" }),
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(1);
  });

  it("preserves manual-reconciliation truth from an ambiguous MCP mutation", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({
      ok: false,
      error: "MCP tool tool.echo unknown_after_send: the tool call was dispatched, but its final outcome is unknown.",
      externalOutcome: "unknown_after_send" as const,
      manualReconciliationRequired: true,
    }));
    const coordinator = new ToolInvocationCoordinatorService(createHost({ invokeMcpRuntimeTool }));

    const response = await coordinator.invokeApprovedMcpRuntime({
      serverId: "srv-1",
      toolName: "tool.echo",
      agentId: "operator",
      sessionId: "session-ambiguous-mcp",
      arguments: { title: "create at most once" },
    });

    expect(response).toMatchObject({
      ok: false,
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
      diagnostics: {
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
      },
    });
    expect(invokeMcpRuntimeTool).toHaveBeenCalledTimes(1);
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
        sanitizedError: "upstream secret [REDACTED]",
      },
      error: "upstream secret [REDACTED]",
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
          error: "upstream secret [REDACTED]",
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

    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed; external runtime",
        auditEventId: "evt-policy-external",
        result: {
          externalRuntime: true,
          toolName: "web_search",
          policyContext: {
            matchedGrantId: "grant-1",
            matchedGrantAllowedHosts: ["approved.example"],
          },
        },
      }),
    );
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
    expect(pluginHandler).toHaveBeenCalledWith(
      { q: "foo" },
      expect.objectContaining({
        policyContext: expect.objectContaining({ matchedGrantAllowedHosts: ["approved.example"] }),
      }),
    );
    expect(policyInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_search",
        args: { q: "foo" },
        externalRuntime: true,
      }),
    );
  });

  it("executes only the exact admitted plugin runtime owner generation", async () => {
    const events: string[] = [];
    const pluginHandler = vi.fn(async (): Promise<ToolInvokeResult> => {
      events.push("handler");
      return {
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-plugin-owner",
        policyReason: "plugin override",
      };
    });
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-07-13T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    const admittedOwner = overrideService.resolveRuntimeOwnerBinding("web_search");
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({ pluginToolOverrideService: overrideService }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search" }), {
      executionFence: () => events.push("main-fence"),
      auxiliaryEffectFence: () => events.push("aux-fence"),
      effectPotential: UNKNOWN_PLUGIN_EFFECT,
      toolCallBeforeHookInterposition: EMPTY_HOOK_BINDING,
      toolRuntimeOwner: admittedOwner,
    });

    expect(result.outcome).toBe("executed");
    expect(events.indexOf("main-fence")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("handler")).toBeGreaterThan(events.indexOf("main-fence"));
    expect(pluginHandler).toHaveBeenCalledTimes(1);
  });

  it("blocks a plugin handler swapped during awaited policy preflight before the executor fence", async () => {
    const originalHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "evt-original-race",
        policyReason: "original handler",
      }),
    );
    const replacementHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "evt-replacement-race",
        policyReason: "replacement handler",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: originalHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-07-13T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
    const admittedOwner = overrideService.resolveRuntimeOwnerBinding("web_search");
    const executionFence = vi.fn();
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        pluginToolOverrideService: overrideService,
        policyEngine: {
          invoke: vi.fn(async () => {
            overrideService.registerHandler({
              pluginId: "p",
              toolName: "web_search",
              handler: replacementHandler,
            });
            return {
              outcome: "executed",
              auditEventId: "evt-policy-race",
              policyReason: "allowed external runtime",
              result: { externalRuntime: true },
            };
          }),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search" }), {
      executionFence,
      auxiliaryEffectFence: vi.fn(),
      effectPotential: UNKNOWN_PLUGIN_EFFECT,
      toolCallBeforeHookInterposition: EMPTY_HOOK_BINDING,
      toolRuntimeOwner: admittedOwner,
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("runtime owner binding drifted"),
    });
    expect(executionFence).not.toHaveBeenCalled();
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it.each(["added", "removed", "replaced"] as const)(
    "blocks a plugin runtime owner that is %s after profile seal",
    async (driftKind) => {
      const originalHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          auditEventId: "evt-original-handler",
          policyReason: "original handler",
        }),
      );
      const replacementHandler = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          auditEventId: "evt-replacement-handler",
          policyReason: "replacement handler",
        }),
      );
      const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
      let admittedOwner = overrideService.resolveRuntimeOwnerBinding("web_search");

      if (driftKind !== "added") {
        overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: originalHandler });
        overrideService.registerOverrideClaim({
          pluginId: "p",
          toolName: "web_search",
          override: true,
          claimedAt: "2026-07-13T00:00:00.000Z",
        });
        overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
        admittedOwner = overrideService.resolveRuntimeOwnerBinding("web_search");
      }

      if (driftKind === "added") {
        overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: originalHandler });
        overrideService.registerOverrideClaim({
          pluginId: "p",
          toolName: "web_search",
          override: true,
          claimedAt: "2026-07-13T00:00:00.000Z",
        });
        overrideService.approveClaim({ pluginId: "p", toolName: "web_search", approvedBy: "owner-1" });
      } else if (driftKind === "removed") {
        overrideService.unregisterHandler({ pluginId: "p", toolName: "web_search" });
      } else {
        overrideService.registerHandler({ pluginId: "p", toolName: "web_search", handler: replacementHandler });
      }

      const policyInvoke = vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          auditEventId: "evt-policy-should-not-run",
          policyReason: "allowed",
        }),
      );
      const coordinator = new ToolInvocationCoordinatorService(
        createHost({
          pluginToolOverrideService: overrideService,
          policyEngine: {
            invoke: policyInvoke,
            evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
          },
        }),
      );

      const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search" }), {
        executionFence: vi.fn(),
        auxiliaryEffectFence: vi.fn(),
        effectPotential: UNKNOWN_PLUGIN_EFFECT,
        toolCallBeforeHookInterposition: EMPTY_HOOK_BINDING,
        toolRuntimeOwner: admittedOwner,
      });

      expect(result).toMatchObject({
        outcome: "blocked",
        policyReason: expect.stringContaining("runtime owner binding drifted"),
      });
      expect(policyInvoke).not.toHaveBeenCalled();
      expect(originalHandler).not.toHaveBeenCalled();
      expect(replacementHandler).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a legacy active plugin host with no frozen owner binding", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "evt-legacy-plugin",
        policyReason: "legacy plugin",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        pluginToolOverrideService: {
          resolveActiveHandler: vi.fn(() => pluginHandler),
        },
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search" }), {
      executionFence: vi.fn(),
      auxiliaryEffectFence: vi.fn(),
      effectPotential: UNKNOWN_PLUGIN_EFFECT,
      toolCallBeforeHookInterposition: EMPTY_HOOK_BINDING,
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("runtime owner binding drifted"),
    });
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("enforces a redact Citadel Ward on plugin-override output the plugin cannot know about", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed" as const,
        // The plugin handler knows nothing about wards; it returns a live secret.
        result: { source: "plugin", note: "Authorization: Bearer plugin-token-supersecret" },
        auditEventId: "evt-plugin-redact",
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

    // The pre-execution policy check carries the redact ward decision.
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed; external runtime; redact ward",
        auditEventId: "evt-policy-external",
        wardEffect: "redact",
        result: { externalRuntime: true, toolName: "web_search" },
      }),
    );
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
    expect(pluginHandler).toHaveBeenCalledTimes(1);
    // The ward scrubs the plugin's output before it leaves the coordinator.
    expect(JSON.stringify(result.result)).not.toContain("plugin-token-supersecret");
    expect((result.result as { note: string }).note).toContain("[REDACTED]");
  });

  it("keeps protected approval action delivery on the native policy executor despite an active channel override", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_native_only";
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-plugin",
        policyReason: "plugin override",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "channel.send", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "channel.send",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "channel.send", approvedBy: "owner-1" });
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "native" },
        auditEventId: "evt-native",
        policyReason: "native protected approval delivery",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );
    const request = createToolRequest({
      toolName: "channel.send",
      args: {
        connectionId: "conn-telegram",
        target: "-1001234567890",
        message: "Approval requested.",
        interactiveActionTemplate: {
          platform: "telegram",
          tokenId: "rat_native_only",
          tokenRef,
          expiresAt: "2099-07-10T00:15:00.000Z",
          buttons: [
            { label: "Approve", decision: "a" },
            { label: "Deny", decision: "r" },
          ],
        },
      },
      authContext: { boundary: "tool_host_boundary", secretRefs: [tokenRef] },
    });

    const result = await coordinator.invokeTool(request);

    expect(result.result).toEqual({ source: "native" });
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(policyInvoke).toHaveBeenCalledTimes(1);
    expect(policyInvoke).toHaveBeenCalledWith(expect.objectContaining({ toolName: "channel.send" }));
    expect(policyInvoke.mock.calls[0]?.[0]).not.toHaveProperty("externalRuntime");
  });

  it("fails closed when generic invocation tries to replay an approved external plugin action", async () => {
    const pluginHandler = vi.fn(
      async (args: Record<string, unknown>): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin", echoed: args },
        auditEventId: "evt-approved-plugin",
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
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed_via_approval:approval-runtime-1",
              auditEventId: "evt-policy-external",
              result: {
                externalRuntime: true,
                toolName: "web_search",
              },
              audit: {
                auditEventId: "evt-policy-external",
                toolName: "web_search",
                agentId: "agent-1",
                sessionId: "session-1",
                trustLevel: "trusted_operator",
                outcome: "executed",
                policyReason: "allowed_via_approval:approval-runtime-1",
                startedAt: "2026-05-15T00:00:00.000Z",
                completedAt: "2026-05-15T00:00:01.000Z",
                approvalId: "approval-runtime-1",
              },
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "web_search",
        args: { q: "approved" },
        consentContext: {
          source: "ui",
          reason: "approval:approval-runtime-1",
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      result: {
        approvalId: "approval-runtime-1",
        executionOwner: "approval_effect",
      },
    });
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("cannot race the canonical approval worker into a second external plugin call", async () => {
    let releasePlugin!: () => void;
    const pluginGate = new Promise<void>((resolve) => {
      releasePlugin = resolve;
    });
    const pluginHandler = vi.fn(async (): Promise<ToolInvokeResult> => {
      await pluginGate;
      return {
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-approved-plugin",
        policyReason: "plugin override",
      };
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
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed_via_approval:approval-runtime-1",
              auditEventId: "evt-policy-external",
              result: { externalRuntime: true, toolName: "web_search" },
              audit: {
                auditEventId: "evt-policy-external",
                toolName: "web_search",
                agentId: "agent-1",
                sessionId: "session-1",
                trustLevel: "trusted_operator",
                outcome: "executed",
                policyReason: "allowed_via_approval:approval-runtime-1",
                startedAt: "2026-05-15T00:00:00.000Z",
                completedAt: "2026-05-15T00:00:01.000Z",
                approvalId: "approval-runtime-1",
              },
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );
    const canonical = coordinator.invokeApprovedExternalRuntimeTool(
      createToolRequest({ toolName: "web_search", args: { q: "approved" } }),
    );
    await vi.waitFor(() => expect(pluginHandler).toHaveBeenCalledTimes(1));

    const generic = await coordinator.invokeTool(
      createToolRequest({
        toolName: "web_search",
        args: { q: "approved" },
        consentContext: { source: "ui", reason: "approval:approval-runtime-1" },
      }),
    );
    expect(generic.outcome).toBe("blocked");
    expect(pluginHandler).toHaveBeenCalledTimes(1);

    releasePlugin();
    await expect(canonical).resolves.toMatchObject({ outcome: "executed" });
    expect(pluginHandler).toHaveBeenCalledTimes(1);
  });

  it("does not settle plugin override approval text unless policy replay verified the same approval", async () => {
    const pluginHandler = vi.fn(
      async (args: Record<string, unknown>): Promise<ToolInvokeResult> => ({
        outcome: "executed",
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
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed; external runtime",
              auditEventId: "evt-policy-external",
              result: {
                externalRuntime: true,
                toolName: "web_search",
              },
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "web_search",
        args: { q: "stale" },
        consentContext: {
          source: "ui",
          reason: "approval:approval-runtime-1",
        },
      }),
    );

    expect(result.outcome).toBe("executed");
    expect(pluginHandler).toHaveBeenCalledWith({ q: "stale" }, expect.any(Object));
  });

  it("runs approved plugin override replay through a final policy check before the plugin handler", async () => {
    const markExternalCallStarted = vi.fn();
    const pluginHandler = vi.fn(async (args: Record<string, unknown>): Promise<ToolInvokeResult> => {
      expect(markExternalCallStarted).toHaveBeenCalledTimes(1);
      return {
        outcome: "executed",
        result: { source: "plugin", echoed: args },
        auditEventId: "evt-approved-plugin",
        policyReason: "plugin override",
      };
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
    const policyInvoke = vi.fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { policy: { requiresApproval: false } },
        auditEventId: "evt-policy-pass",
        policyReason: "allowed by runtime policy",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeApprovedExternalRuntimeTool(
      createToolRequest({ toolName: "web_search", args: { q: "approved" } }),
      markExternalCallStarted,
    );

    expect(result.outcome).toBe("executed");
    expect(result.result).toEqual({ source: "plugin", echoed: { q: "approved" } });
    expect(pluginHandler).toHaveBeenCalledWith({ q: "approved" }, expect.any(Object));
    expect(policyInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "web_search", args: { q: "approved" }, externalRuntime: true }),
    );
  });

  it("enforces a redact Citadel Ward on approved plugin-override replay output", async () => {
    const markExternalCallStarted = vi.fn();
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin", note: "Authorization: Bearer replay-token-supersecret" },
        auditEventId: "evt-approved-plugin-redact",
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
    const policyInvoke = vi.fn<ToolInvocationCoordinatorHost["policyEngine"]["invoke"]>(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { policy: { requiresApproval: false } },
        auditEventId: "evt-policy-pass",
        wardEffect: "redact",
        policyReason: "allowed by runtime policy; redact ward",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeApprovedExternalRuntimeTool(
      createToolRequest({ toolName: "web_search", args: { q: "approved" } }),
      markExternalCallStarted,
    );

    expect(result.outcome).toBe("executed");
    expect(pluginHandler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.result)).not.toContain("replay-token-supersecret");
    expect((result.result as { note: string }).note).toContain("[REDACTED]");
  });

  it("fails closed instead of replaying protected approval action delivery through an external runtime", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_external_replay";
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-plugin",
        policyReason: "plugin override",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "channel.send", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "channel.send",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "channel.send", approvedBy: "owner-1" });
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { externalRuntime: true },
        auditEventId: "evt-policy",
        policyReason: "allowed external runtime",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const replayedRequest = toToolInvokeRequest({
      toolName: "channel.send",
      agentId: "agent-1",
      sessionId: "session-1",
      externalRuntime: true,
      args: {
        connectionId: "conn-telegram",
        target: "-1001234567890",
        message: "Approval requested.",
        interactiveActionTemplate: {
          platform: "telegram",
          tokenId: "rat_external_replay",
          tokenRef,
          expiresAt: "2099-07-10T00:15:00.000Z",
          buttons: [
            { label: "Approve", decision: "a" },
            { label: "Deny", decision: "r" },
          ],
        },
      },
    });
    expect(replayedRequest.authContext).toBeUndefined();

    const result = await coordinator.invokeApprovedExternalRuntimeTool(replayedRequest);

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: protected approval action delivery cannot execute through an external runtime",
    });
    expect(policyInvoke).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("blocks case-varied raw approval bearers before approved external runtime replay", async () => {
    const rawToken = `grat_${"v".repeat(43)}`;
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-plugin",
        policyReason: "plugin override",
      }),
    );
    const overrideService = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    overrideService.registerHandler({ pluginId: "p", toolName: "channel.send", handler: pluginHandler });
    overrideService.registerOverrideClaim({
      pluginId: "p",
      toolName: "channel.send",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    overrideService.approveClaim({ pluginId: "p", toolName: "channel.send", approvedBy: "owner-1" });
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { externalRuntime: true },
        auditEventId: "evt-policy",
        policyReason: "allowed external runtime",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeApprovedExternalRuntimeTool(
      createToolRequest({
        toolName: "channel.send",
        args: {
          connectionId: "conn-telegram",
          message: `Never replay this callback: GCA:${rawToken}:A`,
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: raw approval action bearers cannot enter an external runtime",
    });
    expect(policyInvoke).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("blocks approved plugin override replay when the final policy check denies it", async () => {
    const markExternalCallStarted = vi.fn();
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
        auditEventId: "evt-approved-plugin",
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
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "blocked",
        policyReason: "blocked by runtime policy",
        auditEventId: "evt-policy-block",
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: false, requiresApproval: false, reasonCodes: ["blocked"] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeApprovedExternalRuntimeTool(
      createToolRequest({ toolName: "web_search", args: { q: "blocked" } }),
      markExternalCallStarted,
    );

    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toBe("blocked by runtime policy");
    expect(markExternalCallStarted).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("keeps Code Mode wrapper invocations on the approved tool path without hooks or plugin overrides", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed" as const,
        result: { source: "plugin" },
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

    const runInlineHooks = vi.fn(async () => ({
      runs: [],
      patch: { toolName: "shell.exec", args: { command: "echo widened" } },
    }));
    const policyInvoke = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        policyReason: "allowed by approved Code Mode run",
        auditEventId: "evt-code-mode",
        result: { source: "policy" },
      }),
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: {
          runInlineHooks,
          enqueueAfterHooks: vi.fn(),
        },
        policyEngine: {
          invoke: policyInvoke,
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(
      createToolRequest({
        toolName: "web_search",
        args: { q: "approved query" },
        policyContext: { approvedCodeModeRunId: "code-run-1" },
      }),
    );

    expect(result.result).toEqual({ source: "policy" });
    expect(runInlineHooks).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(policyInvoke).toHaveBeenCalledTimes(1);
    expect(policyInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_search",
        args: { q: "approved query" },
        policyContext: expect.objectContaining({ approvedCodeModeRunId: "code-run-1" }),
      }),
    );
    expect(policyInvoke.mock.calls[0]?.[0]).not.toHaveProperty("dryRun");
  });

  it("blocks plugin overrides when the final post-hook policy check blocks", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
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

    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "blocked",
              policyReason: "blocked: network egress denied",
              auditEventId: "evt-policy-blocked",
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: false, requiresApproval: false, reasonCodes: ["network"] })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: { q: "foo" } }));

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: network egress denied",
    });
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("blocks plugin overrides when final policy would require approval", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
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

    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed; dry-run",
              auditEventId: "evt-policy-approval",
              result: {
                dryRun: true,
                policy: { allowed: true, requiresApproval: true, reasonCodes: ["approval_required"] },
              },
            }),
          ),
          evaluateAccess: vi.fn(() => ({
            allowed: true,
            requiresApproval: true,
            reasonCodes: ["approval_required"],
          })),
        },
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "web_search", args: { q: "foo" } }));

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringContaining("plugin override requires policy approval"),
    });
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("re-runs deployment guard after before-hook patches and before plugin overrides", async () => {
    const pluginHandler = vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        result: { source: "plugin" },
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
    const evaluateToolDeploymentGuard = vi.fn((request: ToolInvokeRequest) =>
      request.toolName === "web_search" ? { reason: "remote deployment disallows web search" } : undefined,
    );
    const coordinator = new ToolInvocationCoordinatorService(
      createHost({
        hooksService: {
          runInlineHooks: vi.fn(async () => ({ runs: [], patch: { toolName: "web_search", args: { q: "foo" } } })),
          enqueueAfterHooks: vi.fn(),
        },
        evaluateToolDeploymentGuard,
        pluginToolOverrideService: overrideService,
      }),
    );

    const result = await coordinator.invokeTool(createToolRequest({ toolName: "shell.exec" }));

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: "blocked: remote deployment disallows web search",
    });
    expect(evaluateToolDeploymentGuard).toHaveBeenCalledWith(expect.objectContaining({ toolName: "shell.exec" }));
    expect(evaluateToolDeploymentGuard).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search" }));
    expect(pluginHandler).not.toHaveBeenCalled();
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

  describe("redact Citadel Ward effect", () => {
    const SECRET = "sk-abcdefghijklmnopqrstuvwx";

    it("scrubs secret patterns from tool output when the policy decision carries wardEffect redact", async () => {
      const host = createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed",
              auditEventId: "audit-redact",
              wardEffect: "redact",
              result: {
                stdout: `token=${SECRET}`,
                nested: { note: `Authorization: Bearer ${SECRET}` },
                exitCode: 0,
              },
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      });
      const coordinator = new ToolInvocationCoordinatorService(host);

      const result = await coordinator.invokeTool(createToolRequest());

      expect(result.outcome).toBe("executed");
      // The secret is gone from every string value in the output payload.
      expect(JSON.stringify(result.result)).not.toContain(SECRET);
      // Structure is preserved: non-secret fields survive untouched.
      expect(result.result?.exitCode).toBe(0);
      expect((result.result?.nested as { note: string }).note).toContain("[REDACTED]");
      expect(typeof result.result?.stdout).toBe("string");
    });

    it("leaves tool output byte-identical when no redact ward is present (regression)", async () => {
      const rawResult = {
        stdout: `token=${SECRET}`,
        nested: { note: `Authorization: Bearer ${SECRET}` },
        exitCode: 0,
      };
      const host = createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed",
              auditEventId: "audit-noward",
              result: rawResult,
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      });
      const coordinator = new ToolInvocationCoordinatorService(host);

      const result = await coordinator.invokeTool(createToolRequest());

      // No redact ward => the secret is preserved exactly as the tool produced it.
      expect(result.result).toEqual(rawResult);
      expect(JSON.stringify(result.result)).toContain(SECRET);
    });

    it("does not act on non-redact ward effects such as route_local (regression)", async () => {
      const rawResult = { stdout: `token=${SECRET}`, exitCode: 0 };
      const host = createHost({
        policyEngine: {
          invoke: vi.fn(
            async (): Promise<ToolInvokeResult> => ({
              outcome: "executed",
              policyReason: "allowed",
              auditEventId: "audit-routelocal",
              wardEffect: "route_local",
              result: rawResult,
            }),
          ),
          evaluateAccess: vi.fn(() => ({ allowed: true, requiresApproval: false, reasonCodes: [] })),
        },
      });
      const coordinator = new ToolInvocationCoordinatorService(host);

      const result = await coordinator.invokeTool(createToolRequest());

      expect(result.result).toEqual(rawResult);
      expect(JSON.stringify(result.result)).toContain(SECRET);
    });
  });
});

describe("capability-scope choke point (executeMcpRuntime)", () => {
  it("denies a scoped-out external MCP server on the model approval-replay path", async () => {
    const markExternalCallStarted = vi.fn();
    const invokeMcpRuntimeTool = vi.fn(async () => ({ ok: true, output: { payload: "ok" } }));
    const assertMcpServerInScope = vi.fn(() => {
      throw new PolicyViolationError({ code: "POLICY_BLOCKED", message: "scoped out" });
    });
    const host = createHost({ assertMcpServerInScope, invokeMcpRuntimeTool });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedMcpRuntime(
      {
        serverId: "srv-1",
        toolName: "tool.echo",
        workspaceId: "default",
      },
      markExternalCallStarted,
    );

    expect(result).toMatchObject({
      ok: false,
      reasonCodes: ["mcp_capability_scope_denied"],
      policyReason: "scoped out",
    });
    expect(assertMcpServerInScope).toHaveBeenCalledTimes(1);
    expect(markExternalCallStarted).not.toHaveBeenCalled();
    // Denied before the external runtime ever executes.
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });

  it("capability-gates internal MCP servers before approval-inbox dispatch", async () => {
    const assertMcpServerInScope = vi.fn(() => {
      throw new PolicyViolationError({ code: "POLICY_BLOCKED", message: "internal infra scoped out" });
    });
    const host = createHost({
      assertMcpServerInScope,
      requireMcpServer: vi.fn(() => createMcpServer({ url: MCP_APPROVAL_INBOX_URL })),
      // Register the inbox tool so resolveMcpRuntimeTarget succeeds and the call actually reaches
      // executeMcpRuntime (the choke point) — otherwise the exemption branch is never exercised.
      listMcpTools: vi.fn(() => [createMcpTool({ toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME })]),
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedMcpRuntime({
      serverId: "srv-1",
      toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
      workspaceId: "default",
    });
    expect(result).toMatchObject({
      ok: false,
      reasonCodes: ["mcp_capability_scope_denied"],
      policyReason: "internal infra scoped out",
    });
    expect(assertMcpServerInScope).toHaveBeenCalledTimes(1);
  });

  it("fails closed when MCP capability-scope wiring is unavailable", async () => {
    const invokeMcpRuntimeTool = vi.fn(async () => ({ ok: true, output: { payload: "ok" } }));
    const host = createHost({
      assertMcpServerInScope: undefined,
      invokeMcpRuntimeTool,
    });
    const coordinator = new ToolInvocationCoordinatorService(host);

    const result = await coordinator.invokeApprovedMcpRuntime({
      serverId: "srv-1",
      toolName: "tool.echo",
      workspaceId: "default",
    });

    expect(result).toMatchObject({
      ok: false,
      reasonCodes: ["mcp_capability_scope_unavailable"],
      policyReason: "blocked: MCP capability scope gate is not wired",
    });
    expect(invokeMcpRuntimeTool).not.toHaveBeenCalled();
  });
});

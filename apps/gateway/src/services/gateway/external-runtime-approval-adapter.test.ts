import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpInvokeRequest, McpInvokeResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { createMcpToolPolicyBinding } from "@goatcitadel/policy-engine";
import { createMeshChatCatalogFixture } from "./mesh-chat-catalog-test-fixtures.js";
import { resolveMeshChatToolSchemas } from "./mesh-chat-catalog.js";
import { dispatchMeshChatTool, type MeshChatDispatchPort } from "./mesh-chat-dispatch.js";
import {
  executeApprovedExternalRuntimePendingAction,
  type ApprovedExternalRuntimePendingActionPort,
  toolInvokeResultFromMcpApproval,
  toToolInvokeRequest,
  approvedExternalRuntimeRequestMatches,
} from "./external-runtime-approval-adapter.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("external runtime approval adapter", () => {
  it("preserves the protected turn, tool invocation and Citadel identity through approval replay", () => {
    const pending = { toolName: "session.status", args: {}, agentId: "assistant", sessionId: "session",
      turnId: "turn", toolRunId: "remote-tool:intent", citadelId: "citadel", workspaceId: "workspace" };
    const request = toToolInvokeRequest(pending);
    expect(request).toMatchObject(pending);
    expect(approvedExternalRuntimeRequestMatches(pending, request)).toBe(true);
    for (const field of ["turnId", "toolRunId", "citadelId"] as const) {
      expect(approvedExternalRuntimeRequestMatches(pending, { ...request, [field]: "another" })).toBe(false);
      expect(approvedExternalRuntimeRequestMatches(pending, { ...request, [field]: undefined })).toBe(false);
    }
  });
  function createHarness(label: string, request: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `goatcitadel-approved-runtime-adapter-${label}-`));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    cleanups.push(() => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const approval = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: { toolName: request.toolName },
      preview: { title: "Approve tool invocation" },
    });
    storage.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "tool.invoke",
      request,
    });
    const pending = storage.pendingApprovalActions.find(approval.approvalId);
    if (!pending) throw new Error("pending approval fixture was not created");
    return { storage, approvalId: approval.approvalId, pending };
  }

  function createPort(
    storage: Storage,
    overrides: Partial<ApprovedExternalRuntimePendingActionPort> = {},
  ): ApprovedExternalRuntimePendingActionPort {
    return {
      storage: createSqliteAsyncStorage(storage),
      executeApprovedAction: vi.fn(async () => undefined),
      enrichMcpInvokePolicyContext: vi.fn((input: McpInvokeRequest) => input),
      invokeApprovedMcpRuntime: vi.fn(async () => ({ ok: true, output: "mcp output" })),
      invokeApprovedExternalRuntimeTool: vi.fn(async () => ({
        outcome: "executed",
        policyReason: "external runtime executed",
        auditEventId: "audit-external",
      })),
      ...overrides,
    };
  }

  function toolRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      toolName: "local.mutate",
      args: { target: "record-1" },
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      ...overrides,
    };
  }

  it("executes a local approved action through the managed side-effect owner without inventing a boundary", async () => {
    const { storage, approvalId, pending } = createHarness("local", toolRequest());
    const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(
      async () => ({
        outcome: "executed",
        policyReason: "approved local action executed",
        auditEventId: "audit-local",
      }),
    );
    const port = createPort(storage, { executeApprovedAction });

    const result = await executeApprovedExternalRuntimePendingAction(port, approvalId, pending);

    expect(result).toMatchObject({ outcome: "executed", auditEventId: "audit-local" });
    expect(executeApprovedAction).toHaveBeenCalledWith(
      approvalId,
      undefined,
      expect.objectContaining({
        deferResolution: true,
        externalSideEffect: {
          markStarted: expect.any(Function),
          markNotRequired: expect.any(Function),
        },
      }),
    );
    expect(port.invokeApprovedMcpRuntime).not.toHaveBeenCalled();
    expect(port.invokeApprovedExternalRuntimeTool).not.toHaveBeenCalled();
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", externalCallStartedAt: undefined }),
    ]);
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ externalBoundaryState: "not_required" }) }),
    ]);
  });

  it("returns durable blocked truth when an external replay no longer has an executable policy result", async () => {
    const { storage, approvalId, pending } = createHarness(
      "stale-policy",
      toolRequest({ toolName: "plugin.mutate", externalRuntime: true }),
    );
    const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(
      async () => undefined,
    );
    const port = createPort(storage, { executeApprovedAction });

    const controller = new AbortController();
    const result = await executeApprovedExternalRuntimePendingAction(port, approvalId, pending, controller.signal);

    expect(result).toMatchObject({
      outcome: "blocked",
      policyReason: expect.stringMatching(/no longer matches executable pending state/i),
    });
    expect(executeApprovedAction).toHaveBeenCalledWith(approvalId, controller.signal, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(port.invokeApprovedMcpRuntime).not.toHaveBeenCalled();
    expect(port.invokeApprovedExternalRuntimeTool).not.toHaveBeenCalled();
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "failed" });
  });

  it("enriches policy truth and routes an approved MCP action through the MCP runtime", async () => {
    const { storage, approvalId, pending } = createHarness(
      "mcp",
      toolRequest({
        toolName: "mcp.invoke",
        args: { serverId: "server-1", toolName: "remote.create", arguments: { value: 7 } },
      }),
    );
    const policyResult: ToolInvokeResult = {
      outcome: "executed",
      policyReason: "allowed_via_approval",
      auditEventId: "audit-policy",
      wardEffect: "redact",
      result: {
        policyContext: { workspaceId: "workspace-1", matchedGrantAllowedHosts: ["mcp.example"] },
      },
    };
    const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(
      async () => policyResult,
    );
    const enrichMcpInvokePolicyContext = vi.fn((input: McpInvokeRequest) => ({
      ...input,
      surface: "mcp" as const,
    }));
    const invokeApprovedMcpRuntime = vi.fn<ApprovedExternalRuntimePendingActionPort["invokeApprovedMcpRuntime"]>(
      async (_input, markExternalCallStarted) => {
        await markExternalCallStarted?.();
        return { ok: true, output: "created" };
      },
    );
    const port = createPort(storage, {
      executeApprovedAction,
      enrichMcpInvokePolicyContext,
      invokeApprovedMcpRuntime,
    });

    const result = await executeApprovedExternalRuntimePendingAction(port, approvalId, pending);

    expect(enrichMcpInvokePolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-1",
        toolName: "remote.create",
        arguments: { value: 7 },
        policyContext: expect.objectContaining({ matchedGrantAllowedHosts: ["mcp.example"] }),
      }),
    );
    expect(invokeApprovedMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "mcp" }),
      expect.any(Function),
      { wardEffect: "redact" },
    );
    expect(result).toMatchObject({
      outcome: "executed",
      result: { externalRuntime: true, toolName: "mcp.invoke", ok: true, output: "created" },
    });
  });

  it.each(["allowed", "denied", "missing", "missing-runtime", "drift", "unknown", "legacy-flag"] as const)(
    "retains mesh identity, policy and effect truth through approved dispatch (%s)", async (scenario) => {
      const catalog = createMeshChatCatalogFixture();
      const [schema] = await resolveMeshChatToolSchemas(catalog.deps, { workspaceId: catalog.workspaceId, entries: [catalog.entry] });
      const binding = { schema: schema!, executionProfileSha256: "9".repeat(64) };
      const request = toolRequest({ toolName: catalog.capabilityId,
        externalRuntime: scenario === "legacy-flag" ? undefined : true, turnId: "turn", toolRunId: "tool-run",
        args: { query: "reviewed input", nodeId: "argument-only-node", approvalId: "argument-only-approval" } });
      const { storage, approvalId, pending } = createHarness(`mesh-${scenario}`, request);
      const resolveBinding = vi.fn<MeshChatDispatchPort["resolveBinding"]>(async () => scenario === "missing" ? undefined : binding);
      const policyResult: ToolInvokeResult = { outcome: scenario === "denied" ? "blocked" : "executed",
        policyReason: scenario === "denied" ? "current mesh deny" : "allowed_via_approval", auditEventId: "audit-mesh" };
      const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(async () => {
        if (scenario === "drift") resolveBinding.mockResolvedValue(undefined);
        return policyResult;
      });
      const dispatch = vi.fn<MeshChatDispatchPort["dispatch"]>(async (_input, options) => {
        await options?.executionFence?.();
        expect(storage.externalSideEffectRuns.listByWorkspace(catalog.workspaceId)[0]?.externalCallStartedAt).toBeDefined();
        return { invocationId: "mesh-invocation", disposition: scenario === "unknown" ? "unknown" : "succeeded",
          settled: true, deliveryUncertain: scenario === "unknown", manualReconciliationRequired: scenario === "unknown",
          output: { status: "ok" }, receipt: {
            invocationId: "mesh-invocation", capabilityId: catalog.capabilityId, nodeId: catalog.binding.nodeId,
            activationId: catalog.binding.activationId, activationRevision: catalog.binding.activationRevision,
            publisherGeneration: catalog.binding.publisherGeneration, publicationLeaseFencingToken: catalog.binding.publicationLeaseFencingToken,
            inputSha256: "1".repeat(64), deadlineAt: "2099-01-01T00:00:00.000Z",
          } };
      });
      const invokeApprovedMeshRuntime = vi.fn<NonNullable<ApprovedExternalRuntimePendingActionPort["invokeApprovedMeshRuntime"]>>(
        (input, policy, id, markStarted) => dispatchMeshChatTool({ resolveBinding, dispatch }, input, policy, {
          approvalId: id, markExternalCallStarted: markStarted,
        }),
      );
      const port = createPort(storage, { resolveMeshChatToolBinding: (input) => resolveBinding(input, undefined), executeApprovedAction,
        ...(scenario === "missing-runtime" ? {} : { invokeApprovedMeshRuntime }) });
      const call = executeApprovedExternalRuntimePendingAction(port, approvalId, pending);
      if (["missing", "missing-runtime", "drift"].includes(scenario)) {
        await expect(call).rejects.toThrow(/frozen target/);
        expect(dispatch).not.toHaveBeenCalled();
        if (scenario !== "drift") expect(executeApprovedAction).not.toHaveBeenCalled();
        expect(storage.externalSideEffectRuns.listByWorkspace(catalog.workspaceId)[0]?.externalCallStartedAt).toBeUndefined();
        return;
      }
      const result = await call;
      expect(executeApprovedAction).toHaveBeenCalledExactlyOnceWith(approvalId, undefined, {
        deferResolution: true, externalRuntimeReplay: true, meshToolBinding: schema!.policyBinding,
      });
      expect(port.invokeApprovedMcpRuntime).not.toHaveBeenCalled();
      expect(port.invokeApprovedExternalRuntimeTool).not.toHaveBeenCalled();
      if (scenario === "denied") {
        expect(result.outcome).toBe("blocked");
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          approvalId, capabilityId: catalog.capabilityId, binding: catalog.binding, args: request.args,
          sessionId: "session-1", turnId: "turn", toolRunId: "tool-run", executionProfileSha256: binding.executionProfileSha256,
        }), expect.any(Object));
        expect(result).toMatchObject({ outcome: "executed", result: { toolName: catalog.capabilityId,
          ...(scenario === "unknown" ? { externalOutcome: "unknown_after_send", manualReconciliationRequired: true } : { ok: true }),
        } });
        if (scenario === "unknown") expect(result.result).not.toHaveProperty("output");
        expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ externalBoundaryState: "crossed" }) }),
        ]);
        const replay = await executeApprovedExternalRuntimePendingAction(port, approvalId, pending);
        expect(replay).toEqual(result);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(executeApprovedAction).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["allowed", "denied", "missing", "drift", "unknown"] as const)(
    "retains the native MCP request through approval replay (%s)", async (scenario) => {
      const nativeToolName = "mcp.server.with.dots.tool.echo";
      const request = toolRequest({ toolName: nativeToolName, externalRuntime: true, turnId: "turn", toolRunId: "tool-run",
        args: { serverId: "native data", toolName: "native data", value: "reviewed" } });
      const { storage, approvalId, pending } = createHarness(`native-${scenario}`, request);
      const policyBinding = createMcpToolPolicyBinding({ canonicalName: nativeToolName,
        serverId: "server.with.dots", nativeToolName: "tool.echo" });
      const target = { serverId: "server.with.dots", nativeToolName: "tool.echo", policyBinding };
      const resolveBinding = vi.fn<NonNullable<ApprovedExternalRuntimePendingActionPort["resolveNativeMcpChatToolBinding"]>>(
        async () => scenario === "missing" ? undefined : target,
      );
      if (scenario === "drift") resolveBinding.mockResolvedValueOnce(target).mockResolvedValueOnce(undefined);
      const policyResult: ToolInvokeResult = { outcome: scenario === "denied" ? "blocked" : "executed",
        policyReason: scenario === "denied" ? "current native deny" : "allowed_via_approval", auditEventId: "audit-native" };
      const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(async () => policyResult);
      const transport = vi.fn<ApprovedExternalRuntimePendingActionPort["invokeApprovedMcpRuntime"]>(async (_input, markStarted) => {
        await markStarted?.();
        return scenario === "unknown"
          ? { ok: false, error: "connection lost after send", externalOutcome: "unknown_after_send", manualReconciliationRequired: true }
          : { ok: true, output: "native response" };
      });
      const port = createPort(storage, { resolveNativeMcpChatToolBinding: resolveBinding,
        executeApprovedAction, invokeApprovedMcpRuntime: transport });
      const call = executeApprovedExternalRuntimePendingAction(port, approvalId, pending);
      if (scenario === "missing" || scenario === "drift") {
        await expect(call).rejects.toThrow(/frozen target binding|target binding drifted/);
        expect(transport).not.toHaveBeenCalled();
        if (scenario === "missing") expect(executeApprovedAction).not.toHaveBeenCalled();
        return;
      }
      const result = await call;
      expect(executeApprovedAction).toHaveBeenCalledExactlyOnceWith(approvalId, undefined, {
        deferResolution: true, externalRuntimeReplay: true, mcpToolBinding: policyBinding,
      });
      expect(port.invokeApprovedExternalRuntimeTool).not.toHaveBeenCalled();
      if (scenario === "denied") {
        expect(result.outcome).toBe("blocked");
        expect(transport).not.toHaveBeenCalled();
        expect(resolveBinding).toHaveBeenCalledTimes(1);
      } else {
        expect(resolveBinding).toHaveBeenCalledTimes(2);
        expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          serverId: "server.with.dots", toolName: "tool.echo", arguments: request.args,
        }), expect.any(Function), { wardEffect: undefined });
        expect(result).toMatchObject({ outcome: "executed", result: { toolName: nativeToolName,
          ...(scenario === "unknown" ? { externalOutcome: "unknown_after_send", manualReconciliationRequired: true } : { ok: true }),
        } });
        expect(storage.pendingApprovalActions.find(approvalId)?.request).toMatchObject(request);
      }
    },
  );

  it("routes a non-MCP external runtime only after replay policy and records the concrete boundary", async () => {
    const { storage, approvalId, pending } = createHarness(
      "external",
      toolRequest({ toolName: "plugin.mutate", externalRuntime: true }),
    );
    const policyResult: ToolInvokeResult = {
      outcome: "executed",
      policyReason: "allowed_via_approval",
      auditEventId: "audit-policy",
      result: { policyContext: { workspaceId: "workspace-1", operatorId: "operator-1" } },
    };
    const executeApprovedAction = vi.fn<ApprovedExternalRuntimePendingActionPort["executeApprovedAction"]>(
      async () => policyResult,
    );
    const invokeApprovedExternalRuntimeTool = vi.fn<
      ApprovedExternalRuntimePendingActionPort["invokeApprovedExternalRuntimeTool"]
    >(async (request: ToolInvokeRequest, markExternalCallStarted?: () => void) => {
      markExternalCallStarted?.();
      return {
        outcome: "executed",
        policyReason: `external runtime executed for ${request.policyContext?.operatorId}`,
        auditEventId: "audit-external",
      };
    });
    const port = createPort(storage, { executeApprovedAction, invokeApprovedExternalRuntimeTool });

    const controller = new AbortController();
    const result = await executeApprovedExternalRuntimePendingAction(port, approvalId, pending, controller.signal);

    expect(executeApprovedAction).toHaveBeenCalledWith(approvalId, controller.signal, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(invokeApprovedExternalRuntimeTool).toHaveBeenCalledWith(
      expect.objectContaining({ policyContext: expect.objectContaining({ operatorId: "operator-1" }) }),
      expect.any(Function),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ outcome: "executed", auditEventId: "audit-external" });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", externalCallStartedAt: expect.any(String) }),
    ]);
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ externalBoundaryState: "crossed" }) }),
    ]);
  });

  it("does not collapse an ambiguous approved MCP mutation into a plain blocked outcome", () => {
    const policyResult: ToolInvokeResult = {
      outcome: "executed",
      policyReason: "allowed_via_approval:approval-mcp-unknown",
      auditEventId: "audit-mcp-unknown",
      result: { externalRuntime: true, toolName: "mcp.invoke" },
    };
    const mcpResult = {
      ok: false,
      error:
        "MCP tool external.create_record unknown_after_send: the tool call was dispatched, but its final outcome is unknown; manual reconciliation is required.",
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
    } as McpInvokeResponse & {
      externalOutcome: "unknown_after_send";
      manualReconciliationRequired: true;
    };

    const result = toolInvokeResultFromMcpApproval(policyResult, mcpResult);

    expect(result).toMatchObject({
      outcome: "executed",
      policyReason: expect.stringMatching(/unknown|manual reconciliation/i),
      result: {
        externalRuntime: true,
        toolName: "mcp.invoke",
        ok: false,
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
      },
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpInvokeRequest, McpInvokeResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import {
  executeApprovedExternalRuntimePendingAction,
  type ApprovedExternalRuntimePendingActionPort,
  toolInvokeResultFromMcpApproval,
} from "./external-runtime-approval-adapter.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("external runtime approval adapter", () => {
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
      storage,
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
        markExternalCallStarted?.();
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
    );
    expect(result).toMatchObject({
      outcome: "executed",
      result: { externalRuntime: true, toolName: "mcp.invoke", ok: true, output: "created" },
    });
  });

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

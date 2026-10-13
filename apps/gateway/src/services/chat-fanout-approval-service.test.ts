import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { resumeChatFanoutApprovals } from "./chat-fanout-approval-service.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const requestContent = { content: "Delegate two checks" };
  const materialSha256 = hash({ version: 2, request: requestContent });
  const actor = {
    actorKind: "operator",
    actorId: "actor",
    operatorId: "actor",
    authActorId: "actor",
    authActorSource: "token",
  };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    admissionMaterialSha256: materialSha256,
    effectiveRequestMaterialSha256: hash({
      version: 1,
      admissionMaterialSha256: materialSha256,
      request: requestContent,
    }),
    requestActor: actor,
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: requestContent,
  };
  const request = {
    toolName: "agent.fanout",
    args: { subtasks: [{ objective: "Check" }] },
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    toolRunId: "tool",
    runId: "run",
    policyContext: actor,
  };
  const tool = {
    ...request,
    status: "approval_required",
    approvalId: "approval",
    result: undefined as Record<string, unknown> | undefined,
  };
  const pending = {
    actionType: "tool.invoke",
    request: { ...request },
    resolutionStatus: "pending",
    result: undefined as Record<string, unknown> | undefined,
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", status: "running", payload };
  const result = {
    outcome: "executed" as const,
    policyReason: "allowed",
    auditEventId: "audit",
    result: {
      status: "waiting",
      fanoutInvocationId: "fanout",
      parentRunId: "run",
      toolRunId: "tool",
    },
  };
  const canonicalResult = { ...result.result };
  const assertFence = vi.fn(async () => undefined);
  const input = {
    sessionId: "session",
    turnId: "turn",
    workspaceId: "workspace",
    canonicalDurableRunId: "run",
    authActorId: "actor",
    authActorSource: "token",
    subagentPolicy: "auto_when_useful",
    canonicalWriteFence: async <T>(work: () => Promise<T>) => {
      await assertFence();
      return await work();
    },
  };
  const host = {
    storage: {
      durableRuns: { getRun: vi.fn(async () => run) },
      sessionMutationAdmissions: {},
      chatToolRuns: {
        listByTurn: vi.fn(async () => [tool]),
        patch: vi.fn(async (_id, patch) => Object.assign(tool, patch)),
      },
      approvals: { get: vi.fn(async () => ({ status: "approved", linkage: { ...request } })) },
      pendingApprovalActions: { find: vi.fn(async () => pending) },
      chatInlineApprovals: { get: vi.fn(async () => undefined), upsert: vi.fn() },
      chatFanoutInvocations: { findByParentAndTool: vi.fn(async () => ({ invocationId: "fanout" })) },
    },
    refreshPolicy: vi.fn(async () => undefined),
    executeApprovedAction: vi.fn(async (_id: string, beforeExecute: () => Promise<void>) => {
      await beforeExecute();
      pending.resolutionStatus = "executed";
      pending.result = result;
      return result;
    }),
    readToolResult: vi.fn(async () => canonicalResult),
  };
  const resume = () => resumeChatFanoutApprovals(host as never, input as never);
  return { host, input, pending, tool, run, result, canonicalResult, assertFence, resume };
}

describe("durable fanout approval continuation", () => {
  it("executes only through the exact approved pending action and refreshes its original result after child settlement", async () => {
    const f = fixture();
    await f.resume();
    expect(f.host.executeApprovedAction).toHaveBeenCalledOnce();
    expect(f.tool.status).toBe("executed");
    f.canonicalResult.status = "completed";
    await f.resume();
    expect(f.host.executeApprovedAction).toHaveBeenCalledOnce();
    expect(f.tool.result?.status).toBe("completed");
  });
  it.each(["args", "actor", "run", "turn", "claim"])("refuses %s drift before approved dispatch", async (drift) => {
    const f = fixture();
    if (drift === "args") f.pending.request.args = { subtasks: [{ objective: "Changed" }] };
    if (drift === "actor")
      f.pending.request.policyContext = { ...f.pending.request.policyContext, authActorId: "foreign" };
    if (drift === "run") f.pending.request.runId = "foreign";
    if (drift === "turn") f.pending.request.turnId = "foreign";
    if (drift === "claim") f.assertFence.mockRejectedValue(new Error("claim lost"));
    await expect(f.resume()).rejects.toThrow();
    expect(f.host.executeApprovedAction).not.toHaveBeenCalled();
  });
  it("rechecks a claim lost after policy refresh and never dispatches", async () => {
    const f = fixture();
    f.host.refreshPolicy.mockImplementation(async () => {
      f.assertFence.mockRejectedValue(new Error("claim lost"));
    });
    await expect(f.resume()).rejects.toThrow("claim lost");
    expect(f.host.executeApprovedAction).not.toHaveBeenCalled();
  });
  it("materializes a retained terminal policy receipt without replaying its dispatch", async () => {
    const f = fixture();
    f.pending.resolutionStatus = "executed";
    f.pending.result = f.result;
    await f.resume();
    expect(f.tool.status).toBe("executed");
    expect(f.host.executeApprovedAction).not.toHaveBeenCalled();
  });
  it("does not treat an edited, withdrawn approval as dispatch authority", async () => {
    const f = fixture();
    f.host.storage.approvals.get.mockResolvedValue({ status: "edited", linkage: { ...f.pending.request } });
    await f.resume();
    expect(f.host.executeApprovedAction).not.toHaveBeenCalled();
    expect(f.host.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });
  it("rejects a forged terminal receipt before materializing the tool", async () => {
    const f = fixture();
    f.pending.resolutionStatus = "executed";
    f.pending.result = { ...f.result, result: { ...f.result.result, fanoutInvocationId: "foreign" } };
    await expect(f.resume()).rejects.toThrow("exact canonical aggregate");
    expect(f.host.executeApprovedAction).not.toHaveBeenCalled();
    expect(f.host.storage.chatToolRuns.patch).not.toHaveBeenCalled();
  });
});

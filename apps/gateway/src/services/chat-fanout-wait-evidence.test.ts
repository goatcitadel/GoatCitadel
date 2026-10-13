import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE } from "./chat-fanout-admission-reference.js";
import { hasDurableFanoutWaitingEvidence } from "./chat-fanout-wait-evidence.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const request = { content: "Delegate two checks" };
  const materialSha256 = hash({ version: 2, request });
  const featureReferenceSha256 = "a".repeat(64);
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
    effectiveRequestMaterialSha256: hash({ version: 1, admissionMaterialSha256: materialSha256, request }),
    featureReferenceSha256,
    requestActor: { actorKind: "operator", actorId: "actor" },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const run = { runId: "run", workflowKey: "chat.turn.execute", payload };
  const trace = { status: "waiting_for_tool", turnId: "turn", sessionId: "session", durable: { runId: "run" } };
  const tool = {
    toolName: "agent.fanout",
    toolRunId: "tool",
    status: "executed",
    turnId: "turn",
    sessionId: "session",
    result: { status: "waiting", fanoutInvocationId: "fanout", parentRunId: "run", toolRunId: "tool" },
  };
  const invocation = {
    invocationId: "fanout",
    parentRunId: "run",
    toolRunId: "tool",
    sessionId: "session",
    workspaceId: "workspace",
    delegationRunId: "delegation",
    status: "waiting",
    childCount: 1,
    parentAdmission: {
      admissionId: "admission",
      sessionIncarnationId: "incarnation",
      materialSha256,
      featureReferenceSha256,
    },
  };
  const delegation = {
    runId: "delegation",
    parentRunId: "run",
    sessionId: "session",
    executionPlanId: "fanout",
    workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
  };
  const step = {
    stepId: "step",
    status: "running",
    durableRunId: "child",
    childSessionId: "child-session",
    childTurnId: "child-turn",
  };
  const watcher = {
    parentRunId: "run",
    childRunId: "child",
    source: "chat_delegation",
    metadata: {
      delegationRunId: "delegation",
      stepId: "step",
      childSessionId: "child-session",
      childTurnId: "child-turn",
    },
  };
  const storage = {
    chatFanoutInvocations: { findByParentAndTool: vi.fn(async () => invocation) },
    chatDelegationRuns: { get: vi.fn(async () => delegation) },
    chatDelegationSteps: { listByRun: vi.fn(async () => [step]) },
    durableChildWatchers: { get: vi.fn(async () => watcher) },
  };
  const check = (requireSettled = false) =>
    hasDurableFanoutWaitingEvidence(storage as never, run as never, trace as never, [tool] as never, {
      requireSettled,
    });
  return { run, trace, tool, invocation, delegation, step, watcher, storage, check };
}

describe("canonical automatic fanout wait evidence", () => {
  it("recognizes the exact retained invocation and child watcher without dispatching", async () => {
    const f = fixture();
    await expect(f.check()).resolves.toBe(true);
    expect(f.storage.chatFanoutInvocations.findByParentAndTool).toHaveBeenCalledWith("run", "tool");
    expect(f.storage.durableChildWatchers.get).toHaveBeenCalledWith("delegation-child:step");
  });
  it.each([
    "trace run",
    "tool reference",
    "admission",
    "material",
    "feature reference",
    "delegation",
    "child count",
    "watcher",
    "child turn",
  ])("refuses %s drift", async (drift) => {
    const f = fixture();
    if (drift === "trace run") f.trace.durable.runId = "foreign";
    if (drift === "tool reference") f.tool.result.fanoutInvocationId = "foreign";
    if (drift === "admission") f.invocation.parentAdmission.admissionId = "foreign";
    if (drift === "material") f.invocation.parentAdmission.materialSha256 = "b".repeat(64);
    if (drift === "feature reference") f.invocation.parentAdmission.featureReferenceSha256 = "b".repeat(64);
    if (drift === "delegation") f.delegation.parentRunId = "foreign";
    if (drift === "child count") f.invocation.childCount = 2;
    if (drift === "watcher") f.watcher.childRunId = "foreign";
    if (drift === "child turn") f.watcher.metadata.childTurnId = "foreign";
    await expect(f.check()).resolves.toBe(false);
  });
  it("allows a failed-before-admission child without inventing a watcher", async () => {
    const f = fixture();
    Object.assign(f.step, { durableRunId: undefined, status: "failed" });
    await expect(f.check()).resolves.toBe(true);
    expect(f.storage.durableChildWatchers.get).not.toHaveBeenCalled();
    f.step.status = "running";
    await expect(f.check()).resolves.toBe(false);
  });
  it("does not turn a pending approval into a tool wait", async () => {
    const f = fixture();
    f.tool.status = "approval_required";
    await expect(f.check()).resolves.toBe(false);
    expect(f.storage.chatFanoutInvocations.findByParentAndTool).not.toHaveBeenCalled();
  });
  it("permits continuation only once the exact aggregate is terminal", async () => {
    const f = fixture();
    await expect(f.check(true)).resolves.toBe(false);
    f.invocation.status = "completed";
    await expect(f.check(true)).resolves.toBe(false);
    f.step.status = "completed";
    await expect(f.check(true)).resolves.toBe(true);
    f.watcher.childRunId = "foreign";
    await expect(f.check(true)).resolves.toBe(false);
  });
});

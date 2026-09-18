import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { retainRemoteWorkerChatApprovalWait, findRemoteWorkerChatApprovalWait } from "./remote-worker-chat-approval-wait.js";

const stores: Storage[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const db = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." }); stores.push(db);
  const scope = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1,
    workspaceId: "workspace", taskId: "task", durableRunId: "parent", sessionId: "session", turnId: "turn" };
  const create = (approvalId: string) => {
    const { approval } = db.approvals.createDeterministicDetachedWithTtlDuration({ approvalId,
      kind: "remote_worker.native_runtime", riskLevel: "danger", preview: {},
      payload: { nativeRuntime: { registryWorkspaceId: scope.registryWorkspaceId, assignmentId: scope.assignmentId, assignmentGeneration: scope.assignmentGeneration } },
      linkage: { workspaceId: scope.workspaceId, taskId: scope.taskId, durableRunId: scope.durableRunId,
        sessionId: scope.sessionId, turnId: scope.turnId, actionType: "remote_worker.native_runtime" } }, 60_000);
    db.approvalWaitRuns.createOrGet({ approvalId, runId: `wait-${approvalId}` }); return approval;
  };
  const approval = create("review");
  const trace = { sessionId: "session", durable: { runId: "parent" } };
  const upsert = vi.fn(async () => undefined), patchIfStatus = vi.fn(async () => trace);
  const asyncStorage = createSqliteAsyncStorage(db);
  const storage = { approvals: asyncStorage.approvals, approvalWaitRuns: asyncStorage.approvalWaitRuns,
    remoteWorkerEffects: { listIntents: async () => [] },
    chatInlineApprovals: { get: async () => undefined, upsert }, chatTurnTraces: { get: async () => trace, patchIfStatus } };
  const current = { assignment: { registryWorkspaceId: "registry", assignmentId: "assignment", manifest: {
    executionWorkspaceId: "workspace", taskId: "task", durableRunId: "parent", sessionId: "session", turnId: "turn" } }, generation: { assignmentGeneration: 1 } };
  return { db, scope, create, approval, trace, storage, current, upsert, patchIfStatus };
}
describe("persisted native review Chat pause", () => {
  it("discovers a pending review without an executable cache and retains the Chat approval pause", async () => {
    const f = fixture();
    const result = await retainRemoteWorkerChatApprovalWait(f.storage as never, f.current as never);
    expect(result?.approvalId).toBe("review");
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", sessionId: "session", turnId: "turn" }));
    expect(f.patchIfStatus).toHaveBeenCalledWith("turn", expect.any(Array), { status: "waiting_for_approval" });
    expect((await findRemoteWorkerChatApprovalWait(f.storage as never, f.current as never))?.summary.approvalId).toBe("review");
  });
  it.each(["approve", "reject"] as const)("retains a decision that %s resolves before the parent's first pause", async decision => {
    const f = fixture(); f.db.approvals.resolve("review", { decision, resolvedBy: "operator" });
    expect(await findRemoteWorkerChatApprovalWait(f.storage as never, f.current as never)).toBeUndefined();
    expect((await retainRemoteWorkerChatApprovalWait(f.storage as never, f.current as never))?.approvalId).toBe("review");
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ status: decision === "approve" ? "approved" : "denied" }));
  });
  it("does not rediscover a settled wait", async () => {
    const f = fixture(); f.db.approvalWaitRuns.markResolved("review");
    expect(await retainRemoteWorkerChatApprovalWait(f.storage as never, f.current as never)).toBeUndefined();
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(["registryWorkspaceId", "assignmentId", "assignmentGeneration", "workspaceId", "taskId", "durableRunId", "sessionId", "turnId"] as const)(
    "does not find another %s scope", key => {
      const f = fixture();
      expect(f.db.approvalWaitRuns.findUnresolvedNativeForAssignment({ ...f.scope, [key]: key === "assignmentGeneration" ? 2 : "other" })).toBeUndefined();
    });
  it("refuses ambiguous unresolved reviews instead of choosing a launch", async () => {
    const f = fixture(); f.create("second");
    await expect(retainRemoteWorkerChatApprovalWait(f.storage as never, f.current as never)).rejects.toThrow("Multiple unresolved");
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("refuses a replaced Chat trace before writing projections", async () => {
    const f = fixture(); f.trace.durable.runId = "different-parent";
    await expect(retainRemoteWorkerChatApprovalWait(f.storage as never, f.current as never)).rejects.toThrow("canonical parent");
    expect(f.upsert).not.toHaveBeenCalled();
  });
});

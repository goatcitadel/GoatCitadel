import { describe, expect, it, vi } from "vitest";
import type { PendingApprovalAction } from "@goatcitadel/contracts";
import {
  assertLocalApprovedActionOwner,
  RemoteWorkerApprovalResumeRequiredError,
} from "./remote-worker-approved-action-guard.js";

function fixture() {
  const pending: PendingApprovalAction = {
    approvalId: "approval", actionType: "tool.invoke", resolutionStatus: "pending",
    createdAt: "2026-09-09T00:00:00.000Z",
    request: { toolName: "fs.write", runId: "run", turnId: "turn" },
  };
  const storage = {
    approvals: { get: vi.fn(async () => ({ linkage: {
      workspaceId: "workspace", sessionId: "session", turnId: "turn", runId: "run",
    } })) },
    chatToolRuns: { listByTurn: vi.fn(async () => [] as Array<{ toolRunId: string; approvalId: string }>) },
    chatExecutionPlacements: { get: vi.fn(async (): Promise<{ executionKind: "local" | "remote_worker" } | undefined> =>
      ({ executionKind: "local" })) },
    remoteWorkerAssignments: { findTaskBoundChatAssignment: vi.fn(async () => undefined as object | undefined) },
  };
  const check = () => assertLocalApprovedActionOwner(storage as never, pending.approvalId, pending);
  return { pending, storage, check };
}

describe("remote worker ownership at the ordinary approved-action executor", () => {
  it("preserves ordinary local approvals and ignores an unrelated worker tool", async () => {
    const f = fixture();
    f.storage.chatToolRuns.listByTurn.mockResolvedValue([{ toolRunId: "remote-tool:other", approvalId: "another-approval" }]);
    await expect(f.check()).resolves.toBeUndefined();
    expect(f.storage.chatExecutionPlacements.get).toHaveBeenCalledWith("run");
  });

  it("refuses an exact remote tool before it can fall back to ordinary approval execution", async () => {
    const f = fixture();
    f.storage.chatToolRuns.listByTurn.mockResolvedValue([{ toolRunId: "remote-tool:intent", approvalId: "approval" }]);
    await expect(f.check()).rejects.toBeInstanceOf(RemoteWorkerApprovalResumeRequiredError);
  });

  it("refuses remote placement before a pending tool has been linked back to its approval", async () => {
    const f = fixture();
    f.storage.chatExecutionPlacements.get.mockResolvedValue({ executionKind: "remote_worker" });
    await expect(f.check()).rejects.toThrow("local replay is unavailable");
  });

  it("retains historical worker assignment ownership without a placement record", async () => {
    const f = fixture();
    f.storage.chatExecutionPlacements.get.mockResolvedValue(undefined);
    f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment.mockResolvedValue({ assignment: {} });
    await expect(f.check()).rejects.toThrow("resumed worker execution owner");
    expect(f.storage.remoteWorkerAssignments.findTaskBoundChatAssignment).toHaveBeenCalledWith({
      executionWorkspaceId: "workspace", sessionId: "session", turnId: "turn", durableRunId: "run",
    });
  });

  it("checks canonical approval linkage even when the retained request omits its run and turn", async () => {
    const f = fixture();
    f.pending.request = { toolName: "fs.write" };
    f.storage.chatExecutionPlacements.get.mockResolvedValue({ executionKind: "remote_worker" });
    await expect(f.check()).rejects.toThrow("resumed worker execution owner");
  });

  it("does not interpret an unavailable owner as local permission", async () => {
    const f = fixture();
    f.storage.chatExecutionPlacements.get.mockRejectedValue(new Error("canonical owner unavailable"));
    await expect(f.check()).rejects.toThrow("canonical owner unavailable");
  });
});

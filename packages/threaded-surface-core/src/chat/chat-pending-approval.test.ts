import { describe, expect, it } from "vitest";
import { deriveThreadPendingApproval, isApprovalForCancelledTurn, mergePendingApproval } from "./chat-pending-approval";

function threadWithStatus(status: string, toolRuns: unknown[]) {
  return {
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        trace: {
          status,
          failure: { message: "Trace failed" },
          toolRuns,
        },
      },
    ],
  };
}

describe("chat-pending-approval", () => {
  it("recognizes only approvals linked to a cancelled turn when filtering stale queue snapshots", () => {
    const runs = [{ status: "approval_required", approvalId: "approval-stopped" }];
    expect(isApprovalForCancelledTurn(threadWithStatus("cancelled", runs) as never, "approval-stopped")).toBe(true);
    expect(isApprovalForCancelledTurn(threadWithStatus("cancelled", runs) as never, "another-approval")).toBe(false);
    expect(isApprovalForCancelledTurn(threadWithStatus("completed", runs) as never, "approval-stopped")).toBe(false);
    expect(isApprovalForCancelledTurn(null, "approval-stopped")).toBe(false);
  });
  it("derives pending approvals from the selected waiting turn", () => {
    expect(deriveThreadPendingApproval(null)).toBeNull();
    expect(deriveThreadPendingApproval(threadWithStatus("completed", []) as never)).toBeNull();
    expect(deriveThreadPendingApproval(threadWithStatus("waiting_for_approval", []) as never)).toBeNull();
    expect(
      deriveThreadPendingApproval({ selectedTurnId: null, activeLeafTurnId: null, turns: [] } as never),
    ).toBeNull();

    expect(
      deriveThreadPendingApproval(
        threadWithStatus("waiting_for_approval", [
          { toolRunId: "old", status: "approval_required", approvalId: "approval-old", toolName: "old" },
          {
            toolRunId: "new",
            status: "approval_required",
            approvalId: "approval-new",
            toolName: "fs.write",
            failureGuidance: "Review file write.",
          },
        ]) as never,
      ),
    ).toEqual({
      approvalId: "approval-new",
      kind: "tool.invoke",
      toolName: "fs.write",
      reason: "Review file write.",
    });

    expect(
      deriveThreadPendingApproval({
        selectedTurnId: "missing",
        activeLeafTurnId: "also-missing",
        turns: [
          {
            turnId: "turn-last",
            trace: {
              status: "waiting_for_approval",
              failure: { message: "Fallback failure" },
              toolRuns: [{ status: "approval_required", approvalId: "approval-last", toolName: "shell.exec" }],
            },
          },
        ],
      } as never),
    ).toMatchObject({ approvalId: "approval-last", reason: "Fallback failure" });
  });

  it("merges pending approval queue records without losing richer details", () => {
    const current = {
      approvalId: "approval-1",
      kind: "tool.invoke",
      toolName: "fs.write",
      reason: "Current reason",
      riskLevel: "danger",
      expiresAt: "2026-05-04T12:00:00.000Z",
      codeHash: "code",
      wrapperManifestHash: "wrapper",
      capabilitySnapshotId: "snapshot",
      inspectPath: "src/file.ts",
      requestedOutputIntent: "patch",
      saveCandidateOnSuccess: true,
      remainingCount: 2,
      affectedResources: ["src/file.ts"],
      codePreview: "diff",
    } as const;

    expect(mergePendingApproval(current, null)).toBe(current);
    expect(mergePendingApproval(null, current)).toBe(current);
    expect(mergePendingApproval(current, { approvalId: "approval-2" })).toEqual({ approvalId: "approval-2" });
    expect(
      mergePendingApproval(current, { approvalId: "approval-1", toolName: "fs.write", reason: "Current reason" }),
    ).toBe(current);
    expect(
      mergePendingApproval(current, {
        approvalId: "approval-1",
        kind: "tool.invoke",
        toolName: "shell.exec",
        reason: "Next reason",
      }),
    ).toEqual({
      ...current,
      toolName: "shell.exec",
      reason: "Next reason",
    });
    expect(
      mergePendingApproval(current, {
        approvalId: "approval-1",
        toolName: undefined,
        reason: undefined,
        riskLevel: undefined,
        expiresAt: undefined,
        codeHash: undefined,
        wrapperManifestHash: undefined,
        capabilitySnapshotId: undefined,
        inspectPath: undefined,
        requestedOutputIntent: undefined,
        saveCandidateOnSuccess: undefined,
        remainingCount: undefined,
        affectedResources: undefined,
        codePreview: undefined,
      }),
    ).toEqual(current);
  });
});

import { describe, expect, it } from "vitest";
import { deriveThreadPendingApproval, mergePendingApproval, type PendingApprovalRecord } from "./chat-pending-approval";

function thread(overrides: Record<string, unknown> = {}) {
  return {
    selectedTurnId: "turn-selected",
    activeLeafTurnId: "turn-leaf",
    turns: [
      {
        turnId: "turn-selected",
        trace: {
          status: "waiting_for_approval",
          failure: { message: "Approval required by policy" },
          toolRuns: [
            {
              status: "completed",
              toolName: "browser.search",
            },
            {
              status: "approval_required",
              toolName: "filesystem.write",
              approvalId: "approval-selected",
              failureGuidance: "Review filesystem write",
            },
          ],
        },
      },
    ],
    ...overrides,
  } as any;
}

describe("chat-pending-approval", () => {
  it("derives the latest approval-required tool run from the selected turn", () => {
    expect(deriveThreadPendingApproval(null)).toBeNull();
    expect(deriveThreadPendingApproval(thread())).toEqual({
      approvalId: "approval-selected",
      kind: "tool.invoke",
      toolName: "filesystem.write",
      reason: "Review filesystem write",
    });
  });

  it("falls back to active or leaf turns and failure messages when guidance is absent", () => {
    expect(
      deriveThreadPendingApproval(
        thread({
          selectedTurnId: "missing",
          activeLeafTurnId: "turn-leaf",
          turns: [
            {
              turnId: "turn-leaf",
              trace: {
                status: "waiting_for_approval",
                failure: { message: "Fallback reason" },
                toolRuns: [
                  {
                    status: "approval_required",
                    toolName: "shell.exec",
                    approvalId: "approval-leaf",
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      approvalId: "approval-leaf",
      toolName: "shell.exec",
      reason: "Fallback reason",
    });

    expect(
      deriveThreadPendingApproval(
        thread({
          selectedTurnId: undefined,
          activeLeafTurnId: undefined,
          turns: [
            {
              turnId: "turn-final",
              trace: {
                status: "waiting_for_approval",
                toolRuns: [
                  {
                    status: "approval_required",
                    toolName: "terminal.run",
                    approvalId: "approval-final",
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ approvalId: "approval-final" });
  });

  it("returns null for non-blocked turns or incomplete approval tool runs", () => {
    expect(
      deriveThreadPendingApproval(
        thread({
          turns: [
            {
              turnId: "turn-selected",
              trace: {
                status: "completed",
                toolRuns: [],
              },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      deriveThreadPendingApproval(
        thread({
          turns: [
            {
              turnId: "turn-selected",
              trace: {
                status: "waiting_for_approval",
                toolRuns: [{ status: "approval_required", toolName: "shell.exec" }],
              },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("merges pending approval updates without losing existing metadata", () => {
    const current: PendingApprovalRecord = {
      approvalId: "approval-1",
      kind: "tool.invoke",
      toolName: "filesystem.write",
      reason: "Old reason",
      riskLevel: "danger",
      expiresAt: "2026-05-14T12:00:00.000Z",
      codeHash: "code-1",
      wrapperManifestHash: "manifest-1",
      capabilitySnapshotId: "capability-1",
      inspectPath: "F:/code/personal-ai",
      requestedOutputIntent: "patch",
      saveCandidateOnSuccess: true,
      remainingCount: 2,
      affectedResources: ["App.tsx"],
      codePreview: "-old\n+new",
    };
    const next: PendingApprovalRecord = {
      approvalId: "approval-1",
      kind: "tool.invoke",
      toolName: "shell.exec",
      reason: "New reason",
    };

    expect(mergePendingApproval(null, next)).toBe(next);
    expect(mergePendingApproval(current, null)).toBe(current);
    expect(mergePendingApproval(current, { ...next, approvalId: "approval-2" })).toMatchObject({
      approvalId: "approval-2",
    });
    expect(mergePendingApproval(current, { ...current })).toBe(current);
    expect(mergePendingApproval(current, next)).toEqual({
      ...current,
      toolName: "shell.exec",
      reason: "New reason",
    });
  });
});

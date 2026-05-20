import React from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApprovalQueue } from "./useApprovalQueue";
import { useRefreshSubscription } from "./useRefreshSubscription.js";

const apiMocks = vi.hoisted(() => ({
  fetchApprovalReplay: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchDevDiagnostics: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  resolveApproval: vi.fn(),
  resolveApprovalsBulk: vi.fn(),
  resumeDurableRun: vi.fn(),
}));

vi.mock("../api/client.js", () => ({
  fetchApprovalReplay: apiMocks.fetchApprovalReplay,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchDevDiagnostics: apiMocks.fetchDevDiagnostics,
  fetchDurableRun: apiMocks.fetchDurableRun,
  fetchDurableRunTimeline: apiMocks.fetchDurableRunTimeline,
  fetchRuntimeLifecycle: apiMocks.fetchRuntimeLifecycle,
  resolveApproval: apiMocks.resolveApproval,
  resolveApprovalsBulk: apiMocks.resolveApprovalsBulk,
  resumeDurableRun: apiMocks.resumeDurableRun,
}));

vi.mock("./useRefreshSubscription.js", () => ({
  useRefreshSubscription: vi.fn(),
}));

type ApprovalQueueResult = ReturnType<typeof useApprovalQueue>;

function approval(
  input: Partial<ApprovalRequest> & Pick<ApprovalRequest, "approvalId" | "createdAt">,
): ApprovalRequest {
  return {
    approvalId: input.approvalId,
    status: input.status ?? "pending",
    riskLevel: input.riskLevel ?? "safe",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    requestedBy: "test",
    action: "test.action",
    summary: input.summary ?? "Test approval",
    payload: {},
    ...input,
  } as ApprovalRequest;
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderApprovalQueue(options?: Parameters<typeof useApprovalQueue>[0]) {
  let latest!: ApprovalQueueResult;
  const Harness = () => {
    latest = useApprovalQueue(options);
    return null;
  };

  const renderer = create(<Harness />);
  await flushAsync();
  await flushAsync();
  return {
    renderer,
    get result() {
      return latest;
    },
  };
}

describe("useApprovalQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    vi.clearAllMocks();

    apiMocks.fetchApprovals.mockImplementation(async (status: ApprovalRequest["status"]) => ({
      items:
        status === "pending"
          ? [
              approval({
                approvalId: "pending-1",
                createdAt: "2026-01-01T11:00:00.000Z",
                riskLevel: "danger",
                linkage: { durableRunId: "run-1", correlationId: "corr-1" },
              }),
              approval({
                approvalId: "expired-1",
                createdAt: "2026-01-01T10:00:00.000Z",
                expiresAt: "2026-01-01T11:30:00.000Z",
              }),
            ]
          : status === "approved"
            ? [
                approval({
                  approvalId: "approved-1",
                  status: "approved",
                  createdAt: "2026-01-01T09:00:00.000Z",
                }),
              ]
            : [],
    }));
  });

  it("loads pending, history, and recovery views from all approval statuses", async () => {
    const hook = await renderApprovalQueue({ focusedApprovalId: "pending-1" });

    expect(apiMocks.fetchApprovals).toHaveBeenCalledTimes(4);
    expect(hook.result.loading).toBe(false);
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-1"]);
    expect(hook.result.historyItems.map((item) => item.approvalId)).toEqual(["expired-1", "approved-1"]);
    expect(hook.result.recoveryItems.map((item) => item.approvalId)).toEqual(["pending-1"]);
    expect(hook.result.pendingRiskCounts).toMatchObject({ danger: 1, safe: 0 });
    expect(hook.result.selectedApproval?.approvalId).toBe("pending-1");
    expect(hook.result.selectedApprovalId).toBe("pending-1");

    await act(async () => {
      hook.result.setView("history");
    });
    expect(hook.result.visibleItems.map((item) => item.approvalId)).toEqual(["expired-1", "approved-1"]);
  });

  it("focuses resolved approvals by switching to history instead of selecting an unrelated pending item", async () => {
    const hook = await renderApprovalQueue({ focusedApprovalId: "approved-1" });

    await flushAsync();

    expect(hook.result.view).toBe("history");
    expect(hook.result.selectedApproval?.approvalId).toBe("approved-1");
    expect(hook.result.selectedApprovalId).toBe("approved-1");
    expect(hook.result.visibleItems.map((item) => item.approvalId)).toEqual(["expired-1", "approved-1"]);
  });

  it("can be disabled without loading approvals", async () => {
    const hook = await renderApprovalQueue({ enabled: false });

    expect(apiMocks.fetchApprovals).not.toHaveBeenCalled();
    expect(hook.result.loading).toBe(true);
    expect(hook.result.visibleItems).toEqual([]);
    expect(vi.mocked(useRefreshSubscription).mock.calls[0]?.[2]).toMatchObject({ enabled: false });
  });

  it("reports load failures and reloads from the refresh subscription", async () => {
    apiMocks.fetchApprovals.mockRejectedValueOnce(new Error("load failed"));
    const hook = await renderApprovalQueue();

    expect(hook.result.error).toBe("load failed");
    expect(hook.result.loading).toBe(false);

    apiMocks.fetchApprovals.mockResolvedValue({ items: [] });
    await act(async () => {
      await vi.mocked(useRefreshSubscription).mock.calls[0]?.[1]();
    });
    expect(hook.result.error).toBeNull();
  });

  it("keeps pending approvals visible when a non-pending approval view fails", async () => {
    apiMocks.fetchApprovals.mockImplementation(async (status: ApprovalRequest["status"]) => {
      if (status === "approved") {
        throw new Error("approved lane failed");
      }
      return {
        items:
          status === "pending"
            ? [
                approval({
                  approvalId: "pending-visible",
                  createdAt: "2026-01-01T11:00:00.000Z",
                }),
              ]
            : [],
      };
    });

    const hook = await renderApprovalQueue();

    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toBe("approved lane failed");
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-visible"]);
    expect(hook.result.visibleItems.map((item) => item.approvalId)).toEqual(["pending-visible"]);
  });

  it("keeps previous pending approvals visible when the pending lane fails during refresh", async () => {
    const hook = await renderApprovalQueue();
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-1"]);

    apiMocks.fetchApprovals.mockImplementation(async (status: ApprovalRequest["status"]) => {
      if (status === "pending") {
        throw new Error("pending lane failed");
      }
      return {
        items:
          status === "approved"
            ? [
                approval({
                  approvalId: "approved-refresh",
                  status: "approved",
                  createdAt: "2026-01-01T09:30:00.000Z",
                }),
              ]
            : [],
      };
    });

    await act(async () => {
      await vi.mocked(useRefreshSubscription).mock.calls[0]?.[1]();
    });

    expect(hook.result.error).toBe("pending lane failed");
    expect(hook.result.pendingLaneFailed).toBe(true);
    expect(hook.result.failedStatusLanes).toEqual(["pending"]);
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-1"]);
    expect(hook.result.historyItems.map((item) => item.approvalId)).toContain("approved-refresh");
  });

  it("does not let a preserved stale pending row override a fresh resolved lane row", async () => {
    const hook = await renderApprovalQueue();
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-1"]);

    apiMocks.fetchApprovals.mockImplementation(async (status: ApprovalRequest["status"]) => {
      if (status === "pending") {
        throw new Error("pending lane failed");
      }
      return {
        items:
          status === "approved"
            ? [
                approval({
                  approvalId: "pending-1",
                  status: "approved",
                  createdAt: "2026-01-01T11:00:00.000Z",
                  resolvedAt: "2026-01-01T12:05:00.000Z",
                }),
              ]
            : [],
      };
    });

    await act(async () => {
      await vi.mocked(useRefreshSubscription).mock.calls[0]?.[1]();
    });

    expect(hook.result.error).toBe("pending lane failed");
    expect(hook.result.pendingItems.map((item) => item.approvalId)).not.toContain("pending-1");
    expect(hook.result.historyItems).toContainEqual(
      expect.objectContaining({
        approvalId: "pending-1",
        status: "approved",
        resolvedAt: "2026-01-01T12:05:00.000Z",
      }),
    );
  });

  it("keeps previous approved approvals visible when the approved lane fails during refresh", async () => {
    const hook = await renderApprovalQueue({ focusedApprovalId: "approved-1" });
    await act(async () => {
      hook.result.setView("history");
    });
    expect(hook.result.historyItems.map((item) => item.approvalId)).toContain("approved-1");

    apiMocks.fetchApprovals.mockImplementation(async (status: ApprovalRequest["status"]) => {
      if (status === "approved") {
        throw new Error("approved lane failed");
      }
      return {
        items:
          status === "pending"
            ? [
                approval({
                  approvalId: "pending-refresh",
                  createdAt: "2026-01-01T11:30:00.000Z",
                }),
              ]
            : [],
      };
    });

    await act(async () => {
      await vi.mocked(useRefreshSubscription).mock.calls[0]?.[1]();
    });

    expect(hook.result.error).toBe("approved lane failed");
    expect(hook.result.pendingItems.map((item) => item.approvalId)).toEqual(["pending-refresh"]);
    expect(hook.result.historyItems.map((item) => item.approvalId)).toContain("approved-1");
  });

  it("resolves, replays, and bulk-rejects approvals", async () => {
    apiMocks.resolveApproval.mockResolvedValue({
      approval: approval({
        approvalId: "pending-1",
        status: "approved",
        createdAt: "2026-01-01T11:00:00.000Z",
        resolvedAt: "2026-01-01T12:01:00.000Z",
        linkage: { sessionId: "session-1", turnId: "turn-1", taskId: "task-1" },
      }),
      durableRunId: "run-1",
      replay: { snapshots: [{ step: "after" }] },
      effects: [{ effectType: "resume" }],
      executedAction: {
        outcome: "completed",
        policyReason: "operator approved",
      },
    });
    apiMocks.fetchApprovalReplay.mockResolvedValue({ snapshots: [{ step: "replay" }] });
    apiMocks.resolveApprovalsBulk.mockResolvedValue({
      resolvedCount: 2,
      skippedCount: 1,
      failedCount: 0,
    });
    const hook = await renderApprovalQueue();

    await act(async () => {
      await expect(hook.result.onResolve("pending-1", "approve")).resolves.toBe(true);
    });

    expect(apiMocks.resolveApproval).toHaveBeenCalledWith("pending-1", "approve");
    expect(hook.result.summary).toBe("Approval pending-1 resolved and action completed: operator approved");
    expect(hook.result.replayById["pending-1"]).toEqual({ snapshots: [{ step: "after" }] });
    expect(hook.result.lifecycleByApprovalId["pending-1"]?.canonical?.runId).toBe("run-1");
    expect(hook.result.durableByApprovalId["pending-1"]).toMatchObject({
      runId: "run-1",
      status: "approved",
    });

    await act(async () => {
      await hook.result.onReplay("pending-1");
    });
    expect(hook.result.replayById["pending-1"]).toEqual({ snapshots: [{ step: "replay" }] });

    await act(async () => {
      await hook.result.onRejectAllPending();
    });
    expect(apiMocks.resolveApprovalsBulk).toHaveBeenCalledWith({
      decision: "reject",
      status: "pending",
      resolutionNote: "Bulk rejected from the approvals queue.",
    });
    expect(hook.result.summary).toBe("Rejected 2 pending approvals. Skipped 1. Failed 0.");
  });

  it("summarizes follow-up, effect-only, and plain approval resolutions", async () => {
    const hook = await renderApprovalQueue({ enabled: false });
    const resolution = (
      approvalId: string,
      overrides: Partial<ApprovalRequest> = {},
      extra: Record<string, unknown> = {},
    ) => ({
      approval: approval({
        approvalId,
        status: "approved",
        createdAt: "2026-01-01T11:00:00.000Z",
        linkage: {
          durableRunId: "linked-run",
          proactiveRunId: "proactive-run",
          workspaceId: "workspace-1",
        },
        ...overrides,
      }),
      replay: { snapshots: [{ step: approvalId }] },
      effects: [],
      ...extra,
    });

    for (const [approvalId, status, expected] of [
      ["queued-1", "queued", "Follow-on work is queued"],
      ["running-1", "running", "Follow-on work is running"],
      ["completed-1", "completed", "Follow-on work completed"],
      ["skipped-1", "skipped", "Follow-on work was skipped"],
      ["failed-1", "failed", "Follow-on work failed"],
    ] as const) {
      apiMocks.resolveApproval.mockResolvedValueOnce(
        resolution(approvalId, {
          followUp: { status },
        } as Partial<ApprovalRequest>),
      );
      await act(async () => {
        await expect(hook.result.onResolve(approvalId, "approve")).resolves.toBe(true);
      });
      expect(hook.result.summary).toBe(`Approval ${approvalId} resolved. ${expected}.`);
    }

    apiMocks.resolveApproval.mockResolvedValueOnce(
      resolution("effects-1", {}, { effects: [{ effectType: "resume" }, { effectType: "notify" }] }),
    );
    await act(async () => {
      await hook.result.onResolve("effects-1", "approve");
    });
    expect(hook.result.summary).toBe("Approval effects-1 resolved. 2 follow-on effects queued.");

    apiMocks.resolveApproval.mockResolvedValueOnce(resolution("plain-1"));
    await act(async () => {
      await hook.result.onResolve("plain-1", "reject");
    });
    expect(hook.result.summary).toBe("Approval plain-1 resolved.");
    expect(hook.result.lifecycleByApprovalId["plain-1"]?.linked.runIds).toEqual(["linked-run"]);
    expect(hook.result.lifecycleByApprovalId["plain-1"]?.linked.proactiveRunIds).toEqual(["proactive-run"]);
    expect(hook.result.lifecycleByApprovalId["plain-1"]?.linked.workspaceIds).toEqual(["workspace-1"]);
    expect(hook.result.durableByApprovalId["plain-1"]).toBeUndefined();

    apiMocks.resolveApproval.mockResolvedValueOnce(
      resolution("none-1", {
        followUp: { status: "none" },
        linkage: undefined,
      } as Partial<ApprovalRequest>),
    );
    await act(async () => {
      await hook.result.onResolve("none-1", "approve");
    });
    expect(hook.result.summary).toBe("Approval none-1 resolved.");
    expect(hook.result.lifecycleByApprovalId["none-1"]?.linked.runIds).toEqual([]);

    apiMocks.resolveApproval.mockResolvedValueOnce(
      resolution("unknown-1", {
        followUp: { status: "unknown" as never },
      } as Partial<ApprovalRequest>),
    );
    await act(async () => {
      await hook.result.onResolve("unknown-1", "approve");
    });
    expect(hook.result.summary).toBe("Approval unknown-1 resolved. Follow-on work status is unknown.");
  });

  it("reports resolve and replay failures without mutating the queue", async () => {
    apiMocks.resolveApproval.mockRejectedValue(new Error("resolve failed"));
    apiMocks.fetchApprovalReplay.mockRejectedValue(new Error("replay failed"));
    const hook = await renderApprovalQueue();

    await act(async () => {
      await expect(hook.result.onResolve("pending-1", "reject")).resolves.toBe(false);
    });
    expect(hook.result.error).toBe("resolve failed");
    expect(hook.result.summary).toBeNull();

    await act(async () => {
      await hook.result.onReplay("pending-1");
    });
    expect(hook.result.error).toBe("replay failed");

    apiMocks.resolveApprovalsBulk.mockRejectedValue(new Error("bulk failed"));
    await act(async () => {
      await hook.result.onRejectAllPending();
    });
    expect(hook.result.error).toBe("bulk failed");
    expect(hook.result.summary).toBeNull();
  });

  it("loads durable status, trace previews, and resumes paused checkpoints", async () => {
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      canonical: { runId: "run-1" },
      approval: { approvalId: "pending-1" },
    });
    apiMocks.fetchDurableRun
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "paused",
        updatedAt: "2026-01-01T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "completed",
        updatedAt: "2026-01-01T12:05:00.000Z",
      });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventType: "run_started",
          stepKey: "start",
          payload: {},
        },
        {
          eventType: "run_paused",
          stepKey: "approval",
          payload: { stepKey: "approval.step", reason: "Waiting for operator" },
        },
      ],
    });
    apiMocks.fetchDevDiagnostics.mockResolvedValue({
      items: [
        {
          timestamp: "2026-01-01T12:00:00.000Z",
          event: "tool",
          message: "Tool completed",
        },
      ],
    });
    const hook = await renderApprovalQueue();

    await act(async () => {
      await hook.result.loadDurableStatus("pending-1");
    });
    expect(hook.result.durableByApprovalId["pending-1"]).toMatchObject({
      runId: "run-1",
      status: "paused",
      blockedStep: "approval.step",
      blockedReason: "Waiting for operator",
    });
    expect(hook.result.durableBusyByApprovalId["pending-1"]).toBe(false);

    await act(async () => {
      await hook.result.loadTracePreview("pending-1", "corr-1");
    });
    expect(hook.result.tracePreviewByApprovalId["pending-1"]?.[0]).toContain("tool: Tool completed");

    await act(async () => {
      await hook.result.resumeFromCheckpoint("pending-1");
    });
    expect(apiMocks.resumeDurableRun).toHaveBeenCalledWith("run-1", "operator");
    expect(hook.result.durableByApprovalId["pending-1"]).toMatchObject({
      runId: "run-1",
      status: "completed",
    });
  });

  it("handles missing or non-paused durable runs deterministically", async () => {
    apiMocks.fetchRuntimeLifecycle.mockResolvedValueOnce({});
    const hook = await renderApprovalQueue();

    await act(async () => {
      await hook.result.loadDurableStatus("pending-1");
    });
    expect(hook.result.error).toBe("No canonical durable run is linked to this approval yet.");

    apiMocks.fetchRuntimeLifecycle.mockResolvedValueOnce({ canonical: { runId: "run-2" } });
    apiMocks.fetchDurableRun.mockResolvedValueOnce({
      runId: "run-2",
      status: "running",
      updatedAt: "2026-01-01T12:00:00.000Z",
    });

    await act(async () => {
      await hook.result.resumeFromCheckpoint("pending-2");
    });
    expect(hook.result.error).toBe("Run run-2 is running, so there is no paused checkpoint to resume.");

    apiMocks.fetchRuntimeLifecycle.mockResolvedValueOnce({});
    await act(async () => {
      await hook.result.resumeFromCheckpoint("pending-3");
    });
    expect(hook.result.error).toBe("No canonical durable run is linked to this approval yet.");

    apiMocks.fetchRuntimeLifecycle.mockRejectedValueOnce(new Error("durable failed"));
    await act(async () => {
      await hook.result.loadDurableStatus("pending-4");
    });
    expect(hook.result.error).toBe("durable failed");

    apiMocks.fetchRuntimeLifecycle.mockResolvedValueOnce({ canonical: { runId: "run-5" } });
    apiMocks.fetchDurableRun.mockResolvedValueOnce({
      runId: "run-5",
      status: "paused",
      updatedAt: "2026-01-01T12:00:00.000Z",
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValueOnce({
      items: [
        {
          eventType: "run_waiting",
          stepKey: "fallback-step",
          payload: { reason: 123 },
        },
      ],
    });
    apiMocks.resumeDurableRun.mockRejectedValueOnce(new Error("resume failed"));
    await act(async () => {
      await hook.result.resumeFromCheckpoint("pending-5");
    });
    expect(hook.result.error).toBe("resume failed");
    expect(hook.result.durableByApprovalId["pending-5"]).toMatchObject({
      blockedStep: "fallback-step",
      blockedReason: undefined,
    });
  });

  it("skips empty trace lookups, reports diagnostic failures, and clears stale empty selections", async () => {
    apiMocks.fetchApprovals.mockResolvedValue({ items: [] });
    const hook = await renderApprovalQueue();

    await act(async () => {
      hook.result.setSelectedApprovalId("stale-id");
    });
    await flushAsync();
    expect(hook.result.selectedApprovalId).toBeNull();

    await act(async () => {
      await hook.result.loadTracePreview("pending-1");
    });
    expect(apiMocks.fetchDevDiagnostics).not.toHaveBeenCalled();

    apiMocks.fetchDevDiagnostics.mockRejectedValue(new Error("diagnostics failed"));
    await act(async () => {
      await hook.result.loadTracePreview("pending-1", "corr-1");
    });
    expect(hook.result.error).toBe("diagnostics failed");
  });
});

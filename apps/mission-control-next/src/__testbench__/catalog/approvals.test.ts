import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { approvalChecks } from "./approvals";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  fetchChatPendingApprovals: vi.fn(),
  denyChatTool: vi.fn(),
  approveChatTool: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchDurableRun: vi.fn(),
  seedChatApprovalScenario: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChatSession: mocks.createChatSession,
  fetchChatPendingApprovals: mocks.fetchChatPendingApprovals,
  denyChatTool: mocks.denyChatTool,
  approveChatTool: mocks.approveChatTool,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovals: mocks.fetchApprovals }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRun: mocks.fetchDurableRun }));
vi.mock("./dev-verification", () => ({ seedChatApprovalScenario: mocks.seedChatApprovalScenario }));

const SCENARIO = {
  sessionId: "s-1",
  workspaceId: "ws-testbench",
  turnId: "t-1",
  approvalId: "4b0c6e0e-6d55-4d2b-9a3c-1f3c9b0a8e11",
  chatTurnDurableRunId: "run-1",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue({ sessionId: "s-1", revision: 1, lifecycleStatus: "active" });
  mocks.seedChatApprovalScenario.mockResolvedValue(SCENARIO);
  mocks.fetchChatPendingApprovals.mockResolvedValue({
    items: [{ approvalId: SCENARIO.approvalId, stale: false }],
    activeApprovalId: null,
    remainingCount: 1,
  });
});

const APPROVED = { ok: true, approvalId: SCENARIO.approvalId, resumed: true, resumedRunId: "run-1" };
const APPROVED_RECORD = { approvalId: SCENARIO.approvalId, status: "approved" };

function runApprove() {
  return findCheck(approvalChecks, "approvals.approve").run(makeTestContext());
}

describe("approval journeys", () => {
  it("rejects the pending approval and finds it recorded as rejected", async () => {
    mocks.denyChatTool.mockResolvedValueOnce({ ok: true, approvalId: SCENARIO.approvalId });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [{ approvalId: SCENARIO.approvalId, status: "rejected" }] });
    const ctx = makeTestContext();
    await expect(findCheck(approvalChecks, "approvals.reject").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(mocks.seedChatApprovalScenario).toHaveBeenCalledWith(
      { sessionId: "s-1", workspaceId: "ws-testbench" },
      ctx.signal,
    );
    expect(mocks.fetchApprovals).toHaveBeenCalledWith({ status: "rejected", limit: 200 });
    expect(ctx.steps.map((step) => step.title)).toEqual([
      "Create session",
      "Seed approval scenario",
      "Approval is pending",
      "Reject the approval",
      "Approval recorded as rejected",
    ]);
  });

  it("fails when the seeded approval is not pending for the session", async () => {
    mocks.fetchChatPendingApprovals.mockResolvedValueOnce({ items: [], activeApprovalId: null, remainingCount: 0 });
    await expect(findCheck(approvalChecks, "approvals.reject").run(makeTestContext())).rejects.toThrow(
      "The seeded approval is not pending for the session.",
    );
  });

  it("fails when the seeded approval is stale", async () => {
    mocks.fetchChatPendingApprovals.mockResolvedValueOnce({
      items: [{ approvalId: SCENARIO.approvalId, stale: true }],
      activeApprovalId: null,
      remainingCount: 0,
    });
    await expect(findCheck(approvalChecks, "approvals.reject").run(makeTestContext())).rejects.toThrow(
      "The seeded approval is not pending for the session.",
    );
  });

  it("approves, waits for the seeded durable run to wake, and reports only what it proved", async () => {
    mocks.approveChatTool.mockResolvedValueOnce({ ...APPROVED, resumedTurnId: "t-1" });
    mocks.fetchDurableRun.mockResolvedValueOnce({
      runId: "run-1",
      status: "running",
      workflowKey: "chat.turn",
      payload: { large: "record" },
    });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [APPROVED_RECORD] });
    await expect(runApprove()).resolves.toEqual({
      status: "pass",
      summary: "Approval woke the durable run (status running when read). Command execution was not verified.",
      evidence: {
        approval: APPROVED_RECORD,
        linkage: { resumed: true, resumedTurnId: "t-1", resumedRunId: "run-1" },
        run: { runId: "run-1", status: "running", lastError: undefined },
      },
    });
    expect(mocks.approveChatTool).toHaveBeenCalledWith("s-1", SCENARIO.approvalId);
    expect(mocks.fetchDurableRun).toHaveBeenCalledWith("run-1");
    expect(mocks.fetchApprovals).toHaveBeenCalledWith({ status: "approved", limit: 200 });
  });

  it("accepts a run that already completed after the wake", async () => {
    mocks.approveChatTool.mockResolvedValueOnce(APPROVED);
    mocks.fetchDurableRun.mockResolvedValueOnce({ runId: "run-1", status: "completed" });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [APPROVED_RECORD] });
    await expect(runApprove()).resolves.toMatchObject({
      status: "pass",
      summary: "Approval woke the durable run (status completed when read). Command execution was not verified.",
    });
  });

  it("fails when the approval did not resume the seeded turn's durable run", async () => {
    for (const response of [
      { ...APPROVED, resumedRunId: "run-other" },
      { ...APPROVED, resumedRunId: undefined },
      { ...APPROVED, resumed: false },
      { ...APPROVED, ok: false },
    ]) {
      mocks.approveChatTool.mockResolvedValueOnce(response);
      await expect(runApprove()).rejects.toThrow("The approval did not resume the seeded turn's durable run.");
    }
    expect(mocks.fetchDurableRun).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "dead_lettered", "paused"])(
    "fails when the durable run leaves waiting as %s",
    async (status) => {
      mocks.approveChatTool.mockResolvedValueOnce(APPROVED);
      mocks.fetchDurableRun.mockResolvedValueOnce({ runId: "run-1", status, lastError: "boom" });
      await expect(runApprove()).rejects.toThrow(`The durable run ended ${status} instead of resuming: boom.`);
      expect(mocks.fetchApprovals).not.toHaveBeenCalled();
    },
  );

  it("names the status alone when the run left no error", async () => {
    mocks.approveChatTool.mockResolvedValueOnce(APPROVED);
    mocks.fetchDurableRun.mockResolvedValueOnce({ runId: "run-1", status: "dead_lettered" });
    await expect(runApprove()).rejects.toThrow("The durable run ended dead_lettered instead of resuming.");
  });

  it("tiers the approve journey as host because it can run the seeded command", () => {
    expect(findCheck(approvalChecks, "approvals.approve").tier).toBe("host");
    expect(findCheck(approvalChecks, "approvals.reject").tier).toBe("mutate");
  });
});

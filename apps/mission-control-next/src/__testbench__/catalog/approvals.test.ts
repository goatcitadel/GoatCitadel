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
    items: [{ approvalId: SCENARIO.approvalId }],
    activeApprovalId: null,
    remainingCount: 1,
  });
});

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

  it("approves, waits for the durable run to wake, and finds the approval recorded", async () => {
    mocks.approveChatTool.mockResolvedValueOnce({ ok: true, approvalId: SCENARIO.approvalId, resumed: true });
    mocks.fetchDurableRun.mockResolvedValueOnce({ runId: "run-1", status: "running" });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [{ approvalId: SCENARIO.approvalId, status: "approved" }] });
    await expect(findCheck(approvalChecks, "approvals.approve").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Approved; the durable run is now running.",
    });
  });

  it("tiers the approve journey as host because it can run the seeded command", () => {
    expect(findCheck(approvalChecks, "approvals.approve").tier).toBe("host");
    expect(findCheck(approvalChecks, "approvals.reject").tier).toBe("mutate");
  });
});

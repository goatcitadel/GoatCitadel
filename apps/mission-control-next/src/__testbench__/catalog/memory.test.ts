import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { memoryChecks } from "./memory";

const mocks = vi.hoisted(() => ({
  patchMemoryItem: vi.fn(),
  forgetMemoryItem: vi.fn(),
  fetchMemoryItemHistory: vi.fn(),
  fetchMemoryItems: vi.fn(),
  resolveApproval: vi.fn(),
  seedMemoryItem: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/memory")>()),
  patchMemoryItem: mocks.patchMemoryItem,
  forgetMemoryItem: mocks.forgetMemoryItem,
  fetchMemoryItemHistory: mocks.fetchMemoryItemHistory,
  fetchMemoryItems: mocks.fetchMemoryItems,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApproval: mocks.resolveApproval }));
vi.mock("./dev-verification", () => ({ seedMemoryItem: mocks.seedMemoryItem }));

function envelope(approvalId: string, action: "item_updated" | "items_forgotten") {
  return {
    pendingApproval: {
      approvalId,
      kind: "memory.lifecycle",
      action,
      workspaceId: "ws-testbench",
      requestSha256: "sha",
      itemIds: ["mem-1"],
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.seedMemoryItem.mockResolvedValue({ itemId: "mem-1", workspaceId: "ws-testbench", namespace: "testbench" });
  mocks.patchMemoryItem.mockResolvedValue(envelope("appr-edit", "item_updated"));
  mocks.resolveApproval.mockResolvedValue({ approval: { status: "approved" } });
  mocks.fetchMemoryItemHistory.mockResolvedValue({ items: [{ changeType: "created" }, { changeType: "updated" }] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memory lifecycle", () => {
  it("edits and forgets the item, each through an approval", async () => {
    mocks.forgetMemoryItem.mockResolvedValueOnce(envelope("appr-forget", "items_forgotten"));
    mocks.fetchMemoryItems.mockResolvedValueOnce({ items: [{ itemId: "mem-1", status: "forgotten" }] });
    const ctx = makeTestContext();
    await expect(findCheck(memoryChecks, "memory.lifecycle").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(mocks.resolveApproval.mock.calls).toEqual([
      ["appr-edit", "approve"],
      ["appr-forget", "approve"],
    ]);
    expect(mocks.fetchMemoryItems).toHaveBeenCalledWith({
      workspaceId: "ws-testbench",
      namespace: "testbench",
      status: "all",
    });
    expect(mocks.seedMemoryItem).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-testbench", namespace: "testbench" }),
      ctx.signal,
    );
  });

  it("fails when editing does not request an approval", async () => {
    mocks.patchMemoryItem.mockResolvedValueOnce({ pendingApproval: null });
    await expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).rejects.toThrow(
      "Editing the item did not request an approval.",
    );
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("fails when forgetting does not request an approval", async () => {
    mocks.forgetMemoryItem.mockResolvedValueOnce({
      pendingApproval: null,
      noMutationRequired: true,
      matchedCount: 0,
      alreadyForgottenCount: 0,
    });
    await expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).rejects.toThrow(
      "did not request an approval",
    );
  });

  it("does not accept the edit's approval as proof when the history never shows the update", async () => {
    vi.useFakeTimers();
    mocks.fetchMemoryItemHistory.mockResolvedValue({ items: [{ changeType: "created" }] });
    const outcome = expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).rejects.toThrow(
      "The edit reaching the item history did not happen",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(mocks.forgetMemoryItem).not.toHaveBeenCalled();
  });

  it("does not accept the forget's approval as proof when the item never reads as forgotten", async () => {
    vi.useFakeTimers();
    mocks.forgetMemoryItem.mockResolvedValueOnce(envelope("appr-forget", "items_forgotten"));
    mocks.fetchMemoryItems.mockResolvedValue({ items: [{ itemId: "mem-1", status: "active" }] });
    const outcome = expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).rejects.toThrow(
      "Forgetting the item did not happen",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(mocks.resolveApproval).toHaveBeenCalledTimes(2);
  });
});

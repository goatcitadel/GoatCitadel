import { describe, expect, it, vi } from "vitest";
import { MemoryRouteService } from "./memory-route-service.js";

/**
 * HX-402 P1: the route facade is the reachability boundary for operator
 * memory mutations. It exposes ONLY the approval-request verbs — the retired
 * direct-mutation delegations are gone, so no route can reach an unapproved
 * patch/forget/batch branch through this facade.
 */
describe("MemoryRouteService approval-first surface", () => {
  it("delegates the mutation verbs to the approval-request methods with hooks intact", () => {
    const port = {
      requestMemoryItemPatchApproval: vi.fn(() => ({ pendingApproval: { approvalId: "approval-patch" } })),
      requestMemoryForgetApproval: vi.fn(() => ({ pendingApproval: { approvalId: "approval-forget" } })),
      requestMemoryBatchMutationApproval: vi.fn(() => ({ pendingApproval: { approvalId: "approval-batch" } })),
    };
    const service = new MemoryRouteService(port as never);
    const hooks = { onCommit: vi.fn(), afterCommit: vi.fn() };

    expect(service.requestItemPatchApproval("item-1", { title: "New" } as never, "operator-1", hooks)).toMatchObject({
      pendingApproval: { approvalId: "approval-patch" },
    });
    expect(port.requestMemoryItemPatchApproval).toHaveBeenCalledWith("item-1", { title: "New" }, "operator-1", hooks);

    expect(
      service.requestForgetApproval({ itemIds: ["item-1"], requesterId: "operator-1" } as never, hooks),
    ).toMatchObject({ pendingApproval: { approvalId: "approval-forget" } });
    expect(port.requestMemoryForgetApproval).toHaveBeenCalledWith(
      { itemIds: ["item-1"], requesterId: "operator-1" },
      hooks,
    );

    expect(
      service.requestBatchMutationApproval({ actionId: "batch-1", operations: [] } as never, "operator-1"),
    ).toMatchObject({ pendingApproval: { approvalId: "approval-batch" } });
    expect(port.requestMemoryBatchMutationApproval).toHaveBeenCalledWith(
      { actionId: "batch-1", operations: [] },
      "operator-1",
      undefined,
    );
  });

  it("no longer exposes any unapproved mutation delegation", () => {
    const service = new MemoryRouteService({} as never);
    const facade = service as unknown as Record<string, unknown>;
    // Inventory of the retired route-facing entry points (HX-402 P1 removal).
    for (const retired of ["patchItem", "forgetItem", "forget", "batchMutateItems"]) {
      expect(facade[retired]).toBeUndefined();
    }
  });
});

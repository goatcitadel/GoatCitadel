import { beforeEach, describe, expect, it, vi } from "vitest";

import * as memory from "./memory";
import { isMemoryMutationApprovalEnvelope } from "./memory";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

const pendingApprovalFixture = {
  approvalId: "11111111-2222-3333-4444-555555555555",
  status: "pending",
  kind: "memory.lifecycle" as const,
  action: "item_updated" as const,
  subjectKind: "memory_item" as const,
  subjectId: "memory-1",
  workspaceId: "workspace-a",
  requestSha256: "a".repeat(64),
  expectedStateSha256: "b".repeat(64),
  createdAt: "2026-07-22T00:00:00.000Z",
  replayed: false,
  itemIds: ["memory-1"],
};

beforeEach(() => {
  apiMocks.request.mockReset();
  apiMocks.request.mockResolvedValue({ pendingApproval: pendingApprovalFixture });
});

function lastCall(): [string, RequestInit | undefined] {
  const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
  return [path as string, init as RequestInit | undefined];
}

function body(init: RequestInit | undefined): unknown {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

/**
 * HX-402 P1: the operator memory mutation verbs are approval-first. The client
 * surfaces the pending `memory.lifecycle` approval envelope verbatim — a verb
 * response never claims an executed mutation.
 */
describe("memory lifecycle approval client", () => {
  it("patchMemoryItem sends the patch and resolves the pending-approval envelope", async () => {
    const outcome = await memory.patchMemoryItem("memory-1", { title: "New title" });
    expect(lastCall()[0]).toBe("/api/v1/memory/items/memory-1");
    expect(lastCall()[1]?.method).toBe("PATCH");
    expect(body(lastCall()[1])).toEqual({ title: "New title" });
    expect(outcome.pendingApproval.approvalId).toBe(pendingApprovalFixture.approvalId);
    expect(isMemoryMutationApprovalEnvelope(outcome)).toBe(true);
  });

  it("forgetMemoryItem resolves either the envelope or the zero-mutation outcome", async () => {
    const envelope = await memory.forgetMemoryItem("memory-1");
    expect(lastCall()[0]).toBe("/api/v1/memory/items/memory-1/forget");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(envelope.pendingApproval?.approvalId).toBe(pendingApprovalFixture.approvalId);

    apiMocks.request.mockResolvedValueOnce({
      pendingApproval: null,
      noMutationRequired: true,
      matchedCount: 1,
      alreadyForgottenCount: 1,
    });
    const noOp = await memory.forgetMemoryItem("memory-1");
    expect(noOp.pendingApproval).toBeNull();
    expect(isMemoryMutationApprovalEnvelope(noOp)).toBe(false);
  });

  it("forgetMemory validates the request client-side before posting the approval request", async () => {
    await memory.forgetMemory({ itemIds: ["memory-1"], workspaceId: "workspace-a" });
    expect(lastCall()[0]).toBe("/api/v1/memory/forget");
    expect(body(lastCall()[1])).toEqual({ itemIds: ["memory-1"], workspaceId: "workspace-a" });

    // Contract-level validation still fires before any network call.
    await expect(memory.forgetMemory({ namespace: "ops", includeGlobal: true } as never)).rejects.toThrow(
      /includeGlobal requires workspaceId/i,
    );
  });

  it("batchMutateMemoryItems posts the batch and resolves one batch approval envelope", async () => {
    apiMocks.request.mockResolvedValueOnce({
      pendingApproval: {
        ...pendingApprovalFixture,
        action: "batch_mutated",
        subjectKind: "memory_item_batch",
        subjectId: undefined,
        itemIds: ["memory-1", "memory-2"],
      },
    });
    const outcome = await memory.batchMutateMemoryItems({
      actionId: "batch-1",
      operations: [
        { kind: "patch_item", itemId: "memory-1", patch: { pinned: true } },
        { kind: "forget_item", itemId: "memory-2" },
      ],
    });
    expect(lastCall()[0]).toBe("/api/v1/memory/items/batch-mutate");
    expect(outcome.pendingApproval.action).toBe("batch_mutated");
    expect(outcome.pendingApproval.itemIds).toEqual(["memory-1", "memory-2"]);
  });

  it("isMemoryMutationApprovalEnvelope rejects malformed envelopes", () => {
    expect(isMemoryMutationApprovalEnvelope(undefined)).toBe(false);
    expect(isMemoryMutationApprovalEnvelope({})).toBe(false);
    expect(isMemoryMutationApprovalEnvelope({ pendingApproval: null })).toBe(false);
    expect(isMemoryMutationApprovalEnvelope({ pendingApproval: { approvalId: "" } })).toBe(false);
    expect(
      isMemoryMutationApprovalEnvelope({
        pendingApproval: { ...pendingApprovalFixture, kind: "mesh.capability.activate" },
      }),
    ).toBe(false);
    expect(isMemoryMutationApprovalEnvelope({ pendingApproval: pendingApprovalFixture })).toBe(true);
  });
});

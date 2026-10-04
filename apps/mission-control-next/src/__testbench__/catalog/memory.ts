import { resolveApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import {
  fetchMemoryItemHistory,
  fetchMemoryItems,
  forgetMemoryItem,
  isMemoryMutationApprovalEnvelope,
  patchMemoryItem,
} from "@goatcitadel/mission-control-shared/api/memory";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { requireWorkspace } from "./context";
import { seedMemoryItem } from "./dev-verification";

const NAMESPACE = "testbench";

export const memoryChecks: readonly CheckDef[] = [
  {
    id: "memory.lifecycle",
    kind: "journey",
    domain: "memory",
    title: "Memory item lifecycle through approvals",
    tier: "mutate",
    needsWorkspace: true,
    timeoutMs: 90_000,
    routes: [
      "POST /api/v1/dev/verification/memory-item-seed",
      "PATCH /api/v1/memory/items/:itemId",
      "POST /api/v1/approvals/:approvalId/resolve",
      "GET /api/v1/memory/items/:itemId/history",
      "POST /api/v1/memory/items/:itemId/forget",
      "GET /api/v1/memory/items",
    ],
    steps: [
      "Seed memory item",
      "Edit item (approval-first)",
      "Approve the edit",
      "History shows the update",
      "Forget item (approval-first)",
      "Approve the forget",
      "Item is forgotten",
    ],
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const item = await ctx.step("Seed memory item", () =>
        seedMemoryItem(
          { workspaceId, namespace: NAMESPACE, title: "Test bench note", content: "Created by the test bench." },
          ctx.signal,
        ),
      );
      const edit = await ctx.step("Edit item (approval-first)", () =>
        patchMemoryItem(item.itemId, { content: "Edited by the test bench." }),
      );
      ensure(isMemoryMutationApprovalEnvelope(edit), "Editing the item did not request an approval.", edit);
      await ctx.step("Approve the edit", () => resolveApproval(edit.pendingApproval.approvalId, "approve"));
      // The approval only queues the edit; the item history is the proof that it was applied.
      await ctx.step("History shows the update", () =>
        waitFor(
          () => fetchMemoryItemHistory(item.itemId),
          (history) => history.items.some((event) => event.changeType === "updated"),
          { signal: ctx.signal, timeoutMs: 15_000, label: "The edit reaching the item history" },
        ),
      );
      const forget = await ctx.step("Forget item (approval-first)", () => forgetMemoryItem(item.itemId));
      ensure(isMemoryMutationApprovalEnvelope(forget), "Forgetting the item did not request an approval.", forget);
      await ctx.step("Approve the forget", () => resolveApproval(forget.pendingApproval.approvalId, "approve"));
      // Likewise, only the item's own status shows the forget was applied.
      await ctx.step("Item is forgotten", () =>
        waitFor(
          () => fetchMemoryItems({ workspaceId, namespace: NAMESPACE, status: "all" }),
          (page) => page.items.some((entry) => entry.itemId === item.itemId && entry.status === "forgotten"),
          { signal: ctx.signal, timeoutMs: 15_000, label: "Forgetting the item" },
        ),
      );
      return pass("The item was edited and then forgotten, each through an approval.");
    },
  },
];

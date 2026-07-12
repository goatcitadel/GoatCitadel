import { describe, expect, it } from "vitest";
import { MEMORY_FORGET_MAX_ITEM_IDS, validateMemoryForgetRequest } from "./memory.js";

describe("memory forget request validation", () => {
  it("accepts bounded explicit targets and workspace-scoped global inclusion", () => {
    expect(() =>
      validateMemoryForgetRequest({
        itemIds: Array.from({ length: MEMORY_FORGET_MAX_ITEM_IDS }, (_, index) => `memory-${index}`),
        workspaceId: "workspace-a",
        includeGlobal: true,
      }),
    ).not.toThrow();
  });

  it("rejects oversized explicit targets and unscoped global inclusion", () => {
    expect(() =>
      validateMemoryForgetRequest({
        itemIds: Array.from({ length: MEMORY_FORGET_MAX_ITEM_IDS + 1 }, (_, index) => `memory-${index}`),
      }),
    ).toThrow(`Memory forget is limited to ${MEMORY_FORGET_MAX_ITEM_IDS} explicit item IDs per request.`);
    expect(() => validateMemoryForgetRequest({ namespace: "ops", workspaceId: " ", includeGlobal: false })).toThrow(
      "Memory forget includeGlobal requires workspaceId.",
    );
  });
});

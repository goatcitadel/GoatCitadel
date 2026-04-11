import { describe, expect, it, vi } from "vitest";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

describe("MemoryLifecycleService", () => {
  it("routes context, learned-memory, and maintenance entry points through one owner", async () => {
    const service = new MemoryLifecycleService({
      context: {
        compose: vi.fn(async () => ({ contextId: "ctx-1" })),
        get: vi.fn(() => ({ contextId: "ctx-1" })),
        listByRun: vi.fn(() => [{ contextId: "ctx-1" }]),
        listRecent: vi.fn(() => [{ contextId: "ctx-2" }]),
        stats: vi.fn(() => ({ totalRuns: 1 })),
      } as never,
      learned: {
        extractAndPersistLearnedMemory: vi.fn(),
        listChatSessionLearnedMemory: vi.fn(() => ({ items: [], conflicts: [] })),
        updateChatSessionLearnedMemory: vi.fn(() => ({ itemId: "item-1" })),
        rebuildChatSessionLearnedMemory: vi.fn(async () => ({ rebuiltAt: "now", items: [], conflicts: [] })),
      } as never,
      maintenance: {
        getPolicy: vi.fn(() => ({ workspaceId: "default" })),
        patchPolicy: vi.fn(() => ({ workspaceId: "default" })),
        getStatus: vi.fn(() => ({ workspaceId: "default" })),
        listRuns: vi.fn(() => []),
        runNow: vi.fn(() => ({ runId: "run-1" })),
        getRunProvenance: vi.fn(() => ({ run: { runId: "run-1" }, sources: [], changes: [] })),
        listRecommendations: vi.fn(() => []),
        acceptRecommendation: vi.fn(() => ({ recommendation: { recommendationId: "rec-1" }, policy: { workspaceId: "default" } })),
        rejectRecommendation: vi.fn(() => ({ recommendationId: "rec-1" })),
        runDueEvaluation: vi.fn(async () => undefined),
        noteSuccessfulRootTurn: vi.fn(async () => undefined),
        parseWorkflowPayload: vi.fn(() => ({ workspaceId: "default" })),
        syncFromDurableRun: vi.fn(),
        executeDurableRun: vi.fn(async () => ({ ok: true })),
      } as never,
      readTranscriptOrEmpty: vi.fn(async () => []),
    });

    await expect(service.composeContext({ scope: "chat", prompt: "hello" })).resolves.toMatchObject({ contextId: "ctx-1" });
    expect(service.listSessionLearnedMemory("session-1")).toEqual({ items: [], conflicts: [] });
    await expect(service.rebuildSessionLearnedMemory("session-1")).resolves.toMatchObject({ rebuiltAt: "now" });
    expect(service.getMaintenancePolicy("default")).toMatchObject({ workspaceId: "default" });
    await expect(service.executeMaintenanceDurableRun({ runId: "run-1" } as never)).resolves.toEqual({ ok: true });
  });
});

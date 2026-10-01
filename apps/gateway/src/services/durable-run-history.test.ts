import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { DurableRunService, type DurableRunServiceContext } from "./durable-run-service.js";

describe("durable history read service", () => {
  it("awaits storage pagination and projects operational state without mutating the source record", async () => {
    const run: DurableRunRecord = {
      runId: "run-1", workflowKey: "chat.turn.execute", status: "queued", attemptCount: 0,
      maxAttempts: 3, version: 0, payload: { workspaceId: "alpha" },
      createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
    };
    const listRunHistory = vi.fn(async () => ({ items: [run], nextCursor: "next" }));
    const service = new DurableRunService({ storage: { durableRuns: { listRunHistory } } } as unknown as DurableRunServiceContext);
    const query = { workspaceId: "alpha", cursor: "page", limit: 2 };
    const page = await service.listDurableRunHistory(query);
    expect(listRunHistory).toHaveBeenCalledWith(query);
    expect(page).toMatchObject({ items: [{ runId: "run-1", workerHealth: "idle", recoveryState: "none" }], nextCursor: "next" });
    expect(run).not.toHaveProperty("workerHealth");
  });
});

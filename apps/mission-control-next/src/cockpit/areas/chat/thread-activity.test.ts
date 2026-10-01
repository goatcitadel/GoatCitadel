import { describe, expect, it, vi } from "vitest";
import { projectThreadActivity, readThreadActivityWindow, THREAD_ACTIVITY_WINDOW_LIMIT } from "./thread-activity";
import { statusRecord } from "./thread-activity.test-support";
import type { ChatSessionStatusResponse } from "@goatcitadel/contracts";

describe("canonical visible thread activity", () => {
  it("distinguishes latest failure from historical failure and missing/foreign status", () => {
    const record = statusRecord("s", "w", { latestTurnId: "latest", latestTurn: { turnId: "latest", status: "completed", startedAt: "2026-10-01T00:00:00Z" },
      durableRuns: [{ runId: "old", status: "failed", workerHealth: "released", recoveryState: "none" }] });
    expect(projectThreadActivity(record, "w", "s").label).toBe("Last turn completed");
    if (record.work.availability !== "available") throw new Error("Fixture work required");
    record.work.value.latestTurn!.status = "failed";
    expect(projectThreadActivity(record, "w", "s").label).toBe("Last turn failed");
    record.work.value.latestTurn = undefined;
    expect(projectThreadActivity(record, "w", "s").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "foreign", "s").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "w", "foreign").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "w", "s").label).toBe("No recorded turns");
  });
  it("uses explicit active counts and rejects malformed counts", () => {
    const record = statusRecord();
    if (record.work.availability !== "available") throw new Error("Fixture work required");
    record.work.value.turnCounts.running = 1;
    expect(projectThreadActivity(record, "w", "s").label).toBe("Working");
    record.work.value.turnCounts.waiting_for_approval = 1;
    expect(projectThreadActivity(record, "w", "s").label).toBe("Waiting on you");
    record.work.value.turnCounts.running = -1;
    expect(projectThreadActivity(record, "w", "s").label).toBe("Status unavailable");
  });
  it("caps work to the requested visible IDs with concurrency two and never reads another page", async () => {
    let active = 0, maximum = 0;
    const read = vi.fn(async (id: string) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return statusRecord(id); });
    const ids = Array.from({ length: 200 }, (_, i) => "session-" + i);
    const result = await readThreadActivityWindow({ workspaceId: "w", sessionIds: ids, signal: new AbortController().signal, isCurrent: () => true, read });
    expect(maximum).toBe(2); expect(read).toHaveBeenCalledTimes(THREAD_ACTIVITY_WINDOW_LIMIT);
    expect(Object.keys(result)).toEqual(ids.slice(0, THREAD_ACTIVITY_WINDOW_LIMIT));
  });
  it("stops queuing and discards late results after scope loss or abort", async () => {
    const pending: Array<(value: ChatSessionStatusResponse) => void> = [];
    const read = vi.fn(() => new Promise<ChatSessionStatusResponse>((resolve) => pending.push(resolve)));
    const controller = new AbortController(); let current = true;
    const request = readThreadActivityWindow({ workspaceId: "w", sessionIds: ["a", "b", "c"], signal: controller.signal, isCurrent: () => current, read });
    expect(read).toHaveBeenCalledTimes(2); current = false; controller.abort();
    pending[0]!(statusRecord("a")); pending[1]!(statusRecord("b"));
    expect(await request).toEqual({}); expect(read).toHaveBeenCalledTimes(2);
  });
});

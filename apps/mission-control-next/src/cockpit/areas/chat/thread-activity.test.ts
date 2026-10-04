import { describe, expect, it, vi } from "vitest";
import {
  createConcurrencyLimiter,
  projectThreadActivity,
  readThreadActivity,
  THREAD_ACTIVITY_WINDOW_LIMIT,
  threadActivityLabel,
} from "./thread-activity";
import { statusRecord } from "./thread-activity.test-support";

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
  it("runs status reads with concurrency two across every caller", async () => {
    let active = 0, maximum = 0;
    const read = vi.fn(async (id: string) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return statusRecord(id); });
    const ids = Array.from({ length: THREAD_ACTIVITY_WINDOW_LIMIT }, (_, i) => "session-" + i);
    const results = await Promise.all(ids.map((sessionId) =>
      readThreadActivity({ workspaceId: "w", sessionId, signal: new AbortController().signal, read })));
    expect(maximum).toBe(2);
    expect(results.every((result) => result.label === "Status unavailable" || result.label === "No recorded turns")).toBe(true);
  });
  it("never starts a queued read whose signal aborted while it waited", async () => {
    const limiter = createConcurrencyLimiter(1);
    const pending: Array<() => void> = [];
    const first = limiter(() => new Promise<void>((resolve) => pending.push(resolve)));
    const controller = new AbortController();
    const second = vi.fn(async () => "started");
    const queued = limiter(second, controller.signal);
    controller.abort();
    pending[0]!();
    await first;
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(second).not.toHaveBeenCalled();
  });
  it("dates a status once it is no longer current", () => {
    const fresh = { label: "Working", tone: "running" as const, observedAt: "2026-10-01T10:42:00Z" };
    expect(threadActivityLabel(fresh)).toBe("Working");
    expect(threadActivityLabel({ ...fresh, stale: true })).toMatch(/^Working · as of /);
    expect(threadActivityLabel({ label: "Working", tone: "running", stale: true })).toBe("Working");
  });
});

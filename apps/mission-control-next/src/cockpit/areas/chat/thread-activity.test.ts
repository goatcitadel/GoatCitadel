import { describe, expect, it } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { projectSessionActivity, projectThreadActivity, threadActivityLabel } from "./thread-activity";
import { statusRecord } from "./thread-activity.test-support";

describe("canonical visible thread activity", () => {
  it("distinguishes latest failure from historical failure and missing/foreign status", () => {
    const record = statusRecord("s", "w", {
      latestTurnId: "latest",
      latestTurn: { turnId: "latest", status: "completed", startedAt: "2026-10-01T00:00:00Z" },
      durableRuns: [{ runId: "old", status: "failed", workerHealth: "released", recoveryState: "none" }],
    });
    expect(projectThreadActivity(record, "w", "s").label).toBe("Last response completed");
    if (record.work.availability !== "available") throw new Error("Fixture work required");
    record.work.value.latestTurn!.status = "failed";
    expect(projectThreadActivity(record, "w", "s").label).toBe("Last response failed");
    record.work.value.latestTurn = undefined;
    expect(projectThreadActivity(record, "w", "s").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "foreign", "s").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "w", "foreign").label).toBe("Status unavailable");
    expect(projectThreadActivity(statusRecord(), "w", "s").label).toBe("No messages yet");
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
  it("reads the same labels from the activity a sessions list returns", () => {
    const counts = { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 };
    const session = (activity?: ChatSessionRecord["activity"]) => ({ sessionId: "s", activity }) as ChatSessionRecord;
    const observedAt = "2026-10-05T10:00:00Z";
    expect(projectSessionActivity(session())).toEqual({ label: "Status unavailable", tone: "neutral" });
    expect(projectSessionActivity(session({ observedAt, latestTurn: null, turnCounts: counts })).label).toBe(
      "No messages yet",
    );
    expect(
      projectSessionActivity(session({ observedAt, latestTurn: null, turnCounts: { ...counts, running: 1 } })),
    ).toEqual({ label: "Working", tone: "running", observedAt });
    expect(
      projectSessionActivity(
        session({ observedAt, latestTurn: null, turnCounts: { ...counts, waiting_for_user_input: 1 } }),
      ).label,
    ).toBe("Waiting on you");
    const latestTurn = { turnId: "t", status: "failed" as const, startedAt: "2026-10-05T09:59:00Z" };
    expect(projectSessionActivity(session({ observedAt, latestTurn, turnCounts: counts })).label).toBe(
      "Last response failed",
    );
    expect(projectSessionActivity(session({ observedAt: "not a time", latestTurn, turnCounts: counts })).label).toBe(
      "Status unavailable",
    );
  });
  it("dates a status once it is no longer current", () => {
    const fresh = { label: "Working", tone: "running" as const, observedAt: "2026-10-01T10:42:00Z" };
    expect(threadActivityLabel(fresh)).toBe("Working");
    expect(threadActivityLabel({ ...fresh, stale: true })).toMatch(/^Working · as of /);
    expect(threadActivityLabel({ label: "Working", tone: "running", stale: true })).toBe("Working");
  });
});

import { describe, expect, it } from "vitest";
import { markStaleSessions } from "./stale-session-markers.js";

const now = new Date("2026-05-16T10:00:00Z").getTime();

describe("markStaleSessions", () => {
  it("marks records with heartbeat older than threshold as stale", () => {
    const stale = new Date(now - 120_000).toISOString();
    const fresh = new Date(now - 30_000).toISOString();
    const result = markStaleSessions(
      [
        { id: "a", lastHeartbeatAt: stale, status: "running" },
        { id: "b", lastHeartbeatAt: fresh, status: "running" },
      ],
      { now, thresholdMs: 90_000 },
    );
    expect(result[0].runtimeState).toBe("stale");
    expect(result[1].runtimeState).toBe("active");
  });

  it("uses updatedAt when lastHeartbeatAt is absent", () => {
    const stale = new Date(now - 120_000).toISOString();
    const result = markStaleSessions([{ id: "a", updatedAt: stale, status: "running" }], { now, thresholdMs: 90_000 });
    expect(result[0].runtimeState).toBe("stale");
  });

  it("never marks terminal-status records as stale", () => {
    const ancient = new Date(now - 999_999).toISOString();
    const result = markStaleSessions(
      [
        { id: "a", lastHeartbeatAt: ancient, status: "sent" },
        { id: "b", lastHeartbeatAt: ancient, status: "failed" },
        { id: "c", lastHeartbeatAt: ancient, status: "completed" },
      ],
      { now, thresholdMs: 90_000 },
    );
    expect(result.every((r) => r.runtimeState === "active")).toBe(true);
  });

  it("returns active when no heartbeat info is available", () => {
    const result = markStaleSessions([{ id: "a", status: "running" }], {
      now,
      thresholdMs: 90_000,
    });
    expect(result[0].runtimeState).toBe("active");
  });

  it("returns active when heartbeat is unparseable", () => {
    const result = markStaleSessions([{ id: "a", lastHeartbeatAt: "not-a-date", status: "running" }], {
      now,
      thresholdMs: 90_000,
    });
    expect(result[0].runtimeState).toBe("active");
  });
});

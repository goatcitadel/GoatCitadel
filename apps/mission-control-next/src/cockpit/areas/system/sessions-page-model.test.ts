import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@goatcitadel/contracts";
import type { OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";
import { findSession, recentSessionList, sessionTitle, sessionsAcrossWorkspaces } from "./sessions-page-model";

const session = (overrides: Partial<SessionMeta> = {}) =>
  ({ sessionId: "session-a", channel: "web", displayName: "Owner conversation", ...overrides }) as SessionMeta;

function data(overrides: Record<string, unknown> = {}, failed: string[] = []): OpsRuntimeData {
  return {
    sessions: [session()],
    dashboard: { pendingApprovals: 3, activeSubagents: 1, recentEvents: [{}, {}], sessions: [] },
    sourceStatus: Object.fromEntries(
      ["sessions", "dashboard"].map((source) => [source, { status: failed.includes(source) ? "error" : "ok" }]),
    ),
    ...overrides,
  } as unknown as OpsRuntimeData;
}

describe("sessionTitle", () => {
  it("names a raw session id by its channel", () => {
    expect(sessionTitle(session({ displayName: "sess_abc" }))).toBe("Web chat conversation");
    expect(sessionTitle(session({ displayName: "  " }))).toBe("Web chat conversation");
  });

  it("keeps an explicit name", () => {
    expect(sessionTitle(session())).toBe("Owner conversation");
  });
});

describe("recentSessionList", () => {
  it("reports a failed source with no rows instead of an empty list", () => {
    expect(recentSessionList(data({ sessions: [] }, ["sessions"]))).toEqual({ state: "failed" });
  });

  it("falls back to the dashboard sessions", () => {
    const fallback = session({ sessionId: "from-dashboard" });
    const list = recentSessionList(
      data({
        sessions: [],
        dashboard: { pendingApprovals: 0, activeSubagents: 0, recentEvents: [], sessions: [fallback] },
      }),
    );
    expect(list).toEqual({ state: "ok", items: [fallback] });
  });
});

describe("findSession", () => {
  it("finds a listed session and misses an unlisted one", () => {
    expect(findSession(data(), "session-a")?.displayName).toBe("Owner conversation");
    expect(findSession(data(), "missing")).toBeUndefined();
  });
});

describe("sessionsAcrossWorkspaces", () => {
  it("labels the installation-wide approval count", () => {
    expect(sessionsAcrossWorkspaces(data())).toEqual([
      { term: "Pending approvals, all workspaces", value: "3" },
      { term: "Active subagents", value: "1" },
      { term: "Recent events", value: "2" },
    ]);
  });

  it("reads Unknown when the dashboard source failed", () => {
    const metrics = sessionsAcrossWorkspaces(data({ dashboard: null }, ["dashboard"]));
    expect(metrics.map((item) => item.value)).toEqual(["Unknown", "Unknown", "Unknown"]);
  });
});

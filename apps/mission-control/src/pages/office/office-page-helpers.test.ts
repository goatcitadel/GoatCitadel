// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "../../api/client";
import {
  asBooleanOr,
  asRecord,
  asString,
  attentionLabel,
  attentionPillClass,
  buildOperatorThought,
  classifyAgentHeat,
  extractSessionId,
  extractTaskId,
  formatClock,
  formatRelative,
  initials,
  isOfficeMotionMode,
  isOperatorPreset,
  normalize,
  parseTimestamp,
  persistOperatorPreferences,
  readOperatorPreferences,
  sanitizeOperatorName,
  sortEvents,
  statusScore,
  summarizeEvent,
  truncate,
} from "./office-page-helpers";
import type { OperatorPreferences } from "./office-page-constants";

const DEFAULT_PREFS: OperatorPreferences = {
  name: "Operator",
  preset: "trailblazer",
  layoutMode: "immersive",
  motionMode: "balanced",
  showCollabOverlay: true,
  showInspectorDock: true,
  showRailDock: true,
  idleMillingEnabled: true,
  focusMode: false,
  quietMode: false,
  followSelection: true,
};

function event(overrides: Partial<RealtimeEvent>): RealtimeEvent {
  return {
    id: "event-1",
    eventId: "event-1",
    eventType: "activity_logged",
    timestamp: "2026-05-14T12:00:00.000Z",
    payload: {},
    ...overrides,
  } as RealtimeEvent;
}

describe("office-page-helpers", () => {
  it("normalizes primitive values, timestamps, and text labels", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:30.000Z"));

    expect(asRecord(null)).toEqual({});
    expect(asString("  status  ")).toBe("status");
    expect(asString("   ")).toBeUndefined();
    expect(parseTimestamp("not-a-date")).toBe(0);
    expect(formatClock()).toBe("-");
    expect(formatRelative("2026-05-14T12:00:00.000Z")).toBe("30s ago");
    expect(formatRelative("2026-05-14T11:58:00.000Z")).toBe("2m ago");
    expect(formatRelative("2026-05-14T08:00:00.000Z")).toBe("4h ago");
    expect(formatRelative("2026-05-12T12:00:00.000Z")).toBe("2d ago");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("goat")).toBe("GO");
    expect(initials(" ")).toBe("AG");
    expect(truncate("abcdef", 5)).toBe("ab...");
    expect(normalize("Ops: Approval Queue!")).toBe("ops approval queue");
  });

  it("sorts events and extracts task/session lineage defensively", () => {
    const sorted = sortEvents([
      event({ eventId: "old", timestamp: "2026-05-14T10:00:00.000Z" }),
      event({ eventId: "new", timestamp: "2026-05-14T11:00:00.000Z" }),
    ]);

    expect(sorted.map((item) => item.eventId)).toEqual(["new", "old"]);
    expect(extractTaskId(event({ payload: { task: { taskId: "task-2" } } }))).toBe("task-2");
    expect(extractTaskId(event({ payload: { taskId: "task-1" } }))).toBe("task-1");
    expect(extractSessionId(event({ payload: { session: { agentSessionId: "session-2" } } }))).toBe("session-2");
    expect(extractSessionId(event({ payload: { sessionId: "session-1" } }))).toBe("session-1");
  });

  it("summarizes realtime events into compact office activity copy", () => {
    expect(
      summarizeEvent(event({ eventType: "tool_invoked", payload: { toolName: "browser.search", outcome: "ok" } })),
    ).toBe("browser.search -> ok");
    expect(
      summarizeEvent(event({ eventType: "approval_created", payload: { kind: "filesystem", riskLevel: "high" } })),
    ).toBe("filesystem (high)");
    expect(
      summarizeEvent(event({ eventType: "activity_logged", payload: { activity: { message: "Reviewed docs" } } })),
    ).toBe("Reviewed docs");
    expect(summarizeEvent(event({ eventType: "task_created", payload: { task: { title: "Ship slice B" } } }))).toBe(
      "Ship slice B",
    );
    expect(summarizeEvent(event({ eventType: "unknown", payload: { details: "x".repeat(90) } }))).toHaveLength(80);
  });

  it("classifies operator state, attention, motion, and stored preferences", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    window.localStorage.clear();

    expect(statusScore("active")).toBe(3);
    expect(statusScore("idle")).toBe(2);
    expect(statusScore("ready")).toBe(1);
    expect(classifyAgentHeat("2026-05-14T11:59:30.000Z")).toBe("hot");
    expect(classifyAgentHeat("2026-05-14T11:55:00.000Z")).toBe("warm");
    expect(classifyAgentHeat("2026-05-13T11:30:00.000Z")).toBe("cold");
    expect(attentionLabel("priority")).toBe("Priority");
    expect(attentionLabel("stable")).toBe("Stable");
    expect(attentionPillClass("priority")).toBe("office-pill-priority");
    expect(attentionPillClass("watch")).toBe("office-pill-watch");
    expect(attentionPillClass("stable")).toBe("office-pill-active");
    expect(sanitizeOperatorName()).toBeUndefined();
    expect(sanitizeOperatorName(" ".repeat(5))).toBeUndefined();
    expect(sanitizeOperatorName("x".repeat(50))).toHaveLength(40);
    expect(isOperatorPreset("nightwatch")).toBe(true);
    expect(isOperatorPreset("invalid")).toBe(false);
    expect(isOfficeMotionMode("reduced")).toBe(true);
    expect(isOfficeMotionMode("fast")).toBe(false);
    expect(asBooleanOr("yes", false)).toBe(false);
    expect(buildOperatorThought({ activeAgents: 0, blockedAgents: 0, pendingApprovals: 0, eventFlow: 0 })).toContain(
      "Ready to assign",
    );
    expect(buildOperatorThought({ activeAgents: 3, blockedAgents: 0, pendingApprovals: 2, eventFlow: 4 })).toContain(
      "approvals pending",
    );
    expect(buildOperatorThought({ activeAgents: 3, blockedAgents: 0, pendingApprovals: 0, eventFlow: 4 })).toContain(
      "4.0 events per minute",
    );
    expect(buildOperatorThought({ activeAgents: 2, blockedAgents: 1, pendingApprovals: 0, eventFlow: 3 })).toContain(
      "blocked",
    );

    persistOperatorPreferences(
      "office-test",
      { ...DEFAULT_PREFS, name: "  Night Operator  ", preset: "strategist", motionMode: "subtle", focusMode: true },
      DEFAULT_PREFS,
    );

    expect(readOperatorPreferences("office-test", DEFAULT_PREFS)).toMatchObject({
      name: "Night Operator",
      preset: "strategist",
      layoutMode: "immersive",
      motionMode: "subtle",
      focusMode: true,
    });

    window.localStorage.setItem("office-test", "{bad json");
    expect(readOperatorPreferences("office-test", DEFAULT_PREFS)).toEqual(DEFAULT_PREFS);
  });
});

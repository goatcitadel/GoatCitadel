import { describe, expect, it } from "vitest";
import { INITIAL_RUN_STATE, countStatuses, runReducer, type RunEvent } from "../runner/state";
import { STATUS_DISPLAY, describeRunEnd, formatDuration, formatEvidence } from "./status-display";

describe("status display", () => {
  it("pairs every status with an icon and a word", () => {
    for (const display of Object.values(STATUS_DISPLAY)) {
      expect(display.icon).not.toBe("");
      expect(display.label).toMatch(/^[a-z ]+$/);
    }
    expect(STATUS_DISPLAY.pass).toEqual({ icon: "✓", label: "pass", tone: "success" });
  });

  it("formats durations and evidence", () => {
    expect(formatDuration(41)).toBe("41 ms");
    expect(formatDuration(2_400)).toBe("2.4 s");
    expect(formatEvidence("raw")).toBe("raw");
    expect(formatEvidence({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it("announces a finished run once, and nothing while running", () => {
    const running = runReducer(INITIAL_RUN_STATE, { type: "run-started", checkIds: ["a"], at: "t" });
    expect(describeRunEnd(running, countStatuses(running, ["a"]))).toBe("");
    const finishing: RunEvent[] = [
      { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
      { type: "run-finished", at: "t", reason: "completed" },
    ];
    const done = finishing.reduce(runReducer, running);
    expect(describeRunEnd(done, countStatuses(done, ["a"]))).toBe(
      "Run completed: 1 pass, 0 fail, 0 blocked, 0 skipped.",
    );
  });
});

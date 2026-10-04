import { describe, expect, it } from "vitest";
import { INITIAL_RUN_STATE, countStatuses, recordFor, runReducer, type RunEvent, type RunState } from "./state";

function apply(events: readonly RunEvent[], start: RunState = INITIAL_RUN_STATE): RunState {
  return events.reduce(runReducer, start);
}

const AT = "2026-10-03T12:00:00.000Z";

describe("runReducer", () => {
  it("queues checks, records steps and logs, and finishes them without mutating earlier state", () => {
    const started = apply([{ type: "run-started", checkIds: ["a", "b"], at: AT }]);
    const finished = apply(
      [
        { type: "check-started", checkId: "a", at: AT },
        { type: "step-started", checkId: "a", title: "Seed" },
        { type: "step-finished", checkId: "a", title: "Seed", status: "pass" },
        { type: "check-logged", checkId: "a", entry: { at: AT, message: "seeded" } },
        { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 12 },
        { type: "check-skipped", checkId: "b", reason: "Mutating checks never run on the real gateway." },
        { type: "run-finished", at: AT, reason: "completed" },
      ],
      started,
    );
    expect(recordFor(started, "a").status).toBe("queued");
    expect(recordFor(finished, "a")).toEqual({
      status: "pass",
      summary: "ok",
      evidence: undefined,
      durationMs: 12,
      steps: [{ title: "Seed", status: "pass" }],
      log: [{ at: AT, message: "seeded" }],
    });
    expect(recordFor(finished, "b")).toMatchObject({
      status: "skipped",
      summary: expect.stringContaining("real gateway"),
    });
    expect(finished).toMatchObject({ running: false, endReason: "completed", finishedAt: AT });
  });

  it("marks leftover checks cancelled when stopped and not run when the gateway became unreachable", () => {
    const queued = apply([{ type: "run-started", checkIds: ["a", "b"], at: AT }]);
    const stopped = runReducer(queued, { type: "run-finished", at: AT, reason: "stopped" });
    const unreachable = runReducer(queued, {
      type: "run-finished",
      at: AT,
      reason: "unreachable",
      banner: "Gateway unreachable: fetch failed",
    });
    expect(recordFor(stopped, "a").status).toBe("cancelled");
    expect(recordFor(unreachable, "b").status).toBe("not-run");
    expect(unreachable.banner).toBe("Gateway unreachable: fetch failed");
  });

  it("finishes the most recent running step with the same title", () => {
    const state = apply([
      { type: "check-started", checkId: "a", at: AT },
      { type: "step-started", checkId: "a", title: "Poll" },
      { type: "step-finished", checkId: "a", title: "Poll", status: "pass" },
      { type: "step-started", checkId: "a", title: "Poll" },
      { type: "step-finished", checkId: "a", title: "Poll", status: "fail" },
    ]);
    expect(recordFor(state, "a").steps).toEqual([
      { title: "Poll", status: "pass" },
      { title: "Poll", status: "fail" },
    ]);
  });

  it("returns an empty not-run record for unknown checks and counts statuses", () => {
    const state = apply([
      { type: "check-finished", checkId: "a", status: "fail", summary: "bad", durationMs: 1 },
      { type: "check-finished", checkId: "b", status: "blocked", summary: "off", durationMs: 1 },
    ]);
    expect(recordFor(state, "missing").status).toBe("not-run");
    expect(countStatuses(state, ["a", "b", "missing"])).toMatchObject({ fail: 1, blocked: 1, "not-run": 1, pass: 0 });
  });

  it("settles running steps to fail when a check is stopped with inflight work", () => {
    const events: RunEvent[] = [
      { type: "run-started", checkIds: ["a"], at: AT },
      { type: "check-started", checkId: "a", at: AT },
      { type: "step-started", checkId: "a", title: "Poll" },
      { type: "run-finished", at: AT, reason: "stopped" },
    ];
    const state = apply(events);
    const record = recordFor(state, "a");
    expect(record.status).toBe("cancelled");
    expect(record.steps).toEqual([{ title: "Poll", status: "fail" }]);
    expect(state.running).toBe(false);
    expect(state.endReason).toBe("stopped");
  });

  it("settles running steps to fail when check-finished is called with unclosed steps", () => {
    const events: RunEvent[] = [
      { type: "check-started", checkId: "a", at: AT },
      { type: "step-started", checkId: "a", title: "Seed" },
      { type: "check-finished", checkId: "a", status: "fail", summary: "error", durationMs: 5 },
    ];
    const state = apply(events);
    const record = recordFor(state, "a");
    expect(record.steps).toEqual([{ title: "Seed", status: "fail" }]);
    expect(record.status).toBe("fail");
  });

  it("ignores late events after a check becomes terminal", () => {
    const events: RunEvent[] = [
      { type: "check-started", checkId: "a", at: AT },
      { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
    ];
    const state = apply(events);
    const lateStepStarted = runReducer(state, { type: "step-started", checkId: "a", title: "Late" });
    const lateCheckLogged = runReducer(lateStepStarted, {
      type: "check-logged",
      checkId: "a",
      entry: { at: AT, message: "too late" },
    });
    expect(state).toBe(lateStepStarted);
    expect(lateStepStarted).toBe(lateCheckLogged);
  });

  it("marks queued checks not-run when run finishes with completed reason", () => {
    const events: RunEvent[] = [
      { type: "run-started", checkIds: ["a", "b"], at: AT },
      { type: "check-started", checkId: "a", at: AT },
      { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
      { type: "run-finished", at: AT, reason: "completed" },
    ];
    const state = apply(events);
    expect(recordFor(state, "a").status).toBe("pass");
    expect(recordFor(state, "b").status).toBe("not-run");
  });
});

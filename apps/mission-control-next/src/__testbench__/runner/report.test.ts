import { describe, expect, it } from "vitest";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import { pass } from "./assert";
import { buildMarkdownReport, describeCoverage, describeTarget } from "./report";
import { INITIAL_RUN_STATE, runReducer, type RunEvent } from "./state";
import type { CheckDef } from "./types";

const CHECKS: CheckDef[] = [
  {
    id: "a",
    kind: "probe",
    domain: "chat",
    title: "Chat | sessions",
    tier: "read",
    routes: ["GET /api/v1/a"],
    run: async () => pass("ok"),
  },
  {
    id: "b",
    kind: "probe",
    domain: "memory",
    title: "Memory",
    tier: "mutate",
    routes: ["GET /api/v1/b"],
    run: async () => pass("ok"),
  },
];

const EVENTS: RunEvent[] = [
  { type: "check-finished", checkId: "a", status: "fail", summary: "Broke\nhere | badly", durationMs: 3 },
  { type: "check-finished", checkId: "b", status: "pass", summary: "ok", durationMs: 3 },
];

describe("buildMarkdownReport", () => {
  it("summarizes the target, coverage, counts, and failing checks", () => {
    const state = EVENTS.reduce(runReducer, INITIAL_RUN_STATE);
    const markdown = buildMarkdownReport({
      target: SANDBOX_TARGET,
      coverage: { total: 4, covered: 1, uncovered: [], staleClaims: [] },
      checks: CHECKS,
      state,
      generatedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(markdown).toContain("# GoatCitadel test bench report");
    expect(markdown).toContain("- Coverage: 1 / 4 routes (25%)");
    expect(markdown).toContain("- Results: 1 pass, 1 fail, 0 blocked, 0 skipped, 0 cancelled, 0 not run");
    expect(markdown).toContain("| fail | chat | Chat \\| sessions | Broke here \\| badly |");
  });

  it("omits the problem table when nothing failed", () => {
    const markdown = buildMarkdownReport({
      target: REAL_TARGET,
      coverage: undefined,
      checks: CHECKS,
      state: INITIAL_RUN_STATE,
      generatedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(markdown).not.toContain("## Failing and blocked");
    expect(markdown).toContain("unavailable");
  });
});

describe("describeTarget and describeCoverage", () => {
  it("names the sandbox root and any failed sandbox condition", () => {
    expect(describeTarget(SANDBOX_TARGET)).toContain("root /tmp/goatcitadel-usability-testbench");
    expect(describeTarget({ ...REAL_TARGET, reason: "No sandbox was launched." })).toContain("sandbox check failed");
    expect(describeCoverage({ total: 0, covered: 0, uncovered: [], staleClaims: [] })).toBe("0 / 0 routes (0%)");
  });
});

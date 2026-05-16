import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CuratorRunReport } from "@goatcitadel/contracts";
import { writeCuratorReport } from "./curator-report.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "curator-report-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function makeReport(overrides: Partial<CuratorRunReport> = {}): CuratorRunReport {
  return {
    runId: "curator-run-abc",
    startedAt: "2026-05-15T12:00:00Z",
    finishedAt: "2026-05-15T12:00:05Z",
    triggerMode: "synchronous",
    dryRun: false,
    cycleDays: 7,
    totalSkills: 2,
    immuneCount: 1,
    scoredCount: 2,
    archivedCount: 1,
    prunedCount: 0,
    consolidationGroupCount: 0,
    entries: [
      {
        skillId: "skill-alpha",
        name: "alpha",
        recommendation: "archive",
        score: {
          honesty: 0.4,
          blockerQuality: 0.4,
          retryQuality: 0.4,
          toolEvidence: 0.4,
          actionability: 0.4,
          mean: 0.4,
        },
        signals: ["never_used"],
        action: "archived",
        actionReason: "rubric_below_threshold",
      },
      {
        skillId: "skill-beta",
        name: "beta",
        recommendation: "keep",
        score: {
          honesty: 0.8,
          blockerQuality: 0.8,
          retryQuality: 0.8,
          toolEvidence: 0.8,
          actionability: 0.8,
          mean: 0.8,
        },
        signals: ["high_usage"],
        action: "skipped_immune",
        actionReason: "bundled",
      },
    ],
    reportDir: "",
    ...overrides,
  };
}

describe("writeCuratorReport", () => {
  it("writes run.json with full report JSON", async () => {
    const report = makeReport();
    const dir = await writeCuratorReport(report, { logsRoot: workspace });
    expect(dir.endsWith(path.join("logs", "curator", "curator-run-abc"))).toBe(true);
    const runJson = await readFile(path.join(dir, "run.json"), "utf-8");
    const parsed = JSON.parse(runJson);
    expect(parsed.runId).toBe("curator-run-abc");
    expect(parsed.archivedCount).toBe(1);
    expect(parsed.entries).toHaveLength(2);
  });

  it("writes REPORT.md with human-readable summary", async () => {
    const report = makeReport();
    const dir = await writeCuratorReport(report, { logsRoot: workspace });
    const md = await readFile(path.join(dir, "REPORT.md"), "utf-8");
    expect(md).toContain("# Curator Run curator-run-abc");
    expect(md).toContain("## Archived (1)");
    expect(md).toContain("alpha");
    expect(md).toContain("Immune (1)");
    expect(md).toContain("beta");
  });
});

import { describe, expect, it } from "vitest";
import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { deriveHealthChecks, summarizeHealthChecks } from "./health-overview";

const healthy: HealthSummaryResponse = {
  generatedAt: "2026-09-28T12:00:00Z",
  database: { driver: "postgres", configured: true, reachable: true, issues: [] },
  systemVitals: {
    hostname: "host", platform: "win32", release: "11", uptimeSeconds: 10, loadAverage: [], cpuCount: 8,
    memoryTotalBytes: 100, memoryFreeBytes: 50, memoryUsedBytes: 50, processRssBytes: 10, processHeapUsedBytes: 5,
  },
  daemonStatus: {
    running: true, pid: 1, uptimeSeconds: 10, host: "host", state: "running", supported: true,
    controllable: true, controlMessage: "Ready", diagnostics: [],
  },
  daemonLogs: { items: [] },
  costs: { summary: { scope: "all", from: "2026-09-27", to: "2026-09-28", items: [] }, qmd: {
    totalRuns: 0, compressionPercent: 0, expansionPercent: 0, efficiencyLabel: "neutral",
  } },
  backups: { items: [], latest: { backupId: "backup", createdAt: "2026-09-28T10:00:00Z", files: [], verified: true, contractVerified: true } },
};

describe("system health checks", () => {
  it("shows only checks backed by the summary and does not claim restore proof", () => {
    const checks = deriveHealthChecks(healthy);
    expect(checks.map((item) => [item.id, item.status.label])).toEqual([
      ["gateway", "Responding"], ["database", "Reachable"], ["service", "Running"], ["backups", "Verified record"],
    ]);
    expect(checks.find((item) => item.id === "backups")?.detail).toContain("full restore is not proven");
  });

  it("puts failed and uncertain owners in review without showing raw database issues", () => {
    const checks = deriveHealthChecks({
      ...healthy,
      database: { driver: "postgres", configured: true, reachable: false, issues: ["secret/path/error"] },
      daemonStatus: { ...healthy.daemonStatus, running: false, state: "stopped" },
      backups: { items: [], latest: null },
    });
    expect(checks.filter((item) => item.status.tone === "failed").map((item) => item.id)).toEqual(["database", "service"]);
    expect(checks.find((item) => item.id === "backups")?.status.tone).toBe("waiting");
    expect(JSON.stringify(checks)).not.toContain("secret/path/error");
  });

  it("limits the sidebar claim to checks returned by the summary", () => {
    expect(summarizeHealthChecks(deriveHealthChecks(healthy))).toEqual({ label: "Reported system checks clear", tone: "done" });
    const unknown = deriveHealthChecks({ ...healthy, database: undefined });
    expect(summarizeHealthChecks(unknown)).toEqual({ label: "Some system checks lack live proof", tone: "neutral" });
    const attention = deriveHealthChecks({ ...healthy, backups: { items: [], latest: null } });
    expect(summarizeHealthChecks(attention)).toEqual({ label: "1 system check needs review", tone: "waiting" });
    const unverified = deriveHealthChecks({ ...healthy, backups: { items: [], latest: { backupId: "backup", createdAt: "2026-09-28T10:00:00Z", files: [] } } });
    expect(unverified.find((item) => item.id === "backups")?.status.tone).toBe("waiting");
  });
});

import { describe, expect, it } from "vitest";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { backupTrustFromInbox } from "./backup-trust";
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
  // The health summary lists manifests only; it never carries verification results.
  backups: { items: [], latest: { backupId: "backup", createdAt: "2026-09-28T10:00:00Z", files: [] } },
};

function inbox(coverageState: OperatorInboxResponse["coverage"][number]["state"], itemId?: string): OperatorInboxResponse {
  return {
    authority: "derived_projection",
    workspaceId: "default",
    generatedAt: "2026-09-28T12:00:00Z",
    coverage: [{ source: "backup_trust", state: coverageState, backupTrust: {
      state: itemId === "backup_trust:stale" ? "stale" : itemId === "backup_trust:failed" ? "failed" : "verified",
      backupId: "backup", createdAt: "2026-09-28T10:00:00Z", observedAt: "2026-09-28T12:00:00Z",
    } }],
    items: itemId
      ? [{ id: itemId, kind: "backup_trust", group: "needs_attention", title: "t", summary: "s", createdAt: "x",
          source: { workspaceId: "default" }, href: "/system/health" } as OperatorInboxResponse["items"][number]]
      : [],
    counts: {} as OperatorInboxResponse["counts"],
  };
}

describe("system health checks", () => {
  it("shows only checks backed by evidence and does not claim restore proof", () => {
    const checks = deriveHealthChecks(healthy, "verified");
    expect(checks.map((item) => [item.id, item.status.label])).toEqual([
      ["gateway", "Responding"], ["database", "Reachable"], ["service", "Running"], ["backups", "Verified"],
    ]);
    expect(checks.find((item) => item.id === "backups")?.detail).toContain("full restore is not proven");
  });

  it("puts failed and uncertain owners in review without showing raw database issues", () => {
    const checks = deriveHealthChecks({
      ...healthy,
      database: { driver: "postgres", configured: true, reachable: false, issues: ["secret/path/error"] },
      daemonStatus: { ...healthy.daemonStatus, running: false, state: "stopped" },
    }, "failed");
    expect(checks.filter((item) => item.status.tone === "failed").map((item) => item.id)).toEqual([
      "database", "service", "backups",
    ]);
    expect(JSON.stringify(checks)).not.toContain("secret/path/error");
  });

  it("limits the sidebar claim to checks returned by the summary", () => {
    expect(summarizeHealthChecks(deriveHealthChecks(healthy, "verified"))).toEqual({ label: "Reported system checks clear", tone: "done" });
    const unknown = deriveHealthChecks({ ...healthy, database: undefined }, "verified");
    expect(summarizeHealthChecks(unknown)).toEqual({ label: "Some system checks lack live proof", tone: "neutral" });
    expect(summarizeHealthChecks(deriveHealthChecks(healthy, "stale"))).toEqual({ label: "1 system check needs review", tone: "waiting" });
  });

  it("never warns on a brand-new install that has no backup yet", () => {
    const fresh = deriveHealthChecks({ ...healthy, backups: { items: [], latest: null } }, "none");
    expect(fresh.find((item) => item.id === "backups")).toMatchObject({ notSetUp: true, status: { label: "No backup yet", tone: "neutral" } });
    expect(summarizeHealthChecks(fresh)).toEqual({ label: "Reported system checks clear", tone: "done" });
  });

  it("does not invent verification it has not read", () => {
    const pending = deriveHealthChecks(healthy, undefined).find((item) => item.id === "backups");
    expect(pending?.status).toEqual({ label: "Not verified yet", tone: "neutral" });
  });

  it("reads backup verification from the Inbox projection", () => {
    expect(backupTrustFromInbox(undefined)).toBeUndefined();
    expect(backupTrustFromInbox(inbox("not_enabled"), null)).toBe("none");
    expect(backupTrustFromInbox(inbox("unavailable"))).toBe("unknown");
    expect(backupTrustFromInbox(inbox("current"), healthy.backups.latest)).toBe("verified");
    expect(backupTrustFromInbox(inbox("limited", "backup_trust:stale"), healthy.backups.latest)).toBe("stale");
    expect(backupTrustFromInbox(inbox("current", "backup_trust:failed"), healthy.backups.latest)).toBe("failed");
  });
});

import { healthOverviewState } from "./health-overview";
it("separates actionable problems, missing proof and verified available evidence", () => {
  const done = { id: "gateway", title: "Gateway", detail: "Responding", inspectPath: "/ops/runtime", status: { tone: "done", label: "Responding" } } as const;
  const unknown = { ...done, id: "database" as const, status: { tone: "neutral" as const, label: "Unknown" } };
  const failed = { ...done, id: "models" as const, status: { tone: "failed" as const, label: "Problem" } };
  expect(healthOverviewState([done])).toMatchObject({ kind: "clear", problems: [], unknown: [] });
  expect(healthOverviewState([done, unknown])).toMatchObject({ kind: "incomplete", unknown: [unknown] });
  expect(healthOverviewState([failed, unknown])).toMatchObject({ kind: "problems", problems: [failed], unknown: [unknown] });
  expect(healthOverviewState([]).kind).toBe("incomplete");
});

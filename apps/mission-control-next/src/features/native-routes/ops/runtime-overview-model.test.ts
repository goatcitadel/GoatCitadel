import { describe, expect, it } from "vitest";
import { describeRuntimeService } from "@goatcitadel/mission-control-shared/content/runtime-service";
import {
  buildNeedsAttentionItems,
  buildOpsHeadMetrics,
  presentPendingApprovals,
  presentRuntimeDaemon,
  presentRuntimeReadiness,
} from "./runtime-overview-model";

type Data = Parameters<typeof buildOpsHeadMetrics>[1];
const base = (overrides: Record<string, unknown> = {}): Data =>
  ({
    sourceStatus: {
      daemon: { status: "ok" },
      health: { status: "ok" },
      backups: { status: "ok" },
      dashboard: { status: "ok" },
    },
    daemon: { running: true, supported: true },
    health: undefined,
    dashboard: undefined,
    mcpServers: [],
    backups: [],
    sessions: [],
    ...overrides,
  }) as unknown as Data;
const metric = (metrics: ReturnType<typeof buildOpsHeadMetrics>, label: string) =>
  metrics.find((item) => item.label.startsWith(label))?.value;

describe("runtime head metrics", () => {
  it("shows Unknown, not 0, when the dashboard and the host give no approval count", () => {
    expect(metric(buildOpsHeadMetrics("runtime", base(), undefined), "Pending approvals")).toBe("Unknown");
  });

  it("labels an installation-wide approval count", () => {
    const metrics = buildOpsHeadMetrics("runtime", base({ dashboard: { pendingApprovals: 2 } }), undefined);
    expect(metrics.find((item) => item.label.startsWith("Pending approvals"))).toEqual(
      expect.objectContaining({ label: "Pending approvals, all workspaces", value: "2" }),
    );
  });

  it("shows Unknown for backups and CPU when their source failed", () => {
    const failed = base({
      sourceStatus: { daemon: { status: "ok" }, health: { status: "error" }, backups: { status: "error" } },
    });
    expect(metric(buildOpsHeadMetrics("runtime", failed, undefined), "Backups")).toBe("Unknown");
    expect(metric(buildOpsHeadMetrics("diagnostics", failed, undefined), "CPU")).toBe("Unknown");
  });

  it("agrees with Health: an unsupported host reads Unavailable, and a stopped service reads Problem", () => {
    const unsupported = base({ daemon: { running: true, supported: false } });
    expect(metric(buildOpsHeadMetrics("runtime", unsupported, undefined), "Daemon")).toBe("Unavailable");
    expect(
      metric(
        buildOpsHeadMetrics("runtime", base({ daemon: { running: false, supported: true } }), undefined),
        "Daemon",
      ),
    ).toBe("Problem");
    expect(metric(buildOpsHeadMetrics("runtime", base(), undefined), "Daemon")).toBe("Running");
  });

  it.each([
    { running: false, supported: true },
    { running: true, supported: true, diagnostics: [{ severity: "critical" }] },
    { running: true, supported: true, diagnostics: [{ severity: "warn" }] },
    { running: true, supported: true },
    { running: true },
    { supported: false },
  ])("Runtime and Health use the same daemon words for %j", (daemon) => {
    const expected = describeRuntimeService(daemon as never).label;
    expect(presentRuntimeDaemon(base({ daemon })).label).toBe(expected);
    expect(metric(buildOpsHeadMetrics("runtime", base({ daemon }), undefined), "Daemon")).toBe(expected);
  });

  it("presents pending approvals once: labelled when installation-wide, Unknown when missing", () => {
    expect(presentPendingApprovals(base({ dashboard: { pendingApprovals: 3 } }), undefined)).toEqual({
      label: "Pending approvals, all workspaces",
      value: "3",
    });
    expect(presentPendingApprovals(base(), 4)).toEqual({ label: "Pending approvals", value: "4" });
    expect(presentPendingApprovals(base(), undefined)).toEqual({ label: "Pending approvals", value: "Unknown" });
  });

  it("raises no daemon attention item on a host where service control is unavailable", () => {
    const ids = buildNeedsAttentionItems(
      base({ daemon: { running: false, supported: false } }),
      undefined,
      "ops" as never,
    ).map((item) => item.id);
    expect(ids).not.toContain("daemon-runtime");
  });

  it("raises a daemon attention item for warning or critical diagnostics on a running daemon", () => {
    const withDiagnostics = (severity: string) =>
      buildNeedsAttentionItems(
        base({ daemon: { running: true, supported: true, diagnostics: [{ id: "d", severity }] } }),
        undefined,
        "ops" as never,
      ).find((item) => item.id === "daemon-runtime");
    expect(withDiagnostics("critical")).toMatchObject({ meta: "problem", tone: "danger" });
    expect(withDiagnostics("warn")).toMatchObject({ meta: "needs review", tone: "caution" });
    expect(withDiagnostics("info")).toBeUndefined();
  });
});

describe("runtime hero readiness", () => {
  it("derives the chip, tone and line from the shared service status, not the running flag", () => {
    const running = (extra: Record<string, unknown>) =>
      presentRuntimeReadiness(base({ daemon: { running: true, supported: true, ...extra } }));
    expect(running({})).toMatchObject({ chip: "Runtime ready", tone: "success" });
    expect(running({ diagnostics: [{ id: "d", severity: "critical" }] })).toMatchObject({
      chip: "Runtime problem",
      tone: "critical",
    });
    expect(running({ diagnostics: [{ id: "d", severity: "warn" }] })).toMatchObject({
      chip: "Runtime needs review",
      tone: "warning",
    });
    expect(presentRuntimeReadiness(base({ daemon: { running: true, supported: false } }))).toMatchObject({
      chip: "Service control unavailable",
      tone: "muted",
    });
    expect(presentRuntimeReadiness(base({ daemon: { running: false, supported: true } }))).toMatchObject({
      chip: "Daemon stopped",
      tone: "warning",
    });
  });
});

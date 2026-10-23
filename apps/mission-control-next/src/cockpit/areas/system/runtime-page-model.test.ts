import { describe, expect, it } from "vitest";
import { describeRuntimeService } from "@goatcitadel/mission-control-shared/content/runtime-service";
import {
  comparisonRunStatus,
  engineFitStatus,
  integrationRows,
  modelPerformanceMetrics,
  localModelStatus,
  runtimeDiagnosticRows,
  runtimeSectionForHash,
  runtimeServerMetrics,
  runtimeServerStatus,
} from "./runtime-page-model";
import { runtimeData, testDaemon as daemon } from "./runtime-page.test-data";

describe("runtimeServerStatus", () => {
  it("reads Unknown when the daemon and health sources both failed", () => {
    const status = runtimeServerStatus(runtimeData({}, ["daemon", "health"]));
    expect(status).toMatchObject({ label: "Unknown", tone: "neutral" });
  });

  it("agrees with System › Health for a running daemon", () => {
    const expected = describeRuntimeService(daemon as never);
    expect(runtimeServerStatus(runtimeData())).toMatchObject({ label: expected.label, tone: expected.tone });
  });
});

describe("runtimeServerMetrics", () => {
  it("reads Unknown memory when the health source failed", () => {
    const memory = runtimeServerMetrics(runtimeData({}, ["health"])).find((item) => item.term === "Memory used");
    expect(memory?.value).toBe("Unknown");
  });

  it("adds database waits when the health summary reports them", () => {
    const data = runtimeData({
      health: {
        daemonStatus: daemon,
        systemVitals: {},
        database: { storageWait: { p95Ms: 12, maxMs: 40, count: 3, criticalCount: 0 } },
      },
    });
    const terms = runtimeServerMetrics(data).map((item) => item.term);
    expect(terms).toContain("Database wait p95");
    expect(terms).toContain("Database wait max");
  });
});

describe("runtimeDiagnosticRows", () => {
  it("presents a warning diagnostic as waiting", () => {
    const data = runtimeData({
      daemon: { ...daemon, diagnostics: [{ id: "d1", title: "Port in use", detail: "8787", severity: "warn" }] },
    });
    expect(runtimeDiagnosticRows(data)[0]).toMatchObject({
      title: "Port in use",
      severity: { label: "Warning", tone: "waiting" },
    });
  });
});

describe("localModelStatus", () => {
  it("reads Unknown when the local model source failed", () => {
    expect(localModelStatus(runtimeData({}, ["llamaCpp"]))).toMatchObject({ label: "Unknown", tone: "neutral" });
  });

  it("reads Running for a healthy running process", () => {
    const data = runtimeData({ llamaCpp: { processState: "running", healthy: true } });
    expect(localModelStatus(data)).toMatchObject({ label: "Running", tone: "done" });
  });

  it("asks for review when the process is unhealthy", () => {
    const data = runtimeData({ llamaCpp: { processState: "running", healthy: false } });
    expect(localModelStatus(data)).toMatchObject({ label: "Needs review", tone: "waiting" });
  });
});

describe("integrationRows", () => {
  it("presents enabled and disabled MCP servers as On and Off", () => {
    const data = runtimeData({
      mcpServers: [
        { serverId: "a", label: "Files", enabled: true, transport: "stdio", category: "files" },
        { serverId: "b", label: "Search", enabled: false, transport: "http" },
      ],
    });
    expect(integrationRows(data).map((row) => row.status.label)).toEqual(["On", "Off"]);
  });
});

describe("runtimeSectionForHash", () => {
  it("maps legacy runtime anchors to native sections", () => {
    expect(runtimeSectionForHash("#ops-runtime-posture")).toBe("runtime-server");
    expect(runtimeSectionForHash("#ops-runtime-backups")).toBe("ops-runtime-backups");
    expect(runtimeSectionForHash("#ops-runtime-integrations")).toBe("runtime-integrations");
    expect(runtimeSectionForHash("#nope")).toBeNull();
  });
});

describe("model performance", () => {
  it("reads Unknown response time when measurements could not be read, not 0 ms", () => {
    const metric = modelPerformanceMetrics(runtimeData({}, ["runtimeMeasurements"])).find(
      (item) => item.term === "Average response time",
    );
    expect(metric?.value).toBe("Unknown");
  });

  it("averages completed calls only", () => {
    const data = runtimeData({
      runtimeMeasurements: [
        { status: "completed", metrics: { latencyMs: 100 } },
        { status: "completed", metrics: { latencyMs: 300 } },
        { status: "failed", metrics: { latencyMs: 9000 } },
      ],
    });
    const metric = modelPerformanceMetrics(data).find((item) => item.term === "Average response time");
    expect(metric?.value).toBe("200 ms");
  });

  it("presents engine fit and comparison runs in operator words", () => {
    expect(engineFitStatus("weak")).toEqual({ label: "Weak fit", tone: "waiting" });
    expect(engineFitStatus("strong")).toEqual({ label: "Good fit", tone: "done" });
    expect(engineFitStatus("unknown")).toEqual({ label: "Not measured", tone: "neutral" });
    expect(comparisonRunStatus("completed_with_warnings")).toEqual({ label: "Done with warnings", tone: "waiting" });
  });
});

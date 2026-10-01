import { describe, expect, it } from "vitest";
import type { DesktopUpdateStatus } from "@goatcitadel/contracts";
import { summarizeHealthChecks } from "./health-overview";
import { deriveSystemHealthChecks } from "./system-health";
import type { SystemHealthSources } from "./system-health-sources";

const missing: SystemHealthSources = {
  summary: { state: "unavailable", detail: "Unavailable" },
  llama: { state: "unavailable", detail: "Unavailable" },
  npu: { state: "unavailable", detail: "Unavailable" },
  connections: { state: "unavailable", detail: "Unavailable" },
  channels: { state: "unavailable", detail: "Unavailable" },
  workers: { state: "unavailable", detail: "Unavailable" },
};

describe("complete cockpit health projection", () => {
  it("does not turn unavailable owners or absent desktop updates into healthy status", () => {
    const checks = deriveSystemHealthChecks(missing, null);
    expect(checks).toHaveLength(9);
    expect(checks.every((check) => check.status.tone === "neutral")).toBe(true);
    expect(summarizeHealthChecks(checks).label).toContain("lack live proof");
  });

  it("reports owner problems while keeping registry-only worker health unknown", () => {
    const updates = { phase: "available", availableRelease: { version: "1.0.1" } } as DesktopUpdateStatus;
    const sources = {
      ...missing,
      llama: { state: "current", value: { enabled: true, healthy: false, processState: "error" } },
      npu: { state: "current", value: { enabled: false, healthy: false, processState: "stopped" } },
      connections: { state: "current", value: [{ kind: "external_connector", enabled: true, status: "error" }] },
      channels: { state: "current", value: { enabledCount: 1, checked: [{ connection: { kind: "channel", enabled: true }, runtime: { state: "current", value: { ready: false } } }] } },
      workers: { state: "current", value: { items: [{ posture: { value: "active" } }] } },
    } as unknown as SystemHealthSources;
    const checks = deriveSystemHealthChecks(sources, updates);
    expect(checks.find((check) => check.id === "models")?.status.tone).toBe("failed");
    expect(checks.find((check) => check.id === "channels")?.status.tone).toBe("waiting");
    expect(checks.find((check) => check.id === "integrations")?.status.tone).toBe("failed");
    expect(checks.find((check) => check.id === "updates")?.status.tone).toBe("waiting");
    expect(checks.find((check) => check.id === "remote_workers")?.status.tone).toBe("neutral");
  });
});

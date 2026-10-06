import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSystemHealthDigest, loadSystemHealthSources } from "./system-health-sources";

const api = vi.hoisted(() => ({
  fetchHealthSummary: vi.fn(),
  fetchLlamaCppStatus: vi.fn(),
  fetchNpuStatus: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchRemoteWorkerRegistry: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchHealthSummary: api.fetchHealthSummary,
  fetchLlamaCppStatus: api.fetchLlamaCppStatus,
  fetchNpuStatus: api.fetchNpuStatus,
  fetchIntegrationConnections: api.fetchIntegrationConnections,
  fetchChannelRuntimeStatus: api.fetchChannelRuntimeStatus,
}));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerRegistry: api.fetchRemoteWorkerRegistry,
}));

const channel = { connectionId: "c1", kind: "channel", enabled: true };

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchHealthSummary.mockResolvedValue({ ok: true });
  api.fetchLlamaCppStatus.mockResolvedValue({ enabled: false });
  api.fetchNpuStatus.mockResolvedValue({ enabled: false });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [channel] });
  api.fetchChannelRuntimeStatus.mockResolvedValue({ ready: true });
  api.fetchRemoteWorkerRegistry.mockResolvedValue({ items: [] });
});

describe("system health reads", () => {
  it("the digest makes exactly four reads and defers channels and workers", async () => {
    const digest = await loadSystemHealthDigest();
    const calls = Object.values(api).reduce((total, mock) => total + mock.mock.calls.length, 0);
    expect(calls).toBe(4);
    expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
    expect(api.fetchRemoteWorkerRegistry).not.toHaveBeenCalled();
    expect(digest.channels).toEqual({ state: "deferred" });
    expect(digest.workers).toEqual({ state: "deferred" });
    expect(digest.connections).toEqual({ state: "current", value: [channel] });
  });

  it("the digest keeps partial truth when one read fails", async () => {
    api.fetchNpuStatus.mockRejectedValue(new Error("NPU sidecar offline"));
    const digest = await loadSystemHealthDigest();
    expect(digest.npu.state).toBe("unavailable");
    expect(digest.summary.state).toBe("current");
  });

  it("the full fan-out still reads channel runtimes and remote workers", async () => {
    const sources = await loadSystemHealthSources("w");
    expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledWith("c1");
    expect(api.fetchRemoteWorkerRegistry).toHaveBeenCalledWith("w", { limit: 100 });
    expect(sources.channels.state).toBe("current");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSystemHealthDigest, loadSystemHealthSources } from "./system-health-sources";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { deriveSystemHealthChecks } from "./system-health";

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
  it("preserves a current channel failure beside another channel's stale observation", async () => {
    api.fetchHealthSummary.mockResolvedValue({ daemonStatus: {}, backups: {} });
    api.fetchIntegrationConnections.mockResolvedValue({ items: [channel, { ...channel, connectionId: "c2" }] });
    const first = await loadSystemHealthSources("w");
    api.fetchChannelRuntimeStatus.mockImplementation(async (id: string) => {
      if (id === "c2") throw new TypeError("Failed to fetch");
      return { ready: false };
    });
    const next = await loadSystemHealthSources("w", first);
    const check = deriveSystemHealthChecks(next, null).find((item) => item.id === "channels");
    expect(check?.status).toEqual({ label: "Needs review", tone: "waiting" });
    expect(check?.detail).toContain("1 enabled channel is not ready");
    expect(check?.detail).not.toContain("Last known");
    expect(check?.lastKnown).toContain("Last known (Channels, checked ");
  });
  describe("a retired channel's saved connection", () => {
    // Saved as enabled, the way it was left when the channel was retired.
    const retired = (key: string, connectionId: string) => ({ connectionId, kind: "channel", key, enabled: true });
    beforeEach(() => {
      api.fetchHealthSummary.mockResolvedValue({ daemonStatus: {}, backups: {} });
    });

    it.each(["signal", "imessage", "zalouser"])(
      "is left out of the runtime checks: a retired %s connection is out of service, not unhealthy",
      async (key) => {
        api.fetchIntegrationConnections.mockResolvedValue({ items: [channel, retired(key, "gone")] });
        const sources = await loadSystemHealthSources("w");
        expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledTimes(1);
        expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledWith("c1");
        expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalledWith("gone");
        expect(sources.channels).toMatchObject({ state: "current", value: { enabledCount: 1 } });
        const check = deriveSystemHealthChecks(sources, null).find((item) => item.id === "channels");
        expect(check?.status).toEqual({ label: "Ready", tone: "done" });
        expect(check?.detail).toContain("1 enabled channel runtime reports ready");
      },
    );

    it("does not make the Channels check read as failing when it is the only enabled channel", async () => {
      api.fetchIntegrationConnections.mockResolvedValue({ items: [retired("signal", "gone")] });
      api.fetchChannelRuntimeStatus.mockResolvedValue({ ready: false });
      const sources = await loadSystemHealthSources("w");
      expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
      expect(sources.channels).toMatchObject({ state: "current", value: { enabledCount: 0, checked: [] } });
      const check = deriveSystemHealthChecks(sources, null).find((item) => item.id === "channels");
      expect(check?.detail).toBe("No channel connection is enabled.");
      expect(check?.status.tone).not.toBe("waiting");
      expect(check?.status.tone).not.toBe("failed");
    });
  });
  it("the digest makes exactly four reads and defers channels and workers", async () => {
    const digest = await loadSystemHealthDigest();
    const calls = Object.values(api).reduce((total, mock) => total + mock.mock.calls.length, 0);
    expect(calls).toBe(4);
    expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
    expect(api.fetchRemoteWorkerRegistry).not.toHaveBeenCalled();
    expect(digest.channels).toEqual({ state: "deferred" });
    expect(digest.workers).toEqual({ state: "deferred" });
    expect(digest.connections).toMatchObject({ state: "current", value: [channel], observedAt: expect.any(Number) });
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

  it("retains a failed source observation without replacing independently refreshed sources", async () => {
    const first = await loadSystemHealthDigest();
    api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch"));
    api.fetchNpuStatus.mockResolvedValue({ enabled: true, healthy: true });
    const failed = await loadSystemHealthDigest(first);
    expect(failed.summary).toMatchObject({
      state: "unavailable",
      retryable: true,
      lastKnown: {
        value: { ok: true },
        observedAt: first.summary.state === "current" ? first.summary.observedAt : undefined,
      },
    });
    expect(failed.npu).toMatchObject({ state: "current", value: { enabled: true } });
    api.fetchHealthSummary.mockResolvedValue({ recovered: true });
    const recovered = await loadSystemHealthDigest(failed);
    expect(recovered.summary).toMatchObject({ state: "current", value: { recovered: true } });
    expect(recovered.summary).not.toHaveProperty("lastKnown");
  });

  it.each([401, 403])("does not repeat a permanently denied source %s while other sources refresh", async (status) => {
    api.fetchRemoteWorkerRegistry.mockRejectedValue(
      new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/workers", status }),
    );
    const first = await loadSystemHealthSources("w");
    const next = await loadSystemHealthSources("w", first);
    expect(api.fetchRemoteWorkerRegistry).toHaveBeenCalledTimes(1);
    expect(api.fetchHealthSummary).toHaveBeenCalledTimes(2);
    expect(next.workers).toMatchObject({ state: "unavailable", retryable: false });
  });
  it("keeps denied channel runtime reads suppressed without suppressing the connection directory", async () => {
    api.fetchChannelRuntimeStatus.mockRejectedValue(
      new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/channels/c1/runtime", status: 403 }),
    );
    const first = await loadSystemHealthSources("w");
    await loadSystemHealthSources("w", first);
    expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(api.fetchIntegrationConnections).toHaveBeenCalledTimes(2);
  });
});

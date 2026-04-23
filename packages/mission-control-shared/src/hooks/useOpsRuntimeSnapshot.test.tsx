import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpsRuntimeSnapshot } from "./useOpsRuntimeSnapshot";

const apiMocks = vi.hoisted(() => ({
  fetchCostSummary: vi.fn(),
  fetchDaemonStatus: vi.fn(),
  fetchDashboardState: vi.fn(),
  fetchHealthSummary: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchSessions: vi.fn(),
  fetchTimelineSummary: vi.fn(),
  listBackups: vi.fn(),
  restartDaemon: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchCostSummary: apiMocks.fetchCostSummary,
  fetchDaemonStatus: apiMocks.fetchDaemonStatus,
  fetchDashboardState: apiMocks.fetchDashboardState,
  fetchHealthSummary: apiMocks.fetchHealthSummary,
  fetchMcpServers: apiMocks.fetchMcpServers,
  fetchSessions: apiMocks.fetchSessions,
  fetchTimelineSummary: apiMocks.fetchTimelineSummary,
  listBackups: apiMocks.listBackups,
  restartDaemon: apiMocks.restartDaemon,
  startDaemon: apiMocks.startDaemon,
  stopDaemon: apiMocks.stopDaemon,
}));

type HookValue = ReturnType<typeof useOpsRuntimeSnapshot>;

function Harness({ onValue }: { onValue: (value: HookValue) => void }) {
  const value = useOpsRuntimeSnapshot();
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOpsRuntimeSnapshot", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HookValue | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    apiMocks.fetchDashboardState.mockResolvedValue({
      timestamp: "2026-04-22T00:00:00.000Z",
      sessions: [
        { sessionId: "session-1", displayName: "Primary", channel: "chat", lastActivityAt: "2026-04-22T00:00:00.000Z" },
      ],
      pendingApprovals: 2,
      activeSubagents: 3,
      taskStatusCounts: [],
      recentEvents: [],
      dailyCostUsd: 4.56,
    });
    apiMocks.fetchTimelineSummary.mockResolvedValue({
      generatedAt: "2026-04-22T00:00:00.000Z",
      events: { items: [] },
      sessions: { items: [] },
      scheduler: { jobs: [], reviewQueue: [] },
      improvement: { reports: [], replayRuns: [] },
    });
    apiMocks.fetchHealthSummary.mockResolvedValue({
      generatedAt: "2026-04-22T00:00:00.000Z",
      systemVitals: {
        hostname: "goat",
        platform: "win32",
        release: "1.0",
        uptimeSeconds: 120,
        loadAverage: [0.2, 0.1, 0.05],
        cpuCount: 8,
        memoryTotalBytes: 2048,
        memoryFreeBytes: 1024,
        memoryUsedBytes: 1024,
        processRssBytes: 512,
        processHeapUsedBytes: 256,
      },
      daemonStatus: {
        running: true,
        pid: 42,
        uptimeSeconds: 120,
        host: "localhost",
        state: "running",
        supported: true,
        controllable: true,
        controlMessage: "ok",
      },
      daemonLogs: { items: [] },
      costs: {
        summary: {
          scope: "day",
          from: "",
          to: "",
          items: [],
          usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
        },
        qmd: {
          totalRuns: 4,
          compressionPercent: 20,
          expansionPercent: 0,
          efficiencyLabel: "reduced",
          netTokenDelta: -220,
        },
      },
      backups: { items: [], latest: null },
    });
    apiMocks.fetchCostSummary.mockResolvedValue({
      scope: "day",
      from: "",
      to: "",
      usageAvailability: { trackedEvents: 12, unknownEvents: 1, totalAgentEvents: 13 },
      items: [
        { key: "openai:gpt-5", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 1200, costUsd: 4.56 },
      ],
    });
    apiMocks.fetchDaemonStatus.mockResolvedValue({
      running: true,
      pid: 42,
      uptimeSeconds: 120,
      host: "localhost",
      state: "running",
      supported: true,
      controllable: true,
      controlMessage: "ok",
    });
    apiMocks.listBackups.mockResolvedValue({
      items: [{ backupId: "backup-1", createdAt: "2026-04-22T00:00:00.000Z", files: [] }],
    });
    apiMocks.fetchSessions.mockResolvedValue({
      items: [
        { sessionId: "session-1", displayName: "Primary", channel: "chat", lastActivityAt: "2026-04-22T00:00:00.000Z" },
      ],
    });
    apiMocks.fetchMcpServers.mockResolvedValue({
      items: [{ serverId: "mcp-1", label: "GitHub", transport: "stdio", enabled: true, category: "code" }],
    });
    apiMocks.startDaemon.mockResolvedValue({
      accepted: true,
      reason: "Started",
      status: { running: true, host: "localhost" },
    });
    apiMocks.restartDaemon.mockResolvedValue({
      accepted: true,
      reason: "Restarted",
      status: { running: true, host: "localhost" },
    });
    apiMocks.stopDaemon.mockResolvedValue({
      accepted: true,
      reason: "Stopped",
      status: { running: false, host: "localhost" },
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("loads the canonical runtime snapshot from the shared API client", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchTimelineSummary).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchCostSummary).toHaveBeenCalledWith("day");
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.data?.dashboard?.pendingApprovals).toBe(2);
    expect(latest?.data?.sessions).toHaveLength(1);
    expect(latest?.data?.mcpServers[0]?.label).toBe("GitHub");
  });

  it("restarts the daemon and refreshes shared snapshot state", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    await act(async () => {
      await latest?.runDaemonAction("restart");
    });
    await flush();

    expect(apiMocks.restartDaemon).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchDashboardState).toHaveBeenCalledTimes(2);
    expect(latest?.notice).toEqual({ tone: "success", message: "Restarted" });
    expect(latest?.daemonBusy).toBeNull();
  });
});

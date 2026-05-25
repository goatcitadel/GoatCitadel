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

// Mirror the mocking pattern from useApprovalQueue.test.tsx: the test runs in
// the node env without a DOM, so window.setInterval is unavailable. The real
// refresh subscription is exercised in useRefreshSubscription.test.tsx.
vi.mock("./useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn(),
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(latest?.data?.sourceStatus.daemon).toEqual({ status: "ok" });
  });

  it("preserves failed source state instead of converting it into false runtime facts", async () => {
    apiMocks.fetchDaemonStatus.mockRejectedValueOnce(new Error("daemon unavailable"));
    apiMocks.fetchHealthSummary.mockRejectedValueOnce(new Error("health unavailable"));

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

    expect(latest?.error).toBeNull();
    expect(latest?.data?.daemon).toBeNull();
    expect(latest?.data?.health).toBeNull();
    expect(latest?.data?.sourceStatus.daemon).toEqual({
      status: "error",
      message: "daemon unavailable",
    });
    expect(latest?.data?.sourceStatus.health).toEqual({
      status: "error",
      message: "health unavailable",
    });
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

  it("ignores late load resolution and rejection after unmount", async () => {
    const lateSuccess = createDeferred<Awaited<ReturnType<typeof apiMocks.fetchDashboardState>>>();
    apiMocks.fetchDashboardState.mockReturnValueOnce(lateSuccess.promise);

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    const observedBeforeSuccess = latest;
    act(() => {
      renderer?.unmount();
      renderer = null;
    });
    await act(async () => {
      lateSuccess.resolve({
        timestamp: "2026-04-22T00:00:00.000Z",
        sessions: [],
        pendingApprovals: 0,
        activeSubagents: 0,
        taskStatusCounts: [],
        recentEvents: [],
        dailyCostUsd: 0,
      });
      await Promise.resolve();
    });
    expect(latest).toBe(observedBeforeSuccess);

    const lateFailure = createDeferred<Awaited<ReturnType<typeof apiMocks.fetchDashboardState>>>();
    apiMocks.fetchDashboardState.mockReturnValueOnce(lateFailure.promise);
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    const observedBeforeFailure = latest;
    act(() => {
      renderer?.unmount();
      renderer = null;
    });
    await act(async () => {
      lateFailure.reject(new Error("late dashboard failure"));
      await Promise.resolve();
    });
    expect(latest).toBe(observedBeforeFailure);
  });

  it("surfaces daemon warnings, clears notices, and reports non-error action failures", async () => {
    apiMocks.startDaemon.mockResolvedValueOnce({
      accepted: false,
      reason: "Already running",
      status: { running: true, host: "localhost" },
    });
    apiMocks.stopDaemon.mockRejectedValueOnce("not an error object");
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
      await latest?.runDaemonAction("start");
    });
    expect(apiMocks.startDaemon).toHaveBeenCalledTimes(1);
    expect(latest?.notice).toEqual({ tone: "warning", message: "Already running" });

    act(() => {
      latest?.clearNotice();
    });
    expect(latest?.notice).toBeNull();

    await act(async () => {
      await latest?.runDaemonAction("stop");
    });
    expect(apiMocks.stopDaemon).toHaveBeenCalledTimes(1);
    expect(latest?.notice).toEqual({ tone: "error", message: "Something went wrong." });
    expect(latest?.daemonBusy).toBeNull();
  });
});

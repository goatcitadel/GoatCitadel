import { describe, expect, it, vi } from "vitest";
import {
  createDashboardRoutePort,
  createDashboardRouteService,
  dashboardRouteMethods,
} from "./dashboard-route-service.js";

describe("dashboard route service", () => {
  it("forwards route methods through the dashboard route service facade", async () => {
    const deps = createDeps();
    const port = createDashboardRoutePort(deps as never);
    const service = createDashboardRouteService(port);

    expect(service).toEqual(
      expect.objectContaining(
        Object.fromEntries(dashboardRouteMethods.map((method) => [method, expect.any(Function)])),
      ),
    );

    expect(await service.costSummary("month", "from", "to")).toEqual([{ costUsd: 1.25 }]);
    expect(await service.costUsageAvailability("from", "to")).toEqual({ available: true });
    expect(await service.getMemoryQmdStats("from", "to")).toEqual({ totalRuns: 2 });
    expect(await service.isFeatureEnabled("connectorDiagnosticsV1Enabled")).toBe(true);
    expect(await service.listBackups(3)).toEqual([{ backupId: "backup-1" }]);
    expect(await service.listMemoryFiles("notes")).toEqual([{ relativePath: "notes/a.md" }]);
    expect(await service.listRealtimeEvents(2, "cursor-1")).toEqual([{ eventId: "event-1" }]);
    expect(await service.listSessions(5, "session-cursor")).toEqual([{ sessionId: "session-1" }]);
    expect(await service.listOperators()).toEqual([{ operatorId: "operator-1" }]);

    expect(deps.storage.costLedger.summary).toHaveBeenCalledWith("month", "from", "to");
    expect(deps.storage.costLedger.usageAvailability).toHaveBeenCalledWith("from", "to");
    expect(deps.memoryLifecycleService.getContextStats).toHaveBeenCalledWith("from", "to");
    expect(deps.backupRetentionService.listBackups).toHaveBeenCalledWith(3);
    expect(deps.memoryLifecycleService.listMemoryFiles).toHaveBeenCalledWith("notes");
    expect(deps.realtimeEventService.listRealtimeEvents).toHaveBeenCalledWith(2, "cursor-1");
    expect(deps.storage.sessions.list).toHaveBeenCalledWith(5, "session-cursor");
    expect(deps.storage.sessions.listOperatorSummaries).toHaveBeenCalledWith(expect.any(String));
  });

  it("builds dashboard state and system vitals without changing response shape", async () => {
    const deps = createDeps();
    const service = createDashboardRouteService(createDashboardRoutePort(deps as never));

    const state = await service.getDashboardState();
    expect(state).toMatchObject({
      sessions: [{ sessionId: "session-1" }],
      pendingApprovals: 2,
      activeSubagents: 4,
      taskStatusCounts: [{ status: "todo", count: 3 }],
      recentEvents: [{ eventId: "recent-1" }],
      dailyCostUsd: 3,
    });
    expect(state.timestamp).toEqual(expect.any(String));
    expect(deps.storage.sessions.list).toHaveBeenCalledWith(200);
    expect(deps.storage.approvals.list).toHaveBeenCalledWith("pending", 10000);
    expect(deps.storage.costLedger.summary).toHaveBeenCalledWith("day", expect.any(String), expect.any(String));

    const vitals = await service.getSystemVitals();
    expect(vitals).toEqual({
      hostname: expect.any(String),
      platform: expect.any(String),
      release: expect.any(String),
      uptimeSeconds: expect.any(Number),
      loadAverage: expect.any(Array),
      cpuCount: expect.any(Number),
      memoryTotalBytes: expect.any(Number),
      memoryFreeBytes: expect.any(Number),
      memoryUsedBytes: expect.any(Number),
      processRssBytes: expect.any(Number),
      processHeapUsedBytes: expect.any(Number),
    });
  });
});

function createDeps() {
  return {
    backupRetentionService: {
      listBackups: vi.fn(() => [{ backupId: "backup-1" }]),
    },
    memoryLifecycleService: {
      getContextStats: vi.fn(() => ({ totalRuns: 2 })),
      listMemoryFiles: vi.fn(() => [{ relativePath: "notes/a.md" }]),
    },
    operatorSummaryCache: {
      get: vi.fn((loader: () => unknown) => loader()),
    },
    realtimeEventService: {
      listRealtimeEvents: vi.fn(() => [{ eventId: "event-1" }]),
    },
    storage: {
      costLedger: {
        summary: vi.fn((scope: string) => (scope === "day" ? [{ costUsd: 1 }, { costUsd: 2 }] : [{ costUsd: 1.25 }])),
        usageAvailability: vi.fn(() => ({ available: true })),
      },
      sessions: {
        list: vi.fn(() => [{ sessionId: "session-1" }]),
        listOperatorSummaries: vi.fn(() => [{ operatorId: "operator-1" }]),
      },
      approvals: {
        list: vi.fn(() => [{ approvalId: "approval-1" }, { approvalId: "approval-2" }]),
      },
      taskSubagents: {
        activeCount: vi.fn(() => 4),
      },
      tasks: {
        statusCounts: vi.fn(() => [{ status: "todo", count: 3 }]),
      },
      realtimeEvents: {
        list: vi.fn(() => [{ eventId: "recent-1" }]),
      },
    },
    isFeatureEnabled: vi.fn(() => true),
  };
}

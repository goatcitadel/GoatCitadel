import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard observe aggregate routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns the unified timeline aggregate", async () => {
    app = Fastify();
    app.decorate("gateway", {
      listRealtimeEvents: vi.fn(() => [{ eventId: "evt-1", sequence: 1 }]),
      listSessions: vi.fn(() => [{ sessionId: "session-1" }]),
      listCronJobs: vi.fn(() => [{ jobId: "job-1" }]),
      listCronReviewQueue: vi.fn(() => [{ itemId: "review-1" }]),
      listImprovementReports: vi.fn(() => [{ reportId: "report-1" }]),
      listDecisionReplayRuns: vi.fn(() => [{ runId: "run-1" }]),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/timeline?eventLimit=10&sessionLimit=5&cronReviewLimit=3&improvementLimit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: { items: [{ eventId: "evt-1", sequence: 1 }] },
      sessions: { items: [{ sessionId: "session-1" }] },
      scheduler: {
        jobs: [{ jobId: "job-1" }],
        reviewQueue: [{ itemId: "review-1" }],
      },
      improvement: {
        reports: [{ reportId: "report-1" }],
        replayRuns: [{ runId: "run-1" }],
      },
    });
  });

  it("returns the unified health aggregate", async () => {
    app = Fastify();
    app.decorate("gateway", {
      getSystemVitals: vi.fn(() => ({ hostname: "goat-box", platform: "win32", release: "11" })),
      getDaemonStatus: vi.fn(() => ({ running: true, state: "running" })),
      listDaemonLogs: vi.fn(() => [{ timestamp: "2026-04-10T00:00:00.000Z", level: "info", message: "ready" }]),
      costSummary: vi.fn(() => [{ key: "day", tokenTotal: 42, costUsd: 1.23 }]),
      costUsageAvailability: vi.fn(() => ({ trackedEvents: 1, unknownEvents: 0, totalAgentEvents: 1 })),
      getMemoryQmdStats: vi.fn(() => ({ totalRuns: 4, compressionPercent: 22, expansionPercent: 0, efficiencyLabel: "reduced" })),
      listBackups: vi.fn(async () => [{ backupId: "backup-1", createdAt: "2026-04-10T00:00:00.000Z", files: [] }]),
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/health?costScope=day&logTail=5&backupLimit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      systemVitals: { hostname: "goat-box", platform: "win32", release: "11" },
      daemonStatus: { running: true, state: "running" },
      daemonLogs: { items: [{ message: "ready" }] },
      costs: {
        summary: {
          scope: "day",
          items: [{ key: "day", tokenTotal: 42, costUsd: 1.23 }],
        },
      },
      backups: {
        latest: { backupId: "backup-1" },
      },
    });
  });
});

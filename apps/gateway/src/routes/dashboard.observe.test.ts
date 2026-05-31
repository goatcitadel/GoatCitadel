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
    app.decorate("services", {
      dashboard: {
        isFeatureEnabled: vi.fn(() => true),
        listRealtimeEvents: vi.fn(() => [{ eventId: "evt-1", sequence: 1 }]),
        listSessions: vi.fn(() => [{ sessionId: "session-1" }]),
      },
      cron: {
        listCronJobs: vi.fn(() => [{ jobId: "job-1" }]),
        listCronReviewQueue: vi.fn(() => [{ itemId: "review-1" }]),
      },
      improvement: {
        listImprovementReports: vi.fn(() => [{ reportId: "report-1" }]),
        listDecisionReplayRuns: vi.fn(() => [{ runId: "run-1" }]),
      },
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

  it("returns an empty review queue when the cron review feature flag is disabled", async () => {
    const listCronReviewQueue = vi.fn(() => {
      throw new Error("Feature flag cronReviewQueueV1Enabled is disabled.");
    });
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        isFeatureEnabled: vi.fn((flag: string) => flag !== "cronReviewQueueV1Enabled"),
        listRealtimeEvents: vi.fn(() => [{ eventId: "evt-1", sequence: 1 }]),
        listSessions: vi.fn(() => [{ sessionId: "session-1" }]),
      },
      cron: {
        listCronJobs: vi.fn(() => [{ jobId: "job-1" }]),
        listCronReviewQueue,
      },
      improvement: {
        listImprovementReports: vi.fn(() => [{ reportId: "report-1" }]),
        listDecisionReplayRuns: vi.fn(() => [{ runId: "run-1" }]),
      },
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/timeline?eventLimit=10&sessionLimit=5&cronReviewLimit=3&improvementLimit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scheduler: {
        jobs: [{ jobId: "job-1" }],
        reviewQueue: [],
      },
    });
    expect(listCronReviewQueue).not.toHaveBeenCalled();
  });

  it("returns the read-only Ops quality aggregate", async () => {
    const getOpsQualitySnapshot = vi.fn(() => ({
      version: "ops.quality_snapshot.v1",
      generatedAt: "2026-05-31T00:00:00.000Z",
      sourceEndpoint: "/api/v1/ops/quality",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        note: "stored evidence only",
      },
      metricScope: {
        scope: "bounded_read",
        promptPackLimit: 10,
        evalRunLimit: 3,
        note: "bounded read",
      },
      metrics: {
        promptPackCount: 1,
        promptPackTestCount: 2,
        redTeamPackCount: 1,
        redTeamTestCount: 4,
        evalRunCount: 1,
        paretoModelCount: 1,
        securityGateCount: 1,
        passingSecurityGateCount: 1,
      },
      promptPacks: { state: "available", items: [{ packId: "pack-1" }] },
      evalProof: { state: "available", items: [{ runId: "eval-1" }] },
      securityEvalPacks: { state: "available", items: [{ packKey: "security" }], warnings: [] },
      securityQualityGates: { state: "available", items: [{ gateId: "gate-1" }], warnings: [] },
      warnings: [],
      nextChecks: [],
    }));
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        getOpsQualitySnapshot,
      },
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ops/quality?packLimit=10&evalLimit=3",
    });

    expect(response.statusCode).toBe(200);
    expect(getOpsQualitySnapshot).toHaveBeenCalledWith({ packLimit: 10, evalLimit: 3 });
    expect(response.json()).toMatchObject({
      version: "ops.quality_snapshot.v1",
      posture: { readOnly: true, sideEffectPosture: "audit_only" },
      metricScope: { scope: "bounded_read", promptPackLimit: 10, evalRunLimit: 3 },
      metrics: { promptPackCount: 1, evalRunCount: 1 },
    });
  });

  it("returns the unified health aggregate", async () => {
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        getSystemVitals: vi.fn(() => ({ hostname: "goat-box", platform: "win32", release: "11" })),
        costSummary: vi.fn(() => [{ key: "day", tokenTotal: 42, costUsd: 1.23 }]),
        costUsageAvailability: vi.fn(() => ({ trackedEvents: 1, unknownEvents: 0, totalAgentEvents: 1 })),
        getMemoryQmdStats: vi.fn(() => ({
          totalRuns: 4,
          compressionPercent: 22,
          expansionPercent: 0,
          efficiencyLabel: "reduced",
        })),
        listBackups: vi.fn(async () => [{ backupId: "backup-1", createdAt: "2026-04-10T00:00:00.000Z", files: [] }]),
      },
      daemon: {
        getDaemonStatus: vi.fn(() => ({ running: true, state: "running" })),
        listDaemonLogs: vi.fn(() => [{ timestamp: "2026-04-10T00:00:00.000Z", level: "info", message: "ready" }]),
      },
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

  it("returns a universal run trace through the observe route", async () => {
    const getObserveRunTrace = vi.fn(async () => ({
      version: "observe.run_trace.v1",
      generatedAt: "2026-05-30T00:00:00.000Z",
      runId: "run-1",
      run: { runId: "run-1", status: "completed" },
      durable: {
        checkpoints: { state: "not_available", items: [] },
        timeline: { state: "not_available", items: [] },
      },
      lifecycle: { state: "not_available" },
      session: { state: "not_available" },
      thread: { state: "not_available", turns: [] },
      approvals: { state: "not_available", items: [], missingIds: [] },
      toolCalls: { state: "not_available", items: [] },
      memoryContext: { state: "not_available", items: [] },
      providerUsage: { state: "not_available", items: [], totals: {} },
      artifacts: { state: "not_available", items: [] },
      errors: { state: "not_available", items: [] },
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        audit: { state: "available", note: "read-only" },
        replay: { state: "not_available", checkpointIds: [], note: "none" },
        resume: { state: "not_available", eligible: false, note: "none" },
      },
    }));
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        getObserveRunTrace,
      },
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/runs/run%2F1/trace",
    });

    expect(response.statusCode).toBe(200);
    expect(getObserveRunTrace).toHaveBeenCalledWith("run/1");
    expect(response.json()).toMatchObject({
      version: "observe.run_trace.v1",
      runId: "run-1",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
      },
    });
  });

  it("returns a read-only universal run trace export through the observe route", async () => {
    const getObserveRunTraceExport = vi.fn(async () => ({
      version: "observe.run_trace_export.v1",
      generatedAt: "2026-05-30T00:00:00.000Z",
      runId: "run-1",
      format: "json",
      contentType: "application/json",
      filename: "goatcitadel-run-trace-run-1.json",
      sourceEndpoint: "/api/v1/observe/runs/run-1/trace",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        note: "read-only",
      },
      trace: { version: "observe.run_trace.v1", runId: "run-1" },
      content: "{}",
    }));
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        getObserveRunTraceExport,
      },
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/runs/run%2F1/trace/export",
    });

    expect(response.statusCode).toBe(200);
    expect(getObserveRunTraceExport).toHaveBeenCalledWith("run/1");
    expect(response.json()).toMatchObject({
      version: "observe.run_trace_export.v1",
      runId: "run-1",
      contentType: "application/json",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
      },
    });
  });

  it("maps a missing observed run trace to 404", async () => {
    app = Fastify();
    app.decorate("services", {
      dashboard: {
        getObserveRunTrace: vi.fn(async () => {
          throw new Error("Durable run not found: missing-run");
        }),
      },
    } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/observe/runs/missing-run/trace",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Durable run not found: missing-run" });
  });
});

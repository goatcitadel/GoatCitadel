import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ValidationError } from "@goatcitadel/contracts";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard route edge coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function createApp(services: Record<string, unknown>): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorate("services", services as never);
    await next.register(dashboardRoutes);
    return next;
  }

  it("routes dashboard state, settings reads, and auth updates through their services", async () => {
    const services = {
      dashboard: {
        getDashboardState: vi.fn(() => ({ nodeId: "gateway-1", ready: true })),
      },
      settings: {
        getSettings: vi.fn(() => ({ revision: 3, budgetMode: "balanced" })),
        getAuthRuntimeSettings: vi.fn(() => ({ mode: "none" })),
        updateSettings: vi.fn((input: Record<string, unknown>) => ({
          revision: input.expectedRevision,
          auth: input.auth,
        })),
      },
    };
    app = await createApp(services);

    let response = await app.inject({ method: "GET", url: "/api/v1/dashboard/state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nodeId: "gateway-1", ready: true });

    response = await app.inject({ method: "GET", url: "/api/v1/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 3, budgetMode: "balanced" });

    response = await app.inject({ method: "GET", url: "/api/v1/auth/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 3, mode: "none" });

    response = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/settings",
      payload: { expectedRevision: 3, mode: "token", token: "secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 3, mode: "token", token: "secret" });
    expect(services.settings.updateSettings).toHaveBeenCalledWith({
      expectedRevision: 3,
      auth: { mode: "token", token: "secret" },
    });
  });

  it("keeps settings and auth validation and service error responses stable", async () => {
    const services = {
      settings: {
        updateSettings: vi.fn(() => {
          throw new ValidationError({ message: "settings rejected" });
        }),
      },
    };
    app = await createApp(services);

    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/settings", payload: { budgetMode: "wrong" } })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/settings",
          payload: { expectedRevision: 1, budgetMode: "saver" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/auth/settings", payload: { mode: "wrong" } })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/auth/settings",
          payload: { expectedRevision: 1, mode: "basic" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("returns validation failures for aggregate queries before touching services", async () => {
    const services = {
      dashboard: {
        isFeatureEnabled: vi.fn(),
        listRealtimeEvents: vi.fn(),
        listSessions: vi.fn(),
        listBackups: vi.fn(),
      },
      cron: {
        listCronJobs: vi.fn(),
        listCronReviewQueue: vi.fn(),
      },
      improvement: {
        listImprovementReports: vi.fn(),
        listDecisionReplayRuns: vi.fn(),
      },
      daemon: {
        getDaemonStatus: vi.fn(),
        listDaemonLogs: vi.fn(),
      },
    };
    app = await createApp(services);

    const timeline = await app.inject({ method: "GET", url: "/api/v1/observe/timeline?eventLimit=0" });
    const health = await app.inject({ method: "GET", url: "/api/v1/observe/health?costScope=invalid" });

    expect(timeline.statusCode).toBe(400);
    expect(health.statusCode).toBe(400);
    expect(services.dashboard.listRealtimeEvents).not.toHaveBeenCalled();
    expect(services.dashboard.listBackups).not.toHaveBeenCalled();
  });

  it("maps cron service errors and validation failures to the existing route statuses", async () => {
    const services = {
      cron: {
        listCronJobs: vi.fn(() => [{ jobId: "job-1", revision: 1 }]),
        getCronJob: vi.fn(() => {
          throw new Error("Cron job not found: missing-job");
        }),
        createCronJob: vi.fn(() => {
          throw new Error("bad schedule");
        }),
        updateCronJob: vi.fn(() => {
          throw new Error("Cron job not found: missing-job");
        }),
        setCronJobEnabled: vi.fn(() => {
          throw new Error("invalid schedule");
        }),
        runCronJobNow: vi.fn((jobId: string) => {
          throw new Error(
            jobId === "no-handler" ? "Cron job has no runnable handler: no-handler" : "Cron job not found: missing-job",
          );
        }),
        deleteCronJob: vi.fn((jobId: string) => {
          if (jobId === "missing") {
            return { deleted: false, jobId };
          }
          if (jobId === "deleted") {
            return { deleted: true, jobId };
          }
          throw new Error("System cron job cannot be deleted: private_beta_backup_daily");
        }),
        listCronReviewQueue: vi.fn(() => {
          throw new Error("Feature flag cronReviewQueueV1Enabled is disabled.");
        }),
        retryCronReviewQueueItem: vi.fn((itemId: string) => {
          throw new Error(itemId === "missing" ? "Cron review item not found: missing" : "retry failed");
        }),
        getCronRunDiff: vi.fn((runId: string) => {
          throw new Error(runId === "missing" ? "Cron run diff not found for run missing" : "diff failed");
        }),
      },
    };
    app = await createApp(services);

    expect((await app.inject({ method: "GET", url: "/api/v1/cron/jobs" })).json()).toEqual({
      items: [{ jobId: "job-1", revision: 1 }],
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/jobs/missing-job" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/jobs", payload: { jobId: "x" } })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/cron/jobs",
          payload: { jobId: "daily-job", name: "Daily", schedule: "0 1 * * *" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/cron/jobs/missing-job", payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/cron/jobs/missing-job",
          payload: { expectedRevision: 1, name: "New" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/cron/jobs/missing-job",
          payload: { expectedRevision: 1, action: "wrong" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/jobs/bad/start" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/jobs/bad/pause" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/jobs/missing/run" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/jobs/no-handler/run" })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/missing?expectedRevision=1" })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/deleted?expectedRevision=1" })).json(),
    ).toEqual({
      deleted: true,
      jobId: "deleted",
    });
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/system?expectedRevision=1" })).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/review-queue?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/review-queue" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/review-queue/missing/retry" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/review-queue/failed/retry" })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/runs/missing/diff" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/runs/failed/diff" })).statusCode).toBe(409);
  });

  it("keeps operator and personality validation/error shapes stable", async () => {
    const services = {
      dashboard: {
        listOperators: vi.fn(() => [{ operatorId: "operator" }]),
        listMemoryFiles: vi.fn(),
      },
      settings: {
        getPersonalityCatalog: vi.fn(() => ({ items: [] })),
        createPersonality: vi.fn(() => {
          throw new Error("create rejected");
        }),
        updatePersonality: vi.fn(() => {
          throw new Error("update rejected");
        }),
        deletePersonality: vi.fn(() => {
          throw new Error("delete rejected");
        }),
        setDefaultPersonality: vi.fn(() => {
          throw new Error("default rejected");
        }),
      },
    };
    app = await createApp(services);

    expect((await app.inject({ method: "GET", url: "/api/v1/operators" })).json()).toEqual({
      items: [{ operatorId: "operator" }],
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/memory/files?dir=a&dir=b" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/personalities", payload: { category: "bad" } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/personalities", payload: { label: "Custom" } })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/personalities/default", payload: {} })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/personalities/default", payload: { personalityId: "x" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/personalities/operator", payload: { category: "bad" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/personalities/operator", payload: { label: "New" } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/personalities/operator" })).statusCode).toBe(400);
  });
});

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError } from "@goatcitadel/contracts";
import { createDatabase, CronJobRepository, type DatabaseClient, type Storage } from "@goatcitadel/storage";
import { CronAutomationService } from "../services/gateway/cron-automation-service.js";
import { createTestCronSpecOwner } from "../services/gateway/cron-spec-owner.test-utils.js";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard cron routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("creates a cron job", async () => {
    const createCronJob = vi.fn((input: Record<string, unknown>) => ({
      ...input,
      revision: 1,
      enabled: input.enabled ?? true,
    }));

    app = Fastify();
    app.decorate("services", { cron: { createCronJob } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      payload: {
        jobId: "nightly-maintenance",
        name: "Nightly Maintenance",
        action: "task",
        schedule: "0 2 * * * America/Los_Angeles",
        enabled: true,
        workdir: "F:/code/personal-ai",
        contextFrom: "daily-review",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createCronJob).toHaveBeenCalledWith({
      jobId: "nightly-maintenance",
      name: "Nightly Maintenance",
      action: "task",
      schedule: "0 2 * * * America/Los_Angeles",
      enabled: true,
      workdir: "F:/code/personal-ai",
      contextFrom: "daily-review",
    });
    expect(response.json()).toMatchObject({ revision: 1 });
  });

  it("rejects runtime telemetry in public create and update mutations", async () => {
    const createCronJob = vi.fn();
    const updateCronJob = vi.fn();
    app = Fastify();
    app.decorate("services", { cron: { createCronJob, updateCronJob } } as never);
    await app.register(dashboardRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      payload: {
        jobId: "telemetry-create",
        name: "Telemetry create",
        schedule: "0 2 * * * UTC",
        lastRunOutput: "operator-owned-output",
      },
    });
    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/cron/jobs/telemetry-create",
      payload: { expectedRevision: 1, name: "Draft", lastRunId: "operator-owned-run" },
    });

    expect(createResponse.statusCode).toBe(400);
    expect(updateResponse.statusCode).toBe(400);
    expect(createCronJob).not.toHaveBeenCalled();
    expect(updateCronJob).not.toHaveBeenCalled();
  });

  it("returns conflict when no_agent creation is disabled by the runtime gate", async () => {
    const createCronJob = vi.fn(() => {
      throw new Error(
        "no_agent cron execution is experimental and disabled by default. Set GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON=true only for local, explicitly governed experiments.",
      );
    });

    app = Fastify();
    app.decorate("services", { cron: { createCronJob } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      payload: {
        jobId: "nightly-maintenance",
        name: "Nightly Maintenance",
        action: "no_agent",
        actionConfig: { noAgent: { command: "pnpm", args: ["verify:fast"] } },
        schedule: "0 2 * * * America/Los_Angeles",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON"),
    });
  });

  it("updates cron fields without schema rejection", async () => {
    const updateCronJob = vi.fn((jobId: string, input: Record<string, unknown>, expectedRevision: number) => ({
      jobId,
      revision: expectedRevision + 1,
      ...input,
    }));

    app = Fastify();
    app.decorate("services", { cron: { updateCronJob } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/cron/jobs/nightly-maintenance",
      payload: {
        expectedRevision: 4,
        action: "curator",
        workdir: null,
        contextFrom: "daily-review",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateCronJob).toHaveBeenCalledWith(
      "nightly-maintenance",
      {
        action: "curator",
        workdir: null,
        contextFrom: "daily-review",
      },
      4,
    );
  });

  it("start and pause routes call enabled toggle", async () => {
    const setCronJobEnabled = vi.fn((jobId: string, enabled: boolean, expectedRevision: number) => ({
      jobId,
      revision: expectedRevision + 1,
      name: "Test Job",
      schedule: "0 2 * * *",
      enabled,
    }));

    app = Fastify();
    app.decorate("services", { cron: { setCronJobEnabled } } as never);
    await app.register(dashboardRoutes);

    const startResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/test-job/start",
      payload: { expectedRevision: 7 },
    });
    const pauseResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/test-job/pause",
      payload: { expectedRevision: 8 },
    });

    expect(startResponse.statusCode).toBe(200);
    expect(pauseResponse.statusCode).toBe(200);
    expect(setCronJobEnabled).toHaveBeenNthCalledWith(1, "test-job", true, 7);
    expect(setCronJobEnabled).toHaveBeenNthCalledWith(2, "test-job", false, 8);
  });

  it("requires a positive revision for every public spec mutation and serializes delete through the query", async () => {
    const updateCronJob = vi.fn();
    const setCronJobEnabled = vi.fn();
    const deleteCronJob = vi.fn((jobId: string, expectedRevision: number) => ({
      deleted: true,
      jobId,
      expectedRevision,
    }));
    app = Fastify();
    app.decorate("services", { cron: { updateCronJob, setCronJobEnabled, deleteCronJob } } as never);
    await app.register(dashboardRoutes);

    const invalidResponses = await Promise.all([
      app.inject({ method: "PATCH", url: "/api/v1/cron/jobs/test-job", payload: { name: "Draft" } }),
      app.inject({ method: "POST", url: "/api/v1/cron/jobs/test-job/start", payload: {} }),
      app.inject({ method: "POST", url: "/api/v1/cron/jobs/test-job/pause", payload: { expectedRevision: 0 } }),
      app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/test-job" }),
    ]);
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/cron/jobs/test-job?expectedRevision=9",
    });

    expect(invalidResponses.every((response) => response.statusCode === 400)).toBe(true);
    expect(updateCronJob).not.toHaveBeenCalled();
    expect(setCronJobEnabled).not.toHaveBeenCalled();
    expect(deleted.statusCode).toBe(200);
    expect(deleteCronJob).toHaveBeenCalledWith("test-job", 9);
  });

  it("returns structured WRITE_CONFLICT details for stale public spec mutations", async () => {
    const conflict = new ConflictError({
      code: "WRITE_CONFLICT",
      message: "cron job changed",
      details: {
        resourceKind: "cron_job",
        resourceId: "test-job",
        expectedRevision: 4,
        currentRevision: 5,
      },
    });
    const fail = vi.fn(() => {
      throw conflict;
    });
    app = Fastify();
    app.decorate("services", {
      cron: {
        updateCronJob: fail,
        setCronJobEnabled: fail,
        deleteCronJob: fail,
      },
    } as never);
    await app.register(dashboardRoutes);

    const responses = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/api/v1/cron/jobs/test-job",
        payload: { expectedRevision: 4, name: "Stale draft" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/test-job/start",
        payload: { expectedRevision: 4 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/test-job/pause",
        payload: { expectedRevision: 4 },
      }),
      app.inject({ method: "DELETE", url: "/api/v1/cron/jobs/test-job?expectedRevision=4" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "WRITE_CONFLICT",
        details: {
          resourceKind: "cron_job",
          resourceId: "test-job",
          expectedRevision: 4,
          currentRevision: 5,
        },
      });
    }
  });

  it("fences stale route clients and keeps start/pause no-ops revision-stable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `goatcitadel-cron-route-${randomUUID()}-`));
    const dbPath = path.join(tempDir, "cron-route.db");
    let dbA: DatabaseClient | undefined;
    let dbB: DatabaseClient | undefined;
    let appA: FastifyInstance | undefined;
    let appB: FastifyInstance | undefined;
    try {
      dbA = createDatabase({ dbPath });
      dbB = createDatabase({ dbPath });
      appA = await createCronRouteApp(new CronJobRepository(dbA));
      appB = await createCronRouteApp(new CronJobRepository(dbB));

      const created = await appA.inject({
        method: "POST",
        url: "/api/v1/cron/jobs",
        payload: { jobId: "shared-route-job", name: "Shared", schedule: "0 2 * * * UTC" },
      });
      const clientBDraft = await appB.inject({ method: "GET", url: "/api/v1/cron/jobs/shared-route-job" });
      const winner = await appA.inject({
        method: "PATCH",
        url: "/api/v1/cron/jobs/shared-route-job",
        payload: { expectedRevision: 1, name: "Client A winner" },
      });
      const stale = await appB.inject({
        method: "PATCH",
        url: "/api/v1/cron/jobs/shared-route-job",
        payload: { expectedRevision: 1, name: "Client B stale overwrite" },
      });
      const noOpStart = await appB.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/shared-route-job/start",
        payload: { expectedRevision: 2 },
      });
      const pause = await appA.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/shared-route-job/pause",
        payload: { expectedRevision: 2 },
      });
      const noOpPause = await appB.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/shared-route-job/pause",
        payload: { expectedRevision: 3 },
      });
      const current = await appB.inject({ method: "GET", url: "/api/v1/cron/jobs/shared-route-job" });

      expect(created.json()).toMatchObject({ revision: 1 });
      expect(clientBDraft.json()).toMatchObject({ revision: 1, name: "Shared" });
      expect(winner.json()).toMatchObject({ revision: 2, name: "Client A winner" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: "WRITE_CONFLICT",
        details: { expectedRevision: 1, currentRevision: 2 },
      });
      expect(noOpStart.json()).toMatchObject({ revision: 2, enabled: true });
      expect(pause.json()).toMatchObject({ revision: 3, enabled: false });
      expect(noOpPause.json()).toMatchObject({ revision: 3, enabled: false });
      expect(current.json()).toMatchObject({ revision: 3, name: "Client A winner", enabled: false });
    } finally {
      await appB?.close();
      await appA?.close();
      dbB?.close();
      dbA?.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns conflict when manual run has no runnable handler", async () => {
    const runCronJobNow = vi.fn(async () => {
      throw new Error("Cron job has no runnable handler: test-job");
    });

    app = Fastify();
    app.decorate("services", { cron: { runCronJobNow } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/test-job/run",
    });

    expect(response.statusCode).toBe(409);
    expect(runCronJobNow).toHaveBeenCalledWith("test-job");
    expect(response.json()).toMatchObject({
      error: "Cron job has no runnable handler: test-job",
    });
  });

  it("passes force metadata through manual cron runs when requested", async () => {
    const runCronJobNow = vi.fn(async () => ({ jobId: "test-job", runId: "run-1", status: "ok" as const }));

    app = Fastify();
    app.decorate("services", { cron: { runCronJobNow } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/test-job/run",
      payload: { force: true, reason: "operator retry" },
    });

    expect(response.statusCode).toBe(200);
    expect(runCronJobNow).toHaveBeenCalledWith("test-job", {
      force: true,
      reason: "operator retry",
    });
  });

  it("projects cron job, run, review, and diff machine output without mutating scheduler truth", async () => {
    const rawJob = {
      jobId: "secret-job",
      revision: 3,
      name: "Secret Job",
      action: "task",
      schedule: "0 2 * * *",
      enabled: true,
      actionConfig: { apiKey: "cron-config-secret" },
      lastRunOutput: "Authorization: Bearer cron-output-secret",
    };
    const rawReview = {
      itemId: "review-1",
      summary: "Authorization: Bearer cron-review-secret",
      diff: { apiKey: "cron-review-diff-secret" },
    };
    const rawRun = { runId: "run-1", output: "token=cron-run-secret" };
    const rawDiff = { runId: "run-1", diff: { authorization: "Bearer cron-diff-secret" } };
    const cron = {
      listCronJobs: vi.fn(() => [rawJob]),
      getCronJob: vi.fn(() => rawJob),
      createCronJob: vi.fn(() => rawJob),
      updateCronJob: vi.fn(() => rawJob),
      setCronJobEnabled: vi.fn(() => rawJob),
      runCronJobNow: vi.fn(async () => rawRun),
      listCronReviewQueue: vi.fn(() => [rawReview]),
      retryCronReviewQueueItem: vi.fn(() => rawReview),
      getCronRunDiff: vi.fn(() => rawDiff),
    };
    app = Fastify();
    app.decorate("services", { cron } as never);
    await app.register(dashboardRoutes);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/cron/jobs" }),
      app.inject({ method: "GET", url: "/api/v1/cron/jobs/secret-job" }),
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs",
        payload: { jobId: "secret-job", name: "Secret Job", action: "task", schedule: "0 2 * * *" },
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/cron/jobs/secret-job",
        payload: { expectedRevision: 3, name: "Renamed" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs/secret-job/start",
        payload: { expectedRevision: 3 },
      }),
      app.inject({ method: "POST", url: "/api/v1/cron/jobs/secret-job/run" }),
      app.inject({ method: "GET", url: "/api/v1/cron/review-queue" }),
      app.inject({ method: "POST", url: "/api/v1/cron/review-queue/review-1/retry" }),
      app.inject({ method: "GET", url: "/api/v1/cron/runs/run-1/diff" }),
    ]);

    expect(responses.every((response) => response.statusCode < 300)).toBe(true);
    for (const response of responses) {
      expect(response.body).not.toContain("cron-config-secret");
      expect(response.body).not.toContain("cron-output-secret");
      expect(response.body).not.toContain("cron-review-secret");
      expect(response.body).not.toContain("cron-review-diff-secret");
      expect(response.body).not.toContain("cron-run-secret");
      expect(response.body).not.toContain("cron-diff-secret");
    }
    expect(rawJob.actionConfig.apiKey).toBe("cron-config-secret");
    expect(rawReview.summary).toContain("cron-review-secret");
  });

  it("reconciles projected cron fields before a routine update", async () => {
    const rawJob = {
      jobId: "roundtrip-job",
      revision: 6,
      name: "Roundtrip Job",
      action: "task",
      schedule: "0 2 * * *",
      enabled: true,
      actionConfig: { endpoint: "https://discord.com/api/webhooks/123/cron-roundtrip-secret", retries: 2 },
      lastRunOutput: "Authorization: Bearer cron-roundtrip-output-secret",
    };
    const updateCronJob = vi.fn((_jobId: string, input: Record<string, unknown>, _expectedRevision: number) => ({
      ...rawJob,
      ...input,
    }));
    app = Fastify();
    app.decorate("services", {
      cron: {
        getCronJob: vi.fn(() => rawJob),
        updateCronJob,
      },
    } as never);
    await app.register(dashboardRoutes);

    const displayed = (
      await app.inject({ method: "GET", url: "/api/v1/cron/jobs/roundtrip-job" })
    ).json() as typeof rawJob;
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/cron/jobs/roundtrip-job",
      payload: {
        expectedRevision: displayed.revision,
        name: "Renamed",
        actionConfig: { ...displayed.actionConfig, retries: 3 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateCronJob).toHaveBeenCalledWith(
      "roundtrip-job",
      {
        name: "Renamed",
        actionConfig: {
          endpoint: rawJob.actionConfig.endpoint,
          retries: 3,
        },
      },
      rawJob.revision,
    );
    expect(rawJob.actionConfig.endpoint).toContain("cron-roundtrip-secret");
  });
});

async function createCronRouteApp(cronJobs: CronJobRepository): Promise<FastifyInstance> {
  const cron = new CronAutomationService({
    storage: { cronJobs } as unknown as Storage,
    specOwner: createTestCronSpecOwner(cronJobs),
    publishRealtime: () => {},
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => false,
    runHandlers: {
      task: async () => ({ taskId: "task-1" }),
      agentTurn: async () => ({ mode: "agent_turn" as const }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      memoryConsolidation: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({ status: "ok" as const, checkId: "runtime_health" as const, summary: "ok" }),
      noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  });
  const routeApp = Fastify();
  routeApp.decorate("services", { cron } as never);
  await routeApp.register(dashboardRoutes);
  return routeApp;
}

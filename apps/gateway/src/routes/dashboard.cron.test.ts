import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
        lastRunOutput: "previous",
        lastRunId: "run-1",
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
      lastRunOutput: "previous",
      lastRunId: "run-1",
    });
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
    const updateCronJob = vi.fn((jobId: string, input: Record<string, unknown>) => ({ jobId, ...input }));

    app = Fastify();
    app.decorate("services", { cron: { updateCronJob } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/cron/jobs/nightly-maintenance",
      payload: {
        action: "curator",
        workdir: null,
        contextFrom: "daily-review",
        lastRunOutput: null,
        lastRunId: "run-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateCronJob).toHaveBeenCalledWith("nightly-maintenance", {
      action: "curator",
      workdir: null,
      contextFrom: "daily-review",
      lastRunOutput: null,
      lastRunId: "run-2",
    });
  });

  it("start and pause routes call enabled toggle", async () => {
    const setCronJobEnabled = vi.fn((jobId: string, enabled: boolean) => ({
      jobId,
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
    });
    const pauseResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/test-job/pause",
    });

    expect(startResponse.statusCode).toBe(200);
    expect(pauseResponse.statusCode).toBe(200);
    expect(setCronJobEnabled).toHaveBeenNthCalledWith(1, "test-job", true);
    expect(setCronJobEnabled).toHaveBeenNthCalledWith(2, "test-job", false);
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
});

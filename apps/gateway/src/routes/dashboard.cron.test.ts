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
    const createCronJob = vi.fn((input: { jobId: string; name: string; schedule: string; enabled?: boolean }) => ({
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
        schedule: "0 2 * * * America/Los_Angeles",
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createCronJob).toHaveBeenCalledWith({
      jobId: "nightly-maintenance",
      name: "Nightly Maintenance",
      schedule: "0 2 * * * America/Los_Angeles",
      enabled: true,
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
});

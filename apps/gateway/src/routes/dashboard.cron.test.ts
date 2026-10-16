import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, NotFoundError, PolicyViolationError } from "@goatcitadel/contracts";
import { createDatabase, CronJobRepository, type DatabaseClient, type Storage } from "@goatcitadel/storage";
import { CronAutomationService } from "../services/gateway/cron-automation-service.js";
import { createTestCronSpecOwner } from "../services/gateway/cron-spec-owner.test-utils.js";
import { dashboardRoutes } from "./dashboard.js";
import { replyWithCronJobs } from "./dashboard-cron-citadel.js";

describe("dashboard cron routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("reads canonical cron occurrence linkage through the runtime owner and redacts output", async () => {
    const canonical = {
      runId: "cron-run-1",
      jobId: "reminder",
      trigger: "scheduled_due",
      scheduledFor: "2026-09-12T12:00:00.000Z",
      jobRevision: 2,
      executionGeneration: 1,
      status: "completed",
      phase: "settlement",
      childSessionId: "cron-session",
      childTurnId: "cron-turn",
      childDurableRunId: "chat-run",
      deliveryRunId: "delivery-run",
    };
    const findCronRunById = vi.fn(async (runId: string) =>
      runId === canonical.runId
        ? { runId, jobId: canonical.jobId, status: "ok", canonical, output: "Authorization: Bearer cron-lookup-secret" }
        : undefined,
    );
    app = Fastify();
    app.decorate("services", { cron: { findCronRunById } } as never);
    await app.register(dashboardRoutes);
    const response = await app.inject({ method: "GET", url: "/api/v1/cron/runs/cron-run-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId: "cron-run-1", canonical });
    expect(response.body).not.toContain("cron-lookup-secret");
    expect(findCronRunById).toHaveBeenCalledWith("cron-run-1");
    const missing = await app.inject({ method: "GET", url: "/api/v1/cron/runs/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Cron run not found." });
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

  it("binds public scheduled creators to auth and rejects forged or internal occurrence authority", async () => {
    const createCronJob = vi.fn(async (input: unknown) => input);
    const updateCronJob = vi.fn(async (_jobId: string, input: unknown) => input);
    app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.authActorId = "operator-real";
    });
    app.decorate("services", { cron: { createCronJob, updateCronJob } } as never);
    await app.register(dashboardRoutes);
    const agentTurn = { prompt: "Read a work item", createdBy: { permissionProfileId: "operator-profile" } };
    const good = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      payload: {
        jobId: "governed-read",
        name: "Governed read",
        action: "agent_turn",
        schedule: "0 12 * * * UTC",
        actionConfig: { agentTurn },
      },
    });
    expect(good.statusCode, good.body).toBe(201);
    expect(createCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        actionConfig: {
          agentTurn: {
            prompt: agentTurn.prompt,
            createdBy: {
              operatorId: "operator-real",
              authActorId: "operator-real",
              depth: 0,
              permissionProfileId: "operator-profile",
            },
          },
        },
      }),
      { actorId: "operator-real", source: "authenticated_operator" },
    );
    for (const forged of [
      { ...agentTurn, createdBy: { ...agentTurn.createdBy, operatorId: "foreign" } },
      { ...agentTurn, createdBy: { ...agentTurn.createdBy, authActorId: "foreign" } },
      { ...agentTurn, createdBy: { ...agentTurn.createdBy, createdByJobId: "foreign", depth: 1 } },
      { ...agentTurn, commitment: { commitmentId: "foreign", revision: 1, materialSha256: "a".repeat(64) } },
      { ...agentTurn, creatorAuthority: { version: "cron.creator-authority.v1", actorId: "operator-real" } },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/cron/jobs/governed-read",
        payload: { expectedRevision: 1, actionConfig: { agentTurn: forged } },
      });
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
      const creation = await app.inject({
        method: "POST",
        url: "/api/v1/cron/jobs",
        payload: {
          jobId: "forged-read",
          name: "Forged read",
          action: "agent_turn",
          schedule: "0 12 * * * UTC",
          actionConfig: { agentTurn: forged },
        },
      });
      expect(creation.statusCode, creation.body).toBeGreaterThanOrEqual(400);
    }
    expect(createCronJob).toHaveBeenCalledTimes(1);
    expect(updateCronJob).not.toHaveBeenCalled();
    const historical = await app.inject({
      method: "PATCH",
      url: "/api/v1/cron/jobs/governed-read",
      payload: { expectedRevision: 1, name: "Renamed" },
    });
    expect(historical.statusCode, historical.body).toBe(200);
    expect(updateCronJob).toHaveBeenCalledWith("governed-read", { name: "Renamed" }, 1, {
      actorId: "operator-real",
      source: "authenticated_operator",
    });
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

  it("accepts no_agent creation without any runtime env gate", async () => {
    const createCronJob = vi.fn((input: Record<string, unknown>) => ({ ...input, revision: 1 }));

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

    expect(response.statusCode, response.body).toBe(201);
    expect(createCronJob).toHaveBeenCalledTimes(1);
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

  describe("citadel-scoped listing", () => {
    const items = [{ jobId: "a", revision: 1 }];

    async function listWith(listCronJobs: ReturnType<typeof vi.fn>, url = "/api/v1/cron/jobs?citadelId=ws-a") {
      app = Fastify();
      app.decorate("services", { cron: { listCronJobs } } as never);
      await app.register(dashboardRoutes);
      return app.inject({ method: "GET", url });
    }

    it("returns scoped items when allowed", async () => {
      const fn = vi.fn(async () => items);
      const response = await listWith(fn);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items });
      expect(fn).toHaveBeenCalledWith({ citadelId: "ws-a", accessClass: "operator" });
    });

    it("fails closed with 403 when the route has no tracked access class", async () => {
      const listCronJobs = vi.fn(async () => {
        throw new PolicyViolationError({ message: "Citadel ws-a is outside your Watchtower access scope." });
      });
      const send = vi.fn();
      const reply = { code: vi.fn(() => ({ send })), send } as never;
      const request = { query: { citadelId: "ws-a" }, routeOptions: { config: {} } } as never;
      await replyWithCronJobs({ listCronJobs } as never, request, reply);
      expect(listCronJobs).toHaveBeenCalledWith({ citadelId: "ws-a", accessClass: undefined });
      expect((reply as { code: ReturnType<typeof vi.fn> }).code).toHaveBeenCalledWith(403);
    });

    it("returns 404 for an unknown citadel", async () => {
      const response = await listWith(
        vi.fn(async () => {
          throw new NotFoundError("Citadel ws-a not found.");
        }),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Citadel ws-a not found." });
    });

    it("returns 403 when outside the access scope", async () => {
      const response = await listWith(
        vi.fn(async () => {
          throw new PolicyViolationError({ message: "Citadel ws-a is outside your Watchtower access scope." });
        }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Citadel ws-a is outside your Watchtower access scope." });
    });

    it("keeps the unscoped list unchanged without citadelId", async () => {
      const fn = vi.fn(async () => [{ jobId: "all" }]);
      const response = await listWith(fn, "/api/v1/cron/jobs");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [{ jobId: "all" }] });
      expect(fn).toHaveBeenCalledWith();
    });

    it("builds the access scope server-side per access class", async () => {
      const listByCitadel = vi.fn(async () => items);
      const getCitadel = vi.fn(async (id: string) => (id === "ws-a" ? { citadelId: id } : undefined));
      const service = new CronAutomationService({
        storage: { citadels: { getCitadel }, cronJobs: { listByCitadel } },
      } as never);
      expect(await service.listCronJobs({ citadelId: "ws-a", accessClass: "operator" })).toEqual(items);
      expect(listByCitadel).toHaveBeenCalledWith({ citadelId: "ws-a", readableCitadelIds: "all" });
      await expect(service.listCronJobs({ citadelId: "ws-a", accessClass: "device" })).rejects.toThrow(
        /outside your Watchtower/,
      );
      await expect(service.listCronJobs({ citadelId: "ws-a", accessClass: undefined })).rejects.toThrow(
        /outside your Watchtower/,
      );
      await expect(service.listCronJobs({ citadelId: "nope", accessClass: "operator" })).rejects.toThrow(/not found/);
      expect(listByCitadel).toHaveBeenCalledTimes(1);
    });
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

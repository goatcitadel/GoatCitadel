import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, NotFoundError, SemanticValidationError, ValidationError } from "@goatcitadel/contracts";
import { modelComparisonRoutes } from "./model-comparisons.js";

describe("model comparison routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("validates creation and delegates comparison reads and judgments", async () => {
    const run = {
      comparisonId: "cmp-1",
      packId: "pack-1",
      status: "queued",
      title: "Compare",
      candidates: [{ candidateId: "c1", providerId: "openai", model: "gpt", blindLabel: "A" }],
      testIds: ["test-a"],
      results: [],
      judgments: [],
      createdAt: "2026-06-05T12:00:00.000Z",
      updatedAt: "2026-06-05T12:00:00.000Z",
    };
    app = Fastify();
    app.decorate("services", {
      modelComparisons: {
        listComparisons: () => ({ items: [run] }),
        createComparison: () => run,
        getComparison: () => run,
        addJudgment: () => ({ judgmentId: "judgment-1", testId: "test-a", scores: [], createdAt: run.createdAt }),
      },
    } as never);
    await app.register(modelComparisonRoutes);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/model-comparisons",
      payload: { packId: "pack-1", candidates: [{ providerId: "one", model: "a" }] },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/model-comparisons",
      payload: {
        packId: "pack-1",
        testIds: ["test-a"],
        candidates: [
          { providerId: "one", model: "a" },
          { providerId: "two", model: "b" },
        ],
      },
    });
    const list = await app.inject({ method: "GET", url: "/api/v1/model-comparisons" });
    const detail = await app.inject({ method: "GET", url: "/api/v1/model-comparisons/cmp-1" });
    const judgment = await app.inject({
      method: "POST",
      url: "/api/v1/model-comparisons/cmp-1/judgments",
      payload: { testId: "test-a", scores: [{ candidateId: "c1", quality: 3 }] },
    });

    expect(invalid.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(list.json().items[0].comparisonId).toBe("cmp-1");
    expect(detail.json().comparisonId).toBe("cmp-1");
    expect(judgment.statusCode).toBe(201);
  });

  it("starts and cancels comparisons with conflict and not-found mapping", async () => {
    const run = { comparisonId: "cmp-1", status: "running" } as Record<string, unknown>;
    app = Fastify();
    app.decorate("services", {
      modelComparisons: {
        startComparison: async (id: string) => {
          if (id === "missing") throw new NotFoundError({ entity: "Model comparison", id });
          if (id === "busy") throw new ConflictError({ message: "Comparison is already running." });
          if (id === "no-runner") throw new ValidationError({ field: "runner", message: "No runner." });
          return run;
        },
        cancelComparison: async (id: string) => {
          if (id === "idle") throw new ConflictError({ message: "Comparison is queued." });
          return { ...run, status: "cancelled" };
        },
      },
    } as never);
    await app.register(modelComparisonRoutes);

    const started = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/cmp-1/run", payload: {} });
    const missing = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/missing/run", payload: {} });
    const busy = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/busy/run", payload: {} });
    const noRunner = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/no-runner/run", payload: {} });
    const cancelled = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/cmp-1/cancel", payload: {} });
    const idle = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/idle/cancel", payload: {} });

    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe("running");
    expect(missing.statusCode).toBe(404);
    expect(busy.statusCode).toBe(409);
    expect(noRunner.statusCode).toBe(400);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    expect(idle.statusCode).toBe(409);
  });

  it("refuses run control when the comparison route port is not registered", async () => {
    app = Fastify();
    app.decorate("services", {} as never);
    await app.register(modelComparisonRoutes);

    const started = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/cmp-1/run", payload: {} });

    expect(started.statusCode).toBe(500);
    expect(started.json().error).toBe("Comparison run control failed.");
  });

  it("maps typed run-control errors to their own status and hides unexpected error text", async () => {
    app = Fastify();
    app.decorate("services", {
      modelComparisons: {
        startComparison: async (id: string) => {
          if (id === "invalid") throw new ValidationError({ field: "candidates", message: "Candidates are invalid." });
          if (id === "unprocessable") throw new SemanticValidationError("Pack has no tests.");
          throw new Error("db exploded: secret");
        },
        cancelComparison: async () => {
          throw new Error("db exploded: secret");
        },
      },
    } as never);
    await app.register(modelComparisonRoutes);

    const invalid = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/invalid/run", payload: {} });
    const unprocessable = await app.inject({
      method: "POST",
      url: "/api/v1/model-comparisons/unprocessable/run",
      payload: {},
    });
    const exploded = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/boom/run", payload: {} });
    const cancelExploded = await app.inject({
      method: "POST",
      url: "/api/v1/model-comparisons/boom/cancel",
      payload: {},
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("Candidates are invalid.");
    expect(unprocessable.statusCode).toBe(422);
    expect(unprocessable.json().error).toBe("Pack has no tests.");
    for (const response of [exploded, cancelExploded]) {
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Comparison run control failed.");
      expect(response.body).not.toContain("secret");
      expect(response.body).not.toContain("db exploded");
    }
  });
});

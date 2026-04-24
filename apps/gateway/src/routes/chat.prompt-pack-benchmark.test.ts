import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promptPackRoutes } from "./prompt-packs.js";

describe("prompt-pack benchmark routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("starts a benchmark run with test codes and provider matrix", async () => {
    const runPromptPackBenchmark = vi.fn(() => ({
      benchmarkRunId: "ppb-123",
    }));

    app = Fastify();
    app.decorate("services", {
      promptPacks: {
        runPromptPackBenchmark,
      },
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/pack-1/benchmark/run",
      payload: {
        testCodes: ["TEST-03", "TEST-06"],
        providers: [
          { providerId: "glm", model: "glm-5" },
          { providerId: "moonshot", model: "kimi-k2.5" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runPromptPackBenchmark).toHaveBeenCalledWith("pack-1", {
      testCodes: ["TEST-03", "TEST-06"],
      providers: [
        { providerId: "glm", model: "glm-5" },
        { providerId: "moonshot", model: "kimi-k2.5" },
      ],
    });
    expect(response.json()).toEqual({
      benchmarkRunId: "ppb-123",
    });
  });

  it("returns benchmark status for a benchmark run id", async () => {
    const getPromptPackBenchmarkStatus = vi.fn(() => ({
      run: {
        benchmarkRunId: "ppb-123",
        packId: "pack-1",
        status: "running",
        testCodes: ["TEST-03"],
        providers: [{ providerId: "glm", model: "glm-5" }],
        startedAt: new Date().toISOString(),
      },
      progress: {
        totalItems: 10,
        completedItems: 4,
      },
      modelSummaries: [],
    }));

    app = Fastify();
    app.decorate("services", {
      promptPacks: {
        getPromptPackBenchmarkStatus,
      },
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/prompt-packs/benchmark/ppb-123",
    });

    expect(response.statusCode).toBe(200);
    expect(getPromptPackBenchmarkStatus).toHaveBeenCalledWith("ppb-123");
    expect(response.json()).toMatchObject({
      progress: {
        totalItems: 10,
        completedItems: 4,
      },
    });
  });

  it("cancels a benchmark run by id", async () => {
    const cancelPromptPackBenchmark = vi.fn(() => ({
      run: {
        benchmarkRunId: "ppb-123",
        packId: "pack-1",
        status: "cancelled",
        testCodes: ["TEST-03"],
        providers: [{ providerId: "glm", model: "glm-5" }],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: "Cancelled by operator.",
      },
      progress: {
        totalItems: 10,
        completedItems: 4,
      },
      modelSummaries: [],
    }));

    app = Fastify();
    app.decorate("services", {
      promptPacks: {
        cancelPromptPackBenchmark,
      },
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/benchmark/ppb-123/cancel",
    });

    expect(response.statusCode).toBe(200);
    expect(cancelPromptPackBenchmark).toHaveBeenCalledWith("ppb-123");
    expect(response.json()).toMatchObject({
      run: {
        status: "cancelled",
      },
    });
  });
});

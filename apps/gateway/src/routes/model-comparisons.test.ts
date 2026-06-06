import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
});

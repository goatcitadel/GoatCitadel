import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { assemblyRoutes } from "./assembly.js";

describe("assembly routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("validates assembly run creation", async () => {
    const createAssemblyRun = vi.fn();
    app = Fastify();
    app.decorate("services", { assembly: { createAssemblyRun } } as never);
    await app.register(assemblyRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assembly/runs",
      payload: {
        prompt: "",
        settings: {
          mode: "consensus",
          participantModels: [{ participantId: "p1", providerId: "openai", model: "gpt-5" }],
          maxRounds: 2,
          maxCritiquePasses: 1,
          maxInterModelExchanges: 1,
          convergenceThreshold: 0.78,
          stagnationWindow: 2,
          timeBudgetMs: 60000,
          tokenBudget: 5000,
          costBudgetUsd: 2,
          domainPreset: "coding",
          synthesisStyle: "balanced",
          exportTargets: ["artifact"],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(createAssemblyRun).not.toHaveBeenCalled();
  });

  it("lists runs, details, and reputation", async () => {
    const createAssemblyRun = vi.fn(async () => ({ runId: "assembly-1" }));
    const listAssemblyRuns = vi.fn(() => [{ runId: "assembly-1" }]);
    const getAssemblyRunDetail = vi.fn(() => ({ run: { runId: "assembly-1" }, rounds: [], artifacts: [] }));
    const listAssemblyReputations = vi.fn(() => [{ modelRef: "openai:gpt-5" }]);
    app = Fastify();
    app.decorate("services", {
      assembly: { createAssemblyRun, listAssemblyRuns, getAssemblyRunDetail, listAssemblyReputations },
    } as never);
    await app.register(assemblyRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/assembly/runs",
      payload: {
        prompt: "Design an Assembly workflow for a code review problem.",
        settings: {
          mode: "consensus",
          participantModels: [
            { participantId: "p1", providerId: "openai", model: "gpt-5" },
            { participantId: "p2", providerId: "anthropic", model: "claude-sonnet-4" },
          ],
          maxRounds: 2,
          maxCritiquePasses: 1,
          maxInterModelExchanges: 1,
          convergenceThreshold: 0.78,
          stagnationWindow: 2,
          timeBudgetMs: 60000,
          tokenBudget: 5000,
          costBudgetUsd: 2,
          domainPreset: "coding",
          synthesisStyle: "balanced",
          exportTargets: ["artifact"],
        },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createAssemblyRun).toHaveBeenCalled();

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/assembly/runs?limit=10",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listAssemblyRuns).toHaveBeenCalledWith(10);

    const detailResponse = await app.inject({
      method: "GET",
      url: "/api/v1/assembly/runs/assembly-1",
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(getAssemblyRunDetail).toHaveBeenCalledWith("assembly-1");

    const reputationResponse = await app.inject({
      method: "GET",
      url: "/api/v1/assembly/reputation?limit=5",
    });
    expect(reputationResponse.statusCode).toBe(200);
    expect(listAssemblyReputations).toHaveBeenCalledWith(5);
  });
});

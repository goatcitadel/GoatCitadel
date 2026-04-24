import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promptPackRoutes } from "./prompt-packs.js";

describe("prompt-pack reset route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns no-op result when both reset flags are false", async () => {
    const getPromptPackExport = vi.fn(() => ({
      packId: "pack-1",
      path: "report.md",
      exists: false,
      sizeBytes: 0,
    }));
    const resetPromptPackRunsAndScores = vi.fn();

    app = Fastify();
    app.decorate("services", {
      promptPacks: {
        getPromptPackExport,
        resetPromptPackRunsAndScores,
      },
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/pack-1/reset",
      payload: {
        clearRuns: false,
        clearScores: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resetPromptPackRunsAndScores).not.toHaveBeenCalled();
    expect(getPromptPackExport).toHaveBeenCalledWith("pack-1");
    expect(response.json()).toMatchObject({
      packId: "pack-1",
      deletedRuns: 0,
      deletedScores: 0,
    });
  });

  it("passes independent reset flags through to gateway service", async () => {
    const resetPromptPackRunsAndScores = vi.fn(() => ({
      packId: "pack-2",
      deletedRuns: 3,
      deletedScores: 0,
      export: {
        packId: "pack-2",
        path: "report.md",
        exists: false,
        sizeBytes: 0,
      },
    }));

    app = Fastify();
    app.decorate("services", {
      promptPacks: {
        getPromptPackExport: vi.fn(),
        resetPromptPackRunsAndScores,
      },
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/pack-2/reset",
      payload: {
        clearRuns: true,
        clearScores: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resetPromptPackRunsAndScores).toHaveBeenCalledWith("pack-2", {
      clearRuns: true,
      clearScores: false,
    });
    expect(response.json()).toMatchObject({
      packId: "pack-2",
      deletedRuns: 3,
      deletedScores: 0,
    });
  });
});

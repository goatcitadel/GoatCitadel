import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promptPackRoutes } from "./prompt-packs.js";

describe("prompt-pack run route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes placeholder values through to prompt-pack run service", async () => {
    const runPromptPackTest = vi.fn(async () => ({
      runId: "run-1",
      packId: "pack-1",
      testId: "test-1",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));

    app = Fastify();
    app.decorate("gateway", {
      runPromptPackTest,
    } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/pack-1/tests/test-1/run",
      payload: {
        providerId: "glm",
        model: "glm-5",
        placeholderValues: {
          "<PASTE A SIMPLE PUBLIC URL>": "https://example.com",
          "<TOPIC>": "ai tooling",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runPromptPackTest).toHaveBeenCalledWith("pack-1", "test-1", {
      providerId: "glm",
      model: "glm-5",
      placeholderValues: {
        "<PASTE A SIMPLE PUBLIC URL>": "https://example.com",
        "<TOPIC>": "ai tooling",
      },
    });
  });
});

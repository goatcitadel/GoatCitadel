import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard settings routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes llama.cpp modelsRootPath through the settings patch schema", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        llamaCpp: {
          modelsRootPath: "C:\\Models\\",
          modelPath: "C:\\Models\\Gemma\\model.gguf",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      llamaCpp: {
        modelsRootPath: "C:\\Models\\",
        modelPath: "C:\\Models\\Gemma\\model.gguf",
      },
    });
  });

  it("passes provider request transport overrides through the settings patch schema", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        llm: {
          upsertProvider: {
            providerId: "openai-compatible",
            baseUrl: "https://llm.example.test/v1",
            request: {
              headers: {
                "X-Trace": "1",
              },
              proxy: {
                url: "http://proxy.internal:8080",
              },
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      llm: {
        upsertProvider: {
          providerId: "openai-compatible",
          baseUrl: "https://llm.example.test/v1",
          request: {
            headers: {
              "X-Trace": "1",
            },
            proxy: {
              url: "http://proxy.internal:8080",
            },
          },
        },
      },
    });
  });
});

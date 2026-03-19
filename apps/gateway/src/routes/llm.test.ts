import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

describe("llm routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("accepts developer messages and OpenAI chat controls", async () => {
    const createChatCompletion = vi.fn(async (request) => ({
      id: "cmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      echo: request,
    }));

    app = Fastify();
    app.decorate("gateway", {
      createChatCompletion,
      getLlmConfig: vi.fn(),
      listLlmProviders: vi.fn(),
      updateLlmConfig: vi.fn(),
      listLlmModels: vi.fn(),
      previewLlmModels: vi.fn(),
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "none" },
        verbosity: "low",
        service_tier: "flex",
        prompt_cache_retention: "in_memory",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: "developer", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
      reasoning: { effort: "none" },
      verbosity: "low",
      service_tier: "flex",
      prompt_cache_retention: "in_memory",
    }));
  });

  it("rejects invalid reasoning controls", async () => {
    app = Fastify();
    app.decorate("gateway", {
      createChatCompletion: vi.fn(),
      getLlmConfig: vi.fn(),
      listLlmProviders: vi.fn(),
      updateLlmConfig: vi.fn(),
      listLlmModels: vi.fn(),
      previewLlmModels: vi.fn(),
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "max" },
      }),
    });

    expect(response.statusCode).toBe(400);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "../test/fake-openai-server.js";
import { createOpenAiCompatibleLlmService } from "../test/llm-fixtures.js";

describe("LlmService fake OpenAI-compatible provider contracts", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("discovers models from a real OpenAI-compatible HTTP endpoint", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    const models = await service.listModels("fake-openai");

    expect(models.map((model) => model.id)).toEqual(["fake-chat", "fake-tools"]);
    expect(server.requests).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/v1/models",
      }),
    );
  });

  it("forwards chat payload fields and provider auth headers", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl, {
      apiKeyEnv: "FAKE_OPENAI_KEY",
      env: { FAKE_OPENAI_KEY: "test-key" },
    });

    const response = await service.chatCompletions({
      providerId: "fake-openai",
      messages: [{ role: "user", content: "return json" }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      metadata: { route: "provider-contract-test" },
    });

    const choices = response.choices as Array<{ message?: { content?: unknown } }> | undefined;
    expect(choices?.[0]?.message?.content).toBe(JSON.stringify({ ok: true }));
    const request = server.requests.find((entry) => entry.path === "/v1/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer test-key");
    expect(request?.body).toMatchObject({
      model: "fake-chat",
      stream: false,
      response_format: { type: "json_object" },
      temperature: 0.1,
      metadata: { route: "provider-contract-test" },
    });
  });

  it("normalizes streamed SSE chunks and keeps usage metadata", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream({
      providerId: "fake-openai",
      messages: [{ role: "user", content: "stream please" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      choices: [{ delta: { content: "hello " } }],
    });
    expect(chunks[1]).toMatchObject({
      choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
    expect(server.requests.find((entry) => entry.path === "/v1/chat/completions")?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("preserves tool-call responses from OpenAI-compatible chat completions", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl, { model: "fake-tools" });

    const response = await service.chatCompletions({
      providerId: "fake-openai",
      messages: [{ role: "user", content: "use the lookup tool" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
    });

    const choices = response.choices as
      | Array<{ finish_reason?: unknown; message?: { tool_calls?: Array<unknown> } }>
      | undefined;
    expect(choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(choices?.[0]?.message?.tool_calls?.[0]).toMatchObject({
      id: "call_fake_lookup",
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("surfaces provider HTTP failures with sanitized operation context", async () => {
    server = await startFakeOpenAiCompatibleServer((request) => {
      if (request.method === "POST" && request.path === "/v1/chat/completions") {
        return {
          status: 429,
          body: { error: { message: "rate limit from fake provider" } },
        };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    await expect(
      service.chatCompletions({
        providerId: "fake-openai",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/chat completion failed \(429 Too Many Requests\)/);
  });

  it("ignores malformed stream frames while continuing valid provider chunks", async () => {
    server = await startFakeOpenAiCompatibleServer((request) => {
      if (request.method === "POST" && request.path === "/v1/chat/completions") {
        return {
          sseFrames: [
            "{not json",
            JSON.stringify({ id: "valid-after-malformed", choices: [{ index: 0, delta: { content: "ok" } }] }),
            "[DONE]",
          ],
        };
      }
      return { status: 404, body: { error: { message: "not found" } } };
    });
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream({
      providerId: "fake-openai",
      messages: [{ role: "user", content: "stream please" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        id: "valid-after-malformed",
        choices: [{ index: 0, delta: { content: "ok" } }],
      }),
    ]);
  });

  it("does not guess discounted-input cost when the provider omits cache-token detail", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl, {
      providerId: "openai",
      label: "OpenAI",
      model: "gpt-4.1-mini",
    });

    const response = await service.chatCompletions({
      providerId: "openai",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
    expect(response.usage).not.toHaveProperty("cost_usd");
  });
});

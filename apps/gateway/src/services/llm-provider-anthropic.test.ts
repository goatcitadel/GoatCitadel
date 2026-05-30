import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import type { LlmProviderAdapterHost, LlmProviderResolution } from "./llm-provider-adapter.js";
import { anthropicProviderAdapter } from "./llm-provider-anthropic.js";

const resolved: LlmProviderResolution = {
  provider: {
    providerId: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.test/v1",
    apiStyle: "anthropic-messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-test"],
  } as never,
  apiKey: "test-key",
};

const host: LlmProviderAdapterHost = {
  buildRequestTarget: (_resolved, purpose, endpointUrl) => ({
    url: endpointUrl,
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
      "x-purpose": purpose,
    },
  }),
};

describe("anthropicProviderAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps chat requests into Anthropic Messages payloads and adapts text/tool responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          model: "claude-test",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Need a lookup." },
            { type: "tool_use", id: "tool_1", name: "lookup", input: { query: "goat" } },
            { type: "tool_use", id: "tool_1", name: "lookup", input: { query: "duplicate" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "Be exact." },
        { role: "developer", content: [{ type: "input_text", text: "Use tools only when needed." }] as never },
        { role: "user", content: [{ type: "input_text", text: "Find the answer." }] as never },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_existing",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"goat"}' },
            },
          ],
        } as never,
        { role: "tool", tool_call_id: "call_existing", content: [{ type: "text", text: "found" }] as never },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup a thing",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } } as never,
      response_format: { type: "json_object" },
      metadata: { route: "anthropic-test" },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 64,
      stop: ["STOP"],
      reasoning: { effort: "high" },
      timeoutMs: 123.9,
    };

    const response = await anthropicProviderAdapter.chatCompletions(request, resolved, "claude-test", host);

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.anthropic.test/v1/messages");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: expect.objectContaining({
        "x-api-key": "test-key",
        "x-purpose": "messages",
      }),
    });
    expect(payload).toMatchObject({
      model: "claude-test",
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      metadata: { route: "anthropic-test" },
      output_config: { format: { type: "json_object" } },
      tool_choice: { type: "tool", name: "lookup" },
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
    expect(payload.system).toEqual([
      { type: "text", text: "Use tools only when needed." },
      { type: "text", text: "Be exact." },
    ]);
    expect(payload.tools).toEqual([
      {
        name: "lookup",
        description: "Lookup a thing",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    expect(payload.messages).toContainEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_existing",
          name: "lookup",
          input: { query: "goat" },
        },
      ],
    });
    expect(response).toMatchObject({
      id: "msg_1",
      model: "claude-test",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Need a lookup.",
            tool_calls: [
              {
                id: "tool_1",
                type: "function",
                function: { name: "lookup", arguments: '{"query":"goat"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("normalizes streaming text, tool-call deltas, usage, and malformed SSE frames", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_stream", model: "claude-test" } })}`,
              "",
              `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello " } })}`,
              "",
              `data: ${JSON.stringify({
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "tool_stream", name: "lookup", input: '{"query"' },
              })}`,
              "",
              "data: {not json",
              "",
              `data: ${JSON.stringify({
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: ':"goat"}' },
              })}`,
              "",
              `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
              "",
              `data: ${JSON.stringify({
                type: "message_delta",
                stop_reason: "max_tokens",
                usage: { input_tokens: 7, output_tokens: 3 },
              })}`,
              "",
              `data: ${JSON.stringify({ type: "message_stop" })}`,
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of anthropicProviderAdapter.chatCompletionsStream(
      {
        messages: [{ role: "user", content: "stream" }],
        tool_choice: "required",
        timeoutMs: -1,
      },
      resolved,
      "claude-test",
      host,
    )) {
      chunks.push(chunk);
    }

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      model: "claude-test",
      stream: true,
      tool_choice: { type: "any" },
      max_tokens: 1024,
    });
    expect(chunks).toEqual([
      {
        id: "msg_stream",
        model: "claude-test",
        choices: [{ index: 0, delta: { content: "hello " } }],
      },
      {
        id: "msg_stream",
        model: "claude-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool_stream",
                  type: "function",
                  function: { name: "lookup", arguments: '{"query":"goat"}' },
                },
              ],
            },
          },
        ],
      },
      expect.objectContaining({
        id: "msg_stream",
        model: "claude-test",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    ]);
  });

  it("keeps parallel tool calls distinct with stable per-tool indices during streaming", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_parallel", model: "claude-test" } })}`,
              "",
              `data: ${JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "tool_a", name: "lookup", input: "" },
              })}`,
              "",
              `data: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"query":"goat"}' },
              })}`,
              "",
              `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
              "",
              `data: ${JSON.stringify({
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "tool_b", name: "translate", input: "" },
              })}`,
              "",
              `data: ${JSON.stringify({
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: '{"text":"hi"}' },
              })}`,
              "",
              `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
              "",
              `data: ${JSON.stringify({ type: "message_stop" })}`,
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const toolCalls: Array<{ index: unknown; id: unknown; name: unknown; arguments: unknown }> = [];
    for await (const chunk of anthropicProviderAdapter.chatCompletionsStream(
      { messages: [{ role: "user", content: "stream" }], timeoutMs: -1 },
      resolved,
      "claude-test",
      host,
    )) {
      const choice = (
        chunk as {
          choices?: Array<{ delta?: { tool_calls?: Array<Record<string, unknown>> } }>;
        }
      ).choices?.[0];
      for (const call of choice?.delta?.tool_calls ?? []) {
        toolCalls.push({
          index: call.index,
          id: call.id,
          name: (call.function as { name?: unknown } | undefined)?.name,
          arguments: (call.function as { arguments?: unknown } | undefined)?.arguments,
        });
      }
    }

    // Each parallel tool call must carry a distinct, stable index. The completion
    // aggregator keys tool calls by this index, so emitting index 0 for every tool
    // collapses parallel calls into one (ids/names overwritten, args concatenated).
    expect(toolCalls).toEqual([
      { index: 0, id: "tool_a", name: "lookup", arguments: '{"query":"goat"}' },
      { index: 1, id: "tool_b", name: "translate", arguments: '{"text":"hi"}' },
    ]);
  });

  it("blocks redirects and includes provider error snippets for Anthropic failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("moved", { status: 307 }));
    await expect(
      anthropicProviderAdapter.chatCompletions(
        { messages: [{ role: "user", content: "hello" }] },
        resolved,
        "claude-test",
        host,
      ),
    ).rejects.toThrow(/blocked redirect \(307\)/);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("bad key".repeat(100), { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      anthropicProviderAdapter
        .chatCompletionsStream({ messages: [{ role: "user", content: "hello" }] }, resolved, "claude-test", host)
        .next(),
    ).rejects.toThrow(/messages request failed \(401 Unauthorized\): bad key/);
  });

  it("turns an HTML-bodied 200 response into a clean provider error instead of a SyntaxError", async () => {
    const htmlBody = "<html><head><title>Just a moment...</title></head><body>Verifying...</body></html>";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(htmlBody, { status: 200, statusText: "OK", headers: { "content-type": "application/json" } }),
    );

    const error = await anthropicProviderAdapter
      .chatCompletions({ messages: [{ role: "user", content: "hello" }] }, resolved, "claude-test", host)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("SyntaxError");
    expect((error as Error).message).toMatch(/messages request returned malformed JSON \(200 OK\)/);
    expect((error as Error).message).toMatch(/Just a moment/);
  });

  it("turns an HTML-bodied 200 stream fallback into a clean provider error instead of a SyntaxError", async () => {
    const htmlBody = "<!doctype html><html><body>gateway timeout</body></html>";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(htmlBody, { status: 200, statusText: "OK", headers: { "content-type": "application/json" } }),
    );

    const error = await anthropicProviderAdapter
      .chatCompletionsStream({ messages: [{ role: "user", content: "hello" }] }, resolved, "claude-test", host)
      .next()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("SyntaxError");
    expect((error as Error).message).toMatch(/messages request returned malformed JSON \(200 OK\)/);
    expect((error as Error).message).toMatch(/gateway timeout/);
  });

  it("translates an OpenAI base64 data-URL image_url part into an Anthropic base64 image block", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_img", model: "claude-test", content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await anthropicProviderAdapter.chatCompletions(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
            ] as never,
          },
        ],
      },
      resolved,
      "claude-test",
      host,
    );

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
          },
        ],
      },
    ]);
  });

  it("translates an OpenAI https image_url part into an Anthropic url image block", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_img", model: "claude-test", content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await anthropicProviderAdapter.chatCompletions(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.test/cat.jpg" } }] as never,
          },
        ],
      },
      resolved,
      "claude-test",
      host,
    );

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://example.test/cat.jpg" } }],
      },
    ]);
  });
});

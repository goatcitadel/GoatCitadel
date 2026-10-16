import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import type { LlmProviderAdapterHost, LlmProviderResolution } from "./llm-provider-adapter.js";
import {
  adaptBedrockConverseResponse,
  bedrockProviderAdapter,
  buildBedrockConversePayload,
  parseBedrockRegion,
} from "./llm-provider-bedrock.js";

const SIGV4_SECRET = "test-secret";
const PNG_BASE64 = "iVBORw0KGgo=";

function bedrockResolution(overrides: { authMode?: string; apiKey?: string } = {}): LlmProviderResolution {
  return {
    provider: {
      providerId: "bedrock",
      label: "Amazon Bedrock",
      baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
      apiStyle: "bedrock-messages",
      authMode: overrides.authMode ?? "aws-sigv4",
      models: ["anthropic.claude-test:0"],
    } as never,
    apiKey:
      "apiKey" in overrides
        ? overrides.apiKey
        : JSON.stringify({
            accessKeyId: "AKIATESTTESTTESTTEST",
            secretAccessKey: SIGV4_SECRET,
            sessionToken: "test-session",
          }),
  };
}

function createHost(headers: Record<string, string> = { "Content-Type": "application/json" }): LlmProviderAdapterHost {
  return {
    buildRequestTarget: (_resolved, _purpose, endpointUrl) => ({ url: endpointUrl, headers: { ...headers } }),
    postJsonRequest: async ({ target, payload, timeoutMs, signal }) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
        redirect: "manual",
      });
      return { response, effectivePayload: payload, outputCapRetriesRemaining: 0 };
    },
    retryOutputCapFailure: async () => undefined,
  };
}

function converseJson(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const simpleRequest: ChatCompletionRequest = { messages: [{ role: "user", content: "Hello" }] };

const simpleConverseResponse = {
  output: { message: { role: "assistant", content: [{ text: "Hi there" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
};

const searchTool = {
  type: "function",
  function: {
    name: "search",
    description: "Search the herd",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
};

describe("buildBedrockConversePayload", () => {
  it("maps system, multimodal user, tool use, tool results, inference config, and tool config", () => {
    const payload = buildBedrockConversePayload({
      messages: [
        { role: "system", content: "Be exact." },
        { role: "developer", content: [{ type: "input_text", text: "Use tools when needed." }] as never },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
          ] as never,
        },
        {
          role: "assistant",
          content: "Let me search.",
          tool_calls: [{ id: "tool_1", type: "function", function: { name: "search", arguments: '{"q":"goat"}' } }],
        } as never,
        { role: "tool", tool_call_id: "tool_1", content: "a goat" },
        { role: "user", content: "Thanks, summarize." },
      ],
      max_tokens: 256,
      temperature: 0.2,
      stop: ["END"],
      tools: [searchTool],
      tool_choice: "required",
    });

    expect(payload.system).toEqual([{ text: "Be exact." }, { text: "Use tools when needed." }]);
    const messages = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]?.content).toEqual([
      { text: "What is in this picture?" },
      { image: { format: "png", source: { bytes: PNG_BASE64 } } },
    ]);
    expect(messages[1]?.content).toEqual([
      { text: "Let me search." },
      { toolUse: { toolUseId: "tool_1", name: "search", input: { q: "goat" } } },
    ]);
    expect(messages[2]?.content).toEqual([
      { toolResult: { toolUseId: "tool_1", content: [{ text: "a goat" }] } },
      { text: "Thanks, summarize." },
    ]);
    expect(payload.inferenceConfig).toEqual({ maxTokens: 256, temperature: 0.2, stopSequences: ["END"] });
    expect(payload.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "search",
            description: "Search the herd",
            inputSchema: { json: { type: "object", properties: { q: { type: "string" } } } },
          },
        },
      ],
      toolChoice: { any: {} },
    });
  });

  it("omits empty inference config, drops tool config for tool_choice none, and rejects remote image URLs", () => {
    const payload = buildBedrockConversePayload({ ...simpleRequest, tools: [searchTool], tool_choice: "none" });
    expect(payload).not.toHaveProperty("inferenceConfig");
    expect(payload).not.toHaveProperty("toolConfig");
    expect(payload).not.toHaveProperty("system");

    expect(() =>
      buildBedrockConversePayload({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/goat.png" } }] as never,
          },
        ],
      }),
    ).toThrow(/data: URL/);
  });

  it("maps auto and named tool choices", () => {
    const auto = buildBedrockConversePayload({ ...simpleRequest, tools: [searchTool], tool_choice: "auto" });
    expect((auto.toolConfig as Record<string, unknown>).toolChoice).toEqual({ auto: {} });
    const named = buildBedrockConversePayload({
      ...simpleRequest,
      tools: [searchTool],
      tool_choice: { type: "function", function: { name: "search" } },
    });
    expect((named.toolConfig as Record<string, unknown>).toolChoice).toEqual({ tool: { name: "search" } });
  });
});

describe("adaptBedrockConverseResponse", () => {
  it("maps text, tool use, reasoning, stop reason, and usage", () => {
    const response = adaptBedrockConverseResponse(
      {
        output: {
          message: {
            role: "assistant",
            content: [
              { reasoningContent: { reasoningText: { text: "thinking about goats", signature: "sig" } } },
              { text: "Searching now." },
              { toolUse: { toolUseId: "tooluse_1", name: "search", input: { q: "goat" } } },
            ],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      },
      "anthropic.claude-test:0",
    );

    const choice = response.choices?.[0];
    const message = choice?.message as Record<string, unknown>;
    expect(response.model).toBe("anthropic.claude-test:0");
    expect(message.content).toBe("Searching now.");
    expect(message.tool_calls).toEqual([
      { id: "tooluse_1", type: "function", function: { name: "search", arguments: '{"q":"goat"}' } },
    ]);
    expect(message.provider_native_content).toEqual([{ type: "reasoning", text: "thinking about goats" }]);
    expect(String(message.content)).not.toContain("thinking about goats");
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(response.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it("maps the remaining stop reasons", () => {
    const finish = (stopReason: string) =>
      adaptBedrockConverseResponse({ ...simpleConverseResponse, stopReason }, "m").choices?.[0]?.finish_reason;
    expect(finish("end_turn")).toBe("stop");
    expect(finish("stop_sequence")).toBe("stop");
    expect(finish("max_tokens")).toBe("length");
    expect(finish("guardrail_intervened")).toBe("content_filter");
    expect(finish("content_filtered")).toBe("content_filter");
  });

  it("round-trips tool use ids back into the next request", () => {
    const adapted = adaptBedrockConverseResponse(
      {
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tooluse_round", name: "search", input: { q: "goat" } } }],
          },
        },
        stopReason: "tool_use",
      },
      "m",
    );
    const assistant = adapted.choices?.[0]?.message as Record<string, unknown>;
    const toolCalls = assistant.tool_calls as Array<{ id: string }>;
    const payload = buildBedrockConversePayload({
      messages: [
        { role: "user", content: "Find a goat." },
        assistant as never,
        { role: "tool", tool_call_id: toolCalls[0]?.id, content: "found one" },
      ],
    });
    const messages = payload.messages as Array<{ role: string; content: Array<Record<string, any>> }>;
    const toolUse = messages[1]?.content.find((block) => block.toolUse)?.toolUse;
    const toolResult = messages[2]?.content.find((block) => block.toolResult)?.toolResult;
    expect(toolUse?.toolUseId).toBe("tooluse_round");
    expect(toolResult?.toolUseId).toBe(toolUse?.toolUseId);
  });
});

describe("parseBedrockRegion", () => {
  it("reads regional, VPC endpoint, and rejects unknown hosts", () => {
    expect(parseBedrockRegion("https://bedrock-runtime.eu-central-1.amazonaws.com")).toBe("eu-central-1");
    expect(parseBedrockRegion("https://vpce-0abc-xyz.bedrock-runtime.us-east-1.vpce.amazonaws.com")).toBe("us-east-1");
    expect(parseBedrockRegion("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com")).toBe("us-gov-west-1");
    expect(() => parseBedrockRegion("https://example.com")).toThrow(/Cannot determine the AWS region/);
  });
});

describe("bedrockProviderAdapter.chatCompletions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs Converse requests with SigV4 without leaking the secret key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(converseJson(simpleConverseResponse));

    const response = await bedrockProviderAdapter.chatCompletions(
      simpleRequest,
      bedrockResolution(),
      "anthropic.claude-test:0",
      createHost({ "Content-Type": "application/json", Authorization: "Bearer should-be-dropped" }),
    );

    expect(bedrockProviderAdapter.apiStyle).toBe("bedrock-messages");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-test%3A0/converse");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\//);
    expect(headers.authorization).toContain("/us-west-2/bedrock/aws4_request");
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["x-amz-security-token"]).toBe("test-session");
    expect(headers).not.toHaveProperty("host");
    expect(headers).not.toHaveProperty("Authorization");
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(SIGV4_SECRET);
    }
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ role: "user", content: [{ text: "Hello" }] }] });
    expect(response.choices?.[0]?.message).toMatchObject({ role: "assistant", content: "Hi there" });
    expect(response.choices?.[0]?.finish_reason).toBe("stop");
    expect(response.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("sends the host bearer header unchanged in Bedrock API-key mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(converseJson(simpleConverseResponse));

    await bedrockProviderAdapter.chatCompletions(
      simpleRequest,
      bedrockResolution({ authMode: "aws-bedrock-api-key", apiKey: "bedrock-key" }),
      "anthropic.claude-test:0",
      createHost({ "Content-Type": "application/json", Authorization: "Bearer bedrock-key" }),
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bedrock-key");
    expect(headers).not.toHaveProperty("x-amz-date");
    expect(headers).not.toHaveProperty("authorization");
  });

  it("requires credentials in bearer mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      bedrockProviderAdapter.chatCompletions(
        simpleRequest,
        bedrockResolution({ authMode: "aws-bedrock-api-key", apiKey: undefined }),
        "m",
        createHost(),
      ),
    ).rejects.toThrow("Amazon Bedrock requires an API key or SigV4 credentials.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Bedrock error responses and blocks redirects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Malformed input request" }), {
        status: 400,
        headers: {
          "content-type": "application/json",
          "x-amzn-errortype": "ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/",
        },
      }),
    );
    const failure = bedrockProviderAdapter.chatCompletions(simpleRequest, bedrockResolution(), "m", createHost());
    await expect(failure).rejects.toThrow(/400/);
    await expect(failure).rejects.toThrow(/ValidationException/);
    await expect(failure).rejects.toThrow(/Malformed input request/);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
    );
    await expect(
      bedrockProviderAdapter.chatCompletions(simpleRequest, bedrockResolution(), "m", createHost()),
    ).rejects.toThrow(/blocked redirect/);
  });

  it("rejects malformed SigV4 credentials before any request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      bedrockProviderAdapter.chatCompletions(
        simpleRequest,
        bedrockResolution({ apiKey: "not-json" }),
        "m",
        createHost(),
      ),
    ).rejects.toThrow(/malformed/);
    await expect(
      bedrockProviderAdapter.chatCompletions(
        simpleRequest,
        bedrockResolution({ apiKey: JSON.stringify({ accessKeyId: "AKIA" }) }),
        "m",
        createHost(),
      ),
    ).rejects.toThrow(/malformed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

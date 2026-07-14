import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmApiStyle, LlmConfigFile, ModelUsageAttributionContext } from "@goatcitadel/contracts";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { LlmService } from "./llm-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

const roots: string[] = [];
const storages: Storage[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createHarness(
  apiStyle: LlmApiStyle,
  model = "test-model",
  providerId = "test-provider",
): { service: LlmService; storage: Storage } {
  const root = path.join(os.tmpdir(), `goatcitadel-output-cap-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const manifestPath = path.join(root, "model-metadata.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      entries: {
        [`${providerId}/${model}`]: {
          contextWindow: 16_384,
          outputTokenLimit: 8_192,
        },
      },
    }),
  );
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  const config: LlmConfigFile = {
    activeProviderId: providerId,
    activeModel: model,
    providers: [
      {
        providerId,
        label: "Test provider",
        baseUrl: "https://provider.example.test/v1",
        apiStyle,
        defaultModel: model,
        apiKey: "test-key",
      },
    ],
  };
  return {
    storage,
    service: new LlmService(
      config,
      {},
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: manifestPath,
        enforceNetworkAllowlist: false,
        modelUsageAccounting: new ModelUsageAccountingService(storage.modelUsageEvents, `owner-${randomUUID()}`),
      },
    ),
  };
}

function attribution(id: string): ModelUsageAttributionContext {
  return {
    operationId: id,
    dispatchGeneration: `${id}:generation-1`,
    workspaceId: "workspace-output-cap",
    sessionId: "session-output-cap",
    turnId: `turn-${id}`,
  };
}

function createNoopSecretStore(): SecretStoreService {
  return {
    isAvailable: () => false,
    setProviderApiKey: () => undefined,
    getProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    setSecret: () => undefined,
    getSecret: () => undefined,
    deleteSecret: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: false, source: "none" }),
  } as unknown as SecretStoreService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("LlmService output-cap recovery", () => {
  it("retries OpenAI-compatible chat once with a lower cap and reconciles both HX-306 attempts", async () => {
    const { service, storage } = createHarness("openai-chat-completions");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return jsonResponse({ error: { message: "Range of max_tokens should be [1, 2048]" } }, 400);
        }
        return jsonResponse({
          id: "completion-recovered",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        });
      }),
    );

    const response = await service.chatCompletions(
      {
        providerId: "test-provider",
        model: "test-model",
        messages: [
          { role: "system", content: "Bound system and routed context" },
          { role: "user", content: "answer" },
        ],
        tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
        max_tokens: 4096,
      },
      attribution("chat-retry"),
    );

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.max_tokens).toBe(4096);
    expect(payloads[1]?.max_tokens).toBe(1984);
    expect(response.modelUsageEventIds).toHaveLength(2);
    const events = storage.modelUsageEvents.list({ turnId: "turn-chat-retry" }).items;
    expect(events.map((event) => event.transportAttemptIndex)).toEqual([1, 0]);
    expect(events.map((event) => event.terminalOutcome).sort()).toEqual(["failed_before_usage", "succeeded"]);
    expect(events[1]).toMatchObject({
      requestedOutputTokenCap: 4096,
      effectiveOutputTokenCap: 4096,
      outputCapDisposition: "initial",
    });
    expect(events[0]).toMatchObject({
      requestedOutputTokenCap: 4096,
      effectiveOutputTokenCap: 1984,
      outputCapDisposition: "reduced_retry",
      outputCapRecoverySourceEventId: events[1]?.eventId,
      outputCapRecoveryReasonCode: "safe_lower_cap",
      outputCapProviderAvailableTokens: 2048,
      outputCapProviderMinimumTokens: 1,
      outputCapConfiguredContextWindowTokens: 16_384,
      outputCapSafetyMarginTokens: 64,
      outputCapEvidenceFormat: "bounded_range",
      transportRetryParentEventId: events[1]?.eventId,
      transportRetryReason: "output_cap_recovery",
    });
    expect(events[0]?.outputCapRequestInputEstimate).toBeGreaterThan(0);
  });

  it("uses the same bounded retry for Anthropic messages without changing context metadata", async () => {
    const { service, storage } = createHarness("anthropic-messages", "claude-test");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return jsonResponse(
            {
              error: {
                message: "max_tokens: 4096 > context_window: 16384 - input_tokens: 14336 = available_tokens: 2048",
              },
            },
            400,
          );
        }
        return jsonResponse({
          id: "anthropic-recovered",
          model: "claude-test",
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 11, output_tokens: 2 },
        });
      }),
    );

    const response = await service.chatCompletions(
      {
        providerId: "test-provider",
        model: "claude-test",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
      },
      attribution("anthropic-retry"),
    );

    expect(payloads.map((item) => item.max_tokens)).toEqual([4096, 1984]);
    expect(response.modelUsageEventIds).toHaveLength(2);
    expect(storage.modelUsageEvents.list({ turnId: "turn-anthropic-retry" }).items).toHaveLength(2);
    expect(service.getModelContextWindow("test-provider", "claude-test")).toBe(16_384);
  });

  it("fails closed after one retry and does not loop or route the error into compaction", async () => {
    const { service, storage } = createHarness("openai-responses", "gpt-5-test", "openai");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ error: { message: "Range of max_tokens should be [1, 2048]" } }, 400);
      }),
    );

    await expect(
      service.chatCompletions(
        {
          providerId: "openai",
          model: "gpt-5-test",
          messages: [{ role: "user", content: "answer" }],
          max_tokens: 4096,
        },
        attribution("responses-retry"),
      ),
    ).rejects.toThrow(/responses request failed/u);

    expect(payloads).toHaveLength(2);
    expect(payloads.map((item) => item.max_output_tokens)).toEqual([4096, 1984]);
    const events = storage.modelUsageEvents.list({ turnId: "turn-responses-retry" }).items;
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.terminalOutcome === "failed_before_usage")).toBe(true);
  });

  it("does not retry malformed or contradictory provider evidence", async () => {
    const { service, storage } = createHarness("openai-chat-completions");
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: "max_tokens: 4096 > context_window: 16384 - input_tokens: 14336 = available_tokens: 1024",
          },
        },
        400,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      service.chatCompletions(
        {
          providerId: "test-provider",
          model: "test-model",
          messages: [{ role: "user", content: "answer" }],
          max_tokens: 4096,
        },
        attribution("contradictory"),
      ),
    ).rejects.toThrow(/chat completion failed/u);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.modelUsageEvents.list({ turnId: "turn-contradictory" }).items).toHaveLength(1);
  });

  it("recovers a 200 Responses failure envelope before returning any answer", async () => {
    const { service, storage } = createHarness("openai-responses", "gpt-5-test", "openai");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return jsonResponse({
            id: "failed-response",
            status: "failed",
            model: "gpt-5-test",
            usage: { input_tokens: 21, output_tokens: 3, cost_usd: 0.07 },
            error: { type: "invalid_request_error", message: "Range of max_output_tokens should be [1, 2048]" },
          });
        }
        return jsonResponse({
          id: "recovered-response",
          status: "completed",
          model: "gpt-5-test",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }],
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      }),
    );

    const response = await service.chatCompletions(
      {
        providerId: "openai",
        model: "gpt-5-test",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
      },
      attribution("responses-envelope"),
    );

    expect(response.choices[0]?.message.content).toBe("recovered");
    expect(payloads.map((item) => item.max_output_tokens)).toEqual([4096, 1984]);
    const events = storage.modelUsageEvents
      .list({ turnId: "turn-responses-envelope" })
      .items.sort((left, right) => left.transportAttemptIndex - right.transportAttemptIndex);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      terminalOutcome: "failed_after_usage",
      inputTokens: 21,
      outputTokens: 3,
      costUsd: 0.07,
      costSource: "provider_reported",
      pricingSource: "provider_reported",
    });
    expect(events[1]).toMatchObject({
      transportRetryParentEventId: events[0]?.eventId,
      transportRetryReason: "output_cap_recovery",
      terminalOutcome: "succeeded",
    });
  });

  it("recovers Responses SSE failure before output and never retries after a visible delta", async () => {
    const { service, storage } = createHarness("openai-responses", "gpt-5-test", "openai");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return sseResponse([
            {
              type: "response.failed",
              response: {
                id: "failed-stream",
                status: "failed",
                error: { message: "Range of max_output_tokens should be [1, 2048]" },
              },
            },
          ]);
        }
        return sseResponse([
          {
            type: "response.completed",
            response: {
              id: "recovered-stream",
              status: "completed",
              model: "gpt-5-test",
              output: [],
              usage: { input_tokens: 8, output_tokens: 1 },
            },
          },
        ]);
      }),
    );
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(
      {
        providerId: "openai",
        model: "gpt-5-test",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
      },
      attribution("responses-sse-before"),
    ))
      chunks.push(chunk);
    expect(payloads.map((item) => item.max_output_tokens)).toEqual([4096, 1984]);
    expect(chunks).toHaveLength(1);
    expect(storage.modelUsageEvents.list({ turnId: "turn-responses-sse-before" }).items).toHaveLength(2);

    vi.unstubAllGlobals();
    const after = createHarness("openai-responses", "gpt-5-test", "openai");
    const afterFetch = vi.fn(async () =>
      sseResponse([
        { type: "response.output_text.delta", response_id: "partial", item_id: "item", delta: "partial" },
        {
          type: "response.failed",
          response: {
            id: "partial",
            status: "failed",
            error: { message: "Range of max_output_tokens should be [1, 2048]" },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", afterFetch);
    const partialChunks: Array<Record<string, unknown>> = [];
    await expect(
      (async () => {
        for await (const chunk of after.service.chatCompletionsStream(
          {
            providerId: "openai",
            model: "gpt-5-test",
            messages: [{ role: "user", content: "answer" }],
            max_tokens: 4096,
          },
          attribution("responses-sse-after"),
        ))
          partialChunks.push(chunk);
      })(),
    ).rejects.toThrow(/responses stream failed/iu);
    expect(partialChunks).toHaveLength(1);
    expect(afterFetch).toHaveBeenCalledTimes(1);
  });

  it("recovers Anthropic SSE with its implicit cap frozen as the logical request", async () => {
    const { service, storage } = createHarness("anthropic-messages", "claude-test");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return sseResponse([
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Range of max_tokens should be [1, 512]",
              },
            },
          ]);
        }
        return sseResponse([
          { type: "message_start", message: { id: "msg-recovered", model: "claude-test", usage: { input_tokens: 8 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]);
      }),
    );
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(
      {
        providerId: "test-provider",
        model: "claude-test",
        messages: [{ role: "user", content: "answer" }],
      },
      attribution("anthropic-implicit"),
    ))
      chunks.push(chunk);

    expect(payloads.map((item) => item.max_tokens)).toEqual([1024, 448]);
    expect(chunks.length).toBeGreaterThan(0);
    const events = storage.modelUsageEvents
      .list({ turnId: "turn-anthropic-implicit" })
      .items.sort((left, right) => left.transportAttemptIndex - right.transportAttemptIndex);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      requestedOutputTokenCap: 1024,
      effectiveOutputTokenCap: 448,
      outputCapDisposition: "reduced_retry",
      transportRetryReason: "output_cap_recovery",
    });

    vi.unstubAllGlobals();
    const after = createHarness("anthropic-messages", "claude-test");
    const afterFetch = vi.fn(async () =>
      sseResponse([
        { type: "message_start", message: { id: "msg-partial", model: "claude-test" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        { type: "error", error: { message: "Range of max_tokens should be [1, 512]" } },
      ]),
    );
    vi.stubGlobal("fetch", afterFetch);
    const partialChunks: Array<Record<string, unknown>> = [];
    await expect(
      (async () => {
        for await (const chunk of after.service.chatCompletionsStream(
          {
            providerId: "test-provider",
            model: "claude-test",
            messages: [{ role: "user", content: "answer" }],
          },
          attribution("anthropic-after-visible"),
        ))
          partialChunks.push(chunk);
      })(),
    ).rejects.toThrow(/Anthropic stream error after message_start/u);
    expect(partialChunks).toHaveLength(1);
    expect(afterFetch).toHaveBeenCalledTimes(1);
  });

  it("recovers OpenAI-compatible stream errors only before the first visible chunk", async () => {
    const { service } = createHarness("openai-chat-completions");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1) {
          return sseResponse([{ error: { message: "Range of max_tokens should be [1, 2048]" } }]);
        }
        return sseResponse([
          {
            id: "chat-recovered",
            model: "test-model",
            choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 1 },
          },
        ]);
      }),
    );
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(
      {
        providerId: "test-provider",
        model: "test-model",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
      },
      attribution("chat-sse-recovery"),
    ))
      chunks.push(chunk);
    expect(payloads.map((item) => item.max_tokens)).toEqual([4096, 1984]);
    expect(chunks).toHaveLength(1);

    vi.unstubAllGlobals();
    const after = createHarness("openai-chat-completions");
    const afterFetch = vi.fn(async () =>
      sseResponse([
        {
          id: "chat-partial",
          model: "test-model",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        },
        { error: { message: "Range of max_tokens should be [1, 2048]" } },
      ]),
    );
    vi.stubGlobal("fetch", afterFetch);
    const partialChunks: Array<Record<string, unknown>> = [];
    await expect(
      (async () => {
        for await (const chunk of after.service.chatCompletionsStream(
          {
            providerId: "test-provider",
            model: "test-model",
            messages: [{ role: "user", content: "answer" }],
            max_tokens: 4096,
          },
          attribution("chat-sse-after"),
        ))
          partialChunks.push(chunk);
      })(),
    ).rejects.toThrow(/Range of max_tokens/u);
    expect(partialChunks).toHaveLength(1);
    expect(afterFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps one cap budget and immutable parentage across cap then metadata compatibility", async () => {
    const { service, storage } = createHarness("openai-chat-completions");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1)
          return jsonResponse({ error: { message: "Range of max_tokens should be [1, 2048]" } }, 400);
        if (payloads.length === 2)
          return jsonResponse({ error: { message: "metadata is only allowed when store is enabled" } }, 400);
        return jsonResponse({
          id: "metadata-recovered",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        });
      }),
    );
    await service.chatCompletions(
      {
        providerId: "test-provider",
        model: "test-model",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
        metadata: { audit: "bound" },
      },
      attribution("cap-then-metadata"),
    );
    expect(payloads.map((item) => item.max_tokens)).toEqual([4096, 1984, 1984]);
    expect(payloads.map((item) => Object.hasOwn(item, "metadata"))).toEqual([true, true, false]);
    const events = storage.modelUsageEvents
      .list({ turnId: "turn-cap-then-metadata" })
      .items.sort((left, right) => left.transportAttemptIndex - right.transportAttemptIndex);
    expect(events.map((event) => event.outputCapDisposition)).toEqual(["initial", "reduced_retry", "preserved_retry"]);
    expect(events.map((event) => event.transportRetryReason)).toEqual([
      undefined,
      "output_cap_recovery",
      "metadata_compatibility",
    ]);
    expect(events[2]?.transportRetryParentEventId).toBe(events[1]?.eventId);
  });

  it("keeps one cap budget and immutable parentage across metadata then cap", async () => {
    const { service, storage } = createHarness("openai-chat-completions");
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (payloads.length === 1)
          return jsonResponse({ error: { message: "metadata is only allowed when store is enabled" } }, 400);
        if (payloads.length === 2)
          return jsonResponse({ error: { message: "Range of max_tokens should be [1, 2048]" } }, 400);
        return jsonResponse({
          id: "cap-recovered",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        });
      }),
    );
    await service.chatCompletions(
      {
        providerId: "test-provider",
        model: "test-model",
        messages: [{ role: "user", content: "answer" }],
        max_tokens: 4096,
        metadata: { audit: "bound" },
      },
      attribution("metadata-then-cap"),
    );
    expect(payloads.map((item) => item.max_tokens)).toEqual([4096, 4096, 1984]);
    const events = storage.modelUsageEvents
      .list({ turnId: "turn-metadata-then-cap" })
      .items.sort((left, right) => left.transportAttemptIndex - right.transportAttemptIndex);
    expect(events.map((event) => event.outputCapDisposition)).toEqual(["initial", "preserved_retry", "reduced_retry"]);
    expect(events.map((event) => event.transportRetryReason)).toEqual([
      undefined,
      "metadata_compatibility",
      "output_cap_recovery",
    ]);
    expect(events[2]?.transportRetryParentEventId).toBe(events[1]?.eventId);
  });

  it(
    "never redispatches auth, rate-limit, redirect, or server failures even when their body mentions a cap",
    { timeout: 60_000 },
    async () => {
      for (const status of [302, 401, 403, 429, 500]) {
        const { service, storage } = createHarness("openai-chat-completions");
        const fetchMock = vi.fn(async () =>
          jsonResponse({ error: { message: "Range of max_tokens should be [1, 2048]" } }, status),
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(
          service.chatCompletions(
            {
              providerId: "test-provider",
              model: "test-model",
              messages: [{ role: "user", content: "answer" }],
              max_tokens: 4096,
            },
            attribution(`status-${status}`),
          ),
        ).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(storage.modelUsageEvents.list({ turnId: `turn-status-${status}` }).items).toHaveLength(1);
        vi.unstubAllGlobals();
      }
    },
  );
});

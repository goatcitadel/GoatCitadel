import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile, ModelUsageAttributionContext, ModelUsageEventRecord } from "@goatcitadel/contracts";
import {
  ModelUsageAccountingService,
  ModelUsageDispatchPersistenceError,
  ModelUsageSettlementError,
} from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { LlmService } from "./llm-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

const storages: Storage[] = [];
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createHarness(
  config: LlmConfigFile,
  secretStore = createNoopSecretStore(),
): {
  service: LlmService;
  storage: Storage;
} {
  const root = path.join(os.tmpdir(), `goatcitadel-llm-usage-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "storage.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  const accounting = new ModelUsageAccountingService(
    storage.modelUsageEvents,
    `gateway-test-${randomUUID()}`,
    60_000,
    60_000,
  );
  return {
    storage,
    service: new LlmService(config, {}, { secretStore, modelUsageAccounting: accounting }),
  };
}

function openAiResponsesConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai",
    activeModel: "gpt-5.4",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
        apiKey: "test-key",
      },
    ],
  };
}

function openAiChatConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai",
    activeModel: "gpt-4.1",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "gpt-4.1",
        apiKey: "test-key",
      },
    ],
  };
}

function codexConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai-codex",
    activeModel: "gpt-5.5",
    providers: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        authMode: "codex-oauth",
      },
    ],
  };
}

function attribution(operationId: string): ModelUsageAttributionContext {
  return {
    operationId,
    dispatchGeneration: `${operationId}:generation-1`,
    workspaceId: "workspace-usage-test",
    sessionId: "session-usage-test",
    turnId: "turn-usage-test",
  };
}

function onlyUsageRecord(storage: Storage): ModelUsageEventRecord {
  const result = storage.modelUsageEvents.list({ workspaceId: "workspace-usage-test" });
  expect(result.items).toHaveLength(1);
  return result.items[0]!;
}

function failNextSettlement(storage: Storage) {
  return vi.spyOn(storage.modelUsageEvents, "finalizeAndProject").mockImplementationOnce(() => {
    throw new Error("injected canonical settlement persistence fault");
  });
}

async function consume(stream: AsyncGenerator<Record<string, unknown>>): Promise<void> {
  for await (const _chunk of stream) {
    // Drain the provider stream through terminal settlement.
  }
}

describe("LlmService canonical transport accounting", () => {
  it.each([
    {
      name: "chat JSON",
      config: openAiChatConfig,
      response: () =>
        new Response(
          JSON.stringify({
            model: "gpt-4.1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      run: (service: LlmService) =>
        service.chatCompletions(
          { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
          attribution("settlement-chat-json"),
        ),
    },
    {
      name: "chat stream",
      config: openAiChatConfig,
      response: () =>
        new Response(
          [
            'data: {"id":"chat-stream","model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      run: (service: LlmService) =>
        consume(
          service.chatCompletionsStream(
            { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
            attribution("settlement-chat-stream"),
          ),
        ),
    },
    {
      name: "Responses JSON",
      config: openAiResponsesConfig,
      response: () =>
        new Response(
          JSON.stringify({
            id: "response-json",
            status: "completed",
            model: "gpt-5.4",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      run: (service: LlmService) =>
        service.chatCompletions(
          { providerId: "openai", model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] },
          attribution("settlement-responses-json"),
        ),
    },
    {
      name: "Responses stream",
      config: openAiResponsesConfig,
      response: () =>
        new Response(
          [
            'data: {"type":"response.completed","response":{"id":"response-stream","status":"completed","model":"gpt-5.4","output":[],"usage":{"input_tokens":4,"output_tokens":1}}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      run: (service: LlmService) =>
        consume(
          service.chatCompletionsStream(
            { providerId: "openai", model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] },
            attribution("settlement-responses-stream"),
          ),
        ),
    },
    {
      name: "image generation",
      config: openAiResponsesConfig,
      response: () =>
        new Response(
          JSON.stringify({
            model: "gpt-image-2",
            data: [{ b64_json: "aW1hZ2U=" }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      run: (service: LlmService) =>
        service.generateImage(
          { providerId: "openai", model: "gpt-image-2", prompt: "goat" },
          attribution("settlement-image-generation"),
        ),
    },
    {
      name: "image edit",
      config: openAiResponsesConfig,
      response: () =>
        new Response(
          JSON.stringify({
            model: "gpt-image-2",
            data: [{ b64_json: "aW1hZ2U=" }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      run: (service: LlmService) =>
        service.generateImage(
          {
            providerId: "openai",
            model: "gpt-image-2",
            prompt: "edit goat",
            referenceImages: [{ bytesBase64: "aW1hZ2U=", mimeType: "image/png", fileName: "goat.png" }],
          },
          attribution("settlement-image-edit"),
        ),
    },
  ])(
    "surfaces $name settlement failure without reclassifying the accepted attempt",
    async ({ config, response, run }) => {
      const { service, storage } = createHarness(config());
      const settlement = failNextSettlement(storage);
      vi.stubGlobal("fetch", vi.fn(async () => response()) as typeof fetch);

      await expect(run(service)).rejects.toBeInstanceOf(ModelUsageSettlementError);

      expect(settlement).toHaveBeenCalledTimes(1);
      expect(onlyUsageRecord(storage)).toMatchObject({
        transportStatus: "accepted",
        terminalOutcome: "in_flight",
      });
    },
  );

  it.each([
    {
      name: "Chat Completions",
      config: openAiChatConfig,
      providerId: "openai",
      model: "gpt-4.1",
      operationId: "early-return-chat-stream",
      body: [
        'data: {"id":"early-chat","model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"partial"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    },
    {
      name: "Responses",
      config: openAiResponsesConfig,
      providerId: "openai",
      model: "gpt-5.4",
      operationId: "early-return-responses-stream",
      body: [
        'data: {"type":"response.output_text.delta","response_id":"early-response","item_id":"item-1","delta":"partial"}',
        'data: {"type":"response.completed","response":{"id":"early-response","status":"completed","model":"gpt-5.4","output":[],"usage":{"input_tokens":4,"output_tokens":1}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    },
  ])("surfaces the exact $name cancellation settlement fault on early iterator return", async (fixture) => {
    const { service, storage } = createHarness(fixture.config());
    const persistenceFailure = new Error(`injected ${fixture.name} cancellation settlement persistence fault`);
    const settlement = vi.spyOn(storage.modelUsageEvents, "finalizeAndProject").mockImplementationOnce(() => {
      throw persistenceFailure;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(fixture.body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ) as typeof fetch,
    );
    const stream = service.chatCompletionsStream(
      {
        providerId: fixture.providerId,
        model: fixture.model,
        messages: [{ role: "user", content: "hello" }],
      },
      attribution(fixture.operationId),
    );

    const first = await stream.next();
    expect(first).toMatchObject({ done: false });

    let failure: unknown;
    try {
      await stream.return(undefined);
    } catch (error) {
      failure = error;
    }

    const accepted = onlyUsageRecord(storage);
    expect(failure).toBeInstanceOf(ModelUsageSettlementError);
    expect(failure).toMatchObject({
      eventId: accepted.eventId,
      intendedOutcome: "cancelled",
      cause: persistenceFailure,
    });
    expect(settlement).toHaveBeenCalledTimes(1);
    expect(accepted).toMatchObject({
      transportStatus: "accepted",
      terminalOutcome: "in_flight",
      dispatchOwnerId: expect.stringMatching(/^gateway-test-/),
      dispatchLeaseExpiresAt: expect.any(String),
    });
  });

  it("wraps accepted lease-renewal persistence faults as authoritative during streaming", async () => {
    const { service, storage } = createHarness(openAiChatConfig());
    let nowMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      nowMs += 60_000;
      return nowMs;
    });
    const renewFailure = new Error("injected accepted lease-renewal persistence fault");
    const renew = vi.spyOn(storage.modelUsageEvents, "renewTransportLease").mockImplementationOnce(() => {
      throw renewFailure;
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            'data: {"id":"renew-fault","model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"partial"}}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await consume(
        service.chatCompletionsStream(
          { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
          attribution("renew-accepted-lease-fault"),
        ),
      );
    } catch (error) {
      failure = error;
    } finally {
      clock.mockRestore();
    }

    expect(failure).toBeInstanceOf(ModelUsageDispatchPersistenceError);
    expect(failure).toMatchObject({ action: "renew_accepted_lease", cause: renewFailure });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onlyUsageRecord(storage)).toMatchObject({
      transportStatus: "accepted",
      terminalOutcome: "failed_before_usage",
    });
  });

  it("surfaces failed-attempt settlement persistence over the original transport rejection", async () => {
    const { service, storage } = createHarness(openAiChatConfig());
    const settlement = failNextSettlement(storage);
    const providerError = new Error("provider transport rejected");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw providerError;
      }) as typeof fetch,
    );

    let failure: unknown;
    try {
      await service.chatCompletions(
        { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
        attribution("settlement-provider-rejection"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelUsageSettlementError);
    expect(failure).toMatchObject({ intendedOutcome: "failed_before_usage", cause: expect.any(Error) });
    expect(settlement).toHaveBeenCalledTimes(1);
    expect(onlyUsageRecord(storage)).toMatchObject({
      transportStatus: "accepted",
      terminalOutcome: "in_flight",
    });
  });

  it.each(["JSON", "multipart"] as const)(
    "observes a fast %s transport rejection while durable acceptance is pending",
    async (transportKind) => {
      const { service, storage } = createHarness(
        transportKind === "JSON" ? openAiChatConfig() : openAiResponsesConfig(),
      );
      const originalAccept = storage.modelUsageEvents.acceptTransport.bind(storage.modelUsageEvents);
      let releaseAccept: (() => void) | undefined;
      const accept = vi
        .spyOn(storage.modelUsageEvents, "acceptTransport")
        .mockImplementationOnce((eventId, ownerId, expiresAt) => {
          const delayed = new Promise<ModelUsageEventRecord>((resolve) => {
            releaseAccept = () => resolve(originalAccept(eventId, ownerId, expiresAt));
          });
          return delayed as never;
        });
      const transportFailure = new Error(`fast ${transportKind} transport rejection`);
      const pendingFetch = Promise.reject<Response>(transportFailure);
      const pendingCatch = vi.spyOn(pendingFetch, "catch");
      const fetchMock = vi.fn(() => pendingFetch);
      vi.stubGlobal("fetch", fetchMock as typeof fetch);

      const request =
        transportKind === "JSON"
          ? service.chatCompletions(
              { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
              attribution("fast-json-transport-rejection"),
            )
          : service.generateImage(
              {
                providerId: "openai",
                model: "gpt-image-2",
                prompt: "edit goat",
                referenceImages: [{ bytesBase64: "aW1hZ2U=", mimeType: "image/png", fileName: "goat.png" }],
              },
              attribution("fast-multipart-transport-rejection"),
            );

      for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenCalledTimes(1);
      expect(pendingCatch).toHaveBeenCalledTimes(1);

      releaseAccept?.();
      await expect(request).rejects.toBe(transportFailure);
    },
  );

  it("surfaces intent-abandon persistence over a synchronous fetch error", async () => {
    const { service, storage } = createHarness(openAiChatConfig());
    const abandon = vi.spyOn(storage.modelUsageEvents, "abandonTransportIntent").mockImplementationOnce(() => {
      throw new Error("injected abandon persistence fault");
    });
    const providerError = new TypeError("invalid synchronous fetch input");
    const fetchMock = vi.fn(() => {
      throw providerError;
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await service.chatCompletions(
        { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
        attribution("abandon-persistence"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelUsageDispatchPersistenceError);
    expect(failure).toMatchObject({ action: "abandon_intent", cause: expect.any(Error) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
    const staleIntent = storage.db
      .prepare("SELECT transport_status, terminal_outcome FROM model_usage_events LIMIT 1")
      .get<{ transport_status: string; terminal_outcome: string }>();
    expect(staleIntent).toMatchObject({
      transport_status: "intent",
      terminal_outcome: "in_flight",
    });
  });

  it("surfaces dispatch-unknown persistence when transport acceptance also fails", async () => {
    const { service, storage } = createHarness(openAiChatConfig());
    const accept = vi.spyOn(storage.modelUsageEvents, "acceptTransport").mockImplementationOnce(() => {
      throw new Error("injected transport acceptance persistence fault");
    });
    const markUnknown = vi.spyOn(storage.modelUsageEvents, "markDispatchUnknown").mockImplementationOnce(() => {
      throw new Error("injected dispatch-unknown persistence fault");
    });
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await service.chatCompletions(
        { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
        attribution("mark-dispatch-unknown-persistence"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelUsageDispatchPersistenceError);
    expect(failure).toMatchObject({ action: "mark_dispatch_unknown", cause: expect.any(Error) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(markUnknown).toHaveBeenCalledTimes(1);
    const staleIntent = storage.db
      .prepare("SELECT transport_status, terminal_outcome FROM model_usage_events LIMIT 1")
      .get<{ transport_status: string; terminal_outcome: string }>();
    expect(staleIntent).toMatchObject({
      transport_status: "intent",
      terminal_outcome: "in_flight",
    });
  });

  it("marks a failed acceptance dispatch unknown, drains the pending fetch, and blocks same-generation redispatch", async () => {
    const { service, storage } = createHarness(openAiChatConfig());
    const acceptanceFailure = new Error("injected transport acceptance persistence fault");
    const accept = vi.spyOn(storage.modelUsageEvents, "acceptTransport").mockImplementationOnce(() => {
      throw acceptanceFailure;
    });
    const markUnknown = vi.spyOn(storage.modelUsageEvents, "markDispatchUnknown");
    let rejectPending: (error: Error) => void = () => undefined;
    const pendingFetch = new Promise<Response>((_resolve, reject) => {
      rejectPending = reject;
    });
    const pendingCatch = vi.spyOn(pendingFetch, "catch");
    const fetchMock = vi.fn(() => pendingFetch);
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await service.chatCompletions(
        { providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] },
        attribution("mark-dispatch-unknown-success"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "ModelUsageDispatchUncertainError",
      cause: acceptanceFailure,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(markUnknown).toHaveBeenCalledTimes(1);
    expect(pendingCatch).toHaveBeenCalledTimes(1);
    expect(onlyUsageRecord(storage)).toMatchObject({
      transportStatus: "dispatch_unknown",
      terminalOutcome: "in_flight",
      dispatchUncertaintyReason: "transport_acceptance_persistence_failed",
    });

    rejectPending(new Error("pending provider fetch aborted after acceptance persistence failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records billed malformed standard image responses before adaptation rejects them", async () => {
    const { service, storage } = createHarness(openAiResponsesConfig());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "gpt-image-2-2026-07-01",
              usage: {
                input_tokens: 40,
                output_tokens: 5,
                cost_usd: 0.25,
                cost_source: "gateway_estimate",
              },
              data: [{ b64_json: "not-valid-base64!" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    await expect(
      service.generateImage(
        { providerId: "openai", model: "gpt-image-2", prompt: "Malformed billed image" },
        attribution("image-malformed"),
      ),
    ).rejects.toThrow("valid base64");

    expect(onlyUsageRecord(storage)).toMatchObject({
      callKind: "image_generation",
      effectiveModelId: "gpt-image-2-2026-07-01",
      inputTokens: 40,
      outputTokens: 5,
      costUsd: 0.25,
      costSource: "provider_reported",
      pricingSource: "provider_reported",
      terminalOutcome: "failed_after_usage",
    });
  });

  it("preserves Codex image completed effective-model drift and billed failure evidence", async () => {
    const secretStore = createCodexSecretStore();
    const success = createHarness(codexConfig(), secretStore);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [
              'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"aW1hZ2U="}}',
              'data: {"type":"response.completed","response":{"model":"gpt-image-2-2026-07-01","output":[],"usage":{"input_tokens":10,"output_tokens":2,"cost_usd":0.04}}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ) as typeof fetch,
    );

    await expect(
      success.service.generateImage(
        { providerId: "openai-codex", model: "gpt-image-2", prompt: "Codex image" },
        attribution("codex-image-success"),
      ),
    ).resolves.toMatchObject({ model: "gpt-image-2-2026-07-01" });
    expect(onlyUsageRecord(success.storage)).toMatchObject({
      effectiveModelId: "gpt-image-2-2026-07-01",
      costUsd: 0.04,
      terminalOutcome: "succeeded",
    });

    const failure = createHarness(codexConfig(), secretStore);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [
              'data: {"type":"response.failed","response":{"model":"gpt-image-2-2026-07-02","usage":{"input_tokens":12,"output_tokens":1,"cost_usd":0.03},"error":{"message":"image failed after billing"}}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ) as typeof fetch,
    );

    await expect(
      failure.service.generateImage(
        { providerId: "openai-codex", model: "gpt-image-2", prompt: "Fail billed image" },
        attribution("codex-image-failure"),
      ),
    ).rejects.toThrow("image failed after billing");
    expect(onlyUsageRecord(failure.storage)).toMatchObject({
      effectiveModelId: "gpt-image-2-2026-07-02",
      inputTokens: 12,
      outputTokens: 1,
      costUsd: 0.03,
      terminalOutcome: "failed_after_usage",
    });
  });

  it.each(["json", "sse"] as const)(
    "estimates trusted cost and effective model for token-bearing Responses %s failures",
    async (mode) => {
      const { service, storage } = createHarness(openAiResponsesConfig());
      const responsePayload = {
        id: `response-failed-${mode}`,
        status: "failed",
        model: "gpt-5.4-2026-03-05",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
        },
        error: { code: "provider_failure", message: `failed ${mode}` },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          mode === "json"
            ? new Response(JSON.stringify(responsePayload), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response(
                [
                  `data: ${JSON.stringify({ type: "response.failed", response: responsePayload })}`,
                  "",
                  "data: [DONE]",
                  "",
                ].join("\n"),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              ),
        ) as typeof fetch,
      );

      if (mode === "json") {
        await expect(
          service.chatCompletions(
            { providerId: "openai", model: "gpt-5.4", messages: [{ role: "user", content: "fail" }] },
            attribution(`responses-failure-${mode}`),
          ),
        ).rejects.toThrow(`failed ${mode}`);
      } else {
        await expect(async () => {
          for await (const _chunk of service.chatCompletionsStream(
            { providerId: "openai", model: "gpt-5.4", messages: [{ role: "user", content: "fail" }] },
            attribution(`responses-failure-${mode}`),
          )) {
            // consume
          }
        }).rejects.toThrow(`failed ${mode}`);
      }

      expect(onlyUsageRecord(storage)).toMatchObject({
        effectiveModelId: "gpt-5.4-2026-03-05",
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
        costUsd: 0.0004,
        costSource: "gateway_estimate",
        pricingSource: "gateway_estimate",
        terminalOutcome: "failed_after_usage",
      });
    },
  );

  it("leaves failed Responses cost unknown when the provider reports a non-equivalent model", async () => {
    const { service, storage } = createHarness(openAiResponsesConfig());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "failed",
              model: "unpriced-provider-model",
              usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
              error: { message: "model drift failure" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    await expect(
      service.chatCompletions(
        { providerId: "openai", model: "gpt-5.4", messages: [{ role: "user", content: "fail" }] },
        attribution("responses-model-drift"),
      ),
    ).rejects.toThrow("model drift failure");

    const record = onlyUsageRecord(storage);
    expect(record).toMatchObject({
      effectiveModelId: "unpriced-provider-model",
      inputTokens: 100,
      outputTokens: 10,
      costSource: "not_available",
      pricingSource: "not_available",
      terminalOutcome: "failed_after_usage",
    });
    expect(record.costUsd).toBeUndefined();
  });
});

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

function createCodexSecretStore(): SecretStoreService {
  const oauth = JSON.stringify({
    accessToken: "codex-access-token",
    refreshToken: "codex-refresh-token",
    expiresAt: Date.now() + 10 * 60_000,
    updatedAt: Date.now(),
  });
  return {
    ...createNoopSecretStore(),
    isAvailable: () => true,
    getSecret: (account: string) => (account === "provider:openai-codex:oauth" ? oauth : undefined),
  } as unknown as SecretStoreService;
}

import type { LlmConfigFile } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "../test/fake-openai-server.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { LlmService, type LlmLocalServiceLeaseAcquirer, type LlmLocalServiceLeaseRequest } from "./llm-service.js";

describe("LlmService local-service leases", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
  });

  it("holds a llama.cpp lease through a non-streaming completion and releases it", async () => {
    let leaseActive = false;
    server = await startFakeOpenAiCompatibleServer((request) => {
      expect(leaseActive).toBe(true);
      if (request.path === "/v1/chat/completions") {
        return { body: chatCompletionBody() };
      }
      return { status: 404, body: {} };
    });
    const release = vi.fn(() => {
      leaseActive = false;
    });
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async (request) => {
      leaseActive = true;
      expect(request).toMatchObject({
        providerId: "llamacpp",
        baseUrl: server?.baseUrl,
        purpose: "chat_completion",
      });
      return { release };
    });
    const service = createService(server.baseUrl, acquire);

    await service.chatCompletions({ messages: [{ role: "user", content: "hello" }] });

    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(leaseActive).toBe(false);
  });

  it("releases the lease when the provider request fails", async () => {
    server = await startFakeOpenAiCompatibleServer(() => ({
      status: 503,
      body: { error: { message: "provider unavailable" } },
    }));
    const release = vi.fn();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async () => ({ release }));
    const service = createService(server.baseUrl, acquire);

    await expect(service.chatCompletions({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(/503/);

    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the lease when a streaming consumer detaches early", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const release = vi.fn();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async () => ({ release }));
    const service = createService(server.baseUrl, acquire);

    for await (const _chunk of service.chatCompletionsStream({
      messages: [{ role: "user", content: "stream" }],
    })) {
      break;
    }

    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("leases the concrete model fetch but not a warm catalog-cache read", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const release = vi.fn();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async (request) => {
      expect(request.purpose).toBe("model_discovery");
      expect(request.signal).toBeDefined();
      return { release };
    });
    const service = createService(server.baseUrl, acquire);

    await expect(service.listModels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fake-chat" })]),
    );
    await expect(service.listModels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fake-chat" })]),
    );

    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds a lease for an exact-endpoint model preview transport", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const release = vi.fn();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async () => ({ release }));
    const service = createService(server.baseUrl, acquire);

    await expect(service.previewModels({ providerId: "llamacpp", baseUrl: server.baseUrl })).resolves.toMatchObject({
      source: "live",
    });

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "model_discovery", baseUrl: server.baseUrl }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a stale-cache background revalidation leased until its transport settles", async () => {
    let modelRequestCount = 0;
    let enterSecondRequest!: () => void;
    const secondRequestEntered = new Promise<void>((resolve) => {
      enterSecondRequest = resolve;
    });
    let resolveSecondRequest!: (value: { body: Record<string, unknown> }) => void;
    const secondRequest = new Promise<{ body: Record<string, unknown> }>((resolve) => {
      resolveSecondRequest = resolve;
    });
    server = await startFakeOpenAiCompatibleServer((request) => {
      if (request.method === "GET" && request.path === "/v1/models") {
        modelRequestCount += 1;
        if (modelRequestCount === 2) {
          enterSecondRequest();
          return secondRequest;
        }
        return { body: modelCatalogBody() };
      }
      return { status: 404, body: {} };
    });
    const release = vi.fn();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(async () => ({ release }));
    const service = createService(server.baseUrl, acquire);
    const initialNow = Date.now();

    await service.listModels();
    vi.spyOn(Date, "now").mockReturnValue(initialNow + 120_000);
    await service.listModels();
    await secondRequestEntered;

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();

    resolveSecondRequest({ body: modelCatalogBody() });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  });

  it("never asks the runtime owner to lease a non-llama provider", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>();
    const service = createService(server.baseUrl, acquire, "openai-compatible");

    await service.chatCompletions({ messages: [{ role: "user", content: "hello" }] });

    expect(acquire).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation during lease acquisition without dispatching", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const controller = new AbortController();
    let entered!: (request: LlmLocalServiceLeaseRequest) => void;
    const enteredPromise = new Promise<LlmLocalServiceLeaseRequest>((resolve) => {
      entered = resolve;
    });
    const acquire = vi.fn<LlmLocalServiceLeaseAcquirer>(
      (request) =>
        new Promise((_resolve, reject) => {
          entered(request);
          request.signal?.addEventListener(
            "abort",
            () => reject(request.signal?.reason ?? new Error("lease acquisition aborted")),
            { once: true },
          );
        }),
    );
    const service = createService(server.baseUrl, acquire);
    const pending = service.chatCompletions({
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
    });
    const request = await enteredPromise;

    controller.abort(new Error("operator cancelled"));

    await expect(pending).rejects.toThrow("operator cancelled");
    expect(request.signal).toBe(controller.signal);
    expect(server.requests).toHaveLength(0);
  });
});

function createService(
  baseUrl: string,
  localServiceLeaseAcquirer: LlmLocalServiceLeaseAcquirer,
  providerId = "llamacpp",
): LlmService {
  const config: LlmConfigFile = {
    activeProviderId: providerId,
    activeModel: "fake-chat",
    providers: [
      {
        providerId,
        label: providerId,
        baseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-chat",
      },
    ],
  };
  return new LlmService(config, {}, { secretStore: createNoopSecretStore(), localServiceLeaseAcquirer });
}

function chatCompletionBody(): Record<string, unknown> {
  return {
    id: "lease-test",
    object: "chat.completion",
    model: "fake-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function modelCatalogBody(): Record<string, unknown> {
  return {
    data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }],
  };
}

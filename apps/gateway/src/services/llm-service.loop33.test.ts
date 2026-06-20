import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmService loop33 runtime branch coverage", () => {
  it("covers provider selection, active model, and empty chat request failures", async () => {
    const service = new LlmService(
      {
        activeProviderId: "openai",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "gpt-4.1-mini",
          },
        ],
      },
      {},
      { secretStore: createNoopSecretStore() },
    );

    expect(service.updateRuntimeConfig({ activeProviderId: "   " })).toMatchObject({
      activeProviderId: "",
      activeModel: "",
    });
    expect(() => service.updateRuntimeConfig({ activeProviderId: "missing" })).toThrow("Unknown LLM provider: missing");
    expect(service.updateRuntimeConfig({ activeProviderId: "openai", activeModel: "gpt-4.1" })).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-4.1",
    });
    expect(service.updateRuntimeConfig({ activeModel: "gpt-4.1-mini" })).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-4.1-mini",
    });
    expect(() => service.getProviderSecretStatus("missing")).toThrow("Unknown LLM provider: missing");
    await expect(service.chatCompletions({ messages: [] })).rejects.toThrow(
      "chat/completions requires at least one message",
    );
    await expect(async () => {
      for await (const _event of service.chatCompletionsStream({ messages: [] })) {
        // The generator should throw before yielding.
      }
    }).rejects.toThrow("chat/completions requires at least one message");

    expect(service.updateRuntimeConfig({ activeProviderId: "" })).toMatchObject({
      activeProviderId: "",
      activeModel: "",
    });
    expect(() => service.resolveExecutionApiStyle()).toThrow(
      "No active LLM provider is configured. Select a provider first.",
    );
    expect(() => service.resolveExecutionApiStyle("missing")).toThrow("Unknown LLM provider: missing");
  });

  it("surfaces provider key deletion errors and protects Codex OAuth providers", () => {
    const unavailableDeletes = {
      ...createNoopSecretStore(),
      deleteProviderApiKey: () => {
        throw new Error("delete failed");
      },
    } as SecretStoreService;
    const service = new LlmService(openAiImageConfig(), {}, { secretStore: unavailableDeletes });

    expect(() => service.setProviderApiKey("missing", "sk-test")).toThrow("Unknown LLM provider: missing");
    expect(() => service.deleteProviderApiKey("missing")).toThrow("Unknown LLM provider: missing");
    expect(() => service.deleteProviderApiKey("openai")).toThrow("delete failed");

    const codexService = new LlmService(createCodexConfig(), {}, { secretStore: createTrackedSecretStore() });
    expect(() => codexService.setProviderApiKey("openai-codex", "sk-test")).toThrow(
      "OpenAI Codex uses ChatGPT OAuth. Connect it through the OpenAI Codex OAuth flow.",
    );
    expect(() => codexService.deleteProviderApiKey("openai-codex")).toThrow(
      "OpenAI Codex uses ChatGPT OAuth. Disconnect it through the OpenAI Codex OAuth flow.",
    );
  });

  it("rejects invalid image-generation requests before posting to providers", async () => {
    const service = new LlmService(
      {
        activeProviderId: "anthropic",
        providers: [
          {
            providerId: "anthropic",
            label: "Anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            apiStyle: "anthropic-messages",
            defaultModel: "claude-sonnet-4-6",
          },
        ],
      },
      {},
      { secretStore: createNoopSecretStore() },
    );

    await expect(service.generateImage({ prompt: "   " })).rejects.toThrow("images requires a non-empty prompt");
    await expect(service.generateImage({ prompt: "draw a console" })).rejects.toThrow(
      "Image generation currently requires an OpenAI, OpenAI Codex, or Google-compatible provider.",
    );
  });

  it("passes optional multipart edit fields, mask files, and multiple references to OpenAI image edits", async () => {
    const service = new LlmService(openAiImageConfig(), {}, { secretStore: createNoopSecretStore() });
    let requestedUrl = "";
    const bodyEntries: Array<[string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        requestedUrl = String(input);
        const formData = init?.body as FormData;
        formData.forEach((value, key) => {
          bodyEntries.push([key, value]);
        });
        return new Response(
          JSON.stringify({
            model: "gpt-image-1",
            created: 321,
            data: [{ url: "https://cdn.example.test/edit.png", revised_prompt: "Sharper console" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    const response = await service.generateImage({
      providerId: "openai",
      model: "gpt-image-1",
      prompt: "Edit these references into one operations console",
      n: 2,
      size: "1536x1024",
      quality: "high",
      background: "transparent",
      outputFormat: "webp",
      responseFormat: "url",
      moderation: "low",
      referenceImages: [
        { bytesBase64: "cmVmMQ==", mimeType: "image/png", fileName: "ref-one.png" },
        { bytesBase64: "cmVmMg==", mimeType: "image/jpeg", fileName: "ref-two.jpg" },
      ],
      maskImage: { bytesBase64: "bWFzaw==", mimeType: "image/png", fileName: "mask.png" },
    });

    expect(requestedUrl).toBe("https://api.openai.com/v1/images/edits");
    expect(response).toMatchObject({
      providerId: "openai",
      model: "gpt-image-1",
      operation: "edit",
      data: [{ url: "https://cdn.example.test/edit.png", revisedPrompt: "Sharper console" }],
      evidence: {
        owner: "gateway",
        source: "provider_response",
        providerId: "openai",
        model: "gpt-image-1",
        operation: "edit",
        resultCount: 1,
        status: "provider_backed",
        results: [
          {
            index: 0,
            source: "url",
            status: "provider_url",
            urlHost: "cdn.example.test",
            persistedArtifact: {
              status: "external_url",
            },
          },
        ],
      },
    });
    expect(response.evidence?.referenceImageHashes).toHaveLength(2);
    expect(response.evidence?.maskImageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.evidence?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.evidence?.results[0]?.urlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.evidence)).not.toContain("Edit these references");
    expect(JSON.stringify(response.evidence)).not.toContain("cmVmMQ==");
    expect(bodyEntries).toEqual(
      expect.arrayContaining([
        ["model", "gpt-image-1"],
        ["prompt", "Edit these references into one operations console"],
        ["n", "2"],
        ["size", "1536x1024"],
        ["quality", "high"],
        ["background", "transparent"],
        ["output_format", "webp"],
        ["response_format", "url"],
        ["moderation", "low"],
      ]),
    );
    expect(bodyEntries.filter(([key]) => key === "image[]")).toHaveLength(2);
    expect(bodyEntries.some(([key]) => key === "mask")).toBe(true);
  });

  it("surfaces image-generation redirects and provider HTTP failures", async () => {
    const service = new LlmService(openAiImageConfig(), {}, { secretStore: createNoopSecretStore() });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("moved", { status: 302, statusText: "Found" }))
        .mockResolvedValueOnce(new Response("provider exploded", { status: 500, statusText: "Server Error" })),
    );

    await expect(service.generateImage({ providerId: "openai", prompt: "draw redirect" })).rejects.toThrow(
      "image generation blocked redirect (302)",
    );
    await expect(service.generateImage({ providerId: "openai", prompt: "draw failure" })).rejects.toThrow(
      "image generation failed (500 Server Error): provider exploded",
    );
  });

  it("surfaces image-edit and Codex image transport failures", async () => {
    const openAiService = new LlmService(openAiImageConfig(), {}, { secretStore: createNoopSecretStore() });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("edit moved", { status: 307, statusText: "Temporary Redirect" }))
        .mockResolvedValueOnce(new Response("edit failed", { status: 400, statusText: "Bad Request" })),
    );

    const editRequest = {
      providerId: "openai",
      prompt: "edit reference",
      referenceImages: [{ bytesBase64: "cmVm" }],
    };
    await expect(openAiService.generateImage(editRequest)).rejects.toThrow("image edit blocked redirect (307)");
    await expect(openAiService.generateImage(editRequest)).rejects.toThrow(
      "image edit failed (400 Bad Request): edit failed",
    );

    const codexService = new LlmService(createCodexConfig(), {}, { secretStore: createTrackedSecretStore() });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("codex moved", { status: 301, statusText: "Moved Permanently" }))
        .mockResolvedValueOnce(new Response("codex failed", { status: 429, statusText: "Too Many Requests" }))
        .mockResolvedValueOnce(
          new Response('data: {"type":"response.failed","error":{"message":"image tool failed"}}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );

    await expect(codexService.generateImage({ providerId: "openai-codex", prompt: "redirect" })).rejects.toThrow(
      "OpenAI Codex image generation blocked redirect (301)",
    );
    await expect(codexService.generateImage({ providerId: "openai-codex", prompt: "rate limit" })).rejects.toThrow(
      "OpenAI Codex image generation failed (429 Too Many Requests): codex failed",
    );
    await expect(codexService.generateImage({ providerId: "openai-codex", prompt: "failed event" })).rejects.toThrow(
      "image tool failed",
    );
  });

  it("uses completed OpenAI Codex image events and rejects Codex-specific unsupported edit options", async () => {
    const service = new LlmService(createCodexConfig(), {}, { secretStore: createTrackedSecretStore() });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [
              'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"Y29tcGxldGVkLWltYWdl","revised_prompt":"Completed prompt"}]}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ) as typeof fetch,
    );

    await expect(
      service.generateImage({
        providerId: "openai-codex",
        prompt: "render from too many references",
        referenceImages: Array.from({ length: 6 }, (_, index) => ({
          bytesBase64: Buffer.from(`ref-${index}`).toString("base64"),
        })),
      }),
    ).rejects.toThrow("OpenAI Codex image generation supports at most 5 reference images.");
    await expect(
      service.generateImage({
        providerId: "openai-codex",
        prompt: "render with mask",
        maskImage: { bytesBase64: "bWFzaw==" },
      }),
    ).rejects.toThrow("OpenAI Codex image generation does not support mask images in v1.");
    await expect(
      service.generateImage({
        providerId: "openai-codex",
        prompt: "render too many",
        n: 5,
      }),
    ).rejects.toThrow("OpenAI Codex image generation supports 1 to 4 results.");

    await expect(
      service.generateImage({
        providerId: "openai-codex",
        prompt: "render completed event",
        n: 1,
      }),
    ).resolves.toMatchObject({
      providerId: "openai-codex",
      model: "gpt-image-2",
      operation: "generate",
      data: [{ b64Json: "Y29tcGxldGVkLWltYWdl", revisedPrompt: "Completed prompt" }],
    });
  });

  it("adds query-auth secrets to provider request URLs and omits them when unavailable", async () => {
    const service = new LlmService(
      {
        activeProviderId: "query-provider",
        providers: [
          {
            providerId: "query-provider",
            label: "Query Provider",
            baseUrl: "https://api.query-provider.example/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "query-model",
            request: {
              auth: {
                type: "query",
                queryParam: "api_key",
                valueEnv: "QUERY_PROVIDER_KEY",
                prefix: "Bearer ",
              },
            },
          },
        ],
      },
      { QUERY_PROVIDER_KEY: " query-secret " },
      { secretStore: createNoopSecretStore() },
    );
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        requestedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-query",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    await service.chatCompletions({ providerId: "query-provider", messages: [{ role: "user", content: "hi" }] });
    expect(requestedUrls[0]).toBe("https://api.query-provider.example/v1/chat/completions?api_key=Bearer+query-secret");

    service.updateRuntimeConfig({
      upsertProvider: {
        providerId: "query-provider",
        request: {
          auth: {
            type: "query",
            queryParam: "api_key",
            valueEnv: "MISSING_QUERY_PROVIDER_KEY",
          },
        },
      },
    });
    await service.chatCompletions({ providerId: "query-provider", messages: [{ role: "user", content: "hi" }] });
    expect(requestedUrls[1]).toBe("https://api.query-provider.example/v1/chat/completions");
  });
});

function openAiImageConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4-mini",
      },
    ],
  };
}

function createCodexConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai-codex",
    activeModel: "openai-codex/gpt-5.5",
    providers: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        authMode: "codex-oauth",
      },
    ],
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

function createTrackedSecretStore(): SecretStoreService {
  const secrets = new Map<string, string>([
    [
      "provider:openai-codex:oauth",
      JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    ],
  ]);
  return {
    isAvailable: () => true,
    setProviderApiKey: (providerId: string, apiKey: string) => {
      secrets.set(providerId, apiKey);
    },
    getProviderApiKey: (providerId: string) => secrets.get(providerId),
    deleteProviderApiKey: (providerId: string) => {
      secrets.delete(providerId);
    },
    setSecret: (account: string, secret: string) => {
      secrets.set(account, secret);
    },
    getSecret: (account: string) => secrets.get(account),
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
    status: (providerId: string) => ({
      providerId,
      hasSecret: secrets.has(providerId),
      source: secrets.has(providerId) ? "keychain" : "none",
    }),
  } as unknown as SecretStoreService;
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { GoogleCloudAuthService } from "./google-cloud-auth-service.js";
import { LlmReasoningProfileError } from "./llm-reasoning-profile.js";
import { LlmService, sanitizeProviderResponseForPublicProjection } from "./llm-service.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LlmService Vertex AI integration", () => {
  it("resolves authorized-user ADC and sends complete/tool/reasoning requests to the canonical Vertex endpoint", async () => {
    const root = createRoot();
    const credentialPath = join(root, "adc.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
        quota_project_id: "project-from-adc",
      }),
    );
    const metadataPath = writeMetadata(root);
    const env = { GOOGLE_APPLICATION_CREDENTIALS: credentialPath };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "vertex-access-token", expires_in: 3600 });
      }
      expect(url).toBe(
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/config-project/locations/europe-west4/endpoints/openapi/chat/completions",
      );
      expect(readHeader(init?.headers, "authorization")).toBe("Bearer vertex-access-token");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "Use the tool" }],
        stream: false,
        reasoning_effort: "high",
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        parallel_tool_calls: true,
      });
      return jsonResponse({
        id: "vertex-completion",
        model: "google/gemini-2.5-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done", reasoning_content: "private chain of thought" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1_000, completion_tokens: 100 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const googleCloudAuthService = new GoogleCloudAuthService({ env, fetch: fetchMock as typeof fetch });
    const service = new LlmService(vertexConfig("google-adc"), env, {
      secretStore: createNoopSecretStore(),
      googleCloudAuthService,
      modelMetadataPath: metadataPath,
      enforceNetworkAllowlist: false,
    });

    expect(service.listProviders()).toEqual([
      expect.objectContaining({
        providerId: "vertex",
        authMode: "google-adc",
        hasApiKey: true,
        apiKeySource: "none",
        googleCloud: { projectId: "config-project", location: "europe-west4", endpointId: "openapi" },
      }),
    ]);
    const response = await service.chatCompletions({
      messages: [{ role: "user", content: "Use the tool" }],
      reasoning: { effort: "high" },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      parallel_tool_calls: true,
    });

    expect(requests).toHaveLength(2);
    expect(response.usage?.cost_usd).toBe(0.00055);
    expect(response.routing?.reasoning).toEqual({
      requested: "high",
      actual: "high",
      providerEffort: "high",
      disposition: "honored",
      reasonCode: "requested_reasoning_supported",
      capabilitySource: "model_metadata",
    });
    expect(response.choices?.[0]?.message).toEqual({ role: "assistant", content: "done" });
  });

  it("treats Chat off as an omitted Vertex reasoning field and never mixes Google thinking config", async () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    let payload: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "vertex-off",
        model: "google/gemini-2.5-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const googleCloudAuthService = new GoogleCloudAuthService({ env: {}, fetch: fetchMock as typeof fetch });
    vi.spyOn(googleCloudAuthService, "resolve").mockResolvedValue({
      accessToken: "short-lived-token",
      expiresAt: "2026-07-13T20:00:00.000Z",
      projectId: "config-project",
      location: "europe-west4",
      endpointId: "openapi",
      baseUrl:
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/config-project/locations/europe-west4/endpoints/openapi",
      credentialType: "adc",
      credentialSource: "adc_file",
    });
    const service = new LlmService(
      vertexConfig("google-adc"),
      {},
      {
        secretStore: createNoopSecretStore(),
        googleCloudAuthService,
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );

    const response = await service.chatCompletions({
      messages: [{ role: "user", content: "Do not reason" }],
      reasoning: { effort: "none" },
    });

    expect(payload).toEqual({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: "Do not reason" }],
      stream: false,
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("google");
    expect(payload).not.toHaveProperty("thinking_config");
    expect(response.routing?.reasoning).toMatchObject({
      requested: "none",
      actual: "none",
      providerEffort: "none",
      disposition: "honored",
      capabilitySource: "model_metadata",
    });
  });

  it("does not promote missing, malformed, or unprobed metadata ADC as route-ready", () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    const missingPath = join(root, "missing-adc.json");
    const malformedPath = join(root, "malformed-adc.json");
    writeFileSync(malformedPath, "{not-json");

    const summarize = (env: NodeJS.ProcessEnv, auth: GoogleCloudAuthService) =>
      new LlmService(vertexConfig("google-adc"), env, {
        secretStore: createNoopSecretStore(),
        googleCloudAuthService: auth,
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      }).listProviders()[0];

    const missingEnv = { GOOGLE_APPLICATION_CREDENTIALS: missingPath };
    expect(
      summarize(missingEnv, new GoogleCloudAuthService({ env: missingEnv, fetch: vi.fn() as typeof fetch })),
    ).toMatchObject({
      hasApiKey: false,
      authReadiness: { status: "missing", source: "adc_file", liveVerified: false },
    });

    const malformedEnv = { GOOGLE_APPLICATION_CREDENTIALS: malformedPath };
    expect(
      summarize(malformedEnv, new GoogleCloudAuthService({ env: malformedEnv, fetch: vi.fn() as typeof fetch })),
    ).toMatchObject({
      hasApiKey: false,
      authReadiness: { status: "invalid", source: "adc_file", liveVerified: false },
    });

    const metadataAuth = new GoogleCloudAuthService({
      env: {},
      fetch: vi.fn() as typeof fetch,
      platform: "win32",
      homedir: () => "C:\\Users\\goat-no-adc",
    });
    expect(summarize({}, metadataAuth)).toMatchObject({
      hasApiKey: false,
      authReadiness: { status: "unknown", source: "metadata", liveVerified: false },
    });
  });

  it("passes a Gateway-owned service-account secret to the auth owner without exposing it in runtime config", async () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    const serviceAccountJson = JSON.stringify({ type: "service_account", private_key: "private", client_email: "x@y" });
    const secretStore = {
      ...createNoopSecretStore(),
      isAvailable: () => true,
      getProviderApiKey: (providerId: string) => (providerId === "vertex" ? serviceAccountJson : undefined),
    };
    const googleCloudAuthService = new GoogleCloudAuthService({ env: {}, fetch: vi.fn() as typeof fetch });
    const authSpy = vi.spyOn(googleCloudAuthService, "resolve").mockResolvedValue({
      accessToken: "short-lived-token",
      expiresAt: "2026-07-13T20:00:00.000Z",
      projectId: "config-project",
      location: "europe-west4",
      endpointId: "openapi",
      baseUrl:
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/config-project/locations/europe-west4/endpoints/openapi",
      credentialType: "service_account",
      credentialSource: "keychain",
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "ok",
        model: "google/gemini-2.5-flash",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      vertexConfig("google-service-account"),
      {},
      {
        secretStore,
        googleCloudAuthService,
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );

    await service.chatCompletions({ messages: [{ role: "user", content: "hello" }] });
    expect(authSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "vertex",
        credentialMode: "service-account",
        serviceAccountJson,
        serviceAccountSource: "keychain",
      }),
    );
    expect(JSON.stringify(service.getRuntimeConfig({ includeKeychainForActiveProvider: true }))).not.toContain(
      "private",
    );
    expect(JSON.stringify(service.getRuntimeConfig({ includeKeychainForActiveProvider: true }))).not.toContain(
      "short-lived-token",
    );
  });
});

describe("LlmService Fireworks integration", () => {
  it("maps internal ultra to Fireworks max only through explicit model metadata", async () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    let payload: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "fw-reasoning",
        model: "accounts/goat/models/reasoner",
        provider_meta: {
          public_label: "kept-complete",
          nested: { analysis: "private top-level nested reasoning" },
        },
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "public answer",
              reasoning_content: "private reasoning",
              provider_meta: {
                public_label: "kept-message",
                nested: { reasoningDetails: [{ text: "private nested complete reasoning" }] },
              },
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      fireworksConfig("accounts/goat/models/reasoner"),
      { FIREWORKS_API_KEY: "key" },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );

    const completion = await service.chatCompletions({
      messages: [{ role: "user", content: "think" }],
      reasoning: { effort: "ultra" },
    });

    expect(payload).toMatchObject({
      reasoning_effort: "max",
      context_length_exceeded_behavior: "error",
    });
    expect(completion.routing?.reasoning).toMatchObject({
      requested: "ultra",
      actual: "ultra",
      providerEffort: "max",
      disposition: "honored",
      capabilitySource: "model_metadata",
    });
    expect(completion.choices?.[0]?.message).toEqual({
      role: "assistant",
      content: "public answer",
      provider_meta: { public_label: "kept-message", nested: {} },
    });
    expect(completion).toMatchObject({ provider_meta: { public_label: "kept-complete", nested: {} } });
    expect(JSON.stringify(completion)).not.toMatch(
      /private reasoning|private top-level nested reasoning|private nested complete reasoning|reasoning_content|reasoningDetails|analysis/u,
    );
  });

  it("uses the OpenAI-compatible complete and streaming tool paths with Fireworks cost attribution", async () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    const payloads: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(readHeader(init?.headers, "authorization")).toBe("Bearer fireworks-key");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      if (payload.stream === true) {
        return new Response(
          [
            'data: {"id":"fw-stream","model":"accounts/fireworks/models/kimi-k2p6","provider_meta":{"public_label":"kept-stream","nested":{"chain-of-thought":"private deep stream reasoning"}},"choices":[{"index":0,"delta":{"content":"public ","reasoning_content":"private stream reasoning","reasoning_details":[{"type":"reasoning.text","text":"private nested reasoning"}],"provider_meta":{"public_label":"kept-delta","nested":{"thinkingContent":"private camel stream reasoning"}},"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"reasoning\\":\\"operator supplied tool argument\\"}"}}]}}]}',
            'data: {"id":"fw-stream","model":"accounts/fireworks/models/kimi-k2p6","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1000,"completion_tokens":100,"cached_prompt_tokens":200}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({
        id: "fw-complete",
        model: "accounts/fireworks/models/kimi-k2p6",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1_000, completion_tokens: 100, cached_prompt_tokens: 200 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      fireworksConfig(),
      { FIREWORKS_API_KEY: "fireworks-key" },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );
    const request = {
      messages: [{ role: "user" as const, content: "Use lookup" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      parallel_tool_calls: true,
    };

    const completion = await service.chatCompletions(request);
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of service.chatCompletionsStream(request)) chunks.push(chunk);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      stream: false,
      parallel_tool_calls: true,
      context_length_exceeded_behavior: "error",
    });
    expect(payloads[1]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
      context_length_exceeded_behavior: "error",
    });
    expect(completion.usage?.cost_usd).toBe(0.001192);
    expect(chunks.at(-1)?.usage).toMatchObject({ cost_usd: 0.001192, cost_source: "estimated" });
    expect(JSON.stringify(chunks)).not.toMatch(
      /private stream reasoning|private nested reasoning|private deep stream reasoning|private camel stream reasoning|reasoning_content|reasoning_details|chain-of-thought|thinkingContent/u,
    );
    expect(
      chunks.flatMap((chunk) =>
        Array.isArray(chunk.choices)
          ? chunk.choices.flatMap((choice) => {
              const delta = (choice as { delta?: Record<string, unknown> }).delta;
              return typeof delta?.content === "string" ? [delta.content] : [];
            })
          : [],
      ),
    ).toEqual(["public ", "answer"]);
    expect(JSON.stringify(chunks)).toContain('"public_label":"kept-stream"');
    expect(JSON.stringify(chunks)).toContain('"public_label":"kept-delta"');
    expect(JSON.stringify(chunks)).toContain('"name":"lookup"');
    expect(JSON.stringify(chunks)).toContain("operator supplied tool argument");
  });

  it("rejects reasoning for Fireworks Kimi K2.6 before dispatch and normalizes provider errors", async () => {
    const root = createRoot();
    const metadataPath = writeMetadata(root);
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      fireworksConfig(),
      { FIREWORKS_API_KEY: "fireworks-key" },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );

    await expect(
      service.chatCompletions({
        messages: [{ role: "user", content: "think" }],
        reasoning: { effort: "high" },
      }),
    ).rejects.toBeInstanceOf(LlmReasoningProfileError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(service.chatCompletions({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(
      /chat completion failed \(429/u,
    );
  });

  it("does not let provider-wildcard metadata grant Fireworks xhigh to an arbitrary model", async () => {
    const root = createRoot();
    const metadataPath = join(root, "wildcard-metadata.json");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        version: 1,
        entries: {
          "fireworks/*": {
            contextWindow: 262_144,
            outputTokenLimit: 32_768,
            reasoning: { supportedEfforts: ["none", "xhigh"] },
          },
        },
      }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      fireworksConfig("accounts/goat/models/reasoner-without-exact-metadata"),
      { FIREWORKS_API_KEY: "fireworks-key" },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: metadataPath,
        enforceNetworkAllowlist: false,
      },
    );

    await expect(
      service.chatCompletions({
        messages: [{ role: "user", content: "think" }],
        reasoning: { effort: "xhigh" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_reasoning_wire_effort" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty Fireworks credential source before provider dispatch", async () => {
    const root = createRoot();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const service = new LlmService(
      fireworksConfig(),
      { FIREWORKS_API_KEY: "   " },
      {
        secretStore: createNoopSecretStore(),
        modelMetadataPath: writeMetadata(root),
        enforceNetworkAllowlist: false,
      },
    );

    expect(service.listProviders()[0]).toMatchObject({ providerId: "fireworks", hasApiKey: false });
    await expect(service.chatCompletions({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(
      /Fireworks requires a configured API key/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("provider response public projection", () => {
  it("recursively strips private fields through nested arrays and preserves public content and tool arguments", () => {
    const source = {
      content: "public answer",
      nested: [
        {
          reasoning_content: "private",
          public: [
            { thinking: "private too", text: "kept" },
            { tool_calls: [{ function: { name: "lookup", arguments: '{"reasoning":"operator value"}' } }] },
          ],
        },
      ],
    };

    const projected = sanitizeProviderResponseForPublicProjection(source);

    expect(JSON.stringify(projected)).toBe(
      '{"content":"public answer","nested":[{"public":[{"text":"kept"},{"tool_calls":[{"function":{"name":"lookup","arguments":"{\\"reasoning\\":\\"operator value\\"}"}}]}]}]}',
    );
  });

  it("uses null-prototype records for hostile prototype keys without polluting consumers", () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"alsoPolluted":"no"}},"prototype":{"safe":"value"},"nested":{"analysis":"private","public":"kept"}}',
    ) as Record<string, unknown>;

    const projected = sanitizeProviderResponseForPublicProjection(source);

    expect(Object.getPrototypeOf(projected)).toBeNull();
    expect(Object.getPrototypeOf(projected.nested as object)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.prototype).not.toHaveProperty("alsoPolluted");
    expect(JSON.stringify(projected)).toContain('"__proto__":{"polluted":"no"}');
    expect(JSON.stringify(projected)).toContain('"public":"kept"');
    expect(JSON.stringify(projected)).not.toContain('"analysis"');
  });

  it("handles deep acyclic adapter graphs iteratively and strips the deepest private field", () => {
    const root: Record<string, unknown> = { public: "root" };
    let cursor = root;
    for (let index = 0; index < 5_000; index += 1) {
      const next: Record<string, unknown> = { index };
      cursor.next = next;
      cursor = next;
    }
    cursor.reasoning_details = { text: "private at depth" };
    cursor.public = "leaf";

    const projected = sanitizeProviderResponseForPublicProjection(root);
    let projectedCursor = projected;
    for (let index = 0; index < 5_000; index += 1) {
      projectedCursor = projectedCursor.next as Record<string, unknown>;
    }
    expect(projectedCursor).toMatchObject({ index: 4_999, public: "leaf" });
    expect(projectedCursor).not.toHaveProperty("reasoning_details");
  });

  it("fails closed on cyclic graphs and sanitization-node budget exhaustion", () => {
    const cyclic: Record<string, unknown> = { content: "public" };
    cyclic.self = cyclic;
    expect(() => sanitizeProviderResponseForPublicProjection(cyclic)).toThrow(/cyclic or aliased/u);

    const oversized = { content: Array.from({ length: 50_001 }, (_, index) => index) };
    expect(() => sanitizeProviderResponseForPublicProjection(oversized)).toThrow(/sanitization node limit/u);
  });
});

function vertexConfig(authMode: "google-adc" | "google-service-account"): LlmConfigFile {
  return {
    activeProviderId: "vertex",
    activeModel: "google/gemini-2.5-flash",
    providers: [
      {
        providerId: "vertex",
        label: "Vertex",
        baseUrl:
          "https://us-central1-aiplatform.googleapis.com/v1/projects/placeholder/locations/us-central1/endpoints/openapi",
        apiStyle: "openai-chat-completions",
        defaultModel: "google/gemini-2.5-flash",
        authMode,
        googleCloud: { projectId: "config-project", location: "europe-west4", endpointId: "openapi" },
      },
    ],
  };
}

function fireworksConfig(model = "accounts/fireworks/models/kimi-k2p6"): LlmConfigFile {
  return {
    activeProviderId: "fireworks",
    activeModel: model,
    providers: [
      {
        providerId: "fireworks",
        label: "Fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: model,
        apiKeyEnv: "FIREWORKS_API_KEY",
      },
    ],
  };
}

function writeMetadata(root: string): string {
  const path = join(root, "metadata.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      entries: {
        "vertex/google/gemini-2.5-flash": {
          contextWindow: 1_048_576,
          outputTokenLimit: 65_535,
          reasoning: { supportedEfforts: ["low", "medium", "high"] },
        },
        "fireworks/accounts/fireworks/models/kimi-k2p6": {
          contextWindow: 262_144,
          outputTokenLimit: 32_768,
          reasoning: { supportedEfforts: ["none"] },
        },
        "fireworks/accounts/goat/models/reasoner": {
          contextWindow: 262_144,
          outputTokenLimit: 32_768,
          reasoning: {
            supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
            providerEffortMap: { ultra: "max" },
          },
        },
      },
    }),
  );
  return path;
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "goatcitadel-provider-parity-"));
  roots.push(root);
  return root;
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function readHeader(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

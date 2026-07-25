import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import {
  currentEmbeddingProfile,
  generateEmbedding,
  isEmbeddingCurrent,
  type EmbeddingUsageAttempt,
  type EmbeddingUsageDispatchInput,
  type EmbeddingUsageDispatchReservation,
} from "./local-embeddings.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local embeddings profile", () => {
  it("uses the default pseudo profile with visible profile metadata", async () => {
    const profile = currentEmbeddingProfile();
    const generated = await generateEmbedding("operator-visible memory");

    expect(profile).toMatchObject({
      profileId: "pseudo:pseudo-hash-v1:64:goatcitadel-embedding-v1",
      provider: "pseudo",
      modelId: "pseudo-hash-v1",
      dimensions: 64,
      status: "active",
      source: "default",
    });
    expect(generated.profile).toEqual(profile);
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata).toMatchObject({
      provider: "pseudo",
      modelId: "pseudo-hash-v1",
      profileId: profile.profileId,
      profileStatus: "active",
      dimensions: 64,
    });
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(true);
  });

  it("supports request-scoped pseudo dimensions and detects stale profile metadata", async () => {
    const request = { provider: "pseudo", modelId: "pseudo-hash-v1-small", dimensions: 16 };
    const generated = await generateEmbedding("short profile", new Date("2026-05-15T12:00:00.000Z"), request);

    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      modelId: "pseudo-hash-v1-small",
      dimensions: 16,
      source: "request",
      status: "active",
    });
    expect(generated.embedding).toHaveLength(16);
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata, request)).toBe(true);
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(false);
  });

  it("falls back explicitly when a non-pseudo provider is requested without config", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote-openai-compatible");

    const generated = await generateEmbedding("fallback profile");

    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      requestedProvider: "remote-openai-compatible",
      status: "fallback",
      source: "environment",
      fallbackReason: "embedding-provider-unavailable: remote-openai-compatible",
    });
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toBe("embedding-provider-unavailable: remote-openai-compatible");
  });
});

describe("local embeddings provider selection", () => {
  it("defaults to pseudo when the env var is unset and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const profile = currentEmbeddingProfile();
    const generated = await generateEmbedding("default selection");

    expect(profile.provider).toBe("pseudo");
    expect(generated.metadata.provider).toBe("pseudo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an unknown provider id as unavailable → pseudo, never calling fetch even with a URL configured", async () => {
    // A typo'd/misconfigured provider must degrade to pseudo, NOT fall through to
    // live HTTP against GOATCITADEL_EMBEDDINGS_URL under the guise of `remote`.
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "gpt5-embeddings-typo");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const profile = currentEmbeddingProfile();
    const generated = await generateEmbedding("unknown provider");

    expect(profile.provider).toBe("pseudo");
    expect(profile).toMatchObject({
      provider: "pseudo",
      status: "fallback",
      requestedProvider: "gpt5-embeddings-typo",
      fallbackReason: "embedding-provider-unavailable: gpt5-embeddings-typo",
    });
    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toBe("embedding-provider-unavailable: gpt5-embeddings-typo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves an active llamacpp profile when fully configured", () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "nomic-embed-text");

    const profile = currentEmbeddingProfile();
    expect(profile).toMatchObject({
      provider: "llamacpp",
      modelId: "nomic-embed-text",
      dimensions: 8,
      status: "active",
      source: "environment",
      profileId: "llamacpp:nomic-embed-text:8:goatcitadel-embedding-v1",
    });
  });
});

describe("local embeddings real provider", () => {
  const dims = 8;
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  beforeEach(() => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", String(dims));
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
  });

  it("uses a llama.cpp endpoint and stamps the real provider profile", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "nomic-embed-text");
    const fetchSpy = vi.fn(async () => jsonResponse({ embedding: vector }));
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("real semantic text", new Date("2026-06-22T00:00:00.000Z"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: "real semantic text" });
    expect(generated.method).toBe("llamacpp-embedding");
    expect(generated.embedding).toHaveLength(dims);
    expect(generated.metadata).toMatchObject({
      provider: "llamacpp",
      modelId: "nomic-embed-text",
      dimensions: dims,
      version: "goatcitadel-embedding-v1",
    });
    expect(generated.metadata.fallbackReason).toBeUndefined();
    expect(isEmbeddingCurrent(generated.embedding, generated.metadata)).toBe(true);
  });

  it("parses an OpenAI-compatible remote response and forwards the model + auth", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "text-embedding-3-small");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_API_KEY", "secret-token");
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ embedding: vector }] }));
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("remote semantic text");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(JSON.parse(String(init.body))).toEqual({ model: "text-embedding-3-small", input: "remote semantic text" });
    expect(generated.method).toBe("remote-embedding");
    expect(generated.metadata.provider).toBe("remote");
    expect(generated.embedding).toHaveLength(dims);
  });

  it("falls back to pseudo on a transport error without throwing", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const generated = await generateEmbedding("network down");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toContain("ECONNREFUSED");
  });

  it("falls back to pseudo on a non-2xx response", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );

    const generated = await generateEmbedding("server error");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.metadata.fallbackReason).toContain("embedding-http-503");
  });

  it("falls back to pseudo when the embeddings response exceeds the byte cap", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"padding":"' + "x".repeat(3 * 1024 * 1024) + '"}', { status: 200 })),
    );

    const generated = await generateEmbedding("hello");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.metadata.fallbackReason).toContain("response body exceeded");
    expect(generated.metadata.fallbackReason).not.toContain("fetchAllowlisted");
  });

  it("falls back to pseudo when the provider returns the wrong dimensionality", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embedding: [0.1, 0.2] })),
    );

    const generated = await generateEmbedding("wrong dims");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.metadata.fallbackReason).toContain("embedding-dimension-mismatch");
  });

  it("falls back to pseudo when the response vector is not numeric", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ embedding: ["nope"] }] })),
    );

    const generated = await generateEmbedding("bad vector");

    expect(generated.metadata.provider).toBe("pseudo");
  });

  it("falls back to pseudo (active config) when the URL is missing", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const generated = await generateEmbedding("no url configured");

    expect(generated.metadata.provider).toBe("pseudo");
    expect(generated.profile).toMatchObject({
      provider: "pseudo",
      status: "fallback",
      requestedProvider: "llamacpp",
      fallbackReason: "embedding-provider-unavailable: llamacpp",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps store and query embeddings dimensionally consistent under a real provider", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ embedding: vector }] })),
    );

    const stored = await generateEmbedding("a memory written at store time");
    const queried = await generateEmbedding("a query issued at retrieve time");

    expect(stored.embedding).toHaveLength(queried.embedding.length);
    expect(stored.embedding.length).toBe(currentEmbeddingProfile().dimensions);
    expect(stored.metadata.provider).toBe(queried.metadata.provider);
    expect(stored.metadata.dimensions).toBe(queried.metadata.dimensions);
  });
});

describe("local embeddings canonical usage accounting seam", () => {
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  function configureRemote(): void {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "embed-requested");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_API_KEY", "secret-token");
  }

  function configureLocal(): void {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_MODEL", "nomic-embed-text");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
  }

  function createAccountingHarness(input?: {
    sequence?: string[];
    acceptError?: Error;
    succeedError?: Error;
    failError?: Error;
    cancelError?: Error;
    abandonError?: Error;
    markDispatchUnknownError?: Error;
  }): {
    prepare: ReturnType<typeof vi.fn<(request: EmbeddingUsageDispatchInput) => EmbeddingUsageDispatchReservation>>;
    reservation: EmbeddingUsageDispatchReservation;
    attempt: EmbeddingUsageAttempt;
  } {
    const sequence = input?.sequence;
    const attempt: EmbeddingUsageAttempt = {
      eventId: "usage-event-1",
      observe: vi.fn(() => sequence?.push("observe")),
      observeNormalized: vi.fn(() => sequence?.push("observe-normalized")),
      succeed: vi.fn(() => {
        sequence?.push("succeed");
        if (input?.succeedError) throw input.succeedError;
        return { eventId: "usage-event-1" };
      }),
      fail: vi.fn(() => {
        sequence?.push("fail");
        if (input?.failError) throw input.failError;
        return { eventId: "usage-event-1" };
      }),
      cancel: vi.fn(() => {
        sequence?.push("cancel");
        if (input?.cancelError) throw input.cancelError;
        return { eventId: "usage-event-1" };
      }),
    };
    const reservation: EmbeddingUsageDispatchReservation = {
      eventId: "usage-event-1",
      accept: vi.fn(() => {
        sequence?.push("accept");
        if (input?.acceptError) throw input.acceptError;
        return attempt;
      }),
      abandon: vi.fn(() => {
        sequence?.push("abandon");
        if (input?.abandonError) throw input.abandonError;
      }),
      markDispatchUnknown: vi.fn(() => {
        sequence?.push("dispatch-unknown");
        if (input?.markDispatchUnknownError) throw input.markDispatchUnknownError;
      }),
    };
    const prepare = vi.fn((_request: EmbeddingUsageDispatchInput) => {
      sequence?.push("prepare");
      return reservation;
    });
    return { prepare, reservation, attempt };
  }

  it("reserves before fetch, accepts the returned promise, and exposes the terminal usage event", async () => {
    configureRemote();
    const sequence: string[] = [];
    const harness = createAccountingHarness({ sequence });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        sequence.push("fetch");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: vector }],
              model: "embed-effective",
              usage: { prompt_tokens: 11, total_tokens: 11 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );

    const generated = await generateEmbedding("accounted embedding", undefined, undefined, {
      purpose: "embedding_query",
      modelUsageAttribution: {
        operationId: "embedding-op-1",
        dispatchGeneration: "generation-1",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        turnId: "turn-a",
      },
      prepareModelUsageDispatch: harness.prepare,
    });

    expect(sequence).toEqual(["prepare", "fetch", "accept", "observe", "observe-normalized", "succeed"]);
    expect(generated.modelUsageEventIds).toEqual(["usage-event-1"]);
    expect(harness.attempt.observe).toHaveBeenCalledWith({ prompt_tokens: 11, total_tokens: 11 });
    expect(harness.attempt.observeNormalized).toHaveBeenCalledWith({ effectiveModelId: "embed-effective" });
    expect(harness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "embedding_runtime",
        requestedProviderId: "remote",
        requestedModelId: "embed-requested",
        effectiveProviderId: "remote",
        effectiveModelId: "embed-requested",
        effectiveApiStyle: "openai_embeddings",
        transportAttemptIndex: 0,
        credential: {
          credentialType: "api_key",
          usagePool: "standard",
          credentialSource: "env",
        },
        attribution: expect.objectContaining({
          operationId: "embedding-op-1",
          callKind: "embedding",
          utilityKind: "embedding_query",
        }),
      }),
    );
  });

  it("fails closed before fetch instead of returning pseudo when a stable embedding dispatch identity is replayed", async () => {
    configureRemote();
    const harness = createAccountingHarness();
    const duplicate = Object.assign(
      new Error("Provider dispatch identity already exists (succeeded); advance dispatchGeneration before re-dispatch"),
      {
        name: "ModelUsageDispatchUncertainError",
        eventId: "usage-event-1",
      },
    );
    harness.prepare.mockReturnValueOnce(harness.reservation).mockImplementationOnce(() => {
      throw duplicate;
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const stableRuntime = {
      purpose: "embedding_query" as const,
      modelUsageAttribution: {
        operationId: "stable-embedding-operation",
        dispatchGeneration: "stable-embedding-operation:generation-1",
      },
      prepareModelUsageDispatch: harness.prepare,
    };

    const first = await generateEmbedding("stable embedding replay", undefined, undefined, stableRuntime);
    expect(first.method).toBe("remote-embedding");

    await expect(
      generateEmbedding("stable embedding replay", undefined, undefined, stableRuntime),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: duplicate,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.prepare).toHaveBeenCalledTimes(2);
  });

  it("abandons a pre-fetch intent when fetch throws synchronously", async () => {
    configureRemote();
    const harness = createAccountingHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("synchronous fetch construction failure");
      }),
    );

    const generated = await generateEmbedding("sync throw", undefined, undefined, {
      purpose: "embedding_query",
      prepareModelUsageDispatch: harness.prepare,
    });

    expect(generated.method).toBe("pseudo-embedding");
    expect(harness.reservation.abandon).toHaveBeenCalledTimes(1);
    expect(harness.reservation.accept).not.toHaveBeenCalled();
    expect(harness.attempt.fail).not.toHaveBeenCalled();
  });

  it("fails closed when a pre-fetch intent cannot be abandoned", async () => {
    configureRemote();
    const persistenceError = new Error("intent abandon persistence failed");
    const harness = createAccountingHarness({ abandonError: persistenceError });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("synchronous fetch construction failure");
      }),
    );

    await expect(
      generateEmbedding("abandon settlement", undefined, undefined, {
        purpose: "embedding_query",
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: persistenceError,
    });
    expect(harness.reservation.abandon).toHaveBeenCalledTimes(1);
    expect(harness.reservation.accept).not.toHaveBeenCalled();
  });

  it("accepts a returned rejected promise, fails it once, and never accounts the pseudo fallback", async () => {
    configureRemote();
    const harness = createAccountingHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNRESET"))),
    );

    const generated = await generateEmbedding("async reject", undefined, undefined, {
      purpose: "embedding_repair",
      prepareModelUsageDispatch: harness.prepare,
    });

    expect(generated.method).toBe("pseudo-embedding");
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.reservation.accept).toHaveBeenCalledTimes(1);
    expect(harness.attempt.fail).toHaveBeenCalledTimes(1);
    expect(harness.attempt.succeed).not.toHaveBeenCalled();
    expect(generated.modelUsageEventIds).toBeUndefined();
  });

  it("fails closed when an accepted provider failure cannot persist its terminal settlement", async () => {
    configureRemote();
    const persistenceError = new Error("failed-attempt persistence failed");
    const harness = createAccountingHarness({ failError: persistenceError });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNRESET"))),
    );

    await expect(
      generateEmbedding("failed settlement", undefined, undefined, {
        purpose: "embedding_repair",
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: persistenceError,
    });
    expect(harness.attempt.fail).toHaveBeenCalledTimes(1);
  });

  it("marks an already-dispatched request uncertain and fails closed when durable acceptance fails", async () => {
    configureRemote();
    const acceptError = new Error("accept persistence failed");
    const harness = createAccountingHarness({ acceptError });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    await expect(
      generateEmbedding("uncertain dispatch", undefined, undefined, {
        purpose: "embedding_index",
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: acceptError,
    });
    expect(harness.reservation.markDispatchUnknown).toHaveBeenCalledWith(
      "embedding_transport_acceptance_persistence_failed",
    );
    expect(harness.attempt.fail).not.toHaveBeenCalled();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });

  it("fails closed when uncertain-dispatch ownership cannot be persisted", async () => {
    configureRemote();
    const persistenceError = new Error("dispatch-unknown persistence failed");
    const harness = createAccountingHarness({
      acceptError: new Error("accept persistence failed"),
      markDispatchUnknownError: persistenceError,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    await expect(
      generateEmbedding("uncertain settlement", undefined, undefined, {
        purpose: "embedding_index",
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: persistenceError,
    });
    expect(harness.reservation.markDispatchUnknown).toHaveBeenCalledTimes(1);
  });

  it("cancels the accepted attempt when the caller aborts an in-flight POST", async () => {
    configureRemote();
    const controller = new AbortController();
    const reason = new Error("operator cancelled embedding usage");
    const harness = createAccountingHarness();
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            notifyFetchStarted?.();
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    const generated = generateEmbedding("cancel accounted POST", undefined, undefined, {
      purpose: "embedding_query",
      signal: controller.signal,
      prepareModelUsageDispatch: harness.prepare,
    });
    await fetchStarted;
    controller.abort(reason);

    await expect(generated).rejects.toBe(reason);
    expect(harness.reservation.accept).toHaveBeenCalledTimes(1);
    expect(harness.attempt.cancel).toHaveBeenCalledWith(reason);
    expect(harness.attempt.fail).not.toHaveBeenCalled();
    expect(harness.attempt.succeed).not.toHaveBeenCalled();
  });

  it("fails closed when cancellation settlement cannot be persisted", async () => {
    configureRemote();
    const controller = new AbortController();
    const persistenceError = new Error("cancellation persistence failed");
    const harness = createAccountingHarness({ cancelError: persistenceError });
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            notifyFetchStarted?.();
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    const generated = generateEmbedding("cancel settlement", undefined, undefined, {
      purpose: "embedding_query",
      signal: controller.signal,
      prepareModelUsageDispatch: harness.prepare,
    });
    await fetchStarted;
    controller.abort(new Error("operator cancelled embedding usage"));

    await expect(generated).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      cause: persistenceError,
    });
    expect(harness.attempt.cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed and leaves recovery ownership intact when terminal persistence fails", async () => {
    configureRemote();
    const persistenceError = new Error("finalizeAndProject persistence failed");
    const harness = createAccountingHarness({ succeedError: persistenceError });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      generateEmbedding("terminal persistence fault", undefined, undefined, {
        purpose: "embedding_query",
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingUsageSettlementError",
      message: "Embedding usage accounting persistence failed",
      cause: persistenceError,
    });
    expect(harness.attempt.succeed).toHaveBeenCalledTimes(1);
    expect(harness.attempt.fail).not.toHaveBeenCalled();
    expect(harness.attempt.cancel).not.toHaveBeenCalled();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });

  it("rechecks caller cancellation after body observation and before terminal success", async () => {
    configureRemote();
    const controller = new AbortController();
    const reason = new Error("cancelled after response body");
    const harness = createAccountingHarness();
    vi.mocked(harness.attempt.observe).mockImplementationOnce(() => controller.abort(reason));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: vector }], usage: { prompt_tokens: 2 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      generateEmbedding("late cancellation", undefined, undefined, {
        purpose: "embedding_query",
        signal: controller.signal,
        prepareModelUsageDispatch: harness.prepare,
      }),
    ).rejects.toBe(reason);
    expect(harness.attempt.cancel).toHaveBeenCalledWith(reason);
    expect(harness.attempt.succeed).not.toHaveBeenCalled();
    expect(harness.attempt.fail).not.toHaveBeenCalled();
  });

  it("records response validation failure after observing usage and does not account pseudo fallback", async () => {
    configureRemote();
    const harness = createAccountingHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const generated = await generateEmbedding("bad dimensions", undefined, undefined, {
      purpose: "memory_write",
      prepareModelUsageDispatch: harness.prepare,
    });

    expect(generated.method).toBe("pseudo-embedding");
    expect(harness.attempt.observe).toHaveBeenCalledWith({ prompt_tokens: 3 });
    expect(harness.attempt.fail).toHaveBeenCalledTimes(1);
    expect(harness.attempt.succeed).not.toHaveBeenCalled();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });

  it("supplies frozen exact-zero pricing for a local POST and never invokes accounting for pseudo", async () => {
    configureLocal();
    const localHarness = createAccountingHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embedding: vector }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await generateEmbedding("local zero", undefined, undefined, {
      purpose: "embedding_index",
      prepareModelUsageDispatch: localHarness.prepare,
    });

    expect(localHarness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveProviderId: "llamacpp",
        credential: { credentialType: "unknown", usagePool: "local", credentialSource: "none" },
        pricing: {
          catalogVersion: "goatcitadel-local-embedding-zero-v1",
          catalogHash: "6b36ae888f77a29b1bb877cbfad5abbe9b0b19490164945f405da1e32aca2e56",
          inputRateUsdPerMillion: 0,
          outputRateUsdPerMillion: 0,
          cachedInputRateUsdPerMillion: 0,
        },
      }),
    );

    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
    const pseudoHarness = createAccountingHarness();
    const pseudo = await generateEmbedding("pseudo floor", undefined, undefined, {
      purpose: "embedding_query",
      prepareModelUsageDispatch: pseudoHarness.prepare,
    });
    expect(pseudo.method).toBe("pseudo-embedding");
    expect(pseudoHarness.prepare).not.toHaveBeenCalled();
  });
});

describe("local embeddings runtime leases", () => {
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  function configureLlamaCpp(): void {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("holds a llama.cpp lease through response validation and releases it on success", async () => {
    configureLlamaCpp();
    const signal = new AbortController().signal;
    const release = vi.fn();
    const acquireLocalServiceLease = vi.fn(async () => ({ release }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embedding: vector })),
    );

    const generated = await generateEmbedding("leased embedding", undefined, undefined, {
      purpose: "embedding_query",
      signal,
      acquireLocalServiceLease,
    });

    expect(generated.method).toBe("llamacpp-embedding");
    expect(acquireLocalServiceLease).toHaveBeenCalledWith({
      providerId: "llamacpp",
      url: "http://127.0.0.1:8080/embedding",
      purpose: "embedding_query",
      signal,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "transport failure",
      fetchResult: async () => {
        throw new Error("ECONNRESET");
      },
      fallbackReason: "ECONNRESET",
    },
    {
      name: "dimension mismatch",
      fetchResult: async () => jsonResponse({ embedding: [0.1, 0.2] }),
      fallbackReason: "embedding-dimension-mismatch",
    },
    {
      name: "malformed vector",
      fetchResult: async () => jsonResponse({ embedding: ["not-a-number"] }),
      fallbackReason: "embedding-invalid-vector",
    },
  ])("releases a llama.cpp lease after $name", async ({ fetchResult, fallbackReason }) => {
    configureLlamaCpp();
    const release = vi.fn();
    vi.stubGlobal("fetch", vi.fn(fetchResult));

    const generated = await generateEmbedding("failed leased embedding", undefined, undefined, {
      purpose: "embedding_index",
      acquireLocalServiceLease: async () => ({ release }),
    });

    expect(generated.method).toBe("pseudo-embedding");
    expect(generated.metadata.fallbackReason).toContain(fallbackReason);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("propagates caller cancellation and releases the active llama.cpp lease", async () => {
    configureLlamaCpp();
    const controller = new AbortController();
    const reason = new Error("operator cancelled embedding");
    const release = vi.fn();
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise<Response>((_resolve, reject) => {
            notifyFetchStarted?.();
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    const generated = generateEmbedding("cancelled leased embedding", undefined, undefined, {
      purpose: "document_ingest",
      signal: controller.signal,
      acquireLocalServiceLease: async () => ({ release }),
    });
    await fetchStarted;
    controller.abort(reason);

    await expect(generated).rejects.toBe(reason);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the runtime config-generation fence rejects lease acquisition", async () => {
    configureLlamaCpp();
    const conflict = new ConflictError({ message: "runtime owners are reconciling" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      generateEmbedding("fenced embedding", undefined, undefined, {
        purpose: "embedding_query",
        acquireLocalServiceLease: async () => Promise.reject(conflict),
      }),
    ).rejects.toBe(conflict);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never acquires a local lease for pseudo or remote providers", async () => {
    const acquireLocalServiceLease = vi.fn(async () => ({ release: vi.fn() }));

    await generateEmbedding("pseudo embedding", undefined, undefined, {
      purpose: "memory_write",
      acquireLocalServiceLease,
    });

    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://api.example.com/v1/embeddings");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ embedding: vector }] })),
    );
    const remote = await generateEmbedding("remote embedding", undefined, undefined, {
      purpose: "embedding_query",
      acquireLocalServiceLease,
    });

    expect(remote.method).toBe("remote-embedding");
    expect(acquireLocalServiceLease).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { acquireBoundLlamaCppEmbeddingLease, acquireBoundLlamaCppLease } from "./llama-cpp-provider-lease.js";

describe("acquireBoundLlamaCppLease", () => {
  it("acquires only the exactly configured provider endpoint and forwards cancellation", async () => {
    const controller = new AbortController();
    const handle = { release: vi.fn(async () => undefined) };
    const acquireLease = vi.fn(async () => handle);

    await expect(
      acquireBoundLlamaCppLease({
        request: {
          providerId: "llamacpp",
          baseUrl: "HTTP://127.0.0.1:8080/v1/",
          purpose: "chat_completion",
          signal: controller.signal,
        },
        configuredBaseUrl: "http://127.0.0.1:8080",
        runtime: { acquireLease } as never,
      }),
    ).resolves.toBe(handle);

    expect(acquireLease).toHaveBeenCalledWith({ purpose: "chat_completion" }, { signal: controller.signal });
  });

  it.each([
    ["other provider", "openai-compatible", "http://127.0.0.1:8080/v1"],
    ["different port", "llamacpp", "http://127.0.0.1:8081/v1"],
    ["different path", "llamacpp", "http://127.0.0.1:8080/private/v1"],
    ["embedded credentials", "llamacpp", "http://user:pass@127.0.0.1:8080/v1"],
    ["query variant", "llamacpp", "http://127.0.0.1:8080/v1?target=other"],
  ])("rejects %s without creating process demand", async (_label, providerId, baseUrl) => {
    const acquireLease = vi.fn();

    await expect(
      acquireBoundLlamaCppLease({
        request: { providerId, baseUrl, purpose: "model_discovery" },
        configuredBaseUrl: "http://127.0.0.1:8080/v1",
        runtime: { acquireLease } as never,
      }),
    ).resolves.toBeUndefined();

    expect(acquireLease).not.toHaveBeenCalled();
  });
});

describe("acquireBoundLlamaCppEmbeddingLease", () => {
  it.each(["/embedding", "/v1/embeddings"])("acquires a configured-origin %s transport", async (pathname) => {
    const controller = new AbortController();
    const handle = { release: vi.fn(async () => undefined) };
    const acquireLease = vi.fn(async () => handle);

    await expect(
      acquireBoundLlamaCppEmbeddingLease({
        request: {
          providerId: "llamacpp",
          url: `http://127.0.0.1:8080${pathname}`,
          purpose: "embedding_query",
          signal: controller.signal,
        },
        configuredBaseUrl: "http://127.0.0.1:8080/v1",
        runtime: { acquireLease } as never,
      }),
    ).resolves.toBe(handle);

    expect(acquireLease).toHaveBeenCalledWith({ purpose: "embedding_query" }, { signal: controller.signal });
  });

  it.each([
    ["different provider", "openai", "http://127.0.0.1:8080/embedding"],
    ["different origin", "llamacpp", "http://127.0.0.1:8081/embedding"],
    ["unknown path", "llamacpp", "http://127.0.0.1:8080/completions"],
    ["credentials", "llamacpp", "http://user:pass@127.0.0.1:8080/embedding"],
    ["query", "llamacpp", "http://127.0.0.1:8080/embedding?target=other"],
  ])("rejects %s without creating demand", async (_label, providerId, url) => {
    const acquireLease = vi.fn();

    await expect(
      acquireBoundLlamaCppEmbeddingLease({
        request: { providerId, url, purpose: "memory_write" },
        configuredBaseUrl: "http://127.0.0.1:8080/v1",
        runtime: { acquireLease } as never,
      }),
    ).resolves.toBeUndefined();

    expect(acquireLease).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";

function buildConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai",
    activeModel: "m1",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com",
        apiStyle: "openai-chat-completions",
        authMode: "bearer",
        defaultModel: "m1",
        apiKey: "sk-test",
      },
    ],
  };
}

function buildService(options: { modelCatalogCachePath?: string } = {}): LlmService {
  return new LlmService(buildConfig(), process.env, {
    networkAllowlist: ["api.openai.com"],
    enforceNetworkAllowlist: false,
    secretStore: createNoopSecretStore(),
    modelCatalogCachePath: options.modelCatalogCachePath,
  });
}

describe("LlmService model catalog cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches live results within TTL window — no second fetch", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = buildService();

    const a = await svc.listModels("openai");
    const b = await svc.listModels("openai");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches empty/template-fallback results so we don't hammer plugin metadata", async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = buildService();

    await svc.listModels("openai");
    await svc.listModels("openai");
    await svc.listModels("openai");

    expect(fetchCount).toBe(1);
  });

  it("config update invalidates the cache (next call fetches fresh)", async () => {
    let count = 0;
    const fetchMock = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify({ data: [{ id: `m${count}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = buildService();

    await svc.listModels("openai");
    svc.updateRuntimeConfig({ activeProviderId: "openai", activeModel: "m1" });
    await svc.listModels("openai");

    expect(count).toBe(2);
  });

  it("does NOT cache error_fallback results — transient errors retry", async () => {
    let count = 0;
    const fetchMock = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify({ error: "service unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = buildService();

    const a = await svc.listModelsWithSource("openai");
    const b = await svc.listModelsWithSource("openai");

    expect(a.source).toBe("error_fallback");
    expect(b.source).toBe("error_fallback");
    // Both calls should hit the network — error_fallback must not be cached.
    expect(count).toBe(2);
  });

  it("dedupes concurrent cold-cache requests — single fetch for parallel callers", async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount += 1;
      // Simulate slow upstream so both callers race the same in-flight.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = buildService();

    const [a, b, c] = await Promise.all([svc.listModels("openai"), svc.listModels("openai"), svc.listModels("openai")]);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fetchCount).toBe(1);
  });

  it("serves a stale disk catalog immediately and refreshes in the background", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-model-cache-"));
    const cachePath = path.join(tempDir, "llm-model-catalog.json");
    await fs.writeFile(
      cachePath,
      JSON.stringify(
        {
          version: 1,
          snapshots: [
            {
              snapshotId: "model-catalog-openai-cached",
              providerId: "openai",
              baseUrl: "https://api.openai.com/v1",
              createdAt: "2026-06-19T00:00:00.000Z",
              cachedAt: "2026-06-19T00:00:00.000Z",
              source: "live",
              status: "stale",
              items: [{ id: "cached-startup-model" }],
              itemCount: 1,
              catalogHash: "cached-hash",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    let releaseFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = buildService({ modelCatalogCachePath: cachePath });

    const result = await Promise.race([
      svc.listModelsWithSource("openai"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("model catalog call blocked on remote hydration")), 30),
      ),
    ]);

    expect(result.items.map((item) => item.id)).toEqual(["cached-startup-model"]);
    expect(result.warning).toContain("local model catalog cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFetch(
      new Response(JSON.stringify({ data: [{ id: "live-refresh-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await vi.waitFor(async () => {
      const persisted = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
        snapshots: Array<{ items: Array<{ id: string }>; catalogHash?: string }>;
      };
      expect(persisted.snapshots[0]?.items.map((item) => item.id)).toEqual(["live-refresh-model"]);
      expect(persisted.snapshots[0]?.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("persists live catalog snapshots without provider secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-model-cache-live-"));
    const cachePath = path.join(tempDir, "llm-model-catalog.json");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = buildService({ modelCatalogCachePath: cachePath });

    await svc.listModelsWithSource("openai");

    const persisted = await fs.readFile(cachePath, "utf8");
    expect(persisted).toContain("m1");
    expect(persisted).toContain("catalogHash");
    expect(persisted).not.toContain("sk-test");
    expect(persisted).not.toContain("Authorization");
  });
});

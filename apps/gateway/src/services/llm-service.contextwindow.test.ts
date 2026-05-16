import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmConfigFile, LlmModelRecord } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

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

function writeManifest(
  dir: string,
  entries: Record<string, { contextWindow: number; outputTokenLimit: number; thinking?: "off" | "auto" }>,
): string {
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ version: 1, entries }));
  return path;
}

function buildAnthropicConfig(): LlmConfigFile {
  return {
    activeProviderId: "anthropic",
    activeModel: "claude-opus-4-7",
    providers: [
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-opus-4-7",
      },
    ],
  };
}

describe("LlmService model metadata decoration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llm-svc-meta-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("listModels decorates records with manifest contextWindow/outputTokenLimit", async () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const models = await service.listModels("anthropic");
    const opus = models.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.outputTokenLimit).toBe(32_000);
  });

  it("listModels preserves pre-existing record fields over manifest defaults", async () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const preExisting: LlmModelRecord = {
      id: "claude-opus-4-7",
      contextWindow: 500_000,
      outputTokenLimit: 16_000,
    };
    const enriched = (
      service as unknown as {
        enrichModelRecord(providerId: string, record: LlmModelRecord): LlmModelRecord;
      }
    ).enrichModelRecord("anthropic", preExisting);
    expect(enriched.contextWindow).toBe(500_000);
    expect(enriched.outputTokenLimit).toBe(16_000);
  });

  it("listModelsWithSource decorates items returned in the discovery result", async () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const result = await service.listModelsWithSource("anthropic");
    const opus = result.items.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.outputTokenLimit).toBe(32_000);
  });

  it("previewModels decorates items returned in the fallback branch", async () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const preview = await service.previewModels({
      providerId: "anthropic",
      baseUrl: "http://127.0.0.1:1/v1",
      apiStyle: "anthropic-messages",
    });
    const opus = preview.items.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.outputTokenLimit).toBe(32_000);
  });

  it("clampActiveModelSummaryReserve clamps requested tokens to the active model's outputTokenLimit", () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const result = service.clampActiveModelSummaryReserve(200_000);
    expect(result.value).toBe(32_000);
    expect(result.clamped).toBe(true);
    expect(result.warning).toBeDefined();
  });

  it("clampActiveModelSummaryReserve passes through when active model has no manifest entry", () => {
    const manifestPath = writeManifest(tmp, {
      "openai/gpt-5.4": { contextWindow: 400_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const result = service.clampActiveModelSummaryReserve(200_000);
    expect(result.value).toBe(200_000);
    expect(result.clamped).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("getRuntimeConfig surfaces active model contextWindow/outputTokenLimit at top level", () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const config = service.getRuntimeConfig();
    expect(config.activeModelContextWindow).toBe(1_000_000);
    expect(config.activeModelOutputTokenLimit).toBe(32_000);
  });

  it("getRuntimeConfig surfaces per-provider metadata for each provider's defaultModel", () => {
    const manifestPath = writeManifest(tmp, {
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
      "openai/gpt-5.4": { contextWindow: 400_000, outputTokenLimit: 16_000 },
    });
    const config: LlmConfigFile = {
      activeProviderId: "anthropic",
      activeModel: "claude-opus-4-7",
      providers: [
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-opus-4-7",
        },
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4",
        },
      ],
    };
    const service = new LlmService(config, process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const runtime = service.getRuntimeConfig();
    const anthropic = runtime.providers.find((p) => p.providerId === "anthropic");
    const openai = runtime.providers.find((p) => p.providerId === "openai");
    expect(anthropic?.activeModelContextWindow).toBe(1_000_000);
    expect(anthropic?.activeModelOutputTokenLimit).toBe(32_000);
    expect(openai?.activeModelContextWindow).toBe(400_000);
    expect(openai?.activeModelOutputTokenLimit).toBe(16_000);
  });

  it("getRuntimeConfig handles missing manifest entries gracefully", () => {
    const manifestPath = writeManifest(tmp, {});
    const service = new LlmService(buildAnthropicConfig(), process.env, {
      secretStore: createNoopSecretStore(),
      modelMetadataPath: manifestPath,
    });

    const config = service.getRuntimeConfig();
    expect(config.activeModelContextWindow).toBeUndefined();
    expect(config.activeModelOutputTokenLimit).toBeUndefined();
    const provider = config.providers.find((p) => p.providerId === "anthropic");
    expect(provider?.activeModelContextWindow).toBeUndefined();
    expect(provider?.activeModelOutputTokenLimit).toBeUndefined();
  });
});

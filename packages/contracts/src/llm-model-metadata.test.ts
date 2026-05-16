import { describe, it, expect, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { LlmModelMetadataEntry, LlmModelMetadataManifest } from "./llm-model-metadata.js";

describe("LlmModelMetadataManifest", () => {
  it("manifest entry has contextWindow, outputTokenLimit, optional thinking", () => {
    const entry: LlmModelMetadataEntry = {
      contextWindow: 272_000,
      outputTokenLimit: 32_000,
    };
    expectTypeOf<LlmModelMetadataEntry>().toHaveProperty("contextWindow").toEqualTypeOf<number>();
    expectTypeOf<LlmModelMetadataEntry>().toHaveProperty("outputTokenLimit").toEqualTypeOf<number>();
    expectTypeOf<LlmModelMetadataEntry>().toHaveProperty("thinking").toEqualTypeOf<"off" | "auto" | undefined>();
    void entry;
  });

  it("manifest is a versioned record with pattern keys", () => {
    const manifest: LlmModelMetadataManifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272_000, outputTokenLimit: 32_000 },
        "xai/grok-4.3": { contextWindow: 1_000_000, outputTokenLimit: 32_000, thinking: "off" },
      },
    };
    expectTypeOf<LlmModelMetadataManifest>().toHaveProperty("version").toEqualTypeOf<number>();
    expectTypeOf<LlmModelMetadataManifest>()
      .toHaveProperty("entries")
      .toEqualTypeOf<Record<string, LlmModelMetadataEntry>>();
    void manifest;
  });
});

describe("shipped manifest at config/llm-model-metadata.json", () => {
  it("parses against LlmModelMetadataManifest and every entry is well-formed", () => {
    // Resolve repo root from this test file's location: packages/contracts/src/...
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const raw = readFileSync(join(repoRoot, "config", "llm-model-metadata.json"), "utf8");
    const parsed = JSON.parse(raw) as LlmModelMetadataManifest;
    expect(parsed.version).toBe(1);
    expect(typeof parsed.entries).toBe("object");
    for (const [key, entry] of Object.entries(parsed.entries)) {
      expect(entry.contextWindow, `${key} contextWindow`).toBeGreaterThan(0);
      expect(entry.outputTokenLimit, `${key} outputTokenLimit`).toBeGreaterThan(0);
      if (entry.thinking !== undefined) {
        expect(["off", "auto"]).toContain(entry.thinking);
      }
    }
  });

  it("includes the critical entries called out in the plan", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const raw = readFileSync(join(repoRoot, "config", "llm-model-metadata.json"), "utf8");
    const parsed = JSON.parse(raw) as LlmModelMetadataManifest;
    expect(parsed.entries["openai-codex/*"]).toEqual({ contextWindow: 272000, outputTokenLimit: 32000 });
    expect(parsed.entries["xai/grok-4.3"]).toEqual({
      contextWindow: 1000000,
      outputTokenLimit: 32000,
      thinking: "off",
    });
    expect(parsed.entries["openrouter/deepseek/deepseek-v4-pro"]).toEqual({
      contextWindow: 128000,
      outputTokenLimit: 32000,
    });
    expect(parsed.entries["anthropic/claude-opus-4-7"]).toEqual({ contextWindow: 1000000, outputTokenLimit: 32000 });
  });
});

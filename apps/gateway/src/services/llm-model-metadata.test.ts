import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlmModelMetadataManifest, lookupModelMetadata } from "./llm-model-metadata.js";

describe("LLM model metadata loader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llm-meta-"));
  });

  it("loads a manifest from disk", () => {
    const path = join(tmp, "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
        },
      }),
    );
    const result = loadLlmModelMetadataManifest(path);
    expect(result.manifest.version).toBe(1);
    expect(Object.keys(result.manifest.entries)).toContain("openai-codex/*");
    expect(result.errors).toEqual([]);
  });

  it("returns empty manifest + warning when file missing", () => {
    const result = loadLlmModelMetadataManifest(join(tmp, "missing.json"));
    expect(result.manifest.entries).toEqual({});
    expect(result.errors.length).toBe(1);
  });

  it("returns empty manifest + warning when JSON malformed", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, "{ not valid json");
    const result = loadLlmModelMetadataManifest(path);
    expect(result.manifest.entries).toEqual({});
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("returns empty manifest + warning when shape invalid", () => {
    const path = join(tmp, "wrong-shape.json");
    writeFileSync(path, JSON.stringify({ version: 1, entries: { x: { contextWindow: -5, outputTokenLimit: 32000 } } }));
    const result = loadLlmModelMetadataManifest(path);
    expect(result.manifest.entries).toEqual({});
    expect(result.errors.length).toBe(1);
  });
});

describe("lookupModelMetadata", () => {
  it("looks up exact provider+model match before wildcard", () => {
    const manifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
        "openai-codex/gpt-5.5": { contextWindow: 272000, outputTokenLimit: 64000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openai-codex", "gpt-5.5");
    expect(entry).toEqual({ contextWindow: 272000, outputTokenLimit: 64000 });
  });

  it("falls back to provider wildcard when exact missing", () => {
    const manifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openai-codex", "gpt-5.5-codex-unknown");
    expect(entry).toEqual({ contextWindow: 272000, outputTokenLimit: 32000 });
  });

  it("returns undefined when no pattern matches", () => {
    const manifest = { version: 1, entries: {} };
    const entry = lookupModelMetadata(manifest, "unknown", "model");
    expect(entry).toBeUndefined();
  });

  it("matches nested model ids like openrouter/deepseek/deepseek-v4-pro", () => {
    const manifest = {
      version: 1,
      entries: {
        "openrouter/deepseek/deepseek-v4-pro": { contextWindow: 128000, outputTokenLimit: 32000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openrouter", "deepseek/deepseek-v4-pro");
    expect(entry).toEqual({ contextWindow: 128000, outputTokenLimit: 32000 });
  });
});

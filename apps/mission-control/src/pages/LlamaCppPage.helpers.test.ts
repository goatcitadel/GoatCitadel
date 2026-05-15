import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendOptionalFlag,
  appendOptionalFlashAttention,
  baseUrlToHost,
  baseUrlToPort,
  canLoadModels,
  createEmptyStatus,
  ensureReasoningDefault,
  formatExtraArgs,
  formatGiB,
  formatProgress,
  hasReasoningOverride,
  isAbortError,
  parseExtraArgs,
  parseOptionalNumberForPatch,
  quoteSegment,
  readRecentLlamaCppDownloads,
  readSavedLlamaCppProfiles,
  toOptionalString,
  upsertFlagValue,
  upsertRecentLlamaCppDownload,
  writeRecentLlamaCppDownloads,
  writeSavedLlamaCppProfiles,
} from "./LlamaCppPage";

describe("LlamaCppPage helper behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("normalizes numeric and argument input fields", () => {
    expect(parseOptionalNumberForPatch("")).toBeNull();
    expect(parseOptionalNumberForPatch(" 2048 ")).toBe(2048);
    expect(parseOptionalNumberForPatch("bad")).toBeNull();
    expect(toOptionalString(undefined)).toBe("");
    expect(toOptionalString(8)).toBe("8");
    expect(parseExtraArgs(" --ctx-size 8192 \n\n --temp 0.2 ")).toEqual(["--ctx-size 8192", "--temp 0.2"]);
    expect(formatExtraArgs(["--a", "--b"])).toBe("--a\n--b");
    expect(upsertFlagValue(["--port", "8080", "--threads", "8"], "--port", "18080")).toEqual([
      "--threads",
      "8",
      "--port",
      "18080",
    ]);
    expect(appendOptionalFlag("--model", " model.gguf ")).toEqual(["--model", "model.gguf"]);
    expect(appendOptionalFlag("--model", " ")).toEqual([]);
    expect(appendOptionalFlashAttention("auto")).toEqual([]);
    expect(appendOptionalFlashAttention("on")).toEqual(["--flash-attn", "on"]);
  });

  it("manages reasoning defaults, command quoting, and base URL parsing", () => {
    expect(hasReasoningOverride(["--reasoning", "off"])).toBe(true);
    expect(hasReasoningOverride(["-rea", "off"])).toBe(true);
    expect(hasReasoningOverride(["--ctx-size", "4096"])).toBe(false);
    expect(ensureReasoningDefault(["--ctx-size", "4096"])).toEqual(["--ctx-size", "4096", "--reasoning", "off"]);
    expect(ensureReasoningDefault(["--reasoning", "on"])).toEqual(["--reasoning", "on"]);
    expect(quoteSegment("C:\\models\\gemma.gguf")).toBe("C:\\models\\gemma.gguf");
    expect(quoteSegment("C:\\model files\\gemma.gguf")).toBe('"C:\\model files\\gemma.gguf"');
    expect(baseUrlToHost("http://127.0.0.1:8080/v1")).toBe("127.0.0.1");
    expect(baseUrlToHost("bad url")).toBe("127.0.0.1");
    expect(baseUrlToPort("https://example.test/v1")).toBe("443");
    expect(baseUrlToPort("http://example.test/v1")).toBe("80");
    expect(baseUrlToPort("bad url")).toBe("8080");
  });

  it("formats status and download progress labels", () => {
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(canLoadModels(null)).toBe(false);
    expect(canLoadModels({ healthy: false } as any)).toBe(false);
    expect(canLoadModels({ healthy: true } as any)).toBe(true);
    expect(createEmptyStatus("http://127.0.0.1:8080/v1")).toMatchObject({
      enabled: false,
      desiredState: "stopped",
      processState: "stopped",
      baseUrl: "http://127.0.0.1:8080/v1",
      healthy: false,
      updatedAt: "2026-05-14T12:00:00.000Z",
    });
    expect(formatGiB(1024 ** 3)).toBe("1.00");
    expect(formatProgress(1024 ** 3)).toBe("1.00 GiB downloaded");
    expect(formatProgress(5 * 1024 ** 3, 10 * 1024 ** 3)).toBe("50% (5.00 / 10.00 GiB)");
    expect(formatProgress(20 * 1024 ** 3, 10 * 1024 ** 3)).toBe("100% (20.00 / 10.00 GiB)");
  });

  it("reads and writes saved profiles and recent downloads defensively", () => {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    };
    vi.stubGlobal("window", { localStorage });

    expect(readSavedLlamaCppProfiles()).toEqual({});
    writeSavedLlamaCppProfiles({
      "text-default": {
        savedAt: "2026-05-14T12:00:00.000Z",
        enabled: true,
        autoStart: true,
        baseUrl: "http://127.0.0.1:18080/v1",
        command: "llama-server",
        modelsRootPath: "C:\\models",
        modelPath: "C:\\models\\gemma.gguf",
        alias: "gemma",
        extraArgsText: "--ctx-size 8192",
        ctxSize: "8192",
        threads: "8",
        gpuLayers: "32",
        parallel: "2",
        batchSize: "512",
        ubatchSize: "128",
        flashAttentionMode: "on",
      },
    } as any);
    expect(readSavedLlamaCppProfiles()["text-default"]?.alias).toBe("gemma");

    store.set("goatcitadel.llamacpp.saved-profiles.v1", JSON.stringify({ "text-long": { alias: "cpu-model" } }));
    expect(readSavedLlamaCppProfiles()["text-long"]).toMatchObject({
      alias: "cpu-model",
      enabled: false,
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080/v1",
      command: "llama-server",
      flashAttentionMode: "auto",
    });
    store.set("goatcitadel.llamacpp.saved-profiles.v1", "null");
    expect(readSavedLlamaCppProfiles()).toEqual({});
    store.set("goatcitadel.llamacpp.saved-profiles.v1", "{bad");
    expect(readSavedLlamaCppProfiles()).toEqual({});

    expect(readRecentLlamaCppDownloads()).toEqual([]);
    writeRecentLlamaCppDownloads([{ modelPath: "one.gguf", mmprojPath: "", savedAt: "now" }] as any);
    expect(readRecentLlamaCppDownloads()).toEqual([{ modelPath: "one.gguf", mmprojPath: "", savedAt: "now" }]);
    store.set("goatcitadel.llamacpp.download-history.v1", JSON.stringify({ not: "array" }));
    expect(readRecentLlamaCppDownloads()).toEqual([]);
    store.set("goatcitadel.llamacpp.download-history.v1", "{bad");
    expect(readRecentLlamaCppDownloads()).toEqual([]);
  });

  it("treats missing browser storage as empty persisted llama.cpp state", () => {
    vi.stubGlobal("window", {});

    expect(readSavedLlamaCppProfiles()).toEqual({});
    expect(readRecentLlamaCppDownloads()).toEqual([]);
    expect(() => writeSavedLlamaCppProfiles({})).not.toThrow();
    expect(() => writeRecentLlamaCppDownloads([])).not.toThrow();
  });

  it("ignores null saved profile payloads while normalizing valid presets", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      },
    });
    store.set(
      "goatcitadel.llamacpp.saved-profiles.v1",
      JSON.stringify({
        "text-default": null,
        multimodal: {
          savedAt: "2026-05-14T12:00:00.000Z",
          alias: "vision-model",
          flashAttentionMode: "off",
        },
      }),
    );

    expect(readSavedLlamaCppProfiles()).toMatchObject({
      "text-default": undefined,
      multimodal: {
        alias: "vision-model",
        enabled: false,
        flashAttentionMode: "off",
      },
    });
  });

  it("deduplicates recent llama.cpp downloads and caps history", () => {
    const existing = Array.from({ length: 8 }, (_, index) => ({
      modelPath: `model-${index}.gguf`,
      mmprojPath: index === 1 ? "vision.gguf" : "",
      savedAt: `time-${index}`,
    }));

    expect(
      upsertRecentLlamaCppDownload(
        existing as any,
        {
          modelPath: "model-1.gguf",
          mmprojPath: "vision.gguf",
          savedAt: "new-time",
        } as any,
      ),
    ).toEqual([
      { modelPath: "model-1.gguf", mmprojPath: "vision.gguf", savedAt: "new-time" },
      { modelPath: "model-0.gguf", mmprojPath: "", savedAt: "time-0" },
      { modelPath: "model-2.gguf", mmprojPath: "", savedAt: "time-2" },
      { modelPath: "model-3.gguf", mmprojPath: "", savedAt: "time-3" },
      { modelPath: "model-4.gguf", mmprojPath: "", savedAt: "time-4" },
      { modelPath: "model-5.gguf", mmprojPath: "", savedAt: "time-5" },
    ]);
  });
});

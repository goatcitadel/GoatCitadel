import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedVoicePlatform } from "./catalog.js";

const mockState = vi.hoisted(() => ({
  rootDir: "",
  platform: "windows-x64" as ManagedVoicePlatform | null,
  failDownloadFor: "",
  downloads: [] as Array<{ url: string; destinationPath: string; expectedSha256: string }>,
}));

vi.mock("./paths.js", async () => {
  const pathModule = await import("node:path");
  return {
    detectManagedVoicePlatform: vi.fn(() => mockState.platform),
    resolveGoatCitadelHome: vi.fn(() => mockState.rootDir),
    resolveVoiceRuntimePaths: vi.fn(() => {
      const voiceDir = pathModule.join(mockState.rootDir, "tools", "voice");
      return {
        goatHome: mockState.rootDir,
        toolsDir: pathModule.join(mockState.rootDir, "tools"),
        voiceDir,
        whisperDir: pathModule.join(voiceDir, "whispercpp"),
        modelsDir: pathModule.join(voiceDir, "models"),
        ffmpegDir: pathModule.join(voiceDir, "ffmpeg"),
        manifestPath: pathModule.join(voiceDir, "manifest.json"),
      };
    }),
  };
});

vi.mock("./download.js", async () => {
  const fsModule = await import("node:fs/promises");
  const pathModule = await import("node:path");
  async function findFileRecursive(rootDir: string, fileName: string): Promise<string | null> {
    const entries = await fsModule.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = pathModule.join(rootDir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const nested = await findFileRecursive(fullPath, fileName);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  }

  return {
    createTempDir: vi.fn((prefix: string) => fsModule.mkdtemp(pathModule.join(mockState.rootDir, prefix))),
    downloadFile: vi.fn(async (url: string, destinationPath: string, expectedSha256: string) => {
      mockState.downloads.push({ url, destinationPath, expectedSha256 });
      if (mockState.failDownloadFor && url.includes(mockState.failDownloadFor)) {
        throw new Error(`download blocked for ${mockState.failDownloadFor}`);
      }
      await fsModule.mkdir(pathModule.dirname(destinationPath), { recursive: true });
      await fsModule.writeFile(destinationPath, `download:${url}`, "utf8");
    }),
    extractZip: vi.fn(async (_archivePath: string, destinationDir: string) => {
      const binaryPath = pathModule.join(destinationDir, "Release", "whisper-cli.exe");
      await fsModule.mkdir(pathModule.dirname(binaryPath), { recursive: true });
      await fsModule.writeFile(binaryPath, "whisper", "utf8");
    }),
    extractGzip: vi.fn(async (_archivePath: string, destinationPath: string) => {
      await fsModule.mkdir(pathModule.dirname(destinationPath), { recursive: true });
      await fsModule.writeFile(destinationPath, "ffmpeg", "utf8");
    }),
    extractTarGz: vi.fn(),
    findFileRecursive: vi.fn(findFileRecursive),
    runCommand: vi.fn(),
  };
});

import { DEFAULT_MANAGED_VOICE_MODEL_ID } from "./catalog.js";
import { installManagedVoiceRuntime } from "./installer.js";
import { readManagedVoiceManifest } from "./status.js";

describe("managed voice runtime install path", () => {
  beforeEach(async () => {
    mockState.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-voice-install-loop19-"));
    mockState.platform = "windows-x64";
    mockState.failDownloadFor = "";
    mockState.downloads = [];
  });

  afterEach(async () => {
    await fs.rm(mockState.rootDir, { recursive: true, force: true });
  });

  it("installs whisper, ffmpeg, and the selected model, then writes managed settings", async () => {
    const settings = createSettingsMock();

    const status = await installManagedVoiceRuntime(settings, { modelId: " tiny.en " });
    const manifest = await readManagedVoiceManifest();

    expect(mockState.downloads.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("whisper-bin-x64.zip"),
        expect.stringContaining("ffmpeg-win32-x64.gz"),
        expect.stringContaining("ggml-tiny.en.bin"),
      ]),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      selectedModelId: "tiny.en",
      whisper: {
        platform: "windows-x64",
        source: "download-binary",
      },
      ffmpeg: {
        source: "download-binary",
      },
      models: [expect.objectContaining({ modelId: "tiny.en" })],
    });
    expect(manifest?.lastError).toBeUndefined();
    expect(settings.set).toHaveBeenCalledWith("voice_runtime_config_v1", {
      selectedModelId: "tiny.en",
      mode: "managed",
    });
    expect(status).toMatchObject({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      selectedModelId: "tiny.en",
      binaryReady: true,
      ffmpegReady: true,
    });
  });

  it("preserves the previous active model when activate is false and records installer failures in the manifest", async () => {
    const settings = createSettingsMock();
    await installManagedVoiceRuntime(settings, { modelId: DEFAULT_MANAGED_VOICE_MODEL_ID });
    mockState.downloads = [];

    const inactiveInstall = await installManagedVoiceRuntime(settings, { modelId: "small.en", activate: false });
    expect(inactiveInstall.selectedModelId).toBe(DEFAULT_MANAGED_VOICE_MODEL_ID);
    expect(settings.set).toHaveBeenLastCalledWith("voice_runtime_config_v1", {
      selectedModelId: DEFAULT_MANAGED_VOICE_MODEL_ID,
      mode: "managed",
    });

    mockState.failDownloadFor = "ggml-tiny.bin";
    await expect(installManagedVoiceRuntime(settings, { modelId: "tiny" })).rejects.toThrow("download blocked");
    await expect(readManagedVoiceManifest()).resolves.toMatchObject({
      schemaVersion: 1,
      lastError: expect.stringContaining("download blocked for ggml-tiny.bin"),
      models: expect.arrayContaining([
        expect.objectContaining({ modelId: DEFAULT_MANAGED_VOICE_MODEL_ID }),
        expect.objectContaining({ modelId: "small.en" }),
      ]),
    });
  });

  it("rejects unsupported platforms and unknown managed model ids before download", async () => {
    mockState.platform = null;
    await expect(installManagedVoiceRuntime(undefined, { modelId: "base.en" })).rejects.toThrow(
      "Managed whisper.cpp install is not supported",
    );

    mockState.platform = "windows-x64";
    await expect(installManagedVoiceRuntime(undefined, { modelId: "missing-model" })).rejects.toThrow(
      "Unknown managed voice model: missing-model",
    );
    expect(mockState.downloads).toEqual([]);
  });
});

function createSettingsMock() {
  let value: { selectedModelId?: string; mode?: "managed" | "env_override" } = {};
  return {
    get: vi.fn(() => ({ value })),
    set: vi.fn((_key: string, next: typeof value) => {
      value = next;
    }),
  };
}

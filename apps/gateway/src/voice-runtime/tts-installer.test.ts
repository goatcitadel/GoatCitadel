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
        piperDir: pathModule.join(voiceDir, "piper"),
        ttsVoicesDir: pathModule.join(voiceDir, "tts-voices"),
        ttsManifestPath: pathModule.join(voiceDir, "tts-manifest.json"),
      };
    }),
  };
});

vi.mock("./download.js", async () => {
  const fsModule = await import("node:fs/promises");
  const pathModule = await import("node:path");
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
      const binaryPath = pathModule.join(destinationDir, "piper", "piper.exe");
      await fsModule.mkdir(pathModule.dirname(binaryPath), { recursive: true });
      await fsModule.writeFile(binaryPath, "piper", "utf8");
    }),
    extractTarGz: vi.fn(async (_archivePath: string, destinationDir: string) => {
      const binaryPath = pathModule.join(destinationDir, "piper", "piper");
      await fsModule.mkdir(pathModule.dirname(binaryPath), { recursive: true });
      await fsModule.writeFile(binaryPath, "piper", "utf8");
    }),
    extractGzip: vi.fn(),
    findFileRecursive: vi.fn(),
    runCommand: vi.fn(),
  };
});

import { DEFAULT_MANAGED_TTS_VOICE_ID, MANAGED_PIPER_RUNTIME_SOURCES, MANAGED_TTS_VOICES } from "./tts-catalog.js";
import { installManagedTtsRuntime } from "./tts-installer.js";
import { readManagedTtsManifest } from "./tts-status.js";

describe("managed piper tts install path", () => {
  beforeEach(async () => {
    mockState.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tts-install-"));
    mockState.platform = "windows-x64";
    mockState.failDownloadFor = "";
    mockState.downloads = [];
  });

  afterEach(async () => {
    await fs.rm(mockState.rootDir, { recursive: true, force: true });
  });

  it("installs the piper binary plus the default voice model and config with pinned digests", async () => {
    const status = await installManagedTtsRuntime();
    const manifest = await readManagedTtsManifest();

    const defaultVoice = MANAGED_TTS_VOICES.find((item) => item.id === DEFAULT_MANAGED_TTS_VOICE_ID);
    expect(mockState.downloads.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        MANAGED_PIPER_RUNTIME_SOURCES["windows-x64"].url,
        defaultVoice?.modelUrl,
        defaultVoice?.configUrl,
      ]),
    );
    // Every download request carried the catalog-pinned digest.
    for (const download of mockState.downloads) {
      expect(download.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      selectedVoiceId: DEFAULT_MANAGED_TTS_VOICE_ID,
      piper: {
        platform: "windows-x64",
      },
      voices: [expect.objectContaining({ voiceId: DEFAULT_MANAGED_TTS_VOICE_ID })],
    });
    expect(manifest?.lastError).toBeUndefined();
    expect(status).toMatchObject({
      provider: "piper",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      selectedVoiceId: DEFAULT_MANAGED_TTS_VOICE_ID,
    });
  });

  it("is idempotent: a second install skips re-downloading artifacts that are present", async () => {
    await installManagedTtsRuntime();
    mockState.downloads = [];

    const status = await installManagedTtsRuntime();
    expect(mockState.downloads).toEqual([]);
    expect(status.readiness).toBe("ready");
  });

  it("records installer failures in the manifest and rethrows", async () => {
    mockState.failDownloadFor = "en_US-lessac-medium.onnx";
    await expect(installManagedTtsRuntime()).rejects.toThrow("download blocked");
    await expect(readManagedTtsManifest()).resolves.toMatchObject({
      schemaVersion: 1,
      lastError: expect.stringContaining("download blocked"),
    });
  });

  it("rejects unsupported platforms and unknown voices before download", async () => {
    mockState.platform = null;
    await expect(installManagedTtsRuntime()).rejects.toThrow("Managed Piper TTS install is not supported");

    mockState.platform = "windows-x64";
    await expect(installManagedTtsRuntime({ voiceId: "missing-voice" })).rejects.toThrow(
      "Unknown managed TTS voice: missing-voice",
    );
    expect(mockState.downloads).toEqual([]);
  });
});

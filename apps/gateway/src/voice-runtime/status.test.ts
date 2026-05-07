import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SystemSettingsRepository } from "@goatcitadel/storage";
import {
  getManagedVoiceRuntimeStatus,
  setVoiceRuntimeConfig,
  writeManagedVoiceManifest,
  type ManagedVoiceManifest,
} from "./status.js";

const originalHome = process.env.GOATCITADEL_HOME;
const originalWhisperBin = process.env.GOATCITADEL_WHISPER_CPP_BIN;
const originalWhisperModel = process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
const originalFfmpegBin = process.env.GOATCITADEL_FFMPEG_BIN;

function createSystemSettingsMock(): Pick<SystemSettingsRepository, "get" | "set"> {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      if (!values.has(key)) {
        return undefined;
      }
      return {
        key,
        value: values.get(key) as T,
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
    },
    set<T>(key: string, value: T) {
      values.set(key, value);
      return {
        key,
        value,
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
    },
  };
}

describe("managed voice runtime status", () => {
  let tempHome = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-voice-status-"));
    process.env.GOATCITADEL_HOME = tempHome;
    delete process.env.GOATCITADEL_WHISPER_CPP_BIN;
    delete process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
    delete process.env.GOATCITADEL_FFMPEG_BIN;
  });

  afterEach(async () => {
    if (originalHome) {
      process.env.GOATCITADEL_HOME = originalHome;
    } else {
      delete process.env.GOATCITADEL_HOME;
    }
    if (originalWhisperBin) {
      process.env.GOATCITADEL_WHISPER_CPP_BIN = originalWhisperBin;
    } else {
      delete process.env.GOATCITADEL_WHISPER_CPP_BIN;
    }
    if (originalWhisperModel) {
      process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH = originalWhisperModel;
    } else {
      delete process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
    }
    if (originalFfmpegBin) {
      process.env.GOATCITADEL_FFMPEG_BIN = originalFfmpegBin;
    } else {
      delete process.env.GOATCITADEL_FFMPEG_BIN;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("treats an env-provided whisper wrapper as ready even without a separate model override", async () => {
    const wrapperPath = path.join(tempHome, "whisper-wrapper.cmd");
    await fs.writeFile(wrapperPath, "@echo off\r\n", "utf8");
    process.env.GOATCITADEL_WHISPER_CPP_BIN = wrapperPath;

    const status = await getManagedVoiceRuntimeStatus(createSystemSettingsMock());

    expect(status.source).toBe("env_override");
    expect(status.binaryReady).toBe(true);
    expect(status.readiness).toBe("ready");
  });

  it("reports a managed install with an active selected model as ready", async () => {
    const systemSettings = createSystemSettingsMock();
    const whisperBinary = path.join(
      tempHome,
      "tools",
      "voice",
      "whispercpp",
      "v1.8.3",
      "windows-x64",
      "Release",
      "whisper-cli.exe",
    );
    const ffmpegBinary = path.join(
      tempHome,
      "tools",
      "voice",
      "ffmpeg",
      "eugeneware_ffmpeg-static_b6.1.1",
      "windows-x64",
      "ffmpeg.exe",
    );
    const modelPath = path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin");
    await fs.mkdir(path.dirname(whisperBinary), { recursive: true });
    await fs.mkdir(path.dirname(ffmpegBinary), { recursive: true });
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(whisperBinary, "binary", "utf8");
    await fs.writeFile(ffmpegBinary, "binary", "utf8");
    await fs.writeFile(modelPath, "model", "utf8");

    const manifest: ManagedVoiceManifest = {
      schemaVersion: 1,
      whisper: {
        version: "v1.8.3",
        platform: "windows-x64",
        binaryPath: whisperBinary,
        installedAt: "2026-03-08T00:00:00.000Z",
        source: "download-binary",
      },
      ffmpeg: {
        version: "eugeneware/ffmpeg-static@b6.1.1",
        binaryPath: ffmpegBinary,
        installedAt: "2026-03-08T00:00:00.000Z",
        source: "download-binary",
      },
      models: [
        {
          modelId: "base.en",
          filePath: modelPath,
          sizeBytes: 123,
          sha256: "abc",
          installedAt: "2026-03-08T00:00:00.000Z",
        },
      ],
    };
    await writeManagedVoiceManifest(manifest);
    setVoiceRuntimeConfig(systemSettings, {
      selectedModelId: "base.en",
      mode: "managed",
    });

    const status = await getManagedVoiceRuntimeStatus(systemSettings);

    expect(status.source).toBe("managed");
    expect(status.readiness).toBe("ready");
    expect(status.selectedModelId).toBe("base.en");
    expect(status.installedModels).toHaveLength(1);
    expect(status.installedModels[0]?.active).toBe(true);
    expect(status.ffmpegReady).toBe(true);
  });

  it("uses the manifest-selected model when database settings are unavailable", async () => {
    const whisperBinary = path.join(
      tempHome,
      "tools",
      "voice",
      "whispercpp",
      "v1.8.3",
      "windows-x64",
      "Release",
      "whisper-cli.exe",
    );
    const baseModelPath = path.join(tempHome, "tools", "voice", "models", "ggml-base.en.bin");
    const smallModelPath = path.join(tempHome, "tools", "voice", "models", "ggml-small.en.bin");
    await fs.mkdir(path.dirname(whisperBinary), { recursive: true });
    await fs.mkdir(path.dirname(baseModelPath), { recursive: true });
    await fs.writeFile(whisperBinary, "binary", "utf8");
    await fs.writeFile(baseModelPath, "model", "utf8");
    await fs.writeFile(smallModelPath, "model", "utf8");

    await writeManagedVoiceManifest({
      schemaVersion: 1,
      selectedModelId: "small.en",
      whisper: {
        version: "v1.8.3",
        platform: "windows-x64",
        binaryPath: whisperBinary,
        installedAt: "2026-03-08T00:00:00.000Z",
        source: "download-binary",
      },
      models: [
        {
          modelId: "base.en",
          filePath: baseModelPath,
          sizeBytes: 123,
          sha256: "abc",
          installedAt: "2026-03-08T00:00:00.000Z",
        },
        {
          modelId: "small.en",
          filePath: smallModelPath,
          sizeBytes: 456,
          sha256: "def",
          installedAt: "2026-03-08T00:00:00.000Z",
        },
      ],
    });

    const status = await getManagedVoiceRuntimeStatus();

    expect(status.selectedModelId).toBe("small.en");
    expect(status.installedModels.find((item) => item.modelId === "small.en")?.active).toBe(true);
    expect(status.installedModels.find((item) => item.modelId === "base.en")?.active).toBe(false);
  });
});

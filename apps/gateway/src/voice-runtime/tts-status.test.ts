import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectManagedTtsVoice } from "./tts-installer.js";
import {
  getManagedTtsRuntimeStatus,
  readManagedTtsManifest,
  writeManagedTtsManifest,
  type ManagedTtsManifest,
} from "./tts-status.js";

const originalHome = process.env.GOATCITADEL_HOME;
const originalPiperBin = process.env.GOATCITADEL_PIPER_BIN;
const originalPiperVoice = process.env.GOATCITADEL_PIPER_VOICE_PATH;

describe("managed piper tts status", () => {
  let tempHome = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tts-status-"));
    process.env.GOATCITADEL_HOME = tempHome;
    delete process.env.GOATCITADEL_PIPER_BIN;
    delete process.env.GOATCITADEL_PIPER_VOICE_PATH;
  });

  afterEach(async () => {
    if (originalHome) {
      process.env.GOATCITADEL_HOME = originalHome;
    } else {
      delete process.env.GOATCITADEL_HOME;
    }
    if (originalPiperBin) {
      process.env.GOATCITADEL_PIPER_BIN = originalPiperBin;
    } else {
      delete process.env.GOATCITADEL_PIPER_BIN;
    }
    if (originalPiperVoice) {
      process.env.GOATCITADEL_PIPER_VOICE_PATH = originalPiperVoice;
    } else {
      delete process.env.GOATCITADEL_PIPER_VOICE_PATH;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("reports missing when nothing is installed", async () => {
    const status = await getManagedTtsRuntimeStatus();
    expect(status.provider).toBe("piper");
    expect(status.readiness).toBe("missing");
    expect(status.binaryReady).toBe(false);
    expect(status.source).toBe("manual");
  });

  it("reports ready when the manifest binary and selected voice files exist on disk", async () => {
    const binaryPath = path.join(tempHome, "piper", "piper.exe");
    const modelPath = path.join(tempHome, "voices", "en_US-lessac-medium.onnx");
    const configPath = `${modelPath}.json`;
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(binaryPath, "bin");
    await fs.writeFile(modelPath, "model");
    await fs.writeFile(configPath, "{}");
    await writeManagedTtsManifest(createManifest(binaryPath, [["en_US-lessac-medium", modelPath, configPath]]));

    const status = await getManagedTtsRuntimeStatus();
    expect(status.readiness).toBe("ready");
    expect(status.binaryPath).toBe(binaryPath);
    expect(status.selectedVoiceId).toBe("en_US-lessac-medium");
    expect(status.selectedVoiceModelPath).toBe(modelPath);
    expect(status.selectedVoiceConfigPath).toBe(configPath);
    expect(status.source).toBe("managed");
  });

  it("reports broken when the binary exists but the voice files are missing", async () => {
    const binaryPath = path.join(tempHome, "piper", "piper.exe");
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.writeFile(binaryPath, "bin");
    await writeManagedTtsManifest(
      createManifest(binaryPath, [
        ["en_US-lessac-medium", path.join(tempHome, "missing.onnx"), path.join(tempHome, "missing.onnx.json")],
      ]),
    );

    const status = await getManagedTtsRuntimeStatus();
    expect(status.readiness).toBe("broken");
  });

  it("prefers env overrides and reports env_override source", async () => {
    const binaryPath = path.join(tempHome, "custom-piper");
    const modelPath = path.join(tempHome, "custom-voice.onnx");
    await fs.writeFile(binaryPath, "bin");
    await fs.writeFile(modelPath, "model");
    await fs.writeFile(`${modelPath}.json`, "{}");
    process.env.GOATCITADEL_PIPER_BIN = binaryPath;
    process.env.GOATCITADEL_PIPER_VOICE_PATH = modelPath;

    const status = await getManagedTtsRuntimeStatus();
    expect(status.source).toBe("env_override");
    expect(status.readiness).toBe("ready");
    expect(status.binaryPath).toBe(binaryPath);
    expect(status.selectedVoiceModelPath).toBe(modelPath);
    expect(status.selectedVoiceId).toBe("custom-voice");
  });

  it("selects an installed voice and rejects voices that are not installed", async () => {
    const binaryPath = path.join(tempHome, "piper", "piper");
    const modelA = path.join(tempHome, "a.onnx");
    const modelB = path.join(tempHome, "b.onnx");
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.writeFile(binaryPath, "bin");
    await writeManagedTtsManifest(
      createManifest(binaryPath, [
        ["voice-a", modelA, `${modelA}.json`],
        ["voice-b", modelB, `${modelB}.json`],
      ]),
    );

    await selectManagedTtsVoice("voice-b");
    expect((await readManagedTtsManifest())?.selectedVoiceId).toBe("voice-b");

    await expect(selectManagedTtsVoice("voice-c")).rejects.toThrow("TTS voice voice-c is not installed yet.");
  });
});

function createManifest(binaryPath: string, voices: Array<[string, string, string]>): ManagedTtsManifest {
  return {
    schemaVersion: 1,
    piper: {
      version: "2023.11.14-2",
      platform: "windows-x64",
      binaryPath,
      installedAt: "2026-07-05T00:00:00.000Z",
    },
    voices: voices.map(([voiceId, modelPath, configPath]) => ({
      voiceId,
      modelPath,
      configPath,
      sizeBytes: 123,
      sha256: "abc",
      installedAt: "2026-07-05T00:00:00.000Z",
    })),
  };
}

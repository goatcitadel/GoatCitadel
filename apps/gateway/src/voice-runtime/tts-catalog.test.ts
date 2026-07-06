import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGED_TTS_VOICE_ID,
  getManagedPiperRuntimeSource,
  getManagedTtsVoice,
  MANAGED_PIPER_RUNTIME_SOURCES,
  MANAGED_TTS_VOICES,
  PIPER_RUNTIME_VERSION,
} from "./tts-catalog.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe("managed piper tts catalog", () => {
  it("pins every piper runtime artifact with an https URL and a real sha256 digest", () => {
    for (const source of Object.values(MANAGED_PIPER_RUNTIME_SOURCES)) {
      expect(source.url.startsWith("https://github.com/rhasspy/piper/releases/download/"), source.url).toBe(true);
      expect(source.url).toContain(PIPER_RUNTIME_VERSION);
      expect(source.sha256, `${source.platform} sha256`).toMatch(SHA256_HEX);
      expect(source.version).toBe(PIPER_RUNTIME_VERSION);
      expect(source.binaryRelativePath.length).toBeGreaterThan(0);
    }
  });

  it("never ships a placeholder digest", () => {
    const digests = [
      ...Object.values(MANAGED_PIPER_RUNTIME_SOURCES).map((item) => item.sha256),
      ...MANAGED_TTS_VOICES.flatMap((item) => [item.modelSha256, item.configSha256]),
    ];
    for (const digest of digests) {
      expect(digest).toMatch(SHA256_HEX);
      expect(digest.toLowerCase()).not.toContain("placeholder");
      expect(new Set(digest.split("")).size, `low-entropy digest: ${digest}`).toBeGreaterThan(4);
    }
    // Distinct artifacts must not share a digest (copy/paste guard). The
    // windows x64/arm64 entries intentionally reuse one archive.
    const uniquePlatformDigests = new Set(Object.values(MANAGED_PIPER_RUNTIME_SOURCES).map((item) => item.sha256));
    expect(uniquePlatformDigests.size).toBe(4);
  });

  it("pins every voice artifact to the versioned Hugging Face tree with model + config digests", () => {
    expect(MANAGED_TTS_VOICES.length).toBeGreaterThan(0);
    for (const voice of MANAGED_TTS_VOICES) {
      expect(voice.modelUrl.startsWith("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/")).toBe(true);
      expect(voice.configUrl.startsWith("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/")).toBe(true);
      expect(voice.modelSha256).toMatch(SHA256_HEX);
      expect(voice.configSha256).toMatch(SHA256_HEX);
      expect(voice.modelFileName.endsWith(".onnx")).toBe(true);
      expect(voice.configFileName).toBe(`${voice.modelFileName}.json`);
      expect(voice.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("resolves the default voice and per-platform runtime sources", () => {
    expect(getManagedTtsVoice(DEFAULT_MANAGED_TTS_VOICE_ID)?.defaultInstall).toBe(true);
    expect(getManagedTtsVoice("nope")).toBeUndefined();
    expect(getManagedPiperRuntimeSource("windows-x64").binaryRelativePath).toBe("piper/piper.exe");
    expect(getManagedPiperRuntimeSource("linux-x64").binaryRelativePath).toBe("piper/piper");
  });
});

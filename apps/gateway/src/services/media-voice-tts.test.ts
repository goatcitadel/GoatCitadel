import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { TtsRuntimeStatus } from "../voice-runtime/tts-status.js";
import {
  MAX_TTS_OUTPUT_BYTES,
  MAX_TTS_TEXT_CHARS,
  PIPER_SYNTHESIZE_TIMEOUT_MS,
  synthesizeSpeech,
  truncateTtsText,
  TTS_TRUNCATION_MARKER,
  type TtsProcessRunner,
} from "./media-voice-tts.js";

function readyStatus(overrides: Partial<TtsRuntimeStatus> = {}): TtsRuntimeStatus {
  return {
    provider: "piper",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    binaryPath: "/fake/piper",
    selectedVoiceId: "en_US-lessac-medium",
    selectedVoiceModelPath: "/fake/en_US-lessac-medium.onnx",
    selectedVoiceConfigPath: "/fake/en_US-lessac-medium.onnx.json",
    manifestPath: "/fake/tts-manifest.json",
    ...overrides,
  };
}

function createFakeRunner(options: {
  oggBytes?: Buffer;
  onPiper?: (args: string[], stdinText?: string) => void | Promise<void>;
  piperError?: unknown;
  ffmpegError?: unknown;
}): { runner: TtsProcessRunner; calls: Array<{ file: string; args: string[]; stdinText?: string }> } {
  const calls: Array<{ file: string; args: string[]; stdinText?: string }> = [];
  const runner: TtsProcessRunner = async (file, args, runOptions) => {
    calls.push({ file, args, stdinText: runOptions.stdinText });
    if (file === "/fake/piper") {
      if (options.piperError) {
        throw options.piperError;
      }
      await options.onPiper?.(args, runOptions.stdinText);
      const wavPath = args[args.indexOf("--output_file") + 1];
      await fs.writeFile(wavPath as string, Buffer.from("RIFFfakewav"));
      return;
    }
    if (options.ffmpegError) {
      throw options.ffmpegError;
    }
    const oggPath = args[args.length - 1];
    await fs.writeFile(oggPath as string, options.oggBytes ?? Buffer.from("OggSfakeopus"));
  };
  return { runner, calls };
}

describe("synthesizeSpeech", () => {
  it("caps input text at the TTS character limit with an ellipsis marker", async () => {
    const { runner, calls } = createFakeRunner({});
    const longText = "a".repeat(MAX_TTS_TEXT_CHARS * 2);

    const result = await synthesizeSpeech(
      { text: longText },
      { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
    );

    expect(result.mimeType).toBe("audio/ogg");
    const piperCall = calls.find((call) => call.file === "/fake/piper");
    expect(piperCall?.stdinText?.length).toBe(MAX_TTS_TEXT_CHARS);
    expect(piperCall?.stdinText?.endsWith(TTS_TRUNCATION_MARKER)).toBe(true);
  });

  it("passes short text through unchanged and pins the piper timeout", async () => {
    const { runner, calls } = createFakeRunner({});
    await synthesizeSpeech(
      { text: "  hello there  " },
      { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
    );
    const piperCall = calls.find((call) => call.file === "/fake/piper");
    expect(piperCall?.stdinText).toBe("hello there");
    expect(piperCall?.args).toEqual([
      "--model",
      "/fake/en_US-lessac-medium.onnx",
      "--config",
      "/fake/en_US-lessac-medium.onnx.json",
      "--output_file",
      expect.stringContaining("goatcitadel-tts-"),
    ]);
  });

  it("rejects empty text", async () => {
    const { runner } = createFakeRunner({});
    await expect(
      synthesizeSpeech(
        { text: "   " },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
      ),
    ).rejects.toThrow("TTS synthesis requires non-empty text.");
  });

  it("throws a configuration error when the TTS runtime is not ready", async () => {
    const { runner, calls } = createFakeRunner({});
    await expect(
      synthesizeSpeech(
        { text: "hello" },
        {
          getTtsStatus: async () => readyStatus({ readiness: "missing", binaryPath: undefined }),
          getFfmpegPath: async () => "/fake/ffmpeg",
          runProcess: runner,
        },
      ),
    ).rejects.toThrow("Local TTS is not configured.");
    expect(calls).toEqual([]);
  });

  it("rejects a requested voice that does not match the installed voice", async () => {
    const { runner } = createFakeRunner({});
    await expect(
      synthesizeSpeech(
        { text: "hello", voice: "de_DE-thorsten-high" },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
      ),
    ).rejects.toThrow("is not the installed voice");
  });

  it("throws when ffmpeg is unavailable", async () => {
    const { runner, calls } = createFakeRunner({});
    await expect(
      synthesizeSpeech(
        { text: "hello" },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => undefined, runProcess: runner },
      ),
    ).rejects.toThrow("TTS conversion requires ffmpeg.");
    expect(calls).toEqual([]);
  });

  it("surfaces a clean timeout error when the piper subprocess is killed on timeout", async () => {
    const timeoutError = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    const { runner } = createFakeRunner({ piperError: timeoutError });
    await expect(
      synthesizeSpeech(
        { text: "hello" },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
      ),
    ).rejects.toThrow(`TTS synthesis timed out after ${PIPER_SYNTHESIZE_TIMEOUT_MS}ms`);
  });

  it("surfaces a clean timeout error when the ffmpeg conversion is killed on timeout", async () => {
    const timeoutError = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    const { runner } = createFakeRunner({ ffmpegError: timeoutError });
    await expect(
      synthesizeSpeech(
        { text: "hello" },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
      ),
    ).rejects.toThrow("TTS audio conversion timed out");
  });

  it("rejects synthesized output larger than the inline attachment cap", async () => {
    const { runner } = createFakeRunner({ oggBytes: Buffer.alloc(MAX_TTS_OUTPUT_BYTES + 1) });
    await expect(
      synthesizeSpeech(
        { text: "hello" },
        { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
      ),
    ).rejects.toThrow("exceeds the");
  });

  it("returns base64 ogg bytes and cleans up temp files on success", async () => {
    const oggBytes = Buffer.from("OggSopus-voice-note");
    const { runner, calls } = createFakeRunner({ oggBytes });

    const result = await synthesizeSpeech(
      { text: "hello" },
      { getTtsStatus: async () => readyStatus(), getFfmpegPath: async () => "/fake/ffmpeg", runProcess: runner },
    );

    expect(Buffer.from(result.bytesBase64, "base64")).toEqual(oggBytes);
    expect(result.mimeType).toBe("audio/ogg");
    const piperCall = calls.find((call) => call.file === "/fake/piper");
    const wavPath = piperCall?.args[piperCall.args.indexOf("--output_file") + 1];
    const ffmpegCall = calls.find((call) => call.file === "/fake/ffmpeg");
    const oggPath = ffmpegCall?.args[ffmpegCall.args.length - 1];
    await expect(fs.access(wavPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(oggPath as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("truncateTtsText leaves short text intact", () => {
    expect(truncateTtsText(" ok ")).toBe("ok");
  });
});

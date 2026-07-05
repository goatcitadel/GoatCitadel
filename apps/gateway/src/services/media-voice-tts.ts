import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getManagedVoiceRuntimeStatus } from "../voice-runtime/status.js";
import { getManagedTtsRuntimeStatus, type TtsRuntimeStatus } from "../voice-runtime/tts-status.js";

/**
 * Local Piper TTS synthesis (Competitive-gap program phase B2b).
 *
 * Subprocess discipline mirrors the whisper/ffmpeg path in
 * `media-voice-service.ts`: bounded timeouts, no shell interpolation
 * (execFile with an args array), stdin for the text payload, and temp files
 * cleaned up in a finally block. Piper writes a WAV intermediate; ffmpeg then
 * converts to ogg/opus, the container Telegram treats as a native voice note.
 *
 * Governance posture: TTS renders only the already-policy-gated assistant
 * reply text. It introduces no new input surface — the text has already
 * passed the outbound channel sanitizer and policy gates before it reaches
 * synthesis, so no additional content scanning happens here by design.
 */

export const MAX_TTS_TEXT_CHARS = 2_000;
export const TTS_TRUNCATION_MARKER = "…";
export const MAX_TTS_OUTPUT_BYTES = 8 * 1024 * 1024;
export const PIPER_SYNTHESIZE_TIMEOUT_MS = 15_000;
export const TTS_FFMPEG_CONVERT_TIMEOUT_MS = 30_000;
const TTS_PROCESS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export interface SynthesizeSpeechInput {
  text: string;
  voice?: string;
}

export interface SynthesizeSpeechResult {
  bytesBase64: string;
  mimeType: string;
}

export type TtsProcessRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; stdinText?: string },
) => Promise<void>;

export interface SynthesizeSpeechDeps {
  getTtsStatus?: () => Promise<TtsRuntimeStatus>;
  getFfmpegPath?: () => Promise<string | undefined>;
  runProcess?: TtsProcessRunner;
}

async function defaultRunProcess(
  file: string,
  args: string[],
  options: { timeoutMs: number; stdinText?: string },
): Promise<void> {
  const pending = execFileAsync(file, args, {
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: TTS_PROCESS_MAX_BUFFER_BYTES,
  });
  if (options.stdinText !== undefined) {
    pending.child.stdin?.write(options.stdinText);
    pending.child.stdin?.end();
  }
  await pending;
}

async function defaultGetFfmpegPath(): Promise<string | undefined> {
  const envFfmpeg = process.env.GOATCITADEL_FFMPEG_BIN?.trim();
  if (envFfmpeg) {
    return envFfmpeg;
  }
  const runtime = await getManagedVoiceRuntimeStatus();
  return runtime.ffmpegPath;
}

function isProcessTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { killed?: unknown }).killed === true &&
    typeof (error as { signal?: unknown }).signal === "string"
  );
}

export function truncateTtsText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TTS_TEXT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_TTS_TEXT_CHARS - TTS_TRUNCATION_MARKER.length)}${TTS_TRUNCATION_MARKER}`;
}

/**
 * Synthesize speech for the given text with the managed Piper runtime and
 * convert it to ogg/opus. Throws when the runtime is not ready, a subprocess
 * fails or times out, or the synthesized output exceeds the inline size cap.
 */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
  deps: SynthesizeSpeechDeps = {},
): Promise<SynthesizeSpeechResult> {
  const text = truncateTtsText(input.text ?? "");
  if (!text) {
    throw new Error("TTS synthesis requires non-empty text.");
  }

  const getTtsStatus = deps.getTtsStatus ?? getManagedTtsRuntimeStatus;
  const runProcess = deps.runProcess ?? defaultRunProcess;
  const getFfmpegPath = deps.getFfmpegPath ?? defaultGetFfmpegPath;

  const status = await getTtsStatus();
  if (status.readiness !== "ready" || !status.binaryPath || !status.selectedVoiceModelPath) {
    throw new Error(
      "Local TTS is not configured. Install the managed Piper runtime or set GOATCITADEL_PIPER_BIN and GOATCITADEL_PIPER_VOICE_PATH.",
    );
  }
  if (input.voice?.trim() && status.selectedVoiceId && input.voice.trim() !== status.selectedVoiceId) {
    throw new Error(
      `Requested TTS voice ${input.voice.trim()} is not the installed voice (${status.selectedVoiceId}).`,
    );
  }
  const ffmpegPath = await getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("TTS conversion requires ffmpeg. Install the managed voice runtime or set GOATCITADEL_FFMPEG_BIN.");
  }

  const tempBase = path.join(os.tmpdir(), `goatcitadel-tts-${randomUUID()}`);
  const wavPath = `${tempBase}.wav`;
  const oggPath = `${tempBase}.ogg`;

  try {
    const piperArgs = ["--model", status.selectedVoiceModelPath, "--output_file", wavPath];
    if (status.selectedVoiceConfigPath) {
      piperArgs.splice(2, 0, "--config", status.selectedVoiceConfigPath);
    }
    try {
      await runProcess(status.binaryPath, piperArgs, {
        timeoutMs: PIPER_SYNTHESIZE_TIMEOUT_MS,
        stdinText: text,
      });
    } catch (error) {
      if (isProcessTimeoutError(error)) {
        throw new Error(`TTS synthesis timed out after ${PIPER_SYNTHESIZE_TIMEOUT_MS}ms and was terminated.`, {
          cause: error,
        });
      }
      throw error;
    }

    try {
      await runProcess(
        ffmpegPath,
        ["-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "32k", "-application", "voip", oggPath],
        { timeoutMs: TTS_FFMPEG_CONVERT_TIMEOUT_MS },
      );
    } catch (error) {
      if (isProcessTimeoutError(error)) {
        throw new Error(`TTS audio conversion timed out after ${TTS_FFMPEG_CONVERT_TIMEOUT_MS}ms and was terminated.`, {
          cause: error,
        });
      }
      throw error;
    }

    const bytes = await fs.readFile(oggPath);
    if (bytes.length === 0) {
      throw new Error("TTS synthesis produced no audio output.");
    }
    if (bytes.length > MAX_TTS_OUTPUT_BYTES) {
      throw new Error(`TTS output exceeds the ${MAX_TTS_OUTPUT_BYTES} byte inline attachment limit.`);
    }
    return {
      bytesBase64: bytes.toString("base64"),
      mimeType: "audio/ogg",
    };
  } finally {
    await Promise.allSettled([fs.rm(wavPath, { force: true }), fs.rm(oggPath, { force: true })]);
  }
}

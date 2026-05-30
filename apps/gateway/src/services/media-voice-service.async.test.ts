import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// The service promisifies `execFile` at import time. We replace the
// callback-style `execFile` from node:child_process with a controllable mock so
// `promisify(execFile)` resolves/rejects deterministically (no real ffmpeg or
// whisper binary, no disk I/O). The runtime-status lookup and node:fs/promises
// are mocked so transcription can run end-to-end against fakes.
// ---------------------------------------------------------------------------

type ExecFileCallback = (
  error: (Error & { killed?: boolean; signal?: string; code?: number }) | null,
  stdout: string,
  stderr: string,
) => void;

interface ExecFileBehavior {
  /** Resolve immediately with this stdout. */
  readonly resolveStdout?: string;
  /** Reject immediately with a non-zero-exit style error. */
  readonly rejectWith?: Error & { code?: number };
  /** Never call back on its own; only the synthetic timeout fires. */
  readonly hang?: boolean;
}

const execFileMock = vi.hoisted(() => {
  const state: { behavior: ExecFileBehavior } = { behavior: { resolveStdout: "" } };
  // Callback-form so promisify wraps it the standard way.
  const fn = vi.fn((_file: string, _args: string[], options: unknown, callback?: ExecFileCallback) => {
    const cb = (typeof options === "function" ? options : callback) as ExecFileCallback;
    const opts = (typeof options === "function" ? {} : options) as { timeout?: number };
    const { behavior } = state;
    if (behavior.hang) {
      // Faithfully model execFile's timeout option: after `timeout` ms the child
      // is killed and the callback fires with killed === true + a signal.
      if (opts.timeout && opts.timeout > 0) {
        setTimeout(() => {
          const error = Object.assign(new Error("spawn ETIMEDOUT"), {
            killed: true,
            signal: "SIGTERM",
          });
          cb(error, "", "");
        }, opts.timeout);
      }
      return;
    }
    if (behavior.rejectWith) {
      setTimeout(() => cb(behavior.rejectWith ?? null, "", "stderr"), 0);
      return;
    }
    setTimeout(() => cb(null, behavior.resolveStdout ?? "", ""), 0);
  });
  return { fn, state };
});

const runtimeStatusMock = vi.hoisted(() => ({ getManagedVoiceRuntimeStatus: vi.fn() }));

const fsMock = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "hello transcript"),
  rm: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock.fn }));
vi.mock("../voice-runtime/status.js", () => ({
  getManagedVoiceRuntimeStatus: runtimeStatusMock.getManagedVoiceRuntimeStatus,
}));
vi.mock("node:fs/promises", () => ({
  default: { writeFile: fsMock.writeFile, readFile: fsMock.readFile, rm: fsMock.rm },
}));

import { MediaVoiceService } from "./media-voice-service.js";

const READY_RUNTIME = {
  provider: "whisper.cpp" as const,
  source: "managed" as const,
  readiness: "ready" as const,
  binaryReady: true,
  binaryPath: "F:\\voice\\whisper.exe",
  ffmpegReady: true,
  ffmpegPath: "F:\\voice\\ffmpeg.exe",
  selectedModelId: "ggml-base.en",
  selectedModelPath: "F:\\voice\\models\\ggml-base.en.bin",
  installedModels: [],
  catalog: [],
};

// Valid WAV header so payload validation + ".wav passthrough" both hold and we
// skip ffmpeg (covered separately via a non-WAV mime in the ffmpeg test).
function wavBytesBase64() {
  return Buffer.from("524946462400000057415645666d7420", "hex").toString("base64");
}

// MP3 framesync header bytes — sniffs as audio, forces the ffmpeg conversion path.
function mp3BytesBase64() {
  return Buffer.from("fffb900000000000000000000000000000000000", "hex").toString("base64");
}

describe("MediaVoiceService external process execution (async + timeout)", () => {
  beforeEach(() => {
    execFileMock.fn.mockClear();
    execFileMock.state.behavior = { resolveStdout: "" };
    fsMock.writeFile.mockClear();
    fsMock.readFile.mockClear();
    fsMock.readFile.mockResolvedValue("hello transcript");
    fsMock.rm.mockClear();
    runtimeStatusMock.getManagedVoiceRuntimeStatus.mockReset();
    runtimeStatusMock.getManagedVoiceRuntimeStatus.mockResolvedValue(READY_RUNTIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes whisper asynchronously via execFile and returns the transcript", async () => {
    const service = new MediaVoiceService(createDeps());

    const result = await service.transcribeVoice({
      bytesBase64: wavBytesBase64(),
      mimeType: "audio/wav",
      language: "en",
    });

    expect(result.text).toBe("hello transcript");
    expect(result.provider).toBe("whisper.cpp");
    // WAV input skips ffmpeg, so exactly one external call: the whisper binary.
    expect(execFileMock.fn).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.fn.mock.calls[0] ?? [];
    expect(file).toBe(READY_RUNTIME.binaryPath);
    expect(args).toEqual(expect.arrayContaining(["-otxt", "-l", "en"]));
    // A finite timeout must be threaded through so a hung binary cannot block forever.
    expect((options as { timeout?: number }).timeout).toBe(120_000);
    expect((options as { windowsHide?: boolean }).windowsHide).toBe(true);
  });

  it("runs ffmpeg conversion asynchronously with a bounded timeout for non-WAV input", async () => {
    const service = new MediaVoiceService(createDeps());

    await service.transcribeVoice({ bytesBase64: mp3BytesBase64(), mimeType: "audio/mpeg" });

    // Two external calls now: ffmpeg convert, then whisper transcribe.
    expect(execFileMock.fn).toHaveBeenCalledTimes(2);
    const [ffmpegFile, , ffmpegOptions] = execFileMock.fn.mock.calls[0] ?? [];
    expect(ffmpegFile).toBe(READY_RUNTIME.ffmpegPath);
    expect((ffmpegOptions as { timeout?: number }).timeout).toBe(30_000);
  });

  it("cleans up temp files on the success path", async () => {
    const service = new MediaVoiceService(createDeps());

    await service.transcribeVoice({ bytesBase64: wavBytesBase64(), mimeType: "audio/wav" });

    // input + normalized + output temp paths all removed in the finally block.
    expect(fsMock.rm).toHaveBeenCalledTimes(3);
    for (const call of fsMock.rm.mock.calls) {
      expect(call[1]).toMatchObject({ force: true });
    }
  });

  it("surfaces a clean error and cleans up temp files when the binary exits non-zero", async () => {
    execFileMock.state.behavior = {
      rejectWith: Object.assign(new Error("Command failed: whisper.exe"), { code: 1 }),
    };
    const service = new MediaVoiceService(createDeps());

    await expect(service.transcribeVoice({ bytesBase64: wavBytesBase64(), mimeType: "audio/wav" })).rejects.toThrow(
      "Local STT failed",
    );

    expect(fsMock.rm).toHaveBeenCalledTimes(3);
  });

  it("hits the timeout, yields a clean transcription error, and still cleans up temp files", async () => {
    vi.useFakeTimers();
    execFileMock.state.behavior = { hang: true };
    const systemSettings = createSystemSettings();
    const service = new MediaVoiceService(createDeps({ systemSettings }));

    const pending = service.transcribeVoice({ bytesBase64: wavBytesBase64(), mimeType: "audio/wav" });
    const assertion = expect(pending).rejects.toThrow(/Local STT failed: Transcription timed out after 120000ms/);

    // Advance past the whisper timeout so the synthetic kill callback fires.
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;

    // Temp files cleaned up even on the timeout/error path.
    expect(fsMock.rm).toHaveBeenCalledTimes(3);
    // Status reflects an explicit timeout, not a raw process signal string.
    expect(systemSettings.set).toHaveBeenCalledWith(
      "voice_status_v1",
      expect.objectContaining({
        state: "error",
        lastError: expect.stringContaining("Transcription timed out after 120000ms"),
      }),
    );
  });
});

function createDeps(overrides: { systemSettings?: ReturnType<typeof createSystemSettings> } = {}) {
  return {
    gatewaySql: { prepare: vi.fn() } as never,
    storage: {
      systemSettings: overrides.systemSettings ?? createSystemSettings(),
      chatAttachments: { get: vi.fn() },
    },
    backgroundTasks: new Set<Promise<unknown>>(),
    isClosing: () => false,
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    readChatAttachmentContent: vi.fn(),
    getChatAttachment: vi.fn(),
  };
}

function createSystemSettings() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => (values.has(key) ? { value: values.get(key) } : undefined)),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}

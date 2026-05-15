import { describe, expect, it, vi } from "vitest";

const voiceRuntimeMocks = vi.hoisted(() => ({
  getManagedVoiceRuntimeStatus: vi.fn(),
  installManagedVoiceRuntime: vi.fn(),
  selectManagedVoiceModel: vi.fn(),
  removeManagedVoiceModel: vi.fn(),
}));

vi.mock("../voice-runtime/status.js", () => ({
  getManagedVoiceRuntimeStatus: voiceRuntimeMocks.getManagedVoiceRuntimeStatus,
}));

vi.mock("../voice-runtime/installer.js", () => ({
  installManagedVoiceRuntime: voiceRuntimeMocks.installManagedVoiceRuntime,
  selectManagedVoiceModel: voiceRuntimeMocks.selectManagedVoiceModel,
  removeManagedVoiceModel: voiceRuntimeMocks.removeManagedVoiceModel,
}));

import { MediaVoiceService } from "./media-voice-service.js";

describe("MediaVoiceService managed voice runtime operations", () => {
  it("persists readiness posture after managed runtime install, selection, and removal", async () => {
    const systemSettings = createSystemSettings();
    const recordDevDiagnostic = vi.fn();
    const readyStatus = {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      binaryPath: "F:\\voice\\whisper.exe",
      ffmpegReady: true,
      ffmpegPath: "F:\\voice\\ffmpeg.exe",
      selectedModelId: "ggml-base.en",
      selectedModelPath: "F:\\voice\\models\\ggml-base.en.bin",
      installedModels: [],
      catalog: [],
    };
    const missingStatus = {
      ...readyStatus,
      readiness: "missing",
      binaryReady: false,
      binaryPath: undefined,
      selectedModelId: "ggml-tiny.en",
      selectedModelPath: undefined,
      lastError: "model missing",
    };
    voiceRuntimeMocks.getManagedVoiceRuntimeStatus.mockResolvedValueOnce(missingStatus);
    voiceRuntimeMocks.installManagedVoiceRuntime.mockResolvedValueOnce(readyStatus);
    voiceRuntimeMocks.selectManagedVoiceModel.mockResolvedValueOnce({
      ...readyStatus,
      selectedModelId: "ggml-small.en",
    });
    voiceRuntimeMocks.removeManagedVoiceModel.mockResolvedValueOnce(missingStatus);

    const service = new MediaVoiceService(createDeps({ systemSettings, recordDevDiagnostic }));

    await expect(service.getVoiceRuntimeStatus()).resolves.toBe(missingStatus);
    await expect(service.installVoiceRuntime({ modelId: "ggml-base.en", activate: true })).resolves.toBe(readyStatus);
    await expect(service.selectVoiceRuntimeModel("ggml-small.en")).resolves.toMatchObject({
      selectedModelId: "ggml-small.en",
    });
    await expect(service.removeVoiceRuntimeModel("ggml-tiny.en")).resolves.toBe(missingStatus);

    expect(voiceRuntimeMocks.installManagedVoiceRuntime).toHaveBeenCalledWith(systemSettings, {
      modelId: "ggml-base.en",
      activate: true,
    });
    expect(voiceRuntimeMocks.selectManagedVoiceModel).toHaveBeenCalledWith(systemSettings, "ggml-small.en");
    expect(voiceRuntimeMocks.removeManagedVoiceModel).toHaveBeenCalledWith(systemSettings, "ggml-tiny.en");
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "voice",
        event: "voice.runtime.install.start",
        level: "info",
      }),
    );
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "voice",
        event: "voice.runtime.install.complete",
        level: "info",
      }),
    );
    expect(systemSettings.set).toHaveBeenCalledWith(
      "voice_status_v1",
      expect.objectContaining({
        provider: "whisper.cpp",
        runtimeReady: true,
        modelId: "ggml-base.en",
      }),
    );
    expect(systemSettings.set).toHaveBeenCalledWith(
      "voice_status_v1",
      expect.objectContaining({
        runtimeReady: false,
        modelId: "ggml-tiny.en",
        lastError: "model missing",
      }),
    );
  });

  it("marks local STT as errored when neither managed nor env runtime is configured", async () => {
    const systemSettings = createSystemSettings();
    voiceRuntimeMocks.getManagedVoiceRuntimeStatus.mockResolvedValueOnce({
      provider: "whisper.cpp",
      source: "manual",
      readiness: "missing",
      binaryReady: false,
      ffmpegReady: false,
      installedModels: [],
      catalog: [],
    });
    const env = {
      GOATCITADEL_WHISPER_CPP_BIN: process.env.GOATCITADEL_WHISPER_CPP_BIN,
      GOATCITADEL_WHISPER_CPP_MODEL_PATH: process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH,
      GOATCITADEL_FFMPEG_BIN: process.env.GOATCITADEL_FFMPEG_BIN,
    };
    delete process.env.GOATCITADEL_WHISPER_CPP_BIN;
    delete process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
    delete process.env.GOATCITADEL_FFMPEG_BIN;

    try {
      const service = new MediaVoiceService(createDeps({ systemSettings }));
      await expect(
        service.transcribeVoice({
          bytesBase64: Buffer.from("not-audio").toString("base64"),
          mimeType: "audio/wav",
        }),
      ).rejects.toThrow("Local STT is not configured");
    } finally {
      process.env.GOATCITADEL_WHISPER_CPP_BIN = env.GOATCITADEL_WHISPER_CPP_BIN;
      process.env.GOATCITADEL_WHISPER_CPP_MODEL_PATH = env.GOATCITADEL_WHISPER_CPP_MODEL_PATH;
      process.env.GOATCITADEL_FFMPEG_BIN = env.GOATCITADEL_FFMPEG_BIN;
    }

    expect(systemSettings.set).toHaveBeenCalledWith(
      "voice_status_v1",
      expect.objectContaining({
        state: "error",
        runtimeReady: false,
        lastError: "No whisper.cpp runtime is configured.",
      }),
    );
  });
});

function createDeps(
  overrides: {
    systemSettings?: ReturnType<typeof createSystemSettings>;
    recordDevDiagnostic?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    gatewaySql: { prepare: vi.fn() } as never,
    storage: {
      systemSettings: overrides.systemSettings ?? createSystemSettings(),
      chatAttachments: {
        get: vi.fn(),
      },
    },
    backgroundTasks: new Set(),
    isClosing: () => false,
    publishRealtime: vi.fn(),
    recordDevDiagnostic: overrides.recordDevDiagnostic ?? vi.fn(),
    readChatAttachmentContent: vi.fn(),
    getChatAttachment: vi.fn(),
  };
}

function createSystemSettings() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => {
      if (!values.has(key)) {
        return undefined;
      }
      return { value: values.get(key) };
    }),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}

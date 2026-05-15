import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceRuntimeStatus, VoiceStatus, VoiceTalkSessionRecord } from "@goatcitadel/contracts";
import { useSettingsVoiceRuntime } from "./useSettingsVoiceRuntime";

const apiMocks = vi.hoisted(() => ({
  fetchVoiceRuntimeStatus: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  fetchVoiceTalkSessions: vi.fn(),
  installVoiceRuntime: vi.fn(),
  removeVoiceRuntimeModel: vi.fn(),
  selectVoiceRuntimeModel: vi.fn(),
  startVoiceTalkSession: vi.fn(),
  startVoiceWake: vi.fn(),
  stopVoiceTalkSession: vi.fn(),
  stopVoiceWake: vi.fn(),
  transcribeVoice: vi.fn(),
}));

vi.mock("../../api/client", () => apiMocks);

function makeVoiceStatus(overrides: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    stt: {
      provider: "whisper.cpp",
      state: "stopped",
      runtimeReady: true,
      modelId: "base.en",
      updatedAt: "2026-05-14T12:00:00.000Z",
    },
    talk: {
      state: "running",
      mode: "wake",
      activeSessionId: "talk-active",
      updatedAt: "2026-05-14T12:01:00.000Z",
    },
    wake: {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: "2026-05-14T12:02:00.000Z",
    },
    ...overrides,
  } as VoiceStatus;
}

function makeVoiceRuntime(overrides: Partial<VoiceRuntimeStatus> = {}): VoiceRuntimeStatus {
  return {
    provider: "whisper.cpp",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    ffmpegReady: true,
    selectedModelId: "base.en",
    binaryPath: "C:\\goatcitadel\\whisper.exe",
    installedModels: [
      {
        modelId: "base.en",
        filePath: "C:\\models\\base.en.bin",
        sizeBytes: 142,
        active: true,
      },
    ],
    catalog: [],
    updatedAt: "2026-05-14T12:03:00.000Z",
    ...overrides,
  } as VoiceRuntimeStatus;
}

function makeTalkSession(overrides: Partial<VoiceTalkSessionRecord> = {}): VoiceTalkSessionRecord {
  return {
    talkSessionId: "talk-active",
    mode: "wake",
    state: "running",
    createdAt: "2026-05-14T12:00:00.000Z",
    startedAt: "2026-05-14T12:00:01.000Z",
    ...overrides,
  } as VoiceTalkSessionRecord;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

function installFileReader(result = "data:audio/wav;base64,UklGRg==") {
  class TestFileReader {
    result: string | ArrayBuffer | null = result;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL = vi.fn(() => this.onload?.());
  }

  vi.stubGlobal("FileReader", TestFileReader);
}

type HookState = ReturnType<typeof useSettingsVoiceRuntime>;

describe("useSettingsVoiceRuntime", () => {
  let state: HookState;
  let setError: ReturnType<typeof vi.fn>;

  function renderHook() {
    function Harness() {
      state = useSettingsVoiceRuntime({ setError });
      return null;
    }

    return create(<Harness />);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setError = vi.fn();
    apiMocks.fetchVoiceStatus.mockResolvedValue(makeVoiceStatus());
    apiMocks.fetchVoiceRuntimeStatus.mockResolvedValue(makeVoiceRuntime());
    apiMocks.fetchVoiceTalkSessions.mockResolvedValue([makeTalkSession()]);
    apiMocks.installVoiceRuntime.mockResolvedValue(makeVoiceRuntime({ selectedModelId: "small.en" }));
    apiMocks.selectVoiceRuntimeModel.mockResolvedValue(makeVoiceRuntime({ selectedModelId: "small.en" }));
    apiMocks.removeVoiceRuntimeModel.mockResolvedValue(makeVoiceRuntime({ installedModels: [] }));
    apiMocks.startVoiceTalkSession.mockResolvedValue({});
    apiMocks.stopVoiceTalkSession.mockResolvedValue({});
    apiMocks.startVoiceWake.mockResolvedValue({});
    apiMocks.stopVoiceWake.mockResolvedValue({});
    apiMocks.transcribeVoice.mockResolvedValue({
      text: "hello operator",
      provider: "whisper.cpp",
      durationMs: 42,
    });
    installFileReader();
  });

  it("loads initial voice state and exposes installed model ids from runtime truth", async () => {
    const renderer = renderHook();
    await flush();

    expect(state.voiceStatus?.talk.activeSessionId).toBe("talk-active");
    expect(state.voiceRuntime?.selectedModelId).toBe("base.en");
    expect(state.voiceTalkSessions).toHaveLength(1);
    expect(state.voiceTalkMode).toBe("wake");
    expect(state.installedVoiceModelIds.has("base.en")).toBe(true);
    expect(state.voiceRecoveryActions).toEqual(expect.any(Array));
    expect(state.voiceOperatorGuidance.postureSummary).toEqual(expect.any(String));
    renderer.unmount();
  });

  it("clears voice snapshots when initial refresh cannot reach the gateway", async () => {
    apiMocks.fetchVoiceStatus.mockRejectedValueOnce(new Error("voice down"));

    const renderer = renderHook();
    await flush();

    expect(state.voiceStatus).toBeNull();
    expect(state.voiceRuntime).toBeNull();
    expect(state.voiceTalkSessions).toEqual([]);
    renderer.unmount();
  });

  it("runs managed runtime install, select, remove, talk, wake, and transcription actions", async () => {
    const renderer = renderHook();
    await flush();

    await act(async () => {
      await state.onInstallManagedVoiceRuntime("small.en", true);
    });
    expect(apiMocks.installVoiceRuntime).toHaveBeenCalledWith({ modelId: "small.en", activate: true });
    expect(state.voiceActionInfo).toContain("Managed voice runtime is ready with small.en.");

    await act(async () => {
      await state.onSelectManagedVoiceModel("small.en");
    });
    expect(apiMocks.selectVoiceRuntimeModel).toHaveBeenCalledWith("small.en");
    expect(state.voiceActionInfo).toBe("Activated local voice model small.en.");

    await act(async () => {
      await state.onRemoveManagedVoiceModel("base.en");
    });
    expect(apiMocks.removeVoiceRuntimeModel).toHaveBeenCalledWith("base.en");
    expect(state.voiceActionInfo).toBe("Removed local voice model base.en.");

    await act(async () => {
      state.setVoiceTalkMode("push_to_talk");
    });
    await act(async () => {
      await state.onStartVoiceTalk();
    });
    expect(apiMocks.startVoiceTalkSession).toHaveBeenCalledWith({ mode: "push_to_talk" });
    expect(state.voiceActionInfo).toBe("Talk Mode started (Push to talk).");

    await act(async () => {
      await state.onStopVoiceTalk();
    });
    expect(apiMocks.stopVoiceTalkSession).toHaveBeenCalledWith("talk-active");
    expect(state.voiceActionInfo).toBe("Talk Mode stopped.");

    await act(async () => {
      await state.onStartWake();
    });
    expect(apiMocks.startVoiceWake).toHaveBeenCalledTimes(1);
    expect(state.voiceActionInfo).toBe("Wake listener enabled.");

    await act(async () => {
      await state.onStopWake();
    });
    expect(apiMocks.stopVoiceWake).toHaveBeenCalledTimes(1);
    expect(state.voiceActionInfo).toBe("Wake listener disabled.");

    await act(async () => {
      state.setVoiceFile(new File(["audio"], "clip.wav", { type: "" }));
    });
    await act(async () => {
      await state.onRunVoiceTranscribeTest();
    });
    expect(apiMocks.transcribeVoice).toHaveBeenCalledWith({
      bytesBase64: "UklGRg==",
      mimeType: "audio/wav",
    });
    expect(state.voiceTranscriptResult).toBe("hello operator");
    expect(state.voiceActionInfo).toBe("Transcription completed with whisper.cpp in 42ms.");
    expect(setError).toHaveBeenLastCalledWith(null);
    renderer.unmount();
  });

  it("reports no-file and runtime action failures without leaving the hook busy", async () => {
    const renderer = renderHook();
    await flush();

    await act(async () => {
      await state.onRunVoiceTranscribeTest();
    });
    expect(setError).toHaveBeenCalledWith("Choose an audio file first.");

    apiMocks.installVoiceRuntime.mockRejectedValueOnce(new Error("install failed"));
    await act(async () => {
      await state.onInstallManagedVoiceRuntime(undefined, false);
    });
    expect(setError).toHaveBeenCalledWith("install failed");
    expect(state.voiceActionInfo).toBe("");
    expect(state.voiceBusy).toBe(false);

    apiMocks.startVoiceTalkSession.mockRejectedValueOnce(new Error("talk failed"));
    apiMocks.fetchVoiceStatus.mockRejectedValueOnce(new Error("refresh also failed"));
    await act(async () => {
      await state.onStartVoiceTalk();
    });
    expect(setError).toHaveBeenCalledWith("talk failed");
    expect(state.voiceBusy).toBe(false);

    apiMocks.stopVoiceWake.mockRejectedValueOnce(new Error("wake stop failed"));
    await act(async () => {
      await state.onStopWake();
    });
    expect(setError).toHaveBeenCalledWith("wake stop failed");
    expect(state.voiceBusy).toBe(false);
    renderer.unmount();
  });

  it("skips stopping talk mode when no active talk session exists and reports transcription failures", async () => {
    apiMocks.fetchVoiceStatus.mockResolvedValue(
      makeVoiceStatus({ talk: { ...makeVoiceStatus().talk, activeSessionId: undefined } }),
    );
    const renderer = renderHook();
    await flush();

    await act(async () => {
      await state.onStopVoiceTalk();
    });
    expect(apiMocks.stopVoiceTalkSession).not.toHaveBeenCalled();

    await act(async () => {
      state.setVoiceFile(new File(["audio"], "clip.ogg", { type: "audio/ogg" }));
    });
    apiMocks.transcribeVoice.mockRejectedValueOnce(new Error("transcribe failed"));
    await act(async () => {
      await state.onRunVoiceTranscribeTest();
    });

    expect(apiMocks.transcribeVoice).toHaveBeenCalledWith({
      bytesBase64: "UklGRg==",
      mimeType: "audio/ogg",
    });
    expect(setError).toHaveBeenCalledWith("transcribe failed");
    expect(state.voiceActionInfo).toBe("");
    renderer.unmount();
  });
});

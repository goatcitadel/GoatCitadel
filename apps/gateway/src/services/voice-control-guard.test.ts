import { describe, expect, it } from "vitest";
import type { VoiceRuntimeStatus, VoiceStatus } from "@goatcitadel/contracts";
import { buildVoiceControlStartFailure } from "./voice-control-guard.js";

function createVoiceStatus(overrides?: {
  stt?: Partial<VoiceStatus["stt"]>;
  talk?: Partial<VoiceStatus["talk"]>;
  wake?: Partial<VoiceStatus["wake"]>;
}): VoiceStatus {
  return {
    stt: {
      provider: "whisper.cpp",
      state: "stopped",
      runtimeReady: true,
      modelId: "base.en",
      updatedAt: "2026-03-31T18:20:00.000Z",
      ...overrides?.stt,
    },
    talk: {
      state: "stopped",
      updatedAt: "2026-03-31T18:20:00.000Z",
      ...overrides?.talk,
    },
    wake: {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: "2026-03-31T18:20:00.000Z",
      ...overrides?.wake,
    },
  };
}

function createVoiceRuntime(overrides?: Partial<VoiceRuntimeStatus>): VoiceRuntimeStatus {
  return {
    provider: "whisper.cpp",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    ffmpegReady: true,
    selectedModelId: "base.en",
    installedModels: [],
    catalog: [],
    ...overrides,
  };
}

describe("buildVoiceControlStartFailure", () => {
  it("blocks talk start when the managed runtime is not ready", () => {
    const failure = buildVoiceControlStartFailure({
      action: "talk",
      now: "2026-03-31T18:25:00.000Z",
      runtime: createVoiceRuntime({
        readiness: "missing",
        selectedModelId: undefined,
        binaryReady: false,
        ffmpegReady: false,
      }),
      status: createVoiceStatus(),
    });

    expect(failure).toEqual(
      expect.objectContaining({
        message: "Cannot start Talk Mode while the managed voice runtime is missing.",
        stt: expect.objectContaining({
          state: "error",
          runtimeReady: false,
          lastError: "Cannot start Talk Mode while the managed voice runtime is missing.",
        }),
        talk: expect.objectContaining({
          state: "error",
        }),
      }),
    );
  });

  it("blocks wake start when no managed model is selected", () => {
    const failure = buildVoiceControlStartFailure({
      action: "wake",
      now: "2026-03-31T18:25:00.000Z",
      runtime: createVoiceRuntime({
        selectedModelId: undefined,
      }),
      status: createVoiceStatus(),
    });

    expect(failure).toEqual(
      expect.objectContaining({
        message: "Cannot start Wake listener until a managed voice model is selected.",
        wake: expect.objectContaining({
          enabled: false,
          state: "error",
        }),
      }),
    );
  });

  it("keeps an already-running talk session visible when a duplicate start is attempted", () => {
    const failure = buildVoiceControlStartFailure({
      action: "talk",
      now: "2026-03-31T18:25:00.000Z",
      runtime: createVoiceRuntime(),
      status: createVoiceStatus({
        talk: {
          activeSessionId: "talk-123",
          state: "running",
          mode: "push_to_talk",
        },
      }),
    });

    expect(failure).toEqual(
      expect.objectContaining({
        message: "Talk Mode is already running on talk-123. Stop it before starting a new session.",
        talk: expect.objectContaining({
          activeSessionId: "talk-123",
          state: "running",
        }),
      }),
    );
  });

  it("returns undefined when the control start is allowed", () => {
    expect(
      buildVoiceControlStartFailure({
        action: "wake",
        now: "2026-03-31T18:25:00.000Z",
        runtime: createVoiceRuntime(),
        status: createVoiceStatus(),
      }),
    ).toBeUndefined();
  });
});

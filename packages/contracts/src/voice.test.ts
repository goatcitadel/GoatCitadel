import { describe, expect, it } from "vitest";
import {
  TAVERN_AUDIO_CAPTURE_DEFAULTS,
  TAVERN_MEDIA_QUALITY_PRESETS,
  buildVoiceOperatorGuidance,
  buildVoiceRecoveryActions,
  type VoiceRuntimeStatus,
  type VoiceStatus,
} from "./voice.js";

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
      updatedAt: "2026-03-31T00:00:00.000Z",
      ...overrides?.stt,
    },
    talk: {
      state: "stopped",
      updatedAt: "2026-03-31T00:00:00.000Z",
      ...overrides?.talk,
    },
    wake: {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: "2026-03-31T00:00:00.000Z",
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
    installedModels: [
      {
        modelId: "base.en",
        filePath: "/tmp/base.en.bin",
        sizeBytes: 1,
        active: true,
      },
    ],
    catalog: [],
    ...overrides,
  };
}

describe("voice operator helpers", () => {
  it("defines conservative Tavern audio capture defaults", () => {
    expect(TAVERN_AUDIO_CAPTURE_DEFAULTS).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it("defines design-only Tavern media quality presets", () => {
    expect(TAVERN_MEDIA_QUALITY_PRESETS).toHaveLength(5);
    expect(TAVERN_MEDIA_QUALITY_PRESETS.map((preset) => preset.presetId)).toEqual([
      "high",
      "balanced",
      "constrained",
      "poor",
      "data_saver",
    ]);
    expect(TAVERN_MEDIA_QUALITY_PRESETS.find((preset) => preset.presetId === "high")).toMatchObject({
      maxVideo: { width: 1920, height: 1080, frameRate: 30 },
      audioFirst: false,
    });
    expect(TAVERN_MEDIA_QUALITY_PRESETS.find((preset) => preset.presetId === "data_saver")).toMatchObject({
      maxVideo: { width: 640, height: 360, frameRate: 15 },
      audioFirst: true,
    });
  });

  it("prioritizes runtime repair when the managed runtime is missing", () => {
    expect(
      buildVoiceRecoveryActions(
        createVoiceStatus({
          stt: { runtimeReady: false },
        }),
        createVoiceRuntime({
          readiness: "missing",
          binaryReady: false,
          ffmpegReady: false,
          selectedModelId: undefined,
          installedModels: [],
        }),
      )[0],
    ).toMatchObject({
      id: "repair-runtime",
      tone: "critical",
    });
  });

  it("offers installed-model activation when runtime is ready without a selected model", () => {
    expect(
      buildVoiceRecoveryActions(
        createVoiceStatus(),
        createVoiceRuntime({
          selectedModelId: undefined,
          installedModels: [
            {
              modelId: "small.en",
              filePath: "/tmp/small.en.bin",
              sizeBytes: 1,
              active: false,
            },
          ],
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: "activate-installed-model",
        modelId: "small.en",
        tone: "warning",
      }),
    );
  });

  it("offers starter model installation when runtime is ready without installed models", () => {
    expect(
      buildVoiceRecoveryActions(
        createVoiceStatus(),
        createVoiceRuntime({
          selectedModelId: undefined,
          installedModels: [],
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: "install-starter-model",
        tone: "warning",
      }),
    );
  });

  it("adds talk and wake cleanup actions when operator state is still active", () => {
    expect(
      buildVoiceRecoveryActions(
        createVoiceStatus({
          talk: {
            activeSessionId: "talk-123",
            state: "running",
            mode: "push_to_talk",
          },
          wake: {
            enabled: true,
            state: "running",
          },
        }),
        createVoiceRuntime(),
      ).map((action) => action.id),
    ).toEqual(["stop-talk-session", "stop-wake-listener"]);
  });

  it("builds a recovery posture summary and deduped recommendations", () => {
    const guidance = buildVoiceOperatorGuidance(
      createVoiceStatus({
        wake: {
          enabled: true,
          state: "running",
        },
      }),
      createVoiceRuntime({
        readiness: "broken",
        binaryReady: false,
        selectedModelId: undefined,
        lastError: "ffmpeg missing",
      }),
    );

    expect(guidance.postureSummary).toContain("Voice is still in recovery posture");
    expect(guidance.blockingIssues).toEqual(
      expect.arrayContaining([
        "Managed voice runtime readiness is broken.",
        "No managed voice model is currently selected.",
        "Last runtime error: ffmpeg missing",
        "Wake mode is enabled while the managed runtime is not ready.",
      ]),
    );
    expect(guidance.recommendedActions).toEqual(Array.from(new Set(guidance.recommendedActions)));
  });

  it("falls back to default missing-runtime guidance when no status is available", () => {
    const guidance = buildVoiceOperatorGuidance();

    expect(guidance.postureSummary).toContain("runtime missing");
    expect(guidance.recoveryActions[0]).toMatchObject({ id: "repair-runtime", tone: "critical" });
    expect(guidance.blockingIssues).toEqual(
      expect.arrayContaining([
        "Managed voice runtime readiness is missing.",
        "No managed voice model is currently selected.",
      ]),
    );
  });

  it("recommends a status refresh when the runtime is ready but only stale error text remains", () => {
    expect(
      buildVoiceRecoveryActions(
        createVoiceStatus({
          stt: { lastError: "previous transient failure" },
        }),
        createVoiceRuntime(),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "refresh-runtime-state",
        tone: "warning",
      }),
    ]);
  });

  it("summarizes ready runtime posture with enabled wake state", () => {
    const guidance = buildVoiceOperatorGuidance(
      createVoiceStatus({
        wake: {
          enabled: true,
          state: "running",
        },
      }),
      createVoiceRuntime(),
    );

    expect(guidance.postureSummary).toContain("Voice runtime is ready on base.en");
    expect(guidance.postureSummary).toContain("wake is running");
  });

  it("summarizes a ready runtime that still needs model selection", () => {
    const guidance = buildVoiceOperatorGuidance(
      createVoiceStatus(),
      createVoiceRuntime({
        selectedModelId: undefined,
      }),
    );

    expect(guidance.postureSummary).toContain("model not selected");
    expect(guidance.postureSummary).toContain("wake disabled");
  });
});

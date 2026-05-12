import { describe, expect, it } from "vitest";
import {
  applyChatModePresetToPatch,
  buildChatModePrefsPatch,
  chatModeAllowsDynamicTeamGrowth,
  chatModeRequiresProjectBinding,
  getChatModePreset,
  getChatTurnRecoveryAction,
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  isChatTurnActiveStatus,
  isChatTurnTerminalStatus,
  type ChatMode,
  type ChatTurnFailureClass,
  type ChatTurnRecoveryAction,
} from "./chat.js";
import { ToolPolicyConfigSchema } from "./config-schemas.js";
import { deriveHookPhase, type HookTrigger } from "./hooks.js";
import { deriveMemoryItemLifecycleState } from "./memory.js";
import { inferProviderForModelId, providerAllowsForeignModelIds } from "./provider-templates.js";
import { clampInt } from "./utils.js";
import {
  buildVoiceOperatorGuidance,
  buildVoiceRecoveryActions,
  type VoiceRuntimeStatus,
  type VoiceStatus,
} from "./voice.js";

function voiceStatus(overrides?: {
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

function voiceRuntime(overrides?: Partial<VoiceRuntimeStatus>): VoiceRuntimeStatus {
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

describe("chat contract helpers", () => {
  it("derives mode presets and patch behavior for every chat mode", () => {
    const modes: ChatMode[] = ["chat", "cowork", "code"];

    for (const mode of modes) {
      expect(getChatModePreset(mode).mode).toBe(mode);
      expect(buildChatModePrefsPatch(mode)).toMatchObject({ mode });
    }

    expect(applyChatModePresetToPatch({})).toEqual({});
    expect(applyChatModePresetToPatch({ mode: "code", webMode: "off" })).toMatchObject({
      mode: "code",
      webMode: "off",
    });
    expect(chatModeRequiresProjectBinding("chat")).toBe(false);
    expect(chatModeRequiresProjectBinding("code")).toBe(true);
    expect(chatModeAllowsDynamicTeamGrowth("chat")).toBe(false);
    expect(chatModeAllowsDynamicTeamGrowth("cowork")).toBe(true);
  });

  it("maps every recovery class and action to operator copy", () => {
    const expectedByFailure: Record<ChatTurnFailureClass, ChatTurnRecoveryAction> = {
      provider_timeout: "retry",
      network_interrupted: "check_gateway_connection",
      tool_blocked: "retry_narrower",
      tool_failed: "retry_narrower",
      auth_required: "reconnect_auth",
      tool_loop_guard: "retry_narrower",
      global_circuit_breaker: "retry_narrower",
      tool_run_budget_exceeded: "retry_narrower",
      turn_budget_exceeded: "switch_to_deep_mode",
      budget_exceeded: "switch_to_deep_mode",
      approval_required: "approve_pending_step",
      unknown: "retry",
    };

    for (const [failureClass, action] of Object.entries(expectedByFailure) as Array<
      [ChatTurnFailureClass, ChatTurnRecoveryAction]
    >) {
      expect(getChatTurnRecoveryAction(failureClass)).toBe(action);
    }

    const actions: ChatTurnRecoveryAction[] = [
      "retry",
      "retry_narrower",
      "continue_from_partial",
      "reconnect_auth",
      "approve_pending_step",
      "switch_to_deep_mode",
      "check_gateway_connection",
    ];
    for (const action of actions) {
      expect(getChatTurnRecoveryActionLabel(action)).toBeTypeOf("string");
      expect(getChatTurnRecoveryActionSummary(action)).toBeTypeOf("string");
    }
  });

  it("checks active and terminal turn statuses", () => {
    expect(isChatTurnActiveStatus("queued")).toBe(true);
    expect(isChatTurnActiveStatus("completed")).toBe(false);
    expect(isChatTurnTerminalStatus("completed")).toBe(true);
    expect(isChatTurnTerminalStatus("waiting_for_tool")).toBe(false);
  });
});

describe("schema and utility helpers", () => {
  it("rejects invalid tool loop threshold ordering", () => {
    const base = {
      profiles: {},
      tools: { profile: "standard", allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
    };

    expect(() =>
      ToolPolicyConfigSchema.parse({
        ...base,
        tools: {
          ...base.tools,
          loopDetection: { warningThreshold: 5, criticalThreshold: 4 },
        },
      }),
    ).toThrow(/warningThreshold/);

    expect(() =>
      ToolPolicyConfigSchema.parse({
        ...base,
        tools: {
          ...base.tools,
          loopDetection: { criticalThreshold: 7, globalThreshold: 6 },
        },
      }),
    ).toThrow(/criticalThreshold/);
  });

  it("derives hook phases for canonical and suffix triggers", () => {
    expect(deriveHookPhase("before_prompt_build")).toBe("before");
    expect(deriveHookPhase("before_message_write")).toBe("before");
    expect(deriveHookPhase("llm_input")).toBe("after");
    expect(deriveHookPhase("agent_end")).toBe("after");
    expect(deriveHookPhase("custom.before" as HookTrigger)).toBe("before");
    expect(deriveHookPhase("custom.after" as HookTrigger)).toBe("after");
    expect(deriveHookPhase("tool.call.error")).toBe("after");
  });

  it("derives memory lifecycle states from status and dates", () => {
    expect(deriveMemoryItemLifecycleState({ status: "forgotten" })).toBe("forgotten");
    expect(deriveMemoryItemLifecycleState({ status: "active", forgottenAt: "2026-01-01T00:00:00.000Z" })).toBe(
      "forgotten",
    );
    expect(deriveMemoryItemLifecycleState({ status: "active" })).toBe("active");
    expect(deriveMemoryItemLifecycleState({ status: "active", expiresAt: "not-a-date" })).toBe("active");
    expect(
      deriveMemoryItemLifecycleState({ status: "active", expiresAt: "2026-01-02T00:00:00.000Z" }, "not-a-date"),
    ).toBe("active");
    expect(
      deriveMemoryItemLifecycleState(
        { status: "active", expiresAt: "2026-01-01T00:00:00.000Z" },
        "2026-01-02T00:00:00.000Z",
      ),
    ).toBe("expired");
    expect(
      deriveMemoryItemLifecycleState(
        { status: "active", expiresAt: "2026-01-03T00:00:00.000Z" },
        new Date("2026-01-02T00:00:00.000Z"),
      ),
    ).toBe("active");
  });

  it("handles provider and numeric utility edge cases", () => {
    expect(inferProviderForModelId("")).toBeUndefined();
    expect(providerAllowsForeignModelIds(" OpenRouter ")).toBe(true);
    expect(clampInt("5.9", 0, 1, 10)).toBe(5);
    expect(clampInt(Number.NaN, 7, 1, 10)).toBe(7);
    expect(clampInt(-10, 0, 1, 10)).toBe(1);
    expect(clampInt(99, 0, 1, 10)).toBe(10);
  });
});

describe("voice contract helper edge cases", () => {
  it("offers starter install when no managed model is installed", () => {
    expect(
      buildVoiceRecoveryActions(
        voiceStatus(),
        voiceRuntime({
          selectedModelId: undefined,
          installedModels: [],
        }),
      ),
    ).toContainEqual(expect.objectContaining({ id: "install-starter-model", tone: "warning" }));
  });

  it("offers state refresh when only stale errors remain", () => {
    expect(
      buildVoiceRecoveryActions(voiceStatus({ stt: { lastError: "old transcription failure" } }), voiceRuntime()),
    ).toContainEqual(expect.objectContaining({ id: "refresh-runtime-state", tone: "warning" }));
  });

  it("builds guidance from default missing runtime state", () => {
    const guidance = buildVoiceOperatorGuidance(undefined, undefined);

    expect(guidance.postureSummary).toContain("recovery posture");
    expect(guidance.recoveryActions[0]?.id).toBe("repair-runtime");
    expect(guidance.blockingIssues).toContain("Managed voice runtime readiness is missing.");
    expect(guidance.blockingIssues).toContain("No managed voice model is currently selected.");
  });

  it("builds selected-model repair guidance and running-talk recommendations", () => {
    const guidance = buildVoiceOperatorGuidance(
      voiceStatus({ talk: { state: "running", activeSessionId: "talk-1" } }),
      voiceRuntime({ readiness: "broken", binaryReady: false, selectedModelId: "small.en" }),
    );

    expect(guidance.postureSummary).toContain("runtime broken, model small.en");
    expect(guidance.recommendedActions).toContain(
      "Run `goatcitadel voice install --model small.en` or re-select the active model from Settings.",
    );
    expect(guidance.recommendedActions).toContain(
      "Stop the current talk session before changing models or repairing the runtime.",
    );
  });

  it("summarizes ready runtime posture with selected model", () => {
    expect(buildVoiceOperatorGuidance(voiceStatus(), voiceRuntime()).postureSummary).toBe(
      "Voice runtime is ready on base.en, talk is stopped, and wake is disabled.",
    );
  });
});

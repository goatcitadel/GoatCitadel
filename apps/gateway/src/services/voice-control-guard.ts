import type { VoiceRuntimeStatus, VoiceStatus } from "@goatcitadel/contracts";

export type VoiceControlAction = "talk" | "wake";

export interface VoiceControlStartFailure {
  message: string;
  stt: VoiceStatus["stt"];
  talk?: VoiceStatus["talk"];
  wake?: VoiceStatus["wake"];
}

interface BuildVoiceControlStartFailureInput {
  action: VoiceControlAction;
  now: string;
  runtime: VoiceRuntimeStatus;
  status: VoiceStatus;
}

export function buildVoiceControlStartFailure(
  input: BuildVoiceControlStartFailureInput,
): VoiceControlStartFailure | undefined {
  const label = input.action === "talk" ? "Talk Mode" : "Wake listener";
  const message = resolveVoiceControlStartFailureMessage(input);
  if (!message) {
    return undefined;
  }
  const stt: VoiceStatus["stt"] = {
    ...input.status.stt,
    state: "error",
    provider: input.runtime.provider,
    modelId: input.runtime.selectedModelId,
    runtimeReady: input.runtime.readiness === "ready",
    lastError: message,
    updatedAt: input.now,
  };
  if (input.action === "talk") {
    return {
      message,
      stt,
      talk: {
        activeSessionId: input.status.talk.activeSessionId,
        state: input.status.talk.state === "running" ? "running" : "error",
        mode: input.status.talk.mode,
        updatedAt: input.now,
      },
    };
  }
  return {
    message,
    stt,
    wake: {
      enabled: input.status.wake.enabled,
      state: input.status.wake.enabled ? input.status.wake.state : "error",
      model: input.status.wake.model,
      updatedAt: input.now,
    },
  };
}

function resolveVoiceControlStartFailureMessage(
  input: BuildVoiceControlStartFailureInput,
): string | undefined {
  const label = input.action === "talk" ? "Talk Mode" : "Wake listener";
  if (input.runtime.readiness !== "ready") {
    return `Cannot start ${label} while the managed voice runtime is ${input.runtime.readiness}.`;
  }
  if (!input.runtime.selectedModelId) {
    return `Cannot start ${label} until a managed voice model is selected.`;
  }
  if (input.action === "talk" && input.status.talk.state === "running") {
    return input.status.talk.activeSessionId
      ? `Talk Mode is already running on ${input.status.talk.activeSessionId}. Stop it before starting a new session.`
      : "Talk Mode is already running. Stop it before starting a new session.";
  }
  if (input.action === "wake" && input.status.wake.enabled) {
    return "Wake listener is already enabled. Disable it before starting a new wake run.";
  }
  return undefined;
}

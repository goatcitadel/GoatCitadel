export type VoiceRuntimeState = "stopped" | "running" | "error";
export type VoiceTalkMode = "push_to_talk" | "wake";
export type VoiceProvider = "whisper.cpp" | "faster-whisper" | "cloud-fallback" | "none";
export type VoiceModelLanguageScope = "english" | "multilingual";
export type VoiceRuntimeInstallSource = "managed" | "env_override" | "manual";
export type VoiceRuntimeReadiness = "ready" | "missing" | "broken";

export interface VoiceTranscribeRequest {
  fileName?: string;
  mimeType?: string;
  bytesBase64: string;
  language?: string;
}

export interface VoiceTranscribeResponse {
  text: string;
  language?: string;
  durationMs?: number;
  provider: VoiceProvider;
}

export interface VoiceTalkSessionRecord {
  talkSessionId: string;
  mode: VoiceTalkMode;
  state: VoiceRuntimeState;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastTranscriptAt?: string;
  sessionId?: string;
}

export interface VoiceWakeStatus {
  enabled: boolean;
  state: VoiceRuntimeState;
  model: "openwakeword" | "none";
  updatedAt: string;
}

export interface VoiceStatus {
  stt: {
    state: VoiceRuntimeState;
    provider: VoiceProvider;
    modelId?: string;
    runtimeReady?: boolean;
    lastError?: string;
    updatedAt: string;
  };
  talk: {
    activeSessionId?: string;
    state: VoiceRuntimeState;
    mode?: VoiceTalkMode;
    updatedAt: string;
  };
  wake: VoiceWakeStatus;
}

export interface VoiceModelCatalogEntry {
  id: string;
  label: string;
  languageScope: VoiceModelLanguageScope;
  approxSizeLabel: string;
  sizeBytes: number;
  recommended?: boolean;
  defaultInstall?: boolean;
}

export interface InstalledVoiceModelRecord {
  modelId: string;
  filePath: string;
  sizeBytes: number;
  installedAt?: string;
  active?: boolean;
}

export interface VoiceRuntimeStatus {
  provider: Extract<VoiceProvider, "whisper.cpp">;
  source: VoiceRuntimeInstallSource;
  readiness: VoiceRuntimeReadiness;
  binaryReady: boolean;
  binaryPath?: string;
  binaryVersion?: string;
  ffmpegReady: boolean;
  ffmpegPath?: string;
  manifestPath?: string;
  selectedModelId?: string;
  selectedModelPath?: string;
  installedModels: InstalledVoiceModelRecord[];
  catalog: VoiceModelCatalogEntry[];
  lastError?: string;
}

export interface VoiceRuntimeInstallRequest {
  modelId?: string;
  activate?: boolean;
  repair?: boolean;
}

export type VoiceRecoveryActionId =
  | "repair-runtime"
  | "install-starter-model"
  | "activate-installed-model"
  | "stop-talk-session"
  | "stop-wake-listener"
  | "refresh-runtime-state";

export interface VoiceRecoveryAction {
  id: VoiceRecoveryActionId;
  title: string;
  description: string;
  tone: "success" | "warning" | "critical";
  modelId?: string;
}

export interface VoiceOperatorGuidance {
  postureSummary: string;
  blockingIssues: string[];
  recoveryActions: VoiceRecoveryAction[];
  recommendedActions: string[];
}

export function buildVoiceRecoveryActions(
  voiceStatus?: VoiceStatus | null,
  voiceRuntime?: VoiceRuntimeStatus | null,
): VoiceRecoveryAction[] {
  const actions: VoiceRecoveryAction[] = [];
  const runtimeMissing = !voiceRuntime || voiceRuntime.readiness === "missing";
  const runtimeBroken = voiceRuntime?.readiness === "broken"
    || Boolean(voiceRuntime && (!voiceRuntime.binaryReady || !voiceRuntime.ffmpegReady));

  if (runtimeMissing || runtimeBroken) {
    actions.push({
      id: "repair-runtime",
      title: runtimeMissing ? "Install or repair the managed runtime" : "Repair the managed runtime",
      description: runtimeMissing
        ? "The local voice runtime is not ready yet. Install or repair it before trying transcription, talk mode, or wake."
        : "The managed runtime is present but incomplete. Repair it so the binary, helper tools, and selected model return to a ready state.",
      tone: "critical",
    });
  }

  if (!runtimeMissing && !runtimeBroken && !voiceRuntime?.selectedModelId) {
    const firstInstalledModel = voiceRuntime.installedModels[0]?.modelId;
    if (firstInstalledModel) {
      actions.push({
        id: "activate-installed-model",
        title: "Activate an installed local model",
        description: `The runtime is ready but no active model is selected. Activate ${firstInstalledModel} before starting talk or transcription tests.`,
        tone: "warning",
        modelId: firstInstalledModel,
      });
    } else {
      actions.push({
        id: "install-starter-model",
        title: "Install and activate a starter model",
        description: "The runtime is ready but no local model is installed yet. Install the starter base.en model so voice flows have an active transcription target.",
        tone: "warning",
      });
    }
  }

  if (voiceStatus?.talk.state === "running" && voiceStatus.talk.activeSessionId) {
    actions.push({
      id: "stop-talk-session",
      title: "Stop the current talk session",
      description: `Talk Mode is still running on ${voiceStatus.talk.activeSessionId}. Stop it before starting a clean proof pass or retrying a failed talk run.`,
      tone: "warning",
    });
  }

  if (voiceStatus?.wake.enabled) {
    actions.push({
      id: "stop-wake-listener",
      title: "Disable the wake listener",
      description: "Wake is still enabled. Disable it so you can re-run a clean enable/disable cycle and verify operator control.",
      tone: "warning",
    });
  }

  if (actions.length === 0 && (voiceStatus?.stt.lastError || voiceRuntime?.lastError)) {
    actions.push({
      id: "refresh-runtime-state",
      title: "Refresh runtime state after the last error",
      description: "Voice recorded a recent error, but no immediate cleanup action is active. Refresh the live status before retrying the proof lane so the operator sees current state instead of stale failure text.",
      tone: "warning",
    });
  }

  return actions;
}

export function buildVoiceOperatorGuidance(
  voiceStatus?: VoiceStatus | null,
  voiceRuntime?: VoiceRuntimeStatus | null,
): VoiceOperatorGuidance {
  const status = voiceStatus ?? {
    stt: {
      state: "stopped" as const,
      provider: "none" as const,
      runtimeReady: false,
      updatedAt: new Date().toISOString(),
    },
    talk: {
      state: "stopped" as const,
      updatedAt: new Date().toISOString(),
    },
    wake: {
      enabled: false,
      state: "stopped" as const,
      model: "none" as const,
      updatedAt: new Date().toISOString(),
    },
  };
  const runtime = voiceRuntime ?? {
    provider: "whisper.cpp" as const,
    source: "managed" as const,
    readiness: "missing" as const,
    binaryReady: false,
    ffmpegReady: false,
    installedModels: [],
    catalog: [],
  };
  const blockingIssues: string[] = [];
  const recommendedActions: string[] = [];
  const recoveryActions = buildVoiceRecoveryActions(status, runtime);
  const lastError = runtime.lastError ?? status.stt.lastError;

  if (runtime.readiness !== "ready") {
    blockingIssues.push(`Managed voice runtime readiness is ${runtime.readiness}.`);
    if (runtime.selectedModelId) {
      recommendedActions.push(`Run \`goatcitadel voice install --model ${runtime.selectedModelId}\` or re-select the active model from Settings.`);
    } else {
      recommendedActions.push("Run `goatcitadel voice install` to provision the managed whisper.cpp runtime.");
    }
  }

  if (!runtime.selectedModelId) {
    blockingIssues.push("No managed voice model is currently selected.");
    recommendedActions.push("Install or activate a local whisper model before testing Talk Mode or local transcription.");
  }

  if (lastError?.trim()) {
    blockingIssues.push(`Last runtime error: ${lastError}`);
  }

  if (status.wake.enabled && runtime.readiness !== "ready") {
    blockingIssues.push("Wake mode is enabled while the managed runtime is not ready.");
    recommendedActions.push("Disable wake mode until the managed runtime reports ready.");
  }

  if (status.talk.state === "running") {
    recommendedActions.push("Stop the current talk session before changing models or repairing the runtime.");
  }

  recommendedActions.push("Generate the voice proof-lane draft from System, then run the transcription, Talk Mode, and Wake Mode operator cycle.");

  let postureSummary = `Voice runtime is ${runtime.readiness}, talk is ${status.talk.state}, and wake is ${status.wake.enabled ? status.wake.state : "disabled"}.`;
  if (runtime.readiness === "ready" && runtime.selectedModelId) {
    postureSummary = `Voice runtime is ready on ${runtime.selectedModelId}, talk is ${status.talk.state}, and wake is ${status.wake.enabled ? status.wake.state : "disabled"}.`;
  } else if (runtime.readiness !== "ready" || !runtime.selectedModelId) {
    postureSummary = `Voice is still in recovery posture: runtime ${runtime.readiness}, model ${runtime.selectedModelId ?? "not selected"}, talk ${status.talk.state}, wake ${status.wake.enabled ? status.wake.state : "disabled"}.`;
  }

  return {
    postureSummary,
    blockingIssues,
    recoveryActions,
    recommendedActions: Array.from(new Set(recommendedActions)),
  };
}

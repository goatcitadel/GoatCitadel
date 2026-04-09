import { useEffect, useMemo, useState } from "react";
import {
  buildVoiceOperatorGuidance,
  buildVoiceRecoveryActions,
  type VoiceRuntimeStatus,
  type VoiceStatus,
  type VoiceTalkSessionRecord,
} from "@goatcitadel/contracts";
import {
  fetchVoiceRuntimeStatus,
  fetchVoiceStatus,
  fetchVoiceTalkSessions,
  installVoiceRuntime,
  removeVoiceRuntimeModel,
  selectVoiceRuntimeModel,
  startVoiceTalkSession,
  startVoiceWake,
  stopVoiceTalkSession,
  stopVoiceWake,
  transcribeVoice,
} from "../../api/client";
import { fileToBase64, formatTalkModeLabel } from "../settings-page-utils";

export type VoiceTalkMode = "push_to_talk" | "wake";

interface UseSettingsVoiceRuntimeOptions {
  setError: (value: string | null) => void;
}

export function useSettingsVoiceRuntime(options: UseSettingsVoiceRuntimeOptions) {
  const { setError } = options;
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeStatus | null>(null);
  const [voiceTalkSessions, setVoiceTalkSessions] = useState<VoiceTalkSessionRecord[]>([]);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceTalkMode, setVoiceTalkMode] = useState<VoiceTalkMode>("push_to_talk");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceTranscriptResult, setVoiceTranscriptResult] = useState("");
  const [voiceActionInfo, setVoiceActionInfo] = useState("");

  const refreshVoiceRuntime = async () => {
    const [status, runtime, talkSessions] = await Promise.all([
      fetchVoiceStatus(),
      fetchVoiceRuntimeStatus(),
      fetchVoiceTalkSessions(8),
    ]);
    setVoiceStatus(status);
    setVoiceRuntime(runtime);
    setVoiceTalkSessions(talkSessions);
    if (status.talk.mode) {
      setVoiceTalkMode(status.talk.mode);
    }
  };

  const refreshVoiceRuntimeAfterFailure = async () => {
    try {
      await refreshVoiceRuntime();
    } catch {
      // Preserve the original operator-facing failure when the refresh probe also fails.
    }
  };

  useEffect(() => {
    void refreshVoiceRuntime().catch(() => {
      setVoiceStatus(null);
      setVoiceRuntime(null);
      setVoiceTalkSessions([]);
    });
  }, []);

  const onInstallManagedVoiceRuntime = async (modelId?: string, activate = true) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await installVoiceRuntime({
        modelId,
        activate,
      });
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(
        runtime.readiness === "ready"
          ? `Managed voice runtime is ready${runtime.selectedModelId ? ` with ${runtime.selectedModelId}` : ""}.`
          : "Managed voice runtime was updated, but it still needs attention.",
      );
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onSelectManagedVoiceModel = async (modelId: string) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await selectVoiceRuntimeModel(modelId);
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Activated local voice model ${modelId}.`);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onRemoveManagedVoiceModel = async (modelId: string) => {
    setVoiceBusy(true);
    setError(null);
    try {
      const runtime = await removeVoiceRuntimeModel(modelId);
      setVoiceRuntime(runtime);
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Removed local voice model ${modelId}.`);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStartVoiceTalk = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await startVoiceTalkSession({ mode: voiceTalkMode });
      await refreshVoiceRuntime();
      setVoiceActionInfo(`Talk Mode started (${formatTalkModeLabel(voiceTalkMode)}).`);
      setError(null);
    } catch (err) {
      await refreshVoiceRuntimeAfterFailure();
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStopVoiceTalk = async () => {
    if (!voiceStatus?.talk.activeSessionId) {
      return;
    }
    setVoiceBusy(true);
    setError(null);
    try {
      await stopVoiceTalkSession(voiceStatus.talk.activeSessionId);
      await refreshVoiceRuntime();
      setVoiceActionInfo("Talk Mode stopped.");
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStartWake = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await startVoiceWake();
      await refreshVoiceRuntime();
      setVoiceActionInfo("Wake listener enabled.");
      setError(null);
    } catch (err) {
      await refreshVoiceRuntimeAfterFailure();
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onStopWake = async () => {
    setVoiceBusy(true);
    setError(null);
    try {
      await stopVoiceWake();
      await refreshVoiceRuntime();
      setVoiceActionInfo("Wake listener disabled.");
      setError(null);
    } catch (err) {
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const onRunVoiceTranscribeTest = async () => {
    if (!voiceFile) {
      setError("Choose an audio file first.");
      return;
    }
    setVoiceBusy(true);
    setError(null);
    try {
      const bytesBase64 = await fileToBase64(voiceFile);
      const result = await transcribeVoice({
        bytesBase64,
        mimeType: voiceFile.type || "audio/wav",
      });
      setVoiceTranscriptResult(result.text);
      await refreshVoiceRuntime();
      setVoiceActionInfo(
        `Transcription completed with ${result.provider}${typeof result.durationMs === "number" ? ` in ${result.durationMs}ms` : ""}.`,
      );
      setError(null);
    } catch (err) {
      await refreshVoiceRuntimeAfterFailure();
      setVoiceActionInfo("");
      setError((err as Error).message);
    } finally {
      setVoiceBusy(false);
    }
  };

  const voiceRecoveryActions = useMemo(
    () => buildVoiceRecoveryActions(voiceStatus, voiceRuntime),
    [voiceStatus, voiceRuntime],
  );
  const voiceOperatorGuidance = useMemo(
    () => buildVoiceOperatorGuidance(voiceStatus, voiceRuntime),
    [voiceStatus, voiceRuntime],
  );
  const installedVoiceModelIds = useMemo(
    () => new Set(voiceRuntime?.installedModels.map((item) => item.modelId) ?? []),
    [voiceRuntime],
  );

  return {
    voiceStatus,
    voiceRuntime,
    voiceTalkSessions,
    voiceBusy,
    voiceTalkMode,
    setVoiceTalkMode,
    voiceFile,
    setVoiceFile,
    voiceTranscriptResult,
    voiceActionInfo,
    voiceRecoveryActions,
    voiceOperatorGuidance,
    installedVoiceModelIds,
    refreshVoiceRuntime,
    onInstallManagedVoiceRuntime,
    onSelectManagedVoiceModel,
    onRemoveManagedVoiceModel,
    onStartVoiceTalk,
    onStopVoiceTalk,
    onStartWake,
    onStopWake,
    onRunVoiceTranscribeTest,
  };
}

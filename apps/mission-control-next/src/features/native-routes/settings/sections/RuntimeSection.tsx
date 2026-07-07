// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Play, Plus, RefreshCw, RotateCcw, Save, Square } from "lucide-react";
import {
  fetchDaemonStatus,
  fetchLlamaCppModels,
  fetchNpuModels,
  fetchSettings,
  fetchVoiceRuntimeStatus,
  installVoiceRuntime,
  patchSettings,
  refreshLlamaCppRuntime,
  refreshNpuRuntime,
  restartDaemon,
  selectVoiceRuntimeModel,
  startDaemon,
  startLlamaCppRuntime,
  stopDaemon,
  stopLlamaCppRuntime,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { deriveLlamaCppAlias } from "../../SettingsNativePage";

const VISUAL_REGRESSION_MODE =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

export function RuntimeSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const settings = await fetchSettings();
    const shouldLoadNpuModels =
      (settings.npu?.enabled ?? false) &&
      ((settings.npu?.status?.healthy ?? false) || settings.npu?.status?.processState === "running");
    const [daemon, voiceRuntime, llamaModels, npuModels] = await Promise.all([
      nativeLoad("Daemon status", fetchDaemonStatus(), null),
      nativeLoad("Voice runtime", fetchVoiceRuntimeStatus(), null),
      nativeLoad("llama.cpp models", fetchLlamaCppModels(), { items: [] }),
      shouldLoadNpuModels
        ? nativeLoad("NPU models", fetchNpuModels(), { items: [] })
        : Promise.resolve({ data: { items: [] }, issue: null }),
    ]);
    if (VISUAL_REGRESSION_MODE) {
      return {
        settings: {
          ...settings,
          llamaCpp: {
            ...settings.llamaCpp,
            baseUrl: "http://127.0.0.1:8080/v1",
            command: "llama-server",
            modelsRootPath: "",
            modelPath: "",
            status: {
              ...settings.llamaCpp?.status,
              desiredState: "stopped" as const,
              processState: "stopped" as const,
              healthy: false,
              activeModelId: undefined,
              command: "llama-server",
              modelPath: undefined,
              lastError: undefined,
            },
          },
          npu: {
            ...settings.npu,
            status: {
              ...settings.npu?.status,
              desiredState: "stopped" as const,
              processState: "stopped" as const,
              healthy: false,
              activeModelId: undefined,
              lastError: undefined,
            },
          },
        },
        issues: [],
        daemon: {
          running: true,
          pid: 0,
          uptimeSeconds: 0,
          host: "Local daemon preview",
          state: "running" as const,
          supported: true,
          controllable: false,
          controlMessage: "Daemon controls are unavailable for this preview run.",
        },
        voiceRuntime: {
          provider: "whisper.cpp" as const,
          source: "managed" as const,
          readiness: "missing" as const,
          binaryReady: false,
          ffmpegReady: false,
          selectedModelId: undefined,
          selectedModelPath: undefined,
          installedModels: [],
          catalog: [],
          lastError: undefined,
        },
        llamaModels: [],
        llamaModelsWarning: undefined,
        npuModels: [],
      };
    }
    return {
      settings,
      issues: nativeLoadIssues([daemon, voiceRuntime, llamaModels, npuModels]),
      daemon: daemon.data,
      voiceRuntime: voiceRuntime.data,
      llamaModels: llamaModels.data.items,
      llamaModelsWarning: llamaModels.data.degraded ? llamaModels.data.warning : undefined,
      npuModels: npuModels.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [llamaForm, setLlamaForm] = useState({
    enabled: false,
    autoStart: false,
    baseUrl: "",
    command: "",
    modelsRootPath: "",
    modelPath: "",
    alias: "",
  });
  const [npuForm, setNpuForm] = useState({
    enabled: false,
    autoStart: false,
    sidecarUrl: "",
  });
  const discoveredLlamaModels = useMemo(
    () => (data?.llamaModels ?? []).filter((item) => typeof item.filePath === "string" && item.filePath.length > 0),
    [data],
  );
  const selectedDiscoveredModelPath = useMemo(
    () => (discoveredLlamaModels.some((item) => item.filePath === llamaForm.modelPath) ? llamaForm.modelPath : ""),
    [discoveredLlamaModels, llamaForm.modelPath],
  );
  const selectedDiscoveredModel = useMemo(
    () => discoveredLlamaModels.find((item) => item.filePath === selectedDiscoveredModelPath),
    [discoveredLlamaModels, selectedDiscoveredModelPath],
  );

  const buildLlamaSettingsPatch = useCallback(
    () => ({
      enabled: llamaForm.enabled,
      autoStart: llamaForm.autoStart,
      baseUrl: llamaForm.baseUrl,
      command: llamaForm.command,
      modelsRootPath: llamaForm.modelsRootPath || undefined,
      modelPath: llamaForm.modelPath || undefined,
      alias: llamaForm.alias,
    }),
    [llamaForm],
  );

  const saveLlamaSettings = useCallback(
    () =>
      patchSettings({
        llamaCpp: buildLlamaSettingsPatch(),
      }),
    [buildLlamaSettingsPatch],
  );

  const handleDiscoveredModelChange = useCallback(
    (nextModelPath: string) => {
      const nextModel = discoveredLlamaModels.find((item) => item.filePath === nextModelPath);
      setLlamaForm((current) => ({
        ...current,
        modelPath: nextModelPath,
        alias: nextModel ? deriveLlamaCppAlias(nextModel.relativePath ?? nextModel.modelId) : current.alias,
      }));
    },
    [discoveredLlamaModels],
  );

  useEffect(() => {
    if (!data) {
      return;
    }
    setLlamaForm({
      enabled: data.settings.llamaCpp?.enabled ?? false,
      autoStart: data.settings.llamaCpp?.autoStart ?? false,
      baseUrl: data.settings.llamaCpp?.baseUrl ?? "",
      command: data.settings.llamaCpp?.command ?? "",
      modelsRootPath: data.settings.llamaCpp?.modelsRootPath ?? "",
      modelPath: data.settings.llamaCpp?.modelPath ?? "",
      alias: data.settings.llamaCpp?.alias ?? "",
    });
    setNpuForm({
      enabled: false,
      autoStart: false,
      sidecarUrl: data.settings.npu?.sidecarUrl ?? "",
    });
  }, [data]);

  const runAndReload = async (operation: () => Promise<unknown>, successMessage: string) => {
    try {
      await operation();
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {data.llamaModelsWarning ? (
            <SettingsNotice notice={{ tone: "info", message: data.llamaModelsWarning }} />
          ) : null}
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Runtime posture"
            subtitle="Providers, local runtimes, and attached systems."
          >
            <NativeMetricGrid
              items={[
                {
                  label: "Daemon",
                  value: data.daemon?.state ?? "unknown",
                  meta: data.daemon?.host ?? "Gateway daemon status",
                },
                {
                  label: "llama.cpp",
                  value: data.settings.llamaCpp?.status?.processState ?? "unknown",
                  meta: `${data.llamaModels?.length ?? 0} models discovered`,
                },
                {
                  label: "NPU",
                  value: data.settings.npu?.status?.processState ?? "unknown",
                  meta: `${data.npuModels?.length ?? 0} models discovered`,
                },
                {
                  label: "Voice",
                  value: data.voiceRuntime?.readiness ?? "unknown",
                  meta: data.voiceRuntime?.selectedModelId ?? "No active voice model",
                },
              ]}
            />
          </NativeCard>
          <SettingsGrid variant="balanced">
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Gateway daemon"
              subtitle="Control the background runtime serving Mission Control."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "State",
                    value: data.daemon?.state ?? "unknown",
                    meta: data.daemon?.running ? "Running" : "Stopped",
                  },
                  {
                    label: "Host",
                    value: data.daemon?.host ?? "n/a",
                    meta: data.daemon?.controllable ? "Controllable" : "Read-only",
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() => void runAndReload(startDaemon, "Gateway daemon start requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <Play size={16} />
                  Start
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(stopDaemon, "Gateway daemon stop requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <Square size={16} />
                  Stop
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(restartDaemon, "Gateway daemon restart requested.")}
                  disabled={!data.daemon?.controllable}
                >
                  <RotateCcw size={16} />
                  Restart
                </NativeButton>
              </SettingsButtonRow>
              {!data.daemon?.controllable && data.daemon?.controlMessage ? (
                <p className="mc-next-settings-help">{data.daemon.controlMessage}</p>
              ) : null}
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="llama.cpp runtime"
              subtitle="Configure and control the local llama.cpp runtime."
            >
              <SettingsFieldGrid>
                <SettingsField label="Base URL">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.baseUrl}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Command">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.command}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, command: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Models root">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.modelsRootPath}
                    onChange={(event) =>
                      setLlamaForm((current) => ({ ...current, modelsRootPath: event.target.value }))
                    }
                  />
                </SettingsField>
                <SettingsField label="Model path">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.modelPath}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, modelPath: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Discovered models" span={2}>
                  <>
                    <select
                      className="mc-next-settings-input"
                      value={selectedDiscoveredModelPath}
                      onChange={(event) => handleDiscoveredModelChange(event.target.value)}
                      disabled={!discoveredLlamaModels.length}
                    >
                      <option value="">
                        {discoveredLlamaModels.length
                          ? `Choose from ${discoveredLlamaModels.length} models under ${llamaForm.modelsRootPath || "the default models root"}`
                          : "No local .gguf models discovered under Models root yet"}
                      </option>
                      {discoveredLlamaModels.map((model) => (
                        <option key={model.filePath} value={model.filePath}>
                          {model.relativePath ?? model.modelId}
                        </option>
                      ))}
                    </select>
                    {selectedDiscoveredModel ? (
                      <p className="mc-next-settings-field-note">
                        {selectedDiscoveredModel.relativePath ?? selectedDiscoveredModel.modelId}
                      </p>
                    ) : null}
                  </>
                </SettingsField>
                <SettingsField label="Alias">
                  <input
                    className="mc-next-settings-input"
                    value={llamaForm.alias}
                    onChange={(event) => setLlamaForm((current) => ({ ...current, alias: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Enabled">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={llamaForm.enabled}
                      onChange={(event) => setLlamaForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enable llama.cpp runtime</span>
                  </label>
                </SettingsField>
                <SettingsField label="Auto start">
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={llamaForm.autoStart}
                      onChange={(event) => setLlamaForm((current) => ({ ...current, autoStart: event.target.checked }))}
                    />
                    <span>Auto-start with the gateway</span>
                  </label>
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() => void runAndReload(saveLlamaSettings, "llama.cpp settings saved.")}
                >
                  <Save size={16} />
                  Save
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() =>
                    void runAndReload(async () => {
                      await saveLlamaSettings();
                      await startLlamaCppRuntime();
                    }, "llama.cpp start requested.")
                  }
                >
                  <Play size={16} />
                  Start
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(stopLlamaCppRuntime, "llama.cpp stop requested.")}
                >
                  <Square size={16} />
                  Stop
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(refreshLlamaCppRuntime, "llama.cpp refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.llamaCpp?.status?.processState ?? "unknown",
                    meta: data.settings.llamaCpp?.status?.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Active model",
                    value: data.settings.llamaCpp?.status?.activeModelId ?? "n/a",
                    meta: data.settings.llamaCpp?.status?.commandSource ?? "source unknown",
                  },
                ]}
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Local acceleration"
              subtitle="NPU sidecar support is retired from the shipped 1.0 runtime."
            >
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() =>
                    void runAndReload(
                      () =>
                        patchSettings({
                          npu: {
                            enabled: false,
                            autoStart: false,
                            sidecarUrl: npuForm.sidecarUrl,
                          },
                        }),
                      "Retired NPU settings normalized.",
                    )
                  }
                >
                  <Save size={16} />
                  Normalize
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() => void runAndReload(refreshNpuRuntime, "NPU refresh requested.")}
                >
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
              <NativeMetricGrid
                items={[
                  {
                    label: "Process",
                    value: data.settings.npu?.status?.processState ?? "unknown",
                    meta: data.settings.npu?.status?.healthy ? "Healthy" : "Needs attention",
                  },
                  {
                    label: "Backend",
                    value: data.settings.npu?.status?.backend ?? "unknown",
                    meta: data.settings.npu?.status?.lastError ?? data.settings.npu?.sidecarUrl,
                  },
                ]}
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Voice runtime"
              subtitle="Install or activate the local voice transcription runtime."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "Readiness",
                    value: data.voiceRuntime?.readiness ?? "unknown",
                    meta: data.voiceRuntime?.provider ?? "whisper.cpp",
                  },
                  {
                    label: "Active model",
                    value: data.voiceRuntime?.selectedModelId ?? "none",
                    meta: `${data.voiceRuntime?.installedModels?.length ?? 0} installed`,
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="default"
                  onClick={() => {
                    const recommended =
                      data.voiceRuntime?.catalog?.find((item) => item.defaultInstall)?.id ??
                      data.voiceRuntime?.catalog?.[0]?.id;
                    void runAndReload(
                      () => installVoiceRuntime(recommended ? { modelId: recommended, activate: true } : {}),
                      "Voice runtime install requested.",
                    );
                  }}
                >
                  <Plus size={16} />
                  Install starter model
                </NativeButton>
                {data.voiceRuntime?.installedModels?.[0] ? (
                  <NativeButton
                    variant="secondary"
                    onClick={() =>
                      void runAndReload(
                        () => selectVoiceRuntimeModel(data.voiceRuntime?.installedModels?.[0]?.modelId ?? ""),
                        "Voice model activated.",
                      )
                    }
                  >
                    <CheckCircle2 size={16} />
                    Activate first installed
                  </NativeButton>
                ) : null}
              </SettingsButtonRow>
              <SettingsActionList
                items={(data.voiceRuntime?.catalog ?? []).slice(0, 8).map((item) => ({
                  label: item.label,
                  description: `${item.languageScope} · ${item.approxSizeLabel}`,
                  meta: item.id,
                  onClick: () =>
                    void runAndReload(() => selectVoiceRuntimeModel(item.id), `Voice model ${item.id} selected.`),
                  actionLabel: data.voiceRuntime?.selectedModelId === item.id ? "Active" : "Use",
                }))}
                emptyLabel="No voice model catalog available."
              />
            </NativeCard>
          </SettingsGrid>
        </SettingsStack>
      ) : null}
    </SettingsSectionShell>
  );
}

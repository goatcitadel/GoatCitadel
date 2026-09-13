import { SettingsChangeStatus, useSettingsChange } from "../use-settings-change";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useMemo, useRef, useState } from "react";
import { CheckCircle2, Play, Plus, RefreshCw, RotateCcw, Save, Square } from "lucide-react";
import type { LlamaCppRuntimeLeaseDiagnostics } from "@goatcitadel/contracts";
import {
  fetchDaemonStatus,
  fetchLlamaCppModels,
  fetchNpuModels,
  fetchSettings,
  fetchVoiceRuntimeStatus,
  installVoiceRuntime,
  isApiRequestError,
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
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { ErrorState, NativeButton, NativeMetricGrid } from "../../primitives";
import { deriveLlamaCppAlias } from "../../SettingsNativePage";
import type { NativeLoadIssue } from "../../shared/native-helpers";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";

const VISUAL_REGRESSION_MODE =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

export function RuntimeSection(props: SettingsSectionProps) {
  const [view, setView] = useState<"daemon" | "llama" | "npu" | "voice" | null>(null);
  const [savingLlama, setSavingLlama] = useState(false);
  const savingLlamaRef = useRef(false);
  const leave = useDraftLeave();
  const llamaRequested = view === "llama";
  const npuRequested = view === "npu";
  const load = useCallback(async () => {
    const settings = await fetchSettings();
    const [daemon, voiceRuntime, llamaModels, npuModels] = await Promise.all([
      nativeLoad("Daemon status", fetchDaemonStatus(), null),
      nativeLoad("Voice runtime", fetchVoiceRuntimeStatus(), null),
      Promise.resolve({ data: { items: [], degraded: false, warning: undefined }, issue: null }),
      Promise.resolve({ data: { items: [] }, issue: null }),
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
  const { loading, error, data: baseData, reload: reloadBase } = useAsyncLoad(load, [load]);
  const llamaModelsLoad = useAsyncLoad(() => llamaRequested && !VISUAL_REGRESSION_MODE ? fetchLlamaCppModels() : Promise.resolve(null), [llamaRequested, baseData?.settings.llamaCpp?.modelsRootPath]);
  const canReadNpuModels = npuRequested && !VISUAL_REGRESSION_MODE && Boolean(baseData?.settings.npu?.enabled && (baseData.settings.npu.status?.healthy || baseData.settings.npu.status?.processState === "running"));
  const npuModelsLoad = useAsyncLoad(() => canReadNpuModels ? fetchNpuModels() : Promise.resolve(null), [canReadNpuModels]);
  const data = useMemo(() => baseData ? { ...baseData, llamaModels: llamaModelsLoad.data?.items ?? [], llamaModelsWarning: llamaModelsLoad.data?.degraded ? llamaModelsLoad.data.warning : undefined, npuModels: npuModelsLoad.data?.items ?? [], issues: [...baseData.issues, ...(llamaModelsLoad.error ? [{ label: "llama.cpp models", message: llamaModelsLoad.error }] : []), ...(npuModelsLoad.error ? [{ label: "NPU models", message: npuModelsLoad.error }] : [])] } : null, [baseData, llamaModelsLoad.data, llamaModelsLoad.error, npuModelsLoad.data, npuModelsLoad.error]);
  const reload = async () => { await Promise.all([reloadBase(), ...(llamaRequested ? [llamaModelsLoad.reload()] : []), ...(canReadNpuModels ? [npuModelsLoad.reload()] : [])]); };
  const [notice, setNotice] = useState<Notice | null>(null);
  const canonicalLlama = { enabled: data?.settings.llamaCpp?.enabled ?? false, autoStart: data?.settings.llamaCpp?.autoStart ?? false, baseUrl: data?.settings.llamaCpp?.baseUrl ?? "", command: data?.settings.llamaCpp?.command ?? "", modelsRootPath: data?.settings.llamaCpp?.modelsRootPath ?? "", modelPath: data?.settings.llamaCpp?.modelPath ?? "", alias: data?.settings.llamaCpp?.alias ?? "" };
  const llamaEditor = useSessionDraft("runtime:system:llama", canonicalLlama, data?.settings.revision, { label: "llama.cpp configuration", active: view === "llama", available: Boolean(data), onSave: () => saveLlamaSettings() });
  const llamaChange = useSettingsChange({ key: llamaEditor.key, operation: "llama_cpp_configuration", matches: (settings, submitted: typeof llamaEditor.value) => Object.entries(submitted).every(([key, value]) => (settings.llamaCpp?.[key as keyof typeof settings.llamaCpp] ?? "") === value), acceptSaved: llamaEditor.acceptSaved, reload });
  const llamaForm = llamaEditor.value;
  const setLlamaForm = llamaEditor.setValue;
  const npuForm = { enabled: false, autoStart: false, sidecarUrl: data?.settings.npu?.sidecarUrl ?? "" };
  const openView = (next: typeof view) => leave.request(() => setView(next), [llamaEditor.key]);
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

  const saveLlamaSettings = async (): Promise<boolean> => {
    if (llamaChange.isPending()) { await llamaChange.refresh(); return false; }
    if (savingLlamaRef.current || llamaEditor.hasRemoteChanges) return false;
    if (!llamaEditor.isDirty) return true;
    if (!data) { setNotice({ tone: "warning", message: "Reload settings before saving llama.cpp changes." }); return false; }
    const submitted = llamaForm;
    savingLlamaRef.current = true; setSavingLlama(true);
    try {
      const updated = await patchSettings({ expectedRevision: Number(llamaEditor.baseRevision ?? data.settings.revision), llamaCpp: buildLlamaSettingsPatch() });
      const clean = llamaChange.receive(updated, submitted, Number(llamaEditor.baseRevision ?? data.settings.revision));
      if (clean) setNotice({ tone: "success", message: "llama.cpp settings saved." });
      await reload();
      return clean;
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        await reload(); setNotice({ tone: "warning", message: "Runtime settings changed elsewhere. Your llama.cpp draft is preserved; review the current settings, then retry." });
      } else setNotice({ tone: "error", message: getErrorMessage(error) });
      return false;
    } finally { savingLlamaRef.current = false; setSavingLlama(false); }
  };

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

  const runAndReload = async (
    operation: () => Promise<unknown>,
    successMessage: string,
    conflictDraft?: "llama" | "npu",
  ) => {
    try {
      const result = await operation();
      if (result === false) return;
      const receipt = result && typeof result === "object" && "changePlanReceipt" in result ? (result as { changePlanReceipt?: Awaited<ReturnType<typeof patchSettings>>["changePlanReceipt"] }).changePlanReceipt : undefined;
      setNotice(receipt && receipt.status !== "completed" && receipt.status !== "applied" ? { tone: "warning", message: `${receipt.summary} Finish the required action in Chat or Approvals (plan ${receipt.planId}).` } : { tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      if (conflictDraft && isApiRequestError(actionError) && actionError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message:
            conflictDraft === "llama"
              ? "Runtime settings changed elsewhere. Your llama.cpp draft is preserved; review the current settings, then retry."
              : "Runtime settings changed elsewhere. Current NPU settings were reloaded; review them, then retry.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  return (
    <SettingsSectionShell
      loading={loading && !data}
      error={error}
      onRetry={reload}
      errorContext={{
        resourceLabel: "Runtime settings",
        unavailableDescription:
          "Mission Control could not reach the Gateway runtime settings owner. Check runtime health, then retry.",
      }}
      errorSecondaryAction={
        error ? (
          <NativeButton
            variant="outline"
            onClick={() => props.navigate({ area: "ops", section: "runtime", theme: props.route.theme })}
          >
            Open Ops Runtime
          </NativeButton>
        ) : undefined
      }
    >
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsChangeStatus change={llamaChange.change} onRefresh={llamaChange.refresh} navigate={props.navigate} route={props.route} />
      {data ? (
        <SettingsStack>
          <RuntimeLoadWarnings
            issues={[
              ...data.issues,
              ...(data.llamaModelsWarning ? [{ label: "llama.cpp models", message: data.llamaModelsWarning }] : []),
            ]}
            onRetry={reload}
            onOpenOps={() => props.navigate({ area: "ops", section: "runtime", theme: props.route.theme })}
          />
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
                  meta: llamaRequested ? `${data.llamaModels?.length ?? 0} models returned` : "Model catalog opens with configuration",
                },
                {
                  label: "NPU",
                  value: data.settings.npu?.status?.processState ?? "unknown",
                  meta: "Retired sidecar compatibility",
                },
                {
                  label: "Voice",
                  value: data.voiceRuntime?.readiness ?? "unknown",
                  meta: data.voiceRuntime?.selectedModelId ?? "No active voice model",
                },
              ]}
            />
          </NativeCard>
          <SettingsButtonRow><NativeButton onClick={() => openView("llama")}>Configure llama.cpp{llamaEditor.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="outline" onClick={() => openView("daemon")}>Gateway controls</NativeButton><NativeButton variant="outline" onClick={() => openView("voice")}>Voice setup</NativeButton><NativeButton variant="outline" onClick={() => openView("npu")}>Legacy acceleration</NativeButton><NativeButton variant="outline" onClick={() => props.navigate({ area: "ops", section: "runtime", theme: props.route.theme })}>Open Ops Runtime</NativeButton></SettingsButtonRow>
          <SettingsStack>
            <DetailInspector open={view === "daemon"} title="Gateway controls" onClose={() => openView(null)}><NativeCard
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
            </NativeCard></DetailInspector>
            {view === "llama" ? <FocusedDetail title="Configure llama.cpp" onClose={() => openView(null)}><NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="llama.cpp runtime"
              subtitle="Configure and control the local llama.cpp runtime."
            >
              {llamaEditor.hasRemoteChanges ? <div role="status"><p>The saved runtime settings changed. Your llama.cpp draft is preserved.</p><details><summary>Current saved runtime configuration</summary><pre>{JSON.stringify(canonicalLlama, null, 2)}</pre></details><NativeButton variant="outline" onClick={llamaEditor.rebaseToCurrent}>Apply draft to current runtime</NativeButton></div> : null}
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
                <SettingsField label="Enabled" group>
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={llamaForm.enabled}
                      onChange={(event) => setLlamaForm((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    <span>Enable llama.cpp runtime</span>
                  </label>
                </SettingsField>
                <SettingsField label="Auto start" group>
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
                  disabled={savingLlama || llamaChange.hasPending || llamaEditor.hasRemoteChanges} onClick={() => void saveLlamaSettings()}
                >
                  <Save size={16} />
                  Save
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  onClick={() =>
                    void runAndReload(
                      async () => {
                        if (!await saveLlamaSettings()) return false;
                        await startLlamaCppRuntime();
                      },
                      "llama.cpp start requested.",
                      "llama",
                    )
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
              <NativeDisclosureCard id="runtime-llama-lifecycle" title="Lifecycle diagnostics"><LlamaCppLeaseDiagnostics diagnostics={data.settings.llamaCpp?.status?.leaseDiagnostics} /></NativeDisclosureCard>
            </NativeCard></FocusedDetail> : null}
            <DetailInspector open={view === "npu"} title="Legacy acceleration" onClose={() => openView(null)}><NativeCard
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
                          expectedRevision: data.settings.revision,
                          npu: {
                            enabled: false,
                            autoStart: false,
                            sidecarUrl: npuForm.sidecarUrl,
                          },
                        }),
                      "Retired NPU settings normalized.",
                      "npu",
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
            </NativeCard></DetailInspector>
            <DetailInspector open={view === "voice"} title="Voice setup" onClose={() => openView(null)}><NativeCard
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
                ariaLabel="Voice model catalog"
                items={(data.voiceRuntime?.catalog ?? []).map((item) => ({
                  label: item.label,
                  description: `${item.languageScope} · ${item.approxSizeLabel}`,
                  meta: item.id,
                  onClick: () =>
                    void runAndReload(() => selectVoiceRuntimeModel(item.id), `Voice model ${item.id} selected.`),
                  actionLabel: data.voiceRuntime?.selectedModelId === item.id ? "Active" : "Use",
                }))}
                emptyLabel="No voice model catalog available."
              />
            </NativeCard></DetailInspector>
          </SettingsStack>
        </SettingsStack>
      ) : null}
      {leave.dialog}
    </SettingsSectionShell>
  );
}

function areRuntimeFormsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function LlamaCppLeaseDiagnostics({ diagnostics }: { diagnostics?: LlamaCppRuntimeLeaseDiagnostics }) {
  if (!diagnostics) {
    return (
      <p className="mc-next-settings-help" role="status">
        Lease lifecycle diagnostics are unavailable from this Gateway version.
      </p>
    );
  }

  const evidence = buildLlamaCppLeaseEvidence(diagnostics);
  return (
    <div role="group" aria-label="llama.cpp lease lifecycle" aria-live="polite">
      <NativeMetricGrid
        items={[
          {
            label: "Lifecycle",
            value: formatLifecycleLabel(diagnostics.state),
            meta: diagnostics.idleDeadline
              ? `Idle shutdown ${formatRuntimeEvidenceTime(diagnostics.idleDeadline)}`
              : "No idle shutdown scheduled",
          },
          {
            label: "Ownership",
            value: formatLifecycleLabel(diagnostics.ownership),
            meta: diagnostics.ownership === "external" ? "Observed, never managed" : "Runtime process owner",
          },
          {
            label: "Active leases",
            value: String(diagnostics.activeLeaseCount),
            meta: formatLeasePurposes(diagnostics),
          },
          {
            label: "Persistent demand",
            value: formatPersistentDemand(diagnostics),
            meta: diagnostics.activeLeaseCount > 0 ? "Transient leases are tracked separately" : "No transient leases",
          },
        ]}
      />
      <SettingsActionList
        ariaLabel="llama.cpp lease diagnostics"
        items={evidence}
        emptyLabel="No probe, exit, or restart evidence recorded yet."
        maxHeight="min(24vh, 12rem)"
      />
    </div>
  );
}

function buildLlamaCppLeaseEvidence(diagnostics: LlamaCppRuntimeLeaseDiagnostics) {
  const evidence = diagnostics.evidence;
  return [
    evidence.lastProbe
      ? {
          id: "llamacpp-last-probe",
          label: "Latest probe",
          description: evidence.lastProbe.healthy ? "Healthy endpoint response" : "Endpoint probe failed",
          meta: formatRuntimeEvidenceTime(evidence.lastProbe.at),
        }
      : null,
    evidence.lastExit
      ? {
          id: "llamacpp-last-exit",
          label: "Latest process exit",
          description: evidence.lastExit.unexpected ? "Unexpected owned-process exit" : "Expected process exit",
          meta: [
            typeof evidence.lastExit.code === "number" ? `code ${evidence.lastExit.code}` : null,
            evidence.lastExit.signal ? `signal ${evidence.lastExit.signal}` : null,
            formatRuntimeEvidenceTime(evidence.lastExit.at),
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : null,
    evidence.lastRestart
      ? {
          id: "llamacpp-last-restart",
          label: "Latest restart",
          description: formatLifecycleLabel(evidence.lastRestart.outcome),
          meta: formatRuntimeEvidenceTime(evidence.lastRestart.at),
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
}

function formatLeasePurposes(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  return diagnostics.purposes.length > 0
    ? diagnostics.purposes.map((item) => `${formatLifecycleLabel(item.purpose)} ×${item.count}`).join(", ")
    : "No active purposes";
}

function formatPersistentDemand(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  const active = Object.entries(diagnostics.persistentDemand)
    .filter(([, enabled]) => enabled)
    .map(([source]) => formatLifecycleLabel(source));
  return active.length > 0 ? active.join(", ") : "None";
}

function formatLifecycleLabel(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatRuntimeEvidenceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function RuntimeLoadWarnings({
  issues,
  onRetry,
  onOpenOps,
}: {
  issues: NativeLoadIssue[];
  onRetry: () => void;
  onOpenOps: () => void;
}) {
  if (issues.length === 0) {
    return null;
  }
  const subsystemLabel = issues.map((issue) => issue.label).join(", ");
  return (
    <ErrorState
      title="Runtime settings unavailable"
      description={`${subsystemLabel} could not be read from the Gateway. The remaining runtime settings are still available.`}
      technicalDetails={issues.map((issue) => `${issue.label}: ${issue.message}`).join("\n")}
      primaryAction={
        <NativeButton variant="secondary" onClick={() => void onRetry()}>
          <RefreshCw size={16} />
          Retry
        </NativeButton>
      }
      secondaryActions={
        <NativeButton variant="outline" onClick={onOpenOps}>
          Open Ops Runtime
        </NativeButton>
      }
    />
  );
}

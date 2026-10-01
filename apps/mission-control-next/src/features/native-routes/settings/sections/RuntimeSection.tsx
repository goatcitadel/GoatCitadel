import { SettingsChangeStatus } from "../use-settings-change";
import { useManagedRuntimeSettings } from "../use-managed-runtime-settings";
import { ManagedRuntimeReview } from "../ManagedRuntimeReview";
import { VoiceRuntimeControls } from "../VoiceRuntimeControls";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useMemo, useState } from "react";
import { Play, RefreshCw, RotateCcw, Save, Square } from "lucide-react";
import { LlamaCppLeaseDiagnostics } from "./LlamaCppLeaseDiagnostics";
import {
  fetchDaemonStatus,
  fetchLlamaCppModels,
  fetchNpuModels,
  fetchSettings,
  fetchVoiceRuntimeStatus,
  isApiRequestError,
  patchSettings,
  refreshLlamaCppRuntime,
  refreshNpuRuntime,
  restartDaemon,
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
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { ErrorState, NativeButton, NativeMetricGrid } from "../../primitives";
import type { NativeLoadIssue } from "../../shared/native-helpers";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";

const VISUAL_REGRESSION_MODE =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

export function RuntimeSection(props: SettingsSectionProps) {
  const [view, setView] = useState<"daemon" | "llama" | "npu" | "voice" | null>(null);
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
  const llamaModelsLoad = useAsyncLoad(
    () => (llamaRequested && !VISUAL_REGRESSION_MODE ? fetchLlamaCppModels() : Promise.resolve(null)),
    [llamaRequested, baseData?.settings.llamaCpp?.modelsRootPath],
  );
  const canReadNpuModels =
    npuRequested &&
    !VISUAL_REGRESSION_MODE &&
    Boolean(
      baseData?.settings.npu?.enabled &&
      (baseData.settings.npu.status?.healthy || baseData.settings.npu.status?.processState === "running"),
    );
  const npuModelsLoad = useAsyncLoad(
    () => (canReadNpuModels ? fetchNpuModels() : Promise.resolve(null)),
    [canReadNpuModels],
  );
  const data = useMemo(
    () =>
      baseData
        ? {
            ...baseData,
            llamaModels: llamaModelsLoad.data?.items ?? [],
            llamaModelsWarning: llamaModelsLoad.data?.degraded ? llamaModelsLoad.data.warning : undefined,
            npuModels: npuModelsLoad.data?.items ?? [],
            issues: [
              ...baseData.issues,
              ...(llamaModelsLoad.error ? [{ label: "llama.cpp models", message: llamaModelsLoad.error }] : []),
              ...(npuModelsLoad.error ? [{ label: "NPU models", message: npuModelsLoad.error }] : []),
            ],
          }
        : null,
    [baseData, llamaModelsLoad.data, llamaModelsLoad.error, npuModelsLoad.data, npuModelsLoad.error],
  );
  const reload = async () => {
    await Promise.all([
      reloadBase(),
      ...(llamaRequested ? [llamaModelsLoad.reload()] : []),
      ...(canReadNpuModels ? [npuModelsLoad.reload()] : []),
    ]);
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const llamaControl = useManagedRuntimeSettings({
    settings: data?.settings,
    available: Boolean(data) && !error && !loading,
    active: view === "llama",
    reload,
  });
  const { draft: llamaEditor, change: llamaChange } = llamaControl;
  const canonicalLlama = llamaControl.current;
  const llamaForm = llamaEditor.value;
  const setLlamaForm = llamaEditor.setValue;
  const npuForm = { enabled: false, autoStart: false, sidecarUrl: data?.settings.npu?.sidecarUrl ?? "" };
  const openView = (next: typeof view) => leave.request(() => setView(next), [llamaEditor.key]);

  const runAndReload = async (
    operation: () => Promise<unknown>,
    successMessage: string,
    conflictDraft?: "llama" | "npu",
  ) => {
    try {
      const result = await operation();
      if (result === false) return;
      const receipt =
        result && typeof result === "object" && "changePlanReceipt" in result
          ? (result as { changePlanReceipt?: Awaited<ReturnType<typeof patchSettings>>["changePlanReceipt"] })
              .changePlanReceipt
          : undefined;
      setNotice(
        receipt && receipt.status !== "completed" && receipt.status !== "applied"
          ? {
              tone: "warning",
              message: `${receipt.summary} Finish the required action in Chat or Approvals (plan ${receipt.planId}).`,
            }
          : { tone: "success", message: successMessage },
      );
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
      <SettingsChangeStatus
        change={llamaChange.change}
        onRefresh={llamaChange.refresh}
        navigate={props.navigate}
        route={props.route}
      />
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
                  meta: `${data.settings.llamaCpp?.managementMode ?? (data.settings.llamaCpp?.autoStart ? "managed" : "external")} · ${data.settings.llamaCpp?.status?.leaseDiagnostics?.ownership ?? "none"}`,
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
          <SettingsButtonRow>
            <NativeButton
              onClick={() =>
                props.navigate({ area: "settings", section: "onboarding", view: "llamacpp", theme: props.route.theme })
              }
            >
              Set up llama.cpp
            </NativeButton>
            <NativeButton variant="outline" onClick={() => openView("llama")}>
              Configure llama.cpp{llamaEditor.isDirty ? " · Unsaved" : ""}
            </NativeButton>
            <NativeButton variant="outline" onClick={() => openView("daemon")}>
              Gateway controls
            </NativeButton>
            <NativeButton variant="outline" onClick={() => openView("voice")}>
              Voice setup
            </NativeButton>
            <NativeButton variant="outline" onClick={() => openView("npu")}>
              Legacy acceleration
            </NativeButton>
            <NativeButton
              variant="outline"
              onClick={() => props.navigate({ area: "ops", section: "runtime", theme: props.route.theme })}
            >
              Open Ops Runtime
            </NativeButton>
          </SettingsButtonRow>
          <SettingsStack>
            <DetailInspector open={view === "daemon"} title="Gateway controls" onClose={() => openView(null)}>
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
            </DetailInspector>
            {view === "llama" ? (
              <FocusedDetail title="Configure llama.cpp" onClose={() => openView(null)}>
                <NativeCard
                  density="compact"
                  className="mc-next-settings-panel"
                  title="llama.cpp runtime"
                  subtitle="Configure and control the local llama.cpp runtime."
                >
                  {llamaEditor.hasRemoteChanges ? (
                    <div role="status">
                      <p>The saved runtime settings changed. Your llama.cpp draft is preserved.</p>
                      <details>
                        <summary>Current saved runtime configuration</summary>
                        <pre>{JSON.stringify(canonicalLlama, null, 2)}</pre>
                      </details>
                      <NativeButton variant="outline" onClick={llamaEditor.rebaseToCurrent}>
                        Apply draft to current runtime
                      </NativeButton>
                    </div>
                  ) : null}
                  <p>
                    Mode:{" "}
                    {data.settings.llamaCpp?.managementMode ??
                      (data.settings.llamaCpp?.autoStart ? "managed" : "external")}{" "}
                    · Ownership: {data.settings.llamaCpp?.status?.leaseDiagnostics?.ownership ?? "none"}
                  </p>
                  {(data.settings.llamaCpp?.managementMode ??
                    (data.settings.llamaCpp?.autoStart ? "managed" : "external")) === "managed" ? (
                    <>
                      <SettingsFieldGrid>
                        <SettingsField label="Base URL">
                          <input
                            className="mc-next-settings-input"
                            disabled={llamaControl.locked}
                            value={llamaForm.baseUrl}
                            onChange={(event) =>
                              setLlamaForm((current) => ({ ...current, baseUrl: event.target.value }))
                            }
                          />
                        </SettingsField>
                        <SettingsField label="Command">
                          <input
                            className="mc-next-settings-input"
                            readOnly
                            value={data.settings.llamaCpp?.command ?? ""}
                          />
                        </SettingsField>
                        <SettingsField label="Models root">
                          <input
                            className="mc-next-settings-input"
                            readOnly
                            value={data.settings.llamaCpp?.modelsRootPath ?? ""}
                          />
                        </SettingsField>
                        <SettingsField label="Model path">
                          <input
                            className="mc-next-settings-input"
                            readOnly
                            value={data.settings.llamaCpp?.modelPath ?? ""}
                          />
                        </SettingsField>
                        <SettingsField label="Saved launch paths" span={2}>
                          <p>
                            Command and model paths are read-only here. Change them through Set up llama.cpp, which
                            validates the selected files.
                          </p>
                        </SettingsField>
                        <SettingsField label="Alias">
                          <input
                            className="mc-next-settings-input"
                            disabled={llamaControl.locked}
                            value={llamaForm.alias}
                            onChange={(event) => setLlamaForm((current) => ({ ...current, alias: event.target.value }))}
                          />
                        </SettingsField>
                        <SettingsField label="Enabled" group>
                          <label className="mc-next-settings-toggle">
                            <input
                              type="checkbox"
                              disabled={llamaControl.locked}
                              checked={llamaForm.enabled}
                              onChange={(event) =>
                                setLlamaForm((current) => ({ ...current, enabled: event.target.checked }))
                              }
                            />
                            <span>Enable llama.cpp runtime</span>
                          </label>
                        </SettingsField>
                        <SettingsField label="Auto start" group>
                          <label className="mc-next-settings-toggle">
                            <input
                              type="checkbox"
                              disabled={llamaControl.locked}
                              checked={llamaForm.autoStart}
                              onChange={(event) =>
                                setLlamaForm((current) => ({ ...current, autoStart: event.target.checked }))
                              }
                            />
                            <span>Auto-start with the gateway</span>
                          </label>
                        </SettingsField>
                      </SettingsFieldGrid>
                      <SettingsButtonRow>
                        <NativeButton
                          variant="default"
                          disabled={!llamaControl.canReview}
                          onClick={() => void llamaControl.requestReview()}
                        >
                          <Save size={16} />
                          Save
                        </NativeButton>
                        <NativeButton
                          variant="secondary"
                          disabled={llamaControl.locked || !llamaControl.managed || llamaEditor.hasRemoteChanges}
                          onClick={() =>
                            void runAndReload(
                              async () => {
                                if (!(await llamaControl.requestReview())) return false;
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
                      {llamaControl.notice ? <p role="status">{llamaControl.notice}</p> : null}
                      {llamaControl.uncertain ? <p role="alert">{llamaControl.uncertain}</p> : null}
                      {llamaControl.inputError ? <p role="alert">{llamaControl.inputError}</p> : null}
                    </>
                  ) : (
                    <p>
                      GoatCitadel observes this external server and does not use saved launch paths or process controls.
                      Change the URL or Chat model in{" "}
                      <NativeButton
                        variant="ghost"
                        onClick={() =>
                          props.navigate({
                            area: "settings",
                            section: "onboarding",
                            view: "llamacpp",
                            theme: props.route.theme,
                          })
                        }
                      >
                        Get started
                      </NativeButton>
                      .
                    </p>
                  )}
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
                        meta:
                          (data.settings.llamaCpp?.managementMode ??
                            (data.settings.llamaCpp?.autoStart ? "managed" : "external")) === "managed"
                            ? (data.settings.llamaCpp?.status?.commandSource ?? "source unknown")
                            : "External endpoint",
                      },
                    ]}
                  />
                  <NativeDisclosureCard id="runtime-llama-lifecycle" title="Lifecycle diagnostics">
                    <LlamaCppLeaseDiagnostics diagnostics={data.settings.llamaCpp?.status?.leaseDiagnostics} />
                  </NativeDisclosureCard>
                </NativeCard>
              </FocusedDetail>
            ) : null}
            <DetailInspector open={view === "npu"} title="Legacy acceleration" onClose={() => openView(null)}>
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
              </NativeCard>
            </DetailInspector>
            <DetailInspector open={view === "voice"} title="Voice setup" onClose={() => openView(null)}>
              <NativeCard
                density="compact"
                className="mc-next-settings-panel"
                title="Voice runtime"
                subtitle="Install or activate the local voice transcription runtime."
              >
                <VoiceRuntimeControls
                  status={data.voiceRuntime}
                  available={!loading && !error && Boolean(data.voiceRuntime)}
                  active={view === "voice"}
                  reload={reload}
                />
              </NativeCard>
            </DetailInspector>
          </SettingsStack>
        </SettingsStack>
      ) : null}
      <ManagedRuntimeReview control={llamaControl} />
      {leave.dialog}
    </SettingsSectionShell>
  );
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

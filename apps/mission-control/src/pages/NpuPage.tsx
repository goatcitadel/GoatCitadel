import { useCallback, useEffect, useRef, useState } from "react";
import {
  evaluateUiChangeRisk,
  fetchNpuModels,
  fetchNpuStatus,
  fetchSettings,
  patchSettings,
  refreshNpuRuntime,
  startNpuRuntime,
  stopNpuRuntime,
  type RuntimeSettingsResponse,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSwitch } from "../components/ui";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";

interface NpuPageProps {
  settings?: RuntimeSettingsResponse | null;
}

type NpuStatusRecord = Awaited<ReturnType<typeof fetchNpuStatus>>;
type NpuModelRecord = Awaited<ReturnType<typeof fetchNpuModels>>["items"][number];

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function NpuPage({ settings }: NpuPageProps) {
  const [status, setStatus] = useState<NpuStatusRecord | null>(null);
  const [models, setModels] = useState<NpuModelRecord[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [npuEnabled, setNpuEnabled] = useState(settings?.npu.enabled ?? false);
  const [autoStart, setAutoStart] = useState(settings?.npu.autoStart ?? false);
  const [sidecarUrl, setSidecarUrl] = useState(settings?.npu.sidecarUrl ?? "http://127.0.0.1:11440");
  const [baseline, setBaseline] = useState<{ enabled: boolean; autoStart: boolean; sidecarUrl: string } | null>(null);
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const [changeReview, setChangeReview] = useState<{
    overall: "safe" | "warning" | "critical";
    items: Array<{ field: string; level: "safe" | "warning" | "critical"; hint?: string }>;
  }>({
    overall: "safe",
    items: [],
  });
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const riskDebounceRef = useRef<number | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);

  const loadModels = async (statusRes: NpuStatusRecord): Promise<void> => {
    if (!canLoadNpuModels(statusRes)) {
      setModels([]);
      setModelCatalogError(null);
      return;
    }
    try {
      const modelRes = await fetchNpuModels();
      setModels(modelRes.items);
      setModelCatalogError(null);
    } catch (err) {
      setModels([]);
      setModelCatalogError((err as Error).message);
    }
  };

  const load = useCallback((options?: { background?: boolean }): Promise<void> => {
    const background = options?.background ?? false;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    setError(null);
    const settingsPromise = background ? Promise.resolve<RuntimeSettingsResponse | null>(null) : fetchSettings();
    return Promise.all([fetchNpuStatus(), settingsPromise])
      .then(async ([statusRes, settingsRes]) => {
        setStatus(statusRes);
        if (settingsRes) {
          setNpuEnabled(settingsRes.npu.enabled);
          setAutoStart(settingsRes.npu.autoStart);
          setSidecarUrl(settingsRes.npu.sidecarUrl);
          setBaseline({
            enabled: settingsRes.npu.enabled,
            autoStart: settingsRes.npu.autoStart,
            sidecarUrl: settingsRes.npu.sidecarUrl,
          });
        }
        await loadModels(statusRes);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        if (background) {
          setIsRefreshing(false);
        } else {
          setIsInitialLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "npu",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  useEffect(() => {
    if (!baseline) {
      return;
    }
    if (riskDebounceRef.current) {
      window.clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    riskDebounceRef.current = window.setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "npu",
          changes: [
            { field: "npu.enabled", from: baseline.enabled, to: npuEnabled },
            { field: "npu.autoStart", from: baseline.autoStart, to: autoStart },
            { field: "npu.sidecarUrl", from: baseline.sidecarUrl, to: sidecarUrl },
          ],
        },
        { signal: controller.signal },
      )
        .then((result) => {
          setChangeReview({
            overall: result.overall,
            items: result.items.map((item) => ({
              field: item.field,
              level: item.level,
              hint: item.hint,
            })),
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setChangeReview({
            overall: "warning",
            items: [
              {
                field: "npu",
                level: "warning",
                hint: "Unable to fetch risk hints from gateway.",
              },
            ],
          });
        });
    }, 400);
    return () => {
      if (riskDebounceRef.current) {
        window.clearTimeout(riskDebounceRef.current);
        riskDebounceRef.current = null;
      }
      riskAbortRef.current?.abort();
    };
  }, [baseline, npuEnabled, autoStart, sidecarUrl]);

  const onStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startNpuRuntime();
      setStatus(next);
      await loadModels(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await stopNpuRuntime();
      setStatus(next);
      setModels([]);
      setModelCatalogError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await refreshNpuRuntime();
      setStatus(next);
      await loadModels(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSaveConfig = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving NPU configuration.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await patchSettings({
        npu: {
          enabled: npuEnabled,
          autoStart,
          sidecarUrl: sidecarUrl.trim(),
        },
      });
      setNpuEnabled(next.npu.enabled);
      setAutoStart(next.npu.autoStart);
      setSidecarUrl(next.npu.sidecarUrl);
      setBaseline({
        enabled: next.npu.enabled,
        autoStart: next.npu.autoStart,
        sidecarUrl: next.npu.sidecarUrl,
      });
      const refreshed = await fetchNpuStatus();
      setStatus(refreshed);
      await loadModels(refreshed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blockConfigSave = changeReview.overall === "critical" && !criticalConfirmed;

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Local Acceleration"
        title={pageCopy.npu.title}
        subtitle={pageCopy.npu.subtitle}
        hint="Use this page to configure the local NPU sidecar, inspect runtime health, and verify the on-device model catalog."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone={npuEnabled ? "success" : "muted"}>{npuEnabled ? "Enabled" : "Disabled"}</StatusChip>
            <StatusChip tone={status?.healthy ? "success" : "warning"}>
              {status?.healthy ? "Healthy" : "Needs attention"}
            </StatusChip>
            <StatusChip tone="muted">{models.length} models</StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="npu"
        what={pageCopy.npu.guide?.what ?? ""}
        when={pageCopy.npu.guide?.when ?? ""}
        mostCommonAction={pageCopy.npu.guide?.mostCommonAction}
        actions={pageCopy.npu.guide?.actions ?? []}
        terms={pageCopy.npu.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing NPU status...</p> : null}
        {busy ? <p className="status-banner">Applying NPU action...</p> : null}
        <FieldHelp>
          Most operators only need this page when they intentionally want local on-device inference. Review the risk
          panel before changing runtime settings.
        </FieldHelp>
      </div>
      <ChangeReviewPanel
        title="NPU Configuration Risk"
        overall={changeReview.overall}
        items={changeReview.items}
        requireCriticalConfirm
        criticalConfirmed={criticalConfirmed}
        onCriticalConfirmChange={setCriticalConfirmed}
      />

      <Panel
        title="Configuration"
        subtitle="Local sidecar settings that control whether the NPU runtime is enabled and how it starts."
      >
        <div className="controls-row">
          <GCSwitch id="npuEnabled" checked={npuEnabled} onCheckedChange={setNpuEnabled} label="Enabled" />
          <GCSwitch id="npuAutoStart" checked={autoStart} onCheckedChange={setAutoStart} label="Auto start" />
        </div>
        <label className="field" htmlFor="npuSidecarUrl">
          Sidecar URL
          <input id="npuSidecarUrl" value={sidecarUrl} onChange={(event) => setSidecarUrl(event.target.value)} />
        </label>
        <FieldHelp>
          Point this at the local NPU sidecar you expect GoatCitadel to use. Leave it on loopback unless you
          intentionally run the accelerator on another machine.
        </FieldHelp>
        <ActionButton label="Save NPU Config" onClick={() => void onSaveConfig()} disabled={busy || blockConfigSave} />
      </Panel>

      <Panel
        title="Runtime Control"
        subtitle="Start, stop, and refresh the sidecar while keeping the current runtime status visible."
        actions={
          status ? (
            <div className="workflow-summary-strip">
              <StatusChip tone={status.processState === "running" ? "success" : "warning"}>
                {status.processState}
              </StatusChip>
              <StatusChip tone="muted">{status.backend}</StatusChip>
            </div>
          ) : null
        }
      >
        <div className="row-actions">
          <ActionButton label="Start" onClick={() => void onStart()} disabled={busy} />
          <ActionButton label="Stop" onClick={() => void onStop()} disabled={busy} />
          <ActionButton label="Refresh" onClick={() => void onRefresh()} disabled={busy} />
        </div>
        {settings ? (
          <p className="field-help">
            Config: enabled={String(settings.npu.enabled)}, autoStart={String(settings.npu.autoStart)}, sidecar=
            {settings.npu.sidecarUrl}
          </p>
        ) : null}
      </Panel>

      {isInitialLoading ? <p>Loading NPU state...</p> : null}

      {status ? (
        <Panel title="Status" subtitle="Current sidecar runtime state, active model, and capability details.">
          <p>Process: {status.processState}</p>
          <p>Desired: {status.desiredState}</p>
          <p>Healthy: {status.healthy ? "yes" : "no"}</p>
          <p>Backend: {status.backend}</p>
          <p>Sidecar URL: {status.sidecarUrl}</p>
          <p>PID: {status.sidecarPid ?? "-"}</p>
          <p>Active model: {status.activeModelId ?? "-"}</p>
          <p>Updated: {new Date(status.updatedAt).toLocaleString()}</p>
          {status.lastError ? <p className="error">Last error: {status.lastError}</p> : null}
          <h4>Capability</h4>
          <p>Windows ARM64: {status.capability.isWindowsArm64 ? "yes" : "no"}</p>
          <p>ONNX Runtime: {status.capability.onnxRuntimeAvailable ? "yes" : "no"}</p>
          <p>ONNX Runtime GenAI: {status.capability.onnxRuntimeGenAiAvailable ? "yes" : "no"}</p>
          <p>QNN Execution Provider: {status.capability.qnnExecutionProviderAvailable ? "yes" : "no"}</p>
          <p>Supported: {status.capability.supported ? "yes" : "no"}</p>
          {status.capability.details.length > 0 ? (
            <ul>
              {status.capability.details.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Models" subtitle="Discovered model catalog exposed by the sidecar.">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Label</th>
              <th>Family</th>
              <th>Source</th>
              <th>Default</th>
              <th>Enabled</th>
              <th>Requires QNN</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>
            {!canLoadNpuModels(status) ? (
              <tr>
                <td colSpan={8}>Model catalog is unavailable until the sidecar is running and healthy.</td>
              </tr>
            ) : modelCatalogError ? (
              <tr>
                <td colSpan={8} className="error">
                  {modelCatalogError}
                </td>
              </tr>
            ) : models.length === 0 ? (
              <tr>
                <td colSpan={8}>No models reported by sidecar.</td>
              </tr>
            ) : (
              models.map((model) => (
                <tr key={model.modelId}>
                  <td>{model.modelId}</td>
                  <td>{model.label}</td>
                  <td>{model.family}</td>
                  <td>{model.source}</td>
                  <td>{model.default ? "yes" : "no"}</td>
                  <td>{model.enabled ? "yes" : "no"}</td>
                  <td>{model.requiresQnn ? "yes" : "no"}</td>
                  <td>{model.contextWindow ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

function canLoadNpuModels(status: NpuStatusRecord | null): boolean {
  return Boolean(status && status.processState === "running" && status.healthy);
}

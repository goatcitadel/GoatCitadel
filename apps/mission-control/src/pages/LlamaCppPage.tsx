import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLlmChatCompletion,
  evaluateUiChangeRisk,
  fetchLlamaCppAdvisor,
  fetchLlamaCppModels,
  fetchLlamaCppStatus,
  fetchSettings,
  patchSettings,
  refreshLlamaCppRuntime,
  startLlamaCppRuntime,
  stopLlamaCppRuntime,
  type RuntimeSettingsResponse,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch } from "../components/ui";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

interface LlamaCppPageProps {
  settings?: RuntimeSettingsResponse | null;
}

type LlamaCppStatusRecord = Awaited<ReturnType<typeof fetchLlamaCppStatus>>;
type LlamaCppModelRecord = Awaited<ReturnType<typeof fetchLlamaCppModels>>["items"][number];
type LlamaCppAdvisorRecord = Awaited<ReturnType<typeof fetchLlamaCppAdvisor>>;

type DraftBaseline = {
  enabled: boolean;
  autoStart: boolean;
  baseUrl: string;
  command: string;
  modelPath: string;
  alias: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function LlamaCppPage({ settings }: LlamaCppPageProps) {
  const [status, setStatus] = useState<LlamaCppStatusRecord | null>(null);
  const [models, setModels] = useState<LlamaCppModelRecord[]>([]);
  const [advisor, setAdvisor] = useState<LlamaCppAdvisorRecord | null>(null);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(settings?.llamaCpp.enabled ?? false);
  const [autoStart, setAutoStart] = useState(settings?.llamaCpp.autoStart ?? false);
  const [baseUrl, setBaseUrl] = useState(settings?.llamaCpp.baseUrl ?? "http://127.0.0.1:8080/v1");
  const [command, setCommand] = useState(settings?.llamaCpp.command ?? "llama-server");
  const [modelPath, setModelPath] = useState(settings?.llamaCpp.modelPath ?? "");
  const [alias, setAlias] = useState(settings?.llamaCpp.alias ?? "gemma-4");
  const [extraArgsText, setExtraArgsText] = useState((settings?.llamaCpp.extraArgs ?? []).join("\n"));
  const [ctxSize, setCtxSize] = useState(toOptionalString(settings?.llamaCpp.ctxSize));
  const [threads, setThreads] = useState(toOptionalString(settings?.llamaCpp.threads));
  const [gpuLayers, setGpuLayers] = useState(toOptionalString(settings?.llamaCpp.gpuLayers));
  const [parallel, setParallel] = useState(toOptionalString(settings?.llamaCpp.parallel));
  const [batchSize, setBatchSize] = useState(toOptionalString(settings?.llamaCpp.batchSize));
  const [ubatchSize, setUbatchSize] = useState(toOptionalString(settings?.llamaCpp.ubatchSize));
  const [flashAttentionMode, setFlashAttentionMode] = useState<"auto" | "on" | "off">(
    settings?.llamaCpp.flashAttention === true ? "on" : settings?.llamaCpp.flashAttention === false ? "off" : "auto",
  );
  const [testResponse, setTestResponse] = useState("");
  const [baseline, setBaseline] = useState<DraftBaseline | null>(null);
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

  const loadModels = useCallback(async (statusRes: LlamaCppStatusRecord): Promise<void> => {
    if (!canLoadModels(statusRes)) {
      setModels([]);
      setModelCatalogError(null);
      return;
    }
    try {
      const modelRes = await fetchLlamaCppModels();
      setModels(modelRes.items);
      setModelCatalogError(null);
    } catch (err) {
      setModels([]);
      setModelCatalogError((err as Error).message);
    }
  }, []);

  const hydrateSettings = useCallback((settingsRes: RuntimeSettingsResponse) => {
    setEnabled(settingsRes.llamaCpp.enabled);
    setAutoStart(settingsRes.llamaCpp.autoStart);
    setBaseUrl(settingsRes.llamaCpp.baseUrl);
    setCommand(settingsRes.llamaCpp.command);
    setModelPath(settingsRes.llamaCpp.modelPath ?? "");
    setAlias(settingsRes.llamaCpp.alias);
    setExtraArgsText((settingsRes.llamaCpp.extraArgs ?? []).join("\n"));
    setCtxSize(toOptionalString(settingsRes.llamaCpp.ctxSize));
    setThreads(toOptionalString(settingsRes.llamaCpp.threads));
    setGpuLayers(toOptionalString(settingsRes.llamaCpp.gpuLayers));
    setParallel(toOptionalString(settingsRes.llamaCpp.parallel));
    setBatchSize(toOptionalString(settingsRes.llamaCpp.batchSize));
    setUbatchSize(toOptionalString(settingsRes.llamaCpp.ubatchSize));
    setFlashAttentionMode(
      settingsRes.llamaCpp.flashAttention === true
        ? "on"
        : settingsRes.llamaCpp.flashAttention === false
          ? "off"
          : "auto",
    );
    setBaseline({
      enabled: settingsRes.llamaCpp.enabled,
      autoStart: settingsRes.llamaCpp.autoStart,
      baseUrl: settingsRes.llamaCpp.baseUrl,
      command: settingsRes.llamaCpp.command,
      modelPath: settingsRes.llamaCpp.modelPath ?? "",
      alias: settingsRes.llamaCpp.alias,
    });
  }, []);

  const load = useCallback(
    (options?: { background?: boolean }): Promise<void> => {
      const background = options?.background ?? false;
      if (background) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }
      setError(null);
      const settingsPromise = background ? Promise.resolve<RuntimeSettingsResponse | null>(null) : fetchSettings();
      return Promise.all([fetchLlamaCppStatus(), settingsPromise])
        .then(async ([statusRes, settingsRes]) => {
          setStatus(statusRes);
          if (settingsRes) {
            hydrateSettings(settingsRes);
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
    },
    [hydrateSettings, loadModels],
  );

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "llamaCpp",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20_000,
      pollIntervalMs: 15_000,
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
          pageId: "llamacpp",
          changes: [
            { field: "llamaCpp.enabled", from: baseline.enabled, to: enabled },
            { field: "llamaCpp.autoStart", from: baseline.autoStart, to: autoStart },
            { field: "llamaCpp.baseUrl", from: baseline.baseUrl, to: baseUrl },
            { field: "llamaCpp.command", from: baseline.command, to: command },
            { field: "llamaCpp.modelPath", from: baseline.modelPath, to: modelPath },
            { field: "llamaCpp.alias", from: baseline.alias, to: alias },
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
                field: "llamaCpp",
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
  }, [alias, autoStart, baseUrl, baseline, command, enabled, modelPath]);

  const commandPreview = useMemo(() => {
    const args = [
      "-m",
      modelPath || "<model.gguf>",
      "--host",
      baseUrlToHost(baseUrl),
      "--port",
      baseUrlToPort(baseUrl),
      "--alias",
      alias || "gemma-4",
      ...appendOptionalFlag("-c", ctxSize),
      ...appendOptionalFlag("-t", threads),
      ...appendOptionalFlag("-ngl", gpuLayers),
      ...appendOptionalFlag("-np", parallel),
      ...appendOptionalFlag("-b", batchSize),
      ...appendOptionalFlag("-ub", ubatchSize),
      ...appendOptionalFlashAttention(flashAttentionMode),
      ...parseExtraArgs(extraArgsText),
    ];
    return [command || "llama-server", ...args].map(quoteSegment).join(" ");
  }, [
    alias,
    baseUrl,
    batchSize,
    command,
    ctxSize,
    extraArgsText,
    flashAttentionMode,
    gpuLayers,
    modelPath,
    parallel,
    threads,
    ubatchSize,
  ]);

  const onStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startLlamaCppRuntime();
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
      const next = await stopLlamaCppRuntime();
      setStatus(next);
      await loadModels(next);
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
      const next = await refreshLlamaCppRuntime();
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
      setError("Confirm critical changes before saving llama.cpp configuration.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await patchSettings({
        llamaCpp: {
          enabled,
          autoStart,
          baseUrl: baseUrl.trim(),
          command: command.trim(),
          extraArgs: parseExtraArgs(extraArgsText),
          modelPath: modelPath.trim(),
          alias: alias.trim(),
          ctxSize: parseOptionalNumberForPatch(ctxSize),
          threads: parseOptionalNumberForPatch(threads),
          gpuLayers: parseOptionalNumberForPatch(gpuLayers),
          parallel: parseOptionalNumberForPatch(parallel),
          batchSize: parseOptionalNumberForPatch(batchSize),
          ubatchSize: parseOptionalNumberForPatch(ubatchSize),
          flashAttention: flashAttentionMode === "auto" ? null : flashAttentionMode === "on",
        },
      });
      hydrateSettings(next);
      const refreshed = await fetchLlamaCppStatus();
      setStatus(refreshed);
      await loadModels(refreshed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onAdvisor = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await fetchLlamaCppAdvisor({
        modelPath: modelPath.trim() || undefined,
        modelId: alias.trim() || undefined,
      });
      setAdvisor(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onApplyAdvisor = () => {
    if (!advisor) {
      return;
    }
    setCtxSize(toOptionalString(advisor.recommended.ctxSize));
    setThreads(toOptionalString(advisor.recommended.threads));
    setGpuLayers(toOptionalString(advisor.recommended.gpuLayers));
    setParallel(toOptionalString(advisor.recommended.parallel));
    setBatchSize(toOptionalString(advisor.recommended.batchSize));
    setUbatchSize(toOptionalString(advisor.recommended.ubatchSize));
    setFlashAttentionMode(
      advisor.recommended.flashAttention === true
        ? "on"
        : advisor.recommended.flashAttention === false
          ? "off"
          : "auto",
    );
  };

  const onRunTest = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await createLlmChatCompletion({
        providerId: "llamacpp",
        model: (status?.activeModelId ?? alias.trim()) || "gemma-4",
        messages: [{ role: "user", content: "Say hello from GoatCitadel's llama.cpp runtime." }],
        max_tokens: 80,
      });
      const content = response.choices?.[0]?.message?.content ?? "";
      setTestResponse(content);
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
        eyebrow="Local Runtime"
        title="llama.cpp"
        subtitle="Manage a local llama-server process, inspect health, and keep a conservative Gemma 4 launch profile ready."
        hint="Use this page when you want GoatCitadel to talk directly to a loopback llama.cpp server or manage one for you."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone={enabled ? "success" : "muted"}>{enabled ? "Enabled" : "Disabled"}</StatusChip>
            <StatusChip tone={status?.healthy ? "success" : "warning"}>
              {status?.healthy ? "Healthy" : "Needs attention"}
            </StatusChip>
            <StatusChip tone="muted">{models.length} models</StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="llamacpp"
        what="Configure GoatCitadel's llama.cpp runtime, inspect the active loopback server, and keep a safe launch profile for local GGUF models."
        when="Use this when you want to run a local model directly through llama-server instead of Ollama or LM Studio."
        mostCommonAction="Set the model path and alias, save the runtime config, start the server, then refresh models."
        actions={[
          "Save loopback runtime settings before trying to start the process.",
          "Run the advisor once to get conservative ctx, thread, and batching suggestions.",
          "Use the discovered model list before running prompt packs so the exact model id is pinned.",
        ]}
        terms={[
          { term: "Alias", meaning: "Stable model id exposed by llama-server through /v1/models, such as gemma-4." },
          {
            term: "GPU layers",
            meaning: "Number of layers offloaded to VRAM. Leave blank for llama.cpp auto-fit or set 0 for CPU-only.",
          },
          {
            term: "Flash Attention",
            meaning: "Optional performance toggle that should stay on auto unless the advisor strongly suggests it.",
          },
        ]}
      />

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing llama.cpp status...</p> : null}
        {busy ? <p className="status-banner">Applying llama.cpp action...</p> : null}
        <FieldHelp>
          This page stays conservative by default. Save the config first, then use the runtime controls and advisor only
          when you are ready to run a local GGUF model.
        </FieldHelp>
      </div>

      <ChangeReviewPanel
        title="llama.cpp Configuration Risk"
        overall={changeReview.overall}
        items={changeReview.items}
        requireCriticalConfirm
        criticalConfirmed={criticalConfirmed}
        onCriticalConfirmChange={setCriticalConfirmed}
      />

      <Panel title="Configuration" subtitle="Loopback runtime settings and launch defaults for llama-server.">
        <div className="controls-row">
          <GCSwitch id="llamaCppEnabled" checked={enabled} onCheckedChange={setEnabled} label="Enabled" />
          <GCSwitch id="llamaCppAutoStart" checked={autoStart} onCheckedChange={setAutoStart} label="Auto start" />
        </div>
        <label className="field" htmlFor="llamaCppBaseUrl">
          Base URL
          <input id="llamaCppBaseUrl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label className="field" htmlFor="llamaCppCommand">
          Command
          <input id="llamaCppCommand" value={command} onChange={(event) => setCommand(event.target.value)} />
        </label>
        <label className="field" htmlFor="llamaCppModelPath">
          Model Path
          <input id="llamaCppModelPath" value={modelPath} onChange={(event) => setModelPath(event.target.value)} />
        </label>
        <label className="field" htmlFor="llamaCppAlias">
          Alias
          <input id="llamaCppAlias" value={alias} onChange={(event) => setAlias(event.target.value)} />
        </label>
        <FieldHelp>
          Keep the base URL on loopback unless you intentionally expose llama.cpp somewhere else. Use an alias like{" "}
          <code>gemma-4</code> so Prompt Lab and chat runs stay stable.
        </FieldHelp>
        <ActionButton
          label="Save llama.cpp Config"
          onClick={() => void onSaveConfig()}
          disabled={busy || blockConfigSave}
        />
      </Panel>

      <Panel title="Runtime Control" subtitle="Start, stop, refresh, and smoke-test the current llama.cpp target.">
        <div className="row-actions">
          <ActionButton label="Start" onClick={() => void onStart()} disabled={busy} />
          <ActionButton label="Stop" onClick={() => void onStop()} disabled={busy} />
          <ActionButton label="Refresh" onClick={() => void onRefresh()} disabled={busy} />
          <ActionButton
            label="Refresh Models"
            onClick={() => void loadModels(status ?? createEmptyStatus(baseUrl))}
            disabled={busy}
          />
          <ActionButton label="Run Test Prompt" onClick={() => void onRunTest()} disabled={busy} />
        </div>
        <FieldHelp>
          The smoke test uses provider id <code>llamacpp</code>. If you have not added that provider in Settings &gt;
          Models yet, apply the llama.cpp preset there first.
        </FieldHelp>
        <p className="field-help">
          Command preview: <code>{commandPreview}</code>
        </p>
        {testResponse ? <p className="field-help">Test response: {testResponse}</p> : null}
      </Panel>

      {isInitialLoading ? <p>Loading llama.cpp state...</p> : null}

      {status ? (
        <Panel
          title="Status"
          subtitle="Current server health, command resolution, and the active model id GoatCitadel sees."
          actions={
            <div className="workflow-summary-strip">
              <StatusChip tone={status.processState === "running" ? "success" : "warning"}>
                {status.processState}
              </StatusChip>
              <StatusChip tone="muted">{status.commandSource ?? "missing"}</StatusChip>
            </div>
          }
        >
          <p>Desired: {status.desiredState}</p>
          <p>Healthy: {status.healthy ? "yes" : "no"}</p>
          <p>PID: {status.pid ?? "-"}</p>
          <p>Command: {status.command ?? "-"}</p>
          <p>Base URL: {status.baseUrl}</p>
          <p>Active model: {status.activeModelId ?? "-"}</p>
          <p>Updated: {new Date(status.updatedAt).toLocaleString()}</p>
          {status.lastError ? <p className="error">Last error: {status.lastError}</p> : null}
        </Panel>
      ) : null}

      <Panel
        title="Advanced Launch"
        subtitle="Optional tuning flags. Leave fields blank when you want llama.cpp auto-fit behavior."
      >
        <div className="controls-row">
          <label className="field" htmlFor="llamaCppCtxSize">
            Context Size
            <input id="llamaCppCtxSize" value={ctxSize} onChange={(event) => setCtxSize(event.target.value)} />
          </label>
          <label className="field" htmlFor="llamaCppThreads">
            Threads
            <input id="llamaCppThreads" value={threads} onChange={(event) => setThreads(event.target.value)} />
          </label>
          <label className="field" htmlFor="llamaCppGpuLayers">
            GPU Layers
            <input id="llamaCppGpuLayers" value={gpuLayers} onChange={(event) => setGpuLayers(event.target.value)} />
          </label>
        </div>
        <div className="controls-row">
          <label className="field" htmlFor="llamaCppParallel">
            Parallel Slots
            <input id="llamaCppParallel" value={parallel} onChange={(event) => setParallel(event.target.value)} />
          </label>
          <label className="field" htmlFor="llamaCppBatchSize">
            Batch Size
            <input id="llamaCppBatchSize" value={batchSize} onChange={(event) => setBatchSize(event.target.value)} />
          </label>
          <label className="field" htmlFor="llamaCppUbatchSize">
            Ubatch Size
            <input id="llamaCppUbatchSize" value={ubatchSize} onChange={(event) => setUbatchSize(event.target.value)} />
          </label>
        </div>
        <div className="controls-row">
          <label htmlFor="llamaCppFlashAttention">Flash Attention</label>
          <GCSelect
            id="llamaCppFlashAttention"
            value={flashAttentionMode}
            onChange={(value) => setFlashAttentionMode(value as "auto" | "on" | "off")}
            options={[
              { value: "auto", label: "Auto" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </div>
        <label className="field" htmlFor="llamaCppExtraArgs">
          Extra Args
          <textarea
            id="llamaCppExtraArgs"
            value={extraArgsText}
            onChange={(event) => setExtraArgsText(event.target.value)}
            rows={5}
          />
        </label>
        <FieldHelp>
          Enter one extra argument per line. Use this only when the structured fields above are not enough.
        </FieldHelp>
      </Panel>

      <Panel
        title="Hardware Advisor"
        subtitle="Read machine telemetry and get a conservative starting point for this model."
      >
        <div className="row-actions">
          <ActionButton label="Run Advisor" onClick={() => void onAdvisor()} disabled={busy} />
          <ActionButton label="Apply Recommendation" onClick={onApplyAdvisor} disabled={!advisor} />
        </div>
        {advisor ? (
          <div className="stack-sm">
            <p>
              Host: {advisor.profile.platform}/{advisor.profile.arch} · logical CPUs {advisor.profile.cpuCoresLogical} ·
              RAM {(advisor.profile.systemRamBytes / 1024 ** 3).toFixed(1)} GiB
            </p>
            <p>
              GPUs:{" "}
              {advisor.profile.gpus.length > 0
                ? advisor.profile.gpus
                    .map(
                      (gpu) => `${gpu.name}${gpu.vramBytes ? ` (${(gpu.vramBytes / 1024 ** 3).toFixed(1)} GiB)` : ""}`,
                    )
                    .join(", ")
                : "none detected"}
            </p>
            <p>
              Recommended: ctx {advisor.recommended.ctxSize ?? "auto"} · threads {advisor.recommended.threads ?? "auto"}{" "}
              · gpu layers {advisor.recommended.gpuLayers ?? "auto"} · parallel {advisor.recommended.parallel ?? "auto"}{" "}
              · batch {advisor.recommended.batchSize ?? "auto"} · ubatch {advisor.recommended.ubatchSize ?? "auto"} ·
              flash attn{" "}
              {advisor.recommended.flashAttention === true
                ? "on"
                : advisor.recommended.flashAttention === false
                  ? "off"
                  : "auto"}
            </p>
            {advisor.observedModelBytes ? (
              <p>Observed model size: {(advisor.observedModelBytes / 1024 ** 3).toFixed(2)} GiB</p>
            ) : null}
            {advisor.warnings.length > 0 ? (
              <ul>
                {advisor.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="field-help">
            Run the advisor after setting a model path if you want model-size-aware guidance.
          </p>
        )}
      </Panel>

      <Panel title="Models" subtitle="Discovered model ids from the current llama.cpp server.">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Owner</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {!canLoadModels(status) ? (
              <tr>
                <td colSpan={3}>Model catalog is unavailable until the server is healthy.</td>
              </tr>
            ) : modelCatalogError ? (
              <tr>
                <td colSpan={3} className="error">
                  {modelCatalogError}
                </td>
              </tr>
            ) : models.length === 0 ? (
              <tr>
                <td colSpan={3}>No models reported by llama.cpp.</td>
              </tr>
            ) : (
              models.map((model) => (
                <tr key={model.modelId}>
                  <td>{model.modelId}</td>
                  <td>{model.ownedBy ?? "-"}</td>
                  <td>{model.created ? new Date(model.created * 1000).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

function canLoadModels(status: LlamaCppStatusRecord | null): boolean {
  return Boolean(status?.healthy);
}

function parseOptionalNumberForPatch(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toOptionalString(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseExtraArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendOptionalFlag(flag: string, value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? [flag, trimmed] : [];
}

function appendOptionalFlashAttention(mode: "auto" | "on" | "off"): string[] {
  return mode === "auto" ? [] : ["--flash-attn", mode];
}

function quoteSegment(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function baseUrlToHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.replace(/\/v1$/i, "")).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function baseUrlToPort(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.replace(/\/v1$/i, ""));
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "8080";
  }
}

function createEmptyStatus(baseUrl: string): LlamaCppStatusRecord {
  return {
    enabled: false,
    desiredState: "stopped",
    processState: "stopped",
    baseUrl,
    healthy: false,
    updatedAt: new Date().toISOString(),
  };
}

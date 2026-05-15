/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelLlamaCppHuggingFaceDownload,
  createLlmChatCompletion,
  detectLlamaCppInstall,
  evaluateUiChangeRisk,
  fetchLlamaCppHuggingFaceDownload,
  fetchLlamaCppAdvisor,
  fetchLlamaCppModels,
  fetchLlamaCppStatus,
  fetchSettings,
  patchSettings,
  refreshLlamaCppRuntime,
  startLlamaCppHuggingFaceDownload,
  startLlamaCppRuntime,
  stopLlamaCppRuntime,
  type LlamaCppHuggingFaceDownloadStatus,
  type LlamaCppInstallDetection,
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

const DEFAULT_LLAMACPP_ALIAS = "gemma-4-local";
const DEFAULT_LLAMACPP_REASONING_LINES = ["--reasoning", "off"].join("\n");
const DEFAULT_TEXT_PROFILE = "text-default";
const LLAMACPP_PROFILE_STORAGE_KEY = "goatcitadel.llamacpp.saved-profiles.v1";
const LLAMACPP_DOWNLOAD_HISTORY_STORAGE_KEY = "goatcitadel.llamacpp.download-history.v1";

type DraftBaseline = {
  enabled: boolean;
  autoStart: boolean;
  baseUrl: string;
  command: string;
  modelsRootPath: string;
  modelPath: string;
  alias: string;
};

type LlamaCppProfilePresetId = "text-default" | "text-long" | "multimodal";

type SavedLlamaCppProfile = {
  savedAt: string;
  enabled: boolean;
  autoStart: boolean;
  baseUrl: string;
  command: string;
  modelsRootPath: string;
  modelPath: string;
  alias: string;
  extraArgsText: string;
  ctxSize: string;
  threads: string;
  gpuLayers: string;
  parallel: string;
  batchSize: string;
  ubatchSize: string;
  flashAttentionMode: "auto" | "on" | "off";
};

type LlamaCppSettingsPatch = NonNullable<Parameters<typeof patchSettings>[0]["llamaCpp"]>;

type RecentLlamaCppDownload = {
  repo: string;
  alias: string;
  modelPath: string;
  mmprojPath?: string;
  modelBytes?: number;
  mmprojBytes?: number;
  completedAt: string;
};

export function isAbortError(error: unknown): boolean {
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
  const [modelsRootPath, setModelsRootPath] = useState(settings?.llamaCpp.modelsRootPath ?? "");
  const [modelPath, setModelPath] = useState(settings?.llamaCpp.modelPath ?? "");
  const [alias, setAlias] = useState(settings?.llamaCpp.alias ?? DEFAULT_LLAMACPP_ALIAS);
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
  const [setupMode, setSetupMode] = useState<"beginner" | "advanced">("beginner");
  const [profilePreset, setProfilePreset] = useState<LlamaCppProfilePresetId>(DEFAULT_TEXT_PROFILE);
  const [savedProfiles, setSavedProfiles] = useState<Partial<Record<LlamaCppProfilePresetId, SavedLlamaCppProfile>>>(
    {},
  );
  const [recentDownloads, setRecentDownloads] = useState<RecentLlamaCppDownload[]>([]);
  const [installDetection, setInstallDetection] = useState<LlamaCppInstallDetection | null>(null);
  const [hfRepo, setHfRepo] = useState("");
  const [hfFilename, setHfFilename] = useState("");
  const [hfMmprojFilename, setHfMmprojFilename] = useState("");
  const [hfSha256, setHfSha256] = useState("");
  const [hfMmprojSha256, setHfMmprojSha256] = useState("");
  const [hfDownloadStatus, setHfDownloadStatus] = useState<LlamaCppHuggingFaceDownloadStatus | null>(null);
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
    setModelsRootPath(settingsRes.llamaCpp.modelsRootPath ?? "");
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
      modelsRootPath: settingsRes.llamaCpp.modelsRootPath ?? "",
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

  useEffect(() => {
    setSavedProfiles(readSavedLlamaCppProfiles());
    setRecentDownloads(readRecentLlamaCppDownloads());
  }, []);

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
    if (!hfDownloadStatus?.jobId) {
      return;
    }
    if (hfDownloadStatus.status !== "queued" && hfDownloadStatus.status !== "running") {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchLlamaCppHuggingFaceDownload(hfDownloadStatus.jobId)
        .then((next) => {
          setHfDownloadStatus(next);
          if (next.status === "completed") {
            if (next.modelPath) {
              setModelPath(next.modelPath);
            }
            setAlias(next.alias);
            if (next.mmprojPath) {
              setExtraArgsText((current) =>
                formatExtraArgs(upsertFlagValue(parseExtraArgs(current), "--mmproj", next.mmprojPath!)),
              );
            }
            if (next.modelPath) {
              const updatedHistory = upsertRecentLlamaCppDownload(readRecentLlamaCppDownloads(), {
                repo: next.repo,
                alias: next.alias,
                modelPath: next.modelPath,
                mmprojPath: next.mmprojPath,
                modelBytes: next.modelBytes,
                mmprojBytes: next.mmprojBytes,
                completedAt: next.completedAt ?? next.updatedAt,
              });
              writeRecentLlamaCppDownloads(updatedHistory);
              setRecentDownloads(updatedHistory);
            }
          }
          if (next.status === "failed") {
            setError(next.error ?? "llama.cpp download failed.");
          }
          if (next.status === "cancelled") {
            setError(null);
          }
        })
        .catch((err) => {
          setError((err as Error).message);
        });
    }, 1200);

    return () => window.clearInterval(interval);
  }, [hfDownloadStatus?.jobId, hfDownloadStatus?.status]);

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
            { field: "llamaCpp.modelsRootPath", from: baseline.modelsRootPath, to: modelsRootPath },
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
  }, [alias, autoStart, baseUrl, baseline, command, enabled, modelPath, modelsRootPath]);

  const commandPreview = useMemo(() => {
    const args = [
      "-m",
      modelPath || "<model.gguf>",
      "--host",
      baseUrlToHost(baseUrl),
      "--port",
      baseUrlToPort(baseUrl),
      "--alias",
      alias || DEFAULT_LLAMACPP_ALIAS,
      ...appendOptionalFlag("-c", ctxSize),
      ...appendOptionalFlag("-t", threads),
      ...appendOptionalFlag("-ngl", gpuLayers),
      ...appendOptionalFlag("-np", parallel),
      ...appendOptionalFlag("-b", batchSize),
      ...appendOptionalFlag("-ub", ubatchSize),
      ...appendOptionalFlashAttention(flashAttentionMode),
      ...ensureReasoningDefault(parseExtraArgs(extraArgsText)),
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

  const persistLlamaCppConfig = async (patch: LlamaCppSettingsPatch): Promise<void> => {
    const next = await patchSettings({
      llamaCpp: patch,
    });
    hydrateSettings(next);
    const refreshed = await fetchLlamaCppStatus();
    setStatus(refreshed);
    await loadModels(refreshed);
  };

  const buildCurrentLlamaCppPatch = (): LlamaCppSettingsPatch => ({
    enabled,
    autoStart,
    baseUrl: baseUrl.trim(),
    command: command.trim(),
    extraArgs: parseExtraArgs(extraArgsText),
    modelsRootPath: modelsRootPath.trim(),
    modelPath: modelPath.trim(),
    alias: alias.trim(),
    ctxSize: parseOptionalNumberForPatch(ctxSize),
    threads: parseOptionalNumberForPatch(threads),
    gpuLayers: parseOptionalNumberForPatch(gpuLayers),
    parallel: parseOptionalNumberForPatch(parallel),
    batchSize: parseOptionalNumberForPatch(batchSize),
    ubatchSize: parseOptionalNumberForPatch(ubatchSize),
    flashAttention: flashAttentionMode === "auto" ? null : flashAttentionMode === "on",
  });

  const applySavedProfileToState = (saved: SavedLlamaCppProfile) => {
    setEnabled(saved.enabled);
    setAutoStart(saved.autoStart);
    setBaseUrl(saved.baseUrl);
    setCommand(saved.command);
    setModelsRootPath(saved.modelsRootPath);
    setModelPath(saved.modelPath);
    setAlias(saved.alias);
    setExtraArgsText(saved.extraArgsText);
    setCtxSize(saved.ctxSize);
    setThreads(saved.threads);
    setGpuLayers(saved.gpuLayers);
    setParallel(saved.parallel);
    setBatchSize(saved.batchSize);
    setUbatchSize(saved.ubatchSize);
    setFlashAttentionMode(saved.flashAttentionMode);
  };

  const onSaveConfig = async () => {
    if (changeReview.overall === "critical" && !criticalConfirmed) {
      setError("Confirm critical changes before saving llama.cpp configuration.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persistLlamaCppConfig(buildCurrentLlamaCppPatch());
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

  const onApplyRecommendedProfile = () => {
    setEnabled(true);
    setBaseUrl("http://127.0.0.1:8080/v1");
    setCommand((current) => current.trim() || "llama-server");
    setAlias(DEFAULT_LLAMACPP_ALIAS);
    setParallel("1");
    if (profilePreset === "multimodal") {
      setCtxSize("8192");
      setBatchSize("512");
      setUbatchSize("256");
    } else if (profilePreset === "text-long") {
      setCtxSize("49152");
      setBatchSize("1024");
      setUbatchSize("512");
    } else {
      setCtxSize("40960");
      setBatchSize("1024");
      setUbatchSize("512");
    }
    setFlashAttentionMode("on");
    setExtraArgsText(DEFAULT_LLAMACPP_REASONING_LINES);
    setInstallDetection(null);
  };

  const onSaveCurrentPreset = () => {
    const nextProfiles = {
      ...savedProfiles,
      [profilePreset]: {
        savedAt: new Date().toISOString(),
        enabled,
        autoStart,
        baseUrl,
        command,
        modelsRootPath,
        modelPath,
        alias,
        extraArgsText,
        ctxSize,
        threads,
        gpuLayers,
        parallel,
        batchSize,
        ubatchSize,
        flashAttentionMode,
      },
    } satisfies Partial<Record<LlamaCppProfilePresetId, SavedLlamaCppProfile>>;
    setSavedProfiles(nextProfiles);
    writeSavedLlamaCppProfiles(nextProfiles);
  };

  const onLoadSavedPreset = () => {
    const saved = savedProfiles[profilePreset];
    if (!saved) {
      return;
    }
    applySavedProfileToState(saved);
  };

  const onLoadSavedPresetAndSave = async () => {
    const saved = savedProfiles[profilePreset];
    if (!saved) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applySavedProfileToState(saved);
      await persistLlamaCppConfig({
        enabled: saved.enabled,
        autoStart: saved.autoStart,
        baseUrl: saved.baseUrl.trim(),
        command: saved.command.trim(),
        extraArgs: parseExtraArgs(saved.extraArgsText),
        modelPath: saved.modelPath.trim(),
        modelsRootPath: saved.modelsRootPath.trim(),
        alias: saved.alias.trim(),
        ctxSize: parseOptionalNumberForPatch(saved.ctxSize),
        threads: parseOptionalNumberForPatch(saved.threads),
        gpuLayers: parseOptionalNumberForPatch(saved.gpuLayers),
        parallel: parseOptionalNumberForPatch(saved.parallel),
        batchSize: parseOptionalNumberForPatch(saved.batchSize),
        ubatchSize: parseOptionalNumberForPatch(saved.ubatchSize),
        flashAttention: saved.flashAttentionMode === "auto" ? null : saved.flashAttentionMode === "on",
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDetectInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await detectLlamaCppInstall();
      setInstallDetection(next);
      if (next.command) {
        setCommand(next.command);
      }
      setBaseUrl(next.recommendedBaseUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDownloadModel = async () => {
    setError(null);
    try {
      const next = await startLlamaCppHuggingFaceDownload({
        repo: hfRepo.trim(),
        filename: hfFilename.trim(),
        alias: alias.trim() || undefined,
        mmprojFilename: hfMmprojFilename.trim() || undefined,
        sha256: hfSha256.trim() || undefined,
        mmprojSha256: hfMmprojSha256.trim() || undefined,
      });
      setHfDownloadStatus(next);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onCancelDownload = async () => {
    if (!hfDownloadStatus?.jobId) {
      return;
    }
    setError(null);
    try {
      const next = await cancelLlamaCppHuggingFaceDownload(hfDownloadStatus.jobId);
      setHfDownloadStatus(next);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onUseRecentDownload = (item: RecentLlamaCppDownload, includeMmproj = false) => {
    setModelPath(item.modelPath);
    setAlias(item.alias);
    if (includeMmproj && item.mmprojPath) {
      setExtraArgsText((current) =>
        formatExtraArgs(upsertFlagValue(parseExtraArgs(current), "--mmproj", item.mmprojPath!)),
      );
    }
  };

  const onRunTest = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await createLlmChatCompletion({
        providerId: "llamacpp",
        model: (status?.activeModelId ?? alias.trim()) || DEFAULT_LLAMACPP_ALIAS,
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
          {
            term: "Alias",
            meaning: "Stable model id exposed by llama-server through /v1/models, such as gemma-4-local.",
          },
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

      <Panel
        title="Quick Setup"
        subtitle="Start with a stable single-model profile, then opt into the deeper knobs only when you actually need them."
      >
        <div className="controls-row">
          <label htmlFor="llamaCppSetupMode">Mission Control Mode</label>
          <GCSelect
            id="llamaCppSetupMode"
            value={setupMode}
            onChange={(value) => setSetupMode(value as "beginner" | "advanced")}
            options={[
              { value: "beginner", label: "Beginner" },
              { value: "advanced", label: "Advanced" },
            ]}
          />
        </div>
        <div className="controls-row">
          <label htmlFor="llamaCppProfilePreset">Profile Preset</label>
          <GCSelect
            id="llamaCppProfilePreset"
            value={profilePreset}
            onChange={(value) => setProfilePreset(value as "text-default" | "text-long" | "multimodal")}
            options={[
              { value: "text-default", label: "Text Default" },
              { value: "text-long", label: "Text Long Context" },
              { value: "multimodal", label: "Multimodal" },
            ]}
          />
        </div>
        <div className="row-actions">
          <ActionButton label="Apply Recommended Profile" onClick={onApplyRecommendedProfile} disabled={busy} />
          <ActionButton
            label="Load Saved Preset"
            onClick={onLoadSavedPreset}
            disabled={!savedProfiles[profilePreset]}
          />
          <ActionButton
            label="Apply Preset + Save"
            onClick={() => void onLoadSavedPresetAndSave()}
            disabled={!savedProfiles[profilePreset] || busy}
          />
          <ActionButton label="Save Current to Preset" onClick={onSaveCurrentPreset} disabled={busy} />
          <ActionButton label="Detect Local Install" onClick={() => void onDetectInstall()} disabled={busy} />
        </div>
        <FieldHelp>
          {profilePreset === "multimodal" ? (
            <>
              Multimodal preset keeps loopback defaults but drops to a lower context window for safer image/mmproj work.
              Treat it as a separate runtime profile from your normal text server.
            </>
          ) : profilePreset === "text-long" ? (
            <>
              Long-context text preset keeps the same single-slot policy but moves to <code>49152</code> context for
              manual escalation on this machine.
            </>
          ) : (
            <>
              Recommended first profile: loopback only, alias <code>{DEFAULT_LLAMACPP_ALIAS}</code>, ctx{" "}
              <code>40960</code>, <code>parallel=1</code>, <code>batch=1024</code>, <code>ubatch=512</code>, flash
              attention on, and <code>--reasoning off</code>.
            </>
          )}
        </FieldHelp>
        {savedProfiles[profilePreset] ? (
          <p className="field-help">
            Saved preset available for <code>{profilePreset}</code>. Last updated{" "}
            {new Date(savedProfiles[profilePreset]!.savedAt).toLocaleString()}.
          </p>
        ) : (
          <p className="field-help">
            No saved preset yet for <code>{profilePreset}</code>. Save the current form once you have a text or
            multimodal setup you want to revisit quickly.
          </p>
        )}
        {installDetection ? (
          <p className="field-help">
            {installDetection.found
              ? `Detected ${installDetection.command ?? "llama-server"} from ${installDetection.source}.`
              : "No local llama-server install was detected automatically."}
            {installDetection.version ? ` Version: ${installDetection.version}.` : ""}
          </p>
        ) : null}
      </Panel>

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
        <label className="field" htmlFor="llamaCppModelsRootPath">
          Models Root Path
          <input
            id="llamaCppModelsRootPath"
            value={modelsRootPath}
            onChange={(event) => setModelsRootPath(event.target.value)}
            placeholder="C:\\models"
          />
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
          <code>{DEFAULT_LLAMACPP_ALIAS}</code> so Prompt Lab and chat runs stay stable.
        </FieldHelp>
        <FieldHelp>
          Models Root Path is the default folder GoatCitadel uses for managed llama.cpp downloads. Model Path still
          points to the exact GGUF file you want to launch.
        </FieldHelp>
        <ActionButton
          label="Save llama.cpp Config"
          onClick={() => void onSaveConfig()}
          disabled={busy || blockConfigSave}
        />
      </Panel>

      <Panel
        title="Hugging Face Model Pull"
        subtitle="Download a specific GGUF into GoatCitadel's managed llama.cpp model folder and fill the local config from the result."
      >
        <label className="field" htmlFor="llamaCppHfRepo">
          Hugging Face Repo
          <input id="llamaCppHfRepo" value={hfRepo} onChange={(event) => setHfRepo(event.target.value)} />
        </label>
        <label className="field" htmlFor="llamaCppHfFilename">
          GGUF Filename
          <input id="llamaCppHfFilename" value={hfFilename} onChange={(event) => setHfFilename(event.target.value)} />
        </label>
        <label className="field" htmlFor="llamaCppHfMmprojFilename">
          Optional mmproj Filename
          <input
            id="llamaCppHfMmprojFilename"
            value={hfMmprojFilename}
            onChange={(event) => setHfMmprojFilename(event.target.value)}
          />
        </label>
        {setupMode === "advanced" ? (
          <>
            <label className="field" htmlFor="llamaCppHfSha256">
              Optional GGUF SHA256
              <input id="llamaCppHfSha256" value={hfSha256} onChange={(event) => setHfSha256(event.target.value)} />
            </label>
            <label className="field" htmlFor="llamaCppHfMmprojSha256">
              Optional mmproj SHA256
              <input
                id="llamaCppHfMmprojSha256"
                value={hfMmprojSha256}
                onChange={(event) => setHfMmprojSha256(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <div className="row-actions">
          <ActionButton
            label="Download GGUF"
            onClick={() => void onDownloadModel()}
            disabled={
              busy ||
              !hfRepo.trim() ||
              !hfFilename.trim() ||
              hfDownloadStatus?.status === "queued" ||
              hfDownloadStatus?.status === "running"
            }
          />
          <ActionButton
            label="Cancel Download"
            onClick={() => void onCancelDownload()}
            disabled={hfDownloadStatus?.status !== "queued" && hfDownloadStatus?.status !== "running"}
          />
        </div>
        <FieldHelp>
          This workflow pulls <code>https://huggingface.co/owner/name/resolve/main/file.gguf</code> into your llama.cpp
          models root, then nests the repo name underneath it. If you provide SHA256 values, GoatCitadel verifies them
          and deletes the partial file on mismatch.
        </FieldHelp>
        {hfDownloadStatus ? (
          <div className="stack-sm">
            <p>
              Download job <code>{hfDownloadStatus.jobId}</code>: {hfDownloadStatus.status} ({hfDownloadStatus.stage})
            </p>
            <div className="llamacpp-progress-stack">
              <label className="field-help" htmlFor="llamaCppModelDownloadProgress">
                Model progress
              </label>
              <progress
                id="llamaCppModelDownloadProgress"
                className="llamacpp-progress"
                value={hfDownloadStatus.totalBytes ? hfDownloadStatus.bytesDownloaded : undefined}
                max={hfDownloadStatus.totalBytes ?? undefined}
              />
            </div>
            <p>
              Model progress: {formatProgress(hfDownloadStatus.bytesDownloaded, hfDownloadStatus.totalBytes)}
              {hfDownloadStatus.expectedSha256 ? " with checksum verification." : "."}
            </p>
            {hfDownloadStatus.mmprojFilename ? (
              <>
                <div className="llamacpp-progress-stack">
                  <label className="field-help" htmlFor="llamaCppMmprojDownloadProgress">
                    mmproj progress
                  </label>
                  <progress
                    id="llamaCppMmprojDownloadProgress"
                    className="llamacpp-progress"
                    value={
                      hfDownloadStatus.mmprojTotalBytes ? (hfDownloadStatus.mmprojBytesDownloaded ?? 0) : undefined
                    }
                    max={hfDownloadStatus.mmprojTotalBytes ?? undefined}
                  />
                </div>
                <p>
                  mmproj progress:{" "}
                  {formatProgress(hfDownloadStatus.mmprojBytesDownloaded ?? 0, hfDownloadStatus.mmprojTotalBytes)}
                </p>
              </>
            ) : null}
            {hfDownloadStatus.modelPath && hfDownloadStatus.modelBytes ? (
              <p>
                Model ready at <code>{hfDownloadStatus.modelPath}</code> ({formatGiB(hfDownloadStatus.modelBytes)} GiB).
              </p>
            ) : null}
            {hfDownloadStatus.mmprojPath && hfDownloadStatus.mmprojBytes ? (
              <p>
                mmproj ready at <code>{hfDownloadStatus.mmprojPath}</code> ({formatGiB(hfDownloadStatus.mmprojBytes)}{" "}
                GiB).
              </p>
            ) : null}
            {hfDownloadStatus.error ? <p className="error">{hfDownloadStatus.error}</p> : null}
          </div>
        ) : null}
        {recentDownloads.length > 0 ? (
          <div className="stack-sm">
            <p className="field-help">Recent imports</p>
            <table className="gc-data-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Alias</th>
                  <th>Completed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {recentDownloads.map((item) => (
                  <tr key={`${item.modelPath}:${item.completedAt}`}>
                    <td>{item.repo}</td>
                    <td>{item.alias}</td>
                    <td>{new Date(item.completedAt).toLocaleString()}</td>
                    <td className="actions">
                      <div className="row-actions">
                        <ActionButton label="Use Model" onClick={() => onUseRecentDownload(item, false)} />
                        <ActionButton
                          label="Use With mmproj"
                          onClick={() => onUseRecentDownload(item, true)}
                          disabled={!item.mmprojPath}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
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

      {setupMode === "advanced" ? (
        <>
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
                <input
                  id="llamaCppGpuLayers"
                  value={gpuLayers}
                  onChange={(event) => setGpuLayers(event.target.value)}
                />
              </label>
            </div>
            <div className="controls-row">
              <label className="field" htmlFor="llamaCppParallel">
                Parallel Slots
                <input id="llamaCppParallel" value={parallel} onChange={(event) => setParallel(event.target.value)} />
              </label>
              <label className="field" htmlFor="llamaCppBatchSize">
                Batch Size
                <input
                  id="llamaCppBatchSize"
                  value={batchSize}
                  onChange={(event) => setBatchSize(event.target.value)}
                />
              </label>
              <label className="field" htmlFor="llamaCppUbatchSize">
                Ubatch Size
                <input
                  id="llamaCppUbatchSize"
                  value={ubatchSize}
                  onChange={(event) => setUbatchSize(event.target.value)}
                />
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
                  Host: {advisor.profile.platform}/{advisor.profile.arch} · logical CPUs{" "}
                  {advisor.profile.cpuCoresLogical} · RAM {(advisor.profile.systemRamBytes / 1024 ** 3).toFixed(1)} GiB
                </p>
                <p>
                  GPUs:{" "}
                  {advisor.profile.gpus.length > 0
                    ? advisor.profile.gpus
                        .map(
                          (gpu) =>
                            `${gpu.name}${gpu.vramBytes ? ` (${(gpu.vramBytes / 1024 ** 3).toFixed(1)} GiB)` : ""}`,
                        )
                        .join(", ")
                    : "none detected"}
                </p>
                <p>
                  Recommended: ctx {advisor.recommended.ctxSize ?? "auto"} · threads{" "}
                  {advisor.recommended.threads ?? "auto"} · gpu layers {advisor.recommended.gpuLayers ?? "auto"} ·
                  parallel {advisor.recommended.parallel ?? "auto"} · batch {advisor.recommended.batchSize ?? "auto"} ·
                  ubatch {advisor.recommended.ubatchSize ?? "auto"} · flash attn{" "}
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
        </>
      ) : null}

      <Panel title="Models" subtitle="Discovered model ids from the current llama.cpp server.">
        <table className="gc-data-table">
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

export function canLoadModels(status: LlamaCppStatusRecord | null): boolean {
  return Boolean(status?.healthy);
}

export function parseOptionalNumberForPatch(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toOptionalString(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function parseExtraArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatExtraArgs(args: string[]): string {
  return args.join("\n");
}

export function hasReasoningOverride(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--reasoning" || arg === "-rea");
}

export function ensureReasoningDefault(args: string[]): string[] {
  return hasReasoningOverride(args) ? args : [...args, "--reasoning", "off"];
}

export function upsertFlagValue(args: string[], flag: string, value: string): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      index += 1;
      continue;
    }
    next.push(args[index] ?? "");
  }
  next.push(flag, value);
  return next.filter(Boolean);
}

export function appendOptionalFlag(flag: string, value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? [flag, trimmed] : [];
}

export function appendOptionalFlashAttention(mode: "auto" | "on" | "off"): string[] {
  return mode === "auto" ? [] : ["--flash-attn", mode];
}

export function quoteSegment(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function baseUrlToHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.replace(/\/v1$/i, "")).hostname;
  } catch {
    return "127.0.0.1";
  }
}

export function baseUrlToPort(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.replace(/\/v1$/i, ""));
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "8080";
  }
}

export function createEmptyStatus(baseUrl: string): LlamaCppStatusRecord {
  return {
    enabled: false,
    desiredState: "stopped",
    processState: "stopped",
    baseUrl,
    healthy: false,
    updatedAt: new Date().toISOString(),
  };
}

export function formatGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2);
}

export function formatProgress(downloadedBytes: number, totalBytes?: number): string {
  if (!totalBytes || totalBytes <= 0) {
    return `${formatGiB(downloadedBytes)} GiB downloaded`;
  }
  const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  return `${percent}% (${formatGiB(downloadedBytes)} / ${formatGiB(totalBytes)} GiB)`;
}

export function readSavedLlamaCppProfiles(): Partial<Record<LlamaCppProfilePresetId, SavedLlamaCppProfile>> {
  if (typeof window === "undefined" || !window.localStorage) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(LLAMACPP_PROFILE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<Record<LlamaCppProfilePresetId, Partial<SavedLlamaCppProfile>>>;
    if (!parsed) {
      return {};
    }
    const normalized = Object.fromEntries(
      Object.entries(parsed).map(([preset, profile]) => [
        preset,
        profile
          ? ({
              savedAt: profile.savedAt ?? new Date(0).toISOString(),
              enabled: profile.enabled ?? false,
              autoStart: profile.autoStart ?? false,
              baseUrl: profile.baseUrl ?? "http://127.0.0.1:8080/v1",
              command: profile.command ?? "llama-server",
              modelsRootPath: profile.modelsRootPath ?? "",
              modelPath: profile.modelPath ?? "",
              alias: profile.alias ?? DEFAULT_LLAMACPP_ALIAS,
              extraArgsText: profile.extraArgsText ?? "",
              ctxSize: profile.ctxSize ?? "",
              threads: profile.threads ?? "",
              gpuLayers: profile.gpuLayers ?? "",
              parallel: profile.parallel ?? "",
              batchSize: profile.batchSize ?? "",
              ubatchSize: profile.ubatchSize ?? "",
              flashAttentionMode: profile.flashAttentionMode ?? "auto",
            } satisfies SavedLlamaCppProfile)
          : undefined,
      ]),
    ) as Partial<Record<LlamaCppProfilePresetId, SavedLlamaCppProfile>>;
    return normalized;
  } catch {
    return {};
  }
}

export function writeSavedLlamaCppProfiles(
  profiles: Partial<Record<LlamaCppProfilePresetId, SavedLlamaCppProfile>>,
): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  window.localStorage.setItem(LLAMACPP_PROFILE_STORAGE_KEY, JSON.stringify(profiles));
}

export function readRecentLlamaCppDownloads(): RecentLlamaCppDownload[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(LLAMACPP_DOWNLOAD_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentLlamaCppDownload[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRecentLlamaCppDownloads(items: RecentLlamaCppDownload[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  window.localStorage.setItem(LLAMACPP_DOWNLOAD_HISTORY_STORAGE_KEY, JSON.stringify(items));
}

export function upsertRecentLlamaCppDownload(
  existing: RecentLlamaCppDownload[],
  nextItem: RecentLlamaCppDownload,
): RecentLlamaCppDownload[] {
  const remaining = existing.filter(
    (item) => !(item.modelPath === nextItem.modelPath && item.mmprojPath === nextItem.mmprojPath),
  );
  return [nextItem, ...remaining].slice(0, 6);
}

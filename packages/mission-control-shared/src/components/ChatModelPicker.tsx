import { GCCombobox, GCSelect } from "./ui";

export interface ChatModelProviderOption {
  providerId: string;
  label: string;
  baseUrl?: string;
  defaultModel?: string;
  contextWindowTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  capabilities?: {
    voiceInput?: boolean;
    voiceOutput?: boolean;
    imageGenerate?: boolean;
    imageEdit?: boolean;
  };
  models: string[];
  disabled?: boolean;
  availabilityLabel?: string;
  availabilityHint?: string;
  isLocalRuntime?: boolean;
  modelProbeState?: "not_checked" | "ready" | "fallback" | "empty" | "error";
  modelProbeSource?: "live" | "template_fallback" | "error_fallback";
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
  modelRefreshStatus?: "fresh" | "stale" | "not_checked" | "error";
}

function formatHostLabel(baseUrl?: string): string | null {
  if (!baseUrl) {
    return null;
  }
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    // Promote to "1M" if rounding to 1-decimal precision yields >= 1000 (e.g. 999_999 → "1000.0" → "1M")
    if (Number.parseFloat(thousands.toFixed(1)) >= 1_000) {
      return "1M";
    }
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(value);
}

function formatCost(input?: number, output?: number): string | null {
  const parts = [
    typeof input === "number" ? `$${input.toFixed(input >= 10 ? 2 : 3)}/M input` : null,
    typeof output === "number" ? `$${output.toFixed(output >= 10 ? 2 : 3)}/M output` : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatCapabilities(capabilities: ChatModelProviderOption["capabilities"]): string | null {
  if (!capabilities) {
    return null;
  }
  const parts = [
    capabilities.voiceInput ? "voice in" : null,
    capabilities.voiceOutput ? "voice out" : null,
    capabilities.imageGenerate ? "image gen" : null,
    capabilities.imageEdit ? "image edit" : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
}

const PROBE_SOURCE_LABELS: Record<string, string> = {
  live: "live probe",
  template_fallback: "provider template",
  error_fallback: "fallback after probe error",
};

function formatProbeCheckedAt(value?: string): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "last check unavailable" : `checked ${parsed.toLocaleString()}`;
}

function buildProviderMetadata(
  activeProvider: ChatModelProviderOption | undefined,
  model?: string,
): Array<{ label: string; value: string }> {
  if (!activeProvider) {
    return [];
  }
  const endpoint = formatHostLabel(activeProvider.baseUrl);
  const cost = formatCost(activeProvider.inputCostPerMillionTokens, activeProvider.outputCostPerMillionTokens);
  const capabilities = formatCapabilities(activeProvider.capabilities);
  const probeSourceLabel = activeProvider.modelProbeSource
    ? (PROBE_SOURCE_LABELS[activeProvider.modelProbeSource] ?? activeProvider.modelProbeSource)
    : null;
  const probeCheckedAt = formatProbeCheckedAt(activeProvider.modelProbeCheckedAt);
  const probe = activeProvider.modelProbeState
    ? [
        `${activeProvider.modelProbeState}${probeSourceLabel ? ` via ${probeSourceLabel}` : ""}`,
        activeProvider.modelRefreshStatus === "stale" ? "stale catalog" : null,
        probeCheckedAt,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ")
    : null;
  return [
    { label: "Runtime", value: activeProvider.isLocalRuntime ? "Local" : "Cloud" },
    endpoint ? { label: "Endpoint", value: endpoint } : null,
    model
      ? { label: "Model", value: model }
      : activeProvider.defaultModel
        ? { label: "Default", value: activeProvider.defaultModel }
        : null,
    typeof activeProvider.contextWindowTokens === "number"
      ? { label: "Context", value: `${formatNumber(activeProvider.contextWindowTokens)} tokens` }
      : null,
    cost ? { label: "Cost", value: cost } : null,
    capabilities ? { label: "Capabilities", value: capabilities } : null,
    probe ? { label: "Catalog", value: probe } : null,
  ].filter((value): value is { label: string; value: string } => Boolean(value));
}

export function ChatModelPicker({
  providers,
  providerId,
  model,
  disabled,
  pendingProviderId,
  modelLoading = false,
  activeModelContextWindow,
  activeModelOutputTokenLimit,
  onChangeProvider,
  onChangeModel,
}: {
  providers: ChatModelProviderOption[];
  providerId?: string;
  model?: string;
  disabled?: boolean;
  pendingProviderId?: string | null;
  modelLoading?: boolean;
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
  onChangeProvider: (providerId: string) => void;
  onChangeModel: (model: string) => void;
}) {
  const displayProviderId = pendingProviderId ?? providerId;
  const activeProvider = providers.find((item) => item.providerId === displayProviderId);
  const models = activeProvider?.models ?? [];
  const providerOptions = [
    { value: "", label: "Select provider", disabled: true },
    ...providers.map((provider) => ({
      value: provider.providerId,
      label: provider.availabilityLabel ?? provider.label,
      disabled: provider.disabled,
    })),
  ];
  const modelOptions = modelLoading
    ? [{ value: "", label: "Loading models...", disabled: true }]
    : !activeProvider
      ? [{ value: "", label: "Select provider first", disabled: true }]
      : models.map((item) => ({ value: item, label: item }));
  const availabilityMessage = !activeProvider
    ? "No provider selected yet. Connect a provider in Configure, then choose a model."
    : modelLoading
      ? `Loading models for ${activeProvider?.label ?? "provider"}...`
      : (activeProvider.modelProbeWarning ??
        (activeProvider.modelRefreshStatus === "stale"
          ? "Model catalog is stale. Refresh models before routing."
          : null) ??
        activeProvider?.availabilityHint ??
        (models.length === 0 ? `No models available for ${activeProvider?.label ?? "this provider"} yet.` : null));
  const metadata = buildProviderMetadata(activeProvider, modelLoading ? undefined : (model ?? models[0]));

  return (
    <div className="chat-model-picker">
      <GCSelect
        value={activeProvider?.providerId ?? ""}
        disabled={disabled || providers.length === 0}
        onChange={onChangeProvider}
        aria-label="Provider"
        options={providerOptions}
      />
      <GCCombobox
        value={modelLoading ? "" : (model ?? models[0] ?? "")}
        disabled={disabled || modelLoading || !activeProvider || models.length === 0}
        onChange={onChangeModel}
        aria-label="Model"
        placeholder={modelLoading ? "Loading models..." : "Search model..."}
        options={modelOptions}
      />
      {typeof activeModelContextWindow === "number" ? (
        <span
          className="chat-model-picker-context-badge text-xs text-muted-foreground"
          title={`Catalog/probe context window: ${formatNumber(activeModelContextWindow)} tokens${
            typeof activeModelOutputTokenLimit === "number"
              ? ` · Output limit: ${formatNumber(activeModelOutputTokenLimit)} tokens`
              : ""
          }`}
          aria-label="Active model catalog/probe context window"
        >
          {formatContextWindow(activeModelContextWindow)}
        </span>
      ) : null}
      {availabilityMessage ? <p className="chat-model-picker-note">{availabilityMessage}</p> : null}
      {metadata.length > 0 ? (
        <dl className="chat-model-picker-metadata" aria-label="Provider and model metadata">
          {metadata.map((item) => (
            <div key={`${item.label}-${item.value}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

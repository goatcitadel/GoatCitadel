import { GCCombobox, GCSelect } from "./ui";

export interface ChatModelProviderOption {
  providerId: string;
  label: string;
  baseUrl?: string;
  defaultModel?: string;
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
  modelProbeSource?: "remote" | "fallback";
  modelProbeCheckedAt?: string;
}

export function ChatModelPicker({
  providers,
  providerId,
  model,
  disabled,
  pendingProviderId,
  modelLoading = false,
  onChangeProvider,
  onChangeModel,
}: {
  providers: ChatModelProviderOption[];
  providerId?: string;
  model?: string;
  disabled?: boolean;
  pendingProviderId?: string | null;
  modelLoading?: boolean;
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
      : (activeProvider?.availabilityHint ??
        (models.length === 0 ? `No models available for ${activeProvider?.label ?? "this provider"} yet.` : null));

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
      {availabilityMessage ? <p className="chat-model-picker-note">{availabilityMessage}</p> : null}
    </div>
  );
}

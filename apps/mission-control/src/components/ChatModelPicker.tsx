import { GCCombobox, GCSelect } from "./ui";

export interface ChatModelProviderOption {
  providerId: string;
  label: string;
  defaultModel?: string;
  models: string[];
  disabled?: boolean;
  availabilityLabel?: string;
  availabilityHint?: string;
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
  const activeProvider = providers.find((item) => item.providerId === displayProviderId) ?? providers[0];
  const models = activeProvider?.models ?? [];
  const modelOptions = modelLoading
    ? [{ value: "", label: "Loading models...", disabled: true }]
    : models.map((item) => ({ value: item, label: item }));
  const availabilityMessage = modelLoading
    ? `Loading models for ${activeProvider?.label ?? "provider"}...`
    : activeProvider?.availabilityHint
      ?? (models.length === 0 ? `No models available for ${activeProvider?.label ?? "this provider"} yet.` : null);

  return (
    <div className="chat-model-picker">
      <GCSelect
        value={activeProvider?.providerId ?? ""}
        disabled={disabled || providers.length === 0}
        onChange={onChangeProvider}
        aria-label="Provider"
        options={providers.map((provider) => ({
          value: provider.providerId,
          label: provider.availabilityLabel ?? provider.label,
          disabled: provider.disabled,
        }))}
      />
      {models.length > 12 ? (
        <GCCombobox
          value={modelLoading ? "" : (model ?? models[0] ?? "")}
          disabled={disabled || modelLoading || models.length === 0}
          onChange={onChangeModel}
          aria-label="Model"
          placeholder={modelLoading ? "Loading models..." : "Search model..."}
          options={modelOptions}
        />
      ) : (
        <GCSelect
          value={modelLoading ? "" : (model ?? models[0] ?? "")}
          disabled={disabled || modelLoading || models.length === 0}
          onChange={onChangeModel}
          aria-label="Model"
          options={modelOptions}
        />
      )}
      {availabilityMessage ? <p className="chat-model-picker-note">{availabilityMessage}</p> : null}
    </div>
  );
}

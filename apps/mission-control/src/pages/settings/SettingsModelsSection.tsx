import type { RuntimeSettingsResponse } from "../../api/client";
import type { ProviderSecretStatus } from "../../api/client";
import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { LlmTransportFields, type LlmTransportDraft } from "../../components/LlmTransportFields";
import { Panel } from "../../components/Panel";
import { SelectOrCustom, type SelectOption } from "../../components/SelectOrCustom";
import { GCSelect } from "../../components/ui";

export type ProviderApiStyle = RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];

export interface SettingsModelsProviderOption {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: ProviderApiStyle;
  resolvedApiStyle?: string;
  defaultModel?: string;
  apiKeySource?: "none" | "keychain" | "env" | "inline";
  apiKeyRef?: string;
}

export interface SettingsModelsProviderTemplate {
  providerId: string;
  label?: string;
  baseUrl: string;
  apiStyle?: ProviderApiStyle;
}

export interface SettingsModelsModelEntry {
  id: string;
}

export interface SettingsModelsCurrentRuntime {
  resolvedApiStyle?: string;
}

export interface SettingsModelsSectionProps {
  applyLocalProviderPreset: (id: "lmstudio" | "ollama" | "llamacpp") => void;
  activeProviderId: string;
  onActiveProviderIdChange: (nextProviderId: string) => void;
  providerSelectOptions: SelectOption[];
  activeModel: string;
  onActiveModelChange: (nextModel: string) => void;
  activeModelOptions: SelectOption[];
  loadingModels: boolean;
  onLoadModels: () => void;
  modelDiscoverySource: string | null;
  modelDiscoveryWarning: string | null;
  models: SettingsModelsModelEntry[];
  onSaveActiveLlm: () => void;
  blockSaves: boolean;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  providerId: string;
  onProviderIdChange: (nextProviderId: string) => void;
  providerLabel: string;
  onProviderLabelChange: (nextLabel: string) => void;
  providerLabelOptions: SelectOption[];
  providerBaseUrl: string;
  onProviderBaseUrlChange: (nextBaseUrl: string) => void;
  providerTemplates: readonly SettingsModelsProviderTemplate[];
  providerApiStyle: ProviderApiStyle;
  onProviderApiStyleChange: (nextApiStyle: ProviderApiStyle) => void;
  providerApiStyleOptions: Array<{ value: ProviderApiStyle; label: string }>;
  currentProviderRuntime: SettingsModelsCurrentRuntime | undefined;
  providerDefaultModel: string;
  onProviderDefaultModelChange: (nextDefaultModel: string) => void;
  providerDefaultModelOptions: SelectOption[];
  providerApiKey: string;
  onProviderApiKeyChange: (nextApiKey: string) => void;
  providerSecretStatus: ProviderSecretStatus | null;
  providerOptions: SettingsModelsProviderOption[];
  onSaveProviderKeyToSecureStore: () => void;
  onDeleteProviderKeyFromSecureStore: () => void;
  providerApiKeyEnv: string;
  onProviderApiKeyEnvChange: (nextApiKeyEnv: string) => void;
  providerRequestDraft: LlmTransportDraft;
  onProviderRequestDraftChange: (nextDraft: LlmTransportDraft) => void;
  providerRequestValidationError: string | null | undefined;
  onSaveProvider: () => void;
}

export function SettingsModelsSection(props: SettingsModelsSectionProps) {
  const {
    applyLocalProviderPreset,
    activeProviderId,
    onActiveProviderIdChange,
    providerSelectOptions,
    activeModel,
    onActiveModelChange,
    activeModelOptions,
    loadingModels,
    onLoadModels,
    modelDiscoverySource,
    modelDiscoveryWarning,
    models,
    onSaveActiveLlm,
    blockSaves,
    showAdvanced,
    onToggleAdvanced,
    providerId,
    onProviderIdChange,
    providerLabel,
    onProviderLabelChange,
    providerLabelOptions,
    providerBaseUrl,
    onProviderBaseUrlChange,
    providerTemplates,
    providerApiStyle,
    onProviderApiStyleChange,
    providerApiStyleOptions,
    currentProviderRuntime,
    providerDefaultModel,
    onProviderDefaultModelChange,
    providerDefaultModelOptions,
    providerApiKey,
    onProviderApiKeyChange,
    providerSecretStatus,
    providerOptions,
    onSaveProviderKeyToSecureStore,
    onDeleteProviderKeyFromSecureStore,
    providerApiKeyEnv,
    onProviderApiKeyEnvChange,
    providerRequestDraft,
    onProviderRequestDraftChange,
    providerRequestValidationError,
    onSaveProvider,
  } = props;

  return (
    <section id="settings-models" className="settings-v2-section">
      <Panel
        className="settings-v2-panel"
        title="LLM Providers & Models"
        subtitle="Direct OpenAI and Anthropic providers use native upstream APIs by default; compatibility gateways stay on chat-completions unless you explicitly change them."
      >
        <FieldHelp>
          Pick an active provider and model first, then use the advanced block only when you need to add or override
          provider details. Known values should stay in selects; custom entry is the fallback.
        </FieldHelp>
        <details className="advanced-panel">
          <summary>Local runtime quick setup: LM Studio + Ollama + llama.cpp</summary>
          <p className="office-subtitle">
            <strong>LM Studio:</strong> load at least one model, then start its local server.
          </p>
          <p className="office-subtitle">
            Base URL: <code>http://127.0.0.1:1234/v1</code> | model id: the loaded model name in LM Studio.
          </p>
          <p className="office-subtitle">
            <strong>Ollama:</strong> run <code>ollama pull llama3.2</code> and keep Ollama running.
          </p>
          <p className="office-subtitle">
            Base URL: <code>http://127.0.0.1:11434/v1</code> | model id: installed tag, for example{" "}
            <code>llama3.2</code>.
          </p>
          <p className="office-subtitle">
            <strong>llama.cpp:</strong> start <code>llama-server</code> with your GGUF model and an alias such as{" "}
            <code>--alias gemma-4-local</code>.
          </p>
          <p className="office-subtitle">
            Base URL: <code>http://127.0.0.1:8080/v1</code> | model id: <code>gemma-4-local</code> or the alias returned
            by <code>/v1/models</code>.
          </p>
          <p className="office-subtitle">
            If GoatCitadel is remote, replace <code>127.0.0.1</code> with the host IP/tailnet name and include that host
            in your outbound allowlist.
          </p>
          <div className="controls-row">
            <button type="button" onClick={() => applyLocalProviderPreset("lmstudio")} className="gc-button">
              Use LM Studio Preset
            </button>
            <button type="button" onClick={() => applyLocalProviderPreset("ollama")} className="gc-button">
              Use Ollama Preset
            </button>
            <button type="button" onClick={() => applyLocalProviderPreset("llamacpp")} className="gc-button">
              Use llama.cpp Preset
            </button>
          </div>
        </details>

        <div className="controls-row">
          <label htmlFor="activeProvider">
            Active Provider{" "}
            <HelpHint
              label="Active provider help"
              text="The active provider is the company or endpoint GoatCitadel will use for new chats and tests by default."
            />
          </label>
          <SelectOrCustom
            id="activeProvider"
            value={activeProviderId}
            onChange={onActiveProviderIdChange}
            options={providerSelectOptions}
            customPlaceholder="Custom provider id"
            customLabel="Custom active provider"
          />
        </div>

        <div className="controls-row">
          <label htmlFor="activeModel">
            Active Model{" "}
            <HelpHint
              label="Active model help"
              text="This is the actual model GoatCitadel will send prompts to for the active provider. The list below is discovered live when possible so you can pick a working model instead of guessing."
            />
          </label>
          <SelectOrCustom
            id="activeModel"
            value={activeModel}
            onChange={onActiveModelChange}
            options={activeModelOptions}
            customPlaceholder="Custom model id"
            customLabel="Custom active model"
          />
          <button type="button" onClick={onLoadModels} className="gc-button">
            {loadingModels ? "Loading..." : "Refresh Models"}
          </button>
        </div>
        {modelDiscoverySource ? (
          <p className="office-subtitle">
            Model discovery: {modelDiscoverySource === "remote" ? "live provider list" : "fallback/default list"}
            {modelDiscoveryWarning ? ` · ${modelDiscoveryWarning}` : ""}
          </p>
        ) : null}
        {models.length > 0 ? (
          <ul className="compact-list">
            {models.map((model) => (
              <li key={model.id}>{model.id}</li>
            ))}
          </ul>
        ) : null}
        <button type="button" onClick={onSaveActiveLlm} disabled={blockSaves} className="gc-button">
          Save Active Provider/Model
        </button>

        <button
          type="button"
          onClick={onToggleAdvanced}
          className="gc-nav-button gc-nav-tier-chip settings-advanced-toggle"
        >
          {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
        </button>
        {showAdvanced ? (
          <div className="advanced-block">
            <h4>Add / Update Provider</h4>
            <div className="controls-row">
              <label htmlFor="providerId">
                Provider ID{" "}
                <HelpHint
                  label="Provider ID help"
                  text="Provider ID is GoatCitadel's stable machine name for this endpoint, such as glm or moonshot. It is how runtime settings and chats refer to the provider internally."
                />
              </label>
              <SelectOrCustom
                id="providerId"
                value={providerId}
                onChange={onProviderIdChange}
                options={providerSelectOptions}
                customPlaceholder="e.g. corp-gateway"
                customLabel="Custom provider id"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerLabel">
                Label{" "}
                <HelpHint
                  label="Provider label help"
                  text="Label is the human-readable display name shown in the UI. It does not have to match the provider ID exactly."
                />
              </label>
              <SelectOrCustom
                id="providerLabel"
                value={providerLabel}
                onChange={onProviderLabelChange}
                options={providerLabelOptions}
                customPlaceholder="Provider display label"
                customLabel="Custom label"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerBaseUrl">Base URL</label>
              <SelectOrCustom
                id="providerBaseUrl"
                value={providerBaseUrl}
                onChange={onProviderBaseUrlChange}
                options={providerTemplates.map((template) => ({
                  value: template.baseUrl,
                  label: template.baseUrl,
                }))}
                customPlaceholder="https://host/v1"
                customLabel="Custom base URL"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerApiStyle">
                Provider API Style{" "}
                <HelpHint
                  label="Provider API style help"
                  text="Configured API style is the upstream protocol GoatCitadel should target for this provider. Direct OpenAI defaults to Responses, direct Anthropic defaults to Messages, and compatibility gateways stay on chat-completions unless you explicitly change them."
                />
              </label>
              <GCSelect
                id="providerApiStyle"
                value={providerApiStyle}
                onChange={(nextApiStyle) => onProviderApiStyleChange(nextApiStyle as ProviderApiStyle)}
                options={providerApiStyleOptions}
              />
            </div>
            <p className="office-subtitle">
              Configured API style: {providerApiStyle}
              {currentProviderRuntime?.resolvedApiStyle
                ? ` · Resolved execution style: ${currentProviderRuntime.resolvedApiStyle}`
                : ""}
            </p>
            <div className="controls-row">
              <label htmlFor="providerDefaultModel">
                Default Model{" "}
                <HelpHint
                  label="Default model help"
                  text="Default model is the model GoatCitadel should choose first for this provider when a chat or page has not pinned a different model yet."
                />
              </label>
              <SelectOrCustom
                id="providerDefaultModel"
                value={providerDefaultModel}
                onChange={onProviderDefaultModelChange}
                options={providerDefaultModelOptions}
                customPlaceholder="Default model id"
                customLabel="Custom default model"
              />
            </div>
            <div className="controls-row">
              <label htmlFor="providerApiKey">API Key (optional)</label>
              <input
                id="providerApiKey"
                type="password"
                value={providerApiKey}
                onChange={(event) => onProviderApiKeyChange(event.target.value)}
              />
            </div>
            <p className="office-subtitle">
              Key source:{" "}
              {providerSecretStatus?.source ??
                providerOptions.find((provider) => provider.providerId === providerId)?.apiKeySource ??
                "none"}
            </p>
            <div className="controls-row">
              <button
                type="button"
                onClick={onSaveProviderKeyToSecureStore}
                disabled={!providerApiKey.trim()}
                className="gc-button"
              >
                Save Key to Secure Store
              </button>
              <button type="button" onClick={onDeleteProviderKeyFromSecureStore} className="gc-button">
                Remove Secure Key
              </button>
            </div>
            <div className="controls-row">
              <label htmlFor="providerApiKeyEnv">
                API Key Env (optional){" "}
                <HelpHint
                  label="Provider API key env help"
                  text="This is the environment variable name GoatCitadel should look for at runtime, for example GLM_API_KEY. It names the variable; it is not the secret value itself."
                />
              </label>
              <SelectOrCustom
                id="providerApiKeyEnv"
                value={providerApiKeyEnv}
                onChange={onProviderApiKeyEnvChange}
                options={[
                  { value: "OPENAI_API_KEY", label: "OPENAI_API_KEY" },
                  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" },
                  { value: "GOOGLE_API_KEY", label: "GOOGLE_API_KEY" },
                  { value: "GLM_API_KEY", label: "GLM_API_KEY" },
                  { value: "MOONSHOT_API_KEY", label: "MOONSHOT_API_KEY" },
                  { value: "OPENROUTER_API_KEY", label: "OPENROUTER_API_KEY" },
                  { value: "OLLAMA_API_KEY", label: "OLLAMA_API_KEY (optional/proxy only)" },
                  {
                    value: "LMSTUDIO_API_KEY",
                    label: "LMSTUDIO_API_KEY (optional/proxy only)",
                  },
                ]}
                customPlaceholder="Custom env var name"
                customLabel="Custom env var"
              />
            </div>
            <LlmTransportFields
              idPrefix="settings-provider-transport"
              draft={providerRequestDraft}
              onChange={onProviderRequestDraftChange}
              error={providerRequestValidationError}
            />
            <button type="button" onClick={onSaveProvider} disabled={blockSaves} className="gc-button">
              Save Provider Settings
            </button>
          </div>
        ) : null}
      </Panel>
    </section>
  );
}

import { Sparkles } from "lucide-react";
import type { PromptPackExecutionStyle } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";

export interface RunSettingsPanelProps {
  isOpsVariant: boolean;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId: string;
  selectedModel: string;
  reuseLastModel: boolean;
  autoScoreOnRun: boolean;
  executionStyle: PromptPackExecutionStyle;
  lastSuccessfulModel?: { providerId: string; model: string };
  selectedRunModel?: { providerId: string; model?: string };
  executionStyleDescription: string;
  onSelectProvider: (providerId: string) => void;
  onSelectModel: (model: string) => void;
  onSetReuseLastModel: (value: boolean) => void;
  onSetAutoScoreOnRun: (value: boolean) => void;
  onSetExecutionStyle: (style: PromptPackExecutionStyle) => void;
}

export function RunSettingsPanel(props: RunSettingsPanelProps) {
  return props.isOpsVariant ? <RunSettingsOpsPanel {...props} /> : <RunSettingsLibraryPanel {...props} />;
}

function RunSettingsBody({
  providerOptions,
  selectedProviderId,
  selectedModel,
  reuseLastModel,
  autoScoreOnRun,
  executionStyle,
  lastSuccessfulModel,
  selectedRunModel,
  executionStyleDescription,
  onSelectProvider,
  onSelectModel,
  onSetReuseLastModel,
  onSetAutoScoreOnRun,
  onSetExecutionStyle,
}: Omit<RunSettingsPanelProps, "isOpsVariant">) {
  return (
    <>
      <label className="mc-pp-field">
        <span>Provider</span>
        <select
          value={selectedProviderId}
          onChange={(event) => {
            onSetReuseLastModel(false);
            onSelectProvider(event.target.value);
            const provider = providerOptions.find((item) => item.providerId === event.target.value);
            onSelectModel(provider?.models[0] ?? "");
          }}
        >
          {providerOptions.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mc-pp-field">
        <span>Model</span>
        <select
          value={selectedModel}
          onChange={(event) => {
            onSetReuseLastModel(false);
            onSelectModel(event.target.value);
          }}
        >
          {(providerOptions.find((provider) => provider.providerId === selectedProviderId)?.models ?? []).map(
            (model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ),
          )}
        </select>
      </label>
      <label className="mc-pp-toggle">
        <input
          type="checkbox"
          checked={reuseLastModel}
          onChange={(event) => onSetReuseLastModel(event.target.checked)}
        />
        <span>Reuse the last successful model lane when available</span>
      </label>
      <label className="mc-pp-toggle">
        <input
          type="checkbox"
          checked={autoScoreOnRun}
          onChange={(event) => onSetAutoScoreOnRun(event.target.checked)}
        />
        <span>Auto-score completed runs after execution</span>
      </label>
      <div className="mc-pp-field">
        <span>Execution style</span>
        <div className="mc-pp-filter-row" role="radiogroup" aria-label="Prompt pack execution style">
          <button
            type="button"
            role="radio"
            aria-checked={executionStyle === "single_turn_harness"}
            className={`mc-pp-filter-chip${executionStyle === "single_turn_harness" ? " active" : ""}`}
            onClick={() => onSetExecutionStyle("single_turn_harness")}
          >
            Harness
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={executionStyle === "agentic_surface"}
            className={`mc-pp-filter-chip${executionStyle === "agentic_surface" ? " active" : ""}`}
            onClick={() => onSetExecutionStyle("agentic_surface")}
          >
            Agentic
          </button>
        </div>
      </div>
      <p className="mc-pp-note">
        {reuseLastModel && lastSuccessfulModel
          ? `Reusing ${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}.`
          : selectedRunModel?.providerId
            ? `New runs request ${selectedRunModel.providerId}/${selectedRunModel.model ?? "provider default"}.`
            : "Select a provider and model to start running this pack."}{" "}
        {executionStyleDescription}
      </p>
    </>
  );
}

function RunSettingsOpsPanel(props: RunSettingsPanelProps) {
  return (
    <details className="mc-pp-panel mc-pp-panel-collapsible">
      <summary>
        <div>
          <h4>Execution lane</h4>
          <p>Adjust provider, model, and scoring defaults only when the next pass needs a different lane.</p>
        </div>
        <Sparkles size={16} />
      </summary>
      <div className="mc-pp-advanced-grid">
        <RunSettingsBody {...props} />
      </div>
    </details>
  );
}

function RunSettingsLibraryPanel(props: RunSettingsPanelProps) {
  return (
    <section className="mc-pp-panel">
      <div className="mc-pp-section-heading">
        <div>
          <h4>Run settings</h4>
          <p>Set the model lane for the next run, then stay focused on the selected test.</p>
        </div>
        <Sparkles size={16} />
      </div>
      <RunSettingsBody {...props} />
    </section>
  );
}

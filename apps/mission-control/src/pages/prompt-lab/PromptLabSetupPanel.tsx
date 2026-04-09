import { ActionButton } from "../../components/ActionButton";
import { ChatModelPicker, type ChatModelProviderOption } from "../../components/ChatModelPicker";

interface PromptLabPackItem {
  packId: string;
  name: string;
  testCount: number;
}

interface PromptLabModelRef {
  providerId: string;
  model?: string;
}

interface PromptLabRegressionStatus {
  run: {
    regressionRunId: string;
    status: string;
  };
  results: unknown[];
}

interface PromptLabSetupPanelProps {
  importText: string;
  importing: boolean;
  packs: PromptLabPackItem[];
  selectedPackId: string | null;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId: string;
  selectedModel: string;
  reuseLastModel: boolean;
  autoScoreOnRun: boolean;
  lastSuccessfulModel: PromptLabModelRef | null;
  selectedRunModel: PromptLabModelRef | null;
  benchmarkTestCodes: string;
  benchmarkProvidersInput: string;
  benchmarkPending: boolean;
  benchmarkRunId: string | null;
  regressionPending: boolean;
  regressionRunId: string | null;
  regressionStatus: PromptLabRegressionStatus | null;
  running: boolean;
  onImportTextChange: (value: string) => void;
  onImport: () => void;
  onSelectedPackIdChange: (packId: string) => void;
  onSelectedProviderIdChange: (providerId: string) => void;
  onSelectedModelChange: (model: string) => void;
  onReuseLastModelChange: (checked: boolean) => void;
  onAutoScoreOnRunChange: (checked: boolean) => void;
  onBenchmarkTestCodesChange: (value: string) => void;
  onBenchmarkProvidersInputChange: (value: string) => void;
  onRunBenchmark: () => void;
  onRefreshBenchmark: () => void;
  onRunRegression: () => void;
  onRefreshRegression: () => void;
}

export function PromptLabSetupPanel({
  importText,
  importing,
  packs,
  selectedPackId,
  providerOptions,
  selectedProviderId,
  selectedModel,
  reuseLastModel,
  autoScoreOnRun,
  lastSuccessfulModel,
  selectedRunModel,
  benchmarkTestCodes,
  benchmarkProvidersInput,
  benchmarkPending,
  benchmarkRunId,
  regressionPending,
  regressionRunId,
  regressionStatus,
  running,
  onImportTextChange,
  onImport,
  onSelectedPackIdChange,
  onSelectedProviderIdChange,
  onSelectedModelChange,
  onReuseLastModelChange,
  onAutoScoreOnRunChange,
  onBenchmarkTestCodesChange,
  onBenchmarkProvidersInputChange,
  onRunBenchmark,
  onRefreshBenchmark,
  onRunRegression,
  onRefreshRegression,
}: PromptLabSetupPanelProps) {
  return (
    <div className="prompt-lab-grid">
      <article className="card prompt-lab-surface prompt-lab-import">
        <h3>Import Prompt Pack</h3>
        <textarea
          rows={10}
          placeholder="Paste prompt-pack markdown here..."
          value={importText}
          onChange={(event) => onImportTextChange(event.target.value)}
        />
        <ActionButton label="Import" pending={importing} onClick={onImport} />
        <p className="office-subtitle">Tip: import once, then use Run next test to move quickly through the pack.</p>
      </article>

      <article className="card prompt-lab-surface prompt-lab-packs">
        <h3>Prompt Packs</h3>
        <ul>
          {packs.map((pack) => (
            <li key={pack.packId}>
              <button
                type="button"
                className={selectedPackId === pack.packId ? "active" : ""}
                onClick={() => onSelectedPackIdChange(pack.packId)}
              >
                {pack.name}
              </button>
              <span>{pack.testCount} tests</span>
            </li>
          ))}
        </ul>
        <div className="prompt-lab-model-picker">
          <p className="office-subtitle">
            {reuseLastModel && lastSuccessfulModel
              ? `New runs will reuse the last successful request: ${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}`
              : selectedRunModel?.providerId
                ? `Requested model for new runs: ${selectedRunModel.providerId}/${selectedRunModel.model ?? "(provider default)"}`
                : "Select a provider/model for this prompt-pack run."}
          </p>
          <ChatModelPicker
            providers={providerOptions}
            providerId={selectedProviderId}
            model={selectedModel}
            disabled={running || providerOptions.length === 0}
            onChangeProvider={onSelectedProviderIdChange}
            onChangeModel={onSelectedModelChange}
          />
        </div>
        <label className="prompt-lab-toggle">
          <input
            type="checkbox"
            checked={reuseLastModel}
            onChange={(event) => onReuseLastModelChange(event.target.checked)}
          />
          Reuse last successful model settings
        </label>
        <label className="prompt-lab-toggle">
          <input
            type="checkbox"
            checked={autoScoreOnRun}
            onChange={(event) => onAutoScoreOnRunChange(event.target.checked)}
          />
          Auto-score completed runs (model + rules)
        </label>
        <details className="prompt-lab-benchmark-panel">
          <summary>Benchmark matrix</summary>
          <p className="office-subtitle">
            Run a provider/model matrix on selected test codes (default high-signal subset).
          </p>
          <label className="prompt-lab-field">
            Test codes (comma or newline separated)
            <textarea
              rows={2}
              value={benchmarkTestCodes}
              onChange={(event) => onBenchmarkTestCodesChange(event.target.value)}
              placeholder="TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28"
            />
          </label>
          <label className="prompt-lab-field">
            Providers matrix (one per line: provider/model)
            <textarea
              rows={3}
              value={benchmarkProvidersInput}
              onChange={(event) => onBenchmarkProvidersInputChange(event.target.value)}
              placeholder={"glm/glm-5\nmoonshot/kimi-k2.5"}
            />
          </label>
          <div className="prompt-lab-actions">
            <ActionButton
              label="Start benchmark"
              pending={benchmarkPending}
              disabled={!selectedPackId || running}
              onClick={onRunBenchmark}
            />
            <ActionButton label="Refresh benchmark" disabled={!benchmarkRunId} onClick={onRefreshBenchmark} />
            <ActionButton
              label="Run replay regression"
              pending={regressionPending}
              disabled={!selectedPackId || running}
              onClick={onRunRegression}
            />
            <ActionButton label="Refresh regression" disabled={!regressionRunId} onClick={onRefreshRegression} />
          </div>
          {regressionStatus ? (
            <p className="office-subtitle">
              Replay regression: <code>{regressionStatus.run.regressionRunId}</code> • {regressionStatus.run.status}
              {" • "}results: {regressionStatus.results.length}
            </p>
          ) : null}
        </details>
      </article>
    </div>
  );
}

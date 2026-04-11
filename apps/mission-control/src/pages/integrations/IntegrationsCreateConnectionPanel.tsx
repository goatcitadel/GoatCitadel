import type { IntegrationCatalogEntry, IntegrationConnection } from "../../api/client";
import { CardSkeleton } from "../../components/CardSkeleton";
import { ConfigFormBuilder } from "../../components/ConfigFormBuilder";
import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { SelectOrCustom } from "../../components/SelectOrCustom";
import { GCSelect, GCSwitch } from "../../components/ui";
import {
  type ChannelSetupPath,
  describeChannelSetupPath,
  describeMaturity,
  formatChannelSetupPath,
  formatKind,
  formatMaturity,
  formatRuntimeAvailability,
} from "../integrations-page-utils";

export interface IntegrationsStatusOption {
  value: IntegrationConnection["status"];
  label: string;
  description: string;
}

export interface IntegrationsCatalogOption {
  value: string;
  label: string;
}

export interface IntegrationsCreateConnectionPanelProps {
  createConnectionTitle: string;
  createConnectionSubtitle: string;
  isInitialLoading: boolean;
  selectedCatalogId: string;
  onSelectedCatalogIdChange: (value: string) => void;
  catalogOptions: IntegrationsCatalogOption[];
  label: string;
  onLabelChange: (value: string) => void;
  selectedCatalog: IntegrationCatalogEntry | undefined;
  selectedCatalogSetupPath: ChannelSetupPath | null;
  selectedCatalogIsRunnable: boolean;
  status: IntegrationConnection["status"];
  onStatusChange: (value: IntegrationConnection["status"]) => void;
  statusOptions: IntegrationsStatusOption[];
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  showAdvancedJson: boolean;
  onShowAdvancedJsonChange: (value: boolean) => void;
  simpleFormLabel: string;
  simpleFormSelectionLabel: string;
  guidedModeSummary: string;
  advancedModeSummary: string;
  selectedModeCallout: string;
  isFormSchemaLoading: boolean;
  formSchema: IntegrationCatalogEntry["formSchema"];
  guidedConfig: Record<string, unknown>;
  onGuidedConfigChange: (value: Record<string, unknown>) => void;
  configJson: string;
  onConfigJsonChange: (value: string) => void;
  blockCreate: boolean;
  createPending: boolean;
  onCreate: () => void;
}

export function IntegrationsCreateConnectionPanel(props: IntegrationsCreateConnectionPanelProps) {
  const {
    createConnectionTitle,
    createConnectionSubtitle,
    isInitialLoading,
    selectedCatalogId,
    onSelectedCatalogIdChange,
    catalogOptions,
    label,
    onLabelChange,
    selectedCatalog,
    selectedCatalogSetupPath,
    selectedCatalogIsRunnable,
    status,
    onStatusChange,
    statusOptions,
    enabled,
    onEnabledChange,
    showAdvancedJson,
    onShowAdvancedJsonChange,
    simpleFormLabel,
    simpleFormSelectionLabel,
    guidedModeSummary,
    advancedModeSummary,
    selectedModeCallout,
    isFormSchemaLoading,
    formSchema,
    guidedConfig,
    onGuidedConfigChange,
    configJson,
    onConfigJsonChange,
    blockCreate,
    createPending,
    onCreate,
  } = props;

  return (
    <Panel title={createConnectionTitle} subtitle={createConnectionSubtitle}>
      {isInitialLoading ? <CardSkeleton lines={5} /> : null}
      {!isInitialLoading ? (
        <>
          <div className="controls-row">
            <label>
              Catalog entry
              <HelpHint
                label="Catalog entry help"
                text="Catalog entries define expected auth methods, fields, and capabilities for a service."
              />
            </label>
            <SelectOrCustom
              value={selectedCatalogId}
              onChange={onSelectedCatalogIdChange}
              options={catalogOptions}
              customPlaceholder="Select a catalog entry"
              customLabel="Catalog id"
              customOptionLabel="Use custom catalog id"
            />
          </div>
          <div className="controls-row">
            <label>
              Display name (optional)
              <HelpHint
                label="Connection label help"
                text="Friendly name shown in lists. If left blank, GoatCitadel uses the catalog name."
              />
            </label>
            <input
              value={label}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder={selectedCatalog?.label ?? "Connection label"}
            />
            <label>
              Initial status
              <HelpHint
                label="Initial status help"
                text="Connected means ready now. Paused/disconnected keeps config saved without active use."
              />
            </label>
            <GCSelect
              value={status}
              onChange={(value) => onStatusChange(value as IntegrationConnection["status"])}
              options={statusOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
            <GCSwitch checked={enabled} onCheckedChange={onEnabledChange} label="Enable right away" />
          </div>
          <p className="office-subtitle">{statusOptions.find((option) => option.value === status)?.description}</p>
          {selectedCatalog ? (
            <div className="card">
              <p>
                <strong>{selectedCatalog.label}</strong> [{formatMaturity(selectedCatalog.maturity)}]
              </p>
              <p>{selectedCatalog.description}</p>
              <p className="office-subtitle">
                Auth: {selectedCatalog.authMethods.join(", ") || "-"}
                {" | "}
                Kind: {formatKind(selectedCatalog.kind)}
              </p>
              <p className="office-subtitle">{describeMaturity(selectedCatalog.maturity)}</p>
              <p className="office-subtitle">
                Runtime: {formatRuntimeAvailability(selectedCatalog.runtimeAvailability)}
              </p>
              {selectedCatalog.kind === "channel" && selectedCatalogSetupPath ? (
                <p className="office-subtitle">Setup path: {formatChannelSetupPath(selectedCatalogSetupPath)}</p>
              ) : null}
              {selectedCatalog.runtimeAvailability === "blocked" ? (
                <FieldHelp>
                  This integration remains visible so operators can prepare it, but the current runtime posture
                  still blocks a runnable connection or supported action path.
                </FieldHelp>
              ) : null}
              {selectedCatalog.kind === "channel" && selectedCatalogSetupPath ? (
                <FieldHelp>{describeChannelSetupPath(selectedCatalogSetupPath)}</FieldHelp>
              ) : null}
              {selectedCatalog.docsUrl ? (
                <p className="office-subtitle">
                  <a href={selectedCatalog.docsUrl} target="_blank" rel="noreferrer">
                    Open integration docs
                  </a>
                </p>
              ) : null}
              <div className="token-row">
                {selectedCatalog.capabilities.map((capability) => (
                  <span key={capability} className="token-chip">
                    {capability}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="integrations-setup-mode-panel">
            <div className="integrations-setup-mode-header">
              <strong>Setup mode</strong>
              <p className="office-subtitle">
                Choose the simple form or the raw config editor before you fill anything in.
              </p>
            </div>
            <div className="integrations-setup-mode-toggle" role="group" aria-label="Setup mode">
              <button
                type="button"
                aria-pressed={!showAdvancedJson}
                className={["gc-button", (`integrations-setup-mode-button${!showAdvancedJson ? " active" : ""}`)].filter(Boolean).join(" ")}
                onClick={() => onShowAdvancedJsonChange(false)}
              >
                <span className="integrations-setup-mode-label">{simpleFormLabel}</span>
                <span className="integrations-setup-mode-note">Recommended for most people</span>
              </button>
              <button
                type="button"
                aria-pressed={showAdvancedJson}
                className={["gc-button", (`integrations-setup-mode-button${showAdvancedJson ? " active" : ""}`)].filter(Boolean).join(" ")}
                onClick={() => onShowAdvancedJsonChange(true)}
              >
                <span className="integrations-setup-mode-label">Advanced JSON</span>
                <span className="integrations-setup-mode-note">Raw config for edge cases</span>
              </button>
            </div>
            <div className="integrations-setup-mode-guidance">
              <article className={`integrations-setup-mode-card${!showAdvancedJson ? " selected" : ""}`}>
                <h4>{simpleFormLabel}</h4>
                <p>{guidedModeSummary}</p>
                <span>Use this when you want the easiest path.</span>
              </article>
              <article className={`integrations-setup-mode-card${showAdvancedJson ? " selected" : ""}`}>
                <h4>Advanced JSON</h4>
                <p>{advancedModeSummary}</p>
                <span>Use this only when docs or support tell you to.</span>
              </article>
            </div>
          </div>
          <p className="integrations-setup-mode-status">
            {!showAdvancedJson
              ? isFormSchemaLoading
                ? "Loading form fields..."
                : simpleFormSelectionLabel
              : "Advanced JSON mode is selected."}
          </p>
          <p className="office-subtitle">{selectedModeCallout}</p>
          {!showAdvancedJson ? (
            isFormSchemaLoading ? (
              <CardSkeleton lines={4} />
            ) : (
              <ConfigFormBuilder schema={formSchema} value={guidedConfig} onChange={onGuidedConfigChange} />
            )
          ) : (
            <>
              <label htmlFor="connectionConfig">Connection config (JSON)</label>
              <textarea
                id="connectionConfig"
                rows={8}
                className="full-textarea"
                value={configJson}
                onChange={(event) => onConfigJsonChange(event.target.value)}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => onCreate()}
            disabled={blockCreate || createPending || !selectedCatalogIsRunnable}
           className="gc-button">
            {createPending ? "Saving..." : "Save Connection"}
          </button>
        </>
      ) : null}
    </Panel>
  );
}

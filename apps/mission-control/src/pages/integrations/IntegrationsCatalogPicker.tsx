import type { IntegrationCatalogEntry } from "../../api/client";
import { DataToolbar } from "../../components/DataToolbar";
import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { GCSelect } from "../../components/ui";
import {
  formatChannelSetupPath,
  formatMaturity,
  formatRuntimeAvailability,
  getChannelSetupPathTone,
  resolveChannelSetupPath,
} from "../integrations-page-utils";

export interface IntegrationsCatalogPickerKindOption<K extends string> {
  value: K;
  label: string;
}

export interface IntegrationsCatalogPickerProps<K extends string> {
  isChannelsView: boolean;
  catalog: IntegrationCatalogEntry[];
  selectedCatalogId: string;
  onSelectCatalogId: (catalogId: string) => void;
  guidedChannelCatalogIds: Set<string>;
  channelCatalogTruthSummary: { guided: number; manual: number; blocked: number };
  isInitialLoading: boolean;
  // Non-channels view props
  kindFilter: K;
  onKindFilterChange: (value: K) => void;
  kindOptions: IntegrationsCatalogPickerKindOption<K>[];
  scopeSubtitle: string;
}

export function IntegrationsCatalogPicker<K extends string>(props: IntegrationsCatalogPickerProps<K>) {
  const {
    isChannelsView,
    catalog,
    selectedCatalogId,
    onSelectCatalogId,
    guidedChannelCatalogIds,
    channelCatalogTruthSummary,
    isInitialLoading,
    kindFilter,
    onKindFilterChange,
    kindOptions,
    scopeSubtitle,
  } = props;

  if (!isChannelsView) {
    return (
      <Panel title="Catalog Scope" subtitle={scopeSubtitle}>
        <DataToolbar
          primary={
            <div className="controls-row">
              <label htmlFor="integrationKind">
                Connection type
                <HelpHint
                  label="Connection type help"
                  text="Filter catalog entries by integration category. This does not remove existing connections."
                />
              </label>
              <GCSelect
                id="integrationKind"
                value={kindFilter}
                onChange={(value) => onKindFilterChange(value as K)}
                options={kindOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </div>
          }
          secondary={<StatusChip>{catalog.length} entries</StatusChip>}
        />
      </Panel>
    );
  }

  return (
    <Panel title="Channel Catalog" subtitle="Showing only channel adapters in this view.">
      <div className="workflow-summary-strip">
        <StatusChip>Kind locked to channels</StatusChip>
        <StatusChip>{catalog.length} channel entries</StatusChip>
        <StatusChip tone="success">{channelCatalogTruthSummary.guided} guided</StatusChip>
        <StatusChip tone="warning">{channelCatalogTruthSummary.manual} manual only</StatusChip>
        {channelCatalogTruthSummary.blocked > 0 ? (
          <StatusChip tone="critical">{channelCatalogTruthSummary.blocked} blocked</StatusChip>
        ) : null}
      </div>
      {!isInitialLoading ? (
        <div className="channel-setup-catalog">
          {catalog.map((entry) => {
            const selected = entry.catalogId === selectedCatalogId;
            const setupPath = resolveChannelSetupPath(entry, guidedChannelCatalogIds);
            return (
              <button
                key={entry.catalogId}
                type="button"
                className={`channel-setup-catalog-item${selected ? " selected" : ""}`}
                onClick={() => onSelectCatalogId(entry.catalogId)}
              >
                <div className="channel-setup-catalog-top">
                  <strong>{entry.label}</strong>
                  <StatusChip tone={getChannelSetupPathTone(setupPath)}>{formatChannelSetupPath(setupPath)}</StatusChip>
                </div>
                <FieldHelp>{entry.description}</FieldHelp>
                <FieldHelp>
                  Runtime: {formatRuntimeAvailability(entry.runtimeAvailability)}
                  {" · "}
                  Parity: {formatMaturity(entry.maturity)}
                </FieldHelp>
              </button>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

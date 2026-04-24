import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";

export interface IntegrationsPluginEntry {
  pluginId: string;
  label: string;
  source?: string;
  sourceMetadata?: {
    type: string;
    display: string;
    packageName?: string;
    packageVersion?: string;
    integrityStatus: string;
  };
  integrityStatus?: string;
  trustWarnings?: Array<{
    code: string;
    severity: string;
    message: string;
  }>;
  theme?: {
    accentColor?: string;
    icon?: string;
    dashboardVariant?: string;
  };
  version: string;
  capabilities: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface IntegrationsPluginsPanelProps {
  plugins: IntegrationsPluginEntry[];
  pluginSource: string;
  onPluginSourceChange: (value: string) => void;
  onInstallPlugin: () => void;
  onTogglePlugin: (pluginId: string, currentlyEnabled: boolean) => void;
  pluginBusyId: string | null;
}

export function IntegrationsPluginsPanel(props: IntegrationsPluginsPanelProps) {
  const { plugins, pluginSource, onPluginSourceChange, onInstallPlugin, onTogglePlugin, pluginBusyId } = props;

  return (
    <Panel
      title="Plugin Adapters"
      subtitle="Optional adapters for services that are not built in yet. Most users can skip this section."
    >
      <details className="advanced-panel">
        <summary>Install new plugin adapter (advanced)</summary>
        <FieldHelp>
          Reference install path: <code>templates/integration-plugins/reference-integration-plugin/</code>
        </FieldHelp>
        <div className="controls-row" style={{ marginTop: 10 }}>
          <input
            value={pluginSource}
            onChange={(event) => onPluginSourceChange(event.target.value)}
            placeholder="Plugin source (file path, URL, or package id)"
          />
          <button
            type="button"
            onClick={() => onInstallPlugin()}
            disabled={pluginBusyId === "install"}
            className="gc-button"
          >
            {pluginBusyId === "install" ? "Installing..." : "Install Plugin"}
          </button>
        </div>
      </details>
      <table className="gc-data-table">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Source / Trust</th>
            <th>Version</th>
            <th>Capabilities</th>
            <th>Status</th>
            <th>Updated</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {plugins.length === 0 ? (
            <tr>
              <td colSpan={7}>No plugins installed.</td>
            </tr>
          ) : (
            plugins.map((plugin) => (
              <tr
                key={plugin.pluginId}
                style={plugin.theme?.accentColor ? { borderLeft: `3px solid ${plugin.theme.accentColor}` } : undefined}
              >
                <td>
                  <strong>{plugin.label}</strong>
                  <div className="office-subtitle">{plugin.pluginId}</div>
                  {plugin.theme?.dashboardVariant ? (
                    <div className="office-subtitle">Theme: {plugin.theme.dashboardVariant}</div>
                  ) : null}
                </td>
                <td>
                  <div>{plugin.sourceMetadata?.display ?? plugin.source ?? "Unknown source"}</div>
                  <div className="office-subtitle">
                    {plugin.sourceMetadata?.type ?? "unknown"} /{" "}
                    {plugin.integrityStatus ?? plugin.sourceMetadata?.integrityStatus ?? "unknown"}
                  </div>
                  {plugin.trustWarnings?.length ? (
                    <div className="office-subtitle">
                      {plugin.trustWarnings.map((warning) => warning.code).join(", ")}
                    </div>
                  ) : null}
                </td>
                <td>{plugin.version}</td>
                <td>{plugin.capabilities.join(", ") || "-"}</td>
                <td>{plugin.enabled ? "enabled" : "disabled"}</td>
                <td>{new Date(plugin.updatedAt).toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => onTogglePlugin(plugin.pluginId, plugin.enabled)}
                    disabled={pluginBusyId === plugin.pluginId}
                    className="gc-button"
                  >
                    {pluginBusyId === plugin.pluginId
                      ? plugin.enabled
                        ? "Disabling..."
                        : "Enabling..."
                      : plugin.enabled
                        ? "Disable"
                        : "Enable"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";

export interface IntegrationsPluginEntry {
  pluginId: string;
  label: string;
  source?: string;
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
          <button type="button" onClick={() => onInstallPlugin()} disabled={pluginBusyId === "install"}>
            {pluginBusyId === "install" ? "Installing..." : "Install Plugin"}
          </button>
        </div>
      </details>
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
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
              <td colSpan={6}>No plugins installed.</td>
            </tr>
          ) : (
            plugins.map((plugin) => (
              <tr key={plugin.pluginId}>
                <td>
                  <strong>{plugin.label}</strong>
                  <div className="office-subtitle">{plugin.pluginId}</div>
                  {plugin.source ? <div className="office-subtitle">{plugin.source}</div> : null}
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

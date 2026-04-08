import type { ObsidianIntegrationStatus } from "../../api/client";
import { Panel } from "../../components/Panel";
import { GCSelect, GCSwitch } from "../../components/ui";

export type ObsidianMode = "read_append" | "read_only";
export type ObsidianBusyState = null | "save" | "test" | "search" | "capture";

export interface ObsidianSearchResultEntry {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
}

export interface IntegrationsObsidianPanelProps {
  obsidianEnabled: boolean;
  onObsidianEnabledChange: (value: boolean) => void;
  obsidianVaultPath: string;
  onObsidianVaultPathChange: (value: string) => void;
  obsidianMode: ObsidianMode;
  onObsidianModeChange: (value: ObsidianMode) => void;
  obsidianAllowedSubpaths: string;
  onObsidianAllowedSubpathsChange: (value: string) => void;
  obsidianBusy: ObsidianBusyState;
  onSaveObsidianConfig: () => void;
  onTestObsidian: () => void;
  obsidianStatus: ObsidianIntegrationStatus | null;
  obsidianQuery: string;
  onObsidianQueryChange: (value: string) => void;
  onSearchObsidian: () => void;
  obsidianSearchResults: ObsidianSearchResultEntry[];
  obsidianInboxRequest: string;
  onObsidianInboxRequestChange: (value: string) => void;
  onCaptureObsidianInbox: () => void;
}

export function IntegrationsObsidianPanel(props: IntegrationsObsidianPanelProps) {
  const {
    obsidianEnabled,
    onObsidianEnabledChange,
    obsidianVaultPath,
    onObsidianVaultPathChange,
    obsidianMode,
    onObsidianModeChange,
    obsidianAllowedSubpaths,
    onObsidianAllowedSubpathsChange,
    obsidianBusy,
    onSaveObsidianConfig,
    onTestObsidian,
    obsidianStatus,
    obsidianQuery,
    onObsidianQueryChange,
    onSearchObsidian,
    obsidianSearchResults,
    obsidianInboxRequest,
    onObsidianInboxRequestChange,
    onCaptureObsidianInbox,
  } = props;

  return (
    <Panel
      title="Obsidian (Preferred Local Notes Path)"
      subtitle="Use this when you want GoatCitadel to read and optionally append markdown in a local Obsidian vault."
    >
      <p className="office-subtitle">Use this for a local vault. Leave it disabled if you do not use Obsidian.</p>
      <ol>
        <li>Set the local vault path and save config.</li>
        <li>Run Test connection to confirm the vault is reachable.</li>
        <li>Optionally capture quick inbox requests into your Obsidian workflow.</li>
      </ol>
      <div className="controls-row">
        <GCSwitch
          checked={obsidianEnabled}
          onCheckedChange={onObsidianEnabledChange}
          label="Enable Obsidian integration"
        />
        <label htmlFor="obsidianVaultPath">Vault path</label>
        <input
          id="obsidianVaultPath"
          value={obsidianVaultPath}
          onChange={(event) => onObsidianVaultPathChange(event.target.value)}
          placeholder="F:\\AI Obsidian\\AI Info"
        />
      </div>
      <div className="controls-row">
        <label htmlFor="obsidianMode">Access mode</label>
        <GCSelect
          id="obsidianMode"
          value={obsidianMode}
          onChange={(value) => onObsidianModeChange(value as ObsidianMode)}
          options={[
            { value: "read_append", label: "read_append (recommended)" },
            { value: "read_only", label: "read_only" },
          ]}
        />
        <label htmlFor="obsidianAllowedSubpaths">Allowed subpaths (comma-separated)</label>
        <input
          id="obsidianAllowedSubpaths"
          value={obsidianAllowedSubpaths}
          onChange={(event) => onObsidianAllowedSubpathsChange(event.target.value)}
          placeholder="GoatCitadel, GoatCitadel/Inbox"
        />
        <button type="button" disabled={obsidianBusy === "save"} onClick={() => onSaveObsidianConfig()}>
          {obsidianBusy === "save" ? "Saving..." : "Save Obsidian config"}
        </button>
        <button type="button" disabled={obsidianBusy === "test"} onClick={() => onTestObsidian()}>
          {obsidianBusy === "test" ? "Testing..." : "Test connection"}
        </button>
      </div>
      {obsidianStatus ? (
        <div className="token-row">
          <span className={`token-chip ${obsidianStatus.vaultReachable ? "token-chip-active" : ""}`}>
            {obsidianStatus.vaultReachable ? "Vault reachable" : "Vault unreachable"}
          </span>
          <span className="token-chip">Mode: {obsidianStatus.mode}</span>
          <span className="token-chip">Last check: {new Date(obsidianStatus.checkedAt).toLocaleString()}</span>
          {obsidianStatus.lastOperationAt ? (
            <span className="token-chip">
              Last operation: {new Date(obsidianStatus.lastOperationAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      ) : null}
      {!obsidianStatus?.enabled ? (
        <p className="table-subtext">Obsidian is currently disabled. This is safe default behavior.</p>
      ) : null}
      {obsidianStatus?.enabled && !obsidianStatus.vaultReachable ? (
        <p className="error">Obsidian is enabled but vault is not reachable. Check your local path and permissions.</p>
      ) : null}
      {obsidianStatus?.lastError ? <p className="error">Last Obsidian error: {obsidianStatus.lastError}</p> : null}
      <details className="advanced-panel">
        <summary>Quick Obsidian operations</summary>
        <div className="controls-row">
          <label htmlFor="obsidianQuery">Search notes</label>
          <input
            id="obsidianQuery"
            value={obsidianQuery}
            onChange={(event) => onObsidianQueryChange(event.target.value)}
            placeholder="Prompt Lab"
          />
          <button type="button" disabled={obsidianBusy === "search"} onClick={() => onSearchObsidian()}>
            {obsidianBusy === "search" ? "Searching..." : "Search"}
          </button>
        </div>
        {obsidianSearchResults.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Note</th>
                <th>Snippet</th>
              </tr>
            </thead>
            <tbody>
              {obsidianSearchResults.map((item) => (
                <tr key={item.relativePath}>
                  <td>{item.relativePath}</td>
                  <td>{item.snippet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="table-subtext">No search results yet.</p>
        )}
        <div className="controls-row">
          <label htmlFor="obsidianInboxRequest">Capture inbox request</label>
          <input
            id="obsidianInboxRequest"
            value={obsidianInboxRequest}
            onChange={(event) => onObsidianInboxRequestChange(event.target.value)}
            placeholder="Investigate score failures in Prompt Lab"
          />
          <button type="button" disabled={obsidianBusy === "capture"} onClick={() => onCaptureObsidianInbox()}>
            {obsidianBusy === "capture" ? "Capturing..." : "Capture to Obsidian inbox"}
          </button>
        </div>
      </details>
    </Panel>
  );
}

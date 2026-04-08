import type { ConnectorDiagnosticReport, ConnectorRecord } from "@goatcitadel/contracts";
import type { IntegrationConnection } from "../../api/client";
import { DataToolbar } from "../../components/DataToolbar";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { formatKind, formatStatus, renderConnectorApprovalDeliverySummary } from "../integrations-page-utils";

export interface IntegrationsConnectionsTableProps {
  connectionsTitle: string;
  connectionsSubtitle: string;
  connectionSearch: string;
  onConnectionSearchChange: (value: string) => void;
  connections: IntegrationConnection[];
  filteredConnections: IntegrationConnection[];
  catalogLabelById: Map<string, string>;
  connectorBySourceId: Map<string, ConnectorRecord>;
  connectorDiagnosticsEnabled: boolean;
  pluginBusyId: string | null;
  deleteActionPending: boolean;
  onToggle: (connection: IntegrationConnection) => void;
  onRunDiagnostics: (connectionId: string) => void;
  onSetDeleteTarget: (connection: IntegrationConnection) => void;
  selectedDiagnosticConnectionId: string | null;
  selectedDiagnostics: ConnectorDiagnosticReport | undefined;
}

export function IntegrationsConnectionsTable(props: IntegrationsConnectionsTableProps) {
  const {
    connectionsTitle,
    connectionsSubtitle,
    connectionSearch,
    onConnectionSearchChange,
    connections,
    filteredConnections,
    catalogLabelById,
    connectorBySourceId,
    connectorDiagnosticsEnabled,
    pluginBusyId,
    deleteActionPending,
    onToggle,
    onRunDiagnostics,
    onSetDeleteTarget,
    selectedDiagnosticConnectionId,
    selectedDiagnostics,
  } = props;

  return (
    <Panel title={connectionsTitle} subtitle={connectionsSubtitle}>
      <DataToolbar
        primary={
          <div className="controls-row">
            <label htmlFor="connectionSearch">Filter</label>
            <input
              id="connectionSearch"
              value={connectionSearch}
              onChange={(event) => onConnectionSearchChange(event.target.value)}
              placeholder="Search label, catalog, status, error..."
            />
          </div>
        }
        secondary={<StatusChip>{filteredConnections.length} visible</StatusChip>}
      />
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Catalog</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Approval delivery</th>
            <th>Enabled</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredConnections.length === 0 ? (
            <tr>
              <td colSpan={8}>
                {connections.length === 0
                  ? "No configured connections yet. Create one above to get started."
                  : "No connections match this filter."}
              </td>
            </tr>
          ) : (
            filteredConnections.map((connection) => (
              <tr key={connection.connectionId}>
                <td>{connection.label}</td>
                <td>
                  {catalogLabelById.get(connection.catalogId) ?? connection.catalogId}
                  <div className="table-subtext">{connection.catalogId}</div>
                </td>
                <td>{formatKind(connection.kind)}</td>
                <td>
                  {formatStatus(connection.status)}
                  {connection.lastError ? <div className="table-subtext">{connection.lastError}</div> : null}
                </td>
                <td>
                  {renderConnectorApprovalDeliverySummary(connectorBySourceId.get(connection.connectionId), connection)}
                </td>
                <td>{connection.enabled ? "yes" : "no"}</td>
                <td>{new Date(connection.updatedAt).toLocaleString()}</td>
                <td className="actions">
                  <button type="button" onClick={() => onToggle(connection)}>
                    {connection.enabled ? "Pause" : "Enable"}
                  </button>
                  {connectorDiagnosticsEnabled ? (
                    <button
                      type="button"
                      onClick={() => onRunDiagnostics(connection.connectionId)}
                      disabled={pluginBusyId === `diag:${connection.connectionId}`}
                    >
                      {pluginBusyId === `diag:${connection.connectionId}` ? "Running..." : "Diagnose"}
                    </button>
                  ) : (
                    <span className="table-subtext">Diagnostics disabled</span>
                  )}
                  <button
                    type="button"
                    className="danger"
                    onClick={() => onSetDeleteTarget(connection)}
                    disabled={deleteActionPending}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {connectorDiagnosticsEnabled && selectedDiagnosticConnectionId && selectedDiagnostics ? (
        <details open style={{ marginTop: 12 }}>
          <summary>
            Diagnostics for{" "}
            {connections.find((item) => item.connectionId === selectedDiagnosticConnectionId)?.label ??
              selectedDiagnosticConnectionId}
            {" • "}
            {selectedDiagnostics.status}
            {" • "}
            {new Date(selectedDiagnostics.checkedAt).toLocaleString()}
          </summary>
          <ul className="improvement-simple-list">
            {selectedDiagnostics.checks.map((check) => (
              <li key={`${check.key}:${check.message}`}>
                <strong>{check.key}</strong> [{check.status}] - {check.message}
              </li>
            ))}
          </ul>
          {selectedDiagnostics.probe?.steps?.length ? (
            <>
              <p className="office-subtitle">
                <strong>Probe truth</strong>
              </p>
              <ul className="improvement-simple-list">
                {selectedDiagnostics.probe.steps.map((step) => (
                  <li key={`${step.key}:${step.message}`}>
                    <strong>{step.label}</strong> [{step.status}] - {step.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {selectedDiagnostics.recommendedNextAction ? (
            <p className="office-subtitle">Next step: {selectedDiagnostics.recommendedNextAction}</p>
          ) : null}
        </details>
      ) : null}
      {!connectorDiagnosticsEnabled ? (
        <FieldHelp>
          Connector diagnostics are disabled in this runtime. Status and configuration still render, but active
          diagnosis runs are intentionally hidden until the feature is enabled.
        </FieldHelp>
      ) : null}
    </Panel>
  );
}

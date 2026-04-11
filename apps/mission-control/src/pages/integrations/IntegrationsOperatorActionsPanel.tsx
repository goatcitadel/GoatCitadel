import { useMemo, useState } from "react";
import type {
  IntegrationActionInvokeResult,
  IntegrationCatalogEntry,
  IntegrationConnection,
  IntegrationOperatorAction,
} from "../../api/client";
import { ConfigFormBuilder } from "../../components/ConfigFormBuilder";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { GCSelect } from "../../components/ui";

interface IntegrationsOperatorActionsPanelProps {
  catalog: IntegrationCatalogEntry[];
  connections: IntegrationConnection[];
  busyKey: string | null;
  result: IntegrationActionInvokeResult | null;
  onRunAction: (
    connection: IntegrationConnection,
    action: IntegrationOperatorAction,
    input: Record<string, unknown>,
  ) => Promise<void> | void;
}

export function IntegrationsOperatorActionsPanel({
  catalog,
  connections,
  busyKey,
  result,
  onRunAction,
}: IntegrationsOperatorActionsPanelProps) {
  const actionableConnections = useMemo(
    () =>
      connections
        .filter((connection) => connection.kind !== "channel")
        .map((connection) => {
          const catalogEntry = catalog.find((entry) => entry.catalogId === connection.catalogId);
          return catalogEntry?.operatorActions?.length
            ? { connection, catalogEntry }
            : null;
        })
        .filter((item): item is { connection: IntegrationConnection; catalogEntry: IntegrationCatalogEntry } => Boolean(item)),
    [catalog, connections],
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedActionId, setSelectedActionId] = useState("");
  const [actionInput, setActionInput] = useState<Record<string, unknown>>({});

  const selectedBundle = actionableConnections.find((item) => item.connection.connectionId === selectedConnectionId)
    ?? actionableConnections[0]
    ?? null;
  const availableActions = selectedBundle?.catalogEntry.operatorActions ?? [];
  const selectedAction = availableActions.find((action) => action.actionId === selectedActionId)
    ?? availableActions[0]
    ?? null;
  const activeBusyKey = selectedBundle && selectedAction
    ? `${selectedBundle.connection.connectionId}:${selectedAction.actionId}`
    : null;

  if (actionableConnections.length === 0) {
    return null;
  }

  return (
    <Panel
      title="Operator Actions"
      subtitle="Visible non-channel integrations expose runnable read, write, search, or capture checks here."
      padding="compact"
    >
      <div className="stack-md">
        <div className="workflow-form-grid">
          <label className="field-label">
            Connection
            <GCSelect
              value={selectedBundle?.connection.connectionId ?? ""}
              onChange={(value) => {
                setSelectedConnectionId(value);
                setSelectedActionId("");
                setActionInput({});
              }}
              options={actionableConnections.map((item) => ({
                value: item.connection.connectionId,
                label: `${item.connection.label} (${item.catalogEntry.label})`,
              }))}
            />
          </label>
          <label className="field-label">
            Action
            <GCSelect
              value={selectedAction?.actionId ?? ""}
              onChange={(value) => {
                setSelectedActionId(value);
                setActionInput({});
              }}
              disabled={!selectedBundle}
              options={availableActions.map((action) => ({
                value: action.actionId,
                label: action.label,
              }))}
            />
          </label>
        </div>
        {selectedAction ? (
          <div className="card stack-sm">
            <div className="workflow-summary-strip">
              <StatusChip tone="muted">{selectedBundle?.catalogEntry.maturity ?? "beta"}</StatusChip>
              <StatusChip tone="muted">{selectedAction.capability}</StatusChip>
              <StatusChip tone={selectedBundle?.connection.enabled ? "success" : "warning"}>
                {selectedBundle?.connection.enabled ? "Enabled" : "Disabled"}
              </StatusChip>
            </div>
            <p><strong>{selectedAction.label}</strong></p>
            <p className="office-subtitle">{selectedAction.description}</p>
            {selectedAction.formSchema ? (
              <ConfigFormBuilder
                schema={selectedAction.formSchema}
                value={actionInput}
                onChange={setActionInput}
              />
            ) : null}
            <div className="toolbar-row">
              <button
                type="button"
                className="btn"
                disabled={!selectedBundle || !selectedAction || busyKey === activeBusyKey}
                onClick={() => {
                  if (!selectedBundle || !selectedAction) {
                    return;
                  }
                  void onRunAction(selectedBundle.connection, selectedAction, actionInput);
                }}
              >
                {busyKey === activeBusyKey ? "Running..." : `Run ${selectedAction.label}`}
              </button>
            </div>
          </div>
        ) : null}
        {result ? (
          <div className="card stack-sm">
            <div className="workflow-summary-strip">
              <StatusChip tone={result.status === "executed" ? "success" : result.status === "blocked" ? "warning" : "critical"}>
                {result.status}
              </StatusChip>
              <StatusChip tone="muted">{result.checkedAt}</StatusChip>
            </div>
            <p className="office-subtitle">{result.message}</p>
            {result.blockedReason ? <p className="office-subtitle">Blocked reason: {result.blockedReason}</p> : null}
            {result.output ? (
              <details>
                <summary>Action output</summary>
                <pre>{JSON.stringify(result.output, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

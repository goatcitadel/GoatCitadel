import type { ConnectorRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { GCSwitch, GCSelect } from "../../components/ui";
import {
  describeConnectorApprovalDelivery,
  describeMcpBlockReason,
  readConnectorApprovalReady,
} from "./mcp-page-helpers";

interface McpSelectedServerPanelProps {
  selected: {
    serverId: string;
    status: "disconnected" | "connecting" | "connected" | "error";
    authType: "none" | "token" | "oauth2";
    enabled: boolean;
    trustTier: "trusted" | "restricted" | "quarantined";
    policy: {
      requireFirstToolApproval: boolean;
      redactionMode: "off" | "basic" | "strict";
      blockedToolPatterns: string[];
      allowedToolPatterns: string[];
      notes?: string;
    };
  } | null;
  selectedConnector: ConnectorRecord | null;
  selectedDiagnostic?: {
    status: "ok" | "warn" | "error";
    checks: Array<{ key: string; status: "pass" | "warn" | "fail"; message: string }>;
    recommendedNextAction?: string;
    checkedAt: string;
  };
  busy: boolean;
  policyRequireFirst: boolean;
  setPolicyRequireFirst: (value: boolean) => void;
  policyRedaction: "off" | "basic" | "strict";
  setPolicyRedaction: (value: "off" | "basic" | "strict") => void;
  policyAllowed: string;
  setPolicyAllowed: (value: string) => void;
  policyBlocked: string;
  setPolicyBlocked: (value: string) => void;
  policyNotes: string;
  setPolicyNotes: (value: string) => void;
  setPolicyDirty: (value: boolean) => void;
  policyDirty: boolean;
  onToggleConnection: () => Promise<void>;
  onStartOAuth: () => Promise<void>;
  onDelete: () => void;
  onHealthCheck: () => Promise<void>;
  onSavePolicy: () => Promise<void>;
}

export function McpSelectedServerPanel(props: McpSelectedServerPanelProps) {
  const {
    selected,
    selectedConnector,
    selectedDiagnostic,
    busy,
    policyRequireFirst,
    setPolicyRequireFirst,
    policyRedaction,
    setPolicyRedaction,
    policyAllowed,
    setPolicyAllowed,
    policyBlocked,
    setPolicyBlocked,
    policyNotes,
    setPolicyNotes,
    setPolicyDirty,
    policyDirty,
    onToggleConnection,
    onStartOAuth,
    onDelete,
    onHealthCheck,
    onSavePolicy,
  } = props;

  if (!selected) {
    return null;
  }

  return (
    <div className="stack-md">
      <div className="actions">
        <ActionButton
          label={selected.status === "connected" ? "Disconnect" : "Connect"}
          pending={busy}
          onClick={() => void onToggleConnection()}
        />
        {selected.authType === "oauth2" ? (
          <ActionButton label="Start OAuth" pending={busy} onClick={() => void onStartOAuth()} />
        ) : null}
        <ActionButton label="Delete" pending={busy} danger onClick={onDelete} />
        <ActionButton label="Health Check" pending={busy} onClick={() => void onHealthCheck()} />
      </div>
      <p className="office-subtitle">{describeMcpBlockReason(selected)}</p>
      {selectedConnector ? (
        <div className="prompt-lab-run-summary">
          <p>
            <strong>Approval delivery</strong>{" "}
            <span className={`token-chip ${readConnectorApprovalReady(selectedConnector) ? "token-chip-active" : ""}`}>
              {readConnectorApprovalReady(selectedConnector) ? "ready" : "not ready"}
            </span>
          </p>
          <p className="office-subtitle">{describeConnectorApprovalDelivery(selectedConnector)}</p>
        </div>
      ) : null}
      {selectedDiagnostic ? (
        <details open>
          <summary>
            Latest health check: {selectedDiagnostic.status}
            {" • "}
            {new Date(selectedDiagnostic.checkedAt).toLocaleString()}
          </summary>
          <ul className="improvement-simple-list">
            {selectedDiagnostic.checks.map((check) => (
              <li key={`${check.key}:${check.message}`}>
                <strong>{check.key}</strong> [{check.status}] - {check.message}
              </li>
            ))}
          </ul>
          {selectedDiagnostic.recommendedNextAction ? (
            <p className="office-subtitle">Next step: {selectedDiagnostic.recommendedNextAction}</p>
          ) : null}
        </details>
      ) : null}
      <div className="controls-row">
        <label className="checkbox-inline">
          <GCSwitch
            checked={policyRequireFirst}
            onCheckedChange={(checked) => {
              setPolicyRequireFirst(checked);
              setPolicyDirty(true);
            }}
            label="Require first-use approval"
          />
        </label>
        <label htmlFor="mcpPolicyRedaction">Redaction mode</label>
        <GCSelect
          id="mcpPolicyRedaction"
          value={policyRedaction}
          onChange={(value) => {
            setPolicyRedaction(value as "off" | "basic" | "strict");
            setPolicyDirty(true);
          }}
          options={[
            { value: "off", label: "off" },
            { value: "basic", label: "basic" },
            { value: "strict", label: "strict" },
          ]}
        />
      </div>
      <div className="controls-row">
        <label htmlFor="mcpAllowedPatterns">Allow patterns</label>
        <input
          id="mcpAllowedPatterns"
          placeholder="search.*, fetch"
          value={policyAllowed}
          onChange={(event) => {
            setPolicyAllowed(event.target.value);
            setPolicyDirty(true);
          }}
        />
      </div>
      <div className="controls-row">
        <label htmlFor="mcpBlockedPatterns">Block patterns</label>
        <input
          id="mcpBlockedPatterns"
          placeholder="admin.*, shell.*"
          value={policyBlocked}
          onChange={(event) => {
            setPolicyBlocked(event.target.value);
            setPolicyDirty(true);
          }}
        />
      </div>
      <div className="controls-row">
        <label htmlFor="mcpPolicyNotes">Notes</label>
        <input
          id="mcpPolicyNotes"
          placeholder="Optional policy note"
          value={policyNotes}
          onChange={(event) => {
            setPolicyNotes(event.target.value);
            setPolicyDirty(true);
          }}
        />
        <ActionButton label="Save Policy" pending={busy} disabled={!policyDirty} onClick={() => void onSavePolicy()} />
      </div>
    </div>
  );
}

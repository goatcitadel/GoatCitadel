import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { DataToolbar } from "../../components/DataToolbar";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";

interface ToolActiveGrantsPanelProps {
  grantFilter: string;
  setGrantFilter: (value: string) => void;
  visibleGrants: ToolGrantRecord[];
  onRevoke: (grantId: string) => Promise<void>;
}

export function ToolActiveGrantsPanel(props: ToolActiveGrantsPanelProps) {
  const { grantFilter, setGrantFilter, visibleGrants, onRevoke } = props;

  return (
    <Panel title="Active Grants" subtitle="Review, filter, and revoke scoped permissions.">
      <DataToolbar
        primary={
          <div className="controls-row">
            <label>Filter</label>
            <input
              value={grantFilter}
              onChange={(event) => setGrantFilter(event.target.value)}
              placeholder="Search tool, scope, decision, created by..."
            />
          </div>
        }
        secondary={<StatusChip>{visibleGrants.length} visible</StatusChip>}
      />
      <table className="gc-data-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Decision</th>
            <th>Scope</th>
            <th>Type</th>
            <th>Expires</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visibleGrants.map((grant) => (
            <tr key={grant.grantId}>
              <td>{grant.toolPattern}</td>
              <td>{grant.decision}</td>
              <td>
                {grant.scope}:{grant.scopeRef}
              </td>
              <td>{grant.grantType}</td>
              <td>{grant.expiresAt ?? "-"}</td>
              <td>
                {grant.revokedAt ? (
                  <span>revoked</span>
                ) : (
                  <button type="button" className="gc-button danger" onClick={() => void onRevoke(grant.grantId)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {visibleGrants.length === 0 ? (
            <tr>
              <td colSpan={6}>No grants match your filter.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Panel>
  );
}


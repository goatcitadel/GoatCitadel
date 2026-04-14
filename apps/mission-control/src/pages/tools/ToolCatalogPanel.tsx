import type { ToolCatalogEntry } from "@goatcitadel/contracts";
import { DataToolbar } from "../../components/DataToolbar";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";

interface ToolCatalogPanelProps {
  showTechnicalDetails: boolean;
  catalogFilter: string;
  setCatalogFilter: (value: string) => void;
  catalogCount: number;
  catalogByPack: {
    core: ToolCatalogEntry[];
    devops: ToolCatalogEntry[];
    knowledge: ToolCatalogEntry[];
    comms: ToolCatalogEntry[];
  };
}

export function ToolCatalogPanel(props: ToolCatalogPanelProps) {
  const { showTechnicalDetails, catalogFilter, setCatalogFilter, catalogCount, catalogByPack } = props;

  return (
    <Panel
      title="Tool Catalog"
      subtitle="Inspect the full tool surface by pack, category, risk, and approval posture."
      className={showTechnicalDetails ? "" : "expert-only"}
      collapsible
      defaultExpanded={false}
      rank="muted"
      padding="compact"
    >
      <DataToolbar
        primary={
          <div className="controls-row">
            <label>Filter</label>
            <input
              value={catalogFilter}
              onChange={(event) => setCatalogFilter(event.target.value)}
              placeholder="Search by tool name, category, or description..."
            />
          </div>
        }
        center={<span className="table-subtext">Use the catalog as evidence, not the page headline.</span>}
        secondary={<StatusChip>{catalogCount} total</StatusChip>}
      />
      {(["core", "devops", "knowledge", "comms"] as const).map((pack) => (
        <div key={pack}>
          <h4>{pack.toUpperCase()}</h4>
          <table className="gc-data-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Category</th>
                <th>Risk</th>
                <th>Approval</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {catalogByPack[pack].map((entry) => (
                <tr key={entry.toolName}>
                  <td>{entry.toolName}</td>
                  <td>{entry.category}</td>
                  <td>{entry.riskLevel}</td>
                  <td>{entry.requiresApproval ? "yes" : "no"}</td>
                  <td>{entry.description}</td>
                </tr>
              ))}
              {catalogByPack[pack].length === 0 ? (
                <tr>
                  <td colSpan={5}>No tools in this pack.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ))}
    </Panel>
  );
}

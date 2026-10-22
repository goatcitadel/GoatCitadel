import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { TOOL_GRANT_SCOPE_LABELS } from "./tool-grant-labels";

type GrantScope = Pick<ToolGrantRecord, "scope"> & { scopeRef?: string };

/**
 * Names where a grant applies (ST-14): "Workspace: Research", "Workspace: This workspace" for the active one, or
 * "Workspace: Another workspace" when the workspace has no name here. Other scopes read their plain label; the raw
 * scope reference stays in technical details.
 */
export function useToolGrantScopeLabel(): (grant: GrantScope) => string {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const nameOf = useWorkspaceNameLookup(activeCitadelId);
  return (grant) => {
    const label = TOOL_GRANT_SCOPE_LABELS[grant.scope] ?? "Unknown scope";
    if (grant.scope !== "workspace") return label;
    if (!grant.scopeRef) return `${label}: Not recorded`;
    if (grant.scopeRef === activeWorkspaceId) return `${label}: This workspace`;
    return `${label}: ${nameOf(grant.scopeRef) ?? "Another workspace"}`;
  };
}

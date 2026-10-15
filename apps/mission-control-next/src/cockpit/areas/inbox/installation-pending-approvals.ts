import { useQuery } from "@tanstack/react-query";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import type { ApprovalsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl, getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/client-core";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

/** The most pending requests one scope read returns; a continuation cursor means there are more. */
export const INSTALLATION_SCOPE_LIMIT = 200;

/**
 * Every pending approval across the installation (no workspace filter), so an installation-wide rejection can state
 * its scope before it is confirmed. The key sits under the approvals topic, so approval events refresh it.
 */
export function useInstallationPendingApprovals() {
  return useQuery({
    queryKey: ["approvals", "pending", "installation", getGatewayApiBaseUrl(), getGatewayAccessRevision()],
    queryFn: () => fetchApprovals({ status: "pending", limit: INSTALLATION_SCOPE_LIMIT }),
  });
}

export interface InstallationRejectionScope {
  count: number;
  summary: string;
  workspaces: string;
  /** Workspace IDs with no name here, for technical details only. */
  unnamedWorkspaceIds: string[];
}

/** Plain-language scope for an installation-wide rejection: how many requests, across how many workspaces. */
export function describeInstallationScope(
  data: ApprovalsResponse,
  nameOf: (workspaceId?: string) => string | undefined,
): InstallationRejectionScope {
  const count = data.items.length;
  const more = Boolean(data.nextCursor);
  const ids = [
    ...new Set(data.items.map((item) => item.linkage?.workspaceId).filter((id): id is string => Boolean(id))),
  ];
  const atLeast = more ? "at least " : "";
  const unscoped = data.items.some((item) => !item.linkage?.workspaceId);
  const summary =
    count === 0
      ? "There is nothing pending to reject."
      : `Rejects ${atLeast}${plural(count, "pending request")} across ${atLeast}${plural(ids.length, "workspace")}.` +
        (unscoped ? " Some requests have no workspace recorded." : "");
  // Named workspaces are listed; unnamed ones are counted here and identified only in technical details.
  const named = ids.map((id) => nameOf(id)).filter((name): name is string => Boolean(name));
  const unnamedWorkspaceIds = ids.filter((id) => !nameOf(id));
  const unnamed = unnamedWorkspaceIds.length
    ? plural(unnamedWorkspaceIds.length, named.length ? "other workspace" : "unnamed workspace")
    : "";
  const labels = [...named, ...(unnamed ? [unnamed] : [])];
  const workspaces = labels.length ? `Workspaces: ${labels.join(", ")}.` : "";
  return { count, summary, workspaces, unnamedWorkspaceIds };
}

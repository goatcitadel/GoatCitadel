import { useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchMcpServer, updateMcpServer } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { mcpToggleUnavailableReason } from "../../../../features/native-routes/settings/use-mcp-enabled";
import { queryKeys } from "../../../data/query-keys";

export const CONNECTOR_CONFLICT_MESSAGE = "Changed elsewhere. Reload to see the latest.";
const NO_BINDING_REASON = "This server's saved version isn't available, so it can't be switched here.";
const CHECK_FAILED_REASON = "Couldn't check whether it can be switched on. Try again.";

type RowLook = Pick<CapabilityConnectorItem, "state" | "reason" | "group">;

// What the row reads like while a switch is saving. The list is read again when the save lands, so a guess about the
// "on" look never outlives the answer: a server that needs sign-in shows that as soon as the Gateway has said so.
const ON_LOOK: RowLook = { state: "connected", reason: "ready", group: "connected" };
const OFF_LOOK: RowLook = { state: "turned_off", reason: "turned_off", group: "turned_off" };

/** A copy of the list with one row changed. Every other row is kept as it is. */
function withRow(
  list: CapabilityConnectorsResponse | undefined,
  id: string,
  change: (row: CapabilityConnectorItem) => CapabilityConnectorItem,
): CapabilityConnectorsResponse | undefined {
  return list ? { ...list, items: list.items.map((row) => (row.id === id ? change(row) : row)) } : list;
}

export interface ConnectorEnabled {
  enabled: boolean;
  /** A save is running, or the check that decides whether a switched-off server can be switched on is. */
  pending: boolean;
  /** Plain words about why the last change did not happen. */
  error?: string;
  /** The last change was refused because the server changed somewhere else. `reload` is the way forward. */
  conflict: boolean;
  /** Why the switch can't be used. */
  unavailableReason?: string;
  setEnabled(next: boolean): void;
  /** Reads the list again and drops the last error. */
  reload(): void;
}

/**
 * The on/off switch of a saved MCP server. The change shows in the cached list at once and is saved with the version
 * the list carried; a failure puts back only this row's look and says why. `item` should be the live row from the
 * cached list, so the switch follows the optimistic change.
 */
export function useConnectorEnabled(item: CapabilityConnectorItem): ConnectorEnabled {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = queryKeys.capabilityConnectors(workspaceId);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | undefined>();
  // State is one render behind a second click in the same tick; this is not.
  const busy = useRef(false);

  const { serverId, serverRevision } = item;
  const enabled = item.state !== "turned_off";
  // A server that is on can always be switched off. A switched-off one is checked before it is switched on, with the
  // same rule Settings uses.
  const needsCheck = !enabled && Boolean(serverId);
  const check = useQuery({
    queryKey: queryKeys.capabilityConnectorServer(serverId ?? ""),
    queryFn: needsCheck && serverId ? () => fetchMcpServer(serverId) : skipToken,
  });
  const checking = needsCheck && check.isPending;
  const unavailableReason =
    !serverId || !serverRevision
      ? NO_BINDING_REASON
      : needsCheck
        ? check.isError
          ? CHECK_FAILED_REASON
          : check.data
            ? mcpToggleUnavailableReason(check.data)
            : undefined
        : undefined;

  async function save(next: boolean) {
    if (busy.current || checking || unavailableReason || !serverId || !serverRevision) return;
    busy.current = true;
    setSaving(true);
    setFailure(undefined);
    const before: RowLook = { state: item.state, reason: item.reason, group: item.group };
    try {
      // A read that started before the change would put the old look back. Cancelling starts at once, so the row
      // changes in the same turn as the click.
      void client.cancelQueries({ queryKey: listKey });
      client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
        withRow(list, item.id, (row) => ({ ...row, ...(next ? ON_LOOK : OFF_LOOK) })),
      );
      const saved = await updateMcpServer(serverId, { expectedRevision: serverRevision, enabled: next });
      // The next switch has to start from the version this save made.
      client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
        withRow(list, item.id, (row) => ({
          ...row,
          ...(saved.revision !== undefined ? { serverRevision: saved.revision } : {}),
          ...(saved.connectionRevision !== undefined ? { serverConnectionRevision: saved.connectionRevision } : {}),
        })),
      );
      void client.invalidateQueries({ queryKey: listKey });
      void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorServer(serverId) });
      void client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
    } catch (error) {
      // Only this row goes back. A newer list may have landed for the others.
      client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
        withRow(list, item.id, (row) => ({ ...row, ...before })),
      );
      const described = describeApiError(error);
      const conflict = described.category === "conflict";
      setFailure({ message: conflict ? CONNECTOR_CONFLICT_MESSAGE : described.summary, conflict });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return {
    enabled,
    pending: saving || checking,
    ...(failure ? { error: failure.message } : {}),
    conflict: failure?.conflict ?? false,
    ...(unavailableReason ? { unavailableReason } : {}),
    setEnabled: (next) => void save(next),
    reload: () => {
      setFailure(undefined);
      void client.invalidateQueries({ queryKey: listKey });
    },
  };
}

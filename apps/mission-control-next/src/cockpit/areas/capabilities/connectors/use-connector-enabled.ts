import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse, McpServerRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchMcpServer, updateMcpServer } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { mcpToggleUnavailableReason } from "../../../../features/native-routes/settings/use-mcp-enabled";
import { queryKeys } from "../../../data/query-keys";

export const CONNECTOR_CONFLICT_MESSAGE = "Changed elsewhere. Reload to see the latest.";
const NO_BINDING_REASON = "This server's saved version isn't available, so it can't be switched here.";
const CHECK_FAILED_REASON = "Couldn't check whether it can be switched on.";

type RowLook = Pick<CapabilityConnectorItem, "state" | "reason" | "group">;

// Switching off is the safe direction, so the row may say so before the Gateway does. Switching on is not: whether the
// server really connects (or needs a sign-in, or fails) is only known once the list is read again, so nothing but the
// switch itself moves until then.
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
  /** What the switch shows: the choice just made while it saves, otherwise the connector's own state. */
  enabled: boolean;
  /** A save, or the read that confirms it, is running; or the check that decides whether a switched-off server can be switched on. */
  pending: boolean;
  /** Plain words about why the last change did not happen. */
  error?: string;
  /** The last change was refused because the server changed somewhere else. `reload` is the way forward. */
  conflict: boolean;
  /** Why the switch can't be used. */
  unavailableReason?: string;
  /** Present when the check behind `unavailableReason` failed: run it again. */
  checkRetry?: { run(): void; running: boolean };
  setEnabled(next: boolean): void;
  /** Reads the list again and drops the last error. */
  reload(): void;
}

/**
 * The on/off switch of a saved MCP server. The switch moves at once and the change is saved with the version the list
 * carried. Switching off also shows in the cached list right away, and a failure puts back only that row's look;
 * switching on leaves the list alone until the confirming read says what the server did. `item` should be the live row
 * from the cached list.
 */
export function useConnectorEnabled(item: CapabilityConnectorItem): ConnectorEnabled {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = queryKeys.capabilityConnectors(workspaceId);
  const [saving, setSaving] = useState(false);
  // The choice the switch shows from the click until the confirming read lands.
  const [shown, setShown] = useState<boolean | undefined>();
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | undefined>();
  // State is one render behind a second click in the same tick; this is not.
  const busy = useRef(false);

  const { serverId, serverRevision } = item;
  const enabled = shown ?? item.state !== "turned_off";
  // A server that is on can always be switched off. A switched-off one is checked before it is switched on, with the
  // same rule Settings uses. The check is off (not a missing `queryFn`) when nothing needs it, so a re-read of the
  // server after a save is skipped instead of failing.
  const needsCheck = item.state === "turned_off" && Boolean(serverId);
  const check = useQuery({
    queryKey: queryKeys.capabilityConnectorServer(serverId ?? ""),
    queryFn: (): Promise<McpServerRecord> => fetchMcpServer(serverId ?? ""),
    enabled: needsCheck,
  });
  // A failed check keeps its failure (and its Retry) on screen while it runs again.
  const checkFailed = needsCheck && !check.data && check.errorUpdateCount > 0;
  const checking = needsCheck && check.isPending && !checkFailed;
  const unavailableReason =
    !serverId || !serverRevision
      ? NO_BINDING_REASON
      : checkFailed
        ? CHECK_FAILED_REASON
        : needsCheck && check.data
          ? mcpToggleUnavailableReason(check.data)
          : undefined;

  async function save(next: boolean) {
    if (busy.current || checking || unavailableReason || !serverId || !serverRevision) return;
    busy.current = true;
    setSaving(true);
    setShown(next);
    setFailure(undefined);
    const before: RowLook = { state: item.state, reason: item.reason, group: item.group };
    try {
      let saved: McpServerRecord;
      try {
        if (!next) {
          // A read that started before the change would put the old look back. Cancelling starts at once, so the row
          // changes in the same turn as the click.
          void client.cancelQueries({ queryKey: listKey });
          client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
            withRow(list, item.id, (row) => ({ ...row, ...OFF_LOOK })),
          );
        }
        saved = await updateMcpServer(serverId, { expectedRevision: serverRevision, enabled: next });
      } catch (error) {
        // Only this row goes back, and only when it was changed. A newer list may have landed for the others.
        if (!next) {
          client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
            withRow(list, item.id, (row) => ({ ...row, ...before })),
          );
        }
        const described = describeApiError(error);
        const conflict = described.category === "conflict";
        setFailure({ message: conflict ? CONNECTOR_CONFLICT_MESSAGE : described.summary, conflict });
        return;
      }
      // The next switch has to start from the version this save made. This is not a claim about the connector's state.
      client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
        withRow(list, item.id, (row) => ({
          ...row,
          ...(saved.revision !== undefined ? { serverRevision: saved.revision } : {}),
          ...(saved.connectionRevision !== undefined ? { serverConnectionRevision: saved.connectionRevision } : {}),
        })),
      );
      void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectorServer(serverId) });
      void client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
      // The switch holds its choice until the Gateway's own answer is in the list.
      await client.invalidateQueries({ queryKey: listKey });
    } finally {
      busy.current = false;
      setShown(undefined);
      setSaving(false);
    }
  }

  return {
    enabled,
    pending: saving || checking,
    ...(failure ? { error: failure.message } : {}),
    conflict: failure?.conflict ?? false,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(checkFailed ? { checkRetry: { run: () => void check.refetch(), running: check.isFetching } } : {}),
    setEnabled: (next) => void save(next),
    reload: () => {
      setFailure(undefined);
      void client.invalidateQueries({ queryKey: listKey });
    },
  };
}

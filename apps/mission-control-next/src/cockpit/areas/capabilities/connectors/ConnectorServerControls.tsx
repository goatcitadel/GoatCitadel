import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilityConnectorsResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { deleteMcpServer } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useInspector } from "../../../app/inspector";
import { queryKeys } from "../../../data/query-keys";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Switch } from "../../../ui/Switch";
import { connectorPanelSource } from "./connector-links";
import { CONNECTOR_CONFLICT_MESSAGE, useConnectorEnabled } from "./use-connector-enabled";

interface Failure {
  message: string;
  /** Reloading is the way forward: the server changed somewhere else, or the change was saved but not confirmed. */
  reloadable: boolean;
  /** The change did go through, so the line is a caution, not a failure. */
  saved?: boolean;
}

/**
 * The controls only a saved MCP server has: its on/off switch and Remove. Both save against the version the list
 * carried, and both say plainly when the server has changed since.
 */
export function ConnectorServerControls({
  item,
  onRemoved,
}: {
  item: CapabilityConnectorItem;
  /** Called once the server is gone, before the panel closes. */
  onRemoved?: () => void;
}) {
  const client = useQueryClient();
  const inspector = useInspector();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const switchState = useConnectorEnabled(item);
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removalFailure, setRemovalFailure] = useState<Failure | undefined>();

  const { serverId, serverRevision } = item;
  const failure: Failure | undefined =
    removalFailure ??
    (switchState.error
      ? {
          message: switchState.error,
          reloadable: switchState.conflict || switchState.unconfirmed,
          ...(switchState.unconfirmed ? { saved: true } : {}),
        }
      : undefined);

  async function remove() {
    if (removing || !serverId || !serverRevision) return;
    setRemoving(true);
    setRemovalFailure(undefined);
    try {
      await deleteMcpServer(serverId, serverRevision);
    } catch (error) {
      const described = describeApiError(error);
      const conflict = described.category === "conflict";
      setRemovalFailure({ message: conflict ? CONNECTOR_CONFLICT_MESSAGE : described.summary, reloadable: conflict });
      setRemoving(false);
      setConfirming(false);
      return;
    }
    const listKey = queryKeys.capabilityConnectors(workspaceId);
    onRemoved?.();
    // The panel is about a server that no longer exists.
    inspector.closeIfOpen(connectorPanelSource(item.id));
    client.setQueryData<CapabilityConnectorsResponse>(listKey, (list) =>
      list ? { ...list, items: list.items.filter((row) => row.id !== item.id) } : list,
    );
    void client.invalidateQueries({ queryKey: listKey });
    void client.invalidateQueries({ queryKey: ["settings", "mcp-servers"] });
    setRemoving(false);
    setConfirming(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg">Turn it on or off</span>
        <Switch
          checked={switchState.enabled}
          onCheckedChange={switchState.setEnabled}
          label={`Turn it on or off: ${item.name}`}
          pending={switchState.pending}
          disabled={Boolean(switchState.unavailableReason)}
          describedBy={switchState.unavailableReason ? reasonId : undefined}
        />
      </div>
      {switchState.unavailableReason ? (
        <div className="space-y-2">
          <p id={reasonId} className="text-sm text-fg-secondary">
            {switchState.unavailableReason}
          </p>
          {switchState.checkRetry ? (
            <Button
              size="sm"
              loading={switchState.checkRetry.running}
              loadingLabel="Retrying…"
              onClick={switchState.checkRetry.run}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="space-y-2">
          <p role="alert" className={failure.saved ? "text-sm text-fg-secondary" : "text-sm text-status-failed"}>
            {failure.message}
          </p>
          {failure.reloadable ? (
            <Button
              size="sm"
              onClick={() => {
                setRemovalFailure(undefined);
                switchState.reload();
              }}
            >
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button
        size="sm"
        variant="danger"
        disabled={!serverId || !serverRevision || switchState.pending}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          // The removal in flight can't be taken back by closing the window.
          if (!removing) setConfirming(open);
        }}
        title={`Remove ${item.name}?`}
        description="This removes it for every workspace on this computer, along with its saved sign-in and keys, its tool list and any approvals waiting on it. Open connections close, and it can't be undone here."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={removing} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button variant="danger" loading={removing} loadingLabel="Removing…" onClick={() => void remove()}>
            {`Remove ${item.name}`}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

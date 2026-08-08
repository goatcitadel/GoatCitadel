import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiscordPairingRecord, DiscordRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import {
  approveDiscordPairing,
  fetchDiscordPairings,
  reconnectDiscordRuntime,
  revokeDiscordPairing,
} from "@goatcitadel/mission-control-shared/api/integrations";
import { RefreshCw, RotateCcw } from "lucide-react";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import {
  getErrorMessage,
  SettingsActionList,
  SettingsButtonRow,
  SettingsField,
  SettingsNotice,
  SettingsStack,
  type Notice,
} from "../SettingsShared";

interface DiscordConnectionOperationsPanelProps {
  connections: IntegrationConnection[];
}

interface DiscordConnectionSnapshot {
  runtime?: DiscordRuntimeStatus;
  items: DiscordPairingRecord[];
}

const EMPTY_SNAPSHOT: DiscordConnectionSnapshot = { items: [] };

export function DiscordConnectionOperationsPanel({ connections }: DiscordConnectionOperationsPanelProps) {
  const discordConnections = useMemo(
    () =>
      connections.filter((connection) => connection.catalogId === "channel.discord" || connection.key === "discord"),
    [connections],
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState(() => discordConnections[0]?.connectionId ?? "");
  const [snapshot, setSnapshot] = useState<DiscordConnectionSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const requestSequence = useRef(0);

  const selectedConnection =
    discordConnections.find((connection) => connection.connectionId === selectedConnectionId) ?? discordConnections[0];

  useEffect(() => {
    if (!discordConnections.some((connection) => connection.connectionId === selectedConnectionId)) {
      setSelectedConnectionId(discordConnections[0]?.connectionId ?? "");
    }
  }, [discordConnections, selectedConnectionId]);

  const refreshSnapshot = useCallback(async (connectionId: string, announce = false): Promise<boolean> => {
    if (!connectionId) {
      return false;
    }
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const next = await fetchDiscordPairings(connectionId);
      if (requestSequence.current !== requestId) {
        return false;
      }
      setSnapshot({ runtime: next.runtime, items: next.items ?? [] });
      if (announce) {
        setNotice({ tone: "success", message: "Discord runtime and pairing state refreshed." });
      }
      return true;
    } catch (error) {
      if (requestSequence.current === requestId) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
      return false;
    } finally {
      if (requestSequence.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(EMPTY_SNAPSHOT);
    setNotice(null);
    if (selectedConnection?.connectionId) {
      void refreshSnapshot(selectedConnection.connectionId);
    }
  }, [refreshSnapshot, selectedConnection?.connectionId]);

  const handleReconnect = async () => {
    if (!selectedConnection) {
      return;
    }
    const connectionId = selectedConnection.connectionId;
    setBusyAction("reconnect");
    try {
      const runtime = await reconnectDiscordRuntime(connectionId);
      setSnapshot((current) => ({ ...current, runtime: runtime ?? current.runtime }));
      if (!(await refreshSnapshot(connectionId))) {
        return;
      }
      setNotice({
        tone: runtime?.ready ? "success" : "warning",
        message: runtime?.ready
          ? "Discord reconnected and reports ready."
          : runtime?.lastError?.trim() || "Discord reconnect requested; runtime is not ready yet.",
      });
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyAction("");
    }
  };

  const handlePairingAction = async (pairing: DiscordPairingRecord, action: "approve" | "revoke") => {
    if (!selectedConnection) {
      return;
    }
    const connectionId = selectedConnection.connectionId;
    setBusyAction(`${action}:${pairing.pairingId}`);
    try {
      if (action === "approve") {
        await approveDiscordPairing(connectionId, pairing.pairingId);
      } else {
        await revokeDiscordPairing(connectionId, pairing.pairingId);
      }
      if (!(await refreshSnapshot(connectionId))) {
        return;
      }
      setNotice({
        tone: "success",
        message: `${pairing.displayName || pairing.userId} pairing ${action === "approve" ? "approved" : "revoked"}.`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyAction("");
    }
  };

  if (discordConnections.length === 0 || !selectedConnection) {
    return null;
  }

  const pendingPairings = snapshot.items.filter((pairing) => pairing.status === "pending");
  const approvedPairings = snapshot.items.filter((pairing) => pairing.status === "approved");
  const runtime = snapshot.runtime;
  const runtimeLabel = loading && !runtime ? "Loading" : runtime ? (runtime.ready ? "Ready" : "Not ready") : "Unknown";
  const guildSummary = runtime?.guildIds.length
    ? `${runtime.guildIds.slice(0, 3).join(", ")}${runtime.guildIds.length > 3 ? ` +${runtime.guildIds.length - 3}` : ""}`
    : "No guilds reported";
  const actionInProgress = busyAction.length > 0;

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Discord runtime & pairing"
      subtitle="Operate finalized Discord connections, reconnect the bot, and approve paired DM users."
      stats={[
        { label: "Runtime", value: runtimeLabel },
        { label: "Pending", value: String(pendingPairings.length) },
      ]}
    >
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        <SettingsField label="Discord connection">
          <select
            className="mc-next-settings-input"
            value={selectedConnection.connectionId}
            onChange={(event) => setSelectedConnectionId(event.target.value)}
            disabled={actionInProgress}
          >
            {discordConnections.map((connection) => (
              <option key={connection.connectionId} value={connection.connectionId}>
                {connection.label}
              </option>
            ))}
          </select>
        </SettingsField>

        <NativeMetricGrid
          items={[
            {
              label: "Runtime",
              value: runtimeLabel,
              meta: runtime?.runtimeMode ?? "Awaiting status",
            },
            {
              label: "Bot",
              value: runtime?.connectedBotTag || runtime?.connectedBotId || "Not reported",
              meta: selectedConnection.enabled ? "Connection enabled" : "Connection disabled",
            },
            {
              label: "Guilds",
              value: String(runtime?.guildIds.length ?? 0),
              meta: guildSummary,
            },
          ]}
        />

        {runtime?.lastError ? (
          <SettingsNotice notice={{ tone: "warning", message: `Discord runtime: ${runtime.lastError}` }} />
        ) : null}

        <SettingsButtonRow>
          <NativeButton
            variant="secondary"
            onClick={() => void refreshSnapshot(selectedConnection.connectionId, true)}
            disabled={loading || actionInProgress}
          >
            <RefreshCw size={16} />
            {loading ? "Refreshing…" : "Refresh"}
          </NativeButton>
          <NativeButton
            variant="secondary"
            onClick={() => void handleReconnect()}
            disabled={loading || actionInProgress}
          >
            <RotateCcw size={16} />
            {busyAction === "reconnect" ? "Reconnecting…" : "Reconnect"}
          </NativeButton>
        </SettingsButtonRow>

        <section aria-labelledby="discord-pending-pairings-heading">
          <div className="mc-next-settings-panel-body">
            <h3 id="discord-pending-pairings-heading">Pending pairings</h3>
            <p className="mc-next-settings-field-note">Approve only Discord users you recognize.</p>
            <SettingsActionList
              ariaLabel="Pending Discord pairings"
              items={pendingPairings.map((pairing) => ({
                id: pairing.pairingId,
                label: pairing.displayName || pairing.userId,
                description: `User ${pairing.userId} · pairing code ${pairing.code}`,
                meta: "Pending approval",
                actionLabel: busyAction === `approve:${pairing.pairingId}` ? "Approving…" : "Approve",
                onClick: actionInProgress ? undefined : () => void handlePairingAction(pairing, "approve"),
              }))}
              emptyLabel="No pending Discord pairings."
              maxHeight="min(24vh, 12rem)"
            />
          </div>
        </section>

        <section aria-labelledby="discord-approved-pairings-heading">
          <div className="mc-next-settings-panel-body">
            <h3 id="discord-approved-pairings-heading">Approved pairings</h3>
            <SettingsActionList
              ariaLabel="Approved Discord pairings"
              items={approvedPairings.map((pairing) => ({
                id: pairing.pairingId,
                label: pairing.displayName || pairing.userId,
                description: `User ${pairing.userId}`,
                meta: "Approved",
                actionLabel: busyAction === `revoke:${pairing.pairingId}` ? "Revoking…" : "Revoke",
                onClick: actionInProgress ? undefined : () => void handlePairingAction(pairing, "revoke"),
              }))}
              emptyLabel="No approved Discord pairings."
              maxHeight="min(24vh, 12rem)"
            />
          </div>
        </section>
      </SettingsStack>
    </NativeCard>
  );
}

import type { IntegrationConnection } from "@goatcitadel/contracts";
import { RefreshCw, RotateCcw } from "lucide-react";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { SettingsActionList, SettingsButtonRow, SettingsField, SettingsNotice, SettingsStack } from "../SettingsShared";
import { useDiscordOperations } from "./use-discord-operations";
export function DiscordConnectionOperationsPanel({ connections }: { connections: IntegrationConnection[] }) {
  const {
    discordConnections,
    selectedConnection,
    setSelectedConnectionId,
    loading,
    busyAction,
    notice,
    mutation,
    refreshSnapshot,
    handleReconnect,
    handlePairingAction,
    pendingPairings,
    approvedPairings,
    runtime,
    runtimeLabel,
    guildSummary,
    actionInProgress,
  } = useDiscordOperations(connections);
  if (!discordConnections.length || !selectedConnection) return null;
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
        {mutation.uncertain ? <p role="alert">{mutation.uncertain}</p> : null}
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

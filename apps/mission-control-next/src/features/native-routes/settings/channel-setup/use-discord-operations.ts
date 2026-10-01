import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiscordPairingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import {
  approveDiscordPairing,
  fetchDiscordPairings,
  reconnectDiscordRuntime,
  revokeDiscordPairing,
} from "@goatcitadel/mission-control-shared/api/integrations";
import { getErrorMessage, type Notice } from "../SettingsShared";
import { beginChannelOperation, useChannelMutationState } from "../sections/channel-setup-state";

type Snapshot = Awaited<ReturnType<typeof fetchDiscordPairings>>;
export function useDiscordOperations(connections: IntegrationConnection[]) {
  const discordConnections = useMemo(
    () => connections.filter((item) => item.catalogId === "channel.discord" || item.key === "discord"),
    [connections],
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState(() => discordConnections[0]?.connectionId ?? "");
  const selectedConnection =
    discordConnections.find((item) => item.connectionId === selectedConnectionId) ?? discordConnections[0];
  const [snapshot, setSnapshot] = useState<Snapshot>({ items: [] });
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const mutation = useChannelMutationState();
  const sequence = useRef(0);
  const identity = `${selectedConnection?.connectionId}:${selectedConnection?.revision}`;
  const view = useRef({ identity });
  if (view.current.identity !== identity) view.current = { identity };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  const captured = view.current;
  const isCurrent = () => mounted.current && view.current === captured;
  function validateSnapshot(value: Snapshot, connectionId: string) {
    if (
      !Array.isArray(value.items) ||
      value.items.some((item) => item.connectionId !== connectionId) ||
      (value.runtime && value.runtime.connectionId !== connectionId)
    )
      throw new Error("Discord evidence did not match the selected connection.");
  }
  const refreshSnapshot = useCallback(async (connectionId: string, announce = false): Promise<boolean> => {
    if (!connectionId) return false;
    const request = ++sequence.current,
      capturedView = view.current;
    setLoading(true);
    try {
      const next = await fetchDiscordPairings(connectionId);
      validateSnapshot(next, connectionId);
      if (!mounted.current || view.current !== capturedView || sequence.current !== request) return false;
      setSnapshot(next);
      if (announce) setNotice({ tone: "success", message: "Discord runtime and pairing state refreshed." });
      return true;
    } catch (cause) {
      if (mounted.current && view.current === capturedView && sequence.current === request)
        setNotice({ tone: "error", message: getErrorMessage(cause) });
      return false;
    } finally {
      if (mounted.current && view.current === capturedView && sequence.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    sequence.current += 1;
    setSnapshot({ items: [] });
    setNotice(null);
    if (selectedConnection?.connectionId) void refreshSnapshot(selectedConnection.connectionId);
    else setLoading(false);
  }, [selectedConnection?.connectionId, selectedConnection?.revision, refreshSnapshot]);
  const handleReconnect = async () => {
    if (!selectedConnection) return;
    const op = beginChannelOperation();
    if (!op) return;
    const connectionId = selectedConnection.connectionId;
    setBusyAction("reconnect");
    try {
      const before = await fetchDiscordPairings(connectionId);
      validateSnapshot(before, connectionId);
      if (!isCurrent()) return;
      const runtime = await op.write(
        () => reconnectDiscordRuntime(connectionId),
        (value) => {
          if (value?.connectionId !== connectionId)
            throw new Error("Reconnect outcome is unconfirmed for this connection.");
        },
      );
      if (!isCurrent()) return;
      setSnapshot((current) => ({ ...current, runtime }));
      const refreshed = await refreshSnapshot(connectionId);
      if (isCurrent())
        setNotice({
          tone: runtime?.ready && refreshed ? "success" : "warning",
          message: !refreshed
            ? "Reconnect acknowledged. Refreshing current Discord evidence failed."
            : runtime?.ready
              ? "Discord reconnected and reports ready."
              : runtime?.lastError?.trim() || "Discord reconnect requested; runtime is not ready yet.",
        });
    } catch (cause) {
      if (isCurrent()) setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      op.finish();
      if (isCurrent()) setBusyAction("");
    }
  };
  const handlePairingAction = async (pairing: DiscordPairingRecord, action: "approve" | "revoke") => {
    if (!selectedConnection || pairing.connectionId !== selectedConnection.connectionId) return;
    const op = beginChannelOperation();
    if (!op) return;
    const connectionId = selectedConnection.connectionId;
    setBusyAction(`${action}:${pairing.pairingId}`);
    try {
      const latest = await fetchDiscordPairings(connectionId);
      validateSnapshot(latest, connectionId);
      if (!isCurrent()) return;
      const current = latest.items.find((item) => item.pairingId === pairing.pairingId);
      if (
        !current ||
        current.userId !== pairing.userId ||
        current.status !== pairing.status ||
        current.updatedAt !== pairing.updatedAt ||
        current.code !== pairing.code
      )
        throw new Error("This pairing changed since review. Refresh and inspect the current user and status.");
      const saved = await op.write(
        () =>
          action === "approve"
            ? approveDiscordPairing(connectionId, pairing.pairingId)
            : revokeDiscordPairing(connectionId, pairing.pairingId),
        (value) => {
          if (
            value.connectionId !== connectionId ||
            value.pairingId !== pairing.pairingId ||
            value.userId !== pairing.userId ||
            value.status !== (action === "approve" ? "approved" : "revoked")
          )
            throw new Error("The pairing response did not acknowledge the reviewed identity and action.");
        },
      );
      if (!isCurrent()) return;
      setSnapshot((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.pairingId !== saved.pairingId), saved],
      }));
      const refreshed = await refreshSnapshot(connectionId);
      if (isCurrent())
        setNotice({
          tone: refreshed ? "success" : "warning",
          message: refreshed
            ? `${pairing.displayName || pairing.userId} pairing ${action === "approve" ? "approved" : "revoked"}.`
            : "Pairing change acknowledged. Refreshing current Discord evidence failed.",
        });
    } catch (cause) {
      if (isCurrent()) setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      op.finish();
      if (isCurrent()) setBusyAction("");
    }
  };
  const runtime = snapshot.runtime;
  return {
    discordConnections,
    selectedConnection,
    selectedConnectionId,
    setSelectedConnectionId,
    snapshot,
    loading,
    busyAction,
    notice,
    mutation,
    refreshSnapshot,
    handleReconnect,
    handlePairingAction,
    pendingPairings: snapshot.items.filter((item) => item.status === "pending"),
    approvedPairings: snapshot.items.filter((item) => item.status === "approved"),
    runtime,
    runtimeLabel: loading && !runtime ? "Loading" : runtime ? (runtime.ready ? "Ready" : "Not ready") : "Unknown",
    guildSummary: runtime?.guildIds.length
      ? `${runtime.guildIds.slice(0, 3).join(", ")}${runtime.guildIds.length > 3 ? ` +${runtime.guildIds.length - 3}` : ""}`
      : "No guilds reported",
    actionInProgress: mutation.pending || Boolean(mutation.uncertain),
  };
}

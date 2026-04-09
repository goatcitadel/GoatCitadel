import { useCallback } from "react";
import {
  approveDiscordPairing,
  fetchDiscordPairings,
  fetchIntegrationConnectionDiagnostics,
  reconnectDiscordRuntime,
  revokeDiscordPairing,
} from "../../api/client";
import type { DiscordPairingRecord, DiscordRuntimeStatus } from "@goatcitadel/contracts";

type DiagnosticsByConnectionId = Record<string, Awaited<ReturnType<typeof fetchIntegrationConnectionDiagnostics>>>;
type DiscordPairingsByConnectionId = Record<
  string,
  {
    runtime?: DiscordRuntimeStatus;
    items: DiscordPairingRecord[];
  }
>;

type UseIntegrationsRuntimeActionsArgs = {
  connectorDiagnosticsEnabled: boolean;
  setError: (value: string | null) => void;
  setPluginBusyId: (value: string | null) => void;
  setDiagnosticsByConnectionId: (
    value: DiagnosticsByConnectionId | ((current: DiagnosticsByConnectionId) => DiagnosticsByConnectionId),
  ) => void;
  setSelectedDiagnosticConnectionId: (value: string | null) => void;
  setDiscordPairingBusyId: (value: string | null) => void;
  setDiscordPairingsByConnectionId: (
    value: DiscordPairingsByConnectionId | ((current: DiscordPairingsByConnectionId) => DiscordPairingsByConnectionId),
  ) => void;
};

export function useIntegrationsRuntimeActions({
  connectorDiagnosticsEnabled,
  setError,
  setPluginBusyId,
  setDiagnosticsByConnectionId,
  setSelectedDiagnosticConnectionId,
  setDiscordPairingBusyId,
  setDiscordPairingsByConnectionId,
}: UseIntegrationsRuntimeActionsArgs) {
  const refreshDiscordPairings = useCallback(
    async (connectionId: string) => {
      const result = await fetchDiscordPairings(connectionId);
      setDiscordPairingsByConnectionId((current) => ({
        ...current,
        [connectionId]: result,
      }));
    },
    [setDiscordPairingsByConnectionId],
  );

  const onRunDiagnostics = useCallback(
    async (connectionId: string) => {
      if (!connectorDiagnosticsEnabled) {
        setError("Connector diagnostics are disabled in this runtime.");
        return;
      }
      setPluginBusyId(`diag:${connectionId}`);
      try {
        const report = await fetchIntegrationConnectionDiagnostics(connectionId);
        setDiagnosticsByConnectionId((current) => ({
          ...current,
          [connectionId]: report,
        }));
        setSelectedDiagnosticConnectionId(connectionId);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPluginBusyId(null);
      }
    },
    [
      connectorDiagnosticsEnabled,
      setDiagnosticsByConnectionId,
      setError,
      setPluginBusyId,
      setSelectedDiagnosticConnectionId,
    ],
  );

  const onApproveDiscordPairing = useCallback(
    async (connectionId: string, pairingId: string) => {
      setDiscordPairingBusyId(`approve:${pairingId}`);
      try {
        await approveDiscordPairing(connectionId, pairingId);
        await refreshDiscordPairings(connectionId);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDiscordPairingBusyId(null);
      }
    },
    [refreshDiscordPairings, setDiscordPairingBusyId, setError],
  );

  const onRevokeDiscordPairing = useCallback(
    async (connectionId: string, pairingId: string) => {
      setDiscordPairingBusyId(`revoke:${pairingId}`);
      try {
        await revokeDiscordPairing(connectionId, pairingId);
        await refreshDiscordPairings(connectionId);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDiscordPairingBusyId(null);
      }
    },
    [refreshDiscordPairings, setDiscordPairingBusyId, setError],
  );

  const onReconnectDiscordRuntime = useCallback(
    async (connectionId: string) => {
      setDiscordPairingBusyId(`reconnect:${connectionId}`);
      try {
        const runtime = await reconnectDiscordRuntime(connectionId);
        setDiscordPairingsByConnectionId((current) => ({
          ...current,
          [connectionId]: {
            runtime,
            items: current[connectionId]?.items ?? [],
          },
        }));
        await refreshDiscordPairings(connectionId);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDiscordPairingBusyId(null);
      }
    },
    [refreshDiscordPairings, setDiscordPairingBusyId, setDiscordPairingsByConnectionId, setError],
  );

  return {
    onRunDiagnostics,
    onApproveDiscordPairing,
    onRevokeDiscordPairing,
    onReconnectDiscordRuntime,
  };
}

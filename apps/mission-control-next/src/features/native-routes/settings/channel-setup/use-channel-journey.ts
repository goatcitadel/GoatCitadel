import { useEffect, useState } from "react";
import type { ChannelRuntimeStatus, ChannelSetupJourney, ConnectorDiagnosticReport, IntegrationConnection } from "@goatcitadel/contracts";
import { fetchAgenticChannelDeliveries, fetchChannelDiagnostics, type AgenticChannelDeliveryRuntimeRecord } from "@goatcitadel/mission-control-shared/api/client";
import { fetchChannelSetupJourney } from "@goatcitadel/mission-control-shared/api/channel-setup-operations";

export function useChannelJourney(connections: IntegrationConnection[], connectorDiagnosticsEnabled: boolean | undefined) {
  const available = connections;
  const [selected, setSelected] = useState("");
  const connectionId = available.some((item) => item.connectionId === selected) ? selected : available[0]?.connectionId;
  const connectionRevision = available.find((item) => item.connectionId === connectionId)?.revision;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    runtime?: ChannelRuntimeStatus; journey?: ChannelSetupJourney; diagnostics?: ConnectorDiagnosticReport;
    deliveries: AgenticChannelDeliveryRuntimeRecord[]; errors: string[];
    diagnosticsAvailability: "enabled" | "disabled" | "unavailable";
  }>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setResult(undefined);
    if (!connectionId) { setLoading(false); return; }
    setLoading(true);
    void Promise.allSettled([
      fetchChannelSetupJourney(connectionId).then((value) => {
        if (value.connectionId !== connectionId || value.connectionRevision !== connectionRevision)
          throw new Error("Channel evidence belongs to a different connection revision. Refresh channels.");
        return value;
      }),
      fetchAgenticChannelDeliveries({ connectionId, limit: 10 }).then((value) => {
        if (!Array.isArray(value.deliveries) || value.deliveries.some((item) => item.connectionId !== connectionId))
          throw new Error("Foreign channel delivery response.");
        return value;
      }),
      connectorDiagnosticsEnabled === true ? fetchChannelDiagnostics(connectionId).then((value) => {
        if (value.connectorId !== connectionId || value.connectorType !== "integration_connection") throw new Error("Foreign channel diagnostics response.");
        return value;
      }) : Promise.resolve(undefined),
    ]).then(([journey, deliveries, diagnostics]) => {
      if (!current) return;
      setResult({
        runtime: journey.status === "fulfilled" ? journey.value.runtime : undefined,
        journey: journey.status === "fulfilled" ? journey.value : undefined,
        diagnostics: diagnostics.status === "fulfilled" ? diagnostics.value : undefined,
        diagnosticsAvailability: connectorDiagnosticsEnabled === true ? "enabled" : connectorDiagnosticsEnabled === false ? "disabled" : "unavailable",
        deliveries: deliveries.status === "fulfilled" ? deliveries.value.deliveries.slice(0, 10) : [],
        errors: [
          journey.status === "rejected" ? "Current connection evidence could not be loaded. Refresh channels and retry." : "",
          deliveries.status === "rejected" ? "Delivery evidence could not be loaded." : "",
          diagnostics.status === "rejected" ? "Diagnostics could not be loaded." : "",
        ].filter(Boolean),
      });
      setLoading(false);
    });
    return () => { current = false; };
  }, [connectionId, connectionRevision, revision, connectorDiagnosticsEnabled]);
  return { available, connectionId, setSelected, setRevision, result, loading };
}

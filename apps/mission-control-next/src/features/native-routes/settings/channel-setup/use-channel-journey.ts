import { useEffect, useState } from "react";
import type { ChannelRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import {
  fetchAgenticChannelDeliveries,
  fetchChannelRuntimeStatus,
  type AgenticChannelDeliveryRuntimeRecord,
} from "@goatcitadel/mission-control-shared/api/client";
const PRIMARY_CHANNELS = ["telegram", "discord", "slack", "signal"];
export function useChannelJourney(connections: IntegrationConnection[]) {
  const available = connections.filter((item) => PRIMARY_CHANNELS.includes(item.key));
  const [selected, setSelected] = useState("");
  const connectionId = available.some((item) => item.connectionId === selected) ? selected : available[0]?.connectionId;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    runtime?: ChannelRuntimeStatus;
    deliveries: AgenticChannelDeliveryRuntimeRecord[];
    errors: string[];
  }>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setResult(undefined);
    if (!connectionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.allSettled([
      fetchChannelRuntimeStatus(connectionId).then((value) => {
        if (value.connectionId !== connectionId) throw new Error("Foreign channel runtime response.");
        return value;
      }),
      fetchAgenticChannelDeliveries({ connectionId, limit: 10 }).then((value) => {
        if (!Array.isArray(value.deliveries) || value.deliveries.some((item) => item.connectionId !== connectionId))
          throw new Error("Foreign channel delivery response.");
        return value;
      }),
    ]).then(([runtime, deliveries]) => {
      if (!current) return;
      setResult({
        runtime: runtime.status === "fulfilled" ? runtime.value : undefined,
        deliveries: deliveries.status === "fulfilled" ? deliveries.value.deliveries : [],
        errors: [
          runtime.status === "rejected" ? "Runtime evidence could not be loaded." : "",
          deliveries.status === "rejected" ? "Delivery evidence could not be loaded." : "",
        ].filter(Boolean),
      });
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [connectionId, revision]);
  return { available, connectionId, setSelected, setRevision, result, loading };
}

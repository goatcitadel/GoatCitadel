import { useEffect, useState } from "react";
import type { ChannelRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import {
  fetchAgenticChannelDeliveries,
  fetchChannelRuntimeStatus,
  type AgenticChannelDeliveryRuntimeRecord,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";

const PRIMARY_CHANNELS = ["telegram", "discord", "slack", "signal"];
const timestamp = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";

export function ChannelJourneyPanel({ connections }: { connections: IntegrationConnection[] }) {
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
      fetchChannelRuntimeStatus(connectionId),
      fetchAgenticChannelDeliveries({ connectionId, limit: 10 }),
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
  if (!available.length) return null;
  const runtime = result?.runtime;
  return (
    <NativeCard
      title="Channel journey"
      subtitle="Inspect observed ingress and delivery before relying on a connection."
    >
      <label>
        Connection{" "}
        <select value={connectionId} onChange={(event) => setSelected(event.target.value)}>
          {available.map((item) => (
            <option key={item.connectionId} value={item.connectionId}>
              {item.label} ({item.key})
            </option>
          ))}
        </select>
      </label>
      <NativeButton onClick={() => setRevision((value) => value + 1)} disabled={loading}>
        Refresh evidence
      </NativeButton>
      <div aria-live="polite" aria-busy={loading}>
        {loading ? <p>Loading channel evidence…</p> : null}
        {result?.errors.map((error) => (
          <p role="alert" key={error}>
            {error}
          </p>
        ))}
        {runtime ? (
          <>
            <p>
              {runtime.channelKey === "signal"
                ? "Signal supports outbound delivery only."
                : "Send a message from an allowed account to verify ingress. Approval requests remain governed by the Gateway."}
            </p>
            <dl>
              <dt>Runtime / connection probe</dt>
              <dd>
                {runtime.ready ? "Ready at last observation" : "Needs attention"} · {timestamp(runtime.lastReadyAt)}
              </dd>
              {runtime.channelKey !== "signal" ? (
                <>
                  <dt>Latest accepted inbound message</dt>
                  <dd>{timestamp(runtime.lastInboundAt)}</dd>
                </>
              ) : null}
              <dt>Latest reconnect</dt>
              <dd>{timestamp(runtime.lastReconnectAt)}</dd>
            </dl>
            {runtime.lastError ? <p role="alert">{runtime.lastError}</p> : null}
          </>
        ) : null}
        {result ? (
          <>
            <p>
              Recent deliveries include replies and scheduled work. A sent receipt records provider acceptance; it does
              not confirm that a person read the message.
            </p>
            {result.deliveries.length ? (
              <ul>
                {result.deliveries.map((delivery) => (
                  <li key={delivery.deliveryId}>
                    <strong>{delivery.status.replaceAll("_", " ")}</strong> · {timestamp(delivery.updatedAt)} · attempt{" "}
                    {delivery.attempts}/{delivery.maxAttempts}
                    {delivery.providerMessageId ? " · provider receipt recorded" : ""}
                    {delivery.error || delivery.staleReason ? <p>{delivery.error ?? delivery.staleReason}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No delivery evidence is available.</p>
            )}
          </>
        ) : null}
      </div>
    </NativeCard>
  );
}

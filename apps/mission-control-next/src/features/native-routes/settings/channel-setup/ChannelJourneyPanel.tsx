import type { IntegrationConnection } from "@goatcitadel/contracts";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import { useChannelJourney } from "./use-channel-journey";
import { ChannelJourneyEvidence } from "./ChannelJourneyEvidence";
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";
export function ChannelJourneyPanel({ connections, connectorDiagnosticsEnabled }: { connections: IntegrationConnection[]; connectorDiagnosticsEnabled?: boolean }) {
  const { available, connectionId, setSelected, setRevision, result, loading } = useChannelJourney(connections, connectorDiagnosticsEnabled);
  if (!available.length) return null;
  return <NativeCard title="Channel journey" subtitle="Gateway evidence for this saved connection and revision.">
    <label>Connection <select value={connectionId} onChange={(event) => setSelected(event.target.value)}>
      {available.map((item) => <option key={item.connectionId} value={item.connectionId}>{item.label} ({item.key})</option>)}
    </select></label>
    <NativeButton onClick={() => setRevision((value) => value + 1)} disabled={loading}>Refresh evidence</NativeButton>
    <div aria-live="polite" aria-busy={loading}>
      {loading ? <p>Loading channel evidence…</p> : null}
      {result?.errors.map((error) => <p role="alert" key={error}>{error}</p>)}
      <ChannelJourneyEvidence journey={result?.journey} diagnostics={result?.diagnostics} diagnosticsAvailability={result?.diagnosticsAvailability} />
      <p>A provider receipt records acceptance. It does not confirm that a person read the message.</p>
      {result?.deliveries.length ? <ul>{result.deliveries.map((delivery) => <li key={delivery.deliveryId}>
        <strong>{delivery.status.replaceAll("_", " ")}</strong> · {timestamp(delivery.updatedAt)} · attempt {delivery.attempts}/{delivery.maxAttempts}
        {delivery.providerMessageId ? " · provider receipt recorded" : ""}
        {delivery.error || delivery.staleReason ? <p>{delivery.error ?? delivery.staleReason}</p> : null}
      </li>)}</ul> : result ? <p>No delivery evidence available.</p> : null}
    </div>
  </NativeCard>;
}

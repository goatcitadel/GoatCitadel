import { useEffect, useRef, useState } from "react";
import type { IntegrationConnection, TelegramChannelPairingList } from "@goatcitadel/contracts";
import { fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { fetchTelegramChannelPairings, approveTelegramChannelPairing, revokeTelegramChannelPairing } from "@goatcitadel/mission-control-shared/api/channel-setup-operations";
import { beginChannelOperation, useChannelMutationState } from "../sections/channel-setup-state";
import { Button } from "../../../../cockpit/ui/Button";
import { Dialog } from "../../../../cockpit/ui/Dialog";
type Pairing = TelegramChannelPairingList["items"][number];
const identity = (item: Pairing) => JSON.stringify([item.actorId, item.status, item.code, item.chatId, item.expiresAt, item.approvedAt]);
export function TelegramPairingPanel({ connection, onUpdated }: {
  connection: IntegrationConnection; onUpdated?: () => Promise<unknown>;
}) {
  const [snapshot, setSnapshot] = useState<TelegramChannelPairingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [review, setReview] = useState<{ pairing: Pairing; connectionRevision: string } | null>(null);
  const mutation = useChannelMutationState();
  const activeScope = useRef({ mounted: true, id: connection.connectionId, revision: connection.revision });
  if (activeScope.current.id !== connection.connectionId || activeScope.current.revision !== connection.revision)
    activeScope.current = { ...activeScope.current, id: connection.connectionId, revision: connection.revision };
  useEffect(() => { activeScope.current.mounted = true; return () => { activeScope.current.mounted = false; }; }, []);
  useEffect(() => {
    if (connection.key !== "telegram") return;
    let active = true; setSnapshot(null); setError(null); setBusy(true); setReview(null);
    void fetchTelegramChannelPairings(connection.connectionId).then((result) => {
      if (!active) return;
      if (result.connectionId !== connection.connectionId) throw new Error("Foreign Telegram pairing response.");
      setSnapshot(result);
      if (result.connectionRevision !== connection.revision) setError("The connection changed. Refresh channels before changing access.");
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Pairing evidence unavailable."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [connection.connectionId, connection.revision, connection.key, revision]);
  if (connection.key !== "telegram") return null;
  const current = review && snapshot?.items.find((item) => item.actorId === review.pairing.actorId && identity(item) === identity(review.pairing));
  const reviewCurrent = Boolean(current && snapshot?.connectionRevision === review?.connectionRevision && connection.revision === review?.connectionRevision);
  const disabled = busy || mutation.pending || Boolean(mutation.uncertain) || snapshot?.connectionRevision !== connection.revision;
  const apply = async () => {
    const selected = review;
    const scope = activeScope.current;
    const isCurrent = () => activeScope.current.mounted && activeScope.current === scope;
    if (!selected || !reviewCurrent || disabled) return;
    setReview(null);
    const op = beginChannelOperation(); if (!op) return;
    setBusy(true); setError(null);
    try {
      const [freshConnection, freshPairings] = await Promise.all([
        fetchIntegrationConnection(connection.connectionId), fetchTelegramChannelPairings(connection.connectionId),
      ]);
      if (!isCurrent()) return;
      if (freshConnection.connectionId !== connection.connectionId || freshConnection.revision !== selected.connectionRevision ||
        freshPairings.connectionId !== connection.connectionId || freshPairings.connectionRevision !== selected.connectionRevision ||
        !freshPairings.items.some((item) => identity(item) === identity(selected.pairing)))
        throw new Error("Pairing or connection evidence changed. Refresh and review the current identity.");
      const result = await op.write(() => selected.pairing.status === "pending" ?
        approveTelegramChannelPairing(connection.connectionId, { code: selected.pairing.code!, expectedConnectionRevision: selected.connectionRevision }) :
        revokeTelegramChannelPairing(connection.connectionId, selected.pairing.actorId, { expectedConnectionRevision: selected.connectionRevision }),
        (value) => {
          if (value.connectionId !== connection.connectionId ||
            (selected.pairing.status === "pending" ? !value.items.some((item) => item.actorId === selected.pairing.actorId && item.status === "approved") :
              value.items.some((item) => item.actorId === selected.pairing.actorId && item.status === "approved")))
            throw new Error("The pairing receipt did not confirm the reviewed access change.");
        });
      if (isCurrent()) { setSnapshot(result); await onUpdated?.(); }
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : "Pairing update could not be confirmed."); }
    finally { op.finish(); if (isCurrent()) setBusy(false); }
  };
  return <section aria-label="Telegram sender access" className="min-w-0 space-y-3 rounded-md border border-line p-3 text-sm">
    <h4 className="font-semibold">Telegram sender access</h4>
    <p>Approve only people you recognize. Destination IDs and sender authorization are separate.</p>
    <Button disabled={busy} onClick={() => setRevision((value) => value + 1)}>Refresh Telegram access</Button>
    {busy ? <p role="status">Loading current sender access…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {mutation.uncertain ? <p role="alert">{mutation.uncertain}</p> : null}
    {snapshot?.legacyOpenWarning ? <p role="alert">{snapshot.legacyOpenWarning}</p> : null}
    {snapshot?.inboundAccessMode === "open_legacy" ? <p role="alert">Legacy open access still permits other senders. Revoking a pairing removes its explicit approval but does not block that person under the open policy. Edit this connection and choose Only allowed senders to restrict inbound access.</p> : null}
    {snapshot ? <p>{snapshot.allowedSenders.length} explicit allowed sender{snapshot.allowedSenders.length === 1 ? "" : "s"} · {snapshot.inboundAccessMode.replaceAll("_", " ")}</p> : null}
    {snapshot?.items.length ? <ul className="max-h-80 space-y-2 overflow-auto">
      {snapshot.items.slice(0, 50).map((pairing) => <li key={pairing.actorId} className="rounded-md border border-line p-3">
        <p>{pairing.displayName || pairing.actorId} · {pairing.status}</p>
        <p className="break-all text-xs">Sender {pairing.actorId}{pairing.chatId ? " · chat " + pairing.chatId : ""}</p>
        {pairing.code ? <p className="break-all text-xs">Pairing code {pairing.code}</p> : null}
        {pairing.expiresAt ? <p className="text-xs">Expires {new Date(pairing.expiresAt).toLocaleString()}</p> : null}
        <Button disabled={disabled || pairing.status === "pending" && !pairing.code}
          onClick={() => setReview({ pairing, connectionRevision: snapshot.connectionRevision })}>
          {pairing.status === "pending" ? "Review Telegram approval" : "Review Telegram revocation"}
        </Button>
      </li>)}
    </ul> : snapshot ? <p>No pending or approved pairings reported.</p> : null}
    <Dialog open={review !== null} title="Review Telegram access change"
      description={snapshot?.inboundAccessMode === "open_legacy" ? "This changes the explicit pairing entry. Legacy open access still permits this person until you change the connection access policy to allowlist." : "This changes only the reviewed sender on this exact connection revision."}
      onOpenChange={(open) => { if (!open) setReview(null); }}>
      {review ? <>
        <p>{review.pairing.status === "pending" ? "Approve" : "Revoke"} {review.pairing.displayName || review.pairing.actorId}</p>
        <p className="break-all">Connection {connection.label} · sender {review.pairing.actorId} · revision {review.connectionRevision}</p>
        {!reviewCurrent ? <p role="alert">Evidence changed. Close and review the current sender.</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="h-auto min-h-10 max-w-full whitespace-normal py-2" disabled={!reviewCurrent || disabled} variant={review.pairing.status === "pending" ? "primary" : "danger"} onClick={() => void apply()}>Apply reviewed Telegram access change</Button>
          <Button onClick={() => setReview(null)}>Cancel access change</Button>
        </div>
      </> : null}
    </Dialog>
  </section>;
}

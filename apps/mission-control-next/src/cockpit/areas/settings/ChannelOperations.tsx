import { useState } from "react";
import type { DiscordPairingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { useChannelJourney } from "../../../features/native-routes/settings/channel-setup/use-channel-journey";
import { useDiscordOperations } from "../../../features/native-routes/settings/channel-setup/use-discord-operations";
import { ChannelJourneyEvidence } from "../../../features/native-routes/settings/channel-setup/ChannelJourneyEvidence";
import { TelegramPairingPanel } from "../../../features/native-routes/settings/channel-setup/TelegramPairingPanel";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

const timestamp = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";
export function ChannelOperations({ connection, onUpdated, connectorDiagnosticsEnabled }: { connection: IntegrationConnection; onUpdated?: () => Promise<unknown>; connectorDiagnosticsEnabled?: boolean }) {
  const journey = useChannelJourney([connection], connectorDiagnosticsEnabled);
  const discord = useDiscordOperations([connection]);
  const [review, setReview] = useState<{
    action: "approve" | "revoke";
    pairing: DiscordPairingRecord;
    revision: string;
  } | null>(null);
  const currentPairing = review && discord.snapshot.items.find((item) => item.pairingId === review.pairing.pairingId);
  const currentReview =
    review?.pairing.connectionId === connection.connectionId &&
    review.revision === connection.revision &&
    currentPairing?.status === review.pairing.status &&
    currentPairing?.updatedAt === review.pairing.updatedAt;
  return (
    <div className="space-y-4">
      {journey.available.length ? (
        <section aria-label="Channel journey" className="space-y-2 text-sm">
          <h4 className="font-semibold">Channel journey</h4>
          <Button disabled={journey.loading} onClick={() => journey.setRevision((value) => value + 1)}>
            Refresh channel evidence
          </Button>
          {journey.loading ? <p role="status">Loading channel evidence…</p> : null}
          {journey.result?.errors.map((error) => (
            <p key={error} role="alert">
              {error}
            </p>
          ))}
          <ChannelJourneyEvidence journey={journey.result?.journey} diagnostics={journey.result?.diagnostics} diagnosticsAvailability={journey.result?.diagnosticsAvailability} />
          <p className="text-fg-muted">
            A sent receipt records provider acceptance; it does not confirm that a person read the message.
          </p>
          <ul className="space-y-2">
            {journey.result?.deliveries.slice(0, 10).map((item) => (
              <li key={item.deliveryId}>
                {item.status.replaceAll("_", " ")} · {timestamp(item.updatedAt)} · attempt {item.attempts}/
                {item.maxAttempts}
                {item.providerMessageId ? " · provider receipt recorded" : ""}
                {item.error || item.staleReason ? <p>{item.error ?? item.staleReason}</p> : null}
              </li>
            ))}
          </ul>
          {journey.result && !journey.result.deliveries.length ? (
            <p className="text-fg-muted">No delivery evidence is available.</p>
          ) : null}
        </section>
      ) : null}
      <TelegramPairingPanel connection={connection} onUpdated={onUpdated} />
      {discord.selectedConnection ? (
        <section aria-label="Discord runtime and pairing" className="space-y-3 text-sm">
          <h4 className="font-semibold">Discord runtime and pairing</h4>
          <p>
            {discord.runtimeLabel} ·{" "}
            {discord.runtime?.connectedBotTag || discord.runtime?.connectedBotId || "Bot identity not reported"}
          </p>
          {discord.notice ? <p role="status">{discord.notice.message}</p> : null}
          {discord.mutation.uncertain ? <p role="alert">{discord.mutation.uncertain}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={discord.loading}
              onClick={() => void discord.refreshSnapshot(connection.connectionId, true)}
            >
              Refresh Discord state
            </Button>
            <Button
              disabled={discord.loading || discord.actionInProgress}
              onClick={() => void discord.handleReconnect()}
            >
              Reconnect Discord
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            Pairing actions reread the current user and status. This owner does not offer an atomic revision
            precondition; its returned record confirms the result.
          </p>
          {discord.pendingPairings.length + discord.approvedPairings.length > 0 ? (
            <ul className="max-h-80 space-y-2 overflow-auto">
              {[...discord.pendingPairings, ...discord.approvedPairings].map((pairing) => (
                <li key={pairing.pairingId} className="rounded-md border border-line p-3">
                  <p>
                    {pairing.displayName || pairing.userId} · {pairing.status}
                  </p>
                  <p className="break-all text-xs text-fg-muted">
                    User {pairing.userId} · pairing {pairing.code}
                  </p>
                  <Button
                    disabled={discord.actionInProgress || discord.loading}
                    onClick={() =>
                      setReview({
                        action: pairing.status === "pending" ? "approve" : "revoke",
                        pairing,
                        revision: connection.revision,
                      })
                    }
                  >
                    {pairing.status === "pending" ? "Review pairing approval" : "Review pairing revocation"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {discord.loading || discord.notice?.tone === "error"
                ? "Pairing state unavailable."
                : "No pending or approved pairings reported."}
            </p>
          )}
        </section>
      ) : null}
      <Dialog
        open={review !== null}
        title="Review Discord pairing"
        description="Approve only users you recognize. Revoking removes this pairing's access through the Gateway owner."
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
      >
        {review ? (
          <div className="space-y-3 text-sm">
            <p>
              {review.action === "approve" ? "Approve" : "Revoke"} {review.pairing.displayName || review.pairing.userId}
            </p>
            <p className="break-all">
              Connection {connection.label} · user {review.pairing.userId} · code {review.pairing.code}
            </p>
            {!currentReview ? (
              <p role="alert">Pairing evidence changed. Close and review its current identity.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant={review.action === "revoke" ? "danger" : "primary"}
                disabled={!currentReview || discord.actionInProgress}
                onClick={() => {
                  const selected = review;
                  setReview(null);
                  void discord.handlePairingAction(selected.pairing, selected.action);
                }}
              >
                Apply reviewed pairing action
              </Button>
              <Button onClick={() => setReview(null)}>Cancel pairing change</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

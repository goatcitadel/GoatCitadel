import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ChannelOutcomeCheck } from "../../../features/native-routes/settings/sections/ChannelOutcomeCheck";
import { Button } from "../../ui/Button";
import { Section } from "../../ui/Section";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChannelActionNote } from "./ChannelActionNote";
import { PendingRequests } from "./ChannelPendingRequests";
import { ownerCandidates, type ApprovedSender, type OwnerCandidate, type PendingRequest } from "./channel-page-model";
import { usePairingDecision } from "./use-pairing-decision";
import { useOwnerMark } from "./use-owner-mark";

function SenderRow({
  candidate,
  saving,
  busy,
  onMark,
}: {
  candidate: OwnerCandidate;
  saving: boolean;
  busy: boolean;
  onMark: (actorId: string, isOwner: boolean) => void;
}) {
  const action = candidate.isOwner ? "Not you" : "This is you";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0 break-words text-base text-fg">
        {candidate.label}
        {candidate.isOwner ? (
          <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-fg-secondary">
            You
          </span>
        ) : null}
      </span>
      <Button
        size="sm"
        aria-label={`${action}: ${candidate.label}`}
        disabled={busy && !saving}
        loading={saving}
        onClick={() => onMark(candidate.actorId, !candidate.isOwner)}
      >
        {action}
      </Button>
    </li>
  );
}

/**
 * Who can message the channel: the people waiting for an answer (Approve or Deny), then the people already approved,
 * each marked as you or not. Senders are named; their ids and codes stay in Technical details. Everything here writes
 * through the same owners as Settings, and the page reads its people again after each answer.
 */
export function PeopleSection({
  connection,
  approved,
  pending,
  openAccess,
  loading,
  failed,
  reload,
}: {
  connection: IntegrationConnection;
  approved: readonly ApprovedSender[];
  pending: readonly PendingRequest[];
  openAccess: boolean;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<unknown>;
}) {
  const owner = useOwnerMark(connection, reload);
  const decision = usePairingDecision(connection, reload);
  const candidates = ownerCandidates(connection, approved);
  const empty = !candidates.length && !pending.length;
  return (
    <Section title="Who can message it" description="Approve the people you know. Then mark which one is you.">
      <div className="space-y-4">
        {openAccess ? (
          <p className="text-sm text-fg-secondary">
            Anyone can message this channel right now. Approving someone doesn't change that.
          </p>
        ) : null}
        <PendingRequests
          requests={pending}
          busy={decision.busy}
          locked={decision.locked || owner.busy}
          onDecide={(request, answer) => void decision.decide(request, answer)}
        />
        {candidates.length ? (
          <div className="space-y-2">
            <p className="text-sm text-fg-secondary">
              In your own conversation you can ask GoatCitadel, and the answer also goes to {connection.label}.
            </p>
            <ul aria-label="People who can message it" className="divide-y divide-line-subtle">
              {candidates.map((candidate) => (
                <SenderRow
                  key={candidate.actorId}
                  candidate={candidate}
                  saving={owner.saving === candidate.actorId}
                  busy={owner.busy || decision.locked}
                  onMark={(actorId, isOwner) => void owner.mark(actorId, isOwner)}
                />
              ))}
            </ul>
            <TechnicalDetails label="Sender IDs">
              <ul>
                {candidates.map((candidate) => (
                  <li key={candidate.actorId}>
                    {candidate.label} · {candidate.actorId}
                  </li>
                ))}
              </ul>
            </TechnicalDetails>
          </div>
        ) : null}
        {empty ? (
          <p className="text-sm text-fg-muted">
            {failed
              ? "Couldn't load who can message it."
              : loading
                ? "Loading who can message it…"
                : "No one is approved yet. When someone messages the bot, their request shows up here."}
          </p>
        ) : null}
        {decision.note ? <ChannelActionNote message={decision.note} fresh /> : null}
        {decision.uncertain ? (
          <ChannelActionNote message={decision.uncertain} fresh={false}>
            <ChannelOutcomeCheck reload={reload} buttonComponent={Button} />
          </ChannelActionNote>
        ) : null}
        {owner.note ? <ChannelActionNote message={owner.note} fresh /> : null}
      </div>
    </Section>
  );
}

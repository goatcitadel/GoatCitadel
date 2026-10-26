import { useEffect, useRef, type ReactNode } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Section } from "../../ui/Section";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChannelOperations } from "../settings/ChannelOperations";
import { ownerCandidates, type ApprovedSender, type OwnerCandidate } from "./channel-page-model";
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

/** Outcome text is not a live region (the page's live-region budget is exact), so a fresh failure takes focus to be heard. */
function SaveNote({ message, fresh, children }: { message: string; fresh: boolean; children?: ReactNode }) {
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fresh) note.current?.focus();
  }, [message, fresh]);
  return (
    <div ref={note} tabIndex={-1} className="space-y-2 outline-none">
      <Callout announce={false} tone="warning">
        {message}
      </Callout>
      {children}
    </div>
  );
}

/**
 * Who can message the channel: the people already approved, each marked as you or not, and the pending requests with
 * their Approve and Deny, which the existing review owns. Senders are named; their ids stay in Technical details.
 */
export function PeopleSection({
  connection,
  approved,
  loading,
  failed,
  reload,
}: {
  connection: IntegrationConnection;
  approved: readonly ApprovedSender[];
  loading: boolean;
  failed: boolean;
  reload: () => Promise<unknown>;
}) {
  const owner = useOwnerMark(connection, reload);
  const candidates = ownerCandidates(connection, approved);
  return (
    <Section title="Who can message it" description="Approve the people you know. Then mark which one is you.">
      <div className="space-y-4">
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
                  busy={owner.busy}
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
        ) : (
          <p className="text-sm text-fg-muted">
            {failed
              ? "Couldn't load who can message it."
              : loading
                ? "Loading who can message it…"
                : "No one is approved yet. When someone messages the bot, their request shows up here."}
          </p>
        )}
        {owner.note ? (
          <SaveNote message={owner.note} fresh={owner.fresh}>
            {owner.uncertain ? (
              <Button size="sm" onClick={() => void owner.checkSaved()}>
                Check what was saved
              </Button>
            ) : null}
          </SaveNote>
        ) : null}
        <ChannelOperations connection={connection} onUpdated={reload} />
      </div>
    </Section>
  );
}

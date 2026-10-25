import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { plural, presentTime } from "@goatcitadel/mission-control-shared/content/format";
import { EmptyState } from "../../ui/EmptyState";
import { inboxKnownCount, inboxReadGaps } from "./inbox-presentation";

function summaryLine(projection: OperatorInboxResponse): string {
  const total = inboxKnownCount(projection);
  const decisions = projection.counts.needs_decision.known;
  const updates = projection.counts.updates.known;
  const other = Math.max(0, total.known - decisions - updates);
  const parts = [
    decisions ? `${plural(decisions, "decision")} waiting` : "",
    updates ? plural(updates, "update") : "",
    other ? `${other} other` : "",
  ].filter(Boolean);
  const counts = parts.length ? `${parts.join(", ")}.` : "Nothing waiting.";
  // The count is honest only when every source was read; a declared scope limit is explained under "What this Inbox covers".
  return inboxReadGaps(projection).length > 0
    ? `${counts} Some sources couldn't be checked, so there may be more.`
    : counts;
}

/** Which sources were not fully read, and which have a declared scope. Plain disclosures, no box. */
function InboxCoverageDetails({ projection }: { projection: OperatorInboxResponse }) {
  const gaps = inboxReadGaps(projection);
  const scopeNotes = projection.coverage.filter(
    (source) => source.state === "limited" || source.state === "not_enabled",
  );
  return (
    <>
      {gaps.length > 0 ? (
        <details className="mt-2 text-xs text-fg-muted">
          <summary className="cursor-pointer font-medium text-fg-secondary">
            Couldn&apos;t fully check {plural(gaps.length, "source")}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {gaps.map((source) => (
              <li key={source.source}>{source.detail ?? "This source couldn't be checked completely."}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {scopeNotes.length > 0 ? (
        <details className="mt-2 text-xs text-fg-muted">
          <summary className="cursor-pointer font-medium text-fg-secondary">What this Inbox covers</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {scopeNotes.map((source) => (
              <li key={source.source}>{source.detail ?? "This source has a defined scope."}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** One line of coverage above the groups, then the coverage disclosures. Not a card: the page is the card. */
export function InboxCoverageSummary({ projection }: { projection: OperatorInboxResponse }) {
  return (
    <div className="text-sm text-fg-secondary">
      {summaryLine(projection)}
      <InboxCoverageDetails projection={projection} />
    </div>
  );
}

/**
 * The one empty state when no group has anything (IN-10). It says "all caught up" only when every expected source
 * was read; otherwise it says that some sources could not be checked.
 */
export function InboxEmptyState({ projection }: { projection: OperatorInboxResponse }) {
  const checked = presentTime(projection.generatedAt)?.text;
  const lastChecked = checked ? ` Last checked ${checked}.` : "";
  const hasGap = inboxReadGaps(projection).length > 0;
  return (
    // Focus lands here after the last item is decided (IN-07).
    <div data-inbox-empty tabIndex={-1}>
      <EmptyState
        title={hasGap ? "Some sources couldn't be checked" : "You're all caught up"}
        description={
          hasGap
            ? `Nothing found, but some sources couldn't be checked completely, so items may be missing.${lastChecked}`
            : `Nothing needs your attention in the checked sources. Decisions, proposals and updates appear here when work needs you.${lastChecked}`
        }
      />
      <div className="mx-auto w-fit max-w-md">
        <InboxCoverageDetails projection={projection} />
      </div>
    </div>
  );
}

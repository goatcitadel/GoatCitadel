import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { plural, presentTime } from "@goatcitadel/mission-control-shared/content/format";
import { EmptyState } from "../../ui/EmptyState";
import { inboxCountIsExact, inboxKnownCount, inboxReadGaps } from "./inbox-presentation";

function summaryLine(projection: OperatorInboxResponse): string {
  const total = inboxKnownCount(projection);
  return inboxCountIsExact(projection, total.complete)
    ? `${plural(total.known, "item")} in this workspace.`
    : `${plural(total.known, "known item")}; more may be outside this view.`;
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
    <div>
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

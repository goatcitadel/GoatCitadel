import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { inboxCountIsExact, inboxKnownCount, inboxReadGaps } from "./inbox-presentation";

function summaryLine(projection: OperatorInboxResponse): string {
  const total = inboxKnownCount(projection);
  const hasGap = inboxReadGaps(projection).length > 0;
  if (total.known === 0) {
    return hasGap
      ? "No known items, but some sources could not be read completely."
      : "Nothing needs your attention in the checked sources.";
  }
  const noun = total.known === 1 ? "item" : "items";
  return inboxCountIsExact(projection, total.complete)
    ? `${total.known} ${noun} in this workspace.`
    : `${total.known} known ${noun}; more may be outside this view.`;
}

export function InboxCoverageSummary({ projection }: { projection: OperatorInboxResponse }) {
  const gaps = inboxReadGaps(projection);
  const scopeNotes = projection.coverage.filter(
    (source) => source.state === "limited" || source.state === "not_enabled",
  );
  return (
    <div role="status" className="rounded-lg border border-line bg-raised p-3 text-sm text-fg-secondary">
      {summaryLine(projection)}
      {gaps.length > 0 ? (
        <details className="mt-2 text-xs text-fg-muted">
          <summary className="cursor-pointer font-medium text-fg-secondary">
            Coverage is incomplete for {gaps.length} {gaps.length === 1 ? "source" : "sources"}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {gaps.map((source) => (
              <li key={source.source}>{source.detail ?? "This source could not be read completely."}</li>
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
    </div>
  );
}

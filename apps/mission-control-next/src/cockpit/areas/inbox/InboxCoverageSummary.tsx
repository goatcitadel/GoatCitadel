import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { inboxKnownCount } from "./inbox-presentation";

export function InboxCoverageSummary({ projection }: { projection: OperatorInboxResponse }) {
  const total = inboxKnownCount(projection);
  const gaps = projection.coverage.filter((source) => source.state === "partial" || source.state === "unavailable");
  const scopeNotes = projection.coverage.filter(
    (source) => source.state === "limited" || source.state === "not_enabled",
  );
  return (
    <div role="status" className="rounded-lg border border-line bg-raised p-3 text-sm text-fg-secondary">
      {total.known === 0
        ? "No known items in the checked sources."
        : total.complete
          ? `${total.known} ${total.known === 1 ? "item" : "items"} in this workspace.`
          : `${total.known} known ${total.known === 1 ? "item" : "items"}; more may be outside this view.`}
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

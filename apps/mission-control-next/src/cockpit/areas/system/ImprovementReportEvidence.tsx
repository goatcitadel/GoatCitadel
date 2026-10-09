import type { WeeklyImprovementReportRecord } from "@goatcitadel/contracts";

/** The report's own findings, proposals and audit evidence, shown plainly rather than only as retained JSON. */
export function ReportEvidence({ data }: { data: WeeklyImprovementReportRecord }) {
  const proposals = data.proposalDrafts ?? [];
  const specialists = data.specialistCandidateSuggestions ?? [];
  const tags = data.strategyTags ?? [];
  return (
    <>
      <h3 className="font-medium">Top findings</h3>
      {data.topFindings.length ? (
        <ul className="grid min-w-0 gap-1 text-sm">
          {data.topFindings.map((finding) => (
            <li key={finding.findingId} className="wrap-anywhere">
              <strong>{finding.title}</strong> · {finding.severity} · seen {finding.recurrenceCount}×
              <span className="block text-fg-secondary">{finding.summary}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No findings recorded.</p>
      )}
      {proposals.length ? (
        <>
          <h3 className="font-medium">Proposal drafts</h3>
          <ul className="grid min-w-0 gap-1 text-sm">
            {proposals.map((draft) => (
              <li key={draft.draftId} className="wrap-anywhere">
                <strong>{draft.title}</strong> · {draft.kind.replaceAll("_", " ")}
                <span className="block text-fg-secondary">{draft.summary}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {specialists.length ? (
        <>
          <h3 className="font-medium">Specialist suggestions</h3>
          <ul className="grid min-w-0 gap-1 text-sm">
            {specialists.map((suggestion) => (
              <li key={suggestion.candidateId} className="wrap-anywhere">
                <strong>{suggestion.title}</strong> · {suggestion.role} · {suggestion.summary}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {tags.length ? (
        <p className="text-sm wrap-anywhere">
          Strategy tags: {tags.map((tag) => `${tag.tag.replaceAll("_", " ")} (${tag.count})`).join(", ")}
        </p>
      ) : null}
      {data.routingGapSummary ? (
        <p className="text-sm wrap-anywhere">
          {data.routingGapSummary.totalEvents} routing-gap events
          {data.routingGapSummary.topRequestedTools.length
            ? ` · most requested: ${data.routingGapSummary.topRequestedTools.join(", ")}`
            : ""}
        </p>
      ) : null}
      {data.harnessAudit ? (
        <p className="text-sm wrap-anywhere">
          Harness audit score {data.harnessAudit.overallScore}
          {data.harnessAudit.weakestPillars.length
            ? ` · weakest: ${data.harnessAudit.weakestPillars.map((pillar) => `${pillar.label} ${pillar.score}`).join(", ")}`
            : ""}
        </p>
      ) : null}
    </>
  );
}

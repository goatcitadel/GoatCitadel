import { useState } from "react";
import { fetchImprovementReport } from "@goatcitadel/mission-control-shared/api/improvement";
import { useAsyncLoad } from "../shared/native-helpers";
import { RecordEvidence } from "../shared/RecordEvidence";
import { NativeButton, NoticeBanner } from "../primitives";
import { NativeList } from "../NativeRoutePageLayout";
export function ImprovementReportDetails({ reportId }: { reportId: string }) {
  const [view, setView] = useState<"recommendation" | "replay" | "history">("recommendation");
  const report = useAsyncLoad(async () => {
    const value = await fetchImprovementReport(reportId);
    if (value.reportId !== reportId) throw new Error("Report identity did not match the selected record.");
    return value;
  }, [reportId]);
  const data = report.data;
  return (
    <>
      {report.error ? <NoticeBanner tone="error" message={report.error} /> : null}
      <NativeButton variant="ghost" disabled={report.loading} onClick={report.reload}>
        Refresh report
      </NativeButton>
      {report.loading && !data ? <p role="status">Loading report…</p> : null}
      {data ? (
        <>
          <p>
            Advisory evidence for {data.weekStart} through {data.weekEnd}. Recommendations do not certify applied
            changes or performance gains.
          </p>
          <div className="mc-next-settings-filter-bar" role="group" aria-label="Improvement report views">
            {(["recommendation", "replay", "history"] as const).map((tab) => (
              <NativeButton key={tab} variant="ghost" aria-pressed={view === tab} onClick={() => setView(tab)}>
                {tab === "recommendation" ? "Recommendation" : tab === "replay" ? "Replay" : "History"}
              </NativeButton>
            ))}
          </div>
          {view === "recommendation" ? (
            <>
              <p>
                {data.summary?.sampledDecisions ?? "Unavailable"} sampled decisions ·{" "}
                {data.summary?.likelyWrongCount ?? "Unavailable"} flagged as likely wrong
              </p>
              <NativeList
                items={(data.queuedRecommendations ?? []).map((item) => ({
                  title: item.description,
                  meta: item.status + " · " + item.riskLevel,
                  body: item.tuneId,
                  actions: (
                    <details>
                      <summary>Recommendation details</summary>
                      <RecordEvidence value={item} />
                    </details>
                  ),
                }))}
                emptyLabel="No queued recommendations returned."
              />
              <details>
                <summary>Findings and proposal evidence</summary>
                <RecordEvidence
                  value={{
                    findings: data.topFindings,
                    proposalDrafts: data.proposalDrafts,
                    strategyTags: data.strategyTags,
                    specialistSuggestions: data.specialistCandidateSuggestions,
                  }}
                />
              </details>
            </>
          ) : null}
          {view === "replay" ? (
            <>
              <p>Replay run {data.runId}</p>
              <RecordEvidence
                value={{
                  summary: data.summary,
                  routingGapSummary: data.routingGapSummary,
                  harnessAudit: data.harnessAudit,
                }}
              />
            </>
          ) : null}
          {view === "history" ? (
            <>
              <RecordEvidence value={data.appliedAutoTunes} />
              <details>
                <summary>All retained report fields</summary>
                <RecordEvidence value={data} />
              </details>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchOpsQualitySnapshot } from "@goatcitadel/mission-control-shared/api/ops-quality";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { QualityGates } from "./quality/QualityGates";
import { QualityEvaluations } from "./quality/QualityEvaluations";
import { QualityDesign } from "./quality/QualityDesign";
import { QualityExports } from "./quality/QualityExports";
import { QualityNotes, qualityTimestamp } from "./quality/QualityEvidence";

const VIEWS = [{ id: "gates", label: "Gates" }, { id: "evaluations", label: "Evaluations" }, { id: "design", label: "Design" }] as const;

export function SystemQuality() {
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("gates");
  const proof = useQuery({ queryKey: [...queryKeys.systemQuality(), "snapshot", 200, 25],
    queryFn: () => fetchOpsQualitySnapshot({ packLimit: 200, evalLimit: 25 }), refetchInterval: 60_000 });
  const snapshot = proof.isError ? undefined : proof.data;
  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="font-display text-xl font-semibold text-fg">Quality</h1>
        <p className="text-sm text-fg-secondary">Installation-wide stored evidence. Refresh and exports do not run evaluations.</p>
      </div>
      <Button size="sm" disabled={proof.isFetching} onClick={() => void proof.refetch()}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
    </header>
    {proof.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading quality proof…</p> : null}
    {proof.isError ? <EmptyState title="Quality proof unavailable" description={describeApiError(proof.error).summary} action={<Button onClick={() => void proof.refetch()}>Try again</Button>} /> : null}
    {snapshot ? <>
      <div className="space-y-1 rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
        <p>Evidence observed {qualityTimestamp(snapshot.generatedAt)}.</p>
        <p>{snapshot.metricScope.note}</p>
        <QualityNotes items={snapshot.warnings} />
      </div>
      <div role="tablist" aria-label="Quality evidence" className="flex gap-1 rounded-md bg-sunken p-1">
        {VIEWS.map((item) => <button key={item.id} id={`quality-tab-${item.id}`} role="tab" type="button"
          aria-selected={view === item.id} aria-controls={`quality-panel-${item.id}`} onClick={() => setView(item.id)}
          className="min-h-9 flex-1 rounded px-3 text-sm font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg">{item.label}</button>)}
      </div>
      <section role="tabpanel" id={`quality-panel-${view}`} aria-labelledby={`quality-tab-${view}`}>
        {view === "gates" ? <QualityGates snapshot={snapshot} reload={() => proof.refetch()} /> : view === "evaluations"
          ? <QualityEvaluations source={snapshot.evalProof} /> : <QualityDesign source={snapshot.designQuality} />}
      </section>
      {snapshot.nextChecks.length ? <details className="rounded-lg border border-line bg-raised p-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg">Recorded next checks</summary>
        <ul className="mt-3 space-y-2">{snapshot.nextChecks.map((check, index) => <li key={`${index}:${check.label}`}>
          <h2 className="text-sm font-medium text-fg">{check.label}</h2><p className="text-sm text-fg-secondary">{check.reason}</p>
          <code className="break-words text-xs text-fg-muted">{check.command}</code>
        </li>)}</ul>
        <p className="mt-2 text-xs text-fg-muted">Commands are recorded guidance. This page does not execute them.</p>
      </details> : null}
    </> : null}
    <QualityExports />
  </section>;
}

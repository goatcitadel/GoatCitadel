import { useState } from "react";
import type { OpsQualitySnapshotResponse } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../../ui/Button";
import { QualityFacts, QualityNotes, QualitySource, qualityNumber, qualityTimestamp } from "./QualityEvidence";

export function QualityEvaluations({ source }: { source: OpsQualitySnapshotResponse["evalProof"] }) {
  const [runId, setRunId] = useState<string | null>(null);
  const selected = source.items.find((run) => run.runId === runId);
  return <QualitySource title="Model evaluations" {...source}>
    <p className="text-sm text-fg-secondary">Stored runtime measurements and operator scores. Inspection does not call providers.</p>
    {source.items.length ? <ol className="grid gap-2">{source.items.map((run, index) => <li key={run.runId} className="rounded-md border border-line-subtle p-3">
      <h3 className="font-medium text-fg">Evaluation {index + 1}</h3>
      <p className="mt-1 text-sm text-fg-secondary">{humanizeToken(run.status)} · {qualityTimestamp(run.createdAt)}</p>
      <p className="mt-1 text-xs text-fg-muted">{run.candidates.length} candidates · {run.results.length} results · {run.warnings.length} warnings</p>
      <Button size="sm" className="mt-2" aria-pressed={runId === run.runId} onClick={() => setRunId(run.runId)}>Inspect evaluation {index + 1}</Button>
    </li>)}</ol> : <p className="text-sm text-fg-muted">No evaluation proof was returned.</p>}
    {runId ? <section aria-label="Selected evaluation" className="space-y-3 rounded-md border border-line bg-sunken p-3">
      {selected ? <>
        <h3 className="font-medium text-fg">Recorded evaluation results</h3>
        <p className="text-sm text-fg-secondary">{qualityTimestamp(selected.createdAt)}</p>
        <QualityNotes items={selected.warnings} />
        {selected.results.length ? <ul className="grid gap-3">{selected.results.map((result, index) => <li key={`${result.providerId}:${result.model}:${index}`} className="space-y-2 rounded-md border border-line-subtle bg-raised p-3">
          <h4 className="break-words text-sm font-semibold text-fg">{result.providerId} · {result.model}</h4>
          <QualityFacts items={[
            { label: "Measurement source", value: humanizeToken(result.measurementSource) },
            { label: "Operator quality score", value: result.qualityScoreSource === "operator" ? qualityNumber(result.qualityScore) : "Not recorded" },
            { label: "Latency", value: qualityNumber(result.latencyMs, " ms") },
            { label: "Estimated cost", value: qualityNumber(result.estimatedCostUsd, " USD") },
            { label: "Energy", value: qualityNumber(result.energyJoules, " J") },
            { label: "Pareto optimal in this recorded set", value: result.paretoOptimal ? "Yes" : "No" },
          ]} />
          <QualityNotes items={result.notes} />
        </li>)}</ul> : <p className="text-sm text-fg-muted">No result rows were recorded for this evaluation.</p>}
        <details><summary className="cursor-pointer text-xs text-fg-muted">Technical evidence</summary>
          <QualityFacts items={[{ label: "Evaluation identity", value: selected.runId }, { label: "Prompt hash", value: selected.promptHash }]} />
        </details>
      </> : <p role="status" className="text-sm text-fg-secondary">The selected evaluation is no longer in the current evidence. Select an evaluation to inspect.</p>}
    </section> : null}
  </QualitySource>;
}

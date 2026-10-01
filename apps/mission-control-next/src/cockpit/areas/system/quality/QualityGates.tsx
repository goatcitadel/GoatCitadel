import { WindowedRecordList } from "../../../ui/WindowedRecordList";
import { useState } from "react";
import type { OpsQualitySnapshotResponse } from "@goatcitadel/contracts";
import { formatSecurityGateStatus, formatSecurityExecutionState } from "../../../../features/native-routes/ops/QualityDashboardRoutePage.helpers";
import { Button } from "../../../ui/Button";
import { ClassicOwnerLink } from "../../../ui/ClassicOwnerLink";
import { QualityFacts, QualityNotes, QualitySource, promptPackQualityHref, qualityNumber } from "./QualityEvidence";
import { QualityPromptPack } from "./QualityPromptPack";
import { QualityDefinitions } from "./QualityDefinitions";

export function QualityGates({ snapshot, reload }: { snapshot: OpsQualitySnapshotResponse; reload: () => Promise<unknown> }) {
  const [gateId, setGateId] = useState<string | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const gates = snapshot.securityQualityGates;
  const selected = gates.items.find((item) => item.gateId === gateId);
  return <div className="space-y-4">
    <QualitySource title="Security quality gates" {...gates}>
      {gates.items.length ? <ul className="grid gap-2">{gates.items.map((gate) => <li key={gate.gateId} className="rounded-md border border-line-subtle p-3">
        <h3 className="font-medium text-fg">{gate.title}</h3>
        <p className="mt-1 text-sm text-fg-secondary">{formatSecurityGateStatus(gate.status)}</p>
        <Button size="sm" className="mt-2" aria-pressed={gateId === gate.gateId} onClick={() => setGateId(gate.gateId)}>Inspect {gate.title}</Button>
      </li>)}</ul> : <p className="text-sm text-fg-muted">No security gates were returned.</p>}
      {gateId ? <section aria-label="Selected quality gate" className="space-y-3 rounded-md border border-line bg-sunken p-3">
        {selected ? <>
          <h3 className="font-medium text-fg">{selected.title}</h3>
          <p className="text-sm text-fg-secondary">{formatSecurityGateStatus(selected.status)} · Stored prompt-pack report</p>
          <QualityFacts items={[
            { label: "Tests", value: selected.evidence.testCount }, { label: "Completed runs", value: selected.evidence.completedRuns },
            { label: "Failed runs", value: selected.evidence.failedRuns }, { label: "Awaiting scores", value: selected.evidence.needsScoreCount },
            { label: "Pass / fail / review", value: `${selected.evidence.passCount} / ${selected.evidence.failCount} / ${selected.evidence.reviewCount}` },
            { label: "Recorded pass rate", value: qualityNumber(selected.evidence.effectivePassRate * 100, "%") },
          ]} />
          <QualityNotes items={[...selected.blockers, ...selected.nextActions]} />
          <p className="text-xs text-fg-muted">{selected.posture.note}</p>
          <ClassicOwnerLink href={promptPackQualityHref(selected.packId)} scope={JSON.stringify([selected.gateId, selected.packId])} className="inline-block text-sm text-accent hover:underline" label="Review prompt-pack scoring" />
        </> : <p role="status" className="text-sm text-fg-secondary">The selected gate is no longer in the current evidence. Select a gate to inspect.</p>}
      </section> : null}
    </QualitySource>
    <QualitySource title="Prompt packs" {...snapshot.promptPacks}>
      {snapshot.promptPacks.items.length ? <WindowedRecordList items={snapshot.promptPacks.items} itemKey={(pack) => pack.packId} label="Prompt pack definitions" className="h-80">{(pack) => <article className="rounded-md border border-line-subtle p-3">
        <h3 className="font-medium text-fg">{pack.name}</h3>
        <p className="mt-1 text-sm text-fg-muted">{pack.testCount ?? "Unknown"} defined tests</p>
        <Button size="sm" className="mt-2 mr-3" aria-pressed={packId === pack.packId} onClick={() => setPackId(pack.packId)}>Inspect {pack.name}</Button>
        <ClassicOwnerLink href={promptPackQualityHref(pack.packId)} scope={pack.packId} className="mt-2 inline-block text-sm text-accent hover:underline" label={`Review ${pack.name}`} />
      </article>}</WindowedRecordList> : <p className="text-sm text-fg-muted">No prompt packs were returned.</p>}
      {packId ? <QualityPromptPack pack={snapshot.promptPacks.items.find((pack) => pack.packId === packId)} observedAt={snapshot.generatedAt} /> : null}
    </QualitySource>
    <QualitySource title="Security execution coverage" {...snapshot.securityExecution}>
      {snapshot.securityExecution.items.length ? <ul className="grid gap-2">{snapshot.securityExecution.items.map((item) => <li key={item.packKey} className="space-y-2 rounded-md border border-line-subtle p-3">
        <h3 className="font-medium text-fg">{item.title}</h3>
        <p className="text-sm text-fg-secondary">{formatSecurityExecutionState(item.state)}</p>
        <QualityFacts items={[{ label: "Run coverage", value: qualityNumber(item.runCoverage * 100, "%") },
          { label: "Scored coverage", value: qualityNumber(item.scoredCoverage * 100, "%") }]} />
        <QualityNotes items={[...item.blockers, ...item.nextActions]} />
      </li>)}</ul> : <p className="text-sm text-fg-muted">No security execution evidence was returned.</p>}
    </QualitySource>
    <QualitySource title="Defensive security definitions" {...snapshot.securityEvalPacks}>
      <QualityDefinitions items={snapshot.securityEvalPacks.items} reload={reload} />
    </QualitySource>
  </div>;
}

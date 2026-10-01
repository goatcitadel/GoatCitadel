import { useState } from "react";
import type { OpsQualitySnapshotResponse } from "@goatcitadel/contracts";
import { formatDesignQualityStatus } from "../../../../features/native-routes/ops/QualityDashboardRoutePage.helpers";
import { Button } from "../../../ui/Button";
import { QualityFacts, QualitySource } from "./QualityEvidence";

export function QualityDesign({ source }: { source: OpsQualitySnapshotResponse["designQuality"] }) {
  const [checkId, setCheckId] = useState<string | null>(null);
  const selected = source.checks.find((check) => check.id === checkId);
  return <QualitySource title="Design quality checks" {...source}>
    <p className="text-sm text-fg-secondary">{source.posture.note}</p>
    {source.checks.length ? <ul className="grid gap-2">{source.checks.map((check, index) => <li key={check.id} className="rounded-md border border-line-subtle p-3">
      <h3 className="font-medium text-fg">{check.label}</h3>
      <p className="mt-1 text-sm text-fg-secondary">{formatDesignQualityStatus(check.status)} · {check.severity}</p>
      <Button size="sm" className="mt-2" aria-pressed={checkId === check.id} onClick={() => setCheckId(check.id)}>Inspect check {index + 1}</Button>
    </li>)}</ul> : <p className="text-sm text-fg-muted">No design checks were returned.</p>}
    {checkId ? <section aria-label="Selected design check" className="space-y-3 rounded-md border border-line bg-sunken p-3">
      {selected ? <>
        <h3 className="font-medium text-fg">{selected.label}</h3>
        <QualityFacts items={[{ label: "Status", value: formatDesignQualityStatus(selected.status) },
          { label: "Severity", value: selected.severity }, { label: "Owner", value: selected.owner }]} />
        <p className="break-words text-sm text-fg-secondary">{selected.evidence}</p>
        {selected.nextAction ? <p className="break-words text-sm text-fg-secondary">Next action: {selected.nextAction}</p> : null}
      </> : <p role="status" className="text-sm text-fg-secondary">The selected check is no longer in the current evidence. Select a check to inspect.</p>}
    </section> : null}
  </QualitySource>;
}

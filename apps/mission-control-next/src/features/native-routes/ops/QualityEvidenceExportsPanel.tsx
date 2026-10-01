import { ClipboardCopy } from "lucide-react";
import type { OpsQualitySnapshotResponse } from "@goatcitadel/contracts";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import { NativeButton, StatusChip } from "../primitives";
import type { useQualityEvidenceClipboard } from "./use-quality-evidence-clipboard";

type Clipboard = ReturnType<typeof useQualityEvidenceClipboard>;
export function QualityEvidenceExportsPanel({
  pending,
  copy,
  checks,
  openRuntime,
}: {
  pending: Clipboard["pending"];
  copy: Clipboard["copy"];
  checks: OpsQualitySnapshotResponse["nextChecks"];
  openRuntime: () => void;
}) {
  return (
    <>
      <NativeButton variant="outline" onClick={() => void copy("evaluations")} disabled={pending !== null}>
        <ClipboardCopy size={16} />
        {pending === "evaluations" ? "Exporting..." : "Copy eval proof export"}
      </NativeButton>
      <NativeCard
        title="Export posture"
        subtitle="Exports are read-only evidence snapshots; they do not rerun, approve, or replay work."
      >
        <div className="mc-next-approvals-chip-row">
          <StatusChip tone="success">Prompt-pack report export</StatusChip>
          <StatusChip tone="success">Run trace JSON export</StatusChip>
          <StatusChip tone="success">Eval proof JSON export</StatusChip>
          <StatusChip tone="success">OTel JSON evidence export</StatusChip>
          <StatusChip tone="muted">Audit-only</StatusChip>
        </div>
        <NativeList
          density="compact"
          items={[
            {
              title: "Prompt-pack report",
              meta: "Library · Prompt Packs",
              body: "Exports the stored report and snapshot path from the prompt-pack workbench.",
            },
            {
              title: "Eval proof JSON",
              meta: "Ops · Quality",
              body: "Copies stored runtime measurement and operator quality-score evidence without calling providers.",
            },
            {
              title: "Run trace JSON",
              meta: "Ops · Run Detail",
              body: "Copies the observe trace export payload from the selected durable run.",
            },
            {
              title: "OTel JSON evidence",
              meta: "Ops · Quality",
              body: "Copies stored quality evidence as an OpenTelemetry-style transport payload without changing runtime truth.",
            },
          ]}
          emptyLabel="No export surfaces are registered."
        />
        <div className="mc-next-approvals-inline-actions">
          <NativeButton variant="secondary" onClick={() => void copy("quality")} disabled={pending !== null}>
            <ClipboardCopy size={16} />
            {pending === "quality" ? "Exporting..." : "Copy OTel evidence"}
          </NativeButton>
        </div>
        <button type="button" className="mc-next-directory-action" onClick={openRuntime}>
          <span>Open runtime evidence</span>
        </button>
      </NativeCard>
      <details>
        <summary>Governance reminders</summary>
        <NativeCard
          title="Governance reminders"
          subtitle="Quality evidence is advisory unless it is tied to durable runs, approvals, and release gates."
        >
          <NativeList
            density="compact"
            items={[
              {
                title: "No hidden pass claim",
                meta: "Truth posture",
                body: "A green eval row is not a release claim unless the relevant verification lane also passed.",
              },
              {
                title: "No autonomous promotion",
                meta: "Human-in-the-loop",
                body: "Skill, model, and prompt-pack changes still route through visible operator review.",
              },
              {
                title: "Exports are snapshots",
                meta: "Audit-only",
                body: "Exported traces and eval reports preserve evidence; they do not mutate runtime state.",
              },
            ]}
            emptyLabel="No governance reminders are configured."
          />
        </NativeCard>
      </details>
      <NativeCard title="Next checks" subtitle="Use existing release lanes instead of inventing dashboard-only proof.">
        <NativeList
          density="compact"
          items={checks.map((check) => ({
            title: check.label,
            meta: check.command.replace(/^pnpm\s+/, ""),
            body: check.reason,
          }))}
          emptyLabel="No checks are configured."
        />
      </NativeCard>
      <p>
        No provider calls. No source writes. Evidence projections are read-only; explicit import actions remain
        operator-initiated.
      </p>
    </>
  );
}

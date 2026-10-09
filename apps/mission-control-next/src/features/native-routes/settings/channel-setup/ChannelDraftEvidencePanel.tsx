import type { ChannelSetupDraftEvidence } from "@goatcitadel/contracts";
import { useChannelProofFreshness } from "./use-channel-proof-freshness";
import { ChannelCheckDetails } from "./ChannelCheckFeedback";
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Timestamp unavailable";
const status = { ok: "Passed", warn: "Warning", error: "Needs attention", idle: "Not checked" };

export function ChannelDraftEvidencePanel({ evidence, loading, error }: { evidence?: ChannelSetupDraftEvidence; loading?: boolean; error?: string | null }) {
  const expired = useChannelProofFreshness(evidence?.currentTest ? { ...evidence.currentTest, kind: "test", restored: true } : undefined);
  if (!evidence && !loading && !error) return null;
  return <section aria-label="Channel check history" aria-busy={loading} className="min-w-0 space-y-2 text-sm">
    <h4 className="font-semibold">Saved check evidence</h4>
    {loading ? <p role="status">Loading saved check evidence…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {evidence ? <>
      <p>Saved receipts are historical evidence. Only the Gateway’s current proof for this exact draft revision can permit preparing a plan.</p>
      {!evidence.currentTest || expired ? <p role="status">No fresh test proof is available for this saved revision. Review the saved checks, then run a reviewed test before preparing a plan.</p> : null}
      <details>
        <summary className="cursor-pointer">Review {evidence.items.length} saved check {evidence.items.length === 1 ? "receipt" : "receipts"}</summary>
        {evidence.items.length ? <ol className="mt-2 max-h-[36rem] space-y-3 overflow-auto">
          {evidence.items.slice(0, 20).map((item) => <li key={item.evidenceId} className="min-w-0 space-y-2 rounded-md border border-line p-3">
            <h5 className="font-medium">{item.phase === "test" ? "Test" : item.phase === "acknowledgement" ? "Acknowledgement" : "Activation"} · {status[item.status]}</h5>
            <p className="text-xs">Tested draft revision {item.draftRevision} · Checked {timestamp(item.checkedAt)}</p>
            <p className="text-xs text-fg-muted">Recorded {timestamp(item.createdAt)}</p>
            {item.acknowledgement ? <p>{item.acknowledgement === "cleanup" ? "Reviewed cleanup warning acknowledged." : "Observed sandbox message confirmed."} The original test warnings remain recorded.</p> : null}
            <ChannelCheckDetails issues={item.issues} probe={item.probe} probeLabel="Saved connection probe" />
            <p className="break-all text-xs text-fg-muted">Receipt {item.evidenceId}{item.priorEvidenceId ? " · Previous receipt " + item.priorEvidenceId : ""}</p>
          </li>)}
        </ol> : <p className="mt-2">No saved test receipts are recorded for this draft.</p>}
      </details>
    </> : null}
  </section>;
}

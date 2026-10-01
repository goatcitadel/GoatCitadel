import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatUsd } from "../../../app/mission-control-shell-model";
import { useCitadelBrief } from "../../../features/native-routes/library/use-citadel-brief";
import { formatBriefAge } from "../../../features/native-routes/library/citadel-brief-format";
import { Button } from "../../ui/Button";

export function CitadelBrief({ citadelId }: { citadelId: string }) {
  const control = useCitadelBrief(citadelId), { state } = control, brief = state.brief;
  return <article aria-label="Daily Citadel brief" className="space-y-3 rounded-md border border-line-subtle bg-sunken p-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-fg">Daily brief</h4>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={state.loading} onClick={() => void control.load()}>Refresh brief</Button>
        <Button size="sm" disabled={state.loading || !brief || control.copying} onClick={() => void control.copy()}>Copy as Markdown</Button></div></header>
    {state.loading ? <p role="status" className="text-sm text-fg-muted">Assembling the last 24 hours…</p> : null}
    {state.error ? <p role="alert" className="text-sm text-status-failed">{state.error}</p> : null}
    {control.copyNotice ? <p role={control.copyNotice.tone === "success" ? "status" : "alert"} className="text-sm text-fg-secondary">{control.copyNotice.message}</p> : null}
    {brief ? <>
      <p className="text-xs text-fg-muted">Window: {new Date(brief.since).toLocaleString()} to {new Date(brief.generatedAt).toLocaleString()} · {brief.workspaces.length} workspace{brief.workspaces.length === 1 ? "" : "s"}.</p>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{[
        ["Pending approvals", String(brief.approvals.pendingCount)], ["Completed", String(brief.activity.completedSince)], ["Failed", String(brief.activity.failedSince)],
        ["Ward hits", String(brief.activity.wardHitsSince)], ["Spend · installation", `${formatUsd(brief.spend.sinceUsd)}${brief.spend.complete ? "" : " · partial"}`], ["Tokens · installation", String(brief.spend.sinceTokens)],
      ].map(([label, value]) => <div key={label}><dt className="text-fg-muted">{label}</dt><dd className="mt-1 break-words font-medium text-fg">{value}</dd></div>)}</dl>
      <p className="text-xs text-fg-muted">Spend and token totals cover the installation; they are not filtered to this Citadel.</p>
      <ul aria-label="Approvals waiting on you" className="max-h-64 space-y-2 overflow-y-auto">{brief.approvals.pending.slice(0, 100).map(item => <li key={item.approvalId} className="rounded-md border border-line-subtle bg-raised p-3"><p className="text-sm font-medium text-fg">{humanizeToken(item.kind)}</p><p className="mt-1 break-words text-xs text-fg-secondary">{humanizeToken(item.riskLevel)} risk · waiting {formatBriefAge(item.ageMs)} · {item.workspaceId}</p></li>)}</ul>
      {!brief.approvals.pending.length ? <p className="text-sm text-fg-muted">Nothing is waiting on you in this brief.</p> : null}
      <p className="text-sm text-fg-secondary">{"unavailable" in brief.memory ? `Memory review is unavailable: ${brief.memory.unavailable}` : `${brief.memory.pendingRecommendations} memory recommendation(s) pending review.`}</p>
    </> : null}
  </article>;
}

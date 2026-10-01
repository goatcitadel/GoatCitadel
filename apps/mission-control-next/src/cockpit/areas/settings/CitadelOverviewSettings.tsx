import { useId, useState } from "react";
import type { CitadelTemplateSnapshot } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useCitadelOverview } from "../../../features/native-routes/library/use-citadel-overview";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { CitadelBrief } from "./CitadelBrief";

export function CitadelOverviewSettings({ citadelId }: { citadelId: string }) {
  const [view, setView] = useState("charter"), purposeId = useId();
  const control = useCitadelOverview(citadelId, view);
  const { state, templateState, lifecycle, lifecycleTarget, charterDraft } = control;
  const leave = useDraftLeaveDialogState(control.leave.dialogProps);
  const charter = state.citadel?.charter;
  const review = control.review;
  const changeView = (next: string) => control.leave.request(() => { control.invalidateReview(); setView(next); }, [charterDraft.key]);
  return <section id="citadel-overview" aria-label="Citadel Overview" className="mt-4 space-y-4 border-t border-line-subtle pt-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-display text-md font-semibold text-fg">Citadel Overview</h3>
      <p className="mt-1 text-sm text-fg-secondary">Review this operating space's Charter, Chambers and Gatehouse posture.</p>
      <p className="mt-1 break-all text-xs text-fg-muted">Citadel: {citadelId}</p></div>
      <Button size="sm" disabled={state.loading} onClick={() => void control.reload()}>Refresh Overview</Button></header>
    {state.loading ? <p role="status" className="text-sm text-fg-muted">Loading Citadel structure…</p> : null}
    {state.error ? <p role="alert" className="text-sm text-status-failed">{state.error}</p> : null}
    {control.notice ? <p role={control.notice.tone === "success" ? "status" : "alert"} className={`text-sm ${control.notice.tone === "error" ? "text-status-failed" : "text-fg-secondary"}`}>{control.notice.message}</p> : null}
    {control.attempt.message ? <p role={control.attempt.phase === "uncertain" ? "alert" : "status"} className="text-sm text-status-waiting">{control.attempt.message}</p> : null}
    {lifecycle.notice || control.lifecycleMessage ? <p role="status" className="text-sm text-status-waiting">{lifecycle.notice ?? control.lifecycleMessage}</p> : null}
    {state.snapshot && !state.error ? charter ? <>
      <div role="group" aria-label="Citadel view" className="flex flex-wrap gap-2">{["charter", "chambers", "gatehouse", "brief"].map(item => <Button key={item} aria-pressed={view === item} onClick={() => changeView(item)}>{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</div>
      {view === "brief" ? <CitadelBrief key={citadelId} citadelId={citadelId} /> : null}
      {view === "charter" ? <article className="space-y-3 rounded-md border border-line-subtle bg-sunken p-3">
        <h4 className="font-medium text-fg">Charter</h4><p className="break-words text-sm text-fg">{charter.purpose}</p>
        <p className="text-xs text-fg-muted">{humanizeToken(charter.kind)} · {humanizeToken(charter.riskPosture)} · {humanizeToken(charter.modelPolicyDefault)} · {humanizeToken(state.snapshot.record?.lifecycleStatus ?? "active")}</p>
        <dl className="space-y-2 text-sm text-fg-secondary">{(["goals", "boundaries", "successDefinition"] as const).map(field => <div key={field}><dt className="font-medium">{field === "successDefinition" ? "Success" : field === "goals" ? "Goals" : "Boundaries"}</dt><dd className="break-words">{charter[field].join(" · ") || "None recorded"}</dd></div>)}</dl>
        <div className="flex flex-wrap gap-2"><Button disabled={control.pending || state.loading} onClick={control.openEditor}>Edit Charter{charterDraft.isDirty ? " · Unsaved" : ""}</Button>
          <Button disabled={control.locked || state.loading || !lifecycleTarget || control.lifecycleLocked} onClick={() => lifecycleTarget && lifecycle.request(lifecycleTarget)}>{lifecycleTarget?.action === "restore" ? "Restore Citadel" : "Archive Citadel"}</Button></div>
      </article> : null}
      {view === "chambers" ? <div className="space-y-2"><h4 className="text-sm font-medium text-fg">Chambers</h4>{state.citadel!.chambers.length ? <ul className="space-y-2">{state.citadel!.chambers.slice(0, 100).map(chamber => <li key={chamber.chamberId} className="rounded-md border border-line-subtle bg-sunken p-3"><p className="break-words text-sm font-medium text-fg">{chamber.name}</p><p className="text-xs text-fg-muted">{humanizeToken(chamber.sensitivity)} · {chamber.sealed ? "Sealed" : "Unsealed"}</p><details className="mt-1 text-xs text-fg-muted"><summary className="cursor-pointer">Chamber identity</summary><p className="break-all">{chamber.chamberId}</p></details></li>)}</ul> : <p className="text-sm text-fg-muted">No Chambers recorded.</p>}
        {state.citadel!.chambers.length > 100 ? <p className="text-xs text-fg-muted">Showing the first 100 Chambers. Blueprint export contains the complete saved structure.</p> : null}</div> : null}
      {view === "gatehouse" ? state.gatehouse ? <dl className="grid gap-3 text-sm sm:grid-cols-2">{[
        ["Risk posture", humanizeToken(state.gatehouse.riskPosture)], ["Model policy", humanizeToken(state.gatehouse.modelPolicyDefault)], ["Sharing", humanizeToken(state.gatehouse.sharingDefault)],
        ["External writes", humanizeToken(state.gatehouse.externalWritesDefault)], ["Wards", String(state.gatehouse.wardCount)], ["Sealed Chambers", String(state.gatehouse.sealedChamberCount)],
      ].map(([label, value]) => <div key={label} className="rounded-md border border-line-subtle bg-sunken p-3"><dt className="font-medium text-fg">{label}</dt><dd className="mt-1 text-fg-secondary">{value}</dd></div>)}</dl> : <p className="text-sm text-fg-muted">Gatehouse evidence is unavailable.</p> : null}
      <p className="text-xs text-fg-muted">Wards and Gates are evaluated with deny-wins policy. Sealed Chambers do not widen access.</p>
      <details className="rounded-md border border-line-subtle bg-sunken p-3 text-sm text-fg-secondary"><summary className="cursor-pointer">Default templates for reference</summary>
        <p className="mt-2">This Citadel already has a Charter. These templates are shown for inspection.</p>
        {templateState.loading ? <p role="status">Loading templates…</p> : templateState.error ? <p role="alert">{templateState.error}</p> : control.defaultTemplates.length ? <div className="mt-3 space-y-3">{control.defaultTemplates.map(template => <article key={template.id}><h4 className="font-medium text-fg">{template.name}</h4><p>{template.description}</p><TemplateContents template={template} /></article>)}</div> : <p>Default templates are unavailable.</p>}
      </details>
    </> : <div className="space-y-3"><p className="text-sm text-fg-secondary">This Citadel needs a Charter. Review a default template, or use Setup for a custom Blueprint.</p>
      {templateState.loading ? <p role="status" className="text-sm text-fg-muted">Loading templates…</p> : null}
      {templateState.error ? <p role="alert" className="text-sm text-status-failed">{templateState.error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">{control.defaultTemplates.map(template => <TemplateCard key={template.id} template={template} disabled={control.locked || control.lifecycleLocked || state.loading || state.snapshot?.record?.lifecycleStatus === "archived"} onReview={() => control.requestTemplate(template)} />)}</div>
      {!templateState.loading && !templateState.error && !control.defaultTemplates.length ? <p className="text-sm text-fg-muted">Default templates are unavailable.</p> : null}
    </div> : null}
    <Dialog open={control.editing} title="Edit Charter" description="Review the exact purpose and saved structure before confirming."
      onOpenChange={open => { if (!open) control.closeEditor(); }}>
      {control.notice && control.notice.tone !== "success" ? <p role="alert" className="mb-3 text-sm text-status-waiting">{control.notice.message}</p> : null}
      {control.attempt.message ? <p role={control.attempt.phase === "uncertain" ? "alert" : "status"} className="mb-3 text-sm text-status-waiting">{control.attempt.message}</p> : null}
      {control.lifecycleMessage ? <p role="alert" className="mb-3 text-sm text-status-waiting">{control.lifecycleMessage}</p> : null}
      {charterDraft.hasRemoteChanges ? <div className="mb-3 space-y-2 text-sm text-status-waiting"><p>The Citadel changed after this draft began. Current purpose: {charter?.purpose}</p>
        <p>Current Chambers: {state.citadel?.chambers.map(chamber => chamber.name).join(" · ") || "None"}</p><Button disabled={control.locked} onClick={() => { control.invalidateReview(); charterDraft.rebaseToCurrent(); }}>Apply draft to current Charter</Button></div> : null}
      <label htmlFor={purposeId} className="block text-sm text-fg-secondary">Purpose</label>
      <textarea id={purposeId} rows={4} disabled={control.locked} value={charterDraft.value} onChange={event => control.changePurpose(event.target.value)} className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg" />
      {review?.kind === "charter" ? <div className="mt-3 space-y-2 text-sm text-fg-secondary"><p className="break-words">Reviewed purpose: {review.input.purpose}</p><p>Other Charter fields and Chambers keep their reviewed values.</p><p className="break-all text-xs">Structure revision: {review.before.revision}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={control.locked} onClick={() => void control.confirm()}>Confirm Charter save</Button><Button disabled={control.pending} onClick={control.cancelReview}>Cancel review</Button></div></div>
        : <div className="mt-3 flex flex-wrap gap-2"><Button disabled={control.locked || control.lifecycleLocked || charterDraft.hasRemoteChanges || !charterDraft.value.trim() || state.snapshot?.record?.lifecycleStatus === "archived"} onClick={control.requestCharter}>Review Charter save</Button><Button disabled={control.pending} onClick={control.closeEditor}>Close Charter</Button></div>}
    </Dialog>
    <Dialog open={review?.kind === "template"} title="Apply this Citadel template?" description="Create the reviewed Charter and add its Chambers. The default Chamber is cleared. Connections and grants keep their existing setup steps."
      onOpenChange={open => { if (!open) control.cancelReview(); }}>
      {review?.kind === "template" ? <div className="space-y-3 text-sm text-fg-secondary"><TemplateContents template={review.template} /><p className="break-all text-xs">Citadel: {citadelId}<br />Structure revision: {review.before.revision}<br />Template revision: {review.template.revision}</p></div> : null}
      <div className="mt-3 flex flex-wrap gap-2"><Button disabled={control.locked} onClick={() => void control.confirm()}>Apply template</Button><Button disabled={control.pending} onClick={control.cancelReview}>Cancel</Button></div>
    </Dialog>
    <Dialog open={Boolean(lifecycle.review)} title={lifecycle.review?.action === "restore" ? "Restore Citadel?" : "Archive Citadel?"} description="The reviewed record is retained, and your selection stays as saved. Archive also discards only its retained profile edit draft."
      onOpenChange={open => { if (!open) lifecycle.cancel(); }}>
      <p className="break-words text-sm text-fg-secondary">{lifecycle.review?.record.name}</p><p className="mt-2 break-all text-xs text-fg-muted">Citadel: {citadelId}<br />Profile revision: {lifecycle.review?.record.revision}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant={lifecycle.review?.action === "archive" ? "danger" : "primary"} disabled={lifecycle.pending} onClick={() => void lifecycle.confirm()}>{lifecycle.review?.action === "restore" ? "Confirm restore" : "Confirm archive"}</Button><Button disabled={lifecycle.pending} onClick={lifecycle.cancel}>Cancel</Button></div>
    </Dialog>
    <Dialog open={control.leave.dialogProps.open} title="Unsaved Charter draft" description={leave.description} onOpenChange={open => { if (!open) control.leave.dialogProps.onCancel(); }}>
      <div className="flex flex-wrap gap-2">{leave.canKeep ? <Button onClick={control.leave.dialogProps.onContinue}>Keep draft and close</Button> : null}<Button variant="danger" onClick={leave.discard}>Discard changes</Button><Button onClick={control.leave.dialogProps.onCancel}>Cancel</Button></div>
    </Dialog>
  </section>;
}

function TemplateCard({ template, disabled, onReview }: { template: CitadelTemplateSnapshot; disabled: boolean; onReview: () => void }) {
  return <article className="space-y-2 rounded-md border border-line-subtle bg-sunken p-3"><h4 className="break-words text-sm font-medium text-fg">{template.name}</h4><p className="text-sm text-fg-secondary">{template.description}</p>
    <details className="text-sm text-fg-secondary"><summary className="cursor-pointer">Template contents</summary><TemplateContents template={template} /></details>
    <Button disabled={disabled} onClick={onReview}>Review template</Button></article>;
}
function TemplateContents({ template }: { template: CitadelTemplateSnapshot }) {
  return <dl className="mt-2 space-y-2 text-sm text-fg-secondary">{[["Purpose", template.purpose], ["Goals", template.goals.join(" · ")], ["Boundaries", template.boundaries.join(" · ")], ["Success", template.successDefinition.join(" · ")],
    ["Risk posture", humanizeToken(template.riskPosture ?? "balanced")], ["Model policy", humanizeToken(template.modelPolicyDefault ?? "hybrid_guarded")],
    ["Chambers", template.chambers.map(chamber => `${chamber.name} (${humanizeToken(chamber.sensitivity ?? "private")}${chamber.sealed ? ", sealed" : ""})`).join(" · ")]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="break-words">{value || "None recorded"}</dd></div>)}</dl>;
}

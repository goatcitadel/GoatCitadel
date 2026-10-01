import { useId } from "react";
import type { CitadelBlueprint } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useCitadelBlueprint, parseBlueprint } from "../../../features/native-routes/library/use-citadel-blueprint";
import { buildBlueprintProofItems, downloadBlueprint } from "../../../features/native-routes/library/citadel-blueprint-artifact";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function CitadelBlueprintSettings({ citadelId }: { citadelId: string }) {
  const control = useCitadelBlueprint(citadelId), inputId = useId(), fileId = useId();
  const leave = useDraftLeaveDialogState(control.leave.dialogProps);
  const parsed = parseBlueprint(control.importText);
  const candidate = control.importState.validation?.ok && "blueprint" in parsed ? parsed.blueprint as CitadelBlueprint : null;
  const proof = buildBlueprintProofItems(control.exportState.json, citadelId);
  const notice = control.attempt.message;
  return <section id="citadel-blueprint" aria-label="Citadel Blueprint" className="mt-4 space-y-4 border-t border-line-subtle pt-4">
    <header><h3 className="font-display text-md font-semibold text-fg">Blueprint</h3>
      <p className="mt-1 text-sm text-fg-secondary">Export a portable Charter and Chambers, or validate and review an import for this Citadel.</p>
      <p className="mt-1 break-all text-xs text-fg-muted">Citadel: {citadelId}</p></header>
    <div role="group" aria-label="Blueprint view" className="flex flex-wrap gap-2">
      {(["export", "import"] as const).map(view => <Button key={view} aria-pressed={control.view === view}
        onClick={() => control.leave.request(() => control.setView(view), [control.blueprintDraft.key])}>{view === "export" ? "Export" : `Import${control.blueprintDraft.isDirty ? " · Unsaved" : ""}`}</Button>)}
    </div>
    {control.view === "export" ? <div className="space-y-3">
      {control.exportState.loading ? <p role="status" className="text-sm text-fg-muted">Loading Blueprint export…</p> : null}
      {control.exportState.error ? <p role="alert" className="text-sm text-status-failed">{control.exportState.error}</p> : null}
      {!control.exportState.loading && !control.exportState.error && !control.exportState.staged ? <p className="text-sm text-fg-secondary">This Citadel needs a Charter before export.</p> : null}
      {control.exportState.json ? <>
        <dl className="grid gap-3 sm:grid-cols-2">{proof.map(item => <div key={item.title} className="rounded-md border border-line-subtle bg-sunken p-3">
          <dt className="text-sm font-medium text-fg">{item.title}</dt><dd className="mt-1 break-words text-xs text-fg-secondary">{item.meta}</dd><dd className="mt-1 text-xs text-fg-muted">{item.body}</dd></div>)}</dl>
        <div className="flex flex-wrap gap-2"><Button onClick={() => {
          try { downloadBlueprint(control.exportState.json!, citadelId); control.setExportNotice("Blueprint downloaded as a secret-free JSON file."); }
          catch { control.setExportNotice("The Blueprint download could not start."); }
        }}>Download blueprint</Button><Button disabled={control.locked} onClick={control.loadExportForImport}>Load export for import</Button></div>
        <details className="text-sm text-fg-secondary"><summary className="cursor-pointer">Export preview</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-3 text-xs">{control.exportState.json}</pre></details>
      </> : null}
      {control.exportNotice ? <p role="status" className="text-sm text-fg-secondary">{control.exportNotice}</p> : null}
      <Button size="sm" disabled={control.exportState.loading} onClick={control.refreshExport}>Refresh export</Button>
    </div> : <div className="space-y-3">
      <label htmlFor={fileId} className="block text-sm text-fg-secondary">Choose Blueprint file (up to 1 MiB)</label>
      <input id={fileId} type="file" accept="application/json,.json" disabled={control.locked || control.importState.busy}
        className="block w-full min-w-0 text-sm text-fg" onChange={event => { const file = event.target.files?.[0]; if (file) void control.loadFile(file); event.target.value = ""; }} />
      <p className="text-xs text-fg-muted">A file is loaded into this app's draft. Validation and a separate import confirmation are required to change the Citadel.</p>
      <details open={Boolean(control.importText)} className="text-sm text-fg-secondary"><summary className="cursor-pointer">Paste or inspect Blueprint JSON</summary>
        <label htmlFor={inputId} className="mt-2 block">Blueprint JSON</label>
        <textarea id={inputId} value={control.importText} rows={8} disabled={control.locked || control.importState.busy}
          className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-fg"
          onChange={event => control.changeText(event.target.value)} /></details>
      <div className="flex flex-wrap gap-2"><Button disabled={control.locked || control.importState.busy || !control.importText.trim()} onClick={() => void control.validate()}>Validate</Button>
        <Button disabled={!control.canApply} onClick={() => control.setConfirmImport(true)}>Review import</Button>
        <Button disabled={control.locked} onClick={() => control.leave.request(() => control.setView("export"), [control.blueprintDraft.key])}>Close import</Button></div>
      {control.importState.busy ? <p role="status" className="text-sm text-fg-muted">Checking the Blueprint owner…</p> : null}
      {control.importState.error ? <p role="alert" className="text-sm text-status-failed">{control.importState.error}</p> : null}
      {control.importState.validation ? control.importState.validation.ok
        ? <p role="status" className="text-sm text-status-done">Blueprint valid — review its changes before importing.</p>
        : <ul aria-label="Blueprint validation errors" className="list-disc space-y-1 pl-5 text-sm text-status-failed">{control.importState.validation.errors.slice(0, 20).map((error, index) => <li key={index}>{error}</li>)}</ul> : null}
      {candidate ? <BlueprintSummary blueprint={candidate} /> : null}
      {control.reviewedTarget?.record?.lifecycleStatus === "archived" ? <p role="status" className="text-sm text-status-waiting">Restore this Citadel, then validate again before importing.</p> : null}
      {control.importState.done ? <p role="status" className="text-sm text-status-done">Blueprint imported and confirmed against the saved structure.</p> : null}
    </div>}
    {notice ? <p role={control.attempt.phase === "uncertain" ? "alert" : "status"} className="break-words text-sm text-status-waiting">{notice}</p> : null}
    <Dialog open={control.confirmImport} onOpenChange={open => control.setConfirmImport(open)} title="Apply this Blueprint?"
      description="Replace the Charter and add the Blueprint's Chambers. Existing Chambers are retained. The Charter default Chamber is cleared; external connections and grants keep their existing setup and approval steps.">
      <dl className="space-y-2 break-words text-sm text-fg-secondary"><dt>Citadel</dt><dd className="font-mono">{citadelId}</dd>
        <dt>Reviewed revision</dt><dd className="break-all font-mono">{control.reviewedTarget?.revision}</dd>
        <dt>Current Charter</dt><dd>{control.reviewedTarget?.charter?.purpose ?? "No Charter yet"}</dd>
        <dt>Imported Charter</dt><dd>{candidate?.charter?.purpose}</dd></dl>
      <div className="mt-4 flex flex-wrap gap-2"><Button variant="danger" disabled={control.locked} onClick={() => void control.applyImport()}>Apply Blueprint</Button>
        <Button disabled={control.locked} onClick={() => control.setConfirmImport(false)}>Cancel</Button></div>
    </Dialog>
    <Dialog open={control.leave.dialogProps.open} title="Unsaved Blueprint draft" description={leave.description}
      onOpenChange={open => { if (!open) control.leave.dialogProps.onCancel(); }}>
      <div className="flex flex-wrap gap-2">{leave.canKeep ? <Button onClick={control.leave.dialogProps.onContinue}>Keep draft and close</Button> : null}
        <Button variant="danger" onClick={leave.discard}>Discard changes</Button><Button onClick={control.leave.dialogProps.onCancel}>Cancel</Button></div>
    </Dialog>
  </section>;
}

function BlueprintSummary({ blueprint }: { blueprint: CitadelBlueprint }) {
  return <div aria-label="Validated Blueprint summary" className="space-y-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
    <h4 className="break-words font-medium text-fg">{blueprint.metadata?.name}</h4><p>{blueprint.metadata?.description}</p><p>{blueprint.charter?.purpose}</p>
    <p>{humanizeToken(blueprint.charter?.kind)} · {humanizeToken(blueprint.charter?.riskPosture)} · {humanizeToken(blueprint.charter?.modelPolicyDefault)}</p>
    <p>{blueprint.chambers?.length ?? 0} Chambers will be added.</p>
    <ul className="space-y-1">{blueprint.chambers?.slice(0, 20).map((chamber, index) => <li key={index} className="break-words">{chamber.name} · {humanizeToken(chamber.sensitivity)} · {chamber.sealed ? "Sealed" : "Unsealed"}</li>)}</ul>
    {(blueprint.chambers?.length ?? 0) > 20 ? <p className="text-xs text-fg-muted">Showing the first 20 Chambers; the JSON preview contains the full import.</p> : null}
    <details><summary className="cursor-pointer">Goals, boundaries and success</summary><dl className="mt-2 space-y-2">
      {(["goals", "boundaries", "successDefinition"] as const).map(field => <div key={field}><dt className="font-medium">{field === "successDefinition" ? "Success" : field === "goals" ? "Goals" : "Boundaries"}</dt>
        <dd className="break-words">{blueprint.charter?.[field]?.join(" · ") || "None specified"}</dd></div>)}
        <div><dt className="font-medium">Risk notes</dt><dd className="break-words">{blueprint.riskNotes?.join(" · ") || "None specified"}</dd></div></dl></details>
  </div>;
}

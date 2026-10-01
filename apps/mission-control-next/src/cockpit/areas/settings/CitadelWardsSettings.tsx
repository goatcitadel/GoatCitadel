import { useId } from "react";
import { useCitadelWards } from "../../../features/native-routes/library/use-citadel-wards";
import { WARD_EFFECT_META, WARD_EFFECTS } from "../../../features/native-routes/library/citadel-ward-model";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { CitadelAccessReview } from "./CitadelAccessReview";

export function CitadelWardsSettings({ citadelId }: { citadelId: string }) {
  const c = useCitadelWards(citadelId),
    nameId = useId(),
    patternId = useId(),
    probeId = useId();
  const leave = useDraftLeaveDialogState(c.leave.dialogProps),
    review = c.pendingAddWard;
  const notice = (
    <>
      {c.access.error ? (
        <p role="alert" className="break-words text-sm text-status-waiting">
          {c.access.error}
        </p>
      ) : null}
      {c.draftError ? (
        <p role="alert" className="text-sm text-status-waiting">
          {c.draftError}
        </p>
      ) : null}
    </>
  );
  return (
    <section id="citadel-wards" aria-label="Citadel Wards" className="mt-4 space-y-4 border-t border-line-subtle pt-4">
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Wards</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Access policy for this Citadel. Deny wins when several Wards match. Testing evaluates policy without executing
          the action.
        </p>
        <p className="break-all text-xs text-fg-muted">Citadel: {citadelId}</p>
      </header>
      {c.access.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading access rules…
        </p>
      ) : null}
      {notice}
      {c.access.reviewRequired && c.view !== "new" ? (
        <CitadelAccessReview snapshot={c.access.snapshot} onAccept={c.access.acceptReview} />
      ) : null}
      {c.access.snapshot?.structure.record?.lifecycleStatus === "archived" ? (
        <p role="status" className="text-sm text-status-waiting">
          Restore this Citadel before changing access rules.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => c.leave.request(() => c.setView("new"), [c.wardDraft.key])}>
          Add Ward{c.wardDraft.isDirty ? " · Unsaved" : ""}
        </Button>
        <Button onClick={() => c.leave.request(() => c.setView("test"), [c.wardDraft.key])}>Test an action</Button>
        <Button disabled={c.access.loading || c.access.busy} onClick={() => void c.access.reload()}>
          Refresh rules
        </Button>
      </div>
      <ul aria-label="Configured Wards" className="max-h-96 space-y-2 overflow-y-auto">
        {c.wards.items.map((ward) => (
          <li key={ward.wardId} className="rounded-md border border-line-subtle bg-sunken p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="break-words font-medium text-fg">{ward.name}</h4>
                <p className="break-words text-sm text-fg-secondary">
                  {ward.actionPattern} · {WARD_EFFECT_META[ward.effect].label}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() =>
                  c.leave.request(() => {
                    c.setSelectedWardId(ward.wardId);
                    c.setView("rule");
                  }, [c.wardDraft.key])
                }
              >
                Inspect {ward.name}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!c.wards.items.length && !c.access.loading ? (
        <p className="text-sm text-fg-muted">No Wards. The Gatehouse default posture applies.</p>
      ) : null}
      <Dialog
        open={c.view === "new"}
        title="Add a Ward"
        description="Review the exact rule before changing access policy."
        onOpenChange={(open) => {
          if (!open) c.leave.request(() => c.setView(null), [c.wardDraft.key]);
        }}
      >
        <div className="space-y-3">
          {notice}
          {c.wardDraft.hasRemoteChanges || c.access.reviewRequired ? (
            <CitadelAccessReview
              snapshot={c.access.snapshot}
              onAccept={() => {
                c.wardDraft.rebaseToCurrent();
                c.access.acceptReview();
              }}
            />
          ) : null}
          <label htmlFor={nameId} className="block text-sm text-fg-secondary">
            Name
            <input
              id={nameId}
              value={c.draft.name}
              disabled={c.access.locked}
              className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-fg"
              onChange={(e) => c.setDraft((draft) => ({ ...draft, name: e.target.value }))}
            />
          </label>
          <label htmlFor={patternId} className="block text-sm text-fg-secondary">
            Action pattern
            <input
              id={patternId}
              value={c.draft.actionPattern}
              disabled={c.access.locked}
              placeholder="shell.*"
              className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-fg"
              onChange={(e) => c.setDraft((draft) => ({ ...draft, actionPattern: e.target.value }))}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-fg">Effect</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {WARD_EFFECTS.map((effect) => (
                <button
                  type="button"
                  key={effect}
                  disabled={c.access.locked}
                  aria-pressed={c.draft.effect === effect}
                  className="rounded-md border border-line bg-sunken p-3 text-left text-sm text-fg-secondary aria-pressed:border-accent aria-pressed:text-fg"
                  onClick={() => c.setDraft((draft) => ({ ...draft, effect }))}
                >
                  <strong className="block">{WARD_EFFECT_META[effect].label}</strong>
                  <span>{WARD_EFFECT_META[effect].detail}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Button
            disabled={
              !c.access.ready || c.wardDraft.hasRemoteChanges || !c.draft.name.trim() || !c.draft.actionPattern.trim()
            }
            onClick={c.requestAddWard}
          >
            Review Ward
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(review)}
        title="Add this Ward?"
        description="The Gateway checks the reviewed revision before saving. Deny-wins policy remains authoritative."
        onOpenChange={(open) => {
          if (!open && !c.access.busy) c.cancelAddReview();
        }}
      >
        <dl className="space-y-2 break-words text-sm text-fg-secondary">
          <dt>Name</dt>
          <dd>{review?.input.name}</dd>
          <dt>Action pattern</dt>
          <dd>{review?.input.actionPattern}</dd>
          <dt>Effect</dt>
          <dd>{review ? WARD_EFFECT_META[review.input.effect].label : ""}</dd>
          <dt>Citadel</dt>
          <dd>{citadelId}</dd>
          <dt>Reviewed revision</dt>
          <dd className="break-all font-mono text-xs">{review?.before.revision}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={c.access.locked} onClick={() => void c.addWard()}>
            Confirm add Ward
          </Button>
          <Button disabled={c.access.busy} onClick={c.cancelAddReview}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={c.view === "rule" && Boolean(c.selectedWard)}
        title={c.selectedWard?.name ?? "Ward"}
        description="A saved policy rule. Inspecting it does not execute an action."
        onOpenChange={(open) => {
          if (!open) c.setView(null);
        }}
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          {notice}
          <p className="break-words">{c.selectedWard?.actionPattern}</p>
          <p>{c.selectedWard ? WARD_EFFECT_META[c.selectedWard.effect].detail : ""}</p>
          <Button
            variant="danger"
            disabled={!c.access.ready}
            onClick={() => {
              if (c.selectedWard && c.access.snapshot)
                c.setPendingDeleteWard({ ward: c.selectedWard, revision: c.access.snapshot.revision });
            }}
          >
            Delete Ward
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(c.pendingDeleteWard)}
        title="Delete this Ward?"
        description="The rule will stop governing matching actions. This cannot be undone."
        onOpenChange={(open) => {
          if (!open && !c.access.busy) c.setPendingDeleteWard(null);
        }}
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          <p className="break-words">
            {c.pendingDeleteWard?.ward.name} · {c.pendingDeleteWard?.ward.actionPattern}
          </p>
          <p className="break-all font-mono text-xs">Reviewed revision: {c.pendingDeleteWard?.revision}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={c.access.locked} onClick={() => void c.deleteWard()}>
              Confirm delete Ward
            </Button>
            <Button disabled={c.access.busy} onClick={() => c.setPendingDeleteWard(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={c.view === "test"}
        title="Test an action"
        description="Evaluate the current Gatehouse policy. No action is executed."
        onOpenChange={(open) => {
          if (!open) c.setView(null);
        }}
      >
        <div className="space-y-3">
          <label htmlFor={probeId} className="block text-sm text-fg-secondary">
            Action
            <input
              id={probeId}
              value={c.probe}
              placeholder="shell.run"
              className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-fg"
              onChange={(e) => c.setProbe(e.target.value)}
            />
          </label>
          <Button disabled={c.probeBusy || !c.probe.trim()} onClick={() => void c.evaluate()}>
            {c.probeBusy ? "Evaluating…" : "Evaluate"}
          </Button>
          {c.probeError ? (
            <p role="alert" className="text-sm text-status-waiting">
              {c.probeError}
            </p>
          ) : null}
          {c.probeResult ? (
            <p role="status" className="break-words text-sm text-fg">
              {c.probeResult.action} → {WARD_EFFECT_META[c.probeResult.effect].label}
            </p>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={c.leave.dialogProps.open}
        title="Unsaved Ward draft"
        description={leave.description}
        onOpenChange={(open) => {
          if (!open) c.leave.dialogProps.onCancel();
        }}
      >
        <div className="flex flex-wrap gap-2">
          {leave.canKeep ? <Button onClick={c.leave.dialogProps.onContinue}>Keep draft and close</Button> : null}
          <Button variant="danger" onClick={leave.discard}>
            Discard changes
          </Button>
          <Button onClick={c.leave.dialogProps.onCancel}>Cancel</Button>
        </div>
      </Dialog>
    </section>
  );
}

import { useCitadelWards } from "./use-citadel-wards";
import { CitadelAccessReview } from "./CitadelAccessReview";
import "./citadel-confirmation.css";
import { useId } from "react";
import { ShieldAlert, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { WARD_EFFECTS, WARD_EFFECT_META } from "./citadel-ward-model";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../primitives";

import { DetailInspector } from "../../../components/DetailInspector";


import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";



/**
 * The Gatehouse Wards editor (spec §20.3 / §11.3). Wards are evaluated deny-wins:
 * the most restrictive matching effect governs an action. This surface lists the
 * Citadel's Wards, adds new ones, and lets the operator test an action against them.
 */
export function CitadelWardsRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const nameId = useId();
  const patternId = useId();
  const effectId = useId();
  const probeId = useId();
  const control = useCitadelWards(activeCitadelId);
  const { access, wards, view, setView, draftError, probeError, leave, wardDraft, draft, setDraft, probe, setProbe, probeResult, selectedWard, setSelectedWardId, pendingDeleteWard, setPendingDeleteWard, deleteWard, evaluate } = control;
  const busy = access.busy, deleteBusy = access.busy;

  return (
    <NativePageFrame
      icon={ShieldCheck}
      area="library"
      kicker={routeKicker(route)}
      title="Wards"
      description={`Access policy for ${activeCitadelName}. Wards are evaluated deny-wins; the most restrictive matching effect governs an action.`}
      loading={wards.loading && !wards.items.length && !access.reviewRequired}
      error={!access.snapshot && !access.reviewRequired ? wards.error : null}
    >
      {access.error && view !== "new" && (!access.reviewRequired || !access.snapshot) ? <NoticeBanner tone="error" message={access.error} /> : null}
      {access.reviewRequired && view !== "new" ? <CitadelAccessReview snapshot={access.snapshot} onAccept={access.acceptReview} /> : null}
      {access.snapshot?.structure.record?.lifecycleStatus === "archived" ? <NoticeBanner tone="warning" message="Restore this Citadel before changing access rules." /> : null}
      <div className="mc-next-settings-button-row">
        <NativeButton onClick={() => leave.request(() => setView("new"), [wardDraft.key])}>Add Ward{wardDraft.isDirty ? " · Unsaved" : ""}</NativeButton>
        <NativeButton variant="outline" onClick={() => leave.request(() => setView("test"), [wardDraft.key])}>Test an action</NativeButton>
      </div>
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Active Wards"
          subtitle="Each Ward matches an action pattern (use * as a wildcard) and applies an effect."
          density="compact"
          stats={[{ label: "Wards", value: String(wards.items.length) }]}
        >
          {wards.items.length > 0 ? (
            <div className="mc-next-ward-directory" role="group" aria-label="Configured Wards">
              {wards.items.map((ward) => (
                <button
                  key={ward.wardId}
                  type="button"
                  className={selectedWard?.wardId === ward.wardId ? "active" : undefined}
                  aria-pressed={selectedWard?.wardId === ward.wardId}
                  onClick={() => leave.request(() => { setSelectedWardId(ward.wardId); setView("rule"); }, [wardDraft.key])}
                >
                  <span>
                    <strong>{ward.name}</strong>
                    <small>{ward.actionPattern}</small>
                  </span>
                  <em>{WARD_EFFECT_META[ward.effect].label}</em>
                </button>
              ))}
            </div>
          ) : (
            <p className="mc-next-ward-empty">No Wards yet — the Gatehouse default posture applies.</p>
          )}
          {selectedWard ? (
            <DetailInspector open={view === "rule"} title={selectedWard.name} onClose={() => setView(null)}>
              <div>
                <span>Selected Ward</span>
                <strong>{selectedWard.name}</strong>
                <p>{WARD_EFFECT_META[selectedWard.effect].detail}</p>
              </div>
              <dl>
                <div>
                  <dt>Pattern</dt>
                  <dd>{selectedWard.actionPattern}</dd>
                </div>
                <div>
                  <dt>Effect</dt>
                  <dd>{WARD_EFFECT_META[selectedWard.effect].label}</dd>
                </div>
              </dl>
              <NativeButton variant="destructive" disabled={!access.ready} onClick={() => { if (access.snapshot) setPendingDeleteWard({ ward: selectedWard, revision: access.snapshot.revision }); }}>
                <Trash2 size={16} />
                Delete Ward
              </NativeButton>
            </DetailInspector>
          ) : null}
        </NativeCard>

        <div className="mc-next-native-stack mc-next-citadel-ward-tools">
          <DetailInspector open={view === "new"} title="Add a Ward" onClose={() => leave.request(() => setView(null), [wardDraft.key])}>
            {access.error && (!access.reviewRequired || !access.snapshot) ? <NoticeBanner tone="error" message={access.error} /> : null}
            {wardDraft.hasRemoteChanges || access.reviewRequired ? <CitadelAccessReview snapshot={access.snapshot} onAccept={() => { wardDraft.rebaseToCurrent(); access.acceptReview(); }} /> : null}
            {draftError ? <NoticeBanner tone="error" message={draftError} /> : null}
            <label className="mc-next-mason-field" htmlFor={nameId}>
              <span>Name</span>
              <input
                id={nameId}
                className="mc-next-settings-input"
                value={draft.name}
                placeholder="Block destructive shell"
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="mc-next-mason-field" htmlFor={patternId}>
              <span>Action pattern</span>
              <input
                id={patternId}
                className="mc-next-settings-input"
                value={draft.actionPattern}
                placeholder="shell.*"
                onChange={(event) => setDraft((current) => ({ ...current, actionPattern: event.target.value }))}
              />
            </label>
            <fieldset className="mc-next-ward-effect-picker" aria-describedby={`${effectId}-hint`}>
              <legend>Effect</legend>
              <p id={`${effectId}-hint`}>Choose the exact enforcement posture for matching actions.</p>
              <div>
                {WARD_EFFECTS.map((effect) => (
                  <button
                    key={effect}
                    type="button"
                    className={draft.effect === effect ? "active" : undefined}
                    aria-pressed={draft.effect === effect}
                    onClick={() => setDraft((current) => ({ ...current, effect }))}
                  >
                    <strong>{WARD_EFFECT_META[effect].label}</strong>
                    <span>{WARD_EFFECT_META[effect].detail}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <NativeButton
              variant="default"
              disabled={busy || !access.ready || wardDraft.hasRemoteChanges || draft.name.trim().length === 0 || draft.actionPattern.trim().length === 0}
              onClick={control.requestAddWard}
            >
              <ShieldAlert size={16} />
              {busy ? "Adding…" : "Add Ward"}
            </NativeButton>
          </DetailInspector>

          <DetailInspector open={view === "test"} title="Test an action" onClose={() => leave.request(() => setView(null), [wardDraft.key])}>
            <label className="mc-next-mason-field" htmlFor={probeId}>
              <span>Action</span>
              <input
                id={probeId}
                className="mc-next-settings-input"
                value={probe}
                placeholder="shell.run"
                onChange={(event) => setProbe(event.target.value)}
              />
            </label>
            <NativeButton variant="default" disabled={control.probeBusy || probe.trim().length === 0} onClick={() => void evaluate()}>
              <Sparkles size={16} />
              Evaluate
            </NativeButton>
            {probeError ? <NoticeBanner tone="error" message={probeError} /> : null}
            {probeResult ? (
              <p className="mc-next-ward-result">
                <strong>{probeResult.action}</strong> → {probeResult.effect}
              </p>
            ) : null}
          </DetailInspector>
        </div>
      </NativeGrid>
      {leave.dialog}
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={Boolean(control.pendingAddWard)}
        title="Add this Ward?"
        message={`${control.pendingAddWard?.input.name} will govern ${control.pendingAddWard?.input.actionPattern} with ${control.pendingAddWard ? WARD_EFFECT_META[control.pendingAddWard.input.effect].label : "the reviewed effect"}. Deny-wins policy remains authoritative.`}
        confirmLabel={busy ? "Adding…" : "Confirm add Ward"}
        pending={busy} cancelDisabled={busy} disableDismiss={busy}
        onCancel={control.cancelAddReview} onConfirm={() => void control.addWard()}
      />
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={Boolean(pendingDeleteWard)}
        title="Delete this Ward?"
        message={
          pendingDeleteWard
            ? `${pendingDeleteWard.ward.name} will stop governing ${pendingDeleteWard.ward.actionPattern}. This cannot be undone.`
            : "This Ward will be deleted."
        }
        confirmLabel={deleteBusy ? "Deleting…" : "Confirm delete Ward"}
        danger
        pending={deleteBusy}
        cancelDisabled={deleteBusy}
        disableDismiss={deleteBusy}
        onCancel={() => setPendingDeleteWard(null)}
        onConfirm={() => void deleteWard()}
      />
    </NativePageFrame>
  );
}

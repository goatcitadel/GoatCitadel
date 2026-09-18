import { useCitadelAccessReview } from "./useCitadelAccessReview";
import { CitadelAccessReview } from "./CitadelAccessReview";
import "./citadel-confirmation.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { CitadelWardRecord, WardEffect } from "@goatcitadel/contracts";
import {
  addCitadelWard,
  evaluateCitadelGatehouseAction,
  removeCitadelWard,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { DetailInspector } from "../../../components/DetailInspector";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

const WARD_EFFECTS: WardEffect[] = ["allow", "deny", "require_approval", "require_dry_run", "redact", "route_local"];

const WARD_EFFECT_META: Record<WardEffect, { label: string; detail: string }> = {
  allow: { label: "Allow", detail: "Permit the matching action unless a stricter Ward also matches." },
  deny: { label: "Deny", detail: "Block the matching action. Deny always wins." },
  require_approval: { label: "Require approval", detail: "Pause for an operator decision before execution." },
  require_dry_run: { label: "Require dry run", detail: "Require a non-mutating preview before execution." },
  redact: { label: "Redact", detail: "Apply redaction to matching action data." },
  route_local: { label: "Route local", detail: "Keep matching model work on a local route." },
};

const EMPTY_WARD = { name: "", actionPattern: "", effect: "deny" as WardEffect };

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
  const access = useCitadelAccessReview(activeCitadelId);
  const wards = { loading: access.loading, error: access.error, items: access.snapshot?.wards ?? [] };
  const [view, setView] = useState<"new" | "test" | "rule" | null>(null);
  const busy = access.busy;
  const [draftError, setDraftError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const leave = useDraftLeave();
  const wardDraft = useSessionDraft(`ward:${activeCitadelId}:new`, EMPTY_WARD, access.snapshot?.revision, { label: "New Ward", available: Boolean(access.snapshot), active: view === "new", onSave: (): Promise<boolean> => addWard() });
  const draft = wardDraft.value;
  const setDraft = wardDraft.setValue;
  const acceptSavedWard = wardDraft.acceptSaved;
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<{ action: string; effect: string } | null>(null);
  const [selectedWardId, setSelectedWardId] = useState<string | null>(null);
  const [pendingDeleteWard, setPendingDeleteWard] = useState<{ ward: CitadelWardRecord; revision: string } | null>(null);
  const deleteBusy = access.busy;
  const selectedWard = useMemo(
    () => wards.items.find((ward) => ward.wardId === selectedWardId) ?? null,
    [selectedWardId, wards.items],
  );

  useEffect(() => {
    setPendingDeleteWard(null); setSelectedWardId(null); setView(null);
    setDraftError(null); setProbeError(null); setProbeResult(null);
  }, [activeCitadelId]);

  const addWard = async () => {
    const expectedRevision = wardDraft.baseRevision;
    if (!access.ready || wardDraft.hasRemoteChanges || typeof expectedRevision !== "string" || !draft.name.trim() || !draft.actionPattern.trim()) return false;
    setDraftError(null);
    const saved = await access.run(expectedRevision, () => addCitadelWard(activeCitadelId, {
      name: draft.name.trim(), actionPattern: draft.actionPattern.trim(), effect: draft.effect, expectedRevision,
    }));
    if (!saved) return false;
    setSelectedWardId(saved.wards.find((item) => !wards.items.some((before) => before.wardId === item.wardId))?.wardId ?? null);
    if (acceptSavedWard(EMPTY_WARD, saved.revision, draft)) setView("rule");
    return true;
  };

  const deleteWard = async () => {
    if (!pendingDeleteWard || pendingDeleteWard.ward.citadelId !== activeCitadelId) return;
    const saved = await access.run(pendingDeleteWard.revision, () => removeCitadelWard(activeCitadelId, pendingDeleteWard.ward.wardId, pendingDeleteWard.revision));
    if (!access.isCurrent()) return;
    setPendingDeleteWard(null);
    setView(null);
    if (saved) setSelectedWardId(null);
  };

  const evaluate = useCallback(async () => {
    const action = probe.trim();
    if (action.length === 0) {
      return;
    }
    setProbeError(null); setProbeResult(null);
    try {
      const result = await evaluateCitadelGatehouseAction(activeCitadelId, action);
      if (access.isCurrent()) setProbeResult(result);
    } catch (error) {
      if (access.isCurrent()) setProbeError(getErrorMessage(error));
    }
  }, [activeCitadelId, probe, access]);

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
              onClick={() => void addWard()}
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
            <NativeButton variant="default" disabled={probe.trim().length === 0} onClick={() => void evaluate()}>
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

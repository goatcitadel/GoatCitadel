import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { CitadelWardRecord, WardEffect } from "@goatcitadel/contracts";
import {
  addCitadelWard,
  evaluateCitadelGatehouseAction,
  listCitadelWards,
  removeCitadelWard,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
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

interface WardsState {
  loading: boolean;
  error: string | null;
  items: CitadelWardRecord[];
}

interface DraftState {
  name: string;
  actionPattern: string;
  effect: WardEffect;
  busy: boolean;
  error: string | null;
}

const INITIAL_DRAFT: DraftState = { name: "", actionPattern: "", effect: "deny", busy: false, error: null };

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
  const [wards, setWards] = useState<WardsState>({ loading: true, error: null, items: [] });
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<{ action: string; effect: string } | null>(null);
  const [selectedWardId, setSelectedWardId] = useState<string | null>(null);
  const [pendingDeleteWard, setPendingDeleteWard] = useState<CitadelWardRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const selectedWard = useMemo(
    () => wards.items.find((ward) => ward.wardId === selectedWardId) ?? wards.items[0] ?? null,
    [selectedWardId, wards.items],
  );

  useEffect(() => {
    let cancelled = false;
    setWards((current) => ({ ...current, loading: true, error: null }));
    void listCitadelWards(activeCitadelId)
      .then((items) => {
        if (!cancelled) {
          setWards({ loading: false, error: null, items });
          setSelectedWardId((current) =>
            current && items.some((ward) => ward.wardId === current) ? current : (items[0]?.wardId ?? null),
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWards({ loading: false, error: getErrorMessage(error), items: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCitadelId]);

  const addWard = useCallback(async () => {
    if (draft.name.trim().length === 0 || draft.actionPattern.trim().length === 0) {
      return;
    }
    setDraft((current) => ({ ...current, busy: true, error: null }));
    try {
      const record = await addCitadelWard(activeCitadelId, {
        name: draft.name.trim(),
        actionPattern: draft.actionPattern.trim(),
        effect: draft.effect,
      });
      setWards((current) => ({ ...current, items: [...current.items, record] }));
      setSelectedWardId(record.wardId);
      setDraft(INITIAL_DRAFT);
    } catch (error) {
      setDraft((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, [activeCitadelId, draft.actionPattern, draft.effect, draft.name]);

  const deleteWard = useCallback(async () => {
    if (!pendingDeleteWard) {
      return;
    }
    setDeleteBusy(true);
    try {
      await removeCitadelWard(activeCitadelId, pendingDeleteWard.wardId);
      setWards((current) => ({
        ...current,
        items: current.items.filter((ward) => ward.wardId !== pendingDeleteWard.wardId),
      }));
      setSelectedWardId(null);
      setPendingDeleteWard(null);
    } catch (error) {
      setWards((current) => ({ ...current, error: getErrorMessage(error) }));
    } finally {
      setDeleteBusy(false);
    }
  }, [activeCitadelId, pendingDeleteWard]);

  const evaluate = useCallback(async () => {
    const action = probe.trim();
    if (action.length === 0) {
      return;
    }
    try {
      const result = await evaluateCitadelGatehouseAction(activeCitadelId, action);
      setProbeResult(result);
    } catch (error) {
      setProbeResult({ action, effect: getErrorMessage(error) });
    }
  }, [activeCitadelId, probe]);

  return (
    <NativePageFrame
      icon={ShieldCheck}
      area="library"
      kicker={routeKicker(route)}
      title="Wards"
      description={`Access policy for ${activeCitadelName}. Wards are evaluated deny-wins; the most restrictive matching effect governs an action.`}
      loading={wards.loading}
      error={wards.error}
    >
      <NativeGrid className="mc-next-native-work-pair mc-next-citadel-wards-grid">
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
                  onClick={() => setSelectedWardId(ward.wardId)}
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
            <section className="mc-next-ward-detail" aria-label={`${selectedWard.name} Ward detail`}>
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
              <NativeButton variant="destructive" onClick={() => setPendingDeleteWard(selectedWard)}>
                <Trash2 size={16} />
                Delete Ward
              </NativeButton>
            </section>
          ) : null}
        </NativeCard>

        <div className="mc-next-native-stack mc-next-citadel-ward-tools">
          <NativeCard
            title="Add a Ward"
            subtitle="Define a pattern and the effect it should enforce."
            density="compact"
          >
            {draft.error ? <NoticeBanner tone="error" message={draft.error} /> : null}
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
              disabled={draft.busy || draft.name.trim().length === 0 || draft.actionPattern.trim().length === 0}
              onClick={() => void addWard()}
            >
              <ShieldAlert size={16} />
              {draft.busy ? "Adding…" : "Add Ward"}
            </NativeButton>
          </NativeCard>

          <NativeCard
            title="Test an action"
            subtitle="See which effect the current Wards would apply."
            density="compact"
          >
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
            {probeResult ? (
              <p className="mc-next-ward-result">
                <strong>{probeResult.action}</strong> → {probeResult.effect}
              </p>
            ) : null}
          </NativeCard>
        </div>
      </NativeGrid>
      <ConfirmModal
        open={Boolean(pendingDeleteWard)}
        title="Delete this Ward?"
        message={
          pendingDeleteWard
            ? `${pendingDeleteWard.name} will stop governing ${pendingDeleteWard.actionPattern}. This cannot be undone.`
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

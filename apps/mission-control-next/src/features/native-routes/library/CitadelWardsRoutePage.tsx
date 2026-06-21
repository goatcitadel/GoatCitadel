import { useCallback, useEffect, useId, useState } from "react";
import { ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import type { CitadelWardRecord, WardEffect } from "@goatcitadel/contracts";
import {
  addCitadelWard,
  evaluateCitadelGatehouseAction,
  listCitadelWards,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

const WARD_EFFECTS: WardEffect[] = ["allow", "deny", "require_approval", "require_dry_run", "redact", "route_local"];

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

  useEffect(() => {
    let cancelled = false;
    setWards((current) => ({ ...current, loading: true, error: null }));
    void listCitadelWards(activeCitadelId)
      .then((items) => {
        if (!cancelled) {
          setWards({ loading: false, error: null, items });
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
      setDraft(INITIAL_DRAFT);
    } catch (error) {
      setDraft((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, [activeCitadelId, draft.actionPattern, draft.effect, draft.name]);

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
          <NativeList
            items={wards.items.map((ward) => ({
              title: ward.name,
              meta: ward.effect,
              body: ward.actionPattern,
            }))}
            emptyLabel="No Wards yet — the Gatehouse default posture applies."
            density="compact"
          />
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
            <label className="mc-next-mason-field" htmlFor={effectId}>
              <span>Effect</span>
              <select
                id={effectId}
                className="mc-next-settings-input"
                value={draft.effect}
                onChange={(event) => setDraft((current) => ({ ...current, effect: event.target.value as WardEffect }))}
              >
                {WARD_EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    {effect}
                  </option>
                ))}
              </select>
            </label>
            <NativeButton
              variant="default"
              disabled={draft.busy || draft.name.trim().length === 0 || draft.actionPattern.trim().length === 0}
              onClick={() => void addWard()}
            >
              <ShieldAlert className="h-4 w-4" />
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
              <Sparkles className="h-4 w-4" />
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
    </NativePageFrame>
  );
}

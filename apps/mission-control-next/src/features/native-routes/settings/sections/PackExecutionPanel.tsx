import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityPackManifest, ChangePlanRecord } from "@goatcitadel/contracts";
import {
  createChangePlan,
  fetchChangePlan,
  fetchChangePlans,
  verifyChangePlan,
} from "@goatcitadel/mission-control-shared/api/client";
import { OwnedChangePlanList } from "@goatcitadel/mission-control-shared/components/chat/OwnedChangePlanList";
import { useSessionDraft } from "../../library/session-drafts";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import type { SettingsSectionProps } from "../SettingsShared";
import "../../../threaded-surface/styles/change-plans.css";
import "./PackExecutionPanel.css";

export function PackExecutionPanel({
  manifest,
  workspaceId,
  navigate,
  route,
}: {
  manifest: CapabilityPackManifest;
  workspaceId: string;
  navigate: SettingsSectionProps["navigate"];
  route: SettingsSectionProps["route"];
}) {
  const setupDraft = useSessionDraft("pack-setup:" + workspaceId + ":" + manifest.packId, manifest.assets.filter(asset => asset.binding && asset.id).map(asset => asset.id), manifest.provenance.contentHash, { label: manifest.name || "Pack setup", onSave: () => reviewSetup() });
  const { value: selected, setValue: setSelected } = setupDraft;
  const ownerKey = `${workspaceId}:${manifest.packId}:${manifest.provenance.contentHash ?? "unavailable"}`;
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const alive = useRef(true);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const [plans, setPlans] = useState<ChangePlanRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    async (verify = false) => {
      const currentGeneration = ++generation.current;
      const result = await fetchChangePlans({ workspaceId }, { limit: 200 });
      let parents = result.items.filter(
        (plan) => plan.request.kind === "capability_pack" && plan.request.packId === manifest.packId,
      );
      if (verify) {
        parents = await Promise.all(
          parents.map((plan) =>
            plan.status === "monitoring" ? verifyChangePlan(plan.planId, { workspaceId }, plan.revision) : plan,
          ),
        );
      }
      const childIds = [
        ...new Set(
          parents.flatMap((plan) =>
            plan.evidenceRefs.filter((ref) => ref.startsWith("change_plan:")).map((ref) => ref.slice(12)),
          ),
        ),
      ];
      const children = await Promise.all(childIds.map((id) => fetchChangePlan(id, { workspaceId })));
      if (alive.current && currentGeneration === generation.current) setPlans([...parents, ...children]);
    },
    [workspaceId, manifest.packId],
  );
  useEffect(() => {
    alive.current = true;
    busyRef.current = false;
    setBusy(false);
    setPlans([]);
    setError(null);
    let cancelled = false;
    void refresh().catch((failure) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : "Pack executions could not be loaded.");
    });
      return () => {
      cancelled = true; alive.current = false; generation.current += 1;
    };
  }, [refresh, ownerKey]);
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    const operationOwner = ownerRef.current;
    busyRef.current = true; setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (alive.current && ownerRef.current === operationOwner)
        setError(failure instanceof Error ? failure.message : "Pack execution failed.");
    } finally {
      if (ownerRef.current === operationOwner) {
        busyRef.current = false; if (alive.current) setBusy(false);
      }
    }
  };
  async function reviewSetup(): Promise<boolean> {
    if (busyRef.current || setupDraft.hasRemoteChanges || !selected.length || !manifest.provenance.contentHash) return false;
    const submitted = selected;
    const submittedOwner = ownerRef.current;
    let saved = false;
    await run(async () => {
      generation.current += 1;
      const plan = await createChangePlan({ workspaceId, surface: "settings", request: { kind: "capability_pack", packId: manifest.packId, manifestHash: manifest.provenance.contentHash!, assetIds: submitted } });
      if (alive.current && ownerRef.current === submittedOwner) {
        generation.current += 1;
        saved = setupDraft.acceptSaved(submitted, manifest.provenance.contentHash, submitted);
        setPlans(current => [plan, ...current.filter(item => item.planId !== plan.planId)]);
      }
    });
    return saved;
  }
  return (
    <section aria-label="Pack execution" className="mc-next-pack-execution">
      <p>
        Choose assets to set up. Each asset keeps its own approval and runtime checks. Policy-default labels in the
        portable preview are advisory.
      </p>
      {setupDraft.hasRemoteChanges ? <p role="alert">This manifest changed while assets were selected. Review its current verified bytes, then choose assets again. <NativeButton variant="secondary" onClick={setupDraft.discard}>Use current manifest</NativeButton></p> : null}
      <NativeDisclosureCard id="pack-verified-manifest" title="Verified manifest"><dl><dt>Pack</dt><dd>{manifest.packId}</dd><dt>Version</dt><dd>{manifest.version}</dd><dt>Publisher</dt><dd>{manifest.provenance.publisher}</dd><dt>Content hash</dt><dd>{manifest.provenance.contentHash || "Unavailable: execution disabled"}</dd></dl></NativeDisclosureCard>
      {manifest.assets.map((asset, index) => (
        <label key={asset.id ?? "unavailable-asset-" + index} className="mc-next-settings-checkbox mc-next-pack-asset">
          <input
            type="checkbox"
            checked={selected.includes(asset.id)}
            disabled={!asset.id || !asset.binding || busy || setupDraft.hasRemoteChanges}
            onChange={(event) =>
              setSelected((values) =>
                event.target.checked ? [...values, asset.id] : values.filter((id) => id !== asset.id),
              )
            }
          />
          {asset.label}
          {!asset.binding ? " — execution unavailable" : ""}
        </label>
      ))}
      <NativeButton
        type="button"
        disabled={busy || !selected.length || !manifest.provenance.contentHash || setupDraft.hasRemoteChanges}
        onClick={() => void reviewSetup()}
      >
        Review setup
      </NativeButton>
      <NativeButton type="button" variant="secondary" disabled={busy} onClick={() => void run(() => refresh(true))}>
        Refresh execution status
      </NativeButton>
      {error ? <p role="alert">{error}</p> : null}
      <OwnedChangePlanList
        plans={plans}
        onUpdated={(plan) => {
          setPlans((current) => current.map((item) => (item.planId === plan.planId ? plan : item)));
          void run(() => refresh(true));
        }}
        onOpenApproval={(approvalId) => navigate({ area: "ops", section: "approvals", approvalId, theme: route.theme })}
      />
    </section>
  );
}

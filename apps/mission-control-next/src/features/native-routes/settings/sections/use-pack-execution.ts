import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type CapabilityPackManifest, type ChangePlanRecord } from "@goatcitadel/contracts";
import {
  createChangePlan,
  fetchCapabilityPackPreview,
  fetchChangePlan,
  fetchChangePlans,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../library/session-drafts";
import { beginPackAttempt, usePackAttempt } from "./pack-mutation-state";
import {
  requireCreatedPackPlan,
  samePackPlan,
  setupRequest,
  validParentPackPlan,
  validWorkspacePlan,
} from "./pack-plan-binding";

export function usePackExecution(manifest: CapabilityPackManifest, workspaceId: string) {
  const base = getGatewayApiBaseUrl(),
    key = JSON.stringify(["pack-setup", base, workspaceId, manifest.packId]);
  const identity = canonicalJsonString([key, manifest]);
  const live = useRef({ identity, epoch: 0, mounted: true, read: 0 });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch++;
    live.current.read++;
  }
  const epoch = live.current.epoch;
  const current = useCallback(
    () => live.current.mounted && live.current.identity === identity && getGatewayApiBaseUrl() === base,
    [base, identity],
  );
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
      owner.read++;
    };
  }, [identity]);
  const draft = useSessionDraft(
    key,
    manifest.assets.filter((asset) => asset.binding && asset.id).map((asset) => asset.id),
    manifest.provenance.contentHash,
    { label: `${manifest.name} setup` },
  );
  const attempt = usePackAttempt(key);
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    parents: ChangePlanRecord[];
    children: ChangePlanRecord[];
  }>({ identity, parents: [], children: [] });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ manifest: CapabilityPackManifest; selected: string[]; epoch: number } | null>(
    null,
  );
  const refresh = useCallback(async () => {
    const readId = ++live.current.read;
    live.current.epoch++;
    setReview(null);
    setLoading(true);
    setError(null);
    try {
      const response = await fetchChangePlans({ workspaceId }, { limit: 200 });
      if (!current() || readId !== live.current.read) return;
      if (!Array.isArray(response.items) || response.items.some((plan) => plan.origin.workspaceId !== workspaceId))
        throw new Error("Foreign plan scope.");
      const parents = response.items.filter((plan) => validParentPackPlan(plan, manifest, workspaceId)).slice(0, 20);
      const childIds = [
        ...new Set(
          parents.flatMap((plan) =>
            plan.evidenceRefs.filter((ref) => ref.startsWith("change_plan:")).map((ref) => ref.slice(12)),
          ),
        ),
      ].slice(0, 64);
      const children = await Promise.all(
        childIds.map(async (id) => {
          const child = await fetchChangePlan(id, { workspaceId });
          if (
            child.planId !== id ||
            !validWorkspacePlan(child, workspaceId) ||
            !["capability_candidate", "runtime_configuration"].includes(child.kind)
          )
            throw new Error("Linked child plan binding is unavailable.");
          return child;
        }),
      );
      if (current() && readId === live.current.read) setSnapshot({ identity, parents, children });
    } catch {
      if (current() && readId === live.current.read)
        setError(
          "Pack plans or their exact linked children could not be read. Previously displayed records are withheld.",
        );
    } finally {
      if (current() && readId === live.current.read) setLoading(false);
    }
  }, [current, identity, manifest, workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const request = setupRequest(manifest, draft.value),
    locked = attempt.phase !== "idle";
  const ready = Boolean(
    current() && request && !draft.hasRemoteChanges && !locked && !loading && !error && workspaceId.trim(),
  );
  function setSelected(next: string[]) {
    if (!current()) return;
    live.current.epoch++;
    setReview(null);
    draft.setValue(next);
  }
  async function confirmSetup() {
    if (!review || !ready || !current() || review.epoch !== live.current.epoch) return false;
    const submittedReview = review;
    const command = setupRequest(submittedReview.manifest, submittedReview.selected);
    if (!command) return false;
    const operation = beginPackAttempt(key);
    if (!operation) return false;
    const captured = review.epoch,
      submitted = [...review.selected];
    const valid = () => current() && live.current.epoch === captured;
    try {
      const fresh = await fetchCapabilityPackPreview(manifest.packId);
      if (!valid()) return false;
      if (!samePackPlan(fresh.manifest, submittedReview.manifest))
        throw new Error("Pack manifest changed. Refresh its preview before setup.");
      const prior = await fetchChangePlans({ workspaceId }, { limit: 200 });
      if (!valid()) return false;
      const plan = await operation.write(
        () => createChangePlan({ workspaceId, surface: "settings", request: command }),
        async (receipt) => {
          if (getGatewayApiBaseUrl() !== base) throw new Error("Gateway changed.");
          requireCreatedPackPlan(
            receipt,
            submittedReview.manifest,
            workspaceId,
            command,
            prior.items.map((item) => item.planId),
          );
          const saved = await fetchChangePlan(receipt.planId, { workspaceId });
          if (getGatewayApiBaseUrl() !== base || !samePackPlan(saved, receipt))
            throw new Error("Setup plan readback differs from its receipt.");
        },
      );
      draft.acceptSaved(submitted, manifest.provenance.contentHash, submitted);
      if (valid()) {
        setReview(null);
        setSnapshot((previous) => ({
          identity,
          parents: [plan, ...previous.parents.filter((item) => item.planId !== plan.planId)].slice(0, 20),
          children: previous.children,
        }));
      }
      return true;
    } catch (failure) {
      if (valid()) {
        setReview(null);
        setError(failure instanceof Error ? failure.message : "The setup plan could not be confirmed.");
      }
      return false;
    } finally {
      operation.finish();
    }
  }
  return {
    draft,
    ready,
    attempt,
    loading,
    error,
    refresh,
    setSelected,
    confirmSetup,
    review: review?.epoch === live.current.epoch && current() ? review : null,
    reviewSetup: () => {
      if (ready && epoch === live.current.epoch)
        setReview({ manifest: structuredClone(manifest), selected: [...draft.value], epoch });
    },
    cancelReview: () => {
      live.current.epoch++;
      setReview(null);
    },
    parents: !loading && !error && snapshot.identity === identity ? snapshot.parents : [],
    children: !loading && !error && snapshot.identity === identity ? snapshot.children : [],
  };
}
export type PackExecutionOwner = ReturnType<typeof usePackExecution>;

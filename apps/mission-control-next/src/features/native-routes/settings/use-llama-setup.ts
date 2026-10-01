import { useEffect, useRef, useState } from "react";
import type { ChangePlanRecord, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import {
  confirmChangePlan,
  createChangePlan,
  fetchChangePlan,
  fetchLlamaCppSetup,
  previewLlmModels,
  stageLlamaCppManagedSelection,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../library/session-drafts";
import { useSettingsApprovalContinuation } from "./use-settings-approval-continuation";
import { useLlamaSetupEvidence } from "./use-llama-setup-evidence";
import {
  beginLlamaAttempt,
  finishLlamaAttempt,
  llamaCanonicalDraft,
  llamaPlanBinding,
  llamaPlanSettled,
  llamaProjectionBinding,
  llamaProjectionReady,
  llamaSnapshot,
  rememberLlamaPlan,
  requireLlamaConfirmationReceipt,
  requireLlamaPlan,
  useLlamaSetupState,
  type LlamaSetupChange,
  type LlamaSetupDraft,
} from "./llama-setup-state";

type Review =
  | { kind: "prepare"; submitted: LlamaSetupDraft; projection: LlamaCppSetupProjection; epoch: number }
  | { kind: "confirm"; plan: ChangePlanRecord; epoch: number };
const confirmationAvailable = (plan?: ChangePlanRecord) =>
  Boolean(
    plan?.status === "awaiting_confirmation" &&
    plan.requiredAction?.kind === "confirmation" &&
    plan.requiredAction.actionId &&
    plan.requiredAction.actionNonce &&
    (!plan.expiresAt || Date.parse(plan.expiresAt) > Date.now()),
  );

export function useLlamaSetup(workspaceId: string) {
  const evidence = useLlamaSetupEvidence(workspaceId),
    { installation, projection } = evidence;
  const state = useLlamaSetupState(installation, workspaceId),
    plan = state.entry?.plan;
  const ready = Boolean(workspaceId.trim() && llamaProjectionReady(projection) && !evidence.loading && !evidence.error);
  const draft = useSessionDraft(
    `llama-setup:${evidence.key}`,
    llamaCanonicalDraft(projection),
    projection?.settingsRevision,
    { label: "llama.cpp setup", available: ready },
  );
  const [catalog, setCatalog] = useState<{
    scope: string;
    baseUrl: string;
    ids: string[];
    state: "fresh" | "empty" | "stale";
  }>();
  const [checking, setChecking] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [review, setReview] = useState<Review | null>(null);
  const life = useRef({ mounted: false, identity: "", epoch: 0, check: 0 });
  const identity = llamaSnapshot([
    evidence.key,
    draft.value,
    draft.baseRevision,
    projection && llamaProjectionBinding(projection),
  ]);
  if (life.current.identity !== identity) {
    life.current.identity = identity;
    life.current.epoch++;
  }
  useEffect(() => {
    const owner = life.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
    };
  }, []);
  const current = (epoch: number) =>
    life.current.mounted && life.current.epoch === epoch && getGatewayApiBaseUrl() === installation;
  const baseUrl = draft.value.baseUrl.trim();
  const loadedCatalog = catalog?.scope === evidence.key && catalog.baseUrl === baseUrl ? catalog : undefined;
  const projectionCatalog =
    projection?.managementMode === "external" && projection.baseUrl === baseUrl && projection.catalog.status === "fresh"
      ? projection.catalog.modelIds
      : [];
  const liveModels = loadedCatalog?.state === "fresh" ? loadedCatalog.ids : loadedCatalog ? [] : projectionCatalog;
  const managedModels = projection?.models.filter((model) => model.source === "filesystem") ?? [];
  const choices = draft.value.mode === "external" ? liveModels : managedModels.map((model) => model.modelId);
  const locked = Boolean(state.attempt),
    busy = state.attempt?.state === "pending" || checking;
  const canPrepare =
    ready &&
    !locked &&
    !state.pending &&
    !projection?.pendingPlan &&
    !draft.hasRemoteChanges &&
    choices.includes(draft.value.model) &&
    Boolean(baseUrl) &&
    (draft.value.mode !== "managed" || Boolean(projection?.binary.found));
  const reviewCurrent = Boolean(
    review &&
    current(review.epoch) &&
    !locked &&
    (review.kind === "prepare"
      ? canPrepare && llamaSnapshot(review.submitted) === llamaSnapshot(draft.value)
      : confirmationAvailable(plan) && llamaSnapshot(review.plan) === llamaSnapshot(plan)),
  );
  const refresh = async () => {
    const epoch = life.current.epoch;
    if (plan) {
      try {
        const saved = await fetchChangePlan(plan.planId, { workspaceId });
        if (!current(epoch)) return;
        requireLlamaPlan(saved, workspaceId);
        if (llamaPlanBinding(saved) !== llamaPlanBinding(plan) || saved.revision < plan.revision)
          throw new Error("Setup plan identity changed.");
        rememberLlamaPlan(installation, saved);
      } catch {
        if (current(epoch)) setNotice("Current setup plan could not be verified. Existing evidence is retained.");
        return;
      }
    }
    await evidence.refresh();
  };
  const approved = useSettingsApprovalContinuation({ plan, workspaceId, onSettled: refresh });
  const settledMatches = Boolean(
    plan &&
    ["completed", "applied"].includes(plan.status) &&
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation === "llama_cpp_setup" &&
    ready &&
    projection &&
    projection.settingsRevision > Number(plan.target.expectedRevision) &&
    projection.managementMode === plan.request.change.managementMode &&
    projection.baseUrl === plan.request.change.baseUrl &&
    projection.chatRoute.providerId === "llamacpp" &&
    projection.chatRoute.model === plan.request.change.model &&
    projection.chatRoute.thinkingLevel === "off",
  );
  const { isDirty, acceptSaved } = draft;
  useEffect(() => {
    if (settledMatches && state.entry?.submitted && projection && isDirty)
      acceptSaved(llamaCanonicalDraft(projection), projection.settingsRevision, state.entry.submitted);
  }, [settledMatches, state.entry, projection, isDirty, acceptSaved]);

  async function checkServer() {
    if (!ready || locked || checking || draft.value.mode !== "external" || !baseUrl) return;
    const epoch = life.current.epoch,
      check = ++life.current.check;
    setChecking(true);
    setNotice(null);
    try {
      const result = await previewLlmModels({ providerId: "llamacpp", baseUrl });
      if (!current(epoch) || check !== life.current.check) return;
      const live = result.source === "live" && result.catalogStatus !== "stale";
      const ids = live ? result.items.map((item) => item.id) : [];
      setCatalog({ scope: evidence.key, baseUrl, ids, state: live ? (ids.length ? "fresh" : "empty") : "stale" });
      draft.setValue((value) => ({ ...value, model: ids[0] ?? "" }));
      if (!live) setNotice("Live catalog unavailable; template aliases are not selectable.");
      else if (!ids.length)
        setNotice("The server answered but its model list is empty. Load a model, then check again.");
    } catch {
      if (current(epoch)) {
        setCatalog({ scope: evidence.key, baseUrl, ids: [], state: "stale" });
        setNotice("The server did not provide a current model catalog.");
      }
    } finally {
      if (life.current.mounted && check === life.current.check) setChecking(false);
    }
  }

  async function confirmReview() {
    if (!review || !reviewCurrent || !beginLlamaAttempt(installation)) return;
    const intent = review,
      epoch = life.current.epoch;
    let dispatched = false,
      acknowledged = false;
    setReview(null);
    setNotice(null);
    try {
      const latest = await fetchLlamaCppSetup(workspaceId, new AbortController().signal);
      if (!current(epoch)) return;
      if (!llamaProjectionReady(latest)) throw new Error("Setup evidence incomplete.");
      if (intent.kind === "prepare") {
        if (llamaProjectionBinding(latest) !== llamaProjectionBinding(intent.projection)) {
          setNotice("Runtime settings or installed evidence changed. Refresh and review again.");
          return;
        }
        let change: LlamaSetupChange;
        if (intent.submitted.mode === "managed") {
          if (
            !latest.binary.found ||
            !latest.models.some((item) => item.source === "filesystem" && item.modelId === intent.submitted.model)
          )
            throw new Error("Managed files unavailable.");
          dispatched = true;
          const selected = await stageLlamaCppManagedSelection({ workspaceId, modelId: intent.submitted.model });
          if (
            !selected.selectionId?.trim() ||
            selected.modelId !== intent.submitted.model ||
            !selected.alias?.trim() ||
            !(Date.parse(selected.expiresAt) > Date.now())
          )
            throw new Error("Managed selection did not match.");
          if (!current(epoch)) {
            acknowledged = true;
            return;
          }
          change = {
            operation: "llama_cpp_setup",
            managementMode: "managed",
            baseUrl: intent.submitted.baseUrl.trim(),
            model: selected.alias,
            selectionId: selected.selectionId,
            autoStart: true,
          };
        } else {
          const catalog = await previewLlmModels({ providerId: "llamacpp", baseUrl: intent.submitted.baseUrl.trim() });
          if (!current(epoch)) return;
          if (
            catalog.source !== "live" ||
            catalog.catalogStatus === "stale" ||
            !catalog.items.some((item) => item.id === intent.submitted.model)
          )
            throw new Error("The reviewed model is no longer freshly advertised.");
          change = {
            operation: "llama_cpp_setup",
            managementMode: "external",
            baseUrl: intent.submitted.baseUrl.trim(),
            model: intent.submitted.model,
          };
        }
        dispatched = true;
        const created = await createChangePlan({
          workspaceId,
          surface: "settings",
          request: { kind: "runtime_configuration", change },
        });
        requireLlamaPlan(created, workspaceId, { change, revision: latest.settingsRevision });
        if (!confirmationAvailable(created)) throw new Error("The created plan has no current confirmation action.");
        if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway changed.");
        const saved = await fetchChangePlan(created.planId, { workspaceId });
        requireLlamaPlan(saved, workspaceId, { change, revision: latest.settingsRevision });
        if (
          getGatewayApiBaseUrl() !== installation ||
          llamaPlanBinding(saved) !== llamaPlanBinding(created) ||
          saved.revision < created.revision ||
          (saved.revision === created.revision && llamaSnapshot(saved) !== llamaSnapshot(created))
        )
          throw new Error("Recorded setup readback differs.");
        rememberLlamaPlan(installation, saved, intent.submitted);
        acknowledged = true;
        if (current(epoch))
          setNotice(
            "Setup plan recorded. Review its canonical confirmation before requesting approval or application.",
          );
      } else {
        const fresh = await fetchChangePlan(intent.plan.planId, { workspaceId });
        if (!current(epoch)) return;
        requireLlamaPlan(fresh, workspaceId);
        if (
          llamaSnapshot(fresh) !== llamaSnapshot(intent.plan) ||
          !confirmationAvailable(fresh) ||
          fresh.target.expectedRevision !== latest.settingsRevision
        ) {
          setNotice("The setup plan or settings revision changed. Refresh and review again.");
          return;
        }
        dispatched = true;
        const receipt = await confirmChangePlan(
          fresh.planId,
          { workspaceId },
          { expectedRevision: fresh.revision, actionNonce: fresh.requiredAction!.actionNonce },
        );
        requireLlamaConfirmationReceipt(fresh, receipt);
        if (getGatewayApiBaseUrl() !== installation) throw new Error("Gateway changed.");
        const saved = await fetchChangePlan(fresh.planId, { workspaceId });
        requireLlamaPlan(saved, workspaceId);
        if (
          getGatewayApiBaseUrl() !== installation ||
          llamaPlanBinding(saved) !== llamaPlanBinding(receipt) ||
          saved.revision < receipt.revision ||
          (saved.revision === receipt.revision && llamaSnapshot(saved) !== llamaSnapshot(receipt))
        )
          throw new Error("Setup confirmation readback differs.");
        rememberLlamaPlan(installation, saved);
        acknowledged = true;
        if (current(epoch)) {
          setNotice("Confirmation recorded. Approval and runtime settlement remain with the Gateway.");
          await evidence.refresh();
        }
      }
    } catch {
      if (!dispatched && current(epoch))
        setNotice("Current setup evidence could not be verified. No setup change was sent.");
    } finally {
      finishLlamaAttempt(installation, dispatched && !acknowledged);
    }
  }
  return {
    workspaceId,
    evidence,
    projection,
    draft,
    plan,
    state,
    ready,
    busy,
    locked,
    choices,
    managedModels,
    notice,
    review,
    reviewCurrent,
    canPrepare,
    settledMatches,
    approved,
    refresh,
    checkServer,
    confirmReview,
    setDraft: draft.setValue,
    prepareReview: () => {
      if (canPrepare && projection)
        setReview({
          kind: "prepare",
          submitted: structuredClone(draft.value),
          projection: structuredClone(projection),
          epoch: life.current.epoch,
        });
    },
    confirmationReview: () => {
      if (!locked && confirmationAvailable(plan) && plan)
        setReview({ kind: "confirm", plan: structuredClone(plan), epoch: life.current.epoch });
    },
    canConfirm: !locked && confirmationAvailable(plan),
    cancelReview: () => {
      life.current.epoch++;
      setReview(null);
    },
    planPending: Boolean(plan && !llamaPlanSettled(plan)),
  };
}

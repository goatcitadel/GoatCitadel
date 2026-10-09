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
import {
  classifyMutationAttempt,
  fetchMutationAttempt,
} from "@goatcitadel/mission-control-shared/api/mutation-attempts";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { useSessionDraft } from "../library/session-drafts";
import { useSettingsApprovalContinuation } from "./use-settings-approval-continuation";
import { useLlamaSetupEvidence } from "./use-llama-setup-evidence";
import { dispatchTrackedMutation, UNSETTLED_ATTEMPT_MESSAGES, type TrackedAttempt } from "./mutation-attempt-tracking";
import {
  LLAMA_ROUTE_PATTERNS,
  beginLlamaAttempt,
  beginLlamaCheck,
  endLlamaCheck,
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
  type LlamaRecovery,
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
    // The lost write's identity and what settling it needs (public values only).
    let transport: TrackedAttempt | undefined, recovery: LlamaRecovery | undefined;
    const track = (tracked: TrackedAttempt | undefined) => {
      transport = tracked;
    };
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
          recovery = { kind: "stage", workspaceId };
          const selected = await dispatchTrackedMutation(
            LLAMA_ROUTE_PATTERNS,
            () => stageLlamaCppManagedSelection({ workspaceId, modelId: intent.submitted.model }),
            track,
          );
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
        const planKey = `llama-setup:${crypto.randomUUID()}`;
        recovery = { kind: "create", workspaceId, change, settingsRevision: latest.settingsRevision, planKey };
        const created = await dispatchTrackedMutation(
          LLAMA_ROUTE_PATTERNS,
          () =>
            createChangePlan({
              workspaceId,
              surface: "settings",
              request: { kind: "runtime_configuration", change },
              idempotencyKey: planKey,
            }),
          track,
        );
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
        recovery = { kind: "confirm", workspaceId, planId: fresh.planId };
        const receipt = await dispatchTrackedMutation(
          LLAMA_ROUTE_PATTERNS,
          () =>
            confirmChangePlan(
              fresh.planId,
              { workspaceId },
              { expectedRevision: fresh.revision, actionNonce: fresh.requiredAction!.actionNonce },
            ),
          track,
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
      finishLlamaAttempt(installation, dispatched && !acknowledged, { transport, recovery });
    }
  }

  /**
   * Settles a lost setup write from the Gateway's record of that exact attempt, then canonical evidence. A lost
   * confirmation re-reads its plan (revision and nonce refuse a duplicate). A lost create replays its plan key only
   * when the Gateway recorded it as committed, which returns that one plan; a released create is never replayed. A
   * lost model staging leaves no plan, and staged selections expire on their own. Anything else keeps the lock.
   */
  async function checkOutcome() {
    const checking = beginLlamaCheck(installation);
    if (!checking?.transport || !checking.recovery) return;
    const { transport, recovery } = checking;
    let replay: TrackedAttempt | undefined;
    // Every read, replay and adoption must stay on the installation the attempt was made against.
    const sameGateway = () => getGatewayApiBaseUrl() === installation;
    const otherGateway = () =>
      endLlamaCheck(installation, checking, {
        message:
          "The Gateway connection changed to a different Gateway, so this setup outcome was not checked. Return to the original Gateway to check it.",
      });
    try {
      if (!sameGateway()) return otherGateway();
      const verdict = classifyMutationAttempt(
        await fetchMutationAttempt(transport.attemptKey, transport.method, transport.routePattern),
      );
      if (verdict !== "committed" && verdict !== "failed_confirm_by_readback") {
        endLlamaCheck(installation, checking, { message: UNSETTLED_ATTEMPT_MESSAGES[verdict] ?? checking.message });
        return;
      }
      if (!sameGateway()) return otherGateway();
      if (recovery.kind === "create" && recovery.replayed && verdict !== "committed") {
        endLlamaCheck(installation, checking, {
          message:
            "The plan replay was released after an error, but the original plan may exist. Setup writes stay locked; inspect the recorded plan before continuing.",
        });
        return;
      }
      let message: string;
      if (recovery.kind === "confirm") {
        const saved = await withFreshReads(() =>
          fetchChangePlan(recovery.planId, { workspaceId: recovery.workspaceId }),
        );
        requireLlamaPlan(saved, recovery.workspaceId);
        if (!sameGateway()) return otherGateway();
        rememberLlamaPlan(installation, saved);
        message =
          verdict === "committed"
            ? "The Gateway recorded this setup confirmation as processed. The plan was re-read; approval and runtime settlement remain with the Gateway."
            : "The Gateway released this setup confirmation after an error and the plan was re-read. Review its current step before acting again.";
      } else if (recovery.kind === "create" && verdict === "committed") {
        const created = await dispatchTrackedMutation(
          LLAMA_ROUTE_PATTERNS,
          () =>
            createChangePlan({
              workspaceId: recovery.workspaceId,
              surface: "settings",
              request: { kind: "runtime_configuration", change: recovery.change },
              idempotencyKey: recovery.planKey,
            }),
          (tracked) => {
            replay = tracked;
          },
        );
        requireLlamaPlan(created, recovery.workspaceId, {
          change: recovery.change,
          revision: recovery.settingsRevision,
        });
        if (!sameGateway()) return otherGateway();
        rememberLlamaPlan(installation, created);
        message =
          "The Gateway recorded this setup plan; it was recovered by its plan key. Review its canonical confirmation before requesting approval.";
      } else {
        await withFreshReads(() => fetchLlamaCppSetup(recovery.workspaceId, new AbortController().signal));
        if (!sameGateway()) return otherGateway();
        message =
          recovery.kind === "create"
            ? "The Gateway released this setup plan request after an error, so it was not replayed. Review the setup again against current evidence."
            : "The Gateway handled the model selection without a recorded plan; staged selections expire on their own. Review the setup again.";
      }
      endLlamaCheck(installation, checking);
      if (life.current.mounted) setNotice(message);
      await evidence.refresh();
    } catch {
      endLlamaCheck(installation, checking, {
        message:
          "The outcome check failed, so setup writes stay locked. Check again, or inspect the recorded plan and runtime.",
        ...(replay && recovery.kind === "create"
          ? { transport: replay, recovery: { ...recovery, replayed: true } }
          : {}),
      });
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
    checkOutcome,
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

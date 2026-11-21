import type { ChangePlanRecord, ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import {
  cancelChangePlan,
  confirmChangePlan,
  createChangePlan,
  fetchChangePlan,
  fetchChatSessionPrefs,
} from "@goatcitadel/mission-control-shared/api/client";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { changePlanClientContext, isSafeSessionModelConfirmation } from "./change-plan-controller-helpers";
import type { Input } from "./useChatModelChangePlans";

export function createChatModelPlanActions(
  {
    workspaceId,
    selectedSession,
    prefs,
    prefsRef,
    setPrefs,
    selectedProviderId,
    selectedModel,
    setUiError,
    pushLocalNotice,
    setChatChangePlanSnapshot,
    setActiveChangePlan,
    setLinkedDefaultChangePlan,
  }: Input,
  isCurrent: () => boolean,
  isShown: (workspaceId: string, sessionId?: string | null) => boolean,
  recordChangePlanResult: (plan: ChangePlanRecord) => ChangePlanRecord,
) {
  const applySafeModelChange = async (plan: ChangePlanRecord, actionNonce: string) => {
    const context = changePlanClientContext(workspaceId, plan);
    // Records what the Gateway says about the plan. An applied change is shown as applied and the Chat's own
    // settings are read again, so the composer matches what the Chat now uses.
    const sessionId = plan.origin.sessionId;
    const stillShown = () => isShown(workspaceId, sessionId);
    const settle = async (answer: ChangePlanRecord) => {
      if (!stillShown()) return;
      const updated = recordChangePlanResult(answer);
      if (updated.status !== "completed" && updated.status !== "applied") return;
      pushLocalNotice(updated.result?.summary ?? "Change applied and verified.", "success");
      if (!sessionId) return;
      try {
        const refreshed = await fetchChatSessionPrefs(sessionId);
        if (!stillShown()) return;
        prefsRef.current = refreshed;
        setPrefs(refreshed);
      } catch {
        if (!stillShown()) return;
        setUiError("The change was applied, but this Chat's settings could not be read again. Reload the Chat.");
      }
    };
    try {
      await settle(await confirmChangePlan(plan.planId, context, { expectedRevision: plan.revision, actionNonce }));
      return;
    } catch (error) {
      if (!stillShown()) return;
      const refusal = describeApiError(error, "Unable to apply this model change.").summary;
      // The answer may have been lost after the Gateway applied the change, so what it holds now is read again
      // (never joining an older read) before anything is said about the outcome.
      let current: ChangePlanRecord;
      try {
        current = await withFreshReads(() => fetchChangePlan(plan.planId, context));
      } catch {
        if (stillShown()) setUiError(refusal);
        return;
      }
      if (!stillShown()) return;
      if (current.status === "awaiting_confirmation" && current.revision === plan.revision) {
        // Still waiting: the review card stays, so "Review and confirm" still works.
        setUiError(refusal);
        return;
      }
      await settle(current);
    }
  };
  const requestThreadModelPatch = async (patch: ChatSessionPrefsPatch) => {
    if (!selectedSession) return;
    const session = selectedSession;
    const nextProviderId = patch.providerId ?? selectedProviderId ?? "";
    const nextModel = patch.model ?? selectedModel ?? "";
    const providerChanged = patch.providerId !== undefined && patch.providerId !== (selectedProviderId ?? "");
    const modelChanged = patch.model !== undefined && patch.model !== (selectedModel ?? "");
    const effortChanged = patch.thinkingLevel !== undefined && patch.thinkingLevel !== prefs?.thinkingLevel;
    if (!providerChanged && !modelChanged && !effortChanged) {
      return;
    }
    try {
      const plan = await createChangePlan({
        workspaceId,
        sessionId: session.sessionId,
        surface: "chat",
        idempotencyKey: [
          "chat-model",
          session.sessionId,
          prefs?.revision ?? 0,
          nextProviderId,
          nextModel,
          patch.thinkingLevel ?? prefs?.thinkingLevel ?? "unchanged",
        ].join(":"),
        request: {
          kind: "session_model",
          ...(nextProviderId ? { providerId: nextProviderId } : {}),
          ...(nextModel ? { model: nextModel } : {}),
          ...(patch.thinkingLevel ? { thinkingLevel: patch.thinkingLevel } : {}),
        },
      });
      if (!isCurrent()) return;
      if (plan.status !== "awaiting_confirmation") {
        if (isShown(workspaceId, session.sessionId)) {
          setUiError(plan.result?.summary ?? "This change needs additional setup before it can be confirmed.");
        }
        return;
      }
      setChatChangePlanSnapshot((current) => {
        if (current.ownerSessionId !== session.sessionId) return current;
        return {
          ownerSessionId: session.sessionId,
          items: [plan, ...current.items.filter((item) => item.planId !== plan.planId)].slice(0, 12),
        };
      });
      // A change the Gateway marked safe and that asks only for a confirmation is applied now: pressing Done was
      // the confirmation. Any other plan keeps its review card.
      if (isSafeSessionModelConfirmation(plan) && plan.requiredAction?.kind === "confirmation") {
        await applySafeModelChange(plan, plan.requiredAction.actionNonce);
      }
    } catch (error) {
      // A refused effort or model comes back as a 422 whose sentence says what to choose; never show the raw body.
      if (isShown(workspaceId, session.sessionId)) {
        setUiError(describeApiError(error, "Unable to prepare this model change.").summary);
      }
    }
  };
  const cancelPendingChatChangePlan = (plan: ChangePlanRecord) => {
    const actionNonce = plan.requiredAction?.actionNonce;
    if (!actionNonce) {
      setUiError("This Change Plan no longer has a cancellable action. Refresh it before continuing.");
      return;
    }
    void cancelChangePlan(
      plan.planId,
      { workspaceId, ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}) },
      { expectedRevision: plan.revision, actionNonce },
    )
      .then((cancelled) => {
        if (!isCurrent()) return;
        setChatChangePlanSnapshot((current) => {
          if (current.ownerSessionId !== (plan.origin.sessionId ?? null)) return current;
          return {
            ...current,
            items: current.items.map((item) => (item.planId === cancelled.planId ? cancelled : item)),
          };
        });
        setActiveChangePlan((current) => (current?.planId === cancelled.planId ? null : current));
        setLinkedDefaultChangePlan((current) => (current?.planId === cancelled.planId ? null : current));
        pushLocalNotice("Change plan cancelled.", "success");
      })
      .catch((error) => {
        if (isCurrent()) setUiError(describeApiError(error, "Unable to cancel this Change Plan.").summary);
      });
  };
  const makeChatChangePlanDefault = (plan: ChangePlanRecord) => {
    if (plan.request.kind !== "session_model") return;
    const providerId = plan.request.providerId ?? selectedProviderId ?? prefs?.providerId;
    const model = plan.request.model ?? selectedModel ?? prefs?.model;
    if (!providerId || !model) {
      setUiError("Choose a provider and model before making it the default for future chats.");
      return;
    }
    void createChangePlan({
      workspaceId,
      ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
      surface: "chat",
      idempotencyKey: `default-model:${plan.planId}:${plan.revision}`,
      request: {
        kind: "installation_default_model",
        providerId,
        model,
        ...(plan.request.thinkingLevel ? { thinkingLevel: plan.request.thinkingLevel } : {}),
      },
    })
      .then((created) => {
        if (!isCurrent()) return;
        if (created.status !== "awaiting_confirmation") {
          setUiError(
            created.result?.summary ?? "This default change needs additional setup before it can be confirmed.",
          );
          return;
        }
        setChatChangePlanSnapshot((current) => {
          const ownerSessionId = plan.origin.sessionId ?? null;
          if (current.ownerSessionId !== ownerSessionId) return current;
          return {
            ownerSessionId,
            items: [created, ...current.items.filter((item) => item.planId !== created.planId)].slice(0, 12),
          };
        });
        setActiveChangePlan(plan);
        setLinkedDefaultChangePlan(created);
      })
      .catch((error) => {
        if (isCurrent()) setUiError(describeApiError(error, "Unable to prepare the default-model change.").summary);
      });
  };
  return { requestThreadModelPatch, cancelPendingChatChangePlan, makeChatChangePlanDefault };
}

import { useCallback } from "react";
import type {
  ChangePlanRecord,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
} from "@goatcitadel/contracts";
import { cancelChangePlan, createChangePlan } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { runWithSelectedSession } from "./mission-threaded-controller-helpers";
import { isTerminalChangePlanStatus } from "./change-plan-controller-helpers";
import type { ChatChangePlanState } from "./useChatChangePlanState";

type Input = Pick<
  ChatChangePlanState,
  "setChatChangePlanSnapshot" | "setActiveChangePlan" | "setLinkedDefaultChangePlan" | "setChangePlanActionError"
> & {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  prefs: ChatSessionPrefsRecord | null;
  selectedProviderId: string | undefined;
  selectedModel: string | undefined;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
};

export function useChatModelChangePlans({
  workspaceId,
  selectedSession,
  prefs,
  selectedProviderId,
  selectedModel,
  setUiError,
  pushLocalNotice,
  setChatChangePlanSnapshot,
  setActiveChangePlan,
  setLinkedDefaultChangePlan,
  setChangePlanActionError,
}: Input) {
  const requestThreadModelPatch = useCallback(
    (patch: ChatSessionPrefsPatch) => {
      void runWithSelectedSession(selectedSession, async (session) => {
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
          if (plan.status !== "awaiting_confirmation") {
            setUiError(plan.result?.summary ?? "This change needs additional setup before it can be confirmed.");
            return;
          }
          setChatChangePlanSnapshot((current) => {
            if (current.ownerSessionId !== session.sessionId) return current;
            return {
              ownerSessionId: session.sessionId,
              items: [plan, ...current.items.filter((item) => item.planId !== plan.planId)].slice(0, 12),
            };
          });
        } catch (error) {
          setUiError(error instanceof Error ? error.message : "Unable to prepare this model change.");
        }
      });
    },
    [
      selectedSession,
      selectedProviderId,
      selectedModel,
      prefs?.thinkingLevel,
      prefs?.revision,
      workspaceId,
      setChatChangePlanSnapshot,
      setUiError,
    ],
  );
  const reviewChatChangePlan = useCallback(
    (plan: ChangePlanRecord) => {
      setChangePlanActionError(null);
      setLinkedDefaultChangePlan(null);
      setActiveChangePlan(plan);
    },
    [setActiveChangePlan, setChangePlanActionError, setLinkedDefaultChangePlan],
  );
  const cancelPendingChatChangePlan = useCallback(
    (plan: ChangePlanRecord) => {
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
          setUiError(error instanceof Error ? error.message : "Unable to cancel this Change Plan.");
        });
    },
    [
      pushLocalNotice,
      setActiveChangePlan,
      setChatChangePlanSnapshot,
      setLinkedDefaultChangePlan,
      setUiError,
      workspaceId,
    ],
  );
  const makeChatChangePlanDefault = useCallback(
    (plan: ChangePlanRecord) => {
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
          setUiError(error instanceof Error ? error.message : "Unable to prepare the default-model change.");
        });
    },
    [
      prefs?.model,
      prefs?.providerId,
      selectedModel,
      selectedProviderId,
      setActiveChangePlan,
      setChatChangePlanSnapshot,
      setLinkedDefaultChangePlan,
      setUiError,
      workspaceId,
    ],
  );
  const recordChangePlanResult = useCallback(
    (updated: ChangePlanRecord) => {
      setChatChangePlanSnapshot((current) => {
        const ownerSessionId = updated.origin.sessionId ?? null;
        if (current.ownerSessionId !== ownerSessionId) return current;
        return {
          ownerSessionId,
          items: [updated, ...current.items.filter((item) => item.planId !== updated.planId)].slice(0, 12),
        };
      });
      if (updated.requiredAction && !isTerminalChangePlanStatus(updated.status)) {
        setActiveChangePlan(updated);
      } else {
        setActiveChangePlan((current) => (current?.planId === updated.planId ? null : current));
      }
      return updated;
    },
    [setActiveChangePlan, setChatChangePlanSnapshot],
  );
  return {
    requestThreadModelPatch,
    reviewChatChangePlan,
    cancelPendingChatChangePlan,
    makeChatChangePlanDefault,
    recordChangePlanResult,
  };
}

import { useCallback, type RefObject, type Dispatch, type SetStateAction } from "react";
import type { ChangePlanRecord, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import {
  confirmChangePlan,
  fetchChangePlan,
  fetchChatSessionPrefs,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { changePlanClientContext, requireExactLinkedConfirmation } from "./change-plan-controller-helpers";
import type { ChatChangePlanState } from "./useChatChangePlanState";

type Input = Pick<
  ChatChangePlanState,
  "setActiveChangePlan" | "setLinkedDefaultChangePlan" | "setChangePlanActionError" | "setChangePlanActionPending"
> & {
  workspaceId: string;
  prefsRef: RefObject<ChatSessionPrefsRecord | null>;
  setPrefs: Dispatch<SetStateAction<ChatSessionPrefsRecord | null>>;
  setUiError: (value: string | null) => void;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  recordChangePlanResult: (updated: ChangePlanRecord) => ChangePlanRecord;
};

export function useChatChangePlanConfirmations({
  workspaceId,
  prefsRef,
  setPrefs,
  setUiError,
  pushLocalNotice,
  recordChangePlanResult,
  setActiveChangePlan,
  setLinkedDefaultChangePlan,
  setChangePlanActionError,
  setChangePlanActionPending,
}: Input) {
  const handleConfirmChangePlan = useCallback(
    async (plan: ChangePlanRecord) => {
      const action = plan.requiredAction;
      if (action?.kind !== "confirmation") {
        setChangePlanActionError(
          "This Change Plan changed before confirmation. Reload it and review the current action.",
        );
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const updated = recordChangePlanResult(
          await confirmChangePlan(plan.planId, changePlanClientContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionNonce: action.actionNonce,
          }),
        );
        if (plan.request.kind === "session_model" && plan.origin.sessionId && updated.status === "completed") {
          const refreshed = await fetchChatSessionPrefs(plan.origin.sessionId);
          prefsRef.current = refreshed;
          setPrefs(refreshed);
        }
        if (updated.status === "completed") {
          setUiError(null);
          pushLocalNotice(updated.result?.summary ?? "Change applied and verified.", "success");
        }
      } catch (error) {
        setChangePlanActionError(error instanceof Error ? error.message : "Unable to apply this Change Plan.");
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [
      prefsRef,
      pushLocalNotice,
      recordChangePlanResult,
      setChangePlanActionError,
      setChangePlanActionPending,
      setPrefs,
      setUiError,
      workspaceId,
    ],
  );
  const handleConfirmLinkedModelPlans = useCallback(
    async (currentChatPlan: ChangePlanRecord, defaultPlan: ChangePlanRecord) => {
      const currentAction = currentChatPlan.requiredAction;
      const defaultAction = defaultPlan.requiredAction;
      if (
        currentChatPlan.request.kind !== "session_model" ||
        defaultPlan.request.kind !== "installation_default_model" ||
        currentAction?.kind !== "confirmation" ||
        defaultAction?.kind !== "confirmation"
      ) {
        setChangePlanActionError(
          "The linked model plans changed before confirmation. Reload and review both scopes again.",
        );
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const [freshCurrent, freshDefault] = await Promise.all([
          fetchChangePlan(currentChatPlan.planId, changePlanClientContext(workspaceId, currentChatPlan)),
          fetchChangePlan(defaultPlan.planId, changePlanClientContext(workspaceId, defaultPlan)),
        ]);
        requireExactLinkedConfirmation(currentChatPlan, freshCurrent);
        requireExactLinkedConfirmation(defaultPlan, freshDefault);
        const currentResult = recordChangePlanResult(
          await confirmChangePlan(currentChatPlan.planId, changePlanClientContext(workspaceId, currentChatPlan), {
            expectedRevision: currentChatPlan.revision,
            actionNonce: currentAction.actionNonce,
          }),
        );
        try {
          const defaultResult = recordChangePlanResult(
            await confirmChangePlan(defaultPlan.planId, changePlanClientContext(workspaceId, defaultPlan), {
              expectedRevision: defaultPlan.revision,
              actionNonce: defaultAction.actionNonce,
            }),
          );
          setLinkedDefaultChangePlan(null);
          if (currentChatPlan.origin.sessionId && currentResult.status === "completed") {
            const refreshed = await fetchChatSessionPrefs(currentChatPlan.origin.sessionId);
            prefsRef.current = refreshed;
            setPrefs(refreshed);
          }
          if (currentResult.status === "completed" && defaultResult.status === "completed") {
            setActiveChangePlan(null);
            pushLocalNotice("Model changed for this Chat and saved as the default for future Chats.", "success");
          }
        } catch (defaultError) {
          setActiveChangePlan(defaultPlan);
          setLinkedDefaultChangePlan(null);
          setChangePlanActionError(
            `This Chat was updated, but the future-Chat default was not. Review the remaining default plan before retrying. ${defaultError instanceof Error ? defaultError.message : ""}`.trim(),
          );
        }
      } catch (error) {
        setChangePlanActionError(
          error instanceof Error ? error.message : "Unable to confirm these linked model plans.",
        );
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [
      prefsRef,
      pushLocalNotice,
      recordChangePlanResult,
      setActiveChangePlan,
      setChangePlanActionError,
      setChangePlanActionPending,
      setLinkedDefaultChangePlan,
      setPrefs,
      workspaceId,
    ],
  );
  return { handleConfirmChangePlan, handleConfirmLinkedModelPlans };
}

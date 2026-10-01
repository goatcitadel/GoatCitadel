import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { changePlanReceiptKey, isTerminalChangePlanStatus } from "../change-plan-controller-helpers";
import {
  shouldShowTerminalChangePlanReceipt,
  writeDismissedChangePlanReceiptKeys,
} from "../change-plan-receipt-visibility";
import type { useChatChangePlanState } from "../useChatChangePlanState";
import type { useChatModelChangePlans } from "../useChatModelChangePlans";
import { useChatSessionData } from "../useChatSessionData";

type Input = {
  thread: ReturnType<typeof useChatSessionData>["thread"];
  changePlanState: Pick<
    ReturnType<typeof useChatChangePlanState>,
    | "chatChangePlans"
    | "dismissedChangePlanReceiptKeys"
    | "changePlanActionPending"
    | "setDismissedChangePlanReceiptKeys"
    | "setActivityOpenRequest"
  >;
  modelPlans: Pick<
    ReturnType<typeof useChatModelChangePlans>,
    "reviewChatChangePlan" | "cancelPendingChatChangePlan" | "makeChatChangePlanDefault"
  >;
};

/** Shows the newest eligible receipt without cascading through dismissed history. */
export function createChatChangePlanReceipt({ thread, changePlanState, modelPlans }: Input) {
  const { setDismissedChangePlanReceiptKeys } = changePlanState;
  const { setActivityOpenRequest } = changePlanState;

  const activeTranscriptChangePlan = changePlanState.chatChangePlans.find(
    (plan) => !isTerminalChangePlanStatus(plan.status) && plan.phase !== "terminal",
  );
  // Change-plan history is newest-first. A dismissed terminal receipt must not
  // cascade through older history; Activity remains the place to inspect it.
  const newestTerminalChangePlan = changePlanState.chatChangePlans.find((plan) =>
    isTerminalChangePlanStatus(plan.status),
  );
  const terminalReceiptVisible =
    newestTerminalChangePlan !== undefined &&
    !changePlanState.dismissedChangePlanReceiptKeys.has(changePlanReceiptKey(newestTerminalChangePlan)) &&
    shouldShowTerminalChangePlanReceipt({
      originTurnId: newestTerminalChangePlan.origin.turnId,
      latestTurnId: thread?.turns.at(-1)?.turnId,
      settledAt: newestTerminalChangePlan.updatedAt,
      now: Date.now(),
    });
  const transcriptChangePlan =
    activeTranscriptChangePlan ?? (terminalReceiptVisible ? newestTerminalChangePlan : undefined);
  const changePlanReceipt = transcriptChangePlan
    ? {
        plan: transcriptChangePlan,
        pending: changePlanState.changePlanActionPending,
        dismissed: changePlanState.dismissedChangePlanReceiptKeys.has(changePlanReceiptKey(transcriptChangePlan)),
        onReview: modelPlans.reviewChatChangePlan,
        onCancel: modelPlans.cancelPendingChatChangePlan,
        onMakeDefault: modelPlans.makeChatChangePlanDefault,
        onDismiss: (dismissedPlan: ChangePlanRecord) => {
          setDismissedChangePlanReceiptKeys((current) => {
            const next = new Set(current);
            next.add(changePlanReceiptKey(dismissedPlan));
            writeDismissedChangePlanReceiptKeys(next);
            return next;
          });
        },
        onOpenDetails: () => setActivityOpenRequest((current) => current + 1),
      }
    : undefined;

  return { changePlanReceipt };
}

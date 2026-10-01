import { useState } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { OpenAICodexDeviceStartResponse } from "@goatcitadel/mission-control-shared/api/client";
import { readDismissedChangePlanReceiptKeys } from "./change-plan-receipt-visibility";

export function useChatChangePlanState(selectedSessionId: string | null) {
  const [activeChangePlan, setActiveChangePlan] = useState<ChangePlanRecord | null>(null);
  const [linkedDefaultChangePlan, setLinkedDefaultChangePlan] = useState<ChangePlanRecord | null>(null);
  const [changePlanActionPending, setChangePlanActionPending] = useState(false);
  const [changePlanActionError, setChangePlanActionError] = useState<string | null>(null);
  const [changePlanOAuthFlow, setChangePlanOAuthFlow] = useState<{
    planId: string;
    planRevision: number;
    actionId: string;
    actionNonce: string;
    flow: OpenAICodexDeviceStartResponse;
  } | null>(null);
  const [chatChangePlanSnapshot, setChatChangePlanSnapshot] = useState<{
    ownerSessionId: string | null;
    items: ChangePlanRecord[];
  }>({ ownerSessionId: null, items: [] });
  // A fetch from a previously selected session can settle after the operator
  // changes chats. Keep its owner alongside the records so transient stale
  // data never reaches the transcript or Activity projections.
  const chatChangePlans =
    chatChangePlanSnapshot.ownerSessionId === selectedSessionId ? chatChangePlanSnapshot.items : [];
  // Receipt dismissal is deliberately a client-only acknowledgement. The
  // canonical plan, result, and evidence stay in the Gateway-backed history.
  const [dismissedChangePlanReceiptKeys, setDismissedChangePlanReceiptKeys] = useState<Set<string>>(() =>
    readDismissedChangePlanReceiptKeys(),
  );
  const [activityOpenRequest, setActivityOpenRequest] = useState(0);
  return {
    activeChangePlan,
    setActiveChangePlan,
    linkedDefaultChangePlan,
    setLinkedDefaultChangePlan,
    changePlanActionPending,
    setChangePlanActionPending,
    changePlanActionError,
    setChangePlanActionError,
    changePlanOAuthFlow,
    setChangePlanOAuthFlow,
    chatChangePlanSnapshot,
    setChatChangePlanSnapshot,
    chatChangePlans,
    dismissedChangePlanReceiptKeys,
    setDismissedChangePlanReceiptKeys,
    activityOpenRequest,
    setActivityOpenRequest,
  };
}
export type ChatChangePlanState = ReturnType<typeof useChatChangePlanState>;

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChangePlanRecord, ChatContinuationInput } from "@goatcitadel/contracts";
import {
  fetchChatContinuation,
  prepareChatContinuation,
} from "@goatcitadel/mission-control-shared/api/chat-continuation";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { OwnedChangePlanList } from "@goatcitadel/mission-control-shared/components/chat/OwnedChangePlanList";
import { subscribeRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { ChatExpiredApprovalRecovery, type DraftControls } from "./ChatExpiredApprovalRecovery";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useSettingsApprovalContinuation } from "../../../features/native-routes/settings/use-settings-approval-continuation";
import { SettingsApprovalDialog } from "../settings/SettingsApprovalDialog";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

type Props = {
  props: DraftControls;
  turnId?: string;
  sessionId: string;
  workspaceId: string;
  approvalId: string;
  showExpiredNotice?: boolean;
  onUpdated: () => void;
};
export function ChatExpiredApprovalRecoveryControl(props: Props) {
  const access = useProjectAccess(props.workspaceId),
    { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  if (activeWorkspaceId && activeWorkspaceId !== props.workspaceId) return null;
  return (
    <Recovery
      key={JSON.stringify([access.identity, activeCitadelId, props.workspaceId, props.sessionId, props.approvalId])}
      {...props}
    />
  );
}
function Recovery({ props, turnId, sessionId, workspaceId, approvalId, showExpiredNotice = true, onUpdated }: Props) {
  const { identity, current: isCurrent } = useProjectAccess(workspaceId),
    lock = useRef(false),
    recoveryElement = useRef<HTMLDivElement>(null),
    preparedNote = useRef<HTMLParagraphElement>(null),
    errorNote = useRef<HTMLParagraphElement>(null),
    requestedFocus = useRef<Element | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [plan, setPlan] = useState<ChangePlanRecord>();
  const input: ChatContinuationInput = {
    workspaceId,
    sessionId,
    approvalId,
    reason: "approval_expired",
    ...(turnId ? { sourceTurnId: turnId } : {}),
  };
  const query = useQuery({
    queryKey: ["chat", "continuation", identity, sessionId, approvalId, turnId],
    queryFn: () => fetchChatContinuation(input),
    retry: false,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
    onUpdated();
  }, [refetch, onUpdated]);
  useEffect(() => subscribeRefresh("approvals", () => void refresh()), [refresh]);
  const polled = useQuery({
    queryKey: ["chat", "recovered-setup", identity, sessionId, plan?.planId],
    queryFn: async () => {
      const fresh = await fetchChangePlan(plan!.planId, { workspaceId, sessionId });
      if (
        fresh.origin.workspaceId !== workspaceId ||
        fresh.origin.sessionId !== sessionId ||
        fresh.planId !== plan!.planId ||
        fresh.intentHash !== plan!.intentHash
      )
        throw new Error("The recovered setup changed scope. Refresh the saved setup before deciding.");
      return fresh;
    },
    enabled: Boolean(plan),
    refetchInterval:
      plan && ["awaiting_approval", "staging", "applying", "verifying"].includes(plan.status) ? 1500 : false,
  });
  useEffect(() => {
    if (polled.data && plan && polled.data.planId === plan.planId && polled.data.revision > plan.revision)
      setPlan(polled.data);
  }, [polled.data, plan]);
  async function renew() {
    if (lock.current || !query.data) return;
    requestedFocus.current = recoveryElement.current?.contains(document.activeElement) ? document.activeElement : null;
    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      const reviewed = query.data,
        fresh = await fetchChatContinuation(input);
      if (!isCurrent()) return;
      if (fresh.sourceHash !== reviewed.sourceHash || fresh.status !== "review_required")
        throw new Error("The request or policy changed. Refresh this recovery before deciding.");
      const result = await prepareChatContinuation({ ...input, expectedSourceHash: reviewed.sourceHash });
      if (!isCurrent()) return;
      if (
        result.workspaceId !== workspaceId ||
        result.sessionId !== sessionId ||
        result.sourceHash !== reviewed.sourceHash ||
        !result.plan ||
        result.plan.origin.workspaceId !== workspaceId ||
        result.plan.origin.sessionId !== sessionId
      )
        throw new Error("The recovery scope changed. Check the saved request before continuing.");
      setPlan(result.plan);
      onUpdated();
    } catch (cause) {
      if (isCurrent())
        setError(
          `${describeApiError(cause).summary} Refresh to inspect the saved recovery; do not repeat an unknown action.`,
        );
    } finally {
      lock.current = false;
      if (isCurrent()) setPending(false);
    }
  }
  const preparedPlanId = plan?.planId;
  useEffect(() => {
    const initiator = requestedFocus.current;
    if (!initiator || (!preparedPlanId && !error)) return;
    requestedFocus.current = null;
    if (!isCurrent()) return;
    const active = document.activeElement;
    // Replacing the clicked decision must not leave keyboard focus on body.
    // A message the operator focused while waiting keeps its focus and draft.
    if (active === document.body || active === initiator)
      (error ? errorNote.current : preparedNote.current)?.focus({ preventScroll: true });
  }, [preparedPlanId, error, isCurrent]);
  const continuation = useSettingsApprovalContinuation({ plan, workspaceId, onSettled: refresh });
  const approval = plan?.requiredAction?.kind === "approval" ? plan.requiredAction : undefined;
  return (
    <div
      ref={recoveryElement}
      className="mt-2 grid min-w-0 gap-2 text-sm"
      role="group"
      aria-label="Expired approval recovery"
    >
      <ChatExpiredApprovalRecovery
        props={props}
        turnId={turnId}
        notice={showExpiredNotice ? undefined : "This setup review is no longer actionable."}
        allowAskAgain={!query.error && query.data?.nextAction?.kind === "ask_again"}
      />
      {query.data ? <p>{query.data.reason}</p> : null}
      {query.isPending ? <p>Checking the saved request and execution outcome…</p> : null}
      {!query.error && query.data?.nextAction?.kind === "review_again" && !plan ? (
        <Button size="sm" variant="secondary" disabled={pending || query.isFetching} onClick={() => void renew()}>
          {pending ? "Preparing current review…" : "Review again"}
        </Button>
      ) : null}
      {error || query.error || polled.error ? (
        <p ref={errorNote} tabIndex={-1} role={error ? undefined : "alert"}>
          {error ?? describeApiError(query.error ?? polled.error).summary}
        </p>
      ) : null}
      {query.data?.status === "unknown_effect" ? (
        <NativeOwnerLink
          href={`/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}`}
          scope={identity}
        >
          Inspect execution outcome
        </NativeOwnerLink>
      ) : null}
      {plan ? (
        <>
          <p ref={preparedNote} tabIndex={-1}>
            This is a fresh review of the saved setup request. The earlier Chat turn stays in your history.
          </p>
          <OwnedChangePlanList
            plans={[plan]}
            onUpdated={(updated) => {
              if (isCurrent()) {
                setPlan(updated);
                void refresh();
              }
            }}
            onOpenApproval={() => void polled.refetch()}
          />
        </>
      ) : null}
      {approval?.approvalId ? (
        <SettingsApprovalDialog
          key={approval.approvalId}
          approvalId={approval.approvalId}
          workspaceId={workspaceId}
          installationSetting
          installationPlanId={plan!.planId}
          presentation="inline"
          onResolved={async (status) => {
            if (status === "approved") await continuation.continueApproved();
            await refresh();
          }}
        />
      ) : null}
      {continuation.message ? <p role="status">{continuation.message}</p> : null}
      {continuation.visible ? (
        <Button size="sm" disabled={continuation.disabled} onClick={() => void continuation.continueApproved()}>
          Continue approved setup
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" disabled={pending || query.isFetching} onClick={() => void refresh()}>
        Refresh recovery
      </Button>
    </div>
  );
}

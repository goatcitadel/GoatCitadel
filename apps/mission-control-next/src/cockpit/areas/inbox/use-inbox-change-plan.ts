import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type ChangePlanRecord, type OperatorInboxItem } from "@goatcitadel/contracts";
import { confirmChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../data/query-keys";
import { keepRecordForSameItem, recordView } from "../../data/record-view";
import { useCachedInboxItem } from "../../data/use-operator-inbox";
import {
  canReviewInboxConfirmation,
  readCurrentInboxPlan,
  requireInboxConfirmationReceipt,
} from "./inbox-change-plan-actions";

type Attempt = {
  state: "checking" | "submitted" | "recorded" | "uncertain";
  actionNonce: string;
  result?: ChangePlanRecord;
};
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
function publish(key: string, attempt?: Attempt) {
  if (attempt) attempts.set(key, attempt);
  else attempts.delete(key);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxChangePlan(item: OperatorInboxItem, workspaceId: string, activeWorkspaceId: string) {
  const queryClient = useQueryClient();
  const itemKey = canonicalJsonString(item);
  const cached = useCachedInboxItem(workspaceId, item.id);
  const queryKey = ["change-plan", "inbox-detail", workspaceId, itemKey, cached.fingerprint];
  const query = useQuery({
    queryKey,
    queryFn: () => readCurrentInboxPlan(item, workspaceId, cached.projection),
    placeholderData: keepRecordForSameItem(queryKey),
    enabled: Boolean(item.source.planId) && workspaceId === activeWorkspaceId && Boolean(cached.projection),
    staleTime: 0,
  });
  const identity = canonicalJsonString([workspaceId, activeWorkspaceId, itemKey, query.data]);
  const lifecycle = useRef({ identity, generation: 0 });
  if (lifecycle.current.identity !== identity) lifecycle.current.generation += 1;
  lifecycle.current.identity = identity;
  const mounted = useRef(true);
  useEffect(() => {
    const current = lifecycle.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.generation += 1;
    };
  }, []);
  const [target, setTarget] = useState<{ plan: ChangePlanRecord; identity: string; generation: number }>();
  const [notice, setNotice] = useState<{ identity: string; message: string }>();
  // A lost confirmation response stays locked across selection and navigation.
  // The owner revision/nonce, never this presentation memory, governs execution.
  const key = JSON.stringify([workspaceId, item.source.planId]);
  const attempt = useSyncExternalStore(
    subscribe,
    () => attempts.get(key),
    () => undefined,
  );
  const scopeChanged = workspaceId !== activeWorkspaceId;
  // The last good plan stays (with its open review) while it is checked again; a confirmed one is reset.
  const view = recordView(query);
  const checking = view.phase === "checking";
  const plan = scopeChanged ? undefined : (view.record ?? undefined);
  const review =
    target?.identity === identity && target.generation === lifecycle.current.generation ? target.plan : undefined;
  const pending = attempt?.state === "checking" || attempt?.state === "submitted";
  const completed = attempt?.state === "recorded" && attempt.actionNonce === plan?.requiredAction?.actionNonce;
  const locked = Boolean(attempt && (attempt.state !== "recorded" || completed));
  const canConfirm = canReviewInboxConfirmation(plan) && !locked && !scopeChanged;
  const error =
    attempt?.state === "uncertain"
      ? "Confirmation outcome is uncertain. Further confirmations are locked in this app session. Inspect the current plan in its owner."
      : notice?.identity === identity
        ? notice.message
        : "";

  function openReview() {
    if (!canConfirm || !plan) return;
    setTarget({ plan, identity, generation: lifecycle.current.generation });
    setNotice(undefined);
  }
  function cancelReview() {
    setTarget(undefined);
  }
  async function refresh() {
    setTarget(undefined);
    setNotice(undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    return query.refetch();
  }

  async function confirm() {
    if (!review || review.requiredAction?.kind !== "confirmation" || !canConfirm || !target) return;
    const currentAttempt = attempts.get(key);
    if (
      currentAttempt &&
      (currentAttempt.state !== "recorded" || currentAttempt.actionNonce === review.requiredAction.actionNonce)
    )
      return;
    const current = () =>
      mounted.current &&
      lifecycle.current.identity === target.identity &&
      lifecycle.current.generation === target.generation;
    if (!current()) return;
    const actionNonce = review.requiredAction.actionNonce;
    publish(key, { state: "checking", actionNonce });
    setNotice(undefined);
    let dispatched = false;
    let recorded = false;
    try {
      const latest = await readCurrentInboxPlan(item, workspaceId);
      if (!current()) return;
      if (!canReviewInboxConfirmation(latest) || canonicalJsonString(latest) !== canonicalJsonString(review)) {
        setTarget(undefined);
        setNotice({
          identity,
          message:
            "The change plan changed or is no longer waiting for confirmation. Refresh its current record before deciding.",
        });
        return;
      }
      dispatched = true;
      publish(key, { state: "submitted", actionNonce });
      const updated = await confirmChangePlan(
        review.planId,
        {
          workspaceId,
          sessionId: review.origin.sessionId,
          turnId: review.origin.turnId,
        },
        { expectedRevision: review.revision, actionNonce },
      );
      requireInboxConfirmationReceipt(review, updated);
      recorded = true;
      publish(key, { state: "recorded", actionNonce, result: updated });
      // The confirmed revision is superseded: drop it while it is read again (T15-M1).
      void queryClient.resetQueries({ queryKey, exact: true });
      // Refresh the old canonical scope even if its detail has been closed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
      if (current()) setTarget(undefined);
    } catch (cause) {
      if (recorded) return;
      if (dispatched) publish(key, { state: "uncertain", actionNonce });
      else if (current())
        setNotice({ identity, message: `Could not check the current change plan. ${describeApiError(cause).summary}` });
      if (current()) setTarget(undefined);
    } finally {
      if (!dispatched) publish(key);
    }
  }

  return {
    query,
    view,
    checking,
    identity,
    plan,
    scopeChanged,
    review,
    pending,
    completed,
    canConfirm,
    result: attempt?.result,
    error,
    openReview,
    cancelReview,
    refresh,
    confirm,
  };
}

export function __resetInboxChangePlanAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}

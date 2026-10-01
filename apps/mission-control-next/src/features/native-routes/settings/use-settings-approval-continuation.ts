import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  fetchApprovalReplay,
  fetchChangePlan,
  respondToChangePlan,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  continuationAction,
  planSnapshot,
  requireApprovedBinding,
  requireContinuationReceipt,
} from "./settings-approval-continuation-binding";

type Attempt = { state: "checking" | "submitted" | "recorded" | "uncertain"; message: string };
// App-session presentation locks prevent accidental retries after a lost response.
// The Gateway remains the approval and Change Plan execution authority.
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

export function useSettingsApprovalContinuation({
  plan,
  workspaceId = "default",
  onSettled,
}: {
  plan?: ChangePlanRecord;
  workspaceId?: string;
  onSettled: () => Promise<unknown>;
}) {
  const snapshot = planSnapshot(plan);
  const key = JSON.stringify([workspaceId, plan?.planId]);
  const identity = JSON.stringify([key, snapshot]);
  const current = useRef({ identity, generation: 0, onSettled });
  if (current.current.identity !== identity) current.current.generation += 1;
  current.current.identity = identity;
  current.current.onSettled = onSettled;
  const mounted = useRef(true);
  const [notice, setNotice] = useState<{ identity: string; message: string }>();
  const attempt = useSyncExternalStore(
    subscribe,
    () => attempts.get(key),
    () => undefined,
  );
  useEffect(() => {
    const lifecycle = current.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycle.generation += 1;
    };
  }, []);
  const eligible = Boolean(snapshot && continuationAction(plan, workspaceId));

  async function continueApproved(): Promise<boolean> {
    if (!plan || !snapshot || !eligible || attempts.has(key)) return false;
    const token = current.current.generation;
    const isCurrent = () =>
      mounted.current && current.current.generation === token && current.current.identity === identity;
    const context = { workspaceId };
    publish(key, { state: "checking", message: "Checking the current plan and required approval…" });
    setNotice(undefined);
    let dispatched = false;
    let recorded = false;
    try {
      const fresh = await fetchChangePlan(plan.planId, context);
      if (!isCurrent()) return false;
      if (planSnapshot(fresh) !== snapshot || !continuationAction(fresh, workspaceId)) {
        throw new Error("The Settings change has changed. Refresh its status and review it again.");
      }
      const action = continuationAction(fresh, workspaceId)!;
      const approval = await fetchApprovalReplay(action.approvalId);
      if (!isCurrent()) return false;
      requireApprovedBinding(fresh, approval);
      const latest = await fetchChangePlan(plan.planId, context);
      if (!isCurrent()) return false;
      if (planSnapshot(latest) !== snapshot || !continuationAction(latest, workspaceId)) {
        throw new Error("The Settings change has changed. Refresh its status and review it again.");
      }
      dispatched = true;
      publish(key, { state: "submitted", message: "Continuing the approved Settings change…" });
      const receipt = await respondToChangePlan(plan.planId, context, {
        expectedRevision: latest.revision,
        actionId: action.actionId,
        actionNonce: action.actionNonce,
        values: {},
      });
      requireContinuationReceipt(fresh, receipt);
      recorded = true;
      publish(key, {
        state: "recorded",
        message: "Continuation recorded. Refresh change status to confirm the plan result and saved settings.",
      });
      if (isCurrent()) await current.current.onSettled();
      return true;
    } catch (error) {
      if (recorded) {
        publish(key, {
          state: "recorded",
          message:
            "Continuation recorded, but settings could not be refreshed. Refresh change status to inspect the saved result.",
        });
        return true;
      }
      const message = dispatched
        ? "Continuation outcome is uncertain. Further attempts are locked in this app session. Refresh change status to inspect the current plan."
        : error instanceof Error
          ? error.message
          : "The Settings change could not be checked. Refresh its status before continuing.";
      if (dispatched) publish(key, { state: "uncertain", message });
      if (isCurrent()) setNotice({ identity, message });
      return false;
    } finally {
      if (!dispatched) publish(key);
    }
  }

  return {
    visible: eligible || Boolean(attempt),
    disabled: !eligible || Boolean(attempt),
    state: attempt?.state,
    message: attempt?.message ?? (notice?.identity === identity ? notice.message : undefined),
    continueApproved,
  };
}

export function __resetSettingsApprovalContinuationsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}

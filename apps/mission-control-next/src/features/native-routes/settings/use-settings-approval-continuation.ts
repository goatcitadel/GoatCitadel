import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  fetchApprovalReplay,
  fetchChangePlan,
  respondToChangePlan,
  resolveApproval,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  continuationAction,
  gatewayAuthApprovalChange,
  planSnapshot,
  requireApprovedBinding,
  requireContinuationReceipt,
  requireSettingsApprovalBinding,
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
  approveGatewayAuth = false,
}: {
  plan?: ChangePlanRecord;
  workspaceId?: string;
  onSettled: () => Promise<unknown>;
  approveGatewayAuth?: boolean;
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
    const accessRevision = approveGatewayAuth ? getGatewayAccessRevision() : undefined;
    const installation = approveGatewayAuth ? getGatewayApiBaseUrl() : undefined;
    const isCurrent = () =>
      mounted.current &&
      current.current.generation === token &&
      current.current.identity === identity &&
      (accessRevision === undefined || getGatewayAccessRevision() === accessRevision) &&
      (installation === undefined || getGatewayApiBaseUrl() === installation);
    const context = { workspaceId,...(plan.origin.surface === "chat" ? {sessionId:plan.origin.sessionId}: {}) };
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
      let approval = await fetchApprovalReplay(action.approvalId);
      if (!isCurrent()) return false;
      if (approveGatewayAuth && gatewayAuthApprovalChange(fresh)) {
        const reviewed = requireSettingsApprovalBinding(fresh, approval);
        if (reviewed.status === "pending") {
          if (reviewed.expiresAt && !(Date.parse(reviewed.expiresAt) > Date.now())) {
            throw new Error("The approval expired. Review a new sign-in change to continue.");
          }
          const beforeApproval = await fetchChangePlan(plan.planId, context);
          if (!isCurrent()) return false;
          if (planSnapshot(beforeApproval) !== snapshot) {
            throw new Error("The Settings change has changed. Refresh and review it again.");
          }
          await resolveApproval(action.approvalId, "approve");
          if (!isCurrent()) return false;
          approval = await fetchApprovalReplay(action.approvalId);
          if (!isCurrent()) return false;
        }
      }
      requireApprovedBinding(fresh, approval);
      const latest = await fetchChangePlan(plan.planId, context);
      if (!isCurrent()) return false;
      if (planSnapshot(latest) !== snapshot || !continuationAction(latest, workspaceId)) {
        throw new Error("The Settings change has changed. Refresh its status and review it again.");
      }
      dispatched = true;
      publish(key, {
        state: "submitted",
        message: approveGatewayAuth
          ? "Applying the approved sign-in settings…"
          : "Continuing the approved Settings change…",
      });
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

  // A fresh canonical completion settles the presentation, including a lost
  // response. Keep the attempt lock if an older approval snapshot reappears.
  const completed = plan?.status === "completed";
  return {
    visible: !completed && (eligible || Boolean(attempt)),
    disabled: !eligible || Boolean(attempt),
    state: completed ? undefined : attempt?.state,
    message: completed ? undefined : attempt?.message ?? (notice?.identity === identity ? notice.message : undefined),
    continueApproved,
  };
}

export function __resetSettingsApprovalContinuationsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}

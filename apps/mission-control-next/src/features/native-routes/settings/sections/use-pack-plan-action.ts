import { useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import {
  cancelChangePlan,
  confirmChangePlan,
  fetchApprovalReplay,
  fetchChangePlan,
  requestChangePlanRollback,
  respondToChangePlan,
  verifyChangePlan,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { beginPackAttempt, usePackAttempt } from "./pack-mutation-state";
import {
  canPackPlanAction,
  requirePackApproval,
  requirePackPlanReceipt,
  samePackPlan,
  validWorkspacePlan,
  type PackPlanAction,
} from "./pack-plan-binding";

export const PACK_ACTION_LABELS: Record<PackPlanAction, string> = {
  confirm: "Confirm reviewed setup action",
  cancel: "Cancel pending setup",
  rollback: "Review setup rollback",
  verify: "Verify current owner evidence",
  continue: "Continue approved setup",
};
export function usePackPlanAction(plan: ChangePlanRecord, workspaceId: string, onUpdated: () => void) {
  const base = getGatewayApiBaseUrl();
  const key = JSON.stringify(["pack-plan", base, workspaceId, plan.planId]);
  const identity = canonicalJsonString([key, plan]);
  const live = useRef({ identity, binding: {}, epoch: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.binding = {};
    live.current.epoch++;
  }
  const binding = live.current.binding;
  useLayoutEffect(() => {
    const view = live.current;
    view.mounted = true;
    return () => {
      view.mounted = false;
      view.epoch++;
    };
  }, [identity]);
  const current = () => live.current.mounted && live.current.binding === binding && getGatewayApiBaseUrl() === base;
  const [review, setReview] = useState<{ plan: ChangePlanRecord; action: PackPlanAction; epoch: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = usePackAttempt(key);
  const eligible =
    validWorkspacePlan(plan, workspaceId) &&
    plan.kind === "capability_pack" &&
    plan.scope === "capability" &&
    plan.target.ownerId === "capability_pack" &&
    plan.request.kind === "capability_pack" &&
    plan.target.resourceId === `${workspaceId}:${plan.request.packId}` &&
    plan.adapter.adapterId === "capability-pack-execution" &&
    plan.adapter.version === 1;
  function request(action: PackPlanAction) {
    if (eligible && current() && attempt.phase === "idle" && canPackPlanAction(plan, action)) {
      setNotice(null);
      setReview({ plan: structuredClone(plan), action, epoch: live.current.epoch });
    }
  }
  async function confirm() {
    if (
      !eligible ||
      !review ||
      !current() ||
      review.epoch !== live.current.epoch ||
      !canPackPlanAction(review.plan, review.action)
    )
      return;
    const selected = review,
      operation = beginPackAttempt(key);
    if (!operation) return;
    const valid = () => current() && live.current.epoch === selected.epoch;
    const context = { workspaceId };
    try {
      const fresh = await fetchChangePlan(plan.planId, context);
      if (!valid()) return;
      if (!samePackPlan(fresh, selected.plan))
        throw new Error("The setup plan changed. Refresh and review its current action.");
      if (selected.action === "continue") {
        const required = fresh.requiredAction;
        if (required?.kind !== "approval" || !required.approvalId)
          throw new Error("The approval binding is unavailable.");
        const approval = await fetchApprovalReplay(required.approvalId);
        if (!valid()) return;
        requirePackApproval(fresh, approval);
        const checked = await fetchChangePlan(plan.planId, context);
        if (!valid()) return;
        if (!samePackPlan(checked, fresh)) throw new Error("The setup plan changed while checking approval.");
      }
      if (!valid() || !canPackPlanAction(fresh, selected.action)) return;
      await operation.write(
        () => {
          if (selected.action === "verify") return verifyChangePlan(fresh.planId, context, fresh.revision);
          if (selected.action === "rollback") return requestChangePlanRollback(fresh.planId, context, fresh.revision);
          const required = fresh.requiredAction;
          if (!required) throw new Error("The current owner action is unavailable.");
          const input = { expectedRevision: fresh.revision, actionNonce: required.actionNonce };
          if (selected.action === "confirm") return confirmChangePlan(fresh.planId, context, input);
          if (selected.action === "cancel") return cancelChangePlan(fresh.planId, context, input);
          return respondToChangePlan(fresh.planId, context, { ...input, actionId: required.actionId, values: {} });
        },
        async (receipt) => {
          if (getGatewayApiBaseUrl() !== base) throw new Error("Gateway changed.");
          requirePackPlanReceipt(fresh, receipt, selected.action);
          const saved = await fetchChangePlan(receipt.planId, context);
          if (getGatewayApiBaseUrl() !== base || !samePackPlan(saved, receipt))
            throw new Error("The plan result could not be confirmed by an independent owner read.");
        },
      );
      if (valid()) {
        setReview(null);
        setNotice("Plan result confirmed. Runtime readiness remains with the recorded owner evidence.");
        onUpdated();
      }
    } catch (error) {
      if (valid()) {
        setReview(null);
        setNotice(error instanceof Error ? error.message : "The setup action could not be confirmed.");
      }
    } finally {
      operation.finish();
    }
  }
  return {
    attempt,
    notice,
    confirm,
    request,
    eligible,
    review: current() && review?.epoch === live.current.epoch ? review : null,
    cancel: () => {
      live.current.epoch++;
      setReview(null);
    },
    actions: eligible
      ? (Object.keys(PACK_ACTION_LABELS) as PackPlanAction[]).filter((action) => canPackPlanAction(plan, action))
      : [],
  };
}

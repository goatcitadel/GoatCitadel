import { useEffect, useRef, useState } from "react";
import { type ChangePlanRecord } from "@goatcitadel/contracts";
import {
  confirmChangePlan,
  fetchChangePlan,
  fetchSettings,
  submitChangePlanGatewayAuthCredential,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useFormDirty } from "../library/use-form-dirty";
import { dispatchTrackedMutation, type TrackedAttempt } from "./mutation-attempt-tracking";
import {
  AUTH_ROUTE_PATTERNS,
  authSnapshot,
  beginAuthAttempt,
  finishAuthAttempt,
  requireAuthPlan,
  type GatewayAuthValues,
} from "./gateway-auth-state";
import type { useGatewayAuthSettings } from "./use-gateway-auth-settings";

function actionFor(plan?: ChangePlanRecord) {
  const action = plan?.requiredAction;
  if (
    !plan ||
    !action?.actionId ||
    !action.actionNonce ||
    (plan.expiresAt && !(Date.parse(plan.expiresAt) > Date.now())) ||
    (action.kind === "secure_input" && !(Date.parse(action.expiresAt) > Date.now()))
  )
    return undefined;
  if (plan.status === "awaiting_confirmation" && action.kind === "confirmation") return action;
  if (
    plan.status === "awaiting_input" &&
    action.kind === "secure_input" &&
    action.targetId === "gateway-auth" &&
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation === "gateway_auth_configuration" &&
    action.fields?.length === 1 &&
    action.fields[0]?.required === true &&
    action.fields[0]?.fieldId === (plan.request.change.mode === "token" ? "token" : "password")
  )
    return action;
  return undefined;
}
function binding(plan: ChangePlanRecord) {
  return authSnapshot({
    planId: plan.planId,
    origin: plan.origin,
    kind: plan.kind,
    request: plan.request,
    target: plan.target,
    intentHash: plan.intentHash,
    adapter: plan.adapter,
    scope: plan.scope,
    createdAt: plan.createdAt,
  });
}
type AuthControl = ReturnType<typeof useGatewayAuthSettings>;
type PendingAuthChange = NonNullable<AuthControl["change"]["change"]>;
export function useGatewayAuthContinuation(
  control: Pick<AuthControl, "key" | "attempt"> & {
    change: {
      change?: Pick<PendingAuthChange, "plan" | "submitted" | "baseRevision">;
      refresh: AuthControl["change"]["refresh"];
    };
  },
) {
  const pending = control.change.change;
  const plan = pending?.plan;
  const action = actionFor(plan);
  const [review, setReview] = useState<ChangePlanRecord | null>(null);
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef({ mounted: false, epoch: 0, identity: "" });
  const identity = authSnapshot([control.key, plan ?? null]);
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch += 1;
  }
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch += 1;
    };
  }, []);
  useFormDirty(`${control.key}:continuation-credential`, Boolean(credential), {
    label: "Gateway credential (clears when this editor closes)",
    keepDraft: false,
    onDiscard: () => setCredential(""),
  });
  const currentReview = Boolean(review && actionFor(review) && action && authSnapshot(review) === authSnapshot(plan));
  async function confirm() {
    if (!review || !currentReview || !pending || control.attempt || !beginAuthAttempt(control.key)) return;
    const intent = review,
      epoch = live.current.epoch,
      reviewedAction = actionFor(intent)!;
    const current = () =>
      live.current.mounted && live.current.epoch === epoch && control.key === `access:${getGatewayApiBaseUrl()}:auth`;
    // Blanking a local copy would not scrub anything: the render closure still holds `credential`, which is
    // cleared through setCredential (js/useless-assignment-to-local flagged the former `secret = ""`).
    const secret = credential.trim();
    let dispatched = false,
      acknowledged = false;
    let transport: TrackedAttempt | undefined;
    setMessage(null);
    try {
      if (reviewedAction.kind === "secure_input" && !secret) return;
      const latest = await fetchChangePlan(intent.planId, { workspaceId: "default" });
      if (!current()) return;
      const settings = await fetchSettings();
      if (!current()) return;
      requireAuthPlan(latest, pending.submitted as GatewayAuthValues, pending.baseRevision);
      if (
        authSnapshot(latest) !== authSnapshot(intent) ||
        !actionFor(latest) ||
        settings.revision !== pending.baseRevision
      ) {
        setMessage("The required authentication action changed. Refresh the change status and review again.");
        return;
      }
      dispatched = true;
      const next = await dispatchTrackedMutation(
        AUTH_ROUTE_PATTERNS,
        () =>
          reviewedAction.kind === "secure_input"
            ? submitChangePlanGatewayAuthCredential(
                intent.planId,
                { workspaceId: "default" },
                {
                  expectedRevision: intent.revision,
                  actionId: reviewedAction.actionId,
                  actionNonce: reviewedAction.actionNonce,
                  credential: secret,
                },
              )
            : confirmChangePlan(
                intent.planId,
                { workspaceId: "default" },
                { expectedRevision: intent.revision, actionNonce: reviewedAction.actionNonce },
              ),
        (tracked) => {
          transport = tracked;
        },
      );
      requireAuthPlan(next, pending.submitted as GatewayAuthValues, pending.baseRevision);
      if (
        binding(next) !== binding(intent) ||
        next.revision <= intent.revision ||
        next.requiredAction?.actionNonce === reviewedAction.actionNonce
      )
        throw new Error("Unbound action receipt");
      acknowledged = true;
      if (current()) {
        setReview(null);
        setMessage("Action recorded. Refreshing canonical settlement.");
        await control.change.refresh();
      }
    } catch {
      if (!dispatched && current())
        setMessage("The current authentication action could not be verified. No action was sent.");
    } finally {
      if (live.current.mounted) setCredential("");
      finishAuthAttempt(control.key, dispatched && !acknowledged, transport);
    }
  }
  return {
    action,
    review,
    currentReview,
    credential,
    setCredential,
    message,
    confirm,
    requestReview: () => {
      if (plan && action && !control.attempt) {
        setReview(structuredClone(plan));
        setMessage(null);
      }
    },
    cancel: () => {
      setReview(null);
      setCredential("");
    },
  };
}

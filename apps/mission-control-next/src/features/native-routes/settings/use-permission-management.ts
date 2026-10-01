import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isUncommittedActivationConflict } from "./permission-activation-binding";
import {
  hasProfileRevisionConflictReason,
  permissionEqual,
  permissionOperationKey,
  type PermissionManagementOperation,
  type PermissionManagementReceipt,
} from "./permission-management-binding";
import {
  commitPermissionManagement,
  readPermissionManagementReview,
  type PermissionManagementReview,
} from "./permission-management-mutation";

type Attempt = { phase: "checking" | "submitted" | "uncertain" | "rejected"; message: string; revision?: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
function publish(key: string, value?: Attempt) {
  if (value) attempts.set(key, value);
  else attempts.delete(key);
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
type PendingReview = {
  generation: number;
  value: PermissionManagementReview;
  onRecorded?: (receipt: PermissionManagementReceipt) => void;
};

/** Shared classic/native admission. This store is a UI retry lock, never policy authority. */
export function usePermissionManagement(options: {
  workspaceId: string;
  identity: string;
  reload: () => Promise<unknown>;
}) {
  const base = getGatewayApiBaseUrl();
  const scope = JSON.stringify([base, options.workspaceId]);
  const identity = JSON.stringify([base, options.workspaceId, options.identity]);
  const owner = useRef({ identity, scope, generation: 0, lifetime: 0, action: 0, mounted: true });
  owner.current.scope = scope;
  if (owner.current.identity !== identity) {
    owner.current.identity = identity;
    owner.current.generation += 1;
  }
  const generation = owner.current.generation;
  useEffect(() => {
    const lifecycle = owner.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.lifetime += 1;
    };
  }, []);
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const [pendingReview, setPendingReview] = useState<PendingReview>();
  const [feedback, setFeedback] = useState<{ scope: string; action: number; message: string }>();
  const [checkingGeneration, setCheckingGeneration] = useState<number>();
  const checking = checkingGeneration === generation;
  const current = () =>
    owner.current.mounted && owner.current.generation === generation && getGatewayApiBaseUrl() === base;
  const review = pendingReview?.generation === generation ? pendingReview : undefined;
  function invalidate() {
    owner.current.action += 1;
    owner.current.generation += 1;
    setPendingReview(undefined);
    setCheckingGeneration(undefined);
  }
  const attemptFor = (operation: PermissionManagementOperation) => {
    const attempt = attempts.get(permissionOperationKey(base, options.workspaceId, operation));
    return attempt?.phase === "rejected" && "profile" in operation && attempt.revision !== operation.profile.revision
      ? undefined
      : attempt;
  };
  const locked = (operation: PermissionManagementOperation) => Boolean(attemptFor(operation));
  async function request(operation: PermissionManagementOperation, onRecorded?: PendingReview["onRecorded"]) {
    if (!current() || locked(operation)) return false;
    const action = ++owner.current.action;
    const lifetime = owner.current.lifetime;
    const isCurrent = () => current() && owner.current.lifetime === lifetime && owner.current.action === action;
    setPendingReview(undefined);
    setFeedback(undefined);
    setCheckingGeneration(generation);
    try {
      const value = await readPermissionManagementReview(structuredClone(operation), options.workspaceId);
      if (!isCurrent()) return false;
      setPendingReview({ generation, value, onRecorded });
      return true;
    } catch (error) {
      if (isCurrent()) setFeedback({ scope, action, message: describeApiError(error).summary });
      return false;
    } finally {
      if (isCurrent()) setCheckingGeneration(undefined);
    }
  }
  async function confirm() {
    if (!current() || !review || locked(review.value.operation)) return false;
    const action = ++owner.current.action;
    const lifetime = owner.current.lifetime;
    const isCurrent = () => current() && owner.current.lifetime === lifetime && owner.current.action === action;
    const key = permissionOperationKey(base, options.workspaceId, review.value.operation);
    let dispatched = false;
    publish(key, { phase: "checking", message: "Rechecking the reviewed permission owner…" });
    try {
      const fresh = await readPermissionManagementReview(review.value.operation, options.workspaceId);
      if (!isCurrent()) return false;
      if (!permissionEqual(fresh, review.value))
        throw new Error("The permission owner changed. Refresh and review again before applying.");
      dispatched = true;
      publish(key, { phase: "submitted", message: "Applying the reviewed permission change…" });
      const receipt = await commitPermissionManagement(review.value);
      publish(key);
      const originWasCurrent = isCurrent();
      // A verified late result acknowledges only the captured origin draft, not the new view.
      let message = "The Gateway confirmed this permission change and its owner readback.";
      try {
        review.onRecorded?.(receipt);
      } catch {
        message += " The editor draft could not be acknowledged; inspect it before making another change.";
      }
      if (
        originWasCurrent &&
        owner.current.mounted &&
        owner.current.scope === scope &&
        owner.current.lifetime === lifetime &&
        owner.current.action === action &&
        getGatewayApiBaseUrl() === base
      ) {
        setFeedback({ scope, action, message });
        setPendingReview(undefined);
        try {
          await options.reload();
        } catch {
          /* Receipt remains confirmed; render the read error separately. */
        }
      }
      return true;
    } catch (error) {
      const knownRejected =
        !review.value.operation.kind.startsWith("override-") && isUncommittedActivationConflict(error);
      if (dispatched && !knownRejected)
        publish(key, {
          phase: "uncertain",
          message:
            "The permission change outcome is uncertain. Retry is locked in this app session, including the detailed settings owner. Refresh to inspect canonical state.",
        });
      else {
        const operation = review.value.operation;
        if (dispatched && knownRejected && hasProfileRevisionConflictReason(error) && "profile" in operation)
          publish(key, {
            phase: "rejected",
            revision: operation.profile.revision,
            message:
              "The reviewed revision was rejected. Refresh and explicitly rebase the draft to a different owner revision before retrying.",
          });
        else publish(key);
        if (isCurrent()) setFeedback({ scope, action, message: describeApiError(error).summary });
      }
      if (isCurrent()) setPendingReview(undefined);
      return false;
    } finally {
      if (!dispatched) publish(key);
    }
  }
  return {
    review: review?.value,
    request,
    confirm,
    invalidate,
    checking,
    locked,
    attemptFor,
    message: feedback?.scope === scope && feedback.action === owner.current.action ? feedback.message : undefined,
  };
}

export function __resetPermissionManagementForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}

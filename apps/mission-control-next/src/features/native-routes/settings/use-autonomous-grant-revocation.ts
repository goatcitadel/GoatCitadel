import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AutonomousActivationGrantRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl, revokeAutonomousActivationGrant } from "@goatcitadel/mission-control-shared/api/client";
import {
  assertAutonomousGrantRevoked,
  AUTONOMOUS_GRANT_REVOKE_INPUT,
  grantCanBeRevoked,
  grantsEqual,
  readAutonomousGrants,
} from "./autonomous-grant-binding";

type Attempt = { phase: "checking" | "submitted" | "recorded" | "uncertain"; message: string };
const attempts = new Map<string, Attempt>(),
  listeners = new Set<() => void>();
let version = 0;
function publish(key: string, attempt?: Attempt) {
  if (attempt) attempts.set(key, attempt);
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
const keyFor = (base: string, grantId: string) => JSON.stringify([base, grantId]);
const locked = (attempt?: Attempt) => Boolean(attempt && attempt.phase !== "recorded");

/** Shared UI admission across both shells; the Gateway remains the grant authority. */
export function useAutonomousGrantRevocation({ scope, reload }: { scope: string; reload: () => Promise<unknown> }) {
  const base = getGatewayApiBaseUrl(),
    identity = JSON.stringify([base, scope]);
  const live = useRef({ identity, generation: 0, lifetime: 0, mounted: true, action: 0 });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  const generation = live.current.generation;
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.lifetime += 1;
    };
  }, []);
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const [reviewState, setReview] = useState<{ generation: number; grant: AutonomousActivationGrantRecord }>();
  const [checking, setChecking] = useState<number>();
  const [feedback, setFeedback] = useState<{ generation: number; message: string }>();
  const review = reviewState?.generation === generation ? reviewState.grant : undefined;
  const current = () =>
    live.current.mounted && live.current.generation === generation && getGatewayApiBaseUrl() === base;
  const attemptFor = (grantId: string) => attempts.get(keyFor(base, grantId));
  const busy = (grantId: string) => locked(attemptFor(grantId));
  function cancel() {
    live.current.action += 1;
    setReview(undefined);
    setChecking(undefined);
  }
  async function request(grant: AutonomousActivationGrantRecord) {
    if (!current() || busy(grant.grantId) || !grantCanBeRevoked(grant)) return;
    const action = ++live.current.action,
      lifetime = live.current.lifetime;
    const owns = () => current() && live.current.action === action && live.current.lifetime === lifetime;
    setReview(undefined);
    setFeedback(undefined);
    setChecking(generation);
    try {
      const saved = (await readAutonomousGrants(new AbortController().signal)).find(
        (item) => item.grantId === grant.grantId,
      );
      if (!owns()) return;
      if (!saved || !grantsEqual(saved, grant) || !grantCanBeRevoked(saved))
        throw new Error("This grant changed. Refresh and review its current record.");
      setReview({ generation, grant: structuredClone(saved) });
    } catch (error) {
      if (owns())
        setFeedback({ generation, message: error instanceof Error ? error.message : "Grant review unavailable." });
    } finally {
      if (owns()) setChecking(undefined);
    }
  }
  async function confirm() {
    if (!review || !current() || busy(review.grantId)) return;
    const grant = review,
      key = keyFor(base, grant.grantId),
      lifetime = live.current.lifetime,
      action = ++live.current.action;
    const owns = () => current() && live.current.lifetime === lifetime && live.current.action === action;
    const sameInstallation = () => getGatewayApiBaseUrl() === base;
    let dispatched = false;
    publish(key, { phase: "checking", message: "Checking the exact reviewed grant…" });
    try {
      const saved = (await readAutonomousGrants(new AbortController().signal)).find(
        (item) => item.grantId === grant.grantId,
      );
      if (!owns()) return;
      if (!saved || !grantsEqual(saved, grant) || !grantCanBeRevoked(saved))
        throw new Error("This grant changed after review. Refresh before making another request.");
      dispatched = true;
      publish(key, { phase: "submitted", message: "Waiting for the Gateway revocation acknowledgement…" });
      const receipt = await revokeAutonomousActivationGrant(grant.grantId, AUTONOMOUS_GRANT_REVOKE_INPUT);
      if (!sameInstallation()) throw new Error("Gateway installation changed before revocation readback.");
      assertAutonomousGrantRevoked(grant, receipt);
      const canonical = (await readAutonomousGrants(new AbortController().signal)).find(
        (item) => item.grantId === grant.grantId,
      );
      if (!sameInstallation() || !canonical || !grantsEqual(canonical, receipt))
        throw new Error("The exact revoked grant could not be verified.");
      publish(key, {
        phase: "recorded",
        message: "The Gateway confirmed this grant is revoked. Already-running work may continue.",
      });
    } catch (error) {
      if (dispatched)
        publish(key, {
          phase: "uncertain",
          message:
            "Revocation outcome is uncertain. The grant may already be revoked; further requests for it are locked in this app session. Refresh to inspect the owner record.",
        });
      else {
        publish(key);
        if (owns())
          setFeedback({ generation, message: error instanceof Error ? error.message : "Grant preflight failed." });
      }
    } finally {
      if (!dispatched) publish(key);
      if (owns()) {
        setReview(undefined);
        try {
          await reload();
        } catch {
          /* Keep the acknowledged or uncertain mutation truth. */
        }
      }
    }
  }
  return {
    review,
    request,
    cancel,
    confirm,
    attemptFor,
    busy,
    checking: checking === generation,
    message: feedback?.generation === generation ? feedback.message : undefined,
    pending: review ? ["checking", "submitted"].includes(attemptFor(review.grantId)?.phase ?? "") : false,
  };
}

export function __resetAutonomousGrantRevocationsForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}

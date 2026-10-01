import { useLayoutEffect, useRef, useState } from "react";
import type { OnboardingState } from "@goatcitadel/contracts";
import { completeOnboarding, fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  getOnboardingAttempt,
  hasOnboardingMarker,
  onboardingCompletionBinding,
  onboardingModelReady,
  onboardingSafeMode,
  setOnboardingAttempt,
  useOnboardingAttempt,
} from "./onboarding-completion-state";

/** Shared admission for the existing installation marker. It never certifies inference or applies settings. */
export function useOnboardingCompletion({
  state,
  scope,
  requireModel = false,
  requireSafeMode = false,
}: {
  state: OnboardingState | undefined;
  scope: string;
  requireModel?: boolean;
  requireSafeMode?: boolean;
}) {
  const installation = getGatewayApiBaseUrl(),
    key = `onboarding:${installation}`;
  const binding = onboardingCompletionBinding(state);
  const identity = JSON.stringify([installation, scope, binding, requireModel, requireSafeMode]);
  const live = useRef({ identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);
  const attempt = useOnboardingAttempt(key);
  const [message, setMessage] = useState<{ identity: string; value: string } | null>(null);
  const notice = message?.identity === identity ? message.value : null;
  const ready = Boolean(
    binding &&
    state &&
    (!requireModel || onboardingModelReady(state)) &&
    (!requireSafeMode || onboardingSafeMode(state)),
  );

  async function complete(): Promise<OnboardingState | null> {
    if (!ready || !state || !binding || getOnboardingAttempt(key)) return null;
    const generation = live.current.generation;
    const current = () =>
      live.current.mounted &&
      live.current.identity === identity &&
      live.current.generation === generation &&
      getGatewayApiBaseUrl() === installation;
    if (!current()) return null;
    setOnboardingAttempt(key, { phase: "pending", message: "Confirming setup with the Gateway…" });
    setMessage(null);
    let dispatched = false;
    try {
      const fresh = await fetchOnboardingState();
      if (!current()) return null;
      if (
        onboardingCompletionBinding(fresh) !== binding ||
        (requireModel && !onboardingModelReady(fresh)) ||
        (requireSafeMode && !onboardingSafeMode(fresh))
      )
        throw new Error(
          "Setup changed. Refresh the checks and review the current model and approval rule before finishing.",
        );
      if (fresh.completed) {
        if (!hasOnboardingMarker(fresh)) throw new Error("The Gateway returned an incomplete setup marker.");
        return fresh;
      }
      // This owner accepts no revision: fresh review is a guard, not an atomic settings transaction.
      dispatched = true;
      const receipt = (await completeOnboarding("operator")).state;
      if (
        getGatewayApiBaseUrl() !== installation ||
        !hasOnboardingMarker(receipt) ||
        receipt.completedBy !== "operator" ||
        onboardingCompletionBinding(receipt) !== binding
      )
        throw new Error("Setup completion did not match the reviewed installation evidence.");
      const observed = await fetchOnboardingState();
      if (
        getGatewayApiBaseUrl() !== installation ||
        !hasOnboardingMarker(observed) ||
        observed.completedAt !== receipt.completedAt ||
        observed.completedBy !== receipt.completedBy ||
        onboardingCompletionBinding(observed) !== binding
      )
        throw new Error("The independent setup read did not confirm the returned marker and reviewed settings.");
      return current() ? observed : null;
    } catch (error) {
      if (dispatched)
        setOnboardingAttempt(key, {
          phase: "unknown",
          message:
            "Setup completion is uncertain. Further completion requests are locked in this app session. Refresh the Gateway checks to inspect its recorded marker.",
        });
      else if (current()) setMessage({ identity, value: describeApiError(error).summary });
      return null;
    } finally {
      if (getOnboardingAttempt(key)?.phase === "pending") setOnboardingAttempt(key);
    }
  }
  return { complete, ready, locked: Boolean(attempt), attempt, notice };
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DemoBootstrapStateResponse } from "@goatcitadel/contracts";
import { bootstrapDemo, fetchDemoState } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getOnboardingAttempt, setOnboardingAttempt, useOnboardingAttempt } from "./onboarding-completion-state";
import { assertDemoReceipt, demoStateBinding, readDemoDestination } from "./demo-bootstrap-binding";
import { recordDemoReceipt, useDemoReceipt } from "./demo-bootstrap-state";

export function useDemoBootstrap(scope: string) {
  const base = getGatewayApiBaseUrl(),
    key = `demo-bootstrap:${base}`,
    identity = JSON.stringify([base, scope]);
  const live = useRef({ identity, generation: 0, mounted: true, read: 0, lifetime: {} });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation++;
    live.current.read++;
  }
  const generation = live.current.generation;
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    owner.lifetime = {};
    return () => {
      owner.mounted = false;
      owner.read++;
    };
  }, []);
  const [display, setDisplay] = useState<{ identity: string; state: DemoBootstrapStateResponse } | null>(null);
  const receipt = useDemoReceipt(base);
  const [review, setReview] = useState<{ generation: number; read: number; state: DemoBootstrapStateResponse } | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{ identity: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const consumed = useRef(new WeakSet<object>());
  const attempt = useOnboardingAttempt(key);
  const current = () =>
    live.current.mounted &&
    live.current.identity === identity &&
    live.current.generation === generation &&
    getGatewayApiBaseUrl() === base;
  const state = display?.identity === identity ? display.state : undefined;
  function invalidate() {
    live.current.generation++;
    live.current.read++;
    setReview(null);
  }
  async function refresh() {
    const read = ++live.current.read;
    const lifetime = live.current.lifetime;
    const isCurrent = () => current() && live.current.lifetime === lifetime;
    setReview(null);
    setLoading(true);
    try {
      const state = await fetchDemoState({ signal: new AbortController().signal });
      if (isCurrent() && live.current.read === read) {
        setDisplay({ identity, state });
        setFeedback(null);
      }
    } catch {
      if (isCurrent() && live.current.read === read)
        setFeedback({ identity, message: "The demo state could not be read. Refresh before continuing." });
    } finally {
      if (isCurrent() && live.current.read === read) setLoading(false);
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current();
  }, [identity]); // Each installation/view owns its initial read.
  function begin() {
    if (!current() || !state || loading || getOnboardingAttempt(key)) return;
    setReview({ generation, read: live.current.read, state: structuredClone(state) });
    setFeedback(null);
  }
  async function confirm() {
    const origin = review;
    if (
      !origin ||
      consumed.current.has(origin) ||
      origin.generation !== generation ||
      origin.read !== live.current.read ||
      !current() ||
      getOnboardingAttempt(key)
    )
      return;
    consumed.current.add(origin);
    const lifetime = live.current.lifetime,
      read = live.current.read;
    const isCurrent = () => current() && live.current.lifetime === lifetime && live.current.read === read;
    setOnboardingAttempt(key, { phase: "pending", message: "Preparing local demo records…" });
    setReview(null);
    let dispatched = false;
    try {
      const fresh = await fetchDemoState({ signal: new AbortController().signal });
      if (!isCurrent()) return;
      if (demoStateBinding(fresh) !== demoStateBinding(origin.state))
        throw new Error("Demo records changed. Refresh and review the current state before preparing them.");
      dispatched = true;
      const result = await bootstrapDemo();
      if (getGatewayApiBaseUrl() !== base) throw new Error("The installation changed.");
      const observed = await fetchDemoState({ signal: new AbortController().signal });
      assertDemoReceipt(result, observed);
      await readDemoDestination(observed);
      if (getGatewayApiBaseUrl() !== base) throw new Error("The installation changed.");
      recordDemoReceipt(base, result);
      if (isCurrent()) {
        setDisplay({ identity, state: observed });
        setFeedback({
          identity,
          message:
            result.status === "partial"
              ? "The Gateway recorded a partial demo. Review its notes; record readiness does not settle memory or approval linkage."
              : "Gateway confirmed the demo records. No Chat message was sent or checkpoint approved.",
        });
      }
    } catch (error) {
      if (dispatched)
        setOnboardingAttempt(key, {
          phase: "unknown",
          message:
            "Demo preparation is unconfirmed and may have written some records. Another bootstrap is locked in both shells for this app session; refresh to inspect the recorded state.",
        });
      else if (isCurrent())
        setFeedback({
          identity,
          message: error instanceof Error ? error.message : "Demo preparation could not be checked.",
        });
    } finally {
      if (getOnboardingAttempt(key)?.phase === "pending") setOnboardingAttempt(key);
    }
  }
  async function open(onOpen: (destination: Awaited<ReturnType<typeof readDemoDestination>>) => void) {
    if (!current() || !state || loading || attempt?.phase === "pending") return;
    const read = ++live.current.read;
    const lifetime = live.current.lifetime;
    const isCurrent = () => current() && live.current.lifetime === lifetime;
    setLoading(true);
    try {
      const fresh = await fetchDemoState({ signal: new AbortController().signal });
      if (!isCurrent() || read !== live.current.read) return;
      const destination = await readDemoDestination(fresh);
      if (isCurrent() && read === live.current.read) onOpen(destination);
    } catch {
      if (isCurrent() && read === live.current.read)
        setFeedback({
          identity,
          message: "The demo destination could not be confirmed. Refresh its records before opening it.",
        });
    } finally {
      if (isCurrent() && read === live.current.read) setLoading(false);
    }
  }
  return {
    state,
    receipt,
    loading,
    attempt,
    locked: Boolean(attempt),
    message: feedback?.identity === identity ? feedback.message : undefined,
    refresh,
    begin,
    confirm,
    open,
    cancel: invalidate,
    review: review?.generation === generation ? review : null,
  };
}

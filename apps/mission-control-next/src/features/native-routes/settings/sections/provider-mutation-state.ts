import { useEffect, useRef, useSyncExternalStore } from "react";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export type ProviderMutation = { pending: boolean; uncertain?: string };
const IDLE: ProviderMutation = { pending: false };
let mutation = IDLE;
const listeners = new Set<() => void>();
function publish(next: ProviderMutation) {
  mutation = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** App-session coordination shared by both Settings shells. Never stores submitted credentials. */
export function useProviderMutationState() {
  return useSyncExternalStore(
    subscribe,
    () => mutation,
    () => IDLE,
  );
}
export function beginProviderMutation() {
  if (mutation.pending || mutation.uncertain) return false;
  publish({ pending: true });
  return true;
}
export function finishProviderMutation() {
  publish({ ...mutation, pending: false });
}
export function retainProviderMutationUncertainty() {
  publish({
    pending: false,
    uncertain:
      "Outcome uncertain. Further provider changes are locked in this app session. Refresh the Gateway evidence and inspect Settings activity before another attempt; your draft is retained.",
  });
}
export function isProviderPrecommitConflict(error: unknown, revision: number) {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "STATE_CONFLICT" &&
    Boolean(details) &&
    details!.expectedRevision === revision &&
    Number.isSafeInteger(details!.currentRevision) &&
    (details!.currentRevision as number) > revision &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details!.committed !== true &&
    details!.mutationCommitted !== true
  );
}

/** An away-and-back editor transition still invalidates a preflight completion. */
export function useProviderEditorEpoch(identity: unknown) {
  const serialized = JSON.stringify(identity);
  const latest = useRef({ serialized, epoch: 0 });
  if (latest.current.serialized !== serialized) latest.current = { serialized, epoch: latest.current.epoch + 1 };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const captured = latest.current;
    return () => mounted.current && latest.current === captured;
  };
}

export function __resetProviderMutationStateForTests() {
  publish(IDLE);
}

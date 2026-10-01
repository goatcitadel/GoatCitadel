import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client";
import {
  performScheduleOperation,
  scheduleOperationId,
  type ScheduleOperation,
  type ScheduleReceipt,
} from "./schedule-operation";

type Attempt = { phase: "checking" | "submitted" | "uncertain"; kind: ScheduleOperation["kind"]; message: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
function publish(keys: string[], value?: Attempt) {
  for (const key of keys) {
    if (value) attempts.set(key, value);
    else attempts.delete(key);
  }
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const keyFor = (base: string, id?: string) => JSON.stringify([base, id ? "job" : "create", id ?? null]);

/** Installation-wide retry locks shared by classic and cockpit; never execution authority. */
export function useScheduleOperations(identity: string) {
  const base = getGatewayApiBaseUrl();
  const binding = JSON.stringify([base, identity]);
  const owner = useRef({ binding, generation: 0, lifetime: 0, mounted: true });
  if (owner.current.binding !== binding) {
    owner.current.binding = binding;
    owner.current.generation += 1;
  }
  const generation = owner.current.generation;
  useEffect(() => {
    const value = owner.current;
    value.mounted = true;
    return () => {
      value.mounted = false;
      value.lifetime += 1;
    };
  }, []);
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const [feedback, setFeedback] = useState<{ binding: string; message: string }>();
  const attempt = (id?: string) => attempts.get(keyFor(base, id));
  const locked = (id?: string) => Boolean(attempt(id));
  const invalidate = () => {
    owner.current.generation += 1;
    setFeedback(undefined);
  };

  async function execute(operation: ScheduleOperation, onRecorded?: (receipt: ScheduleReceipt) => void) {
    const lifetime = owner.current.lifetime;
    const isCurrent = () =>
      owner.current.mounted &&
      owner.current.lifetime === lifetime &&
      owner.current.generation === generation &&
      getGatewayApiBaseUrl() === base;
    if (!isCurrent()) return;
    const copied = structuredClone(operation);
    const keys = [keyFor(base, scheduleOperationId(copied)), ...(copied.kind === "create" ? [keyFor(base)] : [])];
    if (keys.some((key) => attempts.has(key))) return;
    let dispatched = false;
    publish(keys, { phase: "checking", kind: copied.kind, message: "Checking the current schedule owner…" });
    setFeedback(undefined);
    try {
      const receipt = await performScheduleOperation(copied, isCurrent, () => {
        dispatched = true;
        publish(keys, { phase: "submitted", kind: copied.kind, message: "Waiting for the Gateway schedule outcome…" });
      });
      if (getGatewayApiBaseUrl() !== base && dispatched) throw new Error("The installation changed during settlement.");
      publish(keys);
      if (!receipt) return;
      // Canonical origin acknowledgement may clear the submitted draft even after navigation.
      // A presentation callback failure cannot turn a verified write into an unknown outcome.
      try {
        onRecorded?.(receipt);
      } catch {
        /* The known owner result remains confirmed. */
      }
      return isCurrent() ? receipt : undefined;
    } catch (error) {
      const message = dispatched
        ? `The ${copied.kind === "create" ? "create" : "action"} outcome is unconfirmed. Further requests are locked for this app session; inspect the current schedule owner.`
        : error instanceof Error
          ? error.message
          : "Could not check the current schedule owner.";
      publish(keys, dispatched ? { phase: "uncertain", kind: copied.kind, message } : undefined);
      if (isCurrent()) setFeedback({ binding, message });
      return undefined;
    }
  }
  return {
    execute,
    invalidate,
    locked,
    attempt,
    message: feedback?.binding === binding ? feedback.message : undefined,
  };
}

export function resetScheduleOperationsForTests() {
  attempts.clear();
  version += 1;
}

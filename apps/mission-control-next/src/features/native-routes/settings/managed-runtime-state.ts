import { useSyncExternalStore } from "react";
import { isChangePlanRequest, type ChangePlanRecord } from "@goatcitadel/contracts";
import { isApiRequestError, type RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { settleTrackedAttempt, type TrackedAttempt } from "./mutation-attempt-tracking";

export const MANAGED_RUNTIME_DRAFT_KEY = "runtime:system:llama:configuration";
export interface ManagedRuntimeValues {
  enabled: boolean;
  autoStart: boolean;
  baseUrl: string;
  alias: string;
}
export function runtimeManagementMode(settings: RuntimeSettingsResponse | undefined) {
  return settings?.llamaCpp?.managementMode ?? (settings?.llamaCpp?.autoStart ? "managed" : "external");
}
export function managedRuntimeValues(settings: RuntimeSettingsResponse | undefined): ManagedRuntimeValues {
  return {
    enabled: settings?.llamaCpp?.enabled ?? false,
    autoStart: settings?.llamaCpp?.autoStart ?? false,
    baseUrl: settings?.llamaCpp?.baseUrl ?? "",
    alias: settings?.llamaCpp?.alias ?? "",
  };
}
export function normalizeManagedRuntime(values: ManagedRuntimeValues): ManagedRuntimeValues {
  return { ...values, baseUrl: values.baseUrl.trim(), alias: values.alias.trim() };
}
export function managedRuntimeInputError(values: ManagedRuntimeValues): string | undefined {
  const normalized = normalizeManagedRuntime(values);
  if (!normalized.alias) return "Enter a model alias.";
  if (
    !isChangePlanRequest({
      kind: "runtime_configuration",
      change: {
        operation: "llama_cpp_configuration",
        config: { alias: normalized.alias },
      },
    })
  )
    return "Use a supported model alias without spaces or parent path segments (up to 256 characters).";
  try {
    const url = new URL(normalized.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return "Use an HTTP or HTTPS endpoint without credentials or a fragment.";
  } catch {
    return "Enter a complete HTTP or HTTPS endpoint.";
  }
  return undefined;
}
export function hasManagedRuntimeSettings(
  settings: RuntimeSettingsResponse | undefined,
): settings is RuntimeSettingsResponse {
  return Boolean(
    settings &&
    Number.isSafeInteger(settings.revision) &&
    settings.revision > 0 &&
    settings.llamaCpp &&
    typeof settings.llamaCpp.enabled === "boolean" &&
    typeof settings.llamaCpp.autoStart === "boolean" &&
    typeof settings.llamaCpp.baseUrl === "string" &&
    typeof settings.llamaCpp.alias === "string",
  );
}
export function sameRuntimeValues(left: ManagedRuntimeValues, right: ManagedRuntimeValues) {
  return (
    left.enabled === right.enabled &&
    left.autoStart === right.autoStart &&
    left.baseUrl === right.baseUrl &&
    left.alias === right.alias
  );
}
export function matchesManagedRuntimePlan(plan: ChangePlanRecord, submitted: ManagedRuntimeValues) {
  if (
    plan.kind !== "runtime_configuration" ||
    plan.request.kind !== "runtime_configuration" ||
    plan.request.change.operation !== "llama_cpp_configuration" ||
    plan.target.ownerId !== "runtime_settings" ||
    plan.target.resourceId !== "llama_cpp_configuration" ||
    plan.origin.sessionId ||
    plan.origin.turnId
  )
    return false;
  const expected = normalizeManagedRuntime(submitted);
  const actual = plan.request.change.config;
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key as keyof typeof actual] === value)
  );
}
export function isManagedRuntimeRevisionConflict(error: unknown, revision: number) {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  if (body.code !== "STATE_CONFLICT" || !body.details || typeof body.details !== "object") return false;
  const details = body.details as Record<string, unknown>;
  return (
    details.expectedRevision === revision &&
    typeof details.currentRevision === "number" &&
    Number.isSafeInteger(details.currentRevision) &&
    details.currentRevision > revision &&
    body.committed !== true &&
    details.committed !== true &&
    body.mutationCommitted !== true &&
    details.mutationCommitted !== true
  );
}

// Lost mutation responses remain locked across both Settings shells for this app lifetime, unless the Gateway's
// record of the identified attempt settles them (`transport` holds the key, method and route; never the body).
export const RUNTIME_ROUTE_PATTERNS = ["/api/v1/settings"] as const;
type RuntimeLock = { message: string; transport?: TrackedAttempt; checking?: boolean };
let lock: RuntimeLock | undefined;
const listeners = new Set<() => void>();
function publish(next: RuntimeLock | undefined) {
  lock = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useManagedRuntimeUncertainty() {
  return useSyncExternalStore(
    subscribe,
    () => lock?.message,
    () => undefined,
  );
}
export function useManagedRuntimeLock() {
  return useSyncExternalStore(
    subscribe,
    () => lock,
    () => undefined,
  );
}
export function retainManagedRuntimeUncertainty(message: string, transport?: TrackedAttempt) {
  publish({
    message: transport
      ? `${message} Check its outcome to settle it from the Gateway's record of this attempt.`
      : message,
    ...(transport ? { transport } : {}),
  });
}
/** Settles the lock from the Gateway's record and a canonical readback; returns the operator notice when settled. */
export async function checkManagedRuntimeOutcome(readback: () => Promise<unknown>): Promise<string | undefined> {
  const current = lock;
  if (!current?.transport || current.checking) return undefined;
  const checking = { ...current, checking: true };
  publish(checking);
  const result = await settleTrackedAttempt(current.transport, readback, "runtime change");
  if (lock !== checking) return undefined;
  publish(result.settled ? undefined : { ...current, message: result.message });
  return result.settled ? result.message : undefined;
}
export function __resetManagedRuntimeUncertaintyForTests() {
  publish(undefined);
}

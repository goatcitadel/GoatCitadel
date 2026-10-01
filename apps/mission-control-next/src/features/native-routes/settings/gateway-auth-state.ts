import { useSyncExternalStore } from "react";
import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";

export interface GatewayAuthValues {
  mode: "none" | "token" | "basic";
  allowLoopbackBypass: boolean;
  basicUsername: string;
  replaceCredential: boolean;
}
export function authValues(auth?: RuntimeSettingsResponse["auth"]): GatewayAuthValues {
  return {
    mode: auth?.mode ?? "none",
    allowLoopbackBypass: auth?.allowLoopbackBypass ?? false,
    basicUsername: "",
    replaceCredential: false,
  };
}
export function normalizeAuth(values: GatewayAuthValues): GatewayAuthValues {
  return {
    ...values,
    basicUsername: values.mode === "basic" ? values.basicUsername.trim() : "",
    replaceCredential: values.mode !== "none" && values.replaceCredential,
  };
}
export function authReady(settings?: RuntimeSettingsResponse): settings is RuntimeSettingsResponse {
  const auth = settings?.auth;
  return Boolean(
    settings &&
    Number.isSafeInteger(settings.revision) &&
    settings.revision > 0 &&
    auth &&
    ["none", "token", "basic"].includes(auth.mode) &&
    typeof auth.allowLoopbackBypass === "boolean" &&
    typeof auth.tokenConfigured === "boolean" &&
    typeof auth.basicConfigured === "boolean",
  );
}
export function authMatches(settings: RuntimeSettingsResponse, submitted: GatewayAuthValues) {
  const auth = settings.auth;
  return (
    authReady(settings) &&
    auth.mode === submitted.mode &&
    auth.allowLoopbackBypass === submitted.allowLoopbackBypass &&
    (submitted.mode !== "token" || auth.tokenConfigured) &&
    (submitted.mode !== "basic" || auth.basicConfigured)
  );
}
export function authChange(values: GatewayAuthValues) {
  const normalized = normalizeAuth(values);
  return {
    operation: "gateway_auth_configuration",
    mode: normalized.mode,
    allowLoopbackBypass: normalized.allowLoopbackBypass,
    ...(normalized.basicUsername ? { basicUsername: normalized.basicUsername } : {}),
    ...(normalized.replaceCredential ? { replaceCredential: true } : {}),
  };
}
export function matchesAuthPlan(plan: ChangePlanRecord, submitted: GatewayAuthValues) {
  return (
    plan.schemaVersion === 1 &&
    plan.origin?.surface === "settings" &&
    plan.origin.workspaceId === "default" &&
    !plan.origin.sessionId &&
    !plan.origin.turnId &&
    plan.kind === "runtime_configuration" &&
    plan.request?.kind === "runtime_configuration" &&
    plan.target?.ownerId === "runtime_settings" &&
    plan.target.resourceId === "gateway_auth_configuration" &&
    canonicalJsonString(plan.request.change) === canonicalJsonString(authChange(submitted))
  );
}
export function authSnapshot(value: unknown): string {
  return canonicalJsonString(value);
}
export function requireAuthPlan(plan: ChangePlanRecord, submitted: GatewayAuthValues, revision: number) {
  if (
    !matchesAuthPlan(plan, submitted) ||
    plan.target.expectedRevision !== revision ||
    !plan.planId?.trim() ||
    !plan.intentHash?.trim() ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1
  ) {
    throw new Error("The Gateway change does not match the reviewed authentication settings.");
  }
}
export const AUTH_UNCERTAIN =
  "The authentication change outcome is uncertain. Further authentication writes are locked in this app session. Inspect the Gateway settings and recorded change before continuing.";
type Attempt = { state: "pending" | "uncertain"; message: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
function publish() {
  for (const listener of listeners) listener();
}
export function beginAuthAttempt(key: string): boolean {
  if (attempts.has(key)) return false;
  attempts.set(key, { state: "pending", message: "Waiting for the Gateway authentication owner." });
  publish();
  return true;
}
export function finishAuthAttempt(key: string, uncertain = false) {
  if (uncertain) attempts.set(key, { state: "uncertain", message: AUTH_UNCERTAIN });
  else attempts.delete(key);
  publish();
}
export function useAuthAttempt(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => attempts.get(key),
    () => undefined,
  );
}
export function __resetAuthAttemptsForTests() {
  attempts.clear();
  publish();
}

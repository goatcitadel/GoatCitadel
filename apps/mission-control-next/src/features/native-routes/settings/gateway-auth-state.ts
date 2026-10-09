import { useSyncExternalStore } from "react";
import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import {
  classifyMutationAttempt,
  fetchMutationAttempt,
} from "@goatcitadel/mission-control-shared/api/mutation-attempts";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import {
  OTHER_GATEWAY,
  sentToConnectedGateway,
  UNSETTLED_ATTEMPT_MESSAGES,
  type TrackedAttempt,
} from "./mutation-attempt-tracking";

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
/** The Gateway routes the authentication owner writes through; a lost write on any of them can be checked. */
export const AUTH_ROUTE_PATTERNS = [
  "/api/v1/auth/settings",
  "/api/v1/change-plans/:planId/confirmations",
  "/api/v1/change-plans/:planId/gateway-auth-credential",
] as const;
/** `transport` identifies the lost write (never its body or credential) so its outcome can be read. */
type Attempt = { state: "pending" | "uncertain"; message: string; transport?: TrackedAttempt; checking?: boolean };
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
export function finishAuthAttempt(key: string, uncertain = false, transport?: TrackedAttempt) {
  if (uncertain)
    attempts.set(key, {
      state: "uncertain",
      message: transport
        ? AUTH_UNCERTAIN + " Check its outcome to settle it from the Gateway's record of this attempt."
        : AUTH_UNCERTAIN,
      ...(transport ? { transport } : {}),
    });
  else attempts.delete(key);
  publish();
}

/**
 * Settles an uncertain authentication write from the Gateway's record of that exact attempt. Only a committed or
 * released attempt unlocks, and only after `readback` (the canonical settings read) succeeds; a released attempt is not
 * proof that nothing was applied. Anything still running, unknown, absent or unreadable keeps the lock. A changed
 * credential can make the read itself unauthorized; that keeps the lock too. Returns the operator notice, if settled.
 */
export async function checkAuthAttemptOutcome(
  key: string,
  readback: () => Promise<unknown>,
): Promise<string | undefined> {
  const attempt = attempts.get(key);
  const transport = attempt?.transport;
  if (attempt?.state !== "uncertain" || !transport || attempt.checking) return undefined;
  // The record of an attempt lives on the installation it was sent to; never check it against another Gateway.
  if (!sentToConnectedGateway(transport)) {
    attempts.set(key, { ...attempt, message: OTHER_GATEWAY });
    publish();
    return undefined;
  }
  const checking = { ...attempt, checking: true };
  attempts.set(key, checking);
  publish();
  const keep = (message: string) => {
    if (attempts.get(key) !== checking) return;
    attempts.set(key, { ...attempt, message });
    publish();
  };
  try {
    const verdict = classifyMutationAttempt(
      await fetchMutationAttempt(transport.attemptKey, transport.method, transport.routePattern),
    );
    // The operator can switch Gateway while the check runs; nothing read after that is evidence about this attempt.
    if (!sentToConnectedGateway(transport)) {
      keep(OTHER_GATEWAY);
      return undefined;
    }
    if (verdict !== "committed" && verdict !== "failed_confirm_by_readback") {
      keep(UNSETTLED_ATTEMPT_MESSAGES[verdict] ?? attempt.message);
      return undefined;
    }
    await withFreshReads(readback);
    if (attempts.get(key) !== checking) return undefined;
    if (!sentToConnectedGateway(transport)) {
      keep(OTHER_GATEWAY);
      return undefined;
    }
    attempts.delete(key);
    publish();
    return verdict === "committed"
      ? "The Gateway recorded this authentication change as processed. Current settings were read back; review them before another change."
      : "The Gateway released this authentication attempt after an error. Current settings were read back; review them before another change, because part of it may still have been applied.";
  } catch {
    keep(
      "The outcome check failed, so authentication writes stay locked. If this Gateway now needs different access credentials, sign in again, then check again.",
    );
    return undefined;
  }
}
export function readAuthAttempt(key: string) {
  return attempts.get(key);
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

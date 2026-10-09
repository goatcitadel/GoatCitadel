import { useSyncExternalStore } from "react";
import {
  canonicalJsonString,
  CHANGE_PLAN_STATUSES,
  type ChangePlanRecord,
  type ChangePlanRuntimeConfigurationRequest,
  type LlamaCppSetupProjection,
} from "@goatcitadel/contracts";
import type { TrackedAttempt } from "./mutation-attempt-tracking";

export interface LlamaSetupDraft {
  mode: "external" | "managed";
  baseUrl: string;
  model: string;
}
export type LlamaSetupChange = Extract<
  ChangePlanRuntimeConfigurationRequest["change"],
  { operation: "llama_cpp_setup" }
>;
export const llamaSnapshot = (value: unknown) => canonicalJsonString(value);
export const llamaPlanSettled = (plan: ChangePlanRecord) =>
  ["completed", "applied", "manual_required", "failed", "cancelled", "rolled_back", "rollback_failed"].includes(
    plan.status,
  );
export function llamaProjectionReady(value?: LlamaCppSetupProjection | null): value is LlamaCppSetupProjection {
  return Boolean(
    value &&
    Number.isSafeInteger(value.settingsRevision) &&
    value.settingsRevision > 0 &&
    ["external", "managed"].includes(value.managementMode) &&
    typeof value.baseUrl === "string" &&
    value.binary &&
    typeof value.binary.found === "boolean" &&
    value.chatRoute &&
    typeof value.chatRoute.model === "string" &&
    Array.isArray(value.models) &&
    value.catalog &&
    Array.isArray(value.catalog.modelIds),
  );
}
export function llamaProjectionBinding(value: LlamaCppSetupProjection) {
  return llamaSnapshot({
    settingsRevision: value.settingsRevision,
    managementMode: value.managementMode,
    baseUrl: value.baseUrl,
    ownership: value.ownership,
    binary: value.binary,
    models: value.models,
    chatRoute: value.chatRoute,
  });
}
export function llamaCanonicalDraft(projection?: LlamaCppSetupProjection | null): LlamaSetupDraft {
  return {
    mode: projection?.managementMode ?? "external",
    baseUrl: projection?.baseUrl ?? "",
    model:
      projection?.managementMode === "external" &&
      projection.chatRoute.providerId === "llamacpp" &&
      projection.catalog.status === "fresh" &&
      projection.catalog.modelIds.includes(projection.chatRoute.model)
        ? projection.chatRoute.model
        : "",
  };
}
export function requireLlamaPlan(
  plan: ChangePlanRecord,
  workspaceId: string,
  expected?: { change: LlamaSetupChange; revision: number },
) {
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    plan.origin?.surface !== "settings" ||
    plan.origin.workspaceId !== workspaceId ||
    plan.origin.sessionId ||
    plan.origin.turnId ||
    plan.kind !== "runtime_configuration" ||
    plan.adapter?.adapterId !== "runtime-configuration" ||
    plan.adapter.version !== 2 ||
    plan.scope !== "runtime" ||
    !CHANGE_PLAN_STATUSES.includes(plan.status) ||
    plan.request?.kind !== "runtime_configuration" ||
    plan.request.change.operation !== "llama_cpp_setup" ||
    plan.target?.ownerId !== "runtime_settings" ||
    plan.target.resourceId !== "llama_cpp_setup" ||
    !Number.isSafeInteger(plan.target.expectedRevision) ||
    Number(plan.target.expectedRevision) < 1 ||
    !plan.planId?.trim() ||
    !plan.intentHash?.trim() ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    !Number.isFinite(Date.parse(plan.createdAt))
  )
    throw new Error("Setup plan evidence does not match this workspace and runtime owner.");
  if (
    expected &&
    (plan.target.expectedRevision !== expected.revision ||
      llamaSnapshot(plan.request.change) !== llamaSnapshot(expected.change))
  )
    throw new Error("The recorded setup differs from the reviewed request.");
}
export function llamaPlanBinding(plan: ChangePlanRecord) {
  return llamaSnapshot({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    origin: plan.origin,
    kind: plan.kind,
    adapter: plan.adapter,
    scope: plan.scope,
    request: plan.request,
    intentHash: plan.intentHash,
    target: plan.target,
    createdAt: plan.createdAt,
  });
}
export function requireLlamaConfirmationReceipt(before: ChangePlanRecord, after: ChangePlanRecord) {
  requireLlamaPlan(after, before.origin.workspaceId);
  if (
    llamaPlanBinding(before) !== llamaPlanBinding(after) ||
    after.revision <= before.revision ||
    after.requiredAction?.actionNonce === before.requiredAction?.actionNonce
  )
    throw new Error("Setup confirmation returned unrelated or unchanged evidence.");
}
type PlanEntry = { installation: string; workspaceId: string; plan: ChangePlanRecord; submitted?: LlamaSetupDraft };
/** The Gateway routes the llama.cpp setup owner writes through; a lost write on any of them can be checked. */
export const LLAMA_ROUTE_PATTERNS = [
  "/api/v1/llamacpp/setup/managed-selection",
  "/api/v1/change-plans",
  "/api/v1/change-plans/:planId/confirmations",
] as const;
/** Public identities only (no credentials exist in this owner): what a lost write needs to be settled. */
export type LlamaRecovery =
  | { kind: "stage"; workspaceId: string }
  | {
      kind: "create";
      workspaceId: string;
      change: LlamaSetupChange;
      settingsRevision: number;
      planKey: string;
      /** Set once the create was replayed: its own record now decides, and only "committed" may proceed. */
      replayed?: boolean;
    }
  | { kind: "confirm"; workspaceId: string; planId: string };
type Attempt = {
  state: "pending" | "uncertain";
  message: string;
  transport?: TrackedAttempt;
  recovery?: LlamaRecovery;
  checking?: boolean;
};
const plans = new Map<string, PlanEntry>(),
  attempts = new Map<string, Attempt>(),
  listeners = new Set<() => void>();
let version = 0;
const publish = () => {
  version++;
  for (const listener of listeners) listener();
};
export const llamaScopeKey = (installation: string, workspaceId: string) => JSON.stringify([installation, workspaceId]);
export function rememberLlamaPlan(installation: string, plan: ChangePlanRecord, submitted?: LlamaSetupDraft) {
  const key = llamaScopeKey(installation, plan.origin.workspaceId),
    previous = plans.get(key);
  if (
    previous &&
    (previous.plan.planId === plan.planId
      ? previous.plan.revision > plan.revision
      : Date.parse(previous.plan.createdAt) >= Date.parse(plan.createdAt))
  )
    return;
  plans.set(key, {
    installation,
    workspaceId: plan.origin.workspaceId,
    plan,
    submitted: submitted ?? (previous?.plan.planId === plan.planId ? previous.submitted : undefined),
  });
  publish();
}
export function beginLlamaAttempt(installation: string) {
  if (attempts.has(installation)) return false;
  attempts.set(installation, { state: "pending", message: "Waiting for the llama.cpp setup owner." });
  publish();
  return true;
}
export function finishLlamaAttempt(
  installation: string,
  uncertain: boolean,
  lost?: { transport?: TrackedAttempt; recovery?: LlamaRecovery },
) {
  const checkable = Boolean(lost?.transport && lost.recovery);
  if (uncertain)
    attempts.set(installation, {
      state: "uncertain",
      message:
        "The llama.cpp setup outcome is uncertain. Further setup writes are locked in this app session. Inspect its recorded plan and runtime before continuing." +
        (checkable ? " Check its outcome to settle it from the Gateway's record of this attempt." : ""),
      ...(checkable ? { transport: lost!.transport, recovery: lost!.recovery } : {}),
    });
  else attempts.delete(installation);
  publish();
}
/** Marks the uncertain attempt as being checked; returns its snapshot, or undefined when it cannot be checked now. */
export function beginLlamaCheck(installation: string) {
  const attempt = attempts.get(installation);
  if (attempt?.state !== "uncertain" || !attempt.transport || !attempt.recovery || attempt.checking) return undefined;
  const checking = { ...attempt, checking: true };
  attempts.set(installation, checking);
  publish();
  return checking;
}
/** Ends a check: no `kept` releases the lock; otherwise the lock stays with the given message (and transport). */
export function endLlamaCheck(
  installation: string,
  checking: Attempt,
  kept?: { message: string; transport?: TrackedAttempt; recovery?: LlamaRecovery },
) {
  if (attempts.get(installation) !== checking) return;
  if (kept) attempts.set(installation, { ...checking, checking: false, ...kept });
  else attempts.delete(installation);
  publish();
}
export function useLlamaSetupState(installation: string, workspaceId: string) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => version,
  );
  return {
    entry: plans.get(llamaScopeKey(installation, workspaceId)),
    attempt: attempts.get(installation),
    pending: [...plans.values()].find((entry) => entry.installation === installation && !llamaPlanSettled(entry.plan)),
  };
}
export function __resetLlamaSetupForTests() {
  plans.clear();
  attempts.clear();
  publish();
}

import { useSyncExternalStore } from "react";
import type { ChangePlanRecord, ToolApprovalMode } from "@goatcitadel/contracts";
import { isApiRequestError, type RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { TOOL_APPROVAL_MODE_OPTIONS } from "../../../features/native-routes/settings/helpers/permission-helpers";

export const APPROVAL_MODE_DRAFT_KEY = "tools:system:approval-mode";
export function isApprovalMode(value: unknown): value is ToolApprovalMode {
  return TOOL_APPROVAL_MODE_OPTIONS.includes(value as ToolApprovalMode);
}
export function hasApprovalSettings(
  settings: RuntimeSettingsResponse | undefined,
): settings is RuntimeSettingsResponse {
  return Boolean(
    settings &&
    isApprovalMode(settings.toolApprovalMode) &&
    Number.isSafeInteger(settings.revision) &&
    settings.revision > 0 &&
    ["local_dev", "trusted_local", "remote_hardened"].includes(settings.deploymentProfile),
  );
}
export function matchesApprovalModePlan(plan: ChangePlanRecord, submitted: ToolApprovalMode): boolean {
  return (
    plan.kind === "runtime_configuration" &&
    plan.request.kind === "runtime_configuration" &&
    plan.request.change.operation === "tool_approval_mode" &&
    plan.request.change.mode === submitted &&
    plan.target.ownerId === "runtime_settings" &&
    plan.target.resourceId === "tool_approval_mode" &&
    !plan.origin.sessionId &&
    !plan.origin.turnId
  );
}
export function isApprovalRevisionConflict(error: unknown, revision: number): boolean {
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
    details.committed !== true
  );
}

// A lost response cannot establish whether the Gateway applied or queued this save.
// Retain the lock across navigation; this is UI uncertainty, never canonical state.
let uncertainMessage: string | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useApprovalModeUncertainty() {
  return useSyncExternalStore(
    subscribe,
    () => uncertainMessage,
    () => undefined,
  );
}
export function retainApprovalModeUncertainty(message: string) {
  uncertainMessage = message;
  for (const listener of listeners) listener();
}
export function __resetApprovalModeUncertaintyForTests() {
  uncertainMessage = undefined;
  for (const listener of listeners) listener();
}

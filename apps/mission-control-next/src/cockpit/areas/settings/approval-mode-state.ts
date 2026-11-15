import { useSyncExternalStore } from "react";
import type { ChangePlanRecord, ToolApprovalMode } from "@goatcitadel/contracts";
import { isApiRequestError, type RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import type { TrackedAttempt } from "../../../features/native-routes/settings/mutation-attempt-tracking";
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

/**
 * A lost response cannot establish whether the Gateway applied or queued this save, so the rule keeps a record of the
 * write until the saved rule and the open changes have been read again. It is retained across navigation (a lock
 * that is UI uncertainty, never canonical state) and carries what that check needs.
 */
export interface ApprovalModeUncertainty {
  message: string;
  submitted: ToolApprovalMode;
  baseRevision: number;
  previous: ToolApprovalMode;
  /** The Gateway the write went to; the check reads only that one. */
  installation: string;
  /** The write's identity, so the Gateway's record of that very request can say whether it has finished. */
  transport?: TrackedAttempt;
  checking: boolean;
}
// One record per Gateway: a lost write on one installation must never overwrite, clear or be cleared by another's.
const uncertainRecords = new Map<string, ApprovalModeUncertainty>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish() {
  for (const listener of listeners) listener();
}
/** The record of the given installation's unconfirmed save, if it has one. */
export function useApprovalModeUncertainty(installation: string): ApprovalModeUncertainty | undefined {
  return useSyncExternalStore(
    subscribe,
    () => uncertainRecords.get(installation),
    () => undefined,
  );
}
/** The installation's record as it is now, for a check that must not act on a stale render. */
export function currentApprovalModeUncertainty(installation: string): ApprovalModeUncertainty | undefined {
  return uncertainRecords.get(installation);
}
export function retainApprovalModeUncertainty(record: ApprovalModeUncertainty) {
  uncertainRecords.set(record.installation, record);
  publish();
}
export function clearApprovalModeUncertainty(installation: string) {
  uncertainRecords.delete(installation);
  publish();
} /**
 * What the saved rule says about a write whose answer was lost: it is saved when the rule is the submitted one at a
 * newer revision, else it is waiting when an open change for it exists, else it was not saved.
 */
export function settleApprovalModeUncertainty(
  record: ApprovalModeUncertainty,
  latest: RuntimeSettingsResponse,
  waiting: boolean,
): "saved" | "waiting" | "not_saved" {
  if (latest.toolApprovalMode === record.submitted && latest.revision > record.baseRevision) return "saved";
  return waiting ? "waiting" : "not_saved";
}
export function __resetApprovalModeUncertaintyForTests() {
  uncertainRecords.clear();
  publish();
}

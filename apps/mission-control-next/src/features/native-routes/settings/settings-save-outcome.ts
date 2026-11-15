import { changePlanPhaseForStatus, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchChangePlan, fetchChangePlans, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

/**
 * What a rejected Settings save means for the operator:
 * - `waiting`: an earlier change to this setting is still waiting for approval (the Gateway names its plan);
 * - `conflict`: the saved settings moved on while the draft was open;
 * - `refused`: the Gateway answered with a plain refusal, so nothing was applied;
 * - `uncertain`: the answer was lost or the Gateway failed, so the save may or may not have been applied.
 */
export type SettingsSaveFailure =
  | { kind: "waiting"; planId: string }
  | { kind: "conflict" }
  | { kind: "refused"; reason: string }
  | { kind: "uncertain"; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function claimsCommitted(body: Record<string, unknown> | undefined): boolean {
  if (!body) return false;
  const details = asRecord(body.details);
  return [body, details].some((entry) => entry?.committed === true || entry?.mutationCommitted === true);
}

export function classifySettingsSaveFailure(error: unknown): SettingsSaveFailure {
  if (isApiRequestError(error)) {
    const status = (error as { status?: number }).status;
    const body = asRecord((error as { body?: unknown }).body);
    if (status === 409) {
      const details = asRecord(body?.details);
      const planId = details?.resourceId;
      if (
        body?.code === "WRITE_CONFLICT" &&
        details?.resourceKind === "change_plan" &&
        typeof planId === "string" &&
        planId.trim()
      )
        return { kind: "waiting", planId: planId.trim() };
      return { kind: "conflict" };
    }
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 429 &&
      !claimsCommitted(body)
    )
      return { kind: "refused", reason: describeApiError(error).summary };
  }
  return { kind: "uncertain", reason: describeApiError(error).summary };
}

export interface WaitingSettingsChange {
  planId: string;
  approvalId?: string;
  title?: string;
  applying: boolean;
}

const APPLYING = new Set<string>(["applying", "verifying", "monitoring"]);

function isTerminal(plan: ChangePlanRecord): boolean {
  return changePlanPhaseForStatus(plan.status) === "terminal";
}

function isSettingsPlan(plan: ChangePlanRecord): boolean {
  return plan.origin.surface === "settings" && plan.origin.workspaceId === "default";
}

function describeWaiting(plan: ChangePlanRecord): WaitingSettingsChange {
  const action = plan.requiredAction;
  return {
    planId: plan.planId,
    ...(action?.kind === "approval" && action.approvalId ? { approvalId: action.approvalId } : {}),
    ...(plan.title ? { title: plan.title } : {}),
    applying: APPLYING.has(plan.status),
  };
}

/** The Settings change a conflict named, when it is still open; `undefined` when it is finished, foreign or unreadable. */
export async function findWaitingSettingsChange(planId: string): Promise<WaitingSettingsChange | undefined> {
  try {
    const plan = await fetchChangePlan(planId, { workspaceId: "default" });
    if (!isSettingsPlan(plan) || isTerminal(plan)) return undefined;
    return describeWaiting(plan);
  } catch {
    return undefined;
  }
}

/** The newest open Settings change that `matches`; `"unreadable"` when the plans could not be read. */
export async function findActiveSettingsChange(
  matches: (plan: ChangePlanRecord) => boolean,
): Promise<WaitingSettingsChange | undefined | "unreadable"> {
  try {
    const { items } = await fetchChangePlans({ workspaceId: "default" }, { limit: 50 });
    const open = items
      .filter((plan) => isSettingsPlan(plan) && !isTerminal(plan) && matches(plan))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return open[0] ? describeWaiting(open[0]) : undefined;
  } catch {
    return "unreadable";
  }
}

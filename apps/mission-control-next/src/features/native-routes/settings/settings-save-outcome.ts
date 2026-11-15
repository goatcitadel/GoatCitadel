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

/**
 * Where an open Settings change stands for the operator: `approval` has an approval to decide in place, `review` is a
 * change the Inbox lists for the operator to act on (confirm, give input), `credential` needs a secret that Inbox
 * cannot take, `preparing` is not ready for anyone yet (draft, staging) and `applying` is being carried out.
 */
export type WaitingSettingsStage = "approval" | "review" | "credential" | "preparing" | "applying";

export interface WaitingSettingsChange {
  planId: string;
  approvalId?: string;
  title?: string;
  stage: WaitingSettingsStage;
}

/** A waiting change as the save hooks hold it: read, or named by the Gateway but not readable right now. */
export type WaitingSettingsNotice = WaitingSettingsChange | { planId: string; unreadable: true };

/** What a look at a named plan found: still open, finished, not a Settings change, or not readable. */
export type WaitingLookup =
  | { kind: "open"; change: WaitingSettingsChange }
  | { kind: "finished" }
  | { kind: "foreign" }
  | { kind: "unreadable" };

const APPLYING = new Set<string>(["applying", "verifying", "monitoring", "rolling_back"]);
// Not listed in Inbox and not ready for the operator: nothing to click yet.
const PREPARING = new Set<string>(["draft", "staging"]);

function isTerminal(plan: ChangePlanRecord): boolean {
  return changePlanPhaseForStatus(plan.status) === "terminal";
}

function isSettingsPlan(plan: ChangePlanRecord): boolean {
  return plan.origin.surface === "settings" && plan.origin.workspaceId === "default";
}

function describeWaiting(plan: ChangePlanRecord): WaitingSettingsChange {
  const action = plan.requiredAction;
  const approvalId = action?.kind === "approval" && action.approvalId ? action.approvalId : undefined;
  const stage: WaitingSettingsStage = approvalId
    ? "approval"
    : action?.kind === "secure_input"
      ? "credential"
      : APPLYING.has(plan.status)
        ? "applying"
        : PREPARING.has(plan.status)
          ? "preparing"
          : "review";
  return {
    planId: plan.planId,
    ...(approvalId ? { approvalId } : {}),
    ...(plan.title ? { title: plan.title } : {}),
    stage,
  };
}

/** Looks at the Settings change a conflict named. */
export async function findWaitingSettingsChange(planId: string): Promise<WaitingLookup> {
  let plan: ChangePlanRecord;
  try {
    plan = await fetchChangePlan(planId, { workspaceId: "default" });
  } catch {
    return { kind: "unreadable" };
  }
  if (!isSettingsPlan(plan)) return { kind: "foreign" };
  if (isTerminal(plan)) return { kind: "finished" };
  return { kind: "open", change: describeWaiting(plan) };
}

/** What a held waiting change becomes after a look: the open change, the unreadable stand-in, or nothing. */
export function waitingNoticeFor(lookup: WaitingLookup, planId: string): WaitingSettingsNotice | null {
  if (lookup.kind === "open") return lookup.change;
  return lookup.kind === "unreadable" ? { planId, unreadable: true } : null;
}

/** What a waiting change is to: the words that follow "this" in its sentence. */
export type WaitingSubject = "setting" | "rule" | "provider";

/** The one sentence about a waiting change; `subject` is the words after "this". */
export function describeWaitingChange(waiting: WaitingSettingsNotice, subject: WaitingSubject = "setting"): string {
  if ("unreadable" in waiting) return `One change to this ${subject} is already waiting.`;
  if (waiting.stage === "approval") return `One change to this ${subject} is already waiting for your approval.`;
  if (waiting.stage === "review") return `One change to this ${subject} is waiting for your review.`;
  if (waiting.stage === "credential")
    return `One change to this ${subject} is waiting for its credential. Finish or cancel it where you started it.`;
  if (waiting.stage === "preparing")
    return `One change to this ${subject} is being prepared. Refresh in a moment to see it.`;
  return `One change to this ${subject} is still being applied. Refresh in a moment to see it.`;
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

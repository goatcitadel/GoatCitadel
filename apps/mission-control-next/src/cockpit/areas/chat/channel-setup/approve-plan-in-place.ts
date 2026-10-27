import type { ChangePlanRecord, ChangePlanRequiredAction, ChangePlanStatus } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import {
  confirmChangePlan,
  createChangePlan,
  fetchChangePlan,
  fetchSettings,
  resolveApproval,
  respondToChangePlan,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { isBaseUrlAllowlisted } from "../../settings/web-search-state";

/**
 * Where a change ended up after the page did all it may.
 * - completed: the change is applied.
 * - elsewhere: the next step belongs to Settings or Inbox (a form, a secret, an approval this sign-in can't give).
 *   `inInbox` marks a change the page did not make, whose review stays in Inbox.
 * - failed: it stopped for good, or a call failed; the message is plain words.
 */
export type InPlaceOutcome =
  | { kind: "completed"; plan: ChangePlanRecord }
  | { kind: "elsewhere"; plan: ChangePlanRecord; approvalId?: string; inInbox?: true }
  | { kind: "failed"; message: string };

type ApprovalAction = Extract<ChangePlanRequiredAction, { kind: "approval" }>;
/** One round's result: an outcome ends the run, "again" reads the change straight away, "wait" pauses first. */
type Round = InPlaceOutcome | "again" | "wait";

const MAX_ROUNDS = 12;
const WAIT_MS = 1000;

const APPLIED: ReadonlySet<ChangePlanStatus> = new Set(["completed", "applied", "monitoring"]);
const STOPPED: ReadonlySet<ChangePlanStatus> = new Set([
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
  "manual_required",
]);
const STILL_WORKING: ReadonlySet<ChangePlanStatus> = new Set(["applying", "verifying"]);

const ANOTHER_CHANGE = "This approval belongs to another change.";
const TURNED_DOWN = "The approval was turned down.";
const STILL_TURNING_ON = "GoatCitadel is still turning this on. Check again in a moment.";

const failed = (message: string): InPlaceOutcome => ({ kind: "failed", message });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const refusedSignIn = (error: unknown) => isApiRequestError(error) && (error.status === 401 || error.status === 403);

/**
 * A change that has ended and can't be resumed. A change that is still being watched after it applied
 * ("monitoring") counts as open here: approvePlanInPlace reports it as done.
 */
export function hasEnded(plan: Pick<ChangePlanRecord, "status">): boolean {
  return plan.status === "completed" || plan.status === "applied" || STOPPED.has(plan.status);
}

/**
 * Takes a change from where it is to done in one call, doing only what Chat does by hand: confirm it, approve the
 * approval that belongs to this very change, then continue it. It reads the change fresh each round, so it also
 * resumes one that is already part way. Anything it can't do for the operator is handed back as "elsewhere".
 */
export async function approvePlanInPlace(planId: string, workspaceId: string): Promise<InPlaceOutcome> {
  try {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const result = await runRound(planId, workspaceId);
      if (typeof result === "object") return result;
      if (result === "wait" && round < MAX_ROUNDS) await pause(WAIT_MS);
    }
    return failed(STILL_TURNING_ON);
  } catch (error) {
    return failed(describeApiError(error).summary);
  }
}

async function runRound(planId: string, workspaceId: string): Promise<Round> {
  const context = { workspaceId };
  const fresh = await fetchChangePlan(planId, context);
  if (APPLIED.has(fresh.status)) return { kind: "completed", plan: fresh };
  if (STOPPED.has(fresh.status)) return failed(fresh.result?.summary ?? fresh.summary);
  const action = fresh.requiredAction;
  if (!action) return STILL_WORKING.has(fresh.status) ? "wait" : { kind: "elsewhere", plan: fresh };
  if (action.kind === "confirmation" && action.purpose !== "rollback") {
    await confirmChangePlan(planId, context, { expectedRevision: fresh.revision, actionNonce: action.actionNonce });
    return "again";
  }
  if (action.kind === "approval" && action.approvalId) {
    return approveOwnApproval(fresh, action, action.approvalId, workspaceId);
  }
  return { kind: "elsewhere", plan: fresh };
}

/** Approves only the approval this change asked for, and only after reading that it is for this change. */
async function approveOwnApproval(
  plan: ChangePlanRecord,
  action: ApprovalAction,
  approvalId: string,
  workspaceId: string,
): Promise<Round> {
  const approval = await fetchApproval(approvalId, { workspaceId });
  if (approval.kind !== "change_plan_effect" || approval.payload.planId !== plan.planId) return failed(ANOTHER_CHANGE);
  switch (approval.status) {
    case "pending":
      try {
        await resolveApproval(approvalId, "approve");
      } catch (error) {
        if (refusedSignIn(error)) return { kind: "elsewhere", plan, approvalId };
        throw error;
      }
      return "again";
    case "approved":
      await respondToChangePlan(
        plan.planId,
        { workspaceId },
        {
          expectedRevision: plan.revision,
          actionId: action.actionId,
          actionNonce: action.actionNonce,
          values: {},
        },
      );
      return "again";
    default:
      // Turned down, edited, or expired: an expired approval is a rejection, and nothing else may proceed.
      return failed(TURNED_DOWN);
  }
}

/**
 * Makes sure GoatCitadel may reach every host a channel needs. Any missing hosts go into the outbound allowlist as
 * their own change in the caller's workspace, which is approved in place like the channel's change. It does not use
 * the Settings save: that route plans in the default workspace and applies with the operator's approval skip, and
 * Turn on never takes the skip. A finished allowlist change is "allowed", never "completed": that word is for the
 * channel's own change.
 */
export async function ensureHostsAllowed(
  hosts: readonly string[],
  workspaceId: string,
): Promise<{ kind: "allowed" } | InPlaceOutcome> {
  if (hosts.length === 0) return { kind: "allowed" };
  try {
    const settings = await fetchSettings();
    const missing = [...new Set(hosts)].filter(
      (host) => !isBaseUrlAllowlisted(`https://${host}/`, settings.networkAllowlist),
    );
    if (missing.length === 0) return { kind: "allowed" };
    const plan = await createChangePlan({
      workspaceId,
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: [...settings.networkAllowlist, ...missing] },
      },
      idempotencyKey: `messaging-allow-hosts:${[...missing].sort().join(",")}:${settings.revision}`,
    });
    const outcome = await approvePlanInPlace(plan.planId, workspaceId);
    return outcome.kind === "completed" ? { kind: "allowed" } : outcome;
  } catch (error) {
    return failed(describeApiError(error).summary);
  }
}

import type { ChangePlanRecord, ChannelSetupIssue } from "@goatcitadel/contracts";
import {
  acknowledgeChannelSetupTest,
  createChangePlan,
  fetchChangePlans,
  fetchChannelSetupDraft,
  testChannelSetupDraft,
  validateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { approvePlanInPlace, ensureHostsAllowed, hasEnded, type InPlaceOutcome } from "./approve-plan-in-place";

/**
 * What one click on Turn on came to. Besides the change's own outcomes:
 * - blocked: the setup isn't ready; each reason is plain words for the page to show.
 * - needs_cleanup_ack: the test message was sent but couldn't be removed; the operator must say that's fine first.
 */
export type TurnOnOutcome =
  | InPlaceOutcome
  | { kind: "blocked"; reasons: string[] }
  | { kind: "needs_cleanup_ack"; evidenceId: string };

interface DraftRef {
  workspaceId: string;
  draftId: string;
  catalogId: string;
}

type Blocked = Extract<TurnOnOutcome, { kind: "blocked" }>;
type Checked =
  | { kind: "ready"; draftVersion: number }
  | Blocked
  | Extract<TurnOnOutcome, { kind: "needs_cleanup_ack" }>;

const NOT_READY = "GoatCitadel couldn't confirm this setup is ready. Check it and try again.";
const MESSAGE_RECORD_MISSING = "GoatCitadel couldn't find the test message to confirm. Run the test again.";

const failed = (error: unknown): TurnOnOutcome => ({ kind: "failed", message: describeApiError(error).summary });
const blocked = (reasons: readonly string[]): Blocked => ({
  kind: "blocked",
  reasons: reasons.length > 0 ? [...reasons] : [NOT_READY],
});
const issueMessages = (issues: readonly Pick<ChannelSetupIssue, "level" | "message">[]) =>
  issues.filter((issue) => issue.level !== "info").map((issue) => issue.message);

/**
 * Turn on, from one click: the same calls Settings and Chat make by hand, in the same order, leaving the same
 * approval record. It first resumes an open change for this draft; otherwise it makes sure the hosts are allowed,
 * checks and tests the draft, and creates the change bound to the version it just tested. Nothing here finalizes the
 * draft itself: the change does that when it is applied.
 */
export async function turnOnChannelDraft(
  input: DraftRef & { requiredHosts: readonly string[] },
): Promise<TurnOnOutcome> {
  try {
    const open = await findOpenChange(input);
    if (open) return await approvePlanInPlace(open.planId, input.workspaceId);
    const hosts = await ensureHostsAllowed(input.requiredHosts, input.workspaceId);
    if (hosts.kind !== "allowed") return hosts;
    const checked = await checkSetup(input.draftId);
    if (checked.kind !== "ready") return checked;
    return await createAndApprove(input, checked.draftVersion);
  } catch (error) {
    return failed(error);
  }
}

/**
 * The operator said the test message left in the chat is fine. This records that for the test already run and goes
 * on to create and approve the change. It never tests again: a new test would send another message and void the
 * acknowledgement.
 */
export async function acknowledgeCleanupAndTurnOn(input: DraftRef & { evidenceId: string }): Promise<TurnOnOutcome> {
  try {
    const draft = await fetchChannelSetupDraft(input.draftId);
    const acknowledged = await acknowledgeChannelSetupTest(input.draftId, {
      expectedRevision: draft.revision,
      evidenceId: input.evidenceId,
      acknowledgement: "cleanup",
    });
    const eligibility = acknowledged.finalizationEligibility;
    // The change re-checks this when it is applied; a plain "no" here saves the operator a change that can't apply.
    if (eligibility && !eligibility.allowed) {
      return blocked(
        eligibility.blockingReasons.length > 0 ? eligibility.blockingReasons : issueMessages(acknowledged.issues),
      );
    }
    return await createAndApprove(input, acknowledged.draftRevision);
  } catch (error) {
    return failed(error);
  }
}

/** An open channel change for this very draft, if an earlier click or Settings already started one. */
async function findOpenChange({ workspaceId, draftId }: DraftRef): Promise<ChangePlanRecord | undefined> {
  const { items } = await fetchChangePlans({ workspaceId }, { limit: 50 });
  return items.find(
    (plan) =>
      plan.request.kind === "channel_connection" &&
      plan.target.ownerId === "channel_setup_draft" &&
      plan.target.resourceId === draftId &&
      !hasEnded(plan),
  );
}

/** Validates, then tests, the draft as it is now. Each step moves the draft's version, so each uses the one before. */
async function checkSetup(draftId: string): Promise<Checked> {
  const draft = await fetchChannelSetupDraft(draftId);
  const validation = await validateChannelSetupDraft(draftId, draft.revision);
  if (validation.status !== "ok") return blocked(issueMessages(validation.issues));
  const tested = await testChannelSetupDraft(draftId, validation.draftRevision);
  const eligibility = tested.finalizationEligibility;
  if (eligibility?.requiresAcknowledgement) {
    const evidenceId = eligibility.evidenceId ?? tested.evidenceId;
    if (!evidenceId) return blocked([MESSAGE_RECORD_MISSING]);
    return { kind: "needs_cleanup_ack", evidenceId };
  }
  if (!eligibility?.allowed) {
    const reasons = eligibility?.blockingReasons ?? [];
    return blocked(reasons.length > 0 ? reasons : issueMessages(tested.issues));
  }
  return { kind: "ready", draftVersion: tested.draftRevision };
}

async function createAndApprove(
  { workspaceId, draftId, catalogId }: DraftRef,
  draftVersion: number,
): Promise<InPlaceOutcome> {
  const plan = await createChangePlan({
    workspaceId,
    surface: "settings",
    request: { kind: "channel_connection", channelKind: catalogId, draftId },
    idempotencyKey: `messaging-turn-on:${draftId}:${draftVersion}`,
  });
  return approvePlanInPlace(plan.planId, workspaceId);
}

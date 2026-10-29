import {
  APPROVAL_EXPIRY_ACTOR_ID,
  SKILL_LIFECYCLE_APPROVAL_KIND,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type CapabilitySkillActionOutcome,
  type CapabilitySkillStateRequest,
  type DeploymentProfile,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import { ApprovalExpiredAfterCommitError } from "./approval-lifecycle-service.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";
import type { SkillLifecyclePendingApproval, SkillStateMutationOutcome } from "./skill-state-service.js";

/**
 * Why the operator's own switch applied without waiting in the Inbox, written as the note on the approval the skip
 * resolves. Only this file may use them (capability-skill-skip-guard.test.ts).
 */
export const OPERATOR_SKILL_SKIP_NOTES = {
  setting: "Applied without asking: your setting to skip approvals for your own changes is on.",
  tightening: "Applied without asking: turning a skill off, or pausing one that is on, only takes power away.",
} as const;

export type OperatorSkillSkipReason = keyof typeof OPERATOR_SKILL_SKIP_NOTES;

/** The approvals audit event, the one the Change Plan skip records too. */
const SKIP_AUDIT_EVENT = "operator_approval_skipped";

/** One reader per owner the switch goes through. None of them applies a change itself. */
export interface CapabilitySkillActionSources {
  /**
   * The skill state owner. It creates the skill's `skill.lifecycle` approval with the operator as requester, or
   * answers that nothing changes, and refuses a pinned skill or a stale revision. Only that approval's effect ever
   * applies the change.
   */
  setSkillState(
    skillId: string,
    state: SkillRuntimeState,
    authority: { expectedRevision: number; requesterId: string },
  ): Promise<SkillStateMutationOutcome>;
  /** The Inbox's own resolve, which records the decision and runs the approval's effect. */
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  /**
   * One approval as the Inbox reads it: who turned an earlier request down, and the state the skill was in when the
   * owner made this one (`preview.currentState`, written in the same commit as the change it binds).
   */
  readApproval(approvalId: string): Promise<Pick<ApprovalRequest, "status" | "resolvedBy" | "preview">>;
  /** One event on the approvals audit stream. */
  appendApprovalAudit(event: string, payload: Record<string, unknown>): Promise<void>;
  /** The install's deployment profile, read on every switch. */
  deploymentProfile(): DeploymentProfile;
  /** The operator's "skip approvals" setting (`settingsApprovalSkipEnabled`). */
  readApprovalSkipSetting(): Promise<boolean>;
}

export type CapabilitySkillActionStep = "approval_skip" | "current_state" | "resolve" | "audit";

/** Called with the real error of a failed step, so the answer can stay plain. */
export type CapabilitySkillActionFailureReporter = (step: CapabilitySkillActionStep, error: unknown) => void;

/**
 * The Capabilities Skills switch. It never changes a skill itself: it always asks the skill state owner, which creates
 * the usual approval, and when the operator's skip applies it approves that same approval at once, as the operator and
 * with the reason as its note, so the approval's own effect applies the change.
 */
export class CapabilitySkillActionsService {
  public constructor(
    private readonly sources: CapabilitySkillActionSources,
    private readonly reportFailure?: CapabilitySkillActionFailureReporter,
  ) {}

  public async setState(
    input: CapabilitySkillStateRequest & { actorId: string },
  ): Promise<CapabilitySkillActionOutcome> {
    // Switches are install-wide, like the skill state they change; the workspace only names where the tab is open.
    const outcome = await this.sources.setSkillState(input.skillId, input.state, {
      expectedRevision: input.expectedRevision,
      requesterId: input.actorId,
    });
    if (outcome.pendingApproval === null) return { status: "unchanged" };
    const { approvalId, status } = outcome.pendingApproval;
    // The owner's approval ids follow from the request, so the same request can hand back an approval already decided.
    if (status !== "pending") return await this.alreadyDecided(approvalId, status);
    const reason = await this.skipReason(approvalId, input.state);
    if (!reason) return { status: "waiting", approvalId };
    try {
      await this.sources.resolveApproval(approvalId, {
        decision: "approve",
        resolvedBy: input.actorId,
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES[reason],
      });
    } catch (error) {
      // It ran out of time as it was approved: the owner committed the expiry check's rejection, so nothing changes.
      if (error instanceof ApprovalExpiredAfterCommitError) return { status: "declined", approvalId, expired: true };
      // Nothing was approved, so the approval still waits in the Inbox for the operator.
      this.reportFailure?.("resolve", error);
      return { status: "waiting", approvalId };
    }
    await this.recordSkip({ approvalId, kind: SKILL_LIFECYCLE_APPROVAL_KIND, reason, actorId: input.actorId });
    return { status: "approved", approvalId };
  }

  /**
   * The answer for an approval this same request made earlier and someone already decided. Nothing is resolved and no
   * skip is recorded, since this request skipped nothing. Only an approved one applies: an edited skill approval is
   * withdrawn and its effect never runs, so it reads as declined, like a rejected one. The expiry check rejects as its
   * own actor, which is how an expired request is told apart.
   */
  private async alreadyDecided(
    approvalId: string,
    status: Exclude<SkillLifecyclePendingApproval["status"], "pending">,
  ): Promise<CapabilitySkillActionOutcome> {
    switch (status) {
      case "approved":
        return { status: "approved", approvalId };
      case "edited":
        return { status: "declined", approvalId, expired: false };
      case "rejected": {
        const approval = await this.sources.readApproval(approvalId);
        const expired = approval.status === "rejected" && approval.resolvedBy === APPROVAL_EXPIRY_ACTOR_ID;
        return { status: "declined", approvalId, expired };
      }
    }
  }

  /**
   * Why the skip applies, or undefined when the approval waits. `remote_hardened` always asks, and its setting is
   * never read (Ruling R3). Otherwise the setting covers every switch, and a switch that only takes power away applies
   * even without it.
   */
  private async skipReason(approvalId: string, state: SkillRuntimeState): Promise<OperatorSkillSkipReason | undefined> {
    const deploymentProfile = this.sources.deploymentProfile();
    if (await allowsOperatorApprovalSkip(deploymentProfile, () => this.readSkipSetting())) return "setting";
    if (deploymentProfile === "remote_hardened") return undefined;
    return (await this.onlyTakesPowerAway(approvalId, state)) ? "tightening" : undefined;
  }

  /**
   * Whether the switch only takes power away (Q1: A, Ruling R10). Turning a skill off always does: an off skill is
   * never used. Pausing does only when the skill is on: a paused skill can still be used when it is named or matched
   * confidently, so pausing an off skill gives power back. "On" is the state the owner recorded on this very approval,
   * in the same commit as the change it binds, so it is the state the change applies to. When that can't be read, the
   * approval waits.
   */
  private async onlyTakesPowerAway(approvalId: string, state: SkillRuntimeState): Promise<boolean> {
    if (state === "disabled") return true;
    if (state !== "sleep") return false;
    try {
      const approval = await this.sources.readApproval(approvalId);
      return approval.preview.currentState === "enabled";
    } catch (error) {
      this.reportFailure?.("current_state", error);
      return false;
    }
  }

  /** A setting that can't be read counts as off. */
  private async readSkipSetting(): Promise<boolean> {
    try {
      return await this.sources.readApprovalSkipSetting();
    } catch (error) {
      this.reportFailure?.("approval_skip", error);
      return false;
    }
  }

  /**
   * The approval itself already records who approved it and why. This line is the second record, in the stream the
   * Change Plan skip uses, so a failed append is logged and the approved change stands.
   */
  private async recordSkip(payload: {
    approvalId: string;
    kind: typeof SKILL_LIFECYCLE_APPROVAL_KIND;
    reason: OperatorSkillSkipReason;
    actorId: string;
  }): Promise<void> {
    try {
      await this.sources.appendApprovalAudit(SKIP_AUDIT_EVENT, payload);
    } catch (error) {
      this.reportFailure?.("audit", error);
    }
  }
}

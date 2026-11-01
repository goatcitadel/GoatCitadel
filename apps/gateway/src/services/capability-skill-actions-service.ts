import {
  NotFoundError,
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_LIFECYCLE_APPROVAL_KIND,
  ServiceUnavailableError,
  ValidationError,
  isTrustedGitForgeUrl,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type CapabilitySkillActionOutcome,
  type CapabilitySkillInstall,
  type CapabilitySkillOperationRequest,
  type CapabilitySkillReviewRequest,
  type CapabilitySkillStateRequest,
  type DeploymentProfile,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import { ApprovalExpiredAfterCommitError } from "./approval-lifecycle-service.js";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { buildCapabilitySkillInstall, SKILL_HUB_LIST_LIMIT } from "./capability-skill-install-projection.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";
import { PluginSkillNeedsInstallError, pluginSkillSource } from "./plugin-owned-refusal.js";
import type {
  CreateSkillHubOperatorApprovalInput,
  SkillHubOperatorApprovalSummary,
  SkillHubOperatorItem,
} from "./skill-hub-operator-service.js";
import type { SkillHubSourceReviewInput } from "./skill-hub-review-service.js";
import type { SkillStateMutationOutcome } from "./skill-state-service.js";

/**
 * Why the operator's own switch or install step applied without waiting for the operator's approval, written as the
 * note on the approval the skip resolves. Only this file may use them (capability-skill-skip-guard.test.ts).
 */
export const OPERATOR_SKILL_SKIP_NOTES = {
  setting: "Applied without asking: your setting to skip approvals for your own changes is on.",
  tightening: "Applied without asking: turning a skill off, or pausing one that is on, only takes power away.",
  plugin_uninstall:
    "Applied without asking: you uninstalled the plugin this skill came with, and removing it only takes power away.",
} as const;

export type OperatorSkillSkipReason = keyof typeof OPERATOR_SKILL_SKIP_NOTES;

/** The approvals audit event, the one the Change Plan skip records too. */
const SKIP_AUDIT_EVENT = "operator_approval_skipped";

const UNTRUSTED_GIT_HOST_MESSAGE = "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.";
const SOURCE_REFUSED_MESSAGE = "GoatCitadel can't check a skill from this source.";
const CHECK_FAILED_MESSAGE = "This skill didn't pass GoatCitadel's checks.";
const UNREADABLE_CHECK_MESSAGE = "This skill's check can't be read right now.";
/** The review's own refusal codes are upper snake case; anything else names the request field it came in on. */
const REVIEW_CODE = /^[A-Z][A-Z0-9_]*$/u;
/** The request fields a refused source comes in on: the address (unsafe, unreadable, not allowed) or the pack. */
const SOURCE_FIELDS: ReadonlySet<string> = new Set(["sourceRef", "packId"]);

/**
 * A source the check refused, with the review's own code as `reason` (or `UNTRUSTED_GIT_HOST`, or `SOURCE_REFUSED` for
 * the source itself) and a plain message. The owner's own error, which names Skill Hub, stays as `cause` for the log.
 */
export class CapabilitySkillSourceRefusedError extends Error {
  public constructor(
    public readonly reason: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CapabilitySkillSourceRefusedError";
  }
}

/** One reader per owner the switch and the install steps go through. None of them applies a change itself. */
export interface CapabilitySkillActionSources {
  /**
   * The skill state owner. It creates the skill's `skill.lifecycle` approval with the operator as requester, or
   * answers that nothing changes, and refuses a pinned skill or a stale revision. It hands back only an approval that
   * waits or was approved: after a decline it makes a fresh one. Only that approval's effect ever applies the change.
   */
  setSkillState(
    skillId: string,
    state: SkillRuntimeState,
    authority: { expectedRevision: number; requesterId: string },
  ): Promise<SkillStateMutationOutcome>;
  /** The Inbox's own resolve, which records the decision and runs the approval's effect. */
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  /**
   * One approval as the Inbox reads it: where it stands, and the state the skill was in when the owner made it
   * (`preview.currentState`, written in the same commit as the change it binds).
   */
  readApproval(approvalId: string): Promise<Pick<ApprovalRequest, "preview" | "status">>;
  /** One event on the approvals audit stream. */
  appendApprovalAudit(event: string, payload: Record<string, unknown>): Promise<void>;
  /** The install's deployment profile, read on every switch and step. */
  deploymentProfile(): DeploymentProfile;
  /** The operator's "skip approvals" setting (`settingsApprovalSkipEnabled`). */
  readApprovalSkipSetting(): Promise<boolean>;
  /**
   * Skill Hub's source review: it reads the source, checks it and keeps the result, writing nothing a skill runs from.
   * The same workspace and key hand back the same check (`replayed`).
   */
  reviewSkillHubSource(
    input: SkillHubSourceReviewInput,
  ): Promise<{ snapshot: { snapshotId: string }; replayed: boolean }>;
  /** Skill Hub's operator list: the workspace's newest checks, each with its approvals, settlements and guards. */
  listSkillHub(input: { workspaceId: string; limit: number }): Promise<{ items: readonly SkillHubOperatorItem[] }>;
  /**
   * Skill Hub's approval owner. It creates the step's `skill_hub.lifecycle` approval with the operator as requester, or
   * hands back the same request's pending or approved one, and refuses a step its guard doesn't allow (a 409 whose
   * `details.blockers` says why). After a decline it makes a fresh one. Only that approval's effect applies the step.
   */
  createSkillHubApproval(
    input: CreateSkillHubOperatorApprovalInput,
    options?: { pluginPass: { pluginId: string } },
  ): Promise<{ approval: Pick<SkillHubOperatorApprovalSummary, "approvalId" | "status"> }>;
  /** One Skill Hub check by its id, in any workspace: what source it read, so a plugin's skill is told apart. */
  findSkillHubSnapshot(
    snapshotId: string,
  ): Promise<{ sourceProvider: string; sourceRef: string; workspaceId: string } | undefined>;
  /** The plugin records, read through the Plugins tab's one store: which plugin lists a check as its skill. */
  listPluginRecords(): Promise<readonly PluginSkillListing[]>;
}

/** What a plugin record says about its skills, for a step on one of them. */
export type PluginSkillListing = Pick<StoredPlugin, "pluginId" | "name" | "workspaceId" | "state" | "pieces">;

/** One skill an uninstall removes: its check, and the revoke an earlier uninstall already asked for, if any. */
export interface PluginUninstallRevokeInput {
  workspaceId: string;
  /** The plugin skill's Skill Hub check, whose switched-on version is revoked. */
  snapshotId: string;
  pluginId: string;
  actorId: string;
  /** The revoke this plugin's uninstall asked for before, still waiting when it last read it. */
  knownApprovalId?: string;
}

/** `approved`: the revoke is approved and its effect applies it. `waiting`: it waits for the operator's approval. */
export interface PluginUninstallRevokeOutcome {
  status: "approved" | "waiting";
  approvalId: string;
}

/** A plugin whose skills may take their steps: its install is under way, or done. Never while it is uninstalled. */
const PLUGIN_STATES_TAKING_SKILL_STEPS: ReadonlySet<StoredPlugin["state"]> = new Set(["installing", "installed"]);

export type CapabilitySkillActionStep = "approval_skip" | "current_state" | "resolve" | "audit";

/** Called with the real error of a failed step, so the answer can stay plain. */
export type CapabilitySkillActionFailureReporter = (step: CapabilitySkillActionStep, error: unknown) => void;

/**
 * The Capabilities Skills switch, and the check and install steps for a new skill. Neither changes a skill itself: the
 * switch always asks the skill state owner, and each install step always asks Skill Hub's approval owner, which create
 * the usual approval; when the operator's skip applies, they approve that same approval at once, as the operator and
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
    // The owner's approval ids follow from the request, so the same request can hand back the one it already approved.
    // That one is never resolved again, and no second skip is recorded.
    if (status === "approved") return { status: "approved", approvalId };
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
      // Nothing was approved, so the change still waits for the operator's approval.
      this.reportFailure?.("resolve", error);
      return { status: "waiting", approvalId };
    }
    await this.recordSkip({ approvalId, kind: SKILL_LIFECYCLE_APPROVAL_KIND, reason, actorId: input.actorId });
    return { status: "approved", approvalId };
  }

  /**
   * Checks a source through Skill Hub's own review, then reads the check back from Skill Hub's list to say where its
   * install stands. A pack is reviewed exactly as the pack review does. A Git address is refused here unless it is
   * `https` on a trusted forge, and is always reviewed as `git_url`, so an address ending in `/skill.md` can't become a
   * hosted bundle and skip the review's own host check. A refusal keeps the review's code; nothing is asked or approved.
   */
  public async checkSource(
    input: CapabilitySkillReviewRequest & { actorId: string },
  ): Promise<{ install: CapabilitySkillInstall; replayed: boolean }> {
    const { workspaceId, idempotencyKey, actorId } = input;
    const review: SkillHubSourceReviewInput =
      input.source.kind === "pack"
        ? { workspaceId, packId: input.source.packId, idempotencyKey, actorId }
        : {
            workspaceId,
            sourceRef: trustedGitAddress(input.source.sourceRef),
            sourceType: "git_url",
            idempotencyKey,
            actorId,
          };
    let reviewed: Awaited<ReturnType<CapabilitySkillActionSources["reviewSkillHubSource"]>>;
    try {
      reviewed = await this.sources.reviewSkillHubSource(review);
    } catch (error) {
      throw refusedSource(error) ?? error;
    }
    const { items } = await this.sources.listSkillHub({ workspaceId, limit: SKILL_HUB_LIST_LIMIT });
    const item = items.find((candidate) => candidate.snapshotId === reviewed.snapshot.snapshotId);
    const install = item ? buildCapabilitySkillInstall(item) : undefined;
    // The newest check heads the list; only a retried, older one can fall out of it.
    if (!install) throw new ServiceUnavailableError(UNREADABLE_CHECK_MESSAGE);
    return { install, replayed: reviewed.replayed };
  }

  /**
   * Asks for one install step of a checked skill: Skill Hub's approval owner creates the step's approval, with the
   * operator as requester. The skip applies only for the operator's setting (never on `remote_hardened`); installing a
   * skill never only takes power away. It resolves that same approval through the Inbox's own resolve, so the
   * approval's effect applies the step. Hub approvals never expire, and a declined one is asked for afresh, so this
   * answers only `approved` or `waiting`. A step the guard refuses passes the owner's 409 through. A check that came
   * with a plugin takes its steps only while that plugin's record, in this workspace, is installing or installed and
   * lists it: then, and only then, the plugin's pass goes to Skill Hub's owner. Otherwise it is a 409 `PLUGIN_OWNED`.
   */
  public async requestStep(
    input: CapabilitySkillOperationRequest & { actorId: string },
  ): Promise<CapabilitySkillActionOutcome> {
    const step: CreateSkillHubOperatorApprovalInput = {
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      operationKind: input.operationKind,
      actorId: input.actorId,
    };
    const pluginPass = await this.pluginPassFor(input);
    const { approval } = pluginPass
      ? await this.sources.createSkillHubApproval(step, { pluginPass })
      : await this.sources.createSkillHubApproval(step);
    const { approvalId } = approval;
    // The same request hands back the approval it already made; an approved one is never resolved again.
    if (approval.status === "approved") return { status: "approved", approvalId };
    if (!(await allowsOperatorApprovalSkip(this.sources.deploymentProfile(), () => this.readSkipSetting()))) {
      return { status: "waiting", approvalId };
    }
    try {
      await this.sources.resolveApproval(approvalId, {
        decision: "approve",
        resolvedBy: input.actorId,
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.setting,
      });
    } catch (error) {
      // Nothing was approved, so the step still waits for the operator's approval.
      this.reportFailure?.("resolve", error);
      return { status: "waiting", approvalId };
    }
    await this.recordSkip({
      approvalId,
      kind: SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
      reason: "setting",
      actorId: input.actorId,
    });
    return { status: "approved", approvalId };
  }

  /**
   * Removes one switched-on skill a plugin's uninstall takes away: Skill Hub's approval owner creates the check's
   * `revoke` approval with the plugin's pass and the operator as requester, and this resolves that same approval as the
   * operator, so its own effect revokes the skill. Revoking only takes power away (Phase 3, Q1 A), so the skip setting
   * isn't read; `remote_hardened` always asks, and then it answers `waiting`. A revoke the uninstall already asked for
   * that still waits, or was approved, is answered again rather than asked for twice (Skill Hub finds a duplicate only
   * among a workspace's newest approvals). A failed resolve leaves it waiting.
   */
  public async revokeForPluginUninstall(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome> {
    const known = input.knownApprovalId ? await this.readKnownRevoke(input.knownApprovalId) : undefined;
    const approval =
      known ??
      (
        await this.sources.createSkillHubApproval(
          {
            workspaceId: input.workspaceId,
            snapshotId: input.snapshotId,
            operationKind: "revoke",
            actorId: input.actorId,
          },
          { pluginPass: { pluginId: input.pluginId } },
        )
      ).approval;
    const { approvalId } = approval;
    if (approval.status === "approved") return { status: "approved", approvalId };
    if (this.sources.deploymentProfile() === "remote_hardened") return { status: "waiting", approvalId };
    try {
      await this.sources.resolveApproval(approvalId, {
        decision: "approve",
        resolvedBy: input.actorId,
        resolutionNote: OPERATOR_SKILL_SKIP_NOTES.plugin_uninstall,
      });
    } catch (error) {
      // Nothing was approved, so the revoke still waits for the operator's approval.
      this.reportFailure?.("resolve", error);
      return { status: "waiting", approvalId };
    }
    await this.recordSkip({
      approvalId,
      kind: SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
      reason: "plugin_uninstall",
      actorId: input.actorId,
    });
    return { status: "approved", approvalId };
  }

  /** A revoke asked for before, while it still waits or once approved; undefined once it was refused or is gone. */
  private async readKnownRevoke(
    approvalId: string,
  ): Promise<{ approvalId: string; status: "pending" | "approved" } | undefined> {
    let status: ApprovalRequest["status"];
    try {
      ({ status } = await this.sources.readApproval(approvalId));
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    return status === "pending" || status === "approved" ? { approvalId, status } : undefined;
  }

  /**
   * The plugin's pass for a step on its skill, or undefined for any other check (and for one this workspace doesn't
   * have, which Skill Hub's owner refuses as not found). Only a record that is installing or installed, in this
   * workspace, and lists the check as one of its skill pieces gives it; anything else is refused before any approval.
   */
  private async pluginPassFor(
    input: Pick<CapabilitySkillOperationRequest, "workspaceId" | "snapshotId">,
  ): Promise<{ pluginId: string } | undefined> {
    const snapshot = await this.sources.findSkillHubSnapshot(input.snapshotId);
    if (!snapshot || snapshot.workspaceId !== input.workspaceId) return undefined;
    const source = pluginSkillSource(snapshot);
    if (!source) return undefined;
    const listing = (await this.sources.listPluginRecords()).find(
      (plugin) =>
        plugin.pluginId === source.pluginId &&
        plugin.workspaceId === input.workspaceId &&
        PLUGIN_STATES_TAKING_SKILL_STEPS.has(plugin.state) &&
        plugin.pieces.some((piece) => piece.kind === "skill" && piece.skillSnapshotId === input.snapshotId),
    );
    if (!listing) throw new PluginSkillNeedsInstallError(source.pluginId);
    return { pluginId: listing.pluginId };
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
    kind: typeof SKILL_LIFECYCLE_APPROVAL_KIND | typeof SKILL_HUB_LIFECYCLE_APPROVAL_KIND;
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

/**
 * The address, when it is `https` on one of the forges the review trusts for Git (exact lower-case host, no `www.`,
 * default port). Anything else is refused before the review reads it.
 */
function trustedGitAddress(sourceRef: string): string {
  let url: URL | undefined;
  try {
    url = new URL(sourceRef);
  } catch {
    url = undefined;
  }
  if (!url || !isTrustedGitForgeUrl(url)) {
    throw new CapabilitySkillSourceRefusedError("UNTRUSTED_GIT_HOST", UNTRUSTED_GIT_HOST_MESSAGE);
  }
  return sourceRef;
}

/**
 * The review's refusal of a source (its `ValidationError`, whose field is the review's own code, or the request field
 * the source came in on) in plain words with that code kept. Anything else, such as a key reused for other material,
 * isn't a refusal of the source and passes through.
 */
function refusedSource(error: unknown): CapabilitySkillSourceRefusedError | undefined {
  if (!(error instanceof ValidationError)) return undefined;
  const field = error.details?.field;
  if (typeof field !== "string") return undefined;
  if (SOURCE_FIELDS.has(field)) {
    return new CapabilitySkillSourceRefusedError("SOURCE_REFUSED", SOURCE_REFUSED_MESSAGE, { cause: error });
  }
  return REVIEW_CODE.test(field)
    ? new CapabilitySkillSourceRefusedError(field, CHECK_FAILED_MESSAGE, { cause: error })
    : undefined;
}

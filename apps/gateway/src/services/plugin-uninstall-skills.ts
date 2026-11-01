import type { StoredPluginPiece } from "./capability-plugin-store.js";
import type { ApprovalReading, PluginSkillCheck } from "./plugin-skill-checks.js";

// What an uninstall does with one of a plugin's skills, decided from its check alone. A skill counts as removed only once
// its check reads revoked (R62), or when nothing of it was ever switched on. The uninstall plan applies the decision.

/** A skill's own install step that still waits for its approval: an approved one could switch the skill on. */
export interface PendingSkillStep {
  approvalId: string;
  operation: "install_inactive" | "activate";
}

/**
 * Why a skill's removal isn't done yet: its revoke waits for approval, its approved revoke is still being applied, its
 * own step waits for the operator's decision (only declining it lets the uninstall finish), or its own step is under way.
 */
export type SkillWaitReason = "revoke" | "removing" | "decision" | "own_step";

export type SkillRemovalDecision =
  /** Done with: revoked, or never switched on. `counted` when something of it was installed. */
  | { kind: "removed"; counted: boolean; skillId?: string }
  /** Not done yet, for the reason given (`SkillWaitReason`). */
  | { kind: "waiting"; reason: SkillWaitReason; waiting?: NonNullable<StoredPluginPiece["waiting"]> }
  /**
   * Switched on: ask for its revoke. `knownApprovalId` is a revoke already asked for that may still wait; `staleApprovalId`
   * is one that was approved and ended without revoking the skill, so being handed it back means it can't be revoked.
   */
  | { kind: "revoke"; knownApprovalId?: string; staleApprovalId?: string };

/**
 * The decision for one skill piece of an uninstalled plugin, from its check, any own step still waiting, and, for an
 * approved revoke its check shows unsettled, whether that revoke's work is still being done.
 */
export function decideSkillRemoval(
  piece: StoredPluginPiece,
  check: PluginSkillCheck | undefined,
  pendingStep: PendingSkillStep | undefined,
  revokeEffects?: ApprovalReading["effects"],
): SkillRemovalDecision {
  // Never checked: nothing was installed from it.
  if (!piece.skillSnapshotId) return { kind: "removed", counted: false };
  // A check that can't be read is never taken as removed.
  if (!check) throw new Error("Its check can't be read right now.");
  if (check.revoked) return { kind: "removed", counted: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
  // A step waiting for its approval, or an approved one still applying, could switch it on after the record is gone. A
  // waiting one never settles by itself (R61: the uninstall never declines it), so it is the operator's decision.
  const ownStep = pendingStep ?? pendingOwnStep(check);
  if (ownStep) return { kind: "waiting", reason: "decision", waiting: ownStep };
  if (check.step === "installing" || check.step === "switching_on") return { kind: "waiting", reason: "own_step" };
  if (check.version === "switched_on" && check.skillId) return revokeDecision(piece, check, revokeEffects);
  // Installed and never switched on: inert, as nothing can switch it on once no plugin lists it.
  if (check.version === "installed_off") {
    return { kind: "removed", counted: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
  }
  // Only checked, never installed.
  return { kind: "removed", counted: false };
}

/** Whether a check names something installed: a version, switched on or not, or one already revoked. */
export function hasInstalledSkill(check: PluginSkillCheck): boolean {
  return check.version !== "none" || check.revoked;
}

/** Whether a check may have something installed by the time a plan applies: installed, or its own step under way. */
export function mayHaveInstalledSkill(check: PluginSkillCheck, pendingStep: PendingSkillStep | undefined): boolean {
  return (
    hasInstalledSkill(check) ||
    pendingStep !== undefined ||
    pendingOwnStep(check) !== undefined ||
    check.step === "installing" ||
    check.step === "switching_on"
  );
}

/**
 * Whether this approved revoke ended without revoking the skill: its check shows it settled (blocked, or applied with the
 * skill still on), or its work failed, or finished with no settlement to show.
 */
export function revokeEndedUnrevoked(
  check: PluginSkillCheck | undefined,
  approvalId: string,
  effects: ApprovalReading["effects"] | undefined,
): boolean {
  if (!check || check.revoked) return false;
  const settled = check.revokeApproval?.approvalId === approvalId && check.revokeApproval.settled !== undefined;
  return settled || effects === "failed" || effects === "done";
}

function pendingOwnStep(check: PluginSkillCheck): PendingSkillStep | undefined {
  if (check.pendingApprovals.activate) return { approvalId: check.pendingApprovals.activate, operation: "activate" };
  if (check.pendingApprovals.install_inactive) {
    return { approvalId: check.pendingApprovals.install_inactive, operation: "install_inactive" };
  }
  return undefined;
}

/**
 * A switched-on skill's revoke. An approved revoke whose work is still being done is waited for and never asked for
 * twice. One that ended without revoking the skill (settled, failed, or done with no settlement) is stale: a fresh
 * revoke is asked for.
 */
function revokeDecision(
  piece: StoredPluginPiece,
  check: PluginSkillCheck,
  revokeEffects: ApprovalReading["effects"] | undefined,
): SkillRemovalDecision {
  const latest = check.revokeApproval;
  const ended = latest?.status === "approved" && revokeEndedUnrevoked(check, latest.approvalId, revokeEffects);
  if (latest?.status === "approved" && !ended) {
    return {
      kind: "waiting",
      reason: "removing",
      waiting: { approvalId: latest.approvalId, operation: "revoke" },
    };
  }
  const known = latest?.status === "pending" ? latest.approvalId : knownRevoke(piece);
  return {
    kind: "revoke",
    ...(known ? { knownApprovalId: known } : {}),
    ...(latest?.status === "approved" ? { staleApprovalId: latest.approvalId } : {}),
  };
}

function knownRevoke(piece: StoredPluginPiece): string | undefined {
  return piece.waiting?.operation === "revoke" ? piece.waiting.approvalId : undefined;
}

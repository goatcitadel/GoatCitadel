import type { StoredPluginPiece } from "./capability-plugin-store.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";

// What an uninstall does with one of a plugin's skills, decided from its check alone. A skill counts as removed only once
// its check reads revoked (R62), or when nothing of it was ever switched on. The uninstall plan applies the decision.

/** A skill's own install step that still waits for its approval: an approved one could switch the skill on. */
export interface PendingSkillStep {
  approvalId: string;
  operation: "install_inactive" | "activate";
}

/** Why a skill's removal isn't done yet. */
export type SkillWaitReason = "revoke" | "removing" | "own_step";

export type SkillRemovalDecision =
  /** Done with: revoked, or never switched on. `counted` when something of it was installed. */
  | { kind: "removed"; counted: boolean; skillId?: string }
  /** Not done: its revoke waits for approval, its approved revoke is still being applied, or its own step is under way. */
  | { kind: "waiting"; reason: SkillWaitReason; waiting?: NonNullable<StoredPluginPiece["waiting"]> }
  /**
   * Switched on: ask for its revoke. `knownApprovalId` is a revoke already asked for that may still wait; `staleApprovalId`
   * is one that was approved and settled without revoking the skill, so being handed it back means it can't be revoked.
   */
  | { kind: "revoke"; knownApprovalId?: string; staleApprovalId?: string };

/** The decision for one skill piece of an uninstalled plugin, from its check and any own step still waiting. */
export function decideSkillRemoval(
  piece: StoredPluginPiece,
  check: PluginSkillCheck | undefined,
  pendingStep: PendingSkillStep | undefined,
): SkillRemovalDecision {
  // Never checked: nothing was installed from it.
  if (!piece.skillSnapshotId) return { kind: "removed", counted: false };
  // A check that can't be read is never taken as removed.
  if (!check) throw new Error("Its check can't be read right now.");
  if (check.revoked) return { kind: "removed", counted: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
  // An approved step still applying, or one waiting for its approval, could switch it on after the record is gone.
  const ownStep = pendingStep ?? pendingOwnStep(check);
  if (ownStep) return { kind: "waiting", reason: "own_step", waiting: ownStep };
  if (check.step === "installing" || check.step === "switching_on") return { kind: "waiting", reason: "own_step" };
  if (check.version === "switched_on" && check.skillId) return revokeDecision(piece, check);
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

function pendingOwnStep(check: PluginSkillCheck): PendingSkillStep | undefined {
  if (check.pendingApprovals.activate) return { approvalId: check.pendingApprovals.activate, operation: "activate" };
  if (check.pendingApprovals.install_inactive) {
    return { approvalId: check.pendingApprovals.install_inactive, operation: "install_inactive" };
  }
  return undefined;
}

/**
 * A switched-on skill's revoke. An approved revoke whose effect hasn't settled is still being applied, so it is waited
 * for and never asked for twice. One that settled without revoking the skill is stale: a fresh revoke is asked for.
 */
function revokeDecision(piece: StoredPluginPiece, check: PluginSkillCheck): SkillRemovalDecision {
  const latest = check.revokeApproval;
  if (latest?.status === "approved" && latest.settled === undefined) {
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

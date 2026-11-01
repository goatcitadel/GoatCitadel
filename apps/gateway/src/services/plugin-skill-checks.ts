import type {
  ApprovalRequest,
  CapabilitySkillInstallStep,
  SkillHubOperationKind,
  SkillHubOperationSettlementDisposition,
} from "@goatcitadel/contracts";
import { skillHubInstallStep } from "./capability-skill-install-projection.js";
import { SKILL_HUB_OPERATOR_MAX_ITEMS, type SkillHubOperatorItem } from "./skill-hub-operator-service.js";

// A plugin's skill pieces are read by their checks' ids, never through a workspace's newest checks: a newer check never
// pushes a plugin's skill out of view (R37's carry). The plugin's detail and list read each piece from this, and the
// uninstall reads it to know what it can revoke and what a reinstall would be refused.

/** What a plugin's skill piece's check says now. */
export interface PluginSkillCheck {
  snapshotId: string;
  /** The skill's name as the check reads it. */
  title: string;
  /** The skill's id, once a version of it is installed, switched on or not. */
  skillId?: string;
  /** `switched_on`: a version from this check is active. `installed_off`: one is installed, not switched on. */
  version: "none" | "installed_off" | "switched_on";
  /** The version installed from this check was revoked: the AI can't use it, and it can't be switched on again. */
  revoked: boolean;
  /** The approval each step still waits for, by the step. */
  pendingApprovals: Partial<Record<SkillHubOperationKind, string>>;
  /**
   * The newest revoke approval among the workspace's newest approvals: where it stands, and how its effect settled once
   * it did (`applied`, or `blocked` when it didn't revoke). Absent when none is in that window.
   */
  revokeApproval?: {
    approvalId: string;
    status: ApprovalRequest["status"];
    settled?: SkillHubOperationSettlementDisposition;
  };
  /** Whether installing it is allowed now, and the codes that refuse it (a reinstall's included). */
  installInactive: { allowed: boolean; blockers: string[] };
  /** Where its install is, read exactly as the Skills tab reads a check. */
  step: CapabilitySkillInstallStep;
}

/** A workspace's checks by their ids: Skill Hub's operator owner's per-id read. */
export type FindSkillHubChecks = (input: {
  workspaceId: string;
  snapshotIds: readonly string[];
}) => Promise<readonly SkillHubOperatorItem[]>;

/** One check, as a plugin's skill piece reads it. */
export function pluginSkillCheck(item: SkillHubOperatorItem): PluginSkillCheck {
  const step = skillHubInstallStep(item);
  // Installed once a version exists, or once switching it on settled (the Skills tab's own `installedSkillId` rule).
  const installed = item.candidate !== undefined || item.runtime.activeVersion || step === "done";
  const revoke = item.approvals.revoke;
  const pendingApprovals: Partial<Record<SkillHubOperationKind, string>> = {};
  for (const [kind, approval] of Object.entries(item.approvals) as Array<
    [SkillHubOperationKind, SkillHubOperatorItem["approvals"][SkillHubOperationKind]]
  >) {
    if (approval?.status === "pending") pendingApprovals[kind] = approval.approvalId;
  }
  return {
    snapshotId: item.snapshotId,
    title: item.title,
    ...(installed && item.skillId ? { skillId: item.skillId } : {}),
    version: item.runtime.activeVersion ? "switched_on" : item.candidate ? "installed_off" : "none",
    revoked: item.candidate?.lifecycleState === "revoked",
    pendingApprovals,
    ...(revoke
      ? {
          revokeApproval: {
            approvalId: revoke.approvalId,
            status: revoke.status,
            ...(revoke.settlement ? { settled: revoke.settlement.disposition } : {}),
          },
        }
      : {}),
    installInactive: {
      allowed: item.actions.install_inactive.allowed,
      blockers: [...item.actions.install_inactive.blockers],
    },
    step,
  };
}

/**
 * The checks with these ids in one workspace, by id, read at most Skill Hub's largest page of ids at a time. A check
 * that isn't there (or is another workspace's) is left out, and a read that fails throws: a caller reads a piece it
 * can't find as `unknown`, never as added.
 */
export async function readPluginSkillChecks(
  findChecks: FindSkillHubChecks,
  workspaceId: string,
  snapshotIds: readonly string[],
): Promise<ReadonlyMap<string, PluginSkillCheck>> {
  const ids = [...new Set(snapshotIds)];
  const checks = new Map<string, PluginSkillCheck>();
  for (let start = 0; start < ids.length; start += SKILL_HUB_OPERATOR_MAX_ITEMS) {
    const items = await findChecks({
      workspaceId,
      snapshotIds: ids.slice(start, start + SKILL_HUB_OPERATOR_MAX_ITEMS),
    });
    for (const item of items) checks.set(item.snapshotId, pluginSkillCheck(item));
  }
  return checks;
}

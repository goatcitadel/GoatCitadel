import fs from "node:fs/promises";
import path from "node:path";
import { composeCapabilityPlugins, type CapabilityPluginsOwners } from "./capability-plugins-composition.js";
import type { CapabilityPluginsRouteService } from "./capability-plugins-route-service.js";
import {
  composeCapabilitySkills,
  type CapabilitySkills,
  type CapabilitySkillsOwners,
} from "./capability-skills-composition.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";
import { createRemovalCleanupCounter } from "./skill-hub-cleanup-leftovers.js";
import { createSkillHubLifecycleFilesystem } from "./skill-hub-lifecycle-filesystem-composition.js";

// The Skills tab and the Plugins tab, wired together. A plugin's skills take the Skills tab's own install steps, which
// read the plugin records, and the Skills tab marks a skill a plugin brought (or an uninstall removed); the plugin's
// detail reads its skills' checks, and its uninstall revokes them through the Skills tab's one bound revoke. The
// Plugins composition creates the one plugin store, so the Skills tab reads the records through it.

/** Each tab's owners, once: the install's folders and profile come from its config, and Skill Hub serves both tabs. */
export interface CapabilitySkillsAndPluginsOwners
  extends
    Omit<
      CapabilitySkillsOwners,
      "deploymentProfile" | "rootDir" | "pluginRecords" | "skillHub" | "skillHubSettlements" | "skillHubLineages"
    >,
    Omit<
      CapabilityPluginsOwners,
      "skillHub" | "revokeSkill" | "readOperatorApprovalSkip" | "readLeftoverRemoval" | "records"
    > {
  skillHub: CapabilitySkillsOwners["skillHub"] & CapabilityPluginsOwners["skillHub"];
  /**
   * The plugin records' storage, which also holds Skill Hub's settlements the Skills tab reads a removal's outcome from,
   * and the Journey a removal's failed cleanups are read from (one install-wide read).
   */
  records: CapabilityPluginsOwners["records"] & {
    readonly skillHubOperations: CapabilitySkillsOwners["skillHubSettlements"] & {
      listAppliedRemovalCandidateIds(workspaceId: string): Promise<readonly string[]>;
    };
    readonly candidateSkillVersions: {
      list(limit: number): ReturnType<CapabilitySkillsOwners["skillHubLineages"]["listVersions"]>;
    };
    readonly governanceJourneyEvents: {
      listSkillHubRemovalCleanupFailures(): Promise<ReadonlyArray<{ summary: Record<string, unknown> }>>;
    };
  };
}

export interface CapabilitySkillsAndPlugins {
  capabilitySkills: CapabilitySkills & {
    /** System › Health's read: applied removals whose moved-aside folder is still in the skills folder. */
    removalCleanup: { countLeftovers(): Promise<number> };
  };
  capabilityPlugins: CapabilityPluginsRouteService;
}

export function composeCapabilitySkillsAndPlugins(
  owners: CapabilitySkillsAndPluginsOwners,
): CapabilitySkillsAndPlugins {
  // The Skills tab is wired just below the Plugins tab; only an uninstall plan's apply revokes, long after both are.
  const wired: { skills?: CapabilitySkills } = {};
  const plugins = composeCapabilityPlugins({
    ...owners,
    revokeSkill: (input) => {
      if (!wired.skills) throw new Error("The Skills tab isn't wired yet, so a plugin's skill can't be revoked.");
      return wired.skills.revokeSkillForPluginUninstall(input);
    },
    // The same skip the Skills tab and the plugin plans follow, read live: never on remote_hardened, whose setting
    // is never read.
    // The Skills tab's one rule for a never-switched-on left-over, so the plugin check offers exactly what it accepts.
    readLeftoverRemoval: (workspaceId, skillId) => {
      if (!wired.skills) throw new Error("The Skills tab isn't wired yet, so a left-over skill can't be read.");
      return wired.skills.actions.leftoverRemoval(workspaceId, skillId);
    },
    readOperatorApprovalSkip: () =>
      allowsOperatorApprovalSkip(owners.config.assistant.deploymentProfile, () =>
        owners.features.isFeatureEnabled("settingsApprovalSkipEnabled"),
      ),
  });
  const capabilitySkills = composeCapabilitySkills({
    ...owners,
    // The live config: a deployment profile is read on every list and step, never kept.
    deploymentProfile: () => owners.config.assistant.deploymentProfile,
    rootDir: owners.config.rootDir,
    skillHubSettlements: owners.records.skillHubOperations,
    skillHubLineages: {
      // The same window Skill Hub's own operator list reads its candidates from.
      listVersions: () => owners.records.candidateSkillVersions.list(500),
      listRemovedCandidateIds: (workspaceId) =>
        owners.records.skillHubOperations.listAppliedRemovalCandidateIds(workspaceId),
    },
    pluginRecords: { list: () => plugins.readPlugins(), listRemoved: () => plugins.readRemovedPlugins() },
  });
  wired.skills = capabilitySkills;
  // The same runtime skills root Skill Hub's removals move folders aside in, read through the confined filesystem.
  const rootDir = path.resolve(owners.config.rootDir);
  const filesystem = createSkillHubLifecycleFilesystem(rootDir, {});
  const skillsRoot = path.join(rootDir, "skills", "extra");
  const { governanceJourneyEvents } = owners.records;
  const removalCleanup = {
    countLeftovers: createRemovalCleanupCounter(
      () => governanceJourneyEvents.listSkillHubRemovalCleanupFailures(),
      // A plain read: a missing skills folder answers none and is never created by this read.
      async () => (await fs.stat(skillsRoot).catch(() => undefined))?.isDirectory() === true,
      (folder) => filesystem.pathKind(skillsRoot, folder, new AbortController().signal),
      skillsRoot,
    ),
  };
  return { capabilitySkills: { ...capabilitySkills, removalCleanup }, capabilityPlugins: plugins.routes };
}

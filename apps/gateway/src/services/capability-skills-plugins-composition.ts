import { composeCapabilityPlugins, type CapabilityPluginsOwners } from "./capability-plugins-composition.js";
import type { CapabilityPluginsRouteService } from "./capability-plugins-route-service.js";
import {
  composeCapabilitySkills,
  type CapabilitySkills,
  type CapabilitySkillsOwners,
} from "./capability-skills-composition.js";

// The Skills tab and the Plugins tab, wired together. A plugin's skills take the Skills tab's own install steps, which
// read the plugin records, and the Skills tab marks a skill a plugin brought; the plugin's detail reads its skills'
// checks. The Plugins composition creates the one plugin store, so the Skills tab reads the records through it.

/** Each tab's owners, once: the install's folders and profile come from its config, and Skill Hub serves both tabs. */
export interface CapabilitySkillsAndPluginsOwners
  extends
    Omit<CapabilitySkillsOwners, "deploymentProfile" | "rootDir" | "pluginRecords" | "skillHub">,
    Omit<CapabilityPluginsOwners, "skillHub"> {
  skillHub: CapabilitySkillsOwners["skillHub"] & CapabilityPluginsOwners["skillHub"];
}

export interface CapabilitySkillsAndPlugins {
  capabilitySkills: CapabilitySkills;
  capabilityPlugins: CapabilityPluginsRouteService;
}

export function composeCapabilitySkillsAndPlugins(
  owners: CapabilitySkillsAndPluginsOwners,
): CapabilitySkillsAndPlugins {
  const plugins = composeCapabilityPlugins(owners);
  const capabilitySkills = composeCapabilitySkills({
    ...owners,
    // The live config: a deployment profile is read on every list and step, never kept.
    deploymentProfile: () => owners.config.assistant.deploymentProfile,
    rootDir: owners.config.rootDir,
    pluginRecords: { list: () => plugins.readPlugins() },
  });
  return { capabilitySkills, capabilityPlugins: plugins.routes };
}

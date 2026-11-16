import { pluginSkillSource } from "./plugin-owned-refusal.js";

/**
 * Whether a Skill Hub check names a skill an uninstalled plugin left behind, the one rule every place a never-switched-on
 * left-over is offered or removed shares (Skill Hub's guard, the removal request, the plugin check, the removal's effect).
 * The check must have come with a plugin; a tombstone of that very plugin must name the skill; and no record of that
 * plugin may exist now (installing, installed or uninstalling). Undefined when it holds.
 */
export type LeftoverPluginBlock = "not_left_by_plugin" | "plugin_installed";

export interface LeftoverPluginRecords {
  /** Every plugin record there is now, in any state. */
  plugins: ReadonlyArray<{ pluginId: string }>;
  /** The uninstalled plugins remembered, with the skill ids each uninstall removed. */
  removed: ReadonlyArray<{ pluginId: string; skillIds: readonly string[] }>;
}

export function leftoverPluginBlock(
  snapshot: { sourceProvider: string; sourceRef: string },
  skillId: string,
  records: LeftoverPluginRecords,
): LeftoverPluginBlock | undefined {
  const pluginId = pluginSkillSource(snapshot)?.pluginId;
  if (!pluginId) return "not_left_by_plugin";
  const tombstoned = records.removed.some(
    (tombstone) => tombstone.pluginId === pluginId && tombstone.skillIds.includes(skillId),
  );
  if (!tombstoned) return "not_left_by_plugin";
  return records.plugins.some((plugin) => plugin.pluginId === pluginId) ? "plugin_installed" : undefined;
}

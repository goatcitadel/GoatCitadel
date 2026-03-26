import type { EffectiveToolPolicy, ToolPolicyConfig } from "@goatcitadel/contracts";
import { matchesToolPattern } from "./tool-patterns.js";

export function resolveEffectivePolicy(config: ToolPolicyConfig, agentId = ""): EffectiveToolPolicy {
  const profileName = config.agents[agentId]?.tools?.profile ?? config.tools.profile;
  const profileTools = new Set(config.profiles[profileName] ?? []);

  const allowSet = new Set<string>([
    ...config.tools.allow,
    ...(config.agents[agentId]?.tools?.allow ?? []),
  ]);

  const denySet = new Set<string>([
    ...config.tools.deny,
    ...(config.agents[agentId]?.tools?.deny ?? []),
  ]);

  const effectiveTools = new Set<string>();

  if (profileTools.has("*")) {
    effectiveTools.add("*");
  } else {
    for (const tool of profileTools) {
      effectiveTools.add(tool);
    }
  }

  for (const tool of allowSet) {
    effectiveTools.add(tool);
  }

  if (!effectiveTools.has("*")) {
    for (const tool of [...effectiveTools]) {
      if (matchesPatternSet(denySet, tool)) {
        effectiveTools.delete(tool);
      }
    }
  }

  return {
    profile: profileName,
    allowSet,
    denySet,
    effectiveTools,
  };
}

export function isToolAllowed(policy: EffectiveToolPolicy, toolName: string): boolean {
  if (matchesPatternSet(policy.denySet, toolName)) {
    return false;
  }

  return policy.effectiveTools.has("*") || matchesPatternSet(policy.effectiveTools, toolName);
}

function matchesPatternSet(values: Iterable<string>, toolName: string): boolean {
  for (const value of values) {
    if (matchesToolPattern(value, toolName)) {
      return true;
    }
  }
  return false;
}

import type {
  EffectiveToolPolicy,
  LocalOperatorOverrideRecord,
  PermissionProfileRecord,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { matchesToolPattern } from "./tool-patterns.js";

export function resolveEffectivePolicy(
  config: ToolPolicyConfig,
  agentId = "",
  permissionProfile?: PermissionProfileRecord,
  localOperatorOverride?: LocalOperatorOverrideRecord,
): EffectiveToolPolicy {
  const activeLocalOperatorOverride = isActiveLocalOperatorOverride(localOperatorOverride)
    ? localOperatorOverride
    : undefined;
  const profileName =
    permissionProfile?.legacyToolProfile ?? config.agents[agentId]?.tools?.profile ?? config.tools.profile;
  const profileTools = activeLocalOperatorOverride
    ? new Set<string>(["*"])
    : permissionProfile
      ? new Set(permissionProfile.toolPatterns)
      : profileName
        ? new Set(config.profiles?.[profileName] ?? [])
        : new Set<string>(["*"]);
  const approvalMode = activeLocalOperatorOverride
    ? "bypass"
    : (permissionProfile?.approvalMode ??
      config.tools.approvalMode ??
      (profileName === "danger" ? "bypass" : "approve_risky"));

  const allowSet = new Set<string>([
    ...config.tools.allow,
    ...(config.agents[agentId]?.tools?.allow ?? []),
    ...(permissionProfile?.allow ?? []),
  ]);

  const denySet = new Set<string>([
    ...config.tools.deny,
    ...(config.agents[agentId]?.tools?.deny ?? []),
    ...(permissionProfile?.deny ?? []),
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
    approvalMode,
    profile: profileName,
    permissionProfileId: permissionProfile?.profileId,
    permissionProfileLabel: permissionProfile?.label,
    localOperatorOverrideId: activeLocalOperatorOverride?.overrideId,
    allowSet,
    denySet,
    effectiveTools,
    readAccessMode: stricterReadAccessMode(config.sandbox.readAccessMode, permissionProfile?.readAccessMode),
  };
}

function isActiveLocalOperatorOverride(
  override: LocalOperatorOverrideRecord | undefined,
): override is LocalOperatorOverrideRecord {
  return Boolean(
    override &&
    override.status === "active" &&
    Number.isFinite(Date.parse(override.expiresAt)) &&
    Date.parse(override.expiresAt) > Date.now(),
  );
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

function stricterReadAccessMode(
  globalMode: ToolPolicyConfig["sandbox"]["readAccessMode"],
  profileMode: PermissionProfileRecord["readAccessMode"],
): PermissionProfileRecord["readAccessMode"] {
  const rank = { roots_only: 0, approval_required: 1, full_disk: 2 } as const;
  const global = globalMode ?? "roots_only";
  const profile = profileMode ?? global;
  return rank[profile] < rank[global] ? profile : global;
}

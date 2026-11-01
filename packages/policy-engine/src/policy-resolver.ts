import { toolNamesSwitchedOff } from "@goatcitadel/contracts";
import type {
  EffectiveToolPolicy,
  LocalOperatorOverrideRecord,
  PermissionProfileRecord,
  ToolApprovalMode,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { matchesToolPattern } from "./tool-patterns.js";

const APPROVAL_MODE_STRICTNESS: Record<ToolApprovalMode, number> = { bypass: 0, approve_risky: 1, approve_all: 2 };

/** A per-agent approval mode can only tighten the posture, never loosen it. */
function stricterApprovalMode(base: ToolApprovalMode, override: ToolApprovalMode | undefined): ToolApprovalMode {
  if (!override) return base;
  return APPROVAL_MODE_STRICTNESS[override] > APPROVAL_MODE_STRICTNESS[base] ? override : base;
}

export function resolveEffectivePolicy(
  config: ToolPolicyConfig,
  agentId = "",
  requestedPermissionProfile?: PermissionProfileRecord,
  localOperatorOverride?: LocalOperatorOverrideRecord,
): EffectiveToolPolicy {
  // Only an active profile contributes tools, allows, denies or posture; an
  // archived profile must never keep widening policy (fail closed).
  const permissionProfile = requestedPermissionProfile?.status === "active" ? requestedPermissionProfile : undefined;
  const activeLocalOperatorOverride = isActiveLocalOperatorOverride(localOperatorOverride)
    ? localOperatorOverride
    : undefined;
  const profileTools = activeLocalOperatorOverride
    ? new Set<string>(["*"])
    : permissionProfile
      ? new Set(permissionProfile.toolPatterns)
      : new Set<string>();
  const approvalMode: ToolApprovalMode = activeLocalOperatorOverride
    ? "bypass"
    : stricterApprovalMode(
        permissionProfile?.approvalMode ?? config.tools.approvalMode ?? "approve_risky",
        config.agents[agentId]?.tools?.approvalMode,
      );

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
    permissionProfileId: permissionProfile?.profileId,
    permissionProfileLabel: permissionProfile?.label,
    localOperatorOverrideId: activeLocalOperatorOverride?.overrideId,
    allowSet,
    denySet,
    effectiveTools,
    // Install-wide: read from `tools` only, so a per-agent `disabledGroups` can neither add nor lift a switch.
    switchedOffTools: toolNamesSwitchedOff(config.tools.disabledGroups),
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

/**
 * The config as the resolver reads it while plugins hold groups off: each held group is added to the operator's own
 * `tools.disabledGroups`, which is never written. A hand-edited switch that isn't a list adds nothing, as it switches
 * nothing off on its own. Core and unknown ids stay ignored, through the same `toolNamesSwitchedOff`.
 */
export function withHeldToolGroups(config: ToolPolicyConfig, heldGroupIds: readonly string[]): ToolPolicyConfig {
  if (heldGroupIds.length === 0) return config;
  const own: readonly string[] = Array.isArray(config.tools.disabledGroups) ? config.tools.disabledGroups : [];
  return { ...config, tools: { ...config.tools, disabledGroups: [...own, ...heldGroupIds] } };
}

export function isToolAllowed(policy: EffectiveToolPolicy, toolName: string): boolean {
  if (policy.switchedOffTools?.has(toolName) || matchesPatternSet(policy.denySet, toolName)) {
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

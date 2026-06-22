import type {
  ApprovalEscalationPolicy,
  EffectiveToolPolicy,
  SandboxAccessPolicy,
  ToolPolicyAxes,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";

/**
 * Projects the engine's resolved policy onto two orthogonal axes — sandbox access
 * ("what the agent can touch") and approval escalation ("when to interrupt the
 * human") — making the composition explicit for operator-facing config and audit.
 *
 * Behavior-preserving: this derives from the same fields the engine already
 * evaluates independently (filesystem read mode resolution mirrors the engine's
 * getReadAccessMode), so the axes are a faithful, composable view of current policy.
 */
export function deriveToolPolicyAxes(
  config: Pick<ToolPolicyConfig, "sandbox">,
  policy: Pick<EffectiveToolPolicy, "approvalMode" | "readAccessMode">,
): ToolPolicyAxes {
  const sandbox: SandboxAccessPolicy = {
    filesystemReadMode: policy.readAccessMode ?? config.sandbox.readAccessMode ?? "roots_only",
    networkAllowlist: config.sandbox.networkAllowlist ?? [],
    writeJailRoots: config.sandbox.writeJailRoots ?? [],
    readOnlyRoots: config.sandbox.readOnlyRoots ?? [],
    riskyShellPatterns: config.sandbox.riskyShellPatterns ?? [],
    riskyArgumentPatterns: config.sandbox.riskyArgumentPatterns ?? [],
  };
  const approval: ApprovalEscalationPolicy = {
    approvalMode: policy.approvalMode,
    requireApprovalForRiskyShell: config.sandbox.requireApprovalForRiskyShell,
  };
  return { sandbox, approval };
}

import type { McpServerPolicy } from "@goatcitadel/contracts";

export const mcpLines = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
/** Input validation/receipt comparison only; Gateway normalization and policy remain authoritative. */
export function reviewedMcpPolicy(policy: McpServerPolicy): McpServerPolicy {
  const keys = mcpLines(policy.allowedEnvKeys ?? []);
  if (keys.some((key) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)))
    throw new Error(
      "Environment keys must use uppercase letters, numbers and underscores, starting with a letter or underscore.",
    );
  return {
    requireFirstToolApproval: policy.requireFirstToolApproval,
    redactionMode: policy.redactionMode,
    allowedToolPatterns: mcpLines(policy.allowedToolPatterns),
    blockedToolPatterns: mcpLines(policy.blockedToolPatterns),
    allowedEnvKeys: [...new Set(keys)],
    notes: policy.notes?.trim() || undefined,
  };
}

import type { McpServerCategory, McpServerPolicy, McpServerRecord } from "@goatcitadel/contracts";

const DEFAULT_MCP_SERVER_POLICY: McpServerPolicy = {
  requireFirstToolApproval: false,
  redactionMode: "basic",
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};

export function inferMcpCategory(transport: McpServerRecord["transport"]): McpServerCategory {
  if (transport === "stdio") {
    return "development";
  }
  if (transport === "sse") {
    return "research";
  }
  return "automation";
}

export function normalizeMcpPolicy(policy?: Partial<McpServerPolicy>): McpServerPolicy {
  return {
    requireFirstToolApproval: policy?.requireFirstToolApproval ?? DEFAULT_MCP_SERVER_POLICY.requireFirstToolApproval,
    redactionMode: policy?.redactionMode ?? DEFAULT_MCP_SERVER_POLICY.redactionMode,
    allowedToolPatterns: Array.isArray(policy?.allowedToolPatterns)
      ? policy.allowedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.allowedToolPatterns],
    blockedToolPatterns: Array.isArray(policy?.blockedToolPatterns)
      ? policy.blockedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.blockedToolPatterns],
    notes: policy?.notes?.trim() || undefined,
  };
}

import type { McpApprovalPosture, McpServerCategory, McpServerPolicy, McpServerRecord } from "@goatcitadel/contracts";
import { MCP_APPROVAL_POSTURES, redactSecretText } from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";

export const DEFAULT_MCP_SERVER_POLICY: McpServerPolicy = {
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

/** An unrecognised value is dropped, which leaves the server asking for everything. */
function normalizeApprovalPosture(value: unknown): McpApprovalPosture | undefined {
  return MCP_APPROVAL_POSTURES.find((posture) => posture === value);
}

export function normalizeMcpPolicy(policy?: Partial<McpServerPolicy>): McpServerPolicy {
  const approvalPosture = normalizeApprovalPosture(policy?.approvalPosture);
  return {
    requireFirstToolApproval: policy?.requireFirstToolApproval ?? DEFAULT_MCP_SERVER_POLICY.requireFirstToolApproval,
    redactionMode: policy?.redactionMode ?? DEFAULT_MCP_SERVER_POLICY.redactionMode,
    allowedToolPatterns: Array.isArray(policy?.allowedToolPatterns)
      ? policy.allowedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.allowedToolPatterns],
    blockedToolPatterns: Array.isArray(policy?.blockedToolPatterns)
      ? policy.blockedToolPatterns.map((item) => item.trim()).filter(Boolean)
      : [...DEFAULT_MCP_SERVER_POLICY.blockedToolPatterns],
    allowedEnvKeys: normalizeSafeEnvKeyNames(policy?.allowedEnvKeys),
    // Omitted rather than undefined when unset, so a stored policy keeps the shape it had before this setting.
    ...(approvalPosture ? { approvalPosture } : {}),
    notes: policy?.notes?.trim() || undefined,
  };
}

export function wildcardMatch(value: string, pattern: string): boolean {
  // Glob semantics: `*` = any run, `?` = exactly one character; everything else is literal.
  // `?` must be translated before regex compilation, otherwise `delete_?` makes the `_` optional
  // (a block pattern would fail open) and a leading `?` throws.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, "*")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

export function applyMcpRedaction(
  payload: Record<string, unknown>,
  mode: McpServerPolicy["redactionMode"],
): Record<string, unknown> {
  if (mode === "off") {
    return payload;
  }
  const serialized = JSON.stringify(payload);
  const redacted = redactSecretText(serialized).value;
  const parsed = parseJsonWithFallback<Record<string, unknown>>(redacted, payload);
  if (mode === "strict") {
    return {
      ...parsed,
      message: "Output redacted in strict mode.",
    };
  }
  return parsed;
}

function parseJsonWithFallback<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

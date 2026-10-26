const reliefBrand: unique symbol = Symbol("McpApprovalRelief");

/**
 * Gateway-authored, process-local relief for one MCP call: the server's saved approval setting and
 * that tool's stored labels say the call need not ask just because it is an MCP call. It is bound to
 * one canonical target and cannot be serialized, so no request body, tool argument or model output
 * can carry it. It never clears any other reason to ask.
 */
export interface McpApprovalRelief {
  readonly [reliefBrand]: true;
}

const reliefTargets = new WeakMap<McpApprovalRelief, string>();
const CANONICAL_MCP_TOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

/** Called by the Gateway only, after reading the server's saved setting and the tool's stored labels. */
export function createMcpApprovalRelief(input: { canonicalName: string }): McpApprovalRelief {
  const { canonicalName } = input;
  if (
    !canonicalName.startsWith("mcp.") ||
    canonicalName === "mcp.invoke" ||
    !CANONICAL_MCP_TOOL_NAME.test(canonicalName)
  ) {
    throw new Error("Invalid MCP approval relief target");
  }
  const handle = Object.freeze({
    [reliefBrand]: true as const,
    toJSON(): never {
      throw new Error("MCP approval relief cannot be serialized");
    },
  });
  reliefTargets.set(handle, canonicalName);
  return handle;
}

/** True only for a genuine relief minted for exactly this MCP target; anything else fails closed. */
export function readMcpApprovalRelief(
  relief: McpApprovalRelief | undefined,
  canonicalName: string | undefined,
): boolean {
  if (relief === undefined) return false;
  if (reliefTargets.get(relief) === undefined || reliefTargets.get(relief) !== canonicalName) {
    throw new Error("Missing or mismatched MCP approval relief");
  }
  return true;
}

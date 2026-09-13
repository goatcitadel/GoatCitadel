const bindingBrand: unique symbol = Symbol("McpToolPolicyBinding");

/** Process-local dispatch mapping. It is not a grant, credential, or requester identity. */
export interface McpToolPolicyBinding {
  readonly [bindingBrand]: true;
}

export interface McpToolPolicyIdentity {
  readonly canonicalName: string;
  readonly policyToolName: "mcp.invoke";
  readonly serverId: string;
  readonly nativeToolName: string;
}

const identities = new WeakMap<McpToolPolicyBinding, McpToolPolicyIdentity>();

/**
 * Target projection only: these are the same trimmed fields the MCP wrapper
 * sends to its transport owner. This cannot mint a named-tool dispatch handle.
 */
export function readMcpPolicyTargetFromWrapper(request: {
  toolName: string;
  args?: Record<string, unknown>;
}): McpToolPolicyIdentity | undefined {
  if (request.toolName !== "mcp.invoke") return undefined;
  const serverId = typeof request.args?.serverId === "string" ? request.args.serverId.trim() : "";
  const nativeToolName = typeof request.args?.toolName === "string" ? request.args.toolName.trim() : "";
  // An argument-free inspection still evaluates the generic entry point. The
  // transport owner rejects missing targets before any external call.
  if (!serverId || !nativeToolName) return undefined;
  const canonicalName = `mcp.${serverId}.${nativeToolName}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(canonicalName)) {
    throw new Error("Invalid MCP policy target");
  }
  return { canonicalName, serverId, nativeToolName, policyToolName: "mcp.invoke" };
}

/** Called by a trusted runtime owner after resolving the selected native tool. */
export function createMcpToolPolicyBinding(input: {
  canonicalName: string;
  serverId: string;
  nativeToolName: string;
}): McpToolPolicyBinding {
  if (
    !input.serverId ||
    !input.nativeToolName ||
    input.canonicalName !== `mcp.${input.serverId}.${input.nativeToolName}` ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(input.canonicalName)
  ) {
    throw new Error("Invalid native MCP policy mapping");
  }
  const handle = Object.freeze({
    [bindingBrand]: true as const,
    toJSON(): never {
      throw new Error("MCP policy bindings cannot be serialized");
    },
  });
  identities.set(handle, Object.freeze({ ...input, policyToolName: "mcp.invoke" }));
  return handle;
}

export function readMcpToolPolicyBinding(
  binding: McpToolPolicyBinding | undefined,
  canonicalName: string,
): McpToolPolicyIdentity | undefined {
  if (binding === undefined) return undefined;
  const identity = identities.get(binding);
  if (!identity || identity.canonicalName !== canonicalName) {
    throw new Error("Missing or mismatched native MCP policy binding");
  }
  return identity;
}

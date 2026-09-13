import { mcpRequesterScopeHashMaterial, type McpRequesterScopeHashInput, type McpTransport } from "./mcp.js";

export const MCP_STATIC_TOOL_BINDING_VERSION = "goatcitadel.mcp-static-tool-binding.v1" as const;
export const MCP_STATIC_TOOL_SCOPE_VERSION = "goatcitadel.mcp-static-tool-scope.v1" as const;

/**
 * A frozen static MCP target, not connection material or invocation authority.
 * The registry owner must issue a fresh configurationBindingId when connection,
 * credential authority or policy changes, including removal/recreation. It is
 * an opaque UUID, never a digest of credentials, endpoint URLs or command args.
 * Legacy omission does not imply a static binding or authorize native dispatch.
 */
export interface McpStaticToolBinding {
  schemaVersion: typeof MCP_STATIC_TOOL_BINDING_VERSION;
  mode: "static";
  serverId: string;
  nativeToolName: string;
  toolName: string;
  transport: McpTransport;
  configurationBindingId: string;
  /** Hash of the profile's exact provider-facing definition, including its model alias. */
  toolDefinitionSha256: string;
  profileScopeSha256: string;
  callableCatalogSnapshotId: string;
  callableCatalogSha256: string;
  bindingSha256: string;
}

export type McpStaticToolBindingMaterial = Omit<McpStaticToolBinding, "bindingSha256">;

export function mcpStaticToolScopeHashMaterial(input: McpRequesterScopeHashInput) {
  return { ...mcpRequesterScopeHashMaterial(input), schemaVersion: MCP_STATIC_TOOL_SCOPE_VERSION };
}

export function assertMcpStaticToolBinding(input: unknown): asserts input is McpStaticToolBinding {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw new TypeError("Static MCP binding must be a plain object.");
  const fields = [
    "schemaVersion",
    "mode",
    "serverId",
    "nativeToolName",
    "toolName",
    "transport",
    "configurationBindingId",
    "toolDefinitionSha256",
    "profileScopeSha256",
    "callableCatalogSnapshotId",
    "callableCatalogSha256",
    "bindingSha256",
  ];
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, field) ?? {}, "value"))
  )
    throw new TypeError("Static MCP binding contains missing or unsupported fields.");
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== MCP_STATIC_TOOL_BINDING_VERSION || value.mode !== "static")
    throw new TypeError("Static MCP binding version or mode is invalid.");
  for (const field of ["serverId", "nativeToolName", "toolName", "callableCatalogSnapshotId"] as const) {
    if (typeof value[field] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u.test(value[field]))
      throw new TypeError(`Static MCP binding ${field} is invalid.`);
  }
  if (value.toolName === "mcp.invoke" || value.toolName !== `mcp.${value.serverId}.${value.nativeToolName}`)
    throw new TypeError("Static MCP binding does not identify its exact native tool.");
  if (value.transport !== "stdio" && value.transport !== "http" && value.transport !== "sse")
    throw new TypeError("Static MCP binding transport is invalid.");
  if (
    typeof value.configurationBindingId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.configurationBindingId)
  )
    throw new TypeError("Static MCP configuration binding identity is invalid.");
  for (const field of [
    "toolDefinitionSha256",
    "profileScopeSha256",
    "callableCatalogSha256",
    "bindingSha256",
  ] as const) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field]))
      throw new TypeError(`Static MCP binding ${field} is invalid.`);
  }
}

export function mcpStaticToolBindingHashMaterial(input: McpStaticToolBinding): McpStaticToolBindingMaterial {
  assertMcpStaticToolBinding(input);
  const { bindingSha256: _bindingSha256, ...material } = input;
  return material;
}

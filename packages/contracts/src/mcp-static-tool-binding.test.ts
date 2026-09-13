import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { mcpRequesterScopeHashMaterial } from "./mcp.js";
import {
  MCP_STATIC_TOOL_BINDING_VERSION,
  assertMcpStaticToolBinding,
  mcpStaticToolBindingHashMaterial,
  mcpStaticToolScopeHashMaterial,
  type McpStaticToolBinding,
} from "./mcp-static-tool-binding.js";

const scope = {
  profileId: "profile-1",
  turnId: "turn-1",
  sessionId: "session-1",
  workspaceId: "workspace-1",
  authActorId: "actor-1",
  authActorSource: "token" as const,
};
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function binding(): McpStaticToolBinding {
  const result: McpStaticToolBinding = {
    schemaVersion: MCP_STATIC_TOOL_BINDING_VERSION,
    mode: "static",
    serverId: "server.with.dots",
    nativeToolName: "files.read",
    toolName: "mcp.server.with.dots.files.read",
    transport: "stdio",
    configurationBindingId: "28a39400-9059-4bda-a1fa-23c2ae2b3bc3",
    toolDefinitionSha256: "a".repeat(64),
    profileScopeSha256: digest(mcpStaticToolScopeHashMaterial(scope)),
    callableCatalogSnapshotId: "catalog-1",
    callableCatalogSha256: "c".repeat(64),
    bindingSha256: "0".repeat(64),
  };
  result.bindingSha256 = digest(mcpStaticToolBindingHashMaterial(result));
  return result;
}

describe("frozen static MCP target contract", () => {
  it.each(["stdio", "http", "sse"] as const)(
    "retains exact dotted names for %s without connection material",
    (transport) => {
      const value = { ...binding(), transport };
      expect(() => assertMcpStaticToolBinding(JSON.parse(JSON.stringify(value)))).not.toThrow();
      expect(mcpStaticToolBindingHashMaterial(value)).not.toHaveProperty("bindingSha256");
    },
  );
  it.each(["url", "command", "arguments", "headers", "credential", "resolverId", "meshActivation"])(
    "rejects extra %s fields",
    (field) => {
      expect(() => assertMcpStaticToolBinding({ ...binding(), [field]: "not-binding-material" })).toThrow(
        /unsupported fields/u,
      );
    },
  );
  it.each(Object.keys(binding()))("rejects an omitted %s", (field) => {
    const value = { ...binding() } as Record<string, unknown>;
    delete value[field];
    expect(() => assertMcpStaticToolBinding(value)).toThrow(/missing or unsupported/u);
  });
  it.each([
    { mode: "requester_scoped" },
    { schemaVersion: "legacy" },
    { serverId: "different-server" },
    { nativeToolName: "files.delete" },
    { toolName: "mcp.invoke" },
    { transport: "internal" },
    { configurationBindingId: "legacy-config" },
    { configurationBindingId: "28a39400-9059-1bda-a1fa-23c2ae2b3bc3" },
    { callableCatalogSnapshotId: "../catalog" },
    { profileScopeSha256: "A".repeat(64) },
    { toolDefinitionSha256: "short" },
    { callableCatalogSha256: "" },
    { bindingSha256: "G".repeat(64) },
  ])("refuses malformed or redirected material %#", (patch) => {
    expect(() => assertMcpStaticToolBinding({ ...binding(), ...patch })).toThrow(TypeError);
  });
  it("does not execute getters or accept inherited or symbol metadata", () => {
    const value = { ...binding() };
    let called = false;
    Object.defineProperty(value, "serverId", {
      get() {
        called = true;
        return "server.with.dots";
      },
      enumerable: true,
    });
    expect(() => assertMcpStaticToolBinding(value)).toThrow();
    expect(called).toBe(false);
    expect(() => assertMcpStaticToolBinding(Object.create(binding()))).toThrow();
    expect(() => assertMcpStaticToolBinding({ ...binding(), [Symbol("extra")]: "private" })).toThrow();
  });
  it("separates static scope hashes from requester resolution and binds every actor/turn dimension", () => {
    const original = digest(mcpStaticToolScopeHashMaterial(scope));
    expect(original).not.toBe(digest(mcpRequesterScopeHashMaterial(scope)));
    for (const key of ["profileId", "turnId", "sessionId", "workspaceId", "authActorId"] as const)
      expect(digest(mcpStaticToolScopeHashMaterial({ ...scope, [key]: "other" }))).not.toBe(original);
    expect(digest(mcpStaticToolScopeHashMaterial({ ...scope, authActorSource: "companion" }))).not.toBe(original);
    expect(() => mcpStaticToolScopeHashMaterial({ ...scope, authActorSource: "none" } as never)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { CapabilityScopeAssignment } from "@goatcitadel/contracts";
import { CapabilityScopeResolver, isCapabilityAllowed } from "./capability-scope-resolver.js";

function citadelMcpGrant(serverRef: string): CapabilityScopeAssignment {
  return {
    assignmentId: `g-${serverRef}`,
    scopeKind: "citadel",
    scopeId: "personal",
    resourceType: "mcp_server",
    resourceRef: serverRef,
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
  };
}

function resolver(rows: CapabilityScopeAssignment[], disabled = false): CapabilityScopeResolver {
  return new CapabilityScopeResolver({
    listAssignmentsForScope: (kind, id) => rows.filter((r) => r.scopeKind === kind && r.scopeId === id),
    listAllSkillIds: () => [],
    listAllIntegrationIds: () => [],
    listAllMcpServerIds: () => ["allowed", "denied"],
    isDisabled: () => disabled,
  });
}

describe("MCP capability enforcement decision", () => {
  it("allows any server when the citadel/workspace are unconfigured", () => {
    const effective = resolver([]).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "denied")).toBe(true);
  });

  it("denies a server outside the citadel grant", () => {
    const effective = resolver([citadelMcpGrant("allowed")]).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "allowed")).toBe(true);
    expect(isCapabilityAllowed(effective, "denied")).toBe(false);
  });

  it("allows everything when the kill-switch disables scoping (fail-open)", () => {
    const effective = resolver([citadelMcpGrant("allowed")], true).resolve("personal", "default").mcpServers;
    expect(isCapabilityAllowed(effective, "denied")).toBe(true);
  });
});

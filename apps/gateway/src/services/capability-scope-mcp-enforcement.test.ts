import { describe, expect, it, vi } from "vitest";
import type { CapabilityScopeAssignment, McpInvokeRequest } from "@goatcitadel/contracts";
import { PolicyViolationError } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { composeToolsMcpRouteDependencies } from "./gateway-route-composition-tools.js";
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

  it("denies all capabilities when scope resolution faults", () => {
    const effective = new CapabilityScopeResolver({
      listAssignmentsForScope: () => {
        throw new Error("storage unavailable");
      },
      listAllSkillIds: () => ["skill-1"],
      listAllIntegrationIds: () => ["integration-1"],
      listAllMcpServerIds: () => ["denied"],
    }).resolve("personal", "default").mcpServers;

    expect(isCapabilityAllowed(effective, "denied")).toBe(false);
  });
});

// Exercise the REAL private gate method on GatewayService.prototype (via a constructor-bypass
// harness) so the end-to-end enforcement seam — not just the resolver decision — is covered.
function gate(
  rows: CapabilityScopeAssignment[],
  opts: { disabled?: boolean; noResolver?: boolean } = {},
): (request: McpInvokeRequest) => void {
  const svc = Object.create(GatewayService.prototype) as Record<string, unknown>;
  if (!opts.noResolver) {
    svc.capabilityScopeResolver = resolver(rows, opts.disabled);
  }
  svc.storage = { workspaces: { find: () => ({ citadelId: "personal" }) } };
  return (request) =>
    (svc as unknown as { assertMcpServerInCapabilityScope: (r: McpInvokeRequest) => void }).assertMcpServerInCapabilityScope(
      request,
    );
}

const req = (serverId: string): McpInvokeRequest => ({ serverId, toolName: "t", workspaceId: "default" });

describe("assertMcpServerInCapabilityScope (real gate method)", () => {
  it("throws PolicyViolationError for a scoped-out MCP server", () => {
    expect(() => gate([citadelMcpGrant("allowed")])(req("denied"))).toThrow(PolicyViolationError);
  });

  it("allows an MCP server within the citadel grant", () => {
    expect(() => gate([citadelMcpGrant("allowed")])(req("allowed"))).not.toThrow();
  });

  it("allows any server when unconfigured (non-breaking)", () => {
    expect(() => gate([])(req("anything"))).not.toThrow();
  });

  it("fails open when the kill-switch disables scoping", () => {
    expect(() => gate([citadelMcpGrant("allowed")], { disabled: true })(req("denied"))).not.toThrow();
  });

  it("fails closed when the resolver is absent (constructor-bypass harness)", () => {
    expect(() => gate([], { noResolver: true })(req("denied"))).toThrow(PolicyViolationError);
  });
});

// Recursive callable/indexable stub: any property access returns another stub, any call returns one.
function deepStub(overrides: Record<string, unknown> = {}): unknown {
  const target = function () {} as unknown as object;
  return new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (typeof prop === "string" && prop in overrides) {
        return overrides[prop];
      }
      return deepStub();
    },
    apply() {
      return deepStub();
    },
  });
}

describe("REST /mcp/invoke route composition (spec §7a: every caller is scoped)", () => {
  it("routes mcp.invokeMcpTool through the guarded gateway.invokeMcpTool, not the raw coordinator", async () => {
    const guarded = vi.fn(async () => ({}) as never);
    const coordinator = vi.fn(async () => ({}) as never);
    const gateway = deepStub({
      invokeMcpTool: guarded,
      toolInvocationCoordinator: { invokeMcpTool: coordinator },
    });
    const deps = composeToolsMcpRouteDependencies(gateway as never);
    await deps.mcp.invokeMcpTool({ serverId: "x", toolName: "t" });
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(coordinator).not.toHaveBeenCalled();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_RESTRICTED_PROFILE, type ToolInvokeRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { createMcpToolPolicyBinding } from "./mcp-tool-policy-binding.js";
import { createMeshToolPolicyBinding, readMeshToolPolicyBinding, type MeshToolPolicyBinding } from "./mesh-tool-policy-binding.js";
import { ToolRegistry } from "./tool-registry.js";

function config(approvalMode: "bypass" | "approve_risky" = "bypass"): ToolPolicyConfig {
  return { profiles: { danger: ["mesh.invoke"] }, tools: { profile: "danger", approvalMode, allow: [], deny: [] },
    agents: {}, sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [],
      requireApprovalForRiskyShell: true } };
}
function request(kind: "tool" | "mcp_server" = "tool", nodeId = "node-a"): ToolInvokeRequest {
  return { toolName: `mesh:${nodeId}:${kind}:project.status`, agentId: "assistant", sessionId: "mesh-policy-session",
    workspaceId: "default", externalRuntime: true, args: { query: "public fixture" } };
}
function options(kind: "tool" | "mcp_server" = "tool", nodeId = "node-a") {
  return { meshToolBinding: createMeshToolPolicyBinding({ canonicalName: request(kind, nodeId).toolName,
    nodeId, kind, localId: "project.status" }) };
}

describe("mesh tool policy execution", () => {
  let root: string;
  let storage: AsyncStorage;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-mesh-policy-"));
    storage = createSqliteAsyncStorage(new Storage({ dbPath: path.join(root, "runtime.db"),
      transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") }));
  });
  afterEach(async () => {
    await storage?.close();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^gc-mesh-policy-/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps mappings opaque, exact and absent from the public registry", async () => {
    const engine = new ToolPolicyEngine(config(), storage);
    const binding = options().meshToolBinding;
    expect(readMeshToolPolicyBinding(binding, request().toolName)).toMatchObject({
      canonicalName: request().toolName, nodeId: "node-a", kind: "tool", localId: "project.status", policyToolName: "mesh.invoke",
    });
    expect(() => JSON.stringify(binding)).toThrow(/cannot be serialized/);
    expect(() => readMeshToolPolicyBinding({ ...binding }, request().toolName)).toThrow(/binding/);
    expect(() => createMeshToolPolicyBinding({ canonicalName: request().toolName, nodeId: "other", kind: "tool",
      localId: "project.status" })).toThrow(/mapping/);
    expect(() => createMeshToolPolicyBinding({ canonicalName: "mesh:node-a:skill:guide", nodeId: "node-a",
      kind: "skill" as "tool", localId: "guide" })).toThrow(/mapping/);
    expect(engine.listCatalog().some((entry) => entry.toolName === "mesh.invoke")).toBe(false);
    expect((await engine.inspectAccess(request())).reasonCodes).toContain("unknown_tool");
    expect((await engine.inspectAccess({ ...request(), toolName: "mesh.invoke" })).reasonCodes).toContain("unknown_tool");
    await expect(engine.invoke(request(), { meshToolBinding: {} as MeshToolPolicyBinding })).rejects.toThrow(/binding/);
    await expect(engine.invoke(request("mcp_server"), options())).rejects.toThrow(/binding/);
    await expect(engine.invoke({ ...request(), externalRuntime: false }, options())).rejects.toThrow(/external runtime/);
    await expect(engine.invoke(request(), { ...options(), mcpToolBinding: createMcpToolPolicyBinding({
      canonicalName: "mcp.docs.read", serverId: "docs", nativeToolName: "read",
    }) })).rejects.toThrow(/mutually exclusive/);
    const forgedContext = { ...request(), policyContext: { meshToolBinding: binding } } as ToolInvokeRequest;
    expect((await engine.inspectAccess(forgedContext)).reasonCodes).toContain("unknown_tool");
  });

  it.each([request().toolName, "mesh.invoke"])("rejects a registered collision at %s", async (name) => {
    const registry = new ToolRegistry([{ name, category: "ops", riskLevel: "safe", requiresApproval: false,
      description: "Local collision", pack: "core" }]);
    await expect(new ToolPolicyEngine(config(), storage, registry).invoke(request(), options())).rejects.toThrow(/collides/);
  });

  it.each(["mesh.invoke", request().toolName, "mesh:node-a:*"])("keeps %s deny-wins over a scoped allow", async (pattern) => {
    const policy = config();
    policy.tools.deny = [pattern];
    await storage.toolGrants.create({ toolPattern: request().toolName, scope: "session", scopeRef: request().sessionId,
      decision: "allow", grantType: "persistent", createdBy: "operator" });
    expect((await new ToolPolicyEngine(policy, storage).invoke(request(), options())).outcome).toBe("blocked");
  });

  it.each(["mesh.invoke", request().toolName])("enforces the %s scoped deny grant", async (toolPattern) => {
    await storage.toolGrants.create({ toolPattern, scope: "session", scopeRef: request().sessionId,
      decision: "deny", grantType: "persistent", createdBy: "operator" });
    expect((await new ToolPolicyEngine(config(), storage).invoke(request(), options())).outcome).toBe("blocked");
  });

  it("keeps mesh authority separate from MCP allowances and the active permission ceiling", async () => {
    const policy = config();
    policy.profiles = { danger: ["mcp.invoke"] };
    expect((await new ToolPolicyEngine(policy, storage).inspectAccess(request(), options())).allowed).toBe(false);
    const engine = new ToolPolicyEngine(config(), storage);
    const permissionProfile = { ...HEARTBEAT_RESTRICTED_PROFILE, profileId: "mesh-test", deny: [],
      toolPatterns: [request().toolName] };
    const denied = await engine.inspectAccess({ ...request("mcp_server"), policyContext: { permissionProfile } }, options("mcp_server"));
    expect(denied.reasonCodes).toContain("permission_profile_upper_bound");
    expect((await engine.inspectAccess({ ...request(), policyContext: { permissionProfile } }, options())).allowed).toBe(true);
    expect((await engine.inspectAccess({ ...request(), trustLevel: "untrusted_external" }, options())).reasonCodes)
      .toContain("untrusted_source_privileged_tool_block");
    const beforeExecute = vi.fn();
    const result = await engine.invoke(request(), { ...options(), beforeExecute });
    expect(result.outcome).toBe("executed");
    expect(result.internalCall?.capabilityPolicy).toMatchObject({ toolName: "mesh.invoke", family: "ops",
      usesNetwork: true, mutatesRemoteState: true, resolvesSecrets: true, blocksUntrustedEscalation: true });
    expect(result.result).toMatchObject({ externalRuntime: true, toolName: request().toolName });
    expect(beforeExecute).not.toHaveBeenCalled();
  });

  it("shares a bounded mesh grant across nodes and publication kinds without charging inspections", async () => {
    await storage.toolGrants.create({ toolPattern: "mesh.invoke", scope: "session", scopeRef: request().sessionId,
      decision: "allow", grantType: "persistent", constraints: { maxCallsPerHour: 2 }, createdBy: "operator" });
    const engine = new ToolPolicyEngine(config(), storage);
    await engine.evaluateAccess(request(), options());
    await engine.invoke({ ...request(), dryRun: true }, options());
    expect(await storage.toolAccessDecisions.countToolCallsInLastHour("mesh.invoke", "assistant", request().sessionId)).toBe(0);
    expect((await engine.invoke(request(), options())).outcome).toBe("executed");
    expect((await engine.invoke(request("mcp_server", "node-b"), options("mcp_server", "node-b"))).outcome).toBe("executed");
    expect((await engine.invoke(request(), options())).policyReason).toMatch(/maxCallsPerHour/);
    expect(await storage.toolAccessDecisions.countToolCallsInLastHour("mesh.invoke", "assistant", request().sessionId)).toBe(2);
    expect(await storage.toolAccessDecisions.countToolCallsInLastHour(request().toolName, "assistant", request().sessionId)).toBe(1);
    expect(await storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(0);
  });

  it("retains the exact approval request and rechecks mapping and policy on approved replay", async () => {
    const engine = new ToolPolicyEngine(config("approve_risky"), storage);
    const requested = await engine.invoke(request(), options());
    expect(requested.outcome).toBe("approval_required");
    const approvalId = requested.approvalId!;
    const pending = await storage.pendingApprovalActions.find(approvalId);
    expect(pending?.request).toMatchObject({ toolName: request().toolName, args: request().args });
    expect(JSON.stringify(pending)).not.toContain("meshToolBinding");
    expect((await storage.approvals.get(approvalId)).linkage?.toolName).toBe(request().toolName);
    await storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
    const replay = { deferResolution: true, externalRuntimeReplay: true };
    expect((await engine.executeApprovedAction(approvalId, undefined, replay))?.outcome).toBe("blocked");
    expect((await engine.executeApprovedAction(approvalId, undefined, { ...replay, ...options() }))?.outcome).toBe("executed");
    const narrowed = config();
    narrowed.tools.deny = ["mesh.invoke"];
    expect((await new ToolPolicyEngine(narrowed, storage).executeApprovedAction(approvalId, undefined,
      { ...replay, ...options() }))?.outcome).toBe("blocked");
  });

  it.each([
    ["mesh.invoke", "deny"], [request().toolName, "require_approval"], ["mesh.invoke", "redact"],
    [request().toolName, "route_local"], ["mesh.invoke", "require_dry_run"],
  ] as const)("retains %s Ward effect %s", async (actionPattern, effect) => {
    await storage.citadels.addWard({ citadelId: "personal", name: "mesh policy", actionPattern, effect });
    const result = await new ToolPolicyEngine(config(), storage).inspectAccess({ ...request(), citadelId: "personal" }, options());
    expect(result.wardEffect).toBe(effect);
    expect(result.allowed).toBe(effect !== "deny");
    expect(result.requiresApproval).toBe(effect === "require_approval");
  });
});

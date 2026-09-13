import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEARTBEAT_RESTRICTED_PROFILE, type ToolInvokeRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { createMcpToolPolicyBinding, type McpToolPolicyBinding } from "./mcp-tool-policy-binding.js";
import { ToolRegistry } from "./tool-registry.js";

function config(approvalMode: "bypass" | "approve_risky" = "bypass"): ToolPolicyConfig {
  return {
    profiles: { danger: ["mcp.invoke"] },
    tools: { profile: "danger", approvalMode, allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
function request(name = "read"): ToolInvokeRequest {
  return {
    toolName: `mcp.docs.${name}`,
    agentId: "assistant",
    sessionId: "mcp-policy-session",
    workspaceId: "default",
    externalRuntime: true,
    args: { query: "public fixture" },
  };
}
function options(name = "read") {
  return {
    mcpToolBinding: createMcpToolPolicyBinding({
      canonicalName: `mcp.docs.${name}`,
      serverId: "docs",
      nativeToolName: name,
    }),
  };
}

function wrapperRequest(name = "read"): ToolInvokeRequest {
  const native = request(name);
  return {
    ...native,
    toolName: "mcp.invoke",
    args: { serverId: " docs ", toolName: ` ${name} `, arguments: native.args },
  };
}

describe("named MCP policy execution", () => {
  let root: string;
  let storage: Storage;
  let asyncStorage: AsyncStorage;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-native-mcp-policy-"));
    storage = new Storage({
      dbPath: path.join(root, "runtime.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    asyncStorage = createSqliteAsyncStorage(storage);
  });
  afterEach(async () => {
    await asyncStorage?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps unknown or caller-forged native tools closed", async () => {
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    const native = { ...request(), policyContext: { mcpToolBinding: options().mcpToolBinding } } as ToolInvokeRequest;
    expect((await engine.inspectAccess(native)).reasonCodes).toContain("unknown_tool");
    await expect(engine.invoke(request(), { mcpToolBinding: {} as McpToolPolicyBinding })).rejects.toThrow(/binding/);
    await expect(engine.invoke({ ...request(), externalRuntime: false }, options())).rejects.toThrow(
      /external runtime/,
    );
    await expect(engine.invoke(request("search"), options())).rejects.toThrow(/binding/);
    const collision = new ToolRegistry([
      {
        name: request().toolName,
        category: "ops",
        riskLevel: "safe",
        requiresApproval: false,
        description: "fixture collision",
        pack: "core",
      },
    ]);
    await expect(new ToolPolicyEngine(config(), asyncStorage, collision).invoke(request(), options())).rejects.toThrow(
      /collides/,
    );
    await expect(new ToolPolicyEngine(config(), asyncStorage, collision).invoke(wrapperRequest())).rejects.toThrow(
      /collides/,
    );
  });

  it.each(["mcp.invoke", "mcp.docs.read", "mcp.*"])("applies deny-wins for %s", async (toolName) => {
    const policy = config();
    policy.tools.deny = [toolName];
    await asyncStorage.toolGrants.create({
      toolPattern: "mcp.docs.read",
      scope: "session",
      scopeRef: request().sessionId,
      decision: "allow",
      grantType: "persistent",
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    expect((await engine.invoke(request(), options())).policyReason).toMatch(/denied by policy/);
  });

  it.each(["mcp.invoke", "mcp.docs.read"])("applies scoped deny grants for %s", async (toolPattern) => {
    await asyncStorage.toolGrants.create({
      toolPattern,
      scope: "session",
      scopeRef: request().sessionId,
      decision: "deny",
      grantType: "persistent",
      createdBy: "operator",
    });
    expect((await new ToolPolicyEngine(config(), asyncStorage).invoke(request(), options())).outcome).toBe("blocked");
  });

  it("inherits MCP security classification and cannot widen an active permission ceiling", async () => {
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    const forbidden = { ...request(), policyContext: { permissionProfile: HEARTBEAT_RESTRICTED_PROFILE } };
    expect((await engine.inspectAccess(forbidden, options())).reasonCodes).toContain("policy_deny");
    const bounded = {
      ...HEARTBEAT_RESTRICTED_PROFILE,
      profileId: "native-fixture",
      deny: [],
      toolPatterns: [request().toolName],
    };
    expect(
      (
        await engine.inspectAccess(
          { ...request("search"), policyContext: { permissionProfile: bounded } },
          options("search"),
        )
      ).reasonCodes,
    ).toContain("permission_profile_upper_bound");
    expect(
      (await engine.inspectAccess({ ...request(), policyContext: { permissionProfile: bounded } }, options())).allowed,
    ).toBe(true);
    const untrusted = { ...request(), trustLevel: "untrusted_external" as const };
    expect((await engine.inspectAccess(untrusted, options())).reasonCodes).toContain(
      "untrusted_source_privileged_tool_block",
    );
    const result = await engine.invoke(request(), options());
    expect(result.outcome).toBe("executed");
    expect(result.internalCall?.capabilityPolicy).toMatchObject({
      family: "mcp",
      invokesMcp: true,
      resolvesSecrets: true,
    });
    expect(result.result).toMatchObject({ externalRuntime: true, toolName: request().toolName });
  });

  it("counts distinct native tools toward a shared MCP grant and excludes inspection/dry runs", async () => {
    await asyncStorage.toolGrants.create({
      toolPattern: "mcp.invoke",
      scope: "session",
      scopeRef: request().sessionId,
      decision: "allow",
      grantType: "persistent",
      constraints: { maxCallsPerHour: 2 },
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    await engine.evaluateAccess(request(), options());
    await engine.invoke({ ...request(), dryRun: true }, options());
    expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(
      0,
    );
    expect((await engine.invoke(request(), options())).outcome).toBe("executed");
    expect((await engine.invoke(request("search"), options("search"))).outcome).toBe("executed");
    expect((await engine.invoke(request("list"), options("list"))).policyReason).toMatch(/maxCallsPerHour/);
    expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(
      2,
    );
    expect(
      storage.toolAccessDecisions.countToolCallsInLastHour(request().toolName, "assistant", request().sessionId),
    ).toBe(1);
  });

  it("preserves exact native approval identity and requires a fresh runtime mapping on replay", async () => {
    const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
    const requested = await engine.invoke(request(), options());
    expect(requested.outcome).toBe("approval_required");
    const approvalId = requested.approvalId!;
    const pending = await asyncStorage.pendingApprovalActions.find(approvalId);
    expect(pending?.request).toMatchObject({ toolName: request().toolName, args: request().args });
    expect(JSON.stringify(pending)).not.toContain("mcpToolBinding");
    expect((await asyncStorage.approvals.get(approvalId)).linkage?.toolName).toBe(request().toolName);
    await asyncStorage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
    const missing = await engine.executeApprovedAction(approvalId, undefined, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(missing?.outcome).toBe("blocked");
    const replayed = await engine.executeApprovedAction(approvalId, undefined, {
      ...options(),
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(replayed?.outcome).toBe("executed");
    const policy = config();
    policy.tools.deny = ["mcp.invoke"];
    const denied = await new ToolPolicyEngine(policy, asyncStorage).executeApprovedAction(approvalId, undefined, {
      ...options(),
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(denied?.outcome).toBe("blocked");
    expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(
      1,
    );
  });

  it.each([
    ["mcp.invoke", "deny"],
    ["mcp.docs.read", "deny"],
    ["mcp.invoke", "require_approval"],
    ["mcp.docs.read", "require_approval"],
    ["mcp.invoke", "redact"],
    ["mcp.docs.read", "redact"],
    ["mcp.invoke", "route_local"],
    ["mcp.docs.read", "require_dry_run"],
  ] as const)("enforces the %s %s Ward on a named invocation", async (actionPattern, effect) => {
    await asyncStorage.citadels.addWard({ citadelId: "personal", name: "named MCP fixture", actionPattern, effect });
    const result = await new ToolPolicyEngine(config(), asyncStorage).inspectAccess(
      { ...request(), citadelId: "personal" },
      options(),
    );
    expect(result.wardEffect).toBe(effect);
    expect(result.allowed).toBe(effect !== "deny");
    expect(result.requiresApproval).toBe(effect === "require_approval");
  });

  it.each([
    ["mcp.docs.read", { maxCallsPerHour: 1 }],
    ["mcp.invoke", { maxWritesPerHour: 1 }],
  ])("retains native call and shared mutation constraints for %s", async (toolPattern, constraints) => {
    await asyncStorage.toolGrants.create({
      toolPattern,
      scope: "session",
      scopeRef: request().sessionId,
      decision: "allow",
      grantType: "persistent",
      constraints,
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    expect((await engine.invoke(request(), options())).outcome).toBe("executed");
    expect((await engine.invoke(request(), options())).policyReason).toMatch(/maxCallsPerHour|maxWritesPerHour/);
  });

  it("consumes one scoped grant only once when its pattern matches both identities", async () => {
    const grant = await asyncStorage.toolGrants.create({
      toolPattern: "mcp.*",
      scope: "session",
      scopeRef: request().sessionId,
      decision: "allow",
      grantType: "one_time",
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    expect((await engine.invoke(request(), options())).outcome).toBe("executed");
    expect(
      (await asyncStorage.toolGrants.list("session", request().sessionId)).find(
        (item) => item.grantId === grant.grantId,
      )?.usesRemaining,
    ).toBe(0);
  });

  it.each(["mcp.invoke", "mcp.docs.read", "mcp.docs.*"])(
    "cannot evade %s by using the generic wrapper",
    async (toolName) => {
      const policy = config();
      policy.tools.deny = [toolName];
      const engine = new ToolPolicyEngine(policy, asyncStorage);
      expect((await engine.invoke(wrapperRequest())).outcome).toBe("blocked");
    },
  );

  it.each(["mcp.invoke", "mcp.docs.read"])(
    "shares %s call limits across wrapper and named forms",
    async (toolPattern) => {
      await asyncStorage.toolGrants.create({
        toolPattern,
        scope: "session",
        scopeRef: request().sessionId,
        decision: "allow",
        grantType: "persistent",
        constraints: { maxCallsPerHour: 2 },
        createdBy: "operator",
      });
      const engine = new ToolPolicyEngine(config(), asyncStorage);
      await engine.evaluateAccess(wrapperRequest());
      await engine.invoke({ ...wrapperRequest(), dryRun: true });
      expect((await engine.invoke(request(), options())).outcome).toBe("executed");
      expect((await engine.invoke(wrapperRequest())).outcome).toBe("executed");
      expect((await engine.invoke(wrapperRequest())).policyReason).toMatch(/maxCallsPerHour/);
      expect((await engine.invoke(request(), options())).policyReason).toMatch(/maxCallsPerHour/);
      expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(
        2,
      );
      expect(
        storage.toolAccessDecisions.countToolCallsInLastHour(request().toolName, "assistant", request().sessionId),
      ).toBe(2);
    },
  );

  it("preserves the approved wrapper bytes and rechecks its exact native target", async () => {
    const policy = config("approve_risky");
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const original = wrapperRequest();
    const pendingResult = await engine.invoke(original);
    expect(pendingResult.outcome).toBe("approval_required");
    const approvalId = pendingResult.approvalId!;
    const pending = await asyncStorage.pendingApprovalActions.find(approvalId);
    expect(pending?.request).toMatchObject({ toolName: "mcp.invoke", args: original.args });
    await asyncStorage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
    policy.tools.deny = [request().toolName];
    const denied = await engine.executeApprovedAction(approvalId, undefined, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(denied?.outcome).toBe("blocked");
    policy.tools.deny = [];
    const result = await engine.executeApprovedAction(approvalId, undefined, {
      deferResolution: true,
      externalRuntimeReplay: true,
    });
    expect(result?.outcome).toBe("executed");
    expect(result?.result).toMatchObject({ toolName: "mcp.invoke" });
    expect(
      storage.toolAccessDecisions.countToolCallsInLastHour(request().toolName, "assistant", request().sessionId),
    ).toBe(1);
    expect(storage.toolAccessDecisions.countToolCallsInLastHour("mcp.invoke", "assistant", request().sessionId)).toBe(
      1,
    );
  });

  it("checks grant host constraints against the arguments actually sent to the native tool", async () => {
    await asyncStorage.toolGrants.create({
      toolPattern: "mcp.invoke",
      scope: "session",
      scopeRef: request().sessionId,
      decision: "allow",
      grantType: "persistent",
      constraints: { allowedHosts: ["allowed.example"] },
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(config(), asyncStorage);
    const original = wrapperRequest();
    const blocked = {
      ...original,
      args: { ...original.args, url: "https://allowed.example", arguments: { url: "https://blocked.example" } },
    };
    expect((await engine.invoke(blocked)).policyReason).toMatch(/host constraints/);
    const allowed = {
      ...original,
      args: { ...original.args, url: "https://blocked.example", arguments: { url: "https://allowed.example" } },
    };
    expect((await engine.invoke(allowed)).outcome).toBe("executed");
  });
});

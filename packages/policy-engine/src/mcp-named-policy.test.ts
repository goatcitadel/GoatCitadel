import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RESTRICTED_PROFILE,
  mcpCallAsksFirst,
  type McpApprovalPosture,
  type McpToolRecord,
  type ToolInvokeRequest,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { createMcpApprovalRelief, type McpApprovalRelief } from "./mcp-approval-relief.js";
import { createMcpToolPolicyBinding, type McpToolPolicyBinding } from "./mcp-tool-policy-binding.js";
import { ToolRegistry } from "./tool-registry.js";

function config(approvalMode: "bypass" | "approve_risky" | "approve_all" = "bypass"): ToolPolicyConfig {
  return {
    tools: { approvalMode, allow: ["mcp.invoke"], deny: [] },
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

function relief(name = "read"): { mcpApprovalRelief: McpApprovalRelief } {
  return { mcpApprovalRelief: createMcpApprovalRelief({ canonicalName: `mcp.docs.${name}` }) };
}

// Posture × the server's own tool labels → whether the call still asks (the Capabilities hub plan's table).
const POSTURE_ROWS: ReadonlyArray<readonly [McpApprovalPosture, NonNullable<McpToolRecord["annotations"]>, boolean]> = [
  ["everything_asks", { readOnlyHint: true }, true],
  ["reads_free", { readOnlyHint: true }, false],
  ["reads_free", { destructiveHint: false }, true],
  ["reads_free", {}, true],
  ["nothing_asks", { destructiveHint: false }, false],
  ["nothing_asks", {}, true],
  ["nothing_asks", { destructiveHint: true }, true],
  ["nothing_asks", { readOnlyHint: true }, false],
];

describe("named MCP policy execution", () => {
  let root: string;
  let storage: Storage;
  let asyncStorage: AsyncStorage;
  // Apply the full SQLite migration registry before each isolated policy test.
  // V8 coverage on shared CI runners can exceed the default 10-second hook budget.
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-native-mcp-policy-"));
    storage = new Storage({
      dbPath: path.join(root, "runtime.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    asyncStorage = createSqliteAsyncStorage(storage);
  }, 30_000);
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

  describe("server-authored MCP approval relief", () => {
    it.each(POSTURE_ROWS)("posture %s with %j asks: %s", async (posture, annotations, asks) => {
      const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
      const relieved = !mcpCallAsksFirst(posture, annotations);
      expect(relieved).toBe(!asks);
      for (const [target, named] of [
        [request(), options()],
        [wrapperRequest(), {}],
      ] as const) {
        const access = await engine.inspectAccess(target, { ...named, ...(relieved ? relief() : {}) });
        expect(access.allowed).toBe(true);
        expect(access.requiresApproval).toBe(asks);
        expect(access.reasonCodes).toContain(asks ? "approval_mode_risky" : "mcp_approval_relief");
      }
    });

    it("stops the approve_risky ask, records why, and still runs only through policy", async () => {
      const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
      const evaluated = await engine.evaluateAccess(request(), { ...options(), ...relief() });
      expect(evaluated).toMatchObject({ allowed: true, requiresApproval: false });
      expect(evaluated.reasonCodes).toContain("mcp_approval_relief");
      expect(evaluated.reasonCodes).not.toContain("approval_mode_risky");
      const invoked = await engine.invoke(request(), { ...options(), ...relief() });
      expect(invoked.outcome).toBe("executed");
      expect(invoked.audit?.reasonCodes).toContain("mcp_approval_relief");
      const unrelieved = await engine.invoke(request(), options());
      expect(unrelieved.outcome).toBe("approval_required");
    });

    it.each([
      ["approve_all", true, "approval_mode_all"],
      ["bypass", false, "approval_bypass_mode"],
    ] as const)("leaves the %s approval mode in charge", async (mode, asks, reasonCode) => {
      const access = await new ToolPolicyEngine(config(mode), asyncStorage).inspectAccess(request(), {
        ...options(),
        ...relief(),
      });
      expect(access.requiresApproval).toBe(asks);
      expect(access.reasonCodes).toContain(reasonCode);
      expect(access.reasonCodes).not.toContain("mcp_approval_relief");
    });

    it("gives a remote A2A peer no relief", async () => {
      const peer = { ...request(), policyContext: { authActorSource: "a2a_peer" as const } };
      const access = await new ToolPolicyEngine(config("approve_risky"), asyncStorage).inspectAccess(peer, {
        ...options(),
        ...relief(),
      });
      expect(access.requiresApproval).toBe(true);
      expect(access.reasonCodes).toContain("approval_mode_risky");
      expect(access.reasonCodes).not.toContain("mcp_approval_relief");
    });

    it("still denies under nothing_asks when a deny grant matches", async () => {
      await asyncStorage.toolGrants.create({
        toolPattern: request().toolName,
        scope: "session",
        scopeRef: request().sessionId,
        decision: "deny",
        grantType: "persistent",
        createdBy: "operator",
      });
      const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
      const result = await engine.invoke(request(), { ...options(), ...relief() });
      expect(result.outcome).toBe("blocked");
      const policy = config("approve_risky");
      policy.tools.deny = ["mcp.invoke"];
      const denied = await new ToolPolicyEngine(policy, asyncStorage).inspectAccess(wrapperRequest(), relief());
      expect(denied.reasonCodes).toContain("policy_deny");
    });

    it("keeps every other reason to ask: Wards, risky arguments, and the first mutation under an allow grant", async () => {
      await asyncStorage.citadels.addWard({
        citadelId: "personal",
        name: "relief fixture",
        actionPattern: request().toolName,
        effect: "require_approval",
      });
      const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
      const warded = await engine.inspectAccess({ ...request(), citadelId: "personal" }, { ...options(), ...relief() });
      expect(warded.requiresApproval).toBe(true);
      expect(warded.reasonCodes).toContain("citadel_ward_requires_approval");

      const risky = config("approve_risky");
      risky.sandbox.riskyArgumentPatterns = [{ toolNamePattern: "mcp.*", valuePatterns: ["drop everything"] }];
      const argument = await new ToolPolicyEngine(risky, asyncStorage).inspectAccess(
        { ...request(), args: { query: "please drop everything now" } },
        { ...options(), ...relief() },
      );
      expect(argument.requiresApproval).toBe(true);
      expect(argument.reasonCodes).toContain("argument_risky_requires_approval");

      await asyncStorage.toolGrants.create({
        toolPattern: request().toolName,
        scope: "session",
        scopeRef: request().sessionId,
        decision: "allow",
        grantType: "persistent",
        createdBy: "operator",
      });
      // R38: with a matching allow grant, the first mutation in the grant's scope this hour asks once,
      // with or without relief. Without an allow grant this check never runs.
      for (const relieved of [false, true]) {
        const first = await engine.inspectAccess(request(), { ...options(), ...(relieved ? relief() : {}) });
        expect(first.requiresApproval).toBe(true);
      }
    });

    it("cannot be supplied by a request, its arguments, a forged handle, or another target", async () => {
      const engine = new ToolPolicyEngine(config("approve_risky"), asyncStorage);
      const smuggled = {
        ...request(),
        mcpApprovalRelief: true,
        args: { query: "public fixture", mcpApprovalRelief: true },
        policyContext: { mcpApprovalRelief: true },
      } as unknown as ToolInvokeRequest;
      expect((await engine.inspectAccess(smuggled, options())).requiresApproval).toBe(true);
      expect((await engine.invoke(smuggled, options())).outcome).toBe("approval_required");
      const wrapped = wrapperRequest();
      const smuggledWrapper = {
        ...wrapped,
        args: { ...wrapped.args, mcpApprovalRelief: true, arguments: { mcpApprovalRelief: true } },
      };
      expect((await engine.inspectAccess(smuggledWrapper)).requiresApproval).toBe(true);
      // Even a genuine handle placed inside the request is ignored, and it can never be persisted.
      const carried = { ...request(), policyContext: relief() } as unknown as ToolInvokeRequest;
      expect((await engine.inspectAccess(carried, options())).requiresApproval).toBe(true);
      await expect(engine.invoke(carried, options())).rejects.toThrow(/serialized/);

      expect(() => JSON.stringify(relief())).toThrow(/serialized/);
      const parsed = JSON.parse('{"mcpApprovalRelief":true}') as { mcpApprovalRelief: McpApprovalRelief };
      for (const forged of [
        parsed.mcpApprovalRelief,
        {} as McpApprovalRelief,
        Object.freeze({}) as McpApprovalRelief,
      ]) {
        await expect(engine.inspectAccess(request(), { ...options(), mcpApprovalRelief: forged })).rejects.toThrow(
          /approval relief/,
        );
      }
      await expect(engine.inspectAccess(request(), { ...options(), ...relief("search") })).rejects.toThrow(
        /approval relief/,
      );
      await expect(engine.invoke(request("search"), { ...options("search"), ...relief() })).rejects.toThrow(
        /approval relief/,
      );
      await expect(
        engine.inspectAccess({ ...request(), toolName: "session.status", args: {} }, relief()),
      ).rejects.toThrow(/approval relief/);
      for (const canonicalName of ["mcp.invoke", "shell.exec", "", "mcp. docs.read"]) {
        expect(() => createMcpApprovalRelief({ canonicalName })).toThrow(/approval relief/);
      }
    });
  });
});

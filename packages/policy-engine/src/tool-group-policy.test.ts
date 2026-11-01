import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SWITCHABLE_TOOL_GROUP_IDS,
  type LocalOperatorOverrideRecord,
  type ToolInvokeRequest,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { PLUGIN_TOOL_GROUP_HOLD_REASON_CODE, ToolPolicyEngine } from "./engine.js";
import { createMcpToolPolicyBinding } from "./mcp-tool-policy-binding.js";
import { createMeshToolPolicyBinding } from "./mesh-tool-policy-binding.js";
import { isToolAllowed, resolveEffectivePolicy, withHeldToolGroups } from "./policy-resolver.js";

const SWITCHED_OFF_PHRASE = "tool group switched off";

// Tools the tests call, so a group switch is the only thing that can stop them.
const ALLOWED_TOOLS = ["session.status", "git.status", "fs.stat", "fs.write", "mcp.invoke", "mesh.invoke"];

function config(writeJailRoot = "."): ToolPolicyConfig {
  return {
    tools: { approvalMode: "bypass", allow: [...ALLOWED_TOOLS], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [writeJailRoot],
      readOnlyRoots: [],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown> = {}): ToolInvokeRequest {
  return { toolName, args, agentId: "assistant", sessionId: "tool-group-session", workspaceId: "default" };
}

function activeOverride(): LocalOperatorOverrideRecord {
  return {
    overrideId: "override-1",
    operatorId: "operator",
    scope: "operator",
    reason: "fixture",
    status: "active",
    createdBy: "operator",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("switched-off tool groups in the policy engine", () => {
  let root: string;
  let storage: Storage;
  let asyncStorage: AsyncStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-tool-group-policy-"));
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

  it("denies a tool in a switched-off group with tool_group_off", async () => {
    const policy = config();
    policy.tools.disabledGroups = ["git"];
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    const off = await engine.inspectAccess(request("git.status"));
    expect(off.allowed).toBe(false);
    expect(off.reasonCodes).toEqual(["tool_group_off"]);

    const result = await engine.invoke(request("git.status"));
    expect(result.outcome).toBe("blocked");
    expect(result.policyReason).toContain(SWITCHED_OFF_PHRASE);
    expect(result.policyReason).toContain("git.status");
    // The reason can reach the operator (a failed channel delivery, a Chat tool run), so it names the group's label.
    expect(result.policyReason).toContain("(Git)");
    expect(result.policyReason).not.toContain("(git)");

    // Other groups and Core are untouched.
    expect((await engine.inspectAccess(request("session.status"))).allowed).toBe(true);
    expect((await engine.inspectAccess(request("fs.stat", { path: root }))).reasonCodes).not.toContain(
      "tool_group_off",
    );
  });

  it("still denies it under a local operator override, an allow grant and tools.allow", async () => {
    const policy = config();
    policy.tools.allow = [...ALLOWED_TOOLS, "git.*"];
    policy.tools.disabledGroups = ["git"];
    await asyncStorage.toolGrants.create({
      toolPattern: "git.status",
      scope: "session",
      scopeRef: "tool-group-session",
      decision: "allow",
      grantType: "persistent",
      createdBy: "operator",
    });
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const overridden: ToolInvokeRequest = {
      ...request("git.status"),
      policyContext: { localOperatorOverride: activeOverride() },
    };

    for (const candidate of [request("git.status"), overridden]) {
      const evaluation = await engine.inspectAccess(candidate);
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reasonCodes).toEqual(["tool_group_off"]);
    }
    expect((await engine.invoke(overridden)).outcome).toBe("blocked");

    // Switching the group back on lifts only the group switch: the same call is allowed again.
    policy.tools.disabledGroups = [];
    expect((await engine.inspectAccess(overridden)).allowed).toBe(true);
  });

  it("ignores Core and unknown ids", async () => {
    const policy = config();
    policy.tools.disabledGroups = ["core", "nope"];
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const mcpWrapper = request("mcp.invoke", { serverId: "docs", toolName: "read", arguments: {} });

    expect((await engine.inspectAccess(request("session.status"))).allowed).toBe(true);
    const wrapper = await engine.inspectAccess(mcpWrapper);
    expect(wrapper.allowed).toBe(true);
    expect(wrapper.reasonCodes).not.toContain("tool_group_off");
    expect(engine.listSwitchedOffToolNames().size).toBe(0);
    expect(resolveEffectivePolicy(policy).switchedOffTools?.size ?? 0).toBe(0);
  });

  it("keeps evaluating when a hand-edited disabledGroups isn't a list", async () => {
    const policy = config();
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    for (const handEdited of [5, true, {}, "git"]) {
      policy.tools.disabledGroups = handEdited as never;
      const access = await engine.inspectAccess(request("git.status"));
      expect(access.allowed).toBe(true);
      expect(access.reasonCodes).not.toContain("tool_group_off");
      expect(engine.listSwitchedOffToolNames().size).toBe(0);
    }
  });

  it("ignores disabledGroups set for one agent", async () => {
    const policy = config();
    policy.agents.assistant = { tools: { disabledGroups: ["git"] } };
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);
    expect(resolveEffectivePolicy(policy, "assistant").switchedOffTools?.size ?? 0).toBe(0);
    expect(engine.listSwitchedOffToolNames().size).toBe(0);
  });

  it("keeps policy_deny for a tools.deny entry whether or not its group is on", async () => {
    const policy = config();
    policy.tools.deny = ["git.status"];
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    const groupOn = await engine.inspectAccess(request("git.status"));
    expect(groupOn.allowed).toBe(false);
    expect(groupOn.reasonCodes).toEqual(["policy_deny"]);
    expect((await engine.invoke(request("git.status"))).policyReason).toContain("tool denied by policy");

    policy.tools.disabledGroups = ["git"];
    const groupOff = await engine.inspectAccess(request("git.status"));
    expect(groupOff.allowed).toBe(false);
    expect(groupOff.reasonCodes).toEqual(["policy_deny"]);
    expect((await engine.invoke(request("git.status"))).policyReason).toContain("tool denied by policy");

    // A denied tool in a switched-off group is still reported as switched off to callers that list names.
    expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(true);
  });

  it("takes effect on the next call when the live config changes", async () => {
    const policy = config();
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);
    expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(false);

    policy.tools.disabledGroups = ["git"];
    const off = await engine.inspectAccess(request("git.status"));
    expect(off.allowed).toBe(false);
    expect(off.reasonCodes).toEqual(["tool_group_off"]);
    expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(true);

    policy.tools.disabledGroups = [];
    expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);
    expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(false);
  });

  it("never matches a native MCP tool or a mesh tool", async () => {
    const policy = config();
    policy.tools.disabledGroups = [...SWITCHABLE_TOOL_GROUP_IDS];
    const engine = new ToolPolicyEngine(policy, asyncStorage);

    const mcp: ToolInvokeRequest = { ...request("mcp.docs.read"), externalRuntime: true };
    const mcpEvaluation = await engine.inspectAccess(mcp, {
      mcpToolBinding: createMcpToolPolicyBinding({
        canonicalName: "mcp.docs.read",
        serverId: "docs",
        nativeToolName: "read",
      }),
    });
    expect(mcpEvaluation.reasonCodes).not.toContain("tool_group_off");
    expect(mcpEvaluation.allowed).toBe(true);

    const meshName = "mesh:node-a:tool:project.status";
    const mesh: ToolInvokeRequest = { ...request(meshName), externalRuntime: true };
    const meshEvaluation = await engine.inspectAccess(mesh, {
      meshToolBinding: createMeshToolPolicyBinding({
        canonicalName: meshName,
        nodeId: "node-a",
        kind: "tool",
        localId: "project.status",
      }),
    });
    expect(meshEvaluation.reasonCodes).not.toContain("tool_group_off");
    expect(meshEvaluation.allowed).toBe(true);

    // The same config does switch off a built-in tool, so the two checks above are not vacuous.
    expect((await engine.inspectAccess(request("git.status"))).reasonCodes).toEqual(["tool_group_off"]);
  });

  it("blocks an approved action whose group was switched off after approval", async () => {
    const workDir = path.join(root, "work");
    await fs.mkdir(workDir, { recursive: true });
    const policy = config(workDir);
    policy.tools.approvalMode = "approve_risky";
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const approvedFile = path.join(workDir, "approved.txt");
    const blockedFile = path.join(workDir, "blocked.txt");

    const approve = async (file: string): Promise<string> => {
      const asked = await engine.invoke(request("fs.write", { path: file, content: "hello" }));
      expect(asked.outcome).toBe("approval_required");
      await asyncStorage.approvals.resolve(asked.approvalId!, { decision: "approve", resolvedBy: "operator" });
      return asked.approvalId!;
    };

    // Control: with the group on, an approved write runs.
    const firstId = await approve(approvedFile);
    expect((await engine.executeApprovedAction(firstId))?.outcome).toBe("executed");
    await expect(fs.readFile(approvedFile, "utf8")).resolves.toBe("hello");

    // The operator approves, then switches Files off before the approved action runs.
    const secondId = await approve(blockedFile);
    policy.tools.disabledGroups = ["files"];
    const blocked = await engine.executeApprovedAction(secondId);
    expect(blocked?.outcome).toBe("blocked");
    expect(blocked?.policyReason).toContain(SWITCHED_OFF_PHRASE);
    await expect(fs.stat(blockedFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("plugin holds", () => {
    const meetingTools = { groupId: "git", pluginId: "meeting-tools", pluginName: "Meeting tools" };

    it("denies a held group in every chat even when the operator's switch is on", async () => {
      const policy = config();
      policy.tools.allow = [...ALLOWED_TOOLS, "git.*"];
      const engine = new ToolPolicyEngine(policy, asyncStorage);
      expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);

      engine.setPluginToolGroupHolds([meetingTools]);

      for (const sessionId of ["chat-one", "chat-two"]) {
        const held = await engine.inspectAccess({ ...request("git.status"), sessionId });
        expect(held.allowed).toBe(false);
        // The second code says it is a plugin's hold, for a reader that keeps only the codes (F9).
        expect(held.reasonCodes).toEqual(["tool_group_off", PLUGIN_TOOL_GROUP_HOLD_REASON_CODE]);
        const blocked = await engine.invoke({ ...request("git.status"), sessionId });
        expect(blocked.outcome).toBe("blocked");
        expect(blocked.policyReason).toContain("tool group switched off by the plugin Meeting tools (Git)");
      }
      // A local operator override can't lift a hold either.
      const overridden = await engine.inspectAccess({
        ...request("git.status"),
        policyContext: { localOperatorOverride: activeOverride() },
      });
      expect(overridden.reasonCodes).toEqual(["tool_group_off", "plugin_tool_group_hold"]);
      expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(true);
      expect(engine.listPluginToolGroupHolds()).toEqual([meetingTools]);
      // The resolver reads the same union, so isToolAllowed agrees with the engine.
      const effective = resolveEffectivePolicy(withHeldToolGroups(policy, ["git"]), "assistant");
      expect(isToolAllowed(effective, "git.status")).toBe(false);
      expect(isToolAllowed(effective, "session.status")).toBe(true);
      // The operator's own switch is never written by a hold.
      expect(policy.tools.disabledGroups).toBeUndefined();
      // Other groups and Core stay on.
      expect((await engine.inspectAccess(request("session.status"))).allowed).toBe(true);
    });

    it("keeps a group off after a hold is released if the operator switched it off", async () => {
      const policy = config();
      const engine = new ToolPolicyEngine(policy, asyncStorage);
      engine.setPluginToolGroupHolds([meetingTools]);
      policy.tools.disabledGroups = ["git"];

      engine.setPluginToolGroupHolds([]);

      expect((await engine.inspectAccess(request("git.status"))).reasonCodes).toEqual(["tool_group_off"]);
      expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(true);
      expect(engine.listPluginToolGroupHolds()).toEqual([]);
      expect(policy.tools.disabledGroups).toEqual(["git"]);

      // Without the operator's switch, the released group is back on.
      policy.tools.disabledGroups = [];
      expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);
    });

    it("names the first plugin that holds the group, on one line, and the operator when it's their switch too", async () => {
      const policy = config();
      const engine = new ToolPolicyEngine(policy, asyncStorage);
      engine.setPluginToolGroupHolds([
        { ...meetingTools, pluginName: "  Meeting\n\ttools " },
        { ...meetingTools, pluginId: "repo-rules", pluginName: "Repo rules" },
      ]);

      expect((await engine.invoke(request("git.status"))).policyReason).toContain(
        "tool git.status is in a tool group switched off by the plugin Meeting tools (Git)",
      );

      policy.tools.disabledGroups = ["git"];
      expect((await engine.invoke(request("git.status"))).policyReason).toContain(
        "tool group switched off by the operator (Git)",
      );
      // The operator set the switch, so it isn't read as only a plugin's hold.
      expect((await engine.inspectAccess(request("git.status"))).reasonCodes).toEqual(["tool_group_off"]);
    });

    it("ignores a hold on Core or an unknown group, and a hand-edited switch beside a hold", async () => {
      const policy = config();
      const engine = new ToolPolicyEngine(policy, asyncStorage);
      engine.setPluginToolGroupHolds([
        { ...meetingTools, groupId: "core" },
        { ...meetingTools, groupId: "nope" },
      ]);
      expect((await engine.inspectAccess(request("session.status"))).allowed).toBe(true);
      expect(engine.listSwitchedOffToolNames().size).toBe(0);

      policy.tools.disabledGroups = "git" as never;
      engine.setPluginToolGroupHolds([{ ...meetingTools, groupId: "files" }]);
      expect(engine.listSwitchedOffToolNames().has("fs.write")).toBe(true);
      expect(engine.listSwitchedOffToolNames().has("git.status")).toBe(false);
      expect((await engine.inspectAccess(request("git.status"))).allowed).toBe(true);
    });
  });

  describe("policy resolver", () => {
    it("fills switchedOffTools from config.tools only and denies those tools", () => {
      const policy = config();
      policy.tools.allow = ["*"];
      policy.tools.disabledGroups = ["git", "core", "nope"];
      policy.agents.assistant = { tools: { disabledGroups: ["memory"] } };

      const effective = resolveEffectivePolicy(policy, "assistant");

      expect(effective.switchedOffTools?.get("git.status")).toBe("git");
      expect(effective.switchedOffTools?.has("memory.read")).toBe(false);
      expect(effective.switchedOffTools?.has("session.status")).toBe(false);
      expect(isToolAllowed(effective, "git.status")).toBe(false);
      expect(isToolAllowed(effective, "memory.read")).toBe(true);
    });

    it("denies a switched-off tool even under a local operator override", () => {
      const policy = config();
      policy.tools.disabledGroups = ["shell_and_code"];

      const effective = resolveEffectivePolicy(policy, "assistant", undefined, activeOverride());

      expect(effective.effectiveTools.has("*")).toBe(true);
      expect(isToolAllowed(effective, "shell.exec")).toBe(false);
      expect(isToolAllowed(effective, "fs.read")).toBe(true);
    });
  });
});

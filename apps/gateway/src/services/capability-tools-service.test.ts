import { describe, expect, it, vi } from "vitest";
import {
  TOOL_GROUPS,
  toolGroupForTool,
  type CapabilityToolBlock,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
  type ToolGroupId,
  type ToolPolicyActorContext,
  type ToolRiskLevel,
} from "@goatcitadel/contracts";
import { CapabilityToolsService, type CapabilityToolsSources } from "./capability-tools-service.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ISSUE = "Some tools' rules couldn't be checked right now.";
const POLICY_CONTEXT = {
  operatorId: "operator-1",
  authActorId: "operator-1",
  authActorSource: "token",
  permissionProfileId: "workspace-profile",
} as ToolPolicyActorContext;
const ACTOR = { operatorId: "operator-1", authActorId: "operator-1", authActorSource: "token" } as const;

function entry(toolName: string, riskLevel: ToolRiskLevel = "safe") {
  return { toolName, description: `About ${toolName}`, riskLevel };
}

/** A few tools from several groups, in an order that is not alphabetical. */
const CATALOG = [
  entry("time.now"),
  entry("fs.write", "caution"),
  entry("fs.read"),
  entry("fs.delete", "danger"),
  entry("shell.exec", "nuclear"),
  entry("mcp.invoke", "caution"),
  entry("browser.search"),
];

function access(overrides: Partial<ToolAccessEvaluateResponse> = {}): ToolAccessEvaluateResponse {
  return {
    toolName: "x",
    allowed: true,
    reasonCodes: ["allowed"],
    requiresApproval: false,
    riskLevel: "safe",
    ...overrides,
  };
}

function denied(reasonCode: string): ToolAccessEvaluateResponse {
  return access({ allowed: false, reasonCodes: [reasonCode] });
}

function defaultSources() {
  return {
    listToolCatalog: vi.fn(() => CATALOG),
    readSettings: vi.fn(async () => ({ revision: 7, switchedOffToolGroups: [] as ToolGroupId[] })),
    resolvePolicyContext: vi.fn(async () => POLICY_CONTEXT),
    inspectAccess: vi.fn(async (_request: ToolAccessEvaluateRequest) => access()),
    probeArgs: vi.fn((toolName: string): Record<string, unknown> => ({ probe: toolName })),
    isBlockedByInstall: vi.fn((_toolName: string, _args: Record<string, unknown>) => false),
    reportError: vi.fn((_error: unknown, _failedProbes: number) => undefined),
  } satisfies CapabilityToolsSources;
}

/** Every source is a spy. A test replaces one with another spy, so the result keeps the spy types. */
function build(overrides: Partial<ReturnType<typeof defaultSources>> = {}) {
  const sources = { ...defaultSources(), ...overrides };
  return { sources, service: new CapabilityToolsService(sources, () => NOW) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CapabilityToolsService", () => {
  it("marks Core always on, a switched-off group off, and the rest on", async () => {
    const { service } = build({
      readSettings: vi.fn(async () => ({ revision: 7, switchedOffToolGroups: ["files", "git"] as ToolGroupId[] })),
    });

    const response = await service.list("default", ACTOR);

    expect(response.groups.map((group) => group.groupId)).toEqual(TOOL_GROUPS.map((group) => group.id));
    const state = Object.fromEntries(response.groups.map((group) => [group.groupId, group.state]));
    expect(state.core).toBe("always_on");
    expect(state.files).toBe("off");
    expect(state.git).toBe("off");
    expect(state.shell_and_code).toBe("on");
    expect(state.messaging).toBe("on");
    expect(response.groups.find((group) => group.groupId === "core")).toMatchObject({
      label: "Core",
      description: TOOL_GROUPS[0]?.description,
    });
  });

  it("names each plugin that holds a group off, in the holds' order, and no plugin on any other group", async () => {
    const { service } = build({
      readSettings: vi.fn(async () => ({
        revision: 7,
        switchedOffToolGroups: ["git", "browser", "files"] as ToolGroupId[],
        pluginToolGroupHolds: [
          { groupId: "browser" as ToolGroupId, pluginId: "browser-checks", pluginName: "Browser checks" },
          { groupId: "git" as ToolGroupId, pluginId: "meeting-tools", pluginName: "Meeting tools" },
          { groupId: "browser" as ToolGroupId, pluginId: "meeting-tools", pluginName: "Meeting tools" },
        ],
      })),
    });

    const response = await service.list("default", ACTOR);

    const held = Object.fromEntries(response.groups.map((group) => [group.groupId, group.heldOffBy]));
    expect(held.browser).toEqual([
      { pluginId: "browser-checks", name: "Browser checks" },
      { pluginId: "meeting-tools", name: "Meeting tools" },
    ]);
    expect(held.git).toEqual([{ pluginId: "meeting-tools", name: "Meeting tools" }]);
    // The operator's own switch holds files off: no plugin is named.
    expect(response.groups.find((group) => group.groupId === "files")).toMatchObject({ state: "off" });
    expect(
      response.groups
        .filter((group) => "heldOffBy" in group)
        .map((group) => group.groupId)
        .sort(),
    ).toEqual(["browser", "git"]);
  });

  it("reports the workspace, the settings revision and when the list was made", async () => {
    const { service } = build();

    const response = await service.list("workspace-9", ACTOR);

    expect(response).toMatchObject({
      workspaceId: "workspace-9",
      settingsRevision: 7,
      issues: [],
      generatedAt: NOW.toISOString(),
    });
  });

  it("lists the tools the install offers, in registry order, and leaves tools in no group out", async () => {
    // fs.write comes before fs.read in the registry, and document.propose_patch is missing (document editing is off).
    const { service } = build({
      listToolCatalog: vi.fn(() => [
        entry("fs.write", "caution"),
        entry("mcp.github.create_issue"),
        entry("fs.read"),
        entry("docs.search"),
      ]),
    });

    const response = await service.list("default", ACTOR);

    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.tools.map((tool) => tool.toolName)).toEqual(["fs.write", "fs.read"]);
    const documents = response.groups.find((group) => group.groupId === "documents");
    expect(documents?.tools.map((tool) => tool.toolName)).toEqual(["docs.search"]);
    const listed = response.groups.flatMap((group) => group.tools.map((tool) => tool.toolName));
    expect(listed).not.toContain("document.propose_patch");
    expect(listed).not.toContain("mcp.github.create_issue");
    expect(files?.tools[0]).toEqual({
      toolName: "fs.write",
      description: "About fs.write",
      risk: "caution",
      asks: "runs_freely",
    });
  });

  it("takes each group's risk from its riskiest tool", async () => {
    const { service } = build();

    const response = await service.list("default", ACTOR);

    const risk = Object.fromEntries(response.groups.map((group) => [group.groupId, group.risk]));
    expect(risk.core).toBe("caution");
    expect(risk.files).toBe("danger");
    expect(risk.shell_and_code).toBe("nuclear");
    expect(risk.web_search).toBe("safe");
    // A group with no tools offered on this install reads as safe.
    expect(risk.webhooks).toBe("safe");
  });

  it("reads an allowed tool as asking first or running freely", async () => {
    const { service } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) =>
        access({ requiresApproval: request.toolName === "fs.delete" }),
      ),
    });

    const response = await service.list("default", ACTOR);

    const files = response.groups.find((group) => group.groupId === "files");
    const asks = Object.fromEntries(files?.tools.map((tool) => [tool.toolName, tool.asks]) ?? []);
    expect(asks).toEqual({ "fs.write": "runs_freely", "fs.read": "runs_freely", "fs.delete": "asks_first" });
    expect(files?.blockedToolCount).toBe(0);
    expect(files?.tools.every((tool) => tool.blockedBy === undefined)).toBe(true);
  });

  it.each([
    ["policy_deny", "safety_rules"],
    ["policy_disallow", "safety_rules"],
    ["permission_profile_upper_bound", "permission_profile"],
    ["citadel_ward_deny", "citadel_ward"],
    ["grant_deny", "grant"],
  ] satisfies Array<[string, CapabilityToolBlock]>)("maps %s to %s", async (reasonCode, blockedBy) => {
    const { service } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) =>
        request.toolName === "fs.delete" ? denied(reasonCode) : access(),
      ),
    });

    const response = await service.list("default", ACTOR);

    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.tools.find((tool) => tool.toolName === "fs.delete")).toMatchObject({ blockedBy, asks: "unknown" });
    expect(files?.tools.find((tool) => tool.toolName === "fs.read")?.blockedBy).toBeUndefined();
    expect(files?.blockedToolCount).toBe(1);
    expect(response.issues).toEqual([]);
  });

  it("reads any other denial as unknown, without naming a rule", async () => {
    const { service } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) =>
        request.toolName === "fs.write" ? denied("structural_safety_block") : access(),
      ),
    });

    const response = await service.list("default", ACTOR);

    const write = response.groups
      .find((group) => group.groupId === "files")
      ?.tools.find((tool) => tool.toolName === "fs.write");
    expect(write).toEqual({ toolName: "fs.write", description: "About fs.write", risk: "caution", asks: "unknown" });
    expect(response.groups.find((group) => group.groupId === "files")?.blockedToolCount).toBe(0);
    expect(response.issues).toEqual([]);
  });

  /**
   * The engine checks the deny list before the group switch, so a tool that is also denied reports the deny and every
   * other tool in a switched-off group reports the switch.
   */
  function switchedOffFiles(deniedBy: Record<string, string> = {}) {
    return build({
      readSettings: vi.fn(async () => ({ revision: 7, switchedOffToolGroups: ["files"] as ToolGroupId[] })),
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) => {
        const rule = deniedBy[request.toolName];
        if (rule) return denied(rule);
        return toolGroupForTool(request.toolName)?.id === "files" ? denied("tool_group_off") : access();
      }),
    });
  }

  it("shows a safety-rules block on a switched-off group's denied tool", async () => {
    const { service, sources } = switchedOffFiles({ "fs.delete": "policy_deny" });

    const response = await service.list("default", ACTOR);

    // Every tool is probed, the switched-off group's included, with the same request shape.
    const probed = sources.inspectAccess.mock.calls.map(([request]) => request.toolName);
    expect(probed).toEqual(expect.arrayContaining(["fs.read", "fs.write", "fs.delete", "time.now", "shell.exec"]));
    expect(probed).toHaveLength(CATALOG.length);
    expect(sources.inspectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "fs.delete", sessionId: "capabilities-tools", surface: "chat" }),
    );
    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.state).toBe("off");
    expect(files?.tools.find((tool) => tool.toolName === "fs.delete")).toMatchObject({
      blockedBy: "safety_rules",
      asks: "unknown",
    });
    expect(files?.blockedToolCount).toBe(1);
  });

  it("gives no block for a tool that's only switched off", async () => {
    const { service } = switchedOffFiles({ "fs.delete": "policy_deny" });

    const response = await service.list("default", ACTOR);

    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.tools.map((tool) => [tool.toolName, tool.asks, tool.blockedBy])).toEqual([
      ["fs.write", "unknown", undefined],
      ["fs.read", "unknown", undefined],
      ["fs.delete", "unknown", "safety_rules"],
    ]);
    // The switch is not a rule that blocks the tool, so it isn't counted and it isn't an unreadable answer either.
    expect(files?.blockedToolCount).toBe(1);
    expect(response.issues).toEqual([]);
  });

  it("counts no blocked tool when every tool in a switched-off group is only switched off", async () => {
    const { service } = switchedOffFiles();

    const response = await service.list("default", ACTOR);

    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.tools.every((tool) => tool.asks === "unknown" && tool.blockedBy === undefined)).toBe(true);
    expect(files?.blockedToolCount).toBe(0);
    expect(response.issues).toEqual([]);
  });

  it("takes a group's state from the Settings switches, never from the probe", async () => {
    // The probe says "allowed" for every tool, yet Files is in the switched-off list and Git is not.
    const { service } = build({
      readSettings: vi.fn(async () => ({ revision: 7, switchedOffToolGroups: ["files"] as ToolGroupId[] })),
    });

    const response = await service.list("default", ACTOR);

    expect(response.groups.find((group) => group.groupId === "files")?.state).toBe("off");
    expect(response.groups.find((group) => group.groupId === "git")?.state).toBe("on");
    expect(response.groups.find((group) => group.groupId === "core")?.state).toBe("always_on");
  });

  it("applies the install's profile guard to a switched-off group's tools too", async () => {
    const { service } = build({
      listToolCatalog: vi.fn(() => [entry("browser.cookies.get", "caution"), entry("browser.navigate")]),
      readSettings: vi.fn(async () => ({ revision: 7, switchedOffToolGroups: ["browser"] as ToolGroupId[] })),
      isBlockedByInstall: vi.fn((toolName: string) => toolName === "browser.cookies.get"),
    });

    const response = await service.list("default", ACTOR);

    const browser = response.groups.find((group) => group.groupId === "browser");
    expect(browser?.state).toBe("off");
    expect(browser?.tools.find((tool) => tool.toolName === "browser.cookies.get")?.blockedBy).toBe("install_profile");
    expect(browser?.blockedToolCount).toBe(1);
  });

  it("probes every tool once", async () => {
    const { service, sources } = build();

    await service.list("default", ACTOR);

    const probed = sources.inspectAccess.mock.calls.map(([request]) => request.toolName).sort();
    expect(probed).toEqual(CATALOG.map((tool) => tool.toolName).sort());
  });

  it("says some rules couldn't be checked when a probe throws, once", async () => {
    const { service } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) => {
        if (request.toolName === "fs.write" || request.toolName === "shell.exec") {
          throw new Error("storage unavailable at C:\\data\\goatcitadel.sqlite");
        }
        return access();
      }),
    });

    const response = await service.list("default", ACTOR);

    expect(response.issues).toEqual([ISSUE]);
    const files = response.groups.find((group) => group.groupId === "files");
    expect(files?.tools.find((tool) => tool.toolName === "fs.write")).toMatchObject({ asks: "unknown" });
    expect(files?.tools.find((tool) => tool.toolName === "fs.write")?.blockedBy).toBeUndefined();
    expect(files?.tools.find((tool) => tool.toolName === "fs.read")?.asks).toBe("runs_freely");
    // The real error stays out of the answer.
    expect(JSON.stringify(response)).not.toContain("sqlite");
  });

  it("logs the first probe error once per list with a count", async () => {
    const first = new Error("storage unavailable at C:\\data\\goatcitadel.sqlite");
    const second = new Error("a different failure");
    const { service, sources } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) => {
        if (request.toolName === "fs.write") throw first;
        if (request.toolName === "shell.exec") throw second;
        return access();
      }),
    });

    const response = await service.list("default", ACTOR);

    // One report for the whole list, never one per tool: the first error in tool order and how many probes failed.
    expect(sources.reportError).toHaveBeenCalledTimes(1);
    expect(sources.reportError).toHaveBeenCalledWith(first, 2);
    // The operator-visible answer is unchanged and carries none of the error text.
    expect(response.issues).toEqual([ISSUE]);
    expect(JSON.stringify(response)).not.toContain("sqlite");
  });

  it("logs nothing when every rule check succeeds or the answer is only a denial", async () => {
    const { service, sources } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) =>
        request.toolName === "fs.write" ? denied("structural_safety_block") : access(),
      ),
    });

    await service.list("default", ACTOR);

    expect(sources.reportError).not.toHaveBeenCalled();
  });

  it("logs a failed permission profile once, with the number of tools it left unchecked", async () => {
    const failure = new Error("Bypass permission profiles are unavailable in remote_hardened deployment profile.");
    const { service, sources } = build({
      resolvePolicyContext: vi.fn(async () => {
        throw failure;
      }),
    });

    const response = await service.list("default", ACTOR);

    expect(sources.reportError).toHaveBeenCalledTimes(1);
    expect(sources.reportError).toHaveBeenCalledWith(failure, CATALOG.length);
    expect(response.issues).toEqual([ISSUE]);
  });

  it("logs a list once however many requests share it", async () => {
    const gate = deferred<ToolAccessEvaluateResponse>();
    const { service, sources } = build({
      inspectAccess: vi.fn(async (request: ToolAccessEvaluateRequest) => {
        await gate.promise;
        if (request.toolName === "fs.write") throw new Error("boom");
        return access();
      }),
    });

    const first = service.list("default", ACTOR);
    const second = service.list("default", ACTOR);
    await vi.waitFor(() => expect(sources.inspectAccess).toHaveBeenCalled());
    gate.resolve(access());
    await Promise.all([first, second]);

    expect(sources.reportError).toHaveBeenCalledTimes(1);
  });

  it("still lists the groups when no error reader is wired", async () => {
    const { reportError: _unused, ...rest } = defaultSources();
    const service = new CapabilityToolsService(
      {
        ...rest,
        inspectAccess: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
      () => NOW,
    );

    const response = await service.list("default", ACTOR);

    expect(response.issues).toEqual([ISSUE]);
  });

  it("reads every tool as unknown, with one issue, when the permission profile can't be resolved", async () => {
    const { service, sources } = build({
      resolvePolicyContext: vi.fn(async () => {
        throw new Error("profile store unavailable");
      }),
    });

    const response = await service.list("default", ACTOR);

    expect(response.issues).toEqual([ISSUE]);
    expect(sources.inspectAccess).not.toHaveBeenCalled();
    expect(response.groups.flatMap((group) => group.tools).every((tool) => tool.asks === "unknown")).toBe(true);
    expect(response.groups.flatMap((group) => group.tools).length).toBe(CATALOG.length);
  });

  it("uses the workspace's permission profile for the probes", async () => {
    const { service, sources } = build();

    await service.list("workspace-9", ACTOR);

    // Resolved once for the whole list, for this workspace, this operator and the chat surface.
    expect(sources.resolvePolicyContext).toHaveBeenCalledTimes(1);
    expect(sources.resolvePolicyContext).toHaveBeenCalledWith({
      workspaceId: "workspace-9",
      surface: "chat",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
    });
    const requests = sources.inspectAccess.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(CATALOG.length);
    for (const request of requests) {
      expect(request).toEqual({
        toolName: request.toolName,
        agentId: "assistant",
        sessionId: "capabilities-tools",
        workspaceId: "workspace-9",
        surface: "chat",
        args: { probe: request.toolName },
        policyContext: POLICY_CONTEXT,
        permissionProfileId: "workspace-profile",
      });
    }
  });

  it("probes 8 tools at a time", async () => {
    const names = TOOL_GROUPS.flatMap((group) => group.toolNames).slice(0, 40);
    let active = 0;
    let peak = 0;
    const { service, sources } = build({
      listToolCatalog: vi.fn(() => names.map((name) => entry(name))),
      inspectAccess: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return access();
      }),
    });

    await service.list("default", ACTOR);

    expect(sources.inspectAccess).toHaveBeenCalledTimes(40);
    expect(peak).toBe(8);
  });

  it("reports a tool this install's profile blocks without probing it", async () => {
    const { service, sources } = build({
      listToolCatalog: vi.fn(() => [entry("browser.cookies.get", "caution"), entry("browser.navigate")]),
      isBlockedByInstall: vi.fn((toolName: string) => toolName === "browser.cookies.get"),
    });

    const response = await service.list("default", ACTOR);

    const browser = response.groups.find((group) => group.groupId === "browser");
    expect(browser?.tools.find((tool) => tool.toolName === "browser.cookies.get")).toMatchObject({
      blockedBy: "install_profile",
      asks: "unknown",
    });
    expect(browser?.tools.find((tool) => tool.toolName === "browser.navigate")?.blockedBy).toBeUndefined();
    expect(browser?.blockedToolCount).toBe(1);
    expect(sources.inspectAccess.mock.calls.map(([request]) => request.toolName)).toEqual(["browser.navigate"]);
    // The install check sees the same arguments the probe would send.
    expect(sources.isBlockedByInstall).toHaveBeenCalledWith("browser.cookies.get", { probe: "browser.cookies.get" });
  });

  it("still reports an install block when the permission profile can't be resolved", async () => {
    const { service } = build({
      listToolCatalog: vi.fn(() => [entry("browser.cookies.get", "caution"), entry("browser.navigate")]),
      isBlockedByInstall: vi.fn((toolName: string) => toolName === "browser.cookies.get"),
      resolvePolicyContext: vi.fn(async () => {
        throw new Error("profile store unavailable");
      }),
    });

    const response = await service.list("default", ACTOR);

    const browser = response.groups.find((group) => group.groupId === "browser");
    expect(browser?.tools.find((tool) => tool.toolName === "browser.cookies.get")?.blockedBy).toBe("install_profile");
    expect(response.issues).toEqual([ISSUE]);
  });

  it("shares one list between concurrent requests for the same workspace", async () => {
    const gate = deferred<ToolAccessEvaluateResponse>();
    const { service, sources } = build({ inspectAccess: vi.fn(() => gate.promise) });

    const first = service.list("default", ACTOR);
    const second = service.list("default", ACTOR);
    // Both requests have read the settings by now.
    await vi.waitFor(() => expect(sources.inspectAccess).toHaveBeenCalled());
    gate.resolve(access());
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(secondResponse).toBe(firstResponse);
    expect(sources.inspectAccess).toHaveBeenCalledTimes(CATALOG.length);
    expect(sources.resolvePolicyContext).toHaveBeenCalledTimes(1);
  });

  it("doesn't share a list between workspaces or operators", async () => {
    const { service, sources } = build();

    await Promise.all([
      service.list("default", ACTOR),
      service.list("other", ACTOR),
      service.list("default", { ...ACTOR, operatorId: "operator-2", authActorId: "operator-2" }),
    ]);

    expect(sources.resolvePolicyContext).toHaveBeenCalledTimes(3);
  });

  it("doesn't keep a finished list, so a switch shows on the next request", async () => {
    let switchedOff: ToolGroupId[] = [];
    let revision = 7;
    const { service, sources } = build({
      readSettings: vi.fn(async () => ({ revision, switchedOffToolGroups: switchedOff })),
    });

    const before = await service.list("default", ACTOR);
    switchedOff = ["files"];
    revision = 8;
    const after = await service.list("default", ACTOR);

    expect(before.groups.find((group) => group.groupId === "files")?.state).toBe("on");
    expect(after.groups.find((group) => group.groupId === "files")?.state).toBe("off");
    expect(after.settingsRevision).toBe(8);
    expect(sources.resolvePolicyContext).toHaveBeenCalledTimes(2);
  });

  it("doesn't join a list that was started before a switch", async () => {
    let switchedOff: ToolGroupId[] = [];
    let revision = 7;
    const gate = deferred<ToolAccessEvaluateResponse>();
    let held = true;
    const { service, sources } = build({
      readSettings: vi.fn(async () => ({ revision, switchedOffToolGroups: switchedOff })),
      inspectAccess: vi.fn(async () => (held ? gate.promise : access())),
    });

    const slow = service.list("default", ACTOR);
    await vi.waitFor(() => expect(sources.inspectAccess).toHaveBeenCalled());
    // The operator switches Files off while the first list is still being checked.
    switchedOff = ["files"];
    revision = 8;
    held = false;
    const fresh = await service.list("default", ACTOR);
    gate.resolve(access());
    const stale = await slow;

    expect(fresh.groups.find((group) => group.groupId === "files")?.state).toBe("off");
    expect(fresh.settingsRevision).toBe(8);
    expect(stale.settingsRevision).toBe(7);
  });

  it("lets the next request start again after a list fails", async () => {
    let calls = 0;
    const { service } = build({
      listToolCatalog: vi.fn(() => {
        calls += 1;
        if (calls === 1) throw new Error("catalog unavailable");
        return CATALOG;
      }),
    });

    await expect(service.list("default", ACTOR)).rejects.toThrow("catalog unavailable");
    const response = await service.list("default", ACTOR);

    expect(response.groups.find((group) => group.groupId === "files")?.tools).toHaveLength(3);
  });
});

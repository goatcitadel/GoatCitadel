import type { ToolAccessEvaluateRequest, ToolPolicyActorContext } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { filterBasePromptToolsetByPolicy } from "./base-prompt-capability-catalog.js";
import { resolveBasePromptPolicyScope, withBasePromptPolicyScope } from "./base-prompt-policy-scope.js";
import { GatewayService } from "./gateway-service.js";

const SCOPE = { sessionId: "session-1", workspaceId: "workspace-1", mode: "chat" } as const;
const TOOL_NAMES = [
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.patch",
  "shell.exec",
  "documents.create",
  "artifacts.create",
  "browser.search",
  "browser.read",
  "memory.search",
  "time.now",
  "user_input.request",
];

function createGateway(profile: { profileId: string; deny: string[]; askFirst: string[] }) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, unknown>;
  const counters = {
    resolveContext: vi.fn(async () => ({ permissionProfile: profile })),
    findWorkspace: vi.fn(async () => ({ citadelId: "personal" })),
    sessionProject: vi.fn(async () => undefined),
  };
  // The decision reads the probe request's resolved permission profile, so a probe that lost its policy context
  // would not match the per-tool path.
  const inspectAccess = vi.fn((request: ToolAccessEvaluateRequest) => {
    const resolved = request.policyContext?.permissionProfile as unknown as typeof profile | undefined;
    const denied = !resolved || resolved.deny.includes(request.toolName);
    return {
      toolName: request.toolName,
      allowed: !denied,
      requiresApproval: !denied && resolved.askFirst.includes(request.toolName),
      reasonCodes: denied ? ["policy_deny"] : ["allowed"],
      riskLevel: "safe",
    };
  });
  Object.assign(gateway, {
    config: {
      rootDir: "/repo",
      assistant: { workspaceDir: "workspace", deploymentProfile: "local", web: { firecrawl: { enabled: false } } },
    },
    policyEngine: { inspectAccess },
    workspaceTurnSkills: {
      listInstalledCatalog: vi.fn(async () => TOOL_NAMES.map((toolName) => ({ kind: "tool", toolName }))),
    },
    storage: {
      chatSessionMeta: { get: vi.fn(async () => undefined) },
      chatSessionProjects: { get: counters.sessionProject },
      chatProjects: { find: vi.fn(async () => undefined) },
      chatDelegationSteps: {
        listParentsByChildSessionIds: vi.fn(async () => new Map()),
        get: vi.fn(async () => undefined),
      },
      workspaces: { find: counters.findWorkspace },
      permissionProfiles: { resolveContext: counters.resolveContext },
    },
  });
  return { gateway, counters };
}

describe("resolveBasePromptCapabilityCatalog policy scope", () => {
  const profile = { profileId: "custom", deny: ["fs.write"], askFirst: ["shell.exec"] };

  it("resolves the turn's policy context, Citadel and session project once for the whole catalog", async () => {
    const { gateway, counters } = createGateway(profile);
    const catalog = await gateway.resolveBasePromptCapabilityCatalog(SCOPE);

    expect(catalog.toolNames).toHaveLength(TOOL_NAMES.length - 1);
    expect(counters.resolveContext).toHaveBeenCalledTimes(1);
    expect(counters.findWorkspace).toHaveBeenCalledTimes(1);
    expect(counters.sessionProject).toHaveBeenCalledTimes(1);
  });

  it("keeps one session project read per probe outside a catalog build", async () => {
    const { gateway, counters } = createGateway(profile);
    await filterBasePromptToolsetByPolicy(
      { toolNames: TOOL_NAMES, skills: [] },
      SCOPE,
      (request) => gateway.inspectToolAccess(request),
      "/repo/workspace/goatcitadel_out",
    );

    expect(counters.sessionProject).toHaveBeenCalledTimes(TOOL_NAMES.length);
  });

  it("lists no tool when the session's project cannot be read", async () => {
    const { gateway, counters } = createGateway(profile);
    counters.sessionProject.mockRejectedValue(new Error("project store unavailable"));
    const catalog = await gateway.resolveBasePromptCapabilityCatalog(SCOPE);

    expect(catalog.toolNames).toEqual([]);
    expect(catalog.policyDeniedToolNames).toEqual(TOOL_NAMES);
    expect(counters.sessionProject).toHaveBeenCalledTimes(1);
  });

  it("resolves the context the per-tool path resolves for a probe without one", async () => {
    const { gateway, counters } = createGateway(profile);
    await gateway.resolveBasePromptCapabilityCatalog(SCOPE);

    expect(counters.resolveContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "system",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        surface: "chat",
        defaultProfileId: "safe",
      }),
    );
  });

  it("returns the same catalog as probing each tool with its own policy lookup", async () => {
    const { gateway } = createGateway(profile);
    const perTool = await filterBasePromptToolsetByPolicy(
      { toolNames: TOOL_NAMES, skills: [] },
      SCOPE,
      (request) => gateway.inspectToolAccess(request),
      "/repo/workspace/goatcitadel_out",
    );
    const { gateway: fresh } = createGateway(profile);
    const catalog = await fresh.resolveBasePromptCapabilityCatalog(SCOPE);

    const pick = (toolset: typeof catalog) => ({
      toolNames: toolset.toolNames,
      policyDeniedToolNames: toolset.policyDeniedToolNames,
      approvalRequiredToolNames: toolset.approvalRequiredToolNames,
    });
    expect(pick(perTool)).toEqual({
      toolNames: TOOL_NAMES.filter((name) => name !== "fs.write"),
      policyDeniedToolNames: ["fs.write"],
      approvalRequiredToolNames: ["shell.exec"],
    });
    expect(pick(catalog)).toEqual(pick(perTool));
  });

  it("lists no tool when the turn's policy context cannot be resolved", async () => {
    const { gateway, counters } = createGateway(profile);
    counters.resolveContext.mockRejectedValue(new Error("permission store unavailable"));
    const catalog = await gateway.resolveBasePromptCapabilityCatalog(SCOPE);

    expect(catalog.toolNames).toEqual([]);
    expect(catalog.policyDeniedToolNames).toEqual(TOOL_NAMES);
  });
});

describe("resolveBasePromptPolicyScope", () => {
  const policyContext = { permissionProfileId: "safe" } as ToolPolicyActorContext;

  it("returns the workspace, its Citadel and the resolved context, and leaves out an absent Citadel", async () => {
    const resolveToolPolicyContext = vi.fn(async () => policyContext);
    await expect(
      resolveBasePromptPolicyScope(
        { resolveToolPolicyContext, findWorkspace: async () => ({ citadelId: "c1" }) },
        SCOPE,
      ),
    ).resolves.toEqual({ workspaceId: "workspace-1", citadelId: "c1", policyContext });
    await expect(
      resolveBasePromptPolicyScope({ resolveToolPolicyContext, findWorkspace: async () => undefined }, SCOPE),
    ).resolves.toEqual({ workspaceId: "workspace-1", policyContext });
  });
});

describe("withBasePromptPolicyScope", () => {
  it("keeps per-probe resolution for a scope without a workspace", async () => {
    const inspectToolAccess = vi.fn(async (request: ToolAccessEvaluateRequest) => request as never);
    const resolveToolPolicyContext = vi.fn();
    const findWorkspace = vi.fn();
    const probe = withBasePromptPolicyScope(
      { sessionId: "session-1", mode: "chat" },
      { inspectToolAccess, resolveToolPolicyContext },
      findWorkspace,
    );
    const request = { toolName: "fs.read", agentId: "assistant", sessionId: "session-1" };
    await probe(request);

    expect(inspectToolAccess).toHaveBeenCalledWith(request);
    expect(resolveToolPolicyContext).not.toHaveBeenCalled();
    expect(findWorkspace).not.toHaveBeenCalled();
  });
});

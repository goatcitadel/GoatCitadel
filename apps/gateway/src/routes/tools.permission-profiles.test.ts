import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { toolsRoutes } from "./tools.js";

function createProfile() {
  return {
    profileId: "profile-1",
    label: "Custom",
    builtin: false,
    status: "active",
    scope: "operator",
    scopeRef: "operator-test",
    approvalMode: "approve_all",
    toolPatterns: ["session.status"],
    createdBy: "operator-test",
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
}

function createWorkspaceProfile() {
  return {
    ...createProfile(),
    profileId: "workspace-profile",
    label: "Workspace Custom",
    scope: "workspace",
    scopeRef: "workspace-1",
  };
}

describe("tools permission profile routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns hardened-mode errors for bypass profile create, update, and activation", async () => {
    const hardenedError = new Error(
      "Bypass permission profiles are unavailable in remote_hardened deployment profile.",
    );
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => [createProfile()]),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      createPermissionProfile: vi.fn(() => {
        throw hardenedError;
      }),
      updatePermissionProfile: vi.fn(() => {
        throw hardenedError;
      }),
      activatePermissionProfile: vi.fn(() => {
        throw hardenedError;
      }),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools } as never);
    await app.register(toolsRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/tools/permission-profiles",
      payload: {
        label: "Bypass",
        approvalMode: "bypass",
      },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toEqual({ error: hardenedError.message });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/tools/permission-profiles/profile-1",
      payload: {
        approvalMode: "bypass",
      },
    });
    expect(updateResponse.statusCode).toBe(400);
    expect(updateResponse.json()).toEqual({ error: hardenedError.message });

    const activateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/tools/permission-profiles/activate",
      payload: {
        profileId: "profile-1",
        surface: "code",
      },
    });
    expect(activateResponse.statusCode).toBe(400);
    expect(activateResponse.json()).toEqual({ error: hardenedError.message });
  });

  it("activates workspace-scoped profiles as workspace defaults rather than operator-only defaults", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => [createWorkspaceProfile()]),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      activatePermissionProfile: vi.fn((input) => ({
        activationId: "activation-1",
        ...input,
      })),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/permission-profiles/activate",
      payload: {
        profileId: "workspace-profile",
        workspaceId: "workspace-1",
        surface: "code",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(tools.activatePermissionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "workspace-profile",
        workspaceId: "workspace-1",
        surface: "code",
        operatorId: undefined,
        createdBy: "operator-test",
      }),
    );
  });

  it("filters listed profiles to global, actor-owned, and requested workspace scopes", async () => {
    const otherOperator = { ...createProfile(), profileId: "other-operator", scopeRef: "operator-other" };
    const otherWorkspace = { ...createWorkspaceProfile(), profileId: "workspace-other", scopeRef: "workspace-other" };
    const builtin = { ...createProfile(), profileId: "safe", builtin: true, scope: "global", scopeRef: undefined };
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => [
        builtin,
        createProfile(),
        otherOperator,
        createWorkspaceProfile(),
        otherWorkspace,
      ]),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tools/permission-profiles?workspaceId=workspace-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((profile: { profileId: string }) => profile.profileId)).toEqual([
      "safe",
      "profile-1",
      "workspace-profile",
    ]);
  });

  it("rejects one-time deny grants before creating durable grant state", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      createToolGrant: vi.fn(),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/grants",
      payload: {
        toolPattern: "shell.exec",
        decision: "deny",
        scope: "global",
        grantType: "one_time",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("one_time grants can only be allow grants");
    expect(tools.createToolGrant).not.toHaveBeenCalled();
  });

  it("mirrors deployment profile restrictions in access evaluation", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      resolveToolPolicyContext: vi.fn(() => ({ profileId: "safe" })),
      evaluateToolAccess: vi.fn(() => ({
        decision: "allow",
        allowed: true,
        requiresApproval: false,
        reasonCodes: [],
        policyReason: "allowed by policy",
      })),
    };
    const toolsInvoke = {
      getDeploymentProfile: vi.fn(() => "remote_hardened" as const),
      isFeatureEnabled: vi.fn(() => false),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools, toolsInvoke } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      payload: {
        toolName: "browser.cookies.get",
        agentId: "agent-1",
        sessionId: "session-1",
        args: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      requiresApproval: false,
      reasonCodes: ["deployment_profile_block"],
      policyReason: "Browser cookies and storage tools are restricted to the trusted_local deployment profile.",
    });
  });

  it("mirrors computer-use confirmation guardrails in access evaluation", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      resolveToolPolicyContext: vi.fn(() => ({ profileId: "safe" })),
      evaluateToolAccess: vi.fn(() => ({
        decision: "allow",
        allowed: true,
        requiresApproval: false,
        reasonCodes: [],
        policyReason: "allowed by policy",
      })),
    };
    const toolsInvoke = {
      getDeploymentProfile: vi.fn(() => "local_dev" as const),
      isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools, toolsInvoke } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      payload: {
        toolName: "browser.interact",
        agentId: "agent-1",
        sessionId: "session-1",
        args: { steps: [{ action: "click", selector: "button[type=submit]" }] },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      requiresApproval: false,
      reasonCodes: ["computer_use_guardrail_block"],
      policyReason:
        "Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
    });
  });

  it("passes source attribution into access evaluation preflight", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      resolveToolPolicyContext: vi.fn(() => ({ profileId: "safe" })),
      evaluateToolAccess: vi.fn((input: { sourceAttribution?: Array<{ trustLevel?: string }> }) =>
        input.sourceAttribution?.some((source) => source.trustLevel === "untrusted_external")
          ? {
              allowed: false,
              requiresApproval: false,
              reasonCodes: ["untrusted_source_privileged_tool_block"],
              policyReason:
                "tool shell.exec is blocked because untrusted external content cannot escalate into privileged execution",
            }
          : {
              allowed: true,
              requiresApproval: false,
              reasonCodes: ["allowed"],
              policyReason: "allowed",
            },
      ),
    };
    const toolsInvoke = {
      getDeploymentProfile: vi.fn(() => "local_dev" as const),
      isFeatureEnabled: vi.fn(() => false),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools, toolsInvoke } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      payload: {
        toolName: "shell.exec",
        agentId: "agent-1",
        sessionId: "session-1",
        args: { command: "echo hello" },
        sourceAttribution: [
          {
            sourceType: "url",
            sourceRef: "https://example.com/prompt",
            trustLevel: "untrusted_external",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      requiresApproval: false,
      reasonCodes: ["untrusted_source_privileged_tool_block"],
    });
    expect(tools.evaluateToolAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "shell.exec",
        sourceAttribution: [
          {
            sourceType: "url",
            sourceRef: "https://example.com/prompt",
            trustLevel: "untrusted_external",
          },
        ],
      }),
    );
  });

  it("does not mirror computer-use guardrails after verification and confirmation are present", async () => {
    const evaluation = {
      decision: "allow",
      allowed: true,
      requiresApproval: false,
      reasonCodes: ["allowed"],
      policyReason: "allowed by policy",
    };
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      resolveToolPolicyContext: vi.fn(() => ({ profileId: "safe" })),
      evaluateToolAccess: vi.fn(() => evaluation),
    };
    const toolsInvoke = {
      getDeploymentProfile: vi.fn(() => "local_dev" as const),
      isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools, toolsInvoke } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      payload: {
        toolName: "browser.interact",
        agentId: "agent-1",
        sessionId: "session-1",
        args: {
          verifyStep: true,
          confirmBeforeSubmit: true,
          steps: [{ action: "click", selector: "button[type=submit]" }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(evaluation);
  });

  it("returns 404 when activating a missing permission profile", async () => {
    const tools = {
      listToolCatalog: vi.fn(() => []),
      listPermissionProfiles: vi.fn(() => []),
      listActiveLocalOperatorOverrides: vi.fn(() => []),
      activatePermissionProfile: vi.fn(),
    };

    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    app.decorate("services", { tools } as never);
    await app.register(toolsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/permission-profiles/activate",
      payload: {
        profileId: "missing-profile",
        surface: "code",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(tools.activatePermissionProfile).not.toHaveBeenCalled();
  });
});

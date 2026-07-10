import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { toolsInvokeRoute } from "./tools-invoke.js";

describe("tools invoke route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("blocks mutating browser actions without verification", async () => {
    const invokeTool = vi.fn();
    app = Fastify();
    app.decorate("services", {
      toolsInvoke: {
        invokeTool,
        isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
        getDeploymentProfile: vi.fn(() => "local_dev"),
      },
    } as never);
    await app.register(toolsInvokeRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/invoke",
      payload: {
        toolName: "browser.interact",
        args: {
          steps: [{ action: "click" }],
        },
        agentId: "agent-1",
        sessionId: "session-1",
        trustLevel: "trusted_workspace",
        authContext: {
          boundary: "tool_host_boundary",
          secretRefs: ["keychain:goatcitadel:provider:openai"],
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("passes validated requests to the gateway with safety metadata", async () => {
    const invokeTool = vi.fn(async (input) => ({ ok: true, input }));
    const resolveToolPolicyContext = vi.fn((input) => ({
      ...input,
      permissionProfileId: input.permissionProfileId ?? "safe",
      permissionProfile: { profileId: input.permissionProfileId ?? "safe", label: "Safe" },
    }));
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      tools: {
        resolveToolPolicyContext,
      },
      toolsInvoke: {
        invokeTool,
        isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
        getDeploymentProfile: vi.fn(() => "local_dev"),
      },
    } as never);
    await app.register(toolsInvokeRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/invoke",
      payload: {
        toolName: "browser.interact",
        args: {
          steps: [{ action: "click" }],
          verifyStep: true,
          confirmBeforeSubmit: true,
        },
        agentId: "agent-1",
        sessionId: "session-1",
        trustLevel: "trusted_workspace",
        authContext: {
          boundary: "tool_host_boundary",
          secretRefs: ["keychain:goatcitadel:provider:openai"],
        },
        permissionProfileId: "safe",
        surface: "code",
        consentContext: {
          reason: " approval:client-supplied ",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          __gcSafety: {
            verified: true,
            confirmed: true,
            enforced: true,
          },
        }),
        trustLevel: "trusted_workspace",
        policyContext: expect.objectContaining({
          authActorId: "operator-test",
          permissionProfileId: "safe",
          surface: "code",
        }),
        authContext: {
          boundary: "tool_host_boundary",
          secretRefs: ["keychain:goatcitadel:provider:openai"],
        },
        consentContext: expect.objectContaining({
          reason: " approval:client-supplied ",
        }),
      }),
    );
  });

  it("projects tool results at the direct public invocation boundary without mutating runtime truth", async () => {
    const rawResult = {
      status: "completed",
      output: {
        authorization: "Bearer direct-tool-secret",
        callbackUrl: "https://discord.com/api/webhooks/123/direct-tool-path-secret",
      },
      audit: { tokenId: "safe-tool-token-id" },
    };
    const invokeTool = vi.fn(async () => rawResult);
    app = Fastify();
    app.decorate("services", {
      tools: { resolveToolPolicyContext: vi.fn(() => ({ permissionProfileId: "safe" })) },
      toolsInvoke: {
        invokeTool,
        isFeatureEnabled: vi.fn(() => false),
        getDeploymentProfile: vi.fn(() => "local_dev"),
      },
    } as never);
    await app.register(toolsInvokeRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/invoke",
      payload: {
        toolName: "http.get",
        args: { url: "https://example.test" },
        agentId: "agent-1",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "completed",
      output: {
        authorization: "[REDACTED]",
        callbackUrl: "https://discord.com/api/webhooks/[REDACTED]/[REDACTED]",
      },
      audit: { tokenId: "safe-tool-token-id" },
    });
    expect(rawResult.output.authorization).toContain("direct-tool-secret");
    expect(rawResult.output.callbackUrl).toContain("direct-tool-path-secret");
  });

  it("blocks browser cookie tools outside trusted_local", async () => {
    const invokeTool = vi.fn();
    app = Fastify();
    app.decorate("services", {
      toolsInvoke: {
        invokeTool,
        isFeatureEnabled: vi.fn(() => false),
        getDeploymentProfile: vi.fn(() => "remote_hardened"),
      },
    } as never);
    await app.register(toolsInvokeRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/invoke",
      payload: {
        toolName: "browser.cookies.get",
        args: {},
        agentId: "agent-1",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("enforces confirm-before-submit in remote_hardened even when the feature flag is off", async () => {
    const invokeTool = vi.fn();
    app = Fastify();
    app.decorate("services", {
      toolsInvoke: {
        invokeTool,
        isFeatureEnabled: vi.fn(() => false),
        getDeploymentProfile: vi.fn(() => "remote_hardened"),
      },
    } as never);
    await app.register(toolsInvokeRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tools/invoke",
      payload: {
        toolName: "browser.interact",
        args: {
          steps: [{ action: "click" }],
          verifyStep: true,
        },
        agentId: "agent-1",
        sessionId: "session-1",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

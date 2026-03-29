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
    app.decorate("gateway", {
      invokeTool,
      isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
      getDeploymentProfile: vi.fn(() => "local_dev"),
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
    app = Fastify();
    app.decorate("gateway", {
      invokeTool,
      isFeatureEnabled: vi.fn((flag: string) => flag === "computerUseGuardrailsV1Enabled"),
      getDeploymentProfile: vi.fn(() => "local_dev"),
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
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({
        __gcSafety: {
          verified: true,
          confirmed: true,
          enforced: true,
        },
      }),
      trustLevel: "trusted_workspace",
      authContext: {
        boundary: "tool_host_boundary",
        secretRefs: ["keychain:goatcitadel:provider:openai"],
      },
    }));
  });

  it("blocks browser cookie tools outside trusted_local", async () => {
    const invokeTool = vi.fn();
    app = Fastify();
    app.decorate("gateway", {
      invokeTool,
      isFeatureEnabled: vi.fn(() => false),
      getDeploymentProfile: vi.fn(() => "remote_hardened"),
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
    app.decorate("gateway", {
      invokeTool,
      isFeatureEnabled: vi.fn(() => false),
      getDeploymentProfile: vi.fn(() => "remote_hardened"),
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

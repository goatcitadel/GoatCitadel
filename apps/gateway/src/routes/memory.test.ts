import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { memoryRoutes } from "./memory.js";

describe("memory routes", () => {
  let app: FastifyInstance | null = null;

  function buildApp(gateway: Record<string, unknown>, requireOperatorAuth = vi.fn(async () => undefined)) {
    const built = Fastify();
    built.decorate("requireOperatorAuth", requireOperatorAuth as never);
    built.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
        },
      },
    } as never);
    built.decorate("services", {
      memory: {
        ...gateway,
        forget: gateway.forget ?? gateway.forgetMemory,
        runMaintenanceNow: gateway.runMaintenanceNow ?? gateway.runMemoryMaintenanceNow,
        getContext: gateway.getContext ?? gateway.getMemoryContext,
      },
    } as never);
    return { app: built, requireOperatorAuth };
  }

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects bulk forget without any criteria", async () => {
    const forgetMemory = vi.fn();
    const built = buildApp({
      forgetMemory,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(forgetMemory).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          itemIds: expect.arrayContaining(["Provide at least one criterion: itemIds, namespace, or query."]),
        },
      },
    });
    expect(response.json()).not.toMatchObject({
      error: {
        formErrors: expect.arrayContaining(["Provide at least one criterion: itemIds, namespace, or query."]),
      },
    });
  });

  it("forgets matching memory rows when criteria are provided", async () => {
    const forgetMemory = vi.fn(() => ({
      forgottenCount: 1,
      itemIds: ["mem_1"],
    }));
    const built = buildApp({
      forgetMemory,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      payload: {
        namespace: "project.alpha",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(forgetMemory).toHaveBeenCalledTimes(1);
    expect(forgetMemory).toHaveBeenCalledWith({
      itemIds: undefined,
      namespace: "project.alpha",
      query: undefined,
      actorId: expect.stringMatching(/^ip:/),
    });
    expect(response.json()).toEqual({
      forgottenCount: 1,
      itemIds: ["mem_1"],
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(1);
  });

  it("validates memory context route params", async () => {
    const getMemoryContext = vi.fn(() => ({ contextId: "ctx-1", scope: "chat" }));
    app = Fastify();
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "none",
        },
      },
    } as never);
    app.decorate("services", {
      memory: {
        getContext: getMemoryContext,
      },
    } as never);
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/",
    });
    expect(response.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/%20",
    });
    expect(malformed.statusCode).toBe(400);
    expect(getMemoryContext).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/memory/context/ctx-1",
    });
    expect(valid.statusCode).toBe(200);
    expect(getMemoryContext).toHaveBeenCalledWith("ctx-1");
  });

  it("passes explicit memory relation scope through context composition", async () => {
    const composeContext = vi.fn((input) => ({
      contextId: "ctx-compose",
      scope: input.scope,
      relationScope: input.relationScope,
    }));
    const built = buildApp({ composeContext });
    app = built.app;
    await app.register(memoryRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/context/compose",
      payload: {
        scope: "chat",
        prompt: "Find browser governance memory.",
        relationScope: "project",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(composeContext).toHaveBeenCalledWith({
      scope: "chat",
      prompt: "Find browser governance memory.",
      relationScope: "project",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/memory/context/compose",
      payload: {
        scope: "chat",
        prompt: "Find browser governance memory.",
        relationScope: "global",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("accepts memory maintenance run-now on both the canonical and compatibility paths", async () => {
    const runMemoryMaintenanceNow = vi.fn(() => ({
      runId: "mmrun_123",
      workspaceId: "default",
      triggerSource: "manual",
      status: "queued",
    }));
    const built = buildApp({
      runMemoryMaintenanceNow,
    });
    app = built.app;
    await app.register(memoryRoutes);

    const canonical = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/run-now",
      payload: {
        workspaceId: "default",
        triggerSource: "manual",
      },
    });
    const compatibility = await app.inject({
      method: "POST",
      url: "/api/v1/memory/maintenance/run",
      payload: {
        workspaceId: "default",
      },
    });

    expect(canonical.statusCode).toBe(200);
    expect(compatibility.statusCode).toBe(200);
    expect(runMemoryMaintenanceNow).toHaveBeenNthCalledWith(1, {
      workspaceId: "default",
      triggerSource: "manual",
    });
    expect(runMemoryMaintenanceNow).toHaveBeenNthCalledWith(2, {
      workspaceId: "default",
    });
    expect(built.requireOperatorAuth).toHaveBeenCalledTimes(2);
  });
});

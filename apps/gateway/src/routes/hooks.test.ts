import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { hooksRoutes } from "./hooks.js";

describe("hooks routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists hooks and runs through structured public projection without mutating raw records", async () => {
    const hooks = createHooksService();
    app = buildApp(hooks);

    const listed = await app.inject({ method: "GET", url: "/api/v1/workspaces/workspace-1/hooks?limit=2" });
    const runs = await app.inject({ method: "GET", url: "/api/v1/workspaces/workspace-1/hooks/runs?limit=3" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          hookId: "hook-1",
          workspaceId: "workspace-1",
          label: "Notify",
          action: {
            type: "webhook",
            webhook: {
              url: "[REDACTED]",
              secret: "[REDACTED]",
            },
          },
        },
      ],
    });
    expect(runs.json()).toEqual({
      items: [
        {
          runId: "run-1",
        },
      ],
    });
    expect(hooks.listWorkspaceHooks).toHaveBeenCalledWith("workspace-1", 2);
    expect(hooks.listWorkspaceHookRuns).toHaveBeenCalledWith("workspace-1", 3);
    expect(hooks.rawHookRecord.action.webhook).toEqual({
      url: "https://hooks.example.test/services/team/legacy-hook-secret",
      secret: "super-secret",
    });
    expect(hooks.rawHookRun.requestPayload.authorization).toBe("Bearer tiny");
    expect(hooks.rawHookRun.responsePayload.DATABASE_PASSWORD).toBe("db-short");
  });

  it("creates, updates, and deletes workspace hooks through the route service", async () => {
    const hooks = createHooksService();
    app = buildApp(hooks);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/workspace-1/hooks",
      payload: {
        label: "Before tool",
        trigger: "tool.call.before",
        mode: "mutate",
        enabled: true,
        priority: 50,
        timeoutMs: 1000,
        failPolicy: "closed",
        action: {
          type: "webhook",
          webhook: {
            url: "https://hooks.example.test/tool?token=create-short&mode=events",
            secret: "secret-value",
          },
        },
      },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/workspaces/workspace-1/hooks/hook-1",
      payload: {
        label: "After tool",
        enabled: false,
        priority: 25,
        timeoutMs: 500,
        failPolicy: "open",
        action: {
          type: "webhook",
          webhook: {
            url: "https://hooks.example.test/after?token=update-short&mode=events",
            secret: "new-secret",
          },
        },
      },
    });
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/workspaces/workspace-1/hooks/hook-1" });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      hookId: "hook-created",
      action: {
        webhook: {
          url: "[REDACTED]",
          secret: "[REDACTED]",
        },
      },
    });
    expect(created.body).not.toContain("secret-value");
    expect(hooks.createWorkspaceHook).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        label: "Before tool",
        trigger: "tool.call.before",
      }),
    );

    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("new-secret");
    expect(updated.json().action.webhook).toEqual({
      url: "[REDACTED]",
      secret: "[REDACTED]",
    });
    expect(hooks.updateWorkspaceHook).toHaveBeenCalledWith(
      "workspace-1",
      "hook-1",
      expect.objectContaining({ label: "After tool", enabled: false }),
    );
    expect(deleted.json()).toEqual({ deleted: true });
    expect(hooks.deleteWorkspaceHook).toHaveBeenCalledWith("workspace-1", "hook-1");
  });

  it("returns validation failures and maps service errors to 400", async () => {
    const hooks = createHooksService({
      createWorkspaceHook: vi.fn(() => {
        throw new Error("workspace missing");
      }),
      updateWorkspaceHook: vi.fn(() => {
        throw new Error("hook missing");
      }),
    });
    app = buildApp(hooks);

    await expect(
      app.inject({ method: "GET", url: "/api/v1/workspaces/workspace-1/hooks?limit=0" }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/workspaces/workspace-1/hooks/runs?limit=0" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/workspaces/workspace-1/hooks", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/workspaces/workspace-1/hooks",
        payload: {
          label: "Bad URL",
          trigger: "tool.call.before",
          mode: "observe",
          action: { type: "webhook", webhook: { url: "not-a-url" } },
        },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/workspaces/workspace-1/hooks",
        payload: {
          label: "Valid but missing workspace",
          trigger: "tool.call.before",
          mode: "observe",
          action: { type: "webhook", webhook: { url: "https://hooks.example.test/valid" } },
        },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "PATCH",
        url: "/api/v1/workspaces/workspace-1/hooks/hook-1",
        payload: { label: "", timeoutMs: -1 },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "PATCH",
        url: "/api/v1/workspaces/workspace-1/hooks/hook-1",
        payload: { label: "Still missing" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("runs synthetic tests and only exposes the dedicated redrive operation", async () => {
    const hooks = createHooksService({
      testWorkspaceHook: vi.fn(() => ({ runId: "test-run", requestPayload: { synthetic: true } })),
      redriveWorkspaceHookRun: vi.fn(() => ({ runId: "redrive-run", requestPayload: { synthetic: true } })),
    });
    app = buildApp(hooks);

    const tested = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/workspace-1/hooks/hook-1/test",
    });
    const redriven = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/workspace-1/hooks/runs/run-1/redrive",
    });

    expect(tested.statusCode).toBe(202);
    expect(redriven.statusCode).toBe(202);
    expect(hooks.testWorkspaceHook).toHaveBeenCalledWith("workspace-1", "hook-1");
    expect(hooks.redriveWorkspaceHookRun).toHaveBeenCalledWith("workspace-1", "run-1");
  });
});

function buildApp(hooks: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { hooks } as never);
  void next.register(hooksRoutes);
  return next;
}

function createHooksService(overrides: Record<string, unknown> = {}) {
  const hookRecord = {
    hookId: "hook-1",
    workspaceId: "workspace-1",
    label: "Notify",
    action: {
      type: "webhook",
      webhook: {
        url: "https://hooks.example.test/services/team/legacy-hook-secret",
        secret: "super-secret",
      },
    },
  };
  const hookRun = {
    runId: "run-1",
    requestPayload: {
      authorization: "Bearer tiny",
      callbackUrl: "https://callback.example.test/result?token=callback-short",
      tokenId: "token-id-safe",
    },
    responsePayload: {
      DATABASE_PASSWORD: "db-short",
      requestCount: 3,
    },
  };
  return {
    rawHookRecord: hookRecord,
    rawHookRun: hookRun,
    listWorkspaceHooks: vi.fn(() => [hookRecord]),
    listWorkspaceHookRuns: vi.fn(() => [hookRun]),
    createWorkspaceHook: vi.fn((input) => ({
      ...hookRecord,
      ...input,
      hookId: "hook-created",
    })),
    updateWorkspaceHook: vi.fn((_workspaceId: string, hookId: string, input) => ({
      ...hookRecord,
      ...input,
      hookId,
    })),
    deleteWorkspaceHook: vi.fn(() => true),
    testWorkspaceHook: vi.fn(() => ({ runId: "test-run" })),
    redriveWorkspaceHookRun: vi.fn(() => ({ runId: "redrive-run" })),
    ...overrides,
  };
}

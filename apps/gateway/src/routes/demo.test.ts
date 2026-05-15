import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { demoRoutes } from "./demo.js";

describe("demo routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("reports not started before demo bootstrap", async () => {
    app = Fastify();
    app.decorate("services", createDemoServices() as never);
    await app.register(demoRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/demo/state",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "not_started",
      sessions: [],
      tasks: [],
      nextRoute: "/settings/onboarding",
    });
  });

  it("bootstraps safe demo data idempotently", async () => {
    const services = createDemoServices();
    app = Fastify();
    app.decorate("services", services as never);
    await app.register(demoRoutes);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/demo/bootstrap",
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/demo/bootstrap",
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: "ready",
      workspace: { slug: "goatcitadel-demo" },
      project: { name: "Adoption Tour" },
      created: {
        workspace: true,
        project: true,
        chatSession: true,
        coworkSession: true,
        codeSession: true,
        coworkTask: true,
        codeTask: true,
        memorySeed: true,
      },
    });
    expect(first.json().sessions).toHaveLength(3);
    expect(first.json().tasks).toHaveLength(2);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      status: "ready",
      created: {
        workspace: false,
        project: false,
        chatSession: false,
        coworkSession: false,
        codeSession: false,
        coworkTask: false,
        codeTask: false,
        memorySeed: false,
      },
    });
    expect(services.__state.workspaces).toHaveLength(1);
    expect(services.__state.projects).toHaveLength(1);
    expect(services.__state.sessions).toHaveLength(3);
    expect(services.__state.tasks).toHaveLength(2);
    expect(services.knowledge.knowledgeMemoryWrite).toHaveBeenCalledTimes(1);
  });

  it("restores archived demo workspaces and reports state as partial until required artifacts exist", async () => {
    const services = createDemoServices();
    services.__state.workspaces.push({
      workspaceId: "workspace-archived",
      name: "GoatCitadel Demo",
      slug: "goatcitadel-demo",
      lifecycleStatus: "archived",
    });
    app = Fastify();
    app.decorate("services", services as never);
    await app.register(demoRoutes);

    const stateBefore = await app.inject({ method: "GET", url: "/api/v1/demo/state" });
    expect(stateBefore.statusCode).toBe(200);
    expect(stateBefore.json()).toMatchObject({
      status: "not_started",
      nextRoute: "/settings/onboarding",
    });

    const bootstrap = await app.inject({ method: "POST", url: "/api/v1/demo/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(services.workspaces.restoreWorkspace).toHaveBeenCalledWith("workspace-archived");
    expect(bootstrap.json()).toMatchObject({
      status: "ready",
      workspace: { workspaceId: "workspace-archived" },
      notes: expect.arrayContaining(["Restored the existing archived demo workspace."]),
      created: {
        workspace: false,
        project: true,
        chatSession: true,
        coworkSession: true,
        codeSession: true,
      },
    });

    services.__state.sessions.pop();
    const stateAfterMissingCodeSession = await app.inject({ method: "GET", url: "/api/v1/demo/state" });
    expect(stateAfterMissingCodeSession.json()).toMatchObject({
      status: "partial",
      nextRoute: "/cowork?sessionId=session-2",
      notes: ["Demo state is read-only until you press Start demo."],
    });
  });

  it("returns partial bootstrap status when optional demo memory seeding fails", async () => {
    const services = createDemoServices();
    services.knowledge.knowledgeMemoryWrite.mockRejectedValueOnce(new Error("secure memory unavailable"));
    app = Fastify();
    app.decorate("services", services as never);
    await app.register(demoRoutes);

    const response = await app.inject({ method: "POST", url: "/api/v1/demo/bootstrap" });

    expect(response.statusCode).toBe(207);
    expect(response.json()).toMatchObject({
      status: "partial",
      created: {
        workspace: true,
        project: true,
        chatSession: true,
        coworkSession: true,
        codeSession: true,
        coworkTask: true,
        codeTask: true,
        memorySeed: false,
      },
      notes: ["Memory seed skipped: secure memory unavailable"],
    });
  });
});

function createDemoServices() {
  const state = {
    workspaces: [] as Array<Record<string, unknown>>,
    projects: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<Record<string, unknown>>,
    memories: [] as Array<Record<string, unknown>>,
  };
  return {
    __state: state,
    workspaces: {
      listWorkspaces: vi.fn(() => state.workspaces),
      createWorkspace: vi.fn((input: Record<string, unknown>) => {
        const workspace = {
          workspaceId: `workspace-${state.workspaces.length + 1}`,
          lifecycleStatus: "active",
          createdAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
          ...input,
        };
        state.workspaces.push(workspace);
        return workspace;
      }),
      restoreWorkspace: vi.fn((workspaceId: string) => {
        const workspace = state.workspaces.find((item) => item.workspaceId === workspaceId);
        if (workspace) {
          workspace.lifecycleStatus = "active";
        }
        return workspace;
      }),
    },
    chatProjects: {
      listChatProjects: vi.fn((_view: string, _limit: number, workspaceId: string) =>
        state.projects.filter((item) => item.workspaceId === workspaceId),
      ),
      createChatProject: vi.fn((input: Record<string, unknown>) => {
        const project = {
          projectId: `project-${state.projects.length + 1}`,
          lifecycleStatus: "active",
          createdAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
          ...input,
        };
        state.projects.push(project);
        return project;
      }),
    },
    chatSessions: {
      listChatSessions: vi.fn((query: Record<string, unknown>) =>
        state.sessions.filter(
          (item) =>
            (!query.workspaceId || item.workspaceId === query.workspaceId) &&
            (!query.projectId || item.projectId === query.projectId) &&
            (!query.tag || (item.tags as string[] | undefined)?.includes(String(query.tag))),
        ),
      ),
      createChatSession: vi.fn((input: Record<string, unknown>) => {
        const session = {
          sessionId: `session-${state.sessions.length + 1}`,
          sessionKey: `session-key-${state.sessions.length + 1}`,
          scope: "personal",
          pinned: false,
          lifecycleStatus: "active",
          channel: "web",
          account: "operator",
          updatedAt: "2026-05-10T00:00:00.000Z",
          lastActivityAt: "2026-05-10T00:00:00.000Z",
          tokenTotal: 0,
          costUsdTotal: 0,
          ...input,
        };
        state.sessions.push(session);
        return session;
      }),
    },
    tasks: {
      listTasks: vi.fn(
        (
          _limit: number,
          _status: string | undefined,
          _cursor: string | undefined,
          _view: string,
          workspaceId: string,
        ) => state.tasks.filter((item) => item.workspaceId === workspaceId),
      ),
      createTask: vi.fn((input: Record<string, unknown>) => {
        const task = {
          taskId: `task-${state.tasks.length + 1}`,
          assignedAgentId: undefined,
          createdAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
          ...input,
        };
        state.tasks.push(task);
        return task;
      }),
      appendTaskActivity: vi.fn(),
      appendTaskDeliverable: vi.fn(),
    },
    memory: {
      listItems: vi.fn((query: Record<string, unknown>) =>
        state.memories.filter((item) => item.namespace === query.namespace && item.title === query.query),
      ),
    },
    knowledge: {
      knowledgeMemoryWrite: vi.fn(async (input: Record<string, unknown>) => {
        state.memories.push({
          itemId: `memory-${state.memories.length + 1}`,
          title: input.title,
          namespace: input.namespace,
          status: "active",
          metadata: input.metadata,
        });
        return { itemId: state.memories.at(-1)?.itemId };
      }),
    },
  };
}

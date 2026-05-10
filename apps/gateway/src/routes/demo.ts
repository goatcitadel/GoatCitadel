import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type {
  ChatProjectRecord,
  ChatSessionRecord,
  DemoBootstrapResponse,
  DemoBootstrapStateResponse,
  DemoMemorySeed,
  DemoPromptSeed,
  TaskRecord,
  WorkspaceRecord,
} from "@goatcitadel/contracts";

const DEMO_WORKSPACE_SLUG = "goatcitadel-demo";
const DEMO_WORKSPACE_NAME = "GoatCitadel Demo";
const DEMO_PROJECT_NAME = "Adoption Tour";
const DEMO_PROJECT_PATH = "demo/goatcitadel-adoption-tour";
const DEMO_TAG = "goatcitadel-demo";

const STARTER_PROMPTS: DemoPromptSeed[] = [
  {
    surface: "chat",
    title: "Ask what it can do",
    prompt: "Give me a plain-English tour of what GoatCitadel can help me do today.",
  },
  {
    surface: "cowork",
    title: "Plan a launch workflow",
    prompt: "Create a visible Cowork plan for launching a small local-first AI product.",
  },
  {
    surface: "code",
    title: "Review a code change",
    prompt: "Review this repo like a senior engineer and propose the smallest safe validation path.",
  },
];

const MEMORY_SEEDS: DemoMemorySeed[] = [
  {
    namespace: "demo.goatcitadel",
    title: "Operator preference: visible proof",
    content:
      "The demo operator wants model choice, tool use, memory sources, approvals, validation, and open risks visible before trusting an AI run.",
    reason: "Shows how durable memory can support trust without requiring a real provider or channel credential.",
  },
];

export const demoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/demo/state", async (_request, reply) => {
    return reply.send(await readDemoState(fastify));
  });

  fastify.post("/api/v1/demo/bootstrap", async (_request, reply) => {
    const result = await bootstrapDemo(fastify);
    return reply.code(result.status === "ready" ? 200 : 207).send(result);
  });
};

async function bootstrapDemo(fastify: FastifyInstance): Promise<DemoBootstrapResponse> {
  const created = {
    workspace: false,
    project: false,
    chatSession: false,
    coworkSession: false,
    codeSession: false,
    coworkTask: false,
    codeTask: false,
    memorySeed: false,
  };
  const notes: string[] = [];

  let workspace = findDemoWorkspace(fastify);
  if (!workspace) {
    workspace = fastify.services.workspaces.createWorkspace({
      name: DEMO_WORKSPACE_NAME,
      description: "Safe local demo workspace for exploring GoatCitadel without provider or channel credentials.",
      slug: DEMO_WORKSPACE_SLUG,
      workspacePrefs: {
        uiMode: "simple",
        technicalDetailsDefault: false,
        demo: {
          seededAt: new Date().toISOString(),
          starterPrompts: STARTER_PROMPTS,
        },
      },
    });
    created.workspace = true;
  } else if (workspace.lifecycleStatus === "archived") {
    workspace = fastify.services.workspaces.restoreWorkspace(workspace.workspaceId) as WorkspaceRecord;
    notes.push("Restored the existing archived demo workspace.");
  }
  if (!workspace) {
    throw new Error("Demo workspace could not be created.");
  }

  let project = findDemoProject(fastify, workspace.workspaceId);
  if (!project) {
    project = fastify.services.chatProjects.createChatProject({
      workspaceId: workspace.workspaceId,
      name: DEMO_PROJECT_NAME,
      description: "A sample project that ties Chat, Cowork, and Code threads together.",
      workspacePath: DEMO_PROJECT_PATH,
      color: "#14b8a6",
    }) as ChatProjectRecord;
    created.project = true;
  }
  if (!project) {
    throw new Error("Demo project could not be created.");
  }

  const chatSession = ensureDemoSession(
    fastify,
    workspace.workspaceId,
    project.projectId,
    "chat",
    created,
    "chatSession",
  );
  const coworkSession = ensureDemoSession(
    fastify,
    workspace.workspaceId,
    project.projectId,
    "cowork",
    created,
    "coworkSession",
  );
  const codeSession = ensureDemoSession(
    fastify,
    workspace.workspaceId,
    project.projectId,
    "code",
    created,
    "codeSession",
  );

  const coworkTask = ensureDemoTask(fastify, workspace.workspaceId, {
    title: "Demo Cowork mission: launch readiness",
    description:
      "Use Cowork to decompose a launch task, expose blockers, and keep approvals and evidence visible to the operator.",
    status: "planning",
    priority: "normal",
  });
  if (coworkTask.created) {
    created.coworkTask = true;
    fastify.services.tasks.appendTaskActivity(coworkTask.task.taskId, {
      activityType: "comment",
      agentId: "demo",
      message: "Demo task created to show Cowork planning, blockers, and deliverables.",
    });
  }

  const codeTask = ensureDemoTask(fastify, workspace.workspaceId, {
    title: "Demo Code mission: validate a small change",
    description: "Use Code to inspect a patch, run targeted validation, export a diff, and hand off risk notes.",
    status: "inbox",
    priority: "normal",
  });
  if (codeTask.created) {
    created.codeTask = true;
    fastify.services.tasks.appendTaskDeliverable(codeTask.task.taskId, {
      deliverableType: "url",
      title: "White paper",
      path: "docs/goatcitadel-whitepaper.html",
      description: "Shareable sales and engineering overview generated from the current repo.",
    });
  }

  const memorySeed = MEMORY_SEEDS[0]!;
  try {
    const existingMemory = fastify.services.memory.listItems({
      namespace: memorySeed.namespace,
      query: memorySeed.title,
      status: "active",
      limit: 10,
    });
    if (existingMemory.length === 0) {
      await fastify.services.knowledge.knowledgeMemoryWrite({
        namespace: memorySeed.namespace,
        title: memorySeed.title,
        content: memorySeed.content,
        tags: ["demo", "trust", "operator-visible"],
        source: "demo-bootstrap",
        metadata: {
          reason: memorySeed.reason,
          workspaceId: workspace.workspaceId,
        },
        sessionId: chatSession.sessionId,
        taskId: coworkTask.task.taskId,
        agentId: "demo-bootstrap",
      });
      created.memorySeed = true;
    }
  } catch (error) {
    notes.push(`Memory seed skipped: ${(error as Error).message}`);
  }

  const status = created.memorySeed || notes.length === 0 ? "ready" : "partial";

  return {
    status,
    workspace: pickWorkspace(workspace),
    project: pickProject(project),
    sessions: [chatSession, coworkSession, codeSession].map(pickSession),
    tasks: [coworkTask.task, codeTask.task].map(pickTask),
    starterPrompts: STARTER_PROMPTS,
    memorySeeds: MEMORY_SEEDS,
    nextRoute: `/cowork?sessionId=${encodeURIComponent(coworkSession.sessionId)}`,
    notes: notes.length ? notes : ["Demo workspace is ready and uses only local/sample data."],
    created,
  };
}

async function readDemoState(fastify: FastifyInstance): Promise<DemoBootstrapStateResponse> {
  const workspace = findDemoWorkspace(fastify);
  if (!workspace || workspace.lifecycleStatus === "archived") {
    return {
      status: "not_started",
      sessions: [],
      tasks: [],
      starterPrompts: STARTER_PROMPTS,
      memorySeeds: MEMORY_SEEDS,
      nextRoute: "/settings/onboarding",
      notes: ["Demo workspace has not been created yet."],
    };
  }
  const project = findDemoProject(fastify, workspace.workspaceId);
  const sessions = (fastify.services.chatSessions
    .listChatSessions({
      workspaceId: workspace.workspaceId,
      projectId: project?.projectId,
      tag: DEMO_TAG,
      view: "all",
      includeHidden: true,
      limit: 20,
    })
    .filter((item: ChatSessionRecord) => item.mode === "chat" || item.mode === "cowork" || item.mode === "code") ??
    []) as ChatSessionRecord[];
  const tasks = (fastify.services.tasks
    .listTasks(100, undefined, undefined, "all", workspace.workspaceId)
    .filter((item: TaskRecord) => item.title.startsWith("Demo ")) ?? []) as TaskRecord[];
  const coworkSession = sessions.find((item) => item.mode === "cowork");

  return {
    status: project && sessions.length >= 3 && tasks.length >= 2 ? "ready" : "partial",
    workspace: pickWorkspace(workspace),
    project: project ? pickProject(project) : undefined,
    sessions: sessions.map(pickSession),
    tasks: tasks.map(pickTask),
    starterPrompts: STARTER_PROMPTS,
    memorySeeds: MEMORY_SEEDS,
    nextRoute: coworkSession
      ? `/cowork?sessionId=${encodeURIComponent(coworkSession.sessionId)}`
      : "/settings/onboarding",
    notes: ["Demo state is read-only until you press Start demo."],
  };
}

function findDemoWorkspace(fastify: FastifyInstance): WorkspaceRecord | undefined {
  return fastify.services.workspaces
    .listWorkspaces("all", 500)
    .find((item: WorkspaceRecord) => item.slug === DEMO_WORKSPACE_SLUG || item.name === DEMO_WORKSPACE_NAME) as
    | WorkspaceRecord
    | undefined;
}

function findDemoProject(fastify: FastifyInstance, workspaceId: string): ChatProjectRecord | undefined {
  return fastify.services.chatProjects
    .listChatProjects("all", 300, workspaceId)
    .find((item: ChatProjectRecord) => item.name === DEMO_PROJECT_NAME || item.workspacePath === DEMO_PROJECT_PATH) as
    | ChatProjectRecord
    | undefined;
}

function ensureDemoSession(
  fastify: FastifyInstance,
  workspaceId: string,
  projectId: string,
  mode: "chat" | "cowork" | "code",
  created: DemoBootstrapResponse["created"],
  createdKey: keyof Pick<DemoBootstrapResponse["created"], "chatSession" | "coworkSession" | "codeSession">,
): ChatSessionRecord {
  const existing = fastify.services.chatSessions
    .listChatSessions({
      workspaceId,
      projectId,
      tag: DEMO_TAG,
      view: "all",
      includeHidden: true,
      limit: 30,
    })
    .find((item: ChatSessionRecord) => item.mode === mode) as ChatSessionRecord | undefined;
  if (existing) {
    return existing as ChatSessionRecord;
  }

  created[createdKey] = true;
  return fastify.services.chatSessions.createChatSession({
    workspaceId,
    projectId,
    mode,
    origin: "system",
    includeInHistory: true,
    title:
      mode === "chat"
        ? "Demo Chat: product tour"
        : mode === "cowork"
          ? "Demo Cowork: visible mission"
          : "Demo Code: validation loop",
    tags: [DEMO_TAG],
  }) as ChatSessionRecord;
}

function ensureDemoTask(
  fastify: FastifyInstance,
  workspaceId: string,
  input: {
    title: string;
    description: string;
    status: TaskRecord["status"];
    priority: TaskRecord["priority"];
  },
): { task: TaskRecord; created: boolean } {
  const existing = fastify.services.tasks
    .listTasks(100, undefined, undefined, "all", workspaceId)
    .find((item: TaskRecord) => item.title === input.title) as TaskRecord | undefined;
  if (existing) {
    return { task: existing as TaskRecord, created: false };
  }
  return {
    task: fastify.services.tasks.createTask({
      workspaceId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      createdBy: "demo-bootstrap",
    }) as TaskRecord,
    created: true,
  };
}

function pickWorkspace(workspace: WorkspaceRecord): DemoBootstrapStateResponse["workspace"] {
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    slug: workspace.slug,
  };
}

function pickProject(project: ChatProjectRecord): DemoBootstrapStateResponse["project"] {
  return {
    projectId: project.projectId,
    name: project.name,
    workspacePath: project.workspacePath,
  };
}

function pickSession(session: ChatSessionRecord): DemoBootstrapStateResponse["sessions"][number] {
  return {
    sessionId: session.sessionId,
    title: session.title,
    mode: session.mode,
    projectId: session.projectId,
  };
}

function pickTask(task: TaskRecord): DemoBootstrapStateResponse["tasks"][number] {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    priority: task.priority,
  };
}

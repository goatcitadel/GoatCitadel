import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type {
  ApprovalRequest,
  ChatProjectRecord,
  ChatSessionRecord,
  DemoBootstrapResponse,
  DemoBootstrapStateResponse,
  DemoMemorySeed,
  DemoPromptSeed,
  TaskRecord,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
import { projectChatSessionForPublic } from "../services/chat-secret-projection.js";

const DEMO_WORKSPACE_SLUG = "goatcitadel-demo";
const DEMO_WORKSPACE_NAME = "GoatCitadel Demo";
const DEMO_PROJECT_NAME = "Adoption Tour";
const DEMO_PROJECT_PATH = "demo/goatcitadel-adoption-tour";
const DEMO_TAG = "goatcitadel-demo";
const DEMO_CHAT_TITLE = "Demo Chat: guided operations tour";

const STARTER_PROMPTS: DemoPromptSeed[] = [
  {
    surface: "chat",
    title: "Ask what it can do",
    prompt: "Give me a plain-English tour of what GoatCitadel can help me do today.",
  },
  {
    surface: "chat",
    title: "Plan a launch workflow",
    prompt: "Create a visible agentic plan in Chat for launching a small local-first AI product.",
  },
  {
    surface: "chat",
    title: "Review a code change",
    prompt: "From Chat, review this repo like a senior engineer and propose the smallest safe validation path.",
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
    workspace = fastify.services.workspaces.restoreWorkspace(
      workspace.workspaceId,
      workspace.revision,
    ) as WorkspaceRecord;
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
      description: "A sample project for conversation, agentic planning, and governed code-capability work in Chat.",
      workspacePath: DEMO_PROJECT_PATH,
      color: "#14b8a6",
    }) as ChatProjectRecord;
    created.project = true;
  }
  if (!project) {
    throw new Error("Demo project could not be created.");
  }

  const chatSession = ensureDemoSession(fastify, workspace.workspaceId, project.projectId, created);

  const coworkTask = ensureDemoTask(fastify, workspace.workspaceId, {
    title: "Demo agentic mission: launch readiness",
    description:
      "Use Chat to decompose a launch task, expose blockers, and keep approvals and evidence visible to the operator.",
    status: "planning",
    priority: "normal",
  });
  if (coworkTask.created) {
    created.coworkTask = true;
    fastify.services.tasks.appendTaskActivity(coworkTask.task.taskId, {
      activityType: "comment",
      agentId: "demo",
      message: "Demo task created to show agentic planning, blockers, and deliverables in Chat.",
    });
  }
  const governedJob = await ensureFirstRunGovernedJob(fastify, workspace, chatSession, coworkTask.task);
  if (governedJob.created && governedJob.durableBacked) {
    notes.push("Created a first-run approval checkpoint backed by a durable run; approve it only after inspection.");
  } else if (!governedJob.durableBacked) {
    notes.push(
      "First-run approval checkpoint is missing durable-run linkage because durable execution is unavailable.",
    );
  }

  const codeTask = ensureDemoTask(fastify, workspace.workspaceId, {
    title: "Demo code-capability mission: validate a small change",
    description: "Use Chat to inspect a patch, run targeted validation, export a diff, and hand off risk notes.",
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

  const hasPartialNote = notes.some((note) => /skipped|unavailable|without durable-run linkage/i.test(note));
  const status = hasPartialNote ? "partial" : "ready";

  return {
    status,
    workspace: pickWorkspace(workspace),
    project: pickProject(project),
    sessions: [chatSession].map(pickSession),
    tasks: [coworkTask.task, codeTask.task].map(pickTask),
    starterPrompts: STARTER_PROMPTS,
    memorySeeds: MEMORY_SEEDS,
    nextRoute: `/chat?sessionId=${encodeURIComponent(chatSession.sessionId)}`,
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
  const demoSessions = (fastify.services.chatSessions
    .listChatSessions({
      workspaceId: workspace.workspaceId,
      projectId: project?.projectId,
      tag: DEMO_TAG,
      view: "all",
      includeHidden: true,
      limit: 20,
    })
    .filter((item: ChatSessionRecord) => item.mode === "chat") ?? []) as ChatSessionRecord[];
  const canonicalSession = demoSessions.find((item) => item.title === DEMO_CHAT_TITLE) ?? demoSessions[0];
  const sessions = canonicalSession ? [canonicalSession] : [];
  const tasks = (fastify.services.tasks
    .listTasks(100, undefined, undefined, "all", workspace.workspaceId)
    .filter((item: TaskRecord) => item.title.startsWith("Demo ")) ?? []) as TaskRecord[];
  return {
    status: project && sessions.length >= 1 && tasks.length >= 2 ? "ready" : "partial",
    workspace: pickWorkspace(workspace),
    project: project ? pickProject(project) : undefined,
    sessions: sessions.map(pickSession),
    tasks: tasks.map(pickTask),
    starterPrompts: STARTER_PROMPTS,
    memorySeeds: MEMORY_SEEDS,
    nextRoute: canonicalSession
      ? `/chat?sessionId=${encodeURIComponent(canonicalSession.sessionId)}`
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
  created: DemoBootstrapResponse["created"],
): ChatSessionRecord {
  const existingSessions = fastify.services.chatSessions.listChatSessions({
    workspaceId,
    projectId,
    tag: DEMO_TAG,
    view: "all",
    includeHidden: true,
    limit: 30,
  }) as ChatSessionRecord[];
  const existing =
    existingSessions.find((item) => item.mode === "chat" && item.title === DEMO_CHAT_TITLE) ??
    existingSessions.find((item) => item.mode === "chat");
  if (existing) {
    return existing as ChatSessionRecord;
  }

  created.chatSession = true;
  return fastify.services.chatSessions.createChatSession({
    workspaceId,
    projectId,
    mode: "chat",
    origin: "system",
    includeInHistory: true,
    title: DEMO_CHAT_TITLE,
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

async function ensureFirstRunGovernedJob(
  fastify: FastifyInstance,
  workspace: WorkspaceRecord,
  session: ChatSessionRecord,
  task: TaskRecord,
): Promise<{ task: TaskRecord; created: boolean; durableBacked: boolean }> {
  const existingRunId = task.agenticContext?.runId?.trim();
  if (existingRunId) {
    return { task, created: false, durableBacked: true };
  }

  const existingApproval = findFirstRunDemoApproval(fastify, task.taskId);
  const approval =
    existingApproval ??
    (await fastify.services.approvals.createApproval({
      kind: "demo.first_run",
      riskLevel: "safe",
      payload: {
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        taskId: task.taskId,
        action: "inspect_demo_first_run",
        note: "Local demo checkpoint only; approving this does not call a provider or execute external side effects.",
      },
      preview: {
        title: "First-run demo checkpoint",
        surface: "chat",
        workspace: workspace.name,
        task: task.title,
      },
      linkage: {
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        taskId: task.taskId,
        originSurface: "chat",
        actionType: "demo.first_run",
      },
      expiresAt: null,
    }));
  const durableRunId = approval.linkage?.durableRunId ?? approval.linkage?.runId;
  if (!durableRunId) {
    fastify.services.tasks.appendTaskActivity(task.taskId, {
      activityType: "control",
      agentId: "demo-bootstrap",
      message:
        "First-run approval checkpoint created without durable-run linkage because durable execution is unavailable.",
      metadata: {
        approvalId: approval.approvalId,
        surface: "chat",
        sideEffectPosture: "local_demo_only",
      },
    });
    return { task, created: !existingApproval, durableBacked: false };
  }

  const agenticStatus = mapDemoApprovalStatusToAgenticStatus(approval.status);
  const taskStatus = mapDemoApprovalStatusToTaskStatus(approval.status);
  const updated = fastify.services.tasks.updateTask(task.taskId, {
    status: taskStatus,
    agenticContext: {
      ...(task.agenticContext ?? {}),
      boardId: "chat:demo",
      runId: durableRunId,
      durableRunId,
      parentSessionId: session.sessionId,
      surface: "chat",
      status: agenticStatus,
      contextMode: "isolated",
      workspaceScope: { kind: "session" },
      diagnostics: task.agenticContext?.diagnostics ?? [],
    },
  });
  fastify.services.tasks.appendTaskActivity(task.taskId, {
    activityType: "control",
    agentId: "demo-bootstrap",
    message: getDemoApprovalActivityMessage(approval.status),
    metadata: {
      runId: durableRunId,
      approvalId: approval.approvalId,
      approvalStatus: approval.status,
      surface: "chat",
      sideEffectPosture: "local_demo_only",
    },
  });

  return { task: updated as TaskRecord, created: !existingApproval, durableBacked: true };
}

function findFirstRunDemoApproval(fastify: FastifyInstance, taskId: string): ApprovalRequest | undefined {
  return fastify.services.approvals
    .listApprovals(undefined, 500)
    .find(
      (approval) =>
        approval.kind === "demo.first_run" &&
        approval.linkage?.taskId === taskId &&
        approval.linkage?.actionType === "demo.first_run",
    );
}

function mapDemoApprovalStatusToAgenticStatus(status: ApprovalRequest["status"]) {
  if (status === "pending") {
    return "approval_required";
  }
  if (status === "rejected") {
    return "cancelled";
  }
  return "completed";
}

function mapDemoApprovalStatusToTaskStatus(status: ApprovalRequest["status"]): TaskRecord["status"] {
  if (status === "pending") {
    return "planning";
  }
  if (status === "rejected") {
    return "blocked";
  }
  return "review";
}

function getDemoApprovalActivityMessage(status: ApprovalRequest["status"]) {
  if (status === "pending") {
    return "First-run governed checkpoint created; waiting for operator approval before treating proof as complete.";
  }
  if (status === "rejected") {
    return "First-run governed checkpoint is linked to a rejected approval and remains blocked.";
  }
  return "First-run governed checkpoint is linked to a resolved approval and ready for inspection.";
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
  const projected = projectChatSessionForPublic(session);
  return {
    sessionId: projected.sessionId,
    title: projected.title,
    mode: projected.mode,
    projectId: projected.projectId,
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

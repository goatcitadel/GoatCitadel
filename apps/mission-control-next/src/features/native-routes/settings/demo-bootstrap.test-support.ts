import type {
  ChatProjectRecord,
  ChatSessionRecord,
  DemoBootstrapResponse,
  DemoBootstrapStateResponse,
  TaskRecord,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
const time = "2026-09-30T00:00:00.000Z";
export function demoFixture() {
  const workspace: WorkspaceRecord = {
    workspaceId: "demo-workspace",
    citadelId: "demo-citadel",
    revision: 1,
    name: "GoatCitadel Demo",
    slug: "goatcitadel-demo",
    lifecycleStatus: "active",
    createdAt: time,
    updatedAt: time,
  };
  const project: ChatProjectRecord = {
    projectId: "demo-project",
    revision: 1,
    workspaceId: workspace.workspaceId,
    name: "Adoption Tour",
    workspacePath: "demo/goatcitadel-adoption-tour",
    lifecycleStatus: "active",
    createdAt: time,
    updatedAt: time,
  };
  const session: ChatSessionRecord = {
    sessionId: "demo-session",
    revision: 1,
    sessionKey: "demo-key",
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    scope: "mission",
    mode: "chat",
    origin: "system",
    includeInHistory: true,
    title: "Demo Chat",
    pinned: false,
    lifecycleStatus: "active",
    channel: "mission",
    account: "local",
    updatedAt: time,
    lastActivityAt: time,
    tokenTotal: 0,
    costUsdTotal: 0,
  };
  const tasks: TaskRecord[] = ["planning", "inbox"].map((status, index) => ({
    taskId: `demo-task-${index}`,
    workspaceId: workspace.workspaceId,
    revision: 1,
    title: `Demo task ${index}`,
    status: status === "planning" ? "planning" : "inbox",
    priority: "normal",
    createdAt: time,
    updatedAt: time,
  }));
  const state: DemoBootstrapStateResponse = {
    status: "ready",
    workspace: { workspaceId: workspace.workspaceId, name: workspace.name, slug: workspace.slug },
    project: { projectId: project.projectId, name: project.name, workspacePath: project.workspacePath },
    sessions: [{ sessionId: session.sessionId, title: session.title, projectId: project.projectId, mode: "chat" }],
    tasks: tasks.map(({ taskId, title, status, priority }) => ({ taskId, title, status, priority })),
    starterPrompts: [{ title: "Inspect sample", surface: "chat", prompt: "Inspect the sample" }],
    memorySeeds: [{ namespace: "demo.goatcitadel", title: "Sample", content: "Public sample", reason: "Demo example" }],
    nextRoute: "/chat?sessionId=demo-session",
    notes: ["Read-only state"],
  };
  const receipt: DemoBootstrapResponse = {
    ...state,
    notes: ["Local sample records prepared"],
    created: {
      workspace: true,
      project: true,
      chatSession: true,
      coworkSession: false,
      codeSession: false,
      coworkTask: true,
      codeTask: true,
      memorySeed: false,
    },
  };
  const empty: DemoBootstrapStateResponse = {
    status: "not_started",
    sessions: [],
    tasks: [],
    starterPrompts: state.starterPrompts,
    memorySeeds: state.memorySeeds,
    nextRoute: "/settings/onboarding",
    notes: ["Not prepared"],
  };
  return { workspace, project, session, tasks, state, receipt, empty };
}

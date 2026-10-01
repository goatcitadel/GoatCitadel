import {
  canonicalJsonString,
  type DemoBootstrapStateResponse,
  type DemoBootstrapResponse,
} from "@goatcitadel/contracts";
import { fetchWorkspaces, fetchChatProjects, fetchChatSessions } from "@goatcitadel/mission-control-shared/api/client";
import { fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";

export const DEMO_BOOTSTRAP_CONSEQUENCE =
  "Prepare the installation's named demo workspace, reusing or restoring existing demo records. The Gateway may create a project, Chat thread, two sample tasks, a governed approval checkpoint and a durable memory example. It does not send a Chat message or approve the checkpoint. This multi-step API has no revision guard; partial results may remain if it fails.";
export const demoStateBinding = (state: DemoBootstrapStateResponse) =>
  canonicalJsonString({
    ...state,
    notes: undefined,
    sessions: [...state.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    tasks: [...state.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId)),
  });
export function assertDemoReceipt(receipt: DemoBootstrapResponse, saved: DemoBootstrapStateResponse) {
  if (
    !["ready", "partial"].includes(receipt.status) ||
    !receipt.workspace?.workspaceId ||
    !receipt.project?.projectId ||
    receipt.sessions.length !== 1 ||
    receipt.sessions[0]?.mode !== "chat" ||
    receipt.tasks.length !== 2 ||
    new Set(receipt.tasks.map((task) => task.taskId)).size !== 2 ||
    !receipt.notes.every((note) => typeof note === "string") ||
    !receipt.created ||
    Object.values(receipt.created).some((value) => typeof value !== "boolean")
  )
    throw new Error("The demo receipt is incomplete.");
  if (
    canonicalJsonString(receipt.workspace) !== canonicalJsonString(saved.workspace) ||
    canonicalJsonString(receipt.project) !== canonicalJsonString(saved.project) ||
    canonicalJsonString(receipt.sessions) !== canonicalJsonString(saved.sessions) ||
    canonicalJsonString(receipt.starterPrompts) !== canonicalJsonString(saved.starterPrompts) ||
    canonicalJsonString(receipt.memorySeeds) !== canonicalJsonString(saved.memorySeeds) ||
    receipt.nextRoute !== saved.nextRoute ||
    !receipt.tasks.every(
      (task) =>
        canonicalJsonString(task) === canonicalJsonString(saved.tasks.find((item) => item.taskId === task.taskId)),
    )
  )
    throw new Error("The independent demo read does not match the returned records.");
  // GET readiness counts records; it does not corroborate POST memory or approval-linkage results.
  if (saved.status !== "ready")
    throw new Error("The demo's project, session and tasks are not all visible on independent read.");
}
export async function readDemoDestination(state: DemoBootstrapStateResponse) {
  const recordedWorkspace = state.workspace,
    recordedProject = state.project;
  const workspaceId = recordedWorkspace?.workspaceId,
    projectId = recordedProject?.projectId;
  const session = state.sessions.find((item) => item.mode === "chat");
  if (
    !recordedWorkspace ||
    !recordedProject ||
    !workspaceId ||
    !projectId ||
    !session ||
    session.projectId !== projectId
  )
    throw new Error("The demo has no bound Chat destination. Refresh the recorded state.");
  const fresh = () => ({ signal: new AbortController().signal });
  const [workspaces, projects, sessions, tasks] = await Promise.all([
    fetchWorkspaces("all", 500, undefined, fresh()),
    fetchChatProjects("all", 300, workspaceId, undefined, fresh()),
    fetchChatSessions({ workspaceId, projectId, scope: "all", view: "all", includeHidden: true, limit: 100 }, fresh()),
    Promise.all(state.tasks.map((task) => fetchTask(task.taskId, workspaceId, undefined, fresh()))),
  ]);
  const workspace = workspaces.items.find((item) => item.workspaceId === workspaceId);
  const project = projects.items.find((item) => item.projectId === projectId);
  const chat = sessions.items.find((item) => item.sessionId === session.sessionId);
  if (
    !workspace ||
    workspace.lifecycleStatus !== "active" ||
    !workspace.citadelId ||
    workspace.name !== recordedWorkspace.name ||
    workspace.slug !== recordedWorkspace.slug ||
    !project ||
    project.workspaceId !== workspaceId ||
    project.lifecycleStatus !== "active" ||
    project.name !== recordedProject.name ||
    project.workspacePath !== recordedProject.workspacePath ||
    !chat ||
    chat.workspaceId !== workspaceId ||
    chat.projectId !== projectId ||
    chat.mode !== "chat" ||
    chat.title !== session.title ||
    chat.lifecycleStatus !== "active" ||
    tasks.some(
      (task, index) =>
        task.taskId !== state.tasks[index]?.taskId ||
        task.workspaceId !== workspaceId ||
        task.deletedAt ||
        canonicalJsonString({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          priority: task.priority,
        }) !== canonicalJsonString(state.tasks[index]),
    )
  )
    throw new Error(
      "The demo destination is stale or does not match its canonical workspace, project, session and tasks.",
    );
  return { workspaceId, citadelId: workspace.citadelId, sessionId: chat.sessionId, projectId };
}

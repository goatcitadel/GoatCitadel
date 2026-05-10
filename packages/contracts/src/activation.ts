import type { ChatProjectRecord, ChatSessionRecord } from "./chat.js";
import type { TaskRecord } from "./tasks.js";
import type { WorkspaceRecord } from "./workspaces.js";

export type DemoBootstrapStatus = "not_started" | "ready" | "partial";

export interface DemoPromptSeed {
  surface: "chat" | "cowork" | "code";
  title: string;
  prompt: string;
}

export interface DemoMemorySeed {
  namespace: string;
  title: string;
  content: string;
  reason: string;
}

export interface DemoBootstrapStateResponse {
  status: DemoBootstrapStatus;
  workspace?: Pick<WorkspaceRecord, "workspaceId" | "name" | "slug">;
  project?: Pick<ChatProjectRecord, "projectId" | "name" | "workspacePath">;
  sessions: Array<Pick<ChatSessionRecord, "sessionId" | "title" | "mode" | "projectId">>;
  tasks: Array<Pick<TaskRecord, "taskId" | "title" | "status" | "priority">>;
  starterPrompts: DemoPromptSeed[];
  memorySeeds: DemoMemorySeed[];
  nextRoute: string;
  notes: string[];
}

export interface DemoBootstrapResponse extends DemoBootstrapStateResponse {
  created: {
    workspace: boolean;
    project: boolean;
    chatSession: boolean;
    coworkSession: boolean;
    codeSession: boolean;
    coworkTask: boolean;
    codeTask: boolean;
    memorySeed: boolean;
  };
}

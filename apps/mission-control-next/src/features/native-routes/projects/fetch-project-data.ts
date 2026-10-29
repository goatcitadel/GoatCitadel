import type { ChatGeneratedArtifactRecord, ChatProjectRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  fetchChatGeneratedArtifacts,
  fetchChatProjects,
  fetchChatSessions,
} from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "./ProjectsRoutePage.helpers";

export type ProjectData = {
  artifactIssue: string | null;
  projects: ChatProjectRecord[];
  sessions: ChatSessionRecord[];
  artifacts: ChatGeneratedArtifactRecord[];
};

export async function fetchProjectData(activeWorkspaceId: string, activeCitadelId?: string): Promise<ProjectData> {
  const artifactsRequest = fetchChatGeneratedArtifacts({
    citadelId: activeCitadelId,
    workspaceId: activeWorkspaceId,
    limit: 1000,
  })
    .then((response) => ({ items: response.items, issue: null as string | null }))
    .catch((error: unknown) => ({
      items: [] as ChatGeneratedArtifactRecord[],
      issue: getErrorMessage(error),
    }));
  const [projectsResponse, sessionsResponse, artifactsResponse] = await Promise.all([
    fetchChatProjects("all", 300, activeWorkspaceId, activeCitadelId),
    fetchChatSessions({
      citadelId: activeCitadelId,
      workspaceId: activeWorkspaceId,
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    }),
    artifactsRequest,
  ]);
  return {
    projects: projectsResponse.items,
    sessions: sessionsResponse.items,
    artifacts: artifactsResponse.items,
    artifactIssue: artifactsResponse.issue,
  };
}

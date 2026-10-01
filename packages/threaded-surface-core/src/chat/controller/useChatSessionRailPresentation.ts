import type { ChatMode } from "@goatcitadel/contracts";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { useDeferredValue, useMemo } from "react";
import type {
  MissionThreadedControllerHostProps,
  MissionThreadedSessionRailData,
} from "../../MissionThreadedControllerHost.types";
import type { useChatComposerInteractions } from "../useChatComposerInteractions";
import { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionControls } from "../useChatSessionControls";
import type { useChatSessionData } from "../useChatSessionData";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import type { useChatThreadController } from "../useChatThreadController";
import type { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import type { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  lifecycleNotices: ReturnType<typeof useChatRunPresentation>["lifecycleNotices"];
  localNotices: ChatThreadNotice[];
  queuedOutbound: ReturnType<typeof useChatSurfaceOrchestration>["queuedOutbound"];
  presetProfiles: Array<{
    agentId: string;
    label: string;
    summary?: string;
    routeHint?: ChatMode;
    preferredProviderId?: string;
    preferredModel?: string;
    toolsPosture?: "safe_auto" | "manual";
    knowledgeAttachmentIds?: string[];
    promptFraming?: string;
  }>;
  lockSurface: NonNullable<MissionThreadedControllerHostProps["lockSurface"]>;
  search: string;
  workspaceName: NonNullable<MissionThreadedControllerHostProps["workspaceName"]>;
  deferredSearch: ReturnType<typeof useDeferredValue>;
  blockHistoricalMutation: () => boolean;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  handleSelectSessionFromRail: (
    sessionId: string,
    options?:
      | {
          turnId?: string | null | undefined;
          searchHit?: import("@goatcitadel/contracts").ChatSessionSearchHitRecord | undefined;
        }
      | undefined,
  ) => void;
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    "projects" | "sidebarNextCursor" | "sidebarLoadingMore" | "loadSidebar"
  >;
  threadController: Pick<
    ReturnType<typeof useChatThreadController>,
    | "selectedSession"
    | "visibleSessionLabelById"
    | "availableFolders"
    | "missionSessions"
    | "externalSessions"
    | "selectedProject"
    | "workspaceMissionSessionCount"
  >;
  surfaceState: Pick<
    ReturnType<typeof useMissionControlSurfaceState>,
    "isCodeSurface" | "activeModePreset" | "messageMode" | "workspaceSummaryCards" | "isChatSurface"
  >;
  sessionControls: Pick<
    ReturnType<typeof useChatSessionControls>,
    | "showProjectCreate"
    | "creatingSessionMode"
    | "projectName"
    | "projectPath"
    | "archiveWorkspacePending"
    | "setShowProjectCreate"
    | "setProjectName"
    | "setProjectPath"
    | "handleCreateProject"
  >;
  composerInteractions: Pick<
    ReturnType<typeof useChatComposerInteractions>,
    "handleCreateCurrentModeSession" | "handleArchiveWorkspace" | "handleConfirmArchiveWorkspace"
  >;
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    | "historyView"
    | "selectedProjectId"
    | "selectedFolderId"
    | "selectedTag"
    | "selectedSessionId"
    | "setHistoryView"
    | "setSelectedProjectId"
    | "setSelectedFolderId"
    | "setSelectedTag"
  >;
};

/** Builds the session rail and display summaries from scoped session owners. */
export function useChatSessionRailPresentation({
  lifecycleNotices,
  localNotices,
  queuedOutbound,
  presetProfiles,
  lockSurface,
  search,
  workspaceName,
  blockHistoricalMutation,
  setSearch,
  handleSelectSessionFromRail,
  sessionData,
  threadController,
  surfaceState,
  sessionControls,
  composerInteractions,
  selection,
}: Input) {
  const { setShowProjectCreate } = sessionControls;
  const { handleCreateCurrentModeSession } = composerInteractions;
  const { handleCreateProject } = sessionControls;
  const { handleArchiveWorkspace } = composerInteractions;
  const { handleConfirmArchiveWorkspace } = composerInteractions;
  const { loadSidebar } = sessionData;

  const threadNotices = useMemo(() => [...lifecycleNotices, ...localNotices], [lifecycleNotices, localNotices]);
  const queueItems = useMemo(
    () =>
      queuedOutbound.map((item) => ({
        id: item.id,
        action: item.action,
        label: (item.displayContent ?? item.content).trim()
          ? (item.displayContent ?? item.content).trim().slice(0, 96)
          : `Turn ${item.targetTurnId?.slice(-6) ?? "queued"}`,
        createdAt: item.createdAt,
        paused: Boolean(item.paused),
      })),
    [queuedOutbound],
  );
  const presetOptions = useMemo(
    () =>
      presetProfiles.map((item) => ({
        value: item.agentId,
        label: item.label,
        summary: item.summary,
        routeHint: item.routeHint,
        toolsPosture: item.toolsPosture,
      })),
    [presetProfiles],
  );
  const activeCodeProjects = useMemo(
    () =>
      (sessionData.projects?.items ?? [])
        .filter((item) => item.lifecycleStatus === "active")
        .map((project) => ({
          projectId: project.projectId,
          name: project.name,
          workspacePath: project.workspacePath,
        })),
    [sessionData.projects?.items],
  );
  const projectOptions = useMemo(
    () => [
      { value: "none", label: "Unassigned" },
      ...(sessionData.projects?.items ?? [])
        .filter((item) => item.lifecycleStatus === "active")
        .map((project) => ({ value: project.projectId, label: project.name })),
    ],
    [sessionData.projects?.items],
  );

  const workspaceSummaryText = threadController.selectedSession
    ? `${lockSurface ? "Current session" : surfaceState.isCodeSurface ? "Current code session" : `Active ${surfaceState.activeModePreset.label.toLowerCase()} session`}: ${threadController.selectedSession.title || threadController.visibleSessionLabelById.get(threadController.selectedSession.sessionId) || `Chat ${threadController.selectedSession.sessionId.slice(-6)}`}.`
    : lockSurface
      ? `Start a new ${surfaceState.activeModePreset.label.toLowerCase()} run or reopen a recent session from the left rail.`
      : surfaceState.isCodeSurface
        ? "Pick a code session or start a new one. Bind a project only when you want execution-heavy work."
        : `Use the queue to reopen a session or start a new ${surfaceState.activeModePreset.label.toLowerCase()} run from the left rail.`;
  const sessionRailData: MissionThreadedSessionRailData = useMemo(
    () => ({
      mode: surfaceState.messageMode,
      showProjectCreate: sessionControls.showProjectCreate,
      creatingSession: Boolean(sessionControls.creatingSessionMode),
      search,
      projectName: sessionControls.projectName,
      projectPath: sessionControls.projectPath,
      historyView: selection.historyView,
      selectedProjectId: selection.selectedProjectId,
      availableFolders: threadController.availableFolders,
      selectedFolderId: selection.selectedFolderId,
      selectedTag: selection.selectedTag,
      missionSessions: threadController.missionSessions,
      externalSessions: threadController.externalSessions,
      selectedSessionId: selection.selectedSessionId,
      summaryTitle: threadController.selectedProject?.name ?? workspaceName,
      summaryCopy: workspaceSummaryText,
      workspaceSummaryCards: surfaceState.workspaceSummaryCards,
      archiveWorkspaceEnabled:
        surfaceState.isChatSurface &&
        selection.historyView === "active" &&
        threadController.workspaceMissionSessionCount > 0,
      archiveWorkspaceCount: threadController.workspaceMissionSessionCount,
      archiveWorkspacePending: sessionControls.archiveWorkspacePending,
      hasMoreSessions: Boolean(sessionData.sidebarNextCursor),
      loadingMoreSessions: sessionData.sidebarLoadingMore,
      onToggleProjectCreate: () => setShowProjectCreate((current) => !current),
      onCreateSession: () => {
        if (!blockHistoricalMutation()) return handleCreateCurrentModeSession();
      },
      onSearchChange: setSearch,
      onProjectNameChange: sessionControls.setProjectName,
      onProjectPathChange: sessionControls.setProjectPath,
      onCreateProject: () => {
        if (!blockHistoricalMutation()) void handleCreateProject();
      },
      onHistoryViewChange: selection.setHistoryView,
      onArchiveWorkspace: () => {
        if (!blockHistoricalMutation()) handleArchiveWorkspace();
      },
      onConfirmArchiveWorkspace: async () => {
        if (!blockHistoricalMutation()) await handleConfirmArchiveWorkspace();
      },
      onSelectProjectId: selection.setSelectedProjectId,
      onSelectFolderId: selection.setSelectedFolderId,
      onSelectTag: selection.setSelectedTag,
      onSelectSession: handleSelectSessionFromRail,
      renderSessionLabel: (sessionId) =>
        threadController.visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`,
      onLoadMoreSessions: () => void loadSidebar(selection.historyView, { append: true }),
    }),
    [
      sessionControls.archiveWorkspacePending,
      threadController.availableFolders,
      blockHistoricalMutation,
      sessionControls.creatingSessionMode,
          threadController.externalSessions,
      handleArchiveWorkspace,
      handleConfirmArchiveWorkspace,
      handleCreateCurrentModeSession,
      handleCreateProject,
      handleSelectSessionFromRail,
      selection.historyView,
      surfaceState.isChatSurface,
      loadSidebar,
      surfaceState.messageMode,
      threadController.missionSessions,
      sessionControls.projectName,
      sessionControls.projectPath,
      search,
      selection.selectedFolderId,
      threadController.selectedProject?.name,
      selection.selectedProjectId,
      selection.selectedSessionId,
      selection.selectedTag,
      selection.setHistoryView,
      sessionControls.setProjectName,
      sessionControls.setProjectPath,
      setSearch,
      setShowProjectCreate,
      selection.setSelectedFolderId,
      selection.setSelectedProjectId,
      selection.setSelectedTag,
      sessionControls.showProjectCreate,
      sessionData.sidebarLoadingMore,
      sessionData.sidebarNextCursor,
      threadController.visibleSessionLabelById,
      threadController.workspaceMissionSessionCount,
      workspaceName,
      surfaceState.workspaceSummaryCards,
      workspaceSummaryText,
    ],
  );

  return {
    workspaceSummaryText,
    threadNotices,
    queueItems,
    presetOptions,
    activeCodeProjects,
    sessionRailData,
    projectOptions,
  };
}

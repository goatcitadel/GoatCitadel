import type { ReactNode } from "react";
import type { ThreadedGatewayStatusSummary, WorkTrustDescriptor } from "./chat/work-trust";
import type { ComponentProps, DragEventHandler, RefObject } from "react";
import type {
  ChatMode,
  ChatSessionRecord,
  ChatSessionSearchHitRecord,
  ChatThreadResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatGeneratedArtifactRecord,
  ChatSessionWorkbenchFileOperationPreviewRequest,
  ChatSessionWorkbenchFileOperationPreviewResponse,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchCommandRunRequest,
  ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { CoworkCanvasPanel as LegacyCoworkCanvasPanelComponent } from "@goatcitadel/mission-control-shared/components/CoworkCanvasPanel";
import type { ChatContextDockPanelsProps } from "./chat/ChatContextDockPanels.types";
import type { MissionControlActiveSessionSurfaceProps } from "./chat/MissionControlActiveSessionSurface";
import type { MissionThreadedBtwSideChatProps } from "./chat/useBtwSideChatController";

export interface MissionThreadedSessionRailData {
  mode: ChatMode;
  /** Initial conversation discovery is still pending; an empty list is not yet an empty history. */
  loading?: boolean;
  showProjectCreate: boolean;
  creatingSession: boolean;
  search: string;
  projectName: string;
  projectPath: string;
  historyView: "active" | "archived";
  selectedProjectId: string;
  availableFolders: Array<{ folderId: string; name: string; count: number }>;
  selectedFolderId: string;
  selectedTag: string | null;
  missionSessions: Array<ChatSessionRecord & { projectName?: string | null }>;
  externalSessions: Array<ChatSessionRecord & { channel?: string | null; account?: string | null }>;
  selectedSessionId: string | null;
  summaryTitle: string;
  summaryCopy: string;
  workspaceSummaryCards: Array<{ label: string; value: string }>;
  archiveWorkspaceEnabled?: boolean;
  archiveWorkspaceCount?: number;
  archiveWorkspacePending?: boolean;
  hasMoreSessions?: boolean;
  loadingMoreSessions?: boolean;
  onToggleProjectCreate: () => void;
  onCreateSession: () => void | Promise<void>;
  onSearchChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onCreateProject: () => void;
  onHistoryViewChange: (view: "active" | "archived") => void;
  onArchiveWorkspace?: () => void;
  onConfirmArchiveWorkspace?: () => void;
  onSelectProjectId: (projectId: string) => void;
  onSelectFolderId: (folderId: string) => void;
  onSelectTag: (tag: string | null) => void;
  onSelectSession: (
    sessionId: string,
    options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord },
  ) => void;
  renderSessionLabel: (sessionId: string) => string;
  onLoadMoreSessions?: () => void;
}

export interface MissionThreadedEmptyStateProps {
  mode: ChatMode;
  sessionCount: number;
  projectCount: number;
  workspaceName: string;
  approvalsCount: number;
  onCreateSession: () => void;
  onOpenCowork: () => void;
  onOpenCode: () => void;
  onOpenTasks: () => void;
  onOpenApprovals: (approvalId?: string) => void;
  onOpenStartHere?: () => void;
}

export interface MissionThreadedDropTargetProps {
  isDragActive: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}

export interface MissionThreadedCodeWorkflowPanelProps {
  workspaceId: string;
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  projectName?: string;
  needsProjectBinding: boolean;
  workbenchState: ChatSessionWorkbenchRecord | null;
  workbenchTree: ChatSessionWorkbenchTreeResponse | null;
  selectedFile: ChatSessionWorkbenchFileResponse | null;
  selectedFileDiff: ChatSessionWorkbenchFileDiffResponse | null;
  draftContent: string;
  expandedPaths: string[];
  diff: ChatSessionWorkbenchDiffResponse | null;
  output: ChatSessionWorkbenchOutputResponse | null;
  loading: boolean;
  busy: boolean;
  saving: boolean;
  error: string | null;
  hasDirtyDraft: boolean;
  hasRemoteChanges?: boolean;
  retainedDraftPaths?: string[];
  onRebaseDraft?: () => void;
  onSaveDraftForLeave?: () => Promise<boolean>;
  generatedArtifact: ChatGeneratedArtifactRecord | null;
  onCloseGeneratedArtifact?: () => void;
  availableProjects?: Array<{ projectId: string; name: string; workspacePath: string }>;
  selectedProjectCandidateId?: string;
  sourceBindingBusy?: boolean;
  onBindExistingProject?: (projectId: string) => Promise<unknown>;
  onImportProjectSource?: (input: {
    sourceType: "local_folder" | "github_repo";
    name?: string;
    sourcePath?: string;
    repoUrl?: string;
    ref?: string;
  }) => Promise<unknown>;
  onCreateWorktree?: () => void;
  onSelectFile: (relativePath: string) => void;
  onDraftChange: (nextValue: string) => void;
  onExpandedPathsChange: (nextPaths: string[]) => void;
  onRefresh: () => void;
  onSaveFile: () => void;
  onFileOperationPreview?: (
    input: ChatSessionWorkbenchFileOperationPreviewRequest,
  ) => Promise<ChatSessionWorkbenchFileOperationPreviewResponse | null>;
  onFileOperation?: (input: ChatSessionWorkbenchFileOperationRequest) => Promise<boolean>;
  onDiscardDraft: () => void;
  onRunValidationCommand?: (input: ChatSessionWorkbenchCommandRunRequest) => void;
  onApplyPatch?: (patch?: string) => void;
  onExportPatch?: () => Promise<void>;
  onRevertFile?: (relativePath?: string) => void;
  onRevertAll?: () => void;
  onRunHelperSnippet: (language: string, source: string) => void | Promise<void>;
  onOpenApprovals?: (approvalId?: string) => void;
}

export type MissionThreadedWorkflowPanel =
  | { kind: "cowork"; props: ComponentProps<typeof LegacyCoworkCanvasPanelComponent> }
  | { kind: "code"; props: MissionThreadedCodeWorkflowPanelProps }
  | null;

export interface MissionThreadedChangePlanReceipt {
  readonly plan: ChangePlanRecord;
  readonly dismissed?: boolean;
  readonly pending?: boolean;
  readonly onReview?: (plan: ChangePlanRecord) => void;
  readonly onCancel?: (plan: ChangePlanRecord) => void;
  readonly onMakeDefault?: (plan: ChangePlanRecord) => void;
  readonly onDismiss?: (plan: ChangePlanRecord) => void;
  readonly onOpenDetails?: (plan: ChangePlanRecord) => void;
}

export interface MissionThreadedRenderSurfaceInput {
  messageMode: ChatMode;
  sessionRailOpen: boolean;
  onSessionRailOpenChange: (next: boolean) => void;
  dockOpen: boolean;
  onDockOpenChange: (next: boolean) => void;
  onWorkbenchOpenChange?: (open: boolean) => void;
  sessionRail: MissionThreadedSessionRailData;
  activeSessionSurfaceProps: MissionControlActiveSessionSurfaceProps | null;
  emptyStateProps: MissionThreadedEmptyStateProps;
  dropTargetProps: MissionThreadedDropTargetProps;
  workflowPanel: MissionThreadedWorkflowPanel;
  contextDockProps: ChatContextDockPanelsProps | null;
  btwSideChatProps: MissionThreadedBtwSideChatProps;
  /** Gateway-owned plan history remains available to the local Activity view. */
  changePlans?: readonly ChangePlanRecord[];
  /** At most one transcript-adjacent plan receipt; all records remain in Activity history. */
  changePlanReceipt?: MissionThreadedChangePlanReceipt;
  /** Admit a returned plan to its owning Chat and open its governed review. */
  onReviewChangePlan?: (plan: ChangePlanRecord) => void;
  /** A monotonically increasing request to reveal Activity from transcript-adjacent UI. */
  activityOpenRequest?: number;
}

export type MissionThreadedActiveSessionSurfaceProps = MissionControlActiveSessionSurfaceProps;
export type MissionThreadedContextDockProps = ChatContextDockPanelsProps;

export interface MissionThreadedControllerHostProps {
  workspaceId?: string;
  workspaceName?: string;
  approvalsCount?: number;
  surface?: ChatMode;
  lockSurface?: boolean;
  hidePageHeader?: boolean;
  /** Let a shell render its conversation layout while initial discovery loads. */
  renderWhileLoading?: boolean;
  /**
   * Seeds modeOverride from an explicit URL mode (e.g. ?mode=chat) so it behaves
   * like the operator manually clicking the mode override control (QA finding N3):
   * it wins for surface presentation AND outbound sends on that thread, even when
   * the selected session's own mode differs. Re-seeds on session switch so the URL
   * override keeps winning while present; absent (undefined) leaves today's
   * session-mode-wins behavior untouched.
   */
  initialModeOverride?: ChatMode;
  /**
   * The query the controller selects the session, turn and artifact from. A shell that can hold a
   * Back or Forward move passes the location its views show, because the live URL briefly names the
   * held target. Omitted, the controller reads `window.location.search` during render.
   */
  routeSearch?: string;
  gatewayStatus?: ThreadedGatewayStatusSummary;
  workTrust?: WorkTrustDescriptor;
  onWorkTrustSummaryChange?: (summary: string | null) => void;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: (approvalId?: string) => void;
  onOpenStartHere?: () => void;
  onOpenPersonalitiesSettings?: () => void;
  onOpenProviderSettings?: () => void;
  onOpenLocalAiSettings?: () => void;
  onOpenLibraryArtifacts?: () => void;
  onOpenLibraryImports?: () => void;
  onOpenOpsRuntime?: () => void;
  onNavigateSurface?: (
    surface: ChatMode,
    options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
  ) => void;
  // `origin` distinguishes a passive session-mode sync (the selected session's
  // own stored mode, e.g. on arrival or session switch) from an active operator
  // change (the ThreadedModeControl UI's onModeOverride callback). Callers that
  // only care about "what mode is resolved now" can ignore the second arg;
  // callers that need to know whether the URL should be treated as truthfully
  // superseded (vs. a one-time seed that shouldn't be echoed back) read it.
  // Omitted/undefined is treated as "session-sync" for backward compatibility.
  onResolvedModeChange?: (mode: ChatMode, origin?: "session-sync" | "manual-override") => void;
  renderSurface: (input: MissionThreadedRenderSurfaceInput) => ReactNode;
}

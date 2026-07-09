/* eslint-disable max-lines -- Shared threaded controller host centralizes session/thread behavior for both Mission Control apps. */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type DragEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ChatAttachmentRecord,
  ChatGeneratedArtifactRecord,
  ChatMode,
  ChatModePresetRecord,
  ChatSessionRecord,
  ChatSessionWorkbenchCommandRunRequest,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatSessionPrefsPatch,
  ChatThreadResponse,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { isChatTurnActiveStatus } from "@goatcitadel/contracts";
import {
  attachThreadKnowledgeAttachment,
  clearChatSessionGoal,
  createChatGeneratedArtifact,
  createChatSession,
  fetchAgents,
  fetchChatGeneratedArtifact,
  fetchChatSessionGoal,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchRuntimeLifecycleExport,
  fetchSkills,
  parseChatCommand,
  removeThreadKnowledgeAttachment,
  setChatSessionGoal,
  steerChatSession,
  updateChatSessionPrefs,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  controlAgenticRun,
  fetchAgenticRuns,
  fetchAgenticRunTree,
  type AgenticRunTreeResponse,
} from "@goatcitadel/mission-control-shared/api/agentic";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { PageHeader } from "@goatcitadel/mission-control-shared/components/PageHeader";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import type { CoworkCanvasPanel as LegacyCoworkCanvasPanelComponent } from "@goatcitadel/mission-control-shared/components/CoworkCanvasPanel";
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadView";
import { deriveCoworkRunViewModel, type CoworkAgenticControlItem } from "./cowork-view-model";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { pageCopy } from "@goatcitadel/mission-control-shared/content/copy";
import {
  setDevDiagnosticsActiveChatSession,
  setDevDiagnosticsLatestTraceSummary,
} from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import type { ChatContextDockPanelsProps } from "./chat/ChatContextDockPanels.types";
import type { ChatVisualStreamMode } from "./chat/chat-streaming-preview";
import type { MissionControlActiveSessionSurfaceProps } from "./chat/MissionControlActiveSessionSurface";
import { describeChatUiError, type ChatErrorSource } from "./chat/chat-error-copy";
import type { OutboundContextBlock } from "./chat/useChatSurfaceOrchestration";
import { formatCommandResult } from "./chat/chat-page-derivations";
import { resolveProviderModelSelection } from "./chat/chat-page-helpers";
import {
  formatWorkProviderModelSummary,
  type ThreadedGatewayStatusSummary,
  type WorkTrustDescriptor,
} from "./chat/work-trust";
import { ThreadedLoadingState } from "./chat/ThreadedLoadingState";
import {
  buildContextSelectionState,
  buildPrefsPatchFromRecord,
  buildSelectedConversationContext,
  canReadAttachmentInFull,
  formatAgenticBackgroundHandoffNotice,
  formatAgenticBackgroundHandoffSummary,
  formatFallbackSummary,
  formatRuntimeSummary,
  formatRoutingTargetSummary,
  formatSelectionSourceSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  getThreadSourceLabel,
  isDocumentAttachment,
  readVisualStreamModeFromStorage,
  reconcilePendingAttachmentModes,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
  trimForkTitle,
  VISUAL_STREAM_MODE_PREF_KEY,
  type PendingAttachmentDocumentMode,
} from "./chat/mission-threaded-controller-helpers";
import {
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  parseQueueCommand,
  parseBtwCommand,
  resolveCoworkComposerStopControl,
  resolveMidTurnDisposition,
  revealGeneratedArtifactInSurface,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  buildSuggestionSyncKey,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
} from "./chat/chat-page-pure-helpers";
import { resolveOutboundSurfaceMode } from "./pure-helpers";
import { useChatApprovalController } from "./chat/useChatApprovalController";
import { useChatContextActions } from "./chat/useChatContextActions";
import { useChatComposerInteractions } from "./chat/useChatComposerInteractions";
import {
  abortActiveChatStream,
  type ActiveChatStreamState,
  useChatOutboundExecution,
} from "./chat/useChatOutboundExecution";
import {
  createAttachmentStorageKey,
  createDraftStorageKey,
  createQueueStorageKey,
  useDebouncedLocalStoragePersistence,
} from "./chat/useChatLocalPersistence";
import { useChatSessionData } from "./chat/useChatSessionData";
import { useChatSessionControls } from "./chat/useChatSessionControls";
import { useChatDockWorkbenchController } from "./chat/useChatDockWorkbenchController";
import { useChatProviderRoutingController } from "./chat/useChatProviderRoutingController";
import { useChatRoutePreflight } from "./chat/useChatRoutePreflight";
import {
  resolveOutboundDraftContent,
  useChatSurfaceOrchestration,
  type OutboundQueueItem,
} from "./chat/useChatSurfaceOrchestration";
import { useChatThreadController } from "./chat/useChatThreadController";
import { detectImageGenerationIntent } from "./chat/chat-image-intent";
import { useChatMultimodalControls } from "./chat/useChatMultimodalControls";
import { useBtwSideChatController, type MissionThreadedBtwSideChatProps } from "./chat/useBtwSideChatController";
import { useRouteGeneratedArtifactReveal } from "./chat/useRouteGeneratedArtifactReveal";
import {
  formatSessionLabel,
  looksMachineSessionLabel,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
  useMissionControlSurfaceState,
} from "./chat/useMissionControlSurfaceState";
import { createCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { useSurfaceClassifyPreview } from "./chat/useSurfaceClassifyPreview";

export {
  formatSessionLabel,
  getCapabilitySuggestionConfirmationCopy,
  getDeleteSessionConfirmationMessage,
  looksMachineSessionLabel,
  revealGeneratedArtifactInSurface,
  resolveSelectedTurnId,
  resolveChatRefreshPlan,
  resolveOptimisticChatPrefs,
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  shouldShowLearnedMemoryPanel,
  shouldShowSuggestionsPanel,
  shouldShowTracePanel,
};

export {
  formatFallbackSummary,
  formatRuntimeSummary,
  formatRoutingTargetSummary,
  formatThreadedRunStateLabel,
  formatThreadedRunStateSummary,
  reconcilePendingAttachmentModes,
  requiresBoundaryAcknowledgment,
  resolveExecutionRoutePrefs,
  runWithSelectedSession,
  runWithSelectedSessionId,
};
export type { PendingAttachmentDocumentMode } from "./chat/mission-threaded-controller-helpers";

export interface MissionThreadedSessionRailData {
  mode: ChatMode;
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
  onCreateSession: () => void;
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
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
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
  onFileOperation?: (input: ChatSessionWorkbenchFileOperationRequest) => Promise<boolean>;
  onDiscardDraft: () => void;
  onRunValidationCommand?: (input: ChatSessionWorkbenchCommandRunRequest) => void;
  onApplyPatch?: (patch?: string) => void;
  onExportPatch?: () => Promise<void>;
  onRevertFile?: (relativePath?: string) => void;
  onRevertAll?: () => void;
  onRunHelperSnippet: (language: string, source: string) => void;
  onOpenApprovals?: (approvalId?: string) => void;
}

export type MissionThreadedWorkflowPanel =
  | { kind: "cowork"; props: ComponentProps<typeof LegacyCoworkCanvasPanelComponent> }
  | { kind: "code"; props: MissionThreadedCodeWorkflowPanelProps }
  | null;

export interface MissionThreadedRenderSurfaceInput {
  messageMode: ChatMode;
  sessionRailOpen: boolean;
  onSessionRailOpenChange: (next: boolean) => void;
  dockOpen: boolean;
  onDockOpenChange: (next: boolean) => void;
  sessionRail: MissionThreadedSessionRailData;
  activeSessionSurfaceProps: MissionControlActiveSessionSurfaceProps | null;
  emptyStateProps: MissionThreadedEmptyStateProps;
  dropTargetProps: MissionThreadedDropTargetProps;
  workflowPanel: MissionThreadedWorkflowPanel;
  contextDockProps: ChatContextDockPanelsProps | null;
  btwSideChatProps: MissionThreadedBtwSideChatProps;
}

export type MissionThreadedActiveSessionSurfaceProps = MissionControlActiveSessionSurfaceProps;
export type MissionThreadedContextDockProps = ChatContextDockPanelsProps;

const STREAM_PREF_KEY = "goatcitadel.chat.agent.stream.enabled";
export function MissionThreadedControllerHost({
  workspaceId = "default",
  workspaceName = workspaceId,
  approvalsCount = 0,
  surface,
  lockSurface = false,
  hidePageHeader = false,
  initialModeOverride,
  gatewayStatus,
  workTrust,
  onWorkTrustSummaryChange,
  onOpenCowork = () => undefined,
  onOpenCode = () => undefined,
  onOpenTasks = () => undefined,
  onOpenApprovals = () => undefined,
  onOpenStartHere = () => undefined,
  onOpenPersonalitiesSettings = () => undefined,
  onOpenLibraryArtifacts = () => undefined,
  onOpenOpsRuntime = () => undefined,
  onNavigateSurface,
  onResolvedModeChange,
  renderSurface,
}: {
  workspaceId?: string;
  workspaceName?: string;
  approvalsCount?: number;
  surface?: ChatMode;
  lockSurface?: boolean;
  hidePageHeader?: boolean;
  /**
   * Seeds modeOverride from an explicit URL mode (e.g. ?mode=chat) so it behaves
   * like the operator manually clicking the mode override control (QA finding N3):
   * it wins for surface presentation AND outbound sends on that thread, even when
   * the selected session's own mode differs. Re-seeds on session switch so the URL
   * override keeps winning while present; absent (undefined) leaves today's
   * session-mode-wins behavior untouched.
   */
  initialModeOverride?: ChatMode;
  gatewayStatus?: ThreadedGatewayStatusSummary;
  workTrust?: WorkTrustDescriptor;
  onWorkTrustSummaryChange?: (summary: string | null) => void;
  onOpenCowork?: () => void;
  onOpenCode?: () => void;
  onOpenTasks?: () => void;
  onOpenApprovals?: (approvalId?: string) => void;
  onOpenStartHere?: () => void;
  onOpenPersonalitiesSettings?: () => void;
  onOpenLibraryArtifacts?: () => void;
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
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<"active" | "archived">("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<ChatMode | null>(initialModeOverride ?? null);
  // Synced ref so the selectedSessionId-keyed reset effect below can read the
  // latest initialModeOverride without depending on it directly (it must only
  // re-run on session switch, not on every prop identity change).
  const initialModeOverrideRef = useRef(initialModeOverride);
  // Tracks whether the operator has manually changed the mode override (via the
  // ThreadedModeControl UI's onModeOverride callback) since the last time
  // initialModeOverride genuinely changed value. A URL-seeded override is a
  // one-time seed, not a standing force: once the operator diverges from it,
  // a session switch must not snap the override back to the URL's seed and
  // silently discard their explicit choice. Set true in the public
  // onModeOverride callback below; cleared when initialModeOverride's PROP
  // VALUE changes (a new navigation seed re-arms URL precedence).
  const userAdjustedModeOverrideRef = useRef(false);
  useEffect(() => {
    if (initialModeOverrideRef.current !== initialModeOverride) {
      userAdjustedModeOverrideRef.current = false;
    }
    initialModeOverrideRef.current = initialModeOverride;
  }, [initialModeOverride]);
  // Re-seed modeOverride whenever the prop changes to a defined value (e.g. the
  // URL gains ?mode=chat after mount), so navigating within the same session
  // still picks up a newly-explicit override.
  useEffect(() => {
    if (initialModeOverride !== undefined) {
      setModeOverride(initialModeOverride);
    }
  }, [initialModeOverride]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [selectedContextTurnIds, setSelectedContextTurnIds] = useState<string[]>([]);
  const [pendingThreadContext, setPendingThreadContext] = useState<OutboundContextBlock | null>(null);
  const [draft, setDraft] = useState("");
  const [pinnedGoal, setPinnedGoal] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [fullWebAccess, setFullWebAccess] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<ChatErrorSource | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [folderName, setFolderName] = useState("");
  const [tagsValue, setTagsValue] = useState("");
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(STREAM_PREF_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const [visualStreamMode, setVisualStreamMode] = useState<ChatVisualStreamMode>(() =>
    readVisualStreamModeFromStorage(),
  );
  const [renameTitle, setRenameTitle] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);
  const [followThreadOutput, setFollowThreadOutput] = useState(true);
  const [localNotices, setLocalNotices] = useState<ChatThreadNotice[]>([]);
  const [activeGeneratedArtifact, setActiveGeneratedArtifact] = useState<ChatGeneratedArtifactRecord | null>(null);
  const [sessionRailOpen, setSessionRailOpen] = useState(false);
  const [pendingAttachmentModes, setPendingAttachmentModes] = useState<Record<string, PendingAttachmentDocumentMode>>(
    {},
  );
  const [knowledgeUrlDraft, setKnowledgeUrlDraft] = useState("");
  const [knowledgeUrlMode, setKnowledgeUrlMode] = useState<ThreadKnowledgeRetrievalMode>("retrieval");
  const [presetApplyWarning, setPresetApplyWarning] = useState<string | null>(null);
  const setUiError = useCallback((value: string | null, source: ChatErrorSource = "other") => {
    setError(value);
    setErrorSource(value ? source : null);
  }, []);
  const [presetProfiles, setPresetProfiles] = useState<
    Array<{
      agentId: string;
      label: string;
      summary?: string;
      routeHint?: ChatMode;
      preferredProviderId?: string;
      preferredModel?: string;
      toolsPosture?: "safe_auto" | "manual";
      knowledgeAttachmentIds?: string[];
      promptFraming?: string;
    }>
  >([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [workbenchDiscardConfirm, setWorkbenchDiscardConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [threadModelSwitchConfirm, setThreadModelSwitchConfirm] = useState<{
    title: string;
    message: string;
    patch: ChatSessionPrefsPatch;
  } | null>(null);
  const [agenticRunTree, setAgenticRunTree] = useState<AgenticRunTreeResponse | null>(null);
  const [agenticControlPending, setAgenticControlPending] = useState<string | null>(null);
  const [agenticControlStatus, setAgenticControlStatus] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastLocalPrefMutationAtRef = useRef(0);
  const prefMutationSequenceRef = useRef(0);
  const lastPublishedWorkTrustSummaryRef = useRef<string | null>(null);
  const lastCapabilitySuggestionSyncKeyRef = useRef<string | null>(null);
  const lastSpecialistSuggestionSyncKeyRef = useRef<string | null>(null);
  const executeOutboundItemRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => false);
  const queuedOutboundSetterRef = useRef<React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>>(() => []);
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const applyFetchedThreadRef = useRef<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>(
    () => false,
  );
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateRef = useRef<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >(async () => undefined);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  const deferredSearch = useDeferredValue(search.trim());
  const compactSurfaceLayout = useMediaQuery("(max-width: 1023px)");

  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    getCachedModels,
    loadModelsForProvider,
  } = useProviderModelCatalog("chat");
  const eventStreamStatus = useEventStreamStatus();
  const pushLocalNotice = useCallback((content: string, tone: ChatThreadNotice["tone"] = "neutral") => {
    setLocalNotices((current) =>
      [
        {
          id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content,
          tone,
          timestamp: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 12),
    );
  }, []);

  useEffect(() => {
    pushLocalNoticeRef.current = pushLocalNotice;
  }, [pushLocalNotice]);

  useEffect(() => {
    let cancelled = false;
    void fetchAgents("active", 500)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPresetProfiles(
          response.items
            .filter((item) => item.presetDefaults?.presetLabel)
            .map((item) => ({
              agentId: item.agentId,
              label: item.presetDefaults?.presetLabel ?? item.name,
              summary: item.presetDefaults?.presetSummary,
              routeHint: item.presetDefaults?.routeHint,
              preferredProviderId: item.presetDefaults?.preferredProviderId,
              preferredModel: item.presetDefaults?.preferredModel,
              toolsPosture: item.presetDefaults?.toolsPosture,
              knowledgeAttachmentIds: item.presetDefaults?.knowledgeAttachmentIds,
              promptFraming: item.presetDefaults?.promptFraming,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setPresetProfiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionData = useChatSessionData({
    workspaceId,
    historyView,
    searchQuery: deferredSearch,
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig,
    setError: setUiError,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
    surfaceMode: lockSurface && surface ? surface : undefined,
  });
  const {
    projects,
    sessions,
    thread,
    setThread,
    prefs,
    setPrefs,
    binding,
    setBinding,
    generatedArtifacts,
    setGeneratedArtifacts,
    threadKnowledgeAttachments,
    setThreadKnowledgeAttachments,
    settings,
    commandCatalog,
    proactiveStatus,
    setProactiveStatus,
    proactiveRuns,
    setProactiveRuns,
    learnedMemory,
    setLearnedMemory,
    specialistCandidates,
    setSpecialistCandidates,
    installedSkills,
    setInstalledSkills,
    mcpServers,
    setMcpServers,
    mcpTemplates,
    setMcpTemplates,
    loading,
    isRefreshing,
    messagesLoading,
    secondaryLoading,
    sidebarNextCursor,
    sidebarLoadingMore,
    loadSidebar,
    loadSessionCoreState,
  } = sessionData;
  const currentSessionMode: ChatMode = "chat";

  const lastEmittedModeRef = useRef<ChatMode | null>(null);
  useEffect(() => {
    if (currentSessionMode && currentSessionMode !== lastEmittedModeRef.current) {
      lastEmittedModeRef.current = currentSessionMode;
      onResolvedModeChange?.(currentSessionMode, "session-sync");
    }
  }, [currentSessionMode, onResolvedModeChange]);

  // Clear a stale override when the selected thread changes to prevent cross-thread leakage.
  // The override is read synchronously by the next send before this fires, so a same-thread
  // override still applies; on an existing code thread subsequent turns naturally remain code.
  // When an explicit URL override (initialModeOverride) is present, re-seed from it instead of
  // clearing to null so selecting another session while ?mode=chat is present keeps honoring
  // the URL (QA finding N3) rather than reverting to that session's own mode.
  //
  // EXCEPTION: the URL seed is a one-time force, not a standing one. If the operator has
  // manually changed the override since it was last (re-)seeded from the URL
  // (userAdjustedModeOverrideRef), their explicit choice takes precedence over the seed on a
  // session switch — the override clears to null and the newly-selected session's own mode
  // wins, exactly like the pre-existing behavior for an unseeded override. An untouched URL
  // seed keeps re-asserting itself on every session switch, as before.
  useEffect(() => {
    setModeOverride(userAdjustedModeOverrideRef.current ? null : (initialModeOverrideRef.current ?? null));
  }, [selectedSessionId]);

  const resolveAgenticRunTree = useCallback(async (): Promise<AgenticRunTreeResponse | null> => {
    if (!selectedSessionId) {
      return null;
    }
    const response = await fetchAgenticRuns({
      workspaceId,
      sessionId: selectedSessionId,
      surface: "chat",
      limit: 1,
    });
    const runId = response.items[0]?.runId;
    return runId ? fetchAgenticRunTree(runId, { workspaceId }) : null;
  }, [currentSessionMode, selectedSessionId, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void resolveAgenticRunTree()
      .then((tree) => {
        if (!cancelled) {
          setAgenticRunTree(tree);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgenticRunTree(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolveAgenticRunTree]);

  const threadController = useChatThreadController({
    surfaceMode: currentSessionMode,
    showAllModes: !lockSurface,
    routeSearch,
    sessions: sessions?.items,
    projects: projects?.items,
    thread,
    selectedProjectId,
    setSelectedProjectId,
    selectedFolderId,
    setSelectedFolderId,
    selectedTag,
    setSelectedTag,
    historyView,
    setHistoryView,
    selectedSessionId,
    setSelectedSessionId,
    selectedTurnId,
    setSelectedTurnId,
    search,
    setSearch,
    followThreadOutput,
    setFollowThreadOutput,
    applyFetchedThreadRef,
    messageMutationVersionRef,
  });
  const {
    selectedSession,
    selectedProject,
    messages,
    missionSessions,
    externalSessions,
    workspaceMissionSessionCount,
    boundMissionSessionCount,
    visibleSessionLabelById,
    availableFolders,
  } = threadController;
  const routeArtifactId = useMemo(
    () => new URLSearchParams(routeSearch).get("artifactId")?.trim() || null,
    [routeSearch],
  );

  useEffect(() => {
    loadSessionCoreStateRef.current = loadSessionCoreState;
  }, [loadSessionCoreState]);

  const sessionControls = useChatSessionControls({
    workspaceId,
    historyView,
    sessionMode: currentSessionMode,
    selectedProjectId,
    selectedSessionId,
    selectedSession,
    renameTitle,
    folderName,
    tagsValue,
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError: setUiError,
    setSending,
    setQueuedOutbound: (value) => queuedOutboundSetterRef.current(value),
    setThread,
    loadSidebar,
    setBinding,
  });
  const {
    creatingSessionMode,
    projectName,
    setProjectName,
    projectPath,
    setProjectPath,
    showProjectCreate,
    setShowProjectCreate,
    sessionControlPending,
    sessionDeleteConfirm,
    setSessionDeleteConfirm,
    archiveWorkspacePending,
    archiveWorkspaceConfirmOpen,
    setArchiveWorkspaceConfirmOpen,
    integrationConnectionId,
    setIntegrationConnectionId,
    integrationTarget,
    setIntegrationTarget,
    handleCreateSession,
    ensureSession,
    handleCreateProject,
    handleArchiveWorkspaceMissionChats,
    handleRenameSession,
    handleSaveOrganization,
    handleTogglePinSession,
    handleToggleArchiveSession,
    handleDeleteSession,
    confirmDeleteSession,
    handleAssignProject,
    handleImportCodeProject,
    handleSaveExternalBinding,
  } = sessionControls;

  const threadContextSourceLabel = useMemo(
    () => getThreadSourceLabel({ selectedSession, selectedSessionId, visibleSessionLabelById }),
    [selectedSession, selectedSessionId, visibleSessionLabelById],
  );
  const selectedConversationContext = useMemo(
    () =>
      buildSelectedConversationContext({
        thread,
        turnIds: selectedContextTurnIds,
        sourceLabel: threadContextSourceLabel,
        sourceSessionId: selectedSessionId ?? undefined,
      }),
    [selectedContextTurnIds, selectedSessionId, thread, threadContextSourceLabel],
  );
  const activeOutboundContext =
    pendingThreadContext && pendingThreadContext.sessionId === selectedSessionId
      ? pendingThreadContext
      : selectedConversationContext;
  const contextSelection = buildContextSelectionState(activeOutboundContext);
  useEffect(() => {
    if (!thread || selectedContextTurnIds.length === 0) {
      return;
    }
    const availableTurnIds = new Set(thread.turns.map((turn) => turn.turnId));
    setSelectedContextTurnIds((current) => {
      const next = current.filter((turnId) => availableTurnIds.has(turnId));
      return next.length === current.length ? current : next;
    });
  }, [selectedContextTurnIds.length, thread]);
  const handleOutboundContextConsumed = useCallback(() => {
    setSelectedContextTurnIds([]);
    setPendingThreadContext((current) => (current?.sessionId === selectedSessionId ? null : current));
  }, [selectedSessionId]);

  const {
    queuedOutbound,
    setQueuedOutbound,
    editingTurnId,
    setEditingTurnId,
    handleSend,
    handleRetryTurn,
    handleStopActiveTurn,
    handleBeginEditTurn,
    handleResumeQueue,
    handleRemoveQueuedItem,
  } = useChatSurfaceOrchestration({
    draft,
    pendingAttachments,
    outboundContext: activeOutboundContext,
    selectedSessionId,
    thread,
    sending,
    composerRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef,
    executeOutboundItemRef,
    pushLocalNoticeRef,
    setDraft,
    setPendingAttachments,
    setPendingApproval: () => undefined,
    setError: setUiError,
    onOutboundContextConsumed: handleOutboundContextConsumed,
    loadSessionCoreStateRef,
    abortActiveChatStream,
  });
  const composerSendHandlerRef = useRef<() => Promise<void>>(handleSend);
  const handleComposerSend = useCallback(() => composerSendHandlerRef.current(), []);

  useEffect(() => {
    queuedOutboundSetterRef.current = setQueuedOutbound;
  }, [setQueuedOutbound]);
  const {
    commandIndex,
    setCommandIndex,
    commandSuggestions,
    selectedProviderId,
    selectedModel,
    selectedProviderLabel,
    selectedModelLabel,
    requestedProviderLabel,
    requestedModelLabel,
    selectionSourceLabel,
    runtimeSummary,
    runtimeTone,
    providerOptions,
  } = useChatProviderRoutingController({
    runtimeLlmConfig,
    runtimeProviderCatalog,
    getCachedModels,
    loadModelsForProvider,
    prefs,
    settings,
    draft,
    commandCatalog,
    installedSkills,
    mcpServers,
    mcpTemplates,
  });
  const executionSurfaceMode: ChatMode = "chat";
  const outboundSurfaceMode = resolveOutboundSurfaceMode({ lockSurface, surface, modeOverride });
  const executionRoutePrefs = useMemo(
    () => resolveExecutionRoutePrefs(prefs, executionSurfaceMode, selectedProviderId, selectedModel),
    [executionSurfaceMode, prefs, selectedModel, selectedProviderId],
  );
  const routePreflight = useChatRoutePreflight({
    sessionId: selectedSessionId,
    prefs: executionRoutePrefs,
    surfaceMode: executionSurfaceMode,
    displayAction: editingTurnId ? "edit" : "send",
    displayTurnId: editingTurnId,
    enabled: Boolean(selectedSessionId),
  });
  const [acknowledgedRoutePreflightHashes, setAcknowledgedRoutePreflightHashes] = useState<Record<string, true>>({});
  const currentRoutePreflight = routePreflight.result;
  const currentRoutePreflightHash = routePreflight.resultHash;
  const { panelProps: btwSideChatProps, openSideChat: openBtwSideChat } = useBtwSideChatController({
    workspaceId,
    selectedSession,
    selectedSessionId,
    selectedTurnId,
    currentSurface: executionSurfaceMode,
    prefs: executionRoutePrefs,
    selectedProviderId,
    selectedModel,
    fullWebAccess,
    ensureSession,
    pushLocalNotice,
    setUiError,
  });
  const currentRouteBoundaryAcknowledged = Boolean(
    currentRoutePreflightHash && acknowledgedRoutePreflightHashes[currentRoutePreflightHash],
  );
  const acknowledgeCurrentRouteBoundary = useCallback(() => {
    if (!currentRoutePreflightHash) {
      return;
    }
    setAcknowledgedRoutePreflightHashes((current) => ({
      ...current,
      [currentRoutePreflightHash]: true,
    }));
  }, [currentRoutePreflightHash]);

  useEffect(() => {
    if (!lockSurface) {
      if (lastPublishedWorkTrustSummaryRef.current !== null) {
        lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
      return;
    }
    const nextSummary = formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel);
    if (lastPublishedWorkTrustSummaryRef.current === nextSummary) {
      return;
    }
    lastPublishedWorkTrustSummaryRef.current = nextSummary;
    onWorkTrustSummaryChange?.(nextSummary);
  }, [lockSurface, onWorkTrustSummaryChange, selectedModelLabel, selectedProviderLabel]);

  useEffect(
    () => () => {
      if (lastPublishedWorkTrustSummaryRef.current !== null) {
        lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
    },
    [onWorkTrustSummaryChange],
  );

  const handleCommandExecution = useCallback(
    async (sessionId: string, commandText: string) => {
      const btwCommand = parseBtwCommand(commandText);
      if (btwCommand) {
        await openBtwSideChat(btwCommand.text);
        return;
      }
      const queueCommand = parseQueueCommand(commandText);
      if (queueCommand) {
        if (queueCommand.kind === "steer") {
          if (!queueCommand.text) {
            pushLocalNotice("Usage: /queue steer <instruction>", "warning");
            return;
          }
          try {
            const response = await steerChatSession(sessionId, { instruction: queueCommand.text });
            pushLocalNotice(
              response.accepted
                ? "Steering instruction queued."
                : (response.reason ?? "Steering instruction not accepted."),
              response.accepted ? "success" : "warning",
            );
          } catch (cause) {
            setUiError(cause instanceof Error ? cause.message : "Failed to send steering instruction.");
          }
          return;
        }
        if (!queueCommand.text) {
          pushLocalNotice(`Usage: /queue ${queueCommand.kind} <message>`, "warning");
          return;
        }
        setQueuedOutbound((current) => [
          ...current,
          {
            id: `queue-${Date.now()}`,
            action: "send",
            sessionId,
            content: queueCommand.text,
            attachments: [],
            createdAt: new Date().toISOString(),
            paused: queueCommand.kind === "collect",
          },
        ]);
        pushLocalNotice(
          queueCommand.kind === "collect" ? "Message collected in the queue." : "Follow-up queued for the next turn.",
          "success",
        );
        return;
      }
      const commandPolicyTurn =
        thread?.turns.find(
          (turn) => turn.turnId === (selectedTurnId ?? thread.selectedTurnId ?? thread.activeLeafTurnId),
        ) ?? null;
      const commandPolicyRunId = commandPolicyTurn?.trace.orchestration?.runId;
      const result = await parseChatCommand(sessionId, commandText, {
        surface: executionSurfaceMode,
        ...(commandPolicyRunId ? { policyRunId: commandPolicyRunId } : {}),
      });
      if (result.prefs) setPrefs(result.prefs);
      pushLocalNotice(formatCommandResult(result), result.ok ? "success" : "warning");
      if (result.command === "/project" || result.command === "/new") {
        await loadSidebar();
      }
      if (result.command === "/plan" && result.prefs) {
        setPrefs(result.prefs);
      }
      if (result.session) {
        setSelectedSessionId(result.session.sessionId);
      }
      if (result.command === "/skill" || result.command === "/skills") {
        setInstalledSkills(await fetchSkills().then((payload) => payload.items));
      }
      if (result.command === "/mcp") {
        const [servers, templates] = await Promise.all([fetchMcpServers(), fetchMcpTemplates()]);
        setMcpServers(servers.items);
        setMcpTemplates(templates.items);
      }
    },
    [
      loadSidebar,
      executionSurfaceMode,
      openBtwSideChat,
      pushLocalNotice,
      setInstalledSkills,
      setMcpServers,
      setMcpTemplates,
      setPrefs,
      setQueuedOutbound,
      setUiError,
      selectedTurnId,
      thread,
    ],
  );

  const runtimeBlockerActiveRef = useRef(false);
  const contextActions = useChatContextActions({
    selectedSessionId,
    selectedSession,
    selectedTurnId,
    thread,
    draft,
    messages,
    prefs,
    selectedProviderId,
    selectedModel,
    surfaceMode: executionSurfaceMode,
    fullWebAccess,
    sending,
    streamEnabled,
    codeModeNeedsProjectBinding: false,
    loadSidebar,
    ensureSession,
    setError: setUiError,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    learnedMemory,
    setLearnedMemory,
    specialistCandidates,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice,
    lastLocalPrefMutationAtRef,
    runtimeBlockerActiveRef,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  });
  const {
    capabilitySuggestions,
    setCapabilitySuggestions,
    specialistSuggestions,
    setSpecialistSuggestions,
    activeDelegationRun,
    delegationSuggestion,
    setDelegationSuggestion,
    capabilitySuggestionConfirm,
    setCapabilitySuggestionConfirm,
    capabilitySuggestionPending,
    capabilityConfirmationCopy,
    handleRunQuickResearch,
    handleProactivePolicyPatch,
    handleTriggerProactive,
    handleSuggestDelegation,
    handleAcceptDelegation,
    handleRunCodeDelegation,
    handleMemoryStatusUpdate,
    handleRebuildLearnedMemory,
    handleCreateSpecialistDraft,
    handleActivateCatalogSpecialist,
    handleSpecialistCandidatePatch,
    handleCapabilitySuggestionAction,
    confirmCapabilitySuggestionAction,
  } = contextActions;

  const outbound = useChatOutboundExecution({
    sessionConfig: {
      surfaceMode: outboundSurfaceMode,
      selectedSessionId,
      selectedSession,
      prefs,
      fullWebAccess,
      selectedProviderId,
      selectedModel,
    },
    streamConfig: {
      streamEnabled,
      visualStreamMode,
      activeStreamRef,
    },
    stateConfig: {
      sending,
      error,
      queuedOutbound,
      thread,
      messages,
    },
    stateSetters: {
      setThread,
      setError: setUiError,
      setSending,
      setDraft,
      setPendingAttachments,
      setEditingTurnId,
      setCapabilitySuggestions,
      setSpecialistSuggestions,
    },
    operations: {
      loadSidebar,
      loadSessionCoreState,
      ensureSession,
      pushLocalNotice,
      handleCommandExecution,
    },
    refs: {
      executeOutboundItemRef,
      tryBeginOutboundExecutionRef,
      applyFetchedThreadRef,
      messageMutationVersionRef,
    },
    routing: {
      ensureFreshRoutePreflight: (next) => routePreflight.ensureFreshPreflight(next),
      isRoutePreflightAcknowledged: (hash) => Boolean(acknowledgedRoutePreflightHashes[hash]),
    },
  });
  const {
    pendingApproval,
    setPendingApproval,
    pendingUserInput,
    setPendingUserInput,
    approvalPending,
    userInputPending,
    handleApprovePending,
    handleDenyPending,
    handleSubmitUserInput,
    handleSelectBranchTurn,
    streamStatus,
    // Deprecated passthroughs: useChatStreamingPreviewState only updates these
    // on stream start/stop now (not per RAF flush), which is what stops this
    // host from re-rendering per flush. The live, per-flush preview lives in
    // the chat-streaming-preview-store (mission-control-shared); ThreadedTimeline
    // and ChatThreadView subscribe to it directly instead of reading this prop.
    streamingPreview,
    activeStreamingTurnId,
    prefsRef,
  } = outbound;
  runtimeBlockerActiveRef.current = Boolean(pendingApproval || pendingUserInput);

  useChatApprovalController({
    selectedSessionId,
    activeStreamRef,
    setPendingAttachments,
    setEditingTurnId,
    setPendingApproval,
    setPendingUserInput,
    setDelegationSuggestion,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    setSelectedTurnId,
    setLocalNotices,
    pushLocalNotice,
  });

  useEffect(() => {
    setDevDiagnosticsActiveChatSession(selectedSessionId ?? undefined);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setPinnedGoal(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchChatSessionGoal(selectedSessionId);
        if (!cancelled) {
          setPinnedGoal(response.goal ?? undefined);
        }
      } catch {
        // Goal fetch is best-effort. Don't surface errors on session switch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!thread) {
      setDevDiagnosticsLatestTraceSummary(undefined);
      return;
    }
    const selectedTurn = thread.turns.find(
      (turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId),
    );
    setDevDiagnosticsLatestTraceSummary(
      selectedTurn?.trace
        ? {
            sessionId: thread.sessionId,
            turnId: selectedTurn.turnId,
            providerId: selectedTurn.trace.routing.effectiveProviderId ?? selectedTurn.trace.routing.primaryProviderId,
            modelId: selectedTurn.trace.routing.effectiveModel ?? selectedTurn.trace.model,
            state: selectedTurn.trace.status,
          }
        : {
            sessionId: thread.sessionId,
            turnCount: thread.turns.length,
          },
    );
  }, [thread]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const draftRaw = window.localStorage.getItem(createDraftStorageKey(workspaceId, selectedSessionId));
      setDraft(draftRaw ?? "");
      const attachmentsRaw = window.localStorage.getItem(createAttachmentStorageKey(workspaceId, selectedSessionId));
      setPendingAttachments(attachmentsRaw ? (JSON.parse(attachmentsRaw) as ChatAttachmentRecord[]) : []);
      const queueRaw = window.localStorage.getItem(createQueueStorageKey(workspaceId, selectedSessionId));
      setQueuedOutbound(
        queueRaw ? (JSON.parse(queueRaw) as OutboundQueueItem[]).map((item) => ({ ...item, paused: true })) : [],
      );
    } catch {
      setDraft("");
      setPendingAttachments([]);
      setQueuedOutbound([]);
    }
  }, [selectedSessionId, workspaceId, setQueuedOutbound]);

  useEffect(() => {
    setPendingAttachmentModes((current) => reconcilePendingAttachmentModes(current, pendingAttachments));
  }, [pendingAttachments]);

  useEffect(() => {
    if (!activeGeneratedArtifact) {
      return;
    }
    const refreshedArtifact = generatedArtifacts?.items.find(
      (item) => item.artifactId === activeGeneratedArtifact.artifactId,
    );
    if (refreshedArtifact) {
      setActiveGeneratedArtifact(refreshedArtifact);
    }
  }, [activeGeneratedArtifact, generatedArtifacts?.items]);

  const serializedPendingAttachments = useMemo(() => JSON.stringify(pendingAttachments), [pendingAttachments]);
  const serializedQueuedOutbound = useMemo(() => JSON.stringify(queuedOutbound), [queuedOutbound]);

  useDebouncedLocalStoragePersistence(createDraftStorageKey(workspaceId, selectedSessionId), draft);
  useDebouncedLocalStoragePersistence(
    createAttachmentStorageKey(workspaceId, selectedSessionId),
    serializedPendingAttachments,
  );
  useDebouncedLocalStoragePersistence(createQueueStorageKey(workspaceId, selectedSessionId), serializedQueuedOutbound);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STREAM_PREF_KEY, String(streamEnabled));
    } catch {
      // Fallback: localStorage may be disabled or quota-exceeded; preference will not persist this session.
    }
  }, [streamEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VISUAL_STREAM_MODE_PREF_KEY, visualStreamMode);
    } catch {
      // Fallback: localStorage may be disabled or quota-exceeded; preference will not persist this session.
    }
  }, [visualStreamMode]);

  useEffect(() => {
    setRenameTitle(selectedSession?.title ?? "");
    setFolderName(selectedSession?.folderName ?? "");
    setTagsValue((selectedSession?.tags ?? []).join(", "));
  }, [selectedSession?.folderName, selectedSession?.sessionId, selectedSession?.tags, selectedSession?.title]);
  const planningMode = prefs?.planningMode ?? "off";
  const proactiveSuggestionCount = useMemo(
    () => proactiveRuns.filter((run) => run.status === "suggested").length,
    [proactiveRuns],
  );
  const surfaceProjectSummaries = useMemo(
    () => (projects?.items ?? []).map((item) => ({ projectId: item.projectId, name: item.name })),
    [projects?.items],
  );
  const activeSpecialistCandidateCount = useMemo(
    () => specialistCandidates.filter((item) => item.status !== "retired").length,
    [specialistCandidates],
  );

  const {
    messageMode,
    activeModePreset,
    isChatSurface,
    isCoworkSurface,
    isCodeSurface,
    surfaceHeaderTitle,
    surfaceHeaderSubtitle,
    workspaceSummaryCards,
    selectedTurn,
    selectedTurnRecovery,
    effectiveToolAutonomy,
    selectedSessionLabel,
    codeModeNeedsProjectBinding,
    selectedProjectBindingCandidateId,
    selectedProjectBindingCandidateName,
    showTracePanel,
    showSuggestionsPanel,
    showLearnedMemoryPanel,
    dockSectionOrder,
  } = useMissionControlSurfaceState({
    lockSurface,
    surface,
    prefs,
    selectedTurnId,
    thread,
    selectedSession,
    selectedProjectId,
    projects: surfaceProjectSummaries,
    projectsCount: projects?.items.length ?? 0,
    missionSessionCount: missionSessions.length,
    externalSessionCount: externalSessions.length,
    boundMissionSessionCount,
    planningMode,
    chatSubtitle: pageCopy.chat.subtitle ?? "Fast conversation, drafting, and lightweight help.",
    capabilitySuggestionCount: capabilitySuggestions.length,
    specialistSuggestionCount: specialistSuggestions.length,
    specialistCandidateCount: activeSpecialistCandidateCount,
    proactiveSuggestionCount,
    hasDelegationSuggestion: Boolean(delegationSuggestion),
    learnedMemoryCount: learnedMemory.length,
    hasGeneratedArtifact: Boolean(activeGeneratedArtifact),
  });

  useEffect(() => {
    const capabilitySuggestions = selectedTurn?.trace.capabilityUpgradeSuggestions ?? [];
    const specialistSuggestions = selectedTurn?.trace.specialistCandidateSuggestions ?? [];
    const capabilitySyncKey = buildSuggestionSyncKey(selectedTurn?.turnId, capabilitySuggestions);
    const specialistSyncKey = buildSuggestionSyncKey(selectedTurn?.turnId, specialistSuggestions);

    if (lastCapabilitySuggestionSyncKeyRef.current !== capabilitySyncKey) {
      lastCapabilitySuggestionSyncKeyRef.current = capabilitySyncKey;
      setCapabilitySuggestions(capabilitySuggestions);
    }

    if (lastSpecialistSuggestionSyncKeyRef.current !== specialistSyncKey) {
      lastSpecialistSuggestionSyncKeyRef.current = specialistSyncKey;
      setSpecialistSuggestions(specialistSuggestions);
    }
  }, [selectedTurn, setCapabilitySuggestions, setSpecialistSuggestions]);
  const {
    dockOpen,
    setDockOpen,
    activeWorkflowTurn,
    workbenchState,
    workbenchTree,
    selectedWorkbenchFile,
    selectedWorkbenchFileDiff,
    workbenchDraftContent,
    workbenchExpandedPaths,
    workbenchDiff,
    workbenchOutput,
    workbenchLoading,
    workbenchBusy,
    workbenchSaving,
    workbenchError,
    hasDirtyWorkbenchDraft,
    setWorkbenchDraftContent,
    setWorkbenchExpandedPaths,
    refreshWorkbench,
    createWorkbenchWorktree,
    openWorkbenchFile,
    saveWorkbenchFile,
    runWorkbenchFileOperation,
    discardWorkbenchDraft,
    runWorkbenchValidationCommand,
    applyWorkbenchPatch,
    exportWorkbenchPatch,
    revertWorkbenchFile,
    revertWorkbenchAll,
    latestOrchestration,
    orchestrationRun,
    orchestrationCheckpoints,
    orchestrationLoading,
    orchestrationError,
    refreshOrchestrationRun,
    coworkItems,
    selectedSessionProjectValue,
    dockSectionStyle,
  } = useChatDockWorkbenchController({
    messageMode,
    selectedSessionId,
    selectedSession,
    selectedTurn,
    thread,
    messages,
    localNotices,
    dockSectionOrder,
  });
  const handleAgenticControl = useCallback(
    async (control: CoworkAgenticControlItem) => {
      if (!agenticRunTree?.runId || !control.enabled) {
        return;
      }
      setAgenticControlPending(control.action);
      setAgenticControlStatus(null);
      try {
        const response = await controlAgenticRun(
          agenticRunTree.runId,
          {
            action: control.action,
            controlId: `${agenticRunTree.runId}:${control.action}:${Date.now()}`,
            reason: "Mission Control operator action.",
          },
          { workspaceId },
        );
        const refreshedTree = await resolveAgenticRunTree();
        setAgenticRunTree(refreshedTree);
        await refreshOrchestrationRun();
        setAgenticControlStatus(response.message);
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = describeChatUiError(rawMessage, "refresh")?.summary ?? rawMessage;
        setAgenticControlStatus(message);
        pushLocalNotice(message, "warning");
      } finally {
        setAgenticControlPending(null);
      }
    },
    [agenticRunTree?.runId, pushLocalNotice, refreshOrchestrationRun, resolveAgenticRunTree],
  );
  const guardWorkbenchNavigation = useCallback(
    (action: () => void, message: string) => {
      if (!(messageMode === "code" && hasDirtyWorkbenchDraft)) {
        action();
        return;
      }
      setWorkbenchDiscardConfirm({
        title: "Discard unsaved workbench changes?",
        message,
        onConfirm: () => {
          discardWorkbenchDraft();
          action();
        },
      });
    },
    [discardWorkbenchDraft, hasDirtyWorkbenchDraft, messageMode],
  );

  useEffect(() => {
    if (!hasDirtyWorkbenchDraft && workbenchDiscardConfirm) {
      setWorkbenchDiscardConfirm(null);
    }
  }, [hasDirtyWorkbenchDraft, workbenchDiscardConfirm]);

  useEffect(() => {
    if (!compactSurfaceLayout && sessionRailOpen) {
      setSessionRailOpen(false);
    }
  }, [compactSurfaceLayout, sessionRailOpen]);

  useEffect(() => {
    if (compactSurfaceLayout && sessionRailOpen && dockOpen) {
      setDockOpen(false);
    }
  }, [compactSurfaceLayout, dockOpen, sessionRailOpen, setDockOpen]);

  const providerLabelById = useMemo(
    () => new Map(providerOptions.map((provider) => [provider.providerId, provider.label])),
    [providerOptions],
  );
  const activeRouting = activeWorkflowTurn?.trace.routing;
  const requestedProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(providerLabelById, activeRouting.primaryProviderId, activeRouting.primaryModel)
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(requestedProviderLabel, requestedModelLabel);
  const effectiveProviderModelSummary = activeRouting
    ? formatRoutingTargetSummary(
        providerLabelById,
        activeRouting.effectiveProviderId ?? activeRouting.primaryProviderId,
        activeRouting.effectiveModel ?? activeWorkflowTurn?.trace.model ?? activeRouting.primaryModel,
      )
    : currentRoutePreflight
      ? formatRoutingTargetSummary(
          providerLabelById,
          currentRoutePreflight.effectiveProviderId ?? currentRoutePreflight.requestedProviderId,
          currentRoutePreflight.effectiveModel ?? currentRoutePreflight.requestedModel,
        )
      : formatWorkProviderModelSummary(selectedProviderLabel, selectedModelLabel);
  const preflightFallback = formatFallbackSummary(currentRoutePreflight);
  const fallbackSummary = activeRouting?.fallbackUsed
    ? activeRouting.fallbackReason
      ? `Fallback used · ${activeRouting.fallbackReason}`
      : "Fallback used"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? activeRouting?.fallbackReason
        ? `Fallback armed · ${activeRouting.fallbackReason}`
        : "Fallback armed"
      : preflightFallback.summary;
  const fallbackTone = activeRouting?.fallbackUsed
    ? "warning"
    : activeRouting?.fallbackProviderId || activeRouting?.fallbackModel || activeRouting?.fallbackReason
      ? "warning"
      : preflightFallback.tone;
  const preflightRuntime = formatRuntimeSummary(currentRoutePreflight);
  const selectionSourceSummary = currentRoutePreflight
    ? formatSelectionSourceSummary(currentRoutePreflight.selectionSource)
    : selectionSourceLabel;
  const visibleDelegationRun =
    activeDelegationRun?.attachedTurnId &&
    activeWorkflowTurn &&
    activeDelegationRun.attachedTurnId !== activeWorkflowTurn.turnId
      ? null
      : activeDelegationRun;
  const visibleRunStateLabel = formatThreadedRunStateLabel(activeWorkflowTurn, visibleDelegationRun);
  const visibleRunStateSummary = formatThreadedRunStateSummary(activeWorkflowTurn, visibleDelegationRun);
  const backgroundHandoffRunStateSummary = formatAgenticBackgroundHandoffSummary(agenticRunTree, visibleDelegationRun);
  const lifecycleNotices = useMemo<ChatThreadNotice[]>(() => {
    const notices: ChatThreadNotice[] = [];
    const activeTrace = activeWorkflowTurn?.trace;
    const timestamp = activeWorkflowTurn?.assistantMessage?.timestamp ?? new Date().toISOString();
    const backgroundHandoffNotice = formatAgenticBackgroundHandoffNotice(agenticRunTree, visibleDelegationRun);
    if (backgroundHandoffNotice) {
      notices.push({
        id: `lifecycle-agentic-handoff-${agenticRunTree?.runId ?? "active"}`,
        tone: "neutral",
        content: backgroundHandoffNotice,
        timestamp: agenticRunTree?.generatedAt ?? timestamp,
      });
    }
    if (activeTrace?.routing.fallbackUsed) {
      notices.push({
        id: `lifecycle-fallback-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: activeTrace.routing.fallbackReason
          ? `Fallback used for this turn: ${activeTrace.routing.fallbackReason}`
          : "Fallback provider/model routing was used for this turn.",
        timestamp,
      });
    }
    if (activeTrace?.status === "waiting_for_approval") {
      notices.push({
        id: `lifecycle-approval-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: "Run is paused for approval. Respond to the blocker to let durable execution resume.",
        timestamp,
      });
    }
    if (activeTrace?.status === "waiting_for_user_input") {
      notices.push({
        id: `lifecycle-user-input-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "neutral",
        content: "Run is waiting on operator input before it can continue.",
        timestamp,
      });
    }
    if (activeTrace?.completion?.repaired) {
      notices.push({
        id: `lifecycle-repair-${activeWorkflowTurn?.turnId ?? "active"}`,
        tone: "warning",
        content: "Final assistant output was repaired before completion was recorded.",
        timestamp,
      });
    }
    const latestCheckpoint = orchestrationCheckpoints.at(-1);
    if (latestCheckpoint?.checkpointKind === "run_resumed") {
      notices.push({
        id: `lifecycle-resumed-${latestCheckpoint.checkpointId}`,
        tone: "success",
        content: "Durable execution resumed after a pause or approval gate.",
        timestamp: latestCheckpoint.createdAt,
      });
    } else if (latestCheckpoint?.checkpointKind === "run_paused_for_approval") {
      notices.push({
        id: `lifecycle-paused-${latestCheckpoint.checkpointId}`,
        tone: "warning",
        content: "Durable execution paused for approval and is waiting for operator action.",
        timestamp: latestCheckpoint.createdAt,
      });
    }
    for (const diagnostic of agenticRunTree?.diagnostics.slice(0, 2) ?? []) {
      notices.push({
        id: `lifecycle-diagnostic-${diagnostic.signalId}`,
        tone:
          diagnostic.severity === "critical" ? "critical" : diagnostic.severity === "warning" ? "warning" : "neutral",
        content: diagnostic.summary?.trim() || diagnostic.title,
        timestamp: agenticRunTree?.generatedAt ?? timestamp,
      });
    }
    return notices;
  }, [activeWorkflowTurn, agenticRunTree, orchestrationCheckpoints, visibleDelegationRun]);
  const coworkViewModel = useMemo(
    () =>
      deriveCoworkRunViewModel({
        items: coworkItems,
        orchestration: latestOrchestration ?? undefined,
        orchestrationRun,
        orchestrationCheckpoints,
        orchestrationLoading,
        orchestrationError,
        executionPlan: activeWorkflowTurn?.trace.executionPlan,
        delegationRun: visibleDelegationRun,
        activeTurn: activeWorkflowTurn,
        selectedTurn,
        workbenchState,
        agenticRunTree,
      }),
    [
      activeWorkflowTurn,
      agenticRunTree,
      coworkItems,
      latestOrchestration,
      orchestrationCheckpoints,
      orchestrationError,
      orchestrationLoading,
      orchestrationRun,
      selectedTurn,
      visibleDelegationRun,
      workbenchState,
    ],
  );
  const sessionTrust = useMemo<WorkTrustDescriptor>(
    () =>
      workTrust ?? {
        workspaceLabel: workspaceName,
        // Missing trust state is a signal, not a neutral fact — render it as a
        // warning so it does not blend in with the healthy chips around it.
        gatewayTone: gatewayStatus?.tone ?? "warning",
        gatewayLabel: gatewayStatus?.label ?? "Gateway state unavailable",
        gatewayDetail:
          gatewayStatus?.detail ??
          "Mission Control has not received shell gateway status for this threaded surface yet.",
        approvalsSummary: approvalsCount > 0 ? `${approvalsCount} decisions` : "Decisions clear",
        runStateSummary: visibleRunStateSummary ?? backgroundHandoffRunStateSummary,
        activeModeLabel: activeModePreset.label,
        providerModelSummary: effectiveProviderModelSummary,
        requestedProviderModelSummary,
        effectiveProviderModelSummary,
        selectionSourceSummary,
        fallbackSummary,
        fallbackTone,
        runtimeSummary: currentRoutePreflight ? preflightRuntime.summary : runtimeSummary,
        runtimeTone: currentRoutePreflight ? preflightRuntime.tone : runtimeTone,
      },
    [
      activeModePreset.label,
      approvalsCount,
      currentRoutePreflight,
      effectiveProviderModelSummary,
      fallbackSummary,
      fallbackTone,
      gatewayStatus?.detail,
      gatewayStatus?.label,
      gatewayStatus?.tone,
      preflightRuntime.summary,
      preflightRuntime.tone,
      requestedProviderModelSummary,
      runtimeSummary,
      runtimeTone,
      selectionSourceSummary,
      backgroundHandoffRunStateSummary,
      visibleRunStateSummary,
      workTrust,
      workspaceName,
    ],
  );
  const routeBlocked = currentRoutePreflight?.blockedReason ?? undefined;
  const routeBoundaryAckRequired = requiresBoundaryAcknowledgment(currentRoutePreflight);
  const routePreflightPending = Boolean(selectedSessionId) && routePreflight.loading && !currentRoutePreflight;
  const routePreflightUnavailable = Boolean(selectedSessionId) && Boolean(routePreflight.error);
  const canSend =
    Boolean(resolveOutboundDraftContent(draft, pendingAttachments.length, editingTurnId ? "edit" : "send")) &&
    !sending &&
    !pendingApproval &&
    !pendingUserInput &&
    !routeBlocked &&
    !routePreflightPending &&
    !routePreflightUnavailable &&
    (!routeBoundaryAckRequired || currentRouteBoundaryAcknowledged);

  const handleSelectSessionFromRail = useCallback(
    (sessionId: string, options?: { turnId?: string | null }) => {
      if (sessionId === selectedSessionId) {
        setSelectedTurnId(options?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
        return;
      }
      guardWorkbenchNavigation(() => {
        setSelectedSessionId(sessionId);
        setSelectedTurnId(options?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
      }, "Switching sessions will discard the unsaved editor changes in the current Code workbench file.");
    },
    [guardWorkbenchNavigation, selectedSessionId, setSelectedSessionId, setSelectedTurnId],
  );
  const handleSessionRailOpenChange = useCallback(
    (next: boolean) => {
      setSessionRailOpen(next);
      if (next && compactSurfaceLayout) {
        setDockOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen],
  );
  const handleDockOpenChange = useCallback(
    (next: boolean) => {
      setDockOpen(next);
      if (next && compactSurfaceLayout) {
        setSessionRailOpen(false);
        setActiveGeneratedArtifact(null);
      }
    },
    [compactSurfaceLayout, setDockOpen],
  );
  const handleNavigateSurface = useCallback(
    (
      nextSurface: ChatMode,
      options?: { sessionId?: string | null; turnId?: string | null; artifactId?: string | null },
    ) => {
      const nextArtifactId =
        options && Object.prototype.hasOwnProperty.call(options, "artifactId")
          ? (options.artifactId ?? undefined)
          : (activeGeneratedArtifact?.artifactId ?? undefined);
      const nextSessionId = options?.sessionId ?? selectedSessionId;
      const runNavigation = () =>
        onNavigateSurface?.(nextSurface, {
          sessionId: nextSessionId,
          turnId: options?.turnId ?? selectedTurnId,
          artifactId: nextArtifactId,
        });

      if (
        messageMode === "code" &&
        hasDirtyWorkbenchDraft &&
        (nextSurface !== messageMode || nextSessionId !== selectedSessionId)
      ) {
        setWorkbenchDiscardConfirm({
          title: "Discard unsaved workbench changes?",
          message: "Switching surfaces will discard the unsaved editor changes in the current Code workbench file.",
          onConfirm: () => {
            discardWorkbenchDraft();
            runNavigation();
          },
        });
        return;
      }

      runNavigation();
    },
    [
      activeGeneratedArtifact?.artifactId,
      discardWorkbenchDraft,
      hasDirtyWorkbenchDraft,
      messageMode,
      onNavigateSurface,
      selectedSessionId,
      selectedTurnId,
    ],
  );

  const handleCloseGeneratedArtifact = useCallback(() => {
    setActiveGeneratedArtifact(null);
    handleNavigateSurface(messageMode, {
      sessionId: selectedSessionId,
      turnId: selectedTurnId,
      artifactId: null,
    });
  }, [handleNavigateSurface, messageMode, selectedSessionId, selectedTurnId]);

  const revealGeneratedArtifact = useCallback(
    async (artifact: ChatGeneratedArtifactRecord) => {
      await revealGeneratedArtifactInSurface({
        artifact,
        compactSurfaceLayout,
        messageMode,
        loadSessionCoreState,
        setSessionRailOpen,
        setDockOpen,
        setActiveGeneratedArtifact,
        setSelectedTurnId,
        setGeneratedArtifacts,
        handleNavigateSurface,
      });
    },
    [
      compactSurfaceLayout,
      handleNavigateSurface,
      loadSessionCoreState,
      messageMode,
      setDockOpen,
      setGeneratedArtifacts,
    ],
  );
  useRouteGeneratedArtifactReveal({
    routeArtifactId,
    workspaceId,
    revealGeneratedArtifact,
    setActiveGeneratedArtifact,
  });

  const handleOpenGeneratedArtifactFromTurn = useCallback(
    async (turnId: string) => {
      try {
        await runWithSelectedSessionId(selectedSessionId, async () => {
          const targetTurn = thread?.turns.find((turn) => turn.turnId === turnId) ?? null;
          const existingArtifactId = targetTurn?.generatedArtifacts?.[0]?.artifactId;
          if (!existingArtifactId) {
            pushLocalNotice("Create an artifact from this turn before opening it.", "warning");
            return;
          }
          const artifact = (await fetchChatGeneratedArtifact(existingArtifactId, workspaceId)).item;
          await revealGeneratedArtifact(artifact);
        });
      } catch (err) {
        setUiError((err as Error).message);
      }
    },
    [pushLocalNotice, revealGeneratedArtifact, selectedSessionId, setUiError, thread?.turns, workspaceId],
  );

  const handleCreateGeneratedArtifactFromTurn = useCallback(
    async (turnId: string, options?: { supersedeLatest?: boolean }) => {
      try {
        await runWithSelectedSessionId(selectedSessionId, async (sessionId) => {
          const artifact = (
            await createChatGeneratedArtifact(sessionId, turnId, {
              supersedeLatest: options?.supersedeLatest ?? false,
            })
          ).item;
          await revealGeneratedArtifact(artifact);
          pushLocalNotice(
            options?.supersedeLatest ? "Saved a new generated artifact version." : "Created a generated artifact.",
            "success",
          );
        });
      } catch (err) {
        setUiError((err as Error).message);
      }
    },
    [pushLocalNotice, revealGeneratedArtifact, selectedSessionId, setUiError],
  );

  const handleRemoveThreadKnowledge = useCallback(
    async (attachmentId: string) => {
      await runWithSelectedSessionId(selectedSessionId, async (sessionId) => {
        await removeThreadKnowledgeAttachment(sessionId, attachmentId);
        await loadSessionCoreState(sessionId, {
          background: true,
          includeThread: false,
        });
        setThreadKnowledgeAttachments((current) =>
          current
            ? {
                items: current.items.filter((item) => item.attachmentId !== attachmentId),
              }
            : current,
        );
        pushLocalNotice("Removed thread knowledge attachment.", "success");
      });
    },
    [loadSessionCoreState, pushLocalNotice, selectedSessionId, setThreadKnowledgeAttachments],
  );

  const handleExportSessionSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !selectedSession) {
      return;
    }
    const snapshot = {
      exportedAt: new Date().toISOString(),
      session: selectedSession,
      mode: messageMode,
      prefs,
      binding,
      thread,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(selectedSession.title?.trim() || selectedSession.sessionId).replace(/[^a-z0-9_-]+/gi, "-")}-snapshot.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    pushLocalNotice("Session snapshot exported locally.", "success");
  }, [binding, messageMode, prefs, pushLocalNotice, selectedSession, thread]);

  const handleExportRunBundle = useCallback(async () => {
    if (typeof window === "undefined" || !selectedSession) {
      return;
    }
    try {
      const bundle = await fetchRuntimeLifecycleExport({
        sessionId: selectedSession.sessionId,
        turnId: selectedTurn?.turnId,
        runId: selectedTurn?.trace.durable?.runId,
        approvalId: selectedTurn?.trace.toolRuns.find((toolRun) => toolRun.approvalId)?.approvalId,
        includeTranscript: true,
        includeTimeline: true,
        timelineLimit: 200,
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(selectedSession.title?.trim() || selectedSession.sessionId).replace(/[^a-z0-9_-]+/gi, "-")}-${selectedTurn?.turnId ?? "runtime"}-bundle.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      pushLocalNotice("Runtime lifecycle bundle exported locally.", "success");
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to export runtime lifecycle bundle.");
    }
  }, [pushLocalNotice, selectedSession, selectedTurn, setUiError]);

  const handleRunCodeHelper = useCallback(
    async (language: string, source: string) => {
      await runWithSelectedSessionId(selectedSessionId, async (sessionId) => {
        const normalizedLanguage = language.toLowerCase();
        if (
          normalizedLanguage !== "ts" &&
          normalizedLanguage !== "tsx" &&
          normalizedLanguage !== "typescript" &&
          normalizedLanguage !== "js" &&
          normalizedLanguage !== "jsx" &&
          normalizedLanguage !== "javascript"
        ) {
          pushLocalNotice("Code helper currently supports JavaScript and TypeScript snippets.", "warning");
          return;
        }
        try {
          await createCodeModeRun({
            language: normalizedLanguage.startsWith("ts") ? "typescript" : "javascript",
            source,
            originSurface: "chat",
            sessionId,
            turnId: selectedTurn?.turnId,
            requestedOutputIntent: "workbench_helper",
          });
          pushLocalNotice("Queued a code helper run for this snippet.", "success");
          await refreshWorkbench();
        } catch (cause) {
          setUiError(cause instanceof Error ? cause.message : "Unable to start code helper run.");
        }
      });
    },
    [pushLocalNotice, refreshWorkbench, selectedSessionId, selectedTurn?.turnId],
  );

  const applyPrefPatchToSession = useCallback(
    async (
      sessionId: string,
      patch: ChatSessionPrefsPatch,
      options?: {
        syncLocalState?: boolean;
      },
    ) => {
      lastLocalPrefMutationAtRef.current = Date.now();
      const previousPrefs = prefsRef.current;
      const shouldSyncLocalState =
        options?.syncLocalState ?? (!selectedSession || selectedSession.sessionId === sessionId);
      const optimisticPrefs =
        shouldSyncLocalState && previousPrefs ? resolveOptimisticChatPrefs(previousPrefs, patch) : null;
      const mutationId = prefMutationSequenceRef.current + 1;
      prefMutationSequenceRef.current = mutationId;
      if (optimisticPrefs) {
        prefsRef.current = optimisticPrefs;
        setPrefs(optimisticPrefs);
      }
      try {
        const updated = await updateChatSessionPrefs(sessionId, patch);
        if (prefMutationSequenceRef.current !== mutationId) {
          return updated;
        }
        if (shouldSyncLocalState) {
          prefsRef.current = updated;
          setPrefs(updated);
        }
        return updated;
      } catch (err) {
        if (prefMutationSequenceRef.current === mutationId && previousPrefs) {
          prefsRef.current = previousPrefs;
          setPrefs(previousPrefs);
        }
        setUiError((err as Error).message);
        throw err;
      }
    },
    [prefsRef, selectedSession, setPrefs],
  );
  const handlePrefPatch = useCallback(
    async (patch: ChatSessionPrefsPatch) => {
      if (!selectedSession) return;
      try {
        await applyPrefPatchToSession(selectedSession.sessionId, patch);
      } catch {
        // Errors are already surfaced in local state for dock/composer callers.
      }
    },
    [applyPrefPatchToSession, selectedSession],
  );
  const handleToggleContextTurn = useCallback((turnId: string) => {
    setSelectedContextTurnIds((current) =>
      current.includes(turnId) ? current.filter((item) => item !== turnId) : [...current, turnId],
    );
    setPendingThreadContext(null);
  }, []);
  const handleClearContextSelection = useCallback(() => {
    setSelectedContextTurnIds([]);
    setPendingThreadContext((current) => (current?.sessionId === selectedSessionId ? null : current));
  }, [selectedSessionId]);
  const handleStartNewThreadFromTurn = useCallback(
    async (turnId: string) => {
      if (!thread) {
        setUiError("No active conversation is available to start a new thread from.");
        return;
      }
      const contextTurnIds = selectedContextTurnIds.length > 0 ? selectedContextTurnIds : [turnId];
      const sourceLabel = getThreadSourceLabel({ selectedSession, selectedSessionId, visibleSessionLabelById });
      const context = buildSelectedConversationContext({
        thread,
        turnIds: contextTurnIds,
        sourceLabel,
        sourceSessionId: selectedSessionId ?? undefined,
      });
      if (!context) {
        setUiError("Select at least one turn before starting a new thread with context.");
        return;
      }
      setUiError(null);
      try {
        const projectId =
          selectedSession?.projectId ??
          (selectedProjectId !== "all" && selectedProjectId !== "none" ? selectedProjectId : undefined);
        const nextHistoryView = historyView === "archived" ? "active" : historyView;
        const created = await createChatSession(
          {
            workspaceId,
            mode: messageMode,
            projectId,
            title: `Trail from ${trimForkTitle(sourceLabel)}`,
          },
          { originSurface: messageMode },
        );
        const prefsPatch = buildPrefsPatchFromRecord(prefs);
        if (prefsPatch) {
          await applyPrefPatchToSession(created.sessionId, prefsPatch, { syncLocalState: false });
        }
        if (nextHistoryView !== historyView) {
          setHistoryView(nextHistoryView);
        }
        setSelectedSessionId(created.sessionId);
        setSelectedTurnId(null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext({ ...context, sessionId: created.sessionId });
        setThread({
          sessionId: created.sessionId,
          turns: [],
        });
        setDraft("");
        await loadSidebar(nextHistoryView, { bypassCache: true, preferredSessionId: created.sessionId });
        pushLocalNotice(`Started a new thread with ${context.label} attached as context.`, "success");
        composerRef.current?.focus();
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Unable to start a new thread from this context.");
      }
    },
    [
      applyPrefPatchToSession,
      composerRef,
      historyView,
      loadSidebar,
      messageMode,
      prefs,
      pushLocalNotice,
      selectedContextTurnIds,
      selectedProjectId,
      selectedSession,
      selectedSessionId,
      setHistoryView,
      setSelectedSessionId,
      setThread,
      thread,
      visibleSessionLabelById,
      workspaceId,
    ],
  );
  const handleTogglePlanningMode = useCallback(() => {
    void handlePrefPatch({ planningMode: planningMode === "advisory" ? "off" : "advisory" });
  }, [handlePrefPatch, planningMode]);
  const handleToggleResearchMode = useCallback(() => {
    const currentWebMode = prefs?.webMode ?? "auto";

    void handlePrefPatch({
      webMode: currentWebMode === "quick" || currentWebMode === "deep" ? "auto" : "quick",
    });
  }, [handlePrefPatch, prefs?.webMode]);
  const handleToggleReviewMode = useCallback(() => {
    const currentReviewDepth = prefs?.orchestrationReviewDepth ?? "off";

    void handlePrefPatch({
      orchestrationReviewDepth: currentReviewDepth === "off" ? "standard" : "off",
    });
  }, [handlePrefPatch, prefs?.orchestrationReviewDepth]);
  const applyThreadModelPatch = useCallback(
    async (patch: ChatSessionPrefsPatch) => {
      await runWithSelectedSession(selectedSession, async (session) => {
        try {
          await applyPrefPatchToSession(session.sessionId, patch);
          setUiError(null);
        } catch {
          // Errors already surface through page state.
        }
      });
    },
    [applyPrefPatchToSession, selectedSession],
  );
  const requestThreadModelPatch = useCallback(
    (patch: ChatSessionPrefsPatch) => {
      runWithSelectedSession(selectedSession, () => {
        const nextProviderId = patch.providerId ?? selectedProviderId ?? "";
        const nextModel = patch.model ?? selectedModel ?? "";
        const providerChanged = patch.providerId !== undefined && patch.providerId !== (selectedProviderId ?? "");
        const modelChanged = patch.model !== undefined && patch.model !== (selectedModel ?? "");
        if (!providerChanged && !modelChanged) {
          return;
        }
        const nextProviderLabel =
          providerOptions.find((item) => item.providerId === nextProviderId)?.label ?? selectedProviderLabel;
        const nextRoutingSummary = formatWorkProviderModelSummary(nextProviderLabel, nextModel || undefined);
        const turnCount = thread?.turns.length ?? 0;
        if (turnCount === 0) {
          void applyThreadModelPatch(patch);
          return;
        }
        setThreadModelSwitchConfirm({
          title: "Switch thread model?",
          message: `This conversation already has ${turnCount} turn${turnCount === 1 ? "" : "s"}. Switching to ${nextRoutingSummary} can reduce continuity because the new model will not share the same hidden reasoning state. Important context stays in the thread, but you may want to restate key instructions after the switch.`,
          patch,
        });
      });
    },
    [
      applyThreadModelPatch,
      providerOptions,
      selectedModel,
      selectedProviderId,
      selectedProviderLabel,
      selectedSession,
      thread?.turns.length,
    ],
  );
  const handleSetPendingAttachmentMode = useCallback((attachmentId: string, mode: PendingAttachmentDocumentMode) => {
    setPendingAttachmentModes((current) => ({
      ...current,
      [attachmentId]: mode,
    }));
  }, []);
  const attachPendingKnowledgeSources = useCallback(async () => {
    const normalizedKnowledgeUrl = knowledgeUrlDraft.trim();
    const requiresThreadKnowledge =
      pendingAttachments.some((attachment) => {
        const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
        return isDocumentAttachment(attachment) && mode !== "message";
      }) || normalizedKnowledgeUrl.length > 0;
    if (!requiresThreadKnowledge) {
      return;
    }
    const session = await ensureSession();
    const existingKeys = new Set(
      (threadKnowledgeAttachments?.items ?? []).map((item) =>
        item.chatAttachmentId
          ? `${item.chatAttachmentId}:${item.retrievalMode}`
          : `url:${item.sourceRef.trim().toLowerCase()}:${item.retrievalMode}`,
      ),
    );
    const nextItems: ThreadKnowledgeAttachmentRecord[] = [...(threadKnowledgeAttachments?.items ?? [])];

    for (const attachment of pendingAttachments) {
      if (!isDocumentAttachment(attachment)) {
        continue;
      }
      const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
      if (mode === "message") {
        continue;
      }
      if (mode === "full_text" && !canReadAttachmentInFull(attachment)) {
        throw new Error(`${attachment.fileName} is not ready for full-text context yet. Use retrieval instead.`);
      }
      const key = `${attachment.attachmentId}:${mode}`;
      if (existingKeys.has(key)) {
        continue;
      }
      const response = await attachThreadKnowledgeAttachment(session.sessionId, {
        chatAttachmentId: attachment.attachmentId,
        title: attachment.fileName,
        retrievalMode: mode,
      });
      existingKeys.add(key);
      nextItems.unshift(response.item);
    }

    if (normalizedKnowledgeUrl) {
      const urlKey = `url:${normalizedKnowledgeUrl.toLowerCase()}:${knowledgeUrlMode}`;
      if (!existingKeys.has(urlKey)) {
        const response = await attachThreadKnowledgeAttachment(session.sessionId, {
          url: normalizedKnowledgeUrl,
          title: normalizedKnowledgeUrl,
          retrievalMode: knowledgeUrlMode,
        });
        nextItems.unshift(response.item);
      }
      setKnowledgeUrlDraft("");
    }

    setThreadKnowledgeAttachments({ items: nextItems });
  }, [
    ensureSession,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    pendingAttachmentModes,
    pendingAttachments,
    setThreadKnowledgeAttachments,
    threadKnowledgeAttachments?.items,
  ]);
  const handleAttachKnowledgeUrl = useCallback(async () => {
    const normalizedKnowledgeUrl = knowledgeUrlDraft.trim();
    if (!normalizedKnowledgeUrl) {
      return;
    }
    try {
      const session = await ensureSession();
      const response = await attachThreadKnowledgeAttachment(session.sessionId, {
        url: normalizedKnowledgeUrl,
        title: normalizedKnowledgeUrl,
        retrievalMode: knowledgeUrlMode,
      });
      setThreadKnowledgeAttachments((current) => ({
        items: [response.item, ...(current?.items ?? [])],
      }));
      setKnowledgeUrlDraft("");
      pushLocalNotice("Attached a thread knowledge source.", "success");
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Unable to attach thread knowledge source.");
    }
  }, [ensureSession, knowledgeUrlDraft, knowledgeUrlMode, pushLocalNotice, setUiError, setThreadKnowledgeAttachments]);
  const handleApplyPreset = useCallback(async () => {
    try {
      const preset = presetProfiles.find((item) => item.agentId === selectedPresetId);
      if (!preset) {
        return;
      }
      const session = await ensureSession();
      const patch: ChatSessionPrefsPatch = {
        providerId: preset.preferredProviderId,
        model: preset.preferredModel,
        toolAutonomy: preset.toolsPosture,
      };
      const hasPatch = Object.values(patch).some((value) => value !== undefined);
      if (hasPatch) {
        await applyPrefPatchToSession(session.sessionId, patch, {
          syncLocalState: true,
        });
      }
      if (preset.promptFraming) {
        setDraft((current) =>
          current.trim() ? `${preset.promptFraming}\n\n${current.trim()}` : (preset.promptFraming ?? ""),
        );
      }
      const missingKnowledgeAttachmentIds = (preset.knowledgeAttachmentIds ?? []).filter(
        (attachmentId) => !(threadKnowledgeAttachments?.items ?? []).some((item) => item.attachmentId === attachmentId),
      );
      if (missingKnowledgeAttachmentIds.length > 0) {
        const warning =
          missingKnowledgeAttachmentIds.length === 1
            ? `Skipped 1 unavailable knowledge default.`
            : `Skipped ${missingKnowledgeAttachmentIds.length} unavailable knowledge defaults.`;
        setPresetApplyWarning(warning);
        pushLocalNotice(warning, "warning");
      } else {
        setPresetApplyWarning(null);
      }
      if (preset.routeHint && preset.routeHint !== messageMode) {
        handleNavigateSurface(preset.routeHint);
      }
      pushLocalNotice(`Applied ${preset.label}.`, "success");
    } catch (err) {
      setUiError((err as Error).message);
    }
  }, [
    applyPrefPatchToSession,
    ensureSession,
    handleNavigateSurface,
    messageMode,
    presetProfiles,
    pushLocalNotice,
    setUiError,
    setPresetApplyWarning,
    selectedPresetId,
    threadKnowledgeAttachments?.items,
  ]);

  const handleRevealSelectedTurnDetails = useCallback(() => {
    if (!selectedTurn) {
      return;
    }
    if (dockOpen && selectedTurnId === selectedTurn.turnId) {
      handleDockOpenChange(false);
      return;
    }
    setSelectedTurnId(selectedTurn.turnId);
    handleDockOpenChange(true);
  }, [dockOpen, handleDockOpenChange, selectedTurn, selectedTurnId]);
  const handleRevealActiveTurnDetails = useCallback(() => {
    const nextTurn = activeWorkflowTurn ?? selectedTurn;
    if (!nextTurn) {
      return;
    }
    if (dockOpen && selectedTurnId === nextTurn.turnId) {
      handleDockOpenChange(false);
      return;
    }
    setSelectedTurnId(nextTurn.turnId);
    handleDockOpenChange(true);
  }, [activeWorkflowTurn, dockOpen, handleDockOpenChange, selectedTurn, selectedTurnId]);

  const handleSelectBranchTurnAndSync = useCallback(
    async (turnId: string) => {
      const nextThread = await handleSelectBranchTurn(turnId);
      if (nextThread) {
        setSelectedTurnId(nextThread.activeLeafTurnId ?? turnId);
      }
    },
    [handleSelectBranchTurn],
  );
  const lastEditableDraft = useMemo(
    () =>
      [...(thread?.turns ?? [])].reverse().find((turn) => Boolean(turn.userMessage?.content?.trim()))?.userMessage
        ?.content ?? null,
    [thread?.turns],
  );
  const {
    uploadAttachments,
    handleComposerKeyDown,
    handleComposerPaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDismissError,
    handleCancelEdit,
    handleCreateCurrentModeSession,
    handleArchiveWorkspace,
    handleConfirmCapabilitySuggestion,
    handleConfirmDeleteSession,
    handleConfirmArchiveWorkspace,
    handleSetDeepMode,
    handleApplyDraftCommand,
    handleRemoveAttachment,
    handleUploadFiles,
  } = useChatComposerInteractions({
    draft,
    lastEditableDraft,
    commandSuggestions,
    commandIndex,
    error,
    dockOpen,
    sending,
    selectedSession,
    messageMode,
    ensureSession,
    handleSend: handleComposerSend,
    handleCreateSession,
    handleArchiveWorkspaceMissionChats,
    handleRunQuickResearch,
    handlePrefPatch,
    handleTogglePlanningMode,
    handleRevealSelectedTurnDetails,
    confirmCapabilitySuggestionAction,
    confirmDeleteSession,
    setSending,
    setError: setUiError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId,
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
  });
  const handleToggleDock = useCallback(() => {
    handleDockOpenChange(!dockOpen);
  }, [dockOpen, handleDockOpenChange]);
  const latestAssistantTurn = useMemo(
    () => [...(thread?.turns ?? [])].reverse().find((turn) => Boolean(turn.assistantMessage?.content?.trim())) ?? null,
    [thread?.turns],
  );
  const {
    audioInputRef,
    voiceBusy,
    liveVoiceActive,
    liveVoiceAvailable,
    liveVoiceMuted,
    liveVoiceState,
    liveVoiceStatusLabel,
    liveVoiceUnavailableReason,
    voiceInputAvailable,
    voiceOutputAvailable,
    voiceTalkActive,
    voiceStatusLabel,
    voiceUnavailableReason,
    speakResponsesEnabled,
    setSpeakResponsesEnabled,
    imageBusy,
    imageGenerationAvailable,
    imageEditAvailable,
    imageProviderOptions,
    selectedImageProviderId,
    selectedImageModel,
    imageRouteLabel,
    handleToggleLiveVoice,
    handleToggleLiveVoiceMute,
    handleToggleVoiceTalk,
    handleOpenAudioTranscribe,
    handleAudioFileSelected,
    handleGenerateImage,
    handleEditImage,
  } = useChatMultimodalControls({
    providerOptions,
    selectedProviderId,
    preferredImageProviderId: prefs?.imageProviderId,
    preferredImageModel: prefs?.imageModel,
    routePreflight: currentRoutePreflight,
    selectedSessionId,
    activeThreadSessionId: thread?.sessionId,
    pendingAttachments,
    draft,
    latestAssistantMessageId: latestAssistantTurn?.assistantMessage?.messageId,
    latestAssistantContent: latestAssistantTurn?.assistantMessage?.content,
    latestAssistantStatus: latestAssistantTurn?.trace.status,
    setDraft,
    setError: setUiError,
    pushLocalNotice,
    uploadAttachments,
  });

  const handleSetGoal = useCallback(
    async (goal: string, turnBudget?: number) => {
      if (!selectedSessionId) {
        return;
      }
      try {
        const response = await setChatSessionGoal(selectedSessionId, { goal, turnBudget });
        setPinnedGoal(response.goal ?? undefined);
        pushLocalNotice(`Goal set: ${response.goal ?? goal}`, "success");
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Failed to set goal.");
      }
    },
    [pushLocalNotice, selectedSessionId, setUiError],
  );

  const handleClearGoal = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    try {
      await clearChatSessionGoal(selectedSessionId);
      setPinnedGoal(undefined);
      pushLocalNotice("Goal cleared.", "success");
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Failed to clear goal.");
    }
  }, [pushLocalNotice, selectedSessionId, setUiError]);

  const handleGoalStatus = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    try {
      const response = await fetchChatSessionGoal(selectedSessionId);
      setPinnedGoal(response.goal ?? undefined);
      if (response.goal) {
        const budgetSuffix =
          response.turnBudget !== null && response.turnBudget !== undefined
            ? ` (${response.turnsUsed}/${response.turnBudget} turns)`
            : "";
        pushLocalNotice(`Goal: ${response.goal}${budgetSuffix}`, "neutral");
      } else {
        pushLocalNotice("No pinned goal.", "neutral");
      }
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Failed to fetch goal status.");
    }
  }, [pushLocalNotice, selectedSessionId, setUiError]);

  const handleSteerMidTurn = useCallback(
    async (instruction: string) => {
      if (!selectedSessionId) {
        return;
      }
      try {
        const response = await steerChatSession(selectedSessionId, { instruction });
        if (!response.accepted) {
          pushLocalNotice(response.reason ?? "Steering instruction not accepted.", "warning");
        } else {
          pushLocalNotice("Steering instruction queued.", "success");
        }
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Failed to send steering instruction.");
      }
    },
    [pushLocalNotice, selectedSessionId, setUiError],
  );

  const handleSendWithKnowledge = useCallback(async () => {
    const queueCommand = parseQueueCommand(draft);
    const btwCommand = parseBtwCommand(draft);
    if (btwCommand) {
      await openBtwSideChat(btwCommand.text);
      setDraft("");
      return;
    }
    const disposition = resolveMidTurnDisposition({
      hasActiveStream: Boolean(activeStreamRef.current),
      draft,
    });
    const trimmedDraft = draft.trimStart();
    const explicitSteerCommand = /^\/(?:steer|queue\s+steer)\b/i.test(trimmedDraft);
    const localSlashCommand = trimmedDraft.startsWith("/");
    if (disposition === "steer" && (!localSlashCommand || explicitSteerCommand)) {
      const stripped =
        queueCommand?.kind === "steer" ? queueCommand.text : draft.trimStart().replace(/^\/steer\s*/i, "");
      if (stripped) {
        setFollowThreadOutput(true);
        await handleSteerMidTurn(stripped);
        setDraft("");
        return;
      }
    }
    if (queueCommand?.kind === "followup" || queueCommand?.kind === "collect") {
      if (!queueCommand.text) {
        pushLocalNotice(`Usage: /queue ${queueCommand.kind} <message>`, "warning");
        return;
      }
      setQueuedOutbound((current) => [
        ...current,
        {
          id: `queue-${Date.now()}`,
          action: "send",
          sessionId: selectedSessionId ?? undefined,
          content: queueCommand.text,
          attachments: pendingAttachments,
          createdAt: new Date().toISOString(),
          paused: queueCommand.kind === "collect",
        },
      ]);
      setDraft("");
      setPendingAttachments([]);
      pushLocalNotice(
        queueCommand.kind === "collect" ? "Message collected in the queue." : "Follow-up queued for the next turn.",
        "success",
      );
      return;
    }

    const shouldAutoGenerateImage =
      messageMode === "chat" && !editingTurnId && pendingAttachments.length === 0 && detectImageGenerationIntent(draft);
    if (shouldAutoGenerateImage) {
      if (imageBusy) {
        setUiError("Image generation is already running.");
        return;
      }
      if (!imageGenerationAvailable) {
        setUiError("This looks like an image request, but no image generation route is available.");
        return;
      }
      const generated = await handleGenerateImage({
        clearDraftOnSuccess: true,
        trigger: "auto_send",
      });
      if (generated) {
        return;
      }
      return;
    }

    try {
      // Sending a message is an explicit "show me the answer" intent: re-arm
      // auto-follow so the new turn and its streamed response stay in view
      // even if the operator had scrolled up earlier in the session.
      setFollowThreadOutput(true);
      await attachPendingKnowledgeSources();
      await handleSend();
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Unable to prepare thread knowledge.");
    }
  }, [
    attachPendingKnowledgeSources,
    draft,
    editingTurnId,
    handleGenerateImage,
    handleSend,
    handleSteerMidTurn,
    imageBusy,
    imageGenerationAvailable,
    messageMode,
    openBtwSideChat,
    pendingAttachments.length,
    pendingAttachments,
    pushLocalNotice,
    selectedSessionId,
    setDraft,
    setFollowThreadOutput,
    setPendingAttachments,
    setQueuedOutbound,
    setUiError,
  ]);

  useEffect(() => {
    composerSendHandlerRef.current = handleSendWithKnowledge;
  }, [handleSendWithKnowledge]);

  const threadNotices = useMemo(() => [...lifecycleNotices, ...localNotices], [lifecycleNotices, localNotices]);
  const queueItems = useMemo(
    () =>
      queuedOutbound.map((item) => ({
        id: item.id,
        action: item.action,
        label: item.content.trim()
          ? item.content.trim().slice(0, 96)
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
      (projects?.items ?? [])
        .filter((item) => item.lifecycleStatus === "active")
        .map((project) => ({
          projectId: project.projectId,
          name: project.name,
          workspacePath: project.workspacePath,
        })),
    [projects?.items],
  );
  const projectOptions = useMemo(
    () => [
      { value: "none", label: "Unassigned" },
      ...(projects?.items ?? [])
        .filter((item) => item.lifecycleStatus === "active")
        .map((project) => ({ value: project.projectId, label: project.name })),
    ],
    [projects?.items],
  );

  const workspaceSummaryText = selectedSession
    ? `${lockSurface ? "Current session" : isCodeSurface ? "Current code session" : `Active ${activeModePreset.label.toLowerCase()} session`}: ${selectedSession.title || visibleSessionLabelById.get(selectedSession.sessionId) || `Chat ${selectedSession.sessionId.slice(-6)}`}.`
    : lockSurface
      ? `Start a new ${activeModePreset.label.toLowerCase()} run or reopen a recent session from the left rail.`
      : isCodeSurface
        ? "Pick a code session or start a new one. Bind a project only when you want execution-heavy work."
        : `Use the queue to reopen a session or start a new ${activeModePreset.label.toLowerCase()} run from the left rail.`;
  const sessionRailData: MissionThreadedSessionRailData = useMemo(
    () => ({
      mode: messageMode,
      showProjectCreate,
      creatingSession: Boolean(creatingSessionMode),
      search,
      projectName,
      projectPath,
      historyView,
      selectedProjectId,
      availableFolders,
      selectedFolderId,
      selectedTag,
      missionSessions,
      externalSessions,
      selectedSessionId,
      summaryTitle: selectedProject?.name ?? workspaceName,
      summaryCopy: workspaceSummaryText,
      workspaceSummaryCards,
      archiveWorkspaceEnabled: isChatSurface && historyView === "active" && workspaceMissionSessionCount > 0,
      archiveWorkspaceCount: workspaceMissionSessionCount,
      archiveWorkspacePending,
      hasMoreSessions: !deferredSearch && Boolean(sidebarNextCursor),
      loadingMoreSessions: sidebarLoadingMore,
      onToggleProjectCreate: () => setShowProjectCreate((current) => !current),
      onCreateSession: handleCreateCurrentModeSession,
      onSearchChange: setSearch,
      onProjectNameChange: setProjectName,
      onProjectPathChange: setProjectPath,
      onCreateProject: () => void handleCreateProject(),
      onHistoryViewChange: setHistoryView,
      onArchiveWorkspace: handleArchiveWorkspace,
      onConfirmArchiveWorkspace: handleConfirmArchiveWorkspace,
      onSelectProjectId: setSelectedProjectId,
      onSelectFolderId: setSelectedFolderId,
      onSelectTag: setSelectedTag,
      onSelectSession: handleSelectSessionFromRail,
      renderSessionLabel: (sessionId) => visibleSessionLabelById.get(sessionId) ?? `Chat ${sessionId.slice(-6)}`,
      onLoadMoreSessions: () => void loadSidebar(historyView, { append: true }),
    }),
    [
      archiveWorkspacePending,
      availableFolders,
      deferredSearch,
      externalSessions,
      handleArchiveWorkspace,
      handleConfirmArchiveWorkspace,
      handleCreateCurrentModeSession,
      handleCreateProject,
      handleSelectSessionFromRail,
      historyView,
      isChatSurface,
      loadSidebar,
      messageMode,
      missionSessions,
      projectName,
      projectPath,
      search,
      selectedFolderId,
      selectedProject?.name,
      selectedProjectId,
      selectedSessionId,
      selectedTag,
      setHistoryView,
      setProjectName,
      setProjectPath,
      setSearch,
      setSelectedFolderId,
      setSelectedProjectId,
      setSelectedTag,
      showProjectCreate,
      sidebarLoadingMore,
      sidebarNextCursor,
      visibleSessionLabelById,
      workspaceMissionSessionCount,
      workspaceName,
      workspaceSummaryCards,
      workspaceSummaryText,
    ],
  );

  const autoRouteActive = false;
  const surfacePreview = useSurfaceClassifyPreview({
    draft,
    enabled: autoRouteActive,
    workspaceId,
    hasBoundProject: !codeModeNeedsProjectBinding,
  });

  const activeSessionSurfaceProps: MissionControlActiveSessionSurfaceProps | null = selectedSession
    ? {
        mode: messageMode,
        sessionTitle: selectedSessionLabel,
        summary: workspaceSummaryText,
        trust: sessionTrust,
        providerOptions,
        selectedProviderId,
        selectedModel,
        modelSwitchDisabled: !selectedSessionId || sending,
        sessionLifecycleStatus: selectedSession.lifecycleStatus,
        sessionArchivePending: sessionControlPending === "archive",
        dockOpen,
        onToggleDock: handleToggleDock,
        onToggleArchiveSession: () => void handleToggleArchiveSession(),
        onNavigateSurface: handleNavigateSurface,
        onModeOverride: (_mode: ChatMode) => {
          // A user-initiated override change: mark it so a later session switch
          // honors this explicit choice instead of snapping back to a URL seed.
          userAdjustedModeOverrideRef.current = true;
          setModeOverride("chat");
          onResolvedModeChange?.("chat", "manual-override");
        },
        modeOverridePending: modeOverride,
        onRequestProviderChange: (providerId) => {
          const provider = providerOptions.find((item) => item.providerId === providerId);
          const selection = resolveProviderModelSelection({
            provider,
            loadedModels: providerId ? getCachedModels(providerId) : [],
            selectedModel: undefined,
          });
          void loadModelsForProvider(providerId);
          requestThreadModelPatch({ providerId, model: selection.model ?? "" });
        },
        onRequestModelChange: (model) => requestThreadModelPatch({ model }),
        loading: messagesLoading,
        thread,
        selectedTurnId,
        selectedContextTurnIds,
        outboundContext: activeOutboundContext,
        contextSelection,
        delegationRun: visibleDelegationRun,
        delegationSuggestion,
        notices: threadNotices,
        followOutput: followThreadOutput,
        streamStatus: streamStatus as ChatStreamStatus,
        visualStreamMode,
        streamingPreview,
        activeStreamingTurnId,
        queuedCount: queuedOutbound.length,
        streamError: error,
        streamErrorSource: errorSource,
        pendingApproval,
        pendingUserInput,
        workspaceId: selectedSession.workspaceId ?? workspaceId,
        approvalPending,
        approvalsCount,
        userInputPending,
        eventStreamStatus,
        onBottomStateChange: setFollowThreadOutput,
        onSelectTurn: (turnId) => {
          setSelectedTurnId(turnId);
        },
        onToggleContextTurn: handleToggleContextTurn,
        onClearContextSelection: handleClearContextSelection,
        onStartNewThreadFromTurn: (turnId) => void handleStartNewThreadFromTurn(turnId),
        onSwitchBranch: (turnId) => void handleSelectBranchTurnAndSync(turnId),
        onRetryTurn: (turnId) => void handleRetryTurn(turnId),
        onEditTurn: handleBeginEditTurn,
        onOpenRunDetails: (turnId) => {
          if (dockOpen && selectedTurnId === turnId) {
            handleDockOpenChange(false);
            return;
          }
          setSelectedTurnId(turnId);
          handleDockOpenChange(true);
        },
        onExportRunBundle: () => void handleExportRunBundle(),
        onOpenGeneratedArtifact: (turnId) => void handleOpenGeneratedArtifactFromTurn(turnId),
        onCreateGeneratedArtifact: (turnId) => void handleCreateGeneratedArtifactFromTurn(turnId),
        onCreateGeneratedArtifactVersion: (turnId) =>
          void handleCreateGeneratedArtifactFromTurn(turnId, { supersedeLatest: true }),
        onOpenPersonalitiesSettings,
        onOpenLibraryArtifacts,
        onOpenOpsRuntime,
        onAcceptDelegation: handleAcceptDelegation,
        onDismissDelegationSuggestion: () => setDelegationSuggestion(null),
        onApprovePending: (allowScope) => void handleApprovePending(allowScope),
        onDenyPending: () => void handleDenyPending(),
        onOpenApprovals,
        onSubmitUserInput: (response) => void handleSubmitUserInput(response),
        onRefreshThread: () => void loadSessionCoreState(selectedSession.sessionId, { includeThread: true }),
        isDragActive,
        queueItems,
        editingTurnId,
        planningMode: planningMode === "advisory" ? "advisory" : "off",
        effectiveToolAutonomy,
        draft,
        commandSuggestions,
        commandIndex,
        pendingAttachments,
        pendingAttachmentModes,
        threadKnowledgeAttachments: threadKnowledgeAttachments?.items ?? [],
        presetOptions,
        selectedPresetId,
        presetApplyWarning,
        selectedTurnRecovery,
        selectedTurn,
        selectedSessionId,
        currentWebMode: prefs?.webMode ?? "auto",
        currentReviewDepth: prefs?.orchestrationReviewDepth ?? "off",
        fullWebAccess,
        currentThinkingLevel: prefs?.thinkingLevel ?? "standard",
        currentSpeedMode: prefs?.speedMode ?? "standard",
        currentSubagentPolicy: prefs?.subagentPolicy ?? "ask_when_useful",
        routePreflight: currentRoutePreflight,
        routePreflightLoading: routePreflight.loading,
        routePreflightError: routePreflight.error,
        routeBoundaryAckRequired,
        routeBoundaryAcknowledged: currentRouteBoundaryAcknowledged,
        sending,
        canSend,
        hasActiveStream: Boolean(activeStreamRef.current),
        activeStreamTurnAssigned: Boolean(activeStreamRef.current?.turnId),
        composerRef,
        fileInputRef,
        audioInputRef,
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
        onResumeAll: handleResumeQueue,
        onRemoveQueuedItem: handleRemoveQueuedItem,
        onCancelEdit: handleCancelEdit,
        onDismissError: handleDismissError,
        onAcknowledgeRouteBoundary: acknowledgeCurrentRouteBoundary,
        onTogglePlanningMode: handleTogglePlanningMode,
        onToggleResearchMode: handleToggleResearchMode,
        onToggleReviewMode: handleToggleReviewMode,
        onSetDeepMode: () => handleSetDeepMode(),
        onFullWebAccessChange: setFullWebAccess,
        onSetThinkingLevel: (level) => void handlePrefPatch({ thinkingLevel: level }),
        onSetSpeedMode: (mode) => void handlePrefPatch({ speedMode: mode }),
        onSetSubagentPolicy: (policy) => void handlePrefPatch({ subagentPolicy: policy }),
        onReviewRunDetails: handleRevealSelectedTurnDetails,
        onDraftChange: setDraft,
        onComposerKeyDown: handleComposerKeyDown,
        onComposerPaste: handleComposerPaste,
        onApplyDraftCommand: handleApplyDraftCommand,
        onPresetChange: setSelectedPresetId,
        onApplyPreset: () => void handleApplyPreset(),
        onDismissPresetWarning: () => setPresetApplyWarning(null),
        onSetAttachmentMode: handleSetPendingAttachmentMode,
        onRemoveThreadKnowledgeAttachment: (attachmentId) => void handleRemoveThreadKnowledge(attachmentId),
        knowledgeUrlDraft,
        knowledgeUrlMode,
        onKnowledgeUrlDraftChange: setKnowledgeUrlDraft,
        onKnowledgeUrlModeChange: setKnowledgeUrlMode,
        onAttachKnowledgeUrl: () => void handleAttachKnowledgeUrl(),
        onRemoveAttachment: handleRemoveAttachment,
        onAttachFiles: () => fileInputRef.current?.click(),
        onUploadFiles: handleUploadFiles,
        onRunQuickResearch: () => void handleRunQuickResearch(),
        voiceBusy,
        liveVoiceActive,
        liveVoiceAvailable,
        liveVoiceMuted,
        liveVoiceState,
        liveVoiceStatusLabel,
        liveVoiceUnavailableReason,
        voiceInputAvailable,
        voiceOutputAvailable,
        voiceTalkActive,
        voiceStatusLabel,
        voiceUnavailableReason,
        speakResponsesEnabled,
        imageBusy,
        imageGenerationAvailable,
        imageEditAvailable,
        imageProviderOptions,
        selectedImageProviderId,
        selectedImageModel,
        imageRouteSwitchDisabled: !selectedSessionId || sending,
        imageRouteLabel,
        onRequestImageProviderChange: (providerId) => {
          const provider = imageProviderOptions.find((item) => item.providerId === providerId);
          void loadModelsForProvider(providerId);
          void handlePrefPatch({
            imageProviderId: providerId,
            imageModel: provider?.defaultModel ?? provider?.models[0] ?? "",
          });
        },
        onRequestImageModelChange: (model) =>
          void handlePrefPatch({
            imageProviderId: selectedImageProviderId ?? "",
            imageModel: model,
          }),
        onToggleLiveVoice: () => void handleToggleLiveVoice(),
        onToggleLiveVoiceMute: handleToggleLiveVoiceMute,
        onToggleVoiceTalk: () => void handleToggleVoiceTalk(),
        onOpenAudioTranscribe: handleOpenAudioTranscribe,
        onAudioFileSelected: handleAudioFileSelected,
        onToggleSpeakResponses: () => setSpeakResponsesEnabled((current) => !current),
        onGenerateImage: () => void handleGenerateImage(),
        onEditImage: () => void handleEditImage(),
        activeGeneratedArtifact,
        onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
        onStopActiveTurn: () => void handleStopActiveTurn(),
        onSend: () => void handleSendWithKnowledge(),
        coworkStopRunControl: resolveCoworkComposerStopControl({
          mode: messageMode,
          delegationRunStatus: visibleDelegationRun?.status,
          controls: coworkViewModel.agenticRuntime?.controls,
        }),
        onCoworkStopRun: (control) => void handleAgenticControl(control),
        coworkStopRunPending: agenticControlPending === "cancel",
        pinnedGoal,
        midTurnDisposition: resolveMidTurnDisposition({
          hasActiveStream: Boolean(activeStreamRef.current),
          draft,
        }),
        onSteerMidTurn: handleSteerMidTurn,
        onSetGoal: handleSetGoal,
        onClearGoal: handleClearGoal,
        onGoalStatus: handleGoalStatus,
        surfaceRoutePreview: surfacePreview,
        autoRouteActive,
      }
    : null;

  const emptyStateProps: MissionThreadedEmptyStateProps = {
    mode: messageMode,
    sessionCount: missionSessions.length + externalSessions.length,
    projectCount: projects?.items.length ?? 0,
    workspaceName,
    approvalsCount,
    onCreateSession: handleCreateCurrentModeSession,
    onOpenCowork,
    onOpenCode,
    onOpenTasks,
    onOpenApprovals,
    onOpenStartHere,
  };

  const workflowPanel: MissionThreadedWorkflowPanel =
    selectedSession && isCoworkSurface
      ? {
          kind: "cowork",
          props: {
            viewModel: coworkViewModel,
            onRetryTurn: activeWorkflowTurn ? () => void handleRetryTurn(activeWorkflowTurn.turnId) : undefined,
            onStopTurn:
              activeWorkflowTurn && isChatTurnActiveStatus(activeWorkflowTurn.trace.status)
                ? () => void handleStopActiveTurn()
                : undefined,
            onOpenTasks,
            onOpenDetails: () => handleRevealActiveTurnDetails(),
            onFocusComposer: () => composerRef.current?.focus(),
            onRefreshRunState: () => void refreshOrchestrationRun(),
            onAgenticControl: (control) => void handleAgenticControl(control),
            agenticControlPending,
            agenticControlStatus,
          },
        }
      : selectedSession && isCodeSurface
        ? {
            kind: "code",
            props: {
              workspaceId,
              selectedTurn,
              projectName: selectedProject?.name ?? undefined,
              needsProjectBinding: codeModeNeedsProjectBinding,
              workbenchState,
              workbenchTree,
              selectedFile: selectedWorkbenchFile,
              selectedFileDiff: selectedWorkbenchFileDiff,
              draftContent: workbenchDraftContent,
              expandedPaths: workbenchExpandedPaths,
              diff: workbenchDiff,
              output: workbenchOutput,
              loading: workbenchLoading,
              busy: workbenchBusy,
              saving: workbenchSaving,
              error: workbenchError,
              hasDirtyDraft: hasDirtyWorkbenchDraft,
              generatedArtifact: activeGeneratedArtifact,
              onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
              availableProjects: activeCodeProjects,
              selectedProjectCandidateId: selectedProjectBindingCandidateId,
              sourceBindingBusy: sessionControlPending === "project" || sessionControlPending === "code_source",
              onBindExistingProject: async (projectId) => {
                await handleAssignProject(projectId);
              },
              onImportProjectSource: async (input) => {
                await handleImportCodeProject(input);
              },
              onCreateWorktree: () => void createWorkbenchWorktree(workbenchState?.baseRef),
              onSelectFile: (relativePath) => void openWorkbenchFile(relativePath),
              onDraftChange: (nextValue) => setWorkbenchDraftContent(nextValue),
              onExpandedPathsChange: (nextPaths) => setWorkbenchExpandedPaths(nextPaths),
              onRefresh: () => void refreshWorkbench(),
              onSaveFile: () => void saveWorkbenchFile(),
              onFileOperation: (input) => runWorkbenchFileOperation(input),
              onDiscardDraft: () => discardWorkbenchDraft(),
              onRunValidationCommand: (input) => void runWorkbenchValidationCommand(input),
              onApplyPatch: (patch) => void applyWorkbenchPatch(patch),
              onExportPatch: async () => {
                const response = await exportWorkbenchPatch();
                if (!response) {
                  return;
                }
                if (typeof window !== "undefined" && response.patch.trim()) {
                  const blob = new Blob([response.patch], { type: "text/x-diff" });
                  const url = window.URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${selectedSession.sessionId}-workbench-${response.generatedAt.replace(/[:.]/g, "-")}.patch`;
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  window.URL.revokeObjectURL(url);
                }
                pushLocalNotice(
                  `Exported workbench patch for ${response.changedFiles.length} changed file${
                    response.changedFiles.length === 1 ? "" : "s"
                  }.`,
                  "success",
                );
              },
              onRevertFile: (relativePath) => void revertWorkbenchFile(relativePath),
              onRevertAll: () => void revertWorkbenchAll(),
              onRunHelperSnippet: (language, source) => void handleRunCodeHelper(language, source),
              onOpenApprovals,
            },
          }
        : null;

  const threadedSurfaceInput: MissionThreadedRenderSurfaceInput = {
    messageMode,
    sessionRailOpen,
    onSessionRailOpenChange: handleSessionRailOpenChange,
    dockOpen,
    onDockOpenChange: handleDockOpenChange,
    sessionRail: sessionRailData,
    activeSessionSurfaceProps,
    emptyStateProps,
    dropTargetProps: {
      isDragActive,
      fileInputRef,
      onAttachFiles: () => fileInputRef.current?.click(),
      onUploadFiles: handleUploadFiles,
      onDragEnter: handleDragEnter as DragEventHandler<HTMLElement>,
      onDragOver: handleDragOver as DragEventHandler<HTMLElement>,
      onDragLeave: handleDragLeave as DragEventHandler<HTMLElement>,
      onDrop: handleDrop as DragEventHandler<HTMLElement>,
    },
    workflowPanel,
    btwSideChatProps,
    contextDockProps: selectedSession
      ? {
          mode: messageMode,
          dockOpen,
          dockSectionStyle,
          isChatSurface,
          isCoworkSurface,
          isCodeSurface,
          activeModePreset: activeModePreset as ChatModePresetRecord,
          planningMode,
          effectiveToolAutonomy,
          codeModeNeedsProjectBinding,
          selectedSession,
          selectedProject,
          selectedProjectBindingCandidateId,
          selectedProjectBindingCandidateName,
          sending,
          sessionControlPending,
          providerOptions,
          selectedProviderId,
          selectedModel,
          streamEnabled,
          visualStreamMode,
          onStreamEnabledChange: setStreamEnabled,
          onVisualStreamModeChange: setVisualStreamMode,
          prefs,
          selectedSessionId,
          showTracePanel,
          selectedTurn,
          activeGeneratedArtifact,
          routePreflight: currentRoutePreflight,
          trust: sessionTrust,
          providerLabelById,
          showSuggestionsPanel,
          showLearnedMemoryPanel,
          latestOrchestration,
          coworkItems,
          coworkViewModel,
          proactiveStatus,
          proactiveRuns,
          proactiveSuggestionCount,
          capabilitySuggestions,
          specialistSuggestions,
          specialistCandidates,
          delegationSuggestion,
          learnedMemory,
          secondaryLoading,
          binding,
          integrationConnectionId,
          integrationTarget,
          selectedSessionProjectValue,
          projectOptions,
          loadModelsForProvider,
          getCachedModels,
          resolveProviderModelSelection,
          onPrefPatch: handlePrefPatch,
          onSuggestDelegation: handleSuggestDelegation,
          onTriggerProactive: handleTriggerProactive,
          onProactivePolicyPatch: handleProactivePolicyPatch,
          onRunCodeDelegation: handleRunCodeDelegation,
          onCapabilitySuggestionAction: handleCapabilitySuggestionAction,
          onCreateSpecialistDraft: handleCreateSpecialistDraft,
          onActivateCatalogSpecialist: handleActivateCatalogSpecialist,
          onSpecialistCandidatePatch: handleSpecialistCandidatePatch,
          onAcceptDelegation: handleAcceptDelegation,
          onRebuildLearnedMemory: handleRebuildLearnedMemory,
          onUpdateMemoryStatus: handleMemoryStatusUpdate,
          onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
          onRenameTitleChange: setRenameTitle,
          renameTitle,
          folderName,
          onFolderNameChange: setFolderName,
          tagsValue,
          onTagsValueChange: setTagsValue,
          onRenameSession: handleRenameSession,
          onSaveOrganization: handleSaveOrganization,
          onTogglePinSession: handleTogglePinSession,
          onToggleArchiveSession: handleToggleArchiveSession,
          onDeleteSession: () => handleDeleteSession(formatSessionLabel(selectedSession)),
          onAssignProject: handleAssignProject,
          onExportSnapshot: handleExportSessionSnapshot,
          onExportRunBundle: handleExportRunBundle,
          onIntegrationConnectionIdChange: setIntegrationConnectionId,
          onIntegrationTargetChange: setIntegrationTarget,
          onSaveExternalBinding: handleSaveExternalBinding,
        }
      : null,
  };

  const rootClassName = `chat-v11 mode-${messageMode}${lockSurface ? " shell-owned-surface" : ""}`;
  if (loading) {
    return (
      <section className={rootClassName}>
        {!lockSurface && !hidePageHeader ? (
          <PageHeader
            title={surfaceHeaderTitle}
            subtitle={surfaceHeaderSubtitle}
            className="page-header-command chat-v11-header"
          />
        ) : null}
        <ThreadedLoadingState
          approvalsCount={approvalsCount}
          mode={messageMode}
          projectCount={projects ? projects.items.length : null}
          sessionCount={sessions ? missionSessions.length + externalSessions.length : null}
          workspaceName={workspaceName}
        />
      </section>
    );
  }

  return (
    <section className={rootClassName}>
      {!lockSurface && !hidePageHeader ? (
        <PageHeader
          title={surfaceHeaderTitle}
          subtitle={surfaceHeaderSubtitle}
          hint={
            isCodeSurface
              ? undefined
              : "Stay in the main thread by default. Open trace, memory, and approvals only when you need them."
          }
          className="page-header-command chat-v11-header"
          actions={
            <div className="chat-v11-page-actions">
              <StatusChip tone={selectedSessionId ? "live" : "muted"}>
                {selectedSessionId ? "Session selected" : "No session"}
              </StatusChip>
              {selectedSession ? (
                <StatusChip tone={selectedSession.scope === "external" ? "warning" : "success"}>
                  {selectedSession.scope === "external" ? "External writeback (non-resumable)" : "Mission session"}
                </StatusChip>
              ) : null}
              {!isCodeSurface && visibleRunStateLabel ? (
                <StatusChip tone="muted">{visibleRunStateLabel}</StatusChip>
              ) : null}
            </div>
          }
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {isRefreshing ? <p className="status-banner">Refreshing chat context...</p> : null}

      {renderSurface(threadedSurfaceInput)}
      <ConfirmModal
        open={Boolean(capabilitySuggestionConfirm)}
        title={capabilityConfirmationCopy?.title ?? "Confirm capability action"}
        message={capabilityConfirmationCopy?.message ?? ""}
        confirmLabel={
          capabilitySuggestionPending ? "Applying..." : (capabilityConfirmationCopy?.confirmLabel ?? "Confirm")
        }
        danger={capabilityConfirmationCopy?.danger ?? false}
        pending={capabilitySuggestionPending}
        cancelDisabled={capabilitySuggestionPending}
        disableDismiss={capabilitySuggestionPending}
        onCancel={() => setCapabilitySuggestionConfirm(null)}
        onConfirm={handleConfirmCapabilitySuggestion}
      />
      <ConfirmModal
        open={Boolean(workbenchDiscardConfirm)}
        title={workbenchDiscardConfirm?.title ?? "Discard unsaved workbench changes?"}
        message={workbenchDiscardConfirm?.message ?? ""}
        confirmLabel="Discard changes"
        danger
        onCancel={() => setWorkbenchDiscardConfirm(null)}
        onConfirm={() => {
          if (!workbenchDiscardConfirm) {
            return;
          }
          const action = workbenchDiscardConfirm.onConfirm;
          setWorkbenchDiscardConfirm(null);
          action();
        }}
      />
      <ConfirmModal
        open={Boolean(threadModelSwitchConfirm)}
        title={threadModelSwitchConfirm?.title ?? "Switch thread model?"}
        message={threadModelSwitchConfirm?.message ?? ""}
        confirmLabel="Switch model"
        onCancel={() => setThreadModelSwitchConfirm(null)}
        onConfirm={() => {
          if (!threadModelSwitchConfirm) {
            return;
          }
          const patch = threadModelSwitchConfirm.patch;
          setThreadModelSwitchConfirm(null);
          void applyThreadModelPatch(patch);
        }}
      />
      <ConfirmModal
        open={Boolean(sessionDeleteConfirm)}
        title="Delete session permanently"
        message={sessionDeleteConfirm ? getDeleteSessionConfirmationMessage(sessionDeleteConfirm.label) : ""}
        confirmLabel={sessionControlPending === "delete" ? "Deleting..." : "Delete permanently"}
        danger
        pending={sessionControlPending === "delete"}
        cancelDisabled={sessionControlPending === "delete"}
        disableDismiss={sessionControlPending === "delete"}
        onCancel={() => setSessionDeleteConfirm(null)}
        onConfirm={handleConfirmDeleteSession}
      />
      <ConfirmModal
        open={archiveWorkspaceConfirmOpen}
        title="Archive Workspace Mission Chats"
        message={`Archive ${workspaceMissionSessionCount} active mission chats in this workspace? Archived chats leave the default history rail but stay recoverable from the Archived view. External and integration-bound chats are not affected.`}
        confirmLabel={archiveWorkspacePending ? "Archiving..." : "Archive mission chats"}
        danger
        pending={archiveWorkspacePending}
        cancelDisabled={archiveWorkspacePending}
        disableDismiss={archiveWorkspacePending}
        onCancel={() => setArchiveWorkspaceConfirmOpen(false)}
        onConfirm={handleConfirmArchiveWorkspace}
      />
    </section>
  );
}

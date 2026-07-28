import type {
  ChatAttachmentRecord,
  ChatDelegationSuggestionRecord,
  ChatGeneratedArtifactRecord,
  ChatHistoryWindowResponse,
  ChatMode,
  ChatOrchestrationReviewDepth,
  ChatSessionRecord,
  ChatThinkingLevel,
  ChatThreadResponse,
  ChatWebMode,
  ExternalSessionAttachmentRecord,
  RoutingPreflightResult,
  SurfaceClassifyResponse,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import type { ClipboardEventHandler, DragEventHandler, KeyboardEventHandler, RefObject } from "react";
import type { EventStreamStatus } from "@goatcitadel/mission-control-shared/api/shell-client";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import type { ChatQueueItemView } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadView";
import type { CoworkAgenticControlItem } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";
import type { PendingUserInputState } from "./useChatOutboundExecution";
import type { ChatStreamingPreview, ChatVisualStreamMode } from "./chat-streaming-preview";
import type { WorkTrustDescriptor } from "./work-trust";
import type { ChatErrorSource } from "./chat-error-copy";
import type { MidTurnDisposition } from "./chat-page-pure-helpers";
import type { OutboundContextBlock } from "./useChatSurfaceOrchestration";
import type { ChatCapabilityProfileInspection } from "./useChatCapabilityProfileInspection";
import type { MissionThreadedSessionControlBannerProps } from "./session-control-banner";

export interface ThreadedContextSelectionState {
  label: string;
  turnCount: number;
  sourceLabel?: string;
}

export interface ThreadedPersonalityPresence {
  name: string;
  tone?: string;
  scope: "citadel_default" | "thread_override";
  avatarLabel?: string;
  animation?: "ambient" | "still" | "none";
}

/**
 * HX-407 C3 composer controls for read-only external-source attachments.
 * `null`/absent means the capability is not composed (pre-C4) and the surface
 * renders nothing for it; `canMutate: false` keeps attach/detach/knowledge
 * actions disabled while chips and per-turn selection stay live.
 */
export interface ThreadedExternalSourceControls {
  /** Live read-only attachments (content-free records; no transcript bytes). */
  attachments: readonly ExternalSessionAttachmentRecord[];
  /** Explicit per-turn selection (attachment ids) frozen into the next send. */
  selectedAttachmentIds: readonly string[];
  busyAttachmentId: string | null;
  /** True once the runtime exposes the session incarnation (C4); gates mutations only. */
  canMutate: boolean;
  error: string | null;
  onToggleSelect: (attachmentId: string) => void;
  onClearSelection: () => void;
  onAttach: (seed: { sourceId: string; importId: string; itemId: string }) => void;
  onDetach: (attachmentId: string) => void;
  onRequestKnowledgeSnapshot: (attachmentId: string) => void;
}

export interface MissionControlActiveSessionSurfaceProps {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  trust: WorkTrustDescriptor;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId?: string;
  selectedModel?: string;
  modelSwitchDisabled: boolean;
  sessionLifecycleStatus: ChatSessionRecord["lifecycleStatus"];
  sessionArchivePending: boolean;
  dockOpen: boolean;
  onToggleDock: () => void;
  onToggleArchiveSession: () => void;
  onNavigateSurface: (surface: ChatMode) => void;
  onModeOverride?: (mode: ChatMode) => void;
  modeOverridePending?: ChatMode | null;
  onRequestProviderChange: (providerId: string) => void;
  onRequestModelChange: (model: string) => void;
  loading: boolean;
  historicalWindow: ChatHistoryWindowResponse | null;
  historicalWindowLoading: boolean;
  historicalWindowError: string | null;
  onReturnToLatest: () => void;
  historicalContinuationLoading: "older" | "newer" | null;
  historicalContinuationError: string | null;
  onLoadHistoricalContinuation: (direction: "older" | "newer") => void;
  historicalReadOnly: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  selectedContextTurnIds: string[];
  outboundContext: OutboundContextBlock | null;
  contextSelection: ThreadedContextSelectionState | null;
  delegationRun: ActiveChatDelegationRun | null;
  delegationSuggestion: ChatDelegationSuggestionRecord | null;
  notices: ChatThreadNotice[];
  /**
   * HX-411 controller banner data + operator actions, present only while an
   * external session_control_client owns this session. Content-free (no secret);
   * the surface renders it above the conversation with mutation controls disabled.
   */
  sessionControlBanner?: MissionThreadedSessionControlBannerProps | null;
  followOutput: boolean;
  streamStatus: ChatStreamStatus;
  visualStreamMode: ChatVisualStreamMode;
  activePersonality?: ThreadedPersonalityPresence | null;
  /**
   * @deprecated Host passthrough only updates on stream start/stop, not per
   * flush (see useChatStreamingPreviewState.ts). Consumers that need the
   * live, per-flush preview should subscribe to the chat-streaming-preview-store
   * (useChatStreamingPreviewSnapshot) instead of reading this prop.
   */
  streamingPreview: ChatStreamingPreview | null;
  activeStreamingTurnId: string | null;
  queuedCount: number;
  streamError: string | null;
  streamErrorSource?: ChatErrorSource | null;
  pendingApproval: ChatPendingApprovalState | null;
  pendingUserInput: PendingUserInputState | null;
  workspaceId: string;
  approvalPending: boolean;
  approvalsCount: number;
  userInputPending: boolean;
  eventStreamStatus: EventStreamStatus;
  onBottomStateChange: (next: boolean) => void;
  onSelectTurn: (turnId: string | null) => void;
  onToggleContextTurn: (turnId: string) => void;
  onClearContextSelection: () => void;
  onStartNewThreadFromTurn: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onExportRunBundle?: () => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
  onOpenPersonalitiesSettings?: () => void;
  onOpenLibraryArtifacts?: () => void;
  onOpenOpsRuntime?: () => void;
  onAcceptDelegation: () => Promise<void>;
  onDismissDelegationSuggestion: () => void;
  onApprovePending: (allowScope: "once" | "session" | "workspace") => void;
  onDenyPending: () => void;
  onOpenApprovals: () => void;
  onSubmitUserInput: (response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string }) => void;
  onRefreshThread: () => void;
  isDragActive: boolean;
  queueItems: ChatQueueItemView[];
  editingTurnId: string | null;
  planningMode: "off" | "advisory";
  effectiveToolAutonomy?: string;
  draft: string;
  commandSuggestions: Array<{ key: string; command: string; description: string; applyValue: string }>;
  commandIndex: number;
  pendingAttachments: Array<Pick<ChatAttachmentRecord, "attachmentId" | "fileName" | "mimeType" | "sizeBytes">>;
  pendingAttachmentModes?: Record<string, "message" | ThreadKnowledgeRetrievalMode>;
  threadKnowledgeAttachments?: ThreadKnowledgeAttachmentRecord[];
  /** HX-407 C3: absent/null until C4 composes the Chat attachment routes. */
  externalSourceControls?: ThreadedExternalSourceControls | null;
  presetOptions?: Array<{
    value: string;
    label: string;
    summary?: string;
    routeHint?: ChatMode;
    toolsPosture?: "safe_auto" | "manual";
  }>;
  selectedPresetId?: string;
  presetApplyWarning?: string | null;
  selectedTurnRecovery: {
    action?: string;
    label: string;
    summary: string;
  } | null;
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  capabilityProfileInspection: ChatCapabilityProfileInspection;
  selectedSessionId: string | null;
  currentWebMode: ChatWebMode;
  currentReviewDepth: ChatOrchestrationReviewDepth;
  modelCouncilEnabled?: boolean;
  fullWebAccess: boolean;
  currentThinkingLevel: ChatThinkingLevel;
  currentSpeedMode: "standard" | "fast";
  currentSubagentPolicy: "off" | "ask_when_useful" | "auto_when_useful";
  routePreflight: RoutingPreflightResult | null;
  routePreflightLoading: boolean;
  routePreflightError: string | null;
  /** Recompute the frozen preflight after an explicit Work Passport correction. */
  onWorkPassportBaselineChanged?: () => Promise<void>;
  routeBoundaryAckRequired: boolean;
  routeBoundaryAcknowledged: boolean;
  sending: boolean;
  canSend: boolean;
  hasActiveStream: boolean;
  activeStreamTurnAssigned: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  audioInputRef?: RefObject<HTMLInputElement | null>;
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  onResumeAll: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onCancelEdit: () => void;
  onDismissError: () => void;
  onAcknowledgeRouteBoundary: () => void;
  onTogglePlanningMode: () => void;
  onToggleResearchMode: () => void;
  onToggleReviewMode: () => void;
  onToggleModelCouncil?: () => void;
  onSetDeepMode: () => void;
  onFullWebAccessChange: (value: boolean) => void;
  onSetThinkingLevel: (level: ChatThinkingLevel) => void;
  onSetSpeedMode: (mode: "standard" | "fast") => void;
  onSetSubagentPolicy: (policy: "off" | "ask_when_useful" | "auto_when_useful") => void;
  onReviewRunDetails: () => void;
  onDraftChange: (next: string) => void;
  onComposerKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onComposerPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onApplyDraftCommand: (command: string) => void;
  onPresetChange?: (value: string) => void;
  onApplyPreset?: () => void;
  onDismissPresetWarning?: () => void;
  onSetAttachmentMode?: (attachmentId: string, mode: "message" | ThreadKnowledgeRetrievalMode) => void;
  onRemoveThreadKnowledgeAttachment?: (attachmentId: string) => void;
  knowledgeUrlDraft?: string;
  knowledgeUrlMode?: ThreadKnowledgeRetrievalMode;
  onKnowledgeUrlDraftChange?: (value: string) => void;
  onKnowledgeUrlModeChange?: (value: ThreadKnowledgeRetrievalMode) => void;
  onAttachKnowledgeUrl?: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRunQuickResearch: () => void;
  voiceBusy?: boolean;
  liveVoiceActive?: boolean;
  liveVoiceAvailable?: boolean;
  liveVoiceMuted?: boolean;
  liveVoiceState?: string;
  liveVoiceStatusLabel?: string;
  liveVoiceUnavailableReason?: string | null;
  voiceInputAvailable?: boolean;
  voiceOutputAvailable?: boolean;
  voiceTalkActive?: boolean;
  voiceStatusLabel?: string;
  voiceUnavailableReason?: string | null;
  speakResponsesEnabled?: boolean;
  imageBusy?: boolean;
  imageGenerationAvailable?: boolean;
  imageEditAvailable?: boolean;
  imageProviderOptions?: ChatModelProviderOption[];
  selectedImageProviderId?: string;
  selectedImageModel?: string;
  imageRouteSwitchDisabled?: boolean;
  imageRouteLabel?: string | null;
  onRequestImageProviderChange?: (providerId: string) => void;
  onRequestImageModelChange?: (model: string) => void;
  onToggleLiveVoice?: () => void;
  onToggleLiveVoiceMute?: () => void;
  onToggleVoiceTalk?: () => void;
  onOpenAudioTranscribe?: () => void;
  onAudioFileSelected?: (files: FileList | null) => void;
  onToggleSpeakResponses?: () => void;
  onGenerateImage?: () => void;
  onEditImage?: () => void;
  activeGeneratedArtifact?: ChatGeneratedArtifactRecord | null;
  onCloseGeneratedArtifact?: () => void;
  onStopActiveTurn: () => void;
  onSend: () => void;
  pinnedGoal?: string;
  midTurnDisposition?: MidTurnDisposition;
  onSteerMidTurn?: (instruction: string) => Promise<void>;
  onSetGoal?: (goal: string, turnBudget?: number) => Promise<void>;
  onClearGoal?: () => Promise<void>;
  onGoalStatus?: () => Promise<void>;
  /** Full classify preview hook result (only set when autoRouteActive is true). */
  surfaceRoutePreview?: SurfaceClassifyResponse;
  /** True when auto-routing is active for the current thread (unlocked surface, no override, empty thread). */
  autoRouteActive?: boolean;
  /**
   * Active delegation run cancel control, surfaced beside the composer so an
   * operator can stop a running delegation from the chat window without opening
   * the workflow/run-tree panel. `null` unless a running delegation run exposes
   * a cancel control. A disabled control is still passed (rendered disabled with
   * its reason) rather than omitted.
   */
  coworkStopRunControl?: CoworkAgenticControlItem | null;
  /**
   * Record operator stop intent for the active delegation run via the existing
   * agentic run control endpoint (`controlAgenticRun(runId, { action: "cancel" })`).
   * For a run with no attached durable run this is state-only: it records intent
   * and does not terminate the worker.
   */
  onCoworkStopRun?: (control: CoworkAgenticControlItem) => void;
  /** True while a stop (cancel) control request is in flight. */
  coworkStopRunPending?: boolean;
}

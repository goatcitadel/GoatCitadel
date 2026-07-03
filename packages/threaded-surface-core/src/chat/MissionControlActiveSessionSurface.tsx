import type {
  ChatAttachmentRecord,
  ChatDelegationSuggestionRecord,
  ChatGeneratedArtifactRecord,
  ChatMode,
  ChatSessionRecord,
  ChatThreadResponse,
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
import type { CodeSendGate } from "../pure-helpers";

export interface ThreadedContextSelectionState {
  label: string;
  turnCount: number;
  sourceLabel?: string;
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
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  selectedContextTurnIds: string[];
  outboundContext: OutboundContextBlock | null;
  contextSelection: ThreadedContextSelectionState | null;
  delegationRun: ActiveChatDelegationRun | null;
  delegationSuggestion: ChatDelegationSuggestionRecord | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus: ChatStreamStatus;
  visualStreamMode: ChatVisualStreamMode;
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
  selectedSessionId: string | null;
  currentWebMode: "auto" | "off" | "quick" | "deep";
  fullWebAccess: boolean;
  currentThinkingLevel: "off" | "minimal" | "standard" | "extended" | "deep";
  currentSpeedMode: "standard" | "fast";
  currentSubagentPolicy: "off" | "ask_when_useful" | "auto_when_useful";
  routePreflight: RoutingPreflightResult | null;
  routePreflightLoading: boolean;
  routePreflightError: string | null;
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
  onSetDeepMode: () => void;
  onFullWebAccessChange: (value: boolean) => void;
  onSetThinkingLevel: (level: "off" | "minimal" | "standard" | "extended" | "deep") => void;
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
   * Set when a send was intercepted by the code-path pre-send gate. The composer
   * renders an inline confirm; `null` when no gate is pending.
   */
  pendingCodeGate?: CodeSendGate;
  /** Proceed with the gated send, forcing the Code surface. */
  onConfirmCodeTurn?: () => void;
  /** Dismiss the gate and send the message as Chat instead. */
  onSendAsChatInstead?: () => void;
  /**
   * Cowork: the active delegation run's `cancel` control, surfaced beside the
   * composer so an operator can stop a running delegation from the chat window
   * without opening the workflow/run-tree panel. `null` unless a running cowork
   * delegation run exposes a cancel control. A disabled control is still passed
   * (rendered disabled with its reason) rather than omitted.
   */
  coworkStopRunControl?: CoworkAgenticControlItem | null;
  /**
   * Record operator stop intent for the active delegation run via the existing
   * agentic run control endpoint (`controlAgenticRun(runId, { action: "cancel" })`).
   * For a cowork run with no attached durable run this is state-only: it records
   * intent and does not terminate the worker.
   */
  onCoworkStopRun?: (control: CoworkAgenticControlItem) => void;
  /** True while a cowork stop (cancel) control request is in flight. */
  coworkStopRunPending?: boolean;
}

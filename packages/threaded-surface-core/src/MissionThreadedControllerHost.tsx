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
  ChatSessionSearchHitRecord,
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
  ApiRequestError,
  attachThreadKnowledgeAttachment,
  clearChatSessionGoal,
  createChatGeneratedArtifact,
  createChatSession,
  fetchAgents,
  fetchChatGeneratedArtifact,
  fetchChatSessionGoal,
  fetchChatSessionPrefs,
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
import { useSessionControlStatus } from "@goatcitadel/mission-control-shared/hooks/useSessionControlStatus";
import { revokeSessionControl } from "@goatcitadel/mission-control-shared/api/session-control-operator";
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
import { useChatCapabilityProfileInspection } from "./chat/useChatCapabilityProfileInspection";
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
import {
  deriveSessionControlBannerViewModel,
  type SessionControlBannerActionPending,
} from "./chat/session-control-banner";
import { useChatApprovalController } from "./chat/useChatApprovalController";
import { useChatContextActions } from "./chat/useChatContextActions";
import { useChatComposerInteractions } from "./chat/useChatComposerInteractions";
import {
  abortActiveChatStream,
  captureOutboundRequestPrefsSnapshot,
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
import { useChatSessionControls, type SessionMetadataConflictDraft } from "./chat/useChatSessionControls";
import { useChatDockWorkbenchController } from "./chat/useChatDockWorkbenchController";
import { useChatProviderRoutingController } from "./chat/useChatProviderRoutingController";
import { useChatRoutePreflight } from "./chat/useChatRoutePreflight";
import {
  resolveOutboundDraftContent,
  useChatSurfaceOrchestration,
  type OutboundQueueItem,
  type OutboundRequestPrefsSnapshot,
} from "./chat/useChatSurfaceOrchestration";
import { useExternalSourceAttachments } from "./chat/useExternalSourceAttachments";
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

const MAX_HYDRATED_STORAGE_BYTES = 256 * 1024;
const MAX_HYDRATED_QUEUE_ITEMS = 64;
const MAX_HYDRATED_ATTACHMENTS = 16;
const MAX_HYDRATED_MESSAGE_CHARS = 64 * 1024;
const MAX_HYDRATED_ATTACHMENT_TEXT_CHARS = 64 * 1024;
const MAX_HYDRATED_ATTACHMENT_SIZE_BYTES = 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_STORAGE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._ -]{0,255}$/iu;
const WINDOWS_RESERVED_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

type UnknownRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: UnknownRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000")
  );
}

function isSafeIdentifier(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeRelativeStoragePath(value: unknown): value is string {
  if (
    !isBoundedString(value, 1024) ||
    value.trim() !== value ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /%(?:2e|2f|5c)/iu.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        SAFE_STORAGE_SEGMENT_PATTERN.test(segment) &&
        !WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" "),
    );
}

function isWithinStorageBudget(raw: string): boolean {
  if (raw.length > MAX_HYDRATED_STORAGE_BYTES) {
    return false;
  }
  return new TextEncoder().encode(raw).byteLength <= MAX_HYDRATED_STORAGE_BYTES;
}

function parseHydratedAttachment(
  value: unknown,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "attachmentId",
      "sessionId",
      "workspaceId",
      "projectId",
      "fileName",
      "mimeType",
      "mediaType",
      "sizeBytes",
      "sha256",
      "storageRelPath",
      "extractStatus",
      "extractPreview",
      "thumbnailRelPath",
      "ocrText",
      "transcriptText",
      "analysisStatus",
      "createdAt",
    ]) ||
    !isSafeIdentifier(value.attachmentId) ||
    typeof scope.sessionId !== "string" ||
    value.sessionId !== scope.sessionId ||
    value.workspaceId !== scope.workspaceId ||
    !isSafeIdentifier(value.fileName, 512) ||
    !isSafeIdentifier(value.mimeType, 256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sizeBytes as number) > MAX_HYDRATED_ATTACHMENT_SIZE_BYTES ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isSafeRelativeStoragePath(value.storageRelPath) ||
    !["ready", "unsupported", "failed"].includes(value.extractStatus as string) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return null;
  }
  if (
    (hasOwn(value, "projectId") && !isSafeIdentifier(value.projectId)) ||
    (hasOwn(value, "mediaType") &&
      !["text", "image", "audio", "video", "binary"].includes(value.mediaType as string)) ||
    (hasOwn(value, "extractPreview") &&
      !isBoundedString(value.extractPreview, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "thumbnailRelPath") && !isSafeRelativeStoragePath(value.thumbnailRelPath)) ||
    (hasOwn(value, "ocrText") && !isBoundedString(value.ocrText, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "transcriptText") &&
      !isBoundedString(value.transcriptText, MAX_HYDRATED_ATTACHMENT_TEXT_CHARS, true)) ||
    (hasOwn(value, "analysisStatus") &&
      !["queued", "running", "pending", "ready", "failed", "unsupported"].includes(value.analysisStatus as string))
  ) {
    return null;
  }
  return Object.freeze({ ...value }) as unknown as ChatAttachmentRecord;
}

function parseHydratedAttachmentsValue(
  value: unknown,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord[] | null {
  if (!Array.isArray(value) || value.length > MAX_HYDRATED_ATTACHMENTS) {
    return null;
  }
  const parsed: ChatAttachmentRecord[] = [];
  const attachmentIds = new Set<string>();
  for (const candidate of value) {
    const attachment = parseHydratedAttachment(candidate, scope);
    if (!attachment || attachmentIds.has(attachment.attachmentId)) {
      return null;
    }
    attachmentIds.add(attachment.attachmentId);
    parsed.push(attachment);
  }
  return Object.freeze(parsed) as unknown as ChatAttachmentRecord[];
}

function parseHydratedRequestPrefs(value: unknown): OutboundRequestPrefsSnapshot | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "mode",
      "providerId",
      "model",
      "webMode",
      "memoryMode",
      "thinkingLevel",
      "speedMode",
      "subagentPolicy",
      "fullWebAccess",
    ]) ||
    value.mode !== "chat" ||
    !["auto", "off", "quick", "deep"].includes(value.webMode as string) ||
    !["auto", "on", "off"].includes(value.memoryMode as string) ||
    !["off", "minimal", "standard", "extended", "deep", "max", "ultra"].includes(value.thinkingLevel as string) ||
    !["standard", "fast"].includes(value.speedMode as string) ||
    !["off", "ask_when_useful", "auto_when_useful"].includes(value.subagentPolicy as string) ||
    typeof value.fullWebAccess !== "boolean" ||
    !isSafeIdentifier(value.providerId) ||
    !isSafeIdentifier(value.model, 512)
  ) {
    return null;
  }
  return Object.freeze({ ...value }) as unknown as OutboundRequestPrefsSnapshot;
}

const MAX_HYDRATED_EXTERNAL_CONTEXT_REFS = 16;

/**
 * Fail-closed parser for HX-407 queue-frozen external context refs. Only send
 * items may carry them, every ref is a safe `external_attachment` identifier,
 * and any drift rejects the whole persisted queue (matching the envelope's
 * all-or-nothing hydration posture).
 */
function parseHydratedExternalContextRefs(
  value: unknown,
  action: unknown,
): OutboundQueueItem["externalContextRefs"] | null {
  if (
    action !== "send" ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_HYDRATED_EXTERNAL_CONTEXT_REFS
  ) {
    return null;
  }
  const refs: Array<{ kind: "external_attachment"; ref: string; label?: string }> = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isPlainRecord(candidate) ||
      !hasOnlyKeys(candidate, ["kind", "ref", "label"]) ||
      candidate.kind !== "external_attachment" ||
      !isSafeIdentifier(candidate.ref) ||
      seen.has(candidate.ref) ||
      (hasOwn(candidate, "label") && !isBoundedString(candidate.label, 160))
    ) {
      return null;
    }
    seen.add(candidate.ref);
    refs.push(
      Object.freeze({
        kind: "external_attachment",
        ref: candidate.ref,
        ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
      }),
    );
  }
  return Object.freeze(refs);
}

/** Fail-closed parser for browser-persisted attachment references. */
export function parseHydratedChatAttachments(
  raw: string | null,
  scope: { workspaceId: string; sessionId: string | null },
): ChatAttachmentRecord[] {
  if (!raw || !isWithinStorageBudget(raw)) {
    return [];
  }
  try {
    return parseHydratedAttachmentsValue(JSON.parse(raw), scope) ?? [];
  } catch {
    return [];
  }
}

/** Fail-closed parser for immutable browser-persisted outbound queue envelopes. */
export function parseHydratedOutboundQueue(
  raw: string | null,
  scope: {
    workspaceId: string;
    sessionId: string | null;
  },
): OutboundQueueItem[] {
  if (!raw || !isWithinStorageBudget(raw)) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_HYDRATED_QUEUE_ITEMS) {
      return [];
    }
    const parsed: OutboundQueueItem[] = [];
    const queueIds = new Set<string>();
    for (const candidate of value) {
      if (
        !isPlainRecord(candidate) ||
        !hasOnlyKeys(candidate, [
          "id",
          "action",
          "sessionId",
          "targetTurnId",
          "content",
          "attachments",
          "createdAt",
          "paused",
          "modelCouncil",
          "requestPrefs",
          "externalContextRefs",
        ]) ||
        !isSafeIdentifier(candidate.id) ||
        queueIds.has(candidate.id) ||
        !["send", "edit", "retry"].includes(candidate.action as string) ||
        !isBoundedString(candidate.content, MAX_HYDRATED_MESSAGE_CHARS, true) ||
        !isCanonicalTimestamp(candidate.createdAt) ||
        (hasOwn(candidate, "paused") && typeof candidate.paused !== "boolean") ||
        (scope.sessionId === null ? hasOwn(candidate, "sessionId") : candidate.sessionId !== scope.sessionId)
      ) {
        return [];
      }
      const targetTurnId = hasOwn(candidate, "targetTurnId") ? candidate.targetTurnId : undefined;
      if (
        (candidate.action === "send" && (candidate.content as string).trim().length === 0) ||
        (candidate.action === "send" && targetTurnId !== undefined) ||
        (candidate.action === "edit" &&
          ((candidate.content as string).trim().length === 0 || !isSafeIdentifier(targetTurnId))) ||
        (candidate.action === "retry" &&
          (candidate.content !== "" ||
            !isSafeIdentifier(targetTurnId) ||
            (candidate.attachments as unknown[]).length > 0))
      ) {
        return [];
      }
      if (
        hasOwn(candidate, "modelCouncil") &&
        (!isPlainRecord(candidate.modelCouncil) ||
          !hasOnlyKeys(candidate.modelCouncil, ["enabled"]) ||
          candidate.modelCouncil.enabled !== true)
      ) {
        return [];
      }
      const attachments = parseHydratedAttachmentsValue(candidate.attachments, scope);
      const requestPrefs = hasOwn(candidate, "requestPrefs") ? parseHydratedRequestPrefs(candidate.requestPrefs) : null;
      if (!attachments || !requestPrefs) {
        return [];
      }
      const externalContextRefs = hasOwn(candidate, "externalContextRefs")
        ? parseHydratedExternalContextRefs(candidate.externalContextRefs, candidate.action)
        : undefined;
      if (hasOwn(candidate, "externalContextRefs") && !externalContextRefs) {
        return [];
      }
      queueIds.add(candidate.id);
      parsed.push(
        Object.freeze({
          id: candidate.id,
          action: candidate.action,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          ...(typeof targetTurnId === "string" ? { targetTurnId } : {}),
          content: candidate.content,
          attachments,
          createdAt: candidate.createdAt,
          paused: true,
          ...(hasOwn(candidate, "modelCouncil") ? { modelCouncil: Object.freeze({ enabled: true as const }) } : {}),
          requestPrefs,
          ...(externalContextRefs ? { externalContextRefs } : {}),
        }) as OutboundQueueItem,
      );
    }
    return Object.freeze(parsed) as unknown as OutboundQueueItem[];
  } catch {
    return [];
  }
}

/** Replace prior-session state while preserving items enqueued after a session transition rendered. */
export function mergeHydratedOutboundQueue(input: {
  hydrated: OutboundQueueItem[];
  current: OutboundQueueItem[];
  baselineIds: ReadonlySet<string>;
  sessionId: string | null;
}): OutboundQueueItem[] {
  const newlyQueued = input.current.filter(
    (item) =>
      !input.baselineIds.has(item.id) &&
      (input.sessionId === null ? item.sessionId === undefined : item.sessionId === input.sessionId),
  );
  const retainedNewItems = newlyQueued.slice(0, MAX_HYDRATED_QUEUE_ITEMS);
  const retainedIds = new Set(retainedNewItems.map((item) => item.id));
  const hydrated = input.hydrated
    .filter((item) => !retainedIds.has(item.id))
    .slice(0, MAX_HYDRATED_QUEUE_ITEMS - retainedNewItems.length);
  return [...hydrated, ...retainedNewItems];
}

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
  const [modelCouncilEnabled, setModelCouncilEnabled] = useState(false);
  const modelCouncilEnabledRef = useRef(false);
  const consumeModelCouncilArming = useCallback(() => {
    const enabled = modelCouncilEnabledRef.current;
    modelCouncilEnabledRef.current = false;
    setModelCouncilEnabled(false);
    return enabled ? ({ enabled: true } as const) : undefined;
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<ChatErrorSource | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [folderName, setFolderName] = useState("");
  const [tagsValue, setTagsValue] = useState("");
  const sessionMetadataConflictDraftRef = useRef<SessionMetadataConflictDraft | null>(null);
  const [preferenceConflictDraft, setPreferenceConflictDraft] = useState<{
    sessionId: string;
    patch: ChatSessionPrefsPatch;
  } | null>(null);
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
  const outboundRequestPrefsSnapshotRef = useRef<OutboundRequestPrefsSnapshot>(
    captureOutboundRequestPrefsSnapshot({ prefs: null }),
  );
  const pushLocalNoticeRef = useRef<(message: string, tone?: ChatThreadNotice["tone"]) => void>(() => undefined);
  const applyFetchedThreadRef = useRef<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>(
    () => false,
  );
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateRef = useRef<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >(async () => undefined);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  // HX-411: mirrors server truth so operator Chat send fails closed while an
  // external session_control_client owns the current session. Read synchronously
  // by the keyboard/composer send path; never optimistically cleared on SSE drop.
  const sessionControlSendLockedRef = useRef(false);
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  const deferredSearch = useDeferredValue(search.trim());
  // Keep controller ownership aligned with ThreadedSurfacePage and its CSS:
  // below 1180px the inline rail becomes a drawer. Using the shell's narrower
  // 1023px breakpoint here immediately closed that drawer at laptop widths.
  const compactSurfaceLayout = useMediaQuery("(width < 1180px)");

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
    historicalWindow,
    historicalWindowLoading,
    historicalWindowError,
    historicalWindowTarget,
    historicalContinuationLoading,
    historicalContinuationError,
    loadSidebar,
    openHistoricalWindow,
    returnToLatest,
    loadHistoricalContinuation,
    loadSessionCoreState,
    loadSessionSecondaryState,
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

  const refreshChatSessionAggregate = useCallback(
    async (sessionId: string) => {
      const [, , , goal] = await Promise.all([
        loadSidebar(historyView, { bypassCache: true, preferredSessionId: sessionId }),
        loadSessionCoreState(sessionId, { background: true, includeThread: false }),
        loadSessionSecondaryState(sessionId, { background: true }),
        fetchChatSessionGoal(sessionId),
      ]);
      setPinnedGoal(goal.goal ?? undefined);
    },
    [historyView, loadSessionCoreState, loadSessionSecondaryState, loadSidebar],
  );

  // HX-411 governed external session control (operator visibility half). The
  // banner + Ops panel read this content-free projection; the derived send lock
  // fails ordinary operator Chat send closed while an external client owns the
  // generation. Operator reads, approvals, revoke, and emergency takeover stay
  // available; the control secret is never fetched or surfaced here.
  const sessionControlStatus = useSessionControlStatus(selectedSessionId);
  const reloadSessionControl = sessionControlStatus.reload;
  const sessionControlBannerModel = useMemo(
    () => deriveSessionControlBannerViewModel(sessionControlStatus.data),
    [sessionControlStatus.data],
  );
  const sessionControlSendLocked = sessionControlBannerModel.sendLocked;
  useEffect(() => {
    sessionControlSendLockedRef.current = sessionControlSendLocked;
  }, [sessionControlSendLocked]);
  const [sessionControlActionPending, setSessionControlActionPending] =
    useState<SessionControlBannerActionPending | null>(null);
  const [sessionControlActionError, setSessionControlActionError] = useState<string | null>(null);
  const runSessionControlRevoke = useCallback(
    (mode: SessionControlBannerActionPending) => {
      if (!selectedSessionId || !sessionControlBannerModel.externalControlActive) {
        return;
      }
      const targetSessionId = selectedSessionId;
      setSessionControlActionPending(mode);
      setSessionControlActionError(null);
      void revokeSessionControl(targetSessionId, {
        target: "current_controller",
        expectedGeneration: sessionControlBannerModel.generation,
        mode,
      })
        .then(async () => {
          await reloadSessionControl();
          await refreshChatSessionAggregate(targetSessionId);
        })
        .catch(() => {
          setSessionControlActionError(
            "The control action was rejected. The session state may have changed — reload and retry.",
          );
        })
        .finally(() => {
          setSessionControlActionPending(null);
        });
    },
    [
      refreshChatSessionAggregate,
      reloadSessionControl,
      selectedSessionId,
      sessionControlBannerModel.externalControlActive,
      sessionControlBannerModel.generation,
    ],
  );
  const handleSessionControlRevoke = useCallback(() => runSessionControlRevoke("revoke"), [runSessionControlRevoke]);
  const handleSessionControlEmergencyTakeover = useCallback(
    () => runSessionControlRevoke("emergency_takeover"),
    [runSessionControlRevoke],
  );

  const handleSessionMetadataConflictDraftChange = useCallback((draft: SessionMetadataConflictDraft | null) => {
    sessionMetadataConflictDraftRef.current = draft;
  }, []);

  const handleRenameTitleChange = useCallback(
    (value: string) => {
      setRenameTitle(value);
      const conflictDraft = sessionMetadataConflictDraftRef.current;
      if (conflictDraft?.kind === "rename" && conflictDraft.sessionId === selectedSession?.sessionId) {
        sessionMetadataConflictDraftRef.current = { ...conflictDraft, renameTitle: value };
      }
    },
    [selectedSession?.sessionId],
  );

  const handleFolderNameChange = useCallback(
    (value: string) => {
      setFolderName(value);
      const conflictDraft = sessionMetadataConflictDraftRef.current;
      if (conflictDraft?.kind === "organization" && conflictDraft.sessionId === selectedSession?.sessionId) {
        sessionMetadataConflictDraftRef.current = { ...conflictDraft, folderName: value };
      }
    },
    [selectedSession?.sessionId],
  );

  const handleTagsValueChange = useCallback(
    (value: string) => {
      setTagsValue(value);
      const conflictDraft = sessionMetadataConflictDraftRef.current;
      if (conflictDraft?.kind === "organization" && conflictDraft.sessionId === selectedSession?.sessionId) {
        sessionMetadataConflictDraftRef.current = { ...conflictDraft, tagsValue: value };
      }
    },
    [selectedSession?.sessionId],
  );

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
    refreshSessionAggregate: refreshChatSessionAggregate,
    setSessionMetadataConflictDraft: handleSessionMetadataConflictDraftChange,
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

  // HX-407 C3/C4b: durable read-only external-source attachments + explicit
  // per-turn selection. When the runtime does not compose the Gateway routes
  // the list read 404s → supported=false → the composer renders nothing. The
  // hook learns `sessionIncarnationId` from its own durable reload (the C4
  // list response carries it), so attach/detach/knowledge-request activate
  // exactly when the server supplies the value and stay disabled fail-closed
  // when it is genuinely absent — the host passes no incarnation of its own.
  const externalSourceAttachments = useExternalSourceAttachments({
    workspaceId: selectedSession?.workspaceId ?? workspaceId,
    sessionId: selectedSessionId,
    pushLocalNotice,
  });

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
    consumeModelCouncilArming,
    captureOutboundRequestPrefs: () => outboundRequestPrefsSnapshotRef.current,
    captureOutboundExternalContextRefs: externalSourceAttachments.captureOutboundExternalContextRefs,
    loadSessionCoreStateRef,
    abortActiveChatStream,
  });
  const composerSendHandlerRef = useRef<() => Promise<void>>(handleSend);
  const handleComposerSend = useCallback(() => {
    // Fail closed: an external controller owns this session's mutation authority.
    // The server also rejects this send; the UI must never present a send that 403s.
    if (sessionControlSendLockedRef.current) {
      pushLocalNoticeRef.current(
        "This session is controlled by an external client. Revoke or take over before sending.",
        "warning",
      );
      return Promise.resolve();
    }
    return composerSendHandlerRef.current();
  }, []);

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
  outboundRequestPrefsSnapshotRef.current = captureOutboundRequestPrefsSnapshot({
    prefs,
    selectedProviderId,
    selectedModel,
    fullWebAccess,
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
    content: draft,
    surfaceMode: executionSurfaceMode,
    fullWebAccess,
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
    refreshSessionAggregate: refreshChatSessionAggregate,
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
    proactivePolicyDraft,
    proactivePolicyConflict,
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
    externalContext: {
      onExternalContextSent: externalSourceAttachments.handleOutboundExternalContextSent,
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

  const draftStorageKey = createDraftStorageKey(workspaceId, selectedSessionId);
  const attachmentStorageKey = createAttachmentStorageKey(workspaceId, selectedSessionId);
  const queueStorageKey = createQueueStorageKey(workspaceId, selectedSessionId);
  const queueHydrationTransitionRef = useRef<{
    key: string;
    baselineIds: ReadonlySet<string>;
  }>({
    key: queueStorageKey,
    baselineIds: new Set(queuedOutbound.map((item) => item.id)),
  });
  if (queueHydrationTransitionRef.current.key !== queueStorageKey) {
    queueHydrationTransitionRef.current = {
      key: queueStorageKey,
      baselineIds: new Set(queuedOutbound.map((item) => item.id)),
    };
  }

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
    const hydrationTransition = queueHydrationTransitionRef.current;
    try {
      const draftRaw = window.localStorage.getItem(draftStorageKey);
      setDraft(
        draftRaw && isWithinStorageBudget(draftRaw) && draftRaw.length <= MAX_HYDRATED_MESSAGE_CHARS ? draftRaw : "",
      );
      const attachmentsRaw = window.localStorage.getItem(attachmentStorageKey);
      setPendingAttachments(
        parseHydratedChatAttachments(attachmentsRaw, {
          workspaceId,
          sessionId: selectedSessionId,
        }),
      );
      const queueRaw = window.localStorage.getItem(queueStorageKey);
      const hydratedQueue = parseHydratedOutboundQueue(queueRaw, {
        workspaceId,
        sessionId: selectedSessionId,
      });
      setQueuedOutbound((current) =>
        mergeHydratedOutboundQueue({
          hydrated: hydratedQueue,
          current,
          baselineIds: hydrationTransition.baselineIds,
          sessionId: selectedSessionId,
        }),
      );
    } catch {
      setDraft("");
      setPendingAttachments([]);
      setQueuedOutbound((current) =>
        mergeHydratedOutboundQueue({
          hydrated: [],
          current,
          baselineIds: hydrationTransition.baselineIds,
          sessionId: selectedSessionId,
        }),
      );
    }
  }, [attachmentStorageKey, draftStorageKey, queueStorageKey, selectedSessionId, setQueuedOutbound, workspaceId]);

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

  useDebouncedLocalStoragePersistence(draftStorageKey, draft);
  useDebouncedLocalStoragePersistence(attachmentStorageKey, serializedPendingAttachments);
  useDebouncedLocalStoragePersistence(queueStorageKey, serializedQueuedOutbound);

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
    const conflictDraft = sessionMetadataConflictDraftRef.current;
    const appliesToSelectedSession = conflictDraft?.sessionId === selectedSession?.sessionId;
    setRenameTitle(
      appliesToSelectedSession && conflictDraft?.kind === "rename"
        ? conflictDraft.renameTitle
        : (selectedSession?.title ?? ""),
    );
    setFolderName(
      appliesToSelectedSession && conflictDraft?.kind === "organization"
        ? conflictDraft.folderName
        : (selectedSession?.folderName ?? ""),
    );
    setTagsValue(
      appliesToSelectedSession && conflictDraft?.kind === "organization"
        ? conflictDraft.tagsValue
        : (selectedSession?.tags ?? []).join(", "),
    );
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
  const capabilityProfileInspection = useChatCapabilityProfileInspection({
    sessionId: selectedSessionId,
    workspaceId: selectedSession?.workspaceId ?? workspaceId,
    turn: selectedTurn,
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
      if (!Number.isInteger(agenticRunTree.taskRevision) || Number(agenticRunTree.taskRevision) < 1) {
        setAgenticControlStatus("Canonical task revision is unavailable. Refresh the run before applying a control.");
        return;
      }
      setAgenticControlPending(control.action);
      setAgenticControlStatus(null);
      try {
        const response = await controlAgenticRun(
          agenticRunTree.runId,
          {
            action: control.action,
            expectedRevision: agenticRunTree.taskRevision!,
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
        if (error instanceof ApiRequestError && error.status === 409) {
          const refreshedTree = await resolveAgenticRunTree().catch(() => null);
          setAgenticRunTree(refreshedTree);
          const message =
            "The run changed. Canonical state was refreshed; review it, then retry the control explicitly.";
          setAgenticControlStatus(message);
          pushLocalNotice(message, "warning");
          return;
        }
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = describeChatUiError(rawMessage, "refresh")?.summary ?? rawMessage;
        setAgenticControlStatus(message);
        pushLocalNotice(message, "warning");
      } finally {
        setAgenticControlPending(null);
      }
    },
    [
      agenticRunTree?.runId,
      agenticRunTree?.taskRevision,
      pushLocalNotice,
      refreshOrchestrationRun,
      resolveAgenticRunTree,
    ],
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
        approvalsSummary:
          approvalsCount > 0 ? `${approvalsCount} decision${approvalsCount === 1 ? "" : "s"}` : "Decisions clear",
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
  const historicalTargetIsSelected =
    historicalWindowTarget?.workspaceId === workspaceId && historicalWindowTarget.sessionId === selectedSessionId;
  const historicalModeActive =
    historicalTargetIsSelected && Boolean(historicalWindow || historicalWindowLoading || historicalWindowError);
  const canSend =
    Boolean(resolveOutboundDraftContent(draft, pendingAttachments.length, editingTurnId ? "edit" : "send")) &&
    !sending &&
    !pendingApproval &&
    !pendingUserInput &&
    !routeBlocked &&
    !routePreflightPending &&
    !routePreflightUnavailable &&
    !historicalModeActive &&
    // HX-411: external control owns the mutation generation → operator send fails closed.
    !sessionControlSendLocked &&
    (!routeBoundaryAckRequired || currentRouteBoundaryAcknowledged);
  const blockHistoricalMutation = useCallback(() => {
    if (!historicalModeActive) return false;
    pushLocalNotice("Return to the latest conversation before changing or sending anything.", "warning");
    return true;
  }, [historicalModeActive, pushLocalNotice]);

  const handleSelectSessionFromRail = useCallback(
    (sessionId: string, options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord }) => {
      const openRequestedHistory = () => {
        if (options?.searchHit) {
          void openHistoricalWindow(sessionId, options.searchHit);
        } else {
          returnToLatest();
        }
      };
      if (sessionId === selectedSessionId) {
        openRequestedHistory();
        setSelectedTurnId(options?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
        return;
      }
      guardWorkbenchNavigation(() => {
        setSelectedSessionId(sessionId);
        openRequestedHistory();
        setSelectedTurnId(options?.turnId ?? null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setActiveGeneratedArtifact(null);
        setSessionRailOpen(false);
      }, "Switching sessions will discard the unsaved editor changes in the current Code workbench file.");
    },
    [
      guardWorkbenchNavigation,
      openHistoricalWindow,
      returnToLatest,
      selectedSessionId,
      setSelectedSessionId,
      setSelectedTurnId,
    ],
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
        const baselinePrefs =
          previousPrefs?.sessionId === sessionId ? previousPrefs : await fetchChatSessionPrefs(sessionId);
        const updated = await updateChatSessionPrefs(sessionId, {
          ...patch,
          expectedRevision: baselinePrefs.revision,
        });
        if (prefMutationSequenceRef.current !== mutationId) {
          return updated;
        }
        if (shouldSyncLocalState) {
          prefsRef.current = updated;
          setPrefs(updated);
        }
        setPreferenceConflictDraft((current) => (current?.sessionId === sessionId ? null : current));
        return updated;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
          const latestPrefs = await fetchChatSessionPrefs(sessionId);
          await refreshChatSessionAggregate(sessionId);
          if (shouldSyncLocalState) {
            prefsRef.current = latestPrefs;
            setPrefs(latestPrefs);
          }
          setPreferenceConflictDraft({ sessionId, patch });
          setUiError(
            "This chat changed elsewhere. Canonical preferences were refreshed; your unsaved preference draft is preserved for review and retry.",
          );
          throw err;
        }
        if (prefMutationSequenceRef.current === mutationId && previousPrefs) {
          prefsRef.current = previousPrefs;
          setPrefs(previousPrefs);
        }
        setUiError((err as Error).message);
        throw err;
      }
    },
    [prefsRef, refreshChatSessionAggregate, selectedSession, setPrefs],
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
  const handleRetryPreferenceDraft = useCallback(async () => {
    if (!preferenceConflictDraft) return;
    try {
      await applyPrefPatchToSession(preferenceConflictDraft.sessionId, preferenceConflictDraft.patch);
    } catch (_error) {
      // The mutation helper preserves the draft and surfaces the current error.
      void _error;
    }
  }, [applyPrefPatchToSession, preferenceConflictDraft]);
  const handleDiscardPreferenceDraft = useCallback(() => {
    setPreferenceConflictDraft(null);
    setUiError(null);
  }, [setUiError]);
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
        if (!selectedSession) {
          return;
        }
        const response = await setChatSessionGoal(selectedSessionId, {
          goal,
          turnBudget,
          expectedRevision: selectedSession.revision,
        });
        setPinnedGoal(response.goal ?? undefined);
        await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSessionId });
        pushLocalNotice(`Goal set: ${response.goal ?? goal}`, "success");
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.status === 409) {
          await refreshChatSessionAggregate(selectedSessionId);
          setUiError("This chat changed elsewhere. Your goal draft is preserved; review it and retry.");
        } else {
          setUiError(cause instanceof Error ? cause.message : "Failed to set goal.");
        }
      }
    },
    [
      historyView,
      loadSidebar,
      pushLocalNotice,
      refreshChatSessionAggregate,
      selectedSession,
      selectedSessionId,
      setUiError,
    ],
  );

  const handleClearGoal = useCallback(async () => {
    if (!selectedSessionId || !selectedSession) {
      return;
    }
    try {
      await clearChatSessionGoal(selectedSessionId, selectedSession.revision);
      setPinnedGoal(undefined);
      await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSessionId });
      pushLocalNotice("Goal cleared.", "success");
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        await refreshChatSessionAggregate(selectedSessionId);
        setUiError("This chat changed elsewhere. Review the latest goal, then clear it again.");
      } else {
        setUiError(cause instanceof Error ? cause.message : "Failed to clear goal.");
      }
    }
  }, [
    historyView,
    loadSidebar,
    pushLocalNotice,
    refreshChatSessionAggregate,
    selectedSession,
    selectedSessionId,
    setUiError,
  ]);

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
      const modelCouncil = consumeModelCouncilArming();
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
          ...(modelCouncil ? { modelCouncil } : {}),
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
    consumeModelCouncilArming,
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
    composerSendHandlerRef.current = async () => {
      if (historicalModeActive) {
        pushLocalNotice("Return to the latest conversation before sending a message.", "warning");
        return;
      }
      await handleSendWithKnowledge();
    };
  }, [handleSendWithKnowledge, historicalModeActive, pushLocalNotice]);

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
      onCreateSession: () => {
        if (!blockHistoricalMutation()) void handleCreateCurrentModeSession();
      },
      onSearchChange: setSearch,
      onProjectNameChange: setProjectName,
      onProjectPathChange: setProjectPath,
      onCreateProject: () => {
        if (!blockHistoricalMutation()) void handleCreateProject();
      },
      onHistoryViewChange: setHistoryView,
      onArchiveWorkspace: () => {
        if (!blockHistoricalMutation()) handleArchiveWorkspace();
      },
      onConfirmArchiveWorkspace: async () => {
        if (!blockHistoricalMutation()) await handleConfirmArchiveWorkspace();
      },
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
      blockHistoricalMutation,
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
        modelSwitchDisabled: !selectedSessionId || sending || historicalModeActive,
        sessionLifecycleStatus: selectedSession.lifecycleStatus,
        sessionArchivePending: sessionControlPending === "archive",
        dockOpen,
        onToggleDock: handleToggleDock,
        onToggleArchiveSession: () => {
          if (!blockHistoricalMutation()) void handleToggleArchiveSession();
        },
        onNavigateSurface: handleNavigateSurface,
        onModeOverride: (_mode: ChatMode) => {
          if (blockHistoricalMutation()) return;
          // A user-initiated override change: mark it so a later session switch
          // honors this explicit choice instead of snapping back to a URL seed.
          userAdjustedModeOverrideRef.current = true;
          setModeOverride("chat");
          onResolvedModeChange?.("chat", "manual-override");
        },
        modeOverridePending: modeOverride,
        onRequestProviderChange: (providerId) => {
          if (blockHistoricalMutation()) return;
          const provider = providerOptions.find((item) => item.providerId === providerId);
          const selection = resolveProviderModelSelection({
            provider,
            loadedModels: providerId ? getCachedModels(providerId) : [],
            selectedModel: undefined,
          });
          void loadModelsForProvider(providerId);
          requestThreadModelPatch({ providerId, model: selection.model ?? "" });
        },
        onRequestModelChange: (model) => {
          if (!blockHistoricalMutation()) requestThreadModelPatch({ model });
        },
        loading: messagesLoading,
        historicalWindow: historicalTargetIsSelected ? historicalWindow : null,
        historicalWindowLoading: historicalTargetIsSelected && historicalWindowLoading,
        historicalWindowError: historicalTargetIsSelected ? historicalWindowError : null,
        onReturnToLatest: returnToLatest,
        historicalContinuationLoading: historicalTargetIsSelected ? historicalContinuationLoading : null,
        historicalContinuationError: historicalTargetIsSelected ? historicalContinuationError : null,
        onLoadHistoricalContinuation: (direction) => void loadHistoricalContinuation(direction),
        historicalReadOnly: historicalModeActive,
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
        onStartNewThreadFromTurn: (turnId) => {
          if (!blockHistoricalMutation()) void handleStartNewThreadFromTurn(turnId);
        },
        onSwitchBranch: (turnId) => {
          if (!blockHistoricalMutation()) void handleSelectBranchTurnAndSync(turnId);
        },
        onRetryTurn: (turnId) => {
          if (!blockHistoricalMutation()) void handleRetryTurn(turnId);
        },
        onEditTurn: (turnId) => {
          if (!blockHistoricalMutation()) handleBeginEditTurn(turnId);
        },
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
        onCreateGeneratedArtifact: (turnId) => {
          if (!blockHistoricalMutation()) void handleCreateGeneratedArtifactFromTurn(turnId);
        },
        onCreateGeneratedArtifactVersion: (turnId) => {
          if (!blockHistoricalMutation()) {
            void handleCreateGeneratedArtifactFromTurn(turnId, { supersedeLatest: true });
          }
        },
        onOpenPersonalitiesSettings,
        onOpenLibraryArtifacts,
        onOpenOpsRuntime,
        onAcceptDelegation: async () => {
          if (!blockHistoricalMutation()) await handleAcceptDelegation();
        },
        onDismissDelegationSuggestion: () => setDelegationSuggestion(null),
        // Historical transcript reads are mutation-locked. Only stop/cancel
        // controls remain live as safety escapes; approvals and input do not.
        onApprovePending: (allowScope) => {
          if (!blockHistoricalMutation()) void handleApprovePending(allowScope);
        },
        onDenyPending: () => {
          if (!blockHistoricalMutation()) void handleDenyPending();
        },
        onOpenApprovals,
        onSubmitUserInput: (response) => {
          if (!blockHistoricalMutation()) void handleSubmitUserInput(response);
        },
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
        externalSourceControls:
          externalSourceAttachments.supported === true
            ? {
                attachments: externalSourceAttachments.attachments,
                selectedAttachmentIds: externalSourceAttachments.selectedAttachmentIds,
                busyAttachmentId: externalSourceAttachments.busyAttachmentId,
                canMutate: externalSourceAttachments.canMutate && !historicalModeActive,
                error: externalSourceAttachments.error,
                onToggleSelect: externalSourceAttachments.toggleSelection,
                onClearSelection: externalSourceAttachments.clearSelection,
                onAttach: (seed) => {
                  if (!blockHistoricalMutation()) void externalSourceAttachments.attach(seed);
                },
                onDetach: (attachmentId) => {
                  if (!blockHistoricalMutation()) void externalSourceAttachments.detach(attachmentId);
                },
                onRequestKnowledgeSnapshot: (attachmentId) => {
                  if (!blockHistoricalMutation()) void externalSourceAttachments.requestKnowledgeSnapshot(attachmentId);
                },
              }
            : null,
        presetOptions,
        selectedPresetId,
        presetApplyWarning,
        selectedTurnRecovery,
        selectedTurn,
        capabilityProfileInspection,
        selectedSessionId,
        currentWebMode: prefs?.webMode ?? "auto",
        currentReviewDepth: prefs?.orchestrationReviewDepth ?? "off",
        modelCouncilEnabled,
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
        sessionControlBanner: sessionControlBannerModel.externalControlActive
          ? {
              model: sessionControlBannerModel,
              onRevoke: handleSessionControlRevoke,
              onEmergencyTakeover: handleSessionControlEmergencyTakeover,
              actionPending: sessionControlActionPending,
              actionError: sessionControlActionError,
              statusError: sessionControlStatus.error,
            }
          : null,
        hasActiveStream: Boolean(activeStreamRef.current),
        activeStreamTurnAssigned: Boolean(activeStreamRef.current?.turnId),
        composerRef,
        fileInputRef,
        audioInputRef,
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: (event) => {
          if (blockHistoricalMutation()) {
            event.preventDefault();
            return;
          }
          handleDrop(event as Parameters<typeof handleDrop>[0]);
        },
        onResumeAll: () => {
          if (!blockHistoricalMutation()) handleResumeQueue();
        },
        onRemoveQueuedItem: (id) => {
          if (!blockHistoricalMutation()) handleRemoveQueuedItem(id);
        },
        onCancelEdit: handleCancelEdit,
        onDismissError: handleDismissError,
        onAcknowledgeRouteBoundary: acknowledgeCurrentRouteBoundary,
        onTogglePlanningMode: () => {
          if (!blockHistoricalMutation()) handleTogglePlanningMode();
        },
        onToggleResearchMode: () => {
          if (!blockHistoricalMutation()) handleToggleResearchMode();
        },
        onToggleReviewMode: () => {
          if (!blockHistoricalMutation()) handleToggleReviewMode();
        },
        onToggleModelCouncil: () => {
          if (!blockHistoricalMutation()) {
            const next = !modelCouncilEnabledRef.current;
            modelCouncilEnabledRef.current = next;
            setModelCouncilEnabled(next);
          }
        },
        onSetDeepMode: () => {
          if (!blockHistoricalMutation()) handleSetDeepMode();
        },
        onFullWebAccessChange: (value) => {
          if (!blockHistoricalMutation()) setFullWebAccess(value);
        },
        onSetThinkingLevel: (level) => {
          if (!blockHistoricalMutation()) void handlePrefPatch({ thinkingLevel: level });
        },
        onSetSpeedMode: (mode) => {
          if (!blockHistoricalMutation()) void handlePrefPatch({ speedMode: mode });
        },
        onSetSubagentPolicy: (policy) => {
          if (!blockHistoricalMutation()) void handlePrefPatch({ subagentPolicy: policy });
        },
        onReviewRunDetails: handleRevealSelectedTurnDetails,
        onDraftChange: (value) => {
          if (!blockHistoricalMutation()) setDraft(value);
        },
        onComposerKeyDown: (event) => {
          if (blockHistoricalMutation()) {
            event.preventDefault();
            return;
          }
          handleComposerKeyDown(event);
        },
        onComposerPaste: (event) => {
          if (blockHistoricalMutation()) {
            event.preventDefault();
            return;
          }
          handleComposerPaste(event);
        },
        onApplyDraftCommand: (command) => {
          if (!blockHistoricalMutation()) handleApplyDraftCommand(command);
        },
        onPresetChange: (value) => {
          if (!blockHistoricalMutation()) setSelectedPresetId(value);
        },
        onApplyPreset: () => {
          if (!blockHistoricalMutation()) void handleApplyPreset();
        },
        onDismissPresetWarning: () => setPresetApplyWarning(null),
        onSetAttachmentMode: (attachmentId, mode) => {
          if (!blockHistoricalMutation()) handleSetPendingAttachmentMode(attachmentId, mode);
        },
        onRemoveThreadKnowledgeAttachment: (attachmentId) => {
          if (!blockHistoricalMutation()) void handleRemoveThreadKnowledge(attachmentId);
        },
        knowledgeUrlDraft,
        knowledgeUrlMode,
        onKnowledgeUrlDraftChange: (value) => {
          if (!blockHistoricalMutation()) setKnowledgeUrlDraft(value);
        },
        onKnowledgeUrlModeChange: (value) => {
          if (!blockHistoricalMutation()) setKnowledgeUrlMode(value);
        },
        onAttachKnowledgeUrl: () => {
          if (!blockHistoricalMutation()) void handleAttachKnowledgeUrl();
        },
        onRemoveAttachment: (attachmentId) => {
          if (!blockHistoricalMutation()) handleRemoveAttachment(attachmentId);
        },
        onAttachFiles: () => {
          if (!blockHistoricalMutation()) fileInputRef.current?.click();
        },
        onUploadFiles: (files) => {
          if (!blockHistoricalMutation()) handleUploadFiles(files);
        },
        onRunQuickResearch: () => {
          if (!blockHistoricalMutation()) void handleRunQuickResearch();
        },
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
        imageRouteSwitchDisabled: !selectedSessionId || sending || historicalModeActive,
        imageRouteLabel,
        onRequestImageProviderChange: (providerId) => {
          if (blockHistoricalMutation()) return;
          const provider = imageProviderOptions.find((item) => item.providerId === providerId);
          void loadModelsForProvider(providerId);
          void handlePrefPatch({
            imageProviderId: providerId,
            imageModel: provider?.defaultModel ?? provider?.models[0] ?? "",
          });
        },
        onRequestImageModelChange: (model) => {
          if (blockHistoricalMutation()) return;
          void handlePrefPatch({
            imageProviderId: selectedImageProviderId ?? "",
            imageModel: model,
          });
        },
        onToggleLiveVoice: () => {
          if (!blockHistoricalMutation()) void handleToggleLiveVoice();
        },
        onToggleLiveVoiceMute: () => {
          if (!blockHistoricalMutation()) handleToggleLiveVoiceMute();
        },
        onToggleVoiceTalk: () => {
          if (!blockHistoricalMutation()) void handleToggleVoiceTalk();
        },
        onOpenAudioTranscribe: () => {
          if (!blockHistoricalMutation()) handleOpenAudioTranscribe();
        },
        onAudioFileSelected: (files) => {
          if (!blockHistoricalMutation()) handleAudioFileSelected(files);
        },
        onToggleSpeakResponses: () => {
          if (!blockHistoricalMutation()) setSpeakResponsesEnabled((current) => !current);
        },
        onGenerateImage: () => {
          if (!blockHistoricalMutation()) void handleGenerateImage();
        },
        onEditImage: () => {
          if (!blockHistoricalMutation()) void handleEditImage();
        },
        activeGeneratedArtifact,
        onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
        onStopActiveTurn: () => void handleStopActiveTurn(),
        onSend: () => void handleComposerSend(),
        coworkStopRunControl: resolveCoworkComposerStopControl({
          mode: messageMode,
          delegationRunStatus: visibleDelegationRun?.status,
          controls: coworkViewModel.agenticRuntime?.controls,
        }),
        onCoworkStopRun: (control) => {
          if (historicalModeActive && control.action !== "cancel") {
            blockHistoricalMutation();
            return;
          }
          void handleAgenticControl(control);
        },
        coworkStopRunPending: agenticControlPending === "cancel",
        pinnedGoal,
        midTurnDisposition: resolveMidTurnDisposition({
          hasActiveStream: Boolean(activeStreamRef.current),
          draft,
        }),
        onSteerMidTurn: async (instruction) => {
          if (!blockHistoricalMutation()) await handleSteerMidTurn(instruction);
        },
        onSetGoal: async (goal, turnBudget) => {
          if (!blockHistoricalMutation()) await handleSetGoal(goal, turnBudget);
        },
        onClearGoal: async () => {
          if (!blockHistoricalMutation()) await handleClearGoal();
        },
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
    onCreateSession: () => {
      if (!blockHistoricalMutation()) void handleCreateCurrentModeSession();
    },
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
            onRetryTurn: activeWorkflowTurn
              ? () => {
                  if (!blockHistoricalMutation()) void handleRetryTurn(activeWorkflowTurn.turnId);
                }
              : undefined,
            onStopTurn:
              activeWorkflowTurn && isChatTurnActiveStatus(activeWorkflowTurn.trace.status)
                ? () => void handleStopActiveTurn()
                : undefined,
            onOpenTasks,
            onOpenDetails: () => handleRevealActiveTurnDetails(),
            onFocusComposer: () => composerRef.current?.focus(),
            onRefreshRunState: () => void refreshOrchestrationRun(),
            onAgenticControl: (control) => {
              if (historicalModeActive && control.action !== "cancel") {
                blockHistoricalMutation();
                return;
              }
              void handleAgenticControl(control);
            },
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
                if (!blockHistoricalMutation()) await handleAssignProject(projectId);
              },
              onImportProjectSource: async (input) => {
                if (!blockHistoricalMutation()) await handleImportCodeProject(input);
              },
              onCreateWorktree: () => {
                if (!blockHistoricalMutation()) void createWorkbenchWorktree(workbenchState?.baseRef);
              },
              onSelectFile: (relativePath) => void openWorkbenchFile(relativePath),
              onDraftChange: (nextValue) => {
                if (!blockHistoricalMutation()) setWorkbenchDraftContent(nextValue);
              },
              onExpandedPathsChange: (nextPaths) => setWorkbenchExpandedPaths(nextPaths),
              onRefresh: () => void refreshWorkbench(),
              onSaveFile: () => {
                if (!blockHistoricalMutation()) void saveWorkbenchFile();
              },
              onFileOperation: async (input) => {
                if (blockHistoricalMutation()) return false;
                return runWorkbenchFileOperation(input);
              },
              onDiscardDraft: () => {
                if (!blockHistoricalMutation()) discardWorkbenchDraft();
              },
              onRunValidationCommand: (input) => {
                if (!blockHistoricalMutation()) void runWorkbenchValidationCommand(input);
              },
              onApplyPatch: (patch) => {
                if (!blockHistoricalMutation()) void applyWorkbenchPatch(patch);
              },
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
              onRevertFile: (relativePath) => {
                if (!blockHistoricalMutation()) void revertWorkbenchFile(relativePath);
              },
              onRevertAll: () => {
                if (!blockHistoricalMutation()) void revertWorkbenchAll();
              },
              onRunHelperSnippet: (language, source) => {
                if (!blockHistoricalMutation()) void handleRunCodeHelper(language, source);
              },
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
      onAttachFiles: () => {
        if (!blockHistoricalMutation()) fileInputRef.current?.click();
      },
      onUploadFiles: (files) => {
        if (!blockHistoricalMutation()) handleUploadFiles(files);
      },
      onDragEnter: handleDragEnter as DragEventHandler<HTMLElement>,
      onDragOver: handleDragOver as DragEventHandler<HTMLElement>,
      onDragLeave: handleDragLeave as DragEventHandler<HTMLElement>,
      onDrop: ((event) => {
        if (blockHistoricalMutation()) {
          event.preventDefault();
          return;
        }
        handleDrop(event as Parameters<typeof handleDrop>[0]);
      }) as DragEventHandler<HTMLElement>,
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
          onStreamEnabledChange: (value) => {
            if (!blockHistoricalMutation()) setStreamEnabled(value);
          },
          onVisualStreamModeChange: (value) => {
            if (!blockHistoricalMutation()) setVisualStreamMode(value);
          },
          prefs,
          preferenceConflictDraft:
            preferenceConflictDraft?.sessionId === selectedSession.sessionId ? preferenceConflictDraft.patch : null,
          onRetryPreferenceConflictDraft: async () => {
            if (!blockHistoricalMutation()) await handleRetryPreferenceDraft();
          },
          onDiscardPreferenceConflictDraft: handleDiscardPreferenceDraft,
          selectedSessionId,
          showTracePanel,
          selectedTurn,
          capabilityProfileInspection,
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
          proactivePolicyDraft,
          proactivePolicyConflict,
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
          onPrefPatch: async (patch) => {
            if (!blockHistoricalMutation()) await handlePrefPatch(patch);
          },
          onSuggestDelegation: async () => {
            if (!blockHistoricalMutation()) await handleSuggestDelegation();
          },
          onTriggerProactive: async () => {
            if (!blockHistoricalMutation()) await handleTriggerProactive();
          },
          onProactivePolicyPatch: async (patch) => {
            if (!blockHistoricalMutation()) await handleProactivePolicyPatch(patch);
          },
          onRunCodeDelegation: async (presetKey) => {
            if (!blockHistoricalMutation()) await handleRunCodeDelegation(presetKey);
          },
          onCapabilitySuggestionAction: (suggestion) => {
            if (!blockHistoricalMutation()) handleCapabilitySuggestionAction(suggestion);
          },
          onCreateSpecialistDraft: async (suggestion) => {
            if (!blockHistoricalMutation()) await handleCreateSpecialistDraft(suggestion);
          },
          onActivateCatalogSpecialist: async (suggestion) => {
            if (!blockHistoricalMutation()) await handleActivateCatalogSpecialist(suggestion);
          },
          onSpecialistCandidatePatch: async (candidateId, patch, notice) => {
            if (!blockHistoricalMutation()) await handleSpecialistCandidatePatch(candidateId, patch, notice);
          },
          onAcceptDelegation: async () => {
            if (!blockHistoricalMutation()) await handleAcceptDelegation();
          },
          onRebuildLearnedMemory: async () => {
            if (!blockHistoricalMutation()) await handleRebuildLearnedMemory();
          },
          onUpdateMemoryStatus: async (itemId, status) => {
            if (!blockHistoricalMutation()) await handleMemoryStatusUpdate(itemId, status);
          },
          onCloseGeneratedArtifact: handleCloseGeneratedArtifact,
          onRenameTitleChange: (value) => {
            if (!blockHistoricalMutation()) handleRenameTitleChange(value);
          },
          renameTitle,
          folderName,
          onFolderNameChange: (value) => {
            if (!blockHistoricalMutation()) handleFolderNameChange(value);
          },
          tagsValue,
          onTagsValueChange: (value) => {
            if (!blockHistoricalMutation()) handleTagsValueChange(value);
          },
          onRenameSession: async () => {
            if (!blockHistoricalMutation()) await handleRenameSession();
          },
          onSaveOrganization: async () => {
            if (!blockHistoricalMutation()) await handleSaveOrganization();
          },
          onTogglePinSession: async () => {
            if (!blockHistoricalMutation()) await handleTogglePinSession();
          },
          onToggleArchiveSession: async () => {
            if (!blockHistoricalMutation()) await handleToggleArchiveSession();
          },
          onDeleteSession: () => {
            if (!blockHistoricalMutation()) handleDeleteSession(formatSessionLabel(selectedSession));
          },
          onAssignProject: async (value) => {
            if (!blockHistoricalMutation()) await handleAssignProject(value);
          },
          onExportSnapshot: handleExportSessionSnapshot,
          onExportRunBundle: handleExportRunBundle,
          onIntegrationConnectionIdChange: (value) => {
            if (!blockHistoricalMutation()) setIntegrationConnectionId(value);
          },
          onIntegrationTargetChange: (value) => {
            if (!blockHistoricalMutation()) setIntegrationTarget(value);
          },
          onSaveExternalBinding: async () => {
            if (!blockHistoricalMutation()) await handleSaveExternalBinding();
          },
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
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmCapabilitySuggestion();
        }}
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
          if (blockHistoricalMutation()) {
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
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmDeleteSession();
        }}
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
        onConfirm={async () => {
          if (!blockHistoricalMutation()) await handleConfirmArchiveWorkspace();
        }}
      />
    </section>
  );
}

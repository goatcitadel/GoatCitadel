import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatMessageRecord,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatThreadResponse,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChatErrorSource } from "./chat-error-copy";
import type { PendingApprovalRecord } from "./chat-pending-approval";
import type { PendingUserInputRecord } from "./chat-pending-user-input";
import type { ChatVisualStreamMode } from "./chat-streaming-preview";
import type { ChatHistoryView, ChatSidebarLoadOptions } from "./useChatSessionData";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

export type PendingApprovalState = PendingApprovalRecord;
export type PendingUserInputState = PendingUserInputRecord;

export interface ActiveChatStreamState {
  sessionId: string;
  streamToken: string;
  controller: AbortController;
  turnId?: string;
  lastEventId?: string;
  /** Highest server sequence successfully processed; used to drop replayed/out-of-order chunks on resume. */
  lastSequence?: number;
  runId?: string;
}

export type ChatThreadCommitter = (
  updater: ChatThreadResponse | null | ((current: ChatThreadResponse | null) => ChatThreadResponse | null),
) => void;

export type ChatOutboundErrorSetter = (value: string | null, source?: ChatErrorSource) => void;

export interface UseChatOutboundSessionConfig {
  surfaceMode?: ChatSessionPrefsRecord["mode"];
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  prefs: ChatSessionPrefsRecord | null;
  fullWebAccess?: boolean;
  selectedProviderId?: string;
  selectedModel?: string;
}

export interface UseChatOutboundStreamConfig {
  streamEnabled: boolean;
  visualStreamMode?: ChatVisualStreamMode;
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
}

export interface UseChatOutboundStateConfig {
  sending: boolean;
  error: string | null;
  queuedOutbound: OutboundQueueItem[];
  thread: ChatThreadResponse | null;
  messages: ChatMessageRecord[];
}

export interface UseChatOutboundStateSetters {
  setThread: Dispatch<SetStateAction<ChatThreadResponse | null>>;
  setError: ChatOutboundErrorSetter;
  setSending: (value: boolean) => void;
  setDraft: Dispatch<SetStateAction<string>>;
  setPendingAttachments: Dispatch<SetStateAction<ChatAttachmentRecord[]>>;
  setEditingTurnId: (value: string | null) => void;
  setCapabilitySuggestions: (
    value:
      | ChatCapabilityUpgradeSuggestion[]
      | ((current: ChatCapabilityUpgradeSuggestion[]) => ChatCapabilityUpgradeSuggestion[]),
  ) => void;
  setSpecialistSuggestions: (
    value:
      | ChatSpecialistCandidateSuggestionRecord[]
      | ((current: ChatSpecialistCandidateSuggestionRecord[]) => ChatSpecialistCandidateSuggestionRecord[]),
  ) => void;
}

export interface UseChatOutboundOperations {
  loadSidebar: (nextHistoryView?: ChatHistoryView, options?: ChatSidebarLoadOptions) => Promise<void>;
  loadSessionCoreState: (
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>;
  ensureSession: () => Promise<ChatSessionRecord>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  handleCommandExecution: (sessionId: string, commandText: string) => Promise<void>;
}

export interface UseChatOutboundRefs {
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
}

export interface UseChatOutboundRouting {
  ensureFreshRoutePreflight: (input: {
    sessionId?: string | null;
    action: OutboundQueueItem["action"];
    turnId?: string | null;
    force?: boolean;
  }) => Promise<RoutingPreflightResult | null>;
  isRoutePreflightAcknowledged: (hash: string) => boolean;
}

export interface UseChatOutboundExecutionInput {
  sessionConfig: UseChatOutboundSessionConfig;
  streamConfig: UseChatOutboundStreamConfig;
  stateConfig: UseChatOutboundStateConfig;
  stateSetters: UseChatOutboundStateSetters;
  operations: UseChatOutboundOperations;
  refs: UseChatOutboundRefs;
  routing: UseChatOutboundRouting;
}

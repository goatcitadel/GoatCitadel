// Transport fixtures for the actual-owner first-send composition regression.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { vi } from "vitest";
import type { ChatAttachmentRecord, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import {
  captureOutboundRequestPrefsSnapshot,
  useChatOutboundExecution,
  type ActiveChatStreamState,
} from "../useChatOutboundExecution";
import { useChatSurfaceOrchestration, type OutboundQueueItem } from "../useChatSurfaceOrchestration";
import {
  useChatSessionControls,
  type SessionMetadataConflictDraft,
  type InitialOutboundSessionCreation,
} from "../useChatSessionControls";
import { useChatSessionRestoration } from "./useChatSessionRestoration";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  fetchChatSessionStatus: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  fetchChatPendingApprovals: vi.fn(),
  fetchChatSessionGoal: vi.fn(),
  loadSidebar: vi.fn(),
  loadSessionCoreState: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  createChatSession: api.createChatSession,
  fetchChatSessionStatus: api.fetchChatSessionStatus,
  sendAgentChatMessage: api.sendAgentChatMessage,
  fetchChatPendingApprovals: api.fetchChatPendingApprovals,
  fetchChatSessionGoal: api.fetchChatSessionGoal,
}));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: vi.fn(),
  createCorrelationId: () => "first-send-proof",
  setDevDiagnosticsActiveChatSession: vi.fn(),
  setDevDiagnosticsLatestTraceSummary: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-stream-activity-store", () => ({
  recordChatStreamChunkActivity: vi.fn(),
  clearChatStreamActivity: vi.fn(),
}));

const noop = () => undefined;
const CREATED: ChatSessionRecord = {
  sessionId: "session-created",
  revision: 1,
  sessionKey: "mission:first-send",
  workspaceId: "workspace-first",
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "local",
  updatedAt: "2026-09-30T12:00:00.000Z",
  lastActivityAt: "2026-09-30T12:00:00.000Z",
  tokenTotal: 0,
  costUsdTotal: 0,
};
const FIRST_ROUTE = { providerId: "provider-first", model: "model-first", fullWebAccess: false };
const QUEUED_ROUTE = { providerId: "provider-queued", model: "model-queued", fullWebAccess: true };
const LATER_ROUTE = { providerId: "provider-later", model: "model-later", fullWebAccess: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type HarnessHandle = {
  send: () => Promise<void>;
  setDraft: (text: string) => void;
  setRoute: (route: typeof FIRST_ROUTE) => void;
  resumeQueue: () => void;
  queue: OutboundQueueItem[];
  sessionId: string | null;
  sending: boolean;
  error: string | null;
  draft: string;
  navigate: (sessionId: string, workspaceId?: string) => void;
  getCreation: () => InitialOutboundSessionCreation | null;
  markCreation: (creation: InitialOutboundSessionCreation | null) => void;
};
let latest: HarnessHandle;

/** Actual session, queue, execution, and restoration owners in their Host order; only transport is mocked. */
function Harness({ sendOnAssignment = false }: { sendOnAssignment?: boolean }) {
  const [workspaceId, setWorkspaceId] = useState(CREATED.workspaceId!);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSessionRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [thread, setThread] = useState<ChatThreadResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(FIRST_ROUTE);
  const queuedSetterRef = useRef<React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>>(noop);
  const executeRef = useRef<(item: OutboundQueueItem) => Promise<void>>(async () => undefined);
  const admissionRef = useRef(() => false);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const applyFetchedThreadRef = useRef(() => false);
  const messageMutationVersionRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const noticeRef = useRef(noop);
  const conflictRef = useRef<SessionMetadataConflictDraft | null>(null);
  const initialOutboundSessionCreationRef = useRef<InitialOutboundSessionCreation | null>(null);
  const loadSessionRef = useRef(api.loadSessionCoreState);
  const sessions = useChatSessionControls({
    workspaceId,
    initialOutboundSessionCreationRef,
    historyView: "active",
    sessionMode: "chat",
    selectedProjectId: "all",
    selectedSessionId: sessionId,
    selectedSession: session,
    renameTitle: "",
    folderName: "",
    tagsValue: "",
    setSelectedProjectId: noop,
    setSelectedSessionId: setSessionId,
    setHistoryView: noop,
    setError,
    setSending,
    setQueuedOutbound: (value) => queuedSetterRef.current(value),
    setThread,
    setSessions: noop,
    loadSidebar: api.loadSidebar,
    onSessionCreated: setSession,
    setBinding: noop,
  });
  const orchestration = useChatSurfaceOrchestration({
    draft,
    pendingAttachments: attachments,
    selectedSessionId: sessionId,
    thread,
    sending,
    composerRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef: admissionRef,
    executeOutboundItemRef: executeRef,
    pushLocalNoticeRef: noticeRef,
    setDraft,
    setPendingAttachments: setAttachments,
    setPendingApproval: noop,
    setPendingUserInput: noop,
    setError,
    captureOutboundRequestPrefs: () =>
      captureOutboundRequestPrefsSnapshot({
        prefs: null,
        selectedProviderId: route.providerId,
        selectedModel: route.model,
        fullWebAccess: route.fullWebAccess,
      }),
    loadSessionCoreStateRef: loadSessionRef,
    abortActiveChatStream: noop,
  });
  useEffect(() => {
    queuedSetterRef.current = orchestration.setQueuedOutbound;
  }, [orchestration.setQueuedOutbound]);
  useChatOutboundExecution({
    sessionConfig: {
      selectedSessionId: sessionId,
      selectedSession: session,
      prefs: null,
      selectedProviderId: route.providerId,
      selectedModel: route.model,
      fullWebAccess: route.fullWebAccess,
    },
    streamConfig: { streamEnabled: false, activeStreamRef },
    stateConfig: { sending, error, queuedOutbound: orchestration.queuedOutbound, thread, messages: [] },
    stateSetters: {
      setThread,
      setError,
      setSending,
      setDraft,
      setPendingAttachments: setAttachments,
      setEditingTurnId: orchestration.setEditingTurnId,
      setCapabilitySuggestions: noop,
      setSpecialistSuggestions: noop,
    },
    operations: {
      loadSidebar: api.loadSidebar,
      loadSessionCoreState: api.loadSessionCoreState,
      ensureSession: sessions.ensureSession,
      pushLocalNotice: noop,
      handleCommandExecution: async () => undefined,
    },
    refs: {
      executeOutboundItemRef: executeRef,
      tryBeginOutboundExecutionRef: admissionRef,
      applyFetchedThreadRef,
      messageMutationVersionRef,
    },
    routing: { ensureFreshRoutePreflight: api.preflight, isRoutePreflightAcknowledged: () => false },
  });

  // A user action can arrive after the assignment render but before passive scoped hydration.
  const sentOnAssignment = useRef(false);
  useLayoutEffect(() => {
    if (sendOnAssignment && sessionId && !sentOnAssignment.current) {
      sentOnAssignment.current = true;
      void orchestration.handleSend();
    }
  }, [orchestration, sendOnAssignment, sessionId]);
  useChatSessionRestoration({
    workspaceId,
    initialOutboundSessionCreationRef,
    selection: { selectedSessionId: sessionId },
    orchestration,
    sessionData: { thread, generatedArtifacts: null },
    draft,
    pendingAttachments: attachments,
    setDraft,
    setPendingAttachments: setAttachments,
    setPinnedGoal: noop,
    setPendingAttachmentModes: noop,
    activeGeneratedArtifact: null,
    setActiveGeneratedArtifact: noop,
    STREAM_PREF_KEY: "goatcitadel.chat.agent.stream.enabled",
    streamPreferences: { streamEnabled: false, visualStreamMode: "smooth" },
    metadataDraft: { sessionMetadataConflictDraftRef: conflictRef, setFolderName: noop, setTagsValue: noop },
    threadController: { selectedSession: session },
    setRenameTitle: noop,
  });
  latest = {
    send: orchestration.handleSend,
    setDraft,
    setRoute,
    resumeQueue: orchestration.handleResumeQueue,
    queue: orchestration.queuedOutbound,
    sessionId,
    sending,
    error,
    draft,
    navigate: (nextSessionId, nextWorkspaceId = workspaceId) => {
      setSessionId(nextSessionId);
      setSession(null);
      setWorkspaceId(nextWorkspaceId);
    },
    getCreation: () => initialOutboundSessionCreationRef.current,
    markCreation: (creation) => {
      initialOutboundSessionCreationRef.current = creation;
    },
  };
  return null;
}

export { api, CREATED, FIRST_ROUTE, QUEUED_ROUTE, LATER_ROUTE, deferred, Harness, latest };

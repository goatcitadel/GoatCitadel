import React, { useCallback, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useChatSessionData, type ChatHistoryView } from "./useChatSessionData";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchChatCommandCatalogMock = vi.fn();
const fetchChatGeneratedArtifactsMock = vi.fn();
const fetchChatHistoryWindowMock = vi.fn();
const fetchChatHistoryContinuationMock = vi.fn();
const fetchChatLearnedMemoryMock = vi.fn();
const fetchChatProjectsMock = vi.fn();
const fetchChatProactiveRunsMock = vi.fn();
const fetchChatProactiveStatusMock = vi.fn();
const fetchChatSessionBindingMock = vi.fn();
const fetchChatSessionGeneratedArtifactsMock = vi.fn();
const fetchChatSessionPrefsMock = vi.fn();
const fetchChatSessionsMock = vi.fn();
const fetchChatSessionSearchMock = vi.fn();
const fetchChatSpecialistCandidatesMock = vi.fn();
const fetchChatThreadMock = vi.fn();
const fetchMcpServersMock = vi.fn();
const fetchMcpTemplatesMock = vi.fn();
const fetchSettingsMock = vi.fn();
const fetchSkillsMock = vi.fn();
const fetchThreadKnowledgeAttachmentsMock = vi.fn();
const recordClientDiagnosticMock = vi.fn();
const recordChatRefreshPhaseMock = vi.fn();

let latestRefreshSubscription: {
  callback: (signal: any) => Promise<void> | void;
  options: { enabled?: boolean };
} | null = null;
let latestHarness: HarnessSnapshot | null = null;

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatCommandCatalog: (...args: unknown[]) => fetchChatCommandCatalogMock(...args),
  fetchChatGeneratedArtifacts: (...args: unknown[]) => fetchChatGeneratedArtifactsMock(...args),
  fetchChatHistoryWindow: (...args: unknown[]) => fetchChatHistoryWindowMock(...args),
  fetchChatHistoryContinuation: (...args: unknown[]) => fetchChatHistoryContinuationMock(...args),
  fetchChatLearnedMemory: (...args: unknown[]) => fetchChatLearnedMemoryMock(...args),
  fetchChatProjects: (...args: unknown[]) => fetchChatProjectsMock(...args),
  fetchChatProactiveRuns: (...args: unknown[]) => fetchChatProactiveRunsMock(...args),
  fetchChatProactiveStatus: (...args: unknown[]) => fetchChatProactiveStatusMock(...args),
  fetchChatSessionBinding: (...args: unknown[]) => fetchChatSessionBindingMock(...args),
  fetchChatSessionGeneratedArtifacts: (...args: unknown[]) => fetchChatSessionGeneratedArtifactsMock(...args),
  fetchChatSessionPrefs: (...args: unknown[]) => fetchChatSessionPrefsMock(...args),
  fetchChatSessions: (...args: unknown[]) => fetchChatSessionsMock(...args),
  fetchChatSessionSearch: (...args: unknown[]) => fetchChatSessionSearchMock(...args),
  fetchChatSpecialistCandidates: (...args: unknown[]) => fetchChatSpecialistCandidatesMock(...args),
  fetchChatThread: (...args: unknown[]) => fetchChatThreadMock(...args),
  fetchMcpServers: (...args: unknown[]) => fetchMcpServersMock(...args),
  fetchMcpTemplates: (...args: unknown[]) => fetchMcpTemplatesMock(...args),
  fetchSettings: (...args: unknown[]) => fetchSettingsMock(...args),
  fetchSkills: (...args: unknown[]) => fetchSkillsMock(...args),
  fetchThreadKnowledgeAttachments: (...args: unknown[]) => fetchThreadKnowledgeAttachmentsMock(...args),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: any) => Promise<void> | void, options: any) => {
    latestRefreshSubscription = { callback, options };
  },
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: (...args: unknown[]) => recordClientDiagnosticMock(...args),
}));

vi.mock("./chat-causality", () => ({
  recordChatRefreshPhase: (...args: unknown[]) => recordChatRefreshPhaseMock(...args),
}));

type UseChatSessionDataResult = ReturnType<typeof useChatSessionData>;

type HarnessSnapshot = {
  result: UseChatSessionDataResult;
  selectedSessionId: string | null;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  errors: string[];
  applyFetchedThread: ReturnType<typeof vi.fn>;
};

function makeSession(sessionId: string, title = sessionId): ChatSessionRecord {
  return {
    sessionId,
    title,
    scope: "mission",
    lifecycleStatus: "active",
    pinned: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  } as ChatSessionRecord;
}

function makeThread(sessionId: string): ChatThreadResponse {
  return {
    sessionId,
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "message-user",
          sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Open the plan",
          timestamp: "2026-05-01T00:00:00.000Z",
        },
        assistantMessage: {
          messageId: "message-assistant",
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: "Plan opened.",
          timestamp: "2026-05-01T00:00:01.000Z",
        },
        trace: {
          status: "completed",
          routing: {},
          toolRuns: [],
          capabilityUpgradeSuggestions: [],
          specialistCandidateSuggestions: [],
        },
      },
    ],
  } as ChatThreadResponse;
}

function setupApiDefaults() {
  fetchChatProjectsMock.mockResolvedValue({ items: [{ projectId: "project-1", name: "Mission" }], folders: [] });
  fetchChatSessionsMock.mockResolvedValue({ items: [makeSession("session-1"), makeSession("session-2")] });
  fetchChatSessionSearchMock.mockResolvedValue({ items: [] });
  fetchChatHistoryWindowMock.mockResolvedValue({
    anchor: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      messageId: "message-user",
      sequence: 1,
      state: "found",
    },
    items: [],
    hasOlder: false,
    hasNewer: false,
    truncated: false,
    droppedItems: 0,
    byteLength: 2,
  });
  fetchChatHistoryContinuationMock.mockResolvedValue({
    direction: "older",
    cursorState: "valid",
    items: [],
    snapshotMaxSequence: 1,
    hasMore: false,
    truncated: false,
    droppedItems: 0,
    byteLength: 2,
  });
  fetchSettingsMock.mockResolvedValue({
    llm: {
      providers: [{ providerId: "openai", enabled: true, models: [{ model: "gpt-5.5" }] }],
    },
  });
  fetchChatCommandCatalogMock.mockResolvedValue({ items: [{ command: "/plan", usage: "/plan", description: "Plan" }] });
  fetchSkillsMock.mockResolvedValue({ items: [{ skillId: "skill-1", name: "Planning", state: "enabled" }] });
  fetchMcpServersMock.mockResolvedValue({ items: [{ serverId: "server-1", name: "Files" }] });
  fetchMcpTemplatesMock.mockResolvedValue({ items: [{ templateId: "template-1", name: "GitHub", installed: false }] });
  fetchChatThreadMock.mockResolvedValue(makeThread("session-1"));
  fetchChatSessionBindingMock.mockResolvedValue({ item: { sessionId: "session-1", target: null } });
  fetchChatSessionPrefsMock.mockResolvedValue({
    sessionId: "session-1",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
  });
  fetchChatSessionGeneratedArtifactsMock.mockResolvedValue({ items: [{ artifactId: "artifact-session" }] });
  fetchThreadKnowledgeAttachmentsMock.mockResolvedValue({ items: [{ attachmentId: "knowledge-1" }] });
  fetchChatProactiveStatusMock.mockResolvedValue({ policy: { mode: "off" } });
  fetchChatProactiveRunsMock.mockResolvedValue({ items: [{ runId: "run-1", status: "completed" }] });
  fetchChatLearnedMemoryMock.mockResolvedValue({ items: [{ memoryId: "memory-1", content: "Remember this" }] });
  fetchChatSpecialistCandidatesMock.mockResolvedValue({ items: [{ candidateId: "candidate-1", title: "Analyst" }] });
  fetchChatGeneratedArtifactsMock.mockResolvedValue({ items: [{ artifactId: "artifact-global" }] });
}

function Harness(props: {
  workspaceId?: string;
  historyView?: ChatHistoryView;
  searchQuery?: string;
  initialSelectedSessionId?: string | null;
  runtimeLlmConfig?: any;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(props.initialSelectedSessionId ?? null);
  const errorsRef = useRef<string[]>([]);
  const hookResultRef = useRef<UseChatSessionDataResult | null>(null);
  const setError = useCallback((value: string | null) => {
    if (value) {
      errorsRef.current.push(value);
    }
  }, []);
  const applyFetchedThread = useRef(
    vi.fn((thread: ChatThreadResponse, _requestVersion: number | null) => {
      hookResultRef.current?.setThread(thread);
      return true;
    }),
  );
  const messageMutationVersionRef = useRef(42);
  const lastLocalPrefMutationAtRef = useRef(0);

  const result = useChatSessionData({
    workspaceId: props.workspaceId ?? "workspace-1",
    historyView: props.historyView ?? "active",
    searchQuery: props.searchQuery ?? "",
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig: props.runtimeLlmConfig ?? null,
    setError,
    applyFetchedThreadRef: applyFetchedThread,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
  });
  hookResultRef.current = result;
  latestHarness = {
    result,
    selectedSessionId,
    setSelectedSessionId,
    errors: errorsRef.current,
    applyFetchedThread: applyFetchedThread.current,
  };
  return null;
}

async function flushEffects(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("useChatSessionData", () => {
  beforeEach(() => {
    latestHarness = null;
    latestRefreshSubscription = null;
    vi.clearAllMocks();
    setupApiDefaults();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bootstraps sidebar runtime catalogs and selected-session state", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-bootstrap" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });

    expect(fetchChatProjectsMock).toHaveBeenCalledWith("all", 100, "workspace-bootstrap");
    expect(fetchChatSessionsMock).toHaveBeenCalledWith({
      scope: "all",
      view: "active",
      limit: 100,
      workspaceId: "workspace-bootstrap",
    });
    expect(fetchSettingsMock).toHaveBeenCalledTimes(1);
    expect(fetchChatCommandCatalogMock).toHaveBeenCalledTimes(1);
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(fetchMcpServersMock).toHaveBeenCalledTimes(1);
    expect(fetchMcpTemplatesMock).toHaveBeenCalledTimes(1);
    expect(latestHarness?.selectedSessionId).toBe("session-1");

    await act(async () => {
      await flushEffects();
    });

    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatSessionBindingMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatSessionPrefsMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatSessionGeneratedArtifactsMock).not.toHaveBeenCalled();
    expect(fetchThreadKnowledgeAttachmentsMock).toHaveBeenCalledTimes(1);
    expect(fetchThreadKnowledgeAttachmentsMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatProactiveStatusMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatProactiveRunsMock).toHaveBeenCalledWith("session-1", 30);
    expect(fetchChatLearnedMemoryMock).toHaveBeenCalledWith("session-1", 80);
    expect(fetchChatSpecialistCandidatesMock).toHaveBeenCalledWith("session-1", 80);
    expect(fetchChatGeneratedArtifactsMock).toHaveBeenCalledWith({ sessionId: "session-1", limit: 200 });
    expect(latestHarness?.applyFetchedThread).toHaveBeenCalledWith(makeThread("session-1"), 42);
    expect(latestHarness?.result.loading).toBe(false);
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    expect(latestHarness?.result.installedSkills).toHaveLength(1);
    expect(latestRefreshSubscription?.options.enabled).toBe(true);
  });

  it("uses search and archive limits and honors preferred session ids when reloading the sidebar", async () => {
    fetchChatSessionSearchMock.mockResolvedValueOnce({
      items: [
        { session: makeSession("archived-1"), matchedFields: [], hits: [] },
        { session: makeSession("archived-2"), matchedFields: [], hits: [] },
      ],
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          workspaceId="workspace-search"
          historyView="archived"
          searchQuery="release"
          initialSelectedSessionId="missing-session"
        />,
      );
      await flushEffects();
    });

    expect(fetchChatSessionSearchMock).toHaveBeenCalledWith({
      query: "release",
      mode: "discovery",
      view: "archived",
      limit: 250,
      workspaceId: "workspace-search",
      surface: undefined,
    });
    expect(fetchChatSessionsMock).not.toHaveBeenCalled();
    expect(latestHarness?.selectedSessionId).toBe("archived-1");

    fetchChatSessionSearchMock.mockResolvedValueOnce({
      items: [{ session: makeSession("archived-2"), matchedFields: [], hits: [] }],
    });
    await act(async () => {
      await latestHarness?.result.loadSidebar("archived", {
        bypassCache: true,
        preferredSessionId: "archived-2",
      });
    });

    expect(latestHarness?.selectedSessionId).toBe("archived-2");

    await act(async () => {
      renderer?.update(
        <Harness
          workspaceId="workspace-search"
          historyView="archived"
          searchQuery=""
          initialSelectedSessionId="archived-2"
        />,
      );
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.loadSidebar("archived", { bypassCache: true });
    });

    expect(fetchChatProjectsMock).toHaveBeenLastCalledWith("all", 150, "workspace-search");
  });

  it("appends sidebar pagination without reloading over the appended page", async () => {
    fetchChatSessionsMock.mockResolvedValueOnce({
      items: [makeSession("session-1"), makeSession("session-2")],
      nextCursor: "cursor-page-2",
    });

    await act(async () => {
      create(<Harness workspaceId="workspace-pagination" />);
      await flushEffects();
    });

    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual(["session-1", "session-2"]);
    expect(latestHarness?.result.sidebarNextCursor).toBe("cursor-page-2");

    fetchChatSessionsMock.mockResolvedValueOnce({
      items: [makeSession("session-2"), makeSession("session-3")],
      nextCursor: null,
    });
    const callsBeforeAppend = fetchChatSessionsMock.mock.calls.length;

    await act(async () => {
      await latestHarness?.result.loadSidebar("active", { append: true });
      await flushEffects();
    });

    expect(fetchChatSessionsMock).toHaveBeenCalledTimes(callsBeforeAppend + 1);
    expect(fetchChatSessionsMock).toHaveBeenLastCalledWith({
      scope: "all",
      view: "active",
      limit: 100,
      workspaceId: "workspace-pagination",
      cursor: "cursor-page-2",
    });
    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
    expect(latestHarness?.result.sidebarNextCursor).toBeNull();
  });

  it("fences stale sidebar success, failure, and loading finalizers", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-sidebar-race" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });

    let resolveOld!: (value: { items: ChatSessionRecord[] }) => void;
    let rejectOld!: (error: Error) => void;
    const oldResponse = new Promise<{ items: ChatSessionRecord[] }>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    fetchChatSessionsMock.mockReturnValueOnce(oldResponse);
    let oldLoad!: Promise<void>;
    await act(async () => {
      oldLoad = latestHarness!.result.loadSidebar("active", { bypassCache: true });
      await Promise.resolve();
    });

    fetchChatSessionsMock.mockResolvedValueOnce({ items: [makeSession("session-current")] });
    await act(async () => {
      await latestHarness?.result.loadSidebar("active", { bypassCache: true });
    });
    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual(["session-current"]);

    await act(async () => {
      resolveOld({ items: [makeSession("session-stale")] });
      await oldLoad;
    });
    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual(["session-current"]);
    expect(latestHarness?.result.sidebarLoadingMore).toBe(false);

    const staleFailure = new Promise<{ items: ChatSessionRecord[] }>((_resolve, reject) => {
      rejectOld = reject;
    });
    fetchChatSessionsMock.mockReturnValueOnce(staleFailure);
    let staleFailureLoad!: Promise<void>;
    await act(async () => {
      staleFailureLoad = latestHarness!.result.loadSidebar("active", { bypassCache: true });
      await Promise.resolve();
    });
    fetchChatSessionsMock.mockResolvedValueOnce({ items: [makeSession("session-newest")] });
    await act(async () => {
      await latestHarness?.result.loadSidebar("active", { bypassCache: true });
      rejectOld(new Error("stale sidebar failed"));
      await staleFailureLoad;
    });
    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual(["session-newest"]);
    expect(latestHarness?.errors).not.toContain("stale sidebar failed");
    expect(latestHarness?.result.sidebarLoadingMore).toBe(false);
  });

  it("fences competing historical hits and clears a pending hit when the selected session changes", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-1" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    const hit = (messageId: string, sequence: number) => ({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      messageId,
      sequence,
      excerpt: messageId,
      score: 1,
    });
    const windowFor = (messageId: string, sequence: number) => ({
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId,
        sequence,
        state: "found" as const,
      },
      items: [],
      hasOlder: false,
      hasNewer: false,
      truncated: false,
      droppedItems: 0,
      byteLength: 2,
    });
    let resolveFirst!: (value: ReturnType<typeof windowFor>) => void;
    let resolveSecond!: (value: ReturnType<typeof windowFor>) => void;
    fetchChatHistoryWindowMock
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = latestHarness!.result.openHistoricalWindow("session-1", hit("message-1", 1));
      second = latestHarness!.result.openHistoricalWindow("session-1", hit("message-2", 2));
      await Promise.resolve();
    });
    await act(async () => {
      resolveSecond(windowFor("message-2", 2));
      await second;
      resolveFirst(windowFor("message-1", 1));
      await first;
    });
    expect(latestHarness?.result.historicalWindow?.anchor.messageId).toBe("message-2");
    expect(latestHarness?.result.historicalWindowTarget).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });

    let resolvePending!: (value: ReturnType<typeof windowFor>) => void;
    fetchChatHistoryWindowMock.mockReturnValueOnce(new Promise((resolve) => (resolvePending = resolve)));
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = latestHarness!.result.openHistoricalWindow("session-1", hit("message-3", 3));
      latestHarness?.setSelectedSessionId("session-2");
      await flushEffects();
    });
    await act(async () => {
      resolvePending(windowFor("message-3", 3));
      await pending;
      await flushEffects();
    });
    expect(latestHarness?.selectedSessionId).toBe("session-2");
    expect(latestHarness?.result.historicalWindow).toBeNull();
    expect(latestHarness?.result.historicalWindowTarget).toBeNull();
    expect(latestHarness?.result.historicalWindowLoading).toBe(false);
  });

  it("fails closed before fetch when an exact hit identity does not belong to the selected row", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-1" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    fetchChatHistoryWindowMock.mockClear();
    let opened = true;
    await act(async () => {
      opened = await latestHarness!.result.openHistoricalWindow("session-1", {
        workspaceId: "workspace-1",
        sessionId: "session-collision",
        messageId: "colliding-message",
        sequence: 7,
        excerpt: "collision",
        score: 1,
      });
    });
    expect(opened).toBe(false);
    expect(fetchChatHistoryWindowMock).not.toHaveBeenCalled();
    expect(latestHarness?.result.historicalWindowError).toMatch(/does not belong/i);
  });

  it("merges exact older and newer continuation pages and surfaces stale cursors", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-1" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    const historyMessage = (sequence: number) => ({
      sequence,
      isAnchor: sequence === 3,
      message: {
        messageId: `message-${sequence}`,
        sessionId: "session-1",
        role: "assistant" as const,
        content: `message ${sequence}`,
        timestamp: `2026-05-01T00:00:0${sequence}.000Z`,
      },
    });
    const hit = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      messageId: "message-3",
      sequence: 3,
      excerpt: "message 3",
      score: 1,
    };
    const initialWindow = {
      anchor: { ...hit, state: "found" as const },
      items: [historyMessage(3)],
      snapshotMaxSequence: 5,
      hasOlder: true,
      hasNewer: true,
      olderCursor: { messageId: "message-3", sequence: 3, snapshotMaxSequence: 5 },
      newerCursor: { messageId: "message-3", sequence: 3, snapshotMaxSequence: 5 },
      truncated: false,
      droppedItems: 0,
      byteLength: 100,
    };
    fetchChatHistoryWindowMock.mockResolvedValueOnce(initialWindow);
    await act(async () => {
      await latestHarness!.result.openHistoricalWindow("session-1", hit);
    });
    fetchChatHistoryContinuationMock
      .mockResolvedValueOnce({
        direction: "older",
        cursorState: "valid",
        items: [historyMessage(1), historyMessage(2)],
        snapshotMaxSequence: 5,
        hasMore: false,
        truncated: false,
        droppedItems: 0,
        byteLength: 200,
      })
      .mockResolvedValueOnce({
        direction: "newer",
        cursorState: "valid",
        items: [historyMessage(4), historyMessage(5)],
        snapshotMaxSequence: 5,
        hasMore: false,
        truncated: false,
        droppedItems: 0,
        byteLength: 200,
      });
    await act(async () => {
      await latestHarness!.result.loadHistoricalContinuation("older");
      await latestHarness!.result.loadHistoricalContinuation("newer");
    });
    expect(latestHarness?.result.historicalWindow?.items.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);

    fetchChatHistoryWindowMock.mockResolvedValueOnce(initialWindow);
    await act(async () => {
      await latestHarness!.result.openHistoricalWindow("session-1", hit);
    });
    fetchChatHistoryContinuationMock.mockResolvedValueOnce({
      direction: "older",
      cursorState: "stale",
      items: [],
      snapshotMaxSequence: 5,
      hasMore: false,
      truncated: false,
      droppedItems: 0,
      byteLength: 2,
    });
    await act(async () => {
      await latestHarness!.result.loadHistoricalContinuation("older");
    });
    expect(latestHarness?.result.historicalContinuationError).toMatch(/stale/i);
    expect(latestHarness?.result.historicalWindow?.items.map((entry) => entry.sequence)).toEqual([3]);
  });

  it("refreshes view state through resolved refresh plans and reports failures", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-refresh" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    await act(async () => {
      await latestHarness?.result.refreshViewState({
        refreshSidebar: false,
        refreshSession: "none",
        showIndicator: true,
      });
    });

    const loadCountBeforeSignal = fetchChatSessionsMock.mock.calls.length;
    await act(async () => {
      await latestRefreshSubscription?.callback({
        eventId: "old-event",
        eventType: "session_updated",
        timestamp: 1,
        reason: "replay",
        source: "test",
      });
    });
    expect(fetchChatSessionsMock).toHaveBeenCalledTimes(loadCountBeforeSignal);
    expect(recordClientDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ignored_prebootstrap_signal" }),
    );

    await act(async () => {
      await latestRefreshSubscription?.callback({
        eventId: "fresh-event",
        eventType: "fallback_poll",
        timestamp: Date.now(),
        reason: "fallback_poll",
        source: "test",
      });
    });

    expect(recordChatRefreshPhaseMock).toHaveBeenCalledWith(expect.objectContaining({ phase: "plan_resolved" }));
    expect(recordChatRefreshPhaseMock).toHaveBeenCalledWith(expect.objectContaining({ phase: "plan_applied" }));
    expect(recordChatRefreshPhaseMock).toHaveBeenCalledWith(expect.objectContaining({ phase: "plan_completed" }));

    fetchChatProactiveStatusMock.mockRejectedValueOnce(new Error("secondary failed"));
    await act(async () => {
      await latestHarness?.result.refreshViewState({
        refreshSidebar: false,
        refreshSession: "light",
      });
    });
    expect(latestHarness?.errors).toContain("secondary failed");
  });

  it("resets selected-session data and applies runtime config overrides", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-reset" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });
    await act(async () => {
      renderer?.update(
        <Harness
          workspaceId="workspace-reset"
          initialSelectedSessionId="session-1"
          runtimeLlmConfig={{ providers: [{ providerId: "local", enabled: true }] }}
        />,
      );
      await flushEffects();
    });

    expect(latestHarness?.result.settings?.llm.providers[0]?.providerId).toBe("local");
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");

    await act(async () => {
      latestHarness?.setSelectedSessionId(null);
      await flushEffects();
    });
    renderer?.unmount();

    expect(latestHarness?.result.thread).toBeNull();
    expect(latestHarness?.result.prefs).toBeNull();
    expect(latestHarness?.result.generatedArtifacts).toBeNull();
    expect(latestHarness?.result.secondaryLoading).toBe(false);
  });

  it("ignores stale selected-session loads after the selection clears", async () => {
    let resolveThread!: (value: ChatThreadResponse) => void;
    fetchChatThreadMock.mockReturnValueOnce(
      new Promise<ChatThreadResponse>((resolve) => {
        resolveThread = resolve;
      }),
    );

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-stale-load" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });

    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-1");
    expect(latestHarness?.result.messagesLoading).toBe(true);

    await act(async () => {
      latestHarness?.setSelectedSessionId(null);
      await flushEffects();
    });

    const applyCountAfterClear = latestHarness?.applyFetchedThread.mock.calls.length ?? 0;
    expect(latestHarness?.result.thread).toBeNull();
    expect(latestHarness?.result.prefs).toBeNull();
    expect(latestHarness?.result.messagesLoading).toBe(false);

    await act(async () => {
      resolveThread(makeThread("session-1"));
      await flushEffects(6);
    });
    renderer?.unmount();

    expect(latestHarness?.applyFetchedThread).toHaveBeenCalledTimes(applyCountAfterClear);
    expect(latestHarness?.result.thread).toBeNull();
    expect(latestHarness?.result.prefs).toBeNull();
    expect(latestHarness?.result.generatedArtifacts).toBeNull();
    expect(latestHarness?.result.messagesLoading).toBe(false);
    expect(latestHarness?.result.secondaryLoading).toBe(false);
  });

  it("keeps the spinner up when a superseded load settles while the newer load is in flight", async () => {
    let resolveFirstThread!: (value: ChatThreadResponse) => void;
    let resolveSecondThread!: (value: ChatThreadResponse) => void;
    fetchChatThreadMock
      .mockReturnValueOnce(
        new Promise<ChatThreadResponse>((resolve) => {
          resolveFirstThread = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ChatThreadResponse>((resolve) => {
          resolveSecondThread = resolve;
        }),
      );

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-superseded-load" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-1");
    expect(latestHarness?.result.messagesLoading).toBe(true);

    await act(async () => {
      latestHarness?.setSelectedSessionId("session-2");
      await flushEffects();
    });
    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-2");
    expect(latestHarness?.result.messagesLoading).toBe(true);

    // Session 1's superseded load settling must not clear session 2's spinner.
    await act(async () => {
      resolveFirstThread(makeThread("session-1"));
      await flushEffects(6);
    });
    expect(latestHarness?.result.messagesLoading).toBe(true);
    expect(latestHarness?.result.thread).toBeNull();

    // The newest load clears the spinner when it settles.
    await act(async () => {
      resolveSecondThread(makeThread("session-2"));
      await flushEffects(6);
    });
    renderer?.unmount();
    expect(latestHarness?.result.messagesLoading).toBe(false);
    expect(latestHarness?.result.thread?.sessionId).toBe("session-2");
  });

  it("expires dev bootstrap cache entries and covers guarded/full refresh paths", async () => {
    vi.useFakeTimers();
    let resolveProjects!: (value: unknown) => void;
    fetchChatProjectsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    await act(async () => {
      create(<Harness workspaceId="workspace-cache" initialSelectedSessionId="session-1" />);
      await Promise.resolve();
    });
    const refreshPhaseCountBeforeInit = recordChatRefreshPhaseMock.mock.calls.length;
    await act(async () => {
      await latestHarness?.result.refreshViewState({
        refreshSidebar: true,
        refreshSession: "full",
        showIndicator: true,
      });
    });
    expect(recordChatRefreshPhaseMock).toHaveBeenCalledTimes(refreshPhaseCountBeforeInit);

    await act(async () => {
      resolveProjects({ items: [{ projectId: "project-1", name: "Mission" }], folders: [] });
      await flushEffects();
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    await act(async () => {
      await latestHarness?.result.loadSidebar("active");
      await latestHarness?.result.refreshViewState({
        refreshSidebar: false,
        refreshSession: "full",
        showIndicator: true,
      });
    });

    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-1");
    expect(recordChatRefreshPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "plan_completed",
        plan: expect.objectContaining({ refreshSession: "full" }),
      }),
    );
  });

  it("covers default session-load options, no-thread core refreshes, and secondary defaults", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-load-defaults" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });

    const threadFetchCount = fetchChatThreadMock.mock.calls.length;
    await act(async () => {
      await latestHarness?.result.loadSessionCoreState("session-1", { includeThread: false });
    });
    expect(fetchChatThreadMock).toHaveBeenCalledTimes(threadFetchCount);
    expect(fetchChatSessionBindingMock).toHaveBeenLastCalledWith("session-1");

    await act(async () => {
      await latestHarness?.result.loadSessionCoreState("session-1");
      await latestHarness?.result.loadSessionSecondaryState("session-1");
      await latestHarness?.result.loadSessionState("session-1");
    });

    expect(fetchChatThreadMock).toHaveBeenCalledWith("session-1");
    expect(fetchChatGeneratedArtifactsMock).toHaveBeenLastCalledWith({ sessionId: "session-1", limit: 200 });

    fetchChatSessionsMock.mockResolvedValueOnce({ items: [] });
    await act(async () => {
      await latestHarness?.result.loadSidebar("active", { bypassCache: true });
    });
    expect(latestHarness?.selectedSessionId).toBeNull();
  });
});

import React, { Activity, useCallback, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useChatSessionData, type ChatHistoryView } from "./useChatSessionData";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { useChatSessionControls } from "./useChatSessionControls";

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
const assignChatSessionProjectMock = vi.fn();
const assignmentErrors = vi.hoisted(() => ({ ApiRequestError: class extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
} }));
let latestAssignment: ReturnType<typeof useChatSessionControls>["handleAssignProject"] | null = null;

let latestRefreshSubscription: {
  callback: (signal: any) => Promise<void> | void;
  options: { enabled?: boolean };
} | null = null;
let latestHarness: HarnessSnapshot | null = null;

vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...await original<typeof import("@goatcitadel/mission-control-shared/api/client")>(),
  ApiRequestError: assignmentErrors.ApiRequestError,
  assignChatSessionProject: (...args: unknown[]) => assignChatSessionProjectMock(...args),
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
  viewIdentity?: string;
  workspaceId?: string;
  historyView?: ChatHistoryView;
  searchQuery?: string;
  initialSelectedSessionId?: string | null;
  routeSessionId?: string;
  runtimeLlmConfig?: any;
  assignmentControls?: boolean;
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
    viewIdentity: props.viewIdentity,
    routeSessionId: props.routeSessionId,
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
  return props.assignmentControls ? <AssignmentControls snapshot={latestHarness} workspaceId={props.workspaceId ?? "workspace-1"} /> : null;
}

function AssignmentControls({ snapshot, workspaceId }: { snapshot: HarnessSnapshot; workspaceId: string }) {
  const noop = () => undefined;
  const selected = snapshot.result.sessions?.items.find((item) => item.sessionId === snapshot.selectedSessionId);
  const controls = useChatSessionControls({ workspaceId, historyView: "active", sessionMode: "chat", selectedProjectId: "all",
    selectedSessionId: snapshot.selectedSessionId, selectedSession: selected ? { ...selected, workspaceId, revision: 7 } : null,
    renameTitle: "", folderName: "", tagsValue: "", setSelectedProjectId: noop, setSelectedSessionId: snapshot.setSelectedSessionId,
    setHistoryView: noop, setError: (message) => { if (message) snapshot.errors.push(message); }, setSending: noop,
    setQueuedOutbound: noop, setSessions: snapshot.result.setSessions, setThread: snapshot.result.setThread,
    loadSidebar: snapshot.result.loadSidebar, setBinding: snapshot.result.setBinding });
  latestAssignment = controls.handleAssignProject;
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
      // The rail shows each conversation's status from the list itself, not one status read per row.
      includeActivity: true,
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

  it("opens conversation discovery while optional runtime catalogs are still pending", async () => {
    // Expire the development-only catalog deduplication from earlier fixtures.
    vi.useFakeTimers();
    vi.advanceTimersByTime(5001);
    let resolveSkills!: (value: unknown) => void;
    fetchSkillsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSkills = resolve;
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-slow-catalog" />);
      await flushEffects(8);
    });
    expect(fetchSkillsMock).toHaveBeenCalledOnce();
    expect(latestHarness?.result.loading).toBe(false);
    expect(latestHarness?.selectedSessionId).toBe("session-1");
    expect(latestHarness?.result.installedSkills).toEqual([]);
    await act(async () => {
      resolveSkills({ items: [{ skillId: "late-skill" }] });
      await flushEffects(8);
    });
    expect(latestHarness?.result.installedSkills).toEqual([{ skillId: "late-skill" }]);
    await act(async () => renderer.unmount());
  });

  it("retains the mounted conversation during search but bootstraps a new workspace", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-retained-search" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });
    expect(latestHarness?.result.loading).toBe(false);
    let resolveSearch!: (value: unknown) => void;
    fetchChatSessionSearchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-retained-search" searchQuery="retain" />);
      await flushEffects();
    });
    expect(latestHarness?.result.loading).toBe(false);
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    await act(async () => {
      resolveSearch({ items: [{ session: makeSession("session-1"), matchedFields: [], hits: [] }] });
      await flushEffects();
    });
    expect(latestHarness?.result.loading).toBe(false);
    let resolveWorkspace!: (value: unknown) => void;
    fetchChatSessionsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWorkspace = resolve;
      }),
    );
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-new-bootstrap" />);
      await flushEffects();
    });
    expect(latestHarness?.result.loading).toBe(true);
    await act(async () => {
      resolveWorkspace({ items: [makeSession("session-1")] });
      await flushEffects();
    });
    expect(latestHarness?.result.loading).toBe(false);
    await act(async () => renderer.unmount());
  });

  it.each([false, true])(
    "refreshes first-send records without restoring the created selection (operator moved: %s)",
    async (moved) => {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Harness workspaceId={`workspace-created-${moved}`} initialSelectedSessionId="session-1" />);
        await flushEffects();
      });
      await act(async () => {
        await flushEffects();
      });
      let resolveRead!: (value: { items: ChatSessionRecord[] }) => void;
      fetchChatSessionsMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
      );
      await act(async () => {
        latestHarness!.setSelectedSessionId("created-session");
      });
      let refresh!: Promise<void>;
      await act(async () => {
        refresh = latestHarness!.result.loadSidebar("active", { bypassCache: true, preserveSelection: true });
      });
      if (moved)
        await act(async () => {
          latestHarness!.setSelectedSessionId("newer-selection");
        });
      await act(async () => {
        resolveRead({ items: [makeSession("created-session")] });
        await refresh;
      });
      expect(latestHarness!.result.sessions?.items.map((item) => item.sessionId)).toEqual(["created-session"]);
      expect(latestHarness!.selectedSessionId).toBe(moved ? "newer-selection" : "created-session");
      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it("withholds a late first-send sidebar refresh and retained callbacks after workspace ABA", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-origin" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });
    const oldLoad = latestHarness!.result.loadSidebar;
    let resolveRead!: (value: { items: ChatSessionRecord[] }) => void;
    fetchChatSessionsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = oldLoad("active", { bypassCache: true, preserveSelection: true });
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-destination" />);
      await flushEffects();
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-origin" />);
      await flushEffects();
    });
    const records = latestHarness!.result.sessions;
    const reads = fetchChatSessionsMock.mock.calls.length;
    await act(async () => {
      await oldLoad("active", { bypassCache: true, preserveSelection: true });
    });
    expect(fetchChatSessionsMock).toHaveBeenCalledTimes(reads);
    await act(async () => {
      resolveRead({ items: [makeSession("stale-created-session")] });
      await refresh;
    });
    expect(latestHarness!.result.sessions).toBe(records);
    expect(latestHarness!.selectedSessionId).not.toBe("stale-created-session");
    await act(async () => {
      renderer.unmount();
    });
    await oldLoad("active", { bypassCache: true });
    expect(fetchChatSessionsMock).toHaveBeenCalledTimes(reads);
  });

  it("uses search and archive limits and honors preferred session ids when reloading the sidebar", async () => {
    const activity = {
      observedAt: "2026-10-05T10:00:00.000Z",
      latestTurn: null,
      turnCounts: { queued: 0, running: 1, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 },
    };
    fetchChatSessionSearchMock.mockResolvedValueOnce({
      items: [
        { session: { ...makeSession("archived-1"), activity }, matchedFields: [], hits: [] },
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
      limit: 200,
      workspaceId: "workspace-search",
      surface: undefined,
      // Searched rows show their status from the results, not one status read per row.
      includeActivity: true,
    });
    expect(fetchChatSessionsMock).not.toHaveBeenCalled();
    expect(latestHarness?.selectedSessionId).toBe("archived-1");
    // The searched row keeps the activity its result carried, so the rail can show its status.
    expect(latestHarness?.result.sessions?.items[0]?.activity).toEqual(activity);

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
      includeActivity: true,
    }, { signal: expect.any(AbortSignal) });
    expect(latestHarness?.result.sessions?.items.map((item) => item.sessionId)).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
    expect(latestHarness?.result.sidebarNextCursor).toBeNull();
  });

  it("withholds a prior Citadel sidebar callback and late response after view ABA", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness workspaceId="workspace-citadel-aba" viewIdentity="citadel-a" initialSelectedSessionId="session-1" />,
      );
      await flushEffects();
    });
    const oldLoad = latestHarness!.result.loadSidebar;
    let resolveOld!: (value: { items: ChatSessionRecord[] }) => void;
    fetchChatSessionsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = oldLoad("active", { bypassCache: true, preserveSelection: true });
    });
    await act(async () => {
      renderer.update(
        <Harness workspaceId="workspace-citadel-aba" viewIdentity="citadel-b" initialSelectedSessionId="session-1" />,
      );
      await flushEffects();
    });
    await act(async () => {
      renderer.update(
        <Harness workspaceId="workspace-citadel-aba" viewIdentity="citadel-a" initialSelectedSessionId="session-1" />,
      );
      await flushEffects();
    });
    const calls = fetchChatSessionsMock.mock.calls.length;
    await act(async () => {
      await oldLoad("active", { bypassCache: true });
    });
    expect(fetchChatSessionsMock).toHaveBeenCalledTimes(calls);
    await act(async () => {
      resolveOld({ items: [makeSession("obsolete-citadel-session")] });
      await pending;
    });
    expect(latestHarness?.result.sessions?.items.some((item) => item.sessionId === "obsolete-citadel-session")).toBe(
      false,
    );
    expect(latestHarness?.selectedSessionId).toBe("session-1");
    await act(async () => {
      renderer.unmount();
    });
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

  it("reloads only the conversation list for another conversation's thread event", async () => {
    await act(async () => {
      create(<Harness workspaceId="workspace-other-session" initialSelectedSessionId="session-1" />);
      await flushEffects(8);
    });
    await act(async () => {
      await flushEffects(8);
    });
    const threads = fetchChatThreadMock.mock.calls.length;
    const otherSignal = {
      eventId: "other-thread",
      eventType: "chat_thread_updated",
      timestamp: Date.now() + 1_000,
      reason: "chat_thread_updated",
      source: "chat",
      sessionId: "session-2",
    };
    await act(async () => {
      await latestRefreshSubscription?.callback(otherSignal);
    });
    expect(fetchChatThreadMock).toHaveBeenCalledTimes(threads);
    // The list still reloads (its read itself is served by the dev bootstrap cache in this harness).
    expect(recordChatRefreshPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "plan_resolved",
        signal: expect.objectContaining({ eventId: "other-thread" }),
        plan: { refreshSidebar: true, refreshSession: "none" },
      }),
    );

    await act(async () => {
      await latestRefreshSubscription?.callback({ ...otherSignal, eventId: "own-thread", sessionId: "session-1" });
    });
    expect(fetchChatThreadMock).toHaveBeenCalledTimes(threads + 1);
  });

  it("recovers a missed durable completion on fallback and stops full polling once settled", async () => {
    const waiting = makeThread("session-1");
    waiting.turns[0]!.trace.status = "waiting_for_tool";
    fetchChatThreadMock.mockResolvedValue(waiting);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-resume-fallback" initialSelectedSessionId="session-1" />);
      await flushEffects();
    });
    expect(latestHarness?.result.thread?.turns[0]?.trace.status).toBe("waiting_for_tool");
    fetchChatThreadMock.mockResolvedValue(makeThread("session-1"));
    const before = fetchChatThreadMock.mock.calls.length;
    const signal = {
      eventType: "fallback_poll",
      timestamp: Date.now(),
      reason: "fallback_poll",
      source: "refresh-hook",
    };
    await act(async () => {
      await latestRefreshSubscription?.callback(signal);
      await flushEffects();
    });
    expect(fetchChatThreadMock).toHaveBeenCalledTimes(before + 1);
    expect(latestHarness?.result.thread?.turns[0]?.trace.status).toBe("completed");
    await act(async () => {
      await latestRefreshSubscription?.callback(signal);
      await flushEffects();
    });
    expect(fetchChatThreadMock).toHaveBeenCalledTimes(before + 1);
    renderer?.unmount();
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

  it("keeps a retained Chat's data when it is shown again, and re-reads in the background after 30 s", async () => {
    // Past the dev bootstrap cache of earlier tests, which is keyed on the real clock.
    const start = Date.now() + 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const view = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <Harness workspaceId="workspace-retained" />
      </Activity>
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(view("visible"));
      await flushEffects(8);
    });
    await act(async () => {
      await flushEffects(8);
    });
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    const counts = () => ({
      sessions: fetchChatSessionsMock.mock.calls.length,
      settings: fetchSettingsMock.mock.calls.length,
      thread: fetchChatThreadMock.mock.calls.length,
    });
    const first = counts();
    expect(first).toEqual({ sessions: 1, settings: 1, thread: 1 });

    // Away and back within the window: no reload at all.
    await act(async () => {
      renderer.update(view("hidden"));
      await flushEffects(8);
    });
    vi.setSystemTime(start + 20_000);
    await act(async () => {
      renderer.update(view("visible"));
      await flushEffects(8);
    });
    expect(counts()).toEqual(first);
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");

    // Back after the window: one background read each, with the conversation still shown meanwhile.
    await act(async () => {
      renderer.update(view("hidden"));
      await flushEffects(8);
    });
    vi.setSystemTime(start + 51_000);
    let releaseThread!: () => void;
    fetchChatThreadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseThread = () => resolve(makeThread("session-1"));
        }),
    );
    await act(async () => {
      renderer.update(view("visible"));
      await flushEffects(8);
    });
    expect(counts()).toEqual({ sessions: 2, settings: 2, thread: 2 });
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    expect(latestHarness?.result.loading).toBe(false);
    expect(latestHarness?.result.messagesLoading).toBe(false);
    await act(async () => {
      releaseThread();
      await flushEffects(8);
    });
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    await act(async () => renderer.unmount());
  });

  it("reloads a conversation after a quick switch away and back, and drops the other one's late load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7_200_000);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-switch-back" initialSelectedSessionId="session-1" />);
      await flushEffects(8);
    });
    await act(async () => {
      await flushEffects(8);
    });
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");

    let releaseOther!: () => void;
    fetchChatThreadMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOther = () => resolve(makeThread("session-2"));
        }),
    );
    await act(async () => {
      latestHarness?.setSelectedSessionId("session-2");
      await flushEffects(8);
    });
    vi.setSystemTime(Date.now() + 5_000);
    await act(async () => {
      latestHarness?.setSelectedSessionId("session-1");
      await flushEffects(8);
    });
    await act(async () => {
      await flushEffects(8);
    });
    expect(fetchChatThreadMock.mock.calls.map(([id]) => id)).toEqual(["session-1", "session-2", "session-1"]);
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");

    await act(async () => {
      releaseOther();
      await flushEffects(8);
    });
    expect(latestHarness?.result.thread?.sessionId).toBe("session-1");
    await act(async () => renderer.unmount());
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
  it("appends the canonical search cursor without dropping hits or changing the selected conversation", async () => {
    const hit = (id: string) => ({
      session: makeSession(id),
      hits: [{ source: "title", excerpt: id }],
      matchedFields: ["title"],
    });
    fetchChatSessionSearchMock.mockResolvedValueOnce({ items: [hit("search-one")], nextCursor: "search-page-two" });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-search-cursor" searchQuery="search" />);
      await flushEffects();
    });
    fetchChatSessionSearchMock.mockResolvedValueOnce({
      items: [hit("search-one"), hit("search-two")],
      nextCursor: undefined,
    });
    await act(async () => {
      await latestHarness!.result.loadSidebar("active", { append: true });
      await flushEffects();
    });
    expect(fetchChatSessionSearchMock).toHaveBeenLastCalledWith({
      query: "search",
      mode: "discovery",
      view: "active",
      limit: 200,
      workspaceId: "workspace-search-cursor",
      cursor: "search-page-two",
      surface: undefined,
      includeActivity: true,
    }, { signal: expect.any(AbortSignal) });
    expect(latestHarness!.result.sessions?.items.map((item) => item.sessionId)).toEqual(["search-one", "search-two"]);
    expect(latestHarness!.result.sessions?.items[1]?.searchHits).toEqual([{ source: "title", excerpt: "search-two" }]);
    expect(latestHarness!.selectedSessionId).toBe("search-one");
    expect(latestHarness!.result.sidebarNextCursor).toBeNull();
    await act(async () => renderer.unmount());
  });

  it("hydrates an exact older deep link with one scoped read and preserves the page cursor", async () => {
    const requested = { ...makeSession("old-target"), workspaceId: "workspace-linked" };
    fetchChatSessionsMock.mockImplementation(async (query) =>
      query.sessionId ? { items: [requested] } : { items: [makeSession("newest")], nextCursor: "page-2" },
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-linked" routeSessionId="old-target" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("old-target");
    expect(latestHarness!.result.sessions?.items.map((item) => item.sessionId)).toEqual(["newest", "old-target"]);
    expect(latestHarness!.result.sidebarNextCursor).toBe("page-2");
    const reads = fetchChatSessionsMock.mock.calls.filter(([query]) => query.sessionId);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual([
      {
        sessionId: "old-target",
        workspaceId: "workspace-linked",
        scope: "mission",
        view: "active",
        mode: undefined,
        limit: 1,
        // A linked conversation shows its status from this read.
        includeActivity: true,
      },
      { signal: expect.any(AbortSignal) },
    ]);
    await act(async () => renderer.unmount());
  });

  it("retains an explicit conversation choice and a newly created fork across route-linked sidebar refreshes", async () => {
    const records = ["route-origin", "chosen-thread", "new-fork"].map((id) => ({
      ...makeSession(id),
      workspaceId: "workspace-route-selection",
    }));
    fetchChatSessionsMock.mockResolvedValue({ items: records });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-route-selection" routeSessionId="route-origin" />);
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("route-origin");
    await act(async () => {
      latestHarness!.setSelectedSessionId("chosen-thread");
      await flushEffects();
    });
    await act(async () => {
      await latestHarness!.result.loadSidebar("active", { bypassCache: true });
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("chosen-thread");
    await act(async () => {
      await latestHarness!.result.loadSidebar("active", { preferredSessionId: "new-fork", bypassCache: true });
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("new-fork");
    await act(async () => {
      await latestHarness!.result.loadSidebar("active", { bypassCache: true });
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("new-fork");
    await act(async () => renderer.unmount());
  });

  it("applies a new route identity once and preserves subsequent user selection", async () => {
    const records = ["route-one", "route-two", "chosen-thread"].map((id) => ({
      ...makeSession(id),
      workspaceId: "workspace-route-change",
    }));
    fetchChatSessionsMock.mockResolvedValue({ items: records });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-route-change" routeSessionId="route-one" />);
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("route-one");
    await act(async () => {
      latestHarness!.setSelectedSessionId("chosen-thread");
      await flushEffects();
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-route-change" routeSessionId="route-two" />);
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("route-two");
    await act(async () => {
      latestHarness!.setSelectedSessionId("chosen-thread");
      await flushEffects();
    });
    await act(async () => {
      await latestHarness!.result.loadSidebar("active", { bypassCache: true });
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("chosen-thread");
    await act(async () => renderer.unmount());
  });

  it.each([
    { items: [] },
    { items: [{ ...makeSession("old-target"), workspaceId: "foreign" }] },
    { items: [{ ...makeSession("other-id"), workspaceId: "workspace-linked" }] },
  ])("withholds a missing or foreign deep-link record without selecting a recent Chat", async ({ items }) => {
    fetchChatSessionsMock.mockImplementation(async (query) =>
      query.sessionId ? { items } : { items: [makeSession("newest")] },
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-linked" routeSessionId="old-target" />);
      await flushEffects();
    });
    await act(async () => {
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBeNull();
    expect(latestHarness!.result.sessions).toBeNull();
    expect(latestHarness!.errors).toContain(
      "The requested conversation is unavailable in this workspace and history view.",
    );
    await act(async () => renderer.unmount());
  });

  it("aborts an exact deep-link read and withholds its late response after scope ABA", async () => {
    let resolveRead!: (value: unknown) => void;
    fetchChatSessionsMock.mockImplementation((query) =>
      query.sessionId
        ? new Promise((resolve) => {
            resolveRead = resolve;
          })
        : Promise.resolve({ items: [makeSession("newest")] }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness workspaceId="workspace-linked" routeSessionId="old-target" />);
      await flushEffects();
    });
    const oldRead = fetchChatSessionsMock.mock.calls.find(([query]) => query.sessionId)!;
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-other" />);
      await flushEffects();
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="workspace-linked" />);
      await flushEffects();
    });
    expect(oldRead[1].signal.aborted).toBe(true);
    await act(async () => {
      resolveRead({ items: [{ ...makeSession("old-target"), workspaceId: "workspace-linked" }] });
      await flushEffects();
    });
    expect(latestHarness!.selectedSessionId).toBe("newest");
    expect(latestHarness!.result.sessions?.items.some((item) => item.sessionId === "old-target")).toBe(false);
    await act(async () => renderer.unmount());
  });
  it.each([false, true])("preserves newer selection when the real post-assignment sidebar read settles (conflict: %s)", async (conflict) => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness workspaceId={`workspace-assignment-${conflict}`} initialSelectedSessionId="session-1" assignmentControls />); await flushEffects(8); });
    await act(async () => { await flushEffects(8); });
    let resolveRead!: (value: { items: ChatSessionRecord[] }) => void;
    fetchChatSessionsMock.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    if (conflict) assignChatSessionProjectMock.mockRejectedValueOnce(new assignmentErrors.ApiRequestError("stale assignment", 409));
    else assignChatSessionProjectMock.mockResolvedValueOnce({});
    let pending!: Promise<void>;
    await act(async () => { pending = latestAssignment!("destination"); await flushEffects(8); });
    expect(assignChatSessionProjectMock).toHaveBeenCalledExactlyOnceWith("session-1", "destination", 7);
    expect(typeof resolveRead).toBe("function");
    await act(async () => { latestHarness!.setSelectedSessionId("session-2"); });
    expect(latestHarness!.selectedSessionId).toBe("session-2");
    await act(async () => { resolveRead({ items: [{ ...makeSession("session-1"), projectId: "destination" }, makeSession("session-2")] }); await pending; });
    expect(latestHarness!.result.sessions?.items[0]?.projectId).toBe("destination");
    expect(latestHarness!.selectedSessionId).toBe("session-2");
    await act(async () => renderer.unmount());
  });


});

it("rereads the canonical batched list when thread settlement disagrees with retained activity", async () => {
  setupApiDefaults();
  const waiting = { ...makeSession("session-1"), activity: { latestTurn: { turnId: "turn-1", status: "waiting_for_approval" } } };
  fetchChatSessionsMock.mockResolvedValueOnce({ items: [waiting] }).mockImplementation(async (query) => ({ items: [{ ...waiting, activity: { latestTurn: { turnId: "turn-1", status: "completed" } } }], ...(query.sessionIds ? { membership: { sessionIds: query.sessionIds, complete: true } } : {}) }));
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId="settlement-preview" initialSelectedSessionId="session-1" />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(fetchChatSessionsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(latestHarness!.result.sessions?.items[0]?.activity?.latestTurn?.status).toBe("completed");
  await act(async () => renderer!.unmount());
});

it.each(["later", "first"])("preserves two loaded pages, cursor and selection when settling with route %s", async (routeSessionId) => {
  setupApiDefaults();
  let settled = false;
  const first = { ...makeSession("first"), workspaceId: "settlement-pages", pinned: true };
  const later = () => ({ ...makeSession("later"), workspaceId: "settlement-pages", activity: { latestTurn: { turnId: "turn-1", status: settled ? "completed" : "running" } } });
  fetchChatSessionsMock.mockImplementation(async (query) => query.sessionIds ? { items: [first, later()], membership: { sessionIds: query.sessionIds, complete: true } } : query.sessionId ? { items: [later()] }
    : query.cursor === "page-two" ? { items: [later()], nextCursor: "page-three" }
    : { items: [first], nextCursor: "page-two" });
  fetchChatThreadMock.mockImplementation(async (id) => ({ ...makeThread(id), turns: makeThread(id).turns.map((turn) => ({ ...turn, trace: { ...turn.trace, status: "running" } })) }));
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId="settlement-pages" routeSessionId={routeSessionId} />); });
  await act(async () => { await latestHarness!.result.loadSidebar("active", { append: true }); latestHarness!.setSelectedSessionId("later"); });
  const ids = latestHarness!.result.sessions!.items.map((item) => item.sessionId);
  const cursor = latestHarness!.result.sidebarNextCursor;
  expect(ids).toContain("first"); expect(ids).toContain("later"); expect(cursor).toBe("page-three");
  fetchChatSessionsMock.mockClear(); settled = true;
  await act(async () => { latestHarness!.result.setThread(makeThread("later")); });
  expect(fetchChatSessionsMock.mock.calls.filter(([query]) => !query.sessionIds).map(([query]) => query.cursor)).toEqual([undefined, "page-two"]);
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(ids);
  expect(latestHarness!.result.sidebarNextCursor).toBe(cursor);
  expect(latestHarness!.selectedSessionId).toBe("later");
  await act(async () => { await latestHarness!.result.refreshViewState({ refreshSidebar: true, refreshSession: "none" }); });
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(ids);
  expect(latestHarness!.result.sidebarNextCursor).toBe(cursor);
  expect(latestHarness!.selectedSessionId).toBe("later");
  expect(latestHarness!.result.sessions!.items.find((item) => item.sessionId === "later")!.activity!.latestTurn!.status).toBe("completed");
  await act(async () => renderer!.unmount());
});

it("rejects a late loaded-range projection after the verified caller changes", async () => {
  setupApiDefaults(); setGatewayCallerScope("settlement-actor-a");
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId="settlement-caller" />); });
  const before = latestHarness!.result.sessions;
  let resolveRead!: (value: unknown) => void;
  fetchChatSessionsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true }); });
  setGatewayCallerScope("settlement-actor-b");
  await act(async () => { resolveRead({ items: [{ ...makeSession("session-1"), title: "Previous caller result" }] }); await pending; });
  expect(latestHarness!.result.sessions).toBe(before);
  await act(async () => renderer!.unmount()); setGatewayCallerScope("");
});


it.each(["later", "outside"])("retains loaded range through actual URL target %s and canonical membership changes", async (target) => {
  setupApiDefaults();
  const workspaceId = `membership-${target}`;
  const record = (id: string) => ({ ...makeSession(id), workspaceId });
  let canonical = ["first", "later", "moved", "removed"];
  let changed = false;
  fetchChatSessionsMock.mockImplementation(async (query) => {
    if (query.sessionIds) return { items: query.sessionIds.filter((id: string) => canonical.includes(id)).map(record), membership: { sessionIds: query.sessionIds, complete: true } };
    if (query.sessionId) return { items: [record(query.sessionId)] };
    return query.cursor ? { items: changed ? [] : [record("later"), record("moved"), record("removed")], nextCursor: "third" }
      : { items: (changed ? ["new", "first"] : ["first"]).map(record), nextCursor: "second" };
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId={workspaceId} routeSessionId="first" />); await flushEffects(8); });
  await act(async () => { await latestHarness!.result.loadSidebar(undefined, { append: true }); });
  const before = latestHarness!.result.sessions!.items.map((item) => item.sessionId);
  fetchChatSessionsMock.mockClear();
  await act(async () => { renderer.update(<Harness workspaceId={workspaceId} routeSessionId={target} />); await flushEffects(8); });
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(target === "outside" ? [...before, target] : before);
  expect(latestHarness!.result.sidebarNextCursor).toBe("third");
  expect(latestHarness!.selectedSessionId).toBe(target);
  expect(fetchChatSessionsMock.mock.calls.every(([query]) => query.sessionId === "outside")).toBe(true);
  changed = true; canonical = ["first", "later", "moved", "new", "outside"];
  await act(async () => { await latestHarness!.result.refreshViewState({ refreshSidebar: true, refreshSession: "none" }); });
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(["first", "later", "moved", ...(target === "outside" ? [target] : []), "new"]);
  expect(latestHarness!.selectedSessionId).toBe(target);
  expect(latestHarness!.result.sidebarNextCursor).toBe("third");
  expect(fetchChatSessionsMock.mock.calls.some(([query]) => query.cursor === "second")).toBe(true);
  const retained = latestHarness!.result.sessions;
  fetchChatSessionsMock.mockImplementation(async (query) => query.sessionIds ? { items: [], membership: { sessionIds: query.sessionIds, complete: false } } : { items: [] });
  await act(async () => { await expect(latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true })).rejects.toThrow("membership could not be verified"); });
  expect(latestHarness!.result.sessions).toBe(retained);
  await act(async () => renderer.unmount());
});


it("retains uncertainty on a failed or stale bounded search membership read", async () => {
  setupApiDefaults();
  const workspaceId = "search-membership";
  const record = { ...makeSession("searched"), workspaceId };
  fetchChatSessionSearchMock.mockResolvedValue({ items: [{ session: record, hits: [] }] });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId={workspaceId} searchQuery="needle" />); await flushEffects(8); });
  const before = latestHarness!.result.sessions;
  fetchChatSessionsMock.mockRejectedValueOnce(new Error("membership offline"));
  await act(async () => { await expect(latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true })).rejects.toThrow("membership offline"); });
  expect(latestHarness!.result.sessions).toBe(before);
  let resolveMembership!: (value: unknown) => void;
  fetchChatSessionsMock.mockImplementationOnce((query) => {
    expect(query).toMatchObject({ sessionIds: ["searched"], workspaceId, q: "needle", view: "active" });
    return new Promise((resolve) => { resolveMembership = resolve; });
  });
  let pending!: Promise<void>;
  await act(async () => { pending = latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true }); await flushEffects(8); });
  await act(async () => { renderer.update(<Harness workspaceId={workspaceId} searchQuery="changed" historyView="archived" />); await flushEffects(8); });
  const next = latestHarness!.result.sessions;
  await act(async () => { resolveMembership({ items: [], membership: { sessionIds: ["searched"], complete: true } }); await pending; });
  expect(latestHarness!.result.sessions).toBe(next);
  fetchChatSessionSearchMock.mockResolvedValue({ items: [] });
  fetchChatSessionsMock.mockImplementation(async (query) => ({ items: [], membership: { sessionIds: query.sessionIds, complete: true } }));
  await act(async () => { await latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true }); });
  expect(latestHarness!.result.sessions!.items).toEqual([]);
  expect(fetchChatSessionsMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: "changed", view: "archived" }), expect.anything());
  await act(async () => renderer.unmount());
});

it("invalidates an out-of-range exact target when only the URL selection changes", async () => {
  setupApiDefaults();
  const workspaceId = "route-generation";
  const record = (id: string) => ({ ...makeSession(id), workspaceId });
  let resolveExact!: (value: unknown) => void;
  fetchChatSessionsMock.mockImplementation(async (query) => {
    if (query.sessionId) return new Promise((resolve) => { resolveExact = resolve; });
    return { items: [record(query.cursor ? "later" : "first")], nextCursor: query.cursor ? "third" : "second" };
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId={workspaceId} routeSessionId="first" />); await flushEffects(8); });
  await act(async () => { await latestHarness!.result.loadSidebar(undefined, { append: true }); });
  await act(async () => { renderer.update(<Harness workspaceId={workspaceId} routeSessionId="outside" />); await flushEffects(8); });
  const exact = fetchChatSessionsMock.mock.calls.find(([query]) => query.sessionId)!;
  await act(async () => { renderer.update(<Harness workspaceId={workspaceId} routeSessionId="later" />); await flushEffects(8); });
  expect(exact[1].signal.aborted).toBe(true);
  await act(async () => { resolveExact({ items: [record("outside")] }); await flushEffects(8); });
  expect(latestHarness!.selectedSessionId).toBe("later");
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(["first", "later"]);
  expect(latestHarness!.result.sidebarNextCursor).toBe("third");
  await act(async () => renderer.unmount());
});


it("verifies every retained record in batches of at most 100 without per-row requests", async () => {
  setupApiDefaults();
  const rows = Array.from({ length: 201 }, (_, index) => makeSession(`bounded-${index}`));
  fetchChatSessionsMock.mockImplementation(async (query) => query.sessionIds
    ? { items: rows.filter((row) => query.sessionIds.includes(row.sessionId)), membership: { sessionIds: query.sessionIds, complete: true } }
    : { items: rows, nextCursor: "continue" });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId="membership-batches" />); await flushEffects(8); });
  fetchChatSessionsMock.mockClear();
  await act(async () => { await latestHarness!.result.loadSidebar(undefined, { reconcileLoadedRange: true }); });
  const batches = fetchChatSessionsMock.mock.calls.filter(([query]) => query.sessionIds).map(([query]) => query.sessionIds);
  expect(batches.map((ids) => ids.length)).toEqual([100, 100, 1]);
  expect(batches.flat()).toEqual(rows.map((row) => row.sessionId));
  expect(latestHarness!.result.sessions!.items.map((row) => row.sessionId)).toEqual(rows.map((row) => row.sessionId));
  expect(latestHarness!.result.sidebarNextCursor).toBe("continue");
  await act(async () => renderer.unmount());
});


it.each(["loaded", "outside"].flatMap((target) => ["success", "failure", "abort"].map((outcome) => ({ target, outcome }))))(
  "releases displaced append loading on URL selection ($target, late $outcome)", async ({ target, outcome }) => {
    setupApiDefaults();
    const workspaceId = `append-${target}-${outcome}`;
    const row = (id: string) => ({ ...makeSession(id), workspaceId });
    fetchChatSessionsMock.mockImplementation(async (query) => query.sessionId ? { items: [row(query.sessionId)] }
      : query.cursor ? { items: [row("next")], nextCursor: "third" } : { items: [row("first"), row("loaded")], nextCursor: "second" });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness workspaceId={workspaceId} routeSessionId="first" />); await flushEffects(8); });
    let resolveAppend!: (value: unknown) => void;
    let rejectAppend!: (cause: Error) => void;
    fetchChatSessionsMock.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveAppend = resolve; rejectAppend = reject; }));
    let pending!: Promise<void>;
    await act(async () => { pending = latestHarness!.result.loadSidebar(undefined, { append: true }); });
    expect(latestHarness!.result.sidebarLoadingMore).toBe(true);
    const append = fetchChatSessionsMock.mock.calls.at(-1)!;
    await act(async () => { renderer.update(<Harness workspaceId={workspaceId} routeSessionId={target} />); await flushEffects(8); });
    expect(latestHarness!.result.sidebarLoadingMore).toBe(false);
    expect(append[1].signal.aborted).toBe(true);
    expect(latestHarness!.selectedSessionId).toBe(target);
    expect(latestHarness!.result.sidebarNextCursor).toBe("second");
    await act(async () => {
      if (outcome === "success") resolveAppend({ items: [row("obsolete")], nextCursor: "obsolete-cursor" });
      else rejectAppend(outcome === "abort" ? new DOMException("Displaced", "AbortError") : new Error("Late append failure"));
      await pending;
    });
    const retained = ["first", "loaded", ...(target === "outside" ? [target] : [])];
    expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(retained);
    expect(latestHarness!.result.sidebarLoadingMore).toBe(false);
    expect(latestHarness!.result.sidebarNextCursor).toBe("second");
    await act(async () => { await latestHarness!.result.loadSidebar(undefined, { append: true }); });
    expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual([...retained, "next"]);
    expect(latestHarness!.result.sidebarNextCursor).toBe("third");
    expect(latestHarness!.selectedSessionId).toBe(target);
    expect(latestHarness!.errors).not.toContain("Late append failure");
    await act(async () => renderer.unmount());
  },
);

it("reconciles isolated canonical deletion after archive settled without reloading another selected transcript", async () => {
  setupApiDefaults();
  let ids = ["selected", "archive", "delete"];
  fetchChatSessionsMock.mockImplementation(async (query) => query.sessionIds
    ? { items: ids.filter((id) => query.sessionIds.includes(id)).map((id) => makeSession(id)), membership: { sessionIds: query.sessionIds, complete: true } }
    : { items: ids.map((id) => makeSession(id)), nextCursor: query.cursor ? "third" : "second" });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness workspaceId="isolated-delete" initialSelectedSessionId="selected" />); await flushEffects(8); });
  await act(async () => { await latestHarness!.result.loadSidebar(undefined, { append: true }); });
  const threadReads = fetchChatThreadMock.mock.calls.length;
  const emit = async (eventType: string, sessionId: string) => {
    await act(async () => { await latestRefreshSubscription!.callback({ topic: "chat", timestamp: Date.now() + 1000, eventId: sessionId, reason: eventType, eventType, source: "chat", sessionId }); });
  };
  ids = ["selected", "delete"];
  await emit("chat_session_updated", "archive");
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(ids);
  fetchChatSessionsMock.mockClear();
  ids = ["selected"];
  await emit("chat_session_deleted", "delete");
  expect(fetchChatSessionsMock.mock.calls.some(([query]) => query.sessionIds?.includes("delete"))).toBe(true);
  expect(latestHarness!.result.sessions!.items.map((item) => item.sessionId)).toEqual(ids);
  expect(fetchChatThreadMock).toHaveBeenCalledTimes(threadReads);
  expect(latestHarness!.selectedSessionId).toBe("selected");
  expect(latestHarness!.result.sidebarNextCursor).toBe("third");
  await act(async () => renderer.unmount());
});

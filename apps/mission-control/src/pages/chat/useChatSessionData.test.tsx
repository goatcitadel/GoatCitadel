import React, { useCallback, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionData, type ChatHistoryView } from "./useChatSessionData";

const apiMocks = vi.hoisted(() => ({
  fetchChatGeneratedArtifacts: vi.fn(),
  fetchChatCommandCatalog: vi.fn(),
  fetchChatLearnedMemory: vi.fn(),
  fetchChatProjects: vi.fn(),
  fetchChatProactiveRuns: vi.fn(),
  fetchChatProactiveStatus: vi.fn(),
  fetchChatSessionBinding: vi.fn(),
  fetchChatSessionGeneratedArtifacts: vi.fn(),
  fetchChatSessionPrefs: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchChatSpecialistCandidates: vi.fn(),
  fetchChatThread: vi.fn(),
  fetchThreadKnowledgeAttachments: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchMcpTemplates: vi.fn(),
  fetchSettings: vi.fn(),
  fetchSkills: vi.fn(),
}));

const refreshSubscriptionMocks = vi.hoisted(() => ({
  callback: null as
    | ((signal: { topic: "chat"; timestamp: number; reason: string; source?: string; eventType?: string }) => void)
    | null,
  options: null as { enabled?: boolean; coalesceMs?: number; staleMs?: number; pollIntervalMs?: number } | null,
  topic: null as string | null,
}));

const diagnosticMocks = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
  recordChatRefreshPhase: vi.fn(),
}));

vi.mock("../../api/client", () => apiMocks);

vi.mock("../../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn((topic, callback, options) => {
    refreshSubscriptionMocks.topic = topic;
    refreshSubscriptionMocks.callback = callback;
    refreshSubscriptionMocks.options = options ?? null;
  }),
}));

vi.mock("../../state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: diagnosticMocks.recordClientDiagnostic,
}));

vi.mock("./chat-causality", () => ({
  recordChatRefreshPhase: diagnosticMocks.recordChatRefreshPhase,
}));

type HarnessState = ReturnType<typeof useChatSessionData> & {
  selectedSessionId: string | null;
  errors: string[];
  applyFetchedThread: ReturnType<typeof vi.fn>;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setLastLocalPrefMutationAt: (value: number) => void;
};

let latest: HarnessState | null = null;

function thread(sessionId = "session-1") {
  return {
    sessionId,
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "user-1",
          sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Hello",
          timestamp: "2026-04-08T00:00:00.000Z",
        },
        trace: { status: "completed", routing: {}, toolRuns: [] },
      },
    ],
  };
}

function Harness(props: {
  historyView?: ChatHistoryView;
  searchQuery?: string;
  initialSessionId?: string | null;
  runtimeLlmConfig?: any;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    props.initialSessionId === undefined ? null : props.initialSessionId,
  );
  const [errors, setErrors] = useState<string[]>([]);
  const applyFetchedThreadRef = useRef(vi.fn(() => true));
  const messageMutationVersionRef = useRef(7);
  const lastLocalPrefMutationAtRef = useRef(0);
  const handleError = useCallback((value: string | null) => {
    if (value) {
      setErrors((current) => [...current, value]);
    }
  }, []);

  const hook = useChatSessionData({
    workspaceId: "workspace-1",
    historyView: props.historyView ?? "active",
    searchQuery: props.searchQuery ?? "  code  ",
    selectedSessionId,
    setSelectedSessionId,
    runtimeLlmConfig: props.runtimeLlmConfig ?? null,
    setError: handleError,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    lastLocalPrefMutationAtRef,
  });

  latest = {
    ...hook,
    selectedSessionId,
    errors,
    applyFetchedThread: applyFetchedThreadRef.current,
    setSelectedSessionId,
    setLastLocalPrefMutationAt: (value: number) => {
      lastLocalPrefMutationAtRef.current = value;
    },
  };
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useChatSessionData", () => {
  beforeEach(() => {
    latest = null;
    refreshSubscriptionMocks.callback = null;
    refreshSubscriptionMocks.options = null;
    refreshSubscriptionMocks.topic = null;
    diagnosticMocks.recordClientDiagnostic.mockReset();
    diagnosticMocks.recordChatRefreshPhase.mockReset();
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.fetchChatProjects.mockResolvedValue({ items: [{ projectId: "project-1", name: "Project" }] });
    apiMocks.fetchChatSessions.mockResolvedValue({
      items: [
        {
          sessionId: "session-1",
          title: "First session",
          pinned: false,
          lifecycleStatus: "active",
          scope: "mission",
        },
      ],
    });
    apiMocks.fetchSettings.mockResolvedValue({ llm: { providerId: "openai", model: "gpt-5.4-mini" } });
    apiMocks.fetchChatCommandCatalog.mockResolvedValue({
      items: [{ command: "/help", usage: "/help", description: "Show help" }],
    });
    apiMocks.fetchSkills.mockResolvedValue({ items: [{ id: "skill-1", name: "Skill" }] });
    apiMocks.fetchMcpServers.mockResolvedValue({ items: [{ serverId: "server-1", name: "Server" }] });
    apiMocks.fetchMcpTemplates.mockResolvedValue({ items: [{ templateId: "template-1", installed: false }] });
    apiMocks.fetchChatThread.mockResolvedValue(thread());
    apiMocks.fetchChatSessionBinding.mockResolvedValue({ item: { transport: "local", writable: true } });
    apiMocks.fetchChatSessionPrefs.mockResolvedValue({
      sessionId: "session-1",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4-mini",
    });
    apiMocks.fetchChatSessionGeneratedArtifacts.mockResolvedValue({ items: [{ artifactId: "session-artifact" }] });
    apiMocks.fetchThreadKnowledgeAttachments.mockResolvedValue({ items: [{ attachmentId: "knowledge-1" }] });
    apiMocks.fetchChatProactiveStatus.mockResolvedValue({ policy: { mode: "manual" } });
    apiMocks.fetchChatProactiveRuns.mockResolvedValue({ items: [{ runId: "run-1" }] });
    apiMocks.fetchChatLearnedMemory.mockResolvedValue({ items: [{ memoryId: "memory-1" }] });
    apiMocks.fetchChatSpecialistCandidates.mockResolvedValue({ items: [{ candidateId: "candidate-1" }] });
    apiMocks.fetchChatGeneratedArtifacts.mockResolvedValue({ items: [{ artifactId: "global-artifact" }] });
  });

  it("hydrates sidebar, runtime catalog, and the first selected session", async () => {
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    expect(apiMocks.fetchChatProjects).toHaveBeenCalledWith("all", 250, "workspace-1");
    expect(apiMocks.fetchChatSessions).toHaveBeenCalledWith({
      scope: "all",
      view: "active",
      limit: 250,
      workspaceId: "workspace-1",
      q: "code",
    });
    expect(latest?.selectedSessionId).toBe("session-1");
    expect(latest?.settings?.llm).toEqual({ providerId: "openai", model: "gpt-5.4-mini" });
    expect(latest?.commandCatalog).toEqual([{ command: "/help", usage: "/help", description: "Show help" }]);
    expect(latest?.installedSkills).toEqual([{ id: "skill-1", name: "Skill" }]);
    expect(latest?.loading).toBe(false);
    expect(refreshSubscriptionMocks.options).toMatchObject({
      enabled: true,
      coalesceMs: 800,
      staleMs: 20_000,
      pollIntervalMs: 15_000,
    });
  });

  it("loads core session state without fetching the thread when includeThread is false", async () => {
    await act(async () => {
      create(<Harness initialSessionId="session-1" />);
    });
    await flushEffects();
    apiMocks.fetchChatThread.mockClear();
    latest?.applyFetchedThread.mockClear();
    apiMocks.fetchChatSessionPrefs.mockResolvedValueOnce({
      sessionId: "session-1",
      mode: "code",
      providerId: "anthropic",
      model: "claude-test",
    });

    await act(async () => {
      await latest?.loadSessionCoreState("session-1", { includeThread: false });
    });

    expect(apiMocks.fetchChatThread).not.toHaveBeenCalled();
    expect(latest?.applyFetchedThread).not.toHaveBeenCalled();
    expect(latest?.prefs).toMatchObject({ mode: "code", providerId: "anthropic", model: "claude-test" });
    expect(latest?.binding).toEqual({ transport: "local", writable: true });
  });

  it("ignores refresh events that echo recent local preference writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
    await act(async () => {
      create(<Harness initialSessionId="session-1" />);
    });
    await flushEffects();
    for (const mock of [
      apiMocks.fetchChatSessions,
      apiMocks.fetchChatProactiveStatus,
      apiMocks.fetchChatGeneratedArtifacts,
      apiMocks.fetchChatThread,
    ]) {
      mock.mockClear();
    }
    act(() => {
      latest?.setLastLocalPrefMutationAt(Date.now());
    });

    await act(async () => {
      await refreshSubscriptionMocks.callback?.({
        topic: "chat",
        timestamp: Date.now(),
        reason: "session prefs changed",
        source: "unit-test",
        eventType: "chat_session_prefs_updated",
      });
    });

    expect(apiMocks.fetchChatSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchChatProactiveStatus).not.toHaveBeenCalled();
    expect(apiMocks.fetchChatGeneratedArtifacts).not.toHaveBeenCalled();
    expect(apiMocks.fetchChatThread).not.toHaveBeenCalled();
    expect(diagnosticMocks.recordChatRefreshPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "plan_resolved",
        plan: { refreshSidebar: false, refreshSession: "none" },
      }),
    );
    vi.useRealTimers();
  });

  it("applies runtime config updates without reloading the catalog", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness initialSessionId="session-1" />);
    });
    await flushEffects();
    apiMocks.fetchSettings.mockClear();

    await act(async () => {
      renderer.update(
        <Harness initialSessionId="session-1" runtimeLlmConfig={{ providerId: "moonshot", model: "kimi-k2-latest" }} />,
      );
    });

    expect(latest?.settings?.llm).toEqual({ providerId: "moonshot", model: "kimi-k2-latest" });
    expect(apiMocks.fetchSettings).not.toHaveBeenCalled();
  });

  it("clears session-specific state when no session is selected", async () => {
    await act(async () => {
      create(<Harness initialSessionId="session-1" />);
    });
    await flushEffects();
    expect(latest?.prefs).not.toBeNull();

    await act(async () => {
      latest?.setSelectedSessionId(null);
    });

    expect(latest?.prefs).toBeNull();
    expect(latest?.binding).toBeNull();
    expect(latest?.generatedArtifacts).toBeNull();
    expect(latest?.proactiveRuns).toEqual([]);
    expect(latest?.learnedMemory).toEqual([]);
    expect(latest?.specialistCandidates).toEqual([]);
  });
});

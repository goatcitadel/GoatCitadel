import React, { useCallback, useMemo, useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import {
  resolveOutboundExecutionPrefs,
  useChatOutboundExecution,
  type ActiveChatStreamState,
} from "./useChatOutboundExecution";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approveChatToolMock = vi.fn();
const answerChatUserInputPromptMock = vi.fn();
const denyChatToolMock = vi.fn();
const editChatTurnMock = vi.fn();
const fetchChatPendingApprovalsMock = vi.fn();
const resumeChatTurnStreamMock = vi.fn();
const retryChatTurnMock = vi.fn();
const selectChatBranchTurnMock = vi.fn();
const sendAgentChatMessageMock = vi.fn();
const streamAgentChatMessageMock = vi.fn();
const streamEditChatTurnMock = vi.fn();
const streamRetryChatTurnMock = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  answerChatUserInputPrompt: (...args: unknown[]) => answerChatUserInputPromptMock(...args),
  approveChatTool: (...args: unknown[]) => approveChatToolMock(...args),
  denyChatTool: (...args: unknown[]) => denyChatToolMock(...args),
  editChatTurn: (...args: unknown[]) => editChatTurnMock(...args),
  fetchChatPendingApprovals: (...args: unknown[]) => fetchChatPendingApprovalsMock(...args),
  resumeChatTurnStream: (...args: unknown[]) => resumeChatTurnStreamMock(...args),
  retryChatTurn: (...args: unknown[]) => retryChatTurnMock(...args),
  selectChatBranchTurn: (...args: unknown[]) => selectChatBranchTurnMock(...args),
  sendAgentChatMessage: (...args: unknown[]) => sendAgentChatMessageMock(...args),
  streamAgentChatMessage: (...args: unknown[]) => streamAgentChatMessageMock(...args),
  streamEditChatTurn: (...args: unknown[]) => streamEditChatTurnMock(...args),
  streamRetryChatTurn: (...args: unknown[]) => streamRetryChatTurnMock(...args),
}));

type HarnessState = {
  execute: (item: any) => Promise<void>;
  approve: (allowScope?: "once" | "session" | "workspace") => Promise<void>;
  deny: () => Promise<void>;
  submitUserInput: (response: any) => Promise<void>;
  selectBranch: (turnId: string) => Promise<ChatThreadResponse | null | undefined>;
  applyFetchedThread: (thread: ChatThreadResponse, requestVersion: number | null) => boolean;
  tryBegin: () => boolean;
  setActiveStream: (stream: ActiveChatStreamState | null) => void;
  setPendingApproval: React.Dispatch<React.SetStateAction<any>>;
  setPendingUserInput: React.Dispatch<React.SetStateAction<any>>;
  getSnapshot: () => {
    activeStream: ActiveChatStreamState | null;
    draft: string;
    error: string | null;
    pendingAttachments: any[];
    pendingApproval: any;
    pendingUserInput: any;
    streamStatus: string;
    streamingPreview: unknown;
    activeStreamingTurnId: string | null;
    sending: boolean;
    thread: ChatThreadResponse | null;
    mutationVersion: number;
  };
};

let latest: HarnessState | null = null;

function makeThread(): ChatThreadResponse {
  return {
    sessionId: "session-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "user-1",
          sessionId: "session-1",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Original prompt",
          timestamp: "2026-05-03T12:45:00.000Z",
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
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
  } as any;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function Harness(props: {
  ensureFreshRoutePreflight?: () => Promise<any>;
  ensureSession?: () => Promise<any>;
  handleCommandExecution?: (sessionId: string, commandText: string) => Promise<void>;
  initialError?: string | null;
  initialDraft?: string;
  initialPendingAttachments?: any[];
  initialActiveStream?: ActiveChatStreamState | null;
  initialSending?: boolean;
  initialThread?: ChatThreadResponse | null;
  isRoutePreflightAcknowledged?: (hash: string) => boolean;
  loadSessionCoreState?: (sessionId: string, options?: any) => Promise<void>;
  loadSidebar?: () => Promise<void>;
  queuedOutbound?: any[];
  prefs?: any;
  selectedSession?: any | null;
  selectedSessionId?: string | null;
  streamEnabled?: boolean;
  surfaceMode?: "chat" | "cowork" | "code";
  fullWebAccess?: boolean;
}) {
  const [thread, setThread] = useState<ChatThreadResponse | null>(
    props.initialThread === undefined ? makeThread() : props.initialThread,
  );
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const [pendingAttachments, setPendingAttachments] = useState<any[]>(props.initialPendingAttachments ?? []);
  const [, setCapabilitySuggestions] = useState<any[]>([]);
  const [, setSpecialistSuggestions] = useState<any[]>([]);
  const [sending, setSending] = useState(Boolean(props.initialSending));
  const [error, setErrorState] = useState<string | null>(props.initialError ?? null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  if (activeStreamRef.current === null && props.initialActiveStream) {
    activeStreamRef.current = props.initialActiveStream;
  }
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);
  const ensureFreshRoutePreflight = useMemo(
    () =>
      props.ensureFreshRoutePreflight ??
      vi.fn(async () => ({
        requestedProviderId: "openai-codex",
        requestedModel: "gpt-5.5",
        effectiveProviderId: "openai-codex",
        effectiveModel: "gpt-5.5",
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "not_checked",
        runtimeClass: "cloud",
        decision: {
          action: "send",
          issuedAt: "2026-05-03T12:45:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          requestedProviderId: "openai-codex",
          requestedModel: "gpt-5.5",
          effectiveProviderId: "openai-codex",
          effectiveModel: "gpt-5.5",
          selectionSource: "session",
          fallbackPolicy: "off",
          fallbackResult: "not_applicable",
          runtimeReachability: "not_checked",
          runtimeClass: "cloud",
          fingerprint: "route-fingerprint",
        },
      })),
    [props.ensureFreshRoutePreflight],
  );
  const setError = useCallback((value: string | null) => {
    setErrorState(value);
  }, []);
  const messages = useMemo(
    () =>
      thread?.turns.flatMap((turn) => [turn.userMessage, ...(turn.assistantMessage ? [turn.assistantMessage] : [])]) ??
      [],
    [thread],
  );

  const outbound = useChatOutboundExecution({
    sessionConfig: {
      surfaceMode: props.surfaceMode,
      selectedSessionId: props.selectedSessionId === undefined ? "session-1" : props.selectedSessionId,
      selectedSession:
        props.selectedSession === undefined
          ? ({
              sessionId: "session-1",
              projectId: "project-1",
              pinned: false,
              lifecycleStatus: "active",
              scope: "mission",
            } as any)
          : props.selectedSession,
      prefs:
        props.prefs === undefined
          ? ({
              sessionId: "session-1",
              mode: "chat",
              providerId: "openai-codex",
              model: "gpt-5.5",
              webMode: "auto",
              memoryMode: "auto",
              thinkingLevel: "standard",
            } as any)
          : props.prefs,
      fullWebAccess: props.fullWebAccess,
    },
    streamConfig: {
      streamEnabled: props.streamEnabled ?? false,
      activeStreamRef,
    },
    stateConfig: {
      sending,
      error,
      queuedOutbound: props.queuedOutbound ?? [],
      thread,
      messages: messages as any,
    },
    stateSetters: {
      setThread,
      setError,
      setSending,
      setDraft,
      setPendingAttachments,
      setEditingTurnId: vi.fn(),
      setCapabilitySuggestions,
      setSpecialistSuggestions,
    },
    operations: {
      loadSidebar: props.loadSidebar ?? vi.fn(async () => undefined),
      loadSessionCoreState: props.loadSessionCoreState ?? vi.fn(async () => undefined),
      ensureSession: props.ensureSession ?? vi.fn(async () => ({ sessionId: "session-1" }) as any),
      pushLocalNotice: vi.fn(),
      handleCommandExecution: props.handleCommandExecution ?? vi.fn(async () => undefined),
    },
    refs: {
      executeOutboundItemRef,
      tryBeginOutboundExecutionRef,
      applyFetchedThreadRef,
      messageMutationVersionRef,
    },
    routing: {
      ensureFreshRoutePreflight,
      isRoutePreflightAcknowledged: props.isRoutePreflightAcknowledged ?? (() => false),
    },
  });

  latest = {
    execute: executeOutboundItemRef.current,
    approve: outbound.handleApprovePending,
    deny: outbound.handleDenyPending,
    submitUserInput: outbound.handleSubmitUserInput,
    selectBranch: outbound.handleSelectBranchTurn,
    applyFetchedThread: applyFetchedThreadRef.current,
    tryBegin: tryBeginOutboundExecutionRef.current,
    setActiveStream: (stream) => {
      activeStreamRef.current = stream;
    },
    setPendingApproval: outbound.setPendingApproval,
    setPendingUserInput: outbound.setPendingUserInput,
    getSnapshot: () => ({
      activeStream: activeStreamRef.current,
      draft,
      error,
      pendingAttachments,
      pendingApproval: outbound.pendingApproval,
      pendingUserInput: outbound.pendingUserInput,
      streamStatus: outbound.streamStatus,
      streamingPreview: outbound.streamingPreview,
      activeStreamingTurnId: outbound.activeStreamingTurnId,
      sending,
      thread,
      mutationVersion: messageMutationVersionRef.current,
    }),
  };
  return null;
}

describe("useChatOutboundExecution", () => {
  beforeEach(() => {
    latest = null;
    approveChatToolMock.mockReset();
    answerChatUserInputPromptMock.mockReset();
    denyChatToolMock.mockReset();
    editChatTurnMock.mockReset();
    fetchChatPendingApprovalsMock.mockReset();
    resumeChatTurnStreamMock.mockReset();
    retryChatTurnMock.mockReset();
    selectChatBranchTurnMock.mockReset();
    sendAgentChatMessageMock.mockReset();
    streamAgentChatMessageMock.mockReset();
    streamEditChatTurnMock.mockReset();
    streamRetryChatTurnMock.mockReset();
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [],
      activeApprovalId: null,
      remainingCount: 0,
    });
    sendAgentChatMessageMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-2",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Coordinate beta outreach",
        timestamp: "2026-05-03T12:45:02.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Done",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
    retryChatTurnMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-1",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Original prompt",
        timestamp: "2026-05-03T12:45:00.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Retried",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
    editChatTurnMock.mockResolvedValue({
      sessionId: "session-1",
      turnId: "turn-2",
      userMessage: {
        messageId: "user-2",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Edited prompt",
        timestamp: "2026-05-03T12:45:02.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Edited",
        timestamp: "2026-05-03T12:45:03.000Z",
      },
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves outbound execution preference defaults", () => {
    expect(resolveOutboundExecutionPrefs(null)).toEqual({
      useMemory: true,
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
    });
    expect(
      resolveOutboundExecutionPrefs({
        memoryMode: "off",
        webMode: "deep",
        thinkingLevel: "deep",
        speedMode: "fast",
        subagentPolicy: "off",
      } as any),
    ).toEqual({
      useMemory: false,
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "deep",
      speedMode: "fast",
      subagentPolicy: "off",
    });
  });

  it("sends the locked Cowork surface mode even when session prefs still say Chat", async () => {
    await act(async () => {
      create(<Harness surfaceMode="cowork" fullWebAccess />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Coordinate beta outreach",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "Coordinate beta outreach",
        mode: "cowork",
        fullWebAccess: true,
      }),
      { originSurface: "cowork" },
    );
  });

  it("retries with the locked Cowork surface mode even when session prefs still say Chat", async () => {
    await act(async () => {
      create(<Harness surfaceMode="cowork" />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "retry",
        targetTurnId: "turn-1",
        content: "Original prompt",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(retryChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({
        mode: "cowork",
      }),
      { originSurface: "cowork" },
    );
  });

  it("edits with the locked Cowork surface mode even when session prefs still say Chat", async () => {
    await act(async () => {
      create(<Harness surfaceMode="cowork" />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "edit",
        targetTurnId: "turn-1",
        content: "Edited prompt",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(editChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({
        content: "Edited prompt",
        mode: "cowork",
      }),
      { originSurface: "cowork" },
    );
  });

  it("streams the locked Cowork surface mode even when session prefs still say Chat", async () => {
    streamAgentChatMessageMock.mockImplementation(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "message_done",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Done",
      });
    });
    await act(async () => {
      create(<Harness streamEnabled surfaceMode="cowork" />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Coordinate beta outreach",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(streamAgentChatMessageMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "Coordinate beta outreach",
        mode: "cowork",
      }),
      expect.any(Function),
      expect.objectContaining({ originSurface: "cowork" }),
    );
  });

  it("releases the active stream before post-send sidebar refresh finishes", async () => {
    const sidebarRefresh = createDeferred<void>();
    const loadSidebar = vi.fn(() => sidebarRefresh.promise);
    streamAgentChatMessageMock.mockImplementation(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "message_done",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Done",
      });
    });

    await act(async () => {
      create(<Harness streamEnabled surfaceMode="cowork" loadSidebar={loadSidebar} />);
    });

    let executePromise: Promise<void> | undefined;
    await act(async () => {
      executePromise = latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Coordinate beta outreach",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadSidebar).toHaveBeenCalledTimes(1);
    expect(latest?.getSnapshot()).toMatchObject({
      activeStream: null,
      sending: false,
    });
    await expect(executePromise).resolves.toBeUndefined();

    await act(async () => {
      sidebarRefresh.resolve();
      await Promise.resolve();
    });
  });

  it("resumes interrupted streams with the locked Cowork surface mode", async () => {
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      throw new Error("network dropped");
    });
    resumeChatTurnStreamMock.mockImplementationOnce(async (_sessionId, _turnId, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Done after resume",
      });
    });

    await act(async () => {
      create(<Harness streamEnabled surfaceMode="cowork" />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Coordinate beta outreach",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(resumeChatTurnStreamMock).toHaveBeenCalledWith(
      "session-1",
      "turn-2",
      expect.any(Function),
      expect.objectContaining({
        sinceEventId: "evt-0",
        originSurface: "cowork",
      }),
    );
  });

  it("syncs approval queues and resolves approval denial and user input prompts", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValue({
      activeApprovalId: "approval-2",
      remainingCount: 3,
      items: [
        {
          approvalId: "stale-approval",
          stale: true,
          kind: "tool",
          toolName: "old.tool",
          reason: "Old",
        },
        {
          approvalId: "approval-2",
          stale: false,
          kind: "tool",
          toolName: "browser.search",
          reason: "Needs web access",
          riskLevel: "medium",
          expiresAt: "2099-01-01T00:00:00.000Z",
          details: {
            affectedResources: ["https://example.test", 42],
            capabilitySnapshotId: "capability-1",
            codeHash: "code-hash",
            codePreview: "await browser.search()",
            inspectPath: "/tmp/inspect",
            requestedOutputIntent: "research",
            saveCandidateOnSuccess: true,
            wrapperManifestHash: "wrapper-hash",
          },
        },
      ],
    });
    approveChatToolMock.mockResolvedValue({ resumed: false });
    denyChatToolMock.mockResolvedValue(undefined);
    answerChatUserInputPromptMock.mockResolvedValue({ resumed: true });

    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({
        approvalId: "approval-2",
        affectedResources: ["https://example.test"],
        saveCandidateOnSuccess: true,
      }),
    );

    await act(async () => {
      await latest?.approve("workspace");
    });
    expect(approveChatToolMock).toHaveBeenCalledWith("session-1", "approval-2", { allowScope: "workspace" });

    await act(async () => {
      await latest?.deny();
    });
    expect(denyChatToolMock).toHaveBeenCalledWith("session-1", "approval-2");

    await act(async () => {
      latest?.setPendingUserInput({ turnId: "turn-2", promptId: "prompt-1", prompt: "Pick a path" });
      await Promise.resolve();
    });
    await act(async () => {
      await latest?.submitUserInput({ kind: "text", value: "Continue" });
    });
    expect(answerChatUserInputPromptMock).toHaveBeenCalledWith("session-1", "turn-2", "prompt-1", {
      response: { kind: "text", value: "Continue" },
    });
  });

  it("covers approval scope notices, resolver failures, and deferred user-input outcomes", async () => {
    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-session",
        kind: "tool",
        toolName: "browser.search",
        reason: "Search",
        riskLevel: "medium",
        remainingCount: 1,
      });
      await Promise.resolve();
    });
    approveChatToolMock.mockResolvedValueOnce({
      resumed: true,
      resumedRunId: "run-1",
      resumedTurnId: "turn-2",
    });
    await act(async () => {
      await latest?.approve("session");
    });
    expect(approveChatToolMock).toHaveBeenCalledWith("session-1", "approval-session", { allowScope: "session" });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-once",
        kind: "tool",
        toolName: "fs.write",
        reason: "Write",
      });
      await Promise.resolve();
    });
    approveChatToolMock.mockResolvedValueOnce({ resumed: false });
    await act(async () => {
      await latest?.approve();
    });
    expect(approveChatToolMock).toHaveBeenCalledWith("session-1", "approval-once", { allowScope: "once" });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-fail",
        kind: "tool",
        toolName: "shell.exec",
        reason: "Run",
      });
      await Promise.resolve();
    });
    approveChatToolMock.mockRejectedValueOnce(new Error("approve failed"));
    await act(async () => {
      await latest?.approve("workspace");
    });
    expect(latest?.getSnapshot().error).toBe("approve failed");

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-deny-fail",
        kind: "tool",
        toolName: "shell.exec",
        reason: "Run",
      });
      await Promise.resolve();
    });
    denyChatToolMock.mockRejectedValueOnce(new Error("deny failed"));
    await act(async () => {
      await latest?.deny();
    });
    expect(latest?.getSnapshot().error).toBe("deny failed");

    await act(async () => {
      latest?.setPendingUserInput({ turnId: "turn-2", promptId: "prompt-later", prompt: "Need input" });
      await Promise.resolve();
    });
    answerChatUserInputPromptMock.mockResolvedValueOnce({ resumed: false });
    await act(async () => {
      await latest?.submitUserInput({ kind: "text", value: "Later" });
    });
    expect(answerChatUserInputPromptMock).toHaveBeenLastCalledWith("session-1", "turn-2", "prompt-later", {
      response: { kind: "text", value: "Later" },
    });

    await act(async () => {
      latest?.setPendingUserInput({ turnId: "turn-2", promptId: "prompt-fail", prompt: "Need input" });
      await Promise.resolve();
    });
    answerChatUserInputPromptMock.mockRejectedValueOnce(new Error("input failed"));
    await act(async () => {
      await latest?.submitUserInput({ kind: "text", value: "Retry" });
    });
    expect(latest?.getSnapshot().error).toBe("input failed");
  });

  it("resolves delegated approval prompts against the approval owner session", async () => {
    const loadSessionCoreState = vi.fn(async () => undefined);
    await act(async () => {
      create(<Harness loadSessionCoreState={loadSessionCoreState} />);
      await Promise.resolve();
    });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-child",
        sessionId: "child-session",
        kind: "tool",
        toolName: "browser.search",
        reason: "Search",
      });
      await Promise.resolve();
    });

    approveChatToolMock.mockResolvedValueOnce({ resumed: false });
    await act(async () => {
      await latest?.approve("once");
    });

    expect(approveChatToolMock).toHaveBeenCalledWith("child-session", "approval-child", { allowScope: "once" });
    expect(fetchChatPendingApprovalsMock).toHaveBeenCalledWith("child-session");
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-1", {
      background: true,
      includeThread: true,
    });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-child-deny",
        sessionId: "child-session",
        kind: "tool",
        toolName: "browser.search",
        reason: "Search",
      });
      await Promise.resolve();
    });

    denyChatToolMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await latest?.deny();
    });

    expect(denyChatToolMock).toHaveBeenCalledWith("child-session", "approval-child-deny");
  });

  it("handles branch selection, fetched-thread reconciliation, and stream status guards", async () => {
    const nextThread = {
      ...makeThread(),
      activeLeafTurnId: "turn-3",
      selectedTurnId: "turn-3",
      turns: [
        ...makeThread().turns,
        {
          ...makeThread().turns[0],
          turnId: "turn-3",
          userMessage: { ...makeThread().turns[0].userMessage, messageId: "user-3", content: "New branch" },
        },
      ],
    } as ChatThreadResponse;
    selectChatBranchTurnMock.mockResolvedValueOnce(nextThread).mockRejectedValueOnce(new Error("branch missing"));

    await act(async () => {
      create(<Harness queuedOutbound={[{ id: "queue-1", paused: false }]} />);
      await Promise.resolve();
    });

    let firstBegin = false;
    let secondBegin = true;
    await act(async () => {
      firstBegin = latest?.tryBegin() ?? false;
      secondBegin = latest?.tryBegin() ?? true;
    });
    expect(firstBegin).toBe(true);
    expect(secondBegin).toBe(false);
    await act(async () => {
      const selected = await latest?.selectBranch("turn-3");
      expect(selected).toBe(nextThread);
    });
    expect(selectChatBranchTurnMock).toHaveBeenCalledWith("session-1", "turn-3");

    await act(async () => {
      const failed = await latest?.selectBranch("missing-turn");
      expect(failed).toBeNull();
    });
    expect(latest?.getSnapshot().error).toBe("branch missing");

    await act(async () => {
      const stale = latest?.applyFetchedThread(nextThread, 99);
      expect(stale).toBe(false);
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken: "stream-1",
        turnId: "missing-turn",
        controller: new AbortController(),
      });
      const missingActive = latest?.applyFetchedThread(makeThread(), null);
      expect(missingActive).toBe(false);
      latest?.setActiveStream(null);
      const applied = latest?.applyFetchedThread(nextThread, null);
      expect(applied).toBe(true);
      await Promise.resolve();
    });
    expect(latest?.getSnapshot().mutationVersion).toBeGreaterThan(0);
  });

  it("executes local commands and reports blocked route boundaries and missing edit targets", async () => {
    const handleCommandExecution = vi.fn(async () => undefined);
    const blockedPreflight = vi.fn(async () => ({
      requestedProviderId: "local",
      requestedModel: "llama",
      effectiveProviderId: "openai-codex",
      effectiveModel: "gpt-5.5",
      selectionSource: "fallback",
      fallbackPolicy: "auto",
      fallbackResult: "local_to_cloud",
      runtimeReachability: "reachable",
      runtimeClass: "cloud",
      decision: { fingerprint: "fallback-route" },
    }));

    await act(async () => {
      create(<Harness handleCommandExecution={handleCommandExecution} ensureFreshRoutePreflight={blockedPreflight} />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-command",
        action: "send",
        content: "/plan draft rollout",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(handleCommandExecution).toHaveBeenCalledWith("session-1", "/plan draft rollout");
    expect(blockedPreflight).not.toHaveBeenCalled();

    await act(async () => {
      await latest?.execute({
        id: "queue-blocked",
        action: "send",
        content: "Use fallback",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("Please confirm the route fallback before sending.");

    await act(async () => {
      create(<Harness />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-missing",
        action: "edit",
        targetTurnId: "missing-turn",
        content: "Edited prompt",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("The selected branch turn is no longer available.");
  });

  it("buffers stream deltas into preview state until message_done promotes final content", async () => {
    vi.useFakeTimers();
    const streamDeferred = createDeferred<void>();
    let capturedOnChunk: ((chunk: any) => void) | null = null;
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      capturedOnChunk = onChunk;
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "delta",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        delta: "Streaming preview text",
      });
      await streamDeferred.promise;
    });

    await act(async () => {
      create(<Harness streamEnabled />);
    });
    let executePromise: Promise<void> | undefined;
    await act(async () => {
      executePromise = latest?.execute({
        id: "queue-stream-preview",
        action: "send",
        content: "Stream this",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(260);
      await Promise.resolve();
    });

    const midStreamSnapshot = latest!.getSnapshot();
    const streamedTurn = midStreamSnapshot.thread!.turns.find((turn) => turn.turnId === "turn-2")!;
    expect(streamedTurn.assistantMessage?.content ?? "").toBe("");
    expect(midStreamSnapshot.activeStreamingTurnId).toBe("turn-2");
    expect(midStreamSnapshot.streamingPreview).toEqual(
      expect.objectContaining({
        turnId: "turn-2",
        text: "Streaming preview text",
        visibleText: "Streaming preview text",
      }),
    );

    await act(async () => {
      capturedOnChunk?.({
        type: "message_done",
        eventId: "evt-2",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Final server text",
      });
      streamDeferred.resolve();
      await executePromise;
    });

    const finalSnapshot = latest!.getSnapshot();
    expect(finalSnapshot.streamingPreview).toBeNull();
    expect(finalSnapshot.activeStreamingTurnId).toBeNull();
    expect(finalSnapshot.thread!.turns.find((turn) => turn.turnId === "turn-2")!.assistantMessage?.content).toBe(
      "Final server text",
    );
  });

  it("promotes visible preview text when a stream aborts before message_done", async () => {
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "delta",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        delta: "Partial answer before abort",
      });
      throw { name: "AbortError" };
    });

    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-preview-abort",
        action: "send",
        content: "Stream then abort",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    const abortedSnapshot = latest!.getSnapshot();
    expect(abortedSnapshot.streamingPreview).toBeNull();
    expect(abortedSnapshot.thread!.turns.find((turn) => turn.turnId === "turn-2")!.assistantMessage?.content).toBe(
      "Partial answer before abort",
    );
  });

  it("streams edit retry and rich send chunks through the realtime path", async () => {
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-1",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "trace_update",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        trace: {
          status: "running",
          routing: {},
          durable: { runId: "durable-run-1" },
          capabilityUpgradeSuggestions: [{ kind: "skill", title: "Add skill" }],
          specialistCandidateSuggestions: [{ candidateId: "candidate-1", title: "Specialist" }],
        },
      });
      onChunk({
        type: "capability_upgrade_suggestion",
        eventId: "evt-2",
        sessionId: "session-1",
        turnId: "turn-2",
        capabilityUpgradeSuggestions: [{ kind: "mcp_server", title: "Connect server" }],
      });
      onChunk({
        type: "approval_required",
        eventId: "evt-3",
        sessionId: "session-1",
        turnId: "turn-2",
        approval: {
          approvalId: "approval-stream",
          kind: "tool",
          toolName: "browser.search",
          reason: "Search",
          riskLevel: "low",
          affectedResources: ["https://example.test"],
          remainingCount: 1,
        },
      });
      onChunk({
        type: "user_input_required",
        eventId: "evt-4",
        sessionId: "session-1",
        turnId: "turn-2",
        prompt: { turnId: "turn-2", promptId: "prompt-stream", prompt: "Need input" },
      });
      onChunk({
        type: "error",
        eventId: "evt-5",
        sessionId: "session-1",
        turnId: "turn-2",
        error: "partial stream warning",
      });
      onChunk({
        type: "message_done",
        eventId: "evt-6",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Done",
      });
    });
    streamRetryChatTurnMock.mockImplementationOnce(async (_sessionId, _turnId, _payload, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-r",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-retry",
        content: "Retried",
      });
    });
    streamEditChatTurnMock.mockImplementationOnce(async (_sessionId, _turnId, _payload, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-e",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-edit",
        content: "Edited",
      });
    });

    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream",
        action: "send",
        content: "Stream this",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().pendingUserInput).toEqual(expect.objectContaining({ promptId: "prompt-stream" }));

    await act(async () => {
      await latest?.execute({
        id: "queue-retry-stream",
        action: "retry",
        targetTurnId: "turn-1",
        content: "Original prompt",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await latest?.execute({
        id: "queue-edit-stream",
        action: "edit",
        targetTurnId: "turn-1",
        content: "Edited prompt",
        attachments: [{ attachmentId: "file-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 9 }],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(streamRetryChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({ mode: "chat" }),
      expect.any(Function),
      expect.objectContaining({ originSurface: "chat" }),
    );
    expect(streamEditChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({ attachments: ["file-1"], content: "Edited prompt" }),
      expect.any(Function),
      expect.objectContaining({ originSurface: "chat" }),
    );
  });

  it("covers null-session guards, approval detail fallbacks, and route failure paths", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValueOnce({
      activeApprovalId: null,
      remainingCount: 1,
      items: [
        {
          approvalId: "approval-active",
          stale: false,
          kind: "tool",
          toolName: "shell.exec",
          reason: "Run command",
          details: {
            affectedResources: ["F:/code/personal-ai", 7, null],
            saveCandidateOnSuccess: "yes",
          },
        },
      ],
    });
    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({
        approvalId: "approval-active",
        affectedResources: ["F:/code/personal-ai"],
        saveCandidateOnSuccess: undefined,
      }),
    );

    fetchChatPendingApprovalsMock.mockResolvedValueOnce({
      activeApprovalId: "approval-minimal",
      remainingCount: 1,
      items: [
        {
          approvalId: "approval-minimal",
          stale: false,
          kind: "tool",
          toolName: "fs.read",
          reason: "Read file",
        },
      ],
    });
    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({
        approvalId: "approval-minimal",
        affectedResources: undefined,
      }),
    );

    await act(async () => {
      create(<Harness selectedSessionId={null} selectedSession={null} />);
      await Promise.resolve();
    });
    expect(await latest?.selectBranch("turn-1")).toBeUndefined();
    await latest?.approve("once");
    await latest?.deny();
    await latest?.submitUserInput({ kind: "text", value: "ignored" });

    const blockedReason = vi.fn(async () => ({ blockedReason: "No model provider configured" }));
    await act(async () => {
      create(<Harness ensureFreshRoutePreflight={blockedReason} />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-blocked-reason",
        action: "send",
        content: "Send through blocked route",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("No model provider configured");

    const failingPreflight = vi.fn(async () => {
      throw new Error("preflight failed");
    });
    await act(async () => {
      create(<Harness ensureFreshRoutePreflight={failingPreflight} />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-preflight-error",
        action: "send",
        content: "Send through failed preflight",
        attachments: [{ attachmentId: "file-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 5 }],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("preflight failed");
  });

  it("covers thread-derived approval merges, retry failures, and prefs without route overrides", async () => {
    const approvalThread = makeThread();
    approvalThread.turns[0] = {
      ...approvalThread.turns[0],
      trace: {
        ...approvalThread.turns[0].trace,
        status: "waiting_for_approval",
        failure: { message: "Approval needed" },
        toolRuns: [
          {
            toolRunId: "tool-approval",
            status: "approval_required",
            approvalId: "approval-thread",
            toolName: "browser.search",
            failureGuidance: "Search needs approval",
          },
        ],
      },
    } as never;
    fetchChatPendingApprovalsMock.mockResolvedValueOnce({
      activeApprovalId: "approval-thread",
      remainingCount: 1,
      items: [
        {
          approvalId: "approval-thread",
          stale: false,
          kind: "tool",
          toolName: "browser.search",
          reason: "Search needs approval",
        },
      ],
    });
    await act(async () => {
      create(<Harness initialThread={approvalThread} />);
      await Promise.resolve();
    });
    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({
        approvalId: "approval-thread",
        toolName: "browser.search",
        reason: "Search needs approval",
      }),
    );

    const cloneApprovalThread = () =>
      ({
        ...approvalThread,
        turns: approvalThread.turns.map((turn) => ({
          ...turn,
          trace: {
            ...turn.trace,
            toolRuns: [...(turn.trace.toolRuns ?? [])],
          },
        })),
      }) as ChatThreadResponse;
    await act(async () => {
      create(<Harness initialThread={null} />);
      await Promise.resolve();
    });
    const existingApprovalPrompts = [
      { approvalId: "old-approval", toolName: "browser.search", reason: "Search needs approval" },
      { approvalId: "approval-thread", toolName: "shell.run", reason: "Search needs approval" },
      { approvalId: "approval-thread", toolName: "browser.search", reason: "Old reason" },
    ];
    for (const prompt of existingApprovalPrompts) {
      await act(async () => {
        latest?.setPendingApproval(prompt);
        latest?.applyFetchedThread(cloneApprovalThread(), null);
        await Promise.resolve();
      });
    }

    retryChatTurnMock.mockRejectedValueOnce(new Error("retry down"));
    await act(async () => {
      await latest?.execute({
        id: "queue-retry-fail",
        action: "retry",
        targetTurnId: "turn-1",
        content: "Original prompt",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("retry down");

    await act(async () => {
      create(
        <Harness
          prefs={{
            sessionId: "session-1",
            mode: "chat",
            webMode: "auto",
            memoryMode: "auto",
            thinkingLevel: "standard",
          }}
        />,
      );
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-send-no-route",
        action: "send",
        content: "Send without explicit provider",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(sendAgentChatMessageMock).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        content: "Send without explicit provider",
        providerId: "openai-codex",
        model: "gpt-5.5",
        routeDecision: expect.objectContaining({
          selectionSource: "session",
        }),
      }),
      { originSurface: "chat" },
    );
  });

  it("preserves queue-sourced approval when a reconciled thread cannot confirm the approval toolRun", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValueOnce({
      activeApprovalId: "approval-queue",
      remainingCount: 1,
      items: [
        {
          approvalId: "approval-queue",
          stale: false,
          kind: "tool",
          sessionId: "session-1",
          toolName: "shell.exec",
          reason: "Run from queue",
        },
      ],
    });
    await act(async () => {
      create(<Harness initialThread={null} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({ approvalId: "approval-queue", toolName: "shell.exec" }),
    );

    const threadMissingToolRun = {
      sessionId: "session-1",
      turns: [
        {
          turnId: "turn-1",
          userMessage: {
            messageId: "user-1",
            sessionId: "session-1",
            role: "user",
            actorType: "user",
            actorId: "operator",
            content: "Original prompt",
            timestamp: "2026-05-03T12:45:00.000Z",
          },
          trace: {
            status: "waiting_for_approval",
            routing: {},
            toolRuns: [],
            capabilityUpgradeSuggestions: [],
            specialistCandidateSuggestions: [],
          },
        },
      ],
      selectedTurnId: "turn-1",
      activeLeafTurnId: "turn-1",
    } as unknown as ChatThreadResponse;

    await act(async () => {
      latest?.applyFetchedThread(threadMissingToolRun, null);
      await Promise.resolve();
    });

    expect(latest?.getSnapshot().pendingApproval).toEqual(
      expect.objectContaining({ approvalId: "approval-queue", toolName: "shell.exec" }),
    );
  });

  it("handles stream aborts, non-resumable stream errors, sidebar refresh failures, and finalized reconciliation rejects", async () => {
    const loadSidebar = vi.fn(async () => {
      throw new Error("sidebar down");
    });
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "other-session",
        turnId: "turn-other",
        messageId: "assistant-other",
        branchKind: "append",
      });
      onChunk({
        type: "message_start",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      const streamToken = latest?.getSnapshot().activeStream?.streamToken ?? "stream-stale";
      latest?.setActiveStream(null);
      onChunk({
        type: "message_done",
        eventId: "evt-stale",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-stale",
        content: "Ignored stale final",
      });
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken,
        controller: new AbortController(),
        turnId: "turn-2",
      });
      onChunk({
        type: "message_done",
        eventId: "evt-2",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        content: "Streamed final",
      });
    });

    await act(async () => {
      create(<Harness streamEnabled loadSidebar={loadSidebar} />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-final",
        action: "send",
        content: "Stream and reconcile",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await Promise.resolve();
    });
    expect(loadSidebar).toHaveBeenCalled();
    expect(
      latest?.applyFetchedThread(
        {
          ...makeThread(),
          turns: [
            {
              ...makeThread().turns[0],
              assistantMessage: {
                messageId: "assistant-different",
                sessionId: "session-1",
                role: "assistant",
                actorType: "agent",
                actorId: "assistant",
                content: "Older final",
                timestamp: "2026-05-03T12:45:03.000Z",
              },
            },
          ],
        } as never,
        null,
      ),
    ).toBe(false);
    expect(
      latest?.applyFetchedThread(
        {
          ...makeThread(),
          turns: [
            {
              ...makeThread().turns[0],
              assistantMessage: {
                messageId: "assistant-2",
                sessionId: "session-1",
                role: "assistant",
                actorType: "agent",
                actorId: "assistant",
                content: "Streamed final",
                timestamp: "2026-05-03T12:45:03.000Z",
              },
            },
          ],
        } as never,
        null,
      ),
    ).toBe(true);

    streamAgentChatMessageMock.mockImplementationOnce(async () => {
      throw new Error("network failed before turn");
    });
    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-fail",
        action: "send",
        content: "Stream should fail",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("network failed before turn");

    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-resume-start",
        sessionId: "session-1",
        turnId: "turn-resume",
        messageId: "assistant-resume",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      const streamToken = latest?.getSnapshot().activeStream?.streamToken ?? "stream-resume";
      let turnReads = 0;
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken,
        controller: new AbortController(),
        lastEventId: "evt-resume-start",
        get turnId() {
          turnReads += 1;
          return turnReads === 1 ? "turn-resume" : undefined;
        },
      } as ActiveChatStreamState);
      throw new Error("transient stream failure");
    });
    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-resume-missing-turn",
        action: "send",
        content: "Lose turn before resume",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("Streaming request failed before the turn could be resumed.");

    streamAgentChatMessageMock.mockImplementationOnce(async () => {
      throw { name: "AbortError" };
    });
    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-abort",
        action: "send",
        content: "Abort stream",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBeNull();
  });

  it("runs scheduled stream reconciliation and cleans pending stream resources on unmount", async () => {
    vi.useFakeTimers();
    const loadSessionCoreState = vi.fn(async () => undefined);
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-start",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
    });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness streamEnabled loadSessionCoreState={loadSessionCoreState} />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-stream-reconcile",
        action: "send",
        content: "Reconcile after stream",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    if (loadSessionCoreState.mock.calls.length === 0) {
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
    }
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-1", {
      background: true,
      includeThread: true,
    });

    loadSessionCoreState.mockClear();
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-start-2",
        sessionId: "session-1",
        turnId: "turn-3",
        messageId: "assistant-3",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "message_done",
        eventId: "evt-done-2",
        sessionId: "session-1",
        turnId: "turn-3",
        messageId: "assistant-3",
        content: "Done",
      });
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-cleanup",
        action: "send",
        content: "Cleanup stream",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    const controller = new AbortController();
    await act(async () => {
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken: "stream-cleanup",
        controller,
      });
      renderer!.unmount();
    });
    expect(controller.signal.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(loadSessionCoreState).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("guards scheduled stream reconciliation when session or mutation version changes", async () => {
    vi.useFakeTimers();
    const loadSessionCoreState = vi.fn(async () => undefined);
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-mismatch",
        sessionId: "session-1",
        turnId: "turn-mismatch",
        messageId: "assistant-mismatch",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
    });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness streamEnabled loadSessionCoreState={loadSessionCoreState} />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-mismatch",
        action: "send",
        content: "Schedule then switch session",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    await act(async () => {
      renderer.update(
        <Harness streamEnabled selectedSessionId="session-2" loadSessionCoreState={loadSessionCoreState} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(loadSessionCoreState).not.toHaveBeenCalled();

    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-version",
        sessionId: "session-1",
        turnId: "turn-version",
        messageId: "assistant-version",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
    });
    await act(async () => {
      renderer.update(<Harness streamEnabled loadSessionCoreState={loadSessionCoreState} />);
      await Promise.resolve();
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-version",
        action: "send",
        content: "Schedule then mutate",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    await act(async () => {
      latest?.applyFetchedThread(makeThread(), null);
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(loadSessionCoreState).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(loadSessionCoreState).toHaveBeenCalledWith("session-1", {
      background: true,
      includeThread: true,
    });
    vi.useRealTimers();
  });

  it("clears deferred approval-resolve refresh timers on unmount (MCSHARED-003)", async () => {
    vi.useFakeTimers();
    const loadSessionCoreState = vi.fn(async () => undefined);
    approveChatToolMock.mockResolvedValueOnce({ resumed: false });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness loadSessionCoreState={loadSessionCoreState} />);
      await Promise.resolve();
    });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-timer",
        kind: "tool",
        toolName: "shell.exec",
        reason: "Run",
        remainingCount: 1,
      });
      await Promise.resolve();
    });

    // Resolve the approval: this fires the immediate refresh AND schedules the
    // deferred APPROVAL_FALLBACK_REFRESH_DELAYS_MS (500/1500/3000ms) timers.
    await act(async () => {
      await latest?.approve("once");
    });

    // Drop the immediate-refresh calls; we only care about the deferred timers now.
    loadSessionCoreState.mockClear();
    fetchChatPendingApprovalsMock.mockClear();

    await act(async () => {
      renderer.unmount();
    });

    // Advance well past the longest deferred delay (3000ms).
    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // None of the deferred timer callbacks should have fired after unmount.
    expect(loadSessionCoreState).not.toHaveBeenCalled();
    expect(fetchChatPendingApprovalsMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("clears deferred approval-resolve refresh timers when the session switches (MCSHARED-003)", async () => {
    vi.useFakeTimers();
    const loadSessionCoreState = vi.fn(async () => undefined);
    approveChatToolMock.mockResolvedValueOnce({ resumed: false });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness loadSessionCoreState={loadSessionCoreState} />);
      await Promise.resolve();
    });

    await act(async () => {
      latest?.setPendingApproval({
        approvalId: "approval-switch",
        kind: "tool",
        toolName: "shell.exec",
        reason: "Run",
        remainingCount: 1,
      });
      await Promise.resolve();
    });
    await act(async () => {
      await latest?.approve("once");
    });

    loadSessionCoreState.mockClear();
    fetchChatPendingApprovalsMock.mockClear();

    // Switch to a different session before the deferred timers fire.
    await act(async () => {
      renderer.update(<Harness selectedSessionId="session-2" loadSessionCoreState={loadSessionCoreState} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(3500);
      await Promise.resolve();
    });

    // The timers scheduled for the previous session must not have fired.
    expect(loadSessionCoreState).not.toHaveBeenCalled();
    expect(fetchChatPendingApprovalsMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("covers fetched-thread reconciliation fallbacks without a live active stream", async () => {
    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
    });

    expect(latest?.applyFetchedThread(makeThread(), 999)).toBe(false);
    expect(latest?.applyFetchedThread({ ...makeThread(), activeLeafTurnId: "turn-1" }, null)).toBe(true);

    await act(async () => {
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken: "stream-missing-turn",
        controller: new AbortController(),
        turnId: "turn-not-in-thread",
      });
      await Promise.resolve();
    });
    expect(latest?.applyFetchedThread(makeThread(), null)).toBe(false);

    await act(async () => {
      latest?.setActiveStream({
        sessionId: "session-1",
        streamToken: "stream-included-turn",
        controller: new AbortController(),
        turnId: "turn-1",
      });
      await Promise.resolve();
    });
    expect(latest?.applyFetchedThread(makeThread(), 99)).toBe(false);
    expect(latest?.applyFetchedThread(makeThread(), null)).toBe(true);
  });

  it("covers route-null sends, default stream chunk fallbacks, and non-Error sidebar failures", async () => {
    sendAgentChatMessageMock.mockResolvedValueOnce({
      sessionId: "session-1",
      turnId: "turn-no-trace",
      trace: {},
    });
    const loadSidebar = vi.fn(async () => {
      throw "sidebar string failure";
    });
    await act(async () => {
      create(<Harness prefs={null} ensureFreshRoutePreflight={vi.fn(async () => null)} loadSidebar={loadSidebar} />);
      await Promise.resolve();
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-null-route",
        action: "send",
        content: "Send with default prefs",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await Promise.resolve();
    });
    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "Send with default prefs",
        mode: "chat",
      }),
      { originSurface: "chat" },
    );

    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-defaults",
        sessionId: "session-1",
        turnId: "turn-defaults",
        messageId: "assistant-defaults",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({ type: "capability_upgrade_suggestion" });
      onChunk({
        type: "error",
        eventId: "evt-error-default",
        sessionId: "session-1",
        turnId: "turn-defaults",
        error: "   ",
      });
    });
    await act(async () => {
      create(<Harness streamEnabled />);
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-defaults",
        action: "send",
        content: "Stream default chunk fallbacks",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("Streaming request failed.");
  });

  it("preserves existing composer recovery state and reports failures before a session exists", async () => {
    sendAgentChatMessageMock.mockRejectedValueOnce(new Error("send failed"));
    const existingAttachment = {
      attachmentId: "existing-file",
      fileName: "existing.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
    };
    await act(async () => {
      create(
        <Harness
          initialDraft="keep this draft"
          initialPendingAttachments={[existingAttachment]}
          ensureFreshRoutePreflight={vi.fn(async () => null)}
        />,
      );
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-send-failure",
        action: "send",
        content: "restore only when empty",
        attachments: [{ attachmentId: "new-file", fileName: "new.txt", mimeType: "text/plain", sizeBytes: 3 }],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot()).toMatchObject({
      draft: "keep this draft",
      pendingAttachments: [existingAttachment],
      error: "send failed",
    });

    await act(async () => {
      create(
        <Harness
          ensureSession={vi.fn(async () => {
            throw new Error("session unavailable");
          })}
        />,
      );
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-no-session",
        sessionId: "queued-session",
        action: "send",
        content: "cannot resolve session",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBe("session unavailable");

    await act(async () => {
      create(
        <Harness
          ensureSession={vi.fn(async () => {
            throw { name: "AbortError" };
          })}
        />,
      );
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-abort-before-session",
        sessionId: "queued-session",
        action: "send",
        content: "abort before session",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });
    expect(latest?.getSnapshot().error).toBeNull();
  });

  it("reports streaming status when a send is active with a live stream", async () => {
    await act(async () => {
      create(
        <Harness
          initialSending
          initialActiveStream={{
            sessionId: "session-1",
            streamToken: "stream-active",
            controller: new AbortController(),
            turnId: "turn-1",
          }}
        />,
      );
    });

    expect(latest?.getSnapshot().streamStatus).toBe("streaming");
  });

  it("an explicit surfaceMode override sends explicit mode and no autoRoute on the first turn", async () => {
    // Render with a fresh thread (0 prior turns) and surfaceMode="code" (unlocked override path).
    // The Harness initialThread defaults to makeThread() which has 1 turn, so pass initialThread=null
    // to simulate a brand-new session where isFirstTurn=true.
    await act(async () => {
      create(<Harness surfaceMode="code" initialThread={null} />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-override",
        action: "send",
        content: "build the parser",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
    });

    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "build the parser",
        mode: "code",
      }),
      { originSurface: "code" },
    );
    // autoRoute must NOT be present when an explicit surfaceMode is provided
    expect(sendAgentChatMessageMock.mock.calls[0]?.[1]).not.toHaveProperty("autoRoute");
  });
});

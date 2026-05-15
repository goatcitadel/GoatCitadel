import React, { useCallback, useMemo, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import {
  abortActiveChatStream,
  useChatOutboundExecution,
  type ActiveChatStreamState,
} from "./useChatOutboundExecution";

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

vi.mock("../../api/client", () => ({
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
  draft: string;
  capabilitySuggestions: unknown[];
  specialistSuggestions: unknown[];
  pendingApproval: unknown;
  pendingUserInput: unknown;
  error: string | null;
  errorSource: string | null;
  thread: ChatThreadResponse | null;
  loadSessionCoreStateMock: ReturnType<typeof vi.fn>;
  setEditingTurnIdMock: ReturnType<typeof vi.fn>;
  activeStreamRef: React.MutableRefObject<ActiveChatStreamState | null>;
  messageMutationVersionRef: React.MutableRefObject<number>;
  streamStatus: string;
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  execute: (item: any) => Promise<void>;
  applyFetchedThread: (thread: ChatThreadResponse, requestVersion: number | null) => boolean;
  setPendingApproval: (value: any) => void;
  setPendingUserInput: (value: any) => void;
  approvePending: (allowScope?: "once" | "session" | "workspace") => Promise<void>;
  denyPending: () => Promise<void>;
  submitUserInput: (response: any) => Promise<void>;
  selectBranch: (turnId: string) => Promise<ChatThreadResponse | null | undefined>;
  pushLocalNoticeMock: ReturnType<typeof vi.fn>;
};

let latest: HarnessState | null = null;

function makeThread(): ChatThreadResponse {
  return {
    sessionId: "session-1",
    turns: [
      {
        turnId: "turn-1",
        parentTurnId: undefined,
        userMessage: {
          messageId: "user-1",
          sessionId: "session-1",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "Original prompt",
          timestamp: "2026-04-08T00:00:00.000Z",
        },
        assistantMessage: {
          messageId: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: "Latest news summary",
          timestamp: "2026-04-08T00:00:01.000Z",
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

function Harness(props: {
  streamEnabled?: boolean;
  selectedSessionId?: string | null;
  selectedSession?: any;
  queuedOutbound?: any[];
  initialSending?: boolean;
  initialError?: string | null;
  initialActiveStream?: ActiveChatStreamState | null;
  onCommand?: (sessionId: string, command: string) => Promise<void>;
  ensureFreshRoutePreflight?: ReturnType<typeof vi.fn>;
  isRoutePreflightAcknowledged?: (hash: string) => boolean;
}) {
  const [thread, setThread] = useState<ChatThreadResponse | null>(makeThread());
  const [draft, setDraft] = useState("");
  const [, setPendingAttachments] = useState<any[]>([]);
  const [capabilitySuggestions, setCapabilitySuggestions] = useState<any[]>([]);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<any[]>([]);
  const [sending, setSending] = useState(props.initialSending ?? false);
  const [error, setErrorState] = useState<string | null>(props.initialError ?? null);
  const [errorSource, setErrorSource] = useState<string | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  if (props.initialActiveStream && !activeStreamRef.current) {
    activeStreamRef.current = props.initialActiveStream;
  }
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateMock = useMemo(() => vi.fn(async () => undefined), []);
  const setEditingTurnIdMock = useMemo(() => vi.fn(), []);
  const pushLocalNoticeMock = useMemo(() => vi.fn(), []);
  const ensureFreshRoutePreflight = useMemo(
    () =>
      props.ensureFreshRoutePreflight ??
      vi.fn(async () => ({
        requestedProviderId: "openai",
        requestedModel: "gpt-5.4-mini",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4-mini",
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "not_checked",
        runtimeClass: "cloud",
        decision: {
          action: "send",
          issuedAt: "2026-04-24T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          requestedProviderId: "openai",
          requestedModel: "gpt-5.4-mini",
          effectiveProviderId: "openai",
          effectiveModel: "gpt-5.4-mini",
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
  const setError = useCallback((value: string | null, source = "other") => {
    setErrorState(value);
    setErrorSource(value ? source : null);
  }, []);

  const messages = useMemo(() => {
    return (
      thread?.turns.flatMap((turn) => [turn.userMessage, ...(turn.assistantMessage ? [turn.assistantMessage] : [])]) ??
      []
    );
  }, [thread]);

  const hook = useChatOutboundExecution({
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
    streamEnabled: props.streamEnabled ?? false,
    sending,
    error,
    queuedOutbound: props.queuedOutbound ?? [],
    activeStreamRef,
    prefs: {
      sessionId: "session-1",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
    } as any,
    thread,
    messages: messages as any,
    setThread,
    setError,
    setSending,
    setDraft,
    setPendingAttachments,
    setEditingTurnId: setEditingTurnIdMock,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    loadSidebar: vi.fn(async () => undefined),
    loadSessionCoreState: loadSessionCoreStateMock,
    ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
    pushLocalNotice: pushLocalNoticeMock,
    handleCommandExecution: props.onCommand ?? vi.fn(async () => undefined),
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    ensureFreshRoutePreflight,
    isRoutePreflightAcknowledged: props.isRoutePreflightAcknowledged ?? (() => false),
  });

  latest = {
    draft,
    capabilitySuggestions,
    specialistSuggestions,
    pendingApproval: hook.pendingApproval,
    pendingUserInput: hook.pendingUserInput,
    error,
    errorSource,
    thread,
    loadSessionCoreStateMock,
    setEditingTurnIdMock,
    activeStreamRef,
    messageMutationVersionRef,
    streamStatus: hook.streamStatus,
    setThread,
    execute: executeOutboundItemRef.current,
    applyFetchedThread: applyFetchedThreadRef.current,
    setPendingApproval: hook.setPendingApproval,
    setPendingUserInput: hook.setPendingUserInput,
    approvePending: hook.handleApprovePending,
    denyPending: hook.handleDenyPending,
    submitUserInput: hook.handleSubmitUserInput,
    selectBranch: hook.handleSelectBranchTurn,
    pushLocalNoticeMock,
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
    approveChatToolMock.mockResolvedValue({
      ok: true,
      approvalId: "approval-default",
      allowScope: "once",
      resumed: true,
    });
    answerChatUserInputPromptMock.mockResolvedValue({
      ok: true,
      sessionId: "session-1",
      turnId: "turn-input",
      promptId: "prompt-1",
      resumed: false,
    });
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
        content: "Run the task",
        timestamp: "2026-04-08T00:00:02.000Z",
      },
      assistantMessage: {
        messageId: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "Done",
        timestamp: "2026-04-08T00:00:03.000Z",
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
      turnId: "turn-retry",
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
      turnId: "turn-edit",
      trace: {
        status: "completed",
        routing: {},
        toolRuns: [],
        capabilityUpgradeSuggestions: [],
        specialistCandidateSuggestions: [],
      },
    });
    selectChatBranchTurnMock.mockResolvedValue({
      ...makeThread(),
      selectedTurnId: "turn-branch",
      activeLeafTurnId: "turn-branch",
    });
  });

  it("short-circuits slash commands through the local command executor", async () => {
    const onCommand = vi.fn(async () => undefined);
    create(<Harness onCommand={onCommand} />);

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "/help",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(onCommand).toHaveBeenCalledWith("session-1", "/help");
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(streamAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("approves a pending tool request and clears the approval state", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-1",
        toolName: "shell_command",
        reason: "Needs approval",
      });
    });

    await act(async () => {
      await latest?.approvePending();
    });

    expect(approveChatToolMock).toHaveBeenCalledWith("session-1", "approval-1", { allowScope: "once" });
    expect(latest?.pendingApproval).toBeNull();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it("can escalate a pending tool request into a session grant", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-2",
        toolName: "shell_command",
        reason: "Needs approval",
      });
    });

    await act(async () => {
      await latest?.approvePending("session");
    });

    expect(approveChatToolMock).toHaveBeenCalledWith("session-1", "approval-2", { allowScope: "session" });
    expect(latest?.pendingApproval).toBeNull();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it("rejects stale fetched thread data after a finalized streamed reply", async () => {
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
        content: "Latest news summary",
      });
    });

    create(<Harness streamEnabled />);

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    const applied = latest?.applyFetchedThread(
      {
        sessionId: "session-1",
        turns: [
          {
            turnId: "turn-1",
            userMessage: latest?.thread?.turns[0]?.userMessage,
            trace: { status: "completed", routing: {}, toolRuns: [] },
          },
        ],
        selectedTurnId: "turn-1",
        activeLeafTurnId: "turn-1",
      } as any,
      null,
    );

    expect(applied).toBe(false);
  });

  it("reconciles immediately when a stream ends after deltas without message_done", async () => {
    vi.useFakeTimers();
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
        type: "delta",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-2",
        messageId: "assistant-2",
        delta: "partial",
      });
    });

    create(<Harness streamEnabled />);

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(latest?.thread?.turns.at(-1)?.assistantMessage?.content).toBe("partial");

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });

    expect(latest?.loadSessionCoreStateMock).toHaveBeenCalledWith("session-1", {
      background: true,
      includeThread: true,
    });
    vi.useRealTimers();
  });

  it("handles stream suggestions, approval prompts, user input prompts, and chunk errors", async () => {
    streamAgentChatMessageMock.mockImplementation(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-start",
        sessionId: "session-1",
        turnId: "turn-stream",
        messageId: "assistant-stream",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "trace_update",
        eventId: "evt-trace",
        sessionId: "session-1",
        turnId: "turn-stream",
        trace: {
          durable: { runId: "durable-run-1" },
          capabilityUpgradeSuggestions: [{ capabilityId: "browser.search", reason: "Need web." }],
          specialistCandidateSuggestions: [{ roleId: "researcher", reason: "Need synthesis." }],
        },
      });
      onChunk({
        type: "capability_upgrade_suggestion",
        eventId: "evt-capability",
        sessionId: "session-1",
        turnId: "turn-stream",
        capabilityUpgradeSuggestions: [{ capabilityId: "filesystem.read", reason: "Need files." }],
      });
      onChunk({
        type: "approval_required",
        eventId: "evt-approval",
        sessionId: "session-1",
        turnId: "turn-stream",
        approval: {
          approvalId: "approval-stream-1",
          kind: "tool.invoke",
          toolName: "shell_command",
          reason: "Needs review.",
          riskLevel: "high",
          expiresAt: "2026-04-08T00:10:00.000Z",
          details: {},
          remainingCount: 1,
          affectedResources: ["repo"],
        },
      });
      onChunk({
        type: "user_input_required",
        eventId: "evt-input",
        sessionId: "session-1",
        turnId: "turn-stream",
        prompt: {
          promptId: "prompt-stream-1",
          turnId: "turn-stream",
          kind: "text",
          title: "Need detail",
          question: "Provide the missing value.",
          required: true,
        },
      });
      onChunk({
        type: "error",
        eventId: "evt-error",
        sessionId: "session-1",
        turnId: "turn-stream",
        error: "stream chunk failed",
      });
    });

    create(<Harness streamEnabled />);

    await act(async () => {
      await latest?.execute({
        id: "queue-stream-rich",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(latest?.capabilitySuggestions).toEqual([{ capabilityId: "filesystem.read", reason: "Need files." }]);
    expect(latest?.specialistSuggestions).toEqual([{ roleId: "researcher", reason: "Need synthesis." }]);
    expect(latest?.pendingApproval).toBeNull();
    expect(latest?.pendingUserInput).toMatchObject({ promptId: "prompt-stream-1" });
    expect(latest?.error).toBe("stream chunk failed");
    expect(latest?.errorSource).toBe("send");
  });

  it("resumes an interrupted stream when the first stream attempt has a turn id", async () => {
    streamAgentChatMessageMock.mockImplementationOnce(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-start",
        sessionId: "session-1",
        turnId: "turn-resume",
        messageId: "assistant-resume",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      throw new Error("network dropped");
    });
    resumeChatTurnStreamMock.mockImplementationOnce(async (_sessionId, _turnId, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-done",
        sessionId: "session-1",
        turnId: "turn-resume",
        messageId: "assistant-resume",
        content: "Resumed answer",
      });
    });

    create(<Harness streamEnabled />);

    await act(async () => {
      await latest?.execute({
        id: "queue-resume",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(resumeChatTurnStreamMock).toHaveBeenCalledWith(
      "session-1",
      "turn-resume",
      expect.any(Function),
      expect.objectContaining({ sinceEventId: "evt-start", originSurface: "chat" }),
    );
    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith(
      "Stream interrupted. Reconnecting to turn resume.",
      "warning",
    );
  });

  it("streams retry and edit branch actions through their dedicated endpoints", async () => {
    streamRetryChatTurnMock.mockImplementation(async (_sessionId, _turnId, _payload, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-retry-done",
        sessionId: "session-1",
        turnId: "turn-retry",
        messageId: "assistant-retry",
        content: "Retried answer",
      });
    });
    streamEditChatTurnMock.mockImplementation(async (_sessionId, _turnId, _payload, onChunk) => {
      onChunk({
        type: "message_done",
        eventId: "evt-edit-done",
        sessionId: "session-1",
        turnId: "turn-edit",
        messageId: "assistant-edit",
        content: "Edited answer",
      });
    });

    create(<Harness streamEnabled />);

    await act(async () => {
      await latest?.execute({
        id: "queue-stream-retry",
        action: "retry",
        content: "",
        targetTurnId: "turn-1",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });
    await act(async () => {
      await latest?.execute({
        id: "queue-stream-edit",
        action: "edit",
        content: "Updated prompt",
        targetTurnId: "turn-1",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(streamRetryChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({ providerId: "openai", model: "gpt-5.4-mini" }),
      expect.any(Function),
      expect.any(Object),
    );
    expect(streamEditChatTurnMock).toHaveBeenCalledWith(
      "session-1",
      "turn-1",
      expect.objectContaining({ content: "Updated prompt", useMemory: true }),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it("merges backend-delivered approval prompts into the local pending approval state", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [
        {
          approvalId: "approval-merge-1",
          kind: "tool.invoke",
          toolName: "shell_command",
          reason: "Operator confirmation required.",
          stale: false,
          details: {},
        },
      ],
      activeApprovalId: "approval-merge-1",
      remainingCount: 0,
    });

    create(<Harness />);

    await act(async () => {
      latest?.setThread({
        sessionId: "session-1",
        turns: [
          {
            turnId: "turn-approval",
            userMessage: {
              messageId: "user-approval",
              sessionId: "session-1",
              role: "user",
              actorType: "user",
              actorId: "operator",
              content: "Run guarded action",
              timestamp: "2026-04-08T00:00:00.000Z",
            },
            trace: {
              status: "waiting_for_approval",
              routing: {},
              toolRuns: [
                {
                  toolRunId: "tool-run-1",
                  turnId: "turn-approval",
                  sessionId: "session-1",
                  toolName: "shell_command",
                  status: "approval_required",
                  approvalId: "approval-merge-1",
                  startedAt: "2026-04-08T00:00:01.000Z",
                  failureGuidance: "Operator confirmation required.",
                },
              ],
            },
          },
        ],
        selectedTurnId: "turn-approval",
        activeLeafTurnId: "turn-approval",
      } as any);
      await Promise.resolve();
    });

    expect(latest?.pendingApproval).toEqual({
      approvalId: "approval-merge-1",
      kind: "tool.invoke",
      toolName: "shell_command",
      reason: "Operator confirmation required.",
      remainingCount: 0,
    });
  });

  it("maps rich pending approval queue details and ignores stale queue entries", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [
        {
          approvalId: "approval-stale",
          kind: "tool.invoke",
          toolName: "stale_tool",
          stale: true,
          details: {},
        },
        {
          approvalId: "approval-rich",
          kind: "tool.invoke",
          toolName: "filesystem.write",
          reason: "Write release notes",
          riskLevel: "caution",
          expiresAt: "2026-04-08T00:10:00.000Z",
          stale: false,
          details: {
            codeHash: "code-hash",
            wrapperManifestHash: "wrapper-hash",
            capabilitySnapshotId: "snapshot-1",
            inspectPath: "README.md",
            requestedOutputIntent: "patch",
            saveCandidateOnSuccess: true,
            affectedResources: ["README.md", 42, "package.json"],
            codePreview: "diff --git",
          },
        },
      ],
      activeApprovalId: "approval-rich",
      remainingCount: 1,
    });

    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
    });

    expect(latest?.pendingApproval).toMatchObject({
      approvalId: "approval-rich",
      kind: "tool.invoke",
      toolName: "filesystem.write",
      reason: "Write release notes",
      riskLevel: "caution",
      expiresAt: "2026-04-08T00:10:00.000Z",
      codeHash: "code-hash",
      wrapperManifestHash: "wrapper-hash",
      capabilitySnapshotId: "snapshot-1",
      inspectPath: "README.md",
      requestedOutputIntent: "patch",
      saveCandidateOnSuccess: true,
      affectedResources: ["README.md", "package.json"],
      codePreview: "diff --git",
      remainingCount: 1,
    });
  });

  it("clears pending blockers when the active session id disappears", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-clear-session",
        toolName: "shell_command",
        reason: "Needs approval",
      });
      latest?.setPendingUserInput({
        promptId: "prompt-clear-session",
        turnId: "turn-input",
        kind: "text",
        title: "Need detail",
        question: "Share detail",
      });
    });

    await act(async () => {
      renderer!.update(<Harness selectedSessionId={null} selectedSession={null} />);
      await Promise.resolve();
    });

    expect(latest?.pendingApproval).toBeNull();
    expect(latest?.pendingUserInput).toBeNull();
  });

  it("submits pending user-input prompts and clears local prompt state", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingUserInput({
        promptId: "prompt-1",
        turnId: "turn-input",
        kind: "text",
        title: "Need detail",
        question: "Share the missing detail.",
        required: true,
      });
    });

    await act(async () => {
      await latest?.submitUserInput({
        kind: "text",
        text: "final answer",
      });
    });

    expect(answerChatUserInputPromptMock).toHaveBeenCalledWith("session-1", "turn-input", "prompt-1", {
      response: {
        kind: "text",
        text: "final answer",
      },
    });
    expect(latest?.pendingUserInput).toBeNull();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it("preserves prior pending approval context when provider selection fails before dispatch", async () => {
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [
        {
          approvalId: "approval-keep-1",
          kind: "tool.invoke",
          toolName: "shell_command",
          reason: "Still waiting",
          stale: false,
          details: {},
        },
      ],
      activeApprovalId: "approval-keep-1",
      remainingCount: 0,
    });
    create(
      <Harness
        ensureFreshRoutePreflight={vi.fn(async () => ({
          requestedProviderId: undefined,
          requestedModel: undefined,
          effectiveProviderId: undefined,
          effectiveModel: undefined,
          selectionSource: "global",
          fallbackPolicy: "off",
          fallbackResult: "not_applicable",
          runtimeReachability: "not_checked",
          runtimeClass: "unknown",
          blockedReason: "No model provider is configured yet. Open Configure and connect a provider first.",
          decision: {
            action: "send",
            issuedAt: "2026-04-24T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            selectionSource: "global",
            fallbackPolicy: "off",
            fallbackResult: "not_applicable",
            runtimeReachability: "not_checked",
            runtimeClass: "unknown",
            blockedReason: "No model provider is configured yet. Open Configure and connect a provider first.",
            fingerprint: "blocked-route-fingerprint",
          },
        }))}
      />,
    );

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-keep-1",
        toolName: "shell_command",
        reason: "Still waiting",
      });
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(latest?.pendingApproval).toMatchObject({
      approvalId: "approval-keep-1",
      toolName: "shell_command",
      reason: "Still waiting",
    });
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
  });

  it("clears pending approval only when outbound execution commits", async () => {
    create(<Harness />);

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-clear-1",
        toolName: "shell_command",
        reason: "Ready to proceed",
      });
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(sendAgentChatMessageMock).toHaveBeenCalledOnce();
    expect(latest?.pendingApproval).toBeNull();
  });

  it("restores the draft content when a send fails", async () => {
    sendAgentChatMessageMock.mockRejectedValue(
      new Error(
        'API error 400: {"error":"image generation failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"This prompt was rejected by policy because it references a copyrighted character.\\"}}"}',
      ),
    );

    create(<Harness />);

    await act(async () => {
      await latest?.execute({
        id: "queue-1",
        action: "send",
        content: "I want you to create an image of a horse who looks like spongebob squarepants",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(latest?.draft).toBe("I want you to create an image of a horse who looks like spongebob squarepants");
    expect(latest?.error).toContain("This prompt was rejected by policy");
    expect(latest?.errorSource).toBe("send");
  });

  it("tags approval resolution failures with the approval error source", async () => {
    let renderer: ReactTestRenderer;
    approveChatToolMock.mockRejectedValue(new Error('API error 400: {"message":"Approval could not be recorded."}'));

    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-1",
        toolName: "shell_command",
        reason: "Needs approval",
      });
    });

    await act(async () => {
      await latest?.approvePending();
    });

    expect(latest?.error).toContain("Approval could not be recorded.");
    expect(latest?.errorSource).toBe("approval");

    await act(async () => {
      renderer!.unmount();
    });
  });

  it("dispatches retry and edit actions through non-streaming mutation endpoints", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.execute({
        id: "queue-retry",
        action: "retry",
        content: "",
        targetTurnId: "turn-1",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-edit",
        action: "edit",
        content: "Updated prompt",
        targetTurnId: "turn-1",
        attachments: [
          {
            attachmentId: "attachment-1",
            fileName: "report.txt",
            mimeType: "text/plain",
            sizeBytes: 42,
          },
        ],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(retryChatTurnMock).toHaveBeenCalledWith("session-1", "turn-1", {
      providerId: "openai",
      model: "gpt-5.4-mini",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
    });
    expect(editChatTurnMock).toHaveBeenCalledWith("session-1", "turn-1", {
      content: "Updated prompt",
      attachments: ["attachment-1"],
      useMemory: true,
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4-mini",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
    });
  });

  it("denies pending approvals and refreshes the queue", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-deny-1",
        toolName: "shell_command",
        reason: "Needs approval",
      });
    });

    await act(async () => {
      await latest?.denyPending();
    });

    expect(denyChatToolMock).toHaveBeenCalledWith("session-1", "approval-deny-1");
    expect(fetchChatPendingApprovalsMock).toHaveBeenCalledWith("session-1");
    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith(
      "Denied request approval-deny-1. No action was taken.",
      "warning",
    );
    expect(latest?.pendingApproval).toBeNull();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it("selects branch turns and reports branch selection failures", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.selectBranch("turn-branch");
    });

    expect(selectChatBranchTurnMock).toHaveBeenCalledWith("session-1", "turn-branch");
    expect(latest?.thread?.selectedTurnId).toBe("turn-branch");

    selectChatBranchTurnMock.mockRejectedValueOnce(new Error("branch missing"));

    await act(async () => {
      await latest?.selectBranch("turn-missing");
    });

    expect(latest?.error).toBe("branch missing");
    expect(latest?.errorSource).toBe("branch_select");

    create(<Harness selectedSessionId={null} selectedSession={null} />);
    const result = await latest?.selectBranch("turn-no-session");
    expect(result).toBeUndefined();
    expect(selectChatBranchTurnMock).not.toHaveBeenLastCalledWith("session-1", "turn-no-session");
  });

  it("rejects stale fetched threads and fetched threads missing the active stream turn", async () => {
    create(<Harness />);

    act(() => {
      latest!.messageMutationVersionRef.current = 2;
    });

    let staleApplied: boolean | undefined;
    act(() => {
      staleApplied = latest?.applyFetchedThread(makeThread(), 1);
    });
    expect(staleApplied).toBe(false);

    act(() => {
      latest!.messageMutationVersionRef.current = 0;
      latest!.activeStreamRef.current = {
        sessionId: "session-1",
        streamToken: "stream-active",
        turnId: "turn-active",
        controller: new AbortController(),
      };
    });

    let missingActiveApplied: boolean | undefined;
    act(() => {
      missingActiveApplied = latest?.applyFetchedThread(makeThread(), null);
    });
    expect(missingActiveApplied).toBe(false);

    const appliedThread = {
      ...makeThread(),
      turns: [
        ...makeThread().turns,
        {
          turnId: "turn-active",
          userMessage: {
            messageId: "user-active",
            sessionId: "session-1",
            role: "user",
            actorType: "user",
            actorId: "operator",
            content: "Active stream",
            timestamp: "2026-04-08T00:00:04.000Z",
          },
          trace: { status: "running", routing: {}, toolRuns: [] },
        },
      ],
      selectedTurnId: "turn-active",
      activeLeafTurnId: "turn-active",
    } as any;

    let applied: boolean | undefined;
    act(() => {
      applied = latest?.applyFetchedThread(appliedThread, null);
    });
    expect(applied).toBe(true);
    expect(latest?.thread?.selectedTurnId).toBe("turn-active");
  });

  it("blocks unacknowledged route fallback boundaries before dispatch", async () => {
    const ensureFreshRoutePreflight = vi.fn(async () => ({
      requestedProviderId: "local",
      requestedModel: "llama",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4-mini",
      selectionSource: "fallback",
      fallbackPolicy: "auto",
      fallbackResult: "local_to_cloud",
      runtimeReachability: "unreachable",
      runtimeClass: "cloud",
      decision: {
        action: "send",
        issuedAt: "2026-04-24T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        requestedProviderId: "local",
        requestedModel: "llama",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4-mini",
        selectionSource: "fallback",
        fallbackPolicy: "auto",
        fallbackResult: "local_to_cloud",
        runtimeReachability: "unreachable",
        runtimeClass: "cloud",
        fingerprint: "fallback-route",
      },
    }));
    create(
      <Harness ensureFreshRoutePreflight={ensureFreshRoutePreflight} isRoutePreflightAcknowledged={() => false} />,
    );
    sendAgentChatMessageMock.mockClear();

    await act(async () => {
      await latest?.execute({
        id: "queue-fallback",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(ensureFreshRoutePreflight).toHaveBeenCalledWith({
      sessionId: "session-1",
      action: "send",
      turnId: undefined,
    });
    expect(sendAgentChatMessageMock).not.toHaveBeenCalled();
    expect(latest?.error).toBe("Acknowledge the predicted fallback route boundary before continuing.");
    expect(latest?.errorSource).toBe("send");
  });

  it("reports missing retry/edit target turns and restores edit state", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.execute({
        id: "queue-missing-edit",
        action: "edit",
        content: "Updated prompt",
        targetTurnId: "turn-missing",
        attachments: [{ attachmentId: "attachment-1", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(editChatTurnMock).not.toHaveBeenCalled();
    expect(latest?.error).toBe("The selected branch turn is no longer available.");
    expect(latest?.errorSource).toBe("edit");
    expect(latest?.draft).toBe("Updated prompt");
    expect(latest?.setEditingTurnIdMock).toHaveBeenCalledWith("turn-missing");

    await act(async () => {
      await latest?.execute({
        id: "queue-missing-retry",
        action: "retry",
        content: "",
        targetTurnId: "turn-missing",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    expect(retryChatTurnMock).not.toHaveBeenCalled();
    expect(latest?.errorSource).toBe("other");
  });

  it("covers approval/user-input no-op, workspace grants, denial errors, and resumed prompt notices", async () => {
    create(<Harness />);

    await act(async () => {
      await latest?.approvePending();
      await latest?.denyPending();
      await latest?.submitUserInput({ kind: "text", text: "ignored" });
    });

    expect(approveChatToolMock).not.toHaveBeenCalled();
    expect(denyChatToolMock).not.toHaveBeenCalled();
    expect(answerChatUserInputPromptMock).not.toHaveBeenCalled();

    approveChatToolMock.mockResolvedValueOnce({
      ok: true,
      approvalId: "approval-workspace",
      allowScope: "workspace",
      resumed: false,
    });
    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-workspace",
        toolName: "shell_command",
        reason: "Needs workspace grant",
      });
    });

    await act(async () => {
      await latest?.approvePending("workspace");
    });

    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith(
      expect.stringContaining("Workspace allow created. If the run is no longer live"),
      "success",
    );

    denyChatToolMock.mockRejectedValueOnce(new Error("deny failed"));
    act(() => {
      latest?.setPendingApproval({
        approvalId: "approval-deny-error",
        toolName: "shell_command",
        reason: "Needs denial",
      });
    });
    await act(async () => {
      await latest?.denyPending();
    });

    expect(latest?.error).toBe("deny failed");
    expect(latest?.errorSource).toBe("approval");

    answerChatUserInputPromptMock.mockResolvedValueOnce({
      ok: true,
      sessionId: "session-1",
      turnId: "turn-input",
      promptId: "prompt-resume",
      resumed: true,
    });
    act(() => {
      latest?.setPendingUserInput({
        promptId: "prompt-resume",
        turnId: "turn-input",
        kind: "text",
        title: "Need detail",
        question: "Share detail",
      });
    });
    await act(async () => {
      await latest?.submitUserInput({ kind: "text", text: "detail" });
    });

    expect(latest?.pushLocalNoticeMock).toHaveBeenCalledWith(
      "Submitted response for prompt-resume. The turn resumed immediately.",
      "success",
    );

    answerChatUserInputPromptMock.mockRejectedValueOnce(new Error("input failed"));
    act(() => {
      latest?.setPendingUserInput({
        promptId: "prompt-fail",
        turnId: "turn-input",
        kind: "text",
        title: "Need detail",
        question: "Share detail",
      });
    });
    await act(async () => {
      await latest?.submitUserInput({ kind: "text", text: "detail" });
    });

    expect(latest?.error).toBe("input failed");
    expect(latest?.errorSource).toBe("user_input");
  });

  it("derives stream status from error, active stream, sending, queued, and idle states", () => {
    create(<Harness initialError="failed" />);
    expect(latest?.streamStatus).toBe("error");

    create(<Harness initialSending />);
    expect(latest?.streamStatus).toBe("connecting");

    create(
      <Harness
        queuedOutbound={[
          { id: "paused", paused: true },
          { id: "queued", paused: false },
        ]}
      />,
    );
    expect(latest?.streamStatus).toBe("queued");

    create(
      <Harness
        initialSending
        initialActiveStream={{
          sessionId: "session-1",
          streamToken: "streaming",
          controller: new AbortController(),
        }}
      />,
    );
    expect(latest?.streamStatus).toBe("streaming");

    create(<Harness />);
    expect(latest?.streamStatus).toBe("idle");
  });

  it("aborts only live active streams", () => {
    const abortedController = new AbortController();
    abortedController.abort();
    const liveController = new AbortController();

    abortActiveChatStream(null);
    abortActiveChatStream({ sessionId: "s", streamToken: "t", controller: abortedController });
    expect(abortedController.signal.aborted).toBe(true);

    abortActiveChatStream({ sessionId: "s", streamToken: "t", controller: liveController });
    expect(liveController.signal.aborted).toBe(true);
  });

  it("clears scheduled stream reconciliation work on unmount", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    streamAgentChatMessageMock.mockImplementation(async (_sessionId, _payload, onChunk) => {
      onChunk({
        type: "message_start",
        eventId: "evt-0",
        sessionId: "session-1",
        turnId: "turn-cleanup",
        messageId: "assistant-cleanup",
        branchKind: "append",
        parentTurnId: "turn-1",
      });
      onChunk({
        type: "delta",
        eventId: "evt-1",
        sessionId: "session-1",
        turnId: "turn-cleanup",
        messageId: "assistant-cleanup",
        delta: "partial",
      });
    });
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Harness streamEnabled />);
    });

    await act(async () => {
      await latest?.execute({
        id: "queue-cleanup",
        action: "send",
        content: "Run the task",
        attachments: [],
        createdAt: "2026-04-08T00:00:00.000Z",
      });
    });

    await act(async () => {
      renderer!.unmount();
    });

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});

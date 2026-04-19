import React, { useMemo, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { useChatOutboundExecution, type ActiveChatStreamState } from "./useChatOutboundExecution";

const approveChatToolMock = vi.fn();
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
  error: string | null;
  thread: ChatThreadResponse | null;
  loadSessionCoreStateMock: ReturnType<typeof vi.fn>;
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  execute: (item: any) => Promise<void>;
  applyFetchedThread: (thread: ChatThreadResponse, requestVersion: number | null) => boolean;
  setPendingApproval: (value: any) => void;
  approvePending: (allowScope?: "once" | "session" | "workspace") => Promise<void>;
  denyPending: () => Promise<void>;
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
  onCommand?: (sessionId: string, command: string) => Promise<void>;
}) {
  const [thread, setThread] = useState<ChatThreadResponse | null>(makeThread());
  const [draft, setDraft] = useState("");
  const [, setPendingAttachments] = useState<any[]>([]);
  const [capabilitySuggestions, setCapabilitySuggestions] = useState<any[]>([]);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);
  const loadSessionCoreStateMock = useMemo(() => vi.fn(async () => undefined), []);

  const messages = useMemo(() => {
    return (
      thread?.turns.flatMap((turn) => [turn.userMessage, ...(turn.assistantMessage ? [turn.assistantMessage] : [])]) ??
      []
    );
  }, [thread]);

  const hook = useChatOutboundExecution({
    selectedSessionId: "session-1",
    selectedSession: {
      sessionId: "session-1",
      projectId: "project-1",
      pinned: false,
      lifecycleStatus: "active",
      scope: "mission",
    } as any,
    providerOptions: [{ providerId: "openai", label: "OpenAI", models: ["gpt-5.4-mini"] }] as any,
    selectedProviderId: "openai",
    selectedModel: "gpt-5.4-mini",
    streamEnabled: props.streamEnabled ?? false,
    sending,
    error,
    queuedOutbound: [],
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
    setEditingTurnId: vi.fn(),
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    loadSidebar: vi.fn(async () => undefined),
    loadSessionCoreState: loadSessionCoreStateMock,
    ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
    getCachedModels: vi.fn(() => ["gpt-5.4-mini"]),
    pushLocalNotice: vi.fn(),
    handleCommandExecution: props.onCommand ?? vi.fn(async () => undefined),
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
  });

  latest = {
    draft,
    capabilitySuggestions,
    specialistSuggestions,
    pendingApproval: hook.pendingApproval,
    error,
    thread,
    loadSessionCoreStateMock,
    setThread,
    execute: executeOutboundItemRef.current,
    applyFetchedThread: applyFetchedThreadRef.current,
    setPendingApproval: hook.setPendingApproval,
    approvePending: hook.handleApprovePending,
    denyPending: hook.handleDenyPending,
  };
  return null;
}

describe("useChatOutboundExecution", () => {
  beforeEach(() => {
    latest = null;
    approveChatToolMock.mockReset();
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
    fetchChatPendingApprovalsMock.mockResolvedValue({
      items: [],
      activeApprovalId: null,
      remainingCount: 0,
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
});

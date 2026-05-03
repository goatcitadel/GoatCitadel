import React, { useCallback, useMemo, useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { useChatOutboundExecution, type ActiveChatStreamState } from "./useChatOutboundExecution";

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

function Harness(props: { streamEnabled?: boolean; surfaceMode?: "chat" | "cowork" | "code" }) {
  const [thread, setThread] = useState<ChatThreadResponse | null>(makeThread());
  const [, setDraft] = useState("");
  const [, setPendingAttachments] = useState<any[]>([]);
  const [, setCapabilitySuggestions] = useState<any[]>([]);
  const [, setSpecialistSuggestions] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);
  const ensureFreshRoutePreflight = useMemo(
    () =>
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
    [],
  );
  const setError = useCallback((value: string | null) => {
    setErrorState(value);
  }, []);
  const messages = useMemo(() => thread?.turns.map((turn) => turn.userMessage) ?? [], [thread]);

  useChatOutboundExecution({
    surfaceMode: props.surfaceMode,
    selectedSessionId: "session-1",
    selectedSession: {
      sessionId: "session-1",
      projectId: "project-1",
      pinned: false,
      lifecycleStatus: "active",
      scope: "mission",
    } as any,
    streamEnabled: props.streamEnabled ?? false,
    sending,
    error,
    queuedOutbound: [],
    activeStreamRef,
    prefs: {
      sessionId: "session-1",
      mode: "chat",
      providerId: "openai-codex",
      model: "gpt-5.5",
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
    loadSessionCoreState: vi.fn(async () => undefined),
    ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
    pushLocalNotice: vi.fn(),
    handleCommandExecution: vi.fn(async () => undefined),
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    ensureFreshRoutePreflight,
    isRoutePreflightAcknowledged: () => false,
  });

  latest = {
    execute: executeOutboundItemRef.current,
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

  it("sends the locked Cowork surface mode even when session prefs still say Chat", async () => {
    await act(async () => {
      create(<Harness surfaceMode="cowork" />);
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
});

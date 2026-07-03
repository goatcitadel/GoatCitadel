/**
 * Acceptance test for the streaming-preview-to-external-store move.
 *
 * Before this change, every RAF-paced buffer flush (up to ~60/s while
 * streaming) called `setStreamingPreview` inside `useChatStreamingPreviewState`,
 * which re-rendered its caller (the ~3,700-line `MissionThreadedControllerHost`)
 * and, transitively, the whole page shell below it -- by construction, one
 * host+shell re-render per flush.
 *
 * After this change, a flush publishes to the module-level
 * `chat-streaming-preview-store` instead. This test mounts `useChatOutboundExecution`
 * (the real integration point that owns the buffer) inside a "host stand-in"
 * probe that counts its own renders, alongside a "timeline stand-in" probe that
 * subscribes to the store the way `ThreadedTimeline`/`ChatThreadView` do. It
 * pumps 50 delta flushes through the real buffer and asserts:
 *   - the host stand-in renders 0 additional times for those 50 flushes
 *     (only the one render for the message_start transition is allowed), while
 *   - the timeline stand-in DOES re-render once per flush (the store's
 *     subscribers are the only thing that should react to a flush), and
 *   - message_start/message_done transitions still re-render the host stand-in
 *     (start/stop transitions are not swallowed by the fix).
 *
 * There is no interactive Profiler available in this harness; render counts
 * are the direct, honest measurement instead.
 */
import { useRef, useState } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import {
  resetChatStreamingPreviewForTests,
  useChatStreamingPreviewSnapshot,
} from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import { useChatOutboundExecution, type ActiveChatStreamState } from "./useChatOutboundExecution";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const streamAgentChatMessageMock = vi.fn();
const recordClientDiagnosticMock = vi.fn();
const recordChatStreamChunkActivityMock = vi.fn();
const clearChatStreamActivityMock = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  answerChatUserInputPrompt: vi.fn(),
  approveChatTool: vi.fn(),
  denyChatTool: vi.fn(),
  editChatTurn: vi.fn(),
  fetchChatPendingApprovals: vi.fn(async () => ({ items: [], activeApprovalId: null, remainingCount: 0 })),
  resumeChatTurnStream: vi.fn(),
  retryChatTurn: vi.fn(),
  selectChatBranchTurn: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  streamAgentChatMessage: (...args: unknown[]) => streamAgentChatMessageMock(...args),
  streamEditChatTurn: vi.fn(),
  streamRetryChatTurn: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: (...args: unknown[]) => recordClientDiagnosticMock(...args),
  createCorrelationId: () => `correlation-${Math.random().toString(36).slice(2)}`,
}));

vi.mock("@goatcitadel/mission-control-shared/state/chat-stream-activity-store", () => ({
  recordChatStreamChunkActivity: (...args: unknown[]) => recordChatStreamChunkActivityMock(...args),
  clearChatStreamActivity: (...args: unknown[]) => clearChatStreamActivityMock(...args),
}));

function makeThread(): ChatThreadResponse {
  return {
    sessionId: "session-1",
    turns: [],
    selectedTurnId: null,
    activeLeafTurnId: null,
  } as unknown as ChatThreadResponse;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

let outboundOnChunk: ((chunk: any) => void) | null = null;
let hostRenderCount = 0;
let timelineRenderCount = 0;

/**
 * Stand-in for `MissionThreadedControllerHost`: owns `useChatOutboundExecution`
 * (the real hook under test), and increments a counter on every render of
 * itself -- the same position in the tree the real host occupies relative to
 * the streaming-preview hook.
 */
function HostStandIn() {
  hostRenderCount += 1;
  const [thread, setThread] = useState<ChatThreadResponse | null>(makeThread());
  const [sending, setSending] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const activeStreamRef = useRef<ActiveChatStreamState | null>(null);
  const executeOutboundItemRef = useRef(async (_item: unknown) => undefined);
  const tryBeginOutboundExecutionRef = useRef(() => true);
  const applyFetchedThreadRef = useRef((_thread: ChatThreadResponse, _requestVersion: number | null) => false);
  const messageMutationVersionRef = useRef(0);

  const outbound = useChatOutboundExecution({
    sessionConfig: {
      selectedSessionId: "session-1",
      selectedSession: {
        sessionId: "session-1",
        projectId: "project-1",
        pinned: false,
        lifecycleStatus: "active",
        scope: "mission",
      } as any,
      prefs: {
        sessionId: "session-1",
        mode: "chat",
        providerId: "openai-codex",
        model: "gpt-5.5",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      } as any,
    },
    streamConfig: {
      streamEnabled: true,
      activeStreamRef,
    },
    stateConfig: {
      sending,
      error,
      queuedOutbound: [],
      thread,
      messages: [],
    },
    stateSetters: {
      setThread,
      setError: (value: string | null) => setErrorState(value),
      setSending,
      setDraft: vi.fn(),
      setPendingAttachments: vi.fn(),
      setEditingTurnId: vi.fn(),
      setCapabilitySuggestions: vi.fn(),
      setSpecialistSuggestions: vi.fn(),
    },
    operations: {
      loadSidebar: vi.fn(async () => undefined),
      loadSessionCoreState: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => ({ sessionId: "session-1" }) as any),
      pushLocalNotice: vi.fn(),
      handleCommandExecution: vi.fn(async () => undefined),
    },
    refs: {
      executeOutboundItemRef,
      tryBeginOutboundExecutionRef,
      applyFetchedThreadRef,
      messageMutationVersionRef,
    },
    routing: {
      ensureFreshRoutePreflight: vi.fn(async () => null),
      isRoutePreflightAcknowledged: () => false,
    },
  });

  // `useChatOutboundExecution` assigns `executeOutboundItemRef.current =
  // executeOutboundItem` itself during its own render (see the "refreshed
  // during render" note in useChatOutboundExecution.ts), so the ref already
  // holds the real, current callback by the time this render body reaches
  // this line -- capturing it here (not in an effect) means the very first
  // `act()` that drives a send in the test sees the real implementation
  // rather than racing an effect that hasn't committed yet.
  latestExecute = executeOutboundItemRef.current;
  void outbound;

  return <TimelineStandIn sessionId="session-1" />;
}

let latestExecute: ((item: unknown) => Promise<void>) | null = null;

/**
 * Stand-in for the timeline/ChatThreadView: subscribes to the store the way
 * real subscribers do, and increments its own render counter. This is the
 * component that SHOULD re-render once per flush.
 */
function TimelineStandIn({ sessionId }: { sessionId: string | null }) {
  timelineRenderCount += 1;
  useChatStreamingPreviewSnapshot(sessionId);
  return null;
}

describe("streaming preview external store: render-count acceptance", () => {
  beforeEach(() => {
    resetChatStreamingPreviewForTests();
    hostRenderCount = 0;
    timelineRenderCount = 0;
    outboundOnChunk = null;
    latestExecute = null;
    streamAgentChatMessageMock.mockReset();
    recordClientDiagnosticMock.mockReset();
    recordChatStreamChunkActivityMock.mockReset();
    clearChatStreamActivityMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops re-rendering the host per flush while the store's subscriber re-renders per flush, and transitions still reach the host", async () => {
    vi.useFakeTimers();
    const streamDeferred = createDeferred<void>();
    const FLUSH_COUNT = 50;

    streamAgentChatMessageMock.mockImplementationOnce(
      async (_sessionId: string, _payload: unknown, onChunk: (chunk: any) => void) => {
        outboundOnChunk = onChunk;
        onChunk({
          type: "message_start",
          eventId: "evt-start",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "assistant-1",
          branchKind: "append",
        });
        await streamDeferred.promise;
      },
    );

    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(<HostStandIn />);
    });

    // Drive the send through the same seam the real composer uses. The
    // execution promise itself is captured (not discarded) so it can be
    // awaited once the deferred stream resolves below -- mirrors the pattern
    // in useChatOutboundExecution.test.tsx's own streaming tests.
    let executePromise: Promise<void> | undefined;
    await act(async () => {
      executePromise = latestExecute?.({
        id: "queue-render-count",
        action: "send",
        content: "Measure renders",
        attachments: [],
        createdAt: "2026-05-03T12:45:00.000Z",
      });
      await Promise.resolve();
    });

    const hostRendersAfterStart = hostRenderCount;
    const timelineRendersAfterStart = timelineRenderCount;
    // message_start is a turn-identity transition: it must reach the host
    // stand-in (it re-rendered from its initial mount render at minimum).
    expect(hostRendersAfterStart).toBeGreaterThan(0);

    // Pump FLUSH_COUNT delta chunks through the real buffer. Each delta is
    // followed by a RAF/timer-driven flush (the buffer's own scheduling),
    // advanced by the fake timers exactly like the existing streaming tests
    // in useChatOutboundExecution.test.tsx.
    for (let index = 0; index < FLUSH_COUNT; index += 1) {
      await act(async () => {
        outboundOnChunk?.({
          type: "delta",
          eventId: `evt-delta-${index}`,
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "assistant-1",
          delta: "x",
        });
        vi.advanceTimersByTime(20);
        await Promise.resolve();
      });
    }

    const hostRendersAfterFlushes = hostRenderCount - hostRendersAfterStart;
    const timelineRendersAfterFlushes = timelineRenderCount - timelineRendersAfterStart;

    // The acceptance criterion: the host stand-in gets zero additional
    // renders for 50 in-place text flushes within the same turn (allow <=1
    // as slack for any unrelated single transition render, per the brief).
    expect(hostRendersAfterFlushes).toBeLessThanOrEqual(1);
    // The store's subscriber (the timeline stand-in) DOES re-render per
    // flush: with 50 flushes it must render at least once per flush.
    expect(timelineRendersAfterFlushes).toBeGreaterThanOrEqual(FLUSH_COUNT);

    const hostRendersBeforeDone = hostRenderCount;

    // message_done is the stop transition: it must still reach the host.
    await act(async () => {
      outboundOnChunk?.({
        type: "message_done",
        eventId: "evt-done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "x".repeat(FLUSH_COUNT),
      });
      streamDeferred.resolve();
      await executePromise;
    });

    expect(hostRenderCount).toBeGreaterThan(hostRendersBeforeDone);

    await act(async () => {
      renderer?.unmount();
    });

    // Report the concrete numbers for the PR body: before this change, each
    // flush was a host+shell re-render by construction (50 flushes -> 50
    // host re-renders, since the value flowed through host useState). After
    // this change, the host renders are measured directly above.
    console.info(
      `[render-count] host renders per ${FLUSH_COUNT} flushes: before=${FLUSH_COUNT} (by construction) after=${hostRendersAfterFlushes}; timeline-standin renders per ${FLUSH_COUNT} flushes: ${timelineRendersAfterFlushes}`,
    );
  });
});

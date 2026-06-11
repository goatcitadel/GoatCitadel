import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord, ChatStreamChunk } from "@goatcitadel/contracts";
import { useBtwSideChatController } from "./useBtwSideChatController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createChatSideChatMock = vi.hoisted(() => vi.fn());
const fetchChatThreadMock = vi.hoisted(() => vi.fn());
const preflightChatRouteMock = vi.hoisted(() => vi.fn());
const streamAgentChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createChatSideChat: (...args: unknown[]) => createChatSideChatMock(...args),
  fetchChatThread: (...args: unknown[]) => fetchChatThreadMock(...args),
  preflightChatRoute: (...args: unknown[]) => preflightChatRouteMock(...args),
  streamAgentChatMessage: (...args: unknown[]) => streamAgentChatMessageMock(...args),
}));

type Controller = ReturnType<typeof useBtwSideChatController>;

let latest: Controller | null = null;

function Harness() {
  latest = useBtwSideChatController({
    workspaceId: "workspace-1",
    selectedSession: null,
    selectedSessionId: "parent-1",
    selectedTurnId: null,
    currentSurface: "chat",
    prefs: null,
    fullWebAccess: false,
    ensureSession: async () => ({ sessionId: "parent-1" }) as unknown as ChatSessionRecord,
    pushLocalNotice: () => undefined,
    setUiError: () => undefined,
  });
  return null;
}

function emptyChildThread() {
  return {
    sessionId: "child-1",
    selectedTurnId: null,
    activeLeafTurnId: null,
    turns: [],
  };
}

describe("useBtwSideChatController streaming preview", () => {
  let renderer: ReactTestRenderer | undefined;
  let emitChunk: ((chunk: ChatStreamChunk) => void) | null = null;
  let resolveStream: (() => void) | null = null;
  let rejectStream: ((cause: Error) => void) | null = null;

  beforeEach(() => {
    latest = null;
    emitChunk = null;
    resolveStream = null;
    rejectStream = null;
    createChatSideChatMock.mockReset().mockResolvedValue({
      item: { sideChatId: "side-1", parentSessionId: "parent-1", childSessionId: "child-1" },
      childSession: { sessionId: "child-1" },
    });
    fetchChatThreadMock.mockReset().mockResolvedValue(emptyChildThread());
    preflightChatRouteMock.mockReset().mockResolvedValue({ decision: "primary" });
    streamAgentChatMessageMock.mockReset().mockImplementation(
      (_sessionId: string, _payload: unknown, onChunk: (chunk: ChatStreamChunk) => void) => {
        emitChunk = onChunk;
        return new Promise<void>((resolve, reject) => {
          resolveStream = resolve;
          rejectStream = reject;
        });
      },
    );
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  }

  // The preview buffer batches via real 16ms frame-fallback and 50ms max-delay
  // timers in the node environment; waiting comfortably past both is deterministic.
  function waitForPreviewTimers(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 120));
  }

  // Wrapped in an object because `await` would otherwise flatten the returned
  // (still pending) send promise and stall the test.
  async function startStreamingSend(): Promise<{ sendPromise: Promise<void> }> {
    await act(async () => {
      renderer = create(<Harness />);
    });
    let sendPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      sendPromise = latest!.openSideChat("hello");
      await flushMicrotasks();
    });
    expect(emitChunk).not.toBeNull();
    await act(async () => {
      emitChunk!({
        type: "message_start",
        sessionId: "child-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        eventId: "e1",
        sequence: 0,
        branchKind: "append",
      } as never);
    });
    return { sendPromise };
  }

  it("buffers deltas outside the thread and flushes the preview at frame cadence", async () => {
    const { sendPromise } = await startStreamingSend();

    const threadAfterStart = latest!.panelProps.thread;
    expect(threadAfterStart?.turns).toHaveLength(1);
    expect(threadAfterStart?.turns[0]?.assistantMessage?.content).toBe("");

    await act(async () => {
      emitChunk!({ type: "delta", sessionId: "child-1", turnId: "turn-1", messageId: "assistant-1", delta: "Hel", eventId: "e2", sequence: 1 } as never);
      emitChunk!({ type: "delta", sessionId: "child-1", turnId: "turn-1", messageId: "assistant-1", delta: "lo", eventId: "e3", sequence: 2 } as never);
    });

    // Deltas never touch the thread: identity is stable and the optimistic
    // assistant message stays empty until a real chunk boundary.
    expect(latest!.panelProps.thread).toBe(threadAfterStart);
    expect(latest!.panelProps.thread?.turns[0]?.assistantMessage?.content).toBe("");

    await act(async () => {
      await waitForPreviewTimers();
    });
    expect(latest!.panelProps.streamingPreview).toMatchObject({
      sessionId: "child-1",
      turnId: "turn-1",
      text: "Hello",
    });
    expect(latest!.panelProps.thread).toBe(threadAfterStart);

    const finalThread = {
      ...emptyChildThread(),
      selectedTurnId: "turn-1",
      activeLeafTurnId: "turn-1",
      turns: [
        {
          ...threadAfterStart!.turns[0]!,
          assistantMessage: {
            ...threadAfterStart!.turns[0]!.assistantMessage!,
            content: "Hello world",
          },
        },
      ],
    };
    fetchChatThreadMock.mockResolvedValue(finalThread);
    await act(async () => {
      emitChunk!({
        type: "message_done",
        sessionId: "child-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "Hello world",
        eventId: "e4",
        sequence: 3,
      } as never);
      resolveStream!();
      await sendPromise;
    });
    await act(async () => {
      await waitForPreviewTimers();
    });

    expect(latest!.panelProps.streamingPreview).toBeNull();
    expect(latest!.panelProps.thread?.turns[0]?.assistantMessage?.content).toBe("Hello world");
    expect(latest!.panelProps.sending).toBe(false);
    expect(latest!.panelProps.error).toBeNull();
  });

  it("promotes the buffered preview into the thread when the stream fails", async () => {
    const { sendPromise } = await startStreamingSend();

    await act(async () => {
      emitChunk!({ type: "delta", sessionId: "child-1", turnId: "turn-1", messageId: "assistant-1", delta: "Partial answer", eventId: "e2", sequence: 1 } as never);
    });
    expect(latest!.panelProps.thread?.turns[0]?.assistantMessage?.content).toBe("");

    await act(async () => {
      rejectStream!(new Error("boom"));
      await sendPromise;
    });
    await act(async () => {
      await waitForPreviewTimers();
    });

    expect(latest!.panelProps.error).toBe("boom");
    expect(latest!.panelProps.streamingPreview).toBeNull();
    expect(latest!.panelProps.thread?.turns[0]?.assistantMessage?.content).toBe("Partial answer");
    expect(latest!.panelProps.sending).toBe(false);
  });
});

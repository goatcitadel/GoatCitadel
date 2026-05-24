import React, { useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  cancelChatTurn: vi.fn(),
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  cancelChatTurn: apiMocks.cancelChatTurn,
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: apiMocks.recordClientDiagnostic,
}));

import {
  resolveOutboundDraftContent,
  resolveOutboundContentWithContext,
  useChatSurfaceOrchestration,
  type OutboundContextBlock,
  type OutboundQueueItem,
} from "./useChatSurfaceOrchestration";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessSnapshot {
  queuedOutbound: OutboundQueueItem[];
  editingTurnId: string | null;
  draft: string;
  pendingAttachments: unknown[];
}

interface HarnessApi {
  controller: ReturnType<typeof useChatSurfaceOrchestration>;
  snapshot: () => HarnessSnapshot;
  executeOutbound: ReturnType<typeof vi.fn>;
  tryBegin: ReturnType<typeof vi.fn>;
  pushNotice: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
  setPendingApproval: ReturnType<typeof vi.fn>;
  abortActiveChatStream: ReturnType<typeof vi.fn>;
  loadSessionCoreState: ReturnType<typeof vi.fn>;
  composerFocus: ReturnType<typeof vi.fn>;
  activeStreamRef: React.RefObject<{
    sessionId: string;
    streamToken: string;
    turnId?: string;
    controller: AbortController;
  } | null>;
}

let latest: HarnessApi | null = null;

function Harness(props: {
  initialDraft?: string;
  initialAttachments?: unknown[];
  selectedSessionId?: string | null;
  outboundContext?: OutboundContextBlock | null;
  onOutboundContextConsumed?: ReturnType<typeof vi.fn>;
  sending?: boolean;
  canBegin?: boolean;
  activeStream?: { sessionId: string; streamToken: string; turnId?: string; controller: AbortController } | null;
}) {
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const [pendingAttachments, setPendingAttachments] = useState<unknown[]>(props.initialAttachments ?? []);
  const tryBegin = useRef(vi.fn(() => props.canBegin ?? true));
  tryBegin.current.mockImplementation(() => props.canBegin ?? true);
  const executeOutbound = useRef(vi.fn(async (_item: OutboundQueueItem) => undefined));
  const pushNotice = useRef(vi.fn());
  const setError = useRef(vi.fn());
  const setPendingApproval = useRef(vi.fn());
  const abortActiveChatStream = useRef(vi.fn());
  const loadSessionCoreState = useRef(vi.fn(async () => undefined));
  const activeStreamRef = useRef(props.activeStream ?? null);
  const composerFocus = useRef(vi.fn());
  const composerRef = useRef({ focus: composerFocus.current } as unknown as HTMLTextAreaElement);
  const controller = useChatSurfaceOrchestration({
    draft,
    pendingAttachments: pendingAttachments as never,
    outboundContext: props.outboundContext ?? null,
    selectedSessionId: props.selectedSessionId === undefined ? "session-1" : props.selectedSessionId,
    thread: {
      turns: [
        {
          turnId: "turn-1",
          userMessage: { content: "Original prompt" },
        },
      ],
    } as never,
    sending: props.sending ?? false,
    composerRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef: tryBegin,
    executeOutboundItemRef: executeOutbound,
    pushLocalNoticeRef: pushNotice,
    setDraft,
    setPendingAttachments: setPendingAttachments as never,
    setPendingApproval: setPendingApproval.current,
    setError: setError.current,
    onOutboundContextConsumed: props.onOutboundContextConsumed,
    loadSessionCoreStateRef: loadSessionCoreState,
    abortActiveChatStream: abortActiveChatStream.current,
  });

  latest = {
    controller,
    snapshot: () => ({
      queuedOutbound: controller.queuedOutbound,
      editingTurnId: controller.editingTurnId,
      draft,
      pendingAttachments,
    }),
    executeOutbound: executeOutbound.current,
    tryBegin: tryBegin.current,
    pushNotice: pushNotice.current,
    setError: setError.current,
    setPendingApproval: setPendingApproval.current,
    abortActiveChatStream: abortActiveChatStream.current,
    loadSessionCoreState: loadSessionCoreState.current,
    composerFocus: composerFocus.current,
    activeStreamRef,
  };
  return null;
}

function mountHarness(props: Parameters<typeof Harness>[0] = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness {...props} />);
  });
  return renderer;
}

describe("useChatSurfaceOrchestration", () => {
  beforeEach(() => {
    latest = null;
    apiMocks.cancelChatTurn.mockReset();
    apiMocks.recordClientDiagnostic.mockReset();
  });

  it("resolves attachment-only draft content only for send actions", () => {
    expect(resolveOutboundDraftContent("  hello  ", 0)).toBe("hello");
    expect(resolveOutboundDraftContent("   ", 1, "send")).toBe("Please review the attached files and continue.");
    expect(resolveOutboundDraftContent("   ", 1, "edit")).toBe("");
    expect(resolveOutboundDraftContent("   ", 0, "send")).toBe("");
    expect(
      resolveOutboundContentWithContext(" Follow up ", { label: "1 selected turn", content: " Prior answer " }),
    ).toBe("[Selected conversation context]\nPrior answer\n\n[New message]\nFollow up");
  });

  it("sends selected conversation context with the next message and clears it", async () => {
    const onOutboundContextConsumed = vi.fn();
    mountHarness({
      initialDraft: "What should I do next?",
      outboundContext: {
        label: "1 selected turn",
        sourceLabel: "Launch plan",
        sourceSessionId: "session-source",
        turnIds: ["turn-1"],
        content:
          "Source thread: Launch plan\n\nTurn turn-1\nYou: Build the launch plan\nGoatCitadel: Launch plan ready.",
      },
      onOutboundContextConsumed,
    });

    await act(async () => {
      await latest!.controller.handleSend();
    });

    const item = latest!.executeOutbound.mock.calls[0]?.[0] as OutboundQueueItem;
    expect(item.content).toContain("[Selected conversation context]");
    expect(item.content).toContain("Source thread: Launch plan");
    expect(item.content).toContain("[New message]");
    expect(item.content).toContain("What should I do next?");
    expect(onOutboundContextConsumed).toHaveBeenCalledTimes(1);
  });

  it("sends immediately when execution can begin and queues when it cannot", async () => {
    mountHarness({ initialDraft: "   " });
    await act(async () => {
      await latest!.controller.handleSend();
    });
    expect(latest!.executeOutbound).not.toHaveBeenCalled();

    mountHarness({ initialDraft: " Coordinate rollout ", initialAttachments: [{ attachmentId: "a1" }] });
    await act(async () => {
      await latest!.controller.handleSend();
    });
    expect(latest!.executeOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        sessionId: "session-1",
        content: "Coordinate rollout",
        attachments: [{ attachmentId: "a1" }],
      }),
    );
    expect(latest!.snapshot()).toMatchObject({ draft: "", pendingAttachments: [] });
    expect(latest!.setPendingApproval).toHaveBeenCalledWith(null);

    mountHarness({ initialDraft: "Queue me", canBegin: false });
    await act(async () => {
      await latest!.controller.handleSend();
    });
    expect(latest!.executeOutbound).not.toHaveBeenCalled();
    expect(latest!.snapshot().queuedOutbound[0]).toMatchObject({
      action: "send",
      content: "Queue me",
    });
    expect(latest!.snapshot().queuedOutbound[0]).not.toHaveProperty("paused");
    expect(latest!.pushNotice).toHaveBeenCalledWith("Message queued while the current turn finishes.");
  });

  it("supports edit and retry queue flows", async () => {
    mountHarness({ initialDraft: "", canBegin: false });
    act(() => {
      latest!.controller.handleBeginEditTurn("turn-1");
    });
    expect(latest!.snapshot().editingTurnId).toBe("turn-1");
    expect(latest!.snapshot().draft).toBe("Original prompt");
    expect(latest!.composerFocus).toHaveBeenCalled();

    await act(async () => {
      await latest!.controller.handleSend();
    });
    expect(latest!.snapshot().queuedOutbound[0]).toMatchObject({
      action: "edit",
      targetTurnId: "turn-1",
      content: "Original prompt",
    });
    expect(latest!.pushNotice).toHaveBeenCalledWith("Edit queued while the current turn finishes.");

    await act(async () => {
      await latest!.controller.handleRetryTurn("turn-1");
    });
    expect(latest!.snapshot().queuedOutbound[1]).toMatchObject({
      action: "retry",
      targetTurnId: "turn-1",
    });
    expect(latest!.snapshot().queuedOutbound[0]?.id).not.toBe(latest!.snapshot().queuedOutbound[1]?.id);
    expect(latest!.pushNotice).toHaveBeenCalledWith("Retry queued while the current turn finishes.");

    mountHarness({ canBegin: true });
    await act(async () => {
      await latest!.controller.handleRetryTurn("turn-1");
    });
    expect(latest!.executeOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ action: "retry", targetTurnId: "turn-1" }),
    );
  });

  it("drains unpaused queue items when sending stops and execution can begin", async () => {
    const renderer = mountHarness({ initialDraft: "Queue then drain", canBegin: false, sending: true });
    await act(async () => {
      await latest!.controller.handleSend();
    });
    expect(latest!.snapshot().queuedOutbound).toHaveLength(1);

    await act(async () => {
      renderer.update(<Harness initialDraft="" canBegin sending={false} />);
      await Promise.resolve();
    });
    expect(latest!.executeOutbound).toHaveBeenCalledWith(expect.objectContaining({ content: "Queue then drain" }));
    expect(latest!.snapshot().queuedOutbound).toHaveLength(0);
  });

  it("stops active turns and reports cancel errors", async () => {
    apiMocks.cancelChatTurn.mockResolvedValue(undefined);
    mountHarness({
      activeStream: {
        sessionId: "session-1",
        streamToken: "stream-1",
        turnId: "turn-active-123456",
        controller: new AbortController(),
      },
    });

    await act(async () => {
      await latest!.controller.handleStopActiveTurn();
    });
    expect(apiMocks.cancelChatTurn).toHaveBeenCalledWith("session-1", "turn-active-123456", "mission-control");
    expect(latest!.pushNotice).toHaveBeenCalledWith("Stopped turn 123456.", "warning");
    expect(latest!.loadSessionCoreState).toHaveBeenCalledWith("session-1", {
      background: true,
      includeThread: true,
    });
    expect(latest!.abortActiveChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-active-123456" }),
    );

    mountHarness({
      activeStream: {
        sessionId: "session-1",
        streamToken: "stream-2",
        controller: new AbortController(),
      },
    });
    await act(async () => {
      await latest!.controller.handleStopActiveTurn();
    });
    expect(latest!.pushNotice).toHaveBeenCalledWith(
      "Stopped the local connection before the turn id was assigned.",
      "warning",
    );

    apiMocks.cancelChatTurn.mockRejectedValue(new Error("cancel failed"));
    mountHarness({
      activeStream: {
        sessionId: "session-1",
        streamToken: "stream-3",
        turnId: "turn-fail",
        controller: new AbortController(),
      },
    });
    await act(async () => {
      await latest!.controller.handleStopActiveTurn();
    });
    expect(latest!.setError).toHaveBeenCalledWith("cancel failed");

    mountHarness({ selectedSessionId: null });
    await act(async () => {
      await latest!.controller.handleStopActiveTurn();
    });
    expect(latest!.abortActiveChatStream).not.toHaveBeenCalled();

    mountHarness();
    await act(async () => {
      await latest!.controller.handleStopActiveTurn();
    });
    expect(latest!.abortActiveChatStream).not.toHaveBeenCalled();

    act(() => {
      latest!.controller.handleBeginEditTurn("missing-turn");
    });
    expect(latest!.snapshot().editingTurnId).toBeNull();
  });

  it("records resume and remove queue diagnostics", async () => {
    mountHarness({ initialDraft: "Queue diagnostics", canBegin: false });
    await act(async () => {
      await latest!.controller.handleSend();
    });
    act(() => {
      latest!.controller.setQueuedOutbound((current) => current.map((item) => ({ ...item, paused: true })));
    });

    act(() => {
      latest!.controller.handleResumeQueue();
    });
    expect(apiMocks.recordClientDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "queue.resume",
        context: { queuedCount: 1 },
      }),
    );
    expect(latest!.snapshot().queuedOutbound[0]?.paused).toBe(false);

    const id = latest!.snapshot().queuedOutbound[0]!.id;
    act(() => {
      latest!.controller.handleRemoveQueuedItem(id);
    });
    expect(apiMocks.recordClientDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "queue.remove",
        context: { id },
      }),
    );
    expect(latest!.snapshot().queuedOutbound).toEqual([]);
  });
});

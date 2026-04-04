import React, { useMemo, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSurfaceOrchestration } from "./useChatSurfaceOrchestration";

const cancelChatTurnMock = vi.fn();

vi.mock("../../api/client", () => ({
  cancelChatTurn: (...args: unknown[]) => cancelChatTurnMock(...args),
}));

type HarnessControls = ReturnType<typeof useChatSurfaceOrchestration> & {
  draft: string;
  pendingAttachments: Array<{ attachmentId: string; fileName: string }>;
  error: string | null;
};

let latestControls: HarnessControls | null = null;

function Harness(props: {
  canExecute: boolean;
  sending?: boolean;
  activeStream?: {
    sessionId: string;
    streamToken: string;
    turnId?: string;
    controller: AbortController;
  } | null;
  onExecute: (item: unknown) => void;
  onAbort: (stream: unknown) => void;
  onReload: () => void;
  notices: Array<{ message: string; tone?: string }>;
}) {
  const [draft, setDraft] = useState("Ship the narrow fix");
  const [pendingAttachments, setPendingAttachments] = useState([
    { attachmentId: "attachment-1", fileName: "spec.md" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [, setPendingApproval] = useState<null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeStreamRef = useRef(props.activeStream ?? null);
  activeStreamRef.current = props.activeStream ?? null;

  const tryBeginOutboundExecutionRef = useRef<() => boolean>(() => props.canExecute);
  tryBeginOutboundExecutionRef.current = () => props.canExecute;

  const executeOutboundItemRef = useRef(async (item: unknown) => {
    props.onExecute(item);
  });
  executeOutboundItemRef.current = async (item: unknown) => {
    props.onExecute(item);
  };

  const pushLocalNoticeRef = useRef((message: string, tone?: string) => {
    props.notices.push({ message, tone });
  });
  pushLocalNoticeRef.current = (message: string, tone?: string) => {
    props.notices.push({ message, tone });
  };

  const loadSessionCoreStateRef = useRef(async () => {
    props.onReload();
  });
  loadSessionCoreStateRef.current = async () => {
    props.onReload();
  };

  const thread = useMemo(() => ({
    sessionId: "session-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: { content: "Original prompt" },
      },
    ],
  }), []);

  const controls = useChatSurfaceOrchestration({
    draft,
    pendingAttachments: pendingAttachments as any,
    selectedSessionId: "session-1",
    thread: thread as any,
    sending: props.sending ?? false,
    composerRef,
    activeStreamRef,
    tryBeginOutboundExecutionRef,
    executeOutboundItemRef,
    pushLocalNoticeRef,
    setDraft,
    setPendingAttachments: setPendingAttachments as any,
    setPendingApproval,
    setError,
    loadSessionCoreStateRef,
    abortActiveChatStream: props.onAbort as any,
  });

  latestControls = {
    ...controls,
    draft,
    pendingAttachments,
    error,
  };

  return null;
}

describe("useChatSurfaceOrchestration", () => {
  beforeEach(() => {
    latestControls = null;
    cancelChatTurnMock.mockReset();
  });

  it("queues outbound sends when execution is still busy", async () => {
    const notices: Array<{ message: string; tone?: string }> = [];
    create(
      <Harness
        canExecute={false}
        onExecute={vi.fn()}
        onAbort={vi.fn()}
        onReload={vi.fn()}
        notices={notices}
      />,
    );

    await act(async () => {
      await latestControls?.handleSend();
    });

    expect(latestControls?.draft).toBe("");
    expect(latestControls?.queuedOutbound).toHaveLength(1);
    expect(latestControls?.queuedOutbound[0]?.action).toBe("send");
    expect(notices[0]?.message).toContain("queued");
  });

  it("hands queued work to the executor once the surface can run again", async () => {
    const notices: Array<{ message: string; tone?: string }> = [];
    const onExecute = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness
          canExecute={false}
          sending
          onExecute={onExecute}
          onAbort={vi.fn()}
          onReload={vi.fn()}
          notices={notices}
        />,
      );
    });

    await act(async () => {
      await latestControls?.handleRetryTurn("turn-1");
    });
    expect(latestControls?.queuedOutbound).toHaveLength(1);

    await act(async () => {
      renderer!.update(
        <Harness
          canExecute
          sending={false}
          onExecute={onExecute}
          onAbort={vi.fn()}
          onReload={vi.fn()}
          notices={notices}
        />,
      );
      await Promise.resolve();
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ action: "retry", targetTurnId: "turn-1" });
    expect(latestControls?.queuedOutbound).toHaveLength(0);
  });

  it("owns stop-turn recovery by cancelling the turn, reloading, and aborting the stream", async () => {
    cancelChatTurnMock.mockResolvedValue(undefined);
    const onAbort = vi.fn();
    const onReload = vi.fn();
    const stream = {
      sessionId: "session-1",
      streamToken: "stream-1",
      turnId: "turn-1",
      controller: new AbortController(),
    };

    create(
      <Harness
        canExecute={false}
        activeStream={stream}
        onExecute={vi.fn()}
        onAbort={onAbort}
        onReload={onReload}
        notices={[]}
      />,
    );

    await act(async () => {
      await latestControls?.handleStopActiveTurn();
    });

    expect(cancelChatTurnMock).toHaveBeenCalledWith("session-1", "turn-1", "mission-control");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledWith(stream);
    expect(latestControls?.error).toBeNull();
  });
});

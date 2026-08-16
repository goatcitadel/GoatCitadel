import { describe, expect, it, vi } from "vitest";
import { forwardRef, useImperativeHandle } from "react";
import TestRenderer from "react-test-renderer";
import type { ChatThreadResponse, ChatStreamingPreview } from "@goatcitadel/contracts";
import { ChatThreadView } from "./ChatThreadView";

// Shared spy for the imperative scrollToIndex the manual scroll-drive calls. The mock
// Virtuoso forwards a ref exposing this spy so we can assert exactly when the manual
// nudge fires (it must NOT fire per streamed token).
const scrollToIndexSpy = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef<unknown, any>(function MockVirtuoso(
    { atBottomStateChange, className, components, computeItemKey, data = [], followOutput, itemContent, style },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: scrollToIndexSpy }), []);
    if (followOutput) {
      atBottomStateChange?.(true);
    }
    const Header = components?.Header;
    const Footer = components?.Footer;
    return (
      <div className={className} style={style} data-virtuoso="true">
        {Header ? <Header /> : null}
        {data.map((item: any, index: number) => (
          <div key={computeItemKey?.(index, item) ?? item.turnId ?? index} data-virtuoso-item="true">
            {itemContent(index, item)}
          </div>
        ))}
        {Footer ? <Footer /> : null}
      </div>
    );
  }),
}));

function makeTurn(turnId: string, userContent: string, assistantContent: string) {
  return {
    turnId,
    userMessage: {
      messageId: `user-${turnId}`,
      sessionId: "sess-scroll",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: userContent,
      timestamp: "2026-04-04T00:00:00.000Z",
    },
    assistantMessage: {
      messageId: `assistant-${turnId}`,
      sessionId: "sess-scroll",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: assistantContent,
      timestamp: "2026-04-04T00:00:01.000Z",
    },
    toolRuns: [],
    citations: [],
    branch: { siblingCount: 1, activeSiblingIndex: 0, siblingTurnIds: [turnId] },
    branchKind: "append",
    trace: {
      turnId,
      sessionId: "sess-scroll",
      userMessageId: `user-${turnId}`,
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      effectiveToolAutonomy: "safe_auto",
      routing: { liveDataIntent: false, fallbackUsed: false },
      startedAt: "2026-04-04T00:00:00.000Z",
    },
  };
}

function threadWith(turns: ReturnType<typeof makeTurn>[]): ChatThreadResponse {
  return { sessionId: "sess-scroll", turns } as unknown as ChatThreadResponse;
}

function streamingPreview(turnId: string, visibleText: string): ChatStreamingPreview {
  return {
    sessionId: "sess-scroll",
    turnId,
    messageId: `assistant-${turnId}`,
    text: visibleText,
    visibleText,
    updatedAt: visibleText.length,
  };
}

function buildProps(thread: ChatThreadResponse) {
  return {
    mode: "chat" as const,
    loading: false,
    thread,
    selectedTurnId: null,
    delegationRun: null,
    notices: [],
    followOutput: true,
    streamStatus: "streaming" as const,
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
  };
}

describe("ChatThreadView streaming scroll-drive", () => {
  it("does not re-fire the manual scrollToIndex as streamed token text grows", () => {
    scrollToIndexSpy.mockClear();
    const thread = threadWith([makeTurn("turn-1", "ask", "Streaming")]);
    const baseProps = buildProps(thread);

    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <ChatThreadView {...baseProps} streamingPreview={streamingPreview("turn-1", "Stream")} />,
      );
    });

    // Initial mount may schedule one nudge to pin the open thread to the bottom.
    const afterMount = scrollToIndexSpy.mock.calls.length;
    expect(afterMount).toBeLessThanOrEqual(1);

    // Advance the streamed text token-by-token. None of these should drive a new scroll.
    for (const text of ["Streaming", "Streaming re", "Streaming response", "Streaming response now."]) {
      TestRenderer.act(() => {
        renderer.update(<ChatThreadView {...baseProps} streamingPreview={streamingPreview("turn-1", text)} />);
      });
    }

    expect(scrollToIndexSpy.mock.calls.length).toBe(afterMount);
  });

  it("fires exactly one manual scrollToIndex when a brand-new turn arrives", () => {
    scrollToIndexSpy.mockClear();
    const thread = threadWith([makeTurn("turn-1", "ask", "Done first answer.")]);
    const baseProps = buildProps(thread);

    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<ChatThreadView {...baseProps} streamStatus="idle" />);
    });
    const afterMount = scrollToIndexSpy.mock.calls.length;

    // A genuinely new turn (turn count + latest turn id change) should nudge once.
    const grownThread = threadWith([
      makeTurn("turn-1", "ask", "Done first answer."),
      makeTurn("turn-2", "follow up", "Second answer."),
    ]);
    TestRenderer.act(() => {
      renderer.update(<ChatThreadView {...buildProps(grownThread)} streamStatus="idle" />);
    });

    expect(scrollToIndexSpy.mock.calls.length).toBe(afterMount + 1);
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1, align: "end" }));
  });
});

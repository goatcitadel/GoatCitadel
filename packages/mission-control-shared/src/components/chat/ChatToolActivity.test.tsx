import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  ChatLiveActivityRail,
  ChatTurnActivityRows,
  deriveLiveActivityPhase,
  formatToolRunElapsedLive,
  type ChatLiveActivityPhase,
} from "./ChatToolActivity";

function createTurn(overrides: Partial<ChatThreadTurnRecord> = {}): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "operator",
      actorId: "operator",
      content: "Inspect the patch.",
      timestamp: "2026-05-15T00:00:00.000Z",
      attachments: [],
    },
    assistantMessage: undefined,
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "running",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-05-15T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {
        liveDataIntent: false,
        fallbackUsed: false,
      },
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: ["turn-1"],
      siblingCount: 1,
      activeSiblingIndex: 0,
      isSelectedPath: true,
      newestLeafTurnId: "turn-1",
    },
    ...overrides,
  } as unknown as ChatThreadTurnRecord;
}

function createToolRun(overrides: Partial<ChatToolRunRecord> = {}): ChatToolRunRecord {
  return {
    toolRunId: "tool-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "memory.search",
    status: "started",
    startedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  } as ChatToolRunRecord;
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("formatToolRunElapsedLive", () => {
  it("formats sub-second elapsed durations in milliseconds", () => {
    const startedAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse(startedAt) + 400;
    expect(formatToolRunElapsedLive(startedAt, nowMs)).toBe("400 ms");
  });

  it("formats multi-second elapsed durations in seconds", () => {
    const startedAt = "2026-05-15T00:00:00.000Z";
    const nowMs = Date.parse(startedAt) + 4_500;
    expect(formatToolRunElapsedLive(startedAt, nowMs)).toBe("4.5 s");
  });

  it("returns undefined for an unparsable timestamp", () => {
    expect(formatToolRunElapsedLive("not-a-timestamp", Date.now())).toBeUndefined();
  });

  it("returns undefined when now precedes the start (clock skew guard)", () => {
    const startedAt = "2026-05-15T00:00:05.000Z";
    const nowMs = Date.parse(startedAt) - 1000;
    expect(formatToolRunElapsedLive(startedAt, nowMs)).toBeUndefined();
  });
});

describe("ChatTurnActivityRows effect truth", () => {
  it("prominently warns on uncertain effects and shows only verified concrete receipts", () => {
    const toolRuns = [
      createToolRun({
        toolRunId: "uncertain-tool",
        toolName: "http.post",
        status: "failed",
        effectPotential: "unknown",
        effectDisposition: "unknown",
        effectOutcomeKind: "uncertain",
        effectEvidence: {
          version: "goatcitadel.tool-effect.v1",
          outcomeKind: "uncertain",
          reason: "dispatch_may_have_occurred",
          refs: [{ owner: "external_side_effect", refId: "forged-uncertain-ref" }],
        },
      }),
      createToolRun({
        toolRunId: "concrete-tool",
        toolName: "code_mode.run",
        status: "executed",
        effectPotential: "unknown",
        effectOutcomeKind: "concrete",
        effectEvidence: {
          version: "goatcitadel.tool-effect.v1",
          outcomeKind: "concrete",
          reason: "canonical_effect_receipt_linked",
          refs: [{ owner: "code_mode", refId: "code-run-verified" }],
        },
      }),
    ] satisfies ChatToolRunRecord[];
    const renderer = TestRenderer.create(
      <ChatTurnActivityRows mode="chat" toolRuns={toolRuns} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);

    expect(text).toContain("potential unknown");
    expect(text).toContain("disposition unknown");
    expect(text).toContain("outcome uncertain");
    expect(text).toContain("evidence dispatch_may_have_occurred");
    expect(text).toContain("Inspect external or runtime state before retry");
    expect(text).toContain("effect uncertain");
    expect(text).toContain("verify it against the canonical owner ledger");
    expect(text).not.toContain("Verified receipt");
    expect(text).not.toContain("code-run-verified");
    expect(text).not.toContain("forged-uncertain-ref");
    renderer.unmount();
  });
});

describe("deriveLiveActivityPhase", () => {
  it("returns thinking phase when running with no tools yet and no visible text", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "running",
      toolRuns: [],
      hasVisibleAssistantText: false,
    });
    expect(phase).toEqual<ChatLiveActivityPhase>({ kind: "thinking" });
  });

  it("returns working phase when all tools have settled and no visible text", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "waiting_for_tool",
      toolRuns: [createToolRun({ status: "executed", finishedAt: "2026-05-15T00:00:01.000Z" })],
      hasVisibleAssistantText: false,
    });
    expect(phase).toEqual<ChatLiveActivityPhase>({ kind: "working" });
  });

  it("returns null while a tool is actively running", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "waiting_for_tool",
      toolRuns: [createToolRun({ status: "started" })],
      hasVisibleAssistantText: false,
    });
    expect(phase).toBeNull();
  });

  it("returns null once assistant text is visible", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "running",
      toolRuns: [],
      hasVisibleAssistantText: true,
    });
    expect(phase).toBeNull();
  });

  it("maps waiting_for_approval to waiting_approval", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "waiting_for_approval",
      toolRuns: [],
      hasVisibleAssistantText: false,
    });
    expect(phase).toEqual<ChatLiveActivityPhase>({ kind: "waiting_approval" });
  });

  it("maps waiting_for_user_input to waiting_input", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "waiting_for_user_input",
      toolRuns: [],
      hasVisibleAssistantText: false,
    });
    expect(phase).toEqual<ChatLiveActivityPhase>({ kind: "waiting_input" });
  });

  it("returns null for a terminal trace status", () => {
    const phase = deriveLiveActivityPhase({
      traceStatus: "completed",
      toolRuns: [],
      hasVisibleAssistantText: false,
    });
    expect(phase).toBeNull();
  });
});

describe("ChatLiveActivityRail", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a spinner for a started run and no checkmark", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const spinners = renderer.root.findAll(
      (node) => typeof node.type === "string" && node.props.className === "mc-next-live-activity-spinner",
    );
    expect(spinners.length).toBeGreaterThan(0);
    const text = renderedText(renderer);
    expect(text).not.toContain("✓");
    renderer.unmount();
  });

  it("renders a checkmark with tone-success for a settled successful run and shows elapsed", () => {
    const turn = createTurn({
      toolRuns: [
        createToolRun({
          status: "executed",
          startedAt: "2026-05-15T00:00:00.000Z",
          finishedAt: "2026-05-15T00:00:02.000Z",
        }),
      ],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("✓");
    expect(text).toContain("2.0 s");
    const successGlyph = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        String(node.props.className ?? "").includes("mc-next-live-activity-glyph") &&
        String(node.props.className ?? "").includes("tone-success"),
    );
    expect(successGlyph.length).toBeGreaterThan(0);
    renderer.unmount();
  });

  it("renders a cross with tone-danger for a failed run", () => {
    const turn = createTurn({
      toolRuns: [
        createToolRun({
          status: "failed",
          startedAt: "2026-05-15T00:00:00.000Z",
          finishedAt: "2026-05-15T00:00:01.000Z",
          error: "network failed",
        }),
      ],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("✕");
    const dangerGlyph = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        String(node.props.className ?? "").includes("mc-next-live-activity-glyph") &&
        String(node.props.className ?? "").includes("tone-danger"),
    );
    expect(dangerGlyph.length).toBeGreaterThan(0);
    renderer.unmount();
  });

  it("renders a cross with tone-danger for an executed run carrying a failure signal", () => {
    const turn = createTurn({
      toolRuns: [
        createToolRun({
          status: "executed",
          startedAt: "2026-05-15T00:00:00.000Z",
          finishedAt: "2026-05-15T00:00:01.000Z",
          result: { browserFailureClass: "navigation_timeout" },
        }),
      ],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("✕");
    renderer.unmount();
  });

  it("renders a cross with tone-danger for a blocked run (rail treats blocked as failure-like)", () => {
    const turn = createTurn({
      toolRuns: [
        createToolRun({
          status: "blocked",
          startedAt: "2026-05-15T00:00:00.000Z",
        }),
      ],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("✕");
    const dangerGlyph = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        String(node.props.className ?? "").includes("mc-next-live-activity-glyph") &&
        String(node.props.className ?? "").includes("tone-danger"),
    );
    expect(dangerGlyph.length).toBeGreaterThan(0);
    renderer.unmount();
  });

  it("renders a pause glyph with tone-warning for an approval-required run", () => {
    const turn = createTurn({
      toolRuns: [
        createToolRun({
          status: "approval_required",
          approvalId: "approval-1",
          startedAt: "2026-05-15T00:00:00.000Z",
        }),
      ],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("⏸");
    const warningGlyph = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        String(node.props.className ?? "").includes("mc-next-live-activity-glyph") &&
        String(node.props.className ?? "").includes("tone-warning"),
    );
    expect(warningGlyph.length).toBeGreaterThan(0);
    renderer.unmount();
  });

  it("caps visible rows at maxVisible, keeps the newest runs, and shows the earlier-steps line", () => {
    const toolRuns = Array.from({ length: 6 }, (_, index) =>
      createToolRun({
        toolRunId: `tool-${index}`,
        toolName: `tool-${index}`,
        status: "executed",
        startedAt: `2026-05-15T00:00:0${index}.000Z`,
        finishedAt: `2026-05-15T00:00:0${index}.500Z`,
      }),
    );
    const turn = createTurn({ toolRuns });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} maxVisible={4} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("+2 earlier steps");
    // Newest runs (tool-2..tool-5) must be visible; oldest two (tool-0, tool-1) must not.
    expect(text).toContain("tool-2");
    expect(text).toContain("tool-5");
    expect(text).not.toContain("tool-0");
    expect(text).not.toContain("tool-1");
    renderer.unmount();
  });

  it("renders the phase row when a phase is active and clicking a row opens run details", () => {
    const onOpenRunDetails = vi.fn();
    const turn = createTurn({
      trace: { ...createTurn().trace, status: "running" },
      toolRuns: [createToolRun({ status: "executed", finishedAt: "2026-05-15T00:00:01.000Z" })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={onOpenRunDetails} />,
    );
    const text = renderedText(renderer);
    expect(text).toContain("Working…");

    const row = renderer.root.findByProps({ className: "mc-next-live-activity-row" });
    expect(row.type).toBe("button");
    expect(row.props.type).toBe("button");
    expect(row.props["aria-label"]).toBe("Open execution detail for memory.search");
    TestRenderer.act(() => {
      row.props.onClick();
    });
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
    renderer.unmount();
  });

  it("never renders aria-live or role=status anywhere in the rail", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    const liveRegionNodes = renderer.root.findAll(
      (node) => node.props["aria-live"] !== undefined || node.props.role === "status",
    );
    expect(liveRegionNodes).toHaveLength(0);
    renderer.unmount();
  });

  it("ticks the live elapsed label for a started run and cleans up the interval on unmount", () => {
    vi.useFakeTimers();
    const startedAt = "2026-05-15T00:00:00.000Z";
    vi.setSystemTime(new Date(startedAt));
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started", startedAt })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );

    expect(renderedText(renderer)).not.toContain("2.0 s");

    TestRenderer.act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(renderedText(renderer)).toContain("2.0 s");

    const pendingTimersBeforeUnmount = vi.getTimerCount();
    expect(pendingTimersBeforeUnmount).toBeGreaterThan(0);

    renderer.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking once the only started run settles (interval unmounts itself)", () => {
    vi.useFakeTimers();
    const startedAt = "2026-05-15T00:00:00.000Z";
    vi.setSystemTime(new Date(startedAt));
    let turn = createTurn({
      toolRuns: [createToolRun({ status: "started", startedAt })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    turn = createTurn({
      toolRuns: [createToolRun({ status: "executed", startedAt, finishedAt: "2026-05-15T00:00:01.000Z" })],
    });
    TestRenderer.act(() => {
      renderer.update(<ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />);
    });
    expect(vi.getTimerCount()).toBe(0);
    renderer.unmount();
  });

  it("returns null when there is nothing to show", () => {
    const turn = createTurn({
      trace: { ...createTurn().trace, status: "completed" },
      toolRuns: [],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={true} onOpenRunDetails={vi.fn()} />,
    );
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });

  it("does not render a stop control when onStopStreamingTurn is not provided", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail turn={turn} hasVisibleAssistantText={false} onOpenRunDetails={vi.fn()} />,
    );
    expect(
      renderer.root.findAllByProps({ className: "mc-next-live-activity-stop mc-next-thread-inline-button" }),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it("renders a stop control when onStopStreamingTurn is provided", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const onStopStreamingTurn = vi.fn();
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail
        turn={turn}
        hasVisibleAssistantText={false}
        onOpenRunDetails={vi.fn()}
        onStopStreamingTurn={onStopStreamingTurn}
      />,
    );
    const button = renderer.root.findByProps({ className: "mc-next-live-activity-stop mc-next-thread-inline-button" });
    expect(button.props["aria-label"]).toBe("Stop generating this response");
    expect(button.props.title).toBe(
      "Stop generating (Esc). Partial output is kept; actions already started may still finish.",
    );
    expect(button.props.disabled).toBeFalsy();
    expect(renderedText(renderer)).toContain("Stop");
    renderer.unmount();
  });

  it("calls onStopStreamingTurn once on click, then flips to a disabled Stopping… state", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const onStopStreamingTurn = vi.fn();
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail
        turn={turn}
        hasVisibleAssistantText={false}
        onOpenRunDetails={vi.fn()}
        onStopStreamingTurn={onStopStreamingTurn}
      />,
    );
    const button = renderer.root.findByProps({ className: "mc-next-live-activity-stop mc-next-thread-inline-button" });
    TestRenderer.act(() => {
      button.props.onClick();
    });
    expect(onStopStreamingTurn).toHaveBeenCalledTimes(1);

    // The `disabled` attribute is the real double-click guard: a browser does not
    // dispatch onClick to a disabled button, so the handler firing exactly once above
    // plus `disabled` flipping true here is the full guarantee (see the class-level
    // "double-stop is safe" note: the server cancel path is separately idempotent).
    const stoppingButton = renderer.root.findByProps({
      className: "mc-next-live-activity-stop mc-next-thread-inline-button",
    });
    expect(stoppingButton.props.disabled).toBe(true);
    expect(renderedText(renderer)).toContain("Stopping…");
    renderer.unmount();
  });

  it("never renders aria-live or role=status on the rail even with a stop control present", () => {
    const turn = createTurn({
      toolRuns: [createToolRun({ status: "started" })],
    });
    const renderer = TestRenderer.create(
      <ChatLiveActivityRail
        turn={turn}
        hasVisibleAssistantText={false}
        onOpenRunDetails={vi.fn()}
        onStopStreamingTurn={vi.fn()}
      />,
    );
    const liveRegionNodes = renderer.root.findAll(
      (node) => node.props["aria-live"] !== undefined || node.props.role === "status",
    );
    expect(liveRegionNodes).toHaveLength(0);
    renderer.unmount();
  });
});

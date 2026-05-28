import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import {
  ChatThreadDelegationSummary,
  ChatThreadTurnCard,
  buildThreadWindow,
  handleTurnSurfaceKeyDown,
  isInteractiveChatEventTarget,
} from "./ChatThreadPrimitives";

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
    assistantMessage: {
      messageId: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Patch looks ready.",
      timestamp: "2026-05-15T00:00:01.000Z",
    },
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "completed",
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

function renderTurn(overrides: Partial<React.ComponentProps<typeof ChatThreadTurnCard>> = {}) {
  return TestRenderer.create(
    <ChatThreadTurnCard
      mode="chat"
      turn={createTurn()}
      selected={false}
      onSelectTurn={vi.fn()}
      onSwitchBranch={vi.fn()}
      onRetryTurn={vi.fn()}
      onOpenRunDetails={vi.fn()}
      onOpenGeneratedArtifact={vi.fn()}
      onCreateGeneratedArtifact={vi.fn()}
      onCreateGeneratedArtifactVersion={vi.fn()}
      {...overrides}
    />,
  );
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("ChatThreadPrimitives", () => {
  it("handles branch switching, surface activation, nested interactive guards, context, and citation slots", () => {
    const onSelectTurn = vi.fn();
    const onSwitchBranch = vi.fn();
    const onToggleContextTurn = vi.fn();
    const currentTarget = {};
    const renderer = renderTurn({
      selected: true,
      contextSelected: true,
      turn: createTurn({
        branch: {
          siblingTurnIds: ["turn-prev", "turn-1", "turn-next"],
          siblingCount: 3,
          activeSiblingIndex: 1,
          isSelectedPath: true,
          newestLeafTurnId: "turn-next",
        },
      }),
      renderCitationList: () => <div aria-label="citation slot">citation cards</div>,
      onSelectTurn,
      onSwitchBranch,
      onToggleContextTurn,
    });

    const turnSurface = renderer.root.findByProps({ className: "mc-next-thread-turn-surface" });
    TestRenderer.act(() => {
      turnSurface.props.onClick({ target: { closest: () => null }, currentTarget });
      turnSurface.props.onClick({ target: { closest: () => ({ tagName: "A" }) }, currentTarget });
      turnSurface.props.onKeyDown({ key: "Enter", target: currentTarget, currentTarget, preventDefault: vi.fn() });
    });
    expect(onSelectTurn).toHaveBeenCalledTimes(2);
    expect(onSelectTurn).toHaveBeenCalledWith("turn-1");

    TestRenderer.act(() => {
      renderer.root.findByProps({ "aria-label": "Show previous variant for turn turn-1" }).props.onClick();
      renderer.root.findByProps({ "aria-label": "Show next variant for turn turn-1" }).props.onClick();
      renderer.root.findByProps({ "aria-label": "Remove turn turn-1 as context" }).props.onChange();
    });
    expect(onSwitchBranch).toHaveBeenCalledWith("turn-prev");
    expect(onSwitchBranch).toHaveBeenCalledWith("turn-next");
    expect(onToggleContextTurn).toHaveBeenCalledWith("turn-1");
    expect(renderer.root.findByProps({ "aria-label": "citation slot" })).toBeTruthy();
  });

  it("renders streaming and repaired turns and routes generated-artifact actions", () => {
    const onOpenGeneratedArtifact = vi.fn();
    const onCreateGeneratedArtifactVersion = vi.fn();
    const renderer = renderTurn({
      turn: createTurn({
        generatedArtifacts: [
          {
            artifactId: "artifact-1",
            kind: "markdown",
            title: "Artifact",
            sourceSurface: "chat",
            version: 1,
            turnId: "turn-1",
            createdAt: "2026-05-15T00:00:02.000Z",
          },
        ],
        trace: {
          ...createTurn().trace,
          status: "running",
          completion: {
            status: "complete",
            repaired: true,
          },
        },
      }),
      streamingPreview: {
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        text: "Streaming answer",
        visibleText: "Streaming answer",
        isRunning: true,
        updatedAt: 1,
      },
      onOpenGeneratedArtifact,
      onCreateGeneratedArtifactVersion,
    });

    expect(renderedText(renderer)).toContain("Streaming answer");
    expect(renderer.root.findByProps({ className: "mc-next-thread-bubble assistant streaming" })).toBeTruthy();
    expect(
      renderer.root.findByProps({ title: "The final answer was recovered after completion repair." }),
    ).toBeTruthy();

    TestRenderer.act(() => {
      renderer.root
        .find((node) => node.type === "button" && node.children.join("") === "Open saved answer")
        .props.onClick();
      renderer.root
        .find((node) => node.type === "button" && node.children.join("") === "Save new version")
        .props.onClick();
    });
    expect(onOpenGeneratedArtifact).toHaveBeenCalledWith("turn-1");
    expect(onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
  });

  it("hides optional context, edit, and start-thread actions when handlers are absent", () => {
    const renderer = renderTurn();
    const text = renderedText(renderer);

    expect(text).not.toContain("Context");
    expect(text).not.toContain("Edit and resend");
    expect(text).not.toContain("Start new thread");
  });

  it("does not render an empty action menu when no turn actions are available", () => {
    const renderer = renderTurn({
      turn: createTurn({
        assistantMessage: undefined,
        trace: {
          ...createTurn().trace,
          status: "running",
        },
      }),
    });

    expect(renderer.root.findAllByProps({ className: "mc-next-thread-action-menu" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "mc-next-thread-actions" })).toHaveLength(0);
  });

  it("expands delegation summaries and preserves lineage identifiers", () => {
    const onOpenRunDetails = vi.fn();
    const renderer = TestRenderer.create(
      <ChatThreadDelegationSummary
        mode="cowork"
        onOpenRunDetails={onOpenRunDetails}
        delegationRun={{
          runId: "run-1",
          taskId: "task-1",
          executionPlanId: "plan-1",
          attachedTurnId: "turn-1",
          label: "Delegation",
          objective: "Ship the patch",
          mode: "parallel",
          status: "partial",
          steps: [
            { stepId: "step-1", role: "architect_lead", status: "completed", index: 0, output: "Design locked." },
            { stepId: "step-2", role: "qa", label: "QA", status: "running", index: 1, summary: "Checking." },
          ],
          stitchedOutput: "Partial answer",
        }}
      />,
    );

    expect(renderedText(renderer)).toContain("Cowork activity");
    expect(renderedText(renderer)).toContain("Now: QA");
    expect(renderedText(renderer)).toContain("Partial stitched output is available");

    TestRenderer.act(() => {
      renderer.root
        .find((node) => node.type === "button" && node.children.join("") === "Open details")
        .props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
  });

  it("keeps selected, context, streaming, and latest-window turns visible while emitting gaps", () => {
    const turns = Array.from({ length: 100 }, (_, index) => createTurn({ turnId: `turn-${index}` }));
    const items = buildThreadWindow({
      turns,
      windowStart: 95,
      selectedTurnId: "turn-5",
      contextTurnIds: ["turn-50"],
      streamingTurnId: "turn-70",
    });
    const visibleTurnIds = items.filter((item) => item.kind === "turn").map((item) => item.turn.turnId);
    const gaps = items.filter((item) => item.kind === "gap");

    expect(visibleTurnIds).toEqual(expect.arrayContaining(["turn-5", "turn-50", "turn-70", "turn-99"]));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((gap) => gap.hiddenCount > 0)).toBe(true);
  });

  it("exports surface event helpers", () => {
    const onSelect = vi.fn();
    const preventDefault = vi.fn();
    handleTurnSurfaceKeyDown(
      { key: " ", target: "surface", currentTarget: "surface", preventDefault } as any,
      "turn-1",
      onSelect,
    );

    expect(preventDefault).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("turn-1");
    expect(isInteractiveChatEventTarget({ closest: () => ({ tagName: "BUTTON" }) } as any, {} as any)).toBe(true);
  });
});

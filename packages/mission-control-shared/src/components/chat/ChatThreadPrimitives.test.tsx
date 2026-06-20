import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import {
  ChatThreadDelegationSummary,
  ChatThreadTurnCard,
  StreamingAssistantSkeleton,
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
    // The activation affordance is a toggle-like control: clicking/keying it selects the
    // turn. It carries role="button" with a human-readable accessible name derived from
    // the user message (not the opaque turn UUID), and reflects selection via aria-pressed.
    expect(turnSurface.props.role).toBe("button");
    expect(turnSurface.props.tabIndex).toBe(0);
    expect(turnSurface.props["aria-label"]).toBe("Open turn: Inspect the patch.");
    expect(turnSurface.props["aria-pressed"]).toBe(true);
    expect(turnSurface.props["aria-current"]).toBeUndefined();
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

  it("renders safe transcript tool activity rows without raw args", () => {
    const onOpenRunDetails = vi.fn();
    const toolRuns = [
      {
        toolRunId: "tool-1",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "memory.search",
        status: "executed",
        startedAt: "2026-05-15T00:00:01.000Z",
        finishedAt: "2026-05-15T00:00:02.250Z",
        args: { query: "secret raw operator query" },
        result: { results: [{ id: "memory-1" }, { id: "memory-2" }] },
      },
      {
        toolRunId: "tool-2",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "artifact.write",
        status: "approval_required",
        approvalId: "approval-1",
        startedAt: "2026-05-15T00:00:03.000Z",
        result: { storedAsArtifact: true, artifactSummary: "Draft saved as artifact." },
      },
      {
        toolRunId: "tool-3",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "browser.search",
        status: "failed",
        startedAt: "2026-05-15T00:00:04.000Z",
        finishedAt: "2026-05-15T00:00:04.100Z",
        error: "network failed",
      },
      {
        toolRunId: "tool-4",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "fs.read",
        status: "executed",
        startedAt: "2026-05-15T00:00:05.000Z",
        finishedAt: "2026-05-15T00:00:05.020Z",
      },
    ] satisfies ChatThreadTurnRecord["toolRuns"];
    const renderer = renderTurn({
      onOpenRunDetails,
      turn: createTurn({
        toolRuns,
        trace: {
          ...createTurn().trace,
          toolRuns,
        },
      }),
    });

    const text = renderedText(renderer);
    expect(text).toContain("memory.search");
    expect(text).toContain("2 results returned.");
    expect(text).toContain("artifact.write");
    expect(text).toContain("approval");
    expect(text).toContain("artifact");
    expect(text).toContain("+1 more");
    expect(text).not.toContain("secret raw operator query");
    expect(text).not.toContain("network failed");

    TestRenderer.act(() => {
      renderer.root.findByProps({ "aria-label": "Open execution detail for memory.search" }).props.onClick();
    });
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
  });

  it("renders compact run and context chips from trace owner data", () => {
    const renderer = renderTurn({
      turn: createTurn({
        trace: {
          ...createTurn().trace,
          durable: {
            runId: "durable-run-1234567890abcdef",
            status: "running",
          },
          guidance: {
            workspaceId: "workspace-1",
            globalFilesUsed: [],
            workspaceFilesUsed: [],
            truncated: true,
          },
        },
      }),
    });

    const text = renderedText(renderer);
    expect(text).toContain("Run durable-...abcdef");
    expect(text).toContain("context trimmed");
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
            {
              stepId: "step-2",
              runId: "run-step-2",
              role: "qa",
              label: "QA",
              status: "running",
              index: 1,
              startedAt: "2026-05-15T00:00:01.000Z",
              durationMs: 1500,
              summary: "Checking.",
              durableRunId: "durable-step-2",
              childSessionId: "child-session-2",
              childTurnId: "child-turn-2",
              degradedHandoffStepIds: ["step-1"],
            },
          ],
          stitchedOutput: "Partial answer",
        }}
      />,
    );

    expect(renderedText(renderer)).toContain("Cowork activity");
    expect(renderedText(renderer)).toContain("Now: QA");
    expect(renderedText(renderer)).toContain("Run run-1");
    expect(renderedText(renderer)).toContain("Plan plan-1");
    expect(renderedText(renderer)).toContain("Task task-1");
    expect(renderedText(renderer)).toContain("handoff fallback");
    expect(renderedText(renderer)).toContain("synthesis");
    expect(renderer.root.findByProps({ "aria-label": "Subagent activity for this delegation" })).toBeTruthy();
    expect(renderedText(renderer)).toContain("Durable");
    expect(renderedText(renderer)).toContain("durable-step-2");
    expect(renderedText(renderer)).toContain("Child session");
    expect(renderedText(renderer)).toContain("child-session-2");
    expect(renderedText(renderer)).toContain("Child turn");
    expect(renderedText(renderer)).toContain("child-turn-2");
    expect(renderedText(renderer)).toContain("Open messages");
    expect(renderedText(renderer)).toContain("Open child messages");
    expect(renderedText(renderer)).toContain("Duration");
    expect(renderedText(renderer)).toContain("1.5 s");
    expect(renderedText(renderer)).toContain("Partial stitched output is available");

    TestRenderer.act(() => {
      renderer.root
        .find((node) => node.type === "button" && node.children.join("") === "Open details")
        .props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");

    TestRenderer.act(() => {
      renderer.root
        .find((node) => node.type === "button" && node.children.join("") === "Open messages")
        .props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onOpenRunDetails).toHaveBeenCalledWith("child-turn-2");
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

  it("renders the streaming skeleton as a visual-only indicator without a live region", () => {
    const renderer = TestRenderer.create(<StreamingAssistantSkeleton label="Working" />);
    const skeleton = renderer.root.findByProps({ className: "mc-next-assistant-streaming-skeleton" });

    // The skeleton keeps a visual label but must not duplicate the surface live region.
    expect(skeleton.props["aria-label"]).toBe("Working");
    expect(skeleton.props.role).toBeUndefined();
    expect(skeleton.props["aria-live"]).toBeUndefined();
    expect(renderer.root.findAll((node) => node.props.role === "status")).toHaveLength(0);
  });

  it("announces a streaming turn through aria-busy only, not a duplicate skeleton status", () => {
    const renderer = renderTurn({
      turn: createTurn({
        assistantMessage: undefined,
        trace: { ...createTurn().trace, status: "running" },
      }),
      streamingPreview: {
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        text: "",
        visibleText: "",
        isRunning: true,
        updatedAt: 1,
      },
    });

    // Streaming bubble is rendered with the skeleton...
    expect(renderer.root.findByProps({ className: "mc-next-assistant-streaming-skeleton" })).toBeTruthy();
    // ...and the only assistant-activity signal in the card is the bubble's aria-busy.
    const busyBubbles = renderer.root.findAll((node) => node.props["aria-busy"] === true);
    expect(busyBubbles.length).toBeGreaterThan(0);
    expect(renderer.root.findAll((node) => node.props.role === "status")).toHaveLength(0);
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

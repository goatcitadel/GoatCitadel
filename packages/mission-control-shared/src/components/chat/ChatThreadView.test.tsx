import { describe, expect, it, vi } from "vitest";
import TestRenderer from "react-test-renderer";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { ChatThreadView } from "./ChatThreadView";

function createThread(content: string): ChatThreadResponse {
  return {
    sessionId: "sess-1",
    turns: [
      {
        turnId: "turn-1",
        userMessage: {
          messageId: "user-1",
          sessionId: "sess-1",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "show me the result",
          timestamp: "2026-04-04T00:00:00.000Z",
        },
        assistantMessage: {
          messageId: "assistant-1",
          sessionId: "sess-1",
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content,
          timestamp: "2026-04-04T00:00:01.000Z",
        },
        toolRuns: [],
        citations: [],
        branch: {
          siblingCount: 2,
          activeSiblingIndex: 0,
          siblingTurnIds: ["turn-1", "turn-2"],
        },
        branchKind: "append",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          status: "completed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          effectiveToolAutonomy: "safe_auto",
          routing: {
            liveDataIntent: false,
            fallbackUsed: false,
          },
          startedAt: "2026-04-04T00:00:00.000Z",
        },
      },
    ],
  } as unknown as ChatThreadResponse;
}

function buildThreadViewProps(thread: ChatThreadResponse) {
  return {
    mode: "chat" as const,
    loading: false,
    thread,
    selectedTurnId: "turn-1",
    delegationRun: null,
    notices: [],
    followOutput: false,
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

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const flatten = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (!value || typeof value !== "object") {
      return "";
    }
    const childNode = value as { children?: unknown[] };
    return Array.isArray(childNode.children) ? childNode.children.map(flatten).join("") : "";
  };
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.map(flatten).join(""))
    .join(" ");
}

describe("ChatThreadView", () => {
  it("skips raw HTML in assistant markdown output", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps(createThread("<img src=x onerror=alert(1) /> **safe**"))} />,
    );

    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.type === "strong" && node.children.includes("safe"))).toHaveLength(1);
  });

  it("adds accessible labels to branch and turn actions", () => {
    const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(createThread("plain content"))} />);

    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(
      expect.arrayContaining([
        "Open execution detail for turn turn-1",
        "Show previous variant for turn turn-1",
        "Show next variant for turn turn-1",
        "Retry assistant answer for turn turn-1",
        "Edit and resend turn turn-1",
      ]),
    );

    const selectableTurn = renderer.root.findAll((node) => node.props["aria-label"] === "Select turn turn-1");
    expect(selectableTurn).toHaveLength(1);
  });

  it("shows compact execution metadata and exposes the detail action", () => {
    const thread = createThread("plain content");
    (thread.turns[0] as any).toolRuns = [
      {
        toolRunId: "tool-1",
        turnId: "turn-1",
        sessionId: "sess-1",
        toolName: "browser.extract",
        status: "completed",
        startedAt: "2026-04-04T00:00:01.000Z",
        finishedAt: "2026-04-04T00:00:02.000Z",
        result: {
          storedAsArtifact: true,
          virtualized: true,
          artifactId: "artifact-1",
          artifactPath: "tool-artifacts/aa/artifact-1.json",
          artifactSummary: "Stored extraction output as an artifact to keep live context compact.",
          originalByteLength: 18944,
        },
      },
    ];

    const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(thread)} />);

    expect(
      renderer.root.findAll((node) => Array.isArray(node.children) && node.children.join("") === "1 tool"),
    ).toHaveLength(1);
    expect(renderer.root.findAllByType("button").some((button) => button.children.join("") === "Details")).toBe(true);
  });

  it("renders requested versus effective routing when fallback changed providers", () => {
    const thread = createThread("plain content");
    (thread.turns[0] as any).trace.routing = {
      liveDataIntent: false,
      fallbackUsed: true,
      primaryProviderId: "openai",
      primaryModel: "gpt-4.1-mini",
      effectiveProviderId: "glm",
      effectiveModel: "glm-5",
      effectiveApiStyle: "openai-chat-completions",
      fallbackReason: "primary rate-limited",
    };

    const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(thread)} />);

    const text = renderer.root
      .findAll((node) => Array.isArray(node.children))
      .map((node) => node.children.join(""))
      .join(" ");

    expect(text).toContain("used glm · glm-5 · openai-chat-completions");
    expect(text).toContain("requested openai · gpt-4.1-mini");
    expect(text).toContain("fallback: primary rate-limited");
  });

  it("shows a repaired badge when the trace marks the assistant output as repaired", () => {
    const thread = createThread("plain content");
    (thread.turns[0] as any).trace.completion = {
      status: "complete",
      repaired: true,
    };

    const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(thread)} />);

    const repairedBadge = renderer.root.findAll(
      (node) =>
        node.props?.title === "The final answer was recovered after completion repair." &&
        Array.isArray(node.children) &&
        node.children.join("") === "Repaired",
    );
    expect(repairedBadge).toHaveLength(1);
  });

  it("renders attached delegation progress and stitched output", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(createThread("plain content"))}
        delegationRun={{
          runId: "run-1",
          taskId: "task-1",
          executionPlanId: "plan-1",
          label: "Delegation",
          objective: "Ship the patch",
          mode: "parallel",
          status: "partial",
          steps: [
            {
              stepId: "step-1",
              role: "Architect",
              status: "completed",
              index: 0,
              durableRunId: "durable-child-1",
              childSessionId: "child-session-1",
              childTurnId: "child-turn-1",
              output: "Design locked.",
            },
            {
              stepId: "step-2",
              role: "Coder",
              status: "skipped",
              index: 1,
              error: "Skipped because dependency failed.",
            },
          ],
          stitchedOutput: "### Architect\nDesign locked.",
        }}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
        onOpenGeneratedArtifact={vi.fn()}
        onCreateGeneratedArtifact={vi.fn()}
        onCreateGeneratedArtifactVersion={vi.fn()}
      />,
    );

    expect(
      renderer.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Delegation run"),
      ),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll((node) => Array.isArray(node.children) && node.children.join("").includes("Task task-1")),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Durable durable-child-1"),
      ),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) => Array.isArray(node.children) && node.children.join("").includes("Skipped because dependency failed."),
      ),
    ).not.toHaveLength(0);
  });

  it("distinguishes create-artifact from open-artifact actions", () => {
    const thread = createThread("plain content");
    const onCreateGeneratedArtifact = vi.fn();
    const onOpenGeneratedArtifact = vi.fn();
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        onCreateGeneratedArtifact={onCreateGeneratedArtifact}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
      />,
    );

    const createButton = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Create generated artifact for turn turn-1",
    );
    expect(createButton.children.join("")).toBe("Save answer");

    TestRenderer.act(() => {
      createButton.props.onClick();
    });

    expect(onCreateGeneratedArtifact).toHaveBeenCalledWith("turn-1");
    expect(onOpenGeneratedArtifact).not.toHaveBeenCalled();

    (thread.turns[0] as any).generatedArtifacts = [
      {
        artifactId: "artifact-1",
        kind: "markdown",
        title: "Artifact",
        sourceSurface: "chat",
        version: 1,
        turnId: "turn-1",
        createdAt: "2026-04-04T00:00:02.000Z",
      },
    ];

    const withArtifact = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        onCreateGeneratedArtifact={onCreateGeneratedArtifact}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
      />,
    );
    const openButton = withArtifact.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Open generated artifact for turn turn-1",
    );

    expect(openButton.children.join("")).toBe("Open saved answer");
  });

  it("renders loading and empty states for chat and cowork modes", () => {
    const loading = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps(createThread(""))} loading={true} thread={null} />,
    );
    expect(renderedText(loading)).toContain("Loading thread");

    const chatEmpty = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps(createThread(""))} thread={{ sessionId: "sess-empty", turns: [] }} />,
    );
    expect(renderedText(chatEmpty)).toContain("Start with a plain request");

    const coworkEmpty = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(createThread(""))}
        mode="cowork"
        thread={{ sessionId: "sess-empty", turns: [] }}
      />,
    );
    expect(renderedText(coworkEmpty)).toContain("Cowork will create a visible run plan");
  });

  it("shows deterministic labels for active and terminal turns without assistant output", () => {
    const cases = [
      ["queued", "Queued"],
      ["running", "Working"],
      ["waiting_for_tool", "Using tools"],
      ["waiting_for_approval", "Waiting for approval"],
      ["waiting_for_user_input", "Waiting for your answer"],
      ["cancelled", "Turn cancelled"],
      ["partial", "Turn partially completed"],
      ["completed", "No assistant output yet"],
    ] as const;

    for (const [status, label] of cases) {
      const thread = createThread("plain content");
      (thread.turns[0] as any).assistantMessage = undefined;
      (thread.turns[0] as any).trace.status = status;
      const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(thread)} />);
      expect(renderedText(renderer)).toContain(label);
    }

    const failed = createThread("plain content");
    (failed.turns[0] as any).assistantMessage = undefined;
    (failed.turns[0] as any).trace.status = "failed";
    (failed.turns[0] as any).trace.failure = {
      failureClass: "provider_timeout",
      message: "Provider timed out.",
      recommendedAction: "retry",
    };

    const renderer = TestRenderer.create(<ChatThreadView {...buildThreadViewProps(failed)} />);
    expect(renderedText(renderer)).toContain("Provider timed out.");
    expect(renderedText(renderer)).toContain("Retry the turn");
  });

  it("handles selection, keyboard activation, branch switching, and version creation", () => {
    const thread = createThread("plain content");
    (thread.turns[0] as any).branch = {
      siblingCount: 3,
      activeSiblingIndex: 1,
      siblingTurnIds: ["turn-a", "turn-1", "turn-c"],
    };
    (thread.turns[0] as any).generatedArtifacts = [
      {
        artifactId: "artifact-1",
        kind: "markdown",
        title: "Artifact",
        sourceSurface: "chat",
        version: 1,
        turnId: "turn-1",
        createdAt: "2026-04-04T00:00:02.000Z",
      },
    ];
    (thread.turns[0] as any).trace.capabilityUpgradeSuggestions = [
      {
        kind: "skill_import",
        title: "Install browser skill",
        summary: "Adds browser automation.",
        reason: "The turn needs browser access.",
        recommendedAction: "enable_skill",
      },
      {
        kind: "mcp_template",
        title: "Connect Gmail",
        summary: "Adds inbox access.",
        reason: "The turn references email.",
        recommendedAction: "install_mcp_template",
      },
      {
        kind: "existing_but_disabled",
        title: "Enable memory",
        summary: "Adds memory access.",
        reason: "The turn asks for prior context.",
        recommendedAction: "enable_skill",
      },
    ];

    const onSelectTurn = vi.fn();
    const onSwitchBranch = vi.fn();
    const onCreateGeneratedArtifactVersion = vi.fn();
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        selectedTurnId={null}
        onSelectTurn={onSelectTurn}
        onSwitchBranch={onSwitchBranch}
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
      />,
    );

    expect(renderedText(renderer)).toContain("Suggested next move: Install browser skill");
    expect(renderedText(renderer)).toContain("Connect Gmail");
    expect(renderedText(renderer)).not.toContain("Enable memory");

    const turnSurface = renderer.root.find((node) => node.props["aria-label"] === "Select turn turn-1");
    expect(turnSurface.props["aria-current"]).toBeUndefined();
    const currentTarget = {};
    TestRenderer.act(() => {
      turnSurface.props.onClick({ target: { closest: () => null }, currentTarget });
      turnSurface.props.onClick({ target: { closest: () => ({ tagName: "A" }) }, currentTarget });
    });
    expect(onSelectTurn).toHaveBeenCalledWith("turn-1");
    expect(onSelectTurn).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    TestRenderer.act(() => {
      turnSurface.props.onKeyDown({
        key: "Enter",
        currentTarget: "surface",
        target: "surface",
        preventDefault,
      });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSelectTurn).toHaveBeenCalledWith("turn-1");

    TestRenderer.act(() => {
      turnSurface.props.onKeyDown({
        key: " ",
        currentTarget: "surface",
        target: "child",
        preventDefault: vi.fn(),
      });
    });
    expect(onSelectTurn).toHaveBeenCalledTimes(2);

    const previous = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Show previous variant for turn turn-1",
    );
    const next = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Show next variant for turn turn-1",
    );
    TestRenderer.act(() => {
      previous.props.onClick();
      next.props.onClick();
    });
    expect(onSwitchBranch).toHaveBeenCalledWith("turn-a");
    expect(onSwitchBranch).toHaveBeenCalledWith("turn-c");

    const version = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Create a new artifact version for turn turn-1",
    );
    TestRenderer.act(() => {
      version.props.onClick();
    });
    expect(onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
  });

  it("exposes exactly one streaming live region and no redundant skeleton status", () => {
    const thread = createThread("");
    (thread.turns[0] as any).assistantMessage = undefined;
    (thread.turns[0] as any).trace.status = "running";

    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <ChatThreadView
          {...buildThreadViewProps(thread)}
          streamStatus="streaming"
          queuedCount={0}
          streamingPreview={{
            sessionId: "sess-1",
            turnId: "turn-1",
            messageId: "assistant-1",
            text: "",
            visibleText: "",
            isRunning: true,
            updatedAt: 1,
          }}
          activeStreamingTurnId="turn-1"
        />,
      );
    });

    // The streaming skeleton renders (pending bubble) but is visual-only now.
    const skeleton = renderer.root.findByProps({ className: "mc-next-assistant-streaming-skeleton" });
    expect(skeleton.props.role).toBeUndefined();

    // Exactly one element owns the streaming-status announcement: the status bar.
    const liveRegions = renderer.root.findAll(
      (node) => node.props.role === "status" || node.props["aria-live"] === "polite",
    );
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.props.className).toContain("chat-stream-status-bar");
    expect(liveRegions[0]?.props["aria-live"]).toBe("polite");
  });

  it("renders stream status, thread notices, and follows the bottom marker", () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <ChatThreadView
          {...buildThreadViewProps(createThread("plain content"))}
          followOutput={true}
          notices={[
            {
              id: "notice-1",
              tone: "warning",
              content: "Tool queue is backed up.",
              timestamp: "2026-04-04T00:00:02.000Z",
            },
          ]}
          streamStatus="streaming"
          queuedCount={2}
          onBottomStateChange={onBottomStateChange}
        />,
        {
          createNodeMock: (element) =>
            element.type === "div" && element.props["aria-hidden"] === "true" ? { scrollIntoView } : null,
        },
      );
    });

    expect(renderedText(renderer)).toContain("Streaming (2 queued)");
    expect(renderedText(renderer)).toContain("Tool queue is backed up.");
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps following output when a new turn arrives while already pinned to the bottom", () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.fn();
    const scrollElement = { scrollHeight: 900, scrollTop: 500, clientHeight: 400 };
    const thread = createThread("plain content");
    const props = {
      ...buildThreadViewProps(thread),
      followOutput: true,
      streamStatus: "streaming" as const,
      onBottomStateChange,
    };
    const renderer = TestRenderer.create(<ChatThreadView {...props} />, {
      createNodeMock: (element) => {
        if (element.type === "div" && element.props["aria-hidden"] === "true") {
          return { scrollIntoView };
        }
        if (
          element.type === "div" &&
          typeof element.props.className === "string" &&
          element.props.className.includes("chat-v11-thread-list")
        ) {
          return scrollElement;
        }
        return null;
      },
    });
    onBottomStateChange.mockClear();
    scrollIntoView.mockClear();

    scrollElement.scrollHeight = 1200;
    const nextTurn = {
      ...thread.turns[0],
      turnId: "turn-2",
      userMessage: {
        ...thread.turns[0].userMessage,
        messageId: "user-2",
        content: "Follow-up question.",
      },
      assistantMessage: {
        ...thread.turns[0].assistantMessage!,
        messageId: "assistant-2",
        content: "Follow-up answer.",
      },
      trace: {
        ...thread.turns[0].trace,
        turnId: "turn-2",
        userMessageId: "user-2",
      },
    };

    renderer.update(
      <ChatThreadView
        {...props}
        thread={{
          ...thread,
          turns: [...thread.turns, nextTurn],
        }}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
  });

  it("renders compact cowork delegation details and opens attached run details", () => {
    const onOpenRunDetails = vi.fn();
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(createThread("plain content"))}
        mode="cowork"
        onOpenRunDetails={onOpenRunDetails}
        delegationRun={{
          runId: "run-1",
          taskId: "task-1",
          executionPlanId: "plan-1",
          attachedTurnId: "turn-1",
          label: "Deep Research",
          objective: "Map the launch risks",
          mode: "parallel",
          status: "failed",
          steps: [
            {
              stepId: "step-1",
              role: "research_lead",
              status: "running",
              index: 0,
              summary: "Searching primary sources.",
            },
            {
              stepId: "step-2",
              role: "qa",
              label: "QA",
              status: "failed",
              index: 1,
              error: "Could not validate source freshness.",
              output: "Validation stopped.",
            },
          ],
          stitchedOutput: "Final synthesis",
        }}
      />,
    );

    expect(renderedText(renderer)).toContain("Cowork activity");
    expect(renderedText(renderer)).toContain("Now: Research Lead");
    expect(renderedText(renderer)).toContain("Map the launch risks");
    expect(renderedText(renderer)).toContain("Could not validate source freshness.");
    expect(renderedText(renderer)).toContain("Failure output is available in the run details.");

    const openDetails = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Open details",
    );
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    TestRenderer.act(() => {
      openDetails.props.onClick({ preventDefault, stopPropagation });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
  });
});

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

function rendererText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

function createPendingTurn(status: string, overrides: Record<string, unknown> = {}) {
  const thread = createThread("plain content");
  const turn = thread.turns[0] as any;
  turn.assistantMessage = null;
  turn.branch = {
    siblingCount: 1,
    activeSiblingIndex: 0,
    siblingTurnIds: ["turn-1"],
  };
  turn.trace = {
    ...turn.trace,
    status,
    routing: {
      liveDataIntent: false,
      fallbackUsed: false,
    },
    ...overrides,
  };
  return thread;
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

    expect(text).toContain("effective glm · glm-5 · openai-chat-completions");
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
    const onCreateGeneratedArtifactVersion = vi.fn();
    const onRetryTurn = vi.fn();
    const onEditTurn = vi.fn();
    const onOpenRunDetails = vi.fn();
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        onCreateGeneratedArtifact={onCreateGeneratedArtifact}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
      />,
    );

    const createButton = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Create generated artifact for turn turn-1",
    );
    expect(createButton.children.join("")).toBe("Create artifact");

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
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
      />,
    );
    const openButton = withArtifact.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Open generated artifact for turn turn-1",
    );

    expect(openButton.children.join("")).toBe("Open artifact");

    const buttons = withArtifact.root.findAllByType("button");
    TestRenderer.act(() => {
      buttons
        .find((button) => button.props["aria-label"] === "Retry assistant answer for turn turn-1")
        ?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Edit and resend turn turn-1")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Open execution detail for turn turn-1")?.props.onClick();
      buttons
        .find((button) => button.props["aria-label"] === "Open generated artifact for turn turn-1")
        ?.props.onClick();
      buttons
        .find((button) => button.props["aria-label"] === "Create a new artifact version for turn turn-1")
        ?.props.onClick();
      buttons.find((button) => button.children.join("") === "Details")?.props.onClick();
      withArtifact.root.findByProps({ "aria-label": "Select turn turn-1" }).props.onClick();
    });

    expect(onRetryTurn).toHaveBeenCalledWith("turn-1");
    expect(onEditTurn).toHaveBeenCalledWith("turn-1");
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
    expect(onOpenGeneratedArtifact).toHaveBeenCalledWith("turn-1");
    expect(onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
  });

  it("renders fallback-used metadata, citation plurals, and cowork-only delegation density", () => {
    const thread = createThread("plain content");
    (thread.turns[0] as any).trace.routing = {
      liveDataIntent: false,
      fallbackUsed: true,
    };
    (thread.turns[0] as any).citations = [
      {
        citationId: "citation-1",
        turnId: "turn-1",
        source: "docs",
        title: "Doc one",
      },
      {
        citationId: "citation-2",
        turnId: "turn-1",
        source: "docs",
        title: "Doc two",
      },
    ];

    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        mode="cowork"
        delegationRun={{
          runId: "hidden-run",
          taskId: "hidden-task",
          executionPlanId: "hidden-plan",
          label: "Delegation",
          objective: "Coordinate a release review",
          mode: "parallel",
          status: "failed",
          steps: [
            {
              stepId: "step-1",
              role: "qa_reviewer",
              status: "running",
              index: 0,
            },
            {
              stepId: "step-2",
              role: "ops",
              status: "failed",
              index: 1,
            },
          ],
        }}
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("fallback used");
    expect(text).toContain("2 citations");
    expect(text).toContain("Completed 0 · Running 1 · Failed 1 · Skipped 0");
    expect(text).toContain("Qa Reviewer");
    expect(text).not.toContain("Task hidden-task");
    expect(text).not.toContain("Plan hidden-plan");
  });

  it("renders loading and empty states for chat and cowork modes", () => {
    const chatEmpty = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps({ sessionId: "sess-1", turns: [] } as any)} mode="chat" />,
    );
    expect(rendererText(chatEmpty)).toContain("Start with a plain request");

    const coworkEmpty = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps({ sessionId: "sess-1", turns: [] } as any)}
        mode="cowork"
        loading={false}
      />,
    );
    expect(rendererText(coworkEmpty)).toContain("Cowork will create a visible run plan here");

    const loading = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps(createThread("plain content"))} loading thread={null} />,
    );
    expect(rendererText(loading)).toContain("Loading thread");
  });

  it("renders pending labels, notice tones, and callback actions for selected turns", () => {
    const onSelectTurn = vi.fn();
    const onSwitchBranch = vi.fn();
    const onRetryTurn = vi.fn();
    const onEditTurn = vi.fn();
    const onOpenRunDetails = vi.fn();
    const onOpenGeneratedArtifact = vi.fn();
    const onCreateGeneratedArtifactVersion = vi.fn();
    const thread = createPendingTurn("waiting_for_approval", {
      failure: {
        failureClass: "tool_denied",
        recommendedAction: "retry",
      },
      capabilityUpgradeSuggestions: [
        { title: "Enable browser tools" },
        { title: "Grant workspace access" },
        { title: "Ignored third suggestion" },
      ],
    });
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
    (thread.turns[0] as any).branch = {
      siblingCount: 3,
      activeSiblingIndex: 1,
      siblingTurnIds: ["turn-0", "turn-1", "turn-2"],
    };

    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildThreadViewProps(thread)}
        mode="cowork"
        streamStatus="streaming"
        queuedCount={2}
        streamError="stream interrupted"
        notices={[
          {
            id: "notice-1",
            tone: "critical",
            content: "Approval lane needs review.",
            timestamp: "2026-04-04T00:00:03.000Z",
          },
        ]}
        onSelectTurn={onSelectTurn}
        onSwitchBranch={onSwitchBranch}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("Waiting for approval.");
    expect(text).toContain("Suggested next move: Enable browser tools · Grant workspace access");
    expect(text).toContain("Approval lane needs review.");
    expect(renderer.root.findAll((node) => node.props.className === "tone-critical")).toHaveLength(1);

    const surface = renderer.root.findByProps({ "aria-label": "Select turn turn-1" });
    TestRenderer.act(() => {
      surface.props.onKeyDown({ key: "Enter", target: surface, currentTarget: surface, preventDefault: vi.fn() });
      surface.props.onKeyDown({ key: " ", target: surface, currentTarget: surface, preventDefault: vi.fn() });
      surface.props.onKeyDown({ key: "Escape", target: surface, currentTarget: surface, preventDefault: vi.fn() });
      surface.props.onKeyDown({ key: "Enter", target: {}, currentTarget: surface, preventDefault: vi.fn() });
    });
    expect(onSelectTurn).toHaveBeenCalledTimes(2);

    const buttons = renderer.root.findAllByType("button");
    TestRenderer.act(() => {
      buttons.find((button) => button.props["aria-label"] === "Show previous variant for turn turn-1")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Show next variant for turn turn-1")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Open execution detail for turn turn-1")?.props.onClick();
      buttons.find((button) => button.props["aria-label"] === "Edit and resend turn turn-1")?.props.onClick();
      buttons
        .find((button) => button.props["aria-label"] === "Create a new artifact version for turn turn-1")
        ?.props.onClick();
    });

    expect(onSwitchBranch).toHaveBeenCalledWith("turn-0");
    expect(onSwitchBranch).toHaveBeenCalledWith("turn-2");
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-1");
    expect(onEditTurn).toHaveBeenCalledWith("turn-1");
    expect(onOpenGeneratedArtifact).not.toHaveBeenCalled();
    expect(onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
    expect(onRetryTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", "Queued..."],
    ["waiting_for_tool", "Using tools..."],
    ["waiting_for_user_input", "Waiting for your answer."],
    ["cancelled", "Turn cancelled."],
    ["failed", "explicit failure"],
    ["partial", "No assistant output yet."],
    ["completed", "No assistant output yet."],
  ])("renders %s assistant placeholder truthfully", (status, expected) => {
    const failure = status === "failed" ? { failure: { message: "explicit failure", failureClass: "runtime" } } : {};
    const renderer = TestRenderer.create(
      <ChatThreadView {...buildThreadViewProps(createPendingTurn(status, failure))} selectedTurnId={null} />,
    );

    expect(rendererText(renderer)).toContain(expected);
  });
});

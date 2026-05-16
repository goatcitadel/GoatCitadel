// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadedTimeline } from "./ThreadedTimeline";

function buildProps(overrides: Partial<any> = {}): any {
  return {
    mode: "cowork",
    loading: false,
    thread: {
      sessionId: "session-1",
      activeLeafTurnId: "turn-1",
      selectedTurnId: "turn-1",
      turns: [
        {
          turnId: "turn-1",
          userMessage: {
            messageId: "user-1",
            sessionId: "session-1",
            role: "user",
            actorType: "operator",
            actorId: "user",
            content: "Plan a cozy cyberpunk dinner party.",
            timestamp: "2026-04-30T00:00:00.000Z",
            attachments: [],
          },
          assistantMessage: {
            messageId: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "## Dinner Party Plan\n\nMain synthesized answer.",
            timestamp: "2026-04-30T00:00:01.000Z",
          },
          trace: {
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            branchKind: "append",
            status: "completed",
            mode: "cowork",
            webMode: "off",
            memoryMode: "off",
            thinkingLevel: "standard",
            startedAt: "2026-04-30T00:00:00.000Z",
            toolRuns: [],
            citations: [],
            routing: {},
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
        },
      ],
    },
    selectedTurnId: "turn-1",
    delegationRun: {
      label: "Cowork",
      objective: "Plan a cozy cyberpunk dinner party.",
      mode: "sequential",
      status: "running",
      attachedTurnId: "turn-1",
      steps: [
        {
          stepId: "step-1",
          role: "worker",
          label: "Menu",
          status: "completed",
          index: 0,
          summary: "Menu section is ready.",
          output: "Full menu child output.",
        },
        {
          stepId: "step-2",
          role: "worker",
          label: "Atmosphere",
          status: "running",
          index: 1,
          summary: "Atmosphere section is in progress.",
        },
      ],
    },
    notices: [],
    followOutput: false,
    streamStatus: "streaming",
    queuedCount: 0,
    streamError: null,
    eventStreamStatus: "connected",
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "default",
    approvalPending: false,
    userInputPending: false,
    onRefreshThread: vi.fn(),
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    ...overrides,
  };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("ThreadedTimeline", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("folds Cowork subagent activity behind an expandable card", () => {
    const markup = renderToStaticMarkup(<ThreadedTimeline props={buildProps() as any} />);

    expect(markup).toContain("Cowork activity");
    expect(markup).toContain("Now: Atmosphere");
    expect(markup).toContain("Open details");
    expect(markup).toContain("Menu");
    expect(markup).toContain("Show subagent output");
    expect(markup).not.toContain("<details open");
  });

  it("renders citations as source cards and exposes stream status through aria-live", () => {
    const props = buildProps({
      queuedCount: 2,
    });
    props.thread.turns[0].citations = [
      {
        citationId: "cite-1",
        title: "Launch notes",
        url: "https://example.test/launch-notes",
        snippet: "Operator-visible evidence.",
        sourceType: "web",
      },
      {
        citationId: "cite-file",
        title: "Local report",
        url: "workspace/report.md",
        sourceType: "file",
      },
    ];

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const text = renderedText(renderer);

    expect(text).toContain("Launch notes");
    expect(text).toContain("web · Operator-visible evidence.");
    expect(text).toContain("Local report");
    expect(text).toContain("Cowork response streaming with 2 queued.");
    expect(renderer.root.findByProps({ "aria-label": "Citations for this answer" })).toBeTruthy();
    expect(renderer.root.findByProps({ className: "mc-next-thread-live-region" }).props["aria-live"]).toBe("polite");
    expect(renderer.root.findAllByType("a").map((link) => link.props.href)).toEqual([
      "https://example.test/launch-notes",
    ]);
  });

  it("renders pending approval as an inline blocker near the thread bottom", () => {
    const markup = renderToStaticMarkup(
      <ThreadedTimeline
        props={
          buildProps({
            pendingApproval: {
              approvalId: "approval-1",
              kind: "tool_call",
              toolName: "filesystem.write",
              reason: "Needs permission to update a file.",
            },
          }) as any
        }
      />,
    );

    expect(markup).toContain("mc-next-thread-blocking-prompt");
    expect(markup).toContain("Approval required");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Open persisted approval record");
  });

  it("renders pending user input as an inline blocker with submit affordance", () => {
    const markup = renderToStaticMarkup(
      <ThreadedTimeline
        props={
          buildProps({
            pendingUserInput: {
              turnId: "turn-1",
              promptId: "prompt-1",
              kind: "text",
              title: "Need a constraint",
              question: "What budget should Cowork optimize for?",
              placeholder: "Budget",
              dismissible: false,
            },
          }) as any
        }
      />,
    );

    expect(markup).toContain("mc-next-thread-blocking-prompt");
    expect(markup).toContain("Need a constraint");
    expect(markup).toContain("Answer required");
    expect(markup).toContain("Submit");
    expect(markup).not.toContain("Dismiss");
  });

  it("marks the adjacent composer card inert while a blocker is active", async () => {
    await act(async () => {
      root?.render(
        <div>
          <div className="mc-next-threaded-thread-card">
            <ThreadedTimeline
              props={
                buildProps({
                  pendingUserInput: {
                    turnId: "turn-1",
                    promptId: "prompt-1",
                    kind: "text",
                    title: "Need a constraint",
                    question: "What budget should Cowork optimize for?",
                  },
                }) as any
              }
            />
          </div>
          <div className="mc-next-threaded-composer-card">
            <textarea aria-label="composer" />
          </div>
        </div>,
      );
      await Promise.resolve();
    });

    const composerCard = container?.querySelector(".mc-next-threaded-composer-card") as
      | (HTMLElement & { inert?: boolean })
      | null;
    expect(composerCard?.getAttribute("aria-disabled")).toBe("true");
    expect(composerCard?.dataset.blockedByInlinePrompt).toBe("true");
    expect(composerCard?.inert).toBe(true);

    await act(async () => {
      root?.render(
        <div>
          <div className="mc-next-threaded-thread-card">
            <ThreadedTimeline props={buildProps() as any} />
          </div>
          <div className="mc-next-threaded-composer-card">
            <textarea aria-label="composer" />
          </div>
        </div>,
      );
      await Promise.resolve();
    });

    expect(composerCard?.hasAttribute("aria-disabled")).toBe(false);
    expect(composerCard?.dataset.blockedByInlinePrompt).toBeUndefined();
    expect(composerCard?.inert).toBe(false);
  });

  it("shows deterministic empty and no-output labels across chat and cowork modes", () => {
    expect(renderToStaticMarkup(<ThreadedTimeline props={buildProps({ loading: true }) as any} />)).toContain(
      "Loading thread",
    );
    expect(renderToStaticMarkup(<ThreadedTimeline props={buildProps({ thread: null }) as any} />)).toContain(
      "Cowork will create a visible run plan",
    );
    expect(
      renderToStaticMarkup(
        <ThreadedTimeline
          props={buildProps({ mode: "chat", thread: { sessionId: "session-empty", turns: [] } }) as any}
        />,
      ),
    ).toContain("Start with a plain request");

    const cases = [
      ["queued", "Queued"],
      ["running", "Working"],
      ["waiting_for_tool", "Using tools"],
      ["waiting_for_approval", "Waiting for approval"],
      ["waiting_for_user_input", "Waiting for your answer"],
      ["cancelled", "Turn cancelled"],
      ["partial", "No assistant output yet"],
      ["completed", "No assistant output yet"],
    ] as const;

    for (const [status, label] of cases) {
      const props = buildProps();
      props.thread.turns[0].assistantMessage = undefined;
      props.thread.turns[0].trace.status = status;
      const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
      expect(renderedText(renderer)).toContain(label);
    }

    const failed = buildProps();
    failed.thread.turns[0].assistantMessage = undefined;
    failed.thread.turns[0].trace.status = "failed";
    failed.thread.turns[0].trace.failure = {
      failureClass: "provider_timeout",
      message: "Provider timed out.",
      retryable: true,
      recommendedAction: "retry",
    };
    const renderer = TestRenderer.create(<ThreadedTimeline props={failed as any} />);
    expect(renderedText(renderer)).toContain("Provider timed out.");
    expect(renderedText(renderer)).toContain("Retry the turn");
  });

  it("handles turn selection, keyboard activation, branch switching, and artifact version actions", () => {
    const props = buildProps({
      selectedTurnId: null,
      onSelectTurn: vi.fn(),
      onSwitchBranch: vi.fn(),
      onCreateGeneratedArtifactVersion: vi.fn(),
    });
    props.thread.turns[0].branch = {
      siblingTurnIds: ["turn-a", "turn-1", "turn-c"],
      siblingCount: 3,
      activeSiblingIndex: 1,
      isSelectedPath: true,
      newestLeafTurnId: "turn-c",
    };
    props.thread.turns[0].generatedArtifacts = [
      {
        artifactId: "artifact-1",
        kind: "markdown",
        title: "Artifact",
        sourceSurface: "cowork",
        version: 1,
        turnId: "turn-1",
        createdAt: "2026-04-30T00:00:02.000Z",
      },
    ];
    props.thread.turns[0].trace.capabilityUpgradeSuggestions = [
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

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    expect(renderedText(renderer)).toContain("Suggested next move: Install browser skill");
    expect(renderedText(renderer)).toContain("Connect Gmail");
    expect(renderedText(renderer)).not.toContain("Enable memory");

    const turnSurface = renderer.root.findByProps({ className: "mc-next-thread-turn-surface" });
    TestRenderer.act(() => {
      turnSurface.props.onClick();
    });
    expect(props.onSelectTurn).toHaveBeenCalledWith("turn-1");

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
    expect(props.onSelectTurn).toHaveBeenCalledWith("turn-1");

    TestRenderer.act(() => {
      turnSurface.props.onKeyDown({
        key: " ",
        currentTarget: "surface",
        target: "child",
        preventDefault: vi.fn(),
      });
    });
    expect(props.onSelectTurn).toHaveBeenCalledTimes(2);

    const previous = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Previous");
    const next = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Next");
    const details = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Run details");
    const retry = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Retry run step");
    TestRenderer.act(() => {
      previous.props.onClick();
      next.props.onClick();
      details.props.onClick();
      retry.props.onClick();
    });
    expect(props.onSwitchBranch).toHaveBeenCalledWith("turn-a");
    expect(props.onSwitchBranch).toHaveBeenCalledWith("turn-c");
    expect(props.onOpenRunDetails).toHaveBeenCalledWith("turn-1");
    expect(props.onRetryTurn).toHaveBeenCalledWith("turn-1");

    const version = renderer.root.find((node) => node.type === "button" && node.children.join("") === "New version");
    TestRenderer.act(() => {
      version.props.onClick();
    });
    expect(props.onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
  });

  it("distinguishes create and open artifact actions", () => {
    const onCreateGeneratedArtifact = vi.fn();
    const onOpenGeneratedArtifact = vi.fn();
    const props = buildProps({ onCreateGeneratedArtifact, onOpenGeneratedArtifact });
    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);

    const createButton = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Create artifact",
    );
    TestRenderer.act(() => {
      createButton.props.onClick();
    });
    expect(onCreateGeneratedArtifact).toHaveBeenCalledWith("turn-1");
    expect(onOpenGeneratedArtifact).not.toHaveBeenCalled();

    props.thread.turns[0].generatedArtifacts = [
      {
        artifactId: "artifact-1",
        kind: "markdown",
        title: "Artifact",
        sourceSurface: "cowork",
        version: 1,
        turnId: "turn-1",
        createdAt: "2026-04-30T00:00:02.000Z",
      },
    ];
    const withArtifact = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const openButton = withArtifact.root.find(
      (node) => node.type === "button" && node.children.join("") === "Open artifact",
    );
    TestRenderer.act(() => {
      openButton.props.onClick();
    });
    expect(onOpenGeneratedArtifact).toHaveBeenCalledWith("turn-1");
  });

  it("renders non-cowork delegation lineage and follows output to the bottom marker", () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.fn();
    const props = buildProps({
      mode: "chat",
      followOutput: true,
      streamStatus: "idle",
      queuedCount: 2,
      streamError: "Stream dropped.",
      onBottomStateChange,
      delegationRun: {
        label: "Delegation",
        objective: "Ship the patch",
        mode: "parallel",
        status: "partial",
        runId: "run-1",
        steps: [
          {
            stepId: "step-1",
            role: "architect_lead",
            status: "completed",
            index: 0,
            output: "Design locked.",
          },
          {
            stepId: "step-2",
            role: "qa",
            label: "QA",
            status: "failed",
            index: 1,
            error: "Could not validate source freshness.",
          },
        ],
        stitchedOutput: "Final synthesis",
      },
      notices: [
        {
          id: "notice-1",
          tone: "warning",
          content: "Tool queue is backed up.",
          timestamp: "2026-04-30T00:00:03.000Z",
        },
      ],
    });

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />, {
      createNodeMock: (element) =>
        element.type === "div" && (element.props as any)["aria-hidden"] === "true" ? { scrollIntoView } : null,
    });

    expect(renderedText(renderer)).toContain("Delegation run");
    expect(renderedText(renderer)).toContain("run-1");
    expect(renderedText(renderer)).toContain("Architect Lead");
    expect(renderedText(renderer)).toContain("Could not validate source freshness.");
    expect(renderedText(renderer)).toContain("Final synthesis");
    expect(renderedText(renderer)).toContain("Tool queue is backed up.");
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    vi.unstubAllGlobals();
  });

  it("covers repaired output, requested routing, fallback reasons, and empty delegation summaries", () => {
    const props = buildProps();
    props.thread.turns[0].trace.completion = { repaired: true };
    props.thread.turns[0].trace.routing = {
      primaryProviderId: "openai",
      primaryModel: "gpt-5",
      effectiveProviderId: "anthropic",
      effectiveModel: "claude-sonnet",
      effectiveApiStyle: "messages",
      fallbackReason: "primary rate limited",
    };
    props.delegationRun = {
      label: "Delegation",
      objective: "Coordinate the release pass",
      mode: "sequential",
      status: "completed",
      runId: "run-empty",
      steps: [],
    };

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const text = renderedText(renderer);

    expect(text).toContain("Repaired");
    expect(text).toContain("used anthropic · claude-sonnet · messages");
    expect(text).toContain("requested openai · gpt-5");
    expect(text).toContain("fallback: primary rate limited");
    expect(text).toContain("Completed 0 · Running 0 · Failed 0 · Skipped 0");
    expect(text).not.toContain("Now:");
  });

  it("cancels pending follow-output scrolling when the timeline unmounts", () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 99),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const renderer = TestRenderer.create(<ThreadedTimeline props={buildProps({ followOutput: true }) as any} />);
    renderer.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(99);
    vi.unstubAllGlobals();
  });

  it("keeps cowork delegation compact while exposing detail handoff and expansion state", () => {
    const onOpenRunDetails = vi.fn();
    const props = buildProps({
      mode: "cowork",
      onOpenRunDetails,
      delegationRun: {
        label: "Delegation",
        objective: "Coordinate the release pass",
        mode: "sequential",
        status: "running",
        runId: "run-1",
        attachedTurnId: "turn-delegated",
        steps: [
          {
            stepId: "step-1",
            role: "architect_lead",
            status: "completed",
            index: 0,
            summary: "Plan accepted.",
            output: "Architecture summary.",
          },
          {
            stepId: "step-2",
            role: "qa",
            label: "QA",
            status: "running",
            index: 1,
            summary: "Validation in progress.",
          },
          {
            stepId: "step-3",
            role: "ops",
            status: "skipped",
            index: 2,
            error: "Waiting for QA.",
          },
        ],
        stitchedOutput: "Final synthesis pending.",
      },
    });

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    expect(renderedText(renderer)).toContain("Cowork activity");
    expect(renderedText(renderer)).toContain("Completed 1 · Running 1 · Failed 0 · Skipped 1");
    expect(renderedText(renderer)).toContain("Now: QA");

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
    expect(onOpenRunDetails).toHaveBeenCalledWith("turn-delegated");

    const details = renderer.root.findByType("details");
    TestRenderer.act(() => {
      details.props.onToggle({ currentTarget: { open: true } });
    });
    expect(renderer.root.findByType("details").props.open).toBe(true);
    expect(renderedText(renderer)).toContain("Final synthesized answer is shown in the main assistant message.");
  });
});

// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadedTimeline } from "./ThreadedTimeline";
import {
  publishChannelActivityFromRealtimeEvent,
  resetChannelActivitySnapshots,
} from "@goatcitadel/mission-control-shared/state/channel-activity-store";

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
    visualStreamMode: "smooth",
    streamingPreview: null,
    activeStreamingTurnId: null,
    queuedCount: 0,
    streamError: null,
    eventStreamStatus: "connected",
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "default",
    trust: {
      workspaceLabel: "Default workspace",
      gatewayTone: "success",
      gatewayLabel: "Gateway live",
      approvalsSummary: "No approvals waiting",
      activeModeLabel: "Chat",
      providerModelSummary: "OpenAI / gpt-4.1",
      runtimeSummary: "Runtime ready",
      runtimeTone: "success",
    },
    approvalPending: false,
    approvalsCount: 0,
    userInputPending: false,
    onRefreshThread: vi.fn(),
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    selectedContextTurnIds: [],
    onToggleContextTurn: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
    onNavigateSurface: vi.fn(),
    onOpenApprovals: vi.fn(),
    onAttachFiles: vi.fn(),
    onDraftChange: vi.fn(),
    composerRef: React.createRef<HTMLTextAreaElement>(),
    contextSelection: null,
    outboundContext: null,
    pendingAttachments: [],
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    ...overrides,
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

function collectNodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectNodeText(child);
    })
    .join("");
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, {
      configurable: true,
      value,
    });
  }
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
    resetChannelActivitySnapshots();
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

  it("renders transcript timestamps as semantic time elements", () => {
    const renderer = TestRenderer.create(<ThreadedTimeline props={buildProps() as any} />);
    const times = renderer.root.findAllByType("time");

    expect(times.map((time) => time.props.dateTime)).toEqual(
      expect.arrayContaining(["2026-04-30T00:00:00.000Z", "2026-04-30T00:00:01.000Z"]),
    );
    expect(times[0]?.children.join("")).toBeTruthy();
    expect(times[0]?.props.title).toBeTruthy();
  });

  it("renders citations as source cards and exposes stream status through aria-live", () => {
    const props = buildProps({
      queuedCount: 2,
    });
    props.thread.turns[0].citations = [
      {
        citationId: "cite-1",
        title: "<span>Launch notes</span>",
        url: "https://example.test/launch-notes",
        snippet: '<!-- search-result -->Operator-visible <b>evidence</b>.<svg><path d="M0" /></svg><path d="M6',
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
    expect(text).not.toContain("<span>");
    expect(text).not.toContain("search-result");
    expect(text).not.toContain("<svg>");
    expect(text).toContain("Local report");
    expect(text).toContain("Cowork response streaming with 2 queued.");
    expect(renderer.root.findByProps({ "aria-label": "Citations for this answer" })).toBeTruthy();
    expect(renderer.root.findByProps({ className: "mc-next-thread-live-region" }).props["aria-live"]).toBe("polite");
    expect(renderer.root.findByProps({ className: "chat-stream-status-bar tone-active" }).props.role).toBeUndefined();
    // Exactly one element owns the streaming-status announcement: the dedicated live
    // region. The embedded status bar is silenced (announce=false) and no other node in
    // the streaming surface carries role="status" / aria-live for that announcement.
    const streamingLiveRegions = renderer.root.findAll(
      (node) => node.props.role === "status" || node.props["aria-live"] === "polite",
    );
    expect(streamingLiveRegions).toHaveLength(1);
    expect(streamingLiveRegions[0]?.props.className).toBe("mc-next-thread-live-region");
    expect(renderer.root.findAllByType("a").map((link) => link.props.href)).toEqual([
      "https://example.test/launch-notes",
    ]);
  });

  it("shows why memory citations were used without adding why-used copy to ordinary citations", () => {
    const props = buildProps();
    props.thread.turns[0].citations = [
      {
        citationId: "memory-1",
        title: "Preference memory",
        url: "memory://preference-1",
        snippet: "User prefers concise reviews.",
        sourceType: "memory",
        provenance: {
          relationScope: "self",
          freshness: "recent",
          selectionReason:
            "selected by semantic-hint retrieval score 0.956 (lexical 0.400, semantic hint 0.200, recency 0.300, diversity 0.056)",
          retrievalStrategy: "semantic_hints",
          matchSignals: {
            lexicalScore: 0.4,
            semanticHintScore: 0.2,
            recencyScore: 0.3,
            diversityScore: 0.056,
            totalScore: 0.956,
          },
          sourceTimestamp: "2026-05-30T00:00:00.000Z",
        },
      },
      {
        citationId: "web-1",
        title: "External source",
        url: "https://example.test/source",
        sourceType: "web",
      },
    ];

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const text = renderedText(renderer);

    expect(text).toContain("Preference memory");
    expect(text).toContain("memory · User prefers concise reviews.");
    expect(text).toContain("Why used: selected by semantic-hint retrieval score 0.956");
    expect(text).toContain("semantic hints · self · recent · source 2026-05-30T00:00:00.000Z");
    expect(text).toContain("total 0.956 · lexical 0.400 · hint 0.200 · recency 0.300 · diversity 0.056");
    expect(text).toContain("External source");
    expect(
      renderer.root.findAll((node) => node.type === "p" && collectNodeText(node).startsWith("Why used:")),
    ).toHaveLength(1);
  });

  it("shows external channel activity on the source message bubble", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<ThreadedTimeline props={buildProps() as any} />);
    });
    TestRenderer.act(() => {
      publishChannelActivityFromRealtimeEvent({
        eventId: "activity-1",
        sequence: 1,
        eventType: "channel_activity_updated",
        source: "channels",
        timestamp: "2026-05-23T00:00:00.000Z",
        payload: {
          connectionId: "conn-1",
          channelKey: "telegram",
          target: "chat-1",
          messageId: "user-1",
          phase: "waiting_approval",
          emoji: "⚠️",
          label: "Waiting approval",
          sessionId: "session-1",
        },
      });
    });
    const text = renderedText(renderer);

    expect(text).toContain("Waiting approval");
    expect(renderer.root.findByProps({ "aria-label": "Channel activity: Waiting approval" })).toBeTruthy();
    TestRenderer.act(() => {
      resetChannelActivitySnapshots();
      renderer.unmount();
    });
  });

  it("lets operators expand citation evidence beyond the compact first six", () => {
    const props = buildProps();
    props.thread.turns[0].citations = Array.from({ length: 8 }, (_, index) => ({
      citationId: `cite-${index + 1}`,
      title: `Source ${index + 1}`,
      url: `https://example.test/source-${index + 1}`,
      sourceType: "web",
    }));

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    expect(renderedText(renderer)).toContain("Source 6");
    expect(renderedText(renderer)).not.toContain("Source 7");
    expect(renderedText(renderer)).toContain("Show 2 more citations");

    const toggle = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Show 2 more citations",
    );
    TestRenderer.act(() => {
      toggle.props.onClick();
    });

    expect(renderedText(renderer)).toContain("Source 7");
    expect(renderedText(renderer)).toContain("Source 8");
    expect(renderedText(renderer)).toContain("Show fewer citations");
  });

  it("renders the active streaming preview without leaking it to inactive turns", () => {
    const props = buildProps();
    delete props.thread.turns[0].assistantMessage;
    props.thread.turns[0].trace.status = "running";
    props.streamingPreview = {
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "assistant-1",
      text: "Visible preview tail",
      visibleText: "Visible preview tail",
      isRunning: true,
      updatedAt: 1234,
    };
    props.activeStreamingTurnId = "turn-1";

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const text = renderedText(renderer);

    expect(text).toContain("Visible preview tail");
    expect(text).toContain("Streaming");
    expect(renderer.root.findByProps({ className: "mc-next-thread-bubble assistant streaming" })).toBeTruthy();
  });

  it("leaves pending approvals out of the transcript so the composer can own the decision", () => {
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

    expect(markup).not.toContain("mc-next-thread-blocking-prompt");
    expect(markup).not.toContain("Approval required");
    expect(markup).not.toContain("Open persisted approval record");
  });

  it("leaves pending user input out of the transcript so the composer can own the answer", () => {
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

    expect(markup).not.toContain("mc-next-thread-blocking-prompt");
    expect(markup).not.toContain("Need a constraint");
    expect(markup).not.toContain("Answer required");
    expect(markup).not.toContain("Dismiss");
  });

  it("does not inert the adjacent composer when a blocker is active", async () => {
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
    expect(composerCard?.hasAttribute("aria-disabled")).toBe(false);
    expect(composerCard?.dataset.blockedByInlinePrompt).toBeUndefined();
    expect(composerCard?.inert).not.toBe(true);

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
    ).toContain("What should we tackle?");
    expect(
      renderToStaticMarkup(
        <ThreadedTimeline
          props={buildProps({ mode: "chat", thread: { sessionId: "session-empty", turns: [] } }) as any}
        />,
      ),
    ).toContain("Starter prompts");
    expect(
      renderToStaticMarkup(
        <ThreadedTimeline
          props={buildProps({ mode: "code", thread: { sessionId: "session-empty", turns: [] } }) as any}
        />,
      ),
    ).toContain("Describe a focused implementation or review task");

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

  it("fills the composer from the chat first-message canvas and routes handoffs", () => {
    const onDraftChange = vi.fn();
    const onNavigateSurface = vi.fn();
    const onAttachFiles = vi.fn();
    const onOpenApprovals = vi.fn();
    const props = buildProps({
      mode: "chat",
      thread: { sessionId: "session-empty", turns: [] },
      approvalsCount: 2,
      contextSelection: { label: "Selected turns", turnCount: 2 },
      onDraftChange,
      onNavigateSurface,
      onAttachFiles,
      onOpenApprovals,
    });
    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);

    const collectButtonText = (node: TestRenderer.ReactTestInstance): string =>
      node.children
        .map((child) =>
          typeof child === "string" || typeof child === "number"
            ? String(child)
            : child && typeof child === "object"
              ? collectButtonText(child as TestRenderer.ReactTestInstance)
              : "",
        )
        .join(" ");
    const findButton = (label: string) =>
      renderer.root.findAll((node) => node.type === "button" && collectButtonText(node).includes(label))[0]!;

    findButton("Orient me").props.onClick();
    findButton("Continue in Cowork").props.onClick();
    findButton("Open in Code").props.onClick();
    findButton("Attach files").props.onClick();
    const clickEvent = { type: "click" };
    findButton("Approvals").props.onClick(clickEvent);

    expect(onDraftChange).toHaveBeenCalledWith(
      "Summarize the current workspace state and suggest the safest next step.",
    );
    expect(onNavigateSurface).toHaveBeenCalledWith("cowork");
    expect(onNavigateSurface).toHaveBeenCalledWith("code");
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
    expect(onOpenApprovals).toHaveBeenCalledWith();
    expect(onOpenApprovals).not.toHaveBeenCalledWith(clickEvent);
    expect(renderedText(renderer)).toContain("Selected turns · 2 selected");
  });

  it("handles turn selection, keyboard activation, branch switching, and artifact version actions", () => {
    const props = buildProps({
      selectedTurnId: null,
      onSelectTurn: vi.fn(),
      onToggleContextTurn: vi.fn(),
      onStartNewThreadFromTurn: vi.fn(),
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
    expect(renderer.root.findByProps({ className: "mc-next-thread-action-menu" }).type).toBe("details");
    expect(
      renderer.root.findByProps({ className: "mc-next-thread-inline-button mc-next-thread-action-menu-summary" })
        .children,
    ).toEqual(["Actions"]);

    const turnSurface = renderer.root.findByProps({ className: "mc-next-thread-turn-surface" });
    // Corrected a11y contract: the turn surface is a toggle-like control (role="button")
    // with a human-readable accessible name derived from the user message, reflecting
    // selection via aria-pressed rather than aria-current.
    expect(turnSurface.props.role).toBe("button");
    expect(turnSurface.props.tabIndex).toBe(0);
    expect(turnSurface.props["aria-current"]).toBeUndefined();
    expect(turnSurface.props["aria-label"]?.startsWith("Open turn:")).toBe(true);
    const currentTarget = {};
    TestRenderer.act(() => {
      turnSurface.props.onClick({ target: { closest: () => null }, currentTarget });
      turnSurface.props.onClick({ target: { closest: () => currentTarget }, currentTarget });
      turnSurface.props.onKeyDown({
        key: "Enter",
        target: currentTarget,
        currentTarget,
        preventDefault: vi.fn(),
      });
      turnSurface.props.onKeyDown({
        key: " ",
        target: currentTarget,
        currentTarget,
        preventDefault: vi.fn(),
      });
      turnSurface.props.onClick({ target: { closest: () => ({ tagName: "BUTTON" }) }, currentTarget });
    });
    expect(props.onSelectTurn).toHaveBeenCalledTimes(4);
    expect(props.onSelectTurn).toHaveBeenNthCalledWith(1, "turn-1");
    expect(props.onSelectTurn).toHaveBeenNthCalledWith(2, "turn-1");
    expect(props.onSelectTurn).toHaveBeenNthCalledWith(3, "turn-1");
    expect(props.onSelectTurn).toHaveBeenNthCalledWith(4, "turn-1");

    const contextTurn = renderer.root.findByProps({ "aria-label": "Add turn turn-1 as context" });
    TestRenderer.act(() => {
      contextTurn.props.onChange();
    });
    expect(props.onToggleContextTurn).toHaveBeenCalledWith("turn-1");

    const previous = renderer.root.findByProps({ "aria-label": "Show previous variant for turn turn-1" });
    const next = renderer.root.findByProps({ "aria-label": "Show next variant for turn turn-1" });
    const details = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Run details");
    const retry = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Retry run step");
    const startThread = renderer.root.findByProps({ "aria-label": "Start a new thread from turn turn-1" });
    TestRenderer.act(() => {
      previous.props.onClick();
      next.props.onClick();
      details.props.onClick();
      retry.props.onClick();
      startThread.props.onClick();
    });
    expect(props.onSwitchBranch).toHaveBeenCalledWith("turn-a");
    expect(props.onSwitchBranch).toHaveBeenCalledWith("turn-c");
    expect(props.onOpenRunDetails).toHaveBeenCalledWith("turn-1");
    expect(props.onRetryTurn).toHaveBeenCalledWith("turn-1");
    expect(props.onStartNewThreadFromTurn).toHaveBeenCalledWith("turn-1");

    const version = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Save new version",
    );
    TestRenderer.act(() => {
      version.props.onClick();
    });
    expect(props.onCreateGeneratedArtifactVersion).toHaveBeenCalledWith("turn-1");
  });

  it("opens Universal Run Detail only from durable-linked turns", () => {
    const onOpenUniversalRunDetail = vi.fn();
    const baseProps = buildProps();
    const props = buildProps({
      thread: {
        ...baseProps.thread,
        turns: [
          {
            ...baseProps.thread.turns[0],
            trace: {
              ...baseProps.thread.turns[0].trace,
              durable: { runId: "durable-run-1" },
              orchestration: { runId: "orchestration-run-1" },
            },
          },
        ],
      },
    });
    const renderer = TestRenderer.create(
      <ThreadedTimeline props={props as any} onOpenUniversalRunDetail={onOpenUniversalRunDetail} />,
    );

    const traceButton = renderer.root.find((node) => node.type === "button" && node.children.join("") === "Run trace");
    TestRenderer.act(() => {
      traceButton.props.onClick();
    });

    expect(onOpenUniversalRunDetail).toHaveBeenCalledWith("durable-run-1");
    expect(onOpenUniversalRunDetail).not.toHaveBeenCalledWith("orchestration-run-1");
  });

  it("distinguishes create and open artifact actions", () => {
    const onCreateGeneratedArtifact = vi.fn();
    const onOpenGeneratedArtifact = vi.fn();
    const props = buildProps({ onCreateGeneratedArtifact, onOpenGeneratedArtifact });
    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);

    const createButton = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Save answer",
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
      (node) => node.type === "button" && node.children.join("") === "Open saved answer",
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
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />, {
        createNodeMock: (element) =>
          element.type === "div" && (element.props as any)["aria-hidden"] === "true" ? { scrollIntoView } : null,
      });
    });

    expect(renderedText(renderer)).toContain("Delegation run");
    expect(renderedText(renderer)).toContain("run-1");
    expect(renderedText(renderer)).toContain("Architect Lead");
    expect(renderedText(renderer)).toContain("Could not validate source freshness.");
    expect(renderedText(renderer)).toContain("Final synthesis");
    expect(renderedText(renderer)).toContain("Tool queue is backed up.");
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
    vi.unstubAllGlobals();
  });

  it("keeps auto-follow pinned when new turns arrive while the operator is already at the bottom", async () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = buildProps({
      mode: "chat",
      followOutput: true,
      streamStatus: "streaming",
      onBottomStateChange,
      delegationRun: null,
    });

    await act(async () => {
      root?.render(<ThreadedTimeline props={props as any} />);
      await Promise.resolve();
    });
    const scrollElement = container?.querySelector(".mc-next-thread-scroll") as HTMLElement;
    setScrollMetrics(scrollElement, { scrollHeight: 900, scrollTop: 500, clientHeight: 400 });
    // Keep onBottomStateChange history: the shared hook de-duplicates repeated
    // bottom states, so the pinned `true` is asserted from the initial follow
    // tick while the post-update tick stays silent (still pinned, never `false`).
    scrollIntoView.mockClear();

    const nextTurn = {
      ...props.thread.turns[0],
      turnId: "turn-2",
      userMessage: {
        ...props.thread.turns[0].userMessage,
        messageId: "user-2",
        content: "Follow-up question.",
      },
      assistantMessage: {
        ...props.thread.turns[0].assistantMessage,
        messageId: "assistant-2",
        content: "Follow-up answer.",
      },
      trace: {
        ...props.thread.turns[0].trace,
        turnId: "turn-2",
        userMessageId: "user-2",
      },
    };
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 500, clientHeight: 400 });

    await act(async () => {
      root?.render(
        <ThreadedTimeline
          props={
            {
              ...props,
              thread: {
                ...props.thread,
                activeLeafTurnId: "turn-2",
                selectedTurnId: "turn-2",
                turns: [...props.thread.turns, nextTurn],
              },
            } as any
          }
        />,
      );
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
    vi.unstubAllGlobals();
    scrollIntoView.mockRestore();
  });

  it("keeps auto-follow pinned as the visible streaming preview grows", async () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = buildProps({
      mode: "chat",
      followOutput: true,
      streamStatus: "streaming",
      onBottomStateChange,
      delegationRun: null,
      activeStreamingTurnId: "turn-1",
      streamingPreview: {
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        text: "Streaming answer",
        visibleText: "Streaming",
        isRunning: true,
        updatedAt: 1,
      },
    });

    await act(async () => {
      root?.render(<ThreadedTimeline props={props as any} />);
      await Promise.resolve();
    });
    scrollIntoView.mockClear();
    onBottomStateChange.mockClear();

    await act(async () => {
      root?.render(
        <ThreadedTimeline
          props={
            {
              ...props,
              streamingPreview: {
                ...props.streamingPreview,
                visibleText: "Streaming answer with more visible text",
                updatedAt: 2,
              },
            } as any
          }
        />,
      );
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(onBottomStateChange).not.toHaveBeenCalledWith(false);
    vi.unstubAllGlobals();
    scrollIntoView.mockRestore();
  });

  it("stops auto-follow while the operator is reading above the bottom and resumes at the bottom", async () => {
    const onBottomStateChange = vi.fn();
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = buildProps({
      mode: "chat",
      followOutput: true,
      onBottomStateChange,
      delegationRun: null,
    });

    await act(async () => {
      root?.render(<ThreadedTimeline props={props as any} />);
      await Promise.resolve();
    });
    const scrollElement = container?.querySelector(".mc-next-thread-scroll") as HTMLElement;
    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 200, clientHeight: 400 });

    await act(async () => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onBottomStateChange).toHaveBeenCalledWith(false);

    onBottomStateChange.mockClear();
    scrollIntoView.mockClear();
    await act(async () => {
      root?.render(<ThreadedTimeline props={{ ...props, followOutput: false } as any} />);
      await Promise.resolve();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Jump to latest");

    setScrollMetrics(scrollElement, { scrollHeight: 1200, scrollTop: 800, clientHeight: 400 });
    await act(async () => {
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onBottomStateChange).toHaveBeenCalledWith(true);
    vi.unstubAllGlobals();
    scrollIntoView.mockRestore();
  });

  it("shows the jump-to-latest affordance when scrolled away in a non-streaming thread and hides it at the bottom", async () => {
    await act(async () => {
      root?.render(<ThreadedTimeline props={buildProps({ followOutput: false, streamStatus: "idle" }) as any} />);
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Jump to latest");

    await act(async () => {
      root?.render(<ThreadedTimeline props={buildProps({ followOutput: true, streamStatus: "idle" }) as any} />);
      await Promise.resolve();
    });
    expect(container?.textContent).not.toContain("Jump to latest");
  });

  it("labels the jump affordance with pending blockers", async () => {
    await act(async () => {
      root?.render(
        <ThreadedTimeline
          props={
            buildProps({
              followOutput: false,
              pendingApproval: {
                approvalId: "approval-1",
                sessionId: "session-1",
                turnId: "turn-1",
                toolName: "fs.write",
                kind: "tool",
                reason: "Needs approval",
                riskLevel: "medium",
              },
            }) as any
          }
        />,
      );
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Jump to approval");

    await act(async () => {
      root?.render(
        <ThreadedTimeline
          props={
            buildProps({
              followOutput: false,
              pendingUserInput: {
                promptId: "prompt-1",
                sessionId: "session-1",
                turnId: "turn-1",
                message: "Pick a target.",
              },
            }) as any
          }
        />,
      );
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Jump to answer prompt");
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

  it("keeps normal Chat turns conversation-first until exceptional", () => {
    const props = buildProps({
      mode: "chat",
      delegationRun: null,
      selectedTurnId: null,
    });
    props.thread.turns[0].trace.mode = "chat";
    props.thread.turns[0].trace.routing = {
      effectiveProviderId: "anthropic",
      effectiveModel: "claude-sonnet",
      effectiveApiStyle: "messages",
    };

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    expect(renderedText(renderer)).toContain("Context");
    expect(renderedText(renderer)).toContain("Details");
    expect(renderedText(renderer)).not.toContain("used anthropic · claude-sonnet · messages");

    renderer.update(<ThreadedTimeline props={{ ...props, selectedTurnId: "turn-1" } as any} />);
    expect(renderedText(renderer)).not.toContain("used anthropic · claude-sonnet · messages");
  });

  it("windows long transcripts while keeping selected, context-pinned, streaming, and recent turns rendered", () => {
    const props = buildProps({
      mode: "chat",
      delegationRun: null,
      selectedTurnId: "turn-5",
      selectedContextTurnIds: ["turn-10"],
      activeStreamingTurnId: "turn-110",
      streamingPreview: {
        sessionId: "session-1",
        turnId: "turn-110",
        messageId: "assistant-110",
        text: "Streaming answer 110",
        visibleText: "Streaming answer 110",
        isRunning: true,
        updatedAt: 110,
      },
    });
    const baseTurn = props.thread.turns[0];
    props.thread.turns = Array.from({ length: 120 }, (_, index) => {
      const turnNumber = index + 1;
      return {
        ...baseTurn,
        turnId: `turn-${turnNumber}`,
        userMessage: {
          ...baseTurn.userMessage,
          messageId: `user-${turnNumber}`,
          content: `User message ${turnNumber}`,
        },
        assistantMessage:
          turnNumber === 110
            ? undefined
            : {
                ...baseTurn.assistantMessage,
                messageId: `assistant-${turnNumber}`,
                content: `Assistant answer ${turnNumber}`,
              },
        trace: {
          ...baseTurn.trace,
          turnId: `turn-${turnNumber}`,
          userMessageId: `user-${turnNumber}`,
          status: turnNumber === 110 ? "running" : "completed",
          mode: "chat",
        },
        branch: {
          ...baseTurn.branch,
          siblingTurnIds: [`turn-${turnNumber}`],
        },
      };
    });
    props.thread.activeLeafTurnId = "turn-120";

    const renderer = TestRenderer.create(<ThreadedTimeline props={props as any} />);
    const text = renderedText(renderer);

    expect(text).toContain("User message 5");
    expect(text).toContain("User message 10");
    expect(text).toContain("Context pinned");
    expect(text).toContain("Streaming answer 110");
    expect(text).toContain("User message 120");
    expect(text).toContain("hidden for performance");
    expect(text).not.toContain("User message 30");

    const showHidden = renderer.root.find(
      (node) => node.type === "button" && node.children.join("") === "Show hidden turns",
    );
    TestRenderer.act(() => {
      showHidden.props.onClick();
    });

    expect(renderedText(renderer)).toContain("User message 30");
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

    const details = renderer.root.find((node) => node.type === "details" && typeof node.props.onToggle === "function");
    TestRenderer.act(() => {
      details.props.onToggle({ currentTarget: { open: true } });
    });
    expect(
      renderer.root.find((node) => node.type === "details" && typeof node.props.onToggle === "function").props.open,
    ).toBe(true);
    expect(renderedText(renderer)).toContain("Delegated work is still running; final synthesis is not ready yet.");
  });
});

import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { ChatThreadView } from "./ChatThreadView";

function createThread(): ChatThreadResponse {
  return {
    sessionId: "sess-tail",
    turns: [
      {
        turnId: "turn-tail",
        userMessage: {
          messageId: "user-tail",
          sessionId: "sess-tail",
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "inspect this",
          timestamp: "2026-04-04T00:00:00.000Z",
          attachments: [],
        },
        assistantMessage: {
          messageId: "assistant-tail",
          sessionId: "sess-tail",
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: "tail response",
          timestamp: "2026-04-04T00:00:01.000Z",
        },
        toolRuns: [],
        citations: [
          { title: "One", url: "https://example.com/one" },
          { title: "Two", url: "https://example.com/two" },
        ],
        branch: {
          siblingCount: 1,
          activeSiblingIndex: 0,
          siblingTurnIds: ["turn-tail"],
        },
        branchKind: "append",
        trace: {
          turnId: "turn-tail",
          sessionId: "sess-tail",
          userMessageId: "user-tail",
          status: "failed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          effectiveToolAutonomy: "safe_auto",
          model: "fallback-model",
          routing: {
            liveDataIntent: false,
            fallbackUsed: true,
          },
          failure: {
            failureClass: "provider_error",
            message: "Provider failed.",
          },
          orchestration: {
            runId: "run-tail",
          },
          startedAt: "2026-04-04T00:00:00.000Z",
        },
      },
    ],
  } as unknown as ChatThreadResponse;
}

function buildProps(overrides: Partial<React.ComponentProps<typeof ChatThreadView>> = {}) {
  return {
    mode: "cowork" as const,
    loading: false,
    thread: createThread(),
    selectedTurnId: "turn-tail",
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
    ...overrides,
  };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("ChatThreadView tail coverage", () => {
  it("renders failed routing fallbacks, citation plurals, and selected action callbacks", () => {
    const props = buildProps();
    const renderer = TestRenderer.create(<ChatThreadView {...props} />);

    const text = renderedText(renderer);
    expect(text).toContain("provider_error");
    expect(text).toContain("effective fallback-model");
    expect(text).toContain("fallback used");
    expect(text).toContain("2 citations");
    expect(text).toContain("orchestrated");
    expect(text).toContain("Retry run step");
    expect(renderer.root.findAll((node) => node.props["aria-label"]?.includes("variant"))).toHaveLength(0);

    const buttons = renderer.root.findAllByType("button");
    TestRenderer.act(() => {
      buttons.find((button) => button.children.join("") === "Run details")?.props.onClick();
      buttons.find((button) => button.children.join("") === "Open run details")?.props.onClick();
      buttons.find((button) => button.children.join("") === "Retry run step")?.props.onClick();
      buttons.find((button) => button.children.join("") === "Edit and resend")?.props.onClick();
      buttons.find((button) => button.children.join("") === "Create artifact")?.props.onClick();
    });

    expect(props.onOpenRunDetails).toHaveBeenCalledWith("turn-tail");
    expect(props.onRetryTurn).toHaveBeenCalledWith("turn-tail");
    expect(props.onEditTurn).toHaveBeenCalledWith("turn-tail");
    expect(props.onCreateGeneratedArtifact).toHaveBeenCalledWith("turn-tail");
  });

  it("hides turn actions when an unselected turn has no suggestions or artifact", () => {
    const renderer = TestRenderer.create(<ChatThreadView {...buildProps({ selectedTurnId: null })} />);

    expect(
      renderer.root.findAll((node) => Array.isArray(node.children) && node.children.join("") === "Edit and resend"),
    ).toHaveLength(0);
  });

  it("covers completed compact cowork delegation fallbacks and summary toggles", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildProps({
          mode: "cowork",
          delegationRun: {
            label: "Review Crew",
            objective: "Check release readiness",
            mode: "sequential",
            status: "completed",
            steps: [
              {
                stepId: "step-skipped",
                role: "qa_lead",
                label: "   ",
                status: "skipped",
                index: 0,
              },
            ],
          },
        })}
      />,
    );

    expect(renderedText(renderer)).toContain("completed");
    expect(renderedText(renderer)).toContain("Now: Qa Lead");
    expect(
      renderer.root.findAll((node) => node.type === "button" && node.children.join("") === "Open details"),
    ).toHaveLength(0);

    const details = renderer.root.findByType("details");
    TestRenderer.act(() => {
      details.props.onToggle({ currentTarget: { open: false } });
    });
    expect(renderer.root.findByType("details").props.open).toBe(false);
  });

  it("covers compact cowork partial and pending status tones", () => {
    const partial = TestRenderer.create(
      <ChatThreadView
        {...buildProps({
          mode: "cowork",
          delegationRun: {
            label: "Partial Review",
            objective: "Check unresolved work",
            mode: "parallel",
            status: "partial",
            steps: [],
          },
        })}
      />,
    );
    expect(renderedText(partial)).toContain("partial");
    expect(renderedText(partial)).not.toContain("Now:");

    const pending = TestRenderer.create(
      <ChatThreadView
        {...buildProps({
          mode: "cowork",
          delegationRun: {
            label: "Queued Review",
            objective: "Wait for subagents",
            mode: "parallel",
            status: "running",
            steps: [],
          },
        })}
      />,
    );
    expect(renderedText(pending)).toContain("running");
  });

  it("covers failed non-cowork delegation without optional run identifiers", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView
        {...buildProps({
          mode: "chat",
          delegationRun: {
            label: "Background Review",
            objective: "Inspect a risky turn",
            mode: "parallel",
            status: "failed",
            steps: [
              {
                stepId: "step-failed",
                role: "risk_reviewer",
                status: "failed",
                index: 0,
                error: "Risk review failed.",
              },
            ],
          },
        })}
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain("Delegation run");
    expect(text).toContain("failed");
    expect(text).toContain("Risk review failed.");
    expect(text).not.toContain("Plan ");
    expect(text).not.toContain("Task ");
  });

  it("covers completed and pending non-cowork delegation status tones", () => {
    for (const status of ["completed", "running"] as const) {
      const renderer = TestRenderer.create(
        <ChatThreadView
          {...buildProps({
            mode: "chat",
            delegationRun: {
              label: "Background Review",
              objective: "Inspect a turn",
              mode: "parallel",
              status,
              steps: [{ stepId: `step-${status}`, role: "qa_lead", status, index: 0 }],
            },
          })}
        />,
      );

      expect(renderedText(renderer)).toContain(status);
      expect(renderedText(renderer)).toContain("Qa Lead");
    }
  });
});

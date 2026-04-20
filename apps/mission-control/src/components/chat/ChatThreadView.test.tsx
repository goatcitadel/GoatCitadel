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

describe("ChatThreadView", () => {
  it("skips raw HTML in assistant markdown output", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView
        mode="chat"
        loading={false}
        thread={createThread("<img src=x onerror=alert(1) /> **safe**")}
        selectedTurnId="turn-1"
        delegationRun={null}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
      />,
    );

    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.type === "strong" && node.children.includes("safe"))).toHaveLength(1);
  });

  it("adds accessible labels to branch and turn actions", () => {
    const renderer = TestRenderer.create(
      <ChatThreadView
        mode="chat"
        loading={false}
        thread={createThread("plain content")}
        selectedTurnId="turn-1"
        delegationRun={null}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
      />,
    );

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

    const renderer = TestRenderer.create(
      <ChatThreadView
        mode="chat"
        loading={false}
        thread={thread}
        selectedTurnId="turn-1"
        delegationRun={null}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
      />,
    );

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

    const renderer = TestRenderer.create(
      <ChatThreadView
        mode="chat"
        loading={false}
        thread={thread}
        selectedTurnId="turn-1"
        delegationRun={null}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
      />,
    );

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

    const renderer = TestRenderer.create(
      <ChatThreadView
        mode="chat"
        loading={false}
        thread={thread}
        selectedTurnId="turn-1"
        delegationRun={null}
        notices={[]}
        followOutput={false}
        onBottomStateChange={vi.fn()}
        onSelectTurn={vi.fn()}
        onSwitchBranch={vi.fn()}
        onRetryTurn={vi.fn()}
        onEditTurn={vi.fn()}
        onOpenRunDetails={vi.fn()}
      />,
    );

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
        mode="chat"
        loading={false}
        thread={createThread("plain content")}
        selectedTurnId="turn-1"
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
});

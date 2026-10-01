// @vitest-environment happy-dom
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChangePlanRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps, MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent, components, context }: {
    data: ChatThreadTurnRecord[];
    itemContent: (index: number, turn: ChatThreadTurnRecord) => ReactNode;
    components: { Footer?: ComponentType<{ context?: unknown }>; EmptyPlaceholder?: ComponentType };
    context?: unknown;
  }) => {
    const Footer = components.Footer;
    const EmptyPlaceholder = components.EmptyPlaceholder;
    return <div>{data.map((turn, index) => <div key={turn.turnId}>{itemContent(index, turn)}</div>)}
      {!data.length && EmptyPlaceholder ? <EmptyPlaceholder /> : null}
      {Footer ? <Footer context={context} /> : null}
    </div>;
  },
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer", () => ({
  AssistantMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => null,
}));

function turn(turnId: string, selected: boolean, status: "completed" | "failed" = "completed"): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, content: `User ${turnId}` },
    assistantMessage: status === "completed" ? { content: `Assistant ${turnId}` } : undefined,
    trace: { status, model: "sample/model", completion: { usage: { costUsd: 0.01, costSource: "provider_reported" } } },
    toolRuns: [], citations: [], branch: { isSelectedPath: selected },
  } as unknown as ChatThreadTurnRecord;
}

function sessionProps(turns: ChatThreadTurnRecord[]): MissionThreadedActiveSessionSurfaceProps {
  return { selectedSessionId: "session-1", thread: { sessionId: "session-1", turns }, followOutput: true, hasActiveStream: false } as unknown as MissionThreadedActiveSessionSurfaceProps;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ChatTranscript", () => {
  it("retains an exact danger review across fresh transcript props and closes it when review content changes", async () => {
    const onApprovePending = vi.fn();
    const approval = { approvalId: "approval-1", kind: "tool_invoke", riskLevel: "danger" as const, toolName: "write_file", reason: "Reviewed file" };
    const props = { ...sessionProps([turn("visible", true)]), pendingApproval: approval, approvalPending: false, onApprovePending, onDenyPending: vi.fn() };
    const render = async (next: MissionThreadedActiveSessionSurfaceProps) => act(async () => root.render(<InspectorProvider><ChatTranscript props={next} /></InspectorProvider>));
    await render(props);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Review approval")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render({ ...props, pendingApproval: { ...approval }, notices: [{ id: "refresh", tone: "success", content: "Fresh observation", timestamp: "2026-10-01T00:00:00Z" }] });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onApprovePending).not.toHaveBeenCalled();
    await render({ ...props, pendingApproval: { ...approval, reason: "Different file" } });
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
    expect(onApprovePending).not.toHaveBeenCalled();
  });

  it("retains a question answer across transcript refreshes and clears it on conversation change", async () => {
    const prompt = { promptId: "prompt-1", turnId: "turn-1", kind: "single_select" as const, title: "Choose", question: "Which option?", required: true,
      options: [{ optionId: "option-a", label: "First", description: "First path" }, { optionId: "option-b", label: "Second", description: "Second path" }] };
    const onSubmitUserInput = vi.fn();
    const props = { ...sessionProps([turn("visible", true)]), pendingUserInput: prompt, userInputPending: false, onSubmitUserInput };
    const render = async (next: MissionThreadedActiveSessionSurfaceProps) => act(async () => root.render(<InspectorProvider><ChatTranscript props={next} /></InspectorProvider>));
    await render(props);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="option-a"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(true);
    await render({ ...props, pendingUserInput: { ...prompt }, notices: [{ id: "refresh", tone: "success", content: "Fresh observation", timestamp: "2026-10-01T00:00:00Z" }] });
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(true);
    expect(onSubmitUserInput).not.toHaveBeenCalled();
    await render({ ...props, selectedSessionId: "session-2" });
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(false);
  });

  it("keeps controller notices available beside the conversation", async () => {
    const props = {
      ...sessionProps([turn("visible", true)]),
      notices: [{ id: "notice-1", tone: "success" as const, content: "Queued a code helper run for this snippet.", timestamp: "2026-09-29T00:00:00.000Z" }],
    };
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={props} /></InspectorProvider>));
    expect(container.querySelector('summary[aria-label="Conversation updates (1)"]')).not.toBeNull();
    expect(container.textContent).toContain("Queued a code helper run for this snippet.");
  });

  it("shows only the selected branch and opens recorded turn details", async () => {
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([turn("visible", true), turn("hidden", false)])} /><InspectorPanel /></InspectorProvider>));
    expect(container.textContent).toContain("Assistant visible");
    expect(container.textContent).not.toContain("Assistant hidden");
    await act(async () => (container.querySelector('[aria-label="Inspect turn details"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("Cost: $0.01");
  });

  it("keeps failed turns visible with a recovery handoff", async () => {
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([turn("failed", true, "failed")])} /></InspectorProvider>));
    expect(container.textContent).toContain("User failed");
    expect(container.textContent).toContain("Review run details or retry when available");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("uses the recorded failed answer as the only failure message", async () => {
    const recorded = turn("failed-answer", true, "failed");
    recorded.assistantMessage = { content: "The provider could not finish this turn." } as ChatThreadTurnRecord["assistantMessage"];
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={{ ...sessionProps([recorded]), streamError: "provider failed" }} /></InspectorProvider>));
    expect(container.textContent).toContain("The provider could not finish this turn.");
    expect(container.querySelector('[data-tone="failed"]')?.textContent).toBe("Failed");
    expect(container.textContent).not.toContain("This response failed.");
    expect(container.textContent).not.toContain("The response was interrupted.");
    expect(container.textContent).not.toContain("Save answer");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("offers Retry for a cancelled turn that has no assistant message", async () => {
    const cancelled = turn("cancelled", true, "failed");
    cancelled.trace.status = "cancelled";
    cancelled.trace.failure = undefined;
    const onRetryTurn = vi.fn();
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={{ ...sessionProps([cancelled]), onRetryTurn }} /></InspectorProvider>));
    expect(container.textContent).toContain("Cancelled");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(onRetryTurn).toHaveBeenCalledWith("cancelled");
  });

  it("explains an empty thread without inventing a message", async () => {
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([])} /></InspectorProvider>));
    expect(container.textContent).toContain("No messages yet");
    expect(container.querySelectorAll('[aria-label="Conversation turn"]')).toHaveLength(0);
  });

  it("reviews an owned change plan through the controller callback", async () => {
    const plan = {
      planId: "plan-1", revision: 1, kind: "session_model", scope: "current_chat",
      status: "awaiting_confirmation", phase: "confirmation", risk: "safe",
      request: { kind: "session_model" }, title: "Use another model", summary: "Change this conversation.",
      requiredAction: { kind: "confirmation", actionId: "action-1", title: "Confirm model" },
      evidenceRefs: [], approvalRefs: [], rollbackRefs: [],
    } as unknown as ChangePlanRecord;
    const onReview = vi.fn();
    const receipt = { plan, onReview } satisfies NonNullable<MissionThreadedRenderSurfaceInput["changePlanReceipt"]>;
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([])} receipt={receipt} /></InspectorProvider>));
    expect(container.textContent).toContain("Use another model");
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review and confirm");
    await act(async () => review?.click());
    expect(onReview).toHaveBeenCalledWith(plan);
  });

  it("opens cockpit run inspection from a turn and its recorded run card", async () => {
    const onInspectTurn = vi.fn();
    const recorded = turn("run-turn", true);
    recorded.trace.durable = { runId: "durable-1" } as ChatThreadTurnRecord["trace"]["durable"];
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([recorded])} onInspectTurn={onInspectTurn} /></InspectorProvider>));
    expect(container.textContent).toContain("Durable run");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Run details")?.click());
    expect(onInspectTurn).toHaveBeenCalledWith("run-turn");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Inspect run")?.click());
    expect(onInspectTurn).toHaveBeenCalledTimes(2);
    expect(container.querySelector('a[href="/work/runs/durable-1?shell=cockpit"]')).not.toBeNull();
  });

  it("keeps an OpenCode result beside its conversation turn", async () => {
    const recorded = turn("code-turn", true);
    recorded.toolRuns = [{
      toolRunId: "tool-1", turnId: "code-turn", sessionId: "session-1", toolName: "shell.exec",
      status: "executed", startedAt: "2026-09-28T00:00:00Z",
      result: { externalAgent: { engine: "opencode", version: 1, truncated: false, steps: [], files: [{ path: "src/retry.ts" }] } },
    }];
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={sessionProps([recorded])} /></InspectorProvider>));
    expect(container.textContent).toContain("OpenCode report");
    expect(container.textContent).toContain("1 reported file");
    expect(container.textContent).toContain("Reported files");
  });

  it("opens a Gateway-recorded artifact from its turn", async () => {
    const recorded = turn("artifact-turn", true);
    recorded.generatedArtifacts = [{
      artifactId: "artifact-1", kind: "code", title: "Saved patch", sourceSurface: "code",
      version: 2, createdAt: "2026-09-28T00:00:00Z",
    }];
    const onOpenGeneratedArtifact = vi.fn();
    const onOpenArtifact = vi.fn();
    await act(async () => root.render(<InspectorProvider><ChatTranscript props={{ ...sessionProps([recorded]), onOpenGeneratedArtifact }} onOpenArtifact={onOpenArtifact} /></InspectorProvider>));
    expect(container.textContent).toContain("Saved artifacts");
    expect(container.textContent).toContain("Version 2");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Saved patch")?.click());
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact-turn", "artifact-1");
    expect(onOpenGeneratedArtifact).not.toHaveBeenCalled();
  });
});

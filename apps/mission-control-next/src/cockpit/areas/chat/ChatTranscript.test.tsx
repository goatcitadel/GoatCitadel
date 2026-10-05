// @vitest-environment happy-dom
import { act, type ComponentType, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChangePlanRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel, InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

const viewport = vi.hoisted(() => ({
  preview: null as { turnId: string; visibleText: string } | null,
}));

vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: vi.fn().mockResolvedValue(null),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
    context,
    computeItemKey,
    followOutput,
    scrollerRef,
  }: {
    data: ChatThreadTurnRecord[];
    itemContent: (index: number, turn: ChatThreadTurnRecord) => ReactNode;
    components: { Footer?: ComponentType<{ context?: unknown }>; EmptyPlaceholder?: ComponentType };
    context?: unknown;
    computeItemKey?: (index: number, turn: ChatThreadTurnRecord) => string;
    followOutput?: boolean | string | ((atBottom: boolean) => boolean | string);
    scrollerRef?: Ref<HTMLDivElement>;
  }) => {
    const Footer = components.Footer;
    const EmptyPlaceholder = components.EmptyPlaceholder;
    return (
      <div
        ref={scrollerRef}
        data-follow-output={String(typeof followOutput === "function" ? followOutput(true) : followOutput)}
      >
        {data.map((turn, index) => (
          <div key={computeItemKey?.(index, turn) ?? index}>{itemContent(index, turn)}</div>
        ))}
        {!data.length && EmptyPlaceholder ? <EmptyPlaceholder /> : null}
        {Footer ? <Footer context={context} /> : null}
      </div>
    );
  },
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer", () => ({
  AssistantMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => viewport.preview,
}));

function turn(turnId: string, selected: boolean, status: "completed" | "failed" = "completed"): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, content: `User ${turnId}` },
    assistantMessage: status === "completed" ? { content: `Assistant ${turnId}` } : undefined,
    trace: { status, model: "sample/model", completion: { usage: { costUsd: 0.01, costSource: "provider_reported" } } },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: selected },
  } as unknown as ChatThreadTurnRecord;
}

function sessionProps(turns: ChatThreadTurnRecord[]): MissionThreadedActiveSessionSurfaceProps {
  return {
    selectedSessionId: "session-1",
    thread: { sessionId: "session-1", turns },
    followOutput: true,
    hasActiveStream: false,
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function renderWithProviders(node: ReactNode) {
  root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
beforeEach(() => {
  viewport.preview = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe("ChatTranscript", () => {
  it("hydrates missing approval risk from the matching pending canonical record", async () => {
    const onApprovePending = vi.fn();
    vi.mocked(fetchApproval).mockResolvedValueOnce({
      approvalId: "hydrate-risk",
      kind: "tool_invoke",
      status: "pending",
      riskLevel: "caution",
      expiresAt: "2099-10-02T00:00:00Z",
    } as never);
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{
              ...sessionProps([turn("approval-hydrate", true)]),
              pendingApproval: { approvalId: "hydrate-risk", toolName: "fs.read" },
              onApprovePending,
            }}
          />
        </InspectorProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const allow = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve once");
    expect(allow).toBeDefined();
    await act(async () => allow!.click());
    expect(onApprovePending).toHaveBeenCalledWith("once");
  });

  it.each([
    { name: "missing", record: undefined },
    { name: "settled", record: { approvalId: "closed-risk", status: "approved", riskLevel: "caution" } },
    { name: "unrelated", record: { approvalId: "another-risk", status: "pending", riskLevel: "caution" } },
  ])("keeps an unclassified approval closed when its canonical record is $name", async ({ record }) => {
    if (record) vi.mocked(fetchApproval).mockResolvedValueOnce(record as never);
    else
      vi.mocked(fetchApproval).mockRejectedValueOnce(
        new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 }),
      );
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{
              ...sessionProps([turn("approval-closed", true)]),
              pendingApproval: { approvalId: "closed-risk", toolName: "fs.read" },
            }}
          />
        </InspectorProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Risk is unavailable");
    expect(container.textContent).not.toContain("Approve once");
  });
  it("follows measured growth of the same streamed turn only while pinned and enabled", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
      frames.push(frame);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const scrollIntoView = vi.fn();
    const onBottomStateChange = vi.fn();
    const recorded = turn("growth", true);
    const render = async (followOutput = true) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript
              props={{
                ...sessionProps([{ ...recorded }]),
                followOutput,
                hasActiveStream: true,
                activeStreamingTurnId: "growth",
                onBottomStateChange: (atBottom) => onBottomStateChange(atBottom),
              }}
            />
          </InspectorProvider>,
        ),
      );
    const flushFrames = async () => {
      container.querySelector<HTMLElement>('div[aria-hidden="true"].h-px')!.scrollIntoView = scrollIntoView;
      await act(async () => {
        for (const frame of frames.splice(0)) frame(0);
      });
    };
    await render();
    await flushFrames();
    scrollIntoView.mockClear();
    const scroller = container.querySelector<HTMLElement>("[data-follow-output]")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    scrollIntoView.mockClear();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
    scrollIntoView.mockClear();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 950 });
    scroller.scrollTop = 0;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
    scrollIntoView.mockClear();
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    // Owner refreshes can replace callback props between the gesture and its
    // native scroll event. The DOM binding must keep the reader's intent.
    await render();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scroller.scrollTop = 100;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(onBottomStateChange).toHaveBeenLastCalledWith(false);
    viewport.preview = { turnId: "growth", visibleText: "A growing answer" };
    await render(false);
    await flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
    scroller.scrollTop = 1000;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(onBottomStateChange).toHaveBeenLastCalledWith(true);
    viewport.preview = { turnId: "growth", visibleText: "A growing answer at the bottom" };
    await render();
    await flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockClear();
    viewport.preview = { turnId: "growth", visibleText: "A growing answer with follow disabled" };
    await render(false);
    await flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
  it("retains disclosure and focus by turn and tool ID through insertion and canonical refresh", async () => {
    const recorded = turn("retained", true);
    const first = {
      toolRunId: "first",
      turnId: recorded.turnId,
      sessionId: "session-1",
      toolName: "session.status",
      status: "started" as const,
      startedAt: "2026-10-02T00:00:00Z",
    };
    const second = { ...first, toolRunId: "second", status: "blocked" as const, error: "Denied by policy" };
    recorded.toolRuns = [first, second];
    const render = async (turns: ChatThreadTurnRecord[]) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={sessionProps(turns)} />
          </InspectorProvider>,
        ),
      );
    await render([recorded]);
    const disclosure = container.querySelector<HTMLDetailsElement>(
      'details[aria-label="Tool activity for this turn"]',
    )!;
    const summary = disclosure.querySelector("summary")!;
    const row = disclosure.querySelector('[data-tool-run-id="first"]');
    disclosure.open = true;
    summary.focus();
    expect(summary.textContent).toContain("1 running");
    expect(summary.textContent).toContain("1 blocked");
    await render([turn("inserted", true), { ...recorded, toolRuns: [second, { ...first, status: "executed" }] }]);
    expect(container.querySelector('details[aria-label="Tool activity for this turn"]')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(disclosure.querySelector('[data-tool-run-id="first"]')).toBe(row);
    expect(disclosure.querySelectorAll("li")).toHaveLength(2);
    expect(summary.textContent).toContain("1 done");
    expect(disclosure.textContent).toContain("Denied by policy");
  });

  it("reports failed, approval and uncertain results without announcing each refresh", async () => {
    const recorded = turn("activity", true);
    const base = {
      turnId: recorded.turnId,
      sessionId: "session-1",
      toolName: "session.status",
      startedAt: "2026-10-02T00:00:00Z",
    };
    recorded.toolRuns = [
      { ...base, toolRunId: "failed", status: "failed", failureGuidance: "Inspect before retrying" },
      { ...base, toolRunId: "approval", status: "approval_required" },
      { ...base, toolRunId: "uncertain", status: "executed", result: { exitCode: 1 }, effectOutcomeKind: "uncertain" },
    ];
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([recorded])} />
        </InspectorProvider>,
      ),
    );
    const activity = container.querySelector('details[aria-label="Tool activity for this turn"]')!;
    expect(activity.textContent).toContain("1 failed");
    expect(activity.textContent).toContain("1 approval needed");
    expect(activity.textContent).toContain("1 needs review");
    expect(activity.textContent).toContain("Automatic replay is suppressed");
    expect(activity.textContent).toContain("Inspect before retrying");
    expect(activity.querySelector('[aria-live], [role="status"]')).toBeNull();
  });

  it("uses instant bottom-follow under reduced motion and honors disabled follow", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const render = async (followOutput: boolean) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={{ ...sessionProps([turn("motion", true)]), followOutput }} />
          </InspectorProvider>,
        ),
      );
    await render(true);
    expect(container.querySelector('[data-follow-output="true"]')).not.toBeNull();
    await render(false);
    expect(container.querySelector('[data-follow-output="false"]')).not.toBeNull();
  });

  it("labels and copies exact partial source, then exact canonical final source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const recorded = turn("copy", true);
    recorded.assistantMessage!.content = "**Partial** source \\u0057";
    const render = async (running: boolean) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript
              props={{
                ...sessionProps([recorded]),
                hasActiveStream: running,
                activeStreamingTurnId: running ? recorded.turnId : null,
              }}
            />
          </InspectorProvider>,
        ),
      );
    await render(true);
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy answer so far")!.click(),
    );
    expect(writeText).toHaveBeenLastCalledWith("**Partial** source \\u0057");
    expect(container.textContent).toContain("Partial answer copied.");
    recorded.assistantMessage!.content += " final";
    await render(false);
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy answer")!.click(),
    );
    expect(writeText).toHaveBeenLastCalledWith(recorded.assistantMessage!.content);
  });

  it("retains an exact danger review across fresh transcript props and closes it when review content changes", async () => {
    const onApprovePending = vi.fn();
    const approval = {
      approvalId: "approval-1",
      kind: "tool_invoke",
      riskLevel: "danger" as const,
      toolName: "write_file",
      reason: "Reviewed file",
    };
    const props = {
      ...sessionProps([turn("visible", true)]),
      pendingApproval: approval,
      approvalPending: false,
      onApprovePending,
      onDenyPending: vi.fn(),
    };
    const render = async (next: MissionThreadedActiveSessionSurfaceProps) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={next} />
          </InspectorProvider>,
        ),
      );
    await render(props);
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval")!.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render({
      ...props,
      pendingApproval: { ...approval },
      notices: [{ id: "refresh", tone: "success", content: "Fresh observation", timestamp: "2026-10-01T00:00:00Z" }],
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onApprovePending).not.toHaveBeenCalled();
    await render({ ...props, pendingApproval: { ...approval, reason: "Different file" } });
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
    expect(onApprovePending).not.toHaveBeenCalled();
  });

  it("retains a question answer across transcript refreshes and clears it on conversation change", async () => {
    const prompt = {
      promptId: "prompt-1",
      turnId: "turn-1",
      kind: "single_select" as const,
      title: "Choose",
      question: "Which option?",
      required: true,
      options: [
        { optionId: "option-a", label: "First", description: "First path" },
        { optionId: "option-b", label: "Second", description: "Second path" },
      ],
    };
    const onSubmitUserInput = vi.fn();
    const props = {
      ...sessionProps([turn("visible", true)]),
      pendingUserInput: prompt,
      userInputPending: false,
      onSubmitUserInput,
    };
    const render = async (next: MissionThreadedActiveSessionSurfaceProps) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={next} />
          </InspectorProvider>,
        ),
      );
    await render(props);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="option-a"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(true);
    await render({
      ...props,
      pendingUserInput: { ...prompt },
      notices: [{ id: "refresh", tone: "success", content: "Fresh observation", timestamp: "2026-10-01T00:00:00Z" }],
    });
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(true);
    expect(onSubmitUserInput).not.toHaveBeenCalled();
    await render({ ...props, selectedSessionId: "session-2" });
    expect(container.querySelector<HTMLInputElement>('input[value="option-a"]')!.checked).toBe(false);
  });

  it("keeps controller notices available beside the conversation", async () => {
    const props = {
      ...sessionProps([turn("visible", true)]),
      notices: [
        {
          id: "notice-1",
          tone: "success" as const,
          content: "Queued a code helper run for this snippet.",
          timestamp: "2026-09-29T00:00:00.000Z",
        },
      ],
    };
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={props} />
        </InspectorProvider>,
      ),
    );
    expect(container.querySelector('summary[aria-label="Conversation updates (1)"]')).not.toBeNull();
    expect(container.textContent).toContain("Queued a code helper run for this snippet.");
  });

  it("shows only the selected branch and opens recorded turn details", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([turn("visible", true), turn("hidden", false)])} />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Assistant visible");
    expect(container.textContent).not.toContain("Assistant hidden");
    await act(async () =>
      (container.querySelector('[aria-label="Inspect turn details"]') as HTMLButtonElement).click(),
    );
    expect(container.textContent).toContain("Cost: $0.01");
  });

  it("keeps failed turns visible with a recovery handoff", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([turn("failed", true, "failed")])} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("User failed");
    expect(container.textContent).toContain("Review run details or retry when available");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("uses the recorded failed answer as the only failure message", async () => {
    const recorded = turn("failed-answer", true, "failed");
    recorded.assistantMessage = {
      content: "The provider could not finish this turn.",
    } as ChatThreadTurnRecord["assistantMessage"];
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={{ ...sessionProps([recorded]), streamError: "provider failed" }} />
        </InspectorProvider>,
      ),
    );
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
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={{ ...sessionProps([cancelled]), onRetryTurn }} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Cancelled");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(onRetryTurn).toHaveBeenCalledWith("cancelled");
  });

  it("explains an empty thread without inventing a message", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([])} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("No messages yet");
    expect(container.querySelectorAll('[aria-label="Conversation turn"]')).toHaveLength(0);
  });

  it("reviews an owned change plan through the controller callback", async () => {
    const plan = {
      planId: "plan-1",
      revision: 1,
      kind: "session_model",
      scope: "current_chat",
      status: "awaiting_confirmation",
      phase: "confirmation",
      risk: "safe",
      request: { kind: "session_model" },
      title: "Use another model",
      summary: "Change this conversation.",
      requiredAction: { kind: "confirmation", actionId: "action-1", title: "Confirm model" },
      evidenceRefs: [],
      approvalRefs: [],
      rollbackRefs: [],
    } as unknown as ChangePlanRecord;
    const onReview = vi.fn();
    const receipt = { plan, onReview } satisfies NonNullable<MissionThreadedRenderSurfaceInput["changePlanReceipt"]>;
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([])} receipt={receipt} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Use another model");
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review and confirm",
    );
    await act(async () => review?.click());
    expect(onReview).toHaveBeenCalledWith(plan);
  });

  it("opens cockpit run inspection from a turn and its recorded run card", async () => {
    const onInspectTurn = vi.fn();
    const recorded = turn("run-turn", true);
    recorded.trace.durable = { runId: "durable-1" } as ChatThreadTurnRecord["trace"]["durable"];
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([recorded])} onInspectTurn={onInspectTurn} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Durable run");
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Run details")?.click(),
    );
    expect(onInspectTurn).toHaveBeenCalledWith("run-turn");
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Inspect run")?.click(),
    );
    expect(onInspectTurn).toHaveBeenCalledTimes(2);
    expect(container.querySelector('a[href="/work/runs/durable-1?shell=cockpit"]')).not.toBeNull();
  });

  it("keeps an OpenCode result beside its conversation turn", async () => {
    const recorded = turn("code-turn", true);
    recorded.toolRuns = [
      {
        toolRunId: "tool-1",
        turnId: "code-turn",
        sessionId: "session-1",
        toolName: "shell.exec",
        status: "executed",
        startedAt: "2026-09-28T00:00:00Z",
        result: {
          externalAgent: {
            engine: "opencode",
            version: 1,
            truncated: false,
            steps: [],
            files: [{ path: "src/retry.ts" }],
          },
        },
      },
    ];
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([recorded])} />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("OpenCode report");
    expect(container.textContent).toContain("1 reported file");
    expect(container.textContent).toContain("Reported files");
  });

  it("opens a Gateway-recorded artifact from its turn", async () => {
    const recorded = turn("artifact-turn", true);
    recorded.generatedArtifacts = [
      {
        artifactId: "artifact-1",
        kind: "code",
        title: "Saved patch",
        sourceSurface: "code",
        version: 2,
        createdAt: "2026-09-28T00:00:00Z",
      },
    ];
    const onOpenGeneratedArtifact = vi.fn();
    const onOpenArtifact = vi.fn();
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{ ...sessionProps([recorded]), onOpenGeneratedArtifact }}
            onOpenArtifact={onOpenArtifact}
          />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Saved artifacts");
    expect(container.textContent).toContain("Version 2");
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Saved patch")?.click(),
    );
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact-turn", "artifact-1");
    expect(onOpenGeneratedArtifact).not.toHaveBeenCalled();
  });
});

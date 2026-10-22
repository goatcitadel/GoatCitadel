// @vitest-environment happy-dom
import { act, type ComponentType, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
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
  virtualMounts: 0,
  virtualDataCount: 0,
  initialIndex: 0,
}));

vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: vi.fn().mockResolvedValue(null),
  fetchApprovalReplay: vi.fn().mockRejectedValue(new Error("No replay fixture")),
}));
// Approval follow-on reads the lifecycle owner beside the replay; keep it off the network.
vi.mock("@goatcitadel/mission-control-shared/api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/sessions")>()),
  fetchRuntimeLifecycle: vi.fn().mockRejectedValue(new Error("No lifecycle fixture")),
}));

vi.mock("@goatcitadel/mission-control-shared/api/sessions", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRuntimeLifecycle: vi.fn().mockResolvedValue({ canonical: {}, turns: [] }),
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
    initialTopMostItemIndex,
  }: {
    data: ChatThreadTurnRecord[];
    itemContent: (index: number, turn: ChatThreadTurnRecord) => ReactNode;
    components: {
      Footer?: ComponentType<{ context?: unknown }>;
      EmptyPlaceholder?: ComponentType<{ context?: unknown }>;
    };
    context?: unknown;
    computeItemKey?: (index: number, turn: ChatThreadTurnRecord) => string;
    followOutput?: boolean | string | ((atBottom: boolean) => boolean | string);
    scrollerRef?: Ref<HTMLDivElement>;
    initialTopMostItemIndex?: number;
  }) => {
    viewport.virtualMounts++;
    viewport.virtualDataCount = data.length;
    viewport.initialIndex = initialTopMostItemIndex ?? 0;
    const Footer = components.Footer;
    const EmptyPlaceholder = components.EmptyPlaceholder;
    return (
      <div
        ref={scrollerRef}
        data-virtuoso-scroller="true"
        data-follow-output={String(typeof followOutput === "function" ? followOutput(true) : followOutput)}
      >
        {data.slice(viewport.initialIndex, viewport.initialIndex + 10).map((turn, index) => (
          <div key={computeItemKey?.(index, turn) ?? index}>{itemContent(index, turn)}</div>
        ))}
        {!data.length && EmptyPlaceholder ? <EmptyPlaceholder context={context} /> : null}
        {Footer ? <Footer context={context} /> : null}
      </div>
    );
  },
}));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
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
    draft: "",
    onDraftChange: vi.fn(),
    loading: false,
    historicalReadOnly: false,
    sending: false,
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
  viewport.virtualMounts = 0;
  viewport.virtualDataCount = 0;
  viewport.initialIndex = 0;
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
  localStorage.removeItem("goatcitadel.ui.technical_details.v1");
});

describe("ChatTranscript", () => {
  it("hydrates missing approval risk from the matching pending canonical record", async () => {
    const onApprovePending = vi.fn();
    vi.mocked(fetchApproval).mockResolvedValueOnce({
      preview: { targets: ["/workspace/fixture.txt"] },
      payload: {},
      createdAt: "2026-10-01T00:00:00Z",
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
      await import("./ChatApprovalRendererBody");
    });
    await vi.waitFor(() => {
      const allow = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve once");
      expect(allow).toBeDefined();
      expect(allow!.disabled).toBe(false);
    });
    const allow = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve once");
    expect(allow).toBeDefined();
    expect(allow!.disabled).toBe(false);
    expect(onApprovePending).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain(
      record?.status === "approved" ? "Decision recorded" : "The approval record wasn’t found",
    );
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
  it("moves outer Home instantly through the shared reading owner despite measured height growth", async () => {
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const onBottomStateChange = vi.fn();
    const recorded = turn("boundary-home", true);
    const render = async (followOutput: boolean) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={{ ...sessionProps([recorded]), followOutput, onBottomStateChange }} />
          </InspectorProvider>,
        ),
      );
    await render(true);
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    const scrollIntoView = vi.fn();
    container.querySelector<HTMLElement>('div[aria-hidden="true"].h-px')!.scrollIntoView = scrollIntoView;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    scrollIntoView.mockClear();
    onBottomStateChange.mockClear();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scroller.focus();
    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(home));
    expect(home.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(0);
    expect(document.activeElement).toBe(scroller);
    expect(onBottomStateChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    viewport.preview = { turnId: recorded.turnId, visibleText: "New output while reading the start" };
    await render(false);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("uses the shared End action to pin the outer transcript and clear unread messages", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const onBottomStateChange = vi.fn();
    const first = turn("boundary-end-first", true);
    const render = async (turns: ChatThreadTurnRecord[]) =>
      act(async () =>
        renderWithProviders(
          <InspectorProvider>
            <ChatTranscript props={{ ...sessionProps(turns), followOutput: false, onBottomStateChange }} />
          </InspectorProvider>,
        ),
      );
    await render([first]);
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await render([first, turn("boundary-end-second", true)]);
    expect(container.textContent).toContain("2 new messages");
    const scrollIntoView = vi.fn(() => {
      scroller.scrollTop = 800;
    });
    container.querySelector<HTMLElement>('div[aria-hidden="true"].h-px')!.scrollIntoView = scrollIntoView;
    onBottomStateChange.mockClear();
    scroller.focus();
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(end));
    expect(end.defaultPrevented).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "end", behavior: "auto" });
    expect(scroller.scrollTop).toBe(800);
    expect(document.activeElement).toBe(scroller);
    expect(onBottomStateChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(container.textContent).not.toContain("new messages");
  });

  it.each(["Home", "End"])("preserves descendant pending-question %s behavior, draft and focus", async (key) => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const onBottomStateChange = vi.fn(),
      onSubmitUserInput = vi.fn();
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{
              ...sessionProps([turn("boundary-question", true)]),
              followOutput: false,
              onBottomStateChange,
              pendingUserInput: {
                promptId: "boundary-question",
                turnId: "boundary-question",
                kind: "text",
                title: "Note",
                question: "What should be retained?",
                required: true,
              },
              userInputPending: false,
              onSubmitUserInput,
            }}
          />
        </InspectorProvider>,
      ),
    );
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 350 },
    });
    const input = container.querySelector<HTMLInputElement>('form[aria-label="Pending question"] input[type="text"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Retain this answer");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.focus();
    input.setSelectionRange(6, 6);
    const scrollIntoView = vi.fn();
    container.querySelector<HTMLElement>('div[aria-hidden="true"].h-px')!.scrollIntoView = scrollIntoView;
    onBottomStateChange.mockClear();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Retain this answer");
    expect(input.selectionStart).toBe(6);
    expect(scroller.scrollTop).toBe(350);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onBottomStateChange).not.toHaveBeenCalled();
    expect(onSubmitUserInput).not.toHaveBeenCalled();
  });

  it.each(
    ["Home", "End"].flatMap((key) =>
      ["altKey", "ctrlKey", "metaKey", "shiftKey"].map((modifier) => ({ key, modifier })),
    ),
  )("preserves modified outer $modifier+$key browser behavior", async ({ key, modifier }) => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const onBottomStateChange = vi.fn();
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{ ...sessionProps([turn("modified-boundary", true)]), followOutput: false, onBottomStateChange }}
          />
        </InspectorProvider>,
      ),
    );
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 350 },
    });
    const scrollIntoView = vi.fn();
    container.querySelector<HTMLElement>('div[aria-hidden="true"].h-px')!.scrollIntoView = scrollIntoView;
    onBottomStateChange.mockClear();
    scroller.focus();
    const event = new KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(350);
    expect(document.activeElement).toBe(scroller);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onBottomStateChange).not.toHaveBeenCalled();
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
    expect(container.querySelector('[data-follow-output="false"]')).not.toBeNull();
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
    // CH-31: the button reads "Copied" briefly after the first copy; it is the same copy action.
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy answer" || button.textContent === "Copied")!
        .click(),
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
    const canonical = {
      ...approval,
      status: "pending",
      preview: { targets: ["/workspace/reviewed.txt"] },
      payload: {},
      createdAt: "2026-10-01T00:00:00Z",
      explanationStatus: "not_requested",
    };
    vi.mocked(fetchApproval).mockResolvedValue(canonical as never);
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
    await vi.waitFor(() => {
      const review = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Review danger approval",
      );
      expect(review).toBeDefined();
      expect(review!.disabled).toBe(false);
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Review danger approval")!
        .click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render({
      ...props,
      pendingApproval: { ...approval },
      notices: [{ id: "refresh", tone: "success", content: "Fresh observation", timestamp: "2026-10-01T00:00:00Z" }],
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onApprovePending).not.toHaveBeenCalled();
    await act(async () => {
      client.setQueryData(["approvals", "record", "default", approval.approvalId], {
        ...canonical,
        preview: { targets: ["/workspace/different.txt"] },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
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
    expect(container.querySelector('[aria-label="Latest conversation update"]')).not.toBeNull();
    expect(container.textContent).toContain("Queued a code helper run for this snippet.");
  });

  it("shows only the selected branch and opens recorded turn details", async () => {
    const onInspectTurn = vi.fn();
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={sessionProps([turn("visible", true), turn("hidden", false)])}
            onInspectTurn={onInspectTurn}
          />
          <InspectorPanel />
        </InspectorProvider>,
      ),
    );
    expect(container.textContent).toContain("Assistant visible");
    expect(container.textContent).not.toContain("Assistant hidden");
    const receipt = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.endsWith(" · Open message details"),
    );
    // The receipt's accessible name starts with its visible model, cost and timing text.
    expect(receipt?.hasAttribute("aria-label")).toBe(false);
    expect(receipt?.textContent).toMatch(/^.+ · Cost .+ · Open message details$/);
    await act(async () => receipt?.click());
    // The receipt opens the Chat inspector's Message tab for this turn.
    expect(onInspectTurn).toHaveBeenCalledWith("visible");
  });

  it("each turn has an sr-only heading", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([turn("one", true), turn("two", true)])} />
        </InspectorProvider>,
      ),
    );
    for (const article of container.querySelectorAll("article[data-turn-id]")) {
      const headings = [...article.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.textContent)).toEqual(["You said", "Assistant reply"]);
      expect(headings.every((heading) => heading.classList.contains("sr-only"))).toBe(true);
    }
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
    // The recovery sentence names only the controls that exist below the message (no Retry here).
    expect(container.textContent).toContain("Use Run details under More, below this message.");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
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

  it("keeps per-turn progress notes as plain text beside the single transcript live region", async () => {
    const pending = turn("pending", true, "failed");
    pending.trace.status = "running";
    pending.trace.failure = undefined;
    const cancelled = turn("cancelled", true, "failed");
    cancelled.trace.status = "cancelled";
    cancelled.trace.failure = undefined;
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript
            props={{ ...sessionProps([cancelled, pending]), hasActiveStream: true, activeStreamingTurnId: "pending" }}
          />
        </InspectorProvider>,
      ),
    );
    const notes = [...container.querySelectorAll("p")].filter((node) =>
      ["Preparing response…", "Cancelled"].includes(node.textContent ?? ""),
    );
    expect(notes.map((node) => node.textContent)).toEqual(["Cancelled", "Preparing response…"]);
    for (const note of notes) expect(note.hasAttribute("role")).toBe(false);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("explains an empty thread without inventing a message", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([])} />
        </InspectorProvider>,
      ),
    );
    expect(container.querySelector('[aria-label="Conversation starters"]')).not.toBeNull();
    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(0);
  });

  it("names each turn by its position and the start of its prompt", async () => {
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([turn("one", true), turn("two", true)])} />
        </InspectorProvider>,
      ),
    );
    const names = [...container.querySelectorAll("article[data-turn-id]")].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Message 1: User one", "Message 2: User two"]);
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
    await act(async () => {
      await vi.dynamicImportSettled();
    });
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
    expect(container.textContent).toContain("Background run");
    await act(async () =>
      container
        .querySelector('button[aria-label="More message actions"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await vi.waitFor(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent === "Run details",
      );
      expect(item).toBeInstanceOf(HTMLElement);
      expect(item?.getAttribute("data-disabled")).toBeNull();
    });
    await act(async () =>
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent === "Run details")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
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
    await act(async () => {
      await vi.dynamicImportSettled();
    });
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

it.each(["Partial answer retained", ""])(
  "shows one canonical recovery recommendation for interrupted content %j",
  async (content) => {
    const item = turn("partial", true, "failed");
    item.trace.status = "partial";
    item.trace.failure = { failureClass: "unknown", recommendedAction: "retry" } as never;
    if (content) item.assistantMessage = { content } as never;
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps([item])} />
        </InspectorProvider>,
      ),
    );
    const recovery = container.querySelectorAll('[aria-label="Response recovery"]');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.textContent).toContain("Run the same turn again once.");
    if (content) expect(container.textContent).toContain(content);
    expect(recovery[0]?.getAttribute("role")).not.toBe("alert");
  },
);
it("keeps unresolved warnings visible while only routine updates fold into history", async () => {
  const input = sessionProps([]);
  input.notices = [
    { id: "warning", tone: "warning", content: "Action blocked by policy", timestamp: "2026-10-06T00:00:00Z" },
    { id: "info", tone: "neutral", content: "Routine update", timestamp: "2026-10-06T00:01:00Z" },
    { id: "success", tone: "success", content: "A different action succeeded", timestamp: "2026-10-06T00:02:00Z" },
  ];
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={input} />
      </InspectorProvider>,
    ),
  );
  expect(container.querySelector('[aria-label="Conversation warning"]')?.textContent).toBe(
    "Warning: Action blocked by policy",
  );
  expect(container.querySelector('[aria-label="Conversation warning"]')?.closest("details")).toBeNull();
  expect(container.querySelector('[aria-label="Latest conversation update"]')?.textContent).toBe(
    "A different action succeeded",
  );
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={{ ...input, selectedSessionId: "other", notices: [] }} />
      </InspectorProvider>,
    ),
  );
  expect(container.querySelector('[aria-label="Conversation warning"]')).toBeNull();
});
it("counts a new assistant message within an existing turn once, excluding tokens and tool changes", async () => {
  const item = turn("running", true, "failed");
  item.trace.status = "running";
  const render = (entry: ChatThreadTurnRecord, followOutput: boolean) =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={{ ...sessionProps([entry]), followOutput }} />
      </InspectorProvider>,
    );
  await act(async () => render(item, true));
  await act(async () => render(item, false));
  viewport.preview = { turnId: item.turnId, visibleText: "A" };
  await act(async () => render(item, false));
  expect(container.textContent).toContain("1 new message");
  viewport.preview = { turnId: item.turnId, visibleText: "A longer answer" };
  await act(async () => render({ ...item, toolRuns: [{} as never] }, false));
  expect(container.textContent).toContain("1 new message");
  await act(async () => render({ ...item, assistantMessage: { content: "A longer answer" } as never }, false));
  expect(container.textContent).toContain("1 new message");
});

it("names transcript regions and makes the historical viewport keyboard focusable without live announcements", async () => {
  const props = sessionProps([turn("one", true, "failed")]);
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={props} />
      </InspectorProvider>,
    ),
  );
  const messages = container.querySelector('[aria-label="Messages"]');
  expect(messages?.getAttribute("role")).toBe("region");
  expect(messages?.hasAttribute("aria-live")).toBe(false);
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={{ ...props, historicalWindow: { anchor: { state: "found" }, items: [] } as never }} />
      </InspectorProvider>,
    ),
  );
  const history = container.querySelector('[aria-label="Historical messages"]') as HTMLElement;
  expect(history?.getAttribute("role")).toBe("region");
  expect(history?.tabIndex).toBe(0);
  history.focus();
  expect(document.activeElement).toBe(history);
  expect(history.className).toContain("focus-visible:outline");
  expect(history.hasAttribute("aria-live")).toBe(false);
});

it("offers starters only after an editable empty conversation has loaded", async () => {
  const props = {
    ...sessionProps([]),
    loading: false,
    historicalReadOnly: false,
    sending: false,
    draft: "",
    onDraftChange: vi.fn(),
  };
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={props} />
      </InspectorProvider>,
    ),
  );
  expect(container.textContent).toContain("Explain this project");
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={{ ...props, loading: true }} />
      </InspectorProvider>,
    ),
  );
  expect(container.textContent).not.toContain("Explain this project");
});

function NoticePreferenceToggle() {
  const { setShowTechnicalDetails } = useUiPreferences();
  return (
    <button type="button" onClick={() => setShowTechnicalDetails(false)}>
      Hide notice identifiers
    </button>
  );
}

it.each(["neutral", "warning"] as const)(
  "keeps %s notice targets visible and record IDs under technical disclosure",
  async (tone) => {
    localStorage.setItem("goatcitadel.ui.technical_details.v1", "true");
    const props = {
      ...sessionProps([]),
      notices: [
        {
          id: "run-notice",
          tone,
          content: "Research is waiting for approval with one child item.",
          timestamp: "2026-10-01T00:00:00Z",
          technicalDetails: [{ label: "Run ID", value: "run-private-identifier" }],
        },
      ],
    };
    await act(async () =>
      renderWithProviders(
        <UiPreferencesProvider>
          <NoticePreferenceToggle />
          <InspectorProvider>
            <ChatTranscript props={props} />
          </InspectorProvider>
        </UiPreferencesProvider>,
      ),
    );
    const notice = container.querySelector(
      tone === "warning" ? '[aria-label="Conversation warning"]' : '[aria-label="Latest conversation update"]',
    )!;
    expect(notice.textContent).toContain("Research is waiting for approval with one child item.");
    const details = notice.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details.textContent).toContain("Run ID");
    expect(details.textContent).toContain("run-private-identifier");
    const primary = notice.cloneNode(true) as HTMLElement;
    primary.querySelector("details")!.remove();
    expect(primary.textContent).not.toContain("run-private-identifier");
    details.open = true;
    await act(async () =>
      renderWithProviders(
        <UiPreferencesProvider>
          <NoticePreferenceToggle />
          <InspectorProvider>
            <ChatTranscript props={{ ...props, selectedSessionId: "other" }} />
          </InspectorProvider>
        </UiPreferencesProvider>,
      ),
    );
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Hide notice identifiers")!
        .click(),
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Research is waiting for approval with one child item.");
  },
);

it.each([0, 1, 99, 100])(
  "shows %s selected-path turns in the plain transcript without mounting optional virtualization",
  async (count) => {
    const records = Array.from({ length: count }, (_, index) => turn("plain-" + index, true));
    await act(async () =>
      renderWithProviders(
        <InspectorProvider>
          <ChatTranscript props={sessionProps(records)} />
        </InspectorProvider>,
      ),
    );
    expect(viewport.virtualMounts).toBe(0);
    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(count);
    expect(container.querySelector("[data-virtuoso-scroller]")).toBeNull();
    expect(container.querySelector('[data-follow-output="false"]')?.className).toContain("overflow-y-auto");
  },
);
it("hands all 1000 canonical turns to optional virtualization and starts a pinned conversation at its actual tail", async () => {
  const records = Array.from({ length: 1000 }, (_, index) => turn("long-" + index, true));
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={sessionProps(records)} />
      </InspectorProvider>,
    ),
  );
  await act(async () => {
    await import("react-virtuoso");
  });
  expect(viewport.virtualDataCount).toBe(1000);
  expect(viewport.initialIndex).toBe(999);
  expect(container.querySelectorAll("[data-turn-id]").length).toBeLessThan(100);
  expect(container.textContent).toContain("Assistant long-999");
  expect(container.querySelector('[data-follow-output="false"]')).not.toBeNull();
});
it("preserves the reader's disclosure, focus and scroll anchor when a short transcript grows into a virtual viewport", async () => {
  const records = Array.from({ length: 1000 }, (_, index) => turn("anchor-" + index, true));
  records[99]!.toolRuns = [
    {
      toolRunId: "retained-tool",
      turnId: records[99]!.turnId,
      sessionId: "session-1",
      toolName: "session.status",
      status: "blocked",
      error: "Denied by policy",
    } as never,
  ];
  const render = (count: number) =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={{ ...sessionProps(records.slice(0, count)), followOutput: false }} />
      </InspectorProvider>,
    );
  await act(async () => render(100));
  const oldRow = container.querySelector<HTMLElement>('[data-turn-id="anchor-99"]')!;
  const disclosure = oldRow.querySelector<HTMLDetailsElement>('details[aria-label="Tool activity for this turn"]')!;
  disclosure.open = true;
  disclosure.querySelector("summary")!.focus();
  const oldScroller = container.querySelector<HTMLElement>('[data-follow-output="false"]')!;
  oldScroller.scrollTop = 123;
  vi.spyOn(oldRow, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 50 } as DOMRect);
  await act(async () => render(1000));
  await act(async () => {
    await import("react-virtuoso");
  });
  expect(viewport.initialIndex).toBe(99);
  expect(viewport.virtualDataCount).toBe(1000);
  const newDisclosure = container.querySelector<HTMLDetailsElement>(
    '[data-turn-id="anchor-99"] details[aria-label="Tool activity for this turn"]',
  )!;
  expect(newDisclosure.open).toBe(true);
  expect(document.activeElement).toBe(newDisclosure.querySelector("summary"));
  expect(container.querySelector<HTMLElement>("[data-transcript-scroller]")!.scrollTop).toBe(123);
});

it("tells a failure from a warning and a critical notice from a warning without relying on colour", async () => {
  const failed = turn("failed-plain", true, "failed");
  failed.trace.failure = { failureClass: "provider_timeout", recommendedAction: "retry" } as never;
  failed.userMessage.attachments = [
    { attachmentId: "a1", fileName: "brief.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
  ] as never;
  const input = sessionProps([failed]);
  input.notices = [
    { id: "warn", tone: "warning", content: "Tool output was trimmed", timestamp: "2026-10-06T00:00:00Z" },
    { id: "crit", tone: "critical", content: "Policy stopped the run", timestamp: "2026-10-06T00:01:00Z" },
  ];
  await act(async () =>
    renderWithProviders(
      <InspectorProvider>
        <ChatTranscript props={input} />
      </InspectorProvider>,
    ),
  );
  const recovery = container.querySelector('[aria-label="Response recovery"]')!;
  expect(recovery.className).toContain("border-status-failed");
  expect(recovery.textContent).toContain("Cause: the model provider timed out.");
  expect(recovery.textContent).not.toContain("provider_timeout");
  expect(container.querySelector('[aria-label="Conversation warning"]')?.textContent).toContain("Warning: ");
  expect(container.querySelector('[aria-label="Critical conversation notice"]')?.textContent).toContain(
    "Critical: Policy stopped the run",
  );
  const attachments = container.querySelector('[aria-label="Sent attachments"]')!.textContent;
  expect(attachments).toContain("brief.pdf · PDF");
  expect(attachments).not.toContain("application/pdf");
});

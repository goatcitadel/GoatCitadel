// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord, ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refuseNetwork } from "../../../test/refuse-network";
let InspectorProvider: typeof import("../../app/inspector").InspectorProvider;

const loader = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  fullCount: 0,
  customParent: null as HTMLElement | null,
}));
const preview = vi.hoisted(() => ({ value: null as { turnId: string; visibleText: string } | null }));
const mutations = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: vi.fn().mockResolvedValue({
    approvalId: "retained-approval",
    kind: "tool_invoke",
    riskLevel: "nuclear",
    status: "pending",
    preview: { targets: ["/workspace/reviewed.txt"] },
    payload: {},
    createdAt: "2026-10-01T00:00:00Z",
  }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  resolveApproval: mutations.resolve,
}));
vi.mock("@goatcitadel/mission-control-shared/api/sessions", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/sessions")>()),
  fetchRuntimeLifecycle: vi.fn().mockResolvedValue({ canonical: {}, turns: [] }),
}));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => preview.value,
}));
// Approval reviews name workspaces from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/workspaces")>()),
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
refuseNetwork();

let Transcript: typeof import("./ChatTranscript").ChatTranscript;
let root: Root, host: HTMLDivElement, client: QueryClient;
let release: () => void;
function record(index: number): ChatThreadTurnRecord {
  return {
    turnId: "record-" + index,
    userMessage: { messageId: "user-" + index, content: "Question " + index },
    assistantMessage: { content: "Answer " + index },
    trace: { status: "completed", model: "fixture/model" },
    branch: { isSelectedPath: true },
    toolRuns: [],
    citations: [],
  } as unknown as ChatThreadTurnRecord;
}
const records = Array.from({ length: 1000 }, (_, index) => record(index));
function props(
  count: number,
  extra: Partial<MissionThreadedActiveSessionSurfaceProps> = {},
): MissionThreadedActiveSessionSurfaceProps {
  return {
    selectedSessionId: "session-retained",
    workspaceId: "default",
    draft: "",
    onDraftChange: vi.fn(),
    loading: false,
    historicalReadOnly: false,
    sending: false,
    followOutput: false,
    hasActiveStream: false,
    thread: { sessionId: "session-retained", turns: records.slice(0, count) },
    onRefreshThread: vi.fn(),
    ...extra,
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
}
function render(next: MissionThreadedActiveSessionSurfaceProps) {
  root.render(
    <QueryClientProvider client={client}>
      <InspectorProvider>
        <Transcript props={next} />
      </InspectorProvider>
    </QueryClientProvider>,
  );
}
function factory() {
  return {
    Virtuoso: ({
      data,
      itemContent,
      initialTopMostItemIndex,
      customScrollParent,
    }: {
      data: ChatThreadTurnRecord[];
      itemContent: (index: number, turn: ChatThreadTurnRecord) => ReactNode;
      initialTopMostItemIndex?: number;
      customScrollParent?: HTMLElement;
    }) => {
      loader.fullCount = data.length;
      loader.customParent = customScrollParent ?? null;
      const start = initialTopMostItemIndex ?? 0;
      return (
        <div data-loaded-rows>
          {data.slice(start, start + 10).map((item, index) => (
            <div key={item.turnId}>{itemContent(start + index, item)}</div>
          ))}
        </div>
      );
    },
  };
}
beforeEach(async () => {
  vi.resetModules();
  mutations.resolve.mockReset();
  preview.value = null;
  loader.fullCount = 0;
  loader.customParent = null;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  loader.load.mockReset().mockImplementation(() => gate);
  vi.doMock("react-virtuoso", async () => {
    await loader.load();
    return factory();
  });
  Transcript = (await import("./ChatTranscript")).ChatTranscript;
  InspectorProvider = (await import("../../app/inspector")).InspectorProvider;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  release();
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function finishLoad() {
  await act(async () => release());
  await vi.waitFor(() => expect(host.querySelector("[data-loaded-rows]")).not.toBeNull());
}
function setText(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it.each(["text", "single_select"] as const)(
  "keeps the exact %s question control, answer and focus through delayed windowing in both directions",
  async (kind) => {
    const prompt: ChatUserInputPromptRecord = {
      promptId: "retained-question",
      turnId: "record-999",
      kind,
      title: "Choose",
      question: "Which path?",
      required: true,
      options: [
        { optionId: "first", label: "First", description: "Use the first path" },
        { optionId: "second", label: "Second", description: "Use the second path" },
      ],
    };
    const submit = vi.fn();
    const extra = { pendingUserInput: prompt, userInputPending: false, onSubmitUserInput: submit };
    await act(async () => render(props(100, extra)));
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Pending question"]')!;
    const field = form.querySelector<HTMLInputElement>(
      kind === "text" ? 'input[type="text"]' : 'input[value="second"]',
    )!;
    await act(async () => {
      if (kind === "text") setText(field, "retain this answer");
      else field.click();
    });
    field.focus();
    const scroller = host.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    await act(async () => render(props(1000, extra)));
    expect(host.querySelectorAll("[data-turn-id]")).toHaveLength(100);
    expect(loader.fullCount).toBe(0);
    expect(host.querySelector("form")).toBe(form);
    await finishLoad();
    expect(loader.fullCount).toBe(1000);
    expect(loader.customParent).toBe(scroller);
    expect(host.querySelector("form")).toBe(form);
    expect(form.querySelector(kind === "text" ? 'input[type="text"]' : 'input[value="second"]')).toBe(field);
    expect(kind === "text" ? field.value : field.checked).toBe(kind === "text" ? "retain this answer" : true);
    expect(document.activeElement).toBe(field);
    expect(submit).not.toHaveBeenCalled();
    expect(mutations.resolve).not.toHaveBeenCalled();
    await act(async () => render(props(100, extra)));
    expect(host.querySelector("[data-loaded-rows]")).toBeNull();
    expect(host.querySelector("form")).toBe(form);
    expect(document.activeElement).toBe(field);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      kind === "text" ? { kind: "text", text: "retain this answer" } : { kind: "single_select", optionId: "second" },
    );
  },
);

it("keeps an open critical approval review, typed confirmation and focus through delayed windowing; Cancel makes no mutation", async () => {
  const extra = {
    pendingApproval: {
      approvalId: "retained-approval",
      kind: "tool_invoke",
      riskLevel: "nuclear" as const,
      toolName: "write_file",
    },
    approvalPending: false,
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
  };
  await act(async () => render(props(100, extra)));
  await act(async () => {
    await import("./ChatApprovalRendererBody");
  });
  await vi.waitFor(() => {
    const review = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Review nuclear approval",
    );
    expect(review).toBeInstanceOf(HTMLButtonElement);
    expect(review?.disabled).toBe(false);
  });
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Review nuclear approval")!.click(),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')!;
  expect(dialog).not.toBeNull();
  const field = dialog.querySelector<HTMLInputElement>("input")!;
  await act(async () => setText(field, "approve"));
  field.focus();
  await act(async () => render(props(1000, extra)));
  await finishLoad();
  expect(document.querySelector('[role="dialog"][data-state="open"]')).toBe(dialog);
  expect(dialog.querySelector("input")).toBe(field);
  expect(field.value).toBe("approve");
  expect(document.activeElement).toBe(field);
  expect(mutations.resolve).not.toHaveBeenCalled();
  await act(async () =>
    [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click(),
  );
  expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  expect(mutations.resolve).not.toHaveBeenCalled();
});

it("retains tail streaming, optimistic text and the canonical pending decision outside a bounded reading window after chunk failure", async () => {
  loader.load.mockRejectedValue(new Error("fixture unavailable chunk"));
  preview.value = { turnId: "record-999", visibleText: "Tail response still streaming" };
  const submit = vi.fn();
  const prompt: ChatUserInputPromptRecord = {
    promptId: "tail-decision",
    turnId: "record-999",
    kind: "text",
    title: "Tail decision",
    question: "Continue?",
    required: true,
  };
  await act(async () =>
    render(
      props(1000, {
        hasActiveStream: true,
        activeStreamingTurnId: "record-999",
        optimisticUserMessage: { content: "Unshown canonical question", canonicalMessageId: "user-999" } as never,
        pendingUserInput: prompt,
        userInputPending: false,
        onSubmitUserInput: submit,
      }),
    ),
  );
  expect(host.querySelectorAll("[data-turn-id]")).toHaveLength(100);
  expect(host.querySelector('[data-turn-id="record-999"]')).toBeNull();
  expect(host.textContent).toContain("Tail response still streaming");
  expect(host.textContent).toContain("Unshown canonical question");
  expect(host.textContent).toContain("More messages could not be shown");
  expect(host.querySelector('form[aria-label="Pending question"]')?.textContent).toContain("Continue?");
  // CH-10: the decision is signalled by its own card and the composer line, not by the jump button.
  expect(host.textContent).not.toContain("Decision waiting");
  expect(submit).not.toHaveBeenCalled();
  expect(mutations.resolve).not.toHaveBeenCalled();
  // Pinned fallback displays the actual canonical tail without a duplicate footer preview.
  await act(async () =>
    render(
      props(1000, {
        followOutput: true,
        hasActiveStream: true,
        activeStreamingTurnId: "record-999",
        pendingUserInput: prompt,
        userInputPending: false,
        onSubmitUserInput: submit,
      }),
    ),
  );
  expect(host.querySelectorAll("[data-turn-id]")).toHaveLength(100);
  expect(host.querySelector('[data-turn-id="record-999"]')).not.toBeNull();
  expect(host.textContent?.split("Tail response still streaming")).toHaveLength(2);
  expect(host.querySelector('form[aria-label="Pending question"]')).not.toBeNull();
});

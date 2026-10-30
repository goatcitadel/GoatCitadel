// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord, ChatTurnFailureClass } from "@goatcitadel/contracts";
import { getChatTurnRecoveryAction } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";

vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => null,
}));

function turn(turnId: string, content = `Question ${turnId}`): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, content },
    assistantMessage: { content: `Answer ${turnId}` },
    trace: { status: "completed" },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: true },
  } as unknown as ChatThreadTurnRecord;
}

function failedTurn(failureClass: ChatTurnFailureClass): ChatThreadTurnRecord {
  const item = turn("failed");
  item.assistantMessage = undefined;
  item.trace = {
    status: "failed",
    failure: { failureClass, message: "x", recommendedAction: getChatTurnRecoveryAction(failureClass) },
  } as never;
  return item;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function props(turns: ChatThreadTurnRecord[]) {
  return {
    selectedSessionId: "session-1",
    workspaceId: "default",
    draft: "",
    onDraftChange: vi.fn(),
    loading: false,
    historicalReadOnly: false,
    sending: false,
    thread: { sessionId: "session-1", turns },
    followOutput: true,
    hasActiveStream: false,
    composerRef: { current: null },
    onRefreshThread: vi.fn(),
    onRetryTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
}
function render(node: ReactNode) {
  return act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>{node}</InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);
/** Lays out an element at a fixed vertical span, since happy-dom does no layout. */
function place(element: Element, top: number, bottom: number) {
  element.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
}
const frame = () => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("failure cards", () => {
  it.each([
    ["provider_rate_limited", "The model provider is limiting requests", "Wait a minute"],
    ["context_too_long", "This conversation is too long for the model", "Start a new conversation"],
    ["provider_billing", "The model provider turned this request down", "no credit left"],
  ] as const)("names a %s failure and says what to do", async (failureClass, title, hint) => {
    await render(<ChatTranscript props={props([failedTurn(failureClass)])} onNewConversation={vi.fn()} />);
    const card = container.querySelector('[aria-label="Response recovery"]')!;
    expect(card.getAttribute("data-failure-class")).toBe(failureClass);
    expect(card.textContent).toContain(title);
    expect(card.textContent).toContain(hint);
    expect(card.textContent).not.toContain(failureClass);
  });

  it("offers a new conversation only when the conversation is too long", async () => {
    const onNewConversation = vi.fn();
    await render(
      <ChatTranscript props={props([failedTurn("context_too_long")])} onNewConversation={onNewConversation} />,
    );
    await act(async () => button("Start a new conversation")!.click());
    expect(onNewConversation).toHaveBeenCalledTimes(1);

    await render(
      <ChatTranscript props={props([failedTurn("provider_rate_limited")])} onNewConversation={onNewConversation} />,
    );
    expect(button("Start a new conversation")).toBeUndefined();
  });

  it("points an account refusal at the model providers", async () => {
    await render(<ChatTranscript props={props([failedTurn("provider_billing")])} />);
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "Open model providers");
    expect(link?.getAttribute("href")).toContain("/settings/models");
  });
});

describe("turn rail", () => {
  it("lists every message once there are three, with one tab stop", async () => {
    await render(<ChatTranscript props={props([turn("t1"), turn("t2")])} />);
    expect(container.querySelector("[data-chat-turn-rail]")).toBeNull();

    await render(
      <ChatTranscript props={props([turn("t1"), turn("t2"), turn("t3", "Draft a reply to the landlord")])} />,
    );
    const rail = container.querySelector('nav[aria-label="Messages in this conversation"]')!;
    const ticks = [...rail.querySelectorAll("button")];
    expect(ticks.map((tick) => tick.getAttribute("aria-label"))).toEqual([
      "Message 1: Question t1",
      "Message 2: Question t2",
      "Message 3: Draft a reply to the landlord",
    ]);
    expect(ticks.filter((tick) => tick.tabIndex === 0)).toHaveLength(1);
  });

  it("moves between ticks with the arrow keys and jumps to a message on click", async () => {
    await render(<ChatTranscript props={props([turn("t1"), turn("t2"), turn("t3")])} />);
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    place(scroller, 100, 700);
    const articles = [...container.querySelectorAll("article[data-turn-id]")];
    articles.forEach((article, index) => place(article, 100 + index * 400, 500 + index * 400));
    const ticks = [...container.querySelectorAll<HTMLButtonElement>("[data-chat-turn-rail] button")];
    ticks[0]!.focus();
    await act(async () => {
      ticks[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(ticks[1]);

    scroller.scrollTop = 0;
    await act(async () => ticks[2]!.click());
    expect(scroller.scrollTop).toBe(800);
  });
});

describe("sticky prompt", () => {
  it("shows the question once it scrolls away while its answer is still showing, and jumps back to it", async () => {
    const long = "Summarise the quarterly report and list every risk the auditors raised in plain words";
    await render(<ChatTranscript props={props([turn("t1"), turn("t2", long)])} />);
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller]")!;
    const [first, second] = [...container.querySelectorAll("article[data-turn-id]")];
    place(scroller, 100, 700);
    place(first!, -900, -300);
    place(first!.querySelector("[data-turn-prompt]")!, -880, -800);
    place(second!, -300, 900);
    place(second!.querySelector("[data-turn-prompt]")!, -280, -200);
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await frame();

    const sticky = container.querySelector<HTMLButtonElement>("[data-chat-sticky-prompt]")!;
    expect(sticky.getAttribute("aria-label")).toBe(
      "Back to message 2: Summarise the quarterly report and list every risk the auditors raised in…",
    );
    scroller.scrollTop = 500;
    await act(async () => sticky.click());
    expect(scroller.scrollTop).toBe(100);

    // Back at the question, the bar goes away.
    place(second!, 100, 1300);
    place(second!.querySelector("[data-turn-prompt]")!, 120, 200);
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await frame();
    expect(container.querySelector("[data-chat-sticky-prompt]")).toBeNull();
  });
});

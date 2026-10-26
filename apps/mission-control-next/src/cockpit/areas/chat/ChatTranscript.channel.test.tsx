// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../app/inspector";
import { queryKeys } from "../../data/query-keys";
import { ChatTranscript } from "./ChatTranscript";
import type { ChannelConversationContext } from "./channel-conversation";

const api = vi.hoisted(() => ({ markChatSessionRead: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/chat")>()),
  markChatSessionRead: api.markChatSessionRead,
}));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => null,
}));
vi.mock("../../../features/native-routes/library/WorkflowSkillCaptureControl", () => ({
  WorkflowSkillCaptureControl: () => <p>Capture this as a workflow</p>,
}));

type Authority = "external_channel" | "operator";

function channelTurn(
  turnId: string,
  authority: Authority,
  userAt: string,
  assistantAt: string | null = null,
): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: {
      messageId: `user-${turnId}`,
      content: `User ${turnId}`,
      timestamp: userAt,
      sourceAuthority: authority,
    },
    assistantMessage: assistantAt
      ? { messageId: `assistant-${turnId}`, content: `Assistant ${turnId}`, timestamp: assistantAt }
      : undefined,
    trace: { status: "completed", completion: { status: "complete" } },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: true },
  } as unknown as ChatThreadTurnRecord;
}

const telegram: ChannelConversationContext = {
  sessionId: "session-1",
  connectionId: "conn-1",
  channelLabel: "Telegram",
  title: "You",
  kind: "direct",
  own: true,
  status: "on",
};

let root: Root;
let container: HTMLDivElement;
let composer: HTMLTextAreaElement;
let client: QueryClient;

function props(turns: ChatThreadTurnRecord[], overrides: Partial<MissionThreadedActiveSessionSurfaceProps> = {}) {
  return {
    selectedSessionId: "session-1",
    workspaceId: "default",
    selectedProviderId: null,
    draft: "",
    onDraftChange: vi.fn(),
    loading: false,
    historicalReadOnly: false,
    sending: false,
    thread: { sessionId: "session-1", turns },
    followOutput: true,
    hasActiveStream: false,
    composerRef: { current: composer },
    onRefreshThread: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    ...overrides,
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

/** A fresh visit: the transcript unmounts first, so nothing from the previous one carries over. */
async function remount(node: ReactNode) {
  await act(async () => root.render(null));
  await render(node);
}

function userLabels(): string[] {
  return [...container.querySelectorAll(".cockpit-chat-user-bubble > p")].map((label) => label.textContent ?? "");
}

async function openMoreMenu(article: Element): Promise<string[]> {
  const trigger = article.querySelector<HTMLButtonElement>('button[aria-label="More message actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    trigger.click();
  });
  return vi.waitFor(() => {
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(0);
    return items.map((item) => item.textContent ?? "");
  });
}

beforeEach(() => {
  api.markChatSessionRead.mockReset();
  api.markChatSessionRead.mockResolvedValue({ sessionId: "session-1", lastReadAt: "2026-10-25T10:00:00.000Z" });
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  client.clear();
});

describe("ChatTranscript in a channel conversation", () => {
  it("labels channel and desk messages by where they came from", async () => {
    const turns = [
      channelTurn("phone", "external_channel", "2026-10-25T09:00:00.000Z", "2026-10-25T09:00:05.000Z"),
      channelTurn("desk", "operator", "2026-10-25T09:10:00.000Z", "2026-10-25T09:10:05.000Z"),
    ];
    await render(<ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T10:00:00Z" }} />);
    const [phone, desk] = userLabels();
    expect(phone).toMatch(/^You · via Telegram · \S/);
    expect(desk).toMatch(/^You · from your desk · \S/);
    expect(
      [...container.querySelectorAll("article h2.sr-only")]
        .filter((heading) => heading.textContent?.includes(" said"))
        .map((heading) => heading.textContent),
    ).toEqual(["You said via Telegram", "You said from your desk"]);

    // Someone else's direct conversation names them; the assistant keeps its own label.
    await render(
      <ChatTranscript
        props={props(turns.slice(0, 1))}
        channel={{ ...telegram, own: false, title: "Anna", lastReadAt: "2026-10-25T10:00:00Z" }}
      />,
    );
    expect(userLabels()[0]).toMatch(/^Anna · via Telegram · \S/);
    expect(container.textContent).toContain("Assistant");

    // An ordinary conversation reads as it always did.
    await render(<ChatTranscript props={props(turns.slice(0, 1))} />);
    expect(userLabels()[0]).toMatch(/^You · \S/);
    expect(userLabels()[0]).not.toContain("via");
  });

  it("hides retry and edit on messages that arrived through a channel", async () => {
    const channelMessage = channelTurn(
      "phone",
      "external_channel",
      "2026-10-25T09:00:00.000Z",
      "2026-10-25T09:00:05.000Z",
    );
    const deskMessage = channelTurn("desk", "operator", "2026-10-25T09:10:00.000Z", "2026-10-25T09:10:05.000Z");
    const channel = { ...telegram, lastReadAt: "2026-10-25T10:00:00Z" };
    const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent);

    await render(<ChatTranscript props={props([channelMessage])} channel={channel} />);
    expect(buttons()).not.toContain("Retry");
    expect(container.textContent).not.toContain("Capture this as a workflow");
    const arrived = await openMoreMenu(container.querySelector("article")!);
    expect(arrived).toContain("Run details");
    expect(arrived).not.toContain("Edit and resend");

    // A message sent from the desk stays editable and retryable, with the capture control.
    await render(<ChatTranscript props={props([deskMessage])} channel={channel} />);
    expect(buttons()).toContain("Retry");
    expect(container.textContent).toContain("Capture this as a workflow");
    expect(await openMoreMenu(container.querySelector("article")!)).toContain("Edit and resend");
  });

  it("does not point at Retry in the recovery note of a channel message that failed", async () => {
    const failed = channelTurn("phone", "external_channel", "2026-10-25T09:00:00.000Z");
    failed.trace.status = "failed";
    failed.trace.failure = { retryable: true } as never;
    await render(
      <ChatTranscript props={props([failed])} channel={{ ...telegram, lastReadAt: "2026-10-25T10:00:00Z" }} />,
    );
    const note = container.querySelector('[aria-label="Response recovery"]');
    expect(note?.textContent).toContain("Run details");
    expect(note?.textContent).not.toContain("Use Retry");
  });

  it("marks where the new messages start", async () => {
    const turns = [
      channelTurn("read", "external_channel", "2026-10-25T08:00:00.000Z", "2026-10-25T08:00:05.000Z"),
      channelTurn("fresh-1", "external_channel", "2026-10-25T09:40:00.000Z", "2026-10-25T09:40:05.000Z"),
      channelTurn("fresh-2", "external_channel", "2026-10-25T09:50:00.000Z"),
    ];
    await render(
      <ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T09:00:00.000Z" }} />,
    );
    const dividers = [...container.querySelectorAll("*")].filter(
      (node) => node.textContent?.includes("since you were last here") && node.children.length === 0,
    );
    expect(dividers.map((node) => node.textContent)).toEqual(["2 new since you were last here"]);
    // It sits above the first new message (not the read one, not the second new one) and is plain text, not an
    // announcement.
    const divider = dividers[0]!;
    expect(divider.closest("[aria-live], [role='status'], [role='alert']")).toBeNull();
    const article = (turnId: string) => container.querySelector(`article[data-turn-id="${turnId}"]`)!;
    expect(article("fresh-1").contains(divider)).toBe(true);
    expect(article("read").contains(divider)).toBe(false);
    expect(article("fresh-2").contains(divider)).toBe(false);
    expect(
      divider.compareDocumentPosition(article("fresh-1").querySelector("h2")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Nothing new after the marker, and no marker when no read time is known.
    await remount(
      <ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T09:50:00.000Z" }} />,
    );
    expect(container.textContent).not.toContain("since you were last here");
    await remount(<ChatTranscript props={props(turns)} channel={telegram} />);
    expect(container.textContent).not.toContain("since you were last here");
  });

  it("keeps the marker where it was while the conversation is open and is marked read", async () => {
    const turns = [channelTurn("fresh", "external_channel", "2026-10-25T09:40:00.000Z", "2026-10-25T09:40:05.000Z")];
    await render(
      <ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T09:00:00.000Z" }} />,
    );
    expect(container.textContent).toContain("1 new since you were last here");
    // The overview catches up with the read marker; the divider still says where this visit began.
    await render(
      <ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T09:40:05.000Z" }} />,
    );
    expect(container.textContent).toContain("1 new since you were last here");
  });

  it("marks the conversation read once it is shown", async () => {
    const turns = [
      channelTurn("one", "external_channel", "2026-10-25T09:40:00.000Z", "2026-10-25T09:40:05.000Z"),
      channelTurn("two", "external_channel", "2026-10-25T09:50:00.000Z", "2026-10-25T09:50:07.000Z"),
    ];
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const channel = { ...telegram, lastReadAt: "2026-10-25T09:00:00.000Z" };
    await render(<ChatTranscript props={props(turns)} channel={channel} />);
    expect(api.markChatSessionRead).toHaveBeenCalledOnce();
    expect(api.markChatSessionRead).toHaveBeenCalledWith("session-1", "2026-10-25T09:50:07.000Z");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatMessaging("default") });

    // The same messages again (a refresh, a new overview object) never ask twice.
    await render(<ChatTranscript props={props(turns)} channel={{ ...channel }} />);
    await render(<ChatTranscript props={props([...turns])} channel={{ ...channel, status: "needs_attention" }} />);
    expect(api.markChatSessionRead).toHaveBeenCalledOnce();

    // A newer message asks once more, with its own time.
    const newer = [...turns, channelTurn("three", "external_channel", "2026-10-25T10:05:00.000Z")];
    await render(<ChatTranscript props={props(newer)} channel={channel} />);
    expect(api.markChatSessionRead).toHaveBeenCalledTimes(2);
    expect(api.markChatSessionRead).toHaveBeenLastCalledWith("session-1", "2026-10-25T10:05:00.000Z");
  });

  it("leaves a conversation alone when it is already read or is not a channel conversation", async () => {
    const turns = [channelTurn("one", "external_channel", "2026-10-25T09:40:00.000Z", "2026-10-25T09:40:05.000Z")];
    await render(
      <ChatTranscript props={props(turns)} channel={{ ...telegram, lastReadAt: "2026-10-25T09:40:05.000Z" }} />,
    );
    await render(<ChatTranscript props={props(turns)} />);
    // Another conversation's thread is not this one's to mark.
    await render(
      <ChatTranscript props={props(turns, { thread: { sessionId: "other", turns } as never })} channel={telegram} />,
    );
    // Nor is it read while a search result's surrounding history is shown in place of the latest messages.
    await render(
      <ChatTranscript props={props(turns, { historicalWindowLoading: true } as never)} channel={telegram} />,
    );
    expect(container.textContent).toContain("Loading the exact historical message");
    expect(api.markChatSessionRead).not.toHaveBeenCalled();
  });

  it("treats a failed read marker as non-fatal: no message, no retry loop", async () => {
    api.markChatSessionRead.mockRejectedValue(new Error("Conversation read markers need an operator identity"));
    const turns = [channelTurn("one", "external_channel", "2026-10-25T09:40:00.000Z", "2026-10-25T09:40:05.000Z")];
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const channel = { ...telegram, lastReadAt: "2026-10-25T09:00:00.000Z" };
    await render(<ChatTranscript props={props(turns)} channel={channel} />);
    await act(async () => {
      await Promise.resolve();
    });
    await render(<ChatTranscript props={props(turns)} channel={{ ...channel }} />);
    await render(<ChatTranscript props={props([...turns])} channel={channel} />);
    expect(api.markChatSessionRead).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("operator identity");
    // Nothing is left over to retry on its own, and a newer message gets its own single attempt.
    await render(
      <ChatTranscript
        props={props([...turns, channelTurn("two", "external_channel", "2026-10-25T10:05:00.000Z")])}
        channel={channel}
      />,
    );
    expect(api.markChatSessionRead).toHaveBeenCalledTimes(2);
  });
});

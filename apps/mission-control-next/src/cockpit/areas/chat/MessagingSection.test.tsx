// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMessagingChannel, ChatMessagingConversation, ChatMessagingOverview } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingSection } from "./MessagingSection";

const api = vi.hoisted(() => ({ fetchChatMessaging: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function conversation(overrides: Partial<ChatMessagingConversation> = {}): ChatMessagingConversation {
  return {
    sessionId: "sess-1",
    title: "Family group",
    kind: "group",
    own: false,
    lastActivityAt: "2026-10-25T10:00:00.000Z",
    ...overrides,
  };
}

function channel(overrides: Partial<ChatMessagingChannel> = {}): ChatMessagingChannel {
  return {
    connectionId: "conn-1",
    channelKey: "telegram",
    label: "Telegram",
    status: "on",
    conversations: [conversation({ newMessageCount: 3 })],
    ...overrides,
  };
}

function overviewOf(channels: ChatMessagingChannel[]): ChatMessagingOverview {
  return { workspaceId: "default", channels };
}

async function mount(
  overview: ChatMessagingOverview,
  props: { selectedSessionId?: string; onSelectSession?: () => void; onOpenChannel?: () => void } = {},
) {
  api.fetchChatMessaging.mockResolvedValue(overview);
  const handlers = { onSelectSession: vi.fn(), onOpenChannel: vi.fn(), ...props };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MessagingSection workspaceId="default" {...handlers} />
      </QueryClientProvider>,
    );
  });
  // Let the query settle and render its data.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return handlers;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`No button contains "${label}"`);
  return found;
}

beforeEach(() => {
  api.fetchChatMessaging.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("MessagingSection", () => {
  it("shows each channel with its status and its conversations under it", async () => {
    await mount(
      overviewOf([
        channel({ conversations: [conversation(), conversation({ sessionId: "sess-2", title: "Ada" })] }),
        channel({
          connectionId: "conn-2",
          channelKey: "slack",
          label: "Slack",
          status: "needs_attention",
          conversations: [],
        }),
      ]),
    );
    expect(api.fetchChatMessaging).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(container.querySelector("h2")?.textContent).toBe("Messaging");
    // One list item per channel, in the order the Gateway sent them; its conversations sit inside it.
    const telegram = button("Telegram").closest("li")!;
    const slack = button("Slack").closest("li")!;
    expect(telegram.nextElementSibling).toBe(slack);
    expect(telegram.textContent).toContain("Telegram");
    expect(telegram.querySelector('[data-tone="done"]')?.textContent).toBe("On");
    expect(telegram.textContent).toContain("Family group");
    expect(telegram.textContent).toContain("Ada");
    expect(slack.textContent).toContain("Slack");
    expect(slack.querySelector('[data-tone="waiting"]')?.textContent).toBe("Needs you");
    expect(slack.textContent).not.toContain("Family group");
    // Each conversation shows when it last had activity.
    expect(telegram.querySelector("time")?.dateTime).toBe("2026-10-25T10:00:00.000Z");
  });

  it("opens the channel page from the channel row", async () => {
    const { onOpenChannel, onSelectSession } = await mount(overviewOf([channel()]));
    await act(async () => button("Telegram").click());
    expect(onOpenChannel).toHaveBeenCalledWith("conn-1");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("selects a conversation", async () => {
    const { onSelectSession, onOpenChannel } = await mount(
      overviewOf([channel({ conversations: [conversation(), conversation({ sessionId: "sess-2", title: "Ada" })] })]),
      { selectedSessionId: "sess-1" },
    );
    expect(button("Family group").getAttribute("aria-current")).toBe("page");
    expect(button("Ada").getAttribute("aria-current")).toBeNull();
    await act(async () => button("Ada").click());
    expect(onSelectSession).toHaveBeenCalledWith("sess-2");
    await act(async () => button("Family group").click());
    expect(onSelectSession).toHaveBeenLastCalledWith("sess-1");
    expect(onOpenChannel).not.toHaveBeenCalled();
  });

  it("shows a new-message count only when it is known", async () => {
    await mount(
      overviewOf([
        channel({
          conversations: [
            conversation({ sessionId: "a", title: "Unknown count", newMessageCount: undefined }),
            conversation({ sessionId: "b", title: "One new", newMessageCount: 1 }),
            conversation({ sessionId: "c", title: "Three new", newMessageCount: 3 }),
            conversation({ sessionId: "d", title: "Nothing new", newMessageCount: 0 }),
            conversation({ sessionId: "e", title: "Very busy", newMessageCount: 150 }),
          ],
        }),
      ]),
    );
    // Missing is not zero: a conversation without a known count shows none.
    expect(button("Unknown count").textContent).not.toMatch(/new message/);
    expect(button("One new").textContent).toContain("1 new message");
    expect(button("One new").textContent).not.toContain("1 new messages");
    expect(button("Three new").textContent).toContain("3 new messages");
    // A known zero says nothing new has arrived, so there is no badge to show either.
    expect(button("Nothing new").textContent).not.toMatch(/new message/);
    // A busy conversation reads "99+", and assistive technology hears the full phrase.
    const busy = button("Very busy");
    expect(busy.textContent).toContain("99+");
    expect(busy.textContent).toContain("More than 99 new messages");
    expect(busy.textContent).not.toContain("150");
  });

  it("offers to add a channel when there are none", async () => {
    await mount(overviewOf([]));
    expect(container.textContent).toContain("No channels yet");
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/settings/connections"]')];
    // The heading's Add link and the empty state's link go to the same place.
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/#channels$/);
      expect(link.getAttribute("aria-label")).toBe("Add a channel");
      expect(link.textContent).toContain("Add");
      expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("keeps the Add link and says what happened when channels cannot be read", async () => {
    api.fetchChatMessaging.mockRejectedValue(new Error("offline"));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MessagingSection workspaceId="default" onSelectSession={vi.fn()} onOpenChannel={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Couldn't load your channels");
    expect(container.textContent).not.toContain("No channels yet");
    expect(container.querySelector('a[href^="/settings/connections"]')).not.toBeNull();
    api.fetchChatMessaging.mockResolvedValue(overviewOf([channel()]));
    await act(async () => button("Try again").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Telegram");
  });

  it("adds no live regions", async () => {
    await mount(overviewOf([channel()]));
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  WHATSAPP_REPLY_WINDOW_CLOSED,
  type ChatMessagingOverview,
  type ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeChannelConversation, type ChannelConversationContext } from "./channel-conversation";
import {
  channelCheckBlock,
  channelFilesBlock,
  channelReplyBlock,
  channelReplyPlaceholder,
  channelReplySubmitLabel,
  describeChannelReply,
  type ChannelReply,
} from "./channel-composer";
import { useChannelComposerProps } from "./use-channel-composer";

const api = vi.hoisted(() => ({ fetchChatMessaging: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));

function channelContext(overrides: Partial<ChannelConversationContext> = {}): ChannelConversationContext {
  return {
    sessionId: "channel-1",
    connectionId: "conn-1",
    channelKey: "telegram",
    channelLabel: "Telegram",
    title: "Maya",
    kind: "direct",
    own: false,
    status: "on",
    tracksReading: true,
    ...overrides,
  };
}

const NOW = new Date("2026-10-29T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

const post: ChannelReply = { mode: "post", channelLabel: "Telegram", targetTitle: "Maya", status: "on" };
const ask: ChannelReply = { mode: "ask", channelLabel: "Telegram", targetTitle: "You", status: "on" };

describe("describeChannelReply", () => {
  it("asks GoatCitadel in the operator's own direct conversation", () => {
    expect(describeChannelReply(channelContext({ own: true, title: "You" }))).toEqual({
      mode: "ask",
      channelLabel: "Telegram",
      targetTitle: "You",
      status: "on",
    });
  });

  it("posts in someone else's direct conversation and in a group", () => {
    expect(describeChannelReply(channelContext())?.mode).toBe("post");
    expect(describeChannelReply(channelContext({ kind: "group", title: "Family group" }))).toEqual({
      mode: "post",
      channelLabel: "Telegram",
      targetTitle: "Family group",
      status: "on",
    });
  });

  it("carries the channel's status and says nothing for a mission chat", () => {
    expect(describeChannelReply(channelContext({ status: "needs_attention" }))?.status).toBe("needs_attention");
    expect(describeChannelReply(undefined)).toBeUndefined();
  });

  it("carries the channel and the person's last message only once the conversation's turns are known", () => {
    const whatsapp = channelContext({ channelKey: "whatsapp", channelLabel: "WhatsApp" });
    expect(describeChannelReply(whatsapp, { lastInboundAt: "2026-10-28T12:00:00Z" })).toMatchObject({
      replyWindow: { channelKey: "whatsapp", lastInboundAt: "2026-10-28T12:00:00Z" },
    });
    // The turns are known and none is from the person: there is no last message to carry.
    expect(describeChannelReply(whatsapp, { lastInboundAt: undefined })?.replyWindow).toEqual({
      channelKey: "whatsapp",
    });
    // Not known yet (the thread is loading): nothing is claimed about the window.
    expect(describeChannelReply(whatsapp)).not.toHaveProperty("replyWindow");
  });
});

describe("channel reply copy", () => {
  it("names the channel and the person in the placeholder and the submit label", () => {
    expect(channelReplyPlaceholder(ask)).toBe("Ask GoatCitadel. The answer also goes to Telegram.");
    expect(channelReplySubmitLabel(ask)).toBe("Send");
    expect(channelReplyPlaceholder(post)).toBe("Posts to Maya on Telegram as your bot");
    expect(channelReplySubmitLabel(post)).toBe("Post to Maya");
  });

  it("says why a removed or switched-off channel cannot take a reply instead of promising a destination", () => {
    expect(channelReplyPlaceholder({ ...post, status: "removed" })).toBe(
      "This channel was removed. Its conversations stay readable.",
    );
    expect(channelReplyPlaceholder({ ...ask, status: "off" })).toBe("Turn Telegram back on to reply.");
    expect(channelReplySubmitLabel({ ...post, status: "removed" })).toBe("Send");
    expect(channelReplySubmitLabel({ ...post, status: "off" })).toBe("Send");
    // A channel that needs a look can still be tried: the Gateway says so if it cannot deliver.
    expect(channelReplyPlaceholder({ ...post, status: "needs_attention" })).toBe(
      "Posts to Maya on Telegram as your bot",
    );
    expect(channelReplySubmitLabel({ ...post, status: "needs_attention" })).toBe("Post to Maya");
  });

  it.each([
    ["signal", "Signal"],
    ["imessage", "iMessage"],
    ["zalouser", "Zalo personal"],
  ])("offers no way to post through a saved %s connection, which the Gateway reports as removed", (key, label) => {
    // How the Messaging overview lists a retired channel's enabled, connected connection.
    const overview: ChatMessagingOverview = {
      workspaceId: "default",
      channels: [
        {
          connectionId: `conn-${key}`,
          channelKey: key,
          label,
          status: "removed",
          conversations: [
            {
              sessionId: "retired-1",
              title: "Sam",
              kind: "direct",
              own: false,
              lastActivityAt: "2026-10-28T10:00:00Z",
            },
          ],
        },
      ],
    };
    const reply = describeChannelReply(describeChannelConversation("retired-1", overview));
    expect(reply).toMatchObject({ mode: "post", status: "removed" });
    expect(channelReplyBlock(reply)?.kind).toBe("channel-removed");
    expect(channelReplyPlaceholder(reply)).toBe("This channel was removed. Its conversations stay readable.");
    expect(channelReplySubmitLabel(reply)).toBe("Send");
  });

  it("falls back to the ordinary composer copy outside a channel conversation", () => {
    expect(channelReplyPlaceholder(undefined)).toBe("Message GoatCitadel…");
    expect(channelReplySubmitLabel(undefined)).toBe("Send");
  });

  it("says what is happening instead of promising a destination while the channel is unresolved", () => {
    expect(channelReplyPlaceholder(undefined, "checking")).toBe("Checking this channel…");
    expect(channelReplyPlaceholder(undefined, "unavailable")).toBe(
      "Couldn't check this channel. Try again from Messaging.",
    );
  });

  it("blocks only a removed or switched-off channel", () => {
    expect(channelReplyBlock({ ...post, status: "removed" })).toEqual({
      kind: "channel-removed",
      message: "This channel was removed. Its conversations stay readable.",
    });
    expect(channelReplyBlock({ ...post, status: "off" })).toEqual({
      kind: "channel-off",
      message: "Turn Telegram back on to reply.",
    });
    expect(channelReplyBlock({ ...post, status: "on" })).toBeNull();
    expect(channelReplyBlock({ ...post, status: "needs_attention" })).toBeNull();
    expect(channelReplyBlock(undefined)).toBeNull();
  });

  it("blocks a WhatsApp reply once their last message is 24 hours old, in either mode", () => {
    const window = (lastInboundAt: string | undefined) => ({
      replyWindow: { channelKey: "whatsapp", ...(lastInboundAt ? { lastInboundAt } : {}) },
    });
    const closed = { kind: "reply-window-closed", message: WHATSAPP_REPLY_WINDOW_CLOSED };
    for (const reply of [post, ask]) {
      expect(channelReplyBlock({ ...reply, ...window(hoursAgo(25)) }, NOW)).toEqual(closed);
      expect(channelReplyBlock({ ...reply, ...window(hoursAgo(24)) }, NOW)).toEqual(closed);
      expect(channelReplyBlock({ ...reply, ...window(undefined) }, NOW)).toEqual(closed);
      expect(channelReplyBlock({ ...reply, ...window(hoursAgo(1)) }, NOW)).toBeNull();
    }
    // The window is WhatsApp's alone, and a turned-off or removed channel says that first.
    expect(
      channelReplyBlock({ ...post, replyWindow: { channelKey: "telegram", lastInboundAt: hoursAgo(25) } }, NOW),
    ).toBeNull();
    expect(channelReplyBlock({ ...post, status: "off", ...window(hoursAgo(25)) }, NOW)?.kind).toBe("channel-off");
    expect(channelReplyBlock({ ...post, status: "removed", ...window(hoursAgo(25)) }, NOW)?.kind).toBe(
      "channel-removed",
    );
    // A conversation whose turns are not known yet is not blocked on a guess; the Gateway still refuses a late send.
    expect(channelReplyBlock(post, NOW)).toBeNull();
  });

  it("puts the window sentence in the placeholder and keeps the submit label plain", () => {
    // The placeholder and the label read the clock themselves, so this one is dated from it.
    const dayAndAnHourAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const closed = { ...post, replyWindow: { channelKey: "whatsapp", lastInboundAt: dayAndAnHourAgo } };
    expect(channelReplyPlaceholder(closed)).toBe(WHATSAPP_REPLY_WINDOW_CLOSED);
    expect(channelReplySubmitLabel(closed)).toBe("Send");
  });

  it("blocks sending while the channel is being checked or could not be checked", () => {
    expect(channelCheckBlock("checking")).toEqual({ kind: "channel-checking", message: "Checking this channel…" });
    expect(channelCheckBlock("unavailable")).toEqual({
      kind: "channel-unavailable",
      message: "Couldn't check this channel. Try again from Messaging.",
    });
    expect(channelCheckBlock(undefined)).toBeNull();
  });

  it("blocks sending files in a channel conversation, however they got attached", () => {
    expect(channelFilesBlock(post, 1)).toEqual({
      kind: "blocked",
      message: "Files aren't sent in channel conversations. Remove them to send.",
    });
    expect(channelFilesBlock(ask, 2)?.kind).toBe("blocked");
    expect(channelFilesBlock(post, 0)).toBeNull();
    expect(channelFilesBlock(undefined, 3)).toBeNull();
  });
});

describe("useChannelComposerProps", () => {
  const overview: ChatMessagingOverview = {
    workspaceId: "default",
    channels: [
      {
        connectionId: "conn-1",
        channelKey: "telegram",
        label: "Telegram",
        status: "on",
        conversations: [
          { sessionId: "channel-1", title: "Maya", kind: "direct", own: false, lastActivityAt: "2026-10-25T10:00:00Z" },
        ],
      },
    ],
  };
  const held = { scope: "external" as const, channelConnectionId: "conn-1" };
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let seen: Array<ReturnType<typeof useChannelComposerProps<Active>>>;

  type ThreadView = { sessionId: string; turns: readonly ChatThreadTurnRecord[] };
  function activeProps(draft = "hi", thread?: ThreadView | null) {
    return {
      draft,
      thread,
      isDragActive: true,
      onDragEnter: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onComposerPaste: vi.fn(),
    };
  }
  function turnAt(turnId: string, timestamp: string, sourceAuthority: string) {
    return {
      turnId,
      userMessage: { messageId: `user-${turnId}`, timestamp, sourceAuthority },
    } as unknown as ChatThreadTurnRecord;
  }
  type Active = ReturnType<typeof activeProps>;

  function Probe(props: {
    active: Active | null;
    channel?: ChannelConversationContext;
    session?: { scope: "mission" | "external"; channelConnectionId?: string };
  }) {
    seen.push(useChannelComposerProps(props.active, props.channel, "default", props.session));
    return null;
  }

  async function mount(props: React.ComponentProps<typeof Probe>) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe {...props} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    seen = [];
    api.fetchChatMessaging.mockReset();
    api.fetchChatMessaging.mockResolvedValue(overview);
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

  it("hands back the same props object for a mission chat and reads no overview", async () => {
    const active = activeProps();
    await mount({ active, session: { scope: "mission" } });
    expect(seen.at(-1)).toBe(active);
    await mount({ active: null, session: undefined });
    expect(seen.at(-1)).toBeNull();
    expect(api.fetchChatMessaging).not.toHaveBeenCalled();
  });

  it("keeps a mission chat bound to a channel on its own composer, with files and tools", async () => {
    // Binding through the context dock does not make a chat a channel conversation: it still posts through the
    // binding as before, and nothing waits on the Messaging overview.
    const active = activeProps();
    await mount({ active, session: { scope: "mission", channelConnectionId: "conn-1" } });
    expect(seen.at(-1)).toBe(active);
    expect(seen.at(-1)).not.toHaveProperty("channelCheck");
    expect(api.fetchChatMessaging).not.toHaveBeenCalled();
  });

  it("adds the channel reply once and keeps the same object until the channel or the props change", async () => {
    const active = activeProps();
    const channel = channelContext({ own: true, title: "You" });
    await mount({ active, channel, session: held });
    const first = seen.at(-1);
    expect(first).toMatchObject({
      draft: "hi",
      channelReply: { mode: "ask", channelLabel: "Telegram", targetTitle: "You", status: "on" },
    });
    expect(first).not.toHaveProperty("channelCheck");
    await mount({ active, channel, session: held });
    expect(seen.at(-1)).toBe(first);
    await mount({ active: { ...active, draft: "hi!" }, channel, session: held });
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.draft).toBe("hi!");
  });

  it("reads the person's last message from the open conversation's turns for WhatsApp's reply window", async () => {
    const whatsapp = channelContext({ channelKey: "whatsapp", channelLabel: "WhatsApp" });
    const turns = [
      turnAt("t1", hoursAgo(30), "external_channel"),
      turnAt("t2", hoursAgo(26), "external_channel"),
      // Written later than theirs but not theirs: a desk message never reopens the window.
      turnAt("t3", hoursAgo(2), "operator"),
    ];
    await mount({ active: activeProps("hi", { sessionId: "channel-1", turns }), channel: whatsapp, session: held });
    expect(seen.at(-1)?.channelReply?.replyWindow).toEqual({ channelKey: "whatsapp", lastInboundAt: hoursAgo(26) });

    // Their message arrives: the same conversation now carries it.
    const reopened = [...turns, turnAt("t4", hoursAgo(1), "external_channel")];
    await mount({
      active: activeProps("hi", { sessionId: "channel-1", turns: reopened }),
      channel: whatsapp,
      session: held,
    });
    expect(seen.at(-1)?.channelReply?.replyWindow).toEqual({ channelKey: "whatsapp", lastInboundAt: hoursAgo(1) });
  });

  it("claims nothing about the window until the open conversation's own turns are loaded", async () => {
    const whatsapp = channelContext({ channelKey: "whatsapp", channelLabel: "WhatsApp" });
    const turns = [turnAt("t1", hoursAgo(30), "external_channel")];
    // No thread yet, no thread at all, and a thread that is another conversation's.
    for (const thread of [undefined, null, { sessionId: "another-session", turns }]) {
      await mount({ active: activeProps("hi", thread), channel: whatsapp, session: held });
      expect(seen.at(-1)?.channelReply).toBeDefined();
      expect(seen.at(-1)?.channelReply).not.toHaveProperty("replyWindow");
    }
  });

  it("takes files from neither a drop nor a paste in a channel conversation", async () => {
    const active = activeProps();
    await mount({ active, channel: channelContext(), session: held });
    const merged = seen.at(-1)!;
    expect(merged.isDragActive).toBe(false);
    expect(merged.onDrop).not.toBe(active.onDrop);
    expect(merged.onComposerPaste).not.toBe(active.onComposerPaste);
    const drop = { dataTransfer: { types: ["Files"], files: [new File(["x"], "a.txt")] }, preventDefault: vi.fn() };
    merged.onDrop(drop as never);
    expect(active.onDrop).not.toHaveBeenCalled();
    expect(drop.preventDefault).toHaveBeenCalled();
  });

  it("is neutral and not sendable while the overview loads, then follows the channel", async () => {
    api.fetchChatMessaging.mockReturnValue(new Promise(() => undefined));
    const active = activeProps();
    await mount({ active, session: held });
    const checking = seen.at(-1)!;
    expect(checking.channelCheck).toBe("checking");
    expect(checking).not.toHaveProperty("channelReply");
    expect(checking.isDragActive).toBe(false);
    expect(checking.onDrop).not.toBe(active.onDrop);
    await mount({ active, channel: channelContext(), session: held });
    expect(seen.at(-1)?.channelReply?.mode).toBe("post");
    expect(seen.at(-1)).not.toHaveProperty("channelCheck");
  });

  it("stays neutral and not sendable when the overview request fails", async () => {
    api.fetchChatMessaging.mockRejectedValue(new Error("offline"));
    await mount({ active: activeProps(), session: held });
    expect(seen.at(-1)?.channelCheck).toBe("unavailable");
    expect(seen.at(-1)).not.toHaveProperty("channelReply");
  });

  it("does not guess when the overview loads without this conversation", async () => {
    api.fetchChatMessaging.mockResolvedValue({ workspaceId: "default", channels: [] });
    await mount({ active: activeProps(), session: held });
    expect(seen.at(-1)?.channelCheck).toBe("unavailable");
  });
});

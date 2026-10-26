// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMessagingOverview } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConversationContext } from "./channel-conversation";
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
    channelLabel: "Telegram",
    title: "Maya",
    kind: "direct",
    own: false,
    status: "on",
    tracksReading: true,
    ...overrides,
  };
}

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
    // A channel that needs a look can still be tried: the Gateway says so if it cannot deliver.
    expect(channelReplyPlaceholder({ ...post, status: "needs_attention" })).toBe(
      "Posts to Maya on Telegram as your bot",
    );
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

  function activeProps(draft = "hi") {
    return {
      draft,
      isDragActive: true,
      onDragEnter: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onComposerPaste: vi.fn(),
    };
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

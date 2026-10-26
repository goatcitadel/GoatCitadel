// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelConversationContext } from "./channel-conversation";
import {
  channelReplyBlock,
  channelReplyPlaceholder,
  channelReplySubmitLabel,
  describeChannelReply,
  type ChannelReply,
} from "./channel-composer";
import { useChannelComposerProps } from "./use-channel-composer";

function channelContext(overrides: Partial<ChannelConversationContext> = {}): ChannelConversationContext {
  return {
    sessionId: "channel-1",
    connectionId: "conn-1",
    channelLabel: "Telegram",
    title: "Maya",
    kind: "direct",
    own: false,
    status: "on",
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

  it("falls back to the ordinary composer copy outside a channel conversation", () => {
    expect(channelReplyPlaceholder(undefined)).toBe("Message GoatCitadel…");
    expect(channelReplySubmitLabel(undefined)).toBe("Send");
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
});

describe("useChannelComposerProps", () => {
  type Active = { draft: string };
  let root: Root;
  let container: HTMLDivElement;
  let seen: Array<ReturnType<typeof useChannelComposerProps<Active>>>;

  function Probe(props: { active: Active | null; channel: ChannelConversationContext | undefined }) {
    seen.push(useChannelComposerProps(props.active, props.channel));
    return null;
  }

  beforeEach(() => {
    seen = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hands back the same props object for a mission chat", async () => {
    const active = { draft: "hi" };
    await act(async () => root.render(<Probe active={active} channel={undefined} />));
    expect(seen.at(-1)).toBe(active);
    await act(async () => root.render(<Probe active={null} channel={undefined} />));
    expect(seen.at(-1)).toBeNull();
  });

  it("adds the channel reply once and keeps the same object until the channel or the props change", async () => {
    const active = { draft: "hi" };
    const channel = channelContext({ own: true, title: "You" });
    await act(async () => root.render(<Probe active={active} channel={channel} />));
    const first = seen.at(-1);
    expect(first).toEqual({
      draft: "hi",
      channelReply: { mode: "ask", channelLabel: "Telegram", targetTitle: "You", status: "on" },
    });
    await act(async () => root.render(<Probe active={active} channel={channel} />));
    expect(seen.at(-1)).toBe(first);
    await act(async () => root.render(<Probe active={{ draft: "hi!" }} channel={channel} />));
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.draft).toBe("hi!");
  });
});

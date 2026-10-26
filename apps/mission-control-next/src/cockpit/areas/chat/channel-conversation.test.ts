import type { ChatMessagingOverview, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  describeChannelConversation,
  describeChannelMessageSource,
  findNewChannelMessages,
  isNewerThan,
  newestMessageTimestamp,
  newMessagesDividerText,
  type ChannelConversationContext,
} from "./channel-conversation";

const overview: ChatMessagingOverview = {
  workspaceId: "default",
  channels: [
    {
      connectionId: "conn-tg",
      channelKey: "telegram",
      label: "Telegram",
      status: "on",
      conversations: [
        {
          sessionId: "own-1",
          title: "You",
          kind: "direct",
          own: true,
          lastActivityAt: "2026-10-25T10:00:00.000Z",
          lastReadAt: "2026-10-25T09:00:00.000Z",
        },
        {
          sessionId: "group-1",
          title: "Family group",
          kind: "group",
          own: false,
          lastActivityAt: "2026-10-25T09:30:00.000Z",
        },
      ],
    },
    {
      connectionId: "conn-sl",
      channelKey: "slack",
      label: "Slack",
      status: "needs_attention",
      conversations: [
        { sessionId: "dm-1", title: "Anna", kind: "direct", own: false, lastActivityAt: "2026-10-24T10:00:00.000Z" },
      ],
    },
  ],
};

function channelOf(overrides: Partial<ChannelConversationContext> = {}): ChannelConversationContext {
  return {
    sessionId: "own-1",
    connectionId: "conn-tg",
    channelLabel: "Telegram",
    title: "You",
    kind: "direct",
    own: true,
    status: "on",
    ...overrides,
  };
}

function turn(turnId: string, userAt: string, authority: string, assistantAt?: string): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, timestamp: userAt, sourceAuthority: authority },
    assistantMessage: assistantAt ? { messageId: `assistant-${turnId}`, timestamp: assistantAt } : undefined,
  } as unknown as ChatThreadTurnRecord;
}

describe("describeChannelConversation", () => {
  it("finds the channel context for a session from the Messaging overview", () => {
    expect(describeChannelConversation("own-1", overview)).toEqual({
      sessionId: "own-1",
      connectionId: "conn-tg",
      channelLabel: "Telegram",
      title: "You",
      kind: "direct",
      own: true,
      status: "on",
      lastReadAt: "2026-10-25T09:00:00.000Z",
    });
    // A conversation nobody has read yet carries no read marker, not an empty one.
    const unread = describeChannelConversation("dm-1", overview);
    expect(unread).toMatchObject({ connectionId: "conn-sl", channelLabel: "Slack", status: "needs_attention" });
    expect(unread).not.toHaveProperty("lastReadAt");
  });

  it("returns nothing for a mission session", () => {
    expect(describeChannelConversation("mission-1", overview)).toBeUndefined();
    expect(describeChannelConversation("own-1", undefined)).toBeUndefined();
  });
});

describe("describeChannelMessageSource", () => {
  it("names where a message came from, by who the conversation is with", () => {
    expect(describeChannelMessageSource(channelOf(), "external_channel")?.label).toBe("You · via Telegram");
    expect(describeChannelMessageSource(channelOf({ own: false, title: "Anna" }), "external_channel")?.label).toBe(
      "Anna · via Telegram",
    );
    expect(
      describeChannelMessageSource(channelOf({ own: false, kind: "group", title: "Family group" }), "external_channel")
        ?.label,
    ).toBe("via Telegram");
    expect(describeChannelMessageSource(channelOf(), "operator")?.label).toBe("You · from your desk");
  });

  it("gives screen readers a heading that says who spoke", () => {
    expect(describeChannelMessageSource(channelOf(), "external_channel")?.heading).toBe("You said via Telegram");
    expect(describeChannelMessageSource(channelOf({ own: false, title: "Anna" }), "external_channel")?.heading).toBe(
      "Anna said via Telegram",
    );
    expect(describeChannelMessageSource(channelOf(), "operator")?.heading).toBe("You said from your desk");
  });

  it("adds nothing for messages the assistant or the system wrote", () => {
    expect(describeChannelMessageSource(channelOf(), "agent_proposed")).toBeNull();
    expect(describeChannelMessageSource(channelOf(), undefined)).toBeNull();
  });
});

describe("new messages in a channel conversation", () => {
  const turns = [
    turn("old", "2026-10-25T08:00:00.000Z", "external_channel", "2026-10-25T08:00:05.000Z"),
    turn("desk", "2026-10-25T09:30:00.000Z", "operator", "2026-10-25T09:30:05.000Z"),
    turn("new-one", "2026-10-25T09:40:00.000Z", "external_channel", "2026-10-25T09:40:05.000Z"),
    turn("new-two", "2026-10-25T09:50:00.000Z", "external_channel"),
  ];

  it("finds the first channel message after the read marker and counts the ones people sent", () => {
    expect(findNewChannelMessages(turns, "2026-10-25T09:00:00.000Z")).toEqual({ turnId: "new-one", count: 2 });
    expect(findNewChannelMessages(turns, "2026-10-25T09:50:00.000Z")).toBeUndefined();
  });

  it("shows no marker when it does not know where the reader stopped", () => {
    expect(findNewChannelMessages(turns, undefined)).toBeUndefined();
  });

  it("finds the newest message across both sides of every turn", () => {
    expect(newestMessageTimestamp(turns)).toBe("2026-10-25T09:50:00.000Z");
    expect(newestMessageTimestamp([])).toBeUndefined();
  });

  it("compares moments, not spellings of them", () => {
    expect(isNewerThan("2026-10-25T10:00:00Z", "2026-10-25T09:59:59.999Z")).toBe(true);
    expect(isNewerThan("2026-10-25T10:00:00.000Z", "2026-10-25T10:00:00Z")).toBe(false);
    expect(isNewerThan("2026-10-25T10:00:00.000Z", undefined)).toBe(true);
    expect(isNewerThan("not a time", "2026-10-25T10:00:00.000Z")).toBe(false);
  });

  it("words the divider with the shared count formatting", () => {
    expect(newMessagesDividerText(1)).toBe("1 new since you were last here");
    expect(newMessagesDividerText(1204)).toBe("1,204 new since you were last here");
  });
});

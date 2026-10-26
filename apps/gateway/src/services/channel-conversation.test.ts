import { describe, expect, it } from "vitest";
import {
  buildChannelConversation,
  isChannelConversationSession,
  readChannelConversation,
} from "./channel-conversation.js";

describe("channel conversation details", () => {
  it("builds direct details with the other person and group details with a title only", () => {
    expect(buildChannelConversation({ kind: "direct", counterpartActorId: " 42 ", title: " Sam Lee " })).toEqual({
      kind: "direct",
      counterpartActorId: "42",
      title: "Sam Lee",
    });
    expect(buildChannelConversation({ kind: "group", counterpartActorId: "42", title: "Family group" })).toEqual({
      kind: "group",
      title: "Family group",
    });
  });

  it("leaves blank values out instead of storing empty strings", () => {
    expect(buildChannelConversation({ kind: "direct", counterpartActorId: " ", title: "" })).toEqual({
      kind: "direct",
    });
    expect(buildChannelConversation({ kind: "group", title: null })).toEqual({ kind: "group" });
  });

  it("reads stored details and rejects anything off-contract", () => {
    expect(readChannelConversation({ kind: "direct", counterpartActorId: "42", title: "Sam", extra: 1 })).toEqual({
      kind: "direct",
      counterpartActorId: "42",
      title: "Sam",
    });
    expect(readChannelConversation({ kind: "direct", counterpartActorId: 42, title: ["x"] })).toEqual({
      kind: "direct",
    });
    for (const value of [undefined, null, "direct", [], { kind: "channel" }, { title: "No kind" }]) {
      expect(readChannelConversation(value)).toBeUndefined();
    }
  });
});

describe("isChannelConversationSession", () => {
  const binding = { transport: "integration", connectionId: "conn-telegram" } as const;

  it("is a session from outside held through an integration binding", () => {
    expect(isChannelConversationSession({ channel: "telegram" }, binding)).toBe(true);
  });

  it("is never a mission chat, a session without a channel binding, or an unknown session", () => {
    // A mission chat bound to a channel in the context dock stays an ordinary chat.
    expect(isChannelConversationSession({ channel: "mission" }, binding)).toBe(false);
    expect(isChannelConversationSession({ channel: "telegram" }, { transport: "llm" })).toBe(false);
    expect(isChannelConversationSession({ channel: "telegram" }, { transport: "integration" })).toBe(false);
    expect(isChannelConversationSession({ channel: "telegram" }, undefined)).toBe(false);
    expect(isChannelConversationSession(undefined, binding)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildChannelConversation, readChannelConversation } from "./channel-conversation.js";

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

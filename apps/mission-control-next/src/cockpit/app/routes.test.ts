import { describe, expect, it } from "vitest";
import {
  channelKeyChangeHref,
  channelPageConnectionId,
  channelPageHref,
  channelPickerHref,
  channelSetupHref,
  COCKPIT_AREAS,
  messagingView,
  parseCockpitLocation,
} from "./routes";

const CONNECTION = "0b9f2c1e-3d4a-4e5f-8a6b-7c8d9e0f1a2b";

describe("cockpit routes", () => {
  it("maps cockpit and classic paths to their areas", () => {
    expect(parseCockpitLocation("/inbox/appr-1")).toEqual({ area: "inbox", rest: ["appr-1"] });
    expect(parseCockpitLocation("/projects/p-1")).toEqual({ area: "chat", rest: ["p-1"] });
    expect(parseCockpitLocation("/ops/costs")).toEqual({ area: "system", rest: ["costs"] });
    expect(parseCockpitLocation("/__gallery")).toEqual({ area: "gallery", rest: [] });
    expect(parseCockpitLocation("/")).toEqual({ area: "chat", rest: [] });
  });

  it("opens /chat/messaging/<connectionId> as a channel page, not a conversation", () => {
    const { area, rest } = parseCockpitLocation("/chat/messaging/conn%2F1");
    expect(area).toBe("chat");
    expect(rest).toEqual(["messaging", "conn%2F1"]);
    expect(channelPageConnectionId(rest)).toBe("conn/1");
    // The conversation view has no extra segments, and Projects keeps its own.
    expect(channelPageConnectionId([])).toBeNull();
    expect(channelPageConnectionId(["projects", "p-1"])).toBeNull();
    expect(channelPageConnectionId(["messaging"])).toBeNull();
    expect(channelPageConnectionId(["messaging", "a", "b"])).toBeNull();
    expect(channelPageConnectionId(["messaging", "%E0%A4%A"])).toBeNull();
    expect(channelPageConnectionId(["messaging", "%20padded%20"])).toBeNull();
    expect(channelPageHref("conn/1")).toBe("/chat/messaging/conn%2F1");
    expect(channelPageConnectionId(parseCockpitLocation(channelPageHref("conn/1")).rest)).toBe("conn/1");
  });

  it("names the Messaging views: a channel, the picker, a channel's setup and its key change", () => {
    expect(messagingView(["messaging", "add"])).toEqual({ kind: "picker" });
    expect(messagingView(["messaging", "add", "telegram"])).toEqual({ kind: "setup", channelKey: "telegram" });
    expect(messagingView(["messaging", "add", "nextcloud-talk"])).toEqual({
      kind: "setup",
      channelKey: "nextcloud-talk",
    });
    expect(messagingView(["messaging", CONNECTION, "key"])).toEqual({ kind: "change_key", connectionId: CONNECTION });
    expect(messagingView(["messaging", CONNECTION])).toEqual({ kind: "channel", connectionId: CONNECTION });
    expect(messagingView(["messaging", "conn%2F1", "key"])).toEqual({ kind: "change_key", connectionId: "conn/1" });
  });

  it.each([
    [[]],
    [["messaging"]],
    [["projects", "p-1"]],
    [["messaging", "add", "Tele gram"]],
    [["messaging", "add", "Telegram"]],
    [["messaging", "add", "1telegram"]],
    [["messaging", "add", "a".repeat(41)]],
    [["messaging", "add", ""]],
    [["messaging", "add", "telegram", "x"]],
    [["messaging", "a", "b"]],
    [["messaging", CONNECTION, "key", "x"]],
    [["messaging", "%20padded%20", "key"]],
    [["messaging", "%E0%A4%A", "key"]],
    [["messaging", "", "key"]],
  ] as [string[]][])("does not name a Messaging view for %j", (rest) => {
    expect(messagingView(rest)).toBeNull();
  });

  it("accepts a channel key up to 40 characters", () => {
    expect(messagingView(["messaging", "add", "a".repeat(40)])).toEqual({ kind: "setup", channelKey: "a".repeat(40) });
  });

  it("keeps `add` out of the channel-page contract", () => {
    expect(channelPageConnectionId(["messaging", "add"])).toBeNull();
    expect(channelPageConnectionId(["messaging", "add", "telegram"])).toBeNull();
    expect(channelPageConnectionId(["messaging", CONNECTION, "key"])).toBeNull();
  });

  it("builds Messaging hrefs that read back as the same view", () => {
    expect(channelPickerHref()).toBe("/chat/messaging/add");
    expect(channelSetupHref("telegram")).toBe("/chat/messaging/add/telegram");
    expect(channelKeyChangeHref(CONNECTION)).toBe(`/chat/messaging/${CONNECTION}/key`);
    expect(channelKeyChangeHref("conn/1")).toBe("/chat/messaging/conn%2F1/key");
    expect(messagingView(parseCockpitLocation(channelPickerHref()).rest)).toEqual({ kind: "picker" });
    expect(messagingView(parseCockpitLocation(channelSetupHref("slack")).rest)).toEqual({
      kind: "setup",
      channelKey: "slack",
    });
    expect(messagingView(parseCockpitLocation(channelKeyChangeHref("conn/1")).rest)).toEqual({
      kind: "change_key",
      connectionId: "conn/1",
    });
  });

  it("lists primary areas with non-conflicting sequence keys", () => {
    expect(COCKPIT_AREAS.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ["Chat", "c"],
      ["Inbox", "i"],
      ["Work", "w"],
      ["Capabilities", "a"],
      ["Library", "l"],
      ["System", "s"],
    ]);
  });

  it("maps the Capabilities area and its tab sub-routes", () => {
    expect(parseCockpitLocation("/capabilities")).toEqual({ area: "capabilities", rest: [] });
    expect(parseCockpitLocation("/capabilities/connectors")).toEqual({ area: "capabilities", rest: ["connectors"] });
  });
});

import { describe, expect, it } from "vitest";
import { channelPageConnectionId, channelPageHref, COCKPIT_AREAS, parseCockpitLocation } from "./routes";

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

  it("lists primary areas with non-conflicting sequence keys", () => {
    expect(COCKPIT_AREAS.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ["Chat", "c"],
      ["Inbox", "i"],
      ["Work", "w"],
      ["Library", "l"],
      ["System", "s"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { COCKPIT_AREAS, parseCockpitLocation } from "./routes";

describe("cockpit routes", () => {
  it("maps cockpit and classic paths to their areas", () => {
    expect(parseCockpitLocation("/inbox/appr-1")).toEqual({ area: "inbox", rest: ["appr-1"] });
    expect(parseCockpitLocation("/projects/p-1")).toEqual({ area: "chat", rest: ["p-1"] });
    expect(parseCockpitLocation("/ops/costs")).toEqual({ area: "system", rest: ["costs"] });
    expect(parseCockpitLocation("/__gallery")).toEqual({ area: "gallery", rest: [] });
    expect(parseCockpitLocation("/")).toEqual({ area: "chat", rest: [] });
  });

  it("lists primary areas with non-conflicting sequence keys", () => {
    expect(COCKPIT_AREAS.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ["Chat", "c"], ["Inbox", "i"], ["Work", "w"], ["Library", "l"], ["System", "s"],
    ]);
  });
});

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

  it("lists five primary areas with Ctrl+1 through Ctrl+5", () => {
    expect(COCKPIT_AREAS.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ["Chat", "1"], ["Inbox", "2"], ["Work", "3"], ["Library", "4"], ["System", "5"],
    ]);
  });
});

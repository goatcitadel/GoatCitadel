import { describe, expect, it } from "vitest";

import { RAIL_ITEMS, buildAppHref, getRouteLabel, getRouteReleaseScope, parseAppRoute } from "./route-model";

describe("odysseus personal AI routes", () => {
  it("exposes notes, communications, and local AI as rail-backed native routes", () => {
    const notes = parseAppRoute("/library/notes");
    const communications = parseAppRoute("/library/communications");
    const localAi = parseAppRoute("/settings/local-ai");

    expect(buildAppHref(notes)).toBe("/library/notes");
    expect(buildAppHref(communications)).toBe("/library/communications");
    expect(buildAppHref(localAi)).toBe("/settings/local-ai");
    expect(getRouteLabel(notes)).toBe("Notes");
    expect(getRouteLabel(communications)).toBe("Communications");
    expect(getRouteLabel(localAi)).toBe("Local AI");
    expect(RAIL_ITEMS.library.find((item) => item.id === "library-notes")?.section).toBe("notes");
    expect(RAIL_ITEMS.library.find((item) => item.id === "library-communications")?.section).toBe("communications");
    expect(RAIL_ITEMS.settings.find((item) => item.id === "settings-local-ai")?.section).toBe("local-ai");
    expect(getRouteReleaseScope(notes).status).toBe("ship");
    expect(getRouteReleaseScope(communications).note).toContain("approval-gated");
    expect(getRouteReleaseScope(localAi).note).toContain("does not claim");
  });

  it("keeps model comparison review attached to the prompt-packs route", () => {
    const promptPacks = parseAppRoute("/library/prompt-packs");
    const railEntry = RAIL_ITEMS.library.find((item) => item.id === "library-prompt-packs");

    expect(promptPacks.section).toBe("prompt-packs");
    expect(railEntry?.description).toContain("model comparisons");
    expect(getRouteReleaseScope(promptPacks).note).toContain("model comparison review");
  });
});

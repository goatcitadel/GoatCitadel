import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
  PersonalityCatalogService,
} from "./channel-personalities.js";

function createPersonalityService(initial?: unknown) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) {
    store.set("personality.catalog.v1", initial);
  }
  const settings = {
    get: vi.fn((key: string) => {
      if (!store.has(key)) {
        return undefined;
      }
      return { key, value: store.get(key) };
    }),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return { key, value };
    }),
  };
  return {
    service: new PersonalityCatalogService(settings as never),
    settings,
    store,
  };
}

describe("channel personalities", () => {
  it("exposes all requested builtin presets with categories and soul files", () => {
    const ids = listPersonalityPresets().map((preset) => preset.id);
    const expected = [
      "helpful",
      "concise",
      "technical",
      "teacher",
      "creative",
      "operator",
      "researcher",
      "architect",
      "coach",
      "philosopher",
      "critic",
      "skeptic",
      "auditor",
      "red_team",
      "contrarian",
      "tinkerer",
      "pragmatist",
      "optimizer",
      "maintainer",
      "shipper",
      "manager",
      "executive",
      "coworker",
      "intern",
      "therapist",
      "systems_thinker",
      "first_principles",
      "futurist",
      "historian",
      "risk_analyst",
      "debugger",
      "noir",
      "hype",
      "playful",
      "wizard",
      "pirate",
      "alien",
      "time_traveler",
      "drunk_friend",
      "stoned_friend",
      "leprechaun",
      "chaotic_uncle",
      "burnt_out_dev",
      "overengineer",
      "minimalist",
      "glitch",
    ];

    for (const id of expected) {
      expect(ids).toContain(id);
    }
    for (const preset of listPersonalityPresets()) {
      expect(preset.category).toMatch(/^(core|critical|execution|social|thinking|flavor|chaos)$/);
      expect(preset.soulFile).toBe(`docs/personalities/${preset.category}/${preset.id}.md`);
      expect(fs.existsSync(path.resolve(process.cwd(), "..", "..", preset.soulFile))).toBe(true);
    }
  });

  it("normalizes default aliases and preserves policy boundaries in overlays", () => {
    expect(normalizePersonalityId("none")).toBe("default");
    expect(getPersonalityPreset("unknown").id).toBe("default");
    expect(buildPersonalityOverlay("default")).toBeUndefined();
    expect(buildPersonalityOverlay("operator")).toContain("cannot override GoatCitadel safety");
  });
});

describe("PersonalityCatalogService", () => {
  it("merges shipped presets, persisted built-in overrides, custom presets, and default fallback", () => {
    const { service } = createPersonalityService({
      defaultPersonalityId: "missing",
      builtinOverrides: {
        operator: {
          id: "operator",
          label: "Operator Prime",
          category: "core",
          description: "Edited operator.",
          tone: "Steady",
          style: "Compact",
          systemOverlay: "Keep it crisp.",
          safetyNotes: ["Tone only."],
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
      },
      customPresets: [
        {
          id: "direct-custom",
          label: "Direct Custom",
          category: "execution",
          systemOverlay: "Be direct.",
        },
      ],
    });

    const catalog = service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.find((item) => item.id === "operator")).toMatchObject({
      label: "Operator Prime",
      builtin: true,
      editable: true,
      modified: true,
    });
    expect(catalog.items.find((item) => item.id === "direct-custom")).toMatchObject({
      label: "Direct Custom",
      builtin: false,
      editable: true,
      modified: true,
      visibility: "custom",
    });
  });

  it("creates, edits, deletes custom presets, and clears a deleted default", () => {
    const { service } = createPersonalityService();

    service.createPersonality({
      id: "Direct Custom",
      label: "Direct Custom",
      category: "execution",
      description: "Original.",
      tone: "Direct",
      style: "Short",
      systemOverlay: "Be direct.",
      safetyNotes: ["Tone only."],
    });
    expect(() => service.createPersonality({ id: "operator", label: "Duplicate built-in" })).toThrow(/already exists/);

    service.updatePersonality("direct-custom", {
      id: "Direct Custom Edited",
      label: "Direct Custom Edited",
      systemOverlay: "Be direct and kind.",
    });
    service.setDefaultPersonality("direct-custom-edited");
    let catalog = service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("direct-custom-edited");
    expect(catalog.items.find((item) => item.id === "direct-custom-edited")).toMatchObject({
      label: "Direct Custom Edited",
      systemOverlay: "Be direct and kind.",
    });

    service.deletePersonality("direct-custom-edited");
    catalog = service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.some((item) => item.id === "direct-custom-edited")).toBe(false);
  });

  it("edits and resets built-in presets without removing the shipped preset", () => {
    const { service } = createPersonalityService();

    service.updatePersonality("operator", {
      label: "Operator Prime",
      systemOverlay: "Use terse command-center language.",
    });
    service.setDefaultPersonality("operator");
    let catalog = service.getCatalog();
    expect(catalog.items.find((item) => item.id === "operator")).toMatchObject({
      label: "Operator Prime",
      modified: true,
    });

    service.deletePersonality("operator");
    catalog = service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.find((item) => item.id === "operator")).toMatchObject({
      label: "Operator",
      builtin: true,
      modified: false,
    });
  });
});

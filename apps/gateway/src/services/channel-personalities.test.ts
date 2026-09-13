import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, SystemSettingsRepository, type DatabaseClient } from "@goatcitadel/storage";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
  PersonalityCatalogService,
} from "./channel-personalities.js";

const databases: DatabaseClient[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function createPersonalityService(initial?: unknown) {
  const db = createDatabase({ dbPath: ":memory:" }); databases.push(db);
  const settings = new SystemSettingsRepository(db);
  if (initial !== undefined) settings.set("personality.catalog.v1", initial);
  return { service: new PersonalityCatalogService(settings as never), settings };
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
      expect(fs.existsSync(new URL(`../../../../${preset.soulFile}`, import.meta.url))).toBe(true);
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
  it("merges shipped presets, persisted built-in overrides, custom presets, and default fallback", async () => {
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

    const catalog = await service.getCatalog();
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

  it("creates, edits, deletes custom presets, and clears a deleted default", async () => {
    const { service } = createPersonalityService();

    await service.createPersonality({
      expectedRevision: (await service.getCatalog()).revision,
      id: "Direct Custom",
      label: "Direct Custom",
      category: "execution",
      description: "Original.",
      tone: "Direct",
      style: "Short",
      systemOverlay: "Be direct.",
      safetyNotes: ["Tone only."],
    });
    await expect(service.createPersonality({ expectedRevision: (await service.getCatalog()).revision, id: "operator", label: "Duplicate built-in" })).rejects.toThrow(
      /already exists/,
    );

    await service.updatePersonality("direct-custom", {
      expectedRevision: (await service.getCatalog()).revision,
      id: "Direct Custom Edited",
      label: "Direct Custom Edited",
      systemOverlay: "Be direct and kind.",
    });
    await service.setDefaultPersonality("direct-custom-edited", (await service.getCatalog()).revision);
    let catalog = await service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("direct-custom-edited");
    expect(catalog.items.find((item) => item.id === "direct-custom-edited")).toMatchObject({
      label: "Direct Custom Edited",
      systemOverlay: "Be direct and kind.",
    });

    await service.deletePersonality("direct-custom-edited", catalog.revision);
    catalog = await service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.some((item) => item.id === "direct-custom-edited")).toBe(false);
  });

  it("edits and resets built-in presets without removing the shipped preset", async () => {
    const { service } = createPersonalityService();

    await service.updatePersonality("operator", {
      expectedRevision: (await service.getCatalog()).revision,
      label: "Operator Prime",
      systemOverlay: "Use terse command-center language.",
    });
    await service.setDefaultPersonality("operator", (await service.getCatalog()).revision);
    let catalog = await service.getCatalog();
    expect(catalog.items.find((item) => item.id === "operator")).toMatchObject({
      label: "Operator Prime",
      modified: true,
    });

    await service.deletePersonality("operator", catalog.revision);
    catalog = await service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.find((item) => item.id === "operator")).toMatchObject({
      label: "Operator",
      builtin: true,
      modified: false,
    });
  });
});

import type { CapabilityPluginListItem, CapabilityPluginState, PluginPieceKind } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_PIECE_NOUNS,
  PLUGIN_TRUST_LABELS,
  filterPlugins,
  noPluginsDescription,
  pluginPiecesSummary,
  pluginRowAction,
  pluginSearchPlaceholder,
  pluginStateNote,
  pluginTrustOptions,
  presentPluginState,
} from "./plugin-view";

function plugin(overrides: Partial<CapabilityPluginListItem> & Pick<CapabilityPluginListItem, "name">) {
  return {
    pluginId: overrides.name.toLowerCase().replaceAll(" ", "-"),
    description: `${overrides.name} adds a few pieces.`,
    version: "1.0.0",
    trust: "unverified",
    sourceDisplay: "github.com/acme/tools",
    state: "installed",
    pieceCounts: { skill: 1 },
    ...overrides,
  } satisfies CapabilityPluginListItem;
}

const BROWSER_CHECKS = plugin({
  name: "Browser checks",
  description: "Checks web pages in a real browser.",
  trust: "built_in",
  sourceDisplay: "Ships with GoatCitadel",
  state: "available",
  pieceCounts: { connector: 1, skill: 1 },
});
const RELEASE_NOTES = plugin({ name: "Release notes", description: "Drafts notes from merged work." });

describe("pluginPiecesSummary", () => {
  it("names every kind it was sent in a fixed order, whatever order the manifest used", () => {
    // Key order is the manifest's (connector first here); the summary always starts with skills.
    expect(pluginPiecesSummary({ connector: 1, skill: 2 })).toBe("2 skills, 1 connector");
    expect(pluginPiecesSummary({ prompt_pack: 2, hook: 1, tool_group_off: 3, connector: 2, skill: 1 })).toBe(
      "1 skill, 2 connectors, 3 tool rules, 1 hook, 2 prompt packs",
    );
  });

  it("counts through plural()", () => {
    expect(pluginPiecesSummary({ tool_group_off: 1 })).toBe("1 tool rule");
    expect(pluginPiecesSummary({ prompt_pack: 1200 })).toBe("1,200 prompt packs");
  });

  it("leaves out a kind that is absent or counted 0, and says nothing for no pieces", () => {
    expect(pluginPiecesSummary({ skill: 0, hook: 2 })).toBe("2 hooks");
    expect(pluginPiecesSummary({})).toBe("");
  });

  it("has a noun for every kind of piece", () => {
    const kinds: PluginPieceKind[] = ["skill", "connector", "tool_group_off", "hook", "prompt_pack"];
    expect(Object.keys(PLUGIN_PIECE_NOUNS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(PLUGIN_PIECE_NOUNS[kind], kind).toMatch(/^[a-z][a-z ]+[a-z]$/);
  });
});

describe("presentPluginState", () => {
  it.each<[CapabilityPluginState, string, string]>([
    // The badge holds the state alone; the pieces go beside it (pluginStateNote).
    ["installed", "Installed", "done"],
    ["install_not_finished", "Install not finished", "waiting"],
    // A stopped removal keeps this state, so it never reads as running work.
    ["uninstalling", "Removing…", "waiting"],
    ["available", "Ready to install", "neutral"],
  ])("words %s as %j", (state, label, tone) => {
    expect(presentPluginState({ state })).toEqual({ label, tone });
  });

  it("reads Installed alone when the pieces can't be named", () => {
    expect(presentPluginState({ state: "installed" })).toEqual({ label: "Installed", tone: "done" });
    expect(pluginStateNote({ state: "installed", pieceCounts: {} })).toBe("");
  });

  it("names an installed plugin's pieces beside its badge, and nothing for any other state", () => {
    expect(pluginStateNote({ state: "installed", pieceCounts: { connector: 1, skill: 2 } })).toBe(
      "2 skills, 1 connector",
    );
    for (const state of ["install_not_finished", "uninstalling", "available"] as const) {
      expect(pluginStateNote({ state, pieceCounts: { connector: 1, skill: 2 } }), state).toBe("");
    }
  });
});

describe("pluginRowAction", () => {
  it.each<[CapabilityPluginState, string]>([
    ["available", "install"],
    ["installed", "view"],
    ["install_not_finished", "continue"],
    // A plugin on its way out is viewed; its panel says how to finish.
    ["uninstalling", "view"],
  ])("offers one action for %s: %s", (state, action) => {
    expect(pluginRowAction(state)).toBe(action);
  });
});

describe("pluginSearchPlaceholder", () => {
  it("suggests the first plugin's name, lower-cased", () => {
    expect(pluginSearchPlaceholder([BROWSER_CHECKS, RELEASE_NOTES])).toBe('Try "browser checks"');
  });

  it("says what it searches when there is no plugin, or the first has no name", () => {
    expect(pluginSearchPlaceholder([])).toBe("Search plugins");
    expect(pluginSearchPlaceholder([plugin({ name: "  " })])).toBe("Search plugins");
  });
});

describe("pluginTrustOptions", () => {
  it("offers only the trust labels present, Built in first", () => {
    expect(pluginTrustOptions([RELEASE_NOTES, BROWSER_CHECKS])).toEqual([
      { id: "built_in", label: "Built in" },
      { id: "unverified", label: "Unverified" },
    ]);
    expect(pluginTrustOptions([RELEASE_NOTES])).toEqual([{ id: "unverified", label: "Unverified" }]);
    expect(pluginTrustOptions([])).toEqual([]);
    expect(PLUGIN_TRUST_LABELS).toEqual({ built_in: "Built in", unverified: "Unverified" });
  });
});

describe("filterPlugins", () => {
  const all = [BROWSER_CHECKS, RELEASE_NOTES];

  it("matches the name, the description or the label as shown, ignoring case and outer spaces", () => {
    expect(filterPlugins(all, { query: "  BROWSER ", trusts: [] })).toEqual([BROWSER_CHECKS]);
    expect(filterPlugins(all, { query: "merged work", trusts: [] })).toEqual([RELEASE_NOTES]);
    expect(filterPlugins(all, { query: "unverified", trusts: [] })).toEqual([RELEASE_NOTES]);
    expect(filterPlugins(all, { query: "", trusts: [] })).toEqual(all);
    expect(filterPlugins(all, { query: "nothing like it", trusts: [] })).toEqual([]);
  });

  it("keeps only the chosen labels when any is chosen", () => {
    expect(filterPlugins(all, { query: "", trusts: ["built_in"] })).toEqual([BROWSER_CHECKS]);
    expect(filterPlugins(all, { query: "notes", trusts: ["built_in"] })).toEqual([]);
    expect(filterPlugins(all, { query: "", trusts: ["built_in", "unverified"] })).toEqual(all);
  });
});

describe("noPluginsDescription", () => {
  it.each([
    [true, true, "Install one from the built-in list, a Git repository or a folder."],
    [true, false, "Install one from the built-in list or a Git repository."],
    [false, true, "Install one from a Git repository or a folder."],
    [false, false, "Install one from a Git repository."],
  ])("with built-ins %s and folders %s: %j", (builtIn, folders, description) => {
    expect(noPluginsDescription({ builtIn, folders })).toBe(description);
  });
});

import type { CapabilitySkillDiscoverItem } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  discoverAction,
  discoverProviderOptions,
  discoverTerm,
  filterDiscoverItems,
  joinLabels,
  presentDiscoverState,
  unavailableProvidersLine,
} from "./discover-view";

function item(overrides: Partial<CapabilitySkillDiscoverItem> & Pick<CapabilitySkillDiscoverItem, "id">) {
  return {
    name: "Himalaya",
    description: "Reads and sends email from a terminal.",
    category: "email",
    provider: "goatcitadel",
    providerLabel: "GoatCitadel",
    state: "available",
    ...overrides,
  } satisfies CapabilitySkillDiscoverItem;
}

describe("the search term", () => {
  it("is empty under two characters, once trimmed", () => {
    for (const search of ["", " ", "a", " a ", "\t\n"]) expect(discoverTerm(search)).toBe("");
  });

  it("is the trimmed text from two characters, as typed", () => {
    expect(discoverTerm("ab")).toBe("ab");
    expect(discoverTerm("  Code review ")).toBe("Code review");
  });

  it("stops at the 100 characters the Gateway accepts, rather than failing the search", () => {
    const long = `${"x".repeat(99)} tail words`;
    expect(discoverTerm(long)).toBe("x".repeat(99));
    expect(discoverTerm("y".repeat(150))).toHaveLength(100);
  });
});

describe("filtering what the Gateway sent", () => {
  const items = [
    item({ id: "pack:himalaya", category: "email" }),
    item({ id: "source:a", category: "coding", provider: "agentskill", providerLabel: "AgentSkill" }),
    item({ id: "source:b", category: "coding", provider: "skillsmp", providerLabel: "SkillsMP" }),
    item({ id: "source:c", category: "writing", provider: "agentskill", providerLabel: "AgentSkill" }),
  ];
  const ids = (list: readonly CapabilitySkillDiscoverItem[]) => list.map((entry) => entry.id);

  it("keeps everything, in the Gateway's order, when no button is pressed", () => {
    expect(ids(filterDiscoverItems(items, { categories: [], providers: [] }))).toEqual(ids(items));
  });

  it("narrows by category, by provider, and by both", () => {
    expect(ids(filterDiscoverItems(items, { categories: ["coding"], providers: [] }))).toEqual([
      "source:a",
      "source:b",
    ]);
    expect(ids(filterDiscoverItems(items, { categories: [], providers: ["AgentSkill"] }))).toEqual([
      "source:a",
      "source:c",
    ]);
    expect(ids(filterDiscoverItems(items, { categories: ["coding"], providers: ["AgentSkill"] }))).toEqual([
      "source:a",
    ]);
    expect(ids(filterDiscoverItems(items, { categories: ["coding", "writing"], providers: ["SkillsMP"] }))).toEqual([
      "source:b",
    ]);
  });

  it("returns a new array and leaves the items alone", () => {
    const result = filterDiscoverItems(items, { categories: [], providers: [] });
    expect(result).not.toBe(items);
    expect(items).toHaveLength(4);
  });

  it("lists each provider's name once, in the order the items name them", () => {
    expect(discoverProviderOptions(items)).toEqual([
      { id: "GoatCitadel", label: "GoatCitadel" },
      { id: "AgentSkill", label: "AgentSkill" },
      { id: "SkillsMP", label: "SkillsMP" },
    ]);
    expect(discoverProviderOptions([])).toEqual([]);
  });
});

describe("naming the sites that couldn't be searched", () => {
  it("joins names in plain English", () => {
    expect(joinLabels([])).toBe("");
    expect(joinLabels(["AgentSkill"])).toBe("AgentSkill");
    expect(joinLabels(["AgentSkill", "SkillsMP"])).toBe("AgentSkill and SkillsMP");
    expect(joinLabels(["AgentSkill", "SkillsMP", "ClawHub"])).toBe("AgentSkill, SkillsMP and ClawHub");
  });

  it("makes one line, and none when every site answered", () => {
    expect(unavailableProvidersLine([])).toBeUndefined();
    expect(unavailableProvidersLine(["AgentSkill", "SkillsMP"])).toBe(
      "AgentSkill and SkillsMP couldn't be searched right now.",
    );
    expect(unavailableProvidersLine(["SkillsMP"])).toBe("SkillsMP couldn't be searched right now.");
  });
});

describe("what a row says and offers", () => {
  it("words each state and never calls a stopped install anything but unfinished", () => {
    expect(presentDiscoverState("available")).toEqual({ label: "Not installed", tone: "neutral" });
    expect(presentDiscoverState("installed")).toEqual({ label: "Installed", tone: "done" });
    expect(presentDiscoverState("installing")).toEqual({ label: "Install not finished", tone: "waiting" });
    expect(presentDiscoverState("view_only")).toEqual({ label: "View only", tone: "neutral" });
  });

  it("offers Install for an available source and Continue for one between steps", () => {
    expect(discoverAction(item({ id: "pack:a", state: "available" }))).toEqual({ kind: "install" });
    expect(discoverAction(item({ id: "pack:a", state: "installing" }))).toEqual({ kind: "continue" });
  });

  it("offers View for an installed source that can name its skill, and nothing when it can't", () => {
    expect(discoverAction(item({ id: "pack:a", state: "installed", installedSkillId: "extra:himalaya" }))).toEqual({
      kind: "view",
      skillId: "extra:himalaya",
    });
    expect(discoverAction(item({ id: "pack:a", state: "installed" }))).toEqual({ kind: "none" });
  });

  it("offers See listing for a source it can't install, and nothing when it has no listing", () => {
    expect(
      discoverAction(item({ id: "source:a", state: "view_only", listingUrl: "https://agentskill.sh/skills/a" })),
    ).toEqual({ kind: "listing", href: "https://agentskill.sh/skills/a" });
    expect(discoverAction(item({ id: "source:a", state: "view_only" }))).toEqual({ kind: "none" });
  });

  it("never offers a listing link that isn't https", () => {
    for (const listingUrl of [
      "http://agentskill.sh/skills/a",
      "javascript:alert(1)",
      "data:text/html,x",
      "not a url",
      "",
    ]) {
      expect(discoverAction(item({ id: "source:a", state: "view_only", listingUrl }))).toEqual({ kind: "none" });
    }
  });
});

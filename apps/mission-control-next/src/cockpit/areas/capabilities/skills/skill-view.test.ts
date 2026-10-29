import type {
  CapabilitySkillItem,
  CapabilitySkillState,
  CapabilitySkillUsageEntry,
  SkillLifecycleState,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { WORKSPACE_CAPABILITIES_HREF } from "../connectors/connector-links";
import {
  filterSkills,
  presentSkillChange,
  presentSkillState,
  presentSkillUses,
  skillCategoryOptions,
  skillOriginOptions,
  skillSearchSuggestion,
} from "./skill-view";

function skill(overrides: Partial<CapabilitySkillItem> = {}): CapabilitySkillItem {
  return {
    skillId: "writer",
    name: "Writer",
    description: "Drafts and edits prose.",
    category: "writing",
    origin: "built_in",
    state: "on",
    callable: true,
    revision: 3,
    switchable: true,
    pinned: false,
    lifecycleState: "approved",
    tags: [],
    ...overrides,
  };
}

const IDLE = { waiting: false } as const;
const USES = "Used 3 times in the last year";

describe("presentSkillState", () => {
  const CASES: ReadonlyArray<{
    name: string;
    item?: Partial<CapabilitySkillItem>;
    wait?: { waiting: boolean; waitingApprovalId?: string };
    label: string;
    tone: string;
    reason: string;
    link?: { label: string; href: string };
    /** Which row of the order matched, for the views that word a state's own note (the panel's On and Paused lines). */
    kind: string;
  }> = [
    {
      name: "waiting on an approval",
      wait: { waiting: true, waitingApprovalId: "approval-1" },
      label: "Waiting for your approval",
      tone: "waiting",
      reason: "The change applies once you approve it.",
      kind: "waiting",
    },
    {
      name: "waiting before the approval is known",
      wait: { waiting: true },
      label: "Waiting for your approval",
      tone: "waiting",
      reason: "The change applies once you approve it.",
      kind: "waiting",
    },
    {
      name: "waiting beats off",
      item: { state: "off", callable: false },
      wait: { waiting: true, waitingApprovalId: "approval-1" },
      label: "Waiting for your approval",
      tone: "waiting",
      reason: "The change applies once you approve it.",
      kind: "waiting",
    },
    {
      name: "off",
      item: { state: "off", callable: false },
      label: "Off",
      tone: "neutral",
      reason: "The AI can't use it",
      kind: "off",
    },
    {
      name: "off beats left out",
      item: { state: "off", callable: false, leftOutOfWorkspace: true },
      label: "Off",
      tone: "neutral",
      reason: "The AI can't use it",
      kind: "off",
    },
    {
      name: "left out of this workspace",
      item: { leftOutOfWorkspace: true },
      label: "Left out of this workspace",
      tone: "waiting",
      reason: "This workspace's skill choices leave it out, so the AI can't use it here.",
      link: { label: "Change this workspace's skills", href: WORKSPACE_CAPABILITIES_HREF },
      kind: "left_out",
    },
    {
      name: "left out beats paused",
      item: { state: "paused", leftOutOfWorkspace: true },
      label: "Left out of this workspace",
      tone: "waiting",
      reason: "This workspace's skill choices leave it out, so the AI can't use it here.",
      link: { label: "Change this workspace's skills", href: WORKSPACE_CAPABILITIES_HREF },
      kind: "left_out",
    },
    {
      name: "a candidate that isn't reviewed",
      item: { callable: false, lifecycleState: "candidate" },
      label: "Not usable yet",
      tone: "waiting",
      reason: "It hasn't been reviewed, so the AI can't use it",
      kind: "not_usable",
    },
    {
      name: "a draft",
      item: { callable: false, lifecycleState: "draft" },
      label: "Not usable yet",
      tone: "waiting",
      reason: "It's a draft, so the AI can't use it",
      kind: "not_usable",
    },
    {
      name: "a retired skill",
      item: { callable: false, lifecycleState: "deprecated" },
      label: "Retired",
      tone: "neutral",
      reason: "It's retired, so the AI can't use it",
      kind: "not_usable",
    },
    {
      name: "a revoked skill",
      item: { callable: false, lifecycleState: "revoked" },
      label: "Revoked",
      tone: "failed",
      reason: "It was revoked, so the AI can't use it",
      kind: "not_usable",
    },
    {
      name: "an approved skill the list calls not callable",
      item: { callable: false, lifecycleState: "approved" },
      label: "Not usable yet",
      tone: "waiting",
      reason: "The AI can't use it yet",
      kind: "not_usable",
    },
    {
      name: "a not-callable skill with no review state",
      item: { callable: false, lifecycleState: undefined },
      label: "Not usable yet",
      tone: "waiting",
      reason: "The AI can't use it yet",
      kind: "not_usable",
    },
    {
      name: "not callable beats paused",
      item: { state: "paused", callable: false, lifecycleState: "candidate" },
      label: "Not usable yet",
      tone: "waiting",
      reason: "It hasn't been reviewed, so the AI can't use it",
      kind: "not_usable",
    },
    {
      name: "paused",
      item: { state: "paused", callable: true },
      label: "Paused",
      tone: "neutral",
      reason: "Used only when you name it",
      kind: "paused",
    },
    { name: "on and callable", label: "On", tone: "done", reason: USES, kind: "on" },
  ];

  it.each(CASES)("words $name", ({ item, wait = IDLE, label, tone, reason, link, kind }) => {
    const present = presentSkillState(skill(item), wait, USES);
    expect(present).toMatchObject({ label, tone, reason, kind });
    expect(present.link).toEqual(link);
  });

  it("gives a wait no link: a skill approval is decided in the skill's panel, not in Inbox", () => {
    const wait = { waiting: true, waitingApprovalId: "approval-1" };
    const present = presentSkillState(skill(), wait, USES);
    expect(present.link).toBeUndefined();
    expect([present.label, present.reason].join("\n")).not.toContain("Inbox");
  });

  it("leaves the reason of an On skill to the uses line it is given", () => {
    expect(presentSkillState(skill(), IDLE, "Uses unknown").reason).toBe("Uses unknown");
    expect(presentSkillState(skill(), IDLE).reason).toBe("");
  });

  it("never says On for anything but a skill that is on, usable and in this workspace", () => {
    const others = CASES.filter((entry) => entry.label !== "On");
    for (const { item, wait = IDLE } of others) {
      expect(presentSkillState(skill(item), wait, USES).label).not.toBe("On");
    }
  });

  it("never puts a skill id or a raw code in its words", () => {
    for (const { item, wait = IDLE } of CASES) {
      const present = presentSkillState(skill({ skillId: "writer-xyz", ...item }), wait, USES);
      // No id, and no snake_case or camelCase code such as `left_out_of_workspace` or `leftOutOfWorkspace`.
      expect([present.label, present.reason, present.link?.label].join("\n")).not.toMatch(
        /writer-xyz|lifecycle|[a-z]_[a-z]|[a-z][A-Z][a-z]/,
      );
    }
  });

  it("counts every lifecycle state a skill can hold", () => {
    const states: SkillLifecycleState[] = ["draft", "candidate", "approved", "trusted", "deprecated", "revoked"];
    for (const lifecycleState of states) {
      expect(presentSkillState(skill({ callable: false, lifecycleState }), IDLE).reason).toMatch(/can't use it/);
    }
  });
});

describe("presentSkillChange", () => {
  it.each<[CapabilitySkillState, CapabilitySkillState, string]>([
    ["on", "off", "Turn Planner on"],
    ["on", "paused", "Resume Planner"],
    ["off", "on", "Turn Planner off"],
    ["off", "paused", "Turn Planner off"],
    ["paused", "on", "Pause Planner"],
    ["paused", "off", "Pause Planner"],
  ])("words a change to %s from %s as %j", (target, from, words) => {
    expect(presentSkillChange("Planner", target, from)).toBe(words);
  });

  it("names the skill alone when the change asked for isn't known (a wait found on load)", () => {
    expect(presentSkillChange("Planner", undefined, "off")).toBe("Change Planner");
  });
});

describe("presentSkillUses", () => {
  const entry = (uses: number): CapabilitySkillUsageEntry => ({
    skillId: "writer",
    uses,
    lastUsedAt: "2026-10-28T10:00:00.000Z",
  });

  it("counts the uses in the last year", () => {
    expect(presentSkillUses(entry(1), "ready")).toBe("Used 1 time in the last year");
    expect(presentSkillUses(entry(3), "ready")).toBe("Used 3 times in the last year");
    expect(presentSkillUses(entry(1204), "ready")).toBe("Used 1,204 times in the last year");
  });

  it("says Not used yet only when the counts loaded and show no use", () => {
    expect(presentSkillUses(undefined, "ready")).toBe("Not used yet");
    expect(presentSkillUses(entry(0), "ready")).toBe("Not used yet");
  });

  it("says Uses unknown, never a number, when the counts are missing or failed", () => {
    expect(presentSkillUses(undefined, "unknown")).toBe("Uses unknown");
    expect(presentSkillUses(entry(5), "unknown")).toBe("Uses unknown");
  });
});

describe("filterSkills", () => {
  const NONE = { query: "", categories: [], origins: [] } as const;
  const LIST = [
    skill({ skillId: "writer", name: "Writer", description: "Drafts and edits prose.", category: "writing" }),
    skill({
      skillId: "reviewer",
      name: "Code reviewer",
      description: "Reads a diff.",
      category: "coding",
      origin: "imported",
      tags: ["pull-request", "diff"],
    }),
    skill({
      skillId: "planner",
      name: "Planner",
      description: "Breaks work into steps.",
      category: "planning",
      origin: "workspace",
    }),
  ];
  const ids = (list: readonly CapabilitySkillItem[]) => list.map((entry) => entry.skillId);

  it("keeps every skill, in order, when nothing filters", () => {
    expect(ids(filterSkills(LIST, NONE))).toEqual(["writer", "reviewer", "planner"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: "   " }))).toEqual(["writer", "reviewer", "planner"]);
  });

  it("searches the name, the description, the tags and the category label, ignoring case", () => {
    expect(ids(filterSkills(LIST, { ...NONE, query: "CODE REV" }))).toEqual(["reviewer"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: "prose" }))).toEqual(["writer"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: "pull-request" }))).toEqual(["reviewer"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: "writing and docs" }))).toEqual(["writer"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: " planning " }))).toEqual(["planner"]);
  });

  it("doesn't search the skill id or the origin", () => {
    expect(ids(filterSkills(LIST, { ...NONE, query: "reviewer" }))).toEqual(["reviewer"]);
    expect(ids(filterSkills(LIST, { ...NONE, query: "imported" }))).toEqual([]);
    expect(
      ids(
        filterSkills([skill({ skillId: "hidden-id", name: "Visible", description: "" })], { ...NONE, query: "hidden" }),
      ),
    ).toEqual([]);
  });

  it("filters by category, and by origin, and by both", () => {
    expect(ids(filterSkills(LIST, { ...NONE, categories: ["coding", "planning"] }))).toEqual(["reviewer", "planner"]);
    expect(ids(filterSkills(LIST, { ...NONE, origins: ["built_in"] }))).toEqual(["writer"]);
    expect(ids(filterSkills(LIST, { query: "r", categories: ["coding", "planning"], origins: ["workspace"] }))).toEqual(
      ["planner"],
    );
  });

  it("returns a new array and leaves the list as it was", () => {
    const before = [...LIST];
    const result = filterSkills(LIST, NONE);
    expect(result).not.toBe(LIST);
    expect(LIST).toEqual(before);
  });
});

describe("the filter buttons", () => {
  it("lists only the categories that have skills, in the contract's order", () => {
    const options = skillCategoryOptions([
      skill({ category: "personal" }),
      skill({ category: "coding" }),
      skill({ category: "personal" }),
      skill({ category: "writing" }),
    ]);
    expect(options).toEqual([
      { id: "coding", label: "Coding" },
      { id: "writing", label: "Writing and docs" },
      { id: "personal", label: "Personal" },
    ]);
  });

  it("lists only the origins that have skills, in the label table's order", () => {
    const options = skillOriginOptions([
      skill({ origin: "workspace" }),
      skill({ origin: "imported" }),
      skill({ origin: "built_in" }),
    ]);
    expect(options).toEqual([
      { id: "built_in", label: "Built in" },
      { id: "imported", label: "Imported" },
      { id: "workspace", label: "Workspace" },
    ]);
    expect(skillOriginOptions([])).toEqual([]);
  });
});

describe("skillSearchSuggestion", () => {
  it("suggests the most common category, lower-cased", () => {
    const items = [
      skill({ category: "writing" }),
      skill({ category: "coding" }),
      skill({ category: "coding" }),
      skill({ category: "writing" }),
      skill({ category: "coding" }),
    ];
    expect(skillSearchSuggestion(items)).toBe('Try "coding"');
    expect(skillSearchSuggestion([skill({ category: "email" }), skill({ category: "email" })])).toBe(
      'Try "email and messages"',
    );
  });

  it("breaks a tie by the contract's category order", () => {
    expect(skillSearchSuggestion([skill({ category: "writing" }), skill({ category: "coding" })])).toBe('Try "coding"');
  });

  it("says what the box searches when there are no skills", () => {
    expect(skillSearchSuggestion([])).toBe("Search skills");
  });
});

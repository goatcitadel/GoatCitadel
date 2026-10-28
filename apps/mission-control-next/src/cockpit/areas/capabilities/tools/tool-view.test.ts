import type {
  CapabilityToolGroupItem,
  CapabilityToolGroupUsage,
  CapabilityToolItem,
  CapabilityToolUsageResponse,
  ToolGroupId,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  TOOL_BLOCK_LINES,
  filterToolGroups,
  firstSentence,
  presentGroupBlock,
  presentGroupBlockLines,
  presentGroupCalls,
  presentMostUsed,
  presentToolAsks,
  presentToolGroupState,
  presentToolLastUse,
  toolSearchSuggestion,
} from "./tool-view";

function tool(overrides: Partial<CapabilityToolItem> = {}): CapabilityToolItem {
  return { toolName: "fs.read", description: "Read a file.", risk: "safe", asks: "runs_freely", ...overrides };
}

function group(groupId: ToolGroupId, overrides: Partial<CapabilityToolGroupItem> = {}): CapabilityToolGroupItem {
  return {
    groupId,
    label: groupId[0]!.toUpperCase() + groupId.slice(1).replace(/_/g, " "),
    description: `The ${groupId} group.`,
    state: "on",
    risk: "safe",
    tools: [tool(), tool({ toolName: "fs.list" })],
    blockedToolCount: 0,
    ...overrides,
  };
}

function usage(
  kind: "most_used" | "essentials",
  groupIds: ToolGroupId[],
  calls: Partial<Record<ToolGroupId, number>> = {},
): CapabilityToolUsageResponse {
  return {
    since: "2025-10-28T00:00:00.000Z",
    generatedAt: "2026-10-28T00:00:00.000Z",
    tools: [],
    groups: Object.entries(calls).map(([groupId, count]) => ({ groupId: groupId as ToolGroupId, calls: count })),
    mostUsed: { kind, groupIds },
  };
}

describe("presentGroupCalls", () => {
  const entry = (calls: number): CapabilityToolGroupUsage => ({ groupId: "files", calls });

  it.each([
    [entry(0), "ready", "No calls yet"],
    [entry(1), "ready", "1 call in the last year"],
    [entry(2), "ready", "2 calls in the last year"],
    [entry(1204), "ready", "1,204 calls in the last year"],
    // A count is never made up: a missing or failed read says so, and a ready read with no row for the group too.
    [undefined, "unknown", "Calls unknown"],
    [entry(0), "unknown", "Calls unknown"],
    [entry(12), "unknown", "Calls unknown"],
    [undefined, "ready", "Calls unknown"],
  ] as const)("reads %j (%s) as %s", (groupUsage, status, expected) => {
    expect(presentGroupCalls(groupUsage, status)).toBe(expected);
  });
});

describe("presentGroupBlock", () => {
  it("says nothing for a group no rule blocks", () => {
    expect(presentGroupBlock(group("files"))).toBeUndefined();
    expect(presentGroupBlockLines(group("files"))).toEqual([]);
  });

  it.each([
    [1, 1, "Blocked by other rules"],
    [3, 3, "Blocked by other rules"],
    [1, 3, "1 tool blocked by other rules"],
    [2, 3, "2 tools blocked by other rules"],
  ])("reads %i of %i tools blocked as %s", (blocked, total, expected) => {
    const files = group("files", {
      tools: Array.from({ length: total }, (_, index) => tool({ toolName: `fs.tool${index}` })),
      blockedToolCount: blocked,
    });
    expect(presentGroupBlock(files)).toBe(expected);
  });

  it("does not call a group blocked when it has no tools on this install", () => {
    expect(presentGroupBlock(group("git", { tools: [], blockedToolCount: 0 }))).toBeUndefined();
  });

  describe("tools that can't be checked before they're used", () => {
    const unchecked = tool({ toolName: "web.fetch", asks: "unknown" });
    const UNCHECKED = "Some tools can't be checked before they're used";

    it("says so for a group that is on", () => {
      expect(presentGroupBlock(group("web_requests", { tools: [tool(), unchecked] }))).toBe(UNCHECKED);
    });

    it("says so for a group that is always on", () => {
      expect(presentGroupBlock(group("core", { state: "always_on", tools: [unchecked] }))).toBe(UNCHECKED);
    });

    it("says nothing for a group that is off, where unknown only means switched off", () => {
      expect(presentGroupBlock(group("web_requests", { state: "off", tools: [unchecked] }))).toBeUndefined();
    });

    it("does not count a blocked tool, whose answer is known", () => {
      const blocked = tool({ toolName: "fs.write", asks: "unknown", blockedBy: "safety_rules" });
      expect(presentGroupBlock(group("files", { tools: [blocked], blockedToolCount: 1 }))).toBe(
        "Blocked by other rules",
      );
      expect(presentGroupBlockLines(group("files", { tools: [blocked], blockedToolCount: 1 }))).toEqual([
        "Blocked by other rules",
      ]);
    });

    it("sits below the blocked line when both apply", () => {
      const blocked = tool({ toolName: "fs.write", asks: "unknown", blockedBy: "safety_rules" });
      const files = group("files", { tools: [blocked, unchecked, tool()], blockedToolCount: 1 });
      expect(presentGroupBlockLines(files)).toEqual(["1 tool blocked by other rules", UNCHECKED]);
      expect(presentGroupBlock(files)).toBe("1 tool blocked by other rules");
    });
  });

  it("still reports a block in a group that is off", () => {
    const blocked = tool({ toolName: "fs.write", asks: "unknown", blockedBy: "safety_rules" });
    expect(presentGroupBlock(group("files", { state: "off", tools: [blocked], blockedToolCount: 1 }))).toBe(
      "Blocked by other rules",
    );
  });
});

describe("presentMostUsed", () => {
  const groups = (["core", "files", "git", "web_search", "memory", "browser"] as const).map((id) => group(id));

  it("shows the groups the Gateway named, in its order, once 4 have calls", () => {
    const shown = presentMostUsed(
      groups,
      usage("most_used", ["memory", "git", "files", "browser"], { memory: 90, git: 40, files: 30, browser: 20 }),
    );
    expect(shown.heading).toBe("Most used");
    expect(shown.groups.map((entry) => entry.groupId)).toEqual(["memory", "git", "files", "browser"]);
  });

  it("shows Essentials when the Gateway sends the starter set", () => {
    const shown = presentMostUsed(groups, usage("essentials", ["files", "web_search", "memory", "browser"]));
    expect(shown.heading).toBe("Essentials");
    expect(shown.groups.map((entry) => entry.groupId)).toEqual(["files", "web_search", "memory", "browser"]);
  });

  it("shows Essentials from the starter set when counts are missing", () => {
    const shown = presentMostUsed(groups, undefined);
    expect(shown.heading).toBe("Essentials");
    expect(shown.groups.map((entry) => entry.groupId)).toEqual(["files", "web_search", "memory", "browser"]);
  });

  it("falls back to the starter set when the Gateway names no groups", () => {
    const shown = presentMostUsed(groups, usage("essentials", []));
    expect(shown.groups.map((entry) => entry.groupId)).toEqual(["files", "web_search", "memory", "browser"]);
  });

  it("leaves out a group the list doesn't have", () => {
    const shown = presentMostUsed(
      groups.filter((entry) => entry.groupId !== "browser"),
      undefined,
    );
    expect(shown.groups.map((entry) => entry.groupId)).toEqual(["files", "web_search", "memory"]);
  });

  it("uses the live rows from the list", () => {
    const off = group("files", { state: "off" });
    const shown = presentMostUsed([off, ...groups.filter((entry) => entry.groupId !== "files")], undefined);
    expect(shown.groups[0]).toBe(off);
  });
});

describe("filterToolGroups", () => {
  const files = group("files", {
    label: "Files",
    description: "Read, search, write, move and delete files in your folders.",
    tools: [
      tool({ description: "Open a file from disk." }),
      tool({ toolName: "fs.search", description: "Find text." }),
    ],
  });
  const browser = group("browser", {
    label: "Browser",
    description: "Open and drive web pages.",
    tools: [tool({ toolName: "browser.open", description: "Open a page in the browser." })],
  });
  const all = [files, browser];

  it("keeps every group for an empty or blank search", () => {
    expect(filterToolGroups(all, "")).toEqual(all);
    expect(filterToolGroups(all, "   ")).toEqual(all);
  });

  it.each([
    ["a label", "FILES", ["files"]],
    ["a description", "web pages", ["browser"]],
    ["a tool's description", "text", ["files"]],
    ["any case, with spaces around the search", "  DISK ", ["files"]],
    ["more than one group", "open", ["files", "browser"]],
  ] as const)("matches %s", (_where, query, expected) => {
    expect(filterToolGroups(all, query).map((entry) => entry.groupId)).toEqual(expected);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterToolGroups(all, "spreadsheet")).toEqual([]);
  });

  it("does not match tool ids, which the page never shows", () => {
    expect(filterToolGroups(all, "fs.search")).toEqual([]);
  });

  it("keeps the order it was given", () => {
    expect(filterToolGroups([browser, files], "open").map((entry) => entry.groupId)).toEqual(["browser", "files"]);
  });
});

describe("toolSearchSuggestion", () => {
  it("suggests the first Most used group, lower-cased", () => {
    expect(toolSearchSuggestion([group("web_search", { label: "Web search" }), group("files")])).toBe(
      'Try "web search"',
    );
  });

  it("asks for a search without inventing a term when there is no group", () => {
    expect(toolSearchSuggestion([])).toBe("Search tool groups");
  });
});

describe("presentToolAsks", () => {
  const files = group("files");

  it.each([
    ["safety_rules", "Blocked by your safety rules"],
    ["permission_profile", "Blocked by a permission profile"],
    ["citadel_ward", "Blocked by a Citadel Ward"],
    ["grant", "Blocked by a grant"],
    ["install_profile", "Blocked by how this install is set up"],
  ] as const)("names the rule that blocks a tool: %s", (block, expected) => {
    expect(presentToolAsks(files, tool({ asks: "unknown", blockedBy: block }))).toEqual({ text: expected, block });
    expect(TOOL_BLOCK_LINES[block]).toBe(expected);
  });

  it("gives every block a line, and nothing else", () => {
    expect(Object.keys(TOOL_BLOCK_LINES).sort()).toEqual([
      "citadel_ward",
      "grant",
      "install_profile",
      "permission_profile",
      "safety_rules",
    ]);
  });

  it("says whether a free tool asks first", () => {
    expect(presentToolAsks(files, tool({ asks: "asks_first" }))).toEqual({ text: "Asks first" });
    expect(presentToolAsks(files, tool({ asks: "runs_freely" }))).toEqual({ text: "Runs freely" });
  });

  it("says a tool can't be told before it's used only in a group that is on or always on", () => {
    expect(presentToolAsks(files, tool({ asks: "unknown" }))).toEqual({ text: "Can't tell before it's used" });
    expect(presentToolAsks(group("core", { state: "always_on" }), tool({ asks: "unknown" }))).toEqual({
      text: "Can't tell before it's used",
    });
  });

  it("says Switched off for a tool of a group that is off, where unknown only means switched off", () => {
    const off = group("files", { state: "off" });
    expect(presentToolAsks(off, tool({ asks: "unknown" }))).toEqual({ text: "Switched off" });
    // Whatever the answer was, a tool that cannot run does not say it asks first.
    expect(presentToolAsks(off, tool({ asks: "asks_first" }))).toEqual({ text: "Switched off" });
  });

  it("lets a block beat the switch in a group that is off", () => {
    const off = group("files", { state: "off" });
    expect(presentToolAsks(off, tool({ asks: "unknown", blockedBy: "safety_rules" }))).toEqual({
      text: "Blocked by your safety rules",
      block: "safety_rules",
    });
  });
});

describe("presentToolLastUse", () => {
  const NOW = Date.parse("2026-10-28T12:00:00.000Z");
  const withTools = (...tools: CapabilityToolUsageResponse["tools"]): CapabilityToolUsageResponse => ({
    ...usage("most_used", []),
    tools,
  });
  const called = (toolName: string, lastCalledAt: string) => ({ toolName, calls: 3, lastCalledAt });

  it("says when a tool was last used", () => {
    const read = withTools(called("fs.read", "2026-10-28T11:55:00.000Z"));
    expect(presentToolLastUse(read, "fs.read", NOW)).toBe("Last used 5 minutes ago");
    expect(presentToolLastUse(withTools(called("fs.read", "2026-10-28T11:59:40.000Z")), "fs.read", NOW)).toBe(
      "Last used just now",
    );
    expect(presentToolLastUse(withTools(called("fs.read", "2026-10-27T12:00:00.000Z")), "fs.read", NOW)).toBe(
      "Last used yesterday",
    );
  });

  it("says Not used yet only when the counts loaded and the tool isn't in them", () => {
    expect(presentToolLastUse(withTools(called("fs.read", "2026-10-28T11:55:00.000Z")), "fs.write", NOW)).toBe(
      "Not used yet",
    );
    expect(presentToolLastUse(withTools(), "fs.write", NOW)).toBe("Not used yet");
  });

  it("never says Not used yet without counts", () => {
    expect(presentToolLastUse(undefined, "fs.write", NOW)).toBe("Last use unknown");
  });

  it("doesn't make up a time from one it can't read", () => {
    expect(presentToolLastUse(withTools(called("fs.read", "not a time")), "fs.read", NOW)).toBe("Last use unknown");
  });

  it("never reads a time ahead of now as in the future", () => {
    expect(presentToolLastUse(withTools(called("fs.read", "2026-10-28T13:00:00.000Z")), "fs.read", NOW)).toBe(
      "Last used just now",
    );
  });
});

describe("firstSentence", () => {
  it.each([
    ["Read a file. Fails when it is missing.", "Read a file."],
    ["Read a file", "Read a file"],
    ["  Read a file.  ", "Read a file."],
    ["Does it work? Yes.", "Does it work?"],
    ["Stops at once! Then waits.", "Stops at once!"],
    ["Read a file.\nAlso lists folders.", "Read a file."],
    // A dot inside a name or a number is not the end of a sentence.
    ["Uses fs.read for v1.2 files. More.", "Uses fs.read for v1.2 files."],
    ["", ""],
  ])("reads %j as %j", (text, expected) => {
    expect(firstSentence(text)).toBe(expected);
  });
});

describe("presentToolGroupState", () => {
  it.each([
    ["on", "On", "done"],
    ["off", "Off", "neutral"],
    ["always_on", "Always on", "done"],
  ] as const)("words %s", (state, label, tone) => {
    expect(presentToolGroupState(state)).toEqual({ label, tone });
  });
});

import { describe, expect, it } from "vitest";
import {
  ESSENTIAL_TOOL_GROUP_IDS,
  SWITCHABLE_TOOL_GROUP_IDS,
  TOOL_GROUPS,
  isSwitchableToolGroupId,
  isToolGroupChange,
  toolGroupForTool,
  toolNamesSwitchedOff,
} from "./tool-groups.js";

function toolsIn(groupId: string): string[] {
  return TOOL_GROUPS.find((group) => group.id === groupId)?.toolNames.slice() ?? [];
}

describe("tool group map contract", () => {
  it("lists 14 groups with unique ids, and only Core can't be switched off", () => {
    const ids = TOOL_GROUPS.map((group) => group.id);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
    expect(TOOL_GROUPS.filter((group) => !group.switchable).map((group) => group.id)).toEqual(["core"]);
    expect(SWITCHABLE_TOOL_GROUP_IDS).toEqual(TOOL_GROUPS.filter((group) => group.switchable).map((group) => group.id));
    expect(ESSENTIAL_TOOL_GROUP_IDS).toEqual(["files", "web_search", "memory", "browser"]);
  });

  it("puts no tool in two groups", () => {
    const seen = new Map<string, string>();
    for (const group of TOOL_GROUPS) {
      for (const toolName of group.toolNames) {
        expect(seen.has(toolName), `${toolName} is in ${seen.get(toolName)} and ${group.id}`).toBe(false);
        seen.set(toolName, group.id);
      }
    }
    expect(seen.size).toBe(106);
  });

  it("keeps mcp.invoke and the session tools in Core", () => {
    const core = toolsIn("core");
    expect(core).toContain("mcp.invoke");
    expect(core).toContain("session.status");
    expect(core).toContain("session.search");
    expect(core).toContain("session.history");
    expect(toolGroupForTool("mcp.invoke")?.id).toBe("core");
    expect(toolGroupForTool("session.status")?.id).toBe("core");
  });

  it("recognises only switchable group ids", () => {
    expect(isSwitchableToolGroupId("files")).toBe(true);
    expect(isSwitchableToolGroupId("subagents")).toBe(true);
    expect(isSwitchableToolGroupId("core")).toBe(false);
    expect(isSwitchableToolGroupId("nope")).toBe(false);
    expect(isSwitchableToolGroupId(undefined)).toBe(false);
  });

  it("ignores Core and unknown ids when switching off", () => {
    const switchedOff = toolNamesSwitchedOff(["core", "files", "nope"]);
    expect(switchedOff.get("fs.read")).toBe("files");
    expect(switchedOff.has("session.status")).toBe(false);
    expect(switchedOff.has("mcp.invoke")).toBe(false);
    expect(switchedOff.size).toBe(toolsIn("files").length);
    expect(toolNamesSwitchedOff(undefined).size).toBe(0);
  });

  it("ignores a disabledGroups value that isn't a list", () => {
    for (const handEdited of [5, true, {}, "files", null]) {
      expect(toolNamesSwitchedOff(handEdited as never).size).toBe(0);
    }
    // Entries that aren't group ids are skipped; the valid ones around them still count.
    const mixed = toolNamesSwitchedOff(["git", 7, null, {}, "files"] as never);
    expect(mixed.get("git.status")).toBe("git");
    expect(mixed.get("fs.read")).toBe("files");
    expect(mixed.size).toBe(toolsIn("git").length + toolsIn("files").length);
  });
});

describe("tool group change contract", () => {
  it("accepts exactly a switchable group id and a boolean", () => {
    expect(isToolGroupChange({ groupId: "files", enabled: false })).toBe(true);
    expect(isToolGroupChange({ groupId: "subagents", enabled: true })).toBe(true);
    for (const groupId of SWITCHABLE_TOOL_GROUP_IDS) {
      expect(isToolGroupChange({ groupId, enabled: false })).toBe(true);
    }
  });

  it("refuses Core, unknown ids, other types and extra or missing keys", () => {
    expect(isToolGroupChange({ groupId: "core", enabled: false })).toBe(false);
    expect(isToolGroupChange({ groupId: "nope", enabled: false })).toBe(false);
    expect(isToolGroupChange({ groupId: "files", enabled: "no" })).toBe(false);
    expect(isToolGroupChange({ groupId: "files" })).toBe(false);
    expect(isToolGroupChange({ enabled: true })).toBe(false);
    expect(isToolGroupChange({ groupId: "files", enabled: false, scope: "agent" })).toBe(false);
    expect(isToolGroupChange(null)).toBe(false);
    expect(isToolGroupChange(["files", false])).toBe(false);
    expect(isToolGroupChange("files")).toBe(false);
  });
});

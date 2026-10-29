import { describe, expect, it } from "vitest";
import { connectorIdFromSource, connectorPanelSource } from "../connectors/connector-links";
import { toolGroupIdFromSource, toolGroupItemHref, toolPanelSource } from "../tools/tool-links";
import {
  SKILL_PANEL_SOURCE_PREFIX,
  SKILLS_HREF,
  skillIdFromCapabilityId,
  skillIdFromSearch,
  skillIdFromSource,
  skillItemHref,
  skillPanelSource,
} from "./skill-links";

describe("skill addresses", () => {
  it("puts the skill in the address and reads it back", () => {
    expect(SKILLS_HREF).toBe("/capabilities/skills");
    expect(skillItemHref("review")).toBe("/capabilities/skills?item=skill%3Areview");
    expect(skillItemHref("code-review")).toBe("/capabilities/skills?item=skill%3Acode-review");
    expect(skillIdFromSearch("?item=skill%3Areview")).toBe("review");
    expect(skillIdFromSearch("?workspaceId=w&item=skill%3Acode-review&shell=cockpit")).toBe("code-review");
    expect(skillIdFromSearch("?item=skill:review")).toBe("review");
  });

  it("encodes an id that is not safe in an address, and reads it back", () => {
    const href = skillItemHref("a b/c&d");
    expect(href).toBe("/capabilities/skills?item=skill%3Aa%20b%2Fc%26d");
    expect(skillIdFromSearch(href.slice(href.indexOf("?")))).toBe("a b/c&d");
  });

  it.each([
    [undefined],
    [""],
    ["?"],
    ["?item="],
    ["?item=skill%3A"],
    // An id without the prefix, or another tab's item, is not a skill's address.
    ["?item=review"],
    ["?item=group%3Afiles"],
    ["?item=mcp-server%3Alinear"],
    ["?item=SKILL%3Areview"],
  ])("ignores %j", (search) => {
    expect(skillIdFromSearch(search)).toBeUndefined();
  });

  it("reads the skill id out of a Library skill record id", () => {
    expect(skillIdFromCapabilityId("skill:review")).toBe("review");
    // An id without the prefix is already a skill id.
    expect(skillIdFromCapabilityId("review")).toBe("review");
    expect(skillItemHref(skillIdFromCapabilityId("skill:review"))).toBe("/capabilities/skills?item=skill%3Areview");
  });

  it("never reads a tool group's address as a skill's", () => {
    const toolsHref = toolGroupItemHref("files");
    expect(skillIdFromSearch(toolsHref.slice(toolsHref.indexOf("?")))).toBeUndefined();
  });
});

describe("the skill panel's inspector source", () => {
  it("names the skill behind a prefix of its own and reads it back", () => {
    expect(SKILL_PANEL_SOURCE_PREFIX).toBe("capabilities-skills:");
    expect(skillPanelSource("review")).toBe("capabilities-skills:review");
    expect(skillIdFromSource(skillPanelSource("review"))).toBe("review");
    expect(skillIdFromSource(skillPanelSource("pack/a b"))).toBe("pack/a b");
  });

  it.each([[undefined], [""], ["capabilities-skills:"], ["review"], ["chat:review"]])("ignores %j", (source) => {
    expect(skillIdFromSource(source)).toBeUndefined();
  });

  it("keeps the Skills panel apart from the Connectors and Tools panels", () => {
    // A connector's source and a tool group's source never name a skill.
    expect(skillIdFromSource(connectorPanelSource("files"))).toBeUndefined();
    expect(skillIdFromSource("capabilities:review")).toBeUndefined();
    expect(skillIdFromSource(toolPanelSource("files"))).toBeUndefined();
    expect(skillIdFromSource("capabilities-tools:files")).toBeUndefined();
    // And a skill's source names neither a connector nor a tool group.
    expect(connectorIdFromSource(skillPanelSource("files"))).toBeNull();
    expect(connectorIdFromSource("capabilities-skills:files")).toBeNull();
    expect(toolGroupIdFromSource(skillPanelSource("files"))).toBeUndefined();
    expect(toolGroupIdFromSource("capabilities-skills:files")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { toolGroupItemHref } from "../tools/tool-links";
import { SKILLS_HREF, skillIdFromCapabilityId, skillIdFromSearch, skillItemHref } from "./skill-links";

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

import { describe, expect, it } from "vitest";
import { connectorIdFromSource, connectorPanelSource } from "../connectors/connector-links";
import {
  TOOLS_HREF,
  TOOL_PANEL_SOURCE_PREFIX,
  toolBlockHref,
  toolGroupIdFromSearch,
  toolGroupIdFromSource,
  toolGroupItemHref,
  toolHref,
  toolNameFromCapabilityId,
  toolPanelSource,
} from "./tool-links";

describe("tool group addresses", () => {
  it("puts the group in the address and reads it back", () => {
    expect(TOOLS_HREF).toBe("/capabilities/tools");
    expect(toolGroupItemHref("files")).toBe("/capabilities/tools?item=group%3Afiles");
    expect(toolGroupItemHref("shell_and_code")).toBe("/capabilities/tools?item=group%3Ashell_and_code");
    expect(toolGroupIdFromSearch("?item=group%3Afiles")).toBe("files");
    expect(toolGroupIdFromSearch("?workspaceId=w&item=group%3Ashell_and_code&shell=cockpit")).toBe("shell_and_code");
    expect(toolGroupIdFromSearch("?item=group:core")).toBe("core");
  });

  it.each([
    [undefined],
    [""],
    ["?"],
    ["?item="],
    ["?item=group%3A"],
    ["?item=group%3Anope"],
    // A group id without the prefix, or a connector's id, is not a tool group's address.
    ["?item=files"],
    ["?item=mcp-server%3Alinear"],
    ["?item=GROUP%3Afiles"],
    ["?item=group%3Afiles%3Aextra"],
    // An inherited property name is not a group.
    ["?item=group%3Aconstructor"],
    ["?item=group%3A__proto__"],
  ])("ignores %j", (search) => {
    expect(toolGroupIdFromSearch(search)).toBeUndefined();
  });
});

describe("the address of one tool", () => {
  it("opens the group the tool belongs to", () => {
    expect(toolHref("fs.read")).toBe("/capabilities/tools?item=group%3Afiles");
    expect(toolHref("shell.exec")).toBe("/capabilities/tools?item=group%3Ashell_and_code");
    expect(toolHref("capabilities.search")).toBe("/capabilities/tools?item=group%3Acore");
  });

  it("opens the Tools tab for a tool that is in no group", () => {
    expect(toolHref("linear.create_issue")).toBe("/capabilities/tools");
    expect(toolHref("")).toBe("/capabilities/tools");
    // An inherited property name is not a tool.
    expect(toolHref("constructor")).toBe("/capabilities/tools");
  });

  it("reads the tool name out of a Library tool record id", () => {
    expect(toolNameFromCapabilityId("tool:fs.read")).toBe("fs.read");
    // An id without the prefix is already a name.
    expect(toolNameFromCapabilityId("fs.write")).toBe("fs.write");
    expect(toolNameFromCapabilityId("tool:")).toBe("");
  });
});

describe("tool group panel sources", () => {
  it("never shares a prefix with the Connectors panel", () => {
    expect(TOOL_PANEL_SOURCE_PREFIX).toBe("capabilities-tools:");
    expect(toolPanelSource("files")).toBe("capabilities-tools:files");
    expect(toolGroupIdFromSource("capabilities-tools:files")).toBe("files");
    expect(toolGroupIdFromSource("capabilities-tools:core")).toBe("core");

    // A connector's source never names a tool group, and a tool group's never names a connector.
    expect(toolGroupIdFromSource(connectorPanelSource("files"))).toBeUndefined();
    expect(toolGroupIdFromSource("capabilities:files")).toBeUndefined();
    expect(connectorIdFromSource(toolPanelSource("files"))).toBeNull();
    expect(connectorIdFromSource("capabilities-tools:files")).toBeNull();
  });

  it.each([[undefined], [""], ["capabilities-tools:"], ["capabilities-tools:nope"], ["chat:files"]])(
    "reads %j as no tool group",
    (source) => {
      expect(toolGroupIdFromSource(source)).toBeUndefined();
    },
  );
});

describe("toolBlockHref", () => {
  it.each([
    ["safety_rules", "files", "/settings/safety#filesystem-write-roots"],
    ["safety_rules", "git", "/settings/safety#permission-profile"],
    ["safety_rules", "shell_and_code", "/settings/safety#permission-profile"],
    ["permission_profile", "files", "/settings/safety#permission-profile"],
    ["permission_profile", "git", "/settings/safety#permission-profile"],
    ["grant", "files", "/settings/safety#approval-mode"],
    ["grant", "browser", "/settings/safety#approval-mode"],
    ["citadel_ward", "files", "/settings/citadel#citadel-wards"],
    ["citadel_ward", "email_and_calendar", "/settings/citadel#citadel-wards"],
    ["install_profile", "browser", "/settings/safety#approval-mode"],
  ] as const)("sends %s in %s to %s", (block, groupId, href) => {
    expect(toolBlockHref(block, groupId)).toBe(href);
  });
});

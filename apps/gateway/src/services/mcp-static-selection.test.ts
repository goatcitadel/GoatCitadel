import { describe, expect, it } from "vitest";
import { hasExplicitMcpIdentifier, selectExplicitStaticMcpServers } from "./mcp-static-selection.js";

describe("explicit static MCP selection", () => {
  it("never treats overlapping prose as a server or raw-tool mention", () => {
    expect(selectExplicitStaticMcpServers("Prepare keynotes and a spreadsheet", [{ serverId: "notes" }])).toEqual([]);
    expect(hasExplicitMcpIdentifier("spreadsheet thread unread read_more reader", "read")).toBe(false);
    expect(hasExplicitMcpIdentifier("Use the read tool.", "read")).toBe(true);
    expect(hasExplicitMcpIdentifier('Use "echo.value".', "echo.value")).toBe(true);
    expect(hasExplicitMcpIdentifier("Use echo.value.", "echo.value")).toBe(true);
    expect(
      selectExplicitStaticMcpServers("https://mcp.notes.read /mcp.notes.read prefix-mcp.notes.read", [
        { serverId: "notes" },
      ]),
    ).toEqual([]);
  });
  it("selects exact saved identifiers and the longest canonical server prefix", () => {
    const servers = [{ serverId: "notes" }, { serverId: "notes.archive" }, { serverId: "notebook" }];
    expect(selectExplicitStaticMcpServers('Use "notes".', servers)).toEqual([servers[0]]);
    expect(selectExplicitStaticMcpServers("Call mcp.notes.archive.read.", servers)).toEqual([servers[1]]);
    expect(selectExplicitStaticMcpServers("Call mcp.notes.read and notebook.", servers)).toEqual([
      servers[0],
      servers[2],
    ]);
  });
});

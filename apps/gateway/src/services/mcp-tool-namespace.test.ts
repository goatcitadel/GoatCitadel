import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  buildMcpToolCollisionError,
  findServersExposingTool,
  formatNamespacedMcpToolName,
  parseNamespacedMcpToolName,
} from "./mcp-tool-namespace.js";

describe("mcp tool namespace", () => {
  it("parses well-formed mcp__<serverId>__<toolName> names", () => {
    expect(parseNamespacedMcpToolName("mcp__srv-1__read_file")).toEqual({
      serverId: "srv-1",
      toolName: "read_file",
    });
  });

  it("keeps separators inside the tool name segment", () => {
    expect(parseNamespacedMcpToolName("mcp__srv-1__group__read_file")).toEqual({
      serverId: "srv-1",
      toolName: "group__read_file",
    });
  });

  it("treats bare and malformed names as non-namespaced", () => {
    expect(parseNamespacedMcpToolName("read_file")).toBeUndefined();
    expect(parseNamespacedMcpToolName("mcp__read_file")).toBeUndefined();
    expect(parseNamespacedMcpToolName("mcp____read_file")).toBeUndefined();
    expect(parseNamespacedMcpToolName("mcp__srv-1__")).toBeUndefined();
  });

  it("round-trips through formatNamespacedMcpToolName", () => {
    const formatted = formatNamespacedMcpToolName("srv-1", "read_file");
    expect(formatted).toBe("mcp__srv-1__read_file");
    expect(parseNamespacedMcpToolName(formatted)).toEqual({ serverId: "srv-1", toolName: "read_file" });
  });

  it("finds only connected, enabled servers exposing an enabled tool", () => {
    const servers: McpServerRecord[] = [
      makeServer("srv-a", { status: "connected" }),
      makeServer("srv-b", { status: "connected" }),
      makeServer("srv-disconnected", { status: "disconnected" }),
      makeServer("srv-quarantined", { status: "connected", trustTier: "quarantined" }),
    ];
    const tools: Record<string, McpToolRecord[]> = {
      "srv-a": [makeTool("srv-a", "read_file", true)],
      "srv-b": [makeTool("srv-b", "read_file", true)],
      "srv-disconnected": [makeTool("srv-disconnected", "read_file", true)],
      "srv-quarantined": [makeTool("srv-quarantined", "read_file", true)],
    };

    const matches = findServersExposingTool("read_file", servers, (serverId) => tools[serverId] ?? []);
    expect(matches).toEqual(["srv-a", "srv-b"]);
  });

  it("ignores disabled tools and tolerates listMcpTools throwing", () => {
    const servers: McpServerRecord[] = [
      makeServer("srv-a", { status: "connected" }),
      makeServer("srv-b", { status: "connected" }),
    ];

    const matches = findServersExposingTool("read_file", servers, (serverId) => {
      if (serverId === "srv-a") {
        return [makeTool("srv-a", "read_file", false)];
      }
      throw new Error("tools unavailable");
    });
    expect(matches).toEqual([]);
  });

  it("builds a collision error that lists candidates and the namespaced form", () => {
    const message = buildMcpToolCollisionError("read_file", ["srv-a", "srv-b"]);
    expect(message).toContain("srv-a");
    expect(message).toContain("srv-b");
    expect(message).toContain("mcp__srv-a__read_file");
    expect(message).toContain("mcp__srv-b__read_file");
  });
});

function makeServer(serverId: string, overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId,
    label: `Server ${serverId}`,
    transport: "stdio",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "basic",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

function makeTool(serverId: string, toolName: string, enabled: boolean): McpToolRecord {
  return {
    serverId,
    toolName,
    enabled,
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage, type AsyncStorage } from "@goatcitadel/storage";
import { McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

const SERVERS_KEY = "mcp_servers_v1";
const TOOLS_KEY = "mcp_tools_v1";
const UPDATED_AT = "2026-10-25T00:00:00.000Z";

describe("MCP tool inventory annotations", () => {
  let storage: AsyncStorage;
  let store: McpServerStore;
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "gc-mcp-tool-inventory-"));
    storage = createSqliteAsyncStorage(
      new Storage({
        dbPath: ":memory:",
        transcriptsDir: path.join(directory, "transcripts"),
        auditDir: path.join(directory, "audit"),
      }),
    );
    store = new McpServerStore({
      systemSettings: storage.systemSettings,
      runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
    });
  });

  beforeEach(async () => {
    await storage.systemSettings.set(SERVERS_KEY, []);
    await storage.systemSettings.set(TOOLS_KEY, []);
  });

  afterAll(async () => {
    await storage?.close();
    // Closed first, so nothing still holds a file inside it.
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const serverTools = async () => (await store.readTools()).filter((tool) => tool.serverId === "server-1");

  it("round-trips tool annotations through connection settlement and the inventory read", async () => {
    await store.writeServers([server()], []);
    const connecting = await store.patchServerState("server-1", { status: "connecting" });
    const discovered: McpToolRecord[] = [
      tool("search", { readOnlyHint: true }),
      tool("remove", { readOnlyHint: false, destructiveHint: true }),
      // Discovered before annotations were recorded: nothing to keep, so nothing is invented.
      tool("legacy"),
    ];

    await store.completeConnection(connecting, discovered);

    const stored = (await storage.systemSettings.get<McpToolRecord[]>(TOOLS_KEY))?.value ?? [];
    expect(stored).toEqual(discovered);
    const read = await serverTools();
    expect(read).toEqual(discovered);
    expect(read.find((item) => item.toolName === "legacy")).not.toHaveProperty("annotations");

    // A later reconnect replaces the server's tools with what it now reports, labels included.
    const reconnecting = await store.patchServerState("server-1", { status: "connecting" });
    const relabelled = [tool("legacy", { destructiveHint: false })];
    await store.completeConnection(reconnecting, relabelled);
    expect(await serverTools()).toEqual(relabelled);
  });

  it("round-trips tool annotations through a plain inventory write", async () => {
    const tools = [tool("search", { readOnlyHint: true, destructiveHint: false })];

    await store.writeTools(tools);

    expect(await serverTools()).toEqual(tools);
  });
});

function tool(toolName: string, annotations?: McpToolRecord["annotations"]): McpToolRecord {
  return {
    serverId: "server-1",
    toolName,
    enabled: true,
    updatedAt: UPDATED_AT,
    ...(annotations ? { annotations } : {}),
  };
}

function server(): McpServerRecord {
  return {
    serverId: "server-1",
    label: "Fixture MCP",
    transport: "stdio",
    command: "node",
    args: ["fixture.js"],
    authType: "none",
    enabled: true,
    category: "development",
    trustTier: "restricted",
    costTier: "unknown",
    policy: normalizeMcpPolicy(),
    status: "disconnected",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

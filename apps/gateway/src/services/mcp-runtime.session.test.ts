import { afterEach, describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { invokeMcpRuntimeTool, type StdioClient } from "./mcp-runtime.js";
import { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";

const pools: McpStdioSessionPool<StdioClient>[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.close();
});
const script = `
  let count = 0;
  require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'tools/call'
      ? {content:[{type:'text', text:JSON.stringify({pid:process.pid,count:++count})}]} : {};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\\n');
  });
`;
const server: McpServerRecord = {
  serverId: "session-fixture",
  label: "Local session fixture",
  transport: "stdio",
  command: process.execPath,
  args: ["-e", script],
  authType: "none",
  enabled: true,
  status: "connected",
  category: "automation",
  trustTier: "restricted",
  costTier: "free",
  policy: { requireFirstToolApproval: true, redactionMode: "off", allowedToolPatterns: [], blockedToolPatterns: [] },
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

describe("retained MCP stdio transport", () => {
  it("preserves real child state across calls and separates conversation scopes", async () => {
    const pool = new McpStdioSessionPool<StdioClient>();
    pools.push(pool);
    const call = async (scopeKey: string) => {
      const result = await invokeMcpRuntimeTool(server, { toolName: "counter", arguments: {} }, 5000, {
        stdioSession: { pool, scopeKey },
      });
      expect(result.ok, result.error).toBe(true);
      return JSON.parse(String(result.output?.contentText)) as { pid: number; count: number };
    };
    const first = await call("workspace:session-a:actor");
    expect(await call("workspace:session-a:actor")).toEqual({ ...first, count: 2 });
    const other = await call("workspace:session-b:actor");
    expect(other.count).toBe(1);
    expect(other.pid).not.toBe(first.pid);
    pool.closeServer(server.serverId);
    const fresh = await call("workspace:session-a:actor");
    expect(fresh.count).toBe(1);
    expect(fresh.pid).not.toBe(first.pid);
  });
});

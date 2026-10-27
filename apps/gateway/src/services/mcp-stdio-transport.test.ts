import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { createStdioMcpClient, withStdioMcpClient, type StdioClient } from "./mcp-stdio-transport.js";
import { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";

// Fake server: before answering any request, it sends server-initiated requests that REUSE the
// client's request id, and echoes whatever the client replies on stderr.
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) { process.stderr.write("REPLY " + line + "\\n"); return; }
  if (msg.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, method: "ping" }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, method: "roots/list" }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n"), 50);
});
`;

describe("stdio MCP transport server-initiated requests", () => {
  let dir: string | undefined;
  let client: StdioClient | undefined;
  afterEach(() => {
    client?.close();
    client = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("does not let a server request with a colliding id settle our call, and answers it", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-stdio-"));
    const script = join(dir, "server.cjs");
    writeFileSync(script, FAKE_SERVER);
    const server: McpServerRecord = {
      serverId: "fake",
      label: "Fake",
      transport: "stdio",
      command: process.execPath,
      args: [script],
      authType: "none",
      enabled: true,
      category: "development",
      trustTier: "restricted",
      costTier: "unknown",
      policy: normalizeMcpPolicy(),
      status: "disconnected",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
    } as McpServerRecord;

    client = await createStdioMcpClient(server, 10_000);
    const response = await client.request("tools/list");
    expect(response.result).toEqual({ ok: true });
    expect(response.method).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const stderr = client.readStderr();
    expect(stderr).toContain('"result":{}');
    expect(stderr).toContain('"code":-32601');
  });
});

// Answers every request with the child's own pid, so two calls show whether they reached one process.
const PID_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined || msg.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { pid: process.pid } }) + "\\n");
});
`;

describe("stdio MCP pooled session binding", () => {
  let dir: string | undefined;
  let pool: McpStdioSessionPool<StdioClient> | undefined;
  afterEach(() => {
    pool?.close();
    pool = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function pidServer(policy: McpServerRecord["policy"]): McpServerRecord {
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), "mcp-stdio-pid-"));
      writeFileSync(join(dir, "server.cjs"), PID_SERVER);
    }
    return {
      serverId: "pid-fake",
      label: "Pid fake",
      transport: "stdio",
      command: process.execPath,
      args: [join(dir, "server.cjs")],
      authType: "none",
      enabled: true,
      category: "development",
      trustTier: "restricted",
      costTier: "unknown",
      policy,
      status: "connected",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    } as McpServerRecord;
  }

  async function pidOf(server: McpServerRecord): Promise<number> {
    pool ??= new McpStdioSessionPool<StdioClient>();
    const response = await withStdioMcpClient(server, 10_000, (client) => client.request("whoami"), undefined, {
      pool,
      scopeKey: "scope-1",
    });
    return (response.result as { pid: number }).pid;
  }

  it("keeps one process when only what asks first changes between calls", async () => {
    const base = normalizeMcpPolicy();
    const first = await pidOf(pidServer(base));
    const second = await pidOf(pidServer({ ...base, approvalPosture: "reads_free" }));
    const third = await pidOf(pidServer({ ...base, approvalPosture: "nothing_asks" }));

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("starts a new process when another policy field changes", async () => {
    const base = normalizeMcpPolicy();
    const first = await pidOf(pidServer({ ...base, approvalPosture: "reads_free" }));
    const second = await pidOf(pidServer({ ...base, approvalPosture: "reads_free", blockedToolPatterns: ["write*"] }));

    expect(second).not.toBe(first);
  });
});

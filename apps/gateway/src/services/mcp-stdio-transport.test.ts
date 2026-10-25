import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { createStdioMcpClient, type StdioClient } from "./mcp-stdio-transport.js";
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

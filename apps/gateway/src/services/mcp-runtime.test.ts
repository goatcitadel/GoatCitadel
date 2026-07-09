import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import {
  __internal,
  collectMcpBrowserFallbackTargets,
  discoverMcpTools,
  inferMcpToolsForServer,
  invokeMcpRuntimeTool,
} from "./mcp-runtime.js";

function createTestServer(script: string, extraArgs: string[] = []): McpServerRecord {
  const now = new Date().toISOString();
  return {
    serverId: "srv-test",
    label: "Test Playwright MCP",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", script, ...extraArgs],
    authType: "none",
    enabled: true,
    status: "connected",
    category: "browser",
    trustTier: "trusted",
    costTier: "free",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createRemoteTestServer(url: string, input: Partial<McpServerRecord> = {}): McpServerRecord {
  const now = new Date().toISOString();
  return {
    ...createTestServer(""),
    serverId: input.serverId ?? "srv-remote",
    label: input.label ?? "Remote MCP",
    transport: input.transport ?? "http",
    command: undefined,
    args: undefined,
    url,
    authType: input.authType ?? "none",
    category: input.category ?? "research",
    trustTier: input.trustTier ?? "restricted",
    status: input.status ?? "connected",
    policy: input.policy ?? {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function withRemoteMcpHttpServer<T>(
  handler: (input: {
    message: Record<string, unknown>;
    request: http.IncomingMessage;
    response: http.ServerResponse;
  }) => void,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "DELETE") {
        response.writeHead(405).end();
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const message = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      handler({ message, request, response });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Remote MCP test server did not bind to a TCP port.");
    }
    return await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const MCP_TEST_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        { name: "browser.navigate", description: "Navigate browser page" },
        { name: "browser.extract", description: "Extract browser content" },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      structuredContent: {
        url: message.params.arguments.url,
        finalUrl: message.params.arguments.url,
        status: 200,
        title: "Example title",
        textSnippet: "Example page content",
      },
    });
  }
});
`;

const MCP_SLOW_CALL_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    setTimeout(() => {
      reply(message.id, {
        structuredContent: {
          url: message.params.arguments.url,
          finalUrl: message.params.arguments.url,
          status: 200,
        },
      });
    }, 100);
  }
});
`;

const MCP_ENV_ECHO_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      structuredContent: {
        allowed: process.env.MCP_TEST_TOKEN || null,
        lowercase: process.env.mcp_lowercase_token || null,
        assigned: process.env["MCP_TOKEN=value"] || null,
      },
    });
  }
});
`;

const MCP_EXPIRED_SESSION_ONCE_SCRIPT = String.raw`
const fs = require("node:fs");
const statePath = process.argv[1];
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "test-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(statePath, "expired");
      reply(message.id, {
        error: {
          code: -32001,
          message: "expired session",
          data: {
            phase: "pre_dispatch",
            retrySafe: true,
          },
        },
      });
      return;
    }
    reply(message.id, {
      result: {
        structuredContent: { ok: true },
      },
    });
  }
});
`;

const MCP_AMBIGUOUS_MUTATION_ERROR_SCRIPT = String.raw`
const fs = require("node:fs");
const statePath = process.argv[1];
const failureMode = process.argv[2];
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mutation-replay-test-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const previousCount = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
    fs.writeFileSync(statePath, String(previousCount + 1));
    if (failureMode === "jsonrpc-error") {
      reply(message.id, {
        error: {
          code: -32001,
          message: "expired session after mutation dispatch",
          data: {
            phase: "post_dispatch",
            retrySafe: false,
          },
        },
      });
      return;
    }
    reply(message.id, {
      result: {
        isError: true,
        content: [{ type: "text", text: "socket hang up after mutation dispatch" }],
      },
    });
  }
});
`;

const MCP_CONTENT_ITEMS_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      content: [
        { type: "resource", resource: { uri: "file:///tmp/report.json", mimeType: "application/json", text: JSON.stringify({ ok: true }) } },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "resource_link", uri: "file:///tmp/related.md", name: "Related notes", mimeType: "text/markdown" },
        { type: "audio", mimeType: "audio/wav", transcript: "operator audio transcript" },
        { type: "future_block", payload: { ok: true } },
      ],
    });
  }
});
`;

const MCP_MALFORMED_CONTENT_ITEMS_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      content: [
        { type: "image", mimeType: "image/png" },
        { type: "image_url", url: "[image placeholder]" },
        { type: "resource", resource: { mimeType: "application/pdf" } },
      ],
    });
  }
});
`;

const MCP_TOOL_ERROR_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "test-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      error: {
        code: -32000,
        message: "authorization token: secret-token-value-1234567890",
        data: {
          url: "https://user:super-secret-password@example.test",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
        },
      },
    });
  }
});
`;

const MCP_CRASH_MID_TOOL_CALL_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    // Crash without ever responding to the pending tools/call request.
    process.exit(3);
  }
});
`;

// Emits one stdout line that exceeds MCP_STDOUT_LINE_MAX_BYTES (512 KiB) before the
// real JSON-RPC reply, in a single write call so the test stays fast (no write loop).
const MCP_OVERSIZED_STDOUT_LINE_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function replyPayload(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      replyPayload(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "test-mcp", version: "1.0.0" },
      }) + "\n",
    );
    return;
  }
  if (message.method === "tools/call") {
    const oversizedLine = "y".repeat(600 * 1024);
    const validReply = replyPayload(message.id, {
      structuredContent: { ok: true, note: "reply after oversized line" },
    });
    process.stdout.write(oversizedLine + "\n" + validReply + "\n");
  }
});
`;

// Writes stderr content past MCP_STDERR_MAX_BYTES (4096) then exits without ever
// responding to the pending tools/call, so the bounded stderr buffer is echoed into
// the "exited before responding" failure message.
const MCP_STDERR_OVERFLOW_SCRIPT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/call") {
    const startMarker = "STDERR-BOUND-START-MARKER";
    const padding = "x".repeat(4096);
    const endMarker = "STDERR-BOUND-END-MARKER-SHOULD-BE-TRUNCATED";
    process.stderr.write(startMarker + padding + endMarker, () => {
      process.exit(1);
    });
  }
});
`;

describe("mcp runtime", () => {
  it("infers browser and research tool records when discovery has not populated tools yet", () => {
    const now = new Date().toISOString();
    const browserServer = {
      ...createTestServer(""),
      label: "Chrome DevTools Bridge",
      command: "npx",
      args: ["@modelcontextprotocol/server-playwright"],
      category: "browser",
      createdAt: now,
      updatedAt: now,
    };
    const researchServer = {
      ...browserServer,
      serverId: "srv-fetch",
      label: "HTTP Fetch MCP",
      command: "fetch-mcp",
      args: [],
      category: "research",
    };

    expect(inferMcpToolsForServer(browserServer, []).map((tool) => tool.toolName)).toEqual([
      "browser.search",
      "browser.navigate",
      "browser.extract",
    ]);
    expect(inferMcpToolsForServer(researchServer, []).map((tool) => tool.toolName)).toEqual([
      "browser.search",
      "browser.extract",
      "http.get",
    ]);
    expect(
      inferMcpToolsForServer(browserServer, [{ ...inferMcpToolsForServer(browserServer, [])[0]!, toolName: "custom" }]),
    ).toEqual([expect.objectContaining({ toolName: "custom" })]);
  });

  it("resolves package-manager stdio commands for Windows shims and Linux container bins", () => {
    expect(__internal.resolveSpawnCommand("npx", "win32", () => false)).toBe("npx.cmd");
    expect(__internal.resolveSpawnCommand("npm", "linux", (candidate) => candidate === "/usr/local/bin/npm")).toBe(
      "/usr/local/bin/npm",
    );
    expect(__internal.resolveSpawnCommand("pnpm", "linux", (candidate) => candidate === "/usr/local/bin/pnpm")).toBe(
      "/usr/local/bin/pnpm",
    );
    expect(__internal.resolveSpawnCommand("yarn", "linux", () => false)).toBe("yarn");
    expect(__internal.resolveSpawnCommand("node", "linux", () => false)).toBe("node");
    expect(__internal.resolveSpawnCommand("/usr/bin/npx", "linux", () => true)).toBe("/usr/bin/npx");
    expect(__internal.resolveSpawnCommand("./node_modules/.bin/mcp", "linux", () => true)).toBe(
      "./node_modules/.bin/mcp",
    );
  });

  it("wraps Windows command shims through cmd.exe for stdio MCP process launch", () => {
    const spec = __internal.resolveSpawnSpec("npx.cmd", ["--yes", "@modelcontextprotocol/server-filesystem"], "win32");

    expect(spec.command.toLowerCase()).toContain("cmd.exe");
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(spec.args[3]).toBe("npx.cmd --yes @modelcontextprotocol/server-filesystem");
    expect(__internal.resolveSpawnSpec("node", ["server.js"], "linux")).toEqual({
      command: "node",
      args: ["server.js"],
    });
  });

  it("selects approved browser fallback tools and prefers Playwright targets", () => {
    const now = new Date().toISOString();
    const baseServer = createTestServer("");
    const servers: McpServerRecord[] = [
      {
        ...baseServer,
        serverId: "chrome",
        label: "Chrome Browser",
        category: "browser",
        policy: {
          ...baseServer.policy,
          requireFirstToolApproval: true,
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        ...baseServer,
        serverId: "playwright",
        label: "Playwright MCP",
        args: ["@playwright/mcp"],
        category: "automation",
        createdAt: now,
        updatedAt: now,
      },
      {
        ...baseServer,
        serverId: "quarantined",
        label: "Quarantined Browser",
        trustTier: "quarantined",
        createdAt: now,
        updatedAt: now,
      },
    ];
    const tools = [
      { serverId: "chrome", toolName: "page.open", description: "Open a page", enabled: true, updatedAt: now },
      { serverId: "chrome", toolName: "content.read", description: "Read content", enabled: true, updatedAt: now },
      { serverId: "chrome", toolName: "web.search", description: "Find results", enabled: false, updatedAt: now },
      {
        serverId: "playwright",
        toolName: "browser.navigate",
        description: "Navigate browser",
        enabled: true,
        updatedAt: now,
      },
      {
        serverId: "playwright",
        toolName: "browser.snapshot",
        description: "Extract page snapshot",
        enabled: true,
        updatedAt: now,
      },
      { serverId: "quarantined", toolName: "browser.navigate", description: "Navigate", enabled: true, updatedAt: now },
    ];

    const targets = collectMcpBrowserFallbackTargets(
      servers,
      tools,
      (serverId, toolName) => serverId === "chrome" && toolName === "page.open",
    );

    expect(targets).toEqual([
      {
        serverId: "playwright",
        label: "Playwright MCP",
        tier: "playwright_mcp",
        navigateToolName: "browser.navigate",
        extractToolName: "browser.snapshot",
        searchToolName: undefined,
        fetchToolName: "browser.snapshot",
      },
      {
        serverId: "chrome",
        label: "Chrome Browser",
        tier: "browser_mcp",
        navigateToolName: "page.open",
        searchToolName: undefined,
        extractToolName: "page.open",
        fetchToolName: "page.open",
      },
    ]);
  });

  it("discovers tools from a stdio MCP server", async () => {
    const server = createTestServer(MCP_TEST_SCRIPT);

    const tools = await discoverMcpTools(server);

    expect(tools.map((tool) => tool.toolName)).toEqual(["browser.navigate", "browser.extract"]);
  });

  it("discovers tools from a remote streamable HTTP MCP server through the network allowlist", async () => {
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response
            .writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "remote-session-1",
            })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "remote-test", version: "1.0.0" },
                },
              }),
            );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/list") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [{ name: "remote.search", description: "Search remote docs", inputSchema: { type: "object" } }],
              },
            }),
          );
        }
      },
      async (url) => {
        const server = createRemoteTestServer(url);
        const tools = await discoverMcpTools(server, 1000, { networkAllowlist: [new URL(url).host] });

        expect(tools).toEqual([
          expect.objectContaining({
            serverId: "srv-remote",
            toolName: "remote.search",
            description: "Search remote docs",
            inputSchema: { type: "object" },
          }),
        ]);
      },
    );
  });

  it("executes a browser-capable MCP adapter through tools/call", async () => {
    const server = createTestServer(MCP_TEST_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.navigate",
      arguments: {
        url: "https://example.com/releases",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      structuredContent: {
        finalUrl: "https://example.com/releases",
        status: 200,
      },
      contentText: undefined,
    });
  });

  it("executes a remote streamable HTTP MCP tool through tools/call", async () => {
    const seenHeaders: Array<{ sessionId?: string; protocol?: string; authorization?: string }> = [];
    await withRemoteMcpHttpServer(
      ({ message, request, response }) => {
        seenHeaders.push({
          sessionId: request.headers["mcp-session-id"] as string | undefined,
          protocol: request.headers["mcp-protocol-version"] as string | undefined,
          authorization: request.headers.authorization,
        });
        if (message.method === "initialize") {
          response
            .writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "remote-session-2",
            })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "remote-test", version: "1.0.0" },
                },
              }),
            );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") {
          response.writeHead(200, { "content-type": "text/event-stream" }).end(
            [
              "event: message",
              `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text: `remote:${(message.params as { name?: string }).name}` }],
                  structuredContent: { ok: true },
                },
              })}`,
              "",
            ].join("\n"),
          );
        }
      },
      async (url) => {
        const server = createRemoteTestServer(url);
        const result = await invokeMcpRuntimeTool(
          server,
          {
            toolName: "remote.search",
            arguments: { q: "goatcitadel" },
          },
          1000,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result.ok).toBe(true);
        expect(result.output).toMatchObject({
          structuredContent: { ok: true },
          contentText: "remote:remote.search",
        });
        expect(seenHeaders.find((headers) => headers.sessionId === "remote-session-2")).toMatchObject({
          protocol: "2025-06-18",
        });
      },
    );
  });

  it("does not replay an ambiguous remote HTTP MCP mutation", async () => {
    let toolCallCount = 0;
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response
            .writeHead(200, { "content-type": "application/json", "mcp-session-id": "remote-mutation-session" })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "remote-mutation-test", version: "1.0.0" },
                },
              }),
            );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") {
          toolCallCount += 1;
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32001,
                message: "stale session after remote mutation dispatch",
                data: { phase: "post_dispatch", retrySafe: false },
              },
            }),
          );
        }
      },
      async (url) => {
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          { toolName: "external.create_record", arguments: { title: "create once" } },
          1000,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result).toMatchObject({
          ok: false,
          externalOutcome: "unknown_after_send",
          manualReconciliationRequired: true,
          retrySafe: false,
          failurePhase: "post_dispatch",
        });
        expect(toolCallCount).toBe(1);
        expect(result.retryCount).toBeUndefined();
      },
    );
  });

  it("rejects oversized remote MCP JSON responses without echoing response bodies", async () => {
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                oversized: `secret-token-value-${"x".repeat(__internal.MCP_HTTP_RESPONSE_BODY_MAX_BYTES)}`,
              },
            }),
          );
          return;
        }
        response.writeHead(202).end();
      },
      async (url) => {
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          {
            toolName: "remote.search",
            arguments: {},
          },
          1000,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("exceeded");
        expect(result.error).not.toContain("secret-token-value");
      },
    );
  });

  it("rejects oversized remote MCP SSE responses without unbounded buffering", async () => {
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
        response.write(`data: ${"x".repeat(__internal.MCP_HTTP_RESPONSE_BODY_MAX_BYTES)}\n\n`);
        response.end();
      },
      async (url) => {
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          {
            toolName: "remote.search",
            arguments: {},
          },
          1000,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("exceeded");
      },
    );
  });

  it("returns the matching remote MCP SSE response without waiting for stream close", async () => {
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          [
            "event: message",
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: "kept-open stream matched" }],
              },
            })}`,
            "",
          ].join("\n"),
        );
        response.write("\n");
      },
      async (url) => {
        const startedAt = Date.now();
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          {
            toolName: "remote.search",
            arguments: {},
          },
          1000,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result.ok).toBe(true);
        expect(result.output).toMatchObject({
          contentText: "kept-open stream matched",
        });
        expect(Date.now() - startedAt).toBeLessThan(1000);
      },
    );
  });

  it("times out reading a stalled remote MCP HTTP response body instead of hanging", async () => {
    // Plain JSON content-type (not text/event-stream) so this drives through
    // readHttpResponseText -> readBoundedResponseText's body-read deadline.
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        // Send headers plus a partial, never-terminated JSON body, then stall
        // forever: no further writes, no response.end().
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"jsonrpc":"2.0","id":1,"result":{"partial":true');
      },
      async (url) => {
        const startedAt = Date.now();
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          {
            toolName: "remote.search",
            arguments: {},
          },
          300,
          { networkAllowlist: [new URL(url).host] },
        );
        const elapsedMs = Date.now() - startedAt;

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Timed out reading");
        // Bounded by the deadline, not left hanging indefinitely.
        expect(elapsedMs).toBeLessThan(5000);
      },
    );
  });

  it("surfaces the typed timeout error when a remote MCP SSE response stalls mid-stream", async () => {
    await withRemoteMcpHttpServer(
      ({ message, response }) => {
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
        // Stall: never deliver the matching JSON-RPC response and never end the stream.
      },
      async (url) => {
        const startedAt = Date.now();
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          {
            toolName: "remote.search",
            arguments: {},
          },
          500,
          { networkAllowlist: [new URL(url).host] },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Timed out reading MCP HTTP response body");
        expect(Date.now() - startedAt).toBeLessThan(3000);
      },
    );
  });

  it("injects resolved OAuth bearer tokens into remote MCP HTTP calls without echoing secrets", async () => {
    const seenAuthorizations: Array<string | undefined> = [];
    await withRemoteMcpHttpServer(
      ({ message, request, response }) => {
        seenAuthorizations.push(request.headers.authorization);
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "remote-oauth-test", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: "oauth remote ok" }],
                structuredContent: { ok: true },
              },
            }),
          );
        }
      },
      async (url) => {
        const oauthToken = "oauth-access-token-secret-1234567890";
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url, { authType: "oauth2" }),
          {
            toolName: "remote.search",
            arguments: { q: "goatcitadel" },
          },
          1000,
          {
            networkAllowlist: [new URL(url).host],
            oauthAccessTokenResolver: async () => oauthToken,
          },
        );

        expect(result).toMatchObject({
          ok: true,
          output: {
            structuredContent: { ok: true },
            contentText: "oauth remote ok",
          },
        });
        expect(seenAuthorizations).toContain(`Bearer ${oauthToken}`);
        expect(JSON.stringify(result)).not.toContain(oauthToken);
      },
    );
  });

  it("aborts a slow MCP tool call when the signal fires", async () => {
    const server = createTestServer(MCP_SLOW_CALL_SCRIPT);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.navigate",
      arguments: {
        url: "https://example.com/releases",
      },
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("reconnects once when a stdio MCP server explicitly rejects the call before dispatch", async () => {
    const statePath = path.join(os.tmpdir(), `goatcitadel-mcp-expired-${Date.now()}.txt`);
    try {
      const server = createTestServer(MCP_EXPIRED_SESSION_ONCE_SCRIPT, [statePath]);

      const result = await invokeMcpRuntimeTool(server, {
        toolName: "browser.navigate",
        arguments: {
          url: "https://example.com/releases",
        },
      });

      expect(result.ok).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.output).toMatchObject({
        structuredContent: { ok: true },
        degradedReason: "expired_session_reconnect",
      });
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it.each([
    { failureMode: "jsonrpc-error", expectedError: "expired session after mutation dispatch" },
    { failureMode: "tool-result", expectedError: "socket hang up after mutation dispatch" },
  ])(
    "does not replay a mutating MCP tool when its $failureMode reports an ambiguous stale transport error",
    async ({ failureMode, expectedError }) => {
      const statePath = path.join(os.tmpdir(), `goatcitadel-mcp-ambiguous-mutation-${failureMode}-${Date.now()}.txt`);
      try {
        const server = createTestServer(MCP_AMBIGUOUS_MUTATION_ERROR_SCRIPT, [statePath, failureMode]);

        const result = await invokeMcpRuntimeTool(server, {
          toolName: "external.create_record",
          arguments: {
            title: "must be created at most once",
          },
        });

        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining(expectedError),
          externalOutcome: "unknown_after_send",
          manualReconciliationRequired: true,
        });
        expect.soft(result.retryCount).toBeUndefined();
        expect.soft(result.degraded).not.toBe(true);
        expect.soft(fs.readFileSync(statePath, "utf8")).toBe("1");
      } finally {
        fs.rmSync(statePath, { force: true });
      }
    },
  );

  it("normalizes MCP content items into model-safe text, image, and error blocks", async () => {
    const server = createTestServer(MCP_CONTENT_ITEMS_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.extract",
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(result.contentItems).toEqual([
      {
        type: "text",
        text: [
          "MCP resource content",
          "uri: file:///tmp/report.json",
          "mimeType: application/json",
          'text: {"ok":true}',
        ].join("\n"),
      },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        url: undefined,
        resourceUri: undefined,
        name: undefined,
      },
      {
        type: "text",
        text: [
          "MCP resource link",
          "uri: file:///tmp/related.md",
          "name: Related notes",
          "mimeType: text/markdown",
        ].join("\n"),
      },
      {
        type: "text",
        text: ["MCP audio content", "mimeType: audio/wav", "transcript: operator audio transcript"].join("\n"),
      },
      {
        type: "text",
        text: 'MCP future_block content: {"type":"future_block","payload":{"ok":true}}',
      },
    ]);
    expect(result.output).toMatchObject({
      contentText: expect.stringContaining("MCP resource content"),
      content: result.contentItems,
    });
  });

  it("quarantines malformed MCP media and resource placeholders as operator-visible errors", async () => {
    const server = createTestServer(MCP_MALFORMED_CONTENT_ITEMS_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.extract",
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(result.contentItems).toEqual([
      {
        type: "error",
        text: "MCP image content item was quarantined because it did not include persisted media data or an accessible artifact reference.",
      },
      {
        type: "error",
        text: "MCP image content item was quarantined because it did not include persisted media data or an accessible artifact reference.",
      },
      {
        type: "error",
        text: "MCP resource content item was quarantined because it did not include persisted content or an accessible artifact reference.",
      },
    ]);
  });

  it("keeps missing remote URL and missing-command invocation failures structured", async () => {
    await expect(
      invokeMcpRuntimeTool(
        {
          ...createTestServer(""),
          transport: "http",
          command: undefined,
          args: undefined,
          url: undefined,
        },
        { toolName: "browser.navigate", arguments: {} },
      ),
    ).resolves.toMatchObject({
      ok: false,
      output: {
        transport: "http",
        liveness: "missing_url",
      },
      error: "MCP HTTP URL is missing.",
    });

    await expect(
      invokeMcpRuntimeTool(
        {
          ...createTestServer(""),
          command: "  ",
        },
        { toolName: "browser.navigate", arguments: {} },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "MCP stdio command is missing.",
    });

    const spawnFailure = await invokeMcpRuntimeTool(
      {
        ...createTestServer(""),
        command: "missing-secret-token-value-1234567890-mcp",
        args: ["--token", "secret-token-value-1234567890"],
      },
      { toolName: "browser.navigate", arguments: {} },
      250,
    );
    expect(spawnFailure.ok).toBe(false);
    expect(spawnFailure.error).toContain("MCP stdio request failed");
    expect(spawnFailure.error).not.toContain("secret-token-value");
  });

  it("blocks remote MCP invocation when the endpoint is not network-allowlisted", async () => {
    await withRemoteMcpHttpServer(
      ({ response }) => {
        response.writeHead(500).end("should not be reached");
      },
      async (url) => {
        const result = await invokeMcpRuntimeTool(
          createRemoteTestServer(url),
          { toolName: "remote.search", arguments: {} },
          1000,
          { networkAllowlist: [] },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Private");
        expect(result.error).toContain("blocked");
      },
    );
  });

  it("redacts provider secrets from MCP tool error payloads", async () => {
    const result = await invokeMcpRuntimeTool(createTestServer(MCP_TOOL_ERROR_SCRIPT), {
      toolName: "browser.navigate",
      arguments: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("token: [REDACTED]");
    expect(result.error).toContain("[REDACTED]@example.test");
    expect(result.error).toContain("[REDACTED]");
    expect(result.error).not.toContain("secret-token-value");
    expect(result.error).not.toContain("super-secret-password");
    expect(result.error).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("passes only sanitized MCP allowed env keys to stdio children", async () => {
    const previousAllowed = process.env.MCP_TEST_TOKEN;
    const previousLowercase = process.env.mcp_lowercase_token;
    try {
      process.env.MCP_TEST_TOKEN = "allowed-token";
      process.env.mcp_lowercase_token = "lowercase-token";
      const result = await invokeMcpRuntimeTool(
        {
          ...createTestServer(MCP_ENV_ECHO_SCRIPT),
          policy: {
            ...createTestServer("").policy,
            allowedEnvKeys: ["MCP_TEST_TOKEN", " mcp_lowercase_token ", "MCP_TOKEN=value"],
          },
        },
        { toolName: "browser.navigate", arguments: {} },
      );

      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({
        structuredContent: {
          allowed: "allowed-token",
          lowercase: null,
          assigned: null,
        },
      });
    } finally {
      if (previousAllowed === undefined) {
        delete process.env.MCP_TEST_TOKEN;
      } else {
        process.env.MCP_TEST_TOKEN = previousAllowed;
      }
      if (previousLowercase === undefined) {
        delete process.env.mcp_lowercase_token;
      } else {
        process.env.mcp_lowercase_token = previousLowercase;
      }
    }
  });

  it("rejects the pending tools/call and raises no unhandled rejections when the MCP child crashes mid-invoke", async () => {
    // Guard against the shutdown-rejection class: a crash-triggered rejectAll
    // must be caught by the normal await chain, never surface as a process-level
    // unhandled rejection. Add our own listener (never remove vitest's own).
    const unhandledReasons: unknown[] = [];
    const trackUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", trackUnhandledRejection);
    try {
      const server = createTestServer(MCP_CRASH_MID_TOOL_CALL_SCRIPT);

      const result = await invokeMcpRuntimeTool(server, {
        toolName: "browser.navigate",
        arguments: {
          url: "https://example.com/releases",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("exited before responding");
      expect(result.error).toContain("code=3");

      // Give the event loop a turn so any straggling unhandled rejection would
      // have surfaced before we assert the tracker stayed empty.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", trackUnhandledRejection);
    }
  });

  it("discards an oversized stdout line without corrupting the JSON-RPC stream", async () => {
    const server = createTestServer(MCP_OVERSIZED_STDOUT_LINE_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.navigate",
      arguments: {
        url: "https://example.com/releases",
      },
    });

    // The oversized line (> MCP_STDOUT_LINE_MAX_BYTES) is silently discarded;
    // the well-formed reply line that follows it is still parsed and resolved.
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      structuredContent: { ok: true, note: "reply after oversized line" },
    });
  });

  it("bounds stderr diagnostics echoed into the exit failure message to MCP_STDERR_MAX_BYTES", async () => {
    const server = createTestServer(MCP_STDERR_OVERFLOW_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.navigate",
      arguments: {
        url: "https://example.com/releases",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited before responding");
    // Marker written within the first 4 KiB survives the bounded stderr buffer.
    expect(result.error).toContain("STDERR-BOUND-START-MARKER");
    // Marker written past the 4 KiB cap must never appear in the echoed diagnostics.
    expect(result.error).not.toContain("STDERR-BOUND-END-MARKER-SHOULD-BE-TRUNCATED");
  });

  it("returns a structured failure instead of hanging when the MCP stdio command cannot be spawned", async () => {
    const server: McpServerRecord = {
      ...createTestServer(""),
      command: "definitely-not-a-real-binary-goatcitadel-test",
      args: [],
    };

    const startedAt = Date.now();
    const result = await invokeMcpRuntimeTool(server, { toolName: "browser.navigate", arguments: {} }, 1500);
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("MCP stdio request failed");
    // Structured, attributable failure: either the spawn ENOENT error event fires
    // (the expected channel for a plain, extension-less command name) or -- on a
    // host/path that routes the launch through a shell -- the child exits
    // immediately and surfaces as a non-zero "exited before responding" close.
    // Either channel is acceptable; a silent hang is not.
    expect(result.error).toMatch(/enoent|exited before responding/i);
    // Resolved well inside the timeout budget -- proves this failed structurally
    // rather than waiting out the timeout.
    expect(elapsedMs).toBeLessThan(1200);
  });
});

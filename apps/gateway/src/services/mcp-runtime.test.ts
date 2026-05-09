import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { discoverMcpTools, invokeMcpRuntimeTool } from "./mcp-runtime.js";

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
      ],
    });
  }
});
`;

describe("mcp runtime", () => {
  it("discovers tools from a stdio MCP server", async () => {
    const server = createTestServer(MCP_TEST_SCRIPT);

    const tools = await discoverMcpTools(server);

    expect(tools.map((tool) => tool.toolName)).toEqual(["browser.navigate", "browser.extract"]);
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

  it("reconnects once when a stdio MCP tool reports an expired session", async () => {
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

  it("normalizes resource and image MCP content items without flattening resources into text", async () => {
    const server = createTestServer(MCP_CONTENT_ITEMS_SCRIPT);

    const result = await invokeMcpRuntimeTool(server, {
      toolName: "browser.extract",
      arguments: {},
    });

    expect(result.ok).toBe(true);
    expect(result.contentItems).toEqual([
      {
        type: "resource",
        uri: "file:///tmp/report.json",
        mimeType: "application/json",
        text: '{"ok":true}',
        blob: undefined,
        name: undefined,
      },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        url: undefined,
        resourceUri: undefined,
        name: undefined,
      },
    ]);
  });
});

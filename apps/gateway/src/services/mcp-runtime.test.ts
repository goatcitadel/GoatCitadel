import fs from "node:fs";
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
    expect(__internal.resolveSpawnCommand("node", "linux", () => false)).toBe("node");
    expect(__internal.resolveSpawnCommand("/usr/bin/npx", "linux", () => true)).toBe("/usr/bin/npx");
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

  it("keeps non-stdio and missing-command invocation failures structured", async () => {
    await expect(
      invokeMcpRuntimeTool(
        {
          ...createTestServer(""),
          transport: "http",
          url: "https://mcp.example.test",
        },
        { toolName: "browser.navigate", arguments: {} },
      ),
    ).resolves.toMatchObject({
      ok: false,
      output: {
        transport: "http",
        liveness: "url_configured",
      },
      contentItems: [
        {
          type: "error",
          text: expect.stringContaining("HTTP"),
        },
      ],
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
  });

  it("redacts provider secrets from MCP tool error payloads", async () => {
    const result = await invokeMcpRuntimeTool(createTestServer(MCP_TOOL_ERROR_SCRIPT), {
      toolName: "browser.navigate",
      arguments: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("token=[REDACTED]");
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
});

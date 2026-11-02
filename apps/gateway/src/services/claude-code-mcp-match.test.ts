import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { matchClaudeCodeMcpServer, normalizeMcpAddress } from "./claude-code-mcp-match.js";
import { findInstallableConnectorTemplate } from "./connector-install-change-plan-adapter.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

const LEARN = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "microsoft-learn")!;
const NOT_LISTED = "This app isn't in GoatCitadel's connector list. Add it yourself in Connectors.";

function entry(config: unknown, name = "docs") {
  return { name, definedIn: ".mcp.json", config };
}

const KEYED: McpServerTemplateRecord = {
  ...LEARN,
  templateId: "keyed-app",
  label: "Keyed App",
  url: "https://mcp.keyed.example/mcp",
  authType: "token",
};

describe("matchClaudeCodeMcpServer", () => {
  it("matches an exact remote address to its template", () => {
    expect(LEARN.transport).toBe("http");
    expect(matchClaudeCodeMcpServer(entry({ type: "http", url: LEARN.url }), MCP_SERVER_TEMPLATES)).toEqual({
      kind: "matched",
      templateId: "microsoft-learn",
      label: LEARN.label,
      dropsOwnSignIn: false,
    });
  });

  it.each([
    ["a trailing slash", "https://learn.microsoft.com/api/mcp/", true],
    ["an upper-case host", "https://LEARN.Microsoft.com/api/mcp", true],
    ["a query string", "https://learn.microsoft.com/api/mcp?x=1", false],
    ["a different path", "https://learn.microsoft.com/api/other", false],
    ["http:", "http://learn.microsoft.com/api/mcp", false],
    ["a user in the URL", "https://me@learn.microsoft.com/api/mcp", false],
    ["a non-default port", "https://learn.microsoft.com:8443/api/mcp", false],
  ])("compares an address with %s", (_label, url, matches) => {
    const match = matchClaudeCodeMcpServer(entry({ type: "http", url }), MCP_SERVER_TEMPLATES);
    expect(match).toEqual(
      matches
        ? { kind: "matched", templateId: "microsoft-learn", label: LEARN.label, dropsOwnSignIn: false }
        : { kind: "left_out", reason: NOT_LISTED },
    );
  });

  it("leaves out a stdio server, including one that runs the plugin's own code", () => {
    const reason = "A local server, which would run a program. Plugins run no code.";
    for (const config of [
      { command: "bun", args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "start"] },
      { type: "stdio", command: "npx", args: ["some-server"] },
      { type: "http", url: LEARN.url, command: "node" },
    ]) {
      expect(matchClaudeCodeMcpServer(entry(config), MCP_SERVER_TEMPLATES)).toEqual({ kind: "left_out", reason });
    }
  });

  it("leaves out an address with a variable", () => {
    expect(
      matchClaudeCodeMcpServer(entry({ type: "http", url: "https://${HOST}/api/mcp" }), MCP_SERVER_TEMPLATES),
    ).toEqual({
      kind: "left_out",
      reason: "Its address uses a value GoatCitadel can't fill in, so it can't be matched to a connector.",
    });
  });

  it("leaves out a matched template that needs an API key, with its own line", () => {
    const templates = [KEYED];
    const refusal = findInstallableConnectorTemplate(templates, "keyed-app");
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(matchClaudeCodeMcpServer(entry({ type: "http", url: KEYED.url }), templates)).toEqual({
      kind: "left_out",
      reason: refusal.message,
    });
  });

  it("says when the plugin's own sign-in settings are dropped", () => {
    for (const extra of [
      { headers: { Authorization: "Bearer x" } },
      { headersHelper: "./h.sh" },
      { oauth: {} },
      { env: { A: "1" } },
    ]) {
      expect(
        matchClaudeCodeMcpServer(entry({ type: "http", url: LEARN.url, ...extra }), MCP_SERVER_TEMPLATES),
      ).toMatchObject({ kind: "matched", dropsOwnSignIn: true });
    }
  });

  it("leaves out an entry without a type", () => {
    expect(matchClaudeCodeMcpServer(entry({ url: LEARN.url }), MCP_SERVER_TEMPLATES)).toEqual({
      kind: "left_out",
      reason: "It doesn't say how it connects.",
    });
  });

  it("leaves out an entry it can't read", () => {
    const reason = "It isn't a server GoatCitadel can read.";
    expect(matchClaudeCodeMcpServer(entry("nope"), MCP_SERVER_TEMPLATES)).toEqual({ kind: "left_out", reason });
    expect(matchClaudeCodeMcpServer(entry({ type: "ws", url: LEARN.url }), MCP_SERVER_TEMPLATES)).toEqual({
      kind: "left_out",
      reason,
    });
  });

  it("never matches a template of another transport", () => {
    expect(matchClaudeCodeMcpServer(entry({ type: "sse", url: LEARN.url }), MCP_SERVER_TEMPLATES)).toEqual({
      kind: "left_out",
      reason: NOT_LISTED,
    });
  });
});

describe("normalizeMcpAddress", () => {
  it("keeps https only, a lower-case host and a path without a trailing slash", () => {
    expect(normalizeMcpAddress("https://Example.COM:443/a/b/")).toBe("https://example.com/a/b");
    expect(normalizeMcpAddress("https://example.com/")).toBe("https://example.com");
    expect(normalizeMcpAddress("https://example.com/a#frag")).toBeUndefined();
    expect(normalizeMcpAddress("https://example.com/a?")).toBeUndefined();
    expect(normalizeMcpAddress("not a url")).toBeUndefined();
  });
});

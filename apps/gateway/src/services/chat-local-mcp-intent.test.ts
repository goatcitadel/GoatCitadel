import { describe, expect, it } from "vitest";
import { isExplicitLocalMcpTask } from "./chat-local-mcp-intent.js";

describe("local MCP intent", () => {
  it.each([
    "Use mcp.invoke to capture the current local fixture page. Do not search the web or navigate.",
    "Use mcp_invoke for http://127.0.0.1:1234/ and inspect its heading.",
    "Use mcp.invoke for http://[::1]:1234/.",
  ])("keeps explicit local MCP work out of automatic public lookup: %s", (prompt) => {
    expect(isExplicitLocalMcpTask(prompt)).toBe(true);
  });
  it.each([
    "Use mcp.invoke to inspect the public website.",
    "Find the current local weather.",
    "Use mcp.invoke for a local report about https://example.com.",
    "Use mcp.invoke locally and browser.search for local weather.",
    "Use mcp.invoke to inspect http://localhost.example.com.",
    "Use mcp.invoke to inspect http://localhost@remote.example.com.",
  ])("preserves lookup classification for other requests: %s", (prompt) => {
    expect(isExplicitLocalMcpTask(prompt)).toBe(false);
  });
});

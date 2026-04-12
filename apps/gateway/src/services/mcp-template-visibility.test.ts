import { describe, expect, it } from "vitest";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";
import { isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";

describe("mcp template visibility", () => {
  it("keeps local stdio templates visible for the 1.0 surface", () => {
    expect(
      isVisibleMcpTemplateRecord({
        transport: "stdio",
        url: undefined,
      }),
    ).toBe(true);
  });

  it("keeps the internal approval inbox visible even though it is not stdio", () => {
    expect(
      isVisibleMcpTemplateRecord({
        transport: "http",
        url: MCP_APPROVAL_INBOX_URL,
      }),
    ).toBe(true);
  });

  it("hides generic remote MCP transports from the visible 1.0 template library", () => {
    expect(
      isVisibleMcpTemplateRecord({
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
      }),
    ).toBe(false);
    expect(
      isVisibleMcpTemplateRecord({
        transport: "sse",
        url: "https://example.test/mcp/sse",
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  MCP_APPROVAL_INBOX_ELICITATION_LIST_TOOL_NAME,
  MCP_APPROVAL_INBOX_ELICITATION_RESPOND_TOOL_NAME,
  MCP_APPROVAL_INBOX_URL,
} from "./mcp-approval-inbox.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { isAllowedMcpDefinitionForCreate, isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";

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

  it("allows all default internal approval inbox tools it advertises", () => {
    const template = MCP_SERVER_TEMPLATES.find((item) => item.templateId === "approval-inbox");

    expect(template?.policy.allowedToolPatterns).toEqual(
      expect.arrayContaining([
        "goatcitadel.approval.remote_action_inbox.*",
        MCP_APPROVAL_INBOX_ELICITATION_LIST_TOOL_NAME,
        MCP_APPROVAL_INBOX_ELICITATION_RESPOND_TOOL_NAME,
      ]),
    );
  });

  it("shows remote MCP definitions when the runtime bridge can invoke them", () => {
    expect(
      isVisibleMcpTemplateRecord({
        transport: "http",
        url: "https://learn.microsoft.com/api/mcp",
        authType: "none",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
        },
      }),
    ).toBe(true);
    expect(
      isVisibleMcpTemplateRecord({
        transport: "sse",
        url: "https://example.test/mcp/sse",
        authType: "token",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "strict",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
          allowedEnvKeys: ["EXAMPLE_MCP_TOKEN"],
        },
      }),
    ).toBe(true);
  });

  it("keeps unsupported remote MCP auth behind an explicit experimental flag", () => {
    const remoteDefinition = {
      transport: "http" as const,
      url: "https://api.githubcopilot.com/mcp/",
      authType: "oauth2" as const,
    };

    expect(isAllowedMcpDefinitionForCreate(remoteDefinition, {})).toBe(false);
    expect(
      isAllowedMcpDefinitionForCreate(remoteDefinition, { GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS: "true" }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { hasMcpOAuthEndpointSource } from "@goatcitadel/contracts";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { MCP_VENDOR_SERVER_TEMPLATES } from "./mcp-vendor-server-templates.js";
import { isRuntimeSupportedMcpDefinition, isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";

describe("vendor MCP server templates", () => {
  it("keeps template ids and labels unique across the whole catalog", () => {
    const ids = MCP_SERVER_TEMPLATES.map((template) => template.templateId);
    const labels = MCP_SERVER_TEMPLATES.map((template) => template.label.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(MCP_VENDOR_SERVER_TEMPLATES.map((template) => [template.templateId, template] as const))(
    "%s is a governed, disabled, HTTPS vendor endpoint with provenance",
    (_id, template) => {
      const url = new URL(template.url!);
      expect(url.protocol).toBe("https:");
      expect(url.username + url.password + url.hash).toBe("");
      expect(template.networkHosts).toEqual([url.host]);
      expect(template.trustTier).toBe("restricted");
      expect(template.enabledByDefault).toBe(false);
      expect(template.policy.requireFirstToolApproval).toBe(true);
      expect(template.policy.redactionMode).toBe("strict");
      expect(template.provenance).toMatchObject({ catalog: "hermes-agent/optional-mcps", catalogLicense: "MIT" });
      expect(template.provenance?.documentationUrl).toMatch(/^https:\/\//u);
      if (template.authType === "oauth2") {
        expect(template.oauth).toEqual({ metadataDiscovery: true });
        expect(hasMcpOAuthEndpointSource(template.oauth)).toBe(true);
      }
      expect(isRuntimeSupportedMcpDefinition(template)).toBe(true);
      expect(isVisibleMcpTemplateRecord(template)).toBe(true);
    },
  );

  it("carries a risk note on every money-moving server", () => {
    for (const id of ["robinhood", "paypal", "square", "plaid", "rentahuman", "stripe"]) {
      const template = MCP_SERVER_TEMPLATES.find((item) => item.templateId === id);
      expect(template?.riskNotes?.length, id).toBeGreaterThan(0);
    }
  });

  it("marks exactly the money-moving servers, so their changes can't be set to run on their own", () => {
    const marked = MCP_SERVER_TEMPLATES.filter((template) => template.movesMoney === true).map(
      (template) => template.templateId,
    );
    expect(marked.sort()).toEqual(["paypal", "plaid", "rentahuman", "robinhood", "square", "stripe"]);
    // The flag is only ever true; every other template leaves it out.
    expect(MCP_SERVER_TEMPLATES.filter((template) => "movesMoney" in template)).toHaveLength(marked.length);
  });

  it("does not ship any xAI or X surface", () => {
    const text = JSON.stringify(MCP_SERVER_TEMPLATES).toLowerCase();
    expect(text).not.toMatch(/\bxai\b|\bgrok\b|api\.x\.com|twitter/u);
  });
});

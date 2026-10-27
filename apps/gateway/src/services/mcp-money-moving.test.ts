import { describe, expect, it } from "vitest";
import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { isMoneyMovingCatalogServer, isMoneyMovingMcpServer, mcpServerLabelKey } from "./mcp-money-moving.js";

const PAY: Pick<McpServerTemplateRecord, "label" | "networkHosts" | "movesMoney"> = {
  label: "PayPal",
  networkHosts: ["mcp.paypal.com"],
  movesMoney: true,
};
const DOCS: Pick<McpServerTemplateRecord, "label" | "networkHosts" | "movesMoney"> = {
  label: "Docs",
  networkHosts: ["mcp.docs.example"],
};

describe("isMoneyMovingMcpServer", () => {
  it.each([
    ["the template's host under another name", { label: "My wallet", url: "https://mcp.paypal.com/sse" }, true],
    ["the template's host on a different port", { label: "Wallet", url: "https://mcp.paypal.com:8443/sse" }, true],
    ["the template's host with a trailing dot", { label: "Wallet", url: "https://MCP.PayPal.com./sse" }, true],
    ["the template's label at another host", { label: "paypal", url: "https://proxy.example/mcp" }, true],
    ["the template's label with no endpoint", { label: "PayPal" }, true],
    ["another host and label", { label: "Docs", url: "https://mcp.docs.example/mcp" }, false],
    ["a subdomain of the money host", { label: "Wallet", url: "https://evil.mcp.paypal.com.example/sse" }, false],
    ["an endpoint that can't be read", { label: "Wallet", url: "not a url" }, false],
  ] as const)("matches %s: %s", (_label, server, moves) => {
    expect(isMoneyMovingMcpServer(server, [PAY, DOCS])).toBe(moves);
  });

  it("only counts templates marked as moving money", () => {
    expect(isMoneyMovingMcpServer({ label: "Docs", url: "https://mcp.docs.example/mcp" }, [PAY, DOCS])).toBe(false);
    expect(isMoneyMovingMcpServer({ label: "PayPal", url: "https://mcp.paypal.com/sse" }, [DOCS])).toBe(false);
  });

  it.each([
    ["Stripe", "https://mcp.stripe.com"],
    ["PayPal", "https://mcp.paypal.com/sse"],
    ["Plaid", "https://api.dashboard.plaid.com/mcp/"],
    ["RentAHuman", "https://rentahuman.ai/api/mcp"],
    ["Robinhood", "https://agent.robinhood.com/mcp/trading"],
    ["Square", "https://mcp.squareup.com/sse"],
  ])("recognises a renamed %s server from the shipped catalog by its host", (_name, url) => {
    expect(isMoneyMovingMcpServer({ label: "Renamed", url }, MCP_SERVER_TEMPLATES)).toBe(true);
  });

  it("leaves other shipped connectors alone", () => {
    expect(isMoneyMovingMcpServer({ label: "Linear", url: "https://mcp.linear.app/mcp" }, MCP_SERVER_TEMPLATES)).toBe(
      false,
    );
  });
});

describe("isMoneyMovingCatalogServer", () => {
  it("asks the whole shipped catalog, so every template marked as moving money counts", () => {
    const marked = MCP_SERVER_TEMPLATES.filter((template) => template.movesMoney === true);

    expect(marked.length).toBeGreaterThan(0);
    for (const template of marked) {
      expect(isMoneyMovingCatalogServer({ label: "Renamed", url: template.url }), template.templateId).toBe(true);
      expect(isMoneyMovingCatalogServer({ label: template.label, url: "https://proxy.example/mcp" })).toBe(true);
    }
  });

  it("leaves other shipped connectors alone", () => {
    expect(isMoneyMovingCatalogServer({ label: "Linear", url: "https://mcp.linear.app/mcp" })).toBe(false);
  });
});

describe("mcpServerLabelKey", () => {
  it("compares labels without case, the way the connector list pairs a server with its template", () => {
    expect(mcpServerLabelKey("PayPal")).toBe(mcpServerLabelKey("paypal"));
  });
});

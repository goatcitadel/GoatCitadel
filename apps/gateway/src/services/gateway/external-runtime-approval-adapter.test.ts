import { describe, expect, it } from "vitest";
import type { McpInvokeResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { toolInvokeResultFromMcpApproval } from "./external-runtime-approval-adapter.js";

describe("external runtime approval adapter", () => {
  it("does not collapse an ambiguous approved MCP mutation into a plain blocked outcome", () => {
    const policyResult: ToolInvokeResult = {
      outcome: "executed",
      policyReason: "allowed_via_approval:approval-mcp-unknown",
      auditEventId: "audit-mcp-unknown",
      result: { externalRuntime: true, toolName: "mcp.invoke" },
    };
    const mcpResult = {
      ok: false,
      error:
        "MCP tool external.create_record unknown_after_send: the tool call was dispatched, but its final outcome is unknown; manual reconciliation is required.",
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
    } as McpInvokeResponse & {
      externalOutcome: "unknown_after_send";
      manualReconciliationRequired: true;
    };

    const result = toolInvokeResultFromMcpApproval(policyResult, mcpResult);

    expect(result).toMatchObject({
      outcome: "executed",
      policyReason: expect.stringMatching(/unknown|manual reconciliation/i),
      result: {
        externalRuntime: true,
        toolName: "mcp.invoke",
        ok: false,
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
      },
    });
  });
});

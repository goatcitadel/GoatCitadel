import { describe, expect, it } from "vitest";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { knowledgeApprovalPreview } from "./knowledge-approval-preview.js";

function request(toolName: string, overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName,
    args: { namespace: "decisions", title: "Launch note", content: "Ship on Friday." },
    agentId: "agent",
    sessionId: "sess_ec930815d9b7703ea72892d8",
    workspaceId: "ws_27bfbd07d0e84b2188ade48d",
    ...overrides,
  } as ToolInvokeRequest;
}

describe("knowledgeApprovalPreview scope summary", () => {
  it.each(["memory.write", "memory.upsert", "docs.ingest", "embeddings.query"])(
    "keeps raw workspace and session ids out of the %s scope sentence",
    (toolName) => {
      const summary = String(knowledgeApprovalPreview(request(toolName))?.scopeSummary);
      expect(summary).not.toContain("ws_27bfbd07d0e84b2188ade48d");
      expect(summary).not.toContain("sess_ec930815d9b7703ea72892d8");
      expect(summary).toContain("Requested from a conversation in this workspace.");
    },
  );

  it("says when the request did not come from a conversation", () => {
    const summary = String(knowledgeApprovalPreview(request("memory.write", { sessionId: undefined }))?.scopeSummary);
    expect(summary).toContain("Requested in this workspace, outside a conversation.");
  });

  it("still carries the session id as its own field for technical details", () => {
    expect(knowledgeApprovalPreview(request("memory.write"))?.sessionId).toBe("sess_ec930815d9b7703ea72892d8");
  });
});

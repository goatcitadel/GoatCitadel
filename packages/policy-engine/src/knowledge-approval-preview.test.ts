import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ToolInvokeRequest } from "@goatcitadel/contracts";
import { knowledgeApprovalPreview, withLegacyToolApprovalPreview } from "./knowledge-approval-preview.js";

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

describe("knowledge lookup approval previews", () => {
  it.each([
    ["memory.search", "Memory namespace: all namespaces", 12],
    ["docs.search", "Knowledge namespace: all namespaces", 8],
    ["session.search", "This conversation", 10],
  ])("records the query, scope and effective limit for %s", (toolName, target, limit) => {
    expect(knowledgeApprovalPreview(request(toolName, { args: { query: "launch decisions" } }))).toMatchObject({
      reviewKind: "knowledge.operation",
      toolName,
      query: "launch decisions",
      target,
      optionsSummary: `Maximum results: ${limit}`,
    });
  });

  it("shows the actual memory read selector, even when provided as a title", () => {
    expect(
      knowledgeApprovalPreview(request("memory.read", { args: { namespace: "notes", title: "Launch note" } })),
    ).toMatchObject({ target: "Memory namespace: notes", query: "Launch note", optionsSummary: "Maximum results: 5" });
  });

  it("projects a legacy tool approval from its saved arguments and keeps the stored record intact", () => {
    const approval: ApprovalRequest = {
      approvalId: "legacy-search",
      kind: "memory.search",
      riskLevel: "safe",
      status: "pending",
      explanationStatus: "not_requested",
      createdAt: "2026-11-13T00:00:00Z",
      payload: { query: "  launch decisions  ", limit: 3 },
      preview: { toolName: "memory.search" },
      linkage: { actionType: "tool.invoke", toolName: "memory.search" },
    };
    const projected = withLegacyToolApprovalPreview(approval);
    expect(projected.preview).toMatchObject({ query: "launch decisions", optionsSummary: "Maximum results: 3" });
    expect(projected.payload).toBe(approval.payload);
    expect(approval.preview).toEqual({ toolName: "memory.search" });
    expect(withLegacyToolApprovalPreview(projected)).toBe(projected);
    const unlinked = { ...approval, linkage: undefined };
    expect(withLegacyToolApprovalPreview(unlinked)).toBe(unlinked);
    const incomplete = { ...approval, payload: {} };
    expect(withLegacyToolApprovalPreview(incomplete)).toBe(incomplete);
  });
});

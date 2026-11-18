import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ToolInvokeRequest } from "@goatcitadel/contracts";
import { knowledgeApprovalPreview, withLegacyToolApprovalPreview } from "./knowledge-approval-preview.js";

const request = (args: Record<string, unknown>): ToolInvokeRequest => ({
  toolName: "capabilities.explain",
  agentId: "assistant",
  sessionId: "session",
  args,
});

describe("capability explanation approval preview", () => {
  it("makes the read-only inspection reviewable without implying activation or approval", () => {
    expect(knowledgeApprovalPreview(request({ query: "Can you send email?", limit: 3 }))).toMatchObject({
      reviewKind: "knowledge.operation",
      toolName: "capabilities.explain",
      sessionId: "session",
      target: "Capabilities and setup status for this conversation",
      query: "Can you send email?",
      optionsSummary: "Maximum results: 3",
      summary: expect.stringContaining("Does not activate"),
    });
  });

  it("restores a missing action preview on an already persisted inspection approval", () => {
    const approval = {
      kind: "capabilities.explain",
      linkage: { actionType: "tool.invoke", toolName: "capabilities.explain" },
      payload: { query: "email" },
      preview: { toolName: "capabilities.explain", sessionId: "session" },
    } as unknown as ApprovalRequest;
    expect(withLegacyToolApprovalPreview(approval).preview).toMatchObject({
      reviewKind: "knowledge.operation",
      query: "email",
      optionsSummary: "Maximum results: 5",
    });
  });

  it.each([
    { query: "" },
    { query: "x".repeat(513) },
    { query: "email", limit: 6 },
    { query: "email", workspaceId: "other" },
  ])("withholds a preview for malformed or caller-scoped input", (args) => {
    expect(knowledgeApprovalPreview(request(args))).toBeUndefined();
  });

  it("redacts credential-like text and does not copy unknown metadata", () => {
    const preview = knowledgeApprovalPreview(request({ query: "email token=preview-secret" }));
    expect(JSON.stringify(preview)).not.toContain("preview-secret");
  });
});

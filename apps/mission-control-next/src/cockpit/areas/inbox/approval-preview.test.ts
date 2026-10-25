import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import {
  approvalExpiryLabel,
  approvalExplanationLine,
  approvalPreview,
  splitApprovalExplanation,
  splitApprovalSupport,
} from "./approval-preview";

const approval = {
  approvalId: "approval/one?two",
  kind: "tool_invoke",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: {},
  createdAt: "2026-09-28T18:00:00Z",
  explanationStatus: "not_requested",
  linkage: { sessionId: "session-1" },
} satisfies ApprovalRequest;

describe("approval preview", () => {
  it("uses canonical linkage and the native Inbox approval link", () => {
    expect(approvalPreview(approval)).toEqual({
      title: "Tool invoke",
      summary: "Review the exact request and its effects before deciding.",
      source: "Conversation",
      href: "/inbox?approvalId=approval%2Fone%3Ftwo",
    });
    expect(approvalPreview({ ...approval, linkage: { runId: "run-1" } }).source).toBe("Run");
    expect(approvalPreview({ ...approval, linkage: undefined }).source).toBe("Request");
  });

  it("uses a generated explanation when available, without making a decision", () => {
    expect(
      approvalPreview({
        ...approval,
        explanation: { summary: "Run a command", riskExplanation: "Changes files", generatedAt: approval.createdAt },
      }).summary,
    ).toBe("Run a command");
  });

  it("makes expired and unknown expiry states explicit", () => {
    const now = Date.parse("2026-09-28T18:00:00Z");
    expect(approvalExpiryLabel("2026-09-28T18:02:00Z", now)).toBe("Expires in 2 minutes");
    expect(approvalExpiryLabel("2026-09-28T17:59:00Z", now)).toBe("Expired");
    expect(approvalExpiryLabel("invalid", now)).toBeNull();
    expect(approvalExpiryLabel("2026-09-28T19:30:00Z", now)).toBe("Expires in about 2 hours");
    expect(approvalExpiryLabel("2026-09-28T18:01:00Z", now)).toBe("Expires in 1 minute");
    // IN-N09: hours round to the nearest hour, and long expiries read in days.
    expect(approvalExpiryLabel("2026-09-28T19:10:00Z", now)).toBe("Expires in about 1 hour");
    expect(approvalExpiryLabel("2026-09-30T18:00:00Z", now)).toBe("Expires in about 2 days");
  });
});

describe("approval explanation line", () => {
  it("prints exactly one sentence for every explanation state", () => {
    expect(approvalExplanationLine("  Deletes one file.  ", "completed")).toBe("Deletes one file.");
    expect(approvalExplanationLine(undefined, "failed")).toContain("could not be generated");
    expect(approvalExplanationLine("", "pending")).toContain("still being prepared");
    expect(approvalExplanationLine(undefined, "not_requested")).toContain("No explanation was requested");
  });
});

describe("approval card and preview presentation", () => {
  it("moves hashes and byte counts out of the visible preview but keeps consequences (IN-L01)", () => {
    const hash = `Content Summary: Exact original content: 136 UTF-8 bytes; SHA-256 ${"a".repeat(64)}.`;
    const consequence = "Summary: Approval permits this request. Admission is not proof of a saved document.";
    expect(splitApprovalSupport(["Title: Operator preference", hash, consequence])).toEqual({
      visible: ["Title: Operator preference", "Content size: 136 B", consequence],
      technical: [`SHA-256 ${"a".repeat(64)}.`],
    });
  });

  it("keeps decision inputs that share a line with a hash visible, and moves only the hash clause", () => {
    const mixed = `Content Summary: Exact original content: 136 UTF-8 bytes; SHA-256 ${"b".repeat(64)}. Redaction does not change approved executable arguments.`;
    expect(splitApprovalSupport([mixed])).toEqual({
      visible: ["Content size: 136 B", "Redaction does not change approved executable arguments."],
      technical: [`SHA-256 ${"b".repeat(64)}.`],
    });
  });

  it("keeps 'before redaction' on a plain content size (memory-lifecycle previews)", () => {
    expect(splitApprovalSupport(["Content Summary: Requested content: 41 UTF-8 bytes before redaction."])).toEqual({
      visible: ["Content size before redaction: 41 B"],
      technical: [],
    });
  });
});

describe("splitApprovalExplanation (#499)", () => {
  const explanation = (fields: Record<string, unknown> = {}) => ({
    summary: "Summary",
    riskExplanation: "Risk",
    generatedAt: "2026-10-24T17:30:31.000Z",
    ...fields,
  });
  const withExplanation = (kind: string, fields: Record<string, unknown> = {}) =>
    ({ kind, explanation: explanation(fields) }) as unknown as ApprovalRequest;

  it("takes a change plan's own impact, which records no model, as owner-written", () => {
    expect(splitApprovalExplanation(withExplanation("change_plan_effect")).owner?.riskExplanation).toBe("Risk");
  });

  it("treats every other explanation as model-written, even when its provider and model are missing or empty", () => {
    for (const fields of [{}, { providerId: "", model: "" }, { providerId: "claude-code-cli", model: "m" }]) {
      const split = splitApprovalExplanation(withExplanation("tool_invoke", fields));
      expect(split.owner).toBeUndefined();
      expect(split.model?.riskExplanation).toBe("Risk");
    }
    expect(splitApprovalExplanation(withExplanation("change_plan_effect", { model: "m" })).model).toBeDefined();
  });
});

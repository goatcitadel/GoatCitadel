import { describe, expect, it } from "vitest";
import { EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE, type ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

const payload = {
  workspaceId: "workspace", sessionId: "session", sessionIncarnationId: "incarnation",
  sourceId: "source", importId: "import", itemId: "item", attachmentId: "attachment", attachmentRevision: 1,
  normalizedArtifactSha256: "a".repeat(64), rawSha256: "b".repeat(64),
};
const legacy = {
  sourceId: "source", importId: "import", itemId: "item", attachmentId: "attachment",
  normalizedArtifactSha256: payload.normalizedArtifactSha256, normalizedByteCount: 1024,
};
const itemPath = `sessions/${"long-directory/".repeat(25)}work.jsonl`;
const review = {
  version: 1, sourceLabel: "Original reviewed source", itemPath,
  target: `Knowledge copy of ${itemPath} from Original reviewed source`,
  scopeSummary: "Workspace workspace; conversation session.",
  consequence: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE,
};
function approval(preview: ApprovalRequest["preview"] = { ...legacy, review }): ApprovalRequest {
  return {
    approvalId: "approval", kind: "external_source.knowledge_snapshot", status: "pending", riskLevel: "danger",
    payload, preview, linkage: { workspaceId: "workspace", sessionId: "session" },
    createdAt: "2026-10-01T00:00:00.000Z", explanationStatus: "not_requested",
  };
}

describe("exact external-source Knowledge approval evidence", () => {
  it("renders the original full readable target/scope/consequences, with immutable provenance as secondary evidence", () => {
    const record = approval();
    const before = JSON.stringify(record);
    const model = buildApprovalRequestReviewEvidenceModel(record)!;
    expect(model.targets).toEqual([review.target]);
    expect(model.scopeSummary).toBe(review.scopeSummary);
    expect(model.consequence).toBe(EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE);
    expect(model.supporting).toContain(`Imported path: ${itemPath}`);
    expect(model.changes).toEqual([]);
    expect(model.technicalDetails?.[0]?.content).toContain(`Normalized SHA-256: ${payload.normalizedArtifactSha256}`);
    expect(model.technicalDetails?.[0]?.content).toContain("Normalized bytes: 1024");
    expect(JSON.stringify(record)).toBe(before);
  });
  it("renders legacy original identifiers and scope without inventing a historical source name/path", () => {
    const model = buildApprovalRequestReviewEvidenceModel(approval(legacy))!;
    expect(model.targets).toEqual(["Knowledge copy of imported item item"]);
    expect(model.scopeSummary).toBe(review.scopeSummary);
    expect(model.supporting).toEqual(["The original approval did not record a readable source label or item path."]);
    expect(model.consequence).toBe(EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE);
  });
  it.each([
    undefined, {}, { ...legacy, itemId: "foreign" }, { ...legacy, normalizedArtifactSha256: "f".repeat(64) },
    { ...legacy, normalizedByteCount: -1 }, { ...legacy, normalizedByteCount: 1.5 },
    { ...legacy, review: { ...review, scopeSummary: "Workspace foreign; conversation session." } },
    { ...legacy, review: { ...review, target: "Different target" } },
    { ...legacy, review: { ...review, consequence: "Grant unrestricted access." } },
    { ...legacy, review: { version: 1 } }, { ...legacy, review: { ...review, version: 2 } },
    { ...legacy, targets: ["unrelated fallback must not unlock review"] },
  ])("rejects missing or contradictory original preview %j", preview => {
    const record = approval();
    record.preview = preview;
    expect(buildApprovalRequestReviewEvidenceModel(record)).toBeNull();
  });
  it("rejects missing, foreign, or mismatched original payload/linkage", () => {
    for (const record of [
      { ...approval(), payload: {} }, { ...approval(), linkage: undefined },
      { ...approval(), linkage: { workspaceId: "foreign", sessionId: "session" } },
      { ...approval(), linkage: { workspaceId: "workspace", sessionId: "foreign" } },
      { ...approval(), payload: { ...payload, normalizedArtifactSha256: "invalid" } },
    ]) expect(buildApprovalRequestReviewEvidenceModel(record)).toBeNull();
  });
});

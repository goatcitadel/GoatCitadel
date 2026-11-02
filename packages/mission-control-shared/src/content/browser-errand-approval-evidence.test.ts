import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

const approval = (preview: Record<string, unknown>): ApprovalRequest => ({
  approvalId: "approval-1",
  kind: "browser.errand.action",
  riskLevel: "caution",
  status: "pending",
  payload: {},
  preview,
  createdAt: "2026-11-01T00:00:00.000Z",
  explanationStatus: "not_requested",
});

describe("browser errand approval evidence", () => {
  it("names the step and the page address, matching the Gateway's preview", () => {
    // The Gateway sets title to the step title and summary to that title plus the step's description.
    const model = buildApprovalRequestReviewEvidenceModel(
      approval({
        summary: 'Click "Place order" — Buy the hub for $39',
        url: "https://shop.example/checkout",
        title: 'Click "Place order"',
        screenshotAttachmentId: "att-1",
        screenshotSha256: "a".repeat(64),
      }),
    );
    expect(model?.targetEntries).toEqual([
      { label: "Step", value: 'Click "Place order" — Buy the hub for $39' },
      { label: "Page", value: "https://shop.example/checkout" },
    ]);
    expect(model?.supporting).toEqual([]);
  });

  it("names the step from its title when there is no summary", () => {
    const model = buildApprovalRequestReviewEvidenceModel(approval({ title: "The page changed" }));
    expect(model?.targetEntries).toEqual([{ label: "Step", value: "The page changed" }]);
  });

  it("falls back to the generic model when the preview names no page or step", () => {
    const model = buildApprovalRequestReviewEvidenceModel(approval({ url: "https://shop.example/checkout" }));
    expect(model?.targetEntries?.some((entry) => entry.label === "Page")).not.toBe(true);
  });
});

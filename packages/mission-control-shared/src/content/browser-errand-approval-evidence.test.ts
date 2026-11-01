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
  it("names the page as the target and its address as supporting detail", () => {
    const model = buildApprovalRequestReviewEvidenceModel(
      approval({
        summary: "Click Place order",
        url: "https://shop.example/checkout",
        title: "Checkout",
        screenshotAttachmentId: "att-1",
      }),
    );
    expect(model?.targetEntries).toEqual([
      { label: "Step", value: "Click Place order" },
      { label: "Page", value: "Checkout" },
    ]);
    expect(model?.supporting).toEqual(["https://shop.example/checkout"]);
  });

  it("falls back to the generic model when the preview names no page or step", () => {
    const model = buildApprovalRequestReviewEvidenceModel(approval({ url: "https://shop.example/checkout" }));
    expect(model?.targetEntries?.some((entry) => entry.label === "Page")).not.toBe(true);
  });
});

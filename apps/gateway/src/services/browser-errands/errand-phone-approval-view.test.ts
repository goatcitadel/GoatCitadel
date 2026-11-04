import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import {
  buildErrandPhoneApprovalView,
  readErrandPhoneScreenshot,
  ERRAND_PHONE_SCREENSHOT_MAX_BYTES,
  type ErrandScreenshotReads,
} from "./errand-phone-approval-view.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");
const APPROVAL_ID = "7d1b6f8e-4f39-4d38-9a51-0a9f3c1f2b10";

function errandApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: APPROVAL_ID,
    kind: "browser.errand.action",
    status: "pending",
    riskLevel: "caution",
    payload: { category: "spend" },
    preview: {
      summary: "Place the order — Buy 2 bags of coffee for $24.98",
      url: "https://shop.example/checkout",
      title: "Place the order",
      screenshotAttachmentId: "att-before-1",
      screenshotSha256: PNG_SHA256,
    },
    linkage: { sessionId: "session-1", turnId: "turn-1", toolName: "browser_errand" },
    createdAt: "2026-11-02T12:00:00.000Z",
    ...overrides,
  } as ApprovalRequest;
}

function reads(overrides: Partial<Awaited<ReturnType<ErrandScreenshotReads["record"]>>> = {}, bytes = PNG) {
  return {
    record: vi.fn(async () => ({
      sessionId: "session-1",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256: PNG_SHA256,
      ...overrides,
    })),
    bytes: vi.fn(async () => bytes),
  } satisfies ErrandScreenshotReads;
}

describe("buildErrandPhoneApprovalView", () => {
  it("carries the plain line, the page and the approval's own spotlight screenshot", async () => {
    const screenshots = reads();
    const view = await buildErrandPhoneApprovalView(errandApproval(), screenshots);
    expect(view).toEqual({
      line: "GoatCitadel wants to: Place the order — Buy 2 bags of coffee for $24.98",
      page: "https://shop.example/checkout",
      screenshot: {
        mimeType: "image/png",
        sha256: PNG_SHA256,
        url: `/api/v1/approvals/${APPROVAL_ID}/errand-screenshot`,
      },
    });
    expect(screenshots.bytes).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain("dataBase64");
    expect(view?.line).not.toContain(APPROVAL_ID);
    expect(view?.line).not.toMatch(/att-before|session-1|turn-1|caution|browser\.errand/u);
  });

  it("is only for waiting errand approvals", async () => {
    expect(await buildErrandPhoneApprovalView(errandApproval({ kind: "tool.shell" }), reads())).toBeUndefined();
    expect(await buildErrandPhoneApprovalView(errandApproval({ status: "approved" }), reads())).toBeUndefined();
  });

  it.each([
    ["another session", { sessionId: "session-2" }],
    ["another digest", { sha256: "f".repeat(64) }],
    ["another type", { mimeType: "image/svg+xml" }],
    ["too large", { sizeBytes: ERRAND_PHONE_SCREENSHOT_MAX_BYTES + 1 }],
    ["not finite", { sizeBytes: Number.NaN }],
    ["infinite", { sizeBytes: Number.POSITIVE_INFINITY }],
    ["negative size", { sizeBytes: -1 }],
    ["fractional size", { sizeBytes: 8.5 }],
    ["empty size", { sizeBytes: 0 }],
  ])("leaves out a screenshot from %s but keeps the line", async (_label, record) => {
    const screenshots = reads(record);
    const view = await buildErrandPhoneApprovalView(errandApproval(), screenshots);
    expect(view?.line).toMatch(/^GoatCitadel wants to: /u);
    expect(view?.screenshot).toBeUndefined();
    expect(screenshots.bytes).not.toHaveBeenCalled();
  });

  it("preserves workspace scope using an encoded query and does not read bytes", async () => {
    const screenshots = reads();
    const view = await buildErrandPhoneApprovalView(errandApproval(), screenshots, "work & space/one");
    expect(view?.screenshot?.url).toBe(
      `/api/v1/approvals/${APPROVAL_ID}/errand-screenshot?workspaceId=work+%26+space%2Fone`,
    );
    expect(screenshots.bytes).not.toHaveBeenCalled();
  });

  it("leaves out a screenshot that cannot be read without leaking the read error", async () => {
    const failing: ErrandScreenshotReads = {
      record: async () => {
        throw new Error("gone");
      },
      bytes: async () => PNG,
    };
    const unreadable = await buildErrandPhoneApprovalView(errandApproval(), failing);
    expect(unreadable?.screenshot).toBeUndefined();
  });

  it("shortens a very long summary", async () => {
    const view = await buildErrandPhoneApprovalView(
      errandApproval({ preview: { summary: "x".repeat(2000) } }),
      reads(),
    );
    expect(view?.line.length).toBeLessThanOrEqual("GoatCitadel wants to: ".length + 600);
    expect(view?.line.endsWith("…")).toBe(true);
    expect(view?.screenshot).toBeUndefined();
  });
});

describe("readErrandPhoneScreenshot", () => {
  it("reads only the approval's bound attachment with the session and byte limit", async () => {
    const screenshots = reads();
    expect(await readErrandPhoneScreenshot(errandApproval(), screenshots)).toEqual(PNG);
    expect(screenshots.bytes).toHaveBeenCalledWith("att-before-1", {
      sessionId: "session-1",
      maxBytes: ERRAND_PHONE_SCREENSHOT_MAX_BYTES,
    });
  });

  it.each([
    ["another session", { sessionId: "session-2" }],
    ["another digest", { sha256: "f".repeat(64) }],
    ["another type", { mimeType: "image/svg+xml" }],
    ["too large", { sizeBytes: ERRAND_PHONE_SCREENSHOT_MAX_BYTES + 1 }],
    ["not finite", { sizeBytes: Number.NaN }],
    ["negative", { sizeBytes: -1 }],
    ["fractional", { sizeBytes: 1.5 }],
  ])("refuses metadata from %s before reading bytes", async (_label, record) => {
    const screenshots = reads(record);
    expect(await readErrandPhoneScreenshot(errandApproval(), screenshots)).toBeUndefined();
    expect(screenshots.bytes).not.toHaveBeenCalled();
  });

  it("refuses changed, oversized, mismatched-size and corrupt PNG bytes", async () => {
    expect(await readErrandPhoneScreenshot(errandApproval(), reads({}, Buffer.from("changed")))).toBeUndefined();
    expect(
      await readErrandPhoneScreenshot(
        errandApproval(),
        reads({ sizeBytes: PNG.byteLength }, Buffer.alloc(ERRAND_PHONE_SCREENSHOT_MAX_BYTES + 1)),
      ),
    ).toBeUndefined();
    expect(await readErrandPhoneScreenshot(errandApproval(), reads({ sizeBytes: PNG.byteLength + 1 }))).toBeUndefined();
    const corrupt = Buffer.from("this is not a PNG");
    const corruptHash = createHash("sha256").update(corrupt).digest("hex");
    const approval = errandApproval();
    approval.preview.screenshotSha256 = corruptHash;
    expect(await readErrandPhoneScreenshot(approval, reads({ sha256: corruptHash }, corrupt))).toBeUndefined();
  });

  it("refuses unavailable, nonpending, nonerrand and unlinked approvals", async () => {
    const screenshots = reads();
    screenshots.record.mockRejectedValueOnce(new Error("secret-path"));
    expect(await readErrandPhoneScreenshot(errandApproval(), screenshots)).toBeUndefined();
    for (const approval of [
      errandApproval({ status: "approved" }),
      errandApproval({ kind: "tool.shell" }),
      errandApproval({ linkage: undefined }),
      errandApproval({ preview: { screenshotAttachmentId: "att-before-1", screenshotSha256: "invalid" } }),
    ]) {
      expect(await readErrandPhoneScreenshot(approval, reads())).toBeUndefined();
    }
    const unreadable = reads();
    unreadable.bytes.mockRejectedValueOnce(new Error("private read failure"));
    expect(await readErrandPhoneScreenshot(errandApproval(), unreadable)).toBeUndefined();
  });
});

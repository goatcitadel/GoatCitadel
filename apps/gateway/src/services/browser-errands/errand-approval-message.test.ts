import { describe, expect, it } from "vitest";
import {
  buildErrandApprovalMessage,
  ERRAND_APPROVAL_MESSAGE_MAX_LENGTH,
  ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE,
} from "./errand-approval-message.js";

describe("buildErrandApprovalMessage", () => {
  it("asks for a tap when the conversation has buttons", () => {
    expect(
      buildErrandApprovalMessage({
        summary: "Click Buy — Places the order",
        pageUrl: "https://shop.example/cart",
        buttons: true,
      }),
    ).toBe("GoatCitadel wants to: Click Buy — Places the order\nPage: https://shop.example/cart\nTap Approve or Deny.");
  });

  it("asks for a whole-message reply when the conversation has no buttons", () => {
    expect(
      buildErrandApprovalMessage({
        summary: "Click Buy — Places the order",
        pageUrl: "https://shop.example/cart",
        buttons: false,
      }),
    ).toBe(
      "GoatCitadel wants to: Click Buy — Places the order\nPage: https://shop.example/cart\n" +
        "Reply APPROVE or DENY. Reply STOP to end the errand.",
    );
  });

  it("leaves out the page line when there is no page address", () => {
    expect(buildErrandApprovalMessage({ summary: "Click Buy", buttons: true })).toBe(
      "GoatCitadel wants to: Click Buy\nTap Approve or Deny.",
    );
  });

  it.each([true, false])(
    "shortens a long summary to 1024 characters and keeps the instruction (buttons %s)",
    (buttons) => {
      const message = buildErrandApprovalMessage({
        summary: "Fill the form ".repeat(200),
        pageUrl: "https://shop.example/checkout",
        buttons,
        notes: [ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE],
      });

      expect(message.length).toBeLessThanOrEqual(ERRAND_APPROVAL_MESSAGE_MAX_LENGTH);
      expect(message.length).toBeGreaterThan(ERRAND_APPROVAL_MESSAGE_MAX_LENGTH - 20);
      const lines = message.split("\n");
      expect(lines[0]).toMatch(/^GoatCitadel wants to: Fill the form .*…$/);
      expect(lines.slice(1)).toEqual([
        "Page: https://shop.example/checkout",
        buttons ? "Tap Approve or Deny." : "Reply APPROVE or DENY. Reply STOP to end the errand.",
        ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE,
      ]);
    },
  );

  it("fits a long summary, a long page address and the group note together", () => {
    const message = buildErrandApprovalMessage({
      summary: "Type the delivery note ".repeat(80),
      pageUrl: `https://shop.example/${"checkout/".repeat(150)}`,
      buttons: false,
      notes: [ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE],
    });

    expect(message.length).toBeLessThanOrEqual(ERRAND_APPROVAL_MESSAGE_MAX_LENGTH);
    const lines = message.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^GoatCitadel wants to: Type the delivery note .*…$/);
    expect(lines[0]!.length).toBeGreaterThanOrEqual(256);
    expect(lines[1]).toMatch(/^Page: https:\/\/shop\.example\/checkout\/.*…$/);
    expect(lines.slice(2)).toEqual([
      "Reply APPROVE or DENY. Reply STOP to end the errand.",
      ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE,
    ]);
  });

  it("never splits a surrogate pair when shortening", () => {
    const message = buildErrandApprovalMessage({ summary: "🐐".repeat(600), buttons: true });

    expect(message.length).toBeLessThanOrEqual(ERRAND_APPROVAL_MESSAGE_MAX_LENGTH);
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(message.endsWith("…\nTap Approve or Deny.")).toBe(true);
  });

  it("shortens a very long page address and keeps a short summary whole", () => {
    const message = buildErrandApprovalMessage({
      summary: "Click Buy",
      pageUrl: `https://shop.example/${"a".repeat(2000)}`,
      buttons: true,
    });

    expect(message.length).toBeLessThanOrEqual(ERRAND_APPROVAL_MESSAGE_MAX_LENGTH);
    expect(message.endsWith("…\nTap Approve or Deny.")).toBe(true);
    expect(message.startsWith("GoatCitadel wants to: Click Buy\nPage: https://shop.example/aaa")).toBe(true);
  });
});

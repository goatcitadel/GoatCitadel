import { describe, expect, it } from "vitest";
import { describeChatUiError } from "./chat-error-copy";

describe("describeChatUiError", () => {
  it("surfaces nested provider messages from API errors", () => {
    const raw =
      'API error 500: {"error":"image generation failed (500 Internal Server Error): {\\"error\\": {\\"message\\": \\"Upstream timeout while contacting the provider.\\"}}"}';

    const mapped = describeChatUiError(raw, "send");

    expect(mapped).toEqual({
      summary:
        "Upstream timeout while contacting the provider. Your prompt was kept in the composer so you can edit and resend it.",
      raw,
    });
  });

  it("explains provider policy rejections for image prompts", () => {
    const raw =
      'API error 400: {"error":"image generation failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"This prompt was rejected by policy because it references a copyrighted character.\\"}}"}';

    const mapped = describeChatUiError(raw, "image_generate");

    expect(mapped?.summary).toBe(
      "The image prompt was rejected by the provider's policy checks. Try a more original description instead of naming a copyrighted character or exact likeness. Your prompt was kept in the composer so you can edit and resend it.",
    );
    expect(mapped?.raw).toBe(raw);
  });

  it("does not attach retry guidance to approval failures", () => {
    const raw =
      'API error 400: {"error":"approval failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"Approval could not be recorded.\\"}}"}';

    const mapped = describeChatUiError(raw, "approval");

    expect(mapped).toEqual({
      summary: "Approval could not be recorded.",
      raw,
    });
  });
});

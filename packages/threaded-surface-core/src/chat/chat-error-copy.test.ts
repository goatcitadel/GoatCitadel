import { describe, expect, it } from "vitest";
import { describeChatUiError } from "./chat-error-copy";

describe("describeChatUiError", () => {
  it("surfaces nested provider messages from API errors", () => {
    const raw =
      'API error 500: {"error":"image generation failed (500 Internal Server Error): {\\"error\\": {\\"message\\": \\"Upstream timeout while contacting the provider.\\"}}"}';

    expect(describeChatUiError(raw, "send")).toEqual({
      summary:
        "Upstream timeout while contacting the provider. Your prompt was kept in the composer so you can edit and resend it.",
      raw,
    });
  });

  it("keeps provider policy failures specific", () => {
    const raw =
      'API error 400: {"error":"image generation failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"This prompt was rejected by policy because it references a copyrighted character.\\"}}"}';

    expect(describeChatUiError(raw, "image_generate")?.summary).toBe(
      "The image prompt was rejected by the provider's policy checks. Try a more original description instead of naming a copyrighted character or exact likeness. Your prompt was kept in the composer so you can edit and resend it.",
    );
  });

  it("omits composer retry guidance for non-composer failures", () => {
    const raw =
      'API error 400: {"error":"approval failed (400 Bad Request): {\\"error\\": {\\"message\\": \\"Approval could not be recorded.\\"}}"}';

    expect(describeChatUiError(raw, "approval")).toEqual({
      summary: "Approval could not be recorded.",
      raw,
    });
  });

  it("falls back cleanly when an API error has no nested provider message", () => {
    const raw = "API error 502: gateway timeout";

    expect(describeChatUiError(raw, "refresh")).toEqual({
      summary: "The provider request failed before the current step could finish.",
      raw,
    });
  });
});

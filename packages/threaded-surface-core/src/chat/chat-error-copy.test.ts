import { describe, expect, it } from "vitest";
import { describeChatUiError, formatChatUiError } from "./chat-error-copy";

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

  it("maps typed image response timeouts to safe recovery copy", () => {
    const raw =
      'API error 502: {"error":"OpenAI Codex image generation timed out before the provider finished sending the response.","code":"EXTERNAL_SERVICE_FAILED","details":{"service":"openai-codex","operation":"image_generation","reason":"response_body_timeout","retryable":true}}';

    expect(describeChatUiError(raw, "image_generate")).toEqual({
      summary:
        "Image generation timed out before the provider finished sending the response. Your prompt was kept in the composer so you can edit and resend it.",
      raw,
    });
  });

  it("maps common operator-facing errors to stable copy", () => {
    expect(describeChatUiError(null)).toBeNull();
    expect(formatChatUiError("organization must be verified for gpt-image-2", "image_generate")).toContain(
      "not verified for gpt-image-2",
    );
    expect(formatChatUiError("approval required", "other")).toBe(
      "The run is waiting for approval before it can continue.",
    );
    expect(formatChatUiError("user input required", "user_input")).toBe(
      "The run is waiting for operator input before it can continue.",
    );
    expect(formatChatUiError("Malformed SSE frame", "send")).toBe(
      "The response stream interrupted before the run could finish updating.",
    );
    expect(formatChatUiError("No model provider configured", "send")).toBe(
      "The run cannot start because no provider is configured.",
    );
    expect(formatChatUiError("No model is selected", "send")).toBe(
      "The run cannot start because no model is selected.",
    );
    expect(formatChatUiError("run data missing", "refresh")).toBe("Run state refresh failed.");
    expect(formatChatUiError("checkpoint missing", "refresh")).toBe("Checkpoint refresh failed.");
    expect(formatChatUiError("ECONNREFUSED", "refresh")).toBe("The selected runtime could not be reached.");
    expect(formatChatUiError("plain failure", "other")).toBe("plain failure");
  });
});

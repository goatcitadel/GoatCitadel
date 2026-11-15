import { describe, expect, it } from "vitest";
import {
  describeChatUiError,
  formatChatUiError,
  isChatErrorAlreadyShownByTurn,
  isGatewayUnreachableChatError,
} from "./chat-error-copy";

describe("isGatewayUnreachableChatError", () => {
  it("is true for exactly the texts that read as the gateway being unreachable", () => {
    expect(isGatewayUnreachableChatError("Network error: Failed to fetch")).toBe(true);
    expect(isGatewayUnreachableChatError("TypeError: failed to fetch")).toBe(true);
    expect(isGatewayUnreachableChatError("Run data refresh failed")).toBe(false);
    expect(isGatewayUnreachableChatError("The run is waiting for approval; failed to fetch")).toBe(false);
    expect(isGatewayUnreachableChatError("ECONNREFUSED")).toBe(false);
    expect(isGatewayUnreachableChatError(null)).toBe(false);
    expect(isGatewayUnreachableChatError(undefined)).toBe(false);
  });
});

describe("recorded Chat failure copy", () => {
  it("hides only a matching host error already visible in a failed turn", () => {
    const answer = "This turn failed before completion. Retry once, or narrow the request.";
    const error = `${answer} More detail follows.`;
    expect(isChatErrorAlreadyShownByTurn({ error, turnStatus: "failed", assistantContent: answer })).toBe(true);
    expect(
      isChatErrorAlreadyShownByTurn({ error: "A different error", turnStatus: "failed", assistantContent: answer }),
    ).toBe(false);
    expect(isChatErrorAlreadyShownByTurn({ error, turnStatus: "completed", assistantContent: answer })).toBe(false);
    expect(isChatErrorAlreadyShownByTurn({ error, turnStatus: "failed", assistantContent: "Failed" })).toBe(false);
  });
});

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

describe("a send while another window is sending (U-CH-022)", () => {
  const raw =
    "A chat turn write is already in progress for session session-1. Wait for the current send to finish and retry.";

  it("says so in plain words and keeps the Gateway text as the raw error", () => {
    expect(describeChatUiError(raw, "send")).toEqual({
      summary:
        "Another window is sending in this conversation. Your message is still in the box; send it again when that answer finishes.",
      raw,
    });
  });
});

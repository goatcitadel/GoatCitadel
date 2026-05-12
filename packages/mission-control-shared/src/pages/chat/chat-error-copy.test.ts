import { describe, expect, it } from "vitest";

import { describeChatUiError, formatChatUiError } from "./chat-error-copy";

describe("shared chat-error-copy", () => {
  it("maps known runtime failures to operator-facing summaries", () => {
    expect(describeChatUiError(null)).toBeNull();
    expect(formatChatUiError(undefined)).toBeNull();
    expect(describeChatUiError("Approval required for tool")?.summary).toBe(
      "The run is waiting for approval before it can continue.",
    );
    expect(describeChatUiError("waiting for user input")?.summary).toBe(
      "The run is waiting for operator input before it can continue.",
    );
    expect(describeChatUiError("malformed SSE frame")?.summary).toBe(
      "The response stream interrupted before the run could finish updating.",
    );
    expect(describeChatUiError("incomplete event payload")?.summary).toBe(
      "The response stream interrupted before the run could finish updating.",
    );
    expect(describeChatUiError("buffer limit exceeded")?.summary).toBe(
      "The response stream interrupted before the run could finish updating.",
    );
    expect(describeChatUiError("API error 500")?.summary).toBe(
      "The provider request failed before the current step could finish.",
    );
    expect(describeChatUiError("No model provider configured")?.summary).toBe(
      "The run cannot start because no provider is configured.",
    );
    expect(describeChatUiError("No model is selected")?.summary).toBe(
      "The run cannot start because no model is selected.",
    );
    expect(describeChatUiError("run data failed")?.summary).toBe("Run state refresh failed.");
    expect(describeChatUiError("checkpoint load failed")?.summary).toBe("Checkpoint refresh failed.");
    expect(describeChatUiError("ECONNREFUSED")?.summary).toBe("The selected runtime could not be reached.");
    expect(describeChatUiError("runtime could not be reached")?.summary).toBe(
      "The selected runtime could not be reached.",
    );
    expect(describeChatUiError("gateway unreachable")?.summary).toBe("The selected runtime could not be reached.");
    expect(describeChatUiError("provider offline")?.summary).toBe("The selected runtime could not be reached.");
  });

  it("preserves unknown messages as summaries without raw detail", () => {
    expect(describeChatUiError("plain failure")).toEqual({ summary: "plain failure", raw: undefined });
    expect(formatChatUiError("plain failure")).toBe("plain failure");
    expect(describeChatUiError("approval required")?.raw).toBe("approval required");
  });
});

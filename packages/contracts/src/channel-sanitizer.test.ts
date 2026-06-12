import { describe, expect, it } from "vitest";
import { sanitizeChannelOutboundMessage } from "./channel-sanitizer.js";

describe("sanitizeChannelOutboundMessage", () => {
  it("removes angle and bracket internal markup blocks", () => {
    const result = sanitizeChannelOutboundMessage(
      'Visible <thinking data-kind="x">secret</thinking> [tool_call id=1]hidden[/tool_call] done',
    );

    expect(result.message).toBe("Visible   done");
    expect(result.removedBlockCount).toBe(2);
  });

  it("removes internal html comments without stripping ordinary comments", () => {
    const result = sanitizeChannelOutboundMessage("Visible <!--thinking secret -->done <!-- public note -->");

    expect(result.message).toBe("Visible done <!-- public note -->");
    expect(result.removedBlockCount).toBe(1);
  });

  it("scans repeated internal comment openings without regex backtracking", () => {
    const noisyPrefix = "<!--internal ".repeat(2_000);
    const result = sanitizeChannelOutboundMessage(`Visible ${noisyPrefix}secret -->done`);

    expect(result.message).toBe("Visible done");
    expect(result.removedBlockCount).toBe(1);
  });
});

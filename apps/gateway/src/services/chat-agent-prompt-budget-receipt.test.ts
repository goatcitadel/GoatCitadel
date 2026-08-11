import { describe, expect, it } from "vitest";
import {
  buildPromptContextBudgetReceipt,
  shouldCapturePromptContextBudgetReceipt,
} from "./chat-agent-prompt-budget-receipt.js";

describe("chat prompt-context budget receipts", () => {
  it("keeps full-context serialization off the normal live hot path unless diagnostics request it", () => {
    expect(
      shouldCapturePromptContextBudgetReceipt({
        debugEnabled: false,
        executionProfile: "standard",
        normalizationProfile: "live",
      }),
    ).toBe(false);
    expect(
      shouldCapturePromptContextBudgetReceipt({
        debugEnabled: true,
        executionProfile: "standard",
        normalizationProfile: "live",
      }),
    ).toBe(true);
  });

  it("retains receipts for proof-oriented quick-web and prompt-pack profiles", () => {
    expect(
      shouldCapturePromptContextBudgetReceipt({
        debugEnabled: false,
        executionProfile: "quick_web",
        normalizationProfile: "quick_web",
      }),
    ).toBe(true);
    expect(
      shouldCapturePromptContextBudgetReceipt({
        debugEnabled: false,
        executionProfile: "standard",
        normalizationProfile: "prompt_pack_harness",
      }),
    ).toBe(true);
  });

  it("reports bounded category counts without retaining prompt content", () => {
    const receipt = buildPromptContextBudgetReceipt({
      executionProfile: "standard",
      messages: [
        { role: "system", content: "System guidance" },
        { role: "user", content: "Question" },
        { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
      ],
      tools: [{ type: "function", function: { name: "memory_read" } }],
      toolRuns: [{ status: "executed", result: { ok: true } } as never],
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        executionProfile: "standard",
        messageCount: 3,
        toolSchemaCount: 1,
        toolResultCount: 1,
      }),
    );
    expect(receipt.charCounts.total).toBeGreaterThan(0);
    expect(receipt.tokenEstimates.total).toBeGreaterThan(0);
    expect(JSON.stringify(receipt)).not.toContain("System guidance");
    expect(JSON.stringify(receipt)).not.toContain("Question");
  });
});

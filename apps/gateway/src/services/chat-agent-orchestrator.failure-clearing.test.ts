import { describe, expect, it } from "vitest";
import type {
  ChatMode,
  ChatNormalizationProfile,
  ChatToolRunRecord,
  ChatTurnCompletionRecord,
  ChatTurnFailureRecord,
} from "@goatcitadel/contracts";
import { shouldClearRecoverableCompletionFailure } from "./chat-agent-orchestrator.js";

function buildExecutedToolRun(overrides: Partial<ChatToolRunRecord> = {}): ChatToolRunRecord {
  return {
    toolRunId: "tool-run-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "file.read_range",
    status: "executed",
    startedAt: "2026-06-09T00:00:00.000Z",
    finishedAt: "2026-06-09T00:00:01.000Z",
    result: { content: "const example = 1;" },
    ...overrides,
  };
}

function buildBudgetExceededFailure(overrides: Partial<ChatTurnFailureRecord> = {}): ChatTurnFailureRecord {
  return {
    failureClass: "tool_run_budget_exceeded",
    message: "Tool run budget exceeded for this turn after 12 tool calls.",
    recommendedAction: "retry_narrower",
    ...overrides,
  };
}

function buildCompletion(overrides: Partial<ChatTurnCompletionRecord> = {}): ChatTurnCompletionRecord {
  return {
    status: "complete",
    repaired: false,
    ...overrides,
  };
}

const SUBSTANTIVE_CONTENT = [
  "The retry queue drains in `drainQueuedRuns()`:",
  "",
  "1. Leases are renewed per worker before each claim attempt.",
  "2. Expired leases are reconciled, then queued rows are claimed in order.",
  "",
  "So worker B only claims after worker A's lease expires.",
].join("\n");

function buildInput(
  overrides: Partial<Parameters<typeof shouldClearRecoverableCompletionFailure>[0]> = {},
): Parameters<typeof shouldClearRecoverableCompletionFailure>[0] {
  return {
    normalizationProfile: "prompt_pack_harness" as ChatNormalizationProfile,
    mode: "cowork" as ChatMode,
    finalStatus: "completed",
    approvalPending: false,
    completion: buildCompletion(),
    failure: buildBudgetExceededFailure(),
    assistantContent: SUBSTANTIVE_CONTENT,
    toolRuns: [buildExecutedToolRun()],
    ...overrides,
  };
}

describe("shouldClearRecoverableCompletionFailure", () => {
  describe("prompt-lab harness budget-exceeded path", () => {
    it("clears when a tool executed with a result and the content is substantive", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput())).toBe(true);
    });

    it("clears for the short 'tool budget' failure phrasing too", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            failure: buildBudgetExceededFailure({
              message: "Stopped on the tool budget for this turn.",
            }),
          }),
        ),
      ).toBe(true);
    });

    it("does NOT clear when the content admits it may be incomplete", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            assistantContent:
              "Here is what I gathered so far. Parts of this answer may be incomplete because the tool budget ran out.",
          }),
        ),
      ).toBe(false);
    });

    it("does NOT clear when the content coaches a retry continuation", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            assistantContent: 'I gathered partial evidence. Say "keep going" and I will continue from here.',
          }),
        ),
      ).toBe(false);
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            assistantContent: "Partial pass only. Best next move: retry with a narrower scope.",
          }),
        ),
      ).toBe(false);
    });

    it("does NOT clear when the content is a degraded deterministic fallback", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            assistantContent:
              "I couldn't finish that cleanly because the tool flow did not converge to a complete answer.\n\nUseful partial result: file.read_range: {...}",
          }),
        ),
      ).toBe(false);
    });

    it("does NOT clear when the content is serialized tool-call markup", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            assistantContent: '<tool_call>{"name": "file.read_range", "arguments": "{\\"path\\": \\"a.ts\\"}"}</tool_call>',
          }),
        ),
      ).toBe(false);
    });

    it("does NOT clear when the content is empty or whitespace", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput({ assistantContent: "   \n " }))).toBe(false);
    });

    it("does NOT clear when no tool run executed", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput({ toolRuns: [] }))).toBe(false);
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            toolRuns: [buildExecutedToolRun({ status: "failed", result: undefined, error: "boom" })],
          }),
        ),
      ).toBe(false);
    });

    it("does NOT clear when an executed run has no result payload", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({ toolRuns: [buildExecutedToolRun({ result: undefined })] }),
        ),
      ).toBe(false);
    });
  });

  describe("non-harness cowork repair path", () => {
    const repairableFailure: ChatTurnFailureRecord = {
      failureClass: "provider_timeout",
      message: "The provider stopped before the answer finished; a repair pass is required.",
      recommendedAction: "continue_from_partial",
    };

    it("still requires completion.repaired", () => {
      const base = buildInput({
        normalizationProfile: "live",
        failure: repairableFailure,
      });
      expect(shouldClearRecoverableCompletionFailure(base)).toBe(false);
      expect(
        shouldClearRecoverableCompletionFailure({
          ...base,
          completion: buildCompletion({ repaired: true }),
        }),
      ).toBe(true);
    });

    it("requires the continue_from_partial recommendation", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            normalizationProfile: "live",
            completion: buildCompletion({ repaired: true }),
            failure: { ...repairableFailure, recommendedAction: "retry" },
          }),
        ),
      ).toBe(false);
    });

    it("does NOT treat a budget-exceeded failure as repair-clearable on the live profile", () => {
      // The budget early path is harness-only; on the live profile the failure
      // message has to match the repair-clearable set.
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({
            normalizationProfile: "live",
            completion: buildCompletion({ repaired: true }),
            failure: buildBudgetExceededFailure({ recommendedAction: "continue_from_partial" }),
          }),
        ),
      ).toBe(false);
    });
  });

  describe("gating preconditions", () => {
    it("never clears while approval is pending", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput({ approvalPending: true }))).toBe(false);
    });

    it("never clears for non-completed turns", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput({ finalStatus: "failed" }))).toBe(false);
      expect(shouldClearRecoverableCompletionFailure(buildInput({ finalStatus: "partial" }))).toBe(false);
    });

    it("never clears without a failure to clear", () => {
      expect(shouldClearRecoverableCompletionFailure(buildInput({ failure: undefined }))).toBe(false);
    });

    it("never clears on the live chat surface", () => {
      expect(
        shouldClearRecoverableCompletionFailure(
          buildInput({ normalizationProfile: "live", mode: "chat" }),
        ),
      ).toBe(false);
    });
  });
});

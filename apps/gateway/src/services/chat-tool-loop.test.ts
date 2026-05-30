import { randomUUID } from "node:crypto";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  createLoopGuardTrace,
  detectToolLoopRisk,
  initializeToolLoopGuardState,
  normalizeFailureSignature,
  rememberToolLoopHistory,
} from "./chat-tool-loop.js";

function toolRun(input: {
  toolName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status?: ChatToolRunRecord["status"];
}): ChatToolRunRecord {
  return {
    toolRunId: randomUUID(),
    toolName: input.toolName,
    args: input.args ?? {},
    result: input.result ?? {},
    status: input.status ?? "succeeded",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  } as ChatToolRunRecord;
}

describe("chat-tool-loop", () => {
  it("omits trace output when loop detection is disabled and no events exist", () => {
    const state = initializeToolLoopGuardState({ enabled: false });

    expect(createLoopGuardTrace(state)).toBeUndefined();
  });

  it("warns and then suppresses repeated identical tool calls by configured threshold", () => {
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 4,
      warningThreshold: 2,
      criticalThreshold: 3,
      globalThreshold: 4,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: false,
        ping_pong: false,
      },
    });

    // Use a non-polling tool name: polling-like tools (status/poll/wait/check/list/get)
    // are intentionally exempted from `repeated_same_call` and governed only by the
    // progress-aware `no_progress_polling` detector. `send_message` exercises the
    // args-only repeated-call escalation path that this test targets.
    rememberToolLoopHistory(state, toolRun({ toolName: "send_message", args: { id: "run-1" } }));
    const warning = detectToolLoopRisk(state, "send_message", { id: "run-1" });
    expect(warning).toMatchObject({
      detector: "repeated_same_call",
      severity: "warning",
      suppressed: false,
      repetitionCount: 2,
    });

    rememberToolLoopHistory(state, toolRun({ toolName: "send_message", args: { id: "run-1" } }));
    const critical = detectToolLoopRisk(state, "send_message", { id: "run-1" });
    expect(critical).toMatchObject({
      detector: "repeated_same_call",
      severity: "critical",
      suppressed: true,
      repetitionCount: 3,
    });
  });

  it("trips the no-progress polling detector on repeated identical poll outcomes", () => {
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 6,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: false,
        no_progress_polling: true,
        ping_pong: false,
      },
    });

    const pollRun = toolRun({
      toolName: "run.status",
      args: { runId: "run-1" },
      result: { state: "running" },
    });
    rememberToolLoopHistory(state, pollRun);
    rememberToolLoopHistory(state, pollRun);
    rememberToolLoopHistory(state, pollRun);

    const event = detectToolLoopRisk(state, "run.status", { runId: "run-1" });
    expect(event).toMatchObject({
      detector: "no_progress_polling",
      severity: "critical",
      suppressed: true,
      repetitionCount: 4,
    });
  });

  it("does not trip on legitimate distinct, progressing tool calls", () => {
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 6,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      },
    });

    // Distinct reads (different args) and a progressing poll (changing result)
    // must never accumulate into a loop-guard event.
    rememberToolLoopHistory(state, toolRun({ toolName: "fs.read", args: { path: "a.ts" } }));
    expect(detectToolLoopRisk(state, "fs.read", { path: "b.ts" })).toBeUndefined();

    rememberToolLoopHistory(state, toolRun({ toolName: "fs.read", args: { path: "b.ts" } }));
    expect(detectToolLoopRisk(state, "fs.read", { path: "c.ts" })).toBeUndefined();

    // Checking the same status twice (count 2) stays under the warning threshold.
    rememberToolLoopHistory(state, toolRun({ toolName: "run.status", args: { runId: "x" }, result: { step: 1 } }));
    expect(detectToolLoopRisk(state, "run.status", { runId: "x" })).toBeUndefined();

    // A retried search with a refined query is a different signature, not a loop.
    rememberToolLoopHistory(state, toolRun({ toolName: "browser.search", args: { query: "alpha" } }));
    expect(detectToolLoopRisk(state, "browser.search", { query: "alpha beta" })).toBeUndefined();
  });

  it("does not suppress a polling tool whose results keep changing (repeated_same_call exemption)", () => {
    // Regression: with the loop guard enabled by default, the args-only
    // `repeated_same_call` detector previously suppressed legitimate polling
    // (identical inputs) on the 4th call even when the RESULTS were changing.
    // Polling-like tools are now exempt from `repeated_same_call` and governed
    // only by the progress-aware `no_progress_polling` detector, which accounts
    // for result progress before suppressing.
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 8,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      },
    });

    // Six identical-input polls, each returning a DIFFERENT result signature.
    // Without the exemption, repeated_same_call would suppress at call 4+.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const event = detectToolLoopRisk(state, "session.status", {});
      // No suppression at any point: results are progressing, so neither the
      // exempted repeated_same_call nor the progress-aware no_progress_polling
      // detector should trip.
      expect(event?.suppressed ?? false).toBe(false);
      rememberToolLoopHistory(
        state,
        toolRun({
          toolName: "session.status",
          args: {},
          result: { step: attempt, state: attempt < 6 ? "running" : "done" },
        }),
      );
    }

    // No loop-guard event of any severity was recorded for the progressing poll.
    expect(state.events).toHaveLength(0);
  });

  it("suppresses a polling tool with identical results via no_progress_polling", () => {
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 8,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      },
    });

    // Identical inputs AND identical results: a genuinely stuck poll.
    const stuckPoll = toolRun({
      toolName: "session.status",
      args: {},
      result: { state: "running" },
    });
    rememberToolLoopHistory(state, stuckPoll);
    rememberToolLoopHistory(state, stuckPoll);
    rememberToolLoopHistory(state, stuckPoll);

    const event = detectToolLoopRisk(state, "session.status", {});
    expect(event).toMatchObject({
      detector: "no_progress_polling",
      severity: "critical",
      suppressed: true,
      repetitionCount: 4,
    });
  });

  it("suppresses a non-polling tool with identical args via repeated_same_call", () => {
    const state = initializeToolLoopGuardState({
      enabled: true,
      historySize: 8,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      },
    });

    // `send_message` is not polling-like, so identical args escalate through the
    // args-only repeated_same_call detector even though results vary.
    rememberToolLoopHistory(state, toolRun({ toolName: "send_message", args: { to: "ops" }, result: { id: 1 } }));
    rememberToolLoopHistory(state, toolRun({ toolName: "send_message", args: { to: "ops" }, result: { id: 2 } }));
    rememberToolLoopHistory(state, toolRun({ toolName: "send_message", args: { to: "ops" }, result: { id: 3 } }));

    const event = detectToolLoopRisk(state, "send_message", { to: "ops" });
    expect(event).toMatchObject({
      detector: "repeated_same_call",
      severity: "critical",
      suppressed: true,
      repetitionCount: 4,
    });
  });

  it("normalizes failure signatures for retry and circuit-breaker grouping", () => {
    expect(normalizeFailureSignature("  Network   TIMEOUT  ")).toBe("network timeout");
    expect(normalizeFailureSignature(undefined)).toBe("unknown");
  });
});

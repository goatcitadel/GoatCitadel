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

    rememberToolLoopHistory(state, toolRun({ toolName: "status.get", args: { id: "run-1" } }));
    const warning = detectToolLoopRisk(state, "status.get", { id: "run-1" });
    expect(warning).toMatchObject({
      detector: "repeated_same_call",
      severity: "warning",
      suppressed: false,
      repetitionCount: 2,
    });

    rememberToolLoopHistory(state, toolRun({ toolName: "status.get", args: { id: "run-1" } }));
    const critical = detectToolLoopRisk(state, "status.get", { id: "run-1" });
    expect(critical).toMatchObject({
      detector: "repeated_same_call",
      severity: "critical",
      suppressed: true,
      repetitionCount: 3,
    });
  });

  it("normalizes failure signatures for retry and circuit-breaker grouping", () => {
    expect(normalizeFailureSignature("  Network   TIMEOUT  ")).toBe("network timeout");
    expect(normalizeFailureSignature(undefined)).toBe("unknown");
  });
});

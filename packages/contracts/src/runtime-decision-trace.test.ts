import { describe, expect, it } from "vitest";
import type { RuntimeDecisionKind, RuntimeDecisionTraceRecord } from "./runtime-decision-trace.js";
import {
  RUNTIME_DECISION_KINDS,
  RUNTIME_DECISION_TRACE_LIMITS,
  RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES,
} from "./runtime-decision-trace.js";

describe("runtime decision trace contracts", () => {
  it("covers the first-class decision points used by the Gateway runtime", () => {
    const kinds = new Set<RuntimeDecisionKind>(RUNTIME_DECISION_KINDS);

    expect(kinds.has("chat_turn_prepared")).toBe(true);
    expect(kinds.has("memory_context")).toBe(true);
    expect(kinds.has("workflow_choice")).toBe(true);
    expect(kinds.has("execution_plan_revised")).toBe(true);
    expect(kinds.has("tool_approval_required")).toBe(true);
    expect(kinds.has("approval_resolved")).toBe(true);
    expect(kinds.has("durable_checkpoint")).toBe(true);
    expect(kinds.has("unknown")).toBe(true);
  });

  it("keeps the payload budget and array caps explicit in the shared contract", () => {
    expect(RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES).toBe(16 * 1024);
    expect(RUNTIME_DECISION_TRACE_LIMITS.maxSignals).toBeGreaterThan(0);
    expect(RUNTIME_DECISION_TRACE_LIMITS.maxAlternatives).toBeGreaterThan(0);
    expect(RUNTIME_DECISION_TRACE_LIMITS.maxEvidenceRefs).toBeGreaterThan(0);
  });

  it("models records without raw JSON as the primary display contract", () => {
    const record: RuntimeDecisionTraceRecord = {
      decisionId: "decision-1",
      kind: "workflow_choice",
      scope: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      },
      selected: "Use governed Cowork orchestration",
      rationale: "The turn requested multi-step supervised implementation work.",
      alternatives: [
        {
          label: "Direct answer",
          outcome: "not_chosen",
          reasonNotChosen: "The operator asked for implementation, validation, and PR detail.",
        },
      ],
      signals: [
        {
          source: "routing",
          key: "mode",
          value: "cowork",
          weight: "strong",
        },
      ],
      evidenceRefs: [{ refType: "turn", refId: "turn-1" }],
      createdAt: "2026-06-18T00:00:00.000Z",
    };

    expect(record.selected).toContain("orchestration");
    expect(record.signals[0]?.value).toBe("cowork");
  });
});

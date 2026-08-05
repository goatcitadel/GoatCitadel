import { describe, expect, it, vi } from "vitest";
import type { RuntimeDecisionTraceAppendInput, RuntimeDecisionTraceRecord } from "@goatcitadel/contracts";
import { RuntimeDecisionRecorder, type RuntimeDecisionRecorderHost } from "./runtime-decision-recorder.js";

function createRecord(input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceRecord {
  return {
    decisionId: input.decisionId ?? "decision-1",
    kind: input.kind,
    scope: input.scope,
    selected: input.selected,
    rationale: input.rationale,
    alternatives: input.alternatives ?? [],
    signals: input.signals ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    createdAt: input.createdAt ?? "2026-06-18T00:00:00.000Z",
  };
}

describe("RuntimeDecisionRecorder", () => {
  it("appends compact decision records through the storage spine", async () => {
    const append = vi.fn((input: RuntimeDecisionTraceAppendInput) => createRecord(input));
    const recorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: { append },
    });

    const record = await recorder.record({
      kind: "workflow_choice",
      scope: { sessionId: "session-1", turnId: "turn-1" },
      selected: "Use Cowork orchestration",
      rationale: "The turn requested supervised implementation.",
    });

    expect(record?.kind).toBe("workflow_choice");
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("never throws when storage append fails", async () => {
    const diagnostics = vi.fn();
    const recorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: {
        append: vi.fn(() => {
          throw new Error("disk full");
        }),
      },
      recordDevDiagnostic: diagnostics,
    });

    await expect(
      recorder.record({
        kind: "tool_failed",
        scope: { sessionId: "session-1", turnId: "turn-1", toolRunId: "tool-1" },
        selected: "Mark tool failed",
        rationale: "The tool invocation returned an error.",
      }),
    ).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "runtime_decision_trace",
        event: "runtime.decision_trace.append_failed",
        context: expect.objectContaining({ error: "disk full" }),
      }),
    );
  });

  it("does not revive a committed mutation when both decision storage and diagnostics fail", async () => {
    const recorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: {
        append: vi.fn(() => {
          throw new Error("decision store unavailable");
        }),
      },
      recordDevDiagnostic: vi.fn(() => {
        throw new Error("diagnostic store unavailable");
      }),
    });

    await expect(
      recorder.record({
        kind: "approval_requested",
        scope: { approvalId: "approval-1" },
        selected: "Requested shell.exec approval",
        rationale: "The canonical approval transaction already committed.",
      }),
    ).resolves.toBeUndefined();
  });

  it("records 100 compact decisions within a small local threshold", async () => {
    const append = vi.fn((input: RuntimeDecisionTraceAppendInput) => createRecord(input));
    const host: RuntimeDecisionRecorderHost = {
      runtimeDecisionTraces: { append },
    };
    const recorder = new RuntimeDecisionRecorder(host);
    const startedAt = performance.now();

    const records: Array<Promise<RuntimeDecisionTraceRecord | undefined>> = [];
    for (let index = 0; index < 100; index += 1) {
      records.push(
        recorder.record({
          decisionId: `decision-${index}`,
          kind: "routing_choice",
          scope: { sessionId: "session-1", turnId: `turn-${index}` },
          selected: "Answer directly",
          rationale: "No tool, approval, or workflow signal required orchestration.",
        }),
      );
    }
    await Promise.all(records);

    const elapsedMs = performance.now() - startedAt;
    expect(append).toHaveBeenCalledTimes(100);
    expect(elapsedMs).toBeLessThan(50);
  });
});

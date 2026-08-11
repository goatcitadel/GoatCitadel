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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

  it("queues advisory decisions in order without making the caller await storage", async () => {
    const firstAppend = deferred();
    const appendOrder: string[] = [];
    const ownedTasks: Promise<void>[] = [];
    const append = vi.fn(async (input: RuntimeDecisionTraceAppendInput) => {
      appendOrder.push(input.decisionId ?? "missing");
      if (input.decisionId === "decision-1") {
        await firstAppend.promise;
      }
      return createRecord(input);
    });
    const recorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: { append },
      registerBackgroundTask: (task) => {
        ownedTasks.push(task);
      },
    });

    expect(
      recorder.enqueueAdvisory({
        decisionId: "decision-1",
        kind: "tool_selected",
        scope: { turnId: "turn-1", toolRunId: "tool-1" },
        selected: "Select time.now",
        rationale: "The canonical tool row already settled.",
      }),
    ).toBe(true);
    expect(
      recorder.enqueueAdvisory({
        decisionId: "decision-2",
        kind: "tool_blocked",
        scope: { turnId: "turn-2", toolRunId: "tool-2" },
        selected: "Block browser.search",
        rationale: "Web access is disabled.",
      }),
    ).toBe(true);

    expect(ownedTasks).toHaveLength(2);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    expect(appendOrder).toEqual(["decision-1"]);
    firstAppend.resolve();
    await Promise.all(ownedTasks);
    expect(appendOrder).toEqual(["decision-1", "decision-2"]);
  });

  it("bounds advisory backpressure and emits an explicit overflow diagnostic", async () => {
    const releaseAppends = deferred();
    const diagnostics = vi.fn();
    const ownedTasks: Promise<void>[] = [];
    const append = vi.fn(async (input: RuntimeDecisionTraceAppendInput) => {
      await releaseAppends.promise;
      return createRecord(input);
    });
    const recorder = new RuntimeDecisionRecorder({
      runtimeDecisionTraces: { append },
      recordDevDiagnostic: diagnostics,
      registerBackgroundTask: (task) => {
        ownedTasks.push(task);
      },
    });

    for (let index = 0; index < 256; index += 1) {
      expect(
        recorder.enqueueAdvisory({
          decisionId: `queued-${index}`,
          kind: "tool_selected",
          scope: { turnId: `turn-${index}`, toolRunId: `tool-${index}` },
          selected: "Select time.now",
          rationale: "Queued advisory decision.",
        }),
      ).toBe(true);
    }
    expect(
      recorder.enqueueAdvisory({
        decisionId: "overflow",
        kind: "tool_selected",
        scope: { turnId: "turn-overflow", toolRunId: "tool-overflow" },
        selected: "Select time.now",
        rationale: "This advisory projection exceeds the bounded queue.",
      }),
    ).toBe(false);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime.decision_trace.queue_overflow",
        context: expect.objectContaining({ pendingCount: 256, maxPendingCount: 256 }),
      }),
    );
    expect(ownedTasks).toHaveLength(256);

    releaseAppends.resolve();
    await Promise.all(ownedTasks);
    expect(append).toHaveBeenCalledTimes(256);
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

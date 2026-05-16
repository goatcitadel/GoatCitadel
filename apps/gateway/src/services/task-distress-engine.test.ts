import { describe, it, expect } from "vitest";
import type { TaskDistressSignal } from "@goatcitadel/contracts";
import { emitDistressSignal, resolveDistressSignal, summarizeDistress } from "./task-distress-engine.js";

describe("task-distress-engine", () => {
  it("emit prepends a new signal with the given code", () => {
    const next = emitDistressSignal([], {
      code: "needs_user",
      severity: "warn",
      title: "Need input",
      summary: "asks for clarification",
      now: () => "2026-05-15T12:00:00.000Z",
      idFactory: () => "ds-1",
    });
    expect(next[0].signalId).toBe("ds-1");
    expect(next[0].code).toBe("needs_user");
  });

  it("resolve marks a signal resolved without removing it", () => {
    const existing: TaskDistressSignal[] = [
      {
        signalId: "ds-1",
        code: "needs_user",
        severity: "warn",
        title: "x",
        summary: "y",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
    ];
    const next = resolveDistressSignal(existing, "ds-1", {
      resolvedBy: "alice",
      now: () => "2026-05-15T12:05:00.000Z",
    });
    expect(next[0].resolvedAt).toBe("2026-05-15T12:05:00.000Z");
    expect(next[0].resolvedBy).toBe("alice");
  });

  it("summarize returns counts of unresolved signals by severity", () => {
    const signals: TaskDistressSignal[] = [
      {
        signalId: "a",
        code: "needs_user",
        severity: "warn",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
      {
        signalId: "b",
        code: "tool_error",
        severity: "critical",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
      {
        signalId: "c",
        code: "needs_user",
        severity: "warn",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
        resolvedAt: "2026-05-15T12:01:00.000Z",
      },
    ];
    const summary = summarizeDistress(signals);
    expect(summary).toEqual({ info: 0, warn: 1, critical: 1, resolvedCount: 1 });
  });
});

import { describe, expect, it } from "vitest";
import type { ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import { projectCanonicalResult } from "./chat-fanout-result-projection.js";

const invocation = {
  invocationId: "fanout-1", parentRunId: "parent-1", toolRunId: "tool-1",
  delegationRunId: "delegation-1", status: "waiting", grantId: "grant-1",
  projectId: "project-1", reservedActivations: 3, reservedBudgetUsd: 0.75,
  childCount: 3,
} as ChatFanoutInvocationRecord;

describe("committed fanout result projection", () => {
  it("withholds incomplete child output and synthesis while preserving failure evidence", () => {
    const steps = [
      { index: 2, status: "failed", output: "uncommitted failure output", error: "dispatch uncertain" },
      { index: 0, status: "completed", output: " committed result " },
      { index: 1, status: "running", output: "uncommitted partial output", childTurnId: "child-1" },
    ];
    const before = JSON.stringify(steps);
    const result = projectCanonicalResult(invocation, steps, "premature synthesis");
    expect(result).toMatchObject({ completedCount: 1, waitingCount: 1,
      results: [
        { index: 0, status: "completed", output: "committed result" },
        { index: 1, status: "waiting", childTurnId: "child-1" },
        { index: 2, status: "failed", error: "dispatch uncertain" },
      ],
    });
    expect(result).not.toHaveProperty("stitchedOutput");
    expect((result.results as Record<string, unknown>[])[1]).not.toHaveProperty("output");
    expect((result.results as Record<string, unknown>[])[2]).not.toHaveProperty("output");
    expect(JSON.stringify(steps)).toBe(before);
  });

  it("bounds settled excerpts and preserves canonical owner and terminal reason", () => {
    const result = projectCanonicalResult({ ...invocation, status: "partial", terminalReason: "one child failed" },
      [{ index: 0, status: "completed", output: "x".repeat(3_100) },
        { index: 1, status: "cancelled", error: "operator stop" }], "y".repeat(3_100), ["citation-1"]);
    expect(result).toMatchObject({ status: "partial", fanoutInvocationId: "fanout-1", parentRunId: "parent-1",
      toolRunId: "tool-1", delegationRunId: "delegation-1", completedCount: 1, waitingCount: 0,
      terminalReason: "one child failed", citations: ["citation-1"], stitchedOutput: "y".repeat(3_000),
    });
    expect((result.results as Record<string, unknown>[])[0]?.output).toBe("x".repeat(3_000));
  });
});

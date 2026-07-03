import { describe, expect, it } from "vitest";
import { decideToolBatchParallelism } from "./chat-tool-parallelism.js";

const READ_ONLY = new Set(["session.search", "memory.read", "file.read_range"]);

function decide(overrides: Partial<Parameters<typeof decideToolBatchParallelism>[0]> = {}) {
  return decideToolBatchParallelism({
    toolNames: ["session.search", "memory.read"],
    readOnlyNames: READ_ONLY,
    disabledByFlag: false,
    remainingToolBudget: 5,
    maxParallel: 4,
    ...overrides,
  });
}

describe("decideToolBatchParallelism", () => {
  it("parallelizes a multi-call batch of read-only tools", () => {
    expect(decide()).toEqual({ parallel: true, reason: "all_read_only" });
  });

  it("stays serial for a single call", () => {
    expect(decide({ toolNames: ["session.search"] }).parallel).toBe(false);
  });

  it("stays serial when the kill switch is on", () => {
    const decision = decide({ disabledByFlag: true });
    expect(decision.parallel).toBe(false);
    expect(decision.reason).toBe("disabled_by_flag");
  });

  it("stays serial when any tool in the batch is not read-only", () => {
    const decision = decide({ toolNames: ["session.search", "shell.exec"] });
    expect(decision.parallel).toBe(false);
    expect(decision.reason).toBe("non_read_only_tool");
  });

  it("stays serial when the batch exceeds the remaining tool budget", () => {
    const decision = decide({ remainingToolBudget: 1 });
    expect(decision.parallel).toBe(false);
    expect(decision.reason).toBe("exceeds_tool_budget");
  });

  it("stays serial when the batch exceeds the parallel cap", () => {
    const decision = decide({
      toolNames: ["session.search", "memory.read", "file.read_range", "session.search", "memory.read"],
      remainingToolBudget: 10,
    });
    expect(decision.parallel).toBe(false);
    expect(decision.reason).toBe("exceeds_parallel_cap");
  });
});

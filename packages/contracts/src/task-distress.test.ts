import { describe, it, expect } from "vitest";
import type {
  TaskDistressSignal,
  TaskRetryBudget,
  TaskArtifactClaim,
  TaskArtifactVerification,
} from "./task-distress.js";

describe("task-distress contracts", () => {
  it("TaskDistressSignal carries code, severity, timestamps", () => {
    const signal: TaskDistressSignal = {
      signalId: "ds-1",
      code: "needs_user",
      severity: "warn",
      title: "Awaiting user input",
      summary: "Worker requested clarification.",
      emittedBy: "agent-7",
      createdAt: "2026-05-15T12:00:00.000Z",
    };
    expect(signal.code).toBe("needs_user");
    expect(signal.resolvedAt).toBeUndefined();
  });

  it("TaskRetryBudget tracks attempts vs ceiling", () => {
    const budget: TaskRetryBudget = { maxRetries: 3, retryCount: 1 };
    expect(budget.retryCount).toBe(1);
  });

  it("TaskArtifactVerification narrows to expected statuses", () => {
    const verification: TaskArtifactVerification = {
      claim: { kind: "file", value: "/tmp/out.txt" } satisfies TaskArtifactClaim,
      status: "missing",
      checkedAt: "2026-05-15T12:00:00.000Z",
      detail: "ENOENT",
    };
    expect(verification.status).toBe("missing");
  });
});

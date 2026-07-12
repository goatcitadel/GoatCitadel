import { describe, expect, it } from "vitest";
import { isDurableControlError } from "./durable-control-error.js";

describe("isDurableControlError", () => {
  it.each([
    "DurableWorkerInterruptionError",
    "DurableWorkflowTimeoutError",
    "DurableRunPausedError",
    "DurableRunCancelledError",
  ])("recognizes %s", (name) => {
    const error = Object.assign(new Error(name), { name });

    expect(isDurableControlError(error)).toBe(true);
  });

  it.each([
    new Error("ordinary runtime failure"),
    Object.assign(new Error("provider abort"), { name: "AbortError" }),
    { name: "DurableWorkflowTimeoutError" },
    undefined,
  ])("rejects non-durable control values", (candidate) => {
    expect(isDurableControlError(candidate)).toBe(false);
  });
});

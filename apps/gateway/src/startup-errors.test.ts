import { describe, expect, it } from "vitest";
import {
  attachOperatorSummary,
  isNonRetryableStartupError,
  NON_RETRYABLE_STARTUP_EXIT_CODE,
  NonRetryableStartupError,
  readOperatorSummary,
  resolveGatewayStartupExitCode,
} from "./startup-errors.js";

describe("gateway startup errors", () => {
  it("maps operator-action configuration failures to the non-retryable exit code", () => {
    const error = new NonRetryableStartupError("repair the managed runtime");

    expect(error.name).toBe("NonRetryableStartupError");
    expect(error.startupFailureKind).toBe("non_retryable_configuration");
    expect(resolveGatewayStartupExitCode(error)).toBe(NON_RETRYABLE_STARTUP_EXIT_CODE);
  });

  it("keeps ordinary startup failures retryable", () => {
    expect(resolveGatewayStartupExitCode(new Error("temporary startup failure"))).toBe(1);
    expect(resolveGatewayStartupExitCode("temporary startup failure")).toBe(1);
  });
});

describe("operator summaries on startup errors", () => {
  it("round-trips a summary and keeps the technical message", () => {
    const error = attachOperatorSummary(new NonRetryableStartupError("port 45432 held"), "Plain words.");
    expect(readOperatorSummary(error)).toBe("Plain words.");
    expect(error.message).toBe("port 45432 held");
    expect(isNonRetryableStartupError(error)).toBe(true);
  });

  it("gives undefined for an error or value without one", () => {
    expect(readOperatorSummary(new Error("x"))).toBeUndefined();
    expect(readOperatorSummary("text")).toBeUndefined();
    expect(readOperatorSummary(undefined)).toBeUndefined();
  });
});

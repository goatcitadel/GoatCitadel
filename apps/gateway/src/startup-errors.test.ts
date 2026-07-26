import { describe, expect, it } from "vitest";
import {
  NON_RETRYABLE_STARTUP_EXIT_CODE,
  NonRetryableStartupError,
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

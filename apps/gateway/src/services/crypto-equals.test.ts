import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "./crypto-equals.js";

describe("timingSafeStringEqual", () => {
  it("compares equal-length strings by content", () => {
    expect(timingSafeStringEqual("alpha", "alpha")).toBe(true);
    expect(timingSafeStringEqual("alpha", "bravo")).toBe(false);
  });

  it("always performs the padded timing-safe comparison before rejecting length mismatches", () => {
    expect(timingSafeStringEqual("alpha", "alpha-extended")).toBe(false);
    expect(timingSafeStringEqual("alpha", "alpha\u0000")).toBe(false);
  });
});

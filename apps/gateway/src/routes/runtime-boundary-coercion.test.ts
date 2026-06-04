import { describe, expect, it } from "vitest";
import { coerceBoundedInteger } from "./runtime-boundary-coercion.js";

describe("runtime-boundary-coercion", () => {
  it("coerces malformed, empty, non-finite, negative, string numeric, and huge integer inputs", () => {
    const options = { defaultValue: 20, min: 1, max: 500 };

    expect(coerceBoundedInteger(undefined, options)).toBe(20);
    expect(coerceBoundedInteger("", options)).toBe(20);
    expect(coerceBoundedInteger("nope", options)).toBe(20);
    expect(coerceBoundedInteger("Infinity", options)).toBe(20);
    expect(coerceBoundedInteger(-5, options)).toBe(1);
    expect(coerceBoundedInteger("25", options)).toBe(25);
    expect(coerceBoundedInteger(25.9, options)).toBe(25);
    expect(coerceBoundedInteger("999999999", options)).toBe(500);
  });
});

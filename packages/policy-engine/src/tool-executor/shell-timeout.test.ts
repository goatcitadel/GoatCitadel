import { describe, expect, it } from "vitest";
import { resolveShellExecTimeout } from "./shell-timeout.js";

describe("bounded foreground timeout", () => {
  it("preserves the default and accepts an explicit long task limit", () => {
    expect(resolveShellExecTimeout(undefined, 20000)).toBe(20000);
    expect(resolveShellExecTimeout(300000, 20000)).toBe(300000);
  });
  it.each([0, -1, 999, 900001, Infinity, NaN, 1000.5, "300000", null])(
    "rejects invalid limits before spawn: %s",
    (value) => {
      expect(() => resolveShellExecTimeout(value, 20000)).toThrow("timeoutMs");
    },
  );
});

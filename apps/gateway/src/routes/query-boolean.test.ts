import { z } from "zod";
import { describe, expect, it } from "vitest";
import { queryBoolean } from "./query-boolean.js";

describe("queryBoolean", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    ["FALSE", false],
    [true, true],
    [false, false],
  ])("parses %j as %j", (input, expected) => {
    expect(queryBoolean.parse(input)).toBe(expected);
  });

  it.each(["", "yes", "no", "2", "null", "undefined"])("rejects %j", (input) => {
    expect(queryBoolean.safeParse(input).success).toBe(false);
  });

  it("works with optional and default wrappers", () => {
    expect(z.object({ a: queryBoolean.optional() }).parse({})).toEqual({});
    expect(z.object({ a: queryBoolean.optional() }).parse({ a: "false" })).toEqual({ a: false });
    expect(z.object({ raw: queryBoolean.default(false) }).parse({ raw: "false" })).toEqual({ raw: false });
    expect(z.object({ raw: queryBoolean.default(false) }).parse({})).toEqual({ raw: false });
  });
});

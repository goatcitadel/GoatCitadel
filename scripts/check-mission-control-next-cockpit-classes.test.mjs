import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findArbitraryClassValues } from "./check-mission-control-next-cockpit-classes.mjs";

describe("cockpit class guard", () => {
  it("flags arbitrary values in utility positions", () => {
    const source = 'const item = <div className="w-[13px] bg-(--x) text-fg" />;';
    assert.deepEqual(findArbitraryClassValues("item.tsx", source).map((finding) => finding.token),
      ["w-[13px]", "bg-(--x)"]);
  });

  it("accepts bracketed variants and named utilities", () => {
    const source = 'const item = cn("data-[state=open]:bg-sunken", "aria-[current=page]:text-fg", "lg:grid-cols-3");';
    assert.deepEqual(findArbitraryClassValues("item.tsx", source), []);
  });
});

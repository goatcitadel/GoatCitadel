import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBreakpointViolations } from "./check-mission-control-next-breakpoints.mjs";

describe("breakpoint guard", () => {
  it("accepts canonical widths in CSS and TypeScript", () => {
    assert.deepEqual(findBreakpointViolations("a.css", "@media (max-width: 639px) { a {} }"), []);
    assert.deepEqual(findBreakpointViolations("a.tsx", 'useMediaQuery("(width < 1280px)")'), []);
  });

  it("reports noncanonical widths and source lines", () => {
    assert.deepEqual(findBreakpointViolations("a.css", "a {}\n@media (max-width: 767px) { a {} }"),
      [{ file: "a.css", line: 2, value: "max-width: 767px" }]);
    assert.deepEqual(findBreakpointViolations("a.ts", 'matchMedia("(min-width: 900px)")'),
      [{ file: "a.ts", line: 1, value: "min-width: 900px" }]);
  });

  it("ignores height and declarations inside media blocks", () => {
    assert.deepEqual(findBreakpointViolations("a.css", "@media (max-height: 699px) { a { max-width: 767px; } }"), []);
  });
});

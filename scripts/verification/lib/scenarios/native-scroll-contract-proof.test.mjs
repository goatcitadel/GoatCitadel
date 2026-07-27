import assert from "node:assert/strict";
import { test } from "node:test";

import { validateNativeNestedScrollerSnapshot, validateNativeStageSnapshot } from "./native-scroll-contract-proof.mjs";

test("accepts a bounded native stage at its visible bottom", () => {
  assert.doesNotThrow(() =>
    validateNativeStageSnapshot(
      {
        found: true,
        overflowY: "auto",
        clientHeight: 700,
        documentScrollTop: 0,
        atBottom: true,
        contentBottom: 680,
        visibleBottom: 700,
      },
      "settings-providers",
    ),
  );
});

test("rejects document scrolling and obscured route bottoms", () => {
  assert.throws(
    () =>
      validateNativeStageSnapshot(
        { found: true, overflowY: "auto", clientHeight: 700, documentScrollTop: 20, atBottom: false },
        "ops-runtime",
      ),
    /document scrolled/,
  );
  assert.throws(
    () =>
      validateNativeStageSnapshot(
        {
          found: true,
          overflowY: "auto",
          clientHeight: 700,
          documentScrollTop: 0,
          atBottom: true,
          contentBottom: 730,
          visibleBottom: 700,
        },
        "ops-runtime",
      ),
    /final route content remained below/,
  );
});

test("requires nested native collections to hand vertical scrolling to the stage", () => {
  assert.doesNotThrow(() =>
    validateNativeNestedScrollerSnapshot({ found: true, overscrollBehaviorY: "auto" }, "library-skills"),
  );
  assert.throws(
    () => validateNativeNestedScrollerSnapshot({ found: true, overscrollBehaviorY: "contain" }, "library-skills"),
    /blocked vertical handoff/,
  );
});

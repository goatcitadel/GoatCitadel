import assert from "node:assert/strict";
import test from "node:test";
import { readLongListCount } from "./cockpit-long-list-fixture.mjs";

test("keeps the lane's 105 records unless a large-data run asks for more", () => {
  assert.equal(readLongListCount(undefined), 105);
  assert.equal(readLongListCount(""), 105);
  assert.equal(readLongListCount("1000"), 1000);
});

test("rejects counts the proof cannot use or that would run for hours", () => {
  for (const raw of ["abc", "100", "2001", "1.5", "-5"]) {
    assert.throws(() => readLongListCount(raw), /GOATCITADEL_VERIFY_LONG_LIST_COUNT/);
  }
});

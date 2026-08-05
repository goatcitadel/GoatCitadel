import assert from "node:assert/strict";
import test from "node:test";

import { listZipEntryNames } from "./research-artifact-reliability.mjs";

test("ZIP central-directory parser fails closed on non-archives", () => {
  assert.throws(() => listZipEntryNames(Buffer.from("not a zip")), /end-of-central-directory/u);
});

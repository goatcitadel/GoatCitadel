import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as storage from "./index.js";

describe("storage public API", () => {
  it("does not expose test-only internals through the package root", () => {
    for (const key of [
      "__approvalInboxInternals",
      "__postgresSyncInternals",
      "__sqliteInternals",
      "__taskRepoInternals",
    ]) {
      assert.equal(Object.hasOwn(storage, key), false, `${key} leaked through the storage root export`);
    }
  });
});

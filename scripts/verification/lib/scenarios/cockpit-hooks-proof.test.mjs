import assert from "node:assert/strict";
import { it } from "node:test";
import { assertHookReviewHasNoEffects } from "./cockpit-hooks-proof.mjs";
it("rejects changed hook evidence, attempted mutations and persisted signing inputs", () => {
  const before = { hooks: [], runs: [] }, input = { before, after: before, writes: [], persistedValues: ["unrelated"], secret: "synthetic-input" };
  assert.doesNotThrow(() => assertHookReviewHasNoEffects(input));
  for (const patch of [{ after: { hooks: [{ hookId: "new" }], runs: [] } }, { after: { hooks: [], runs: [{ runId: "sent" }] } },
    { writes: [{ method: "POST", pathname: "/hooks" }] }, { persistedValues: ["synthetic-input"] }])
    assert.throws(() => assertHookReviewHasNoEffects({ ...input, ...patch }));
});

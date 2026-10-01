import assert from "node:assert/strict";
import test from "node:test";
import { assertFirstRunPreserved } from "./cockpit-first-run-proof.mjs";
const fixture = () => ({ before: { completed: false, settings: { revision: 3 }, firstTask: { status: "not_observed" } },
  after: { completed: false, settings: { revision: 3 }, firstTask: { status: "not_observed" } },
  writes: [{ method: "POST", path: "/api/v1/onboarding/complete", body: { completedBy: "operator" } }], forwarded: 0 });
test("accepts exact intercepted completion and unchanged real owner", () => assert.doesNotThrow(() => assertFirstRunPreserved(fixture())));
test("rejects real marker/settings/inference changes or a forwarded completion", () => {
  for (const change of [{ after: { completed: true } }, { after: { ...fixture().after, settings: { revision: 4 } } },
    { after: { ...fixture().after, firstTask: { status: "verified" } } }, { forwarded: 1 }])
    assert.throws(() => assertFirstRunPreserved({ ...fixture(), ...change }));
});
test("rejects duplicate or changed completion payload and unrelated writes", () => {
  for (const writes of [[...fixture().writes, ...fixture().writes], [{ ...fixture().writes[0], body: { completedBy: "foreign" } }],
    [{ method: "PATCH", path: "/api/v1/settings", body: {} }]])
    assert.throws(() => assertFirstRunPreserved({ ...fixture(), writes }));
});

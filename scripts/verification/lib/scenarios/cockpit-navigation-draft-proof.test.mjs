import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNavigationDraftOwner } from "./cockpit-navigation-draft-proof.mjs";

const proof = () => ({ before: { items: [{ grantId: "existing", decision: "deny", scopeRef: "workspace-a" }] },
  after: { items: [{ grantId: "existing", decision: "deny", scopeRef: "workspace-a" }] },
  writes: [], origin: 123, current: 123, retained: "inert-unsaved-pattern", expected: "inert-unsaved-pattern" });
test("draft navigation keeps exact canonical grants, text and realm without writes", () => assertNavigationDraftOwner(proof()));
for (const defect of ["owner", "write", "document", "text"]) {
  test(`rejects ${defect} drift in a purported presentation-only journey`, () => {
    const value = proof();
    if (defect === "owner") value.after.items[0].scopeRef = "foreign";
    if (defect === "write") value.writes.push({ method: "POST", pathname: "/api/v1/tools/grants" });
    if (defect === "document") value.current++;
    if (defect === "text") value.retained = "";
    assert.throws(() => assertNavigationDraftOwner(value));
  });
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAuthBaselinePreserved } from "./cockpit-gateway-auth-proof.mjs";
const fixture = () => {
  const before = { revision: 12, auth: { mode: "none", allowLoopbackBypass: true, tokenConfigured: false }, toolApprovalMode: "approve_risky" };
  const request = { expectedRevision: 12, mode: "token", allowLoopbackBypass: false, token: "synthetic-fixture" };
  return { before, after: structuredClone(before), request, expected: structuredClone(request), intercepted: 1 };
};
describe("native auth browser proof evidence", () => {
  it("accepts exact intercepted intent and unchanged real owner", () => assert.doesNotThrow(() => assertAuthBaselinePreserved(fixture())));
  it("rejects an auth or policy change and unexpected owner revision", () => {
    for (const patch of [{ revision: 13 }, { auth: { mode: "token" } }, { toolApprovalMode: "bypass" }]) {
      const value = fixture(); assert.throws(() => assertAuthBaselinePreserved({ ...value, after: { ...value.after, ...patch } }));
    }
  });
  it("rejects altered intent or missing interception instead of claiming a safe transport fixture", () => {
    const value = fixture(); assert.throws(() => assertAuthBaselinePreserved({ ...value, intercepted: 0 }));
    assert.throws(() => assertAuthBaselinePreserved({ ...value, request: { ...value.request, expectedRevision: 11 } }));
    assert.throws(() => assertAuthBaselinePreserved({ ...value, request: { ...value.request, extra: "unreviewed" } }));
  });
});

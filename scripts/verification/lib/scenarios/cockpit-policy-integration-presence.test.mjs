import assert from "node:assert/strict";
import test from "node:test";
import { createPolicyMutationRecorder } from "./cockpit-library-policy-proof.mjs";
import { createIntegrationMutationRecorder } from "./cockpit-integration-connections-proof.mjs";

const expected = { workspaceId: "workspace-a", clientId: "independent-client", leaseId: "independent-lease" };
function heartbeat(change = {}) {
  const body = { ...expected, focused: true, visible: true, ttlMs: 90_000 };
  const receipt = { ...expected, focused: true, visible: true, updatedAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T00:01:30.000Z" };
  return { method: "PUT", pathname: "/api/v1/notifications/presence", body, status: 200, receipt, ...change };
}
function request(value) {
  return { url: () => "http://fixture.invalid" + value.pathname, method: () => value.method,
    postDataJSON: () => value.body,
    response: () => value.response ?? Promise.resolve({ status: () => value.status, json: async () => value.receipt }) };
}
const owners = [
  { name: "policy", create: createPolicyMutationRecorder, writes: recorder => recorder.mutations,
    owner: { method: "POST", pathname: "/api/v1/tools/access/evaluate", body: { toolName: "fs.read", workspaceId: "workspace-a", args: { path: " ./exact.txt " } } } },
  { name: "integration", create: createIntegrationMutationRecorder, writes: recorder => recorder.writes,
    owner: { method: "PATCH", pathname: "/api/v1/integrations/connections/synthetic-one", body: { expectedRevision: "a".repeat(64), enabled: true } } },
];
for (const owner of owners) {
  test(`${owner.name}: validated exact presence remains evidence while zero/one owner write stays exact`, async () => {
    const recorder = owner.create();
    assert.equal(owner.writes(recorder).length, 0);
    if (owner.name === "policy") assert.equal(recorder.policyRequests.length, 0);
    recorder.record(request(heartbeat()));
    assert.equal(owner.writes(recorder).length, 0, "Mounted presence is not an operator-owner mutation");
    assert.equal(recorder.total, 1); assert.equal(recorder.presence.length, 1, "Presence must be retained, not ignored");
    await recorder.assertBackground(expected);
    recorder.record(request(owner.owner));
    assert.equal(owner.writes(recorder).length, 1); assert.equal(recorder.total, 2);
    if (owner.name === "policy") {
      assert.equal(recorder.policyRequests.length, 1);
      assert.deepEqual(recorder.policyRequests[0].postDataJSON(), owner.owner.body);
    } else assert.deepEqual(recorder.writes[0], owner.owner);
    await recorder.assertBackground(expected);
  });
  test(`${owner.name}: wrong methods and lookalike presence owners cannot disappear`, () => {
    for (const change of [{ method: "POST" }, { method: "PATCH" }, { method: "DELETE" },
      { pathname: "/api/v1/notifications/presence/" }, { pathname: "/api/v1/notifications/presence-extra" }, { pathname: "/api/v1/notifications/settings" }]) {
      const recorder = owner.create();recorder.record(request(heartbeat(change)));
      assert.equal(owner.writes(recorder).length, 1);assert.equal(recorder.total, 1);assert.equal(recorder.presence.length, 0);
    }
  });
  test(`${owner.name}: foreign, failed, malformed or missing presence receipts prevent pass`, async () => {
    const good = heartbeat();
    for (const change of [{ status: 403 }, { receipt: { ...good.receipt, workspaceId: "foreign" } },
      { receipt: { ...good.receipt, leaseId: "foreign" } }, { receipt: { ...good.receipt, expiresAt: "2026-11-05T00:02:00.000Z" } },
      { body: { ...good.body, clientId: "foreign" } }, { body: { ...good.body, ttlMs: 1 } },
      { body: { ...good.body, extra: true } }, { response: Promise.resolve(null) }]) {
      const recorder = owner.create();recorder.record(request(heartbeat(change)));
      await assert.rejects(() => recorder.assertBackground(expected));
    }
  });
  test(`${owner.name}: background validation waits for the actual owner receipt`, async () => {
    let release;const response = new Promise(resolve => { release = resolve; });
    const recorder = owner.create();recorder.record(request(heartbeat({ response })));
    let completed = false;const validation = recorder.assertBackground(expected).then(() => { completed = true; });
    await Promise.resolve();await Promise.resolve();
    const prematurelyCompleted = completed;
    const good = heartbeat();release({ status: () => good.status, json: async () => good.receipt });
    await validation;assert.equal(prematurelyCompleted, false, "Unsettled presence cannot be promoted to validated background traffic");
  });
}

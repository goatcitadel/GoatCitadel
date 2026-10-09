import assert from "node:assert/strict";
import { it } from "node:test";
import { createReviewedMutationRecorder } from "./cockpit-reviewed-mutations.mjs";
const identity = { workspaceId: "workspace", clientId: "client", leaseId: "lease" };
const body = { ...identity, focused: true, visible: true, ttlMs: 90_000 };
const receipt = { ...identity, focused: true, visible: true, updatedAt: "2026-10-06T00:00:00Z", expiresAt: "2026-10-06T00:01:30Z" };
const request = (pathname, method, input, output = receipt, status = 200) => ({ url: () => `http://fixture${pathname}`,
  method: () => method, postDataJSON: () => input, response: async () => ({ status: () => status, json: async () => output }) });
it("separates only a verified presence lease and keeps every mutation in totals", async () => {
  const traffic = createReviewedMutationRecorder();
  traffic.record(request("/api/v1/notifications/presence", "PUT", body));
  await traffic.assertBackground(identity);
  assert.deepEqual(traffic.writes, []); assert.equal(traffic.total, 1); assert.equal(traffic.presence.length, 1);
  traffic.record(request("/api/v1/tools/grants", "POST", { scope: "global" }));
  traffic.record(request("/api/v1/unexpected-owner", "DELETE", null));
  assert.equal(traffic.writes.length, 2); assert.equal(traffic.total, 3);
});
it("rejects wrong presence method, scope, body, failed response and substituted receipt", async () => {
  for (const [method, input, output, status] of [["POST", body, receipt, 200], ["PUT", { ...body, workspaceId: "foreign" }, receipt, 200],
    ["PUT", { ...body, sessionId: "unexpected" }, receipt, 200], ["PUT", body, receipt, 403],
    ["PUT", body, { ...receipt, leaseId: "foreign" }, 200]]) {
    const traffic = createReviewedMutationRecorder(); traffic.record(request("/api/v1/notifications/presence", method, input, output, status));
    await assert.rejects(() => traffic.assertBackground(identity));
  }
});
it("records auth transport separately with exact owner validation and includes it in totals", async () => {
  const traffic = createReviewedMutationRecorder();
  traffic.record(request("/api/v1/auth/sse-token", "POST", { scope: "events:stream" },
    { scope: "events:stream", token: "a".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await traffic.assertBackground(identity); assert.equal(traffic.observers.length, 1); assert.equal(traffic.total, 1);
  assert.deepEqual(traffic.writes, []);
  const bad = createReviewedMutationRecorder(); bad.record(request("/api/v1/auth/sse-token", "POST", { scope: "admin" }));
  await assert.rejects(() => bad.assertBackground(identity));
});

it("binds the per-mount in-memory lease across a page while checking the independent stored client", async () => {
  const traffic = createReviewedMutationRecorder(), page = { evaluate: async () => identity.clientId };
  traffic.record(request("/api/v1/notifications/presence", "PUT", body));
  await traffic.assertPageBackground(page, identity.workspaceId);
  traffic.record(request("/api/v1/notifications/presence", "PUT", { ...body, leaseId: "other" }, { ...receipt, leaseId: "other" }));
  await assert.rejects(() => traffic.assertPageBackground(page, identity.workspaceId));
  const absent = createReviewedMutationRecorder();
  await assert.rejects(() => absent.assertPageBackground(page, identity.workspaceId));
});

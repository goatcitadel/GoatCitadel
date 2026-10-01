import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCockpitObserverRequest,
  recordCockpitObserverRequest,
  assertCockpitObserverRequests,
} from "./cockpit-observer-requests.mjs";

test("observer classification permits only the exact event bridge or scoped route inspection", () => {
  const expected = {
    sessionId: "session/a",
    prefsOverride: { providerId: "fixture", model: "model", memoryMode: "off" },
  };
  const bridge = { method: "POST", pathname: "/api/v1/auth/sse-token", body: { scope: "events:stream" } };
  assert.equal(assertCockpitObserverRequest(bridge), "event-bridge");
  const route = {
    method: "POST",
    pathname: "/api/v1/chat/sessions/session%2Fa/route-preflight",
    body: { action: "send", fullWebAccess: true },
  };
  assert.equal(assertCockpitObserverRequest(route, expected), "route-inspection");
  assertCockpitObserverRequest({ ...route, body: { ...route.body, prefsOverride: expected.prefsOverride } }, expected);
  for (const entry of [
    { ...bridge, method: "PUT" },
    { ...bridge, body: { scope: "dev:diagnostics:stream" } },
    { ...bridge, body: { ...bridge.body, actorId: "other" } },
    { ...route, pathname: "/api/v1/chat/sessions/foreign/route-preflight" },
    { ...route, pathname: "/api/v1/chat/sessions/session%2Fa/agent-send" },
    { ...route, body: { ...route.body, content: "execute" } },
    { ...route, body: { ...route.body, prefsOverride: { ...expected.prefsOverride, model: "other" } } },
  ])
    assert.throws(() => assertCockpitObserverRequest(entry, expected));
});

test("actual bridge acknowledgement is required and its token is not retained in evidence", async () => {
  const entries = [],
    receipt = {
      scope: "events:stream",
      token: "a".repeat(43),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  const request = {
    url: () => "http://127.0.0.1/api/v1/auth/sse-token",
    method: () => "POST",
    postDataJSON: () => ({ scope: "events:stream" }),
    response: async () => ({ status: () => 200, json: async () => receipt }),
  };
  assert.equal(recordCockpitObserverRequest(request, entries), true);
  await assertCockpitObserverRequests(entries);
  assert.equal(JSON.stringify(entries).includes(receipt.token), false);
  assert.deepEqual(entries[0].evidence, { scope: receipt.scope, expiresAt: receipt.expiresAt });
  assert.equal(
    recordCockpitObserverRequest({ ...request, url: () => "http://127.0.0.1/api/v1/approvals/approve" }, entries),
    false,
  );
  const bad = [];
  recordCockpitObserverRequest({ ...request, postDataJSON: () => ({ scope: "dev:diagnostics:stream" }) }, bad);
  await assert.rejects(assertCockpitObserverRequests(bad));
});

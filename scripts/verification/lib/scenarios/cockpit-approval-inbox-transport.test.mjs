import assert from "node:assert/strict";
import test from "node:test";
import { matchInboxOwnerRead, readInboxOwnerResult, createHeldInboxOwnerRoute, createOwnerReadDiagnostic } from "./cockpit-approval-mode-proof.mjs";
const inbox = () => ({ authority: "derived_projection", workspaceId: "default", items: [] });
const item = path => ({ path, correlationId: "synthetic-correlation", originSurface: "inbox" });
const rows = () => [item("/api/v1/settings"), item("/api/v1/inbox?workspaceId=default"), item("/api/v1/workspaces")];
const request = (entries = rows()) => ({ method: () => "GET", url: () => "http://fixture.invalid/api/v1/startup-reads?" + new URLSearchParams({ reads: JSON.stringify(entries) }) });
const direct = () => ({ method: () => "GET", url: () => "http://fixture.invalid/api/v1/inbox?workspaceId=default" });
const response = body => ({ status: () => 200, json: async () => body });
const envelope = () => ({ items: [
  { status: 200, bodyText: JSON.stringify({ revision: 1 }), headers: { "content-type": "application/json" } },
  { status: 200, bodyText: JSON.stringify(inbox()), headers: { "content-type": "application/json" } },
  { status: 503, bodyText: JSON.stringify({ error: "synthetic unrelated owner failure" }), headers: {} },
] });
test("direct owner GET remains recognized and its authentic result is returned", async () => {
  assert.deepEqual(matchInboxOwnerRead(direct()), { transport: "direct", index: 0, count: 1 });
  const body = inbox();assert.equal(await readInboxOwnerResult(direct(), response(body)), body);
});
test("RED: batch membership identifies the exact Inbox array index and preserves unrelated owner responses", async () => {
  assert.deepEqual(matchInboxOwnerRead(request()), { transport: "startup_batch", index: 1, count: 3 });
  const body = envelope(), before = structuredClone(body);
  assert.deepEqual(await readInboxOwnerResult(request(), response(body)), inbox());assert.deepEqual(body, before);
});
test("unrelated startup packets and non-GET requests are not captured", () => {
  assert.equal(matchInboxOwnerRead(request([item("/api/v1/settings")])), null);
  assert.equal(matchInboxOwnerRead({ ...direct(), method: () => "POST" }), null);
});
test("RED: malformed, duplicate and foreign Inbox membership cannot authenticate a pre-event capture", () => {
  const malformed = { method: () => "GET", url: () => "http://fixture.invalid/api/v1/startup-reads?reads=not-json" };
  assert.throws(() => matchInboxOwnerRead(malformed));
  for (const entries of [[...rows(), item("/api/v1/inbox?workspaceId=default")],
    [item("/api/v1/inbox?workspaceId=foreign")], [item("/api/v1/inbox?workspaceId=default&workspaceId=foreign")],
    [{ ...rows()[1], unknown: "private-request-canary" }], Array.from({ length: 17 }, () => item("/api/v1/settings"))])
    assert.throws(() => matchInboxOwnerRead(request(entries)));
});
test("RED: response index, status, fallback, authority and workspace are genuine owner requirements", async () => {
  for (const mutate of [
    body => { body.items.pop(); }, body => { body.items[1].status = 403; },
    body => { body.items[1].directReadRequired = true; }, body => { body.items[1].bodyText = "not-json"; },
    body => { body.items[1].bodyText = JSON.stringify({ ...inbox(), workspaceId: "foreign" }); },
    body => { body.items[1].bodyText = JSON.stringify({ ...inbox(), authority: "realtime_event" }); },
    body => { body.items[1].headers.authorization = "private-header-canary"; },
  ]) { const body = envelope();mutate(body);await assert.rejects(() => readInboxOwnerResult(request(), response(body))); }
  await assert.rejects(() => readInboxOwnerResult(direct(), response({ ...inbox(), workspaceId: "foreign" })));
});
test("RED: held batch fetches the original packet once, becomes ready after capture and fulfills unchanged only after release", async () => {
  let release, markReady, held = false, ready = false, fetches = 0, fulfills = 0, continues = 0;
  const readySignal = new Promise(resolve => { markReady = resolve; });
  const gate = new Promise(resolve => { release = resolve; }), body = envelope(), apiResponse = response(body), records = [];
  const route = { request, fetch: async (...args) => { assert.equal(args.length, 0);fetches++;return apiResponse; },
    continue: async () => { continues++; }, fulfill: async value => { fulfills++;assert.deepEqual(Object.keys(value), ["response"]);assert.equal(value.response, apiResponse); } };
  const handler = createHeldInboxOwnerRoute({ isHeld: () => held, onStart: () => { held = true; }, onReady: () => { ready = true;markReady(); }, gate, isClosed: () => false, record: value => records.push(value) });
  const pending = handler(route);await Promise.race([readySignal, pending]);
  const captured = { held, ready, fetches, fulfills };
  await handler(route);release();await pending;
  assert.deepEqual(captured, { held: true, ready: true, fetches: 1, fulfills: 0 });
  assert.equal(fulfills, 1);assert.equal(continues, 1);assert.equal(fetches, 1);
  assert.ok(records.some(value => value.transport === "startup_batch"));
});
test("RED: failed authentic capture never opens readiness or fulfills a replacement response", async () => {
  let ready = false, fulfills = 0;const body = envelope();body.items[1].status = 403;
  const handler = createHeldInboxOwnerRoute({ isHeld: () => false, onStart: () => {}, onReady: () => { ready = true; }, gate: Promise.resolve(), isClosed: () => false });
  await assert.rejects(() => handler({ request, fetch: async () => response(body), continue: async () => {}, fulfill: async () => { fulfills++; } }));
  assert.equal(ready, false);assert.equal(fulfills, 0);
});
test("RED: membership diagnostics retain only a closed transport enum and no packet or secret", () => {
  const diagnostic = createOwnerReadDiagnostic(), canary = "private-membership-canary";
  diagnostic.record({ kind: "route_hit", owner: "inbox", transport: "startup_batch", url: canary, headers: canary, body: canary });
  assert.equal(diagnostic.snapshot().events[0].transport, "startup_batch");
  diagnostic.record({ kind: "route_hit", transport: canary });
  assert.equal(diagnostic.snapshot().events[1].transport, "other");assert.ok(!JSON.stringify(diagnostic.snapshot()).includes(canary));
});

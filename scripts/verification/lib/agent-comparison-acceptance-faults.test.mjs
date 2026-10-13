import assert from "node:assert/strict";
import { it } from "node:test";
import { createAcceptanceFaultControls } from "./agent-comparison-acceptance-faults.mjs";
import { createComparisonProviderProxy } from "./agent-comparison-provider.mjs";
import { ComparisonDispatchBudget, sha256 } from "./agent-comparison.mjs";

const cellId = "goatcitadel:provider_recovery:1",
  runtimeId = "owned-runtime";
const profile = {
  model: "controlled-model",
  reasoning: "none",
  outputField: "max_tokens",
  contextTokens: 4096,
  outputTokens: 128,
  maxTaskMs: 10000,
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    requestUsd: 0,
    observedAt: "2026-10-11T00:00:00.000Z",
    sourceSha256: sha256("test-only rates"),
  },
};
const body = { model: profile.model, messages: [{ role: "user", content: "Controlled test" }] };
async function fixture(t, { rejectEvidence = false } = {}) {
  const observations = [],
    receipts = [];
  const faults = await createAcceptanceFaultControls({
    cellId,
    deadlineAt: Date.now() + 30000,
    persistReceipt: async (receipt) => {
      if (rejectEvidence) throw new Error("disk unavailable");
      observations.push(receipt);
    },
  });
  t.after(() => faults.close());
  faults.bindRuntime(runtimeId);
  return { faults, observations, receipts };
}
async function proxyFixture(t, options) {
  const result = await fixture(t, options);
  let upstreamCalls = 0;
  const budget = new ComparisonDispatchBudget({ maxRequests: 2, maxCostUsd: 1, persist: async () => {} });
  const proxy = await createComparisonProviderProxy({
    budget,
    cellId,
    profile,
    upstreamUrl: "https://comparison.invalid/v1/chat/completions",
    upstreamApiKey: "test-secret-never-retained",
    persistReceipt: async (receipt) => result.receipts.push(receipt),
    acceptanceFaults: result.faults,
    fetchUpstream: async () => {
      upstreamCalls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "controlled success" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  t.after(() => proxy.close());
  const send = (input = body) =>
    fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  return { ...result, proxy, send, budget, upstreamCalls: () => upstreamCalls };
}
async function rpc(connection, method, params = {}) {
  return fetch(connection.url, {
    method: "POST",
    headers: { ...connection.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

it("charges one reserved request for a controlled pre-forward failure and retains actual subsequent usage", async (t) => {
  const test = await proxyFixture(t);
  const armed = test.faults.armPreDispatchFailure({ runtimeId, providerId: "comparison" });
  assert.equal(armed.boundary, "before_upstream_forward");
  // Malformed input must not consume an armed fault or a request allowance.
  assert.equal((await test.send({ ...body, model: "wrong" })).status, 400);
  const replies = await Promise.all([test.send(), test.send()]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 503]);
  assert.equal(test.upstreamCalls(), 1);
  assert.equal(test.budget.snapshot().requests, 2);
  assert.ok(test.budget.snapshot().receipts.every((receipt) => receipt.state === "settled"));
  const failed = test.receipts.find((receipt) => receipt.status === 503);
  assert.equal(failed.costUsd, 0);
  assert.equal(failed.usage, null);
  assert.equal(failed.costKind, "controlled_no_upstream_forward");
  assert.equal(failed.controlledFault.upstreamForwarded, false);
  assert.equal(failed.controlledFault.nativeTransportReachedFixture, true);
  assert.equal(failed.controlledFault.usefulOutputBytes, 0);
  assert.deepEqual(test.faults.observeProviderFault({ runtimeId }), failed.controlledFault);
  assert.deepEqual(test.receipts.find((receipt) => receipt.status === 200).usage, { inputTokens: 10, outputTokens: 5 });
  assert.throws(() => test.faults.armPreDispatchFailure({ runtimeId, providerId: "comparison" }), /one initial/);
  assert.equal((await test.send()).status, 429);
  assert.doesNotMatch(
    JSON.stringify({ observations: test.observations, receipts: test.receipts }),
    /test-secret-never-retained/,
  );
});

it("does not forward or settle an attempt when the controlled fault evidence cannot persist", async (t) => {
  const test = await proxyFixture(t, { rejectEvidence: true });
  test.faults.armPreDispatchFailure({ runtimeId, providerId: "comparison" });
  assert.equal((await test.send()).status, 502);
  assert.equal(test.upstreamCalls(), 0);
  assert.equal(test.budget.snapshot().receipts[0].state, "unknown");
  assert.throws(() => test.faults.observeProviderFault({ runtimeId }), /persistence failed/);
  assert.equal((await test.send()).status, 502);
  assert.equal(test.upstreamCalls(), 0);
});

it("records the actual nonce-bound marker before dropping its response and counts repeat dispatches", async (t) => {
  const test = await fixture(t);
  const connection = test.faults.getEffectConnection({ runtimeId });
  const wrongAuth = await rpc({ ...connection, headers: { authorization: "Bearer other" } }, "tools/list");
  assert.equal(wrongAuth.status, 401);
  assert.equal((await rpc(connection, "initialize")).status, 200);
  const listed = await (await rpc(connection, "tools/list")).json();
  const args = { marker: listed.result.tools[0].inputSchema.properties.marker.const };
  assert.equal((await rpc(connection, "tools/call", { name: "record_marker", arguments: args })).status, 403);
  assert.equal(test.observations.length, 0);
  test.faults.bindEffectTool({ runtimeId, toolName: "mcp.fixture.record_marker" });
  const setup = test.faults.armUncertainEffect({ runtimeId });
  assert.equal(setup.argsSha256, sha256(args));
  assert.ok(setup.prompt.length < 8000);
  assert.doesNotMatch(JSON.stringify(setup), new RegExp(connection.headers.authorization.slice(7)));
  assert.equal(
    (await rpc(connection, "tools/call", { name: "record_marker", arguments: { marker: "wrong" } })).status,
    403,
  );
  await assert.rejects(rpc(connection, "tools/call", { name: "record_marker", arguments: args }));
  const native = { runtimeId, effectId: "native-effect", toolName: setup.toolName, argsSha256: setup.argsSha256 };
  const one = test.faults.observeEffectTransport(native);
  assert.equal(one.dispatches.length, 1);
  assert.equal(one.automaticRetries, 0);
  assert.equal(one.dispatches[0].outcome, "unknown_after_send");
  assert.equal(one.dispatches[0].responseIntentionallyDropped, true);
  assert.equal(test.observations[0].transportReceiptId, one.dispatches[0].transportReceiptId);
  await assert.rejects(rpc(connection, "tools/call", { name: "record_marker", arguments: args }));
  assert.equal(test.faults.observeEffectTransport(native).automaticRetries, 1);
  assert.throws(
    () => test.faults.observeEffectTransport({ ...native, argsSha256: sha256("other") }),
    /cannot be joined/,
  );
});

it("requires parent review for credential-free loopback discovery and still refuses an unarmed effect", async (t) => {
  const { faults, observations } = await fixture(t);
  const privateConnection = faults.getEffectConnection({ runtimeId });
  const publicConnection = { url: privateConnection.url, headers: {} };
  assert.equal((await rpc(publicConnection, "tools/list")).status, 401);
  assert.throws(() => faults.enableReviewedPublicTransport({ runtimeId: "foreign-runtime" }), /different/);
  const reviewed = faults.enableReviewedPublicTransport({ runtimeId });
  assert.equal(reviewed.authType, "none");
  assert.equal(new URL(reviewed.url).hostname, "127.0.0.1");
  const listed = await (await rpc(publicConnection, "tools/list")).json();
  const args = { marker: listed.result.tools[0].inputSchema.properties.marker.const };
  assert.equal((await rpc(publicConnection, "tools/call", { name: "record_marker", arguments: args })).status, 403);
  assert.equal(observations.length, 0);
  assert.throws(() => faults.enableReviewedPublicTransport({ runtimeId }), /once/);
});

it("refuses unsupported cells, cross-runtime control, cancellation and use after owned shutdown", async (t) => {
  await assert.rejects(
    createAcceptanceFaultControls({
      cellId: "goatcitadel:cited_research:1",
      deadlineAt: Date.now() + 1000,
      persistReceipt: async () => {},
    }),
    /provider-recovery/,
  );
  const { faults } = await fixture(t),
    aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  assert.throws(() => faults.getEffectConnection({ runtimeId: "another" }), /different/);
  assert.throws(() => faults.getEffectConnection({ runtimeId, signal: aborted.signal }), /cancelled/);
  assert.throws(() => faults.bindRuntime(runtimeId), /once/);
  const connection = faults.getEffectConnection({ runtimeId });
  await faults.close();
  await faults.close();
  await assert.rejects(rpc(connection, "tools/list"));
  assert.throws(() => faults.armPreDispatchFailure({ runtimeId, providerId: "comparison" }), /expired/);
});

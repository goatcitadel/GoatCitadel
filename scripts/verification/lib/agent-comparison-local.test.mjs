import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  ComparisonDispatchBudget,
  COMPARISON_VERSION,
  normalizeComparisonTransport,
  prepareComparison,
  sha256,
  summarizeComparison,
  comparisonMarkdown,
} from "./agent-comparison.mjs";
import { createComparisonProviderProxy } from "./agent-comparison-provider.mjs";
import { openComparisonJournal } from "./agent-comparison-journal.mjs";
import { startComparisonSession } from "./agent-comparison-session.mjs";

const localRuntime = {
  runtime: "controlled-fixture-runtime",
  modelSha256: sha256("fixture model"),
  quantization: "fixture",
  hardware: "test-only",
};
const transportProfile = {
  kind: "local",
  upstreamUrl: "http://127.0.0.1:8080/v1/chat/completions",
  outputField: "max_tokens",
  localRuntime,
};
const product = {
  revision: "a".repeat(40),
  provider: "local-fixture",
  model: "fixture-text",
  reasoning: "none",
  tools: ["files"],
  grants: ["test-workspace"],
  contextTokens: 4096,
  outputTokens: 128,
  maxTaskMs: 1000,
};
const config = {
  schemaVersion: COMPARISON_VERSION,
  trials: 3,
  maxRequests: 2,
  maxCostUsd: 0,
  transportProfile,
  products: Object.fromEntries(["goatcitadel", "openclaw", "hermes"].map((name) => [name, product])),
};
const body = { model: product.model, messages: [{ role: "user", content: "hello" }] };
const response = (usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: "fixture" } }], usage }), {
    headers: { "content-type": "application/json" },
  });

it("permits only explicitly declared literal-loopback local transport, without fictional rates", () => {
  assert.deepEqual(normalizeComparisonTransport(transportProfile), transportProfile);
  assert.equal(
    normalizeComparisonTransport({ ...transportProfile, upstreamUrl: "http://[::1]:8080/v1/chat/completions" }).kind,
    "local",
  );
  for (const upstreamUrl of [
    "http://localhost:8080/v1/chat/completions",
    "http://127.1/v1/chat/completions",
    "http://2130706433/v1/chat/completions",
    "http://0x7f000001/v1/chat/completions",
    "http://192.168.1.1/v1/chat/completions",
    "http://127.0.0.1.evil.invalid/v1/chat/completions",
    "https://provider.invalid/v1/chat/completions",
    "http://user:secret@127.0.0.1/v1/chat/completions",
    "http://127.0.0.1/v1/chat/completions?secret=value",
    "http://127.0.0.1/v1/chat/completions#fragment",
  ]) {
    assert.throws(() => normalizeComparisonTransport({ ...transportProfile, upstreamUrl }), /Comparison upstream/);
  }
  assert.throws(
    () => normalizeComparisonTransport({ ...transportProfile, pricing: { requestUsd: 0 } }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      normalizeComparisonTransport({ ...transportProfile, localRuntime: { ...localRuntime, modelSha256: "unknown" } }),
    /metadata/,
  );
  const { kind, localRuntime: ignored, ...plain } = transportProfile;
  void kind;
  void ignored;
  assert.throws(() => normalizeComparisonTransport(plain), /HTTPS/);
  assert.throws(() => prepareComparison({ ...config, maxCostUsd: 1 }), /zero provider dollars/);
});

async function fixture(t, fetchUpstream = async () => response()) {
  const events = [],
    receipts = [];
  const budget = new ComparisonDispatchBudget({
    maxRequests: 2,
    maxCostUsd: 0,
    allowZeroCost: true,
    persist: async (entry) => events.push(entry),
  });
  const proxy = await createComparisonProviderProxy({
    budget,
    cellId: "goatcitadel:cited_research:1",
    profile: { ...product, outputField: transportProfile.outputField, transportKind: "local", localRuntime },
    upstreamUrl: transportProfile.upstreamUrl,
    persistReceipt: async (entry) => receipts.push(entry),
    fetchUpstream,
  });
  t.after(() => proxy.close());
  const send = (input = body) =>
    fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  return { send, budget, events, receipts, proxy };
}

it("retains actual token usage, zero provider charges and no auth header for an unauthenticated local endpoint", async (t) => {
  const { send, budget, receipts, events } = await fixture(t, async (url, init) => {
    assert.equal(url, transportProfile.upstreamUrl);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.redirect, "error");
    assert.equal(JSON.parse(init.body).max_tokens, 128);
    return response();
  });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  assert.equal(budget.snapshot().requests, 2);
  assert.equal(budget.snapshot().committedOrReservedUsd, 0);
  assert.deepEqual(receipts[0].usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(receipts[0].costUsd, 0);
  assert.equal(receipts[0].costKind, "local_no_provider_charge");
  assert.equal(receipts[0].pricingSha256, null);
  assert.deepEqual(
    events.map((event) => event.state),
    ["reserved", "settled", "reserved", "settled"],
  );
});

it("enforces local token bounds and retains missing/over-limit usage as unsettled instead of inventing measurements", async (t) => {
  let calls = 0;
  const { send, receipts, budget } = await fixture(t, async () => {
    calls++;
    return calls === 1 ? response(null) : response({ prompt_tokens: 10, completion_tokens: 129 });
  });
  assert.equal((await send({ ...body, max_tokens: 129 })).status, 400);
  assert.equal((await send({ ...body, messages: [{ role: "user", content: "x".repeat(4096) }] })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await send()).status, 502);
  assert.equal((await send()).status, 502);
  assert.equal((await send()).status, 429);
  assert.equal(receipts[0].usage, null);
  assert.equal(receipts[0].costUsd, null);
  assert.equal(
    budget.snapshot().receipts.every((entry) => entry.state === "unknown"),
    true,
  );
});

it("recovers zero-dollar local reservations without refunding request counts or weakening hosted journals", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "goat-comparison-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = prepareComparison(config);
  const first = await openComparisonJournal({ directory, manifest });
  await first.budget.dispatch(
    { cellId: "goatcitadel:cited_research:1", role: "child", maximumCostUsd: 0 },
    async () => ({ costUsd: 0 }),
  );
  await assert.rejects(
    first.budget.dispatch({ cellId: "hermes:cited_research:1", role: "retry", maximumCostUsd: 0 }, async () => {
      throw new Error("interrupted");
    }),
    /interrupted/,
  );
  const snapshot = first.snapshot();
  await first.close();
  const second = await openComparisonJournal({ directory, manifest });
  t.after(() => second.close());
  assert.equal(second.budget.snapshot().requests, 2);
  await assert.rejects(
    second.budget.dispatch({ cellId: "openclaw:cited_research:1", role: "primary", maximumCostUsd: 0 }, async () => ({
      costUsd: 0,
    })),
    /exhausted/,
  );
  assert.throws(
    () =>
      new ComparisonDispatchBudget({ maxRequests: 2, maxCostUsd: 0, persist: async () => {}, events: snapshot.events }),
    /Invalid durable/,
  );
  assert.throws(
    () => new ComparisonDispatchBudget({ maxRequests: 2, maxCostUsd: 1, allowZeroCost: true, persist: async () => {} }),
    /zero-dollar/,
  );
  await second.close();
});

it("runs an explicitly controlled local session with zero dollars, bounded deadline and truthful incomplete report", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "goat-comparison-local-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = prepareComparison(config);
  const session = await startComparisonSession({
    manifest,
    campaignDirectory: directory,
    outputDirectory: path.join(directory, "cell"),
    options: {
      schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
      cellId: "goatcitadel:cited_research:1",
      checkoutRoot: directory,
      ...transportProfile,
    },
    checkout: { revision: product.revision, clean: true },
    fetchUpstream: async () => response(),
    evidenceSource: "controlled_fixture",
  });
  t.after(() => session.close());
  const connection = JSON.parse(await readFile(session.connectionFile, "utf8"));
  assert.equal(
    (
      await fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
    200,
  );
  const result = await session.close();
  assert.equal(result.costUsd, 0);
  assert.equal(result.costKind, "local_no_provider_charge");
  assert.equal(result.taskOutcome, "unverified");
  const report = summarizeComparison(manifest, []);
  assert.equal(report.status, "incomplete_or_not_comparable");
  assert.deepEqual(report.localRuntime, localRuntime);
  assert.match(comparisonMarkdown(report), /hardware, electricity and operator time are not priced/);
});

it("aborts local inference at the task deadline without refunding its request reservation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "goat-comparison-local-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bounded = prepareComparison({
    ...config,
    // Preparation is now charged to the same deadline. Leave enough time for
    // file/journal setup so this case reaches and proves transport cancellation.
    products: Object.fromEntries(Object.keys(config.products).map((name) => [name, { ...product, maxTaskMs: 5000 }])),
  });
  let aborted = false;
  const session = await startComparisonSession({
    manifest: bounded,
    campaignDirectory: directory,
    outputDirectory: path.join(directory, "cell"),
    options: {
      schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
      cellId: "goatcitadel:cited_research:1",
      checkoutRoot: directory,
      ...transportProfile,
    },
    checkout: { revision: product.revision, clean: true },
    evidenceSource: "controlled_fixture",
    fetchUpstream: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("deadline"));
          },
          { once: true },
        );
      }),
  });
  t.after(() => session.close());
  const connection = JSON.parse(await readFile(session.connectionFile, "utf8"));
  const request = fetch(`${connection.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const finish = await session.finished;
  await request;
  assert.equal(aborted, true);
  assert.equal(finish.result.reason, "deadline");
  assert.equal(finish.result.requests, 1);
  assert.equal(finish.result.costUsd, null);
  assert.equal(finish.result.taskOutcome, "unverified");
});

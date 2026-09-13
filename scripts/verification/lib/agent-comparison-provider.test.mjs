import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, rm, link, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ComparisonDispatchBudget, COMPARISON_VERSION, prepareComparison, sha256 } from "./agent-comparison.mjs";
import { openComparisonJournal } from "./agent-comparison-journal.mjs";
import { createComparisonProviderProxy } from "./agent-comparison-provider.mjs";

const configuration = {
  schemaVersion: COMPARISON_VERSION,
  trials: 3,
  maxRequests: 3,
  maxCostUsd: 1,
  products: Object.fromEntries(
    ["goatcitadel", "openclaw", "hermes"].map((product) => [
      product,
      {
        revision: "a".repeat(40),
        provider: "fixture",
        model: "fixture-text",
        reasoning: "none",
        tools: [],
        grants: [],
        contextTokens: 4096,
        outputTokens: 128,
        maxTaskMs: 1000,
      },
    ]),
  ),
};
const profile = {
  ...configuration.products.goatcitadel,
  outputField: "max_completion_tokens",
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    requestUsd: 0,
    observedAt: "2026-09-09T00:00:00.000Z",
    sourceSha256: sha256("controlled fixture rate"),
  },
};
const body = { model: profile.model, messages: [{ role: "user", content: "Say hello" }] };

it("accepts native text-part arrays within the same bound and refuses priced or unknown modalities", async (t) => {
  const { send, calls, budget } = await fixture(t);
  const content = [
    { type: "text", text: "First" },
    { type: "text", text: "Second" },
  ];
  assert.equal((await send({ ...body, messages: [{ role: "user", content }] })).status, 200);
  assert.deepEqual(JSON.parse(calls[0].body).messages[0].content, content);
  for (const invalid of [
    [{ type: "image_url", image_url: { url: "https://private.invalid/secret" } }],
    [{ type: "text", text: "ok", audio: "private-sentinel" }],
    [{ type: "text", text: { private: "sentinel" } }],
    [null],
  ]) {
    const response = await send({ ...body, messages: [{ role: "user", content: invalid }] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.message, "Only text and function-tool messages are supported.");
  }
  const oversized = await send({
    ...body,
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] }],
  });
  assert.equal(oversized.status, 400);
  assert.equal(budget.snapshot().requests, 1);
  assert.equal(calls.length, 1);
});

it("returns fixed validation reasons without echoing malformed request data", async (t) => {
  const { proxy, send, calls } = await fixture(t);
  const capped = await send({ ...body, max_completion_tokens: profile.outputTokens + 1 });
  assert.equal((await capped.json()).error.message, "Output token limit exceeds the pinned profile.");
  const malformed = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" },
    body: '{"secret":"PRIVATE_SENTINEL",bad-json}',
  });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /PRIVATE_SENTINEL/);
  assert.equal(calls.length, 0);
});

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "goat-comparison-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, options = {}) {
  const events = [];
  const calls = [];
  const receipts = [];
  const budget =
    options.budget ??
    new ComparisonDispatchBudget({
      maxRequests: options.maxRequests ?? 3,
      maxCostUsd: options.maxCostUsd ?? 1,
      persist: async (event) => events.push(event),
    });
  const proxy = await createComparisonProviderProxy({
    budget,
    cellId: "goatcitadel:cited_research:1",
    profile,
    upstreamUrl: "https://provider.invalid/v1/chat/completions",
    upstreamApiKey: "parent-only-controlled-key",
    persistReceipt: options.persistReceipt ?? (async (receipt) => receipts.push(receipt)),
    fetchUpstream:
      options.fetchUpstream ??
      (async (url, init) => {
        assert.equal(events.at(-1).state, "reserved");
        calls.push({ url, ...init });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "hello" } }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
  });
  t.after(() => proxy.close());
  const send = (value = body, key = proxy.apiKey) =>
    fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  return { proxy, send, events, calls, receipts, budget };
}

describe("durable comparison budget journal", () => {
  it("owns one writer, fsyncs actual requests, and recovers the complete campaign across restart", async (t) => {
    const directory = await temporary(t);
    const manifest = prepareComparison(configuration);
    const first = await openComparisonJournal({ directory, manifest });
    await assert.rejects(openComparisonJournal({ directory, manifest }), /EEXIST/);
    await first.budget.dispatch(
      { cellId: "goatcitadel:cited_research:1", role: "unclassified", maximumCostUsd: 0.4 },
      async () => {
        const raw = await readFile(path.join(directory, "budget.jsonl"), "utf8");
        assert.equal(JSON.parse(raw.trim().split("\n").at(-1)).state, "reserved");
        return { costUsd: 0.1 };
      },
    );
    await assert.rejects(
      first.budget.dispatch({ cellId: "hermes:code_repair:1", role: "retry", maximumCostUsd: 0.4 }, async () => {
        throw new Error("lost response");
      }),
    );
    const previous = first.budget.snapshot();
    await first.close();
    const second = await openComparisonJournal({ directory, manifest });
    assert.deepEqual(second.budget.snapshot(), previous);
    assert.equal(second.snapshot().events.length, 4);
    await second.close();
    await second.close();
  });
  it("refuses drift, partial records, unknown cells, and hard-linked journals", async (t) => {
    const directory = await temporary(t);
    const manifest = prepareComparison(configuration);
    const writer = await openComparisonJournal({ directory, manifest });
    await assert.rejects(
      writer.budget.dispatch({ cellId: "invented", role: "primary", maximumCostUsd: 0.1 }, async () =>
        assert.fail("must not dispatch"),
      ),
      /undeclared/,
    );
    await writer.close();
    await assert.rejects(
      openComparisonJournal({ directory, manifest: prepareComparison({ ...configuration, maxRequests: 4 }) }),
      /another manifest/,
    );
    const file = path.join(directory, "budget.jsonl");
    const original = await readFile(file);
    await appendFile(file, '{"sequence":1');
    await assert.rejects(openComparisonJournal({ directory, manifest }), /incomplete/);
    await writeFile(file, original);
    const alias = path.join(directory, "linked.jsonl");
    await link(file, alias);
    await assert.rejects(openComparisonJournal({ directory, manifest }), /ordinary/);
    await unlink(alias);
    const recovered = await openComparisonJournal({ directory, manifest });
    assert.equal(recovered.budget.snapshot().requests, 0);
    await recovered.close();
  });
});

describe("comparison provider transport", () => {
  it("counts concurrent HTTP attempts without guessing retry/child lineage, and persists before forwarding output", async (t) => {
    const test = await fixture(t, { maxRequests: 2 });
    const responses = await Promise.all([test.send(), test.send(), test.send()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 429]);
    assert.equal(test.calls.length, 2);
    assert.equal(test.budget.snapshot().requests, 2);
    assert.ok(test.events.every((event) => event.role === "unclassified"));
    assert.equal(test.receipts.length, 2);
    assert.equal(test.receipts[0].costUsd, 0.00003);
    const dispatched = JSON.parse(test.calls[0].body);
    assert.equal(dispatched.max_completion_tokens, 128);
    assert.equal(dispatched.reasoning_effort, "none");
    assert.equal(test.calls[0].redirect, "error");
    assert.ok(!JSON.stringify(test.receipts).includes("parent-only-controlled-key"));
    for (const response of responses) await response.text();
  });
  it("blocks unknown models, extra billed surfaces, unbounded input, mismatched reasoning, and stale adapter credentials before spending", async (t) => {
    const test = await fixture(t);
    for (const request of [
      { ...body, model: "other" },
      { ...body, reasoning_effort: "high" },
      { ...body, max_tokens: 9999 },
      {
        ...body,
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://invalid" } }] }],
      },
      { ...body, tools: [{ type: "web_search" }] },
      { ...body, messages: [{ role: "user", content: "x".repeat(4096) }] },
      { ...body, n: 2 },
      { ...body, service_tier: "priority" },
      { ...body, extra_body: { unknown: true } },
    ])
      assert.equal((await test.send(request)).status, 400);
    assert.equal((await test.send(body, "wrong-token")).status, 401);
    assert.equal(test.calls.length, 0);
    assert.equal(test.budget.snapshot().requests, 0);
  });
  it("retains unknown costs at their full maximum and prevents a retry exceeding the dollar cap", async (t) => {
    const maximum = (4096 + 128 * 2) / 1_000_000;
    const test = await fixture(t, {
      maxCostUsd: maximum,
      fetchUpstream: async () => new Response('{"choices":[]}', { headers: { "content-type": "application/json" } }),
    });
    assert.equal((await test.send()).status, 502);
    assert.equal((await test.send()).status, 429);
    assert.equal(test.budget.snapshot().committedOrReservedUsd, maximum);
    assert.equal(test.budget.snapshot().receipts[0].state, "unknown");
    assert.equal(test.receipts[0].costUsd, null);
  });
  it("requires a complete SSE terminal usage record and returns exactly the upstream bytes", async (t) => {
    const wire =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
    const test = await fixture(t, {
      fetchUpstream: async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body).stream_options, { include_usage: true });
        return new Response(wire, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const response = await test.send({ ...body, stream: true });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
    assert.equal(test.receipts[0].responseSha256, sha256(Buffer.from(wire)));
  });
  it("cannot forward model output if native receipt persistence fails", async (t) => {
    const test = await fixture(t, {
      persistReceipt: async () => {
        throw new Error("disk full");
      },
    });
    const response = await test.send();
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("hello"));
    assert.equal(test.budget.snapshot().receipts[0].state, "unknown");
  });
  it("keeps ambiguous network failure secret-safe and leaves no automatic retry", async (t) => {
    let calls = 0;
    const test = await fixture(t, {
      fetchUpstream: async () => {
        calls++;
        throw new Error("Bearer parent-only-controlled-key");
      },
    });
    const response = await test.send();
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(test.receipts).includes("parent-only-controlled-key"));
    assert.ok(!(await response.text()).includes("parent-only-controlled-key"));
    assert.equal(test.receipts[0].status, null);
  });
  it("cannot start upstream dispatch after shutdown while a reservation is still flushing", async (t) => {
    let release;
    let reserved;
    const flushing = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      reserved = resolve;
    });
    const budget = new ComparisonDispatchBudget({
      maxRequests: 1,
      maxCostUsd: 1,
      persist: async (event) => {
        if (event.state === "reserved") {
          reserved();
          await flushing;
        }
      },
    });
    const test = await fixture(t, { budget });
    const request = test.send().catch(() => null);
    await started;
    const closing = test.proxy.close();
    release();
    await closing;
    await request;
    assert.equal(test.calls.length, 0);
    assert.equal(budget.snapshot().receipts[0].state, "unknown");
  });
});

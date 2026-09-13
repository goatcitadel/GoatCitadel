import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { COMPARISON_VERSION, prepareComparison, sha256 } from "./agent-comparison.mjs";
import { readComparisonJson, startComparisonSession } from "./agent-comparison-session.mjs";

const products = Object.fromEntries(
  ["goatcitadel", "openclaw", "hermes"].map((product) => [
    product,
    {
      revision: "a".repeat(40),
      provider: "controlled-fixture",
      model: "fixture-text",
      reasoning: "none",
      contextTokens: 4096,
      outputTokens: 128,
      maxTaskMs: 30_000,
      tools: ["files"],
      grants: ["test-workspace"],
    },
  ]),
);
const pricing = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  requestUsd: 0,
  observedAt: "2026-09-09T00:00:00.000Z",
  sourceSha256: sha256("controlled fixture rates"),
};
const transportProfile = {
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  outputField: "max_completion_tokens",
  pricing,
};
const manifest = prepareComparison({
  schemaVersion: COMPARISON_VERSION,
  products,
  trials: 3,
  maxRequests: 2,
  maxCostUsd: 1,
  transportProfile,
});

async function fixture(t, overrides = {}) {
  const campaignDirectory = await mkdtemp(path.join(tmpdir(), "goat-comparison-session-"));
  t.after(() => rm(campaignDirectory, { recursive: true, force: true }));
  return {
    campaignDirectory,
    outputDirectory: path.join(campaignDirectory, "cell-1"),
    manifest,
    options: {
      schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
      cellId: "goatcitadel:cited_research:1",
      checkoutRoot: campaignDirectory,
      apiKeyEnv: "COMPARISON_PROVIDER_KEY",
      upstreamUrl: "https://provider.invalid/v1/chat/completions",
      outputField: "max_completion_tokens",
      pricing,
    },
    upstreamApiKey: "parent-only-fixture-key",
    checkout: { revision: "a".repeat(40), clean: true },
    fetchUpstream: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    ...overrides,
  };
}
async function send(connection) {
  return fetch(`${connection.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: connection.model, messages: [{ role: "user", content: "hello" }] }),
  });
}

it("rejects untyped or unsupported approval options before creating campaign state", async (t) => {
  for (const nativeApprovalGateway of [true, "true", 1]) {
    const input = await fixture(t);
    input.options.cellId = "hermes:cited_research:1";
    input.options.nativeApprovalGateway = nativeApprovalGateway;
    await assert.rejects(startComparisonSession(input), /Supervised options/);
    assert.deepEqual(await readdir(input.campaignDirectory), []);
  }
  for (const nativeInteractiveCli of [true, "true", 1]) {
    const input = await fixture(t);
    input.options.nativeInteractiveCli = nativeInteractiveCli;
    await assert.rejects(startComparisonSession(input), /Supervised options/);
    assert.deepEqual(await readdir(input.campaignDirectory), []);
  }
});

it("runs a supervised HTTP cell with fsynced evidence and one budget across subsequent cells", async (t) => {
  const input = await fixture(t);
  const first = await startComparisonSession(input);
  t.after(() => first.close());
  const connection = await readComparisonJson(first.connectionFile);
  assert.equal((await readFile(first.promptFile, "utf8")).includes("answer.json"), true);
  assert.match(await readFile(path.join(first.workspace, "sources", "atlas.md"), "utf8"), /100 GB/);
  await assert.rejects(
    startComparisonSession({ ...input, outputDirectory: path.join(input.campaignDirectory, "competing") }),
    /EEXIST/,
  );
  assert.equal((await send(connection)).status, 200);
  const stop = await first.close();
  assert.equal(stop.requests, 1);
  assert.equal(stop.costUsd, 0.00002);
  assert.equal(stop.taskOutcome, "unverified");
  const attempt = await readFile(path.join(first.evidence, stop.nativeReceipts[0].path));
  assert.equal(sha256(attempt), stop.nativeReceipts[0].sha256);
  assert.equal(JSON.parse(attempt).executionId, first.binding.executionId);
  assert.ok(!attempt.toString().includes(input.upstreamApiKey));
  const exported = await readComparisonJson(path.join(input.outputDirectory, "journal-export.json"));
  assert.deepEqual(
    exported.events.map((item) => item.state),
    ["reserved", "settled"],
  );
  await assert.rejects(
    startComparisonSession({ ...input, outputDirectory: path.join(input.campaignDirectory, "hidden-retry") }),
    /already has provider attempts/,
  );
  const next = await startComparisonSession({
    ...input,
    outputDirectory: path.join(input.campaignDirectory, "cell-2"),
    options: { ...input.options, cellId: "hermes:cited_research:1" },
  });
  t.after(() => next.close());
  const nextConnection = await readComparisonJson(next.connectionFile);
  assert.equal((await send(nextConnection)).status, 200);
  assert.equal((await send(nextConnection)).status, 429);
  assert.equal((await next.close()).requests, 1);
  assert.equal(
    (await readComparisonJson(path.join(input.campaignDirectory, "cell-2", "journal-export.json"))).events.length,
    4,
  );
  assert.deepEqual(await next.finished, { ok: true, result: await next.close() });
});

it("keeps reuse inputs out of the source workflow and preserves every earlier invocation", async (t) => {
  const input = await fixture(t);
  input.options.cellId = "goatcitadel:workflow_capture_reuse:1";
  const session = await startComparisonSession(input);
  await session.close();
  assert.deepEqual(await readdir(path.join(session.workspace, "input")), ["source-changes.json"]);
  assert.match(await readFile(session.promptFile, "utf8"), /source-release/);
  assert.doesNotMatch(await readFile(path.join(session.evidence, "session-start.json"), "utf8"), /Duplicate reminder/);
  const original = await readFile(path.join(session.evidence, "session-finish.json"));
  await assert.rejects(startComparisonSession(input), /EEXIST/);
  assert.deepEqual(await readFile(path.join(session.evidence, "session-finish.json")), original);
});

it("retains controlled provenance for an OpenClaw skill session and rejects unsupported workflow owners", async (t) => {
  const input = await fixture(t, { evidenceSource: "controlled_fixture" });
  input.options = {
    ...input.options,
    cellId: "openclaw:workflow_capture_reuse:1",
    nativeApprovalGateway: true,
    nativeSkillWorkflow: true,
  };
  for (const options of [
    { ...input.options, cellId: "hermes:workflow_capture_reuse:1" },
    { ...input.options, nativeApprovalGateway: false },
    { ...input.options, nativeSkillWorkflow: "true" },
    { ...input.options, cellId: "openclaw:cited_research:1" },
  ])
    await assert.rejects(startComparisonSession({ ...input, options }), /Supervised options/);
  await assert.rejects(startComparisonSession({ ...input, evidenceSource: "unverified_guess" }), /evidence source/);
  assert.deepEqual(await readdir(input.campaignDirectory), []);
  const session = await startComparisonSession(input);
  t.after(() => session.close());
  const start = await readComparisonJson(path.join(session.evidence, "session-start.json"));
  assert.equal(start.source, "controlled_fixture");
  assert.equal(start.product, "openclaw");
  assert.deepEqual(await readdir(path.join(session.workspace, "input")), ["source-changes.json"]);
  await session.close();
});

it("pins the same provider endpoint and prices across cells and refuses inline secrets before creating evidence", async (t) => {
  const input = await fixture(t);
  for (const change of [
    { upstreamUrl: "https://other-provider.invalid/v1/chat/completions" },
    { pricing: { ...pricing, requestUsd: 0.1 } },
    { pricing: { ...pricing, apiKey: "must-not-enter-evidence" } },
    { upstreamUrl: "must-not-enter-evidence" },
  ]) {
    await assert.rejects(startComparisonSession({ ...input, options: { ...input.options, ...change } }), (error) => {
      assert.doesNotMatch(error.message, /must-not-enter-evidence/);
      return true;
    });
  }
  assert.deepEqual(await readdir(input.campaignDirectory), []);
});

it("refuses zero budgets, dirty or mismatched source, secret-bearing options, and outputs outside the campaign before setup", async (t) => {
  const input = await fixture(t);
  for (const values of [
    {
      manifest: prepareComparison({
        schemaVersion: COMPARISON_VERSION,
        products,
        trials: 3,
        maxRequests: 0,
        maxCostUsd: 0,
      }),
    },
    { checkout: { revision: "a".repeat(40), clean: false } },
    { checkout: { revision: "b".repeat(40), clean: true } },
    { options: { ...input.options, apiKey: "unallowed-inline-secret" } },
    { outputDirectory: path.join(input.campaignDirectory, "nested", "cell") },
  ])
    await assert.rejects(startComparisonSession({ ...input, ...values }));
  assert.deepEqual(await readdir(input.campaignDirectory), []);
});

it("retains an interrupted upstream reservation and its native failure receipt at deadline", async (t) => {
  const shortProducts = Object.fromEntries(
    Object.entries(products).map(([name, value]) => [name, { ...value, maxTaskMs: 1000 }]),
  );
  const input = await fixture(t, {
    manifest: prepareComparison({
      schemaVersion: COMPARISON_VERSION,
      products: shortProducts,
      transportProfile,
      trials: 3,
      maxRequests: 2,
      maxCostUsd: 1,
    }),
    fetchUpstream: async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("controlled interruption")), { once: true }),
      ),
  });
  const session = await startComparisonSession(input);
  t.after(() => session.close());
  const connection = await readComparisonJson(session.connectionFile);
  const request = send(connection).catch(() => null);
  const result = await session.finished;
  await request;
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, "deadline");
  assert.equal(result.result.requests, 1);
  assert.equal(result.result.costUsd, null);
  assert.equal(result.result.status, "unsettled_provider_cost");
  const exported = await readComparisonJson(path.join(input.outputDirectory, "journal-export.json"));
  assert.equal(exported.events.at(-1).state, "unknown");
});

it("does not replace a malformed input or parse a larger linked input as ordinary JSON", async (t) => {
  const input = await fixture(t);
  const filename = path.join(input.campaignDirectory, "input.json");
  await writeFile(filename, "{");
  await assert.rejects(readComparisonJson(filename));
  assert.equal(await readFile(filename, "utf8"), "{");
  await writeFile(filename, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readComparisonJson(filename), /8 MiB/);
});

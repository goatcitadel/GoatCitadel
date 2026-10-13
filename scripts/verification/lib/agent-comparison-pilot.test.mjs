import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  COMPARISON_VERSION,
  ComparisonDispatchBudget,
  prepareComparison,
  sha256,
  summarizeComparison,
} from "./agent-comparison.mjs";
import { openComparisonPilotJournal } from "./agent-comparison-journal.mjs";
import { createComparisonPilot, preparePilotComparison, pilotFeatureAcceptance } from "./agent-comparison-pilot.mjs";
import { verifyPilotAccounting } from "./agent-comparison-record.mjs";
import { startComparisonSession } from "./agent-comparison-session.mjs";

const pricing = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  requestUsd: 0,
  observedAt: "2026-10-11T00:00:00.000Z",
  sourceSha256: sha256("controlled rates"),
};
const transportProfile = {
  upstreamUrl: "https://fixture.invalid/v1/chat/completions",
  outputField: "max_tokens",
  pricing,
};
const product = {
  revision: "a".repeat(40),
  provider: "fixture",
  model: "fixture-model",
  reasoning: "none",
  tools: ["files"],
  grants: ["test-workspace"],
  contextTokens: 64_000,
  outputTokens: 4096,
  maxTaskMs: 600_000,
};
const config = {
  schemaVersion: COMPARISON_VERSION,
  transportProfile,
  products: Object.fromEntries(["goatcitadel", "openclaw", "hermes"].map((name) => [name, product])),
};
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "goat-comparison-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

it("prepares the full matrices under $25/450 hosted and independent 450/$0 local caps, without passing evidence", async (t) => {
  const pilot = createComparisonPilot({ pilotId: randomUUID(), hostedBudgetDirectory: await temporary(t) });
  const hosted = preparePilotComparison(pilot, config);
  assert.equal(hosted.cells.length, 45);
  assert.equal(hosted.maxRequests, 450);
  assert.equal(hosted.maxCostUsd, 25);
  assert.deepEqual(hosted.pilotBudget, pilot.hostedBudget);
  const local = preparePilotComparison(pilot, {
    ...config,
    transportProfile: {
      kind: "local",
      upstreamUrl: "http://127.0.0.1:8080/v1/chat/completions",
      outputField: "max_tokens",
      localRuntime: {
        runtime: "fixture",
        modelSha256: sha256("fixture"),
        quantization: "fixture",
        hardware: "fixture",
      },
    },
  });
  assert.equal(local.cells.length, 45);
  assert.equal(local.maxRequests, 450);
  assert.equal(local.maxCostUsd, 0);
  assert.equal(local.pilotBudget, undefined);
  assert.equal(summarizeComparison(hosted, []).status, "incomplete_or_not_comparable");
  const features = pilotFeatureAcceptance(pilot);
  assert.equal(features.rows.length, 12);
  assert.ok(features.rows.every((row) => row.status === "not_run" && row.evidence.length === 0));
  assert.ok(features.rows.some((row) => row.id === "scheduled_agent_work"));
  assert.ok(features.rows.some((row) => row.id === "web_research"));
  assert.throws(() => preparePilotComparison({ ...pilot, localMaxRequests: 451 }, config), /authorization/);
  assert.throws(
    () =>
      preparePilotComparison(pilot, {
        ...config,
        products: { ...config.products, hermes: { ...product, contextTokens: 32_000 } },
      }),
    /64,000/,
  );
  const smaller = preparePilotComparison(pilot, {
    ...config,
    products: Object.fromEntries(
      Object.keys(config.products).map((name) => [name, { ...product, contextTokens: 32_000 }]),
    ),
  });
  assert.equal(smaller.products.hermes.contextTokens, 32_000);
  assert.throws(
    () =>
      preparePilotComparison(pilot, {
        ...config,
        products: Object.fromEntries(
          Object.keys(config.products).map((name) => [name, { ...product, contextTokens: 128_000 }]),
        ),
      }),
    /64,000/,
  );
});

it("shares one durable pilot cap across different manifests, rejects concurrent owners and retains unknown attempts", async (t) => {
  const policy = { pilotId: randomUUID(), directory: await temporary(t), maxRequests: 3, maxCostUsd: 1 };
  const first = await openComparisonPilotJournal(policy);
  await assert.rejects(openComparisonPilotJournal(policy), /EEXIST/);
  const cellA = `${"a".repeat(64)}:goatcitadel:cited_research:1`;
  const cellB = `${"b".repeat(64)}:hermes:cited_research:1`;
  await first.budget.dispatch({ cellId: cellA, role: "primary", maximumCostUsd: 0.6 }, async () => ({ costUsd: 0.2 }));
  await assert.rejects(
    first.budget.dispatch({ cellId: cellA, role: "retry", maximumCostUsd: 0.6 }, async () => {
      throw new Error("lost");
    }),
    /lost/,
  );
  await first.close();
  const next = await openComparisonPilotJournal(policy);
  t.after(() => next.close());
  let called = false;
  await assert.rejects(
    next.budget.dispatch({ cellId: cellB, role: "child", maximumCostUsd: 0.3 }, async () => {
      called = true;
      return { costUsd: 0.1 };
    }),
    /exhausted/,
  );
  assert.equal(called, false);
  assert.equal(next.budget.snapshot().requests, 2);
  assert.equal(next.budget.snapshot().committedOrReservedUsd, 0.8);
  await next.close();
  await assert.rejects(openComparisonPilotJournal({ ...policy, maxCostUsd: 2 }), /another manifest/);
});

it("requires matching shared pilot evidence before a cell can be recorded", async (t) => {
  const pilot = createComparisonPilot({ pilotId: randomUUID(), hostedBudgetDirectory: await temporary(t) });
  const manifest = preparePilotComparison(pilot, config);
  const journal = await openComparisonPilotJournal(pilot.hostedBudget);
  t.after(() => journal.close());
  const cellId = "goatcitadel:cited_research:1";
  await journal.budget.dispatch(
    { cellId: `${manifest.manifestSha256}:${cellId}`, role: "primary", maximumCostUsd: 0.1 },
    async () => ({ costUsd: 0.05 }),
  );
  const calls = [{ role: "primary", maximumCostUsd: 0.1, costUsd: 0.05, state: "settled" }];
  const accounting = verifyPilotAccounting(manifest, journal.snapshot(), cellId, calls);
  assert.equal(accounting.requests, 1);
  assert.equal(accounting.committedOrReservedUsd, 0.05);
  assert.throws(() => verifyPilotAccounting(manifest, undefined, cellId, calls), /complete shared pilot/);
  assert.throws(() => verifyPilotAccounting(manifest, journal.snapshot(), cellId, []), /does not match/);
  assert.throws(
    () => verifyPilotAccounting(manifest, journal.snapshot(), cellId, [{ ...calls[0], costUsd: 0 }]),
    /does not match/,
  );
  assert.throws(
    () =>
      new ComparisonDispatchBudget({
        maxRequests: 450,
        maxCostUsd: 25,
        persist: async () => {},
        events: [{ sequence: 1, cellId, role: "primary", maximumCostUsd: 0, state: "reserved", costUsd: null }],
      }),
    /Invalid durable/,
  );
  await journal.close();
});

it("enforces the shared request cap through actual session composition across two campaigns", async (t) => {
  const root = await temporary(t),
    shared = path.join(root, "shared");
  await mkdir(shared);
  const pilotBudget = { pilotId: randomUUID(), directory: shared, maxRequests: 1, maxCostUsd: 1 };
  let upstreamCalls = 0;
  for (const [index, revision] of ["a", "b"].entries()) {
    const directory = path.join(root, `campaign-${index}`);
    await mkdir(directory);
    const manifest = prepareComparison({
      ...config,
      products: Object.fromEntries(
        Object.entries(config.products).map(([name, value]) => [name, { ...value, revision: revision.repeat(40) }]),
      ),
      trials: 3,
      maxRequests: 1,
      maxCostUsd: 1,
      pilotBudget,
    });
    const session = await startComparisonSession({
      manifest,
      campaignDirectory: directory,
      outputDirectory: path.join(directory, "cell"),
      options: {
        schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
        cellId: "goatcitadel:cited_research:1",
        checkoutRoot: directory,
        apiKeyEnv: "FIXTURE_KEY",
        ...transportProfile,
      },
      upstreamApiKey: "fixture-only",
      checkout: { revision: revision.repeat(40), clean: true },
      evidenceSource: "controlled_fixture",
      fetchUpstream: async () => {
        upstreamCalls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "fixture" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    t.after(() => session.close());
    const connection = JSON.parse(await readFile(session.connectionFile, "utf8"));
    const response = await fetch(`${connection.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: product.model, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, index === 0 ? 200 : 429);
    await session.close();
    const exported = JSON.parse(await readFile(path.join(directory, "cell", "pilot-budget-export.json"), "utf8"));
    assert.equal(exported.pilotId, pilotBudget.pilotId);
    assert.equal(exported.events.length, 2);
  }
  assert.equal(upstreamCalls, 1);
});

import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  COMPARISON_VERSION,
  COMPARISON_TASKS,
  comparisonTasks,
  prepareComparison,
  sha256,
  summarizeComparison,
} from "./agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_TASKS, FEATURE_ACCEPTANCE_SUITE } from "./agent-comparison-acceptance-fixtures.mjs";
import { runFeatureAcceptance, verifyFeatureAcceptance } from "./agent-comparison-acceptance.mjs";
import { createComparisonPilot, preparePilotComparison } from "./agent-comparison-pilot.mjs";
import { startComparisonSession } from "./agent-comparison-session.mjs";
import { openComparisonPilotJournal } from "./agent-comparison-journal.mjs";
import { recordComparisonCell, verifyPilotAccounting } from "./agent-comparison-record.mjs";

const hosted = {
  upstreamUrl: "https://fixture.invalid/v1/chat/completions",
  outputField: "max_tokens",
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    requestUsd: 0,
    observedAt: "2026-10-11T00:00:00Z",
    sourceSha256: sha256("rates"),
  },
};
const local = {
  kind: "local",
  upstreamUrl: "http://127.0.0.1:8080/v1/chat/completions",
  outputField: "max_tokens",
  localRuntime: { runtime: "controlled", modelSha256: sha256("model"), quantization: "fixture", hardware: "fixture" },
};
const product = {
  revision: "a".repeat(40),
  provider: "fixture",
  model: "fixture-model",
  reasoning: "none",
  tools: ["files"],
  grants: ["test-workspace"],
  contextTokens: 64000,
  outputTokens: 4096,
  maxTaskMs: 600000,
};
const products = Object.fromEntries(["goatcitadel", "openclaw", "hermes"].map((name) => [name, product]));
const at = (seconds) => new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString();
const event = (kind, id, time, data = {}) => ({ kind, id, at: at(time), ...data });
const scope = { runId: "run", turnId: "turn" };
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "goat-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fixture(taskId) {
  if (taskId === "web_research") {
    const claims = [
      {
        id: "postgres",
        text: "First factual claim",
        url: "https://postgresql.org/docs/current/transaction-iso.html",
        quote: "First evidence",
      },
      {
        id: "sqlite",
        text: "Second factual claim",
        url: "https://sqlite.org/isolation.html",
        quote: "Second evidence",
      },
    ];
    const answer = {
      claims,
      conflicts: [{ claimIds: ["postgres", "sqlite"], explanation: "These describe distinct documented behaviors." }],
    };
    return {
      artifact: ["research.json", answer],
      phases: {
        research: [
          event("web_search", "search", 0, {
            query: "transaction isolation primary documentation",
            resultUrls: claims.map((entry) => entry.url),
          }),
          ...claims.map((claim, index) =>
            event("web_source", `source${index}`, 1, {
              url: claim.url,
              status: 200,
              text: claim.quote,
              contentSha256: sha256(claim.quote),
            }),
          ),
        ],
        source_review: [
          event("source_review", "review", 2, {
            reviewerKind: "human",
            reviewerId: "fixture-reviewer",
            artifactSha256: sha256(answer),
            claims: claims.map((claim) => ({ claimId: claim.id, claimSha256: sha256(claim), supported: true })),
            conflictSearchCompleted: true,
            conflicts: [{ claimIds: ["postgres", "sqlite"] }],
          }),
        ],
      },
    };
  }
  if (taskId === "scheduled_agent_work")
    return {
      phases: {
        schedule: [
          event("scheduled_occurrence", "occurrence", 0, {
            ...scope,
            occurrenceId: "occurrence1",
            mode: "agent_turn",
            authorizedDestination: "test-sink",
          }),
          event("turn_admitted", "admission", 1, { ...scope, occurrenceId: "occurrence1" }),
          event("tool_result", "tool", 2, {
            ...scope,
            toolName: "fs.read",
            status: "completed",
            path: "input/ledger.json",
            authoritySha256: sha256("authority"),
            resultSha256: sha256({ amountsCents: [130, 270, 600] }),
          }),
        ],
        await_approval: [event("approval_pending", "pending", 3, { ...scope, approvalId: "approval1" })],
        restart: [event("runtime_restart", "restart", 4, { previousRuntimeId: "old", runtimeId: "new" })],
        approve: [
          event("approval", "approval", 5, {
            ...scope,
            approvalId: "approval1",
            decision: "approved",
            actorKind: "human",
            actorId: "fixture-operator",
          }),
        ],
        settle: [
          event("turn_resumed", "resume", 6, { ...scope, approvalId: "approval1", runtimeId: "new" }),
          event("delivery_receipt", "delivery", 7, {
            ...scope,
            totalCents: 1000,
            providerMessageId: "provider1",
            destination: "test-sink",
          }),
        ],
        reconnect: [
          event("reconnect_observation", "reconnect", 8, {
            pendingDeliveries: 0,
            deliveryCount: 1,
            observedUntil: at(39),
          }),
        ],
      },
    };
  if (taskId === "provider_recovery")
    return {
      artifact: ["recovery.json", { totalCents: 1000 }],
      phases: {
        known_failure: [event("failure_armed", "armed", 0)],
        fallback: [
          event("provider_attempt", "attempt1", 1, {
            ...scope,
            providerId: "primary",
            outcome: "confirmed_not_dispatched",
          }),
          event("provider_changed", "visible", 2, {
            ...scope,
            fromProviderId: "primary",
            toProviderId: "fallback",
            surface: "chat",
            routeReferenceSha256: sha256("route"),
          }),
          event("provider_attempt", "attempt2", 3, { ...scope, providerId: "fallback", outcome: "completed" }),
        ],
        unknown_case: [
          event("uncertain_effect", "effect", 4, {
            runId: "uncertain-run",
            turnId: "uncertain-turn",
            effectId: "effect1",
            outcome: "unknown_after_send",
          }),
        ],
        reconcile: [
          event("reconciliation_required", "blocked", 5, {
            runId: "uncertain-run",
            turnId: "uncertain-turn",
            effectId: "effect1",
            status: "blocked",
            dispatchCount: 1,
            automaticRetries: 0,
          }),
        ],
      },
    };
  const answer = { northCents: 400, southCents: 600, totalCents: 1000 };
  const result = (region) => ({ region, totalCents: region === "north" ? 400 : 600 });
  const child = (childId, time) =>
    event("child_result", childId, time, {
      runId: "run",
      childId,
      maxRequests: 3,
      requests: 1,
      maxTokens: 4096,
      tokens: 40,
      result: result(childId),
      resultSha256: sha256(result(childId)),
    });
  return {
    artifact: ["delegation.json", answer],
    phases: {
      delegate: [event("delegation_plan", "plan", 0, { runId: "run", surface: "chat", childIds: ["north", "south"] })],
      one_child: [child("north", 1)],
      restart: [event("runtime_restart", "restart", 2, { previousRuntimeId: "old", runtimeId: "new" })],
      recover: [
        child("south", 3),
        event("delegation_recovered", "recovery", 4, {
          runId: "run",
          childIds: ["north", "south"],
          spawnedChildren: 2,
        }),
      ],
      verify: [
        event("synthesis", "synthesis", 5, {
          runId: "run",
          artifactSha256: sha256(answer),
          childResultSha256s: [sha256(result("north")), sha256(result("south"))],
        }),
      ],
    },
  };
}

it("keeps the five original tasks unchanged and prepares a separate 36-cell suite with shared track budgets", async (t) => {
  const root = await temporary(t),
    pilot = createComparisonPilot({ pilotId: randomUUID(), hostedBudgetDirectory: path.join(root, "hosted") });
  const original = preparePilotComparison(pilot, {
    schemaVersion: COMPARISON_VERSION,
    transportProfile: hosted,
    products,
  });
  assert.equal(original.cells.length, 45);
  assert.equal(original.suite, undefined);
  assert.equal(original.fixtureSetSha256, sha256(COMPARISON_TASKS));
  const extended = preparePilotComparison(pilot, {
    schemaVersion: COMPARISON_VERSION,
    suite: FEATURE_ACCEPTANCE_SUITE,
    transportProfile: hosted,
    products,
  });
  assert.equal(extended.cells.length, 36);
  assert.deepEqual(extended.pilotBudget, original.pilotBudget);
  assert.equal(comparisonTasks(extended).length, 4);
  const localCampaign = preparePilotComparison(pilot, {
    schemaVersion: COMPARISON_VERSION,
    suite: FEATURE_ACCEPTANCE_SUITE,
    transportProfile: local,
    products,
  });
  assert.equal(localCampaign.localPilotBudget.maxRequests, 450);
  assert.equal(localCampaign.localPilotBudget.maxCostUsd, 0);
  assert.notEqual(localCampaign.localPilotBudget.directory, pilot.hostedBudget.directory);
  assert.throws(() => prepareComparison({ ...original, suite: "unknown" }), /Unsupported/);
});

for (const productId of ["goatcitadel", "openclaw", "hermes"])
  for (const track of ["hosted", "local"])
    for (const task of FEATURE_ACCEPTANCE_TASKS) {
      it(`checks generic harness custody for ${productId}/${task.id}/${track}; controlled phase records are not product proof`, async (t) => {
        const root = await temporary(t),
          shared = path.join(root, "shared");
        await mkdir(shared);
        const config = {
          schemaVersion: COMPARISON_VERSION,
          suite: FEATURE_ACCEPTANCE_SUITE,
          trials: 3,
          products,
          transportProfile: track === "local" ? local : hosted,
          maxRequests: 4,
          maxCostUsd: track === "local" ? 0 : 1,
          [track === "local" ? "localPilotBudget" : "pilotBudget"]: {
            pilotId: randomUUID(),
            directory: shared,
            maxRequests: 4,
            maxCostUsd: track === "local" ? 0 : 1,
          },
        };
        const manifest = prepareComparison(config),
          cellId = `${productId}:${task.id}:1`;
        let upstreamCalls = 0;
        const session = await startComparisonSession({
          manifest,
          campaignDirectory: root,
          outputDirectory: path.join(root, "cell"),
          options: {
            schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
            cellId,
            checkoutRoot: root,
            ...manifest.transportProfile,
            ...(track === "hosted" ? { apiKeyEnv: "FIXTURE_KEY" } : {}),
          },
          checkout: { revision: product.revision, clean: true },
          ...(track === "hosted" ? { upstreamApiKey: "fixture-key" } : {}),
          evidenceSource: "controlled_fixture",
          fetchUpstream: async () => {
            upstreamCalls++;
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: "Controlled task result" } }],
                usage: { prompt_tokens: 10, completion_tokens: 3 },
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        });
        t.after(() => session.close());
        const value = fixture(task.id),
          actions = {};
        for (const phase of task.phases)
          actions[phase.action] = async ({ phase: current }) => {
            if (current.id === task.phases[0].id) {
              const connection = JSON.parse(await readFile(session.connectionFile, "utf8"));
              const response = await fetch(`${connection.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                  model: product.model,
                  messages: [{ role: "user", content: task.prompt }],
                  max_tokens: 4096,
                }),
              });
              assert.equal(response.status, 200);
              await response.json();
              if (value.artifact)
                await writeFile(path.join(session.workspace, value.artifact[0]), JSON.stringify(value.artifact[1]));
            }
            return { records: structuredClone(value.phases[current.id]) };
          };
        const result = await runFeatureAcceptance({ taskId: task.id, session, source: "controlled_fixture", actions });
        assert.equal(upstreamCalls, 1);
        const cell = path.join(root, "cell");
        const json = async (name) => JSON.parse(await readFile(path.join(cell, name), "utf8"));
        const recorded = await recordComparisonCell({
          manifest,
          taskId: task.id,
          trial: 1,
          workspaceRoot: session.workspace,
          evidenceRoot: session.evidence,
          journal: await json("journal-export.json"),
          pilotJournal: await json("pilot-budget-export.json"),
          measurements: { ...session.binding, durationMs: result.finish.durationMs, manualInterventions: 0 },
        });
        assert.equal(recorded.receipt.outcome, "passed");
        assert.equal(recorded.receipt.evidenceKind, "controlled");
        assert.equal(recorded.receipt.requests, 1);
        assert.equal(summarizeComparison(manifest, [recorded.receipt]).status, "incomplete_or_not_comparable");
        if (track === "local") assert.equal(recorded.receipt.costUsd, 0);
        const broken = structuredClone(value);
        if (task.id === "web_research") broken.phases.source_review[0].reviewerKind = "model";
        if (task.id === "scheduled_agent_work")
          broken.phases.settle.push({ ...broken.phases.settle[1], id: "duplicate-delivery" });
        if (task.id === "provider_recovery") broken.phases.reconcile[0].automaticRetries = 1;
        if (task.id === "delegation") broken.phases.recover[1].spawnedChildren = 3;
        const altered = structuredClone(result.execution),
          content = new Map([
            ["session-start.json", await readFile(path.join(session.evidence, "session-start.json"), "utf8")],
          ]);
        for (const phase of task.phases) {
          const ref = altered.nativeReceipts.find((entry) => entry.phaseId === phase.id);
          const document = await json(`evidence/${ref.path}`);
          document.records = broken.phases[phase.id];
          const raw = JSON.stringify(document);
          ref.sha256 = sha256(raw);
          content.set(ref.path, raw);
        }
        const checks = await verifyFeatureAcceptance({
          taskId: task.id,
          execution: altered,
          readEvidence: async (name) => content.get(name),
          readWorkspace: async (name) => readFile(path.join(session.workspace, name), "utf8"),
        });
        assert.ok(Object.values(checks).some((passed) => !passed));
      });
    }

it("shares local request reservations across campaigns and cannot substitute the hosted journal", async (t) => {
  const directory = await temporary(t),
    policy = { pilotId: randomUUID(), directory, maxRequests: 1, maxCostUsd: 0 };
  const first = await openComparisonPilotJournal(policy, { local: true });
  const cellId = "goatcitadel:web_research:1",
    manifest = { manifestSha256: "a".repeat(64), localPilotBudget: policy };
  await first.budget.dispatch(
    { cellId: `${manifest.manifestSha256}:${cellId}`, role: "primary", maximumCostUsd: 0 },
    async () => ({ costUsd: 0 }),
  );
  const calls = [{ role: "primary", maximumCostUsd: 0, costUsd: 0, state: "settled" }];
  assert.equal(verifyPilotAccounting(manifest, first.snapshot(), cellId, calls).requests, 1);
  assert.throws(
    () => verifyPilotAccounting(manifest, { ...first.snapshot(), budgetTrack: undefined }, cellId, calls),
    /shared pilot/,
  );
  await first.close();
  const second = await openComparisonPilotJournal(policy, { local: true });
  t.after(() => second.close());
  let called = false;
  await assert.rejects(
    second.budget.dispatch(
      { cellId: `${"b".repeat(64)}:hermes:delegation:1`, role: "child", maximumCostUsd: 0 },
      async () => {
        called = true;
        return { costUsd: 0 };
      },
    ),
    /exhausted/,
  );
  assert.equal(called, false);
  await second.close();
  await assert.rejects(openComparisonPilotJournal({ ...policy, maxCostUsd: 1 }), /another manifest/);
});

it("closes unsupported adapters, preserves source kind, and bounds a nonsettling phase by session shutdown", async (t) => {
  const root = await temporary(t),
    evidence = path.join(root, "evidence");
  await mkdir(evidence);
  const binding = {
    executionId: "execution",
    cellId: "goatcitadel:web_research:1",
    manifestSha256: "a".repeat(64),
    revision: "b".repeat(40),
    effectiveConfigSha256: "c".repeat(64),
    fixtureSha256: "d".repeat(64),
  };
  await writeFile(
    path.join(evidence, "session-start.json"),
    JSON.stringify({ ...binding, source: "controlled_fixture" }),
  );
  let finish,
    closeCount = 0;
  const session = {
    binding,
    evidence,
    finished: new Promise((resolve) => {
      finish = resolve;
    }),
    close: async () => {
      closeCount++;
    },
  };
  await assert.rejects(
    runFeatureAcceptance({ taskId: "web_research", session, source: "controlled_fixture", actions: {} }),
    /does not support/,
  );
  assert.equal(closeCount, 1);
  const actions = { run_turn: async () => new Promise(() => {}), review_sources: async () => ({ records: [] }) };
  await assert.rejects(
    runFeatureAcceptance({ taskId: "web_research", session, source: "native_receipts", actions }),
    /provenance/,
  );
  assert.equal(closeCount, 2);
  const running = runFeatureAcceptance({ taskId: "web_research", session, source: "controlled_fixture", actions });
  setTimeout(() => finish({ ok: true, result: { reason: "deadline" } }), 10);
  await assert.rejects(running, /session ended/);
  assert.equal(closeCount, 3);
});

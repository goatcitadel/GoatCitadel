import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  FEATURE_ACCEPTANCE_PINS,
  readFeatureAcceptanceAvailability,
  buildFeatureAcceptanceProfile,
} from "./agent-comparison-acceptance-profile.mjs";
import { FEATURE_ACCEPTANCE_TASKS, FEATURE_ACCEPTANCE_SUITE } from "./agent-comparison-acceptance-fixtures.mjs";
import {
  createAcceptanceActions as openclawActions,
  projectOpenclawAcceptanceWeb,
} from "./agent-comparison-openclaw-acceptance.mjs";
import {
  createAcceptanceActions as hermesActions,
  projectHermesAcceptanceWeb,
} from "./agent-comparison-hermes-acceptance.mjs";
import { runFeatureAcceptance, verifyFeatureAcceptance } from "./agent-comparison-acceptance.mjs";
import { prepareComparison, COMPARISON_VERSION, sha256 } from "./agent-comparison.mjs";
import { startComparisonSession } from "./agent-comparison-session.mjs";
import { recordComparisonCell } from "./agent-comparison-record.mjs";
import { buildNativeComparisonProfile, NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";

const profile = (product) => ({
  revision: FEATURE_ACCEPTANCE_PINS[product],
  provider: "fixture",
  model: "fixture-model",
  reasoning: "none",
  tools: ["files", "web", "scheduling", "delegation", "fallback"],
  grants: ["test-workspace"],
  contextTokens: 64000,
  outputTokens: 4096,
  maxTaskMs: 600000,
});
const at = "2026-10-11T00:00:00Z";
const urls = ["https://www.postgresql.org/docs/current/transaction-iso.html", "https://www.sqlite.org/isolation.html"];
const texts = ["PostgreSQL supports transaction isolation.", "SQLite provides isolated transactions."];
const artifact = {
  claims: texts.map((text, index) => ({ id: `claim-${index}`, text, quote: text, url: urls[index] })),
  conflicts: [],
};
async function setup(t, product, taskId, track) {
  const root = await mkdtemp(path.join(tmpdir(), "comparison-native-features-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  await mkdir(shared);
  const transportProfile =
    track === "local"
      ? {
          kind: "local",
          upstreamUrl: "http://127.0.0.1:8080/v1/chat/completions",
          outputField: "max_tokens",
          localRuntime: {
            runtime: "controlled",
            modelSha256: sha256("model"),
            quantization: "fixture",
            hardware: "fixture",
          },
        }
      : {
          upstreamUrl: "https://fixture.invalid/v1/chat/completions",
          outputField: "max_tokens",
          pricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 2,
            requestUsd: 0,
            observedAt: at,
            sourceSha256: sha256("rates"),
          },
        };
  const products = Object.fromEntries(Object.keys(FEATURE_ACCEPTANCE_PINS).map((key) => [key, profile(key)]));
  const manifest = prepareComparison({
    schemaVersion: COMPARISON_VERSION,
    suite: FEATURE_ACCEPTANCE_SUITE,
    trials: 3,
    products,
    transportProfile,
    maxRequests: 10,
    maxCostUsd: track === "local" ? 0 : 1,
    [track === "local" ? "localPilotBudget" : "pilotBudget"]: {
      pilotId: randomUUID(),
      directory: shared,
      maxRequests: 10,
      maxCostUsd: track === "local" ? 0 : 1,
    },
  });
  const options = {
    schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
    cellId: `${product}:${taskId}:1`,
    checkoutRoot: root,
    ...transportProfile,
    ...(track === "hosted" ? { apiKeyEnv: "FIXTURE_KEY" } : {}),
  };
  let forwarded = 0;
  const session = await startComparisonSession({
    manifest,
    options,
    campaignDirectory: root,
    outputDirectory: path.join(root, "cell"),
    checkout: { revision: products[product].revision, clean: true },
    ...(track === "hosted" ? { upstreamApiKey: "controlled-key" } : {}),
    evidenceSource: "controlled_fixture",
    fetchUpstream: async () => {
      forwarded++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "controlled" } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  t.after(() => session.close());
  return { root, session, manifest, options, forwarded: () => forwarded };
}
function nativeTurn(product, workspace) {
  const prompt = FEATURE_ACCEPTANCE_TASKS[0].prompt;
  if (product === "openclaw") {
    const messages = [{ role: "user", content: prompt }];
    const call = (id, name, args, result) => {
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
        {
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          timestamp: at,
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      );
    };
    call(
      "search",
      "web_search",
      { query: "isolation" },
      { kind: "results", query: "isolation", results: urls.map((url) => ({ url })) },
    );
    urls.forEach((url, index) =>
      call(`fetch-${index}`, "web_fetch", { url }, { url, status: 200, text: texts[index], truncated: false }),
    );
    return {
      sessionKey: "agent:main:fixture",
      result: {
        status: "ok",
        runId: "native-run",
        result: {
          meta: {
            agentMeta: {
              sessionId: "native-session",
              terminalReceipt: {
                runId: "native-run",
                turnId: "native-run",
                sessionId: "native-session",
                effective: { provider: "comparison", model: "fixture-model" },
                rerouted: false,
              },
            },
            systemPromptReport: {
              source: "run",
              sessionKey: "agent:main:fixture",
              sessionId: "native-session",
              workspaceDir: workspace,
              systemPrompt: { hash: sha256("prompt") },
              skills: { entries: [] },
            },
          },
        },
      },
      history: { sessionKey: "agent:main:fixture", sessionId: "native-session", hasMore: false, messages },
    };
  }
  const messages = [{ id: 1, session_id: "native-session", role: "user", content: prompt, active: 1, timestamp: at }];
  const call = (id, name, args, result) => {
    messages.push(
      {
        id: messages.length + 1,
        session_id: "native-session",
        role: "assistant",
        tool_calls: JSON.stringify([{ id, function: { name, arguments: JSON.stringify(args) } }]),
        active: 1,
        timestamp: at,
      },
      {
        id: messages.length + 2,
        session_id: "native-session",
        role: "tool",
        tool_call_id: id,
        tool_name: name,
        content: JSON.stringify(result),
        active: 1,
        timestamp: at,
      },
    );
  };
  call("search", "web_search", { query: "isolation" }, { success: true, data: { web: urls.map((url) => ({ url })) } });
  call("extract", "web_extract", { urls }, { results: urls.map((url, index) => ({ url, content: texts[index] })) });
  messages.push({
    id: messages.length + 1,
    session_id: "native-session",
    role: "assistant",
    content: "Wrote research.json",
    finish_reason: "stop",
    active: 1,
    timestamp: at,
  });
  return {
    process: { exitCode: 0, cleanupUnconfirmed: false },
    transcript: {
      status: "retained",
      sessions: [
        {
          id: "native-session",
          source: "cli",
          model: "fixture-model",
          billing_provider: "custom",
          cwd: workspace,
          parent_session_id: null,
        },
      ],
      messages,
    },
  };
}

for (const product of Object.keys(FEATURE_ACCEPTANCE_PINS))
  for (const track of ["hosted", "local"])
    for (const task of FEATURE_ACCEPTANCE_TASKS) {
      it(`declares exact native availability and feature policy for ${product}/${task.id}/${track}`, () => {
        const available = readFeatureAcceptanceAvailability(product, task.id, profile(product));
        const plan = buildFeatureAcceptanceProfile(product, profile(product), task.id, "max_tokens");
        assert.equal(plan.revision, FEATURE_ACCEPTANCE_PINS[product]);
        assert.deepEqual(plan.supportedTasks, [task.id]);
        assert.equal(plan.suite, FEATURE_ACCEPTANCE_SUITE);
        assert.ok(["supported", "unsupported", "blocked"].includes(available.status));
        if (available.status !== "supported") assert.ok(available.sourceFiles.length > 0);
        if (product === "goatcitadel" && task.id !== "delegation")
          assert.equal(plan.config.assistant.features.chatAutomaticFanoutV1Enabled, undefined);
        if (product === "hermes" && task.id === "web_research")
          assert.equal(plan.config.web.provider_tier.parallel, "free");
        if (product === "openclaw" && task.id === "web_research")
          assert.deepEqual(plan.config.plugins.allow, ["duckduckgo"]);
      });
      if (readFeatureAcceptanceAvailability(product, task.id, profile(product)).status !== "supported") {
        it(`retains no-call native limitation for ${product}/${task.id}/${track} without fabricating native effects`, async (t) => {
          const f = await setup(t, product, task.id, track);
          let started = 0;
          const factory = product === "openclaw" ? openclawActions : product === "hermes" ? hermesActions : undefined;
          const actions = factory
            ? await factory({ ...f, supervisor: { start: async () => started++, stop: async () => {} } })
            : { availability: readFeatureAcceptanceAvailability(product, task.id, profile(product)) };
          const result = await runFeatureAcceptance({
            taskId: task.id,
            session: f.session,
            source: "controlled_fixture",
            actions,
          });
          assert.equal(started, 0);
          assert.equal(f.forwarded(), 0);
          const json = (name) => readFile(path.join(f.root, "cell", name), "utf8").then(JSON.parse);
          const recorded = await recordComparisonCell({
            manifest: f.manifest,
            taskId: task.id,
            trial: 1,
            workspaceRoot: f.session.workspace,
            evidenceRoot: f.session.evidence,
            journal: await json("journal-export.json"),
            pilotJournal: await json("pilot-budget-export.json"),
            measurements: { ...f.session.binding, durationMs: result.finish.durationMs, manualInterventions: 0 },
          });
          assert.equal(recorded.receipt.outcome, actions.availability.status);
          assert.equal(recorded.receipt.requests, 0);
          assert.ok(Object.values(recorded.receipt.checks).every((check) => !check.passed));
          const altered = structuredClone(result.execution);
          altered.acceptanceDisposition = "passed";
          await assert.rejects(
            verifyFeatureAcceptance({
              taskId: task.id,
              execution: altered,
              readEvidence: (name) => readFile(path.join(f.session.evidence, name), "utf8"),
              readWorkspace: async () => {
                throw new Error("must not inspect fabricated artifacts");
              },
            }),
            /no-call evidence/,
          );
        });
      }
    }

for (const product of ["openclaw", "hermes"])
  for (const track of ["hosted", "local"]) {
    it(`runs the ${product} web adapter against native-shaped controlled receipts through the ${track} journal`, async (t) => {
      const f = await setup(t, product, "web_research", track),
        native = nativeTurn(product, f.session.workspace);
      let stops = 0;
      const configHash = sha256("config"),
        supervisor = {
          start: async () => ({
            runtimeId: "runtime",
            stateId: "state",
            revision: FEATURE_ACCEPTANCE_PINS[product],
            workspace: f.session.workspace,
            configurationSha256: configHash,
          }),
          runTurn: async () => {
            const connection = JSON.parse(await readFile(f.session.connectionFile, "utf8"));
            const response = await fetch(`${connection.baseUrl}/chat/completions`, {
              method: "POST",
              headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
              body: JSON.stringify({
                model: "fixture-model",
                messages: [{ role: "user", content: FEATURE_ACCEPTANCE_TASKS[0].prompt }],
                max_tokens: 4096,
              }),
            });
            assert.equal(response.status, 200);
            await response.json();
            await writeFile(path.join(f.session.workspace, "research.json"), JSON.stringify(artifact));
            return native;
          },
          reviewPermissions: async () => ({
            configurationSha256: configHash,
            reviewedBy: "controlled-human",
            reviewedAt: at,
            policy: {
              files: product === "hermes" ? "host_user" : "workspace_only",
              terminal: "disabled",
              skills: "disabled",
              schedule: "disabled",
            },
          }),
          reviewSources: async () => ({
            reviewerKind: "human",
            reviewerId: "controlled-human",
            artifactSha256: sha256(artifact),
            claims: artifact.claims.map((claim) => ({
              claimId: claim.id,
              claimSha256: sha256(claim),
              supported: true,
            })),
            conflicts: [],
            conflictSearchCompleted: true,
          }),
          stop: async () => {
            stops++;
          },
        };
      const actions = await (product === "openclaw" ? openclawActions : hermesActions)({ ...f, supervisor });
      const result = await runFeatureAcceptance({
        taskId: "web_research",
        session: f.session,
        source: "controlled_fixture",
        actions,
      });
      assert.equal(stops, 1);
      assert.equal(f.forwarded(), 1);
      const checks = await verifyFeatureAcceptance({
        taskId: "web_research",
        execution: result.execution,
        readEvidence: (name) => readFile(path.join(f.session.evidence, name), "utf8"),
        readWorkspace: (name) => readFile(path.join(f.session.workspace, name), "utf8"),
      });
      assert.ok(Object.values(checks).every(Boolean));
      const changed = structuredClone(native);
      if (product === "openclaw")
        changed.history.messages.find((message) => message.role === "toolResult").toolCallId = "different";
      else changed.transcript.messages.find((message) => message.role === "tool").tool_call_id = "different";
      assert.throws(
        () =>
          (product === "openclaw" ? projectOpenclawAcceptanceWeb : projectHermesAcceptanceWeb)(changed, {
            model: "fixture-model",
            workspace: f.session.workspace,
            prompt: FEATURE_ACCEPTANCE_TASKS[0].prompt,
          }),
        /unsettled|settled/,
      );
    });
  }
it("preserves the original five native profiles and rejects undeclared features/repins", () => {
  for (const product of ["openclaw", "hermes"]) {
    const original = buildNativeComparisonProfile(
      product,
      { ...profile(product), revision: NATIVE_COMPARISON_PINS[product], tools: ["files"] },
      "max_tokens",
    );
    assert.deepEqual(original.supportedTasks, ["cited_research", "code_repair", "document_generation"]);
    assert.ok(!original.nativeTools.includes("web_search") && !original.nativeTools.includes("web"));
  }
  assert.throws(
    () => buildFeatureAcceptanceProfile("openclaw", { ...profile("openclaw"), tools: ["files"] }, "web_research"),
    /not declared/,
  );
  assert.throws(
    () =>
      readFeatureAcceptanceAvailability("hermes", "web_research", { ...profile("hermes"), revision: "a".repeat(40) }),
    /pin/,
  );
});

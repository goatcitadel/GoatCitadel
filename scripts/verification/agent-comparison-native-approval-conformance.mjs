import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { COMPARISON_VERSION, prepareComparison, sha256 } from "./lib/agent-comparison.mjs";
import { NATIVE_COMPARISON_PINS, NATIVE_COMPARISON_VERSION } from "./lib/agent-comparison-native-profile.mjs";
import {
  prepareNativeComparisonLaunch,
  runNativeComparison,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { createNativeConformanceProbes } from "./lib/agent-comparison-native-probes.mjs";

const [checkoutRoot, executablePath, root, decision = "allow-once"] = process.argv.slice(2);
if (
  ![5, 6].includes(process.argv.length) ||
  ![checkoutRoot, executablePath, root].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
  !["allow-once", "deny", "abort"].includes(decision)
)
  throw new Error(
    "Usage: node agent-comparison-native-approval-conformance.mjs ABSOLUTE_OPENCLAW_CHECKOUT ABSOLUTE_NODE NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]",
  );

// This is an opt-in, deterministic process/transport fixture. Only the generated
// marker command below may be approved. No real provider or task-quality result
// is produced, and campaign runs never import this fixture decision loop.
const pricing = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  requestUsd: 0,
  observedAt: "2026-09-09T00:00:00.000Z",
  sourceSha256: sha256("synthetic native approval conformance"),
};
const transportProfile = {
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  outputField: "max_completion_tokens",
  pricing,
};
const products = Object.fromEntries(
  Object.entries(NATIVE_COMPARISON_PINS).map(([product, revision]) => [
    product,
    {
      revision,
      provider: "comparison",
      model: "gpt-5.4",
      tools: ["files", "terminal"],
      grants: ["test-workspace"],
      reasoning: "none",
      contextTokens: 128000,
      outputTokens: 512,
      maxTaskMs: 90000,
    },
  ]),
);
const manifest = prepareComparison({
  schemaVersion: COMPARISON_VERSION,
  products,
  transportProfile,
  trials: 3,
  maxRequests: 8,
  maxCostUsd: 2,
});
const options = {
  schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
  cellId: "openclaw:cited_research:1",
  checkoutRoot,
  apiKeyEnv: "CONTROLLED_FIXTURE_KEY",
  ...transportProfile,
  nativeApprovalGateway: true,
};
const launch = await prepareNativeComparisonLaunch({
  manifest,
  cellId: options.cellId,
  checkoutRoot,
  executablePath,
  approvalGateway: true,
});
await mkdir(root);
await writeNativeComparisonJson(path.join(root, "manifest.json"), manifest);
const outputDirectory = path.join(root, "cell");
const probes = createNativeConformanceProbes({ workspace: path.join(outputDirectory, "workspace"), permissions: true });
const stop = new AbortController();
const calls = [];
let approval, fixtureFailure;
const result = await runNativeComparison({
  manifest,
  campaignDirectory: root,
  outputDirectory,
  options,
  launch,
  review: {
    schemaVersion: NATIVE_COMPARISON_VERSION,
    launchSha256: launch.launchSha256,
    effectiveConfigSha256: launch.nativeProfile.effectiveConfigSha256,
    nativePolicyReviewed: true,
    credentialIsolationReviewed: true,
    reviewedBy: "controlled_local_fixture_not_live_operator_review",
    reviewedAt: new Date().toISOString(),
  },
  upstreamApiKey: "controlled-fixture-no-live-provider",
  signal: stop.signal,
  fetchUpstream: async (_url, init) => {
    const body = JSON.parse(init.body);
    const message =
      calls.length >= 7 ? { role: "assistant", content: "LOCAL_PROFILE_INCOMPLETE" } : probes.respond(body);
    calls.push({
      requestedProbe: message.tool_calls?.[0]?.id ?? null,
      results: (body.messages ?? []).filter((entry) => entry.role === "tool"),
    });
    const base = {
      id: "chatcmpl-controlled",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-5.4",
    };
    const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 };
    const finish_reason = message.tool_calls?.length ? "tool_calls" : "stop";
    if (!body.stream)
      return new Response(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason }], usage }), {
        headers: { "content-type": "application/json" },
      });
    const delta = message.tool_calls?.length
      ? { role: "assistant", tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
      : message;
    return new Response(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  },
  onApprovalReady: async ({ pending, resolve, signal }) => {
    for (const file of probes.fixtures) await writeFile(file.filename, file.content, { flag: "wx" });
    const fixtureLoop = (async () => {
      while (!signal.aborted) {
        const current = await pending();
        if (current.approvals?.length) {
          assert.equal(current.approvals.length, 1);
          const request = current.approvals[0];
          assert.equal(request.kind, "exec");
          assert.equal(request.summary, "node ./terminal-probe.cjs");
          const script = probes.fixtures.find((file) => file.filename.endsWith("terminal-probe.cjs"));
          assert.equal(await readFile(script.filename, "utf8"), script.content);
          await assert.rejects(readFile(probes.markerFile), { code: "ENOENT" });
          approval = { request, markerAbsentBeforeDecision: true, decision };
          if (decision === "abort") stop.abort();
          else approval.result = await resolve({ approvalId: request.id, decision });
          return;
        }
        await delay(200, undefined, { signal });
      }
    })().catch((error) => {
      if (!signal.aborted) {
        fixtureFailure = error;
        stop.abort();
      }
    });
    return { stop: () => fixtureLoop };
  },
});
let marker = null;
try {
  marker = await readFile(probes.markerFile, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const proof = {
  fixtureOnly: true,
  decision,
  approval,
  marker,
  calls,
  result,
  localModelCalls: calls.length,
  upstreamModelRequests: 0,
};
await writeNativeComparisonJson(path.join(root, "proof.json"), proof);
if (fixtureFailure) throw fixtureFailure;
assert.ok(approval?.markerAbsentBeforeDecision, "No native approval request was observed.");
assert.ok(calls.length > 0 && calls.length <= 8);
assert.equal(Boolean(marker), decision === "allow-once");
if (decision !== "abort") {
  assert.equal(result.receipt.exitCode, 0);
  assert.equal(result.receipt.stopReason, "process_exit");
  assert.equal(approval.result.approval.decision, decision);
} else assert.notEqual(result.receipt.stopReason, "process_exit");
assert.equal(result.receipt.cleanupUnconfirmed, false);
assert.equal(result.receipt.taskOutcome, "unverified");
assert.equal(result.transport.requests, calls.length);
assert.equal(result.transport.status, "task_evidence_pending");
const execution = JSON.parse(await readFile(path.join(result.evidenceDirectory, "execution.json"), "utf8"));
assert.ok(execution.nativeReceipts.some((entry) => entry.path === "native-approval-events.jsonl"));
assert.equal(
  execution.nativeReceipts.filter((entry) => entry.path.endsWith("-intent.json")).length,
  decision === "abort" ? 0 : 1,
);
process.stdout.write(
  `${JSON.stringify({
    root,
    success: true,
    fixtureOnly: true,
    decision,
    localModelCalls: calls.length,
    nativeDecision: approval.result?.approval.decision ?? null,
    markerCreated: Boolean(marker),
    upstreamModelRequests: 0,
  })}\n`,
);

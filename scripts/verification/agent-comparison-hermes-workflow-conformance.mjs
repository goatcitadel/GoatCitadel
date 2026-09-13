import assert from "node:assert/strict";
import { mkdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_VERSION, COMPARISON_TASKS, prepareComparison, sha256 } from "./lib/agent-comparison.mjs";
import { NATIVE_COMPARISON_PINS, NATIVE_COMPARISON_VERSION } from "./lib/agent-comparison-native-profile.mjs";
import {
  prepareNativeComparisonLaunch,
  runNativeComparison,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { assertNativeApprovalTerminal } from "./lib/agent-comparison-native-approval-console.mjs";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";

const [checkoutRoot, executablePath, root] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  ![checkoutRoot, executablePath, root].every((value) => typeof value === "string" && path.isAbsolute(value))
)
  throw new Error(
    "Usage: node agent-comparison-hermes-workflow-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY",
  );
assertNativeApprovalTerminal();
// Synthetic model responses drive real, source-pinned native owners. Review and
// apply remain typed terminal actions; this fixture never answers its own review.
const task = COMPARISON_TASKS.find((entry) => entry.id === "workflow_capture_reuse");
const skill = `---
name: release-note
description: Use to draft release notes from supplied evidence.
---
# Release note

## When to use
Use when the operator requests release notes from a supplied change list.

## Inputs
The operator supplies an input JSON filename and output Markdown filename. The JSON contains fixed, evidence, and unverified arrays.

## Instructions
Read the input. Put fixed entries under What changed, evidence entries under Evidence, and unsupported claims only under Unverified. Preserve factual wording.

## Failure handling
Stop on invalid or missing input. Explain what is needed without inventing changes or evidence.

## Output
Create the requested Markdown file with What changed, Evidence, and Unverified sections.

## Verification
Read the output and compare each entry with the input. Check that unsupported claims appear only under Unverified.

## Boundaries
Use supplied workspace files only. Do not publish, send messages, activate another skill, or write durable memory.
`;
const products = Object.fromEntries(
  Object.entries(NATIVE_COMPARISON_PINS).map(([product, revision]) => [
    product,
    {
      revision,
      provider: "comparison",
      model: "fixture-model",
      tools: ["files", "skills"],
      grants: ["test-workspace"],
      reasoning: "none",
      contextTokens: 64000,
      outputTokens: 8192,
      maxTaskMs: 600000,
    },
  ]),
);
const transportProfile = {
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  outputField: "max_completion_tokens",
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    requestUsd: 0,
    observedAt: "2026-09-12T00:00:00.000Z",
    sourceSha256: sha256("synthetic Hermes workflow fixture"),
  },
};
const manifest = prepareComparison({
  schemaVersion: COMPARISON_VERSION,
  products,
  transportProfile,
  trials: 3,
  maxRequests: 24,
  maxCostUsd: 2,
});
const options = {
  schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
  cellId: "hermes:workflow_capture_reuse:1",
  checkoutRoot,
  apiKeyEnv: "CONTROLLED_FIXTURE_KEY",
  ...transportProfile,
  nativeInteractiveCli: true,
  nativeSkillWorkflow: true,
};
const launch = await prepareNativeComparisonLaunch({
  manifest,
  cellId: options.cellId,
  checkoutRoot,
  executablePath,
  interactiveCli: true,
  skillWorkflow: true,
});
await mkdir(root);
await writeNativeComparisonJson(path.join(root, "manifest.json"), manifest);
await writeNativeComparisonJson(path.join(root, "fixture.json"), {
  fixtureOnly: true,
  source: "controlled_fixture",
  skill,
  launchSha256: launch.launchSha256,
});
const outputDirectory = path.join(root, "cell"),
  workspace = path.join(outputDirectory, "workspace");
const calls = [],
  requested = new Set();
let heldOutObservedEarly = false,
  result,
  failure;
const stop = new AbortController();
const interrupt = () => stop.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  result = await runNativeComparison({
    manifest,
    campaignDirectory: root,
    outputDirectory,
    options,
    launch,
    evidenceSource: "controlled_fixture",
    review: {
      schemaVersion: NATIVE_COMPARISON_VERSION,
      launchSha256: launch.launchSha256,
      effectiveConfigSha256: launch.nativeProfile.effectiveConfigSha256,
      nativePolicyReviewed: true,
      credentialIsolationReviewed: true,
      reviewedBy: "controlled_local_fixture_not_live_campaign_review",
      reviewedAt: new Date().toISOString(),
    },
    upstreamApiKey: "controlled-fixture-no-live-provider",
    signal: stop.signal,
    onNativeOutput: (chunk) => process.stdout.write(chunk),
    fetchUpstream: async (_url, init) => {
      const body = JSON.parse(init.body);
      const lastUser = body.messages?.findLast((entry) => entry.role === "user")?.content;
      const text = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser);
      const capture = text.includes("Save this verified release-note workflow");
      const reuse = !capture && text.includes("input/changes.json");
      const phase = capture ? "capture" : reuse ? "reuse" : "source";
      if (!reuse) {
        try {
          await access(path.join(workspace, "input/changes.json"));
          heldOutObservedEarly = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const has = (name) => body.tools?.some((entry) => entry.function?.name === name);
      const once = (key) => {
        if (requested.has(key)) return false;
        requested.add(key);
        return true;
      };
      let tool;
      if (capture && has("skill_manage") && once("capture:create"))
        tool = { name: "skill_manage", arguments: { action: "create", name: "release-note", content: skill } };
      else if (reuse && has("skill_view") && once("reuse:skill"))
        tool = { name: "skill_view", arguments: { name: "release-note" } };
      else if (!capture && has("read_file") && once(`${phase}:input`))
        tool = { name: "read_file", arguments: { path: reuse ? "input/changes.json" : "input/source-changes.json" } };
      else if (!capture && has("write_file") && once(`${phase}:write`)) {
        const values = JSON.parse(
          reuse ? task.phases[2].files["input/changes.json"] : task.files["input/source-changes.json"],
        );
        tool = {
          name: "write_file",
          arguments: {
            path: reuse ? "release.md" : "source-release.md",
            content: `# What changed\n${values.fixed.join("\n")}\n# Evidence\n${values.evidence.join("\n")}\n# Unverified\n${values.unverified.join("\n")}\n`,
          },
        };
      } else if (!capture && has("read_file") && once(`${phase}:verify`))
        tool = { name: "read_file", arguments: { path: reuse ? "release.md" : "source-release.md" } };
      const message = tool
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `workflow${calls.length}`,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          }
        : {
            role: "assistant",
            content: capture
              ? "The proposal is pending exact operator review and activation."
              : "The release notes were created and checked against the supplied input.",
          };
      calls.push({
        phase,
        tool,
        tools: body.tools?.map((entry) => entry.function?.name),
        results: body.messages?.filter((entry) => entry.role === "tool"),
      });
      const base = {
        id: `workflow-${calls.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "fixture-model",
      };
      const usage = { prompt_tokens: 200, completion_tokens: 250, total_tokens: 450 },
        finish_reason = tool ? "tool_calls" : "stop";
      if (!body.stream)
        return new Response(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason }], usage }), {
          headers: { "content-type": "application/json" },
        });
      const delta = tool
        ? { role: "assistant", tool_calls: message.tool_calls.map((entry) => ({ index: 0, ...entry })) }
        : message;
      return new Response(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
} catch (error) {
  failure = error;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
await writeNativeComparisonJson(path.join(root, "proof.json"), {
  fixtureOnly: true,
  source: "controlled_fixture",
  result,
  ...(failure ? { failure: failure.message } : {}),
  calls,
  heldOutObservedEarly,
  localModelCalls: calls.length,
  upstreamModelRequests: 0,
});
if (failure) throw failure;
assert.equal(result.receipt.exitCode, 0);
assert.equal(result.receipt.stopReason, "process_exit");
assert.equal(result.receipt.cleanupUnconfirmed, false);
assert.equal(heldOutObservedEarly, false);
assert.ok(calls.length > 0 && calls.length <= 24);
const verification = await verifyComparisonEvidence({
  taskId: task.id,
  workspaceRoot: workspace,
  evidenceRoot: result.evidenceDirectory,
});
await writeNativeComparisonJson(path.join(root, "verification.json"), verification);
assert.equal(verification.evidenceKind, "controlled");
assert.equal(verification.outcome, "passed", JSON.stringify(verification.checks));
const execution = JSON.parse(await readFile(path.join(result.evidenceDirectory, "execution.json"), "utf8"));
process.stdout.write(
  JSON.stringify({
    root,
    fixtureOnly: true,
    success: true,
    nativeSnapshots: execution.nativeSnapshotCount,
    independentChecks: Object.keys(verification.checks).length,
    localModelCalls: calls.length,
    upstreamModelRequests: 0,
  }) + "\n",
);

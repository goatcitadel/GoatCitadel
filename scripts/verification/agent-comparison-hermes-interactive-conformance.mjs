import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_VERSION, prepareComparison, sha256 } from "./lib/agent-comparison.mjs";
import { NATIVE_COMPARISON_PINS, NATIVE_COMPARISON_VERSION } from "./lib/agent-comparison-native-profile.mjs";
import {
  prepareNativeComparisonLaunch,
  runNativeComparison,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { assertNativeApprovalTerminal } from "./lib/agent-comparison-native-approval-console.mjs";

const [checkoutRoot, executablePath, root, decision = "allow-once"] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  ![5, 6].includes(process.argv.length) ||
  ![checkoutRoot, executablePath, root].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
  !["allow-once", "deny", "abort"].includes(decision)
)
  throw new Error(
    "Usage (Windows): node agent-comparison-hermes-interactive-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]",
  );
assertNativeApprovalTerminal();
const pricing = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  requestUsd: 0,
  observedAt: "2026-09-09T00:00:00.000Z",
  sourceSha256: sha256("synthetic Hermes interactive fixture"),
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
      outputTokens: 1024,
      maxTaskMs: 240000,
    },
  ]),
);
const manifest = prepareComparison({
  schemaVersion: COMPARISON_VERSION,
  products,
  transportProfile,
  trials: 3,
  maxRequests: 12,
  maxCostUsd: 2,
});
const options = {
  schemaVersion: "goatcitadel.agent-comparison.supervised.v1",
  cellId: "hermes:cited_research:1",
  checkoutRoot,
  apiKeyEnv: "CONTROLLED_FIXTURE_KEY",
  ...transportProfile,
  nativeInteractiveCli: true,
};
const launch = await prepareNativeComparisonLaunch({
  manifest,
  cellId: options.cellId,
  checkoutRoot,
  executablePath,
  interactiveCli: true,
});
await mkdir(root);
await writeNativeComparisonJson(path.join(root, "manifest.json"), manifest);
const outputDirectory = path.join(root, "cell"),
  workspace = path.join(outputDirectory, "workspace");
const fixtureFile = path.join(workspace, "approval-probe.txt"),
  fixtureBytes = "DISPOSABLE_COMPARISON_FILE\n";
// The native Windows Hermes terminal uses Bash; forward slashes preserve the
// absolute executable path instead of interpreting backslashes as escapes.
const powershell = path
  .join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  .replaceAll("\\", "/");
const command = `${powershell} -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath './approval-probe.txt' -ErrorAction Stop"`;
await writeNativeComparisonJson(path.join(root, "fixture.json"), {
  fixtureOnly: true,
  expectedDecision: decision,
  command,
  workspace,
  fixtureFile,
  fixtureSha256: sha256(fixtureBytes),
  stdoutCapture: "not_captured_native_terminal",
});
process.stdout.write(
  `Native Hermes fixture: ${root}\nExpected: ${decision}. Only removal of this disposable file is in scope: ${fixtureFile}\nAfter the turn, use Hermes /exit. This fixture never supplies an approval.\n`,
);
const stop = new AbortController(),
  interrupt = () => stop.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const calls = [];
let requested = false;
try {
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
    onNativeOutput: (chunk) => process.stdout.write(chunk),
    fetchUpstream: async (_url, init) => {
      const body = JSON.parse(init.body),
        terminal = body.tools?.find((tool) => tool.function?.name === "terminal");
      let message = { role: "assistant", content: "LOCAL_HERMES_APPROVAL_FIXTURE_DONE" };
      if (terminal && !requested) {
        await writeFile(fixtureFile, fixtureBytes, { flag: "wx" });
        requested = true;
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "callhermesapprovalfixture",
              type: "function",
              function: { name: "terminal", arguments: JSON.stringify({ command, workdir: workspace }) },
            },
          ],
        };
      }
      calls.push({
        tools: body.tools?.map((tool) => tool.function?.name),
        requestedTool: Boolean(message.tool_calls),
        results: body.messages?.filter((entry) => entry.role === "tool"),
      });
      const base = {
        id: "chatcmpl-hermes-fixture",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.4",
      };
      const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
        finish_reason = message.tool_calls ? "tool_calls" : "stop";
      if (!body.stream)
        return new Response(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason }], usage }), {
          headers: { "content-type": "application/json" },
        });
      const delta = message.tool_calls
        ? { role: "assistant", tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
        : message;
      return new Response(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let remaining = null;
  try {
    remaining = await readFile(fixtureFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const transcript = JSON.parse(
    await readFile(path.join(result.evidenceDirectory, "native-hermes-transcript.json"), "utf8"),
  );
  await writeNativeComparisonJson(path.join(root, "proof.json"), {
    fixtureOnly: true,
    decision,
    remaining,
    calls,
    result,
    upstreamModelRequests: 0,
    transcriptStatus: transcript.status,
    nativeApprovalVotes: "operator_review_required",
  });
  assert.ok(requested, "The native CLI did not request the controlled terminal operation.");
  assert.equal(remaining, decision === "allow-once" ? null : fixtureBytes);
  assert.equal(result.receipt.cleanupUnconfirmed, false);
  assert.equal(transcript.status, "retained");
  // Ctrl+C cancels the native turn; the operator then exits the CLI normally.
  // A supervisor timeout with an untouched file is not cancellation proof.
  assert.equal(result.receipt.exitCode, 0);
  assert.equal(result.receipt.stopReason, "process_exit");
  const toolResults = transcript.messages.filter(
    (message) => message.role === "tool" && message.tool_call_id === "callhermesapprovalfixture",
  );
  assert.equal(toolResults.length, 1);
  const toolResult = JSON.parse(toolResults[0].content);
  if (decision === "allow-once") {
    assert.equal(toolResult.exit_code, 0);
    assert.equal(toolResult.error, null);
    assert.match(toolResult.approval, /was approved by the user/);
  } else {
    assert.equal(toolResult.exit_code, -1);
    assert.equal(toolResult.status, "blocked");
    assert.match(toolResult.error, /^BLOCKED: User denied this command\./);
  }
  if (decision === "abort") {
    assert.ok(
      transcript.messages.some(
        (message) => message.role === "assistant" && message.content === "Operation interrupted.",
      ),
      "The native transcript must retain the interrupted turn.",
    );
  }
  assert.equal(result.receipt.taskOutcome, "unverified");
  assert.equal(result.transport.requests, calls.length);
  process.stdout.write(
    `${JSON.stringify({ root, success: true, decision, localModelCalls: calls.length, upstreamModelRequests: 0 })}\n`,
  );
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

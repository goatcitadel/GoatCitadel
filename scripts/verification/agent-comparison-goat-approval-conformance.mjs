import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildNativeComparisonProfile,
  bindNativeComparisonConfig,
  nativeComparisonArguments,
  NATIVE_COMPARISON_PINS,
} from "./lib/agent-comparison-native-profile.mjs";
import {
  initializeNativeComparisonWorkspace,
  readNativeComparisonGit,
  nativeComparisonEnvironment,
  superviseNativeComparisonProcess,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { createComparisonProviderProxy } from "./lib/agent-comparison-provider.mjs";
import { ComparisonDispatchBudget, sha256 } from "./lib/agent-comparison.mjs";
import { assertNativeApprovalTerminal } from "./lib/agent-comparison-native-approval-console.mjs";

const [checkoutRoot, root, decision = "allow-once"] = process.argv.slice(2);
if (
  ![4, 5].includes(process.argv.length) ||
  ![checkoutRoot, root].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
  !["allow-once", "deny", "abort"].includes(decision)
)
  throw new Error(
    "Usage: node agent-comparison-goat-approval-conformance.mjs ABSOLUTE_WORKING_CHECKOUT NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]",
  );
assertNativeApprovalTerminal();
const appSha256 = createHash("sha256")
  .update(await readFile(path.join(checkoutRoot, "apps/gateway/dist/app.js")))
  .digest("hex");
const git = await readNativeComparisonGit();
await mkdir(root);
const workspace = path.join(root, "workspace"),
  homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(homeDirectory, "state"),
  evidence = path.join(root, "evidence");
for (const directory of [workspace, path.join(stateDirectory, "config"), path.join(homeDirectory, "tmp"), evidence])
  await mkdir(directory, { recursive: true });
const expectedMarker = `CONTROLLED_GOAT_APPROVAL_${randomUUID()}`;
const markerFile = path.join(workspace, "terminal-result.txt");
const fixtureScript =
  "const fs=require('node:fs'); const path=require('node:path');\n" +
  `fs.writeFileSync(path.join(__dirname,'terminal-result.txt'),${JSON.stringify(expectedMarker)},{flag:'wx'});\n`;
const profile = {
  revision: NATIVE_COMPARISON_PINS.goatcitadel,
  provider: "comparison",
  model: "fixture-model",
  tools: ["files", "terminal"],
  grants: ["test-workspace"],
  reasoning: "none",
  contextTokens: 32000,
  outputTokens: 4096,
  maxTaskMs: 180000,
};
const plan = buildNativeComparisonProfile("goatcitadel", profile, "max_completion_tokens", { approvalGateway: true });
await writeNativeComparisonJson(path.join(root, "fixture.json"), {
  fixtureOnly: true,
  source: "working_build_not_clean_pinned_campaign",
  appSha256,
  git,
  plan,
  decision,
  expectedCommand: "node ./terminal-probe.cjs",
  fixtureScriptSha256: sha256(fixtureScript),
});
const journal = await open(path.join(root, "journal.jsonl"), "wx", 0o600);
let tail = Promise.resolve();
const persist = (kind, value) => {
  const next = tail.then(async () => {
    await journal.write(`${JSON.stringify({ kind, value })}\n`);
    await journal.sync();
  });
  tail = next.catch(() => {});
  return next;
};
const budget = new ComparisonDispatchBudget({
  maxRequests: 12,
  maxCostUsd: 2,
  persist: (event) => persist("budget", event),
});
const calls = [];
let requested = false;
const proxy = await createComparisonProviderProxy({
  budget,
  cellId: "goatcitadel:cited_research:1",
  profile: {
    ...profile,
    outputField: "max_completion_tokens",
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      requestUsd: 0,
      observedAt: "2026-09-09T00:00:00.000Z",
      sourceSha256: sha256("synthetic GoatCitadel approval fixture"),
    },
  },
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  upstreamApiKey: "controlled-no-live-provider",
  persistReceipt: (receipt) => persist("receipt", receipt),
  fetchUpstream: async (_url, init) => {
    const body = JSON.parse(init.body),
      tool = body.tools?.find((entry) => ["shell_exec", "shell.exec"].includes(entry.function?.name));
    let message = { role: "assistant", content: "LOCAL_APPROVAL_FIXTURE_DONE" };
    if (tool && !requested) {
      requested = true;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "callgoatapprovalfixture",
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({ command: "node ./terminal-probe.cjs", cwd: workspace }),
            },
          },
        ],
      };
    }
    calls.push({
      model: body.model,
      tools: body.tools?.map((entry) => entry.function?.name),
      requestedTool: Boolean(message.tool_calls),
      results: body.messages?.filter((entry) => entry.role === "tool"),
    });
    const base = { id: "controlled-goat-approval", object: "chat.completion", model: profile.model };
    const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 };
    const finish_reason = message.tool_calls ? "tool_calls" : "stop";
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
let child;
const controller = new AbortController(),
  stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timer = setTimeout(stop, profile.maxTaskMs);
try {
  const configFile = path.join(stateDirectory, plan.filename);
  await writeNativeComparisonJson(
    configFile,
    bindNativeComparisonConfig(
      plan,
      {
        revision: plan.revision,
        effectiveConfigSha256: plan.effectiveConfigSha256,
        baseUrl: proxy.baseUrl,
        apiKey: proxy.apiKey,
      },
      workspace,
    ),
  );
  await writeNativeComparisonJson(path.join(stateDirectory, "config/llm-model-metadata.json"), {
    version: 1,
    entries: {
      "comparison/fixture-model": {
        contextWindow: profile.contextTokens,
        outputTokenLimit: profile.outputTokens,
        reasoning: { supportedEfforts: ["none"] },
      },
    },
  });
  for (const [filename, contents] of [
    [path.join(stateDirectory, ".env"), ""],
    [path.join(workspace, "terminal-probe.cjs"), fixtureScript],
    [
      path.join(root, "prompt.txt"),
      "Use shell.exec to run node ./terminal-probe.cjs in this project. Preserve the native approval. After it is resolved, report the tool result.",
    ],
  ]) {
    const file = await open(filename, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  process.stdout.write(
    `Controlled fixture: ${root}\nOnly node ./terminal-probe.cjs is in scope. Expected decision: ${decision}.\n`,
  );
  const environment = nativeComparisonEnvironment({
    product: "goatcitadel",
    homeDirectory,
    stateDirectory,
    executablePath: process.execPath,
    checkoutRoot,
    proxyKey: proxy.apiKey,
    toolGitPath: git.executablePath,
  });
  await writeNativeComparisonJson(
    path.join(root, "workspace-git.json"),
    await initializeNativeComparisonWorkspace({
      workspace,
      homeDirectory,
      gitExecutablePath: git.executablePath,
      environment,
      signal: controller.signal,
    }),
  );
  child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    cwd: workspace,
    args: nativeComparisonArguments("goatcitadel", {
      checkoutRoot,
      configFile,
      stateDirectory,
      promptFile: path.join(root, "prompt.txt"),
      workspace,
      profile,
      evidenceDirectory: evidence,
      approvalGateway: true,
    }),
    environment,
    signal: controller.signal,
    interactiveInput: true,
    onOutput: (chunk) => process.stdout.write(chunk),
  });
  const result = await child.finished;
  let marker = null;
  try {
    marker = await readFile(markerFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const nativeFiles = await readdir(path.join(evidence, "goatcitadel"));
  const intents = [];
  for (const name of nativeFiles.filter((name) => name.endsWith("-intent.json")))
    intents.push(JSON.parse(await readFile(path.join(evidence, "goatcitadel", name), "utf8")));
  await writeNativeComparisonJson(path.join(root, "proof.json"), {
    fixtureOnly: true,
    source: "working_build_not_clean_pinned_campaign",
    appSha256,
    decision,
    result,
    marker,
    calls,
    intents,
    nativeFiles,
    upstreamModelRequests: 0,
  });
  assert.ok(requested, "The real Chat runner did not receive the terminal fixture call.");
  assert.equal(marker, decision === "allow-once" ? expectedMarker : null);
  assert.equal(intents.length, decision === "abort" ? 0 : 1);
  if (decision !== "abort") {
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopReason, "process_exit");
    assert.equal(intents[0].decision, decision === "allow-once" ? "approve" : "reject");
    assert.ok(nativeFiles.includes("thread-final.json"));
  } else {
    const interrupted = JSON.parse(await readFile(path.join(evidence, "goatcitadel/interrupted.json"), "utf8"));
    assert.equal(interrupted.status, "cancelled");
    assert.equal(interrupted.reason, "operator_console_closed");
    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "process_exit");
    assert.equal(nativeFiles.includes("thread-final.json"), false);
  }
  assert.equal(result.cleanupUnconfirmed, false);
  process.stdout.write(
    `${JSON.stringify({ root, success: true, decision, markerCreated: Boolean(marker), localModelCalls: calls.length, upstreamModelRequests: 0 })}\n`,
  );
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await child?.stop("fixture_close");
  await proxy.close();
  await tail;
  await journal.close();
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, open, access } from "node:fs/promises";
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
import { ComparisonDispatchBudget, COMPARISON_TASKS, sha256 } from "./lib/agent-comparison.mjs";
import { assertNativeApprovalTerminal } from "./lib/agent-comparison-native-approval-console.mjs";
import { PERMISSION_REVIEW_VERSION, PERMISSION_REVIEW_FILE } from "./lib/agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";
import { readNativeGoatWorkflowEvidence } from "./lib/agent-comparison-goat-evidence.mjs";

const [checkoutRoot, root] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  ![checkoutRoot, root].every((value) => typeof value === "string" && path.isAbsolute(value))
)
  throw new Error(
    "Usage: node agent-comparison-goat-workflow-conformance.mjs ABSOLUTE_WORKING_CHECKOUT NEW_ABSOLUTE_DIRECTORY",
  );
assertNativeApprovalTerminal();
const appSha256 = sha256(await readFile(path.join(checkoutRoot, "apps/gateway/dist/app.js")));
const git = await readNativeComparisonGit();
const task = COMPARISON_TASKS.find((entry) => entry.id === "workflow_capture_reuse");
const profile = {
  revision: NATIVE_COMPARISON_PINS.goatcitadel,
  provider: "comparison",
  model: "fixture-model",
  tools: ["files", "skills"],
  grants: ["test-workspace"],
  reasoning: "none",
  contextTokens: 32000,
  outputTokens: 8192,
  maxTaskMs: 600000,
};
const plan = buildNativeComparisonProfile("goatcitadel", profile, "max_completion_tokens", {
  approvalGateway: true,
  skillWorkflow: true,
});
const binding = {
  executionId: randomUUID(),
  manifestSha256: sha256({ fixtureOnly: true, appSha256, profile }),
  cellId: "goatcitadel:workflow_capture_reuse:1",
  revision: profile.revision,
  effectiveConfigSha256: plan.effectiveConfigSha256,
  fixtureSha256: sha256(task),
};
await mkdir(root);
const cell = path.join(root, "cell"),
  workspace = path.join(cell, "workspace"),
  evidence = path.join(cell, "evidence"),
  homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(homeDirectory, "state");
for (const directory of [workspace, evidence, path.join(stateDirectory, "config"), path.join(homeDirectory, "tmp")])
  await mkdir(directory, { recursive: true });
const writeText = async (filename, value) => {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
for (const [filename, value] of Object.entries(task.files)) {
  const target = path.join(workspace, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeText(target, value);
}
await writeText(path.join(cell, "prompt.txt"), task.phases[0].prompt);
await writeText(path.join(stateDirectory, ".env"), "");
await writeNativeComparisonJson(path.join(evidence, "session-start.json"), {
  ...binding,
  source: "controlled_fixture",
  product: "goatcitadel",
  taskId: task.id,
  profile,
  fixtureOnly: true,
  appSha256,
});
await writeNativeComparisonJson(path.join(evidence, "native-launch.json"), {
  ...binding,
  plan,
  appSha256,
  source: "working_build_not_clean_pinned_campaign",
});
const launchReceipt = {
  path: "native-launch.json",
  sha256: sha256(await readFile(path.join(evidence, "native-launch.json"))),
};
await writeNativeComparisonJson(path.join(evidence, PERMISSION_REVIEW_FILE), {
  schemaVersion: PERMISSION_REVIEW_VERSION,
  ...binding,
  policy: plan.permissionPolicy,
  reviewedBy: "controlled_local_fixture_not_live_operator_review",
  reviewedAt: new Date().toISOString(),
  sourceReceipts: [launchReceipt],
});
const skill = `---
name: release-note
description: Prepare release notes from supplied change, evidence, and unverified claim lists.
metadata:
  tools: [file.read_range, documents.create]
  keywords: [release-note, release notes]
---
# Release note

## When to use
Use when the operator requests release notes from a supplied change list.

## Inputs
The operator supplies an input JSON filename and an output Markdown filename. The JSON contains fixed, evidence, and unverified arrays.

## Instructions
Read the supplied input file. Write the fixed entries under What changed, the evidence entries under Evidence, and unsupported claims under Unverified. Preserve the factual wording.

## Failure handling
If the input is missing or invalid, stop and explain what is needed. Do not invent changes or evidence.

## Output
Create the requested Markdown file with What changed, Evidence, and Unverified sections.

## Verification
Read the output and compare every entry with the supplied input. Confirm that unsupported claims appear only in Unverified.

## Boundaries
Operate only on the supplied workspace files. Do not publish, deploy, send messages, activate another skill, or write durable memory.
`;
await writeNativeComparisonJson(path.join(root, "fixture.json"), {
  fixtureOnly: true,
  source: "working_build_not_clean_pinned_campaign",
  appSha256,
  plan,
  skillSha256: sha256(skill),
  skill,
});
const journal = await open(path.join(root, "journal.jsonl"), "wx", 0o600);
let tail = Promise.resolve();
const persist = (kind, value) => {
  const next = tail.then(async () => {
    await journal.write(JSON.stringify({ kind, value }) + "\n");
    await journal.sync();
  });
  tail = next.catch(() => {});
  return next;
};
const budget = new ComparisonDispatchBudget({
  maxRequests: 30,
  maxCostUsd: 2,
  persist: (event) => persist("budget", event),
});
const calls = [],
  requested = new Set();
let heldOutObservedEarly = false;
const proxy = await createComparisonProviderProxy({
  budget,
  cellId: binding.cellId,
  profile: {
    ...profile,
    outputField: "max_completion_tokens",
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      requestUsd: 0,
      observedAt: "2026-09-09T00:00:00.000Z",
      sourceSha256: sha256("synthetic GoatCitadel workflow fixture"),
    },
  },
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  upstreamApiKey: "controlled-no-live-provider",
  persistReceipt: (receipt) => persist("receipt", receipt),
  fetchUpstream: async (_url, init) => {
    const body = JSON.parse(init.body);
    const lastUser = body.messages?.findLast((message) => message.role === "user")?.content ?? "";
    const text = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser);
    const capture = text.includes("WORKFLOW_SKILL_CAPTURE_V1 ");
    const reuse = !capture && text.includes("input/changes.json");
    const turn = capture ? "capture" : reuse ? "reuse" : "source";
    if (!reuse) {
      try {
        await access(path.join(workspace, "input/changes.json"));
        heldOutObservedEarly = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const read = body.tools?.find((entry) =>
      ["fs_read", "fs.read", "file_read_range", "file.read_range"].includes(entry.function?.name),
    );
    const write = body.tools?.find((entry) =>
      ["fs_write", "fs.write", "documents_create", "documents.create"].includes(entry.function?.name),
    );
    const readRange = ["file_read_range", "file.read_range"].includes(read?.function.name)
      ? { startLine: 1, endLine: 200 }
      : {};
    let message = {
      role: "assistant",
      content: capture ? skill : "The release notes were written and checked against the supplied input.",
    };
    let tool;
    if (!capture && read && !requested.has(`${turn}:read`)) {
      requested.add(`${turn}:read`);
      tool = {
        name: read.function.name,
        arguments: { path: reuse ? "input/changes.json" : "input/source-changes.json", ...readRange },
      };
    } else if (!capture && write && !requested.has(`${turn}:write`)) {
      requested.add(`${turn}:write`);
      const values = JSON.parse(
        reuse ? task.phases[2].files["input/changes.json"] : task.files["input/source-changes.json"],
      );
      const content = `# What changed\n${values.fixed.join("\n")}\n# Evidence\n${values.evidence.join("\n")}\n# Unverified\n${values.unverified.join("\n")}\n`;
      tool = {
        name: write.function.name,
        arguments: {
          path: reuse ? "release.md" : "source-release.md",
          ...(["documents_create", "documents.create"].includes(write.function.name)
            ? {
                format: "markdown",
                title: "Release notes",
                sections: [
                  { heading: "What changed", bullets: values.fixed },
                  { heading: "Evidence", bullets: values.evidence },
                  { heading: "Unverified", bullets: values.unverified },
                ],
                design: { mode: "plain" },
              }
            : { content }),
        },
      };
    } else if (!capture && read && requested.has(`${turn}:write`) && !requested.has(`${turn}:verify`)) {
      requested.add(`${turn}:verify`);
      tool = {
        name: read.function.name,
        arguments: { path: reuse ? "release.md" : "source-release.md", ...readRange },
      };
    }
    if (tool)
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `callworkflow${calls.length}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      };
    calls.push({
      turn,
      tools: body.tools?.map((entry) => entry.function?.name),
      tool,
      results: body.messages?.filter((entry) => entry.role === "tool"),
    });
    return new Response(
      JSON.stringify({
        id: `workflow-${calls.length}`,
        object: "chat.completion",
        model: profile.model,
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 250, total_tokens: 450 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});
const controller = new AbortController(),
  interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(() => controller.abort("deadline"), profile.maxTaskMs);
let child;
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
  process.stdout.write(
    `Controlled native skill workflow: ${root}\nReview the generated release-note skill and approve only that exact version. All model responses are local fixtures.\n`,
  );
  child = superviseNativeComparisonProcess({
    executablePath: process.execPath,
    cwd: workspace,
    environment,
    signal: controller.signal,
    interactiveInput: true,
    onOutput: (chunk) => process.stdout.write(chunk),
    args: nativeComparisonArguments("goatcitadel", {
      checkoutRoot,
      configFile,
      stateDirectory,
      promptFile: path.join(cell, "prompt.txt"),
      workspace,
      profile,
      evidenceDirectory: evidence,
      approvalGateway: true,
      skillWorkflow: true,
    }),
  });
  const result = await child.finished;
  await writeNativeComparisonJson(path.join(root, "proof.json"), {
    fixtureOnly: true,
    source: "working_build_not_clean_pinned_campaign",
    appSha256,
    result,
    calls,
    heldOutObservedEarly,
    upstreamModelRequests: 0,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, "process_exit");
  assert.equal(result.cleanupUnconfirmed, false);
  assert.equal(heldOutObservedEarly, false);
  const execution = await readNativeGoatWorkflowEvidence({
    evidenceDirectory: evidence,
    binding,
    source: "controlled_fixture",
    signal: controller.signal,
  });
  await writeNativeComparisonJson(path.join(evidence, "execution.json"), {
    ...execution,
    nativeReceipts: [...execution.nativeReceipts, launchReceipt],
  });
  const verified = await verifyComparisonEvidence({
    taskId: task.id,
    workspaceRoot: workspace,
    evidenceRoot: evidence,
  });
  await writeNativeComparisonJson(path.join(root, "verification.json"), verified);
  assert.equal(verified.outcome, "passed");
  process.stdout.write(
    JSON.stringify({
      root,
      success: true,
      nativeSnapshots: execution.nativeSnapshotCount,
      localModelCalls: calls.length,
      upstreamModelRequests: 0,
    }) + "\n",
  );
} finally {
  clearTimeout(timer);
  controller.abort();
  await child?.stop("fixture_close");
  await proxy.close();
  await tail;
  await journal.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

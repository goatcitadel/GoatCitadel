import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  startNativeOpenclawApprovalGateway,
  startNativeOpenclawApprovalReviewer,
  callNativeOpenclawApproval,
} from "./lib/agent-comparison-openclaw-gateway.mjs";
import {
  bindNativeComparisonConfig,
  nativeComparisonArguments,
  NATIVE_COMPARISON_PINS,
} from "./lib/agent-comparison-native-profile.mjs";
import {
  nativeComparisonEnvironment,
  superviseNativeComparisonProcess,
  prepareNativeComparisonLaunch,
} from "./lib/agent-comparison-native-driver.mjs";
import { createComparisonProviderProxy } from "./lib/agent-comparison-provider.mjs";
import { ComparisonDispatchBudget, COMPARISON_VERSION, prepareComparison, sha256 } from "./lib/agent-comparison.mjs";
import {
  createNativeConformanceProbes,
  evaluateNativeConformancePolicy,
} from "./lib/agent-comparison-native-probes.mjs";

const product = process.argv[2];
if (!["hermes", "openclaw"].includes(product)) throw new Error("Choose a controlled native product.");
const [checkoutRoot, executablePath, root, mode] = process.argv.slice(3);
const approvalResume = mode === "--approval-resume" && product === "openclaw";
const permissions = mode === "--permissions" || approvalResume;
if (
  (process.argv.length !== 6 && !(process.argv.length === 7 && permissions)) ||
  ![checkoutRoot, executablePath, root].every((value) => typeof value === "string" && path.isAbsolute(value))
)
  throw new Error(
    "Usage: node agent-comparison-native-conformance.mjs PRODUCT ABSOLUTE_CHECKOUT ABSOLUTE_NATIVE_EXECUTABLE NEW_ABSOLUTE_DIRECTORY [--permissions | --approval-resume (OpenClaw only)]",
  );
const profile = {
  revision: NATIVE_COMPARISON_PINS[product],
  provider: "comparison",
  model: "gpt-5.4",
  tools: permissions ? ["files", "terminal"] : ["files"],
  grants: ["test-workspace"],
  reasoning: "none",
  contextTokens: 128000,
  outputTokens: 512,
  maxTaskMs: 90000,
};
const manifest = prepareComparison({
  schemaVersion: COMPARISON_VERSION,
  trials: 3,
  maxRequests: 8,
  maxCostUsd: 2,
  products: Object.fromEntries(
    Object.entries(NATIVE_COMPARISON_PINS).map(([name, revision]) => [name, { ...profile, revision }]),
  ),
});
// Reuse the native source/executable/policy binding checks. This is fixture proof,
// never a campaign result or permission to send requests to a real provider.
const launch = await prepareNativeComparisonLaunch({
  manifest,
  cellId: `${product}:cited_research:1`,
  checkoutRoot,
  executablePath,
  approvalGateway: approvalResume,
});
await mkdir(root);
const workspace = path.join(root, "workspace"),
  homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(root, "state");
for (const directory of [workspace, homeDirectory, stateDirectory, path.join(homeDirectory, "tmp")])
  await mkdir(directory, { recursive: true });
const plan = launch.nativeProfile;
const journal = await open(path.join(root, "journal.jsonl"), "wx");
let journalTail = Promise.resolve();
const persist = (kind, value) => {
  const pending = journalTail.then(async () => {
    await journal.write(`${JSON.stringify({ kind, value })}\n`);
    await journal.sync();
  });
  journalTail = pending.catch(() => {});
  return pending;
};
// Synthetic accounting for controlled responses only; no paid provider exists here.
const budget = new ComparisonDispatchBudget({
  maxRequests: 8,
  maxCostUsd: 2,
  persist: (event) => persist("budget", event),
});
const calls = [];
const probes = createNativeConformanceProbes({ workspace, permissions });
const proxy = await createComparisonProviderProxy({
  budget,
  cellId: `${product}:cited_research:1`,
  profile: {
    ...profile,
    outputField: "max_completion_tokens",
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      requestUsd: 0,
      observedAt: "2026-09-09T00:00:00.000Z",
      sourceSha256: sha256("synthetic conformance pricing"),
    },
  },
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  upstreamApiKey: "controlled-fixture-no-upstream-key",
  persistReceipt: (receipt) => persist("receipt", receipt),
  fetchUpstream: async (_url, init) => {
    const body = JSON.parse(init.body);
    const tools = body.tools?.map((tool) => tool.function?.name) ?? [];
    const message =
      calls.length >= 7 ? { role: "assistant", content: "LOCAL_PROFILE_INCOMPLETE" } : probes.respond(body);
    const shouldCall = Boolean(message.tool_calls?.length);
    calls.push({
      model: body.model,
      outputCap: body.max_completion_tokens,
      reasoning: body.reasoning_effort,
      stream: body.stream,
      tools,
      requestedProbe: message.tool_calls?.[0]?.id ?? null,
      toolResults: (body.messages ?? [])
        .filter((entry) => entry.role === "tool")
        .map((entry) => ({
          toolCallId: entry.tool_call_id,
          content:
            typeof entry.content === "string"
              ? entry.content.slice(0, 4096)
              : JSON.stringify(entry.content)?.slice(0, 4096),
        })),
    });
    const base = {
      id: "chatcmpl-controlled",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: profile.model,
    };
    const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 };
    const finish_reason = shouldCall ? "tool_calls" : "stop";
    if (!body.stream)
      return new Response(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason }], usage }), {
        headers: { "content-type": "application/json" },
      });
    const delta = shouldCall
      ? { role: "assistant", tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
      : message;
    const bytes = `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`;
    return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
  },
});
let child, timer, gateway, reviewer, approvalProof;
const fixtureStop = new AbortController();
try {
  const connection = {
    revision: profile.revision,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    baseUrl: proxy.baseUrl,
    apiKey: proxy.apiKey,
  };
  const configFile = path.join(stateDirectory, plan.filename),
    promptFile = path.join(root, "prompt.txt");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(path.join(root, "launch.json"), JSON.stringify(launch, null, 2));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const fixture of probes.fixtures) await writeFile(fixture.filename, fixture.content, { flag: "wx" });
  await writeFile(
    promptFile,
    "Read fixture.txt with the file tool, then reply LOCAL_PROFILE_OK. Only this controlled workspace is in scope. Preserve native approvals and never grant an approval automatically.",
  );
  let environment = nativeComparisonEnvironment({
    product,
    homeDirectory,
    stateDirectory,
    executablePath,
    checkoutRoot,
    proxyKey: proxy.apiKey,
  });
  timer = setTimeout(() => fixtureStop.abort(), profile.maxTaskMs);
  if (approvalResume) {
    gateway = await startNativeOpenclawApprovalGateway({
      plan,
      connection,
      workspace,
      configFile,
      environment,
      checkoutRoot,
      executablePath,
      signal: fixtureStop.signal,
      superviseProcess: superviseNativeComparisonProcess,
    });
    environment = gateway.environment;
    await writeFile(path.join(root, "approval-gateway.json"), JSON.stringify(gateway.evidence, null, 2), {
      flag: "wx",
    });
    reviewer = await startNativeOpenclawApprovalReviewer({
      control: gateway.control,
      outputFile: path.join(root, "approval-events.jsonl"),
      signal: fixtureStop.signal,
      superviseProcess: superviseNativeComparisonProcess,
    });
  } else await writeFile(configFile, JSON.stringify(bindNativeComparisonConfig(plan, connection, workspace), null, 2));
  const args = nativeComparisonArguments(product, {
    checkoutRoot,
    configFile,
    stateDirectory,
    promptFile,
    workspace,
    profile,
    evidenceDirectory: root,
    approvalGateway: approvalResume,
  });
  child = superviseNativeComparisonProcess({
    executablePath,
    args,
    cwd: workspace,
    environment,
    signal: fixtureStop.signal,
  });
  if (approvalResume) {
    // This deterministic fixture alone resolves its one harmless, create-only
    // marker command. Campaign drivers never call this fixture approval path.
    let stopped = false;
    void child.finished.then(() => {
      stopped = true;
    });
    while (!approvalProof && !stopped) {
      const pending = await callNativeOpenclawApproval(gateway.control, "pending", {}, fixtureStop.signal);
      if (pending.approvals?.length) {
        if (
          pending.approvals.length !== 1 ||
          pending.approvals[0].kind !== "exec" ||
          pending.approvals[0].summary !== "node ./terminal-probe.cjs"
        )
          throw new Error("Refusing an unexpected native fixture approval.");
        const script = probes.fixtures.find((file) => file.filename.endsWith("terminal-probe.cjs"));
        if ((await readFile(script.filename, "utf8")) !== script.content)
          throw new Error("The controlled terminal fixture changed before approval.");
        try {
          await readFile(probes.markerFile);
          throw new Error("Terminal executed before native approval.");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const resolution = await callNativeOpenclawApproval(
          gateway.control,
          "resolve",
          { approvalId: pending.approvals[0].id, decision: "allow-once" },
          fixtureStop.signal,
        );
        if (resolution.approval?.decision !== "allow-once")
          throw new Error("Native approval did not record allow-once.");
        approvalProof = {
          source: "controlled_fixture_native_cli",
          pending,
          resolution,
          markerAbsentBeforeDecision: true,
        };
      } else await delay(200, undefined, { signal: fixtureStop.signal });
    }
  }
  const nativeResult = await child.finished;
  const result = {
    ...nativeResult,
    stdout: gateway
      ? gateway.redact(nativeResult.stdout)
      : nativeResult.stdout.replaceAll(proxy.apiKey, "[supervised proxy token]"),
    stderr: gateway
      ? gateway.redact(nativeResult.stderr)
      : nativeResult.stderr.replaceAll(proxy.apiKey, "[supervised proxy token]"),
  };
  let terminalBytes = null;
  if (permissions) {
    try {
      terminalBytes = await readFile(probes.markerFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const permissionEvidence = probes.evidence(terminalBytes);
  const policyConformance = evaluateNativeConformancePolicy(
    approvalProof
      ? {
          ...permissionEvidence,
          terminal: { outcome: "approval_required", source: "native_pending_before_decision" },
        }
      : permissionEvidence,
    plan.permissionPolicy,
    permissions,
  );
  const toolRequested = permissionEvidence.workspace_read.requested;
  const toolResultSeen = permissionEvidence.workspace_read.outcome === "allowed";
  const success =
    result.exitCode === 0 &&
    result.stopReason === "process_exit" &&
    !result.cleanupUnconfirmed &&
    policyConformance.status === "matched" &&
    toolRequested &&
    toolResultSeen &&
    result.stdout.includes("LOCAL_PROFILE_OK") &&
    (!approvalResume || (approvalProof && permissionEvidence.terminal.outcome === "allowed")) &&
    (!permissions ||
      Object.values(permissionEvidence).every((entry) => !["inconclusive", "unsupported"].includes(entry.outcome)));
  await writeFile(
    path.join(root, "proof.json"),
    JSON.stringify(
      {
        source: "controlled_native_proxy_and_tool",
        product,
        revision: profile.revision,
        launchSha256: launch.launchSha256,
        effectiveConfigSha256: plan.effectiveConfigSha256,
        nativeProfileSha256: plan.planSha256,
        configuredPermissions: plan.permissionPolicy,
        upstreamNetworkRequests: 0,
        syntheticBudget: { maxRequests: 8, maxCostUsd: 2 },
        calls,
        toolRequested,
        toolResultSeen,
        success,
        approvalConformance: approvalResume
          ? "controlled_native_allow_once"
          : permissions
            ? "observations_only_no_automatic_approval"
            : "not_exercised",
        ...(approvalProof ? { approvalProof } : {}),
        permissionEvidence,
        policyConformance,
        hostIsolation: "not_certified",
        result,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      root,
      product,
      success,
      exitCode: result.exitCode,
      localModelCalls: calls.length,
      toolRequested,
      toolResultSeen,
      policyConformance: policyConformance.status,
      permissionOutcomes: Object.fromEntries(
        Object.entries(permissionEvidence).map(([name, entry]) => [name, entry.outcome]),
      ),
      stopReason: result.stopReason,
      stderr: result.stderr.slice(-2000),
      stdout: result.stdout.slice(-2000),
    }),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  clearTimeout(timer);
  await child?.stop("fixture_cleanup");
  await reviewer?.stop("fixture_cleanup");
  await gateway?.stop("fixture_cleanup");
  await proxy.close();
  await journalTail;
  await journal.close();
}

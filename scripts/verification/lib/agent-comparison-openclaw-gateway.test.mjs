import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  buildNativeComparisonProfile,
  bindNativeComparisonConfig,
  NATIVE_COMPARISON_PINS,
} from "./agent-comparison-native-profile.mjs";
import { nativeComparisonEnvironment, superviseNativeComparisonProcess } from "./agent-comparison-native-driver.mjs";
import {
  callNativeOpenclawApproval,
  startNativeOpenclawApprovalGateway,
} from "./agent-comparison-openclaw-gateway.mjs";

const profile = {
  revision: NATIVE_COMPARISON_PINS.openclaw,
  provider: "fixture",
  model: "fixture-model",
  tools: ["files", "terminal"],
  grants: ["test-workspace"],
  reasoning: "none",
  contextTokens: 8192,
  outputTokens: 256,
  maxTaskMs: 5000,
};
const plan = buildNativeComparisonProfile("openclaw", profile, "max_completion_tokens", { approvalGateway: true });
const connection = {
  revision: profile.revision,
  effectiveConfigSha256: plan.effectiveConfigSha256,
  baseUrl: "http://127.0.0.1:30001/v1",
  apiKey: "a".repeat(64),
};

it("keeps supervised approval opt-in, source-pinned and distinct from model-proxy authority", () => {
  const headless = buildNativeComparisonProfile("openclaw", profile);
  assert.notEqual(plan.planSha256, headless.planSha256);
  assert.equal(plan.config.tools.exec.mode, "ask");
  assert.deepEqual(plan.config.tools.exec.safeBins, []);
  assert.equal(plan.permissionPolicy.terminal, headless.permissionPolicy.terminal);
  assert.equal(plan.config.cron.enabled, false);
  assert.equal(plan.config.discovery.mdns.mode, "off");
  assert.equal(plan.config.models.catalogRefresh.enabled, false);
  assert.throws(() => buildNativeComparisonProfile("hermes", profile, "max_tokens", { approvalGateway: true }));
  assert.throws(() => bindNativeComparisonConfig(plan, connection, path.resolve("workspace")));
  for (const binding of [
    { port: 30001, token: "b".repeat(64) },
    { port: 40001, token: connection.apiKey },
    { port: 0, token: "b".repeat(64) },
    { port: 40001, token: "short" },
  ])
    assert.throws(() => bindNativeComparisonConfig(plan, connection, path.resolve("workspace"), binding));
  const config = bindNativeComparisonConfig(plan, connection, path.resolve("workspace"), {
    port: 40001,
    token: "b".repeat(64),
  });
  assert.equal(config.gateway.auth.token, "b".repeat(64));
  assert.equal(config.models.providers.comparison.apiKey, connection.apiKey);
});

async function fixture(t, fail = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-native-approval-"));
  let gateway;
  t.after(async () => {
    await gateway?.stop("test_cleanup");
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^goat-native-approval-/u);
    await rm(root, { recursive: true, force: true });
  });
  // Argument/process fixture only. The opt-in native conformance command runs
  // the actual pinned OpenClaw Gateway and CLI separately.
  await writeFile(
    path.join(root, "openclaw.mjs"),
    `import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "gateway") { ${fail ? 'console.error("fixture startup refused"); process.exit(1);' : "setInterval(() => {}, 1000);"} }
else { for await (const chunk of process.stdin) { void chunk; } fs.appendFileSync("commands.jsonl", JSON.stringify(args) + "\\n");
console.log(JSON.stringify(args[1] === "pending" ? {approvals: []} : {approval: {decision: args.at(-1)}})); }
`,
    { flag: "wx" },
  );
  const environment = nativeComparisonEnvironment({
    product: "openclaw",
    homeDirectory: root,
    stateDirectory: root,
    executablePath: process.execPath,
    checkoutRoot: root,
    proxyKey: connection.apiKey,
  });
  const input = {
    plan,
    connection,
    workspace: root,
    configFile: path.join(root, "openclaw.json"),
    environment,
    checkoutRoot: root,
    executablePath: process.execPath,
    superviseProcess: superviseNativeComparisonProcess,
  };
  return { root, input, start: async () => (gateway = await startNativeOpenclawApprovalGateway(input)) };
}

it("starts an empty isolated owner, never grants by itself and stops only its process", async (t) => {
  const f = await fixture(t),
    gateway = await f.start();
  assert.equal(gateway.evidence.automaticApprovals, false);
  assert.equal(gateway.evidence.initialPendingApprovals, 0);
  const before = (await readFile(path.join(f.root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    before.map((args) => args.slice(0, 2)),
    [["approvals", "pending"]],
  );
  for (const input of [
    { approvalId: "one", decision: "allow-always" },
    { approvalId: "--help", decision: "allow-once" },
    { approvalId: "one\nother", decision: "deny" },
  ])
    await assert.rejects(callNativeOpenclawApproval(gateway.control, "resolve", input));
  await assert.rejects(callNativeOpenclawApproval(gateway.control, "arbitrary"));
  const result = await callNativeOpenclawApproval(gateway.control, "resolve", {
    approvalId: "exact-one",
    decision: "allow-once",
  });
  assert.equal(result.approval.decision, "allow-once");
  const config = JSON.parse(await readFile(f.input.configFile, "utf8"));
  assert.notEqual(config.gateway.auth.token, connection.apiKey);
  assert.doesNotMatch(JSON.stringify(gateway.evidence), new RegExp(config.gateway.auth.token));
  assert.equal(
    gateway.redact(`${config.gateway.auth.token} ${connection.apiKey}`),
    "[approval gateway token] [supervised proxy token]",
  );
  await assert.rejects(startNativeOpenclawApprovalGateway(f.input), /EEXIST/);
  config.gateway.port++;
  await writeFile(f.input.configFile, JSON.stringify(config));
  await assert.rejects(callNativeOpenclawApproval(gateway.control, "pending"), /configuration changed/);
  await gateway.stop("test_cleanup");
  assert.equal((await gateway.finished).cleanupUnconfirmed, false);
});

it("retains a bounded failure when its owned Gateway exits before readiness", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(f.start(), /fixture startup refused/);
});

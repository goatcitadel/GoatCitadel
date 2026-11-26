import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { installedRecall, withNativeRecallPage } from "./lib/windows-installed-recall.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  DETERMINISTIC_LLM_MODEL,
  DETERMINISTIC_LLM_PROVIDER_ID,
  startDeterministicLlmStub,
} from "../verification/lib/scenarios/deterministic-llm-stub.mjs";

const exec = promisify(execFile);
const [app, scratch, evidence, ollamaExe, fixtureArgument] = process.argv.slice(2);
const recallOnly = ollamaExe === "--recall-only";
const ntfyExe = recallOnly ? undefined : fixtureArgument;
const ollamaModel = "qwen2.5:0.5b";
const modelDigest = "a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67";
const ntfyTokenEnv = "NTFY_READINESS_TOKEN";
const marker = "READINESS-" + randomUUID().slice(0, 8).toUpperCase();
const sample = "Synthetic approved file " + marker;
const manifest = await readJson(path.join(app, "release-manifest.json"));
const launcher = path.join(app, "bin", "goatcitadel.mjs");
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:GOATCITADEL_|OLLAMA_|NTFY_|ACTIONS_|(?:GH|GITHUB)_TOKEN$|NODE_(?:OPTIONS|PATH)$)/i.test(name)));
const secrets = new Set();

assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(manifest.target, "windows-x64");
assert.equal(manifest.sourceModified, false);
assert.equal(await fs.realpath(process.execPath), await fs.realpath(path.join(app, "runtime", "node", "node.exe")));

function testSecret() {
  const value = randomUUID() + randomUUID();
  secrets.add(value);
  return value;
}

function redacted(value) {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text.slice(0, 1000);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
}

async function poll(check, description, timeoutMs = 90_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const found = await check();
    if (found) return found;
    await delay(500);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function ports(count) {
  const listeners = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(listeners.map((server) =>
      new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))));
    return listeners.map((server) => server.address().port);
  } finally {
    await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function request(port, route, options = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(8_000),
  });
}

async function withServer(exe, args, cwd, childEnv, run) {
  const log = await fs.open(path.join(cwd, `${path.basename(exe)}.log`), "wx");
  const child = spawn(exe, args, { cwd, env: childEnv, stdio: ["ignore", log.fd, log.fd], windowsHide: true });
  const closed = once(child, "close").catch(() => []);
  try {
    await once(child, "spawn");
    return await run();
  } finally {
    await log.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true });
    }
    assert.ok(await Promise.race([closed.then(() => true), delay(8_000, false, { ref: false })]), "Fixture server did not exit");
  }
}

async function withRuntime(root, { provider, model, fixtureEnv = {}, allow = [], recall = false }, run) {
  const [gatewayPort, uiPort] = await ports(2);
  const home = path.join(root, "home");
  const configDir = path.join(home, "runtime-root", "config");
  const runtimeDir = path.join(home, "runtime");
  const config = await readJson(path.join(app, "templates", "config", "goatcitadel.example.json"));
  delete config.generation;
  config.assistant.database.driver = "sqlite";
  config.assistant.durable.enabled = true;
  config.assistant.durable.executionEnabled = true;
  if (recall) {
    config.assistant.memory.enabled = true;
    Object.assign(config.assistant.features, {
      durableKernelV1Enabled: true,
      memoryLifecycleAdminV1Enabled: true,
      autonomyV1Disabled: true,
    });
  } else {
    config.assistant.toolApprovalMode = "approve_all";
    config.toolPolicy.approvalMode = "approve_all";
  }
  config.toolPolicy.sandbox.networkAllowlist = [new URL(provider.baseUrl).host, ...allow];
  config.cronJobs = { jobs: [] };
  const providerId = provider.providerId;
  config.llm = { activeProviderId: providerId, activeModel: model, providers: [provider] };
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await writeJson(path.join(configDir, "goatcitadel.json"), config);
  await writeJson(path.join(runtimeDir, "launcher-settings.json"), { schemaVersion: 1, gatewayPort, uiPort });
  if (providerId === DETERMINISTIC_LLM_PROVIDER_ID) {
    await writeJson(path.join(configDir, "llm-model-metadata.json"), {
      version: 1, entries: { [`${providerId}/${model}`]: { contextWindow: 128000, outputTokenLimit: 16000 } },
    });
  }
  const token = testSecret();
  const runtimeEnv = {
    ...env, ...fixtureEnv,
    GOATCITADEL_HOME: home,
    GOATCITADEL_APP_DIR: app,
    GOATCITADEL_AUTH_MODE: "token",
    GOATCITADEL_AUTH_TOKEN: token,
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"),
  };
  async function cli(...args) {
    const result = await exec(process.execPath, [launcher, ...args, "--json"], {
      cwd: root, env: runtimeEnv, timeout: 180_000, windowsHide: true,
    });
    return JSON.parse(result.stdout);
  }
  async function api(route, method = "GET", body) {
    const response = await request(gatewayPort, route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(125_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${route} returned ${response.status} ${redacted(JSON.stringify(data))}`);
    return data;
  }
  async function send(title, content, page) {
    const created = await api("/api/v1/chat/sessions", "POST", { title, workspaceId: "default" });
    const id = created.sessionId ?? created.session?.sessionId;
    assert.ok(id, "The Gateway did not create a session");
    const route = `/api/v1/chat/sessions/${encodeURIComponent(id)}`;
    const guided = providerId === DETERMINISTIC_LLM_PROVIDER_ID;
    const controls = {
      providerId, model, webMode: "off", memoryMode: recall ? "on" : "off", thinkingLevel: "off",
      speedMode: guided ? "standard" : "fast", subagentPolicy: "off",
      toolAutonomy: guided ? "safe_auto" : "manual", orchestrationEnabled: false,
    };
    const prefs = await api(route + "/prefs");
    await api(route + "/prefs", "PATCH", { ...controls, expectedRevision: prefs.revision });
    if (page) {
      await page.goto(`http://127.0.0.1:${uiPort}/chat?shell=cockpit&sessionId=${encodeURIComponent(id)}`);
      await page.getByPlaceholder(/^Message GoatCitadel/u).fill(content);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      return { id, route, content };
    }
    const input = {
      action: "send", content, providerId, model, webMode: "off", memoryMode: controls.memoryMode, thinkingLevel: "off",
      speedMode: controls.speedMode, subagentPolicy: "off", prefsOverride: controls,
    };
    const preflight = await api(route + "/route-preflight", "POST", input);
    assert.ok(preflight.decision, "Chat preflight omitted its route decision");
    await api(route + "/agent-send", "POST", { ...input, routeDecision: preflight.decision });
    return { id, route, content };
  }
  async function waitForTurn(chat, status) {
    return poll(async () => {
      const thread = await api(chat.route + "/thread");
      const turn = thread.turns?.find((entry) => entry.userMessage?.content === chat.content);
      if (turn?.trace?.status === status) return turn;
      if (["failed", "cancelled", "completed", "partial"].includes(turn?.trace?.status)) {
        throw new Error(`Unexpected Chat settlement ${turn.trace.status} ${redacted(JSON.stringify(turn.trace.failure))}`);
      }
    }, `the Chat turn to reach ${status}`, 155_000);
  }

  try {
    const launch = await cli("launch", "--no-open", "--wait");
    assert.equal(launch.status, "ready");
    assert.equal((await request(gatewayPort, "/livez")).status, 200);
    assert.equal((await request(uiPort, "/")).status, 200);
    const onboarding = "/api/v1/onboarding";
    await poll(async () => {
      try {
        if ((await api(onboarding + "/state")).completed) return true;
        await api(onboarding + "/complete", "POST", { completedBy: "installed-readiness" });
        return (await api(onboarding + "/state")).completed;
      } catch (error) {
        if (!error.message.includes("returned 409") || !error.message.includes("STATE_CONFLICT")) throw error;
      }
    }, "onboarding completion to persist", 10_000);
    const restart = async () => {
      const stopped = await cli("stop");
      assert.equal(stopped.notStopped?.length ?? 0, 0);
      const restarted = await cli("launch", "--no-open", "--wait");
      assert.equal(restarted.status, "ready");
    };
    const withNative = async (visit) => {
      const debugPort = fixtureArgument ? Number(fixtureArgument) : (await ports(1))[0];
      assert.ok(Number.isInteger(debugPort) && debugPort > 0 && debugPort <= 65535);
      return withNativeRecallPage({ app, root, runtimeEnv, uiPort, debugPort, poll, visit });
    };
    return await run({ api, send, waitForTurn, restart, withNative });
  } finally {
    const stopped = await cli("stop");
    assert.equal(stopped.notStopped?.length ?? 0, 0, "An installed runtime process did not stop");
  }
}

async function realProvider(root) {
  const [port] = await ports(1);
  const serverEnv = {
    ...env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: path.join(root, "models"),
    USERPROFILE: root, OLLAMA_NO_CLOUD: "1", OLLAMA_NUM_PARALLEL: "1", CUDA_VISIBLE_DEVICES: "-1",
  };
  return withServer(ollamaExe, ["serve"], root, serverEnv, async () => {
    const serverVersion = await poll(async () => {
      const response = await request(port, "/api/version").catch(() => null);
      return response?.ok && (await response.json()).version;
    }, "the real Ollama server", 30_000);
    assert.equal(serverVersion, "0.40.18");
    await exec(ollamaExe, ["pull", ollamaModel], {
      cwd: root, env: serverEnv, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    const tagList = await (await request(port, "/api/tags")).json();
    assert.equal(tagList.models.find((entry) => entry.name === ollamaModel)?.digest, modelDigest);
    const config = await readJson(path.join(app, "templates", "config", "goatcitadel.example.json"));
    const ollama = config.llm.providers.find((entry) => entry.providerId === "ollama");
    assert.ok(ollama, "The installed provider catalog omitted Ollama");
    const provider = { ...ollama, baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: ollamaModel, models: [ollamaModel] };
    return withRuntime(root, { provider, model: ollamaModel }, async ({ send, waitForTurn, api }) => {
      const started = performance.now();
      const chat = await send("Installed live Ollama", `Reply with this text and nothing else: ${marker}`);
      const turn = await waitForTurn(chat, "completed");
      assert.equal(turn.trace.model, ollamaModel);
      assert.ok(turn.trace.completion?.providerCallCount > 0, "Missing provider call evidence");
      assert.ok(turn.assistantMessage?.content?.includes(marker), "The real model reply omitted the prompt marker");
      const firstTask = (await api("/api/v1/onboarding/state")).firstTask;
      const recordedProvider = firstTask?.turnId === turn.turnId ? firstTask.providerId
        : turn.assistantMessage?.providerId ?? turn.assistantMessage?.metadata?.providerId;
      assert.equal(recordedProvider, "ollama");
      return {
        provider: recordedProvider, serverVersion, model: turn.trace.model, modelDigest, turnId: turn.turnId,
        providerCalls: turn.trace.completion.providerCallCount, response: redacted(turn.assistantMessage.content).slice(0, 160),
        elapsedMs: Math.round(performance.now() - started),
      };
    });
  });
}

async function withStub(root, runtimeOptions, run, stubOptions = {}) {
  const key = testSecret();
  const stub = await startDeterministicLlmStub({
    replyText: sample, expectedAuthorization: `Bearer ${key}`, ...stubOptions,
  });
  try {
    const provider = {
      providerId: DETERMINISTIC_LLM_PROVIDER_ID, label: "Installed acceptance fixture", baseUrl: stub.baseUrl,
      apiStyle: "openai-chat-completions", defaultModel: DETERMINISTIC_LLM_MODEL, models: [DETERMINISTIC_LLM_MODEL],
      apiKeyEnv: DETERMINISTIC_LLM_KEY_ENV,
    };
    return await withRuntime(root, {
      ...runtimeOptions, provider, model: DETERMINISTIC_LLM_MODEL,
      fixtureEnv: { ...runtimeOptions.fixtureEnv, [DETERMINISTIC_LLM_KEY_ENV]: key },
    }, run);
  } finally {
    await stub.close();
  }
}

async function governedApproval(root) {
  const notePath = path.join(root, "home", "runtime-root", "workspace", "readiness-note.txt");
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, sample, { flag: "wx" });
  return withStub(root, {}, async ({ api, send, waitForTurn }) => {
    const chat = await send("Installed governed approval", "Use fs.read on readiness-note.txt and quote the contents.");
    const waiting = await waitForTurn(chat, "waiting_for_approval");
    const tool = waiting.toolRuns.find((run) => run.toolName === "fs.read");
    assert.equal(tool?.status, "approval_required");
    assert.equal(tool.result, undefined);
    assert.ok(tool.approvalId);
    const runId = waiting.trace.durable?.runId;
    assert.ok(runId);
    const route = `/api/v1/approvals/${encodeURIComponent(tool.approvalId)}`;
    const preview = await api(route);
    assert.equal(preview.status, "pending");
    assert.match(JSON.stringify(preview.preview), /fs\.read/);
    assert.match(JSON.stringify(preview.preview), /readiness-note\.txt/);
    const resume = await api("/api/v1/chat/tools/approve", "POST", {
      sessionId: chat.id, approvalId: tool.approvalId, allowScope: "once",
    });
    assert.equal(resume.resumedRunId, runId);
    const turn = await waitForTurn(chat, "completed");
    assert.equal(turn.trace.durable?.runId, runId);
    const completed = turn.toolRuns.find((item) => item.toolRunId === tool.toolRunId);
    assert.equal(completed?.status, "executed");
    assert.ok(JSON.stringify(completed.result).includes(sample), "Approved tool result did not contain the fixture file contents");
    await poll(async () => {
      const result = await api(`/api/v1/durable/runs/${encodeURIComponent(runId)}`);
      return (result.run ?? result).status === "completed";
    }, "the same durable run to complete");
    const decision = await api(route);
    assert.equal(decision.status, "approved");
    return { tool: "fs.read", approvalId: tool.approvalId, scope: "once", decision: decision.status,
      durableRunId: runId, durableStatus: "completed", fileReadVerified: true, modelFixture: DETERMINISTIC_LLM_MODEL };
  }, {
    dispatchPlanRequiredTool: "fs_read",
    dispatchPlan: [{ type: "tool_call", name: "fs_read", arguments: { path: notePath }, callId: "installed_approval_read" }],
  });
}

async function realChannel(root) {
  const [port] = await ports(1);
  const baseUrl = `http://127.0.0.1:${port}`;
  const topic = marker.toLowerCase();
  const ntfyConfig = path.join(root, "ntfy.yml");
  await fs.writeFile(ntfyConfig, [
    `listen-http: 127.0.0.1:${port}`, `base-url: ${baseUrl}`, "auth-default-access: deny-all", "log-level: warn",
    ...["auth", "cache"].map((key) => `${key}-file: ${JSON.stringify(path.join(root, `${key}.db`).replaceAll("\\", "/"))}`),
  ].join("\n") + "\n", { flag: "wx" });
  const childEnv = { ...env, NTFY_CONFIG_FILE: ntfyConfig };
  return withServer(ntfyExe, ["serve", "--config", ntfyConfig], root, childEnv, async () => {
    await poll(async () => (await request(port, "/v1/health").catch(() => null))?.ok, "authenticated ntfy to start", 20_000);
    const password = testSecret();
    const command = (args) => exec(ntfyExe, args, {
      cwd: root, env: { ...childEnv, NTFY_PASSWORD: password }, timeout: 15_000, windowsHide: true,
    });
    await command(["user", "add", "readiness"]);
    await command(["access", "readiness", topic, "rw"]);
    const issued = await command(["token", "add", "--expires=2h", "readiness"]);
    const accessToken = (issued.stdout + issued.stderr).match(/\btk_[A-Za-z0-9_-]+\b/)?.[0];
    assert.ok(accessToken, "The test topic did not issue an access token");
    secrets.add(accessToken);
    const headers = { Authorization: `Bearer ${accessToken}` };
    const subscription = `/${topic}/json?poll=1&since=all`;
    const anonymous = await request(port, subscription);
    assert.ok([401, 403].includes(anonymous.status), "Anonymous access to the test topic was allowed");
    await anonymous.body?.cancel();
    return withStub(root, { fixtureEnv: { [ntfyTokenEnv]: accessToken }, allow: [`127.0.0.1:${port}`] }, async ({ api }) => {
      const { connectionId } = await api("/api/v1/integrations/connections", "POST", {
        catalogId: "channel.ntfy", label: "Protected runner ntfy", enabled: true, status: "connected", workspaceId: "default",
        config: { baseUrl, topic, tokenEnv: ntfyTokenEnv, inboundStreamEnabled: true,
          inboundAccessMode: "allowlist", allowedSenders: [`ntfy-topic:${topic}`] },
      });
      assert.ok(connectionId);
      const id = encodeURIComponent(connectionId);
      const journeyRoute = `/api/v1/channels/connections/${id}/journey`;
      await poll(async () => (await api(journeyRoute)).runtime.ready, "the ntfy stream to become ready");
      const message = `Synthetic outbound ${marker}`;
      const { deliveryId } = await api("/api/v1/comms/send", "POST", { connectionId, target: topic, message });
      assert.ok(deliveryId);
      async function getDelivery() {
        const { deliveries } = await api(`/api/v1/comms/deliveries?connectionId=${id}`);
        const delivery = deliveries.find((item) => item.deliveryId === deliveryId);
        if (delivery?.status === "failed") throw new Error(`ntfy send failed ${redacted(delivery.error)}`);
        return delivery;
      }
      await poll(async () => (await getDelivery())?.deliveryStatus === "waiting_approval", "the exact channel send approval");
      const { items } = await api("/api/v1/approvals?status=pending");
      const matching = items.filter((item) => item.payload?.connectionId === connectionId && item.payload?.message === message);
      assert.equal(matching.length, 1, "Expected one pending approval for the synthetic notification");
      const sendApproval = `/api/v1/approvals/${encodeURIComponent(matching[0].approvalId)}`;
      const approval = await api(sendApproval);
      assert.equal(approval.status, "pending");
      assert.equal(approval.preview?.toolName, "channel.send");
      assert.equal(approval.preview?.target, topic);
      assert.equal(approval.payload?.connectionId, connectionId);
      assert.equal(approval.payload?.target, topic);
      assert.equal(approval.payload?.message, message);
      await api(sendApproval + "/resolve", "POST", { decision: "approve", resolutionNote: "Synthetic notification to the runner test topic" });
      const sent = await poll(async () => {
        const delivery = await getDelivery();
        return delivery?.status === "sent" && delivery;
      }, "the approved notification to send");
      const replay = await request(port, subscription, { headers });
      assert.equal(replay.status, 200);
      const receipt = (await replay.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .find((item) => item.event === "message" && item.message === message);
      assert.ok(receipt?.id, "The independent ntfy subscriber did not receive the notification");
      assert.equal(sent.providerMessageId, receipt.id);
      assert.equal((await api(journeyRoute)).latestInbound, undefined, "The Gateway admitted its own notification");
      const inbound = `Reply with only ${marker}.`;
      const publication = await request(port, `/${topic}`, {
        method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: inbound,
      });
      assert.equal(publication.status, 200);
      const source = await publication.json();
      assert.ok(source.id && source.id !== receipt.id);
      const accepted = await poll(async () => {
        const journey = await api(journeyRoute);
        assert.notEqual(journey.latestInbound?.status, "failed", "The Gateway failed to admit inbound ntfy");
        return journey.states.inbound === "verified" && journey.latestInbound?.turnId && journey.latestInbound;
      }, "the independently published inbound notification to link to Chat");
      assert.ok(accepted.sessionId && accepted.durableRunId);
      const thread = await api(`/api/v1/chat/sessions/${encodeURIComponent(accepted.sessionId)}/thread`);
      const turn = thread.turns?.find((item) => item.turnId === accepted.turnId);
      assert.ok(turn?.userMessage?.content?.includes(inbound), "The linked Chat turn did not contain the inbound text");
      return { transport: "ntfy", authenticated: true, sendApprovalId: matching[0].approvalId,
        outboundProviderMessageId: receipt.id, inboundProviderMessageId: source.id, inboundEventId: accepted.eventId,
        turnId: accepted.turnId, durableRunId: accepted.durableRunId, modelFixture: DETERMINISTIC_LLM_MODEL };
    });
  });
}

const recallCheck = ["recall", (root) => installedRecall(root, evidence, withStub, poll)];
const checks = recallOnly
  ? [recallCheck]
  : [["provider", realProvider], ["channel", realChannel], ["approval", governedApproval]];
for (const [name, check] of checks) {
  const root = await fs.mkdtemp(path.join(scratch, `${name}-`));
  let result;
  try {
    result = { status: "passed", ...await check(root) };
  } catch (error) {
    result = { status: "failed", error: redacted(error.message) };
    process.exitCode = 1;
  }
  await writeJson(path.join(evidence, `${name}.json`), {
    ...result, sourceCommit: manifest.sourceCommit, target: manifest.target, node: process.versions.node,
  });
  console.log(`${name} ${result.status}${result.error ? ` (${result.error})` : ""}`);
}

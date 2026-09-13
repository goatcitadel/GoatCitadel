import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createReservation } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ComparisonDispatchBudget, COMPARISON_TASKS, sha256 } from "./lib/agent-comparison.mjs";
import { NATIVE_COMPARISON_PINS } from "./lib/agent-comparison-native-profile.mjs";
import {
  nativeComparisonEnvironment,
  readNativeComparisonCheckout,
  superviseNativeComparisonProcess,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { createComparisonProviderProxy } from "./lib/agent-comparison-provider.mjs";
import {
  observeOpenclawComparisonDelivery,
  readOpenclawComparisonDeliveryQueue,
  readOpenclawComparisonDeliveryDispatch,
} from "./lib/agent-comparison-openclaw-delivery.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./lib/agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";

// Fresh owned processes and synthetic transports only. No credential input or
// attachment to an existing operator Gateway is supported by this command.
const [checkoutRoot, executablePath, root] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  ![checkoutRoot, executablePath, root].every((value) => typeof value === "string" && path.isAbsolute(value))
)
  throw new Error(
    "Usage: node agent-comparison-openclaw-delivery-conformance.mjs ABSOLUTE_OPENCLAW_CHECKOUT ABSOLUTE_NODE NEW_ABSOLUTE_DIRECTORY",
  );
const checkout = await readNativeComparisonCheckout(checkoutRoot);
assert.equal(checkout.revision, NATIVE_COMPARISON_PINS.openclaw);
assert.equal(checkout.clean, true);
await mkdir(root);
const cellDirectory = path.join(root, "cell"),
  workspace = path.join(cellDirectory, "workspace"),
  evidence = path.join(cellDirectory, "evidence"),
  homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(homeDirectory, "openclaw"),
  raw = path.join(root, "native");
for (const directory of [workspace, evidence, stateDirectory, path.join(homeDirectory, "tmp"), raw])
  await mkdir(directory, { recursive: true });
const write = writeNativeComparisonJson;
let sequence = 0;
const retain = (name, value) => write(path.join(raw, `${String(++sequence).padStart(4, "0")}-${name}.json`), value);
const profile = {
  provider: "comparison",
  model: "fixture-model",
  reasoning: "none",
  contextTokens: 64000,
  outputTokens: 2048,
  maxTaskMs: 300000,
  tools: ["schedule"],
  grants: ["controlled-telegram-target"],
};
const task = COMPARISON_TASKS.find((entry) => entry.id === "scheduled_delivery");
const controller = new AbortController(),
  signal = controller.signal;
const interrupt = () => controller.abort(new Error("Controlled OpenClaw delivery interrupted."));
const deadline = setTimeout(
  () => controller.abort(new Error("Controlled delivery deadline reached.")),
  profile.maxTaskMs,
);
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const budget = new ComparisonDispatchBudget({
  maxRequests: 15,
  maxCostUsd: 2,
  persist: (event) => retain("budget", event),
});
let activeScheduleId;
let modelRequests = 0,
  scheduleJob,
  issued = false,
  client,
  gateway,
  GatewayClient,
  failure,
  result,
  restartCount = 0;
const providerReceipts = [],
  wireRequests = [],
  children = [];
const telegramToken = `123456789:${randomBytes(24).toString("base64url")}`,
  gatewayToken = randomBytes(32).toString("hex");
const authorization = { accountId: "default", target: "-123456", scheduledFor: "" };
const telegram = createServer(async (request, response) => {
  try {
    assert.ok(["GET", "POST"].includes(request.method));
    const endpoint = new URL(request.url, "http://127.0.0.1");
    assert.ok(endpoint.pathname.startsWith(`/bot${telegramToken}/`));
    const method = endpoint.pathname.slice(`/bot${telegramToken}/`.length);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 64 * 1024);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const body = request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(text || "{}")
      : Object.fromEntries(new URLSearchParams(request.method === "GET" ? endpoint.search : text));
    wireRequests.push({ method, body });
    assert.ok(wireRequests.length <= 100);
    await retain("telegram-wire", { fixtureOnly: true, method, body });
    let value;
    if (method === "getMe")
      value = { id: 123456789, is_bot: true, first_name: "Comparison", username: "comparison_fixture_bot" };
    else if (method === "getChat") {
      assert.equal(String(body.chat_id), authorization.target);
      value = { id: Number(authorization.target), type: "supergroup", title: "Controlled comparison" };
    } else if (method === "sendMessage") {
      assert.equal(request.method, "POST");
      assert.equal(String(body.chat_id), authorization.target);
      assert.equal(body.text, "HARBOR PILOT CHECK");
      const providerMessageId = String(8300 + providerReceipts.length);
      const nativeDispatch = await readOpenclawComparisonDeliveryDispatch(stateDirectory, activeScheduleId);
      providerReceipts.push({
        fixtureOnly: true,
        providerMessageId,
        accountId: authorization.accountId,
        destination: `telegram:${authorization.target}`,
        message: body.text,
        nativeDispatch,
        acknowledgedAt: new Date().toISOString(),
      });
      await retain("telegram-ack", providerReceipts.at(-1));
      value = {
        message_id: Number(providerMessageId),
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(authorization.target), type: "supergroup" },
        text: body.text,
      };
    } else if (["deleteWebhook", "setMyCommands", "deleteMyCommands"].includes(method)) value = true;
    else if (method === "getWebhookInfo") value = { url: "", has_custom_certificate: false, pending_update_count: 0 };
    else if (method === "getUpdates") {
      await delay(5000);
      value = [];
    } else throw new Error(`Unexpected controlled Telegram method: ${method}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: value }));
  } catch (error) {
    failure ??= error;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, error_code: 400, description: "Controlled fixture refused the request." }),
    );
    controller.abort(error);
  }
});
let proxy, reservation;
const redact = (value) =>
  String(value)
    .replaceAll(telegramToken, "[controlled telegram token]")
    .replaceAll(gatewayToken, "[controlled gateway token]")
    .replaceAll(proxy?.apiKey ?? "never-a-token", "[controlled proxy token]");
try {
  await new Promise((resolve, reject) => {
    telegram.once("error", reject);
    telegram.listen(0, "127.0.0.1", resolve);
  });
  proxy = await createComparisonProviderProxy({
    budget,
    cellId: "openclaw:scheduled_delivery:1",
    profile: {
      ...profile,
      outputField: "max_completion_tokens",
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        requestUsd: 0,
        observedAt: "2026-09-12T00:00:00.000Z",
        sourceSha256: sha256("synthetic OpenClaw delivery prices"),
      },
    },
    upstreamUrl: "https://provider.invalid/v1/chat/completions",
    upstreamApiKey: "controlled-no-live-provider",
    persistReceipt: (receipt) => retain("provider-receipt", receipt),
    fetchUpstream: async (_url, init) => {
      const body = JSON.parse(init.body),
        user = JSON.stringify(body.messages?.findLast((item) => item.role === "user")?.content ?? "");
      const create = user.includes("COMPARISON_NATIVE_REMINDER_CREATE");
      await retain("model-request", {
        model: body.model,
        tools: body.tools?.map((item) => item.function?.name),
        create,
      });
      let tool;
      if (create && !issued) {
        if (!body.tools?.some((item) => item.function?.name === "automations")) {
          const error = new Error("The native model must receive the pinned automations tool.");
          controller.abort(error);
          throw error;
        }
        issued = true;
        tool = {
          id: "comparison_schedule_create",
          type: "function",
          function: { name: "automations", arguments: JSON.stringify({ action: "add", job: scheduleJob }) },
        };
      }
      const message = tool
        ? { role: "assistant", content: null, tool_calls: [tool] }
        : { role: "assistant", content: create ? "The reminder is scheduled." : "HARBOR PILOT CHECK" };
      await retain("model-call", {
        model: body.model,
        tools: body.tools?.map((entry) => entry.function?.name),
        message,
        toolResults: body.messages?.filter((entry) => entry.role === "tool"),
      });
      const base = {
        id: `controlled-openclaw-delivery-${++modelRequests}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: profile.model,
      };
      const usage = { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
        finish_reason = tool ? "tool_calls" : "stop";
      if (!body.stream)
        return new Response(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason }], usage }), {
          headers: { "content-type": "application/json" },
        });
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, ...tool }] } : message;
      return new Response(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  reservation = createReservation();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port,
    configFile = path.join(stateDirectory, "openclaw.json");
  const config = {
    models: {
      mode: "replace",
      catalogRefresh: { enabled: false },
      providers: {
        comparison: {
          baseUrl: proxy.baseUrl,
          apiKey: proxy.apiKey,
          api: "openai-completions",
          auth: "api-key",
          models: [
            {
              id: profile.model,
              name: profile.model,
              reasoning: false,
              input: ["text"],
              contextWindow: profile.contextTokens,
              maxTokens: profile.outputTokens,
              compat: { maxTokensField: "max_completion_tokens" },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        skills: [],
        model: { primary: `comparison/${profile.model}`, fallbacks: [] },
        modelPolicy: { allow: [`comparison/${profile.model}`] },
        models: { [`comparison/${profile.model}`]: { params: { maxTokens: profile.outputTokens } } },
        thinkingDefault: "off",
        heartbeat: { every: "0m" },
      },
    },
    tools: { allow: ["automations"], fs: { workspaceOnly: true }, exec: { mode: "ask", safeBins: [] } },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
      reload: { mode: "off" },
    },
    cron: { enabled: true },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    plugins: {
      enabled: true,
      allow: ["telegram"],
      slots: { memory: "none" },
      entries: { telegram: { enabled: true }, "memory-core": { enabled: false } },
    },
    skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
    channels: {
      telegram: {
        enabled: true,
        botToken: telegramToken,
        apiRoot: `http://127.0.0.1:${telegram.address().port}`,
        network: { dangerouslyAllowPrivateNetwork: true },
        dmPolicy: "disabled",
        groupPolicy: "disabled",
        streaming: { mode: "off" },
      },
    },
  };
  await write(configFile, config);
  const environment = {
    ...nativeComparisonEnvironment({
      product: "openclaw",
      homeDirectory,
      stateDirectory,
      executablePath,
      checkoutRoot,
      proxyKey: proxy.apiKey,
    }),
    OPENCLAW_CONFIG_PATH: configFile,
    OPENCLAW_DISABLE_BONJOUR: "1",
  };
  // This command is itself an isolated child. Set its fresh home before the
  // public SDK import can open device identity; never select personal state.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  ({ GatewayClient } = await import(pathToFileURL(path.join(checkoutRoot, "dist/plugin-sdk/gateway-runtime.js"))));
  const retainNativeLaunch = async (effectiveConfig) => {
    const binding = {
      executionId: randomUUID(),
      cellId: "openclaw:scheduled_delivery:1",
      revision: checkout.revision,
      manifestSha256: sha256({ profile, fixtureOnly: true, checkout }),
      effectiveConfigSha256: sha256(effectiveConfig),
      fixtureSha256: sha256(task),
    };
    await write(path.join(evidence, "session-start.json"), {
      ...binding,
      product: "openclaw",
      taskId: task.id,
      source: "controlled_fixture",
      profile,
    });
    const launch = {
      ...binding,
      fixtureOnly: true,
      checkout,
      config: JSON.parse(redact(JSON.stringify(effectiveConfig))),
      configurationSha256: sha256(effectiveConfig),
      declaredConfigurationSha256: sha256(config),
      executableSha256: sha256(await readFile(executablePath)),
      entrySha256: sha256(await readFile(path.join(checkoutRoot, "openclaw.mjs"))),
      clientSha256: sha256(await readFile(path.join(checkoutRoot, "dist/plugin-sdk/gateway-runtime.js"))),
      channelStartup: "native Telegram polling against an owned loopback fixture",
      policyLimit:
        "Explicit fixture schedule review authorizes one destination; OpenClaw does not add a per-send approval here.",
    };
    await write(path.join(evidence, "native-launch.json"), launch);
    await write(path.join(evidence, PERMISSION_REVIEW_FILE), {
      schemaVersion: PERMISSION_REVIEW_VERSION,
      ...binding,
      policy: { files: "disabled", terminal: "disabled", skills: "disabled", schedule: "authorized_destination" },
      reviewedBy: "controlled_local_fixture_not_live_campaign_review",
      reviewedAt: new Date().toISOString(),
      sourceReceipts: [
        { path: "native-launch.json", sha256: sha256(await readFile(path.join(evidence, "native-launch.json"))) },
      ],
    });
  };
  await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  reservation = undefined;
  const startGateway = async () => {
    signal.throwIfAborted();
    const child = superviseNativeComparisonProcess({
      executablePath,
      args: [path.join(checkoutRoot, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
      cwd: workspace,
      environment,
      signal,
    });
    children.push(child);
    let terminal = false;
    void child.finished.then(() => {
      terminal = true;
    });
    const readySignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    // Let the product finish state/bootstrap work before a device-auth client
    // opens that same fresh state. A live process alone is not readiness.
    let httpReady = false;
    while (!httpReady) {
      readySignal.throwIfAborted();
      assert.equal(terminal, false, "Native Gateway stopped before HTTP readiness.");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.any([readySignal, AbortSignal.timeout(1000)]),
          redirect: "error",
        });
        await response.body?.cancel();
        httpReady = response.ok;
      } catch (error) {
        if (readySignal.aborted) throw error;
      }
      if (!httpReady) await delay(250, undefined, { signal: readySignal });
    }
    let connectedReady = false;
    while (!connectedReady) {
      readySignal.throwIfAborted();
      assert.equal(terminal, false, "Native Gateway stopped before readiness.");
      let connectError;
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: gatewayToken,
        clientName: "cli",
        clientDisplayName: "Controlled scheduled delivery comparison",
        mode: "cli",
        scopes: ["operator.admin"],
        onHelloOk: (hello) => {
          if (hello.auth?.scopes?.includes("operator.admin")) connectedReady = true;
          else connectError = new Error("Native comparison client lacks operator scope.");
        },
        onConnectError: (error) => {
          connectError = error;
        },
        onClose: (_code, reason) => {
          connectError ??= new Error(`Native connection closed: ${reason}`);
        },
      });
      client.start();
      while (!connectedReady && !connectError) {
        readySignal.throwIfAborted();
        assert.equal(terminal, false, "Native Gateway stopped before readiness.");
        await delay(100, undefined, { signal: readySignal });
      }
      if (!connectedReady) {
        await retain("connect-error", { message: redact(connectError.message) });
        await client.stopAndWait();
        client = undefined;
        if (!/ECONNREFUSED|socket|startup|1006/iu.test(connectError.message))
          throw new Error(redact(connectError.message));
        await delay(250, undefined, { signal: readySignal });
      }
    }
    await retain("gateway-ready", { pid: child.pid, restart: restartCount });
    return child;
  };
  const request = async (method, params, active = signal, expectFinal = false) => {
    active.throwIfAborted();
    const response = await client.request(method, params, {
      signal: active,
      timeoutMs: expectFinal ? 90000 : 15000,
      expectFinal,
    });
    const text = redact(JSON.stringify(response));
    assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
    return JSON.parse(text);
  };
  gateway = await startGateway();
  const effectiveConfig = JSON.parse(await readFile(configFile, "utf8"));
  await retain("effective-config", JSON.parse(redact(JSON.stringify(effectiveConfig))));
  for (const key of ["models", "tools", "gateway", "channels", "plugins", "agents"])
    assert.equal(
      sha256(effectiveConfig[key]),
      sha256(config[key]),
      `Native startup changed the reviewed ${key} configuration.`,
    );
  await retainNativeLaunch(effectiveConfig);
  const initialInventory = await request("cron.list", { includeDisabled: true, limit: 200 });
  assert.equal(initialInventory.hasMore, false);
  assert.equal(initialInventory.total, initialInventory.jobs.length);
  assert.ok(initialInventory.jobs.every((job) => job.enabled === false && !job.state?.runningAtMs));
  await retain("initial-schedule-inventory", initialInventory);
  authorization.scheduledFor = new Date(Date.now() + 60000).toISOString();
  scheduleJob = {
    name: `comparison-reminder-${randomUUID().slice(0, 8)}`,
    enabled: true,
    deleteAfterRun: false,
    sessionTarget: "isolated",
    wakeMode: "now",
    schedule: { kind: "at", at: authorization.scheduledFor },
    payload: {
      kind: "agentTurn",
      message: "HARBOR PILOT CHECK",
      model: `comparison/${profile.model}`,
      thinking: "off",
      toolsAllow: [],
    },
    delivery: {
      mode: "announce",
      channel: "telegram",
      accountId: authorization.accountId,
      to: authorization.target,
      bestEffort: false,
    },
  };
  await retain("schedule-review", {
    fixtureOnly: true,
    authorization,
    scheduleJob,
    action: "The controlled operator requests exactly this native schedule.",
  });
  const turn = await request(
    "agent",
    {
      message: "COMPARISON_NATIVE_REMINDER_CREATE: Schedule the reviewed one-shot reminder using the cron tool.",
      agentId: "main",
      sessionKey: `agent:main:comparison-delivery-${randomUUID()}`,
      model: `comparison/${profile.model}`,
      thinking: "off",
      deliver: false,
      timeout: 90,
      idempotencyKey: randomUUID(),
    },
    signal,
    true,
  );
  await retain("schedule-turn", turn);
  const inventory = await request("cron.list", { includeDisabled: true, limit: 200 });
  await retain("schedule-inventory", inventory);
  assert.equal(inventory.hasMore, false);
  assert.equal(inventory.total, inventory.jobs.length);
  assert.equal(
    inventory.jobs.length,
    initialInventory.jobs.length + 1,
    "The model must create exactly one native schedule.",
  );
  const added = inventory.jobs.filter((job) => !initialInventory.jobs.some((before) => before.id === job.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].name, scheduleJob.name);
  const scheduleId = added[0].id;
  activeScheduleId = scheduleId;
  result = await observeOpenclawComparisonDelivery({
    cellDirectory,
    scheduleId,
    authorization,
    request,
    readQueue: () => readOpenclawComparisonDeliveryQueue(stateDirectory),
    readProviderReceipts: async () => structuredClone(providerReceipts),
    signal,
    onReconnect: async () => {
      const before = gateway.pid;
      await client.stopAndWait();
      client = undefined;
      await gateway.stop("controlled_restart");
      const stopped = await gateway.finished;
      assert.equal(stopped.cleanupUnconfirmed, false);
      await retain("gateway-stopped", { ...stopped, stdout: redact(stopped.stdout), stderr: redact(stopped.stderr) });
      restartCount++;
      gateway = await startGateway();
      assert.equal(
        sha256(JSON.parse(await readFile(configFile, "utf8"))),
        sha256(effectiveConfig),
        "Native configuration changed across restart.",
      );
      return {
        kind: "owned_process_restart",
        beforeInstanceId: `pid-${before}`,
        afterInstanceId: `pid-${gateway.pid}`,
      };
    },
  });
  const verification = await verifyComparisonEvidence({
    taskId: task.id,
    workspaceRoot: workspace,
    evidenceRoot: evidence,
  });
  assert.equal(verification.outcome, "passed");
  assert.equal(verification.evidenceKind, "controlled");
  assert.equal(providerReceipts.length, 1);
  await write(path.join(root, "result.json"), {
    fixtureOnly: true,
    modelRequests,
    upstreamRequests: 0,
    externalChannelRequests: 0,
    providerReceipts,
    result,
    verification,
  });
  process.stdout.write(
    JSON.stringify({
      root,
      outcome: verification.outcome,
      checks: verification.checks,
      modelRequests,
      upstreamRequests: 0,
    }) + "\n",
  );
} catch (error) {
  failure ??= error;
  await write(path.join(root, "failure.json"), {
    fixtureOnly: true,
    message: redact(failure.message).slice(-2000),
    stack: redact(failure.stack).slice(-10000),
    modelRequests,
    providerReceipts,
  });
  process.stderr.write(`${redact(failure.stack).slice(-10000)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await client?.stopAndWait();
  for (const child of children) {
    await child.stop("supervisor_close");
    const settled = await child.finished;
    await retain("process-terminal", {
      pid: child.pid,
      ...settled,
      stdout: redact(settled.stdout),
      stderr: redact(settled.stderr),
    });
    if (settled.cleanupUnconfirmed) process.exitCode = 1;
  }
  await proxy?.close();
  if (reservation?.listening) await new Promise((resolve) => reservation.close(resolve));
  telegram.closeAllConnections();
  if (telegram.listening) await new Promise((resolve) => telegram.close(resolve));
  if (failure) process.exitCode = 1;
}

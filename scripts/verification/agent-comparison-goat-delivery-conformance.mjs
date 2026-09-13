import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { goatComparisonConfig } from "./lib/agent-comparison-goat-profile.mjs";
import {
  nativeComparisonEnvironment,
  readNativeComparisonGit,
  initializeNativeComparisonWorkspace,
} from "./lib/agent-comparison-native-driver.mjs";
import { createComparisonProviderProxy } from "./lib/agent-comparison-provider.mjs";
import { ComparisonDispatchBudget, COMPARISON_TASKS, sha256 } from "./lib/agent-comparison.mjs";
import { createGoatComparisonClient } from "./lib/agent-comparison-goat-client.mjs";
import { executeGoatComparisonTurn } from "./lib/agent-comparison-goat-api.mjs";
import { observeGoatComparisonDelivery } from "./lib/agent-comparison-goat-delivery.mjs";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./lib/agent-comparison-permissions.mjs";

// This command owns a fresh runtime and synthetic transports. It never accepts
// real channel/provider credentials or attaches to an operator's existing app.
const [checkoutRoot, root] = process.argv.slice(2);
if (process.argv.length !== 4 || ![checkoutRoot, root].every((value) => value && path.isAbsolute(value)))
  throw new Error(
    "Usage: node agent-comparison-goat-delivery-conformance.mjs ABSOLUTE_CHECKOUT NEW_ABSOLUTE_DIRECTORY",
  );
await mkdir(root);
const cellDirectory = path.join(root, "cell"),
  workspace = path.join(cellDirectory, "workspace"),
  evidence = path.join(cellDirectory, "evidence"),
  homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(homeDirectory, "state"),
  raw = path.join(root, "native");
for (const directory of [
  workspace,
  evidence,
  path.join(stateDirectory, "config"),
  path.join(homeDirectory, "tmp"),
  raw,
])
  await mkdir(directory, { recursive: true });
const write = async (filename, value) => {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
};
let sequence = 0;
const retain = (name, value) => write(path.join(raw, `${String(++sequence).padStart(4, "0")}-${name}.json`), value);
const profile = {
  provider: "comparison",
  model: "fixture-model",
  reasoning: "medium",
  contextTokens: 32000,
  outputTokens: 2048,
  maxTaskMs: 300000,
  tools: ["schedule"],
  grants: ["test-workspace", "controlled-telegram-target"],
};
const task = COMPARISON_TASKS.find((entry) => entry.id === "scheduled_delivery");
const appSha256 = sha256(await readFile(path.join(checkoutRoot, "apps/gateway/dist/app.js")));
const binding = {
  executionId: randomUUID(),
  cellId: "goatcitadel:scheduled_delivery:1",
  revision: "working-build-not-clean-pinned",
  manifestSha256: sha256({ profile, appSha256, fixtureOnly: true }),
  effectiveConfigSha256: sha256(profile),
  fixtureSha256: sha256(task),
};
const controller = new AbortController(),
  interrupt = () => controller.abort(new Error("Controlled delivery run interrupted."));
const deadline = setTimeout(
  () => controller.abort(new Error("Controlled delivery deadline reached.")),
  profile.maxTaskMs,
);
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const budget = new ComparisonDispatchBudget({
  maxRequests: 30,
  maxCostUsd: 2,
  persist: (event) => retain("budget", event),
});
let scheduleArgs,
  issued = false,
  modelRequests = 0;
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
      observedAt: "2026-09-12T00:00:00.000Z",
      sourceSha256: sha256("synthetic scheduled-delivery fixture prices"),
    },
  },
  upstreamUrl: "https://provider.invalid/v1/chat/completions",
  upstreamApiKey: "controlled-no-live-provider",
  persistReceipt: (receipt) => retain("provider-receipt", receipt),
  fetchUpstream: async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = JSON.stringify(body.messages?.findLast((message) => message.role === "user")?.content ?? "");
    const tool = body.tools?.find((item) => ["schedule.manage", "schedule_manage"].includes(item.function?.name));
    let message = {
      role: "assistant",
      content: user.includes("COMPARISON_NATIVE_REMINDER_CREATE") ? "The reminder is scheduled." : "HARBOR PILOT CHECK",
    };
    let finishReason = "stop";
    if (user.includes("COMPARISON_NATIVE_REMINDER_CREATE") && !issued) {
      assert.ok(tool, "The actual native Chat must offer schedule.manage.");
      issued = true;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "comparison_reminder_create",
            type: "function",
            function: { name: tool.function.name, arguments: JSON.stringify(scheduleArgs) },
          },
        ],
      };
      finishReason = "tool_calls";
    }
    await retain("model-call", {
      model: body.model,
      tools: body.tools?.map((item) => item.function?.name),
      message,
      toolResults: body.messages?.filter((item) => item.role === "tool"),
    });
    return new Response(
      JSON.stringify({
        id: `controlled-reminder-${++modelRequests}`,
        object: "chat.completion",
        model: profile.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 150, completion_tokens: 80, total_tokens: 230 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});
const git = await readNativeComparisonGit();
const environment = nativeComparisonEnvironment({
  product: "goatcitadel",
  homeDirectory,
  stateDirectory,
  executablePath: process.execPath,
  checkoutRoot,
  proxyKey: proxy.apiKey,
  toolGitPath: git.executablePath,
});
await write(
  path.join(root, "workspace-git.json"),
  await initializeNativeComparisonWorkspace({
    workspace,
    homeDirectory,
    gitExecutablePath: git.executablePath,
    environment,
    signal: controller.signal,
  }),
);
const { config } = goatComparisonConfig(profile, { workspace, baseUrl: proxy.baseUrl });
config.assistant.features.autonomyV1Disabled = false;
config.toolPolicy.profiles.comparison = ["schedule.manage", "comms.send"];
config.toolPolicy.sandbox.networkAllowlist = ["127.0.0.1", "api.telegram.org"];
await write(path.join(stateDirectory, "config/goatcitadel.json"), config);
await write(path.join(stateDirectory, ".env"), "");
await write(path.join(evidence, "session-start.json"), {
  ...binding,
  source: "controlled_fixture",
  product: "goatcitadel",
  taskId: task.id,
  profile,
});
const launch = {
  ...binding,
  fixtureOnly: true,
  appSha256,
  nativeConfigSha256: sha256(config),
  boundary:
    "Actual working Gateway with synthetic model and Telegram transports. Native creation and delivery approvals remain required.",
};
await write(path.join(evidence, "native-launch.json"), launch);
await write(path.join(evidence, PERMISSION_REVIEW_FILE), {
  schemaVersion: PERMISSION_REVIEW_VERSION,
  ...binding,
  policy: { files: "disabled", terminal: "disabled", skills: "disabled", schedule: "per_send_approval" },
  reviewedBy: "controlled local conformance fixture",
  reviewedAt: new Date().toISOString(),
  sourceReceipts: [{ path: "native-launch.json", sha256: sha256(JSON.stringify(launch, null, 2) + "\n") }],
});

// Sanitize this task-owned process before loading the built product. No personal
// config, keychain values or provider environment can enter the fresh runtime.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
process.chdir(workspace);
const { buildApp } = await import(pathToFileURL(path.join(checkoutRoot, "apps/gateway/dist/app.js")));
const originalFetch = globalThis.fetch;
const gatewayPorts = new Set();
const providerReceipts = [];
const target = "-123456";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "127.0.0.1" && (url.port === new URL(proxy.baseUrl).port || gatewayPorts.has(url.port)))
    return originalFetch(input, init);
  if (url.href === "https://api.telegram.org/botcontrolled-no-live-telegram/sendMessage" && init?.method === "POST") {
    const body = JSON.parse(init.body);
    assert.equal(String(body.chat_id), target);
    assert.equal(body.text, "HARBOR PILOT CHECK");
    const receipt = {
      fixtureOnly: true,
      providerMessageId: String(7300 + providerReceipts.length),
      destination: `telegram:${target}`,
      message: body.text,
      acknowledgedAt: new Date().toISOString(),
    };
    providerReceipts.push(receipt);
    await retain("telegram-transport", receipt);
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: Number(receipt.providerMessageId), chat: { id: Number(target) }, text: body.text },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`Unexpected network destination in the controlled fixture: ${url.origin}`);
};
let app, baseUrl, token;
const startApp = async () => {
  token = randomBytes(32).toString("base64url");
  process.env.GOATCITADEL_AUTH_TOKEN = token;
  app = await buildApp();
  baseUrl = `${await app.listen({ host: "127.0.0.1", port: 0 })}/`;
  gatewayPorts.add(new URL(baseUrl).port);
  await retain("runtime-started", { baseUrl, processId: process.pid, observedAt: new Date().toISOString() });
};
const approveSchedule = async (control) => {
  let stopped = false,
    failure;
  const loop = (async () => {
    while (!stopped && !control.signal.aborted) {
      for (const approval of (await control.pending()).approvals) {
        await retain("schedule-approval", approval);
        assert.equal(approval.request.kind, "schedule.manage");
        assert.deepEqual(approval.request.payload, scheduleArgs, "Approve only this exact controlled schedule.");
        await control.resolve({ approvalId: approval.id, decision: "allow-once" });
      }
      await delay(200, undefined, { signal: control.signal });
    }
  })().catch((error) => {
    if (!control.signal.aborted) {
      failure = error;
      controller.abort(error);
    }
  });
  return {
    stop: async () => {
      stopped = true;
      await loop;
      if (failure) throw failure;
    },
  };
};
let deliverySupervision;
const superviseDelivery = (api, scheduleId, connectionId) => {
  const stop = new AbortController();
  const signal = AbortSignal.any([controller.signal, stop.signal]);
  const resolved = new Set();
  const nativeId = (value) => {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/u);
    return encodeURIComponent(value);
  };
  const loop = (async () => {
    while (!signal.aborted) {
      const page = await api("delivery-pending", "/approvals?status=pending&limit=200&workspaceId=default");
      assert.ok(Array.isArray(page.items) && page.items.length < 200 && !page.nextCursor);
      for (const approval of page.items.filter((item) => item.kind === "channel.send")) {
        if (resolved.has(approval.approvalId)) continue;
        const job = await api("delivery-job", `/cron/jobs/${nativeId(scheduleId)}`);
        const run = await api("delivery-occurrence", `/cron/runs/${nativeId(job.activeRunId ?? job.lastRunId)}`);
        const occurrence = run.canonical;
        assert.ok(occurrence && occurrence.jobId === scheduleId && occurrence.trigger === "scheduled_due");
        assert.equal(occurrence.jobRevision, job.revision);
        const chat = await api("delivery-chat", `/durable/runs/${nativeId(occurrence.childDurableRunId)}`);
        assert.equal(chat.status, "completed");
        assert.equal(chat.metadata?.cronRunId, occurrence.runId);
        const deliveryId = chat.metadata?.autonomousChatPostCommit?.delivery?.runId;
        const delivery = await api("delivery-owner", `/durable/runs/${nativeId(deliveryId)}`);
        assert.equal(delivery.workflowKey, "connector.delivery");
        assert.equal(delivery.payload?.runId, chat.runId);
        assert.equal(delivery.payload.sessionId, occurrence.childSessionId);
        assert.equal(delivery.payload.connectorId, `integration:${connectionId}`);
        assert.equal(delivery.payload.action, "channel.send");
        assert.deepEqual(delivery.payload.payload, { target, message: "HARBOR PILOT CHECK" });
        // Queue admission may still be finishing when its per-send approval first
        // appears. Wait until the native checkpoint fixes this effect's identity.
        if (delivery.status !== "completed") continue;
        const checkpoints = await api(
          "delivery-approval-checkpoints",
          `/durable/runs/${nativeId(deliveryId)}/checkpoints?limit=200`,
        );
        assert.ok(Array.isArray(checkpoints.items) && checkpoints.items.length < 200);
        const completions = checkpoints.items.filter((item) => item.checkpointKind === "run_completed");
        assert.equal(completions.length, 1);
        assert.match(completions[0].state.sideEffectRunId, /^extfx_[a-f0-9]+$/u);
        const effectId = `connector-delivery:${deliveryId}`;
        const replay = await api("delivery-approval-replay", `/approvals/${nativeId(approval.approvalId)}/replay`);
        const current = replay.approval;
        assert.equal(current.approvalId, approval.approvalId);
        assert.equal(current.status, "pending");
        assert.equal(current.kind, "channel.send");
        assert.deepEqual(current.payload, { connectionId, target, message: "HARBOR PILOT CHECK", effectId });
        assert.equal(current.linkage?.workspaceId, "default");
        assert.equal(current.linkage.sessionId, occurrence.childSessionId);
        assert.equal(current.linkage.runId, chat.runId);
        assert.equal(replay.durableRunId, current.linkage.durableRunId);
        const wait = await api("delivery-approval-wait", `/durable/runs/${nativeId(replay.durableRunId)}`);
        assert.equal(wait.workflowKey, "approval.wait");
        assert.equal(wait.payload?.approvalId, current.approvalId);
        assert.equal(wait.metadata?.approvalId, current.approvalId);
        if (wait.status !== "waiting") continue;
        assert.equal(wait.metadata.waitForEvent?.eventKey, "approval.resolved");
        assert.equal(wait.metadata.waitForEvent.correlationId, current.approvalId);
        signal.throwIfAborted();
        await retain("delivery-approval-intent", { approval: current, occurrence, effectId, decision: "approve" });
        resolved.add(current.approvalId);
        await api("delivery-approval-result", `/approvals/${nativeId(current.approvalId)}/resolve`, {
          decision: "approve",
        });
      }
      await delay(1000, undefined, { signal });
    }
  })().catch((error) => {
    if (!signal.aborted) controller.abort(error);
  });
  return {
    stop: async () => {
      stop.abort();
      await loop;
    },
  };
};
try {
  await startApp();
  const api = createGoatComparisonClient({ baseUrl, token, retain, signal: controller.signal });
  const connection = await api("telegram-connection", "/integrations/connections", {
    catalogId: "channel.telegram",
    label: "Controlled comparison Telegram",
    enabled: true,
    status: "connected",
    config: { botToken: "controlled-no-live-telegram", defaultChatId: target },
  });
  const scheduledFor = new Date(Math.ceil((Date.now() + 90000) / 60000) * 60000);
  scheduleArgs = {
    op: "create",
    name: "Comparison reminder",
    schedule: `${scheduledFor.getUTCMinutes()} ${scheduledFor.getUTCHours()} * * * UTC`,
    prompt: "Reply with exactly HARBOR PILOT CHECK and nothing else.",
    endAt: new Date(scheduledFor.getTime() + 60000).toISOString(),
    deliveryChannel: { channelKey: "telegram", target },
  };
  const turn = await executeGoatComparisonTurn({
    baseUrl,
    token,
    workspace,
    profile: { model: profile.model, thinkingLevel: "standard" },
    prompt: `COMPARISON_NATIVE_REMINDER_CREATE: Use schedule.manage to create exactly this one bounded test reminder: ${JSON.stringify(scheduleArgs)}.`,
    retain,
    signal: controller.signal,
    onApprovalReady: approveSchedule,
  });
  await retain("source-turn", turn);
  const jobs = (await api("schedules", "/cron/jobs")).items.filter((job) => job.action === "agent_turn");
  assert.equal(jobs.length, 1);
  console.log(`Native reminder retained: ${jobs[0].jobId}; scheduled ${scheduledFor.toISOString()}`);
  deliverySupervision = superviseDelivery(api, jobs[0].jobId, connection.connectionId);
  const observed = await observeGoatComparisonDelivery({
    cellDirectory,
    baseUrl,
    token,
    scheduleId: jobs[0].jobId,
    authorization: {
      channelKey: "telegram",
      connectionId: connection.connectionId,
      target,
      scheduledFor: scheduledFor.toISOString(),
    },
    signal: controller.signal,
    maxTaskMs: profile.maxTaskMs,
    onReconnect: async () => {
      await deliverySupervision.stop();
      await app.close();
      assert.equal(app.server.listening, false);
      await retain("runtime-closed", {
        baseUrl,
        processId: process.pid,
        listening: false,
        observedAt: new Date().toISOString(),
      });
      await startApp();
      return {
        kind: "owned_runtime_restart",
        baseUrl,
        token,
        detail:
          "Closed the task-owned Fastify runtime and reopened the same persisted SQLite/config state in a new runtime instance; the supervisor process was retained.",
      };
    },
  });
  assert.equal(providerReceipts.length, 1);
  assert.equal(observed.providerMessageId, providerReceipts[0].providerMessageId);
  const verification = await verifyComparisonEvidence({
    taskId: task.id,
    workspaceRoot: workspace,
    evidenceRoot: evidence,
  });
  assert.equal(verification.outcome, "passed");
  assert.equal(verification.evidenceKind, "controlled");
  await write(path.join(root, "result.json"), {
    fixtureOnly: true,
    appSha256,
    modelRequests,
    upstreamRequests: 0,
    externalChannelRequests: 0,
    providerReceipts,
    observed,
    verification,
  });
  console.log(
    JSON.stringify({
      root,
      modelRequests,
      upstreamRequests: 0,
      externalChannelRequests: 0,
      outcome: verification.outcome,
      checks: Object.keys(verification.checks).length,
    }),
  );
} catch (error) {
  await retain("failure", { message: error.message, stack: error.stack, modelRequests, providerReceipts });
  throw error;
} finally {
  controller.abort();
  clearTimeout(deadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  try {
    await deliverySupervision?.stop();
    await app?.close();
  } finally {
    globalThis.fetch = originalFetch;
    await proxy.close();
  }
}

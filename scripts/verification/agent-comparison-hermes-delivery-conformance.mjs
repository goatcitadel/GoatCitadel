import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComparisonDispatchBudget, COMPARISON_TASKS, sha256 } from "./lib/agent-comparison.mjs";
import { buildNativeComparisonProfile, NATIVE_COMPARISON_PINS } from "./lib/agent-comparison-native-profile.mjs";
import {
  nativeComparisonEnvironment,
  readNativeComparisonCheckout,
  superviseNativeComparisonProcess,
  writeNativeComparisonJson,
} from "./lib/agent-comparison-native-driver.mjs";
import { createComparisonProviderProxy } from "./lib/agent-comparison-provider.mjs";
import {
  readHermesComparisonDeliveryState,
  projectHermesComparisonSchedule,
  projectHermesComparisonDelivery,
} from "./lib/agent-comparison-hermes-delivery.mjs";
import { readHermesNativeTranscript } from "./lib/agent-comparison-hermes-transcript.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./lib/agent-comparison-permissions.mjs";
import { advanceComparisonWorkflow } from "./lib/agent-comparison-workflow.mjs";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";

// Native processes and synthetic transports only. This command never attaches
// to an existing Gateway or accepts real model/channel credentials.
const [checkoutRoot, executablePath, root] = process.argv.slice(2);
assert.ok(
  process.argv.length === 5 &&
    [checkoutRoot, executablePath, root].every((v) => typeof v === "string" && path.isAbsolute(v)),
  "Usage: node agent-comparison-hermes-delivery-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY",
);
const checkout = await readNativeComparisonCheckout(checkoutRoot);
assert.equal(checkout.clean, true);
assert.equal(checkout.revision, NATIVE_COMPARISON_PINS.hermes);
await mkdir(root);
const homeDirectory = path.join(root, "home"),
  stateDirectory = path.join(homeDirectory, "hermes"),
  workspace = path.join(root, "cell", "workspace"),
  evidence = path.join(root, "cell", "evidence"),
  raw = path.join(root, "native"),
  configFile = path.join(stateDirectory, "config.yaml");
for (const dir of [stateDirectory, workspace, evidence, raw, path.join(homeDirectory, "tmp")])
  await mkdir(dir, { recursive: true });
const write = writeNativeComparisonJson;
const execute = promisify(execFile);
let sequence = 0;
const retain = (name, value) => write(path.join(raw, `${String(++sequence).padStart(4, "0")}-${name}.json`), value);
const controller = new AbortController(),
  signal = controller.signal;
const deadline = setTimeout(() => controller.abort(new Error("Controlled Hermes delivery deadline reached.")), 300000);
const interrupt = () => controller.abort(new Error("Controlled Hermes delivery interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const children = [],
  providerReceipts = [],
  modelCalls = [],
  wireRequests = [];
let failure,
  gateway,
  proxy,
  schedule,
  issued = false,
  searched = false,
  described = false;
const token = `123456789:${randomBytes(24).toString("base64url")}`;
const authorization = { accountId: "default", target: "-123456", scheduledFor: "" };
const redact = (value) =>
  String(value)
    .replaceAll(token, "[controlled telegram token]")
    .replaceAll(proxy?.apiKey ?? "never-a-key", "[controlled proxy token]");
const telegram = createServer(async (request, response) => {
  try {
    const endpoint = new URL(request.url, "http://127.0.0.1");
    assert.equal(request.method, "POST");
    assert.ok(endpoint.pathname.startsWith(`/bot${token}/`));
    const method = endpoint.pathname.slice(`/bot${token}/`.length),
      chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 65536);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const body = request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(text || "{}")
      : Object.fromEntries(new URLSearchParams(text));
    wireRequests.push({ method, body });
    assert.ok(wireRequests.length <= 200);
    await retain("telegram-wire", { fixtureOnly: true, method, body });
    let result;
    if (method === "getMe")
      result = { id: 123456789, is_bot: true, first_name: "Comparison", username: "comparison_fixture_bot" };
    else if (method === "getChat") {
      assert.equal(String(body.chat_id), authorization.target);
      result = { id: Number(authorization.target), type: "supergroup", title: "Controlled comparison" };
    } else if (method === "sendMessage") {
      assert.equal(String(body.chat_id), authorization.target);
      assert.equal(body.text, "HARBOR PILOT CHECK");
      const nativeDispatch = await readHermesComparisonDeliveryState(stateDirectory);
      const receipt = {
        fixtureOnly: true,
        providerMessageId: String(9300 + providerReceipts.length),
        accountId: authorization.accountId,
        destination: `telegram:${authorization.target}`,
        message: body.text,
        nativeDispatch,
        acknowledgedAt: new Date().toISOString(),
      };
      providerReceipts.push(receipt);
      await retain("telegram-ack", receipt);
      result = {
        message_id: Number(receipt.providerMessageId),
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(authorization.target), type: "supergroup" },
        text: body.text,
      };
    } else if (method === "getUpdates") {
      await delay(1000);
      result = [];
    } else if (["deleteWebhook", "setMyCommands", "deleteMyCommands"].includes(method)) result = true;
    else if (method === "getWebhookInfo") result = { url: "", has_custom_certificate: false, pending_update_count: 0 };
    else throw new Error(`Unexpected controlled Telegram method: ${method}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    failure ??= error;
    controller.abort(error);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error_code: 400, description: "Controlled fixture refused request." }));
  }
});
try {
  await new Promise((resolve, reject) => {
    telegram.once("error", reject);
    telegram.listen(0, "127.0.0.1", resolve);
  });
  const profile = {
    revision: checkout.revision,
    provider: "comparison",
    model: "fixture-model",
    reasoning: "none",
    contextTokens: 64000,
    outputTokens: 2048,
    maxTaskMs: 300000,
    tools: ["files"],
    grants: ["test-workspace"],
  };
  proxy = await createComparisonProviderProxy({
    budget: new ComparisonDispatchBudget({
      maxRequests: 15,
      maxCostUsd: 2,
      persist: (event) => retain("budget", event),
    }),
    cellId: "hermes:scheduled_delivery:1",
    profile: {
      ...profile,
      outputField: "max_completion_tokens",
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        requestUsd: 0,
        observedAt: "2026-09-12T00:00:00.000Z",
        sourceSha256: sha256("synthetic Hermes delivery prices"),
      },
    },
    upstreamUrl: "https://provider.invalid/v1/chat/completions",
    upstreamApiKey: "controlled-no-live-provider",
    persistReceipt: (receipt) => retain("provider-receipt", receipt),
    fetchUpstream: async (_url, init) => {
      try {
        const body = JSON.parse(init.body),
          last = body.messages?.findLast((m) => m.role === "user"),
          create = JSON.stringify(last?.content).includes("COMPARISON_NATIVE_REMINDER_CREATE");
        const tools = body.tools?.map((t) => t.function?.name) ?? [];
        const system = body.messages?.find((m) => m.role === "system")?.content;
        const title = !tools.length && typeof system === "string" && system.startsWith("You name chat sessions.");
        await retain("model-request", {
          model: body.model,
          create,
          title,
          system: typeof system === "string" ? system.slice(0, 1000) : null,
          tools,
          stream: body.stream,
          results: body.messages?.filter((m) => m.role === "tool"),
        });
        let message, tool;
        if (title)
          message = { role: "assistant", content: JSON.stringify({ title: "Schedule controlled Telegram reminder" }) };
        else if (create && !issued) {
          if (tools.includes("cronjob_manage")) {
            issued = true;
            tool = { name: "cronjob_manage", arguments: schedule };
          } else if (tools.includes("tool_search") && !searched) {
            searched = true;
            tool = { name: "tool_search", arguments: { queries: ["create scheduled cron job"], limit: 3 } };
          } else if (tools.includes("tool_describe") && !described) {
            described = true;
            tool = { name: "tool_describe", arguments: { names: ["cronjob_manage"] } };
          } else if (tools.includes("tool_call") && described) {
            issued = true;
            tool = { name: "tool_call", arguments: { name: "cronjob_manage", arguments: schedule } };
          } else throw new Error("Native schedule tool is unavailable through its declared discovery path.");
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `schedule_${randomUUID().slice(0, 8)}`,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          };
        } else {
          if (!create) assert.equal(tools.length, 0, "The scheduled turn has unreviewed tools.");
          message = {
            role: "assistant",
            content: create ? "The reviewed reminder is scheduled." : "HARBOR PILOT CHECK",
          };
        }
        modelCalls.push({ create, title, tool, message });
        await retain("model-call", modelCalls.at(-1));
        const base = {
            id: `fixture-${modelCalls.length}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: profile.model,
          },
          usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
          finish_reason = message.tool_calls ? "tool_calls" : "stop";
        if (body.stream) {
          const delta = message.tool_calls
            ? { role: "assistant", tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
            : message;
          return new Response(
            `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            ...base,
            choices: [{ index: 0, message, finish_reason }],
            usage,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        failure ??= error;
        controller.abort(error);
        throw error;
      }
    },
  });
  const config = buildNativeComparisonProfile("hermes", profile).config;
  const replaceSlots = (v) =>
    typeof v === "string"
      ? v
          .replaceAll("__GOAT_COMPARISON_BASE_URL__", proxy.baseUrl)
          .replaceAll("__GOAT_COMPARISON_PROXY_KEY__", proxy.apiKey)
      : Array.isArray(v)
        ? v.map(replaceSlots)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, replaceSlots(value)]))
          : v;
  const effectiveConfig = replaceSlots(config);
  effectiveConfig.model.context_length = profile.contextTokens;
  Object.assign(effectiveConfig, {
    toolsets: ["cronjob"],
    platform_toolsets: { cli: ["cronjob"], cron: [], telegram: [] },
    cron: { wrap_response: false, allow_agent_scheduling: false, mirror_delivery: false },
    kanban: { dispatch_in_gateway: false },
    skills: {
      write_approval: true,
      ledger: true,
      external_dirs: [],
      project_discovery: false,
      inline_shell: false,
      template_vars: false,
    },
    curator: { enabled: false },
    memory: { memory_enabled: false, user_profile_enabled: false },
    gateway: {
      platforms: {
        telegram: {
          enabled: true,
          token,
          gateway_restart_notification: false,
          typing_indicator: false,
          extra: {
            base_url: `http://127.0.0.1:${telegram.address().port}/bot`,
            base_file_url: `http://127.0.0.1:${telegram.address().port}/file/bot`,
            mode: "classic",
            allowed_users: [],
          },
        },
      },
    },
  });
  await write(configFile, effectiveConfig);
  const configurationSha256 = sha256(effectiveConfig);
  const checkConfig = async () =>
    assert.equal(
      sha256(JSON.parse(await readFile(configFile, "utf8"))),
      configurationSha256,
      "The native Hermes configuration changed.",
    );
  const environment = {
    ...nativeComparisonEnvironment({
      product: "hermes",
      homeDirectory,
      stateDirectory,
      executablePath,
      checkoutRoot,
      proxyKey: proxy.apiKey,
    }),
    HERMES_GATEWAY_LOCK_DIR: path.join(stateDirectory, "gateway-locks"),
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USERS: "99999999",
    TZ: "UTC",
  };
  const launch = (args) => {
    signal.throwIfAborted();
    const child = superviseNativeComparisonProcess({
      executablePath,
      args,
      cwd: workspace,
      environment,
      signal,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    children.push(child);
    return child;
  };
  const run = async (args) => {
    const child = launch(args),
      settled = await child.finished;
    await retain("command-terminal", {
      args,
      ...settled,
      stdout: redact(settled.stdout),
      stderr: redact(settled.stderr),
    });
    assert.equal(settled.exitCode, 0);
    assert.equal(settled.cleanupUnconfirmed, false);
    return settled;
  };
  await run(["-m", "hermes_cli.main", "skills", "opt-out"]);
  await run([
    "-c",
    "import json; from tools.skills_sync import sync_skills; print(json.dumps(sync_skills(quiet=True)))",
  ]);
  const startGateway = async () => {
    await checkConfig();
    const child = launch(["-u", "-m", "gateway.run"]);
    let terminal;
    child.finished.then((value) => {
      terminal = value;
    });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      if (terminal) throw new Error(`Native Gateway exited before readiness: ${redact(terminal.stderr).slice(-3000)}`);
      try {
        const status = JSON.parse(await readFile(path.join(stateDirectory, "gateway_state.json"), "utf8"));
        if (
          Number.isSafeInteger(status.pid) &&
          status.pid > 0 &&
          status.code_sha === checkout.revision &&
          status.kind === "hermes-gateway" &&
          path.resolve(status.hermes_home ?? "") === stateDirectory &&
          status.gateway_state === "running" &&
          status.platforms?.telegram?.state === "connected"
        ) {
          // Windows venv python.exe is a launcher. Bind the native PID to the
          // live owned process tree instead of accepting a status-file PID.
          let ancestry = [{ pid: status.pid }];
          if (process.platform === "win32") {
            const command = `$candidate=${status.pid}; $owner=${child.pid}; $rows=@(); for($i=0; $i -lt 8 -and $candidate -gt 0; $i++){ $item=Get-CimInstance Win32_Process -Filter ('ProcessId='+$candidate); if(!$item){break}; $rows+=@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;startedAt=$item.CreationDate.ToUniversalTime().ToString('o');executable=$item.ExecutablePath}; if($candidate -eq $owner){break}; $candidate=[int]$item.ParentProcessId }; ConvertTo-Json -InputObject @($rows) -Compress`;
            const observed = await execute(
              path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
              ["-NoProfile", "-NonInteractive", "-Command", command],
              { windowsHide: true, timeout: 10000, maxBuffer: 16384 },
            );
            ancestry = JSON.parse(observed.stdout);
          }
          if (ancestry.at(-1)?.pid !== child.pid) {
            await delay(500, undefined, { signal });
            continue;
          }
          await retain("gateway-ready", { status, launcherPid: child.pid, ancestry });
          await checkConfig();
          return { ...child, nativePid: status.pid, identity: status, ancestry };
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(500, undefined, { signal });
    }
    throw new Error("Native Hermes Gateway did not become ready.");
  };
  gateway = await startGateway();
  await retain("effective-config", JSON.parse(redact(JSON.stringify(effectiveConfig))));
  const task = COMPARISON_TASKS.find((task) => task.id === "scheduled_delivery"),
    comparisonProfile = { ...profile, tools: ["schedule"], grants: ["controlled-telegram-target"] };
  const binding = {
    executionId: randomUUID(),
    cellId: "hermes:scheduled_delivery:1",
    revision: checkout.revision,
    manifestSha256: sha256({ fixtureOnly: true, profile: comparisonProfile, checkout }),
    effectiveConfigSha256: configurationSha256,
    fixtureSha256: sha256(task),
  };
  await write(path.join(evidence, "session-start.json"), {
    ...binding,
    product: "hermes",
    taskId: task.id,
    source: "controlled_fixture",
    profile: comparisonProfile,
  });
  const launchFile = path.join(evidence, "native-launch.json");
  await write(launchFile, {
    ...binding,
    fixtureOnly: true,
    checkout,
    config: JSON.parse(redact(JSON.stringify(effectiveConfig))),
    configurationSha256,
    executableSha256: sha256(await readFile(executablePath)),
    gatewaySourceSha256: sha256(await readFile(path.join(checkoutRoot, "gateway/run.py"))),
    observerSourceSha256: sha256(
      await readFile(new URL("./lib/agent-comparison-hermes-delivery.mjs", import.meta.url)),
    ),
    coordinatorSourceSha256: sha256(await readFile(new URL(import.meta.url))),
    gatewayIdentity: gateway.identity,
    ancestry: gateway.ancestry,
    policyLimit:
      "Native schedule creation authorizes one declared destination; no per-send approval or detached-worker queue is claimed.",
  });
  const sourceReceipts = [{ path: "native-launch.json", sha256: sha256(await readFile(launchFile)) }];
  await write(path.join(evidence, PERMISSION_REVIEW_FILE), {
    schemaVersion: PERMISSION_REVIEW_VERSION,
    ...binding,
    policy: { files: "disabled", terminal: "disabled", skills: "disabled", schedule: "authorized_destination" },
    sourceReceipts,
    reviewedBy: "controlled_local_fixture_not_live_campaign_review",
    reviewedAt: new Date().toISOString(),
  });
  const recordPhase = async (action, delivery, native) => {
    const filename = `native-hermes-delivery-${action}.json`;
    await write(path.join(evidence, filename), { ...binding, source: "controlled_fixture", ...native });
    await advanceComparisonWorkflow({
      cellDirectory: path.dirname(workspace),
      action,
      executionFile: "workflow-execution.json",
      receipt: {
        ...binding,
        source: "controlled_fixture",
        nativeReceipt: { path: filename, sha256: sha256(await readFile(path.join(evidence, filename))) },
        permissionReview: {
          path: PERMISSION_REVIEW_FILE,
          sha256: sha256(await readFile(path.join(evidence, PERMISSION_REVIEW_FILE))),
        },
        delivery,
      },
    });
  };
  const initial = await readHermesComparisonDeliveryState(stateDirectory);
  assert.equal(initial.jobs?.jobs?.length ?? 0, 0);
  assert.equal(initial.executions.executions?.length ?? 0, 0);
  assert.equal(initial.queue.status, "missing");
  await retain("initial-state", initial);
  authorization.scheduledFor = new Date(Date.now() + 60000).toISOString();
  schedule = {
    action: "create",
    name: `comparison-reminder-${randomUUID().slice(0, 8)}`,
    prompt: "HARBOR PILOT CHECK",
    schedule: authorization.scheduledFor,
    repeat: 1,
    deliver: `telegram:${authorization.target}`,
    enabled_toolsets: ["cronjob", "no_mcp"],
    attach_to_session: false,
  };
  await retain("schedule-review", { fixtureOnly: true, authorization, schedule });
  const prompt = path.join(workspace, "schedule-prompt.txt");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    prompt,
    "COMPARISON_NATIVE_REMINDER_CREATE: Create the reviewed one-shot reminder with the native schedule tool.\n",
  );
  const scheduleTurn = await run([
    "-m",
    "hermes_cli.main",
    "chat",
    "--provider",
    "comparison",
    "--model",
    profile.model,
    "--reasoning",
    "none",
    "--toolsets",
    "cronjob",
    "--max-turns",
    "10",
    "--run-budget",
    "90",
    "--query-file",
    prompt,
    "--quiet",
  ]);
  const created = await readHermesComparisonDeliveryState(stateDirectory);
  await retain("created-state", created);
  await checkConfig();
  const scheduled = projectHermesComparisonSchedule({ state: created, authorization, model: profile.model });
  assert.ok(Date.parse(authorization.scheduledFor) > Date.now(), "Observe the created schedule before it is due.");
  const delivery = {
    scheduleId: scheduled.scheduleId,
    scheduledFor: authorization.scheduledFor,
    authorizedDestination: `telegram:${authorization.target}`,
    schedulePersisted: true,
  };
  await recordPhase("schedule", delivery, {
    initial,
    created,
    authorization,
    gatewayIdentity: gateway.identity,
    scheduleTurn: { ...scheduleTurn, stdout: redact(scheduleTurn.stdout), stderr: redact(scheduleTurn.stderr) },
    modelCalls: structuredClone(modelCalls),
  });
  let completed, projected;
  const beforeIdentity = gateway.identity,
    observations = [];
  const observe = async () => {
    signal.throwIfAborted();
    assert.ok(observations.length < 300, "Native Hermes observation exceeded its bound.");
    const state = await readHermesComparisonDeliveryState(stateDirectory),
      receipts = structuredClone(providerReceipts);
    const record = { observedAt: new Date().toISOString(), state, receipts };
    observations.push(record);
    await retain("delivery-observation", record);
    return state;
  };
  for (;;) {
    signal.throwIfAborted();
    const state = await observe();
    assert.ok(providerReceipts.length <= 1, "Native delivery was duplicated.");
    if (providerReceipts.length && state.executions.executions?.some((e) => e.status === "completed")) {
      completed = state;
      projected = projectHermesComparisonDelivery({
        created,
        state,
        receipts: providerReceipts,
        authorization,
        model: profile.model,
        gatewayIdentity: beforeIdentity,
      });
      await retain("completed-state", completed);
      break;
    }
    if (state.executions.executions?.some((e) => ["failed", "unknown"].includes(e.status)))
      throw new Error("Native scheduled execution failed.");
    await delay(1000, undefined, { signal });
  }
  const before = gateway.nativePid;
  await gateway.stop("controlled_restart");
  assert.equal((await gateway.finished).cleanupUnconfirmed, false);
  const transcript = await readHermesNativeTranscript({ stateDirectory });
  const cronSessions = transcript.sessions.filter((session) => session.source === "cron");
  assert.equal(cronSessions.length, 1);
  assert.ok(cronSessions[0].id.startsWith(`cron_${scheduled.scheduleId}_`));
  assert.equal(cronSessions[0].model, profile.model);
  assert.equal(cronSessions[0].billing_provider, "custom");
  assert.equal(cronSessions[0].tool_call_count, 0);
  assert.equal(cronSessions[0].end_reason, "cron_complete");
  const cronReplies = transcript.messages.filter(
    (message) => message.session_id === cronSessions[0].id && message.role === "assistant",
  );
  assert.equal(cronReplies.length, 1);
  assert.equal(cronReplies[0].content, "HARBOR PILOT CHECK");
  gateway = await startGateway();
  assert.notEqual(gateway.nativePid, before);
  const reconnectedAt = new Date().toISOString(),
    start = performance.now();
  for (;;) {
    signal.throwIfAborted();
    assert.deepEqual(await observe(), completed);
    assert.equal(providerReceipts.length, 1);
    if (performance.now() - start >= 30000) break;
    await delay(1000, undefined, { signal });
  }
  const observedUntil = new Date().toISOString();
  await checkConfig();
  await recordPhase(
    "reconnect",
    {
      ...delivery,
      receipts: providerReceipts,
      reconnectedAt,
      observedUntil,
      pendingDeliveries: 0,
      reconnectKind: "owned_process_restart",
    },
    {
      observations,
      transcript,
      projected,
      beforeIdentity,
      afterIdentity: gateway.identity,
      afterAncestry: gateway.ancestry,
      observedDurationMs: performance.now() - start,
    },
  );
  const workflow = JSON.parse(await readFile(path.join(evidence, "workflow-execution.json"), "utf8"));
  await write(path.join(evidence, "execution.json"), {
    ...workflow,
    nativeReceipts: [...sourceReceipts, ...workflow.nativeReceipts],
  });
  const verification = await verifyComparisonEvidence({
    taskId: task.id,
    workspaceRoot: workspace,
    evidenceRoot: evidence,
  });
  assert.equal(verification.outcome, "passed");
  assert.equal(verification.evidenceKind, "controlled");
  await write(path.join(root, "native-proof.json"), {
    fixtureOnly: true,
    taskOutcome: "unverified",
    checkout,
    authorization,
    created,
    completed,
    providerReceipts,
    modelRequests: modelCalls.length,
    upstreamRequests: 0,
    externalChannelRequests: 0,
    beforeInstanceId: `pid-${before}`,
    afterInstanceId: `pid-${gateway.nativePid}`,
    reconnectedAt,
    observedUntil,
  });
  await write(path.join(root, "result.json"), {
    fixtureOnly: true,
    verification,
    result: projected,
    modelRequests: modelCalls.length,
    providerReceipts: providerReceipts.length,
    upstreamRequests: 0,
    externalChannelRequests: 0,
  });
  process.stdout.write(
    JSON.stringify({
      root,
      nativeJourney: verification.outcome,
      checks: verification.checks,
      modelRequests: modelCalls.length,
      upstreamRequests: 0,
    }) + "\n",
  );
} catch (error) {
  failure ??= error;
  await write(path.join(root, "failure.json"), {
    fixtureOnly: true,
    message: redact(failure.message),
    stack: redact(failure.stack),
    modelCalls,
    providerReceipts,
  });
  process.stderr.write(redact(failure.stack) + "\n");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  for (const child of children) {
    await child.stop("supervisor_close");
    const value = await child.finished;
    await retain("process-terminal", {
      pid: child.pid,
      ...value,
      stdout: redact(value.stdout),
      stderr: redact(value.stderr),
    });
    if (value.cleanupUnconfirmed) process.exitCode = 1;
  }
  await retain("native-transcript", await readHermesNativeTranscript({ stateDirectory }));
  await proxy?.close();
  telegram.closeAllConnections();
  if (telegram.listening) await new Promise((resolve) => telegram.close(resolve));
  if (failure) process.exitCode = 1;
}

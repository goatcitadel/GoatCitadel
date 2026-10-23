#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertArtifactRedactionGate } from "../verify-artifact-redaction.mjs";
import {
  CLAUDE_CODE_CLI_MODEL,
  buildTestbenchEnvOmit,
  buildTestbenchGatewayEnv,
  prepareTestbenchRuntime,
  readClaudeCodeCliAuthStatus,
  writeClaudeCodeCliProviderConfig,
} from "../testbench-runtime.mjs";
import {
  completeLiveProviderSourceState,
  consumeCompleteSseFrames,
  ensureLiveProviderOnboardingComplete,
} from "./live-provider-preqa.mjs";
import { CLAUDE_CLI_USABILITY_TASKS } from "./lib/scenarios/claude-cli-usability-tasks.mjs";
import { requestJson, startVerificationStack, stopVerificationStack } from "./lib/runtime.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { snapshotUsabilitySourceState } from "./lib/scenarios/usability-source-state.mjs";
import {
  createRunContext,
  finalizeRunContext,
  releaseRunContext,
  repoRoot,
  runScenario,
  writeJson,
} from "./lib/shared.mjs";

export const LANE = "claude-cli-usability";
const PROVIDER_ID = "claude-code-cli";
const TURN_TIMEOUT_MS = 300_000;
const POLL_MS = 500;
// The gateway holds a session's write lock until the stream sends `done`, seconds after the turn settles.
const STREAM_END_GRACE_MS = 30_000;
const SETTLED_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const RAW_TOOL_MARKUP = /<invoke\s+name="/u;
// prepareTestbenchRuntime needs a stub URL for the fixture config it then hands to writeClaudeCodeCliProviderConfig,
// which replaces the whole provider list; nothing ever calls this address.
const UNUSED_STUB_URL = "http://127.0.0.1:9/v1";

export function isSettledTurnStatus(status) {
  return SETTLED_STATUSES.has(status);
}

/** The Chat send/edit request for one catalog task, pinned to the Claude Code CLI provider and the task's prefs. */
export function buildClaudeCliChatMutation(task, model, action = "send") {
  if (!["send", "edit"].includes(action)) throw new Error(`unsupported Claude CLI usability action ${action}`);
  const content = action === "edit" ? (task.followUp?.content ?? task.prompt) : task.prompt;
  const prefs = { providerId: PROVIDER_ID, model, ...task.prefs };
  const body = {
    content,
    providerId: PROVIDER_ID,
    model,
    webMode: task.prefs.webMode,
    memoryMode: task.prefs.memoryMode,
    thinkingLevel: task.prefs.thinkingLevel,
    subagentPolicy: task.prefs.subagentPolicy,
    prefsOverride: prefs,
  };
  return { action, preflight: { action, ...body }, body };
}

function isCodeToolRun(run) {
  return typeof run?.toolName === "string" && run.toolName.startsWith("code") && run.status === "executed";
}

/** Grades one settled canonical turn against its task's `expect`. A tool the model never asked for is not a product failure. */
export function classifyUsabilityOutcome(turn, task) {
  const trace = turn?.trace ?? {};
  const expect = task.expect;
  const toolRuns = Array.isArray(trace.toolRuns) ? trace.toolRuns : [];
  const reasons = [];
  if (trace.routing?.effectiveProviderId !== PROVIDER_ID) {
    reasons.push(`resolved to provider ${trace.routing?.effectiveProviderId ?? "missing"}`);
  }
  if (!expect.status.includes(trace.status)) {
    reasons.push(`status ${trace.status ?? "missing"} is not ${expect.status.join(" or ")}`);
  }
  if (expect.forbidExecutedArgsMatching) {
    const forbidden = new RegExp(expect.forbidExecutedArgsMatching, "iu");
    const hit = toolRuns.find((run) => run.status === "executed" && forbidden.test(JSON.stringify(run.args ?? {})));
    if (hit) reasons.push(`${hit.toolName} executed with forbidden arguments`);
  }
  if (typeof expect.citationsMin === "number") {
    const citations = Array.isArray(trace.citations) ? trace.citations.length : 0;
    if (citations < expect.citationsMin)
      reasons.push(`${citations} citation(s), expected at least ${expect.citationsMin}`);
  }
  if (expect.codeModeRun === true && !trace.codeModeRunId && !toolRuns.some(isCodeToolRun)) {
    reasons.push("no Code Mode run was recorded");
  }
  if (expect.codeModeRun === false && toolRuns.some(isCodeToolRun)) {
    reasons.push("a Code Mode run executed although its approval was rejected");
  }
  let declined = false;
  if (expect.toolNamesAny?.length && !toolRuns.some((run) => expect.toolNamesAny.includes(run.toolName))) {
    if (toolRuns.length === 0) declined = true;
    else
      reasons.push(
        `no ${expect.toolNamesAny.join("/")} tool run (got ${toolRuns.map((run) => run.toolName).join(", ")})`,
      );
  }
  if (typeof expect.reply === "string" && turn?.assistantMessage?.content?.trim() !== expect.reply) {
    reasons.push(`reply was not exactly ${expect.reply}`);
  }
  // A tool call the provider never executed can come back as plain text; that is a wrong answer, not a pass.
  if (RAW_TOOL_MARKUP.test(turn?.assistantMessage?.content ?? "")) {
    reasons.push("the reply is raw tool-call markup instead of an answer");
  }
  if (reasons.length > 0) return { verdict: "failed", reasons };
  if (declined)
    return { verdict: "model_declined", reasons: [`the model did not call ${expect.toolNamesAny.join("/")}`] };
  return { verdict: "passed", reasons: [] };
}

async function listFiles(root, dir = root) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return await listFiles(root, full);
      return entry.isFile() ? [full] : [];
    }),
  );
  return nested.flat();
}

/** Relative paths of the files under `root` that contain any non-empty needle, case-insensitively. */
export async function findSecretTextLeaks(root, needles) {
  const wanted = needles.filter((needle) => typeof needle === "string" && needle.trim()).map((n) => n.toLowerCase());
  if (wanted.length === 0) return [];
  const leaks = [];
  for (const file of await listFiles(root)) {
    const text = (await fs.readFile(file, "latin1")).toLowerCase();
    if (wanted.some((needle) => text.includes(needle))) leaks.push(path.relative(root, file).replaceAll("\\", "/"));
  }
  return leaks.sort();
}

function headers(correlationId, sessionId) {
  return {
    "x-goatcitadel-correlation-id": correlationId,
    ...(sessionId ? { "x-goatcitadel-session-id": sessionId } : {}),
  };
}

function assertOk(response, label) {
  if (!response?.ok) {
    throw new Error(
      `${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body ?? {}).slice(0, 300)}`,
    );
  }
}

async function createTaskSession(gatewayUrl, task, model) {
  const created = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
    method: "POST",
    body: { title: `Usability ${task.id}: ${task.title}` },
  });
  assertOk(created, `create ${task.id} session`);
  const sessionId = created.body.sessionId;
  const prefs = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`);
  assertOk(prefs, `read ${task.id} prefs`);
  const patched = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    method: "PATCH",
    body: { expectedRevision: prefs.body.revision, providerId: PROVIDER_ID, model, ...task.prefs },
  });
  assertOk(patched, `patch ${task.id} prefs`);
  return sessionId;
}

async function readThread(gatewayUrl, sessionId, correlationId) {
  const thread = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
    { headers: headers(correlationId, sessionId) },
  );
  assertOk(thread, "read canonical thread");
  return Array.isArray(thread.body?.turns) ? thread.body.turns : [];
}

function pendingApprovalId(trace) {
  const run = (trace?.toolRuns ?? []).find((item) => item.status === "approval_required" && item.approvalId);
  return run?.approvalId ?? trace?.pendingApprovalSummary?.approvalId;
}

/**
 * Polls the canonical turn until it settles, resolving each approval it waits on with the task's decision.
 * `stopOnUserInput` returns a turn that is waiting for the operator's answer instead of failing on it.
 */
async function settleTurn(gatewayUrl, input) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const resolved = new Set();
  let latest;
  while (Date.now() < deadline) {
    latest = (await readThread(gatewayUrl, input.sessionId, input.correlationId)).find(
      (item) => item.turnId === input.turnId,
    );
    const status = latest?.trace?.status;
    if (isSettledTurnStatus(status)) return { turn: latest, approvalsResolved: resolved.size };
    if (status === "waiting_for_user_input" && input.stopOnUserInput)
      return { turn: latest, approvalsResolved: resolved.size };
    const approvalId = status === "waiting_for_approval" ? pendingApprovalId(latest.trace) : undefined;
    if (approvalId && !resolved.has(approvalId) && input.approval !== "none") {
      const decision = input.approval === "reject" ? "reject" : "approve";
      const response = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers: headers(input.correlationId, input.sessionId),
        body: { decision, resolutionNote: `verification-${LANE}` },
      });
      assertOk(response, `${decision} approval ${approvalId}`);
      resolved.add(approvalId);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`turn ${input.turnId} did not settle (${latest?.trace?.status ?? "missing"})`);
}

/** The error for a stream that ended before naming its turn, carrying the stream's own error events. */
export function streamClosedWithoutTurnError(taskId, errorEvents) {
  const details = errorEvents
    .map((event) => [event.code, event.error ?? event.message].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
  return new Error(`${taskId} stream closed without naming its turn${details ? `: ${details}` : ""}`);
}

/**
 * Starts one send or edit stream and resolves as soon as the stream names its turn. The stream stays open while the
 * turn waits on an approval, so the caller settles the turn (resolving approvals) with the stream still open and then
 * calls `finish()`, which closes it and reports the SSE event types and the seconds to the first text delta.
 */
async function openTurnStream(gatewayUrl, input) {
  const mutation = buildClaudeCliChatMutation(input.task, input.model, input.action);
  const preflight = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/route-preflight`,
    {
      method: "POST",
      headers: headers(input.correlationId, input.sessionId),
      body: { ...mutation.preflight, ...(input.sourceTurnId ? { turnId: input.sourceTurnId } : {}) },
    },
  );
  assertOk(preflight, `${input.task.id} route preflight`);
  const route =
    mutation.action === "send"
      ? `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/agent-send/stream`
      : `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/turns/${encodeURIComponent(input.sourceTurnId)}/edit/stream`;
  const controller = new AbortController();
  const started = performance.now();
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: "POST",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
      ...headers(input.correlationId, input.sessionId),
    },
    body: JSON.stringify({
      ...mutation.body,
      providerId: preflight.body.decision.effectiveProviderId,
      model: preflight.body.decision.effectiveModel,
      routeDecision: preflight.body.decision,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${input.task.id} Chat SSE failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const types = new Set();
  const errorEvents = [];
  let firstDeltaSeconds;
  let announceFirstDelta;
  const firstDelta = new Promise((resolve) => {
    announceFirstDelta = resolve;
  });
  let announceTurnId;
  const turnIdSeen = new Promise((resolve) => {
    announceTurnId = resolve;
  });
  const pump = (async () => {
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      const consumed = consumeCompleteSseFrames(buffer);
      buffer = consumed.remainder;
      for (const event of consumed.events) {
        if (typeof event.type === "string") types.add(event.type);
        if (event.type === "error") errorEvents.push(event);
        if (typeof event.turnId === "string" && event.turnId.trim()) announceTurnId(event.turnId);
        if (event.type === "delta" && firstDeltaSeconds === undefined) {
          firstDeltaSeconds = (performance.now() - started) / 1000;
          announceFirstDelta();
        }
      }
    }
  })().catch(() => undefined);
  const finish = async () => {
    await reader.cancel().catch(() => undefined);
    controller.abort();
    await pump;
    return { sseEventTypes: [...types], firstDeltaSeconds };
  };
  const turnId = await Promise.race([turnIdSeen, pump.then(() => undefined)]);
  if (!turnId) {
    await finish();
    throw streamClosedWithoutTurnError(input.task.id, errorEvents);
  }
  return { turnId, started, ended: pump, firstDelta, finish };
}

/** Waits for `promise` (which may be absent) or `ms`, whichever comes first, and leaves no timer behind. */
async function waitAtMost(promise, ms) {
  let timer;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

async function cancelTurn(gatewayUrl, input) {
  const cancel = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/turns/${encodeURIComponent(input.turnId)}/cancel`,
    {
      method: "POST",
      headers: headers(input.correlationId, input.sessionId),
      body: { cancelledBy: `verification-${LANE}` },
    },
  );
  assertOk(cancel, `${input.task.id} cancel`);
}

const DEFAULT_TASK_DEPS = Object.freeze({ createTaskSession, openTurnStream, cancelTurn, settleTurn });

/**
 * Runs one catalog task against a running gateway and returns its settled canonical turn plus timings. Used by the
 * lane for the automatable subset and by the exploratory runner for the rest of the catalog. `options.deps` replaces
 * the network steps in tests.
 */
export async function runUsabilityTask(gatewayUrl, task, options = {}) {
  const deps = { ...DEFAULT_TASK_DEPS, ...options.deps };
  const model = options.model ?? CLAUDE_CODE_CLI_MODEL;
  const correlationId = options.correlationId ?? randomUUID();
  const prior = task.dependsOn ? options.results?.get(task.dependsOn) : undefined;
  if (task.dependsOn && !prior) throw new Error(`${task.id} depends on ${task.dependsOn}, which has no result`);
  const sessionId = prior?.sessionId ?? (await deps.createTaskSession(gatewayUrl, task, model));
  const editing = task.followUp?.action === "edit";
  const stream = await deps.openTurnStream(gatewayUrl, {
    task,
    model,
    correlationId,
    sessionId,
    action: editing ? "edit" : "send",
    sourceTurnId: editing ? prior.turnId : undefined,
  });
  let settled;
  let streamed;
  try {
    if (task.followUp?.action === "cancel") {
      // Stop a turn that is actually streaming, so the cancel reaches the running CLI step.
      await waitAtMost(stream.firstDelta, STREAM_END_GRACE_MS);
      await deps.cancelTurn(gatewayUrl, { task, sessionId, turnId: stream.turnId, correlationId });
    }
    settled = await deps.settleTurn(gatewayUrl, {
      sessionId,
      turnId: stream.turnId,
      correlationId,
      approval: task.approval,
      stopOnUserInput: options.stopOnUserInput === true,
    });
  } finally {
    if (settled) await waitAtMost(stream.ended, STREAM_END_GRACE_MS);
    streamed = await stream.finish();
  }
  let forkSessionId;
  if (task.expect.forkSession) {
    const fork = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(stream.turnId)}/fork`,
      { method: "POST", headers: headers(correlationId, sessionId), body: { title: `Usability ${task.id} fork` } },
    );
    assertOk(fork, `${task.id} fork`);
    forkSessionId = fork.body?.session?.sessionId;
  }
  return {
    taskId: task.id,
    sessionId,
    turnId: stream.turnId,
    forkSessionId,
    turn: settled.turn,
    approvalsResolved: settled.approvalsResolved,
    sseEventTypes: streamed.sseEventTypes,
    secondsToFirstDelta: streamed.firstDeltaSeconds,
    secondsTotal: (performance.now() - stream.started) / 1000,
  };
}

/** Maps a graded task result onto the run manifest's scenario result. */
export function toScenarioResult(result, grade) {
  const trace = result.turn?.trace ?? {};
  const metrics = {
    turnId: result.turnId,
    status: trace.status,
    secondsTotal: Number(result.secondsTotal.toFixed(1)),
    toolRuns: (trace.toolRuns ?? []).map((run) => `${run.toolName}:${run.status}`),
    approvalsResolved: result.approvalsResolved,
  };
  if (grade.verdict === "failed")
    return { status: "failed", error: grade.reasons.join("; "), providerId: PROVIDER_ID, metrics };
  if (grade.verdict === "model_declined") {
    return {
      status: "passed",
      providerId: PROVIDER_ID,
      notes: [`model_declined: ${grade.reasons.join("; ")}`],
      metrics: { ...metrics, modelDeclined: true },
    };
  }
  return { status: "passed", providerId: PROVIDER_ID, metrics };
}

async function runAutomatableTasks(context, stack, correlationId) {
  const results = new Map();
  for (const task of CLAUDE_CLI_USABILITY_TASKS.filter((item) => item.automatable)) {
    await runScenario(
      context,
      { id: `${LANE}.${task.id}`, lane: LANE, title: `${task.id} ${task.title}`, subsystem: "chat-usability" },
      async () => {
        const result = await runUsabilityTask(stack.gatewayUrl, task, { correlationId, results });
        results.set(task.id, result);
        await writeJson(path.join(context.artifactRoot, "task-results", `${task.id}.json`), {
          ...result,
          turn: { trace: result.turn?.trace },
        });
        return toScenarioResult(result, classifyUsabilityOutcome(result.turn, task));
      },
    );
  }
}

/** Prepares the isolated runtime, starts its gateway and completes onboarding; cleans up whatever started if a step fails. */
async function startSandbox(context) {
  const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
  const runtimeRoot = await prepareTestbenchRuntime({
    runId: `${context.runId}-isolated`,
    stubBaseUrl: UNUSED_STUB_URL,
  });
  let stack;
  try {
    await writeClaudeCodeCliProviderConfig(runtimeRoot);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: false,
      processLogPrefix: LANE,
      gatewayEnvOmit: buildTestbenchEnvOmit(secretEnvKeys),
      gatewayEnv: buildTestbenchGatewayEnv(runtimeRoot, { provider: PROVIDER_ID }),
    });
    await ensureLiveProviderOnboardingComplete(stack.gatewayUrl);
    return stack;
  } catch (error) {
    await stopSandbox(stack ?? { runtimeRoot });
    throw error;
  }
}

/** Stops the gateway, which is when its stdout/stderr logs are written into the run's evidence, and removes the runtime. */
async function stopSandbox(sandbox) {
  if (sandbox?.gateway) await stopVerificationStack(sandbox);
  else if (sandbox?.runtimeRoot)
    await fs.rm(sandbox.runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
}

const DEFAULT_LANE_DEPS = Object.freeze({
  readAuth: () => readClaudeCodeCliAuthStatus(),
  runScenario,
  startSandbox,
  stopSandbox,
  runTasks: (context, sandbox) => runAutomatableTasks(context, sandbox, randomUUID()),
  assertRedaction: (root) => assertArtifactRedactionGate(root),
  findLeaks: (root, needles) => findSecretTextLeaks(root, needles),
  completeSourceState: (context, sourceState) => completeLiveProviderSourceState(context, sourceState),
});

/**
 * Runs every lane scenario in order. The sandbox runs inside a startup scenario and is stopped before the evidence
 * scenarios, because the gateway writes its logs into the evidence only when it exits; a startup failure is recorded
 * and the evidence scenarios still run.
 */
export async function runLane(context, sourceState, overrides = {}) {
  const deps = { ...DEFAULT_LANE_DEPS, ...overrides };
  const auth = deps.readAuth();
  const scenario = (id, title, subsystem, fn) =>
    deps.runScenario(context, { id: `${LANE}.${id}`, lane: LANE, title, subsystem }, fn);
  await scenario("preflight", "Claude Code CLI is signed in with a subscription", "provider-runtime", async () =>
    auth.ready
      ? { status: "passed", providerId: PROVIDER_ID }
      : { status: "failed", error: `Claude Code CLI is not ready (${auth.reason}); run \`claude\` and sign in first` },
  );
  if (auth.ready) {
    let sandbox;
    try {
      await scenario(
        "startup",
        "Isolated sandbox gateway starts on the Claude Code CLI provider",
        "provider-runtime",
        async () => {
          sandbox = await deps.startSandbox(context);
          return { status: "passed", providerId: PROVIDER_ID };
        },
      );
      if (sandbox) await deps.runTasks(context, sandbox);
    } finally {
      if (sandbox) await deps.stopSandbox(sandbox);
    }
  }
  await scenario(
    "artifact-redaction",
    "Evidence contains no secret-shaped values",
    "verification-evidence",
    async () => {
      await deps.assertRedaction(context.artifactRoot);
      return { status: "passed" };
    },
  );
  await scenario(
    "account-email",
    "Evidence never contains the CLI account email",
    "verification-evidence",
    async () => {
      if (!auth.accountEmail) return { status: "skipped", notes: ["the CLI reported no account email to scan for"] };
      const leaks = await deps.findLeaks(context.artifactRoot, [auth.accountEmail]);
      return leaks.length === 0
        ? { status: "passed", metrics: { scannedForAccountEmail: true } }
        : {
            status: "failed",
            error: `the CLI account email appears in ${leaks.length} evidence file(s): ${leaks.join(", ")}`,
          };
    },
  );
  await scenario("source-integrity", "Evidence remains bound to one source state", "verification-evidence", async () =>
    deps.completeSourceState(context, sourceState),
  );
}

export async function main() {
  const sourceState = snapshotUsabilitySourceState(repoRoot, process.env.GOATCITADEL_USABILITY_SOURCE_MODE);
  const context = await createRunContext(LANE, { profile: sourceState.mode });
  try {
    await runLane(context, sourceState);
    const manifest = await finalizeRunContext(context);
    console.log(`Artifact: ${context.artifactRoot}`);
    console.log(`Status: ${manifest.status}`);
    if (manifest.status !== "passed") process.exitCode = 1;
  } finally {
    await releaseRunContext(context);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

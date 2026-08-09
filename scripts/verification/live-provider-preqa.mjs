#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertArtifactRedactionGate } from "../verify-artifact-redaction.mjs";
import {
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopVerificationStack,
} from "./lib/runtime.mjs";
import { parseGatewayChatSse } from "./lib/scenarios/gateway-chat-fault-recovery-lane.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import {
  assertUsabilitySourceStateUnchanged,
  snapshotUsabilitySourceState,
} from "./lib/scenarios/usability-source-state.mjs";
import {
  createRunContext,
  finalizeRunContext,
  releaseRunContext,
  repoRoot,
  runScenario,
  writeJson,
} from "./lib/shared.mjs";

const LANE = "live-provider-preqa";
const PROVIDER_ID = "openai-codex";
const PROVIDER_BASE_URL = "https://chatgpt.com/backend-api/codex";
const MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
});
const OPERATOR_TOKEN = "verification-live-provider-preqa-operator-token";
const TURN_TIMEOUT_MS = 180_000;
const ONBOARDING_RECONCILIATION_CONFLICT =
  "Settings are temporarily unavailable while runtime owners reconcile a config generation.";

// Every ordinary verification stack stays keychain-isolated. This one lane is
// the deliberate exception: it reads only the existing ChatGPT OAuth record
// from the OS keychain while all provider/channel secret environment variables
// remain scrubbed and all runtime data stays under a fresh temporary root.
export const LIVE_PROVIDER_GATEWAY_ENV = Object.freeze({
  GOATCITADEL_AUTH_MODE: "token",
  GOATCITADEL_AUTH_TOKEN: OPERATOR_TOKEN,
  GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
  GOATCITADEL_DEV_DIAGNOSTICS: "true",
  GOATCITADEL_DISABLE_SECRET_STORE: "false",
});

export async function main() {
  const sourceState = snapshotUsabilitySourceState(repoRoot, process.env.GOATCITADEL_USABILITY_SOURCE_MODE);
  const context = await createRunContext(LANE, {
    profile: sourceState.mode,
  });
  try {
    await runScenario(
      context,
      {
        id: "live-provider.chatgpt.sol-terra-luna",
        lane: LANE,
        title: "ChatGPT OAuth Sol journey pack and Terra/Luna smokes",
        subsystem: "provider-runtime",
      },
      async ({ correlationId }) =>
        await runLiveProviderJourney(context, {
          correlationId,
          sourceState,
        }),
    );

    await runScenario(
      context,
      {
        id: "live-provider.artifact-redaction",
        lane: LANE,
        title: "Live provider evidence contains no secret-shaped values",
        subsystem: "verification-evidence",
      },
      async () => {
        await assertArtifactRedactionGate(context.artifactRoot);
        return {
          status: "passed",
          metrics: { scannedArtifactRoot: true, findings: 0 },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "live-provider.source-integrity",
        lane: LANE,
        title: "Live provider evidence remains bound to one source state",
        subsystem: "verification-evidence",
      },
      async () => await completeLiveProviderSourceState(context, sourceState),
    );

    const manifest = await finalizeRunContext(context);
    console.log(`Artifact: ${context.artifactRoot}`);
    console.log(`Status: ${manifest.status}`);
    if (manifest.status !== "passed") process.exitCode = 1;
  } finally {
    await releaseRunContext(context);
  }
}

export async function completeLiveProviderSourceState(context, startedSourceState, deps = {}) {
  const snapshotSourceState = deps.snapshotUsabilitySourceState ?? snapshotUsabilitySourceState;
  const persistJson = deps.writeJson ?? writeJson;
  const sourceRepoRoot = deps.repoRoot ?? repoRoot;
  const completedSourceState = snapshotSourceState(sourceRepoRoot, startedSourceState.mode);
  const sourceStatePath = path.join(context.artifactRoot, "diagnostics", "live-provider-source-state.json");
  await persistJson(sourceStatePath, {
    schemaVersion: 1,
    started: startedSourceState,
    completed: completedSourceState,
  });

  const common = {
    metrics: {
      baseSha: startedSourceState.baseSha,
      completedBaseSha: completedSourceState.baseSha,
      completedSourceDiffSha256: completedSourceState.diffSha256,
      completedSourceModified: completedSourceState.sourceModified,
    },
    artifacts: {
      diagnostics: [relativeToRun(context, sourceStatePath)],
      screenshots: [],
      traces: [],
      logs: [],
      perf: [],
      playwright: [],
    },
  };
  try {
    assertUsabilitySourceStateUnchanged(startedSourceState, completedSourceState);
    return { status: "passed", ...common };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...common,
    };
  }
}

export async function runLiveProviderJourney(context, input) {
  const correlationId = requireText(input.correlationId, "live-provider correlation id");
  const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
  const resultPath = path.join(context.artifactRoot, "provider-results", "chatgpt-live-provider-pack.json");
  let runtimeRoot;
  let stack;
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-isolated`);
    await writeOpenAICodexProviderConfig(runtimeRoot, MODELS.sol);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: false,
      processLogPrefix: LANE,
      gatewayEnvOmit: secretEnvKeys,
      gatewayEnv: LIVE_PROVIDER_GATEWAY_ENV,
    });

    await ensureLiveProviderOnboardingComplete(stack.gatewayUrl);
    await assertCodexOAuthConnected(stack.gatewayUrl);

    const models = [];
    const sol = await createLiveSession(stack.gatewayUrl, "Sol full journey", MODELS.sol);
    const solProbes = [];
    const first = await streamLiveMutation(stack.gatewayUrl, {
      action: "send",
      content: "Reply with exactly: CHAT_OK",
      correlationId,
      expectedReply: "CHAT_OK",
      model: MODELS.sol,
      sessionId: sol.sessionId,
    });
    solProbes.push(first);
    solProbes.push(
      await streamLiveMutation(stack.gatewayUrl, {
        action: "send",
        content: "Reply with exactly: SECOND_OK",
        correlationId,
        expectedReply: "SECOND_OK",
        model: MODELS.sol,
        sessionId: sol.sessionId,
      }),
    );
    solProbes.push(
      await streamLiveMutation(stack.gatewayUrl, {
        action: "retry",
        content: "Reply with exactly: CHAT_OK",
        correlationId,
        expectedReply: "CHAT_OK",
        model: MODELS.sol,
        sessionId: sol.sessionId,
        sourceTurnId: first.turnId,
      }),
    );
    const edited = await streamLiveMutation(stack.gatewayUrl, {
      action: "edit",
      content: "Reply with exactly: EDIT_OK",
      correlationId,
      expectedReply: "EDIT_OK",
      model: MODELS.sol,
      sessionId: sol.sessionId,
      sourceTurnId: first.turnId,
    });
    solProbes.push(edited);

    const fork = await requestJson(
      stack.gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sol.sessionId)}/turns/${encodeURIComponent(edited.turnId)}/fork`,
      {
        method: "POST",
        headers: correlationHeaders(correlationId, sol.sessionId),
        body: { title: "Pre-QA live provider fork" },
      },
    );
    assertResponseOk(fork, "fork Sol Chat session");
    const forkSessionId = requireText(fork.body?.session?.sessionId, "fork session id");
    solProbes.push({
      action: "fork",
      sourceTurnId: edited.turnId,
      sessionId: forkSessionId,
      manifestVersion: fork.body?.manifest?.manifestVersion,
      status: "completed",
    });
    solProbes.push(
      await streamLiveMutation(stack.gatewayUrl, {
        action: "branch-send",
        content: "Reply with exactly: BRANCH_OK",
        correlationId,
        expectedReply: "BRANCH_OK",
        model: MODELS.sol,
        sessionId: forkSessionId,
      }),
    );
    solProbes.push(await exerciseSessionLifecycle(stack.gatewayUrl, fork.body.session, correlationId));
    const cancellationSession = await createLiveSession(stack.gatewayUrl, "Sol cancellation", MODELS.sol);
    solProbes.push(
      await streamAndCancelLiveTurn(stack.gatewayUrl, {
        correlationId,
        model: MODELS.sol,
        sessionId: cancellationSession.sessionId,
      }),
    );
    models.push({ model: MODELS.sol, sessionId: sol.sessionId, probes: solProbes });

    for (const [label, model, expectedReply] of [
      ["Terra smoke", MODELS.terra, "TERRA_OK"],
      ["Luna smoke", MODELS.luna, "LUNA_OK"],
    ]) {
      const session = await createLiveSession(stack.gatewayUrl, label, model);
      const probe = await streamLiveMutation(stack.gatewayUrl, {
        action: "send",
        content: `Reply with exactly: ${expectedReply}`,
        correlationId,
        expectedReply,
        model,
        sessionId: session.sessionId,
      });
      models.push({ model, sessionId: session.sessionId, probes: [probe] });
    }

    const payload = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      baseSha: input.sourceState.baseSha,
      sourceModified: input.sourceState.sourceModified,
      providerId: PROVIDER_ID,
      dataBoundary:
        "fresh isolated root; fixed disposable prompts; web, memory, orchestration, subagents, and tools disabled; OAuth read from the OS keychain",
      models,
    };
    await writeJson(resultPath, payload);
    return {
      status: "passed",
      providerId: PROVIDER_ID,
      modelId: `${MODELS.sol} + Terra/Luna smokes`,
      notes: [payload.dataBoundary],
      metrics: {
        baseSha: input.sourceState.baseSha,
        sourceModified: input.sourceState.sourceModified,
        models: models.length,
        probes: models.reduce((sum, item) => sum + item.probes.length, 0),
        scrubbedSecretEnvKeys: secretEnvKeys.length,
      },
      artifacts: {
        diagnostics: [relativeToRun(context, resultPath)],
        screenshots: [],
        traces: [],
        logs: [relativeToRun(context, stack.gateway.stdoutPath), relativeToRun(context, stack.gateway.stderrPath)],
        perf: [],
        playwright: [],
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeJson(resultPath, {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      baseSha: input.sourceState.baseSha,
      sourceModified: input.sourceState.sourceModified,
      providerId: PROVIDER_ID,
      status: "failed",
      error: errorMessage,
    });
    return {
      status: "failed",
      error: errorMessage,
      providerId: PROVIDER_ID,
      modelId: `${MODELS.sol} + Terra/Luna smokes`,
      metrics: {
        baseSha: input.sourceState.baseSha,
        sourceModified: input.sourceState.sourceModified,
        scrubbedSecretEnvKeys: secretEnvKeys.length,
      },
      artifacts: {
        diagnostics: [relativeToRun(context, resultPath)],
        screenshots: [],
        traces: [],
        logs: stack
          ? [relativeToRun(context, stack.gateway.stdoutPath), relativeToRun(context, stack.gateway.stderrPath)]
          : [],
        perf: [],
        playwright: [],
      },
    };
  } finally {
    if (stack) await stopVerificationStack(stack);
    else if (runtimeRoot) await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeOpenAICodexProviderConfig(runtimeRoot, activeModel = MODELS.sol) {
  const llm = {
    activeProviderId: PROVIDER_ID,
    activeModel,
    providers: [
      {
        providerId: PROVIDER_ID,
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: PROVIDER_BASE_URL,
        apiStyle: "openai-codex-responses",
        defaultModel: activeModel,
        authMode: "codex-oauth",
      },
    ],
  };
  const unifiedPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  const unified = JSON.parse(await fs.readFile(unifiedPath, "utf8"));
  unified.llm = llm;
  delete unified.generation;
  await fs.writeFile(unifiedPath, `${JSON.stringify(unified, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(runtimeRoot, "config", "llm-providers.json"),
    `${JSON.stringify(llm, null, 2)}\n`,
    "utf8",
  );
  return llm;
}

export function buildLiveChatMutation(input) {
  const action = input.action === "branch-send" ? "send" : input.action;
  if (!["send", "retry", "edit"].includes(action)) throw new Error(`unsupported live Chat action ${input.action}`);
  const body = {
    content: requireText(input.content, "live Chat content"),
    providerId: PROVIDER_ID,
    model: requireText(input.model, "live Chat model"),
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    prefsOverride: {
      providerId: PROVIDER_ID,
      model: input.model,
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      orchestrationEnabled: false,
    },
  };
  return {
    action,
    preflight: {
      action,
      ...(input.sourceTurnId ? { turnId: input.sourceTurnId } : {}),
      ...body,
    },
    body,
  };
}

async function streamLiveMutation(gatewayUrl, input) {
  const mutation = buildLiveChatMutation(input);
  const preflight = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/route-preflight`,
    {
      method: "POST",
      headers: correlationHeaders(input.correlationId, input.sessionId),
      body: mutation.preflight,
    },
  );
  assertResponseOk(preflight, `${input.action} route preflight`);
  if (!preflight.body?.decision) throw new Error(`${input.action} route preflight returned no decision`);
  const route =
    mutation.action === "send"
      ? `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/agent-send/stream`
      : `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/turns/${encodeURIComponent(input.sourceTurnId)}/${mutation.action}/stream`;
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: "POST",
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
      ...correlationHeaders(input.correlationId, input.sessionId),
    },
    body: JSON.stringify({
      ...mutation.body,
      providerId: preflight.body.decision.effectiveProviderId,
      model: preflight.body.decision.effectiveModel,
      routeDecision: preflight.body.decision,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${input.action} Chat SSE failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  const chunks = parseGatewayChatSse(await response.text());
  const errors = chunks.filter((chunk) => chunk.type === "error");
  if (errors.length > 0) throw new Error(`${input.action} Chat SSE emitted ${errors.length} error event(s)`);
  for (const terminalType of ["message_done", "done"]) {
    if (!chunks.some((chunk) => chunk.type === terminalType)) {
      throw new Error(`${input.action} Chat SSE omitted ${terminalType}`);
    }
  }
  const turnId = requireText(
    chunks.find((chunk) => typeof chunk.turnId === "string" && chunk.turnId.trim())?.turnId,
    `${input.action} turn id`,
  );
  const canonicalTurn = await waitForCanonicalTurn(gatewayUrl, input.sessionId, turnId, input.correlationId);
  validateLiveProviderProbe(canonicalTurn, {
    action: input.action,
    expectedReply: input.expectedReply,
    expectedModel: input.model,
  });
  return {
    action: input.action,
    expectedReply: input.expectedReply,
    effectiveProviderId: canonicalTurn.trace?.routing?.effectiveProviderId,
    effectiveModel: canonicalTurn.trace?.routing?.effectiveModel,
    sseEventTypes: [...new Set(chunks.map((chunk) => chunk.type).filter((value) => typeof value === "string"))],
    errorEvents: [],
    turnId,
    runId: canonicalTurn.trace?.durable?.runId,
    status: canonicalTurn.trace?.status,
  };
}

async function streamAndCancelLiveTurn(gatewayUrl, input) {
  const mutation = buildLiveChatMutation({
    action: "send",
    content: "Write a long numbered list of 500 harmless test words for a cancellation smoke test.",
    model: input.model,
  });
  const preflight = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/route-preflight`,
    {
      method: "POST",
      headers: correlationHeaders(input.correlationId, input.sessionId),
      body: mutation.preflight,
    },
  );
  assertResponseOk(preflight, "cancel route preflight");
  if (!preflight.body?.decision) throw new Error("cancel route preflight returned no decision");

  const controller = new AbortController();
  const response = await fetch(
    `${gatewayUrl}/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/agent-send/stream`,
    {
      method: "POST",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]),
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...correlationHeaders(input.correlationId, input.sessionId),
      },
      body: JSON.stringify({
        ...mutation.body,
        providerId: preflight.body.decision.effectiveProviderId,
        model: preflight.body.decision.effectiveModel,
        routeDecision: preflight.body.decision,
      }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`cancel Chat SSE failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turnId;
  try {
    while (!turnId) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const consumed = consumeCompleteSseFrames(buffer);
      buffer = consumed.remainder;
      turnId = consumed.events.find((event) => typeof event.turnId === "string" && event.turnId.trim())?.turnId;
    }
    turnId = requireText(turnId, "cancel turn id");
    const cancelled = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {
        method: "POST",
        headers: correlationHeaders(input.correlationId, input.sessionId),
        body: { cancelledBy: "verification-live-provider-preqa" },
      },
    );
    assertResponseOk(cancelled, "cancel live-provider Chat turn");
    if (cancelled.body?.cancelled !== true || cancelled.body?.trace?.status !== "cancelled") {
      throw new Error(
        `cancel did not win the active turn (${cancelled.body?.trace?.status ?? "missing canonical status"})`,
      );
    }
    const canonical = await waitForCanonicalTurn(gatewayUrl, input.sessionId, turnId, input.correlationId);
    if (canonical.trace?.status !== "cancelled") {
      throw new Error(`cancelled turn settled as ${canonical.trace?.status ?? "missing"}`);
    }
    return {
      action: "stop",
      effectiveProviderId: canonical.trace?.routing?.effectiveProviderId,
      effectiveModel: canonical.trace?.routing?.effectiveModel,
      turnId,
      runId: canonical.trace?.durable?.runId,
      status: canonical.trace?.status,
    };
  } finally {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }
}

export function consumeCompleteSseFrames(buffer) {
  if (typeof buffer !== "string") throw new TypeError("SSE buffer must be a string");
  const separators = [...buffer.matchAll(/\r?\n\r?\n/gu)];
  const last = separators.at(-1);
  if (!last || last.index === undefined) return { events: [], remainder: buffer };
  const cut = last.index + last[0].length;
  return {
    events: parseGatewayChatSse(buffer.slice(0, cut)),
    remainder: buffer.slice(cut),
  };
}

export function validateLiveProviderProbe(turn, input) {
  if (turn?.trace?.status !== "completed") {
    throw new Error(`${input.action} canonical turn status was ${turn?.trace?.status ?? "missing"}`);
  }
  if (turn?.assistantMessage?.content?.trim() !== input.expectedReply) {
    throw new Error(`${input.action} canonical assistant content did not equal the disposable expected reply`);
  }
  if (turn?.trace?.routing?.effectiveProviderId !== PROVIDER_ID) {
    throw new Error(`${input.action} resolved to an unexpected provider`);
  }
  if (turn?.trace?.routing?.effectiveModel !== input.expectedModel) {
    throw new Error(`${input.action} resolved to an unexpected model`);
  }
}

async function createLiveSession(gatewayUrl, titleSuffix, model) {
  const created = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
    method: "POST",
    body: { title: `Pre-QA live provider: ${titleSuffix}` },
  });
  assertResponseOk(created, "create live-provider Chat session");
  const sessionId = requireText(created.body?.sessionId, "live-provider session id");
  const prefs = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`);
  assertResponseOk(prefs, "read live-provider Chat prefs");
  const patched = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    method: "PATCH",
    body: {
      expectedRevision: prefs.body.revision,
      providerId: PROVIDER_ID,
      model,
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      orchestrationEnabled: false,
    },
  });
  assertResponseOk(patched, "patch live-provider Chat prefs");
  return created.body;
}

async function exerciseSessionLifecycle(gatewayUrl, initial, correlationId) {
  let session = initial;
  for (const [action, expected] of [
    ["pin", { pinned: true }],
    ["archive", { lifecycleStatus: "archived" }],
    ["restore", { lifecycleStatus: "active" }],
    ["unpin", { pinned: false }],
  ]) {
    const response = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}/${action}`,
      {
        method: "POST",
        headers: correlationHeaders(correlationId, session.sessionId),
        body: { expectedRevision: session.revision },
      },
    );
    assertResponseOk(response, `${action} live-provider Chat session`);
    session = response.body;
    for (const [key, value] of Object.entries(expected)) {
      if (session?.[key] !== value) throw new Error(`${action} did not persist ${key}=${String(value)}`);
    }
  }
  return {
    action: "session-lifecycle",
    sessionId: session.sessionId,
    finalRevision: session.revision,
    pinned: session.pinned,
    lifecycleStatus: session.lifecycleStatus,
    status: "completed",
  };
}

async function waitForCanonicalTurn(gatewayUrl, sessionId, turnId, correlationId) {
  const deadline = Date.now() + 20_000;
  let latest;
  while (Date.now() < deadline) {
    const thread = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
      { headers: correlationHeaders(correlationId, sessionId) },
    );
    assertResponseOk(thread, "read canonical live-provider thread");
    latest = Array.isArray(thread.body?.turns) ? thread.body.turns.find((turn) => turn.turnId === turnId) : undefined;
    if (latest && !["queued", "running"].includes(latest.trace?.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`canonical live-provider turn ${turnId} did not settle (${latest?.trace?.status ?? "missing"})`);
}

export async function ensureLiveProviderOnboardingComplete(gatewayUrl, deps = {}) {
  const request = deps.requestJson ?? requestJson;
  const wait = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const state = await request(gatewayUrl, "/api/v1/onboarding/state");
    if (isOnboardingReconciliationConflict(state) && attempt < 120) {
      await wait(250);
      continue;
    }
    assertResponseOk(state, "read live-provider onboarding state");
    if (state.body?.completed === true) return state.body;
    const completed = await request(gatewayUrl, "/api/v1/onboarding/complete", {
      method: "POST",
      body: { completedBy: "verification-live-provider-preqa" },
    });
    if (isOnboardingReconciliationConflict(completed) && attempt < 120) {
      await wait(250);
      continue;
    }
    assertResponseOk(completed, "complete live-provider onboarding");
    return completed.body;
  }
  throw new Error("live-provider onboarding reconciliation retry budget was exhausted");
}

function isOnboardingReconciliationConflict(response) {
  return (
    response?.status === 409 &&
    response.body?.code === "STATE_CONFLICT" &&
    response.body?.error === ONBOARDING_RECONCILIATION_CONFLICT
  );
}

async function assertCodexOAuthConnected(gatewayUrl) {
  const status = await requestJson(gatewayUrl, "/api/v1/llm/providers/openai-codex/oauth/status");
  assertResponseOk(status, "read ChatGPT OAuth status");
  if (status.body?.connected !== true) {
    throw new Error(
      "ChatGPT OAuth is not connected in the GoatCitadel OS keychain; connect it in Settings before the required live provider gate",
    );
  }
}

function correlationHeaders(correlationId, sessionId) {
  return {
    "x-goatcitadel-correlation-id": correlationId,
    ...(sessionId ? { "x-goatcitadel-session-id": sessionId } : {}),
  };
}

function assertResponseOk(response, label) {
  if (!response?.ok) throw new Error(`${label} failed (${response?.status ?? "unknown"})`);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

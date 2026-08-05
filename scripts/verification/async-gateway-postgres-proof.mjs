#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { prepareVerificationRuntime, startVerificationStack, stopVerificationStack } from "./lib/runtime.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./lib/scenarios/deterministic-llm-stub.mjs";
import { redactSensitiveEvidence } from "./lib/scenarios/gateway-chat-fault-recovery-lane.mjs";
import {
  RESEARCH_ARTIFACT_PROVIDER_ID,
  RESEARCH_ARTIFACT_PROVIDER_MODEL,
  RESEARCH_ARTIFACT_PROMPT,
  RESEARCH_ARTIFACT_TASK_COUNT,
  buildPresentationArgs,
  createResearchArtifactPermissionProfile,
  createResearchSession,
  ensureOnboardingComplete,
  readResearchTurnCapabilityProfile,
  sendResearchTurn,
  validateResearchTurn,
} from "./research-artifact-reliability.mjs";
import {
  POSTGRES_RECOVERY_SCRUBBED_ENV_KEYS,
  POSTGRES_RECOVERY_URL_ENV,
  parseLoopbackPostgresVerificationUrl,
} from "./usability-postgres-recovery.mjs";
import { createRunContext, finalizeRunContext, repoRoot, runScenario, writeJson } from "./lib/shared.mjs";

export const ASYNC_GATEWAY_POSTGRES_LANE = "async-gateway-postgres";
export const EVENT_LOOP_P99_LIMIT_MS = 250;
export const EVENT_LOOP_MAX_LIMIT_MS = 1_000;
export const GUARD_METRICS_MAX_AGE_MS = 2_000;

const PROCESS_LOG_PREFIX = "async-gateway-postgres";
const GUARD_METRICS_ENV = "GOATCITADEL_ASYNC_GATEWAY_PROOF_METRICS_PATH";
const GUARD_VIOLATIONS_ENV = "GOATCITADEL_ASYNC_GATEWAY_PROOF_VIOLATIONS_PATH";
const CHECKPOINT_TASK_INDEX = 2;
const CHECKPOINT_PROVIDER_DELAY_MS = 2_000;

export async function main() {
  const context = await createRunContext(ASYNC_GATEWAY_POSTGRES_LANE, {
    profile: "isolated-built-runtime",
  });
  await runScenario(
    context,
    {
      id: "async-gateway-postgres.research-artifact-checkpoint",
      lane: ASYNC_GATEWAY_POSTGRES_LANE,
      title: "Async PostgreSQL Gateway stays responsive through research artifacts and CHECKPOINT",
      subsystem: "gateway-storage-postgres",
    },
    async ({ correlationId }) => runAsyncGatewayPostgresProof(context, correlationId),
  );
  const manifest = await finalizeRunContext(context);
  const scenario = manifest.scenarios.find(
    (candidate) => candidate.id === "async-gateway-postgres.research-artifact-checkpoint",
  );
  console.log(`Artifact: ${context.artifactRoot}`);
  console.log(`Status: ${manifest.status}`);
  console.log(`Live PostgreSQL scenario: ${scenario?.status ?? "missing"}`);
  if (manifest.status !== "passed") process.exitCode = 1;
}

export async function runAsyncGatewayPostgresProof(context, correlationId, options = {}) {
  const environment = options.environment ?? process.env;
  const prerequisite = resolveLivePostgresPrerequisite(environment);
  if (!prerequisite.configured) {
    return {
      status: "skipped",
      notes: [
        `${POSTGRES_RECOVERY_URL_ENV} is unset; no live PostgreSQL, checkpoint, provider-turn, or event-loop claim was made.`,
        `Set a loopback-only disposable PostgreSQL URL in ${POSTGRES_RECOVERY_URL_ENV} to execute this acceptance lane.`,
      ],
      metrics: { livePostgresConfigured: false, tasksExecuted: 0, checkpointExecuted: false },
      artifacts: emptyArtifacts(),
    };
  }

  const presentationModulePath = path.join(repoRoot, "skills", "bundled", "design-intelligence", "presentation.md");
  const presentationModuleBytes = (await fs.stat(presentationModulePath)).size;
  assert.ok(presentationModuleBytes <= 8 * 1024, `presentation.md exceeds 8 KiB (${presentationModuleBytes} bytes)`);

  const metricsPath = path.join(context.artifactRoot, "perf", "async-gateway-event-loop.json");
  const violationsPath = path.join(context.artifactRoot, "diagnostics", "async-gateway-atomics-wait.json");
  const resultPath = path.join(context.artifactRoot, "diagnostics", "async-gateway-postgres-proof.json");
  const checkpointPath = path.join(context.artifactRoot, "diagnostics", "postgres-checkpoint.json");
  const guardPath = path.join(repoRoot, "scripts", "verification", "lib", "async-gateway-main-thread-guard.cjs");
  const deckDir = path.join(context.artifactRoot, "artifacts", "presentations");
  await Promise.all([
    fs.mkdir(path.dirname(metricsPath), { recursive: true }),
    fs.mkdir(path.dirname(violationsPath), { recursive: true }),
    fs.mkdir(deckDir, { recursive: true }),
  ]);

  const dispatchPlan = buildDispatchPlan();
  const stub = await startDeterministicLlmStub({
    providerId: RESEARCH_ARTIFACT_PROVIDER_ID,
    model: RESEARCH_ARTIFACT_PROVIDER_MODEL,
    dispatchPlanModel: RESEARCH_ARTIFACT_PROVIDER_MODEL,
    dispatchPlan,
  });
  let runtimeRoot;
  let stack;
  let database;
  let proofResult;
  let primaryError;
  try {
    database = await createDisposablePostgresSchema(prerequisite.rawUrl);
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-async-gateway-postgres`);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl, {
      apiStyle: "openai-responses",
      providerId: RESEARCH_ARTIFACT_PROVIDER_ID,
      model: RESEARCH_ARTIFACT_PROVIDER_MODEL,
    });
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: false,
      gatewayMode: "built",
      processLogPrefix: PROCESS_LOG_PREFIX,
      gatewayEnvOmit: [...POSTGRES_RECOVERY_SCRUBBED_ENV_KEYS, GUARD_METRICS_ENV, GUARD_VIOLATIONS_ENV],
      gatewayEnv: buildAsyncGatewayProofEnv({
        scopedConnectionString: database.scopedConnectionString,
        metricsPath,
        violationsPath,
        guardPath,
        existingNodeOptions: environment.NODE_OPTIONS,
      }),
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-async-gateway-postgres");
    const permissionProfileId = await createResearchArtifactPermissionProfile(stack.gatewayUrl, correlationId);

    const results = [];
    let checkpointResult;
    for (let index = 1; index <= RESEARCH_ARTIFACT_TASK_COUNT; index += 1) {
      const taskCorrelationId = `${correlationId}-task-${index}`;
      const sessionId = await createResearchSession(stack.gatewayUrl, taskCorrelationId, index);
      let turn;
      if (index === CHECKPOINT_TASK_INDEX) {
        const dispatchCountBeforeTurn = stub.completionDispatches();
        const checkpointed = await runTurnWithCheckpoint({
          startTurn: () => sendResearchTurn(stack.gatewayUrl, sessionId, taskCorrelationId, permissionProfileId),
          waitForTurnActivity: () => stub.waitForCompletionDispatchCount(dispatchCountBeforeTurn + 1, 30_000),
          runCheckpoint: () => database.runCheckpoint(),
        });
        turn = checkpointed.turn;
        checkpointResult = checkpointed.checkpoint;
      } else {
        turn = await sendResearchTurn(stack.gatewayUrl, sessionId, taskCorrelationId, permissionProfileId);
      }
      const capabilityProfile = await readResearchTurnCapabilityProfile(
        stack.gatewayUrl,
        sessionId,
        turn.turnId,
        taskCorrelationId,
      );
      const validated = await validateResearchTurn({ turn, capabilityProfile, runtimeRoot, deckDir, index });
      results.push({
        sessionId,
        turnId: turn.turnId,
        checkpointConcurrent: index === CHECKPOINT_TASK_INDEX,
        ...validated,
      });
    }

    assert.equal(stub.dispatchPlanDispatches(), RESEARCH_ARTIFACT_TASK_COUNT * 2);
    assert.ok(checkpointResult?.durationMs >= 0, "the controlled PostgreSQL CHECKPOINT did not execute");
    await writeJson(checkpointPath, {
      schemaVersion: 1,
      taskIndex: CHECKPOINT_TASK_INDEX,
      startedAt: checkpointResult.startedAt,
      finishedAt: checkpointResult.finishedAt,
      durationMs: checkpointResult.durationMs,
      overlappedActiveTurn: true,
    });

    const metrics = await readGuardMetrics(metricsPath);
    const metricEvaluation = evaluateAsyncGatewayMetrics(metrics, { nowMs: Date.now() });
    assert.deepEqual(metricEvaluation.failures, [], metricEvaluation.failures.join("; "));
    assert.equal(
      await fileExists(violationsPath),
      false,
      "the Gateway main-thread Atomics.wait guard recorded a violation",
    );

    const gatewayStdoutPath = stack.gateway.stdoutPath;
    const gatewayStderrPath = stack.gateway.stderrPath;
    await stopVerificationStack(stack);
    stack = undefined;
    runtimeRoot = undefined;
    const runtimeLogEvaluation = evaluateRuntimeLogs(
      `${await readTextIfExists(gatewayStdoutPath)}\n${await readTextIfExists(gatewayStderrPath)}`,
    );
    assert.deepEqual(runtimeLogEvaluation.failures, [], runtimeLogEvaluation.failures.join("; "));

    const result = {
      schemaVersion: 1,
      prompt: RESEARCH_ARTIFACT_PROMPT,
      tasks: RESEARCH_ARTIFACT_TASK_COUNT,
      checkpointTaskIndex: CHECKPOINT_TASK_INDEX,
      checkpointDurationMs: checkpointResult.durationMs,
      presentationModuleBytes,
      providerDispatches: stub.dispatchPlanDispatches(),
      eventLoop: metricEvaluation.metrics,
      runtimeLogMatches: runtimeLogEvaluation.matches,
      results: results.map((item) => ({
        sessionId: item.sessionId,
        turnId: item.turnId,
        checkpointConcurrent: item.checkpointConcurrent,
        status: item.status,
        firstProviderInputTokens: item.firstProviderInputTokens,
        promptContextEstimatedTokens: item.promptContextEstimatedTokens,
        activatedSkillInstructionBytes: item.activatedSkillInstructionBytes,
        citations: item.citations,
        searchQuery: item.searchQuery,
        copiedDeckPath: item.copiedDeckPath,
        deckBytes: item.deckBytes,
        slideCount: item.slideCount,
      })),
    };
    await writeJson(resultPath, result);
    proofResult = {
      status: "passed",
      providerId: RESEARCH_ARTIFACT_PROVIDER_ID,
      modelId: RESEARCH_ARTIFACT_PROVIDER_MODEL,
      notes: [
        "The Gateway used the Promise-based PostgreSQL path in an isolated schema and a built runtime.",
        "Task 2 overlapped a real PostgreSQL CHECKPOINT while the deterministic provider held the turn open.",
        "The provider was deterministic and loopback-only; browser.search and presentations.create were real governed tools.",
      ],
      metrics: {
        livePostgresConfigured: true,
        tasksExecuted: results.length,
        checkpointExecuted: true,
        checkpointDurationMs: checkpointResult.durationMs,
        eventLoopP99Ms: metricEvaluation.metrics.p99Ms,
        eventLoopMaxMs: metricEvaluation.metrics.maxMs,
        atomicsWaitCalls: metricEvaluation.metrics.atomicsWaitCalls,
        maximumFirstProviderInputTokens: Math.max(...results.map((item) => item.firstProviderInputTokens)),
        maximumPromptContextEstimatedTokens: Math.max(...results.map((item) => item.promptContextEstimatedTokens)),
        maximumActivatedSkillInstructionBytes: Math.max(...results.map((item) => item.activatedSkillInstructionBytes)),
      },
      artifacts: {
        diagnostics: [
          relativeArtifact(context, resultPath),
          relativeArtifact(context, checkpointPath),
          relativeArtifact(context, gatewayStdoutPath),
          relativeArtifact(context, gatewayStderrPath),
          ...results.map((item) => relativeArtifact(context, item.copiedDeckPath)),
        ],
        screenshots: [],
        traces: [],
        logs: [relativeArtifact(context, gatewayStdoutPath), relativeArtifact(context, gatewayStderrPath)],
        perf: [relativeArtifact(context, metricsPath)],
        playwright: [],
      },
    };
  } catch (error) {
    primaryError = sanitizeAsyncGatewayProofError(error, prerequisite.sensitiveValues);
  }

  let cleanupError;
  try {
    await cleanupProofResources({ stack, runtimeRoot, stub, database });
  } catch (error) {
    cleanupError = sanitizeAsyncGatewayProofError(error, prerequisite.sensitiveValues);
  }
  if (primaryError && cleanupError) {
    throw new Error(`${primaryError.message}; cleanup also failed: ${cleanupError.message}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  assert.ok(proofResult, "async Gateway PostgreSQL proof produced no result");
  return proofResult;
}

export function resolveLivePostgresPrerequisite(environment = process.env) {
  const rawUrl = String(environment[POSTGRES_RECOVERY_URL_ENV] ?? "").trim();
  if (!rawUrl) return { configured: false };
  const parsed = parseLoopbackPostgresVerificationUrl(rawUrl);
  return {
    configured: true,
    rawUrl,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    sensitiveValues: parsed.sensitiveValues,
  };
}

export function buildScopedPostgresConnectionString(rawUrl, schemaName) {
  assert.match(schemaName, /^gc_async_gateway_[a-f0-9]+$/u, "unsafe disposable PostgreSQL schema name");
  const parsed = new URL(rawUrl);
  parsed.searchParams.set("options", `-c search_path=${schemaName}`);
  return parsed.toString();
}

export function buildGuardNodeOptions(existingNodeOptions, guardPath) {
  const existing = String(existingNodeOptions ?? "").trim();
  const requireOption = `--require=${JSON.stringify(path.resolve(guardPath))}`;
  return [existing, requireOption].filter(Boolean).join(" ");
}

export function buildAsyncGatewayProofEnv({
  scopedConnectionString,
  metricsPath,
  violationsPath,
  guardPath,
  existingNodeOptions,
}) {
  return {
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "true",
    GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS: "true",
    GOATCITADEL_DATABASE_DRIVER: "postgres",
    GOATCITADEL_POSTGRES_MODE: "managed",
    GOATCITADEL_POSTGRES_CONNECTION_STRING: scopedConnectionString,
    GOATCITADEL_POSTGRES_ASYNC_GATEWAY_ENABLED: "true",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
    [GUARD_METRICS_ENV]: metricsPath,
    [GUARD_VIOLATIONS_ENV]: violationsPath,
    [DETERMINISTIC_LLM_KEY_ENV]: "verification-fixture-key",
    NODE_OPTIONS: buildGuardNodeOptions(existingNodeOptions, guardPath),
  };
}

export async function createDisposablePostgresSchema(rawUrl, options = {}) {
  parseLoopbackPostgresVerificationUrl(rawUrl);
  const schemaName = `gc_async_gateway_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = `"${schemaName}"`;
  const poolFactory = options.poolFactory ?? defaultPostgresPoolFactory;
  const pool = await poolFactory(rawUrl);
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    created = true;
    return {
      schemaName,
      scopedConnectionString: buildScopedPostgresConnectionString(rawUrl, schemaName),
      async runCheckpoint() {
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        await pool.query("CHECKPOINT");
        return {
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
        };
      },
      async cleanup() {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await pool.end();
        }
      },
    };
  } catch (error) {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function runTurnWithCheckpoint({ startTurn, waitForTurnActivity, runCheckpoint }) {
  const turnPromise = Promise.resolve().then(startTurn);
  const checkpointPromise = (async () => {
    await waitForTurnActivity();
    return await runCheckpoint();
  })();
  const [turn, checkpoint] = await Promise.all([turnPromise, checkpointPromise]);
  return { turn, checkpoint };
}

export function evaluateAsyncGatewayMetrics(payload, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const p99Ms = Number(payload?.eventLoop?.p99Ms);
  const maxMs = Number(payload?.eventLoop?.maxMs);
  const atomicsWaitCalls = Number(payload?.atomicsWaitCalls);
  const updatedAtMs = Date.parse(String(payload?.updatedAt ?? ""));
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : Number.POSITIVE_INFINITY;
  const failures = [];
  if (payload?.guardActive !== true || payload?.mainThread !== true)
    failures.push("Gateway main-thread guard was not active");
  if (!Number.isFinite(p99Ms) || p99Ms >= EVENT_LOOP_P99_LIMIT_MS) {
    failures.push(`event-loop p99 must be below ${EVENT_LOOP_P99_LIMIT_MS}ms (received ${p99Ms})`);
  }
  if (!Number.isFinite(maxMs) || maxMs >= EVENT_LOOP_MAX_LIMIT_MS) {
    failures.push(`event-loop maximum must be below ${EVENT_LOOP_MAX_LIMIT_MS}ms (received ${maxMs})`);
  }
  if (!Number.isFinite(atomicsWaitCalls) || atomicsWaitCalls !== 0) {
    failures.push(`Gateway main-thread Atomics.wait calls must be zero (received ${atomicsWaitCalls})`);
  }
  if (ageMs > GUARD_METRICS_MAX_AGE_MS) {
    failures.push(`Gateway event-loop metrics are stale (${ageMs}ms old)`);
  }
  return { failures, metrics: { p99Ms, maxMs, atomicsWaitCalls, ageMs } };
}

export function evaluateRuntimeLogs(rawLog) {
  const patterns = [
    /stream interrupted/giu,
    /reconnecting to turn/giu,
    /repaired completion/giu,
    /provider request failed/giu,
    /chat completion timed out/giu,
  ];
  const matches = patterns.flatMap((pattern) => [...String(rawLog ?? "").matchAll(pattern)].map((match) => match[0]));
  return {
    matches,
    failures:
      matches.length > 0
        ? [`runtime logs contain reconnect, repair, failure, or timeout evidence: ${matches.join(", ")}`]
        : [],
  };
}

function buildDispatchPlan() {
  const plan = [];
  for (let index = 1; index <= RESEARCH_ARTIFACT_TASK_COUNT; index += 1) {
    plan.push(
      {
        type: "tool_call",
        name: "presentations_create",
        callId: `call_async_gateway_deck_${index}`,
        arguments: buildPresentationArgs(index),
        ...(index === CHECKPOINT_TASK_INDEX ? { delayMs: CHECKPOINT_PROVIDER_DELAY_MS } : {}),
      },
      {
        type: "success",
        replyText: `Research complete. I preserved the source citations and created funny-jokes-reliability-${index}.pptx.`,
      },
    );
  }
  return plan;
}

async function cleanupProofResources({ stack, runtimeRoot, stub, database }) {
  try {
    await stopVerificationStack(stack ?? (runtimeRoot ? { runtimeRoot } : undefined));
  } finally {
    try {
      await stub.close();
    } finally {
      await database?.cleanup();
    }
  }
}

async function defaultPostgresPoolFactory(connectionString) {
  const requireFromStorage = createRequire(path.join(repoRoot, "packages", "storage", "package.json"));
  const { Pool } = requireFromStorage("pg");
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  await pool.query("SELECT 1");
  return pool;
}

async function readGuardMetrics(filePath) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Gateway event-loop metrics were unavailable: ${lastError?.message ?? "unknown read failure"}`);
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function relativeArtifact(context, filePath) {
  return path.relative(context.artifactRoot, filePath).split(path.sep).join("/");
}

function emptyArtifacts() {
  return { diagnostics: [], screenshots: [], traces: [], logs: [], perf: [], playwright: [] };
}

export function sanitizeAsyncGatewayProofError(error, sensitiveValues) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSensitiveEvidence(message, sensitiveValues));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

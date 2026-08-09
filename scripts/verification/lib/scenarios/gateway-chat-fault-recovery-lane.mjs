import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopProcess,
  stopVerificationStack,
} from "../runtime.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./deterministic-llm-stub.mjs";

export const GATEWAY_CHAT_FAULT_SCENARIO_ID = "usability.gateway-chat-fault-recovery";
export const GATEWAY_CHAT_FAULT_ARTIFACT_NAME = "gateway-chat-fault-recovery-steps.json";
export const GATEWAY_CHAT_FAULT_GATEWAY_MODE = "built";
export const GATEWAY_CHAT_FAULT_STORAGE_MODES = Object.freeze(["sqlite", "postgres"]);
// The streaming secret projector intentionally retains an undecided lexical
// suffix until a safe delimiter or terminal event. Keep the trailing space so
// this fixture proves a publicly emitted delta before terminating the Gateway.
export const GATEWAY_CHAT_FAULT_RESTART_PREFIX = "STREAMING_BEFORE_RESTART ";

const JOURNEY_ID = "gateway-chat-fault-recovery";
const DEFECT_ID = "GC-USAB-002";
const PROVIDER_API_STYLE = "openai-responses";
const PROVIDER_ID = "openai";
const PROVIDER_MODEL = "gpt-5-verification";
const STREAM_IDLE_TIMEOUT_MS = 5_000;
const NEAR_EXPIRY_MARKER = "GC_USAB_NEAR_EXPIRY_4551";
const NEAR_EXPIRY_REMAINING_MS = 4_551;
const OFF_MODE_COMPLETION_TIMEOUT_MS = 90_000;
const NEAR_EXPIRY_CLOCK_ADVANCE_MS = OFF_MODE_COMPLETION_TIMEOUT_MS - NEAR_EXPIRY_REMAINING_MS;
const PRELOAD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "gateway-chat-fault-clock-preload.mjs");

const REPLIES = Object.freeze({
  transientRecovered: "SERVER_ERROR_RECOVERED",
  invalidAuthRecovered: "INVALID_AUTH_NEXT_TURN_OK",
  timeoutRecovered: "TIMEOUT_NEXT_TURN_OK",
  restartRecovered: "RESTART_NEXT_TURN_OK",
});

const PROMPTS = Object.freeze({
  transient: "Synthetic pre-output server error retry proof.",
  postOutput: "Synthetic post-output disconnect proof.",
  nearExpiry: `${NEAR_EXPIRY_MARKER} synthetic near-expiry retry budget proof.`,
  invalidAuth: "Synthetic invalid provider credential proof.",
  invalidAuthRecovery: "Synthetic next-turn admission proof after provider auth failure.",
  timeout: "Synthetic provider idle timeout proof.",
  timeoutRecovery: "Synthetic next-turn admission proof after provider timeout.",
  restartDuringStream: "Synthetic restart during an active provider stream proof.",
  restartRecovery: "Synthetic next-turn admission proof after streaming restart.",
});

/**
 * Verification-runner integration entrypoint. The usability lane can import
 * this function and call it alongside its other sub-lanes.
 */
export async function runGatewayChatFaultRecoveryLane(context, options = {}, deps = {}) {
  const runScenario = deps.runScenario;
  if (typeof runScenario !== "function") {
    return runGatewayChatFaultRecoveryJourney(context, options, deps);
  }
  return runScenario(
    context,
    {
      id: GATEWAY_CHAT_FAULT_SCENARIO_ID,
      lane: "usability",
      title: "Gateway Chat SSE transient-failure, deadline, and next-turn recovery proof",
      subsystem: "gateway-chat-reliability",
    },
    async ({ correlationId }) => runGatewayChatFaultRecoveryJourney(context, { ...options, correlationId }, deps),
  );
}

export function createGatewayChatFaultExecutionConfig(options = {}) {
  const storage = normalizeText(options.storage) ?? "sqlite";
  if (!GATEWAY_CHAT_FAULT_STORAGE_MODES.includes(storage)) {
    throw new Error(
      `unsupported Gateway Chat fault storage ${storage}; expected ${GATEWAY_CHAT_FAULT_STORAGE_MODES.join(" or ")}`,
    );
  }
  if (options.gatewayEnv !== undefined && (!options.gatewayEnv || typeof options.gatewayEnv !== "object")) {
    throw new TypeError("Gateway Chat fault gatewayEnv must be an object when provided");
  }
  const environment = options.environment ?? process.env;
  const gatewayEnv = {
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_STREAM_COALESCE_OFF: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
    GOATCITADEL_DEV_DIAGNOSTICS_BUFFER_SIZE: "5000",
    GOATCITADEL_VERIFY_FAULT_CLOCK_MARKER: NEAR_EXPIRY_MARKER,
    GOATCITADEL_VERIFY_FAULT_CLOCK_ADVANCE_MS: String(NEAR_EXPIRY_CLOCK_ADVANCE_MS),
    GOATCITADEL_VERIFY_FAULT_CLOCK_TARGET_PATH: "/v1/responses",
    NODE_OPTIONS: appendNodeImportOption(environment.NODE_OPTIONS, PRELOAD_PATH),
    [DETERMINISTIC_LLM_KEY_ENV]: "verification-fixture-key",
    ...(options.gatewayEnv ?? {}),
  };
  if (storage === "postgres") {
    assertManagedLoopbackPostgresGatewayEnv(gatewayEnv);
  }
  const scrubbedSecretEnvKeys = uniqueStrings([
    ...(options.secretEnvKeys ?? []),
    ...collectSensitiveEnvironmentKeys(environment),
  ]);
  const sensitiveValues = uniqueStrings(options.sensitiveValues ?? []);
  return {
    gatewayEnv,
    scrubbedSecretEnvKeys,
    sensitiveValues,
    storage,
    buildStackOptions(runtimeRoot, processLogPrefix) {
      return {
        runtimeRoot,
        includeUi: false,
        // This journey must kill the Gateway process itself. The dev supervisor
        // owns another child process, so killing only its launcher can leave the
        // active stream alive long enough to settle by its idle watchdog instead
        // of exercising boot-time interruption recovery.
        gatewayMode: GATEWAY_CHAT_FAULT_GATEWAY_MODE,
        processLogPrefix,
        gatewayEnvOmit: scrubbedSecretEnvKeys,
        gatewayEnv: { ...gatewayEnv },
      };
    },
  };
}

export function buildGatewayChatFaultNotes(storage) {
  if (!GATEWAY_CHAT_FAULT_STORAGE_MODES.includes(storage)) {
    throw new Error(`cannot build Gateway Chat fault notes for unsupported storage ${String(storage)}`);
  }
  const storageNote =
    storage === "postgres"
      ? "Every provider dispatch traversed the real Gateway Chat SSE and durable-turn path against isolated managed PostgreSQL state on a loopback-only verification fixture."
      : "Every provider dispatch traversed the real Gateway Chat SSE and durable-turn path against isolated SQLite state.";
  return [
    storageNote,
    "The restart scenario kills only its owned Gateway after a visible SSE delta, reopens the same isolated runtime root and storage fixture, and proves canonical interruption plus next-turn admission without provider replay.",
    "The 4551 ms edge uses a verification-only, stack-scoped clock preload; durable lease and persisted timestamp clocks are unchanged.",
    "No personal runtime root, provider credential, external channel, or external model endpoint was read or contacted.",
  ];
}

export function buildGatewayChatFaultArtifact(input) {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const providerDispatches = Array.isArray(input.providerDispatches) ? input.providerDispatches : [];
  const faultTargetDispatches = Array.isArray(input.faultTargetDispatches) ? input.faultTargetDispatches : [];
  const rawArtifact = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    journeyId: JOURNEY_ID,
    defectId: DEFECT_ID,
    baseSha: input.baseSha,
    environment: "isolated-source",
    storage: input.storage,
    provider: {
      providerId: input.providerId,
      model: input.modelId,
      apiStyle: PROVIDER_API_STYLE,
      transport: "loopback-fixture",
    },
    controls: {
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      nearExpiryRemainingBudgetMs: NEAR_EXPIRY_REMAINING_MS,
      nearExpiryClockAdvanceMs: NEAR_EXPIRY_CLOCK_ADVANCE_MS,
      personalRuntimeAccess: false,
      externalProviderAccess: false,
      scrubbedSecretEnvKeyCount: input.scrubbedSecretEnvKeyCount ?? 0,
    },
    summary: {
      status: input.terminalError ? "failed" : "passed",
      stepsPlanned: 9,
      stepsExecuted: steps.length,
      stepsPassed: steps.filter((step) => step.status === "passed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
      providerDispatches: providerDispatches.length,
      faultTargetDispatches: faultTargetDispatches.length,
      auxiliaryDispatches: providerDispatches.length - faultTargetDispatches.length,
    },
    steps,
    providerDispatches,
    faultTargetDispatches,
    gatewayDiagnostics: projectGatewayDiagnostics(input.gatewayDiagnostics ?? [], steps),
    error: input.terminalError
      ? input.terminalError instanceof Error
        ? input.terminalError.message
        : String(input.terminalError)
      : null,
  };
  return redactSensitiveEvidence(rawArtifact, input.sensitiveValues);
}

export function redactSensitiveEvidence(value, sensitiveValues = []) {
  const secrets = uniqueStrings(sensitiveValues).sort((left, right) => right.length - left.length);
  return redactEvidenceValue(value, secrets);
}

/**
 * Runs every fault against a real isolated Gateway process and the public Chat
 * SSE route. Provider I/O stays on the deterministic loopback stub.
 */
export async function runGatewayChatFaultRecoveryJourney(context, options = {}, deps = {}) {
  requireContext(context);
  const baseSha = normalizeText(options.baseSha) ?? "unknown";
  const artifactPath = path.join(context.artifactRoot, "diagnostics", GATEWAY_CHAT_FAULT_ARTIFACT_NAME);
  const steps = [];
  const executionConfig = createGatewayChatFaultExecutionConfig(options);
  const { scrubbedSecretEnvKeys, sensitiveValues, storage } = executionConfig;
  const startStack = deps.startVerificationStack ?? startVerificationStack;
  const recordStep = async (input) =>
    await runRecordedStep({
      ...input,
      baseSha,
      sensitiveValues,
      storage,
    });
  const stub = await startDeterministicLlmStub({
    providerId: PROVIDER_ID,
    model: PROVIDER_MODEL,
    dispatchPlanModel: PROVIDER_MODEL,
    dispatchPlan: [
      { type: "provider_error", code: "server_error", message: "Synthetic transient provider failure." },
      { type: "success", replyText: REPLIES.transientRecovered },
      { type: "stream_disconnect", emittedText: "SYNTHETIC_PARTIAL_OUTPUT" },
      { type: "provider_error", code: "server_error", message: "Synthetic near-expiry provider failure." },
      { type: "http_error", status: 401, code: "invalid_api_key", message: "Synthetic invalid credential." },
      { type: "success", replyText: REPLIES.invalidAuthRecovered },
      { type: "stream_stall" },
      { type: "stream_stall" },
      { type: "stream_stall" },
      { type: "success", replyText: REPLIES.timeoutRecovered },
      { type: "stream_stall", emittedText: GATEWAY_CHAT_FAULT_RESTART_PREFIX },
      { type: "success", replyText: REPLIES.restartRecovered },
    ],
  });
  let runtimeRoot;
  let stack;
  let terminalError;
  let gatewayDiagnostics = [];
  const gatewayProcessLogs = [];
  const correlationBase = normalizeText(options.correlationId) ?? `gateway-fault-${randomUUID()}`;

  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-gateway-chat-faults`);
    await configureVerificationAssistant(runtimeRoot);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl, {
      apiStyle: PROVIDER_API_STYLE,
      providerId: stub.providerId,
      model: stub.model,
    });
    stack = await startStack(context, executionConfig.buildStackOptions(runtimeRoot, "usability-gateway-faults"));
    gatewayProcessLogs.push(stack.gateway?.stdoutPath, stack.gateway?.stderrPath);
    await ensureOnboardingComplete(stack.gatewayUrl);

    await recordStep({
      steps,
      stepId: "pre-output-server-error-retry",
      expectedResult:
        "The exact provider-native server_error fails before output, retries once inside the shared deadline, and completes.",
      stub,
      stack,
      correlationId: `${correlationBase}-server-error`,
      expectedDispatches: 2,
      execute: async ({ correlationId }) => {
        const session = await createFixtureSession(stack.gatewayUrl, correlationId, "Server error retry");
        const turn = await sendFixtureTurn(stack.gatewayUrl, session.sessionId, PROMPTS.transient, correlationId);
        assertNoErrorChunk(turn, "pre-output server_error retry");
        assertCompletedReply(turn, REPLIES.transientRecovered, "pre-output server_error retry");
        return { sessionId: session.sessionId, turn };
      },
      assertDiagnostics: ({ diagnostic }) => {
        assertDiagnostic(diagnostic, {
          emittedOutput: false,
          failureClass: "transient",
          event: "chat.completion_stream.attempt_failed",
        });
      },
    });

    await recordStep({
      steps,
      stepId: "post-output-disconnect-no-replay",
      expectedResult:
        "A transient provider disconnect after visible output emits a terminal failure and is never replayed.",
      stub,
      stack,
      correlationId: `${correlationBase}-post-output`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const session = await createFixtureSession(stack.gatewayUrl, correlationId, "Post-output disconnect");
        const turn = await sendFixtureTurn(stack.gatewayUrl, session.sessionId, PROMPTS.postOutput, correlationId);
        if (!turn.chunks.some((chunk) => chunk.type === "delta" && Number(chunk.deltaBytes) > 0)) {
          throw new Error("post-output disconnect produced no visible Gateway delta");
        }
        assertErrorChunk(turn, "post-output disconnect");
        return { sessionId: session.sessionId, turn };
      },
      assertDiagnostics: ({ diagnostic }) => {
        assertDiagnostic(diagnostic, {
          emittedOutput: true,
          event: "chat.completion_stream.failed_after_emit",
        });
      },
    });

    await recordStep({
      steps,
      stepId: "near-expiry-4551-single-dispatch",
      expectedResult:
        "A pre-output server_error with at most 4551 ms left cannot fund backoff plus the five-second secondary window and dispatches once.",
      stub,
      stack,
      correlationId: `${correlationBase}-near-expiry`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const session = await createFixtureSession(stack.gatewayUrl, correlationId, "Near-expiry single dispatch");
        const turn = await sendFixtureTurn(stack.gatewayUrl, session.sessionId, PROMPTS.nearExpiry, correlationId);
        assertErrorChunk(turn, "near-expiry server_error");
        return { sessionId: session.sessionId, turn };
      },
      assertDiagnostics: ({ diagnostic }) => {
        assertDiagnostic(diagnostic, {
          emittedOutput: false,
          failureClass: "transient",
          event: "chat.completion_stream.failed",
        });
        const remainingBudgetMs = readFiniteNumber(diagnostic?.context?.remainingBudgetMs);
        if (remainingBudgetMs === undefined || remainingBudgetMs < 0 || remainingBudgetMs > NEAR_EXPIRY_REMAINING_MS) {
          throw new Error(`near-expiry remaining budget was ${String(remainingBudgetMs)}, expected 0..4551 ms`);
        }
      },
    });

    const invalidAuthSession = await createFixtureSession(
      stack.gatewayUrl,
      `${correlationBase}-invalid-auth-session`,
      "Invalid auth recovery",
    );
    await recordStep({
      steps,
      stepId: "invalid-credentials-terminal-failure",
      expectedResult: "Invalid provider credentials fail terminally without compatibility or transient replay.",
      stub,
      stack,
      correlationId: `${correlationBase}-invalid-auth`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const turn = await sendFixtureTurn(
          stack.gatewayUrl,
          invalidAuthSession.sessionId,
          PROMPTS.invalidAuth,
          correlationId,
        );
        assertErrorChunk(turn, "invalid provider credentials");
        return { sessionId: invalidAuthSession.sessionId, turn };
      },
      assertDiagnostics: ({ diagnostic }) => {
        assertDiagnostic(diagnostic, {
          emittedOutput: false,
          failureClass: "auth_denial",
          event: "chat.completion_stream.failed",
        });
      },
    });

    await recordStep({
      steps,
      stepId: "invalid-credentials-next-turn-admission",
      expectedResult:
        "The same session admits and completes the immediate next turn after terminal provider auth failure.",
      stub,
      stack,
      correlationId: `${correlationBase}-invalid-auth-next`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const turn = await sendFixtureTurn(
          stack.gatewayUrl,
          invalidAuthSession.sessionId,
          PROMPTS.invalidAuthRecovery,
          correlationId,
        );
        assertNoErrorChunk(turn, "invalid-auth next turn");
        assertCompletedReply(turn, REPLIES.invalidAuthRecovered, "invalid-auth next turn");
        return { sessionId: invalidAuthSession.sessionId, turn, recoveryOutcome: "next_turn_admitted" };
      },
    });

    const timeoutSession = await createFixtureSession(
      stack.gatewayUrl,
      `${correlationBase}-timeout-session`,
      "Provider timeout recovery",
    );
    await recordStep({
      steps,
      stepId: "provider-idle-timeout-terminal-failure",
      expectedResult:
        "A silent provider stream is bounded by the five-second watchdog and exhausts only the bounded transient retry count.",
      stub,
      stack,
      correlationId: `${correlationBase}-timeout`,
      expectedDispatches: 3,
      execute: async ({ correlationId }) => {
        const turn = await sendFixtureTurn(stack.gatewayUrl, timeoutSession.sessionId, PROMPTS.timeout, correlationId, {
          timeoutMs: 45_000,
        });
        assertErrorChunk(turn, "provider idle timeout");
        return { sessionId: timeoutSession.sessionId, turn };
      },
      assertDiagnostics: ({ diagnostic }) => {
        assertDiagnostic(diagnostic, {
          emittedOutput: false,
          event: "chat.completion_stream.failed",
        });
        if (!new Set(["transient", "unknown"]).has(diagnostic.context?.failureClass)) {
          throw new Error(`unexpected timeout provider failure class: ${String(diagnostic.context?.failureClass)}`);
        }
      },
    });

    await recordStep({
      steps,
      stepId: "provider-timeout-next-turn-admission",
      expectedResult: "The same session admits and completes the immediate next turn after terminal provider timeout.",
      stub,
      stack,
      correlationId: `${correlationBase}-timeout-next`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const turn = await sendFixtureTurn(
          stack.gatewayUrl,
          timeoutSession.sessionId,
          PROMPTS.timeoutRecovery,
          correlationId,
        );
        assertNoErrorChunk(turn, "timeout next turn");
        assertCompletedReply(turn, REPLIES.timeoutRecovered, "timeout next turn");
        return { sessionId: timeoutSession.sessionId, turn, recoveryOutcome: "next_turn_admitted" };
      },
    });

    const restartSession = await createFixtureSession(
      stack.gatewayUrl,
      `${correlationBase}-stream-restart-session`,
      "Streaming restart recovery",
    );
    await recordStep({
      steps,
      stepId: "restart-during-streaming-reconciles-canonical-turn",
      expectedResult:
        "After a visible provider delta, an owned Gateway restart preserves the partial prefix, marks the exact turn interrupted, and releases its durable admission without replay.",
      stub,
      stack,
      correlationId: `${correlationBase}-stream-restart`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const streaming = await startFixtureTurnUntilDelta(
          stack.gatewayUrl,
          restartSession.sessionId,
          PROMPTS.restartDuringStream,
          correlationId,
        );
        const beforeGatewayPid = stack.gateway?.child?.pid ?? null;
        const gatewayStopStartedAt = Date.now();
        await stopProcess(stack.gateway);
        const gatewayStopDurationMs = Date.now() - gatewayStopStartedAt;
        streaming.controller.abort();
        await streaming.reader.cancel().catch(() => undefined);
        if (gatewayStopDurationMs >= STREAM_IDLE_TIMEOUT_MS) {
          throw new Error(
            `owned Gateway process termination took ${gatewayStopDurationMs}ms and did not preempt the ${STREAM_IDLE_TIMEOUT_MS}ms provider idle watchdog`,
          );
        }

        const restarted = await startStack(
          context,
          executionConfig.buildStackOptions(stack.runtimeRoot, "usability-gateway-faults-restart"),
        );
        gatewayProcessLogs.push(restarted.gateway?.stdoutPath, restarted.gateway?.stderrPath);
        Object.assign(stack, restarted);
        await ensureOnboardingComplete(stack.gatewayUrl);
        const turn = await waitForInterruptedFixtureTurn(
          stack.gatewayUrl,
          restartSession.sessionId,
          streaming.turnId,
          correlationId,
        );
        turn.chunks = streaming.chunks;
        if (!turn.assistantContent.includes("STREAMING_BEFORE_RESTART")) {
          throw new Error("restart recovery did not retain the exact visible streaming prefix");
        }
        return {
          sessionId: restartSession.sessionId,
          turn,
          recoveryOutcome: "interrupted_by_restart",
          beforeGatewayPid,
          afterGatewayPid: stack.gateway?.child?.pid ?? null,
          gatewayStopDurationMs,
        };
      },
    });

    await recordStep({
      steps,
      stepId: "streaming-restart-next-turn-admission",
      expectedResult: "The restarted Gateway admits and completes the immediate next turn in the same session.",
      stub,
      stack,
      correlationId: `${correlationBase}-stream-restart-next`,
      expectedDispatches: 1,
      execute: async ({ correlationId }) => {
        const turn = await sendFixtureTurn(
          stack.gatewayUrl,
          restartSession.sessionId,
          PROMPTS.restartRecovery,
          correlationId,
        );
        assertNoErrorChunk(turn, "streaming-restart next turn");
        assertCompletedReply(turn, REPLIES.restartRecovered, "streaming-restart next turn");
        return { sessionId: restartSession.sessionId, turn, recoveryOutcome: "next_turn_admitted" };
      },
    });

    if (stub.dispatchPlanDispatches() !== 12) {
      throw new Error(
        `expected exactly 12 fault-target provider dispatches across the journey, received ${stub.dispatchPlanDispatches()}`,
      );
    }
  } catch (error) {
    terminalError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (stack) {
      gatewayDiagnostics = await fetchDiagnostics(stack.gatewayUrl).catch(() => []);
    }
    const artifact = buildGatewayChatFaultArtifact({
      baseSha,
      gatewayDiagnostics,
      providerId: stub.providerId,
      modelId: stub.model,
      providerDispatches: stub.completionDispatchRecords(),
      scrubbedSecretEnvKeyCount: scrubbedSecretEnvKeys.length,
      faultTargetDispatches: stub.dispatchPlanDispatchRecords(),
      sensitiveValues,
      steps,
      storage,
      terminalError,
    });
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    if (stack) await stopVerificationStack(stack).catch(() => undefined);
    else if (runtimeRoot) await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await stub.close().catch(() => undefined);
  }

  const diagnosticArtifact = relativeArtifact(context, artifactPath);
  const processLogs = uniqueStrings(gatewayProcessLogs)
    .filter(Boolean)
    .map((entry) => relativeArtifact(context, entry));
  return {
    status: terminalError ? "failed" : "passed",
    error: terminalError ? redactSensitiveEvidence(terminalError.message, sensitiveValues) : undefined,
    providerId: stub.providerId,
    modelId: stub.model,
    metrics: {
      baseSha,
      stepsPlanned: 9,
      stepsExecuted: steps.length,
      stepsPassed: steps.filter((step) => step.status === "passed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
      providerDispatches: stub.completionDispatches(),
      faultTargetDispatches: stub.dispatchPlanDispatches(),
      auxiliaryDispatches: stub.completionDispatches() - stub.dispatchPlanDispatches(),
      storage,
    },
    notes: buildGatewayChatFaultNotes(storage),
    artifacts: {
      diagnostics: [diagnosticArtifact],
      logs: processLogs,
      screenshots: [],
      traces: [],
      video: [],
    },
  };
}

async function runRecordedStep(input) {
  const startedAt = new Date().toISOString();
  const dispatchStart = input.stub.dispatchPlanDispatches();
  let execution;
  try {
    execution = await input.execute({ correlationId: input.correlationId });
    const requiresProviderFailureDiagnostic = typeof input.assertDiagnostics === "function";
    const diagnostics = await fetchStepDiagnostics(input.stack.gatewayUrl, input.correlationId, execution.sessionId, {
      requireProviderFailureDiagnostic: requiresProviderFailureDiagnostic,
    });
    const diagnostic = requiresProviderFailureDiagnostic ? selectProviderFailureDiagnostic(diagnostics) : undefined;
    input.assertDiagnostics?.({ diagnostic, diagnostics, execution });
    const dispatchCount = input.stub.dispatchPlanDispatches() - dispatchStart;
    if (dispatchCount !== input.expectedDispatches) {
      throw new Error(
        `${input.stepId} dispatched ${dispatchCount} provider requests; expected ${input.expectedDispatches}`,
      );
    }
    const correlation = resolveCorrelation(execution, diagnostic, input.correlationId);
    assertCompleteCorrelation(correlation);
    input.steps.push(
      buildStepRow(input, {
        status: "passed",
        actualResult: "passed",
        startedAt,
        dispatchCount,
        diagnostic,
        diagnostics,
        execution,
        correlation,
      }),
    );
    return execution;
  } catch (error) {
    const diagnostics = execution?.sessionId
      ? await fetchStepDiagnostics(input.stack.gatewayUrl, input.correlationId, execution.sessionId).catch(() => [])
      : [];
    const diagnostic = selectProviderFailureDiagnostic(diagnostics);
    input.steps.push(
      buildStepRow(input, {
        status: "failed",
        actualResult: redactSensitiveEvidence(
          error instanceof Error ? error.message : String(error),
          input.sensitiveValues,
        ),
        startedAt,
        dispatchCount: input.stub.dispatchPlanDispatches() - dispatchStart,
        diagnostic,
        diagnostics,
        execution,
        correlation: resolveCorrelation(execution, diagnostic, input.correlationId),
      }),
    );
    throw error;
  }
}

function buildStepRow(input, outcome) {
  const chunks = outcome.execution?.turn?.chunks ?? [];
  const failureClass = normalizeText(outcome.diagnostic?.context?.failureClass) ?? null;
  const emittedOutput =
    typeof outcome.diagnostic?.context?.emittedOutput === "boolean"
      ? outcome.diagnostic.context.emittedOutput
      : Boolean(outcome.execution?.turn?.chunks?.some((chunk) => chunk.type === "delta" && chunk.deltaBytes > 0));
  return {
    journeyId: JOURNEY_ID,
    stepId: input.stepId,
    baseSha: input.baseSha,
    environment: "isolated-source",
    storage: input.storage,
    profileState: "api-sse",
    viewport: null,
    theme: null,
    provider: input.stub.providerId,
    expectedResult: input.expectedResult,
    actualResult: outcome.actualResult,
    evidence: [GATEWAY_CHAT_FAULT_ARTIFACT_NAME],
    defectId: DEFECT_ID,
    skipReason: null,
    status: outcome.status,
    startedAt: outcome.startedAt,
    finishedAt: new Date().toISOString(),
    diagnostics: {
      providerDispatchCount: outcome.dispatchCount,
      emittedOutput,
      providerFailureClass: failureClass,
      remainingBudgetMs: readFiniteNumber(outcome.diagnostic?.context?.remainingBudgetMs) ?? null,
      recoveryOutcome:
        outcome.execution?.recoveryOutcome ??
        (chunks.some((chunk) => chunk.type === "error")
          ? "terminal_failure"
          : chunks.some((chunk) => chunk.type === "done")
            ? "completed"
            : "unknown"),
      correlation: outcome.correlation,
      diagnosticEvents: outcome.diagnostics.map((event) => event.event),
    },
  };
}

async function createFixtureSession(gatewayUrl, correlationId, titleSuffix) {
  const created = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
    method: "POST",
    headers: correlationHeaders(correlationId),
    body: { title: `Pre-QA fault fixture: ${titleSuffix}` },
  });
  assertResponseOk(created, "create Chat fault-fixture session");
  if (!normalizeText(created.body?.sessionId)) throw new Error("Chat session create returned no sessionId");
  const prefs = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(created.body.sessionId)}/prefs`,
    { headers: correlationHeaders(correlationId) },
  );
  assertResponseOk(prefs, "read Chat fault-fixture prefs");
  const patched = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(created.body.sessionId)}/prefs`,
    {
      method: "PATCH",
      headers: correlationHeaders(correlationId),
      body: {
        expectedRevision: prefs.body.revision,
        subagentPolicy: "off",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "off",
        toolAutonomy: "manual",
        orchestrationEnabled: false,
      },
    },
  );
  assertResponseOk(patched, "patch Chat fault-fixture prefs");
  return created.body;
}

async function sendFixtureTurn(gatewayUrl, sessionId, content, correlationId, options = {}) {
  const { admittedRequest, route } = await prepareFixtureTurnRequest(gatewayUrl, sessionId, content, correlationId);
  const timeoutMs = Number(options.timeoutMs ?? 60_000);
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: fixtureTurnHeaders(sessionId, correlationId),
    body: JSON.stringify(admittedRequest),
  });
  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Chat SSE request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const raw = await response.text();
  const chunks = parseGatewayChatSse(raw);
  const canonical = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
    { headers: correlationHeaders(correlationId) },
  );
  assertResponseOk(canonical, "canonical Chat fault-fixture thread");
  const turnId = chunks.find((chunk) => normalizeText(chunk.turnId))?.turnId;
  const canonicalTurn = Array.isArray(canonical.body?.turns)
    ? (canonical.body.turns.find((turn) => turn.turnId === turnId) ?? canonical.body.turns.at(-1))
    : undefined;
  if (!canonicalTurn || canonicalTurn.trace?.status === "running" || canonicalTurn.trace?.status === "queued") {
    throw new Error(
      `canonical Chat turn did not settle after SSE completion (${canonicalTurn?.trace?.status ?? "missing"})`,
    );
  }
  return projectCanonicalFixtureTurn(canonicalTurn, chunks);
}

async function startFixtureTurnUntilDelta(gatewayUrl, sessionId, content, correlationId) {
  const { admittedRequest, route } = await prepareFixtureTurnRequest(gatewayUrl, sessionId, content, correlationId);
  const controller = new AbortController();
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: "POST",
    signal: controller.signal,
    headers: fixtureTurnHeaders(sessionId, correlationId),
    body: JSON.stringify(admittedRequest),
  });
  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Chat streaming-restart request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let pending = "";
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const next = await readWithDeadline(reader, remainingMs);
      if (next.done) throw new Error("Gateway SSE closed before the streaming-restart delta was visible");
      pending += decoder.decode(next.value, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/u);
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        chunks.push(...parseGatewayChatSse(`${frame}\n\n`));
      }
      const delta = chunks.find((chunk) => chunk.type === "delta" && typeof chunk.delta === "string" && chunk.delta);
      if (!delta) continue;
      const turnId = normalizeText(delta.turnId);
      const runId = normalizeText(delta.runId);
      if (!turnId || !runId) throw new Error("streaming-restart delta omitted canonical turn/run correlation");
      return {
        controller,
        reader,
        turnId,
        runId,
        chunks: chunks.map(projectStreamChunk),
      };
    }
    throw new Error("Gateway SSE did not emit the streaming-restart delta before the deadline");
  } catch (error) {
    controller.abort();
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function waitForInterruptedFixtureTurn(gatewayUrl, sessionId, turnId, correlationId) {
  const deadline = Date.now() + 30_000;
  let observedStatus = "missing";
  while (Date.now() < deadline) {
    const canonical = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
      { headers: correlationHeaders(correlationId) },
    );
    assertResponseOk(canonical, "canonical streaming-restart Chat thread");
    const canonicalTurn = Array.isArray(canonical.body?.turns)
      ? canonical.body.turns.find((turn) => turn.turnId === turnId)
      : undefined;
    observedStatus = canonicalTurn?.trace?.status ?? "missing";
    if (canonicalTurn && observedStatus !== "running" && observedStatus !== "queued") {
      if (canonicalTurn.trace?.failure?.failureClass !== "interrupted_by_restart") {
        throw new Error(
          `streaming restart settled as ${observedStatus} with failureClass=${String(canonicalTurn.trace?.failure?.failureClass ?? "missing")} instead of interrupted_by_restart`,
        );
      }
      if (canonicalTurn.trace?.completion?.status !== "interrupted") {
        throw new Error(
          `streaming restart completion was ${String(canonicalTurn.trace?.completion?.status)}, expected interrupted`,
        );
      }
      return projectCanonicalFixtureTurn(canonicalTurn, []);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`streaming restart turn did not reconcile before deadline (status=${observedStatus})`);
}

async function prepareFixtureTurnRequest(gatewayUrl, sessionId, content, correlationId) {
  const request = {
    action: "send",
    content,
    providerId: PROVIDER_ID,
    model: PROVIDER_MODEL,
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    prefsOverride: {
      providerId: PROVIDER_ID,
      model: PROVIDER_MODEL,
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      orchestrationEnabled: false,
    },
  };
  const preflight = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`,
    { method: "POST", headers: correlationHeaders(correlationId), body: request },
  );
  assertResponseOk(preflight, "Chat fault-fixture route preflight");
  if (!preflight.body?.decision) throw new Error("Chat route preflight returned no decision");
  return {
    admittedRequest: {
      ...request,
      providerId: preflight.body.decision.effectiveProviderId,
      model: preflight.body.decision.effectiveModel,
      routeDecision: preflight.body.decision,
    },
    route: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`,
  };
}

function fixtureTurnHeaders(sessionId, correlationId) {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
    "x-goatcitadel-correlation-id": correlationId,
    "x-goatcitadel-session-id": sessionId,
  };
}

function projectCanonicalFixtureTurn(canonicalTurn, chunks) {
  return {
    chunks: chunks.map((chunk) => (chunk.deltaBytes === undefined ? projectStreamChunk(chunk) : chunk)),
    canonicalStatus: canonicalTurn.trace?.status,
    canonicalTurnId: canonicalTurn.turnId,
    canonicalRunId: canonicalTurn.trace?.durable?.runId,
    assistantContent:
      typeof canonicalTurn.assistantMessage?.content === "string" ? canonicalTurn.assistantMessage.content : "",
  };
}

async function readWithDeadline(reader, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Gateway SSE delta read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseGatewayChatSse(raw) {
  if (typeof raw !== "string") throw new TypeError("Gateway SSE payload must be a string");
  const chunks = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) chunks.push(parsed);
    } catch (error) {
      throw new Error(`Gateway SSE emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
  return chunks;
}

function projectStreamChunk(chunk) {
  return {
    type: normalizeText(chunk.type) ?? "unknown",
    eventId: normalizeText(chunk.eventId) ?? null,
    sequence: readFiniteNumber(chunk.sequence) ?? null,
    sessionId: normalizeText(chunk.sessionId) ?? null,
    turnId: normalizeText(chunk.turnId) ?? null,
    runId: normalizeText(chunk.runId) ?? null,
    messageId: normalizeText(chunk.messageId) ?? null,
    deltaBytes: typeof chunk.delta === "string" ? Buffer.byteLength(chunk.delta, "utf8") : 0,
  };
}

async function fetchStepDiagnostics(gatewayUrl, correlationId, sessionId, options = {}) {
  const requireProviderFailureDiagnostic = options.requireProviderFailureDiagnostic === true;
  const deadline = Date.now() + (requireProviderFailureDiagnostic ? 2_000 : 0);
  let observed = [];

  while (true) {
    const correlated = await requestJson(
      gatewayUrl,
      `/api/v1/dev/verification/diagnostics-snapshot?correlationId=${encodeURIComponent(correlationId)}&limit=500`,
    );
    assertResponseOk(correlated, "fault-step diagnostics snapshot");
    const correlatedItems = Array.isArray(correlated.body?.items) ? correlated.body.items : [];
    if (!requireProviderFailureDiagnostic) return correlatedItems;

    const all = await fetchDiagnostics(gatewayUrl);
    const sessionItems = all.filter((event) => event.sessionId === sessionId || event.context?.sessionId === sessionId);
    observed = mergeDiagnosticItems(correlatedItems, sessionItems);
    if (selectProviderFailureDiagnostic(observed) || Date.now() >= deadline) return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function mergeDiagnosticItems(primary, fallback) {
  const seen = new Set();
  return [...primary, ...fallback].filter((event) => {
    const key = normalizeText(event?.id) ?? JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchDiagnostics(gatewayUrl) {
  const response = await requestJson(gatewayUrl, "/api/v1/dev/verification/diagnostics-snapshot?limit=500");
  assertResponseOk(response, "Gateway diagnostics snapshot");
  return Array.isArray(response.body?.items) ? response.body.items : [];
}

function selectProviderFailureDiagnostic(diagnostics) {
  const terminalEvents = new Set([
    "chat.completion_stream.failed",
    "chat.completion_stream.failed_after_emit",
    "chat.completion_stream.attempt_failed",
  ]);
  return diagnostics.find((event) => terminalEvents.has(event.event));
}

function assertDiagnostic(diagnostic, expected) {
  if (!diagnostic) throw new Error(`missing ${expected.event} Gateway diagnostic`);
  if (expected.event && diagnostic.event !== expected.event) {
    throw new Error(`expected Gateway diagnostic ${expected.event}, received ${diagnostic.event}`);
  }
  if (typeof expected.emittedOutput === "boolean" && diagnostic.context?.emittedOutput !== expected.emittedOutput) {
    throw new Error(
      `expected emittedOutput=${expected.emittedOutput}, received ${String(diagnostic.context?.emittedOutput)}`,
    );
  }
  if (expected.failureClass && diagnostic.context?.failureClass !== expected.failureClass) {
    throw new Error(
      `expected provider failure class ${expected.failureClass}, received ${String(diagnostic.context?.failureClass)}`,
    );
  }
  const remainingBudgetMs = readFiniteNumber(diagnostic.context?.remainingBudgetMs);
  if (remainingBudgetMs === undefined) throw new Error("Gateway diagnostic omitted remainingBudgetMs");
  assertCompleteCorrelation(
    {
      sessionId: normalizeText(diagnostic.sessionId) ?? normalizeText(diagnostic.context?.sessionId) ?? null,
      turnId: normalizeText(diagnostic.turnId) ?? normalizeText(diagnostic.context?.turnId) ?? null,
      runId: normalizeText(diagnostic.runId) ?? normalizeText(diagnostic.context?.durableRunId) ?? null,
    },
    "provider-failure diagnostic",
  );
}

function assertErrorChunk(turn, label) {
  if (!turn.chunks.some((chunk) => chunk.type === "error")) {
    throw new Error(`${label} emitted no terminal error chunk`);
  }
}

function assertNoErrorChunk(turn, label) {
  if (turn.chunks.some((chunk) => chunk.type === "error")) {
    throw new Error(`${label} emitted an unexpected error chunk`);
  }
}

function assertCompletedReply(turn, expectedReply, label) {
  if (!turn.chunks.some((chunk) => chunk.type === "done")) {
    throw new Error(`${label} emitted no done chunk`);
  }
  if (turn.canonicalStatus !== "completed" || turn.assistantContent.trim() !== expectedReply) {
    throw new Error(`${label} did not persist the exact completed assistant reply`);
  }
}

function resolveCorrelation(execution, diagnostic, fallbackCorrelationId) {
  const turn = execution?.turn;
  return {
    correlationId: normalizeText(diagnostic?.correlationId) ?? fallbackCorrelationId,
    sessionId:
      normalizeText(diagnostic?.sessionId) ??
      normalizeText(diagnostic?.context?.sessionId) ??
      normalizeText(execution?.sessionId) ??
      null,
    turnId:
      normalizeText(diagnostic?.turnId) ??
      normalizeText(diagnostic?.context?.turnId) ??
      normalizeText(turn?.canonicalTurnId) ??
      null,
    runId:
      normalizeText(diagnostic?.runId) ??
      normalizeText(diagnostic?.context?.durableRunId) ??
      normalizeText(turn?.canonicalRunId) ??
      null,
  };
}

function assertCompleteCorrelation(correlation, owner = "Gateway journey") {
  if (!correlation.sessionId || !correlation.turnId || !correlation.runId) {
    throw new Error(`${owner} omitted canonical session/turn/run correlation`);
  }
}

function projectGatewayDiagnostics(diagnostics, steps) {
  const correlations = new Set(steps.map((step) => step.diagnostics?.correlation?.correlationId).filter(Boolean));
  return diagnostics
    .filter((event) => correlations.has(event.correlationId))
    .map((event) => ({
      timestamp: event.timestamp,
      level: event.level,
      category: event.category,
      event: event.event,
      correlationId: event.correlationId ?? null,
      sessionId: event.sessionId ?? event.context?.sessionId ?? null,
      turnId: event.turnId ?? event.context?.turnId ?? null,
      runId: event.runId ?? event.context?.durableRunId ?? null,
      providerId: event.providerId ?? null,
      modelId: event.modelId ?? null,
      runtimeStatus: event.runtimeStatus ?? null,
      runtimeError: event.runtimeError
        ? {
            name: event.runtimeError.name ?? null,
            code: event.runtimeError.code ?? null,
            retryable: event.runtimeError.retryable ?? null,
          }
        : null,
      context: {
        retryIndex: readFiniteNumber(event.context?.retryIndex) ?? null,
        transientRetryIndex: readFiniteNumber(event.context?.transientRetryIndex) ?? null,
        emittedOutput: typeof event.context?.emittedOutput === "boolean" ? event.context.emittedOutput : null,
        remainingBudgetMs: readFiniteNumber(event.context?.remainingBudgetMs) ?? null,
        failureClass: normalizeText(event.context?.failureClass) ?? null,
        retryCooldownExhausted:
          typeof event.context?.retryCooldownExhausted === "boolean" ? event.context.retryCooldownExhausted : null,
        operationKind: normalizeText(event.context?.operationKind) ?? null,
        transactionPosture: normalizeText(event.context?.transactionPosture) ?? null,
        sessionPosture: normalizeText(event.context?.sessionPosture) ?? null,
        storageWaitOutcome: normalizeText(event.context?.outcome) ?? null,
        storageWaitDurationMs:
          readFiniteNumber(event.durationMs) ?? readFiniteNumber(event.context?.durationMs) ?? null,
        storageWaitRollingCount: readFiniteNumber(event.context?.rollingCount) ?? null,
        storageWaitRollingP95Ms: readFiniteNumber(event.context?.rollingP95Ms) ?? null,
        storageWaitRollingMaxMs: readFiniteNumber(event.context?.rollingMaxMs) ?? null,
        idleWatchdogDisabled:
          typeof event.context?.idleWatchdogDisabled === "boolean" ? event.context.idleWatchdogDisabled : null,
        idleTimeoutMs: readFiniteNumber(event.context?.idleTimeoutMs) ?? null,
      },
    }));
}

export async function configureVerificationAssistant(runtimeRoot) {
  const configDir = path.join(runtimeRoot, "config");
  const unifiedPath = path.join(configDir, "goatcitadel.json");
  const unifiedSource = path.join(configDir, "goatcitadel.example.json");
  let unified;
  try {
    unified = JSON.parse(await fs.readFile(unifiedPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    unified = JSON.parse(await fs.readFile(unifiedSource, "utf8"));
  }
  if (!unified.assistant || typeof unified.assistant !== "object" || Array.isArray(unified.assistant)) {
    throw new Error("Gateway Chat fault fixture requires an authoritative assistant config object");
  }
  unified.assistant.streamIdleTimeoutMs = STREAM_IDLE_TIMEOUT_MS;
  // Boot seals the unified file and projects it into the compatibility files.
  // Clear the old seal whenever this isolated fixture changes authoritative data.
  delete unified.generation;
  await fs.writeFile(unifiedPath, `${JSON.stringify(unified, null, 2)}\n`, "utf8");

  const target = path.join(configDir, "assistant.config.json");
  const source = path.join(configDir, "assistant.config.example.json");
  let config;
  try {
    config = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    config = JSON.parse(await fs.readFile(source, "utf8"));
  }
  config.streamIdleTimeoutMs = STREAM_IDLE_TIMEOUT_MS;
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function ensureOnboardingComplete(gatewayUrl) {
  const deadline = Date.now() + 15_000;
  let current = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  while (current.status === 409 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  }
  assertResponseOk(current, "read onboarding state");
  if (current.body?.completed === true) return;
  const completed = await requestJson(gatewayUrl, "/api/v1/onboarding/complete", {
    method: "POST",
    body: { completedBy: "verification-gateway-chat-faults" },
  });
  assertResponseOk(completed, "complete onboarding");
}

function appendNodeImportOption(existing, preloadPath) {
  const importOption = `--import=${pathToFileURL(preloadPath).href}`;
  return [normalizeText(existing), importOption].filter(Boolean).join(" ");
}

function correlationHeaders(correlationId) {
  return { "x-goatcitadel-correlation-id": correlationId };
}

function assertResponseOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body ?? null)}`);
  }
}

function relativeArtifact(context, filePath) {
  return path.relative(context.artifactRoot, filePath).split(path.sep).join("/");
}

function collectSensitiveEnvironmentKeys(env) {
  const pattern = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSCODE|PRIVATE_KEY|CLIENT_SECRET)(?:$|_)/u;
  return Object.keys(env).filter((key) => pattern.test(key));
}

function assertManagedLoopbackPostgresGatewayEnv(gatewayEnv) {
  const host = normalizeText(gatewayEnv.GOATCITADEL_POSTGRES_HOST);
  const port = Number(gatewayEnv.GOATCITADEL_POSTGRES_PORT);
  const requiredText = [
    ["GOATCITADEL_POSTGRES_DATABASE", gatewayEnv.GOATCITADEL_POSTGRES_DATABASE],
    ["GOATCITADEL_POSTGRES_USER", gatewayEnv.GOATCITADEL_POSTGRES_USER],
    ["GOATCITADEL_POSTGRES_PASSWORD", gatewayEnv.GOATCITADEL_POSTGRES_PASSWORD],
  ];
  if (gatewayEnv.GOATCITADEL_DATABASE_DRIVER !== "postgres") {
    throw new Error("PostgreSQL Gateway fault verification requires GOATCITADEL_DATABASE_DRIVER=postgres");
  }
  if (gatewayEnv.GOATCITADEL_POSTGRES_MODE !== "managed") {
    throw new Error("PostgreSQL Gateway fault verification requires GOATCITADEL_POSTGRES_MODE=managed");
  }
  if (gatewayEnv.GOATCITADEL_BUNDLED_POSTGRES_ENABLED !== "false") {
    throw new Error("PostgreSQL Gateway fault verification requires GOATCITADEL_BUNDLED_POSTGRES_ENABLED=false");
  }
  if (gatewayEnv.GOATCITADEL_POSTGRES_CONNECTION_STRING !== undefined) {
    throw new Error("PostgreSQL Gateway fault verification must not pass the source URL to the Gateway process");
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("PostgreSQL Gateway fault verification requires an exact loopback database host");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PostgreSQL Gateway fault verification requires an explicit valid database port");
  }
  for (const [key, value] of requiredText) {
    if (!normalizeText(value)) throw new Error(`PostgreSQL Gateway fault verification requires ${key}`);
  }
}

function redactEvidenceValue(value, secrets) {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED_VERIFICATION_SECRET]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidenceValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEvidenceValue(item, secrets)]));
  }
  return value;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function normalizeText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readFiniteNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireContext(context) {
  if (!context || typeof context !== "object") throw new TypeError("verification context is required");
  if (!normalizeText(context.runId)) throw new TypeError("verification context.runId is required");
  if (!normalizeText(context.artifactRoot)) throw new TypeError("verification context.artifactRoot is required");
}

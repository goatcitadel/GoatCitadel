import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { NEXT_RELEASE_SURFACE_MANIFEST } from "../release-surface-manifest.mjs";
import { prepareVerificationRuntime, requestJson, stopVerificationStack } from "../runtime.mjs";
import {
  DETERMINISTIC_LLM_DEFAULT_REPLY,
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./deterministic-llm-stub.mjs";
import { readBrowserSseDiagnostics } from "./browser-helpers.mjs";
import {
  captureBrowserActionCheckpoint,
  discardBrowserVideo,
  emptyBrowserEvidenceArtifacts as emptyArtifacts,
  mergeBrowserEvidenceArtifacts as mergeArtifactSets,
  retainFailedBrowserVideo,
} from "./usability-browser-evidence.mjs";
import { BROWSER_ACTION_BUNDLES } from "./usability-browser-action-registry.mjs";

const PACKAGE_NAME = "@goatcitadel/mission-control-next";
const OPERATOR_TOKEN = "verification-usability-browser-actions-operator-token";
const ACTION_TIMEOUT_MS = 30_000;
const SSE_RECOVERY_WINDOW_MS = 5_000;
const EVENT_STREAM_PATH = "/api/v1/events/stream";
const CONNECTION_FAILED_CONSOLE_TEXT = "Failed to load resource: net::ERR_CONNECTION_FAILED";
const MAX_BROWSER_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const PROMPT_PACK_BENCHMARK_MODELS = Object.freeze(["verification-stub-chat", "verification-stub-chat-alt"]);
const PROMPT_PACK_BENCHMARK_JUDGE_RULE_ID = "prompt-pack-benchmark-judge";
const PROMPT_PACK_MEMORY_DISTILLER_RULE_ID = "prompt-pack-benchmark-memory-context-distillation";
const DEV_VERIFICATION_VAULT_KEY_ENV = "GOATCITADEL_VERIFY_VAULT_KEY_BASE64";
const DEV_VERIFICATION_VAULT_KEY = createHash("sha256")
  .update("goatcitadel-usability-vault-fixture-v1", "utf8")
  .digest("base64");
const CHAT_ATTACHMENT_EVIDENCE_URL = "https://fixture.example.invalid/usability-attachment-source";
const CHAT_ATTACHMENT_TURN_CONTENT = "Inspect deterministic image and audio attachments.";
const CHAT_ATTACHMENT_EXPECTATIONS = Object.freeze([
  Object.freeze({ fileName: "usability-image.png", mimeType: "image/png", mediaType: "image" }),
  Object.freeze({ fileName: "usability-audio.wav", mimeType: "audio/wav", mediaType: "audio" }),
]);
const CODE_MODE_HELPER_PROMPT = "Create a deterministic TypeScript helper snippet.";
const CODE_MODE_HELPER_SOURCE =
  'console.log("CHAT_CODE_MODE_STDOUT"); return { ok: true, marker: "CHAT_CODE_MODE_OK" };';
const CODE_MODE_HELPER_REPLY = ["Deterministic governed helper:", "", "```ts", CODE_MODE_HELPER_SOURCE, "```"].join(
  "\n",
);
const DELEGATION_OUTPUTS = Object.freeze([
  "Deterministic research handoff.",
  "Deterministic review handoff.",
  "Final deterministic delegation synthesis from both handoffs.",
]);

export function buildDelegationPromptReplyRules() {
  return [
    {
      ruleId: "delegation-researcher",
      userContentIncludes: "Assigned role: researcher",
      replyText: DELEGATION_OUTPUTS[0],
    },
    {
      ruleId: "delegation-reviewer",
      userContentIncludes: "Assigned role: reviewer",
      replyText: DELEGATION_OUTPUTS[1],
    },
    {
      ruleId: "delegation-synthesizer",
      userContentIncludes: "Assigned role: synthesizer",
      replyText: DELEGATION_OUTPUTS[2],
    },
  ];
}

export function buildPromptPackBenchmarkReplyRules() {
  return [
    {
      ruleId: PROMPT_PACK_BENCHMARK_JUDGE_RULE_ID,
      userContentIncludes: "Trace summary (metadata only):",
      replyText: JSON.stringify({
        routingScore: 2,
        honestyScore: 2,
        handoffScore: 2,
        robustnessScore: 2,
        usabilityScore: 2,
        rationale: "Deterministic benchmark judge fixture.",
      }),
    },
    {
      ruleId: PROMPT_PACK_MEMORY_DISTILLER_RULE_ID,
      systemContentIncludes:
        "You are a context distiller. Only use provided evidence. Return strict JSON. Never invent citations.",
      // Preserve the existing parse failure and deterministic memory fallback;
      // this rule adds purpose attribution without changing product behavior.
      replyText: DETERMINISTIC_LLM_DEFAULT_REPLY,
    },
  ];
}

export const USABILITY_BROWSER_ACTION_GATEWAY_ENV = Object.freeze({
  GOATCITADEL_AUTH_MODE: "token",
  GOATCITADEL_AUTH_TOKEN: OPERATOR_TOKEN,
  GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
  GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
  GOATCITADEL_FEATURE_CONNECTOR_DIAGNOSTICS_V1_ENABLED: "true",
  GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
  GOATCITADEL_DEV_DIAGNOSTICS: "true",
  [DEV_VERIFICATION_VAULT_KEY_ENV]: DEV_VERIFICATION_VAULT_KEY,
  [DETERMINISTIC_LLM_KEY_ENV]: "verification-stub-key",
});

export const USABILITY_LOCAL_MCP_POLICY = Object.freeze({
  // The fixture starts GoatCitadel's own Gateway-backed stdio proxy. MCP child
  // env remains deny-by-default; this one operator credential is explicit.
  allowedEnvKeys: Object.freeze(["GOATCITADEL_AUTH_TOKEN"]),
});

/**
 * Runs the semantic route/action inventory as actual Chromium operations. Every
 * route action has an exact step identity and retains a machine-readable action
 * log. A component/unit assertion cannot satisfy this lane.
 */
export async function runUsabilityBrowserActionLane(context, options = {}, deps) {
  const baseSha = requireText(options.baseSha, "baseSha");
  const requestedBundleIds = resolveRequestedBundleIds(options.browserActionBundleIds);
  const needsSettingsFixture =
    requestedBundleIds === null ||
    requestedBundleIds.has("settings-core-auth-provider") ||
    requestedBundleIds.has("settings-governance-runtime-integrations");
  const needsLibraryContentFixture = requestedBundleIds === null || requestedBundleIds.has("library-content");
  const needsChatCodeFixture = requestedBundleIds === null || requestedBundleIds.has("chat-agentic-durable-code");
  const stub = await startDeterministicLlmStub({
    replyText: "Verification stub reply.",
    expectedAuthorization: "Bearer verification-stub-key",
  });
  let settingsFixtureServer;
  let runtimeRoot;
  let stack;
  let browser;

  try {
    if (needsSettingsFixture) settingsFixtureServer = await startSettingsBrowserFixtureServer();
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-browser-actions`);
    const codeModeProject = needsChatCodeFixture ? await prepareCodeModeVerificationProject(runtimeRoot) : undefined;
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl);
    stack = await deps.startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      processLogPrefix: "usability-browser-actions",
      gatewayEnvOmit: options.secretEnvKeys,
      uiEnvOmit: options.secretEnvKeys,
      gatewayEnv: USABILITY_BROWSER_ACTION_GATEWAY_ENV,
    });
    await deps.ensureOnboardingComplete(stack.gatewayUrl, "verification-usability-browser-actions");
    const fixture = await deps.seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot });
    fixture.settings = needsSettingsFixture
      ? await seedSettingsBrowserActionFixture(stack.gatewayUrl, settingsFixtureServer.baseUrl, fixture.workspaceId)
      : {};
    fixture.settings.llmStubBaseUrl = stub.baseUrl;
    fixture.library = needsLibraryContentFixture
      ? await seedLibraryBrowserActionFixture(stack.gatewayUrl, fixture.workspaceId)
      : {};
    const session = await createActionSession(stack.gatewayUrl, fixture.workspaceId);
    fixture.actionSession = session;
    fixture.codeModeProject = codeModeProject;
    browser = await deps.chromium.launch({ headless: true });

    let opsFixtureSeeded = false;
    for (const [bundleId, registeredSteps] of Object.entries(BROWSER_ACTION_BUNDLES)) {
      if (requestedBundleIds && !requestedBundleIds.has(bundleId)) continue;
      const localSteps = registeredSteps.filter((entry) => !entry.external);
      if (localSteps.length === 0) continue;
      if (!opsFixtureSeeded && bundleId === "ops-governance-reliability") {
        await seedOpsBrowserActionFixture(stack.gatewayUrl, fixture);
        opsFixtureSeeded = true;
      }
      await runBrowserActionBundle(context, {
        baseSha,
        browser,
        bundleId,
        deps,
        fixture,
        registeredSteps: localSteps,
        sessionId: session.sessionId,
        stack,
        stub,
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (stack) await stopVerificationStack(stack);
    else if (runtimeRoot) await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    if (settingsFixtureServer) await settingsFixtureServer.close().catch(() => undefined);
    await stub.close().catch(() => undefined);
  }
}

async function runBrowserActionBundle(context, input) {
  return await input.deps.runScenario(
    context,
    {
      id: `usability.browser-actions.${input.bundleId}`,
      lane: "usability",
      title: `${input.bundleId} operator actions complete in Chromium`,
      subsystem: "usability-browser-actions",
    },
    async ({ correlationId }) => {
      const browserActionSteps = [];
      const diagnosticPath = path.join(
        context.artifactRoot,
        "diagnostics",
        `usability-browser-actions-${input.bundleId}.json`,
      );
      const diagnosticRef = input.deps.relativeToRun(context, diagnosticPath);
      const browserContext = await input.browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
        permissions: ["clipboard-read", "clipboard-write"],
        recordVideo: {
          dir: path.join(context.artifactRoot, "playwright"),
          size: { width: 1440, height: 1024 },
        },
      });
      await input.deps.installMissionControlNextBrowserState(
        browserContext,
        input.fixture.workspaceId,
        input.fixture.citadelId,
      );
      await installBrowserOperatorAuthState(browserContext);
      const page = await browserContext.newPage();
      const video = page.video?.() ?? null;
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      const browserLog = input.deps.attachBrowserLogging(page);
      const logCursor = browserLog.mark();
      const trace = await input.deps.startBrowserTrace(context, {
        page,
        slug: `usability-browser-actions-${input.bundleId}`,
      });
      let artifacts = emptyArtifacts();
      let terminalError;
      let browserConsoleEvidence = emptyBrowserConsoleEvidence();

      try {
        for (const registeredStep of input.registeredSteps) {
          const result = await executeBrowserActionStep({
            baseSha: input.baseSha,
            correlationId,
            diagnosticRef,
            deps: input.deps,
            fixture: input.fixture,
            page,
            registeredStep,
            sessionId: input.sessionId,
            stack: input.stack,
            stub: input.stub,
          });
          const checkpointRef = await captureBrowserActionCheckpoint(context, {
            bundleId: input.bundleId,
            page,
            stepId: registeredStep.stepId,
          });
          result.evidence = [...new Set([...(result.evidence ?? []), checkpointRef])];
          artifacts = mergeArtifactSets(artifacts, { screenshots: [checkpointRef] });
          browserActionSteps.push(result);
          if (result.status !== "passed") {
            throw new Error(`${registeredStep.stepId}: ${result.actualResult}`);
          }
        }
        const recoveryEvidence = await pollSseConnectionRecoveryEvidence({
          snapshot: browserLog.getSnapshot(logCursor),
          clientSseDiagnostics: await readBrowserSseDiagnostics(page),
          getSnapshot: () => browserLog.getSnapshot(logCursor),
          readClientSseDiagnostics: () => readBrowserSseDiagnostics(page),
        });
        const browserSnapshot = recoveryEvidence.snapshot;
        const clientSseDiagnostics = recoveryEvidence.clientSseDiagnostics;
        const filteredConsole = filterExpectedBrowserConsoleMessages(browserSnapshot, browserActionSteps, {
          clientSseDiagnostics,
          sseRecovery: recoveryEvidence.recovery,
        });
        browserConsoleEvidence = buildBrowserConsoleEvidence(
          filteredConsole,
          browserSnapshot,
          clientSseDiagnostics,
          recoveryEvidence,
        );
        input.deps.assertBrowserConsoleHealthy({ getSnapshot: () => filteredConsole.snapshot }, 0, PACKAGE_NAME);
        artifacts = mergeArtifactSets(
          artifacts,
          await input.deps.captureBrowserArtifacts(context, {
            slug: `usability-browser-actions-${input.bundleId}`,
            page,
            browserLog,
            gatewayUrl: input.stack.gatewayUrl,
            correlationId,
            logCursor,
          }),
        );
      } catch (error) {
        terminalError = error;
        artifacts = mergeArtifactSets(
          artifacts,
          await input.deps.captureBrowserArtifacts(context, {
            slug: `usability-browser-actions-${input.bundleId}-failure`,
            page,
            browserLog,
            gatewayUrl: input.stack.gatewayUrl,
            correlationId,
            logCursor,
          }),
        );
        const traceArtifact = await trace.retain().catch(() => null);
        artifacts = input.deps.appendTraceArtifact(artifacts, traceArtifact);
      } finally {
        await input.deps.writeJson(diagnosticPath, {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          baseSha: input.baseSha,
          bundleId: input.bundleId,
          browserConsoleEvidence,
          browserActionSteps,
        });
        artifacts = mergeArtifactSets(artifacts, { diagnostics: [diagnosticRef] });
        await trace.discard().catch(() => undefined);
        await browserContext.close().catch(() => undefined);
        if (terminalError) {
          const videoArtifact = await retainFailedBrowserVideo(context, {
            slug: `usability-browser-actions-${input.bundleId}`,
            video,
          }).catch(() => null);
          artifacts = mergeArtifactSets(artifacts, {
            playwright: videoArtifact ? [videoArtifact] : [],
          });
        } else {
          await discardBrowserVideo(video);
        }
      }

      return {
        status: terminalError ? "failed" : "passed",
        error: terminalError ? formatError(terminalError) : undefined,
        metrics: {
          baseSha: input.baseSha,
          stepsPlanned: input.registeredSteps.length,
          stepsExecuted: browserActionSteps.length,
          stepsPassed: browserActionSteps.filter((row) => row.status === "passed").length,
          stepsFailed: browserActionSteps.filter((row) => row.status !== "passed").length,
          browserConsoleEvidence,
          browserActionSteps,
        },
        artifacts,
      };
    },
  );
}

export function filterExpectedBrowserConsoleMessages(snapshot, browserActionSteps, options = {}) {
  const expectedRevisionConflictProbes = new Set([
    "note-revision-conflict",
    "project-revision-conflict",
    "settings-revision-conflict",
  ]);
  const expectedConflictCount = browserActionSteps
    .flatMap((step) => step.operatorActions ?? [])
    .filter(
      (action) =>
        action.kind === "canonical-api-probe" &&
        expectedRevisionConflictProbes.has(action.probe) &&
        action.status === 409,
    ).length;
  let remainingExpected = expectedConflictCount;
  let acknowledgedRevisionConflictCount = 0;
  let consoleMessages = (snapshot.consoleMessages ?? []).filter((message) => {
    if (remainingExpected > 0 && message.type === "error" && /status of 409 \(Conflict\)/iu.test(message.text ?? "")) {
      remainingExpected -= 1;
      acknowledgedRevisionConflictCount += 1;
      return false;
    }
    return true;
  });

  const sseRecovery =
    options.sseRecovery ??
    evaluateSseConnectionRecovery({ ...snapshot, consoleMessages }, options.clientSseDiagnostics);
  if (sseRecovery.acknowledged) {
    let remainingSseConsoleError = 1;
    consoleMessages = consoleMessages.filter((message) => {
      if (remainingSseConsoleError > 0 && message.type === "error" && message.text === CONNECTION_FAILED_CONSOLE_TEXT) {
        remainingSseConsoleError -= 1;
        return false;
      }
      return true;
    });
  }

  const acknowledgedSseRecoveryCount = sseRecovery.acknowledged ? 1 : 0;
  return {
    snapshot: { ...snapshot, consoleMessages },
    acknowledgedCount: acknowledgedRevisionConflictCount + acknowledgedSseRecoveryCount,
    acknowledgedRevisionConflictCount,
    acknowledgedSseRecoveryCount,
    sseRecovery,
  };
}

export function evaluateSseConnectionRecovery(snapshot, clientSseDiagnostics) {
  const exactConsoleErrors = (snapshot.consoleMessages ?? []).filter(
    (message) => message.type === "error" && message.text === CONNECTION_FAILED_CONSOLE_TEXT,
  );
  const requestFailures = snapshot.eventStreamRequestFailures ?? [];
  const responses = snapshot.eventStreamResponses ?? [];
  const diagnostics = clientSseDiagnostics?.records ?? [];
  const rejectionReason = (() => {
    if (exactConsoleErrors.length !== 1) return "requires exactly one matching console error";
    if (snapshot.eventStreamEvidenceTruncated === true) return "event-stream evidence was truncated";
    if (requestFailures.length !== 1) return "requires exactly one matching request failure";
    const failedUrl = requestFailures[0]?.url;
    if (failedUrl !== EVENT_STREAM_PATH) return "request failure URL did not match the event stream";
    if (requestFailures[0]?.errorText !== "net::ERR_CONNECTION_FAILED") {
      return "request failure class did not match ERR_CONNECTION_FAILED";
    }
    if (clientSseDiagnostics?.available !== true) return "client SSE diagnostics were unavailable";
    return undefined;
  })();
  if (rejectionReason) {
    return {
      acknowledged: false,
      reason: rejectionReason,
      requestFailureCount: requestFailures.length,
      responseCount: responses.length,
      clientDiagnosticCount: diagnostics.length,
    };
  }

  const failedAtMs = parseEvidenceTimestamp(requestFailures[0].timestamp);
  if (failedAtMs === undefined) {
    return rejectedSseRecovery("request failure timestamp was invalid", requestFailures, responses, diagnostics);
  }
  const response = responses
    .filter((record) => record?.url === EVENT_STREAM_PATH && record?.status === 200)
    .map((record) => ({ record, timestampMs: parseEvidenceTimestamp(record.timestamp) }))
    .filter(
      (candidate) =>
        candidate.timestampMs !== undefined &&
        candidate.timestampMs > failedAtMs &&
        candidate.timestampMs - failedAtMs <= SSE_RECOVERY_WINDOW_MS,
    )
    .sort((left, right) => left.timestampMs - right.timestampMs)[0];
  if (!response) {
    return rejectedSseRecovery(
      "no later 200 event-stream response arrived within 5 seconds",
      requestFailures,
      responses,
      diagnostics,
    );
  }
  const clientOpen = diagnostics
    .filter((record) => record?.category === "sse" && record?.event === "open")
    .map((record) => ({ record, timestampMs: parseEvidenceTimestamp(record.timestamp) }))
    .filter(
      (candidate) =>
        candidate.timestampMs !== undefined &&
        candidate.timestampMs >= response.timestampMs &&
        candidate.timestampMs - failedAtMs <= SSE_RECOVERY_WINDOW_MS,
    )
    .sort((left, right) => left.timestampMs - right.timestampMs)[0];
  if (!clientOpen) {
    return rejectedSseRecovery(
      "no later client SSE open diagnostic arrived within 5 seconds",
      requestFailures,
      responses,
      diagnostics,
    );
  }

  return {
    acknowledged: true,
    reason: "single event-stream connection failure recovered with a 200 response and client SSE open diagnostic",
    failedUrl: EVENT_STREAM_PATH,
    failureTimestamp: requestFailures[0].timestamp,
    responseTimestamp: response.record.timestamp,
    clientOpenTimestamp: clientOpen.record.timestamp,
    recoveryMs: clientOpen.timestampMs - failedAtMs,
    requestFailureCount: requestFailures.length,
    responseCount: responses.length,
    clientDiagnosticCount: diagnostics.length,
  };
}

export async function pollSseConnectionRecoveryEvidence(input) {
  let snapshot = input.snapshot;
  let clientSseDiagnostics = input.clientSseDiagnostics;
  let recovery = evaluateSseConnectionRecovery(snapshot, clientSseDiagnostics);
  if (!isPollableSseRecoveryCandidate(snapshot, clientSseDiagnostics)) {
    return { snapshot, clientSseDiagnostics, recovery, pollCount: 0 };
  }

  const failedAtMs = parseEvidenceTimestamp(snapshot.eventStreamRequestFailures[0]?.timestamp);
  if (failedAtMs === undefined) {
    return { snapshot, clientSseDiagnostics, recovery, pollCount: 0 };
  }
  const deadlineMs = failedAtMs + SSE_RECOVERY_WINDOW_MS;
  const now = input.now ?? Date.now;
  const wait = input.wait ?? waitForSseRecoveryPoll;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const maxPollCount = Math.ceil(SSE_RECOVERY_WINDOW_MS / Math.max(1, pollIntervalMs)) + 1;
  let pollCount = 0;

  while (now() < deadlineMs && pollCount < maxPollCount) {
    await wait(Math.min(pollIntervalMs, Math.max(1, deadlineMs - now())));
    pollCount += 1;
    snapshot = input.getSnapshot();
    clientSseDiagnostics = await input.readClientSseDiagnostics();
    recovery = evaluateSseConnectionRecovery(snapshot, clientSseDiagnostics);
    if (!isPollableSseRecoveryCandidate(snapshot, clientSseDiagnostics)) {
      break;
    }
  }

  // A recovery acknowledgement is only stable after one last synchronous log
  // read at the bounded deadline. This closes the gap between the last async
  // diagnostics read and return, where a second request failure could arrive.
  snapshot = input.getSnapshot();
  recovery = evaluateSseConnectionRecovery(snapshot, clientSseDiagnostics);
  const stabilityWindowCompleted = now() >= deadlineMs;
  if (recovery.acknowledged && !stabilityWindowCompleted) {
    recovery = {
      ...recovery,
      acknowledged: false,
      reason: "event-stream recovery stability window did not complete",
    };
  }

  return {
    snapshot,
    clientSseDiagnostics,
    recovery,
    pollCount,
    stabilityDeadlineTimestamp: new Date(deadlineMs).toISOString(),
    stabilityWindowCompleted,
  };
}

function isPollableSseRecoveryCandidate(snapshot, clientSseDiagnostics) {
  const exactConsoleErrors = (snapshot.consoleMessages ?? []).filter(
    (message) => message.type === "error" && message.text === CONNECTION_FAILED_CONSOLE_TEXT,
  );
  const requestFailures = snapshot.eventStreamRequestFailures ?? [];
  return (
    exactConsoleErrors.length === 1 &&
    snapshot.eventStreamEvidenceTruncated !== true &&
    requestFailures.length === 1 &&
    requestFailures[0]?.url === EVENT_STREAM_PATH &&
    requestFailures[0]?.errorText === "net::ERR_CONNECTION_FAILED" &&
    clientSseDiagnostics?.available === true
  );
}

async function waitForSseRecoveryPoll(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rejectedSseRecovery(reason, requestFailures, responses, diagnostics) {
  return {
    acknowledged: false,
    reason,
    requestFailureCount: requestFailures.length,
    responseCount: responses.length,
    clientDiagnosticCount: diagnostics.length,
  };
}

function parseEvidenceTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyBrowserConsoleEvidence() {
  return {
    acknowledgedCount: 0,
    acknowledgedRevisionConflictCount: 0,
    acknowledgedSseRecoveryCount: 0,
    eventStreamRequestFailureCount: 0,
    eventStreamResponseCount: 0,
    eventStreamEvidenceTruncated: false,
    clientSseDiagnosticsAvailable: false,
    clientSseDiagnosticCount: 0,
    sseRecoveryPollCount: 0,
    sseRecoveryStabilityDeadline: undefined,
    sseRecoveryStabilityWindowCompleted: false,
  };
}

function buildBrowserConsoleEvidence(filteredConsole, snapshot, clientSseDiagnostics, recoveryEvidence) {
  return {
    acknowledgedCount: filteredConsole.acknowledgedCount,
    acknowledgedRevisionConflictCount: filteredConsole.acknowledgedRevisionConflictCount,
    acknowledgedSseRecoveryCount: filteredConsole.acknowledgedSseRecoveryCount,
    eventStreamRequestFailureCount: (snapshot.eventStreamRequestFailures ?? []).length,
    eventStreamResponseCount: (snapshot.eventStreamResponses ?? []).length,
    eventStreamEvidenceTruncated: snapshot.eventStreamEvidenceTruncated === true,
    clientSseDiagnosticsAvailable: clientSseDiagnostics?.available === true,
    clientSseDiagnosticCount: (clientSseDiagnostics?.records ?? []).length,
    sseRecoveryPollCount: recoveryEvidence.pollCount,
    sseRecoveryStabilityDeadline: recoveryEvidence.stabilityDeadlineTimestamp,
    sseRecoveryStabilityWindowCompleted: recoveryEvidence.stabilityWindowCompleted ?? false,
    sseRecovery: filteredConsole.sseRecovery,
  };
}

async function executeBrowserActionStep(input) {
  const startedAt = new Date().toISOString();
  const operatorActions = [];
  try {
    const route = NEXT_RELEASE_SURFACE_MANIFEST.find((candidate) => candidate.slug === input.registeredStep.routeSlug);
    if (!route) throw new Error(`release route ${input.registeredStep.routeSlug} is not registered`);
    const params = new URLSearchParams({ theme: "dark" });
    if (route.slug === "chat") params.set("sessionId", input.sessionId);
    const routeHref = `${route.href}${route.href.includes("?") ? "&" : "?"}${params.toString()}`;
    await input.page.goto(input.deps.buildVerificationUiUrl(input.stack.uiUrl, routeHref), {
      waitUntil: "domcontentloaded",
    });
    await input.deps.waitForVerificationRouteReady(input.page, route, PACKAGE_NAME);
    await input.deps.setBrowserCorrelation(input.page, input.correlationId, input.sessionId);

    const operationState = {
      correlationId: input.correlationId,
      deps: input.deps,
      fixture: input.fixture,
      gatewayUrl: input.stack.gatewayUrl,
      route,
      sessionId: input.sessionId,
      stub: input.stub,
      uiUrl: input.stack.uiUrl,
    };
    for (const operation of input.registeredStep.operations) {
      const action = await executeOperation(input.page, operation, operationState);
      if (action) operatorActions.push(action);
    }

    if (operatorActions.length === 0) throw new Error("step performed no interactive or canonical API action");
    return browserStepResult(input, {
      startedAt,
      operatorActions,
      status: "passed",
      actualResult: "All registered Chromium operations completed against the isolated Gateway.",
    });
  } catch (error) {
    return browserStepResult(input, {
      startedAt,
      operatorActions,
      status: "failed",
      actualResult: formatError(error),
    });
  }
}

async function executeOperation(page, operation, state) {
  switch (operation.kind) {
    case "click": {
      const locator = await interactiveLocator(page, operation.name, operation.exact === true);
      const capture = operation.captureJsonResponse;
      if (!capture) {
        await locator.click();
        return { kind: "click", accessibleName: operation.name };
      }
      const pathPattern = compileBrowserEvidencePattern(capture.pathPattern, "captured response path");
      const matchesResponse = (candidate) => {
        let pathname;
        try {
          pathname = new URL(candidate.url()).pathname;
        } catch {
          return false;
        }
        return candidate.request().method() === capture.method && pathPattern.test(pathname);
      };
      const matchingResponses = [];
      const responseListener = (candidate) => {
        if (matchesResponse(candidate)) matchingResponses.push(candidate);
      };
      page.on("response", responseListener);
      let response;
      try {
        [response] = await Promise.all([
          page.waitForResponse(matchesResponse, { timeout: operation.timeoutMs ?? ACTION_TIMEOUT_MS }),
          locator.click(),
        ]);
      } catch (error) {
        page.off("response", responseListener);
        throw error;
      }
      if (response.status() !== capture.status) {
        page.off("response", responseListener);
        throw new Error(
          `captured response for ${operation.name} returned ${response.status()}, expected ${capture.status}`,
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        page.off("response", responseListener);
        throw new Error(
          `captured response for ${operation.name} was not JSON: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const value = payload?.[capture.field];
      const valuePattern = compileBrowserEvidencePattern(capture.valuePattern, "captured response value");
      if (typeof value !== "string" || !valuePattern.test(value)) {
        page.off("response", responseListener);
        throw new Error(
          `captured response for ${operation.name} has invalid ${capture.field}: ${JSON.stringify(value)}`,
        );
      }
      let requestBody;
      try {
        requestBody = response.request().postDataJSON();
      } catch (error) {
        page.off("response", responseListener);
        throw new Error(
          `captured response for ${operation.name} has no JSON request body: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (capture.expectedBody !== undefined && !isDeepStrictEqual(requestBody, capture.expectedBody)) {
        page.off("response", responseListener);
        throw new Error(`captured request for ${operation.name} drifted: ${JSON.stringify(requestBody)}`);
      }
      state.capturedJsonResponses ??= {};
      const existing = state.capturedJsonResponses[capture.stateKey];
      if (existing !== undefined && existing.value !== value) {
        page.off("response", responseListener);
        throw new Error(`captured response state ${capture.stateKey} changed identity within the browser run`);
      }
      const requestPath = new URL(response.url()).pathname;
      state.capturedJsonResponses[capture.stateKey] = {
        value,
        requestPath,
        requestBody,
        matchingResponses,
        dispose: () => page.off("response", responseListener),
      };
      return {
        kind: "click",
        accessibleName: operation.name,
        capturedResponse: { status: response.status(), field: capture.field, value, requestPath, requestBody },
      };
    }
    case "click-pattern": {
      const locator = await interactiveLocator(page, operation.namePattern, false);
      await locator.click();
      return { kind: "click", accessibleNamePattern: operation.namePattern };
    }
    case "focus": {
      const locator = await interactiveLocator(page, operation.name, operation.exact === true);
      await locator.focus();
      const focused = await locator.evaluate((element) => element === document.activeElement).catch(() => false);
      if (!focused) throw new Error(`interactive control did not retain focus: ${operation.name}`);
      return { kind: "focus", accessibleName: operation.name };
    }
    case "hover": {
      const locator = await interactiveLocator(page, operation.name, operation.exact === true);
      await locator.hover();
      return { kind: "hover", accessibleName: operation.name };
    }
    case "wait-enabled": {
      const locator = await interactiveLocator(page, operation.name, operation.exact === true);
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await locator.isEnabled().catch(() => false)) {
          return { kind: "wait-enabled", accessibleName: operation.name };
        }
        await page.waitForTimeout(50);
      }
      throw new Error(`interactive control did not become enabled: ${operation.name}`);
    }
    case "confirm": {
      const dialog = page.getByRole("dialog").last();
      const locator = await firstVisibleLocator(
        page,
        dialog.getByRole("button", { name: operation.name, exact: true }),
        `modal confirmation control not found: ${operation.name}`,
      );
      await locator.click();
      return { kind: "confirm", accessibleName: operation.name };
    }
    case "fill": {
      const locator = await editableLocator(page, operation.label);
      await locator.fill(operation.value);
      return { kind: "fill", accessibleName: operation.label, value: redactFixtureValue(operation.value) };
    }
    case "select": {
      const locator = await editableLocator(page, operation.label);
      const options = await locator
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ label: node.textContent?.trim() ?? "", value: node.getAttribute("value") ?? "" })),
        );
      const selected = resolveSelectOption(options, operation);
      if (!selected) {
        throw new Error(
          `select option not found for ${operation.label}: ${operation.value ?? operation.optionLabel ?? operation.option ?? "missing selector"}`,
        );
      }
      await locator.selectOption(selected.value);
      return {
        kind: "select",
        accessibleName: operation.label,
        optionLabel: selected.label,
        value: selected.value,
      };
    }
    case "fixture-session": {
      const fixtureSessionId = state.fixture.sessions?.[operation.sessionKey];
      if (typeof fixtureSessionId !== "string" || !fixtureSessionId) {
        throw new Error(`fixture session is unavailable: ${operation.sessionKey}`);
      }
      const params = new URLSearchParams({ theme: "dark", sessionId: fixtureSessionId });
      const routeHref = `${state.route.href}${state.route.href.includes("?") ? "&" : "?"}${params.toString()}`;
      await page.goto(state.deps.buildVerificationUiUrl(state.uiUrl, routeHref), { waitUntil: "domcontentloaded" });
      await state.deps.waitForVerificationRouteReady(page, state.route, PACKAGE_NAME);
      await state.deps.setBrowserCorrelation(page, state.correlationId, fixtureSessionId);
      state.sessionId = fixtureSessionId;
      return { kind: "fixture-session", sessionKey: operation.sessionKey, sessionId: fixtureSessionId };
    }
    case "reload": {
      await page.reload({ waitUntil: "domcontentloaded" });
      await state.deps.waitForVerificationRouteReady(page, state.route, PACKAGE_NAME);
      await state.deps.setBrowserCorrelation(page, state.correlationId, state.sessionId);
      return { kind: "reload", route: state.route.href, sessionId: state.sessionId };
    }
    case "check-pattern": {
      const expression = new RegExp(escapeRegExp(operation.namePattern), "iu");
      const checkbox = await firstVisibleLocator(
        page,
        page.getByRole("checkbox", { name: expression }),
        `checkbox not found: ${operation.namePattern}`,
      );
      await checkbox.check();
      return { kind: "check", accessibleNamePattern: operation.namePattern };
    }
    case "uncheck-pattern": {
      const expression = new RegExp(escapeRegExp(operation.namePattern), "iu");
      const checkbox = await firstVisibleLocator(
        page,
        page.getByRole("checkbox", { name: expression }),
        `checkbox not found: ${operation.namePattern}`,
      );
      await checkbox.uncheck();
      return { kind: "uncheck", accessibleNamePattern: operation.namePattern };
    }
    case "assert-checked": {
      if (typeof operation.checked !== "boolean") {
        throw new Error(`checkbox assertion requires a boolean state: ${operation.namePattern}`);
      }
      const expression = new RegExp(escapeRegExp(operation.namePattern), "iu");
      const checkbox = await firstVisibleLocator(
        page,
        page.getByRole("checkbox", { name: expression }),
        `checkbox not found: ${operation.namePattern}`,
      );
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const actual = await checkbox.isChecked().catch(() => undefined);
        if (actual === operation.checked) {
          return {
            kind: "assert-checked",
            accessibleNamePattern: operation.namePattern,
            checked: operation.checked,
          };
        }
        await page.waitForTimeout(50);
      }
      throw new Error(`checkbox state not found: ${operation.namePattern}=${String(operation.checked)}`);
    }
    case "file": {
      const chooser = page.getByLabel(operation.name, { exact: true }).first();
      if ((await chooser.count()) === 0) throw new Error(`file input not found: ${operation.name}`);
      const buffer = decodeBrowserFixtureFile(operation);
      await chooser.setInputFiles({
        name: operation.fileName,
        mimeType: operation.mimeType,
        buffer,
      });
      return {
        kind: "file",
        accessibleName: operation.name,
        fileName: operation.fileName,
        mimeType: operation.mimeType,
        sizeBytes: buffer.length,
      };
    }
    case "assert-image-loaded": {
      const image = await firstVisibleLocator(
        page,
        page.getByRole("img", { name: operation.name, exact: true }),
        `image preview not found: ${operation.name}`,
      );
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const dimensions = await image
          .evaluate((element) => {
            const candidate = element;
            const ImageElement = candidate.ownerDocument.defaultView?.HTMLImageElement;
            return ImageElement && candidate instanceof ImageElement && candidate.complete
              ? { width: candidate.naturalWidth, height: candidate.naturalHeight }
              : null;
          })
          .catch(() => null);
        if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
          return { kind: "assert-image-loaded", accessibleName: operation.name, ...dimensions };
        }
        await page.waitForTimeout(50);
      }
      throw new Error(`image preview did not load: ${operation.name}`);
    }
    case "download": {
      const locator = await interactiveLocator(page, operation.name, operation.exact === true);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: ACTION_TIMEOUT_MS }),
        locator.click(),
      ]);
      try {
        const failure = await download.failure();
        if (failure) throw new Error(`browser download failed for ${operation.name}: ${failure}`);
        const downloadedPath = await download.path();
        if (!downloadedPath) throw new Error(`browser download returned no local path for ${operation.name}`);
        const downloadedStat = await fs.stat(downloadedPath);
        if (!downloadedStat.isFile())
          throw new Error(`browser download returned a non-file path for ${operation.name}`);
        if (downloadedStat.size > MAX_BROWSER_DOWNLOAD_BYTES) {
          throw new Error(
            `browser download exceeded ${MAX_BROWSER_DOWNLOAD_BYTES} bytes for ${operation.name}: ${downloadedStat.size}`,
          );
        }
        const bytes = await fs.readFile(downloadedPath);
        const evidence = validateBrowserDownloadEvidence(operation, download.suggestedFilename(), bytes, {
          workspaceId: state.fixture.workspaceId,
        });
        return {
          kind: "verified-download",
          accessibleName: operation.name,
          ...evidence,
        };
      } finally {
        await download.delete().catch(() => undefined);
      }
    }
    case "assert-text": {
      await firstVisibleLocator(
        page,
        page.getByText(new RegExp(escapeRegExp(operation.value), "iu")),
        `text not found: ${operation.value}`,
        operation.timeoutMs,
      );
      return {
        kind: "terminal-ui-readback",
        readback: "text",
        value: operation.value,
        ...(operation.timeoutMs ? { timeoutMs: operation.timeoutMs } : {}),
      };
    }
    case "assert-text-pattern": {
      const expression = compileBrowserEvidencePattern(operation.valuePattern, "text readback");
      await firstVisibleLocator(page, page.getByText(expression), `text pattern not found: ${operation.valuePattern}`);
      return { kind: "terminal-ui-readback", readback: "text-pattern", valuePattern: operation.valuePattern };
    }
    case "assert-text-absent": {
      const locator = page.getByText(new RegExp(escapeRegExp(operation.value), "iu"));
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const count = await locator.count();
        let anyVisible = false;
        for (let index = 0; index < count; index += 1) {
          if (
            await locator
              .nth(index)
              .isVisible()
              .catch(() => false)
          ) {
            anyVisible = true;
            break;
          }
        }
        if (!anyVisible) {
          return { kind: "terminal-ui-readback", readback: "text-absent", value: operation.value };
        }
        await page.waitForTimeout(50);
      }
      throw new Error(`text remained visible after terminal mutation: ${operation.value}`);
    }
    case "assert-control": {
      await interactiveLocator(page, operation.name, operation.exact === true);
      return { kind: "terminal-ui-readback", readback: "control", accessibleName: operation.name };
    }
    case "assert-test-id-text": {
      const region = page.getByTestId(operation.testId).first();
      if ((await region.count()) === 0) throw new Error(`readback test id not found: ${operation.testId}`);
      await region
        .getByText(new RegExp(escapeRegExp(operation.value), "iu"))
        .first()
        .waitFor({ state: "visible" });
      return {
        kind: "terminal-ui-readback",
        readback: "test-id-text",
        testId: operation.testId,
        value: operation.value,
      };
    }
    case "assert-value": {
      const locator = await editableLocator(page, operation.label);
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const actual = await locator.inputValue().catch(() => undefined);
        if (actual === operation.value) {
          return {
            kind: "terminal-ui-readback",
            readback: "value",
            accessibleName: operation.label,
            value: redactFixtureValue(operation.value),
          };
        }
        await page.waitForTimeout(50);
      }
      throw new Error(`editable value not found: ${operation.label}=${operation.value}`);
    }
    case "assert-table-text": {
      const table = page.getByRole("table", { name: operation.tableName, exact: true }).first();
      if ((await table.count()) === 0) throw new Error(`table not found: ${operation.tableName}`);
      await table.getByText(operation.value, { exact: true }).first().waitFor({ state: "visible" });
      return { kind: "assert-table-text", tableName: operation.tableName, value: operation.value };
    }
    case "api":
      return await executeApiProbe(operation.probe, state);
    default:
      throw new Error(`unsupported browser action operation: ${String(operation.kind)}`);
  }
}

export function decodeBrowserFixtureFile(operation) {
  if (typeof operation?.fileName !== "string" || !operation.fileName.trim()) {
    throw new Error("browser fixture file requires a fileName");
  }
  if (typeof operation?.mimeType !== "string" || !operation.mimeType.trim()) {
    throw new Error(`browser fixture file ${operation.fileName} requires a MIME type`);
  }
  if (operation.encoding === "utf8") {
    if (typeof operation.content !== "string" || operation.content.length === 0) {
      throw new Error(`browser fixture file ${operation.fileName} requires nonempty UTF-8 content`);
    }
    return Buffer.from(operation.content, "utf8");
  }
  if (operation.encoding === "base64") {
    const encoded = typeof operation.contentBase64 === "string" ? operation.contentBase64.trim() : "";
    if (
      !encoded ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    ) {
      throw new Error(`browser fixture file ${operation.fileName} contains invalid base64`);
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== encoded) {
      throw new Error(`browser fixture file ${operation.fileName} contains noncanonical base64`);
    }
    return decoded;
  }
  throw new Error(`browser fixture file ${operation.fileName} has unsupported encoding ${String(operation.encoding)}`);
}

export function validateBrowserDownloadEvidence(operation, suggestedFilename, bytes, context = {}) {
  if (typeof suggestedFilename !== "string" || !suggestedFilename.trim()) {
    throw new Error("browser download returned no suggested filename");
  }
  if (
    suggestedFilename === "." ||
    suggestedFilename === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(suggestedFilename) ||
    path.posix.isAbsolute(suggestedFilename) ||
    path.win32.isAbsolute(suggestedFilename) ||
    path.posix.basename(suggestedFilename) !== suggestedFilename ||
    path.win32.basename(suggestedFilename) !== suggestedFilename
  ) {
    throw new Error(`browser download suggested an unsafe filename: ${suggestedFilename}`);
  }
  const expectedFileName = operation?.expectedFileName;
  const expectedFileNamePattern = operation?.expectedFileNamePattern;
  if ((typeof expectedFileName === "string") === (typeof expectedFileNamePattern === "string")) {
    throw new Error("browser download requires exactly one expected filename selector");
  }
  if (typeof expectedFileName === "string" && suggestedFilename !== expectedFileName) {
    throw new Error(`browser download filename mismatch: expected ${expectedFileName}, received ${suggestedFilename}`);
  }
  if (typeof expectedFileNamePattern === "string") {
    const expression = compileBrowserEvidencePattern(expectedFileNamePattern, "download filename");
    if (!expression.test(suggestedFilename)) {
      throw new Error(
        `browser download filename mismatch: expected /${expectedFileNamePattern}/, received ${suggestedFilename}`,
      );
    }
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length === 0) throw new Error(`browser download ${suggestedFilename} contained no bytes`);
  if (buffer.length > MAX_BROWSER_DOWNLOAD_BYTES) {
    throw new Error(`browser download ${suggestedFilename} exceeded ${MAX_BROWSER_DOWNLOAD_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (operation.expectedSha256 !== undefined && sha256 !== operation.expectedSha256) {
    throw new Error(
      `browser download SHA-256 mismatch for ${suggestedFilename}: expected ${operation.expectedSha256}, received ${sha256}`,
    );
  }
  if (operation.contentContract !== undefined) {
    validateBrowserDownloadContentContract(operation, buffer, context);
  }
  return {
    fileName: suggestedFilename,
    sizeBytes: buffer.length,
    sha256,
    ...(operation.contentContract ? { contentContract: operation.contentContract } : {}),
  };
}

function validateBrowserDownloadContentContract(operation, buffer, context) {
  const payload = parseBrowserDownloadJson(buffer, operation.contentContract);
  switch (operation.contentContract) {
    case "citadel-blueprint-v1": {
      if (payload.schemaVersion !== "goatcitadel.blueprint.v1") {
        throw new Error("browser Citadel Blueprint download has the wrong schemaVersion");
      }
      if (!isJsonObject(payload.metadata) || payload.metadata.name !== operation.expectedBlueprintPurpose) {
        throw new Error("browser Citadel Blueprint download does not identify the exact Citadel fixture");
      }
      if (!isJsonObject(payload.charter) || payload.charter.purpose !== operation.expectedBlueprintPurpose) {
        throw new Error("browser Citadel Blueprint download does not contain the exact fixture Charter");
      }
      if (
        !Array.isArray(payload.chambers) ||
        payload.chambers.length === 0 ||
        payload.chambers.some(
          (chamber) =>
            !isJsonObject(chamber) ||
            typeof chamber.name !== "string" ||
            !chamber.name.trim() ||
            typeof chamber.sensitivity !== "string" ||
            typeof chamber.sealed !== "boolean",
        ) ||
        !Array.isArray(payload.riskNotes)
      ) {
        throw new Error("browser Citadel Blueprint download is missing typed chamber or risk-note content");
      }
      if (containsJsonKey(payload, new Set(["citadelId", "chamberId"]))) {
        throw new Error("browser Citadel Blueprint download leaked non-portable identity fields");
      }
      return;
    }
    case "ops-diagnostics-v1": {
      if (payload.schemaVersion !== 1) {
        throw new Error("browser diagnostics download has the wrong schemaVersion");
      }
      if (typeof context.workspaceId !== "string" || payload.workspaceId !== context.workspaceId) {
        throw new Error("browser diagnostics download does not identify the exact workspace fixture");
      }
      if (typeof payload.generatedAt !== "string" || !Number.isFinite(Date.parse(payload.generatedAt))) {
        throw new Error("browser diagnostics download has no valid generatedAt timestamp");
      }
      if (
        !isJsonObject(payload.sourceStatus) ||
        !isJsonObject(payload.sourceStatus.health) ||
        (payload.sourceStatus.health.status !== "ok" && payload.sourceStatus.health.status !== "error") ||
        Object.values(payload.sourceStatus).some(
          (entry) => !isJsonObject(entry) || (entry.status !== "ok" && entry.status !== "error"),
        ) ||
        !Array.isArray(payload.daemonLogs) ||
        !Array.isArray(payload.daemonDiagnostics)
      ) {
        throw new Error("browser diagnostics download is missing typed runtime diagnostic content");
      }
      return;
    }
    default:
      throw new Error(`browser download has unsupported content contract: ${String(operation.contentContract)}`);
  }
}

function parseBrowserDownloadJson(buffer, contract) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(
      `browser ${contract} download is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `browser ${contract} download is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isJsonObject(payload)) throw new Error(`browser ${contract} download root must be an object`);
  return payload;
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsJsonKey(value, forbiddenKeys) {
  if (Array.isArray(value)) return value.some((entry) => containsJsonKey(entry, forbiddenKeys));
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(([key, entry]) => forbiddenKeys.has(key) || containsJsonKey(entry, forbiddenKeys));
}

function compileBrowserEvidencePattern(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} pattern is empty`);
  try {
    return new RegExp(value, "iu");
  } catch (error) {
    throw new Error(`${label} pattern is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function executeApiProbe(probe, state) {
  const result = await apiProbe(probe, state);
  return { kind: "canonical-api-probe", probe, ...result };
}

async function apiProbe(probe, state) {
  switch (probe) {
    case "skill-lifecycle-approval-baseline": {
      const [skills, approvals] = await Promise.all([
        checkedRequest(state.gatewayUrl, "/api/v1/skills", {}, probe),
        checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=200", {}, probe),
      ]);
      const codingSkills = (Array.isArray(skills.body?.items) ? skills.body.items : []).filter(
        (item) => item?.skillId === "bundled:coding" && item?.name === "coding",
      );
      if (codingSkills.length !== 1 || typeof codingSkills[0]?.state !== "string") {
        throw new Error(`skill lifecycle browser step requires one canonical bundled:coding skill`);
      }
      state.skillLifecycleApprovalEvidence = {
        skillId: codingSkills[0].skillId,
        baselineApprovalIds: (Array.isArray(approvals.body?.items) ? approvals.body.items : [])
          .map((item) => item?.approvalId)
          .filter((approvalId) => typeof approvalId === "string"),
        observedApprovalIds: [],
      };
      return {
        status: approvals.status,
        outcome: `captured ${codingSkills[0].skillId} at ${codingSkills[0].state} before lifecycle requests`,
      };
    }
    case "skill-lifecycle-enabled-readback":
      return await waitForSkillLifecycleReadback(state, "enabled", probe);
    case "skill-lifecycle-sleep-readback":
      return await waitForSkillLifecycleReadback(state, "sleep", probe);
    case "skill-lifecycle-disabled-readback":
      return await waitForSkillLifecycleReadback(state, "disabled", probe);
    case "approval-decision-baseline": {
      const response = await checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=200", {}, probe);
      const pending = Array.isArray(response.body?.items)
        ? response.body.items.filter((item) => typeof item?.approvalId === "string" && item?.status === "pending")
        : [];
      if (pending.length < 2) {
        throw new Error(
          `approval decision browser step requires at least two pending approvals; found ${pending.length}`,
        );
      }
      state.approvalDecisionBaseline = Object.fromEntries(pending.map((item) => [item.approvalId, item.status]));
      return { status: response.status, outcome: `captured ${pending.length} exact pending approval identities` };
    }
    case "approval-decisions-resolved": {
      const baseline = state.approvalDecisionBaseline;
      if (!baseline || Object.keys(baseline).length < 2) {
        throw new Error("approval decision baseline was not captured in this exact browser step");
      }
      let latest;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        latest = await checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=200", {}, probe);
        const statuses = new Map(
          (Array.isArray(latest.body?.items) ? latest.body.items : [])
            .filter((item) => typeof item?.approvalId === "string")
            .map((item) => [item.approvalId, item.status]),
        );
        const changed = Object.keys(baseline).map((approvalId) => ({ approvalId, status: statuses.get(approvalId) }));
        const approved = changed.filter((item) => item.status === "approved");
        const rejected = changed.filter((item) => item.status === "rejected");
        if (approved.length >= 1 && rejected.length >= 1) {
          return {
            status: latest.status,
            outcome: `canonical approvals recorded ${approved.length} approved and ${rejected.length} rejected browser decisions`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`browser approval decisions did not reach approved and rejected canonical states`);
    }
    case "kanban-task-lifecycle-readback": {
      const taskIds = Array.isArray(state.fixture.taskIds) ? state.fixture.taskIds : [];
      if (taskIds.length < 4) throw new Error("Kanban lifecycle fixture requires four canonical task identities");
      const response = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/tasks?limit=200&view=all&workspaceId=${encodeURIComponent(state.fixture.workspaceId)}`,
        {},
        probe,
      );
      const byId = new Map(
        (Array.isArray(response.body?.items) ? response.body.items : [])
          .filter((item) => typeof item?.taskId === "string")
          .map((item) => [item.taskId, item]),
      );
      const unblocked = byId.get(taskIds[3]);
      const retried = byId.get(taskIds[1]);
      const closed = byId.get(taskIds[2]);
      if (unblocked?.status !== "assigned") {
        throw new Error(`Kanban unblock did not persist assigned state: ${JSON.stringify(unblocked)}`);
      }
      if (
        retried?.status !== "blocked" ||
        (retried.retryBudget?.retryCount ?? 0) < 1 ||
        typeof retried.retryBudget?.exhaustedAt !== "string"
      ) {
        throw new Error(`Kanban retry did not persist its attempt: ${JSON.stringify(retried)}`);
      }
      if (closed?.status !== "done") {
        throw new Error(`Kanban close did not persist done state: ${JSON.stringify(closed)}`);
      }
      return {
        status: response.status,
        outcome: `canonical Kanban tasks persisted assigned, retry-exhausted blocked, and done terminal states`,
      };
    }
    case "agent-default-tools-persisted": {
      const expectedRoleId = "usability-browser-agent";
      const expectedTools = ["fs.read", "fs.list"];
      const agents = await checkedRequest(state.gatewayUrl, "/api/v1/agents?view=all&limit=300", {}, probe);
      const matches = Array.isArray(agents.body?.items)
        ? agents.body.items.filter((item) => item?.roleId === expectedRoleId)
        : [];
      if (matches.length !== 1) {
        throw new Error(`expected exactly one canonical ${expectedRoleId} agent; found ${matches.length}`);
      }
      const agentId = requireText(matches[0]?.agentId, `${expectedRoleId} agentId`);
      const detail = await checkedRequest(state.gatewayUrl, `/api/v1/agents/${encodeURIComponent(agentId)}`, {}, probe);
      validatePersistedAgentDefaultTools(detail.body, { agentId, expectedRoleId, expectedTools });
      return {
        status: detail.status,
        outcome: `${expectedRoleId} retained ${expectedTools.join(", ")} in canonical storage`,
      };
    }
    case "arm-stop-provider": {
      if (typeof state.stub?.replaceDispatchPlan !== "function") {
        throw new Error("deterministic provider does not support dispatch-plan replacement");
      }
      state.stub.replaceDispatchPlan([
        { type: "stream_stall" },
        { type: "success", replyText: "Verification stub reply." },
      ]);
      return { status: 200, outcome: "next provider stream armed to stall until the visible Stop turn action" };
    }
    case "chat-retry-completed":
      return await waitForExactCompletedChatTurn(state, "Stop this deterministic usability turn.");
    case "chat-branch-completed":
      return await waitForExactCompletedChatTurn(state, "Branch this deterministic turn.");
    case "chat-attachment-evidence-seed": {
      const response = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/dev/verification/chat-attachment-evidence-scenario",
        {
          method: "POST",
          body: { workspaceId: state.fixture.workspaceId, sessionId: state.sessionId },
        },
        probe,
      );
      state.chatAttachmentEvidence = validateSeededChatAttachmentEvidence(response.body, {
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
      });
      return {
        status: response.status,
        outcome: `seeded citation ${state.chatAttachmentEvidence.citationId}, tool event ${state.chatAttachmentEvidence.toolRunId}, and local URL source`,
      };
    }
    case "chat-attachments-canonical": {
      if (!state.chatAttachmentEvidence) {
        throw new Error("Chat attachment evidence seed was not retained in this exact browser step");
      }
      await waitForExactCompletedChatTurn(state, CHAT_ATTACHMENT_TURN_CONTENT);
      const thread = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/thread?includeDecisionTrace=true`,
        {},
        probe,
      );
      const projection = validateCanonicalChatAttachmentProjection(thread.body, {
        evidence: state.chatAttachmentEvidence,
        expectedAttachments: CHAT_ATTACHMENT_EXPECTATIONS,
        expectedAssistantContent: DETERMINISTIC_LLM_DEFAULT_REPLY,
        expectedUserContent: CHAT_ATTACHMENT_TURN_CONTENT,
        sessionId: state.sessionId,
      });
      const records = [];
      for (const expected of projection.attachments) {
        const response = await checkedRequest(
          state.gatewayUrl,
          `/api/v1/chat/attachments/${encodeURIComponent(expected.attachmentId)}`,
          {},
          probe,
        );
        records.push(response.body);
      }
      validateCanonicalChatAttachmentRecords(records, {
        expectedAttachments: CHAT_ATTACHMENT_EXPECTATIONS,
        projectedAttachments: projection.attachments,
        sessionId: state.sessionId,
      });
      const sources = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/knowledge-attachments`,
        {},
        probe,
      );
      validateCanonicalChatUrlSource(sources.body?.items, state.chatAttachmentEvidence);
      return {
        status: thread.status,
        outcome: `canonical turn ${projection.turnId} retained ${projection.attachments.length} MIME-typed attachments plus rendered citation/tool evidence`,
      };
    }
    case "planning-turn-completed":
      return await waitForExactCompletedChatTurn(state, "Plan this deterministic usability turn.");
    case "delegate-suggest-accept": {
      const objective = "Produce two independent deterministic analyses and synthesize both.";
      const parentThread = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/thread?includeDecisionTrace=true`,
        {},
        probe,
      );
      const parentCorrelation = resolveThreadDurableCorrelation(parentThread.body?.turns, state.sessionId);
      const parentRun = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(parentCorrelation.runId)}`,
        {},
        probe,
      );
      validateDurableRunCorrelation(parentRun.body, parentCorrelation);
      const suggestion = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/delegate/suggest`,
        {
          method: "POST",
          body: { objective, roles: ["Researcher", "Reviewer", "Synthesizer"], mode: "parallel" },
        },
        probe,
      );
      const suggestionId = suggestion.body?.suggestion?.suggestionId;
      if (!suggestionId) throw new Error("delegation suggestion returned no suggestionId");
      if (typeof state.stub?.replacePromptReplyRules !== "function") {
        throw new Error("deterministic provider does not support prompt-matched reply rules");
      }
      // Delegated turns can make auxiliary provider requests around the actual
      // child completion. Match the non-retained role marker instead of relying
      // on global dispatch order so parallel workers remain deterministic.
      state.stub.replacePromptReplyRules(buildDelegationPromptReplyRules());
      const accepted = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/delegate/accept`,
        {
          method: "POST",
          body: {
            suggestionId,
            objective,
            roles: ["Researcher", "Reviewer", "Synthesizer"],
            mode: "parallel",
            surfaceMode: "chat",
            policyRunId: parentCorrelation.runId,
            steps: [
              { stepId: "research", index: 0, role: "Researcher", parallelizable: true },
              { stepId: "review", index: 1, role: "Reviewer", parallelizable: true },
              {
                stepId: "synthesis",
                index: 2,
                role: "Synthesizer",
                parallelizable: false,
                dependsOnStepIds: ["research", "review"],
              },
            ],
          },
        },
        probe,
      );
      const delegationRunId = accepted.body?.runId;
      if (!delegationRunId) throw new Error("accepted delegation returned no runId");
      const canonical = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/delegations/${encodeURIComponent(delegationRunId)}`,
        {},
        probe,
      );
      const rail = await checkedRequest(
        state.gatewayUrl,
        durableBackgroundTaskRailRoute(parentCorrelation.runId, state.fixture.workspaceId, state.sessionId),
        {},
        probe,
      );
      let fanIn;
      try {
        fanIn = validateCompletedDelegationFanIn(accepted.body, canonical.body, rail.body, {
          delegationRunId,
          objective,
          parentRunId: parentCorrelation.runId,
          workspaceId: state.fixture.workspaceId,
          sessionId: state.sessionId,
        });
      } catch (error) {
        const dispatches =
          typeof state.stub?.completionDispatchRecords === "function"
            ? state.stub.completionDispatchRecords().map((entry) => ({
                behavior: entry.behavior,
                dispatchPlanIndex: entry.dispatchPlanIndex,
                outcome: entry.outcome,
                promptReplyRuleId: entry.promptReplyRuleId,
                status: entry.status,
              }))
            : [];
        const actualOutputs = Array.isArray(canonical.body?.steps)
          ? normalizeDelegationProofSteps(canonical.body.steps, "canonical delegation").map((step) => ({
              index: step.index,
              role: step.role,
              status: step.status,
              output: step.output,
            }))
          : [];
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message}; canonicalOutputs=${JSON.stringify(actualOutputs)}; providerDispatches=${JSON.stringify(dispatches)}`,
          { cause: error },
        );
      }
      const childCorrelations = [];
      for (const task of fanIn.tasks) {
        const childRun = await checkedRequest(
          state.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(task.childRunId)}`,
          {},
          probe,
        );
        const childCorrelation = {
          runId: task.childRunId,
          sessionId: requireText(childRun.body?.payload?.sessionId, "durable child session ID"),
          turnId: requireText(childRun.body?.payload?.turnId, "durable child turn ID"),
        };
        validateDurableRunCorrelation(childRun.body, childCorrelation);
        validateDurableTaskLinks(task, childCorrelation);
        childCorrelations.push(childCorrelation);
      }
      const firstTask = fanIn.tasks[0];
      const firstChildCorrelation = childCorrelations[0];
      state.fixture.durableWatcher = {
        parent: parentCorrelation,
        child: firstChildCorrelation,
        watcherId: firstTask.watcherId,
      };
      return {
        status: accepted.status,
        outcome: `delegation ${delegationRunId} completed three verified child runs with two-way fan-in and synthesized parent evidence`,
      };
    }
    case "approval-and-user-input": {
      const approvalSessionId = requireText(state.fixture.sessions?.approval, "approval fixture session");
      const userInputSessionId = requireText(state.fixture.sessions?.userInput, "user-input fixture session");
      const resolved = await pollResolvedBlockerEvidence(async () => {
        const approvals = await checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=100", {}, probe);
        const approvalThread = await checkedRequest(
          state.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(approvalSessionId)}/thread?includeDecisionTrace=true`,
          {},
          probe,
        );
        const userInputThread = await checkedRequest(
          state.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(userInputSessionId)}/thread?includeDecisionTrace=true`,
          {},
          probe,
        );
        return {
          status: approvals.status,
          approvalSessionId,
          approvals: approvals.body?.items,
          approvalTurns: approvalThread.body?.turns,
          userInputSessionId,
          userInputTurns: userInputThread.body?.turns,
        };
      });
      const evidence = resolved.evidence;
      const approvalTurn = resolved.snapshot.approvalTurns.find((turn) => turn?.turnId === evidence.approvalTurnId);
      const userInputTurn = resolved.snapshot.userInputTurns.find((turn) => turn?.turnId === evidence.userInputTurnId);
      const workspaceQuery = `workspaceId=${encodeURIComponent(state.fixture.workspaceId)}`;
      const approvalRunId = requireText(approvalTurn?.trace?.durable?.runId, "approval blocker durable run ID");
      const [approvalProfile, userInputProfile, approvalRun, userInputRun] = await Promise.all([
        checkedRequest(
          state.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(approvalSessionId)}/turns/${encodeURIComponent(evidence.approvalTurnId)}/capability-profile?${workspaceQuery}`,
          {},
          "approval blocker capability profile",
        ),
        checkedRequest(
          state.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(userInputSessionId)}/turns/${encodeURIComponent(evidence.userInputTurnId)}/capability-profile?${workspaceQuery}`,
          {},
          "user-input blocker capability profile",
        ),
        checkedRequest(
          state.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(approvalRunId)}`,
          {},
          "approval blocker durable run",
        ),
        checkedRequest(
          state.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(evidence.userInputRunId)}`,
          {},
          "user-input blocker durable run",
        ),
      ]);
      validateDurableRunCorrelation(approvalRun.body, {
        runId: approvalRunId,
        sessionId: approvalSessionId,
        turnId: evidence.approvalTurnId,
      });
      validateDurableRunCorrelation(userInputRun.body, {
        runId: evidence.userInputRunId,
        sessionId: userInputSessionId,
        turnId: evidence.userInputTurnId,
      });
      validateResolvedBlockerCapabilityProfile(approvalProfile.body, {
        requestActor: approvalRun.body?.payload?.requestActor,
        sessionId: approvalSessionId,
        turn: approvalTurn,
        workspaceId: state.fixture.workspaceId,
      });
      validateResolvedBlockerCapabilityProfile(userInputProfile.body, {
        requestActor: userInputRun.body?.payload?.requestActor,
        sessionId: userInputSessionId,
        turn: userInputTurn,
        workspaceId: state.fixture.workspaceId,
      });
      const responses = userInputRun.body?.payload?.userInputResponses;
      if (
        !Array.isArray(responses) ||
        !responses.some(
          (item) =>
            item?.kind === "single_select" &&
            item?.response?.optionId === "option-a" &&
            item?.selectedOption?.optionId === "option-a" &&
            item?.selectedOption?.label === "Continue with the current plan" &&
            typeof item?.answeredAt === "string" &&
            item.answeredAt.length > 0,
        )
      ) {
        throw new Error("user-input answer was not durably recorded with the selected fixture option");
      }
      return {
        status: resolved.snapshot.status,
        outcome: "approval and user-input blockers resolved with exact actor-bound capability profiles",
      };
    }
    case "durable-run-read": {
      const thread = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/thread?includeDecisionTrace=true`,
        {},
        probe,
      );
      const correlation = resolveThreadDurableCorrelation(thread.body?.turns, state.sessionId);
      const durableRun = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(correlation.runId)}`,
        {},
        probe,
      );
      validateDurableRunCorrelation(durableRun.body, correlation);
      const expected = state.fixture.durableWatcher;
      if (
        !expected ||
        expected.parent?.runId !== correlation.runId ||
        expected.parent?.sessionId !== correlation.sessionId ||
        expected.parent?.turnId !== correlation.turnId
      ) {
        throw new Error("durable watcher fixture is absent or belongs to a different parent Chat turn");
      }
      const rail = await checkedRequest(
        state.gatewayUrl,
        durableBackgroundTaskRailRoute(correlation.runId, state.fixture.workspaceId, state.sessionId),
        {},
        probe,
      );
      const task = validateAttachedDurableWatcher(rail.body, {
        parentRunId: correlation.runId,
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
        watcherId: expected.watcherId,
        childRunId: expected.child.runId,
      });
      validateDurableTaskLinks(task, expected.child);
      const childRun = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(expected.child.runId)}`,
        {},
        probe,
      );
      validateDurableRunCorrelation(childRun.body, expected.child);
      return {
        status: durableRun.status,
        outcome: `parent ${correlation.runId} correlated to session ${correlation.sessionId} turn ${correlation.turnId}; watcher ${task.watcherId} reattached to child ${task.childRunId}`,
      };
    }
    case "durable-run-pause": {
      const durableRunId = requireText(state.fixture.runs?.opsApproval, "Ops approval durable run ID");
      const paused = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/pause`,
        { method: "POST", body: {} },
        probe,
      );
      if (paused.body?.runId !== durableRunId || paused.body?.status !== "paused") {
        throw new Error(`Ops approval durable run did not pause canonically: ${JSON.stringify(paused.body)}`);
      }
      return { status: paused.status, outcome: `durable run ${durableRunId} paused after approval route hydration` };
    }
    case "approval-durable-run-read": {
      const approvalId = requireText(state.fixture.approvals?.ops, "Ops approval ID");
      const durableRunId = requireText(state.fixture.runs?.opsApproval, "Ops approval durable run ID");
      const lifecycle = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(approvalId)}`,
        {},
        probe,
      );
      const canonicalRunId = lifecycle.body?.canonical?.runId ?? lifecycle.body?.approval?.linkage?.durableRunId;
      if (canonicalRunId !== durableRunId) {
        throw new Error(`approval lifecycle selected ${canonicalRunId ?? "no run"}, expected ${durableRunId}`);
      }
      let durableRun;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        durableRun = await checkedRequest(
          state.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`,
          {},
          probe,
        );
        if (durableRun.body?.status !== "paused") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (durableRun?.body?.runId !== durableRunId || durableRun.body.status === "paused") {
        throw new Error(`approval durable run did not resume canonically: ${JSON.stringify(durableRun?.body)}`);
      }
      return {
        status: durableRun.status,
        outcome: `canonical approval run ${durableRunId} resumed to ${durableRun.body.status}`,
      };
    }
    case "arm-code-helper-provider": {
      const projectFixture = state.fixture.codeModeProject;
      if (!projectFixture?.workspacePath || !projectFixture?.absolutePath) {
        throw new Error("isolated Code Mode verification project fixture is missing");
      }
      const createdProject = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/chat/projects",
        {
          method: "POST",
          body: {
            workspaceId: state.fixture.workspaceId,
            name: "Usability governed Code Mode fixture",
            description: "Isolated committed repository for deterministic named proof.",
            workspacePath: projectFixture.workspacePath,
          },
        },
        probe,
      );
      const projectId = requireText(createdProject.body?.projectId, "Code Mode fixture project ID");
      const sessions = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions?workspaceId=${encodeURIComponent(state.fixture.workspaceId)}&view=all&limit=1000`,
        {},
        probe,
      );
      const actionSession = Array.isArray(sessions.body?.items)
        ? sessions.body.items.find((item) => item?.sessionId === state.sessionId)
        : undefined;
      if (!actionSession?.revision) throw new Error("Code Mode fixture could not resolve the current Chat revision");
      const assigned = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/project`,
        { method: "POST", body: { projectId, expectedRevision: actionSession.revision } },
        probe,
      );
      if (assigned.body?.projectId !== projectId || assigned.body?.sessionId !== state.sessionId) {
        throw new Error("Code Mode fixture project was not bound to the exact Chat session");
      }
      const worktree = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/workbench/worktree`,
        { method: "POST", body: { baseRef: "HEAD" } },
        probe,
      );
      if (
        worktree.body?.state?.sessionId !== state.sessionId ||
        worktree.body?.state?.projectId !== projectId ||
        worktree.body?.state?.worktreeStatus !== "ready" ||
        typeof worktree.body?.state?.worktreePath !== "string" ||
        !worktree.body.state.worktreePath
      ) {
        throw new Error(`Code Mode fixture worktree is not ready: ${JSON.stringify(worktree.body)}`);
      }
      state.fixture.codeMode = {
        projectId,
        workbench: worktree.body.state,
      };
      if (typeof state.stub?.replacePromptReplyRules !== "function") {
        throw new Error("deterministic provider does not support prompt-matched reply rules");
      }
      state.stub.replacePromptReplyRules([
        {
          ruleId: "code-mode-helper",
          userContentIncludes: CODE_MODE_HELPER_PROMPT,
          replyText: CODE_MODE_HELPER_REPLY,
        },
      ]);
      return {
        status: worktree.status,
        outcome: `project ${projectId} bound with isolated ready worktree for governed Code Mode proof`,
      };
    }
    case "code-helper-turn-completed": {
      const completed = await waitForExactCompletedChatTurn(state, CODE_MODE_HELPER_PROMPT, CODE_MODE_HELPER_REPLY);
      state.fixture.codeMode = {
        ...(state.fixture.codeMode ?? {}),
        chatTurn: {
          runId: completed.runId,
          sessionId: completed.sessionId,
          turnId: completed.turnId,
        },
      };
      return completed;
    }
    case "code-mode-helper-approve-complete": {
      const chatTurn = requireCodeModeChatTurn(state.fixture.codeMode);
      const query = new URLSearchParams({
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
        turnId: chatTurn.turnId,
        status: "approval_pending",
        limit: "25",
      });
      const listed = await checkedRequest(state.gatewayUrl, `/api/v1/code-mode/runs?${query.toString()}`, {}, probe);
      const candidates = Array.isArray(listed.body?.items)
        ? listed.body.items.filter(
            (run) =>
              run?.requestedOutputIntent === "workbench_helper" &&
              run?.originSurface === "chat" &&
              run?.language === "typescript" &&
              run?.workspaceId === state.fixture.workspaceId &&
              run?.sessionId === state.sessionId &&
              run?.turnId === chatTurn.turnId,
          )
        : [];
      if (candidates.length !== 1) {
        throw new Error(`expected exactly one approval-pending Chat helper run, found ${candidates.length}`);
      }
      const pending = candidates[0];
      const runId = requireText(pending.runId, "Code Mode helper run ID");
      const approvalId = requireText(pending.approvalId, "Code Mode helper approval ID");
      const pendingDetail = await readCodeModeRunInScope(state, runId, chatTurn.turnId, probe);
      if (
        pendingDetail.body?.status !== "approval_pending" ||
        pendingDetail.body?.approvalId !== approvalId ||
        pendingDetail.body?.requestedOutputIntent !== "workbench_helper"
      ) {
        throw new Error("Code Mode helper did not retain its governed approval-pending ledger state");
      }
      await checkedRequest(
        state.gatewayUrl,
        `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
        {
          method: "POST",
          body: {
            decision: "approve",
            resolutionNote: "Approved by isolated Chromium governed Code Mode verification.",
          },
        },
        probe,
      );
      const completed = await pollCodeModeRun(
        () => readCodeModeRunInScope(state, runId, chatTurn.turnId, probe),
        (run) => run?.status === "completed" || run?.status === "failed",
      );
      validateCompletedCodeModeRun(completed.body, {
        approvalId,
        runId,
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
        turnId: chatTurn.turnId,
      });
      state.fixture.codeMode = {
        ...state.fixture.codeMode,
        approvalId,
        runId,
      };
      return {
        status: completed.status,
        outcome: `governed helper ${runId} completed only after approval ${approvalId} with immutable hash evidence`,
      };
    }
    case "code-mode-helper-artifacts": {
      const codeMode = requireCompletedCodeModeFixture(state.fixture.codeMode);
      const runResponse = await readCodeModeRunInScope(state, codeMode.runId, codeMode.chatTurn.turnId, probe);
      const run = runResponse.body;
      validateCompletedCodeModeRun(run, {
        approvalId: codeMode.approvalId,
        runId: codeMode.runId,
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
        turnId: codeMode.chatTurn.turnId,
      });
      const artifactKinds = ["source", "wrapper_manifest", "policy_snapshot", "stdout"];
      const previews = {};
      for (const artifactKind of artifactKinds) {
        const preview = await checkedRequest(
          state.gatewayUrl,
          codeModeArtifactRoute(
            codeMode.runId,
            artifactKind,
            state.fixture.workspaceId,
            state.sessionId,
            codeMode.chatTurn.turnId,
          ),
          {},
          probe,
        );
        previews[artifactKind] = preview.body;
      }
      const snapshot = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/capabilities/snapshots/${encodeURIComponent(run.capabilitySnapshotId)}`,
        {},
        probe,
      );
      validateCodeModeArtifactEvidence(run, previews, snapshot.body, CODE_MODE_HELPER_SOURCE);
      return {
        status: runResponse.status,
        outcome: `source, wrapper, policy, stdout, and frozen capability snapshot verified for ${codeMode.runId}`,
      };
    }
    case "code-mode-helper-proof": {
      const codeMode = requireCompletedCodeModeFixture(state.fixture.codeMode);
      const runResponse = await readCodeModeRunInScope(state, codeMode.runId, codeMode.chatTurn.turnId, probe);
      const evidenceResponse = await checkedRequest(
        state.gatewayUrl,
        codeModeVerificationEvidenceRoute(
          codeMode.runId,
          state.fixture.workspaceId,
          state.sessionId,
          codeMode.chatTurn.turnId,
        ),
        {},
        probe,
      );
      const evidence = validateVerifiedCodeModeNamedProof(runResponse.body, evidenceResponse.body?.items, {
        runId: codeMode.runId,
        workspaceId: state.fixture.workspaceId,
        sessionId: state.sessionId,
        turnId: codeMode.chatTurn.turnId,
      });
      const workbench = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/workbench`,
        {},
        probe,
      );
      if (
        workbench.body?.state?.worktreeStatus !== "ready" ||
        workbench.body?.state?.sessionId !== state.sessionId ||
        workbench.body?.state?.projectId !== state.fixture.codeMode?.projectId
      ) {
        throw new Error("named Code Mode proof did not retain the exact ready Chat worktree scope");
      }
      return {
        status: evidenceResponse.status,
        outcome: `named git diff --check proof ${evidence.evidenceId} verified the immutable run subject`,
      };
    }
    case "code-mode-helper-run-detail": {
      const codeMode = requireCompletedCodeModeFixture(state.fixture.codeMode);
      const durableRun = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(codeMode.chatTurn.runId)}`,
        {},
        probe,
      );
      validateDurableRunCorrelation(durableRun.body, codeMode.chatTurn);
      const trace = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/observe/runs/${encodeURIComponent(codeMode.chatTurn.runId)}/trace`,
        {},
        probe,
      );
      validateUniversalRunDetailTrace(trace.body, codeMode.chatTurn);
      return {
        status: trace.status,
        outcome: `visible Run Detail correlated durable run ${codeMode.chatTurn.runId} to its exact Chat session and turn`,
      };
    }
    case "capability-catalog-read": {
      const inspectable = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/capabilities/catalog?scope=inspectable",
        {},
        probe,
      );
      const callable = await checkedRequest(state.gatewayUrl, "/api/v1/capabilities/catalog?scope=callable", {}, probe);
      if (!Array.isArray(inspectable.body?.items) || !Array.isArray(callable.body?.items)) {
        throw new Error("capability catalogs are malformed");
      }
      return { status: 200, outcome: `${inspectable.body.items.length}/${callable.body.items.length} catalog rows` };
    }
    case "candidate-proposal-read": {
      const candidateId = requireText(state.fixture.candidateId, "verification capability candidate ID");
      const candidateVersionId = requireText(
        state.fixture.candidateVersionId,
        "verification capability candidate version ID",
      );
      const before = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/capabilities/catalog?scope=inspectable",
        {},
        probe,
      );
      const candidate = Array.isArray(before.body?.items)
        ? before.body.items.find(
            (item) =>
              item?.kind === "candidate_skill" &&
              item?.candidateId === candidateId &&
              item?.capabilityId === `candidate:${candidateId}:${candidateVersionId}`,
          )
        : undefined;
      if (!candidate || candidate.callable !== false || candidate.lifecycleState !== "candidate") {
        throw new Error(`seeded candidate ${candidateId} is absent or not inspect-only candidate state`);
      }
      const candidateDetail = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}`,
        {},
        probe,
      );
      if (
        candidateDetail.body?.candidateId !== candidateId ||
        candidateDetail.body?.latestVersion?.versionId !== candidateVersionId ||
        candidateDetail.body?.latestVersion?.lifecycleState !== "candidate" ||
        candidateDetail.body?.activationBlocked !== true
      ) {
        throw new Error(`seeded candidate ${candidateId} canonical detail is malformed or activation-capable`);
      }
      const created = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/capabilities/proposals",
        {
          method: "POST",
          body: {
            proposalKind: "skill",
            title: "Usability browser capability proposal",
            summary: "Deterministic proposal linked to an isolated inspect-only candidate.",
            payload: {
              source: "usability-browser-action",
              candidateVersionId,
            },
            candidateId,
            activationTargetId: candidateId,
          },
        },
        probe,
      );
      const proposalId = created.body?.proposalId;
      if (typeof proposalId !== "string" || !proposalId) {
        throw new Error("created capability proposal returned no proposalId");
      }
      const detail = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/capabilities/proposals/${encodeURIComponent(proposalId)}`,
        {},
        probe,
      );
      if (
        detail.body?.proposal?.candidateId !== candidateId ||
        detail.body?.proposal?.activationTargetId !== candidateId ||
        detail.body?.proposal?.status !== "proposed"
      ) {
        throw new Error("capability proposal lost candidate linkage or proposal lifecycle state");
      }
      const [inspectable, callable] = await Promise.all([
        checkedRequest(state.gatewayUrl, "/api/v1/capabilities/catalog?scope=inspectable", {}, probe),
        checkedRequest(state.gatewayUrl, "/api/v1/capabilities/catalog?scope=callable", {}, probe),
      ]);
      const proposalCapabilityId = `proposal:${proposalId}`;
      if (!inspectable.body?.items?.some((item) => item?.capabilityId === proposalCapabilityId)) {
        throw new Error("created proposal is absent from the inspectable catalog");
      }
      if (callable.body?.items?.some((item) => item?.capabilityId === proposalCapabilityId)) {
        throw new Error("inspect-only proposal leaked into the callable catalog");
      }
      if (callable.body?.items?.some((item) => item?.kind === "candidate_skill" && item?.candidateId === candidateId)) {
        throw new Error(`candidate ${candidateId} leaked into the callable catalog`);
      }
      if (
        !inspectable.body?.items?.some(
          (item) =>
            item?.kind === "candidate_skill" &&
            item?.candidateId === candidateId &&
            item?.capabilityId === `candidate:${candidateId}:${candidateVersionId}` &&
            item?.callable === false,
        )
      ) {
        throw new Error(`candidate ${candidateId} disappeared from the inspectable catalog`);
      }
      return {
        status: created.status,
        outcome: `catalog candidate ${candidateId} linked to inspect-only proposal ${proposalId}`,
      };
    }
    case "communications-uncredentialed-fixture": {
      const connectionId = requireText(
        state.fixture.library?.communicationsConnectionId,
        "communications fixture connection ID",
      );
      const dashboard = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/communications?workspaceId=${encodeURIComponent(state.fixture.workspaceId)}`,
        {},
        probe,
      );
      const account = dashboard.body?.mailAccounts?.find((item) => item?.connectionId === connectionId);
      const message = dashboard.body?.messages?.find((item) => item?.messageId === "fixture-message-1");
      const event = dashboard.body?.events?.find((item) => item?.eventId === "fixture-event-1");
      if (
        account?.syncStatus !== "not_configured" ||
        account?.address !== "verification-inbox@example.invalid" ||
        message?.subject !== "Fixture inbox readiness" ||
        event?.title !== "Fixture usability agenda"
      ) {
        throw new Error(`uncredentialed Communications fixture was not canonical: ${JSON.stringify(dashboard.body)}`);
      }
      return {
        status: dashboard.status,
        outcome: `disabled connection ${connectionId} exposed deterministic inbox and agenda fixtures without credentials`,
      };
    }
    case "communications-approval-no-send": {
      const connectionId = requireText(
        state.fixture.library?.communicationsConnectionId,
        "communications fixture connection ID",
      );
      const approvals = await checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=100", {}, probe);
      const matches = Array.isArray(approvals.body?.items)
        ? approvals.body.items.filter(
            (item) =>
              item?.kind === "communications.mail.send" &&
              item?.status === "pending" &&
              item?.payload?.action === "mail_send" &&
              item?.payload?.accountId === connectionId &&
              item?.payload?.subject === "Usability fixture approval draft" &&
              item?.payload?.bodyText === "This message remains inside the isolated approval fixture." &&
              Array.isArray(item?.payload?.to) &&
              item.payload.to.length === 1 &&
              item.payload.to[0] === "fixture-recipient@example.invalid",
          )
        : [];
      if (matches.length !== 1) {
        throw new Error(`expected one pending Communications send approval; found ${matches.length}`);
      }
      if (
        matches[0]?.preview?.execution !== "Approval records operator intent; this route does not send the message."
      ) {
        throw new Error("Communications approval did not retain the no-send execution boundary");
      }
      const sideEffects = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/integrations/external-side-effects?workspaceId=${encodeURIComponent(state.fixture.workspaceId)}&connectionId=${encodeURIComponent(connectionId)}&limit=100`,
        {},
        probe,
      );
      if (!Array.isArray(sideEffects.body?.items) || sideEffects.body.items.length !== 0) {
        throw new Error(
          `Communications draft crossed an external side-effect boundary: ${JSON.stringify(sideEffects.body)}`,
        );
      }
      return {
        status: sideEffects.status,
        outcome: `approval ${matches[0].approvalId} stayed pending with zero external side-effect runs`,
      };
    }
    case "prompt-pack-run-all-canonical-settle": {
      const captured = resolveCapturedPromptPackBenchmark(state, "promptPackRunAllBenchmarkRunId", "Run all");
      const canonical = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/prompt-packs/benchmark/${encodeURIComponent(captured.benchmarkRunId)}`,
        {},
        probe,
      );
      const evidence = validatePromptPackRunAllStatus(canonical.body, captured);
      return {
        status: canonical.status,
        outcome: `${evidence.completedItems}/${evidence.totalItems} prior run-all rows settled canonically with exact scoring before the compare baseline`,
      };
    }
    case "prompt-pack-benchmark-provider-readiness": {
      const stubBaseUrl = requireText(state.fixture.settings?.llmStubBaseUrl, "deterministic provider URL");
      const config = await checkedRequest(state.gatewayUrl, "/api/v1/llm/config", {}, probe);
      const providers = (Array.isArray(config.body?.providers) ? config.body.providers : []).filter(
        (item) => item?.providerId === "verification-stub",
      );
      if (
        providers.length !== 1 ||
        providers[0]?.baseUrl !== stubBaseUrl ||
        providers[0]?.apiStyle !== "openai-chat-completions" ||
        providers[0]?.defaultModel !== PROMPT_PACK_BENCHMARK_MODELS[0] ||
        config.body?.activeProviderId !== "verification-stub"
      ) {
        throw new Error(`prompt-pack benchmark provider configuration drifted: ${JSON.stringify(config.body)}`);
      }
      const models = await requestJson(stubBaseUrl, "/models", {
        headers: { authorization: `Bearer ${USABILITY_BROWSER_ACTION_GATEWAY_ENV[DETERMINISTIC_LLM_KEY_ENV]}` },
      });
      if (
        !models.ok ||
        !Array.isArray(models.body?.data) ||
        !models.body.data.some((item) => item?.id === PROMPT_PACK_BENCHMARK_MODELS[0])
      ) {
        throw new Error(
          `prompt-pack deterministic provider preflight failed (${models.status}): ${JSON.stringify(models.body)}`,
        );
      }
      if (typeof state.stub?.completionDispatchRecords !== "function") {
        throw new Error("deterministic provider does not expose benchmark dispatch records");
      }
      if (typeof state.stub?.replacePromptReplyRules !== "function") {
        throw new Error("deterministic provider does not support prompt-tagged benchmark replies");
      }
      await waitForPromptPackProviderQuiet(state.stub);
      state.stub.replacePromptReplyRules(buildPromptPackBenchmarkReplyRules());
      state.promptPackBenchmarkDispatchBaseline = state.stub.completionDispatchRecords().length;
      return {
        status: models.status,
        outcome: `verification-stub was reachable with ${PROMPT_PACK_BENCHMARK_MODELS[0]} before the four-item benchmark`,
      };
    }
    case "prompt-pack-benchmark-provider-dispatch": {
      if (typeof state.stub?.completionDispatchRecords !== "function") {
        throw new Error("deterministic provider does not expose benchmark dispatch records");
      }
      const captured = resolveCapturedPromptPackBenchmark(state, "promptPackBenchmarkRunId", "prompt-pack benchmark");
      const canonical = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/prompt-packs/benchmark/${encodeURIComponent(captured.benchmarkRunId)}`,
        {},
        probe,
      );
      const canonicalEvidence = validatePromptPackBenchmarkStatus(canonical.body, {
        benchmarkRunId: captured.benchmarkRunId,
        packId: captured.packId,
      });
      const evidence = validatePromptPackBenchmarkDispatchRecords(
        state.stub.completionDispatchRecords(),
        state.promptPackBenchmarkDispatchBaseline,
      );
      return {
        status: canonical.status,
        outcome: `${canonicalEvidence.completedItems}/${canonicalEvidence.totalItems} canonical benchmark rows; ${evidence.executionDispatches} exact executions, ${evidence.memoryDistillerDispatches} purpose-tagged memory distillers, and ${evidence.judgeDispatches} prompt-tagged score judges across ${evidence.models.join(", ")}`,
      };
    }
    case "project-revision-conflict":
      return await proveProjectRevisionConflict(state.gatewayUrl, state.fixture.workspaceId);
    case "project-revision-persisted":
      return await proveProjectRevisionPersistence(state.gatewayUrl, state.fixture.workspaceId);
    case "note-revision-conflict":
      return await proveNoteRevisionConflict(state.gatewayUrl, state.fixture.workspaceId);
    case "settings-revision-conflict":
      return await proveSettingsRevisionConflict(state.gatewayUrl);
    case "workspace-isolation": {
      const response = await checkedRequest(state.gatewayUrl, "/api/v1/workspaces?view=all&limit=500", {}, probe);
      if (!Array.isArray(response.body?.items) || response.body.items.length < 2) {
        throw new Error("workspace isolation probe requires at least two isolated workspaces");
      }
      const ids = response.body.items.map((item) => item.workspaceId);
      if (new Set(ids).size !== ids.length) throw new Error("workspace isolation returned duplicate identities");
      return { status: response.status, outcome: `${ids.length} distinct workspace identities` };
    }
    case "workspace-lifecycle-active": {
      const response = await checkedRequest(state.gatewayUrl, "/api/v1/workspaces?view=all&limit=500", {}, probe);
      const workspace = Array.isArray(response.body?.items)
        ? response.body.items.find((item) => item?.name === "Usability browser workspace")
        : undefined;
      if (!workspace?.workspaceId || workspace.lifecycleStatus !== "active") {
        throw new Error("restored usability workspace is absent or not canonically active");
      }
      return { status: response.status, outcome: `workspace ${workspace.workspaceId} restored to active lifecycle` };
    }
    case "citadel-isolation": {
      const before = await checkedRequest(state.gatewayUrl, "/api/v1/citadels?view=all&limit=500", {}, probe);
      if (!Array.isArray(before.body?.items)) throw new Error("citadel list is malformed");
      const activeFixture = before.body.items.find((item) => item?.citadelId === state.fixture.citadelId);
      if (!activeFixture) throw new Error("active fixture Citadel is absent before the isolation probe");
      const isolatedId = "usability-browser-isolated-citadel";
      await checkedRequest(
        state.gatewayUrl,
        "/api/v1/citadels",
        {
          method: "POST",
          body: {
            citadelId: isolatedId,
            name: "Usability Browser Isolated Citadel",
            slug: isolatedId,
            kind: "project",
            description: "Deterministic isolated Citadel identity for Chromium usability proof.",
          },
        },
        probe,
      );
      const after = await checkedRequest(state.gatewayUrl, "/api/v1/citadels?view=all&limit=500", {}, probe);
      const ids = Array.isArray(after.body?.items) ? after.body.items.map((item) => item?.citadelId) : [];
      if (!ids.includes(state.fixture.citadelId) || !ids.includes(isolatedId) || new Set(ids).size !== ids.length) {
        throw new Error("Citadel create/isolation probe did not preserve distinct canonical identities");
      }
      const archived = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/citadels/${encodeURIComponent(isolatedId)}/archive`,
        { method: "POST", body: {} },
        probe,
      );
      if (archived.body?.lifecycleStatus !== "archived") {
        throw new Error("isolated Citadel cleanup did not archive the created identity");
      }
      return { status: archived.status, outcome: `${ids.length} distinct Citadels; isolated fixture archived` };
    }
    case "notification-rule-archive-readback": {
      const archived = await waitForNotificationArchiveReadback(state, {
        probe,
        ruleState: "archived",
        targetState: "active",
      });
      state.notificationArchiveEvidence = {
        ruleId: archived.rule.ruleId,
        targetId: archived.target.targetId,
      };
      return {
        status: archived.status,
        outcome: `notification rule ${archived.rule.ruleId} archived while destination ${archived.target.targetId} remained active`,
      };
    }
    case "notification-archive-and-non-operator-denial": {
      const expected = state.notificationArchiveEvidence;
      if (!expected?.ruleId || !expected?.targetId) {
        throw new Error("notification rule archive readback did not capture exact canonical identities");
      }
      const archived = await waitForNotificationArchiveReadback(state, {
        probe,
        ruleState: "archived",
        targetState: "archived",
        expected,
      });
      const response = await requestJson(state.gatewayUrl, "/api/v1/notifications/targets", {
        headers: {
          authorization: "Bearer definitely-not-the-operator",
          "x-forwarded-for": "198.51.100.29",
        },
      });
      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`non-operator notification request was not denied (${response.status})`);
      }
      return {
        status: response.status,
        outcome: `exact notification destination ${archived.target.targetId} and rule ${archived.rule.ruleId} archived canonically; non-operator denied`,
      };
    }
    case "runtime-health-read": {
      const health = await checkedRequest(state.gatewayUrl, "/health", {}, probe);
      return { status: health.status, outcome: "Gateway health read" };
    }
    case "runtime-diagnostic-fixture": {
      const snapshot = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/dev/verification/diagnostics-snapshot?limit=50",
        {},
        probe,
      );
      if (!Array.isArray(snapshot.body?.items)) throw new Error("diagnostic fixture returned no items array");
      return { status: snapshot.status, outcome: `${snapshot.body.items.length} diagnostic rows` };
    }
    case "invalid-provider-credential": {
      const oauth = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/llm/providers/openai-codex/oauth/status",
        {},
        probe,
      );
      if (oauth.body?.connected === true) {
        throw new Error("isolated OpenAI Codex OAuth state unexpectedly reports a connected credential");
      }
      const preview = await requestJson(state.gatewayUrl, "/api/v1/llm/models/preview", {
        method: "POST",
        headers: operatorHeaders(),
        body: {
          providerId: "verification-invalid-credential",
          baseUrl: requireText(state.fixture.settings?.llmStubBaseUrl, "deterministic provider URL"),
          apiStyle: "openai-chat-completions",
          apiKeyEnv: "GOATCITADEL_VERIFY_INTENTIONALLY_MISSING_KEY",
        },
      });
      if (preview.ok) {
        if (
          preview.body?.source === "live" ||
          !/401|credential|unauthorized|api key/i.test(preview.body?.warning ?? "")
        ) {
          throw new Error(`invalid provider credential did not fail closed: ${JSON.stringify(preview.body)}`);
        }
      } else if (preview.status !== 400 && preview.status !== 401) {
        throw new Error(`invalid provider credential returned unexpected status ${preview.status}`);
      }
      return {
        status: preview.status,
        outcome: `OAuth stayed disconnected; missing provider credential failed closed (${preview.body?.source ?? preview.status})`,
      };
    }
    case "authenticated-access-variants": {
      await checkedRequest(state.gatewayUrl, "/api/v1/settings", {}, probe);
      const device = await requestJson(state.gatewayUrl, "/api/v1/settings", {
        headers: { authorization: `Bearer ${requireText(state.fixture.settings?.deviceToken, "device token")}` },
      });
      if (device.status !== 403) {
        throw new Error(`active device principal did not reach the operator boundary as forbidden (${device.status})`);
      }
      return {
        status: device.status,
        outcome: "operator token persisted; active device principal denied operator settings",
      };
    }
    case "revoked-credential-denial": {
      const revoked = await requestJson(state.gatewayUrl, "/api/v1/settings", {
        headers: {
          authorization: `Bearer ${requireText(state.fixture.settings?.deviceToken, "revoked device token")}`,
        },
      });
      if (revoked.status !== 401) {
        throw new Error(`revoked device credential was not rejected as unauthenticated (${revoked.status})`);
      }
      return { status: revoked.status, outcome: "revoked device credential denied" };
    }
    case "tool-deny-wins": {
      const profiles = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/tools/permission-profiles?workspaceId=${encodeURIComponent(state.fixture.workspaceId)}`,
        {},
        probe,
      );
      const profile = profiles.body?.items?.find((item) => item?.label === "Usability deny-wins profile");
      if (!profile?.profileId || !profile.deny?.includes("fs.write") || !profile.allow?.includes("fs.*")) {
        throw new Error("deterministic deny-wins permission profile is absent or malformed");
      }
      const response = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/tools/access/evaluate",
        {
          method: "POST",
          body: {
            toolName: "fs.write",
            agentId: "verification-usability-browser",
            workspaceId: state.fixture.workspaceId,
            sessionId: state.sessionId,
            trustLevel: "untrusted_external",
            surface: "tools",
            permissionProfileId: profile.profileId,
          },
        },
        probe,
      );
      if (response.body?.allowed !== false) {
        throw new Error("explicit permission-profile deny did not win over its allow pattern");
      }
      return { status: response.status, outcome: `profile ${profile.profileId} denied fs.write despite fs.* allow` };
    }
    case "tool-approval-boundary": {
      const response = await checkedRequest(
        state.gatewayUrl,
        "/api/v1/tools/access/evaluate",
        {
          method: "POST",
          body: {
            toolName: "fs.write",
            agentId: "verification-usability-browser",
            workspaceId: state.fixture.workspaceId,
            sessionId: state.sessionId,
            trustLevel: "untrusted_external",
            surface: "tools",
          },
        },
        probe,
      );
      if (response.body?.allowed === true && response.body?.requiresApproval !== true) {
        throw new Error("high-risk tool was neither denied nor approval-gated");
      }
      return { status: response.status, outcome: response.body?.allowed ? "approval required" : "denied" };
    }
    default:
      throw new Error(`unimplemented canonical API probe: ${probe}`);
  }
}

async function proveProjectRevisionConflict(gatewayUrl, workspaceId) {
  const listed = await checkedRequest(
    gatewayUrl,
    `/api/v1/chat/projects?view=all&limit=500&workspaceId=${encodeURIComponent(workspaceId)}`,
    {},
    "project conflict",
  );
  const project = listed.body?.items?.find((item) => item.name === "Usability browser project");
  if (!project?.projectId || !Number.isInteger(project.revision)) throw new Error("created project was not canonical");
  const route = `/api/v1/chat/projects/${encodeURIComponent(project.projectId)}`;
  await checkedRequest(
    gatewayUrl,
    route,
    { method: "PATCH", body: { expectedRevision: project.revision, description: "Concurrent fixture edit." } },
    "project conflict canonical update",
  );
  const stale = await requestJson(
    gatewayUrl,
    route,
    withOperatorAuth({
      method: "PATCH",
      body: { expectedRevision: project.revision, description: "Stale browser edit." },
    }),
  );
  if (stale.status !== 409) throw new Error(`project stale revision returned ${stale.status}, expected 409`);
  return { status: stale.status, outcome: "stale project revision rejected" };
}

async function proveProjectRevisionPersistence(gatewayUrl, workspaceId) {
  const listed = await checkedRequest(
    gatewayUrl,
    `/api/v1/chat/projects?view=all&limit=500&workspaceId=${encodeURIComponent(workspaceId)}`,
    {},
    "project conflict persistence",
  );
  const project = listed.body?.items?.find((item) => item.name === "Usability browser project");
  if (
    !project?.projectId ||
    !Number.isInteger(project.revision) ||
    project.description !== "Local draft preserved across the revision conflict."
  ) {
    throw new Error("project conflict retry did not persist the exact browser draft canonically");
  }
  return {
    status: listed.status,
    outcome: `project ${project.projectId} persisted browser draft at revision ${project.revision}`,
  };
}

async function proveNoteRevisionConflict(gatewayUrl, workspaceId) {
  const listed = await checkedRequest(
    gatewayUrl,
    `/api/v1/notes?workspaceId=${encodeURIComponent(workspaceId)}`,
    {},
    "note conflict",
  );
  const note = listed.body?.items?.find((item) => item.title === "Usability browser note");
  if (!note?.noteId || !Number.isInteger(note.revision)) throw new Error("created note was not canonical");
  const route = `/api/v1/notes/${encodeURIComponent(note.noteId)}`;
  await checkedRequest(
    gatewayUrl,
    route,
    { method: "PATCH", body: { expectedRevision: note.revision, workspaceId, body: "Concurrent fixture edit." } },
    "note conflict canonical update",
  );
  const stale = await requestJson(
    gatewayUrl,
    route,
    withOperatorAuth({
      method: "PATCH",
      body: { expectedRevision: note.revision, workspaceId, body: "Stale browser edit." },
    }),
  );
  if (stale.status !== 409) throw new Error(`note stale revision returned ${stale.status}, expected 409`);
  return { status: stale.status, outcome: "stale note revision rejected" };
}

async function proveSettingsRevisionConflict(gatewayUrl) {
  const settings = await checkedRequest(gatewayUrl, "/api/v1/settings", {}, "settings conflict");
  if (!Number.isInteger(settings.body?.revision)) throw new Error("settings response has no revision");
  const expectedRevision = settings.body.revision;
  await checkedRequest(
    gatewayUrl,
    "/api/v1/settings",
    { method: "PATCH", body: { expectedRevision, budgetMode: settings.body.budgetMode } },
    "settings conflict canonical update",
  );
  const stale = await requestJson(
    gatewayUrl,
    "/api/v1/settings",
    withOperatorAuth({
      method: "PATCH",
      body: { expectedRevision, budgetMode: settings.body.budgetMode },
    }),
  );
  if (stale.status !== 409) throw new Error(`settings stale revision returned ${stale.status}, expected 409`);
  return { status: stale.status, outcome: "stale settings revision rejected" };
}

export function resolveNotificationArchiveFixture(targetItems, ruleItems, workspaceId, expected = {}) {
  const matchingTargets = (Array.isArray(targetItems) ? targetItems : []).filter(
    (item) => item?.workspaceId === workspaceId && item?.label === "Usability notification destination",
  );
  const matchingRules = (Array.isArray(ruleItems) ? ruleItems : []).filter(
    (item) => item?.workspaceId === workspaceId && item?.label === "Usability notification rule",
  );
  if (matchingTargets.length !== 1) {
    throw new Error(`notification destination readback found ${matchingTargets.length} exact matches`);
  }
  if (matchingRules.length !== 1) {
    throw new Error(`notification rule readback found ${matchingRules.length} exact matches`);
  }
  const target = matchingTargets[0];
  const rule = matchingRules[0];
  if (
    typeof target.targetId !== "string" ||
    typeof target.lifecycleState !== "string" ||
    typeof rule.ruleId !== "string" ||
    typeof rule.lifecycleState !== "string"
  ) {
    throw new Error("notification archive readback is missing canonical IDs or lifecycleState fields");
  }
  if (expected.targetId !== undefined && target.targetId !== expected.targetId) {
    throw new Error(`notification destination identity drifted from ${expected.targetId} to ${target.targetId}`);
  }
  if (expected.ruleId !== undefined && rule.ruleId !== expected.ruleId) {
    throw new Error(`notification rule identity drifted from ${expected.ruleId} to ${rule.ruleId}`);
  }
  if (!Array.isArray(rule.targetIds) || rule.targetIds.length !== 1 || rule.targetIds[0] !== target.targetId) {
    throw new Error("notification rule does not retain its one exact fixture destination");
  }
  return { target, rule };
}

async function waitForNotificationArchiveReadback(state, options) {
  const query = `workspaceId=${encodeURIComponent(state.fixture.workspaceId)}&includeArchived=true&limit=500`;
  let latest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [targets, rules] = await Promise.all([
      checkedRequest(state.gatewayUrl, `/api/v1/notifications/targets?${query}`, {}, options.probe),
      checkedRequest(state.gatewayUrl, `/api/v1/notifications/rules?${query}`, {}, options.probe),
    ]);
    latest = resolveNotificationArchiveFixture(
      targets.body?.items,
      rules.body?.items,
      state.fixture.workspaceId,
      options.expected,
    );
    if (latest.rule.lifecycleState === options.ruleState && latest.target.lifecycleState === options.targetState) {
      return { ...latest, status: Math.max(targets.status, rules.status) };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `notification archive state did not settle canonically (rule=${String(latest?.rule?.lifecycleState)}, target=${String(latest?.target?.lifecycleState)}; expected rule=${options.ruleState}, target=${options.targetState})`,
  );
}

async function waitForPromptPackProviderQuiet(stub, options = {}) {
  const quietMs = options.quietMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let records = stub.completionDispatchRecords();
  let lastCount = records.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    records = stub.completionDispatchRecords();
    if (records.length !== lastCount) {
      lastCount = records.length;
      quietSince = Date.now();
      continue;
    }
    const allSettled = records.every(
      (record) => typeof record?.finishedAt === "string" && typeof record?.outcome === "string",
    );
    if (allSettled && Date.now() - quietSince >= quietMs) {
      return records.length;
    }
  }
  throw new Error(
    `deterministic provider did not become dispatch-quiet before the compare baseline (observed ${lastCount} completion dispatches)`,
  );
}

function resolveCapturedPromptPackBenchmark(state, stateKey, label) {
  const captured = state.capturedJsonResponses?.[stateKey];
  if (!captured?.value || typeof captured.dispose !== "function") {
    throw new Error(`${label} start response was not captured from the exact browser click`);
  }
  captured.dispose();
  if (captured.matchingResponses.length !== 1) {
    throw new Error(
      `${label} click produced ${captured.matchingResponses.length} matching start responses; expected exactly one`,
    );
  }
  const packMatch = captured.requestPath.match(/^\/api\/v1\/prompt-packs\/([^/]+)\/benchmark\/run$/u);
  if (!packMatch) throw new Error(`captured ${label} path is malformed: ${captured.requestPath}`);
  return {
    benchmarkRunId: captured.value,
    packId: decodeURIComponent(packMatch[1]),
  };
}

async function checkedRequest(gatewayUrl, route, init, label) {
  const response = await requestJson(gatewayUrl, route, withOperatorAuth(init));
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(response.body)}`);
  return response;
}

async function waitForSkillLifecycleReadback(state, expectedState, label) {
  const evidence = state.skillLifecycleApprovalEvidence;
  if (!evidence || evidence.skillId !== "bundled:coding") {
    throw new Error("skill lifecycle approval baseline was not captured in this exact browser step");
  }
  const excludedApprovalIds = new Set([...evidence.baselineApprovalIds, ...evidence.observedApprovalIds]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [skills, approvals] = await Promise.all([
      checkedRequest(state.gatewayUrl, "/api/v1/skills", {}, label),
      checkedRequest(state.gatewayUrl, "/api/v1/approvals?limit=200", {}, label),
    ]);
    const codingSkills = (Array.isArray(skills.body?.items) ? skills.body.items : []).filter(
      (item) => item?.skillId === evidence.skillId && item?.name === "coding",
    );
    if (codingSkills.length !== 1 || typeof codingSkills[0]?.state !== "string") {
      throw new Error(`skill lifecycle readback lost canonical ${evidence.skillId}`);
    }
    const pendingApprovals = (Array.isArray(approvals.body?.items) ? approvals.body.items : []).filter(
      (item) =>
        typeof item?.approvalId === "string" &&
        !excludedApprovalIds.has(item.approvalId) &&
        item.status === "pending" &&
        item.kind === "skill.lifecycle" &&
        item.preview?.action === "skill_state_set" &&
        item.preview?.skillId === evidence.skillId &&
        item.preview?.state === expectedState,
    );
    if (pendingApprovals.length > 1) {
      throw new Error(`skill lifecycle ${expectedState} request created multiple canonical pending approvals`);
    }
    if (codingSkills[0].state === expectedState) {
      if (pendingApprovals.length !== 0) {
        throw new Error(`skill lifecycle ${expectedState} readback found both a no-op state and a pending mutation`);
      }
      return {
        status: skills.status,
        outcome: `${evidence.skillId} was already ${expectedState}; canonical no-op state retained`,
      };
    }
    if (pendingApprovals.length === 1) {
      evidence.observedApprovalIds.push(pendingApprovals[0].approvalId);
      return {
        status: approvals.status,
        outcome: `${evidence.skillId} ${expectedState} request persisted as approval ${pendingApprovals[0].approvalId}; canonical state remains ${codingSkills[0].state}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `skill lifecycle ${expectedState} request produced neither canonical state nor an exact pending approval`,
  );
}

export function validatePromptPackBenchmarkDispatchRecords(records, baselineCount) {
  if (!Array.isArray(records)) throw new Error("prompt-pack benchmark provider returned no dispatch records");
  if (!Number.isInteger(baselineCount) || baselineCount < 0 || baselineCount > records.length) {
    throw new Error("prompt-pack benchmark provider baseline is missing or invalid");
  }
  const benchmarkRecords = records.slice(baselineCount);
  for (const record of benchmarkRecords) {
    if (record?.outcome !== "success" || record?.status !== 200) {
      throw new Error(`prompt-pack benchmark provider dispatch did not succeed: ${JSON.stringify(record)}`);
    }
  }

  const executions = benchmarkRecords.filter(
    (record) => record?.stream === true && record?.promptReplyRuleId === undefined,
  );
  const judges = benchmarkRecords.filter((record) => record?.promptReplyRuleId === PROMPT_PACK_BENCHMARK_JUDGE_RULE_ID);
  const memoryDistillers = benchmarkRecords.filter(
    (record) => record?.promptReplyRuleId === PROMPT_PACK_MEMORY_DISTILLER_RULE_ID,
  );
  const classified = new Set([...executions, ...memoryDistillers, ...judges]);
  const unclassified = benchmarkRecords.filter((record) => !classified.has(record));
  if (unclassified.length > 0) {
    throw new Error(
      `prompt-pack benchmark observed ${unclassified.length} unclassified provider dispatches: ${JSON.stringify(
        summarizePromptPackDispatchRecords(unclassified),
      )}`,
    );
  }
  if (executions.length !== 4) {
    throw new Error(
      `prompt-pack benchmark dispatched ${executions.length} streamed executions; expected 4: ${JSON.stringify(
        summarizePromptPackDispatchRecords(benchmarkRecords),
      )}`,
    );
  }
  if (judges.length !== 4) {
    throw new Error(
      `prompt-pack benchmark dispatched ${judges.length} prompt-tagged judges; expected 4: ${JSON.stringify(
        summarizePromptPackDispatchRecords(benchmarkRecords),
      )}`,
    );
  }
  if (memoryDistillers.length !== 2) {
    throw new Error(
      `prompt-pack benchmark dispatched ${memoryDistillers.length} purpose-tagged memory distillers; expected 2: ${JSON.stringify(
        summarizePromptPackDispatchRecords(benchmarkRecords),
      )}`,
    );
  }
  for (const model of PROMPT_PACK_BENCHMARK_MODELS) {
    const executionMatches = executions.filter((record) => record?.model === model);
    const judgeMatches = judges.filter((record) => record?.model === model);
    if (executionMatches.length !== 2 || judgeMatches.length !== 2) {
      throw new Error(
        `prompt-pack benchmark model ${model} received ${executionMatches.length} executions and ${judgeMatches.length} judges; expected 2 and 2`,
      );
    }
  }
  if (executions.some((record) => record?.messageCount !== 4 || record?.behavior !== undefined)) {
    throw new Error("prompt-pack benchmark streamed execution signature drifted");
  }
  if (
    judges.some(
      (record) => record?.stream !== false || record?.messageCount !== 3 || record?.behavior !== "prompt_reply_rule",
    )
  ) {
    throw new Error("prompt-pack benchmark judge signature drifted or required a repair attempt");
  }
  if (
    memoryDistillers.some(
      (record) =>
        record?.model !== PROMPT_PACK_BENCHMARK_MODELS[0] ||
        record?.stream !== false ||
        record?.messageCount !== 2 ||
        record?.behavior !== "prompt_reply_rule",
    )
  ) {
    throw new Error("prompt-pack memory-distiller dispatch signature drifted");
  }
  return {
    dispatchCount: benchmarkRecords.length,
    executionDispatches: executions.length,
    memoryDistillerDispatches: memoryDistillers.length,
    judgeDispatches: judges.length,
    models: [...PROMPT_PACK_BENCHMARK_MODELS],
  };
}

function summarizePromptPackDispatchRecords(records) {
  return records.map((record) => ({
    model: record?.model,
    stream: record?.stream,
    messageCount: record?.messageCount,
    behavior: record?.behavior,
    promptReplyRuleId: record?.promptReplyRuleId,
    promptMetadata: record?.promptMetadata,
    outcome: record?.outcome,
    status: record?.status,
    startedAt: record?.startedAt,
    finishedAt: record?.finishedAt,
  }));
}

export function validatePromptPackBenchmarkStatus(payload, expected) {
  const run = payload?.run;
  if (
    run?.benchmarkRunId !== expected?.benchmarkRunId ||
    run?.packId !== expected?.packId ||
    run?.status !== "completed" ||
    run?.executionStyle !== "single_turn_harness"
  ) {
    throw new Error(`prompt-pack canonical benchmark identity or terminal status drifted: ${JSON.stringify(run)}`);
  }
  if (
    !isDeepStrictEqual(run.testCodes, ["TEST-91", "TEST-92"]) ||
    !isDeepStrictEqual(
      run.providers,
      PROMPT_PACK_BENCHMARK_MODELS.map((model) => ({ providerId: "verification-stub", model })),
    )
  ) {
    throw new Error("prompt-pack canonical benchmark tests or provider matrix drifted");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(run.packContentSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(run.policyHash ?? "") ||
    !/^[a-f0-9]{64}$/u.test(run.testSnapshotSha256 ?? "") ||
    !Number.isFinite(Date.parse(run.startedAt ?? "")) ||
    !Number.isFinite(Date.parse(run.finishedAt ?? ""))
  ) {
    throw new Error("prompt-pack canonical benchmark is missing immutable hashes or terminal timestamps");
  }
  if (payload?.progress?.totalItems !== 4 || payload?.progress?.completedItems !== 4) {
    throw new Error(`prompt-pack canonical benchmark progress is not 4/4: ${JSON.stringify(payload?.progress)}`);
  }
  if (!Array.isArray(payload.modelSummaries) || payload.modelSummaries.length !== 2) {
    throw new Error("prompt-pack canonical benchmark did not return two model summaries");
  }
  for (const model of PROMPT_PACK_BENCHMARK_MODELS) {
    const matches = payload.modelSummaries.filter(
      (summary) => summary?.providerId === "verification-stub" && summary?.model === model,
    );
    if (
      matches.length !== 1 ||
      matches[0]?.total !== 2 ||
      matches[0]?.scored !== 2 ||
      matches[0]?.runFailures !== 0 ||
      matches[0]?.approvalPausedCount !== 0 ||
      matches[0]?.noOutputCount !== 0
    ) {
      throw new Error(`prompt-pack canonical benchmark summary drifted for ${model}: ${JSON.stringify(matches)}`);
    }
  }
  return { totalItems: 4, completedItems: 4, models: [...PROMPT_PACK_BENCHMARK_MODELS] };
}

export function validatePromptPackRunAllStatus(payload, expected) {
  const run = payload?.run;
  if (
    run?.benchmarkRunId !== expected?.benchmarkRunId ||
    run?.packId !== expected?.packId ||
    run?.status !== "completed" ||
    run?.executionStyle !== "single_turn_harness" ||
    !isDeepStrictEqual(run.testCodes, ["TEST-91", "TEST-92"]) ||
    !isDeepStrictEqual(run.providers, [{ providerId: "verification-stub", model: PROMPT_PACK_BENCHMARK_MODELS[0] }])
  ) {
    throw new Error(`prompt-pack run-all identity, matrix, or terminal status drifted: ${JSON.stringify(run)}`);
  }
  if (payload?.progress?.totalItems !== 2 || payload?.progress?.completedItems !== 2) {
    throw new Error(`prompt-pack run-all progress is not 2/2: ${JSON.stringify(payload?.progress)}`);
  }
  const summaries = Array.isArray(payload.modelSummaries) ? payload.modelSummaries : [];
  if (
    summaries.length !== 1 ||
    summaries[0]?.providerId !== "verification-stub" ||
    summaries[0]?.model !== PROMPT_PACK_BENCHMARK_MODELS[0] ||
    summaries[0]?.total !== 2 ||
    summaries[0]?.scored !== 2 ||
    summaries[0]?.runFailures !== 0 ||
    summaries[0]?.approvalPausedCount !== 0 ||
    summaries[0]?.noOutputCount !== 0
  ) {
    throw new Error(`prompt-pack run-all scoring did not settle canonically: ${JSON.stringify(summaries)}`);
  }
  return { totalItems: 2, completedItems: 2, models: [PROMPT_PACK_BENCHMARK_MODELS[0]] };
}

export function withOperatorAuth(init = {}) {
  return {
    ...init,
    headers: { ...operatorHeaders(), ...(init?.headers ?? {}) },
  };
}

function operatorHeaders() {
  return { authorization: `Bearer ${OPERATOR_TOKEN}` };
}

async function createActionSession(gatewayUrl, workspaceId) {
  const created = await checkedRequest(
    gatewayUrl,
    "/api/v1/chat/sessions",
    { method: "POST", body: { title: "Usability browser action session", workspaceId } },
    "create action session",
  );
  if (!created.body?.sessionId) throw new Error("action session returned no sessionId");
  return created.body;
}

export async function prepareCodeModeVerificationProject(runtimeRoot) {
  const workspacePath = "code-mode-verification-project";
  const absolutePath = path.join(runtimeRoot, "workspace", workspacePath);
  await fs.mkdir(absolutePath, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(absolutePath, "README.md"),
      "# Deterministic Code Mode verification fixture\n\nThis isolated repository exists only for pre-QA named proof.\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(absolutePath, "package.json"),
      `${JSON.stringify(
        {
          name: "goatcitadel-code-mode-verification-fixture",
          private: true,
          version: "1.0.0",
          scripts: { test: 'node -e "process.exit(0)"' },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
  execFileSync("git", ["init"], { cwd: absolutePath, stdio: "ignore" });
  // Keep the isolated fixture byte-stable across hosts. In particular, a
  // Windows system/global core.autocrlf=true must not make the worktree look
  // dirty when named-proof capture intentionally ignores ambient Git config.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: absolutePath });
  execFileSync("git", ["config", "user.email", "usability-code-mode@example.invalid"], { cwd: absolutePath });
  execFileSync("git", ["config", "user.name", "GoatCitadel Usability Verification"], { cwd: absolutePath });
  execFileSync("git", ["add", "README.md", "package.json"], { cwd: absolutePath });
  execFileSync("git", ["commit", "-m", "Initialize deterministic Code Mode fixture"], {
    cwd: absolutePath,
    stdio: "ignore",
  });
  return { absolutePath, workspacePath };
}

async function seedOpsBrowserActionFixture(gatewayUrl, fixture) {
  const excludedSessionIds = new Set(
    [fixture.sessionId, fixture.sessions?.userInput].filter((value) => typeof value === "string" && value.length > 0),
  );
  const sessionId = fixture.sessionIds?.find((candidate) => !excludedSessionIds.has(candidate));
  if (!sessionId) throw new Error("Ops browser actions require a second isolated approval session");
  const approval = await checkedRequest(
    gatewayUrl,
    "/api/v1/dev/verification/chat-approval-scenario",
    { method: "POST", body: { sessionId, workspaceId: fixture.workspaceId } },
    "seed Ops approval fixture",
  );
  const durableRunId = approval.body?.approvalWaitRunId;
  const approvalId = approval.body?.approvalId;
  if (!durableRunId || !approvalId) throw new Error("Ops approval fixture returned no canonical approval wait run");
  fixture.sessions = { ...(fixture.sessions ?? {}), opsApproval: sessionId };
  fixture.runs = { ...(fixture.runs ?? {}), opsApproval: durableRunId };
  fixture.approvals = { ...(fixture.approvals ?? {}), ops: approvalId };
}

async function seedLibraryBrowserActionFixture(gatewayUrl, workspaceId) {
  const connection = await checkedRequest(
    gatewayUrl,
    "/api/v1/integrations/connections",
    {
      method: "POST",
      body: {
        catalogId: "automation.gmail",
        label: "Verification uncredentialed communications",
        workspaceId,
        enabled: false,
        status: "disconnected",
        config: {
          address: "verification-inbox@example.invalid",
          verificationCommunicationsFixture: {
            schemaVersion: 1,
            mode: "uncredentialed-read-only",
            messages: [
              {
                id: "fixture-message-1",
                from: "fixture-sender@example.invalid",
                to: ["verification-inbox@example.invalid"],
                subject: "Fixture inbox readiness",
                snippet: "Deterministic inbox content; no provider credential was configured.",
                receivedAt: "2026-07-29T15:00:00.000Z",
                labels: ["INBOX"],
              },
            ],
            events: [
              {
                id: "fixture-event-1",
                calendarId: "verification-calendar",
                title: "Fixture usability agenda",
                description: "Deterministic calendar content from the isolated verification fixture.",
                startIso: "2026-07-30T16:00:00.000Z",
                endIso: "2026-07-30T16:30:00.000Z",
                attendees: ["verification-inbox@example.invalid"],
              },
            ],
          },
        },
      },
    },
    "seed Library Communications fixture",
  );
  return {
    communicationsConnectionId: requireText(connection.body?.connectionId, "communications connection ID"),
  };
}

async function seedSettingsBrowserActionFixture(gatewayUrl, fixtureBaseUrl, workspaceId) {
  const deviceRequest = await requestJson(gatewayUrl, "/api/v1/auth/device-requests", {
    method: "POST",
    body: {
      deviceLabel: "Verification usability device",
      deviceType: "desktop",
      platform: "windows",
    },
  });
  if (!deviceRequest.ok) {
    throw new Error(
      `seed Settings device request failed (${deviceRequest.status}): ${JSON.stringify(deviceRequest.body)}`,
    );
  }
  const approvalId = requireText(deviceRequest.body?.approvalId, "device approval ID");
  const requestId = requireText(deviceRequest.body?.requestId, "device request ID");
  const requestSecret = requireText(deviceRequest.body?.requestSecret, "device request secret");
  await checkedRequest(
    gatewayUrl,
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
    {
      method: "POST",
      body: {
        decision: "approve",
        resolvedBy: "verification-usability-browser-actions",
        resolutionNote: "Deterministic isolated Settings device grant.",
      },
    },
    "approve Settings device fixture",
  );
  const deviceStatus = await waitForApprovedDeviceRequest(gatewayUrl, requestId, requestSecret);
  const deviceToken = requireText(deviceStatus.body?.deviceToken, "approved device token");
  const deviceGrants = await checkedRequest(
    gatewayUrl,
    "/api/v1/auth/devices?view=all",
    {},
    "read approved Settings device grant",
  );
  const deviceGrantId = requireText(
    deviceGrants.body?.items?.find((item) => item?.requestId === requestId)?.grantId,
    "device grant ID",
  );

  const diagnosticsConnection = await checkedRequest(
    gatewayUrl,
    "/api/v1/integrations/connections",
    {
      method: "POST",
      body: {
        catalogId: "automation.webhooks",
        label: "Verification webhook diagnostics",
        enabled: false,
        status: "disconnected",
        config: { baseUrl: fixtureBaseUrl, method: "POST", enabled: false },
      },
    },
    "seed Settings integration diagnostics fixture",
  );
  const sandboxConnection = await checkedRequest(
    gatewayUrl,
    "/api/v1/integrations/connections",
    {
      method: "POST",
      body: {
        catalogId: "productivity.apple-notes",
        label: "Verification sandbox bridge",
        enabled: true,
        status: "connected",
        config: { bridgeUrl: fixtureBaseUrl, actionRoute: "v1", enabled: true },
      },
    },
    "seed Settings sandbox integration fixture",
  );

  const channelDraft = await checkedRequest(
    gatewayUrl,
    "/api/v1/channels/drafts",
    { method: "POST", body: { catalogId: "channel.ntfy" } },
    "seed Settings channel draft",
  );
  const channelDraftId = requireText(channelDraft.body?.draftId, "channel draft ID");
  await checkedRequest(
    gatewayUrl,
    `/api/v1/channels/drafts/${encodeURIComponent(channelDraftId)}`,
    {
      method: "PATCH",
      body: {
        label: "Verification sandbox channel",
        enabled: true,
        draft: {
          baseUrl: fixtureBaseUrl,
          topic: "goatcitadel-verification",
          priority: "3",
          // Finalization intentionally requires a completed live check. The
          // loopback fixture below is the sandbox destination, so this proves
          // the real ntfy publish path without contacting an external service.
          dryRun: false,
        },
      },
    },
    "configure Settings channel draft",
  );

  const localMcp = await checkedRequest(
    gatewayUrl,
    "/api/v1/mcp/servers",
    {
      method: "POST",
      body: {
        label: "Verification local MCP",
        transport: "stdio",
        command: process.execPath,
        args: [
          path.resolve("bin/goatcitadel.mjs"),
          "mcp-server",
          "--gateway-url",
          gatewayUrl,
          "--agent-id",
          "verification-usability-browser",
          "--session-id",
          "verification-usability-mcp-session",
          "--workspace-id",
          workspaceId,
        ],
        authType: "none",
        enabled: true,
        category: "other",
        trustTier: "restricted",
        costTier: "free",
        policy: USABILITY_LOCAL_MCP_POLICY,
      },
    },
    "seed local MCP fixture",
  );
  const remoteMcp = await checkedRequest(
    gatewayUrl,
    "/api/v1/mcp/servers",
    {
      method: "POST",
      body: {
        label: "Verification remote MCP",
        transport: "http",
        url: fixtureBaseUrl,
        authType: "none",
        enabled: false,
        category: "other",
        trustTier: "restricted",
        costTier: "free",
      },
    },
    "seed remote MCP fixture",
  );

  return {
    deviceToken,
    deviceGrantId,
    diagnosticsConnectionId: diagnosticsConnection.body?.connectionId,
    sandboxConnectionId: sandboxConnection.body?.connectionId,
    channelDraftId,
    localMcpServerId: localMcp.body?.serverId,
    remoteMcpServerId: remoteMcp.body?.serverId,
  };
}

async function waitForApprovedDeviceRequest(gatewayUrl, requestId, requestSecret) {
  let latest;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/auth/device-requests/${encodeURIComponent(requestId)}/status`, {
      headers: { "x-goatcitadel-device-request-secret": requestSecret },
    });
    if (!latest.ok) {
      throw new Error(`read Settings device request failed (${latest.status}): ${JSON.stringify(latest.body)}`);
    }
    if (latest.body?.status === "approved" && typeof latest.body?.deviceToken === "string") return latest;
    if (latest.body?.status === "rejected" || latest.body?.status === "expired") {
      throw new Error(`Settings device request resolved as ${latest.body.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Settings device request did not resolve: ${JSON.stringify(latest?.body)}`);
}

export async function startSettingsBrowserFixtureServer() {
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
    if (method === "POST" && url.pathname === "/v1/integrations/actions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: "fixture bridge ok",
          output: { catalogId: body?.catalogId, actionId: body?.actionId, input: body?.input ?? {} },
        }),
      );
      return;
    }
    if (method === "POST" && url.pathname === "/goatcitadel-verification") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "verification-ntfy-message", accepted: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found", method, path: url.pathname }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Settings fixture server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeIdleConnections?.();
        for (const socket of sockets) socket.destroy();
      }),
  };
}

async function interactiveLocator(page, name, exact) {
  const pattern = exact ? name : new RegExp(escapeRegExp(name), "iu");
  const locator = [
    ...["button", "link", "tab", "menuitem", "option", "radio"].map((role) =>
      page.getByRole(role, { name: pattern, exact }),
    ),
    page.locator("summary").filter({ hasText: pattern }),
  ].reduce((combined, candidate) => combined.or(candidate));
  return await firstVisibleLocator(page, locator, `interactive control not found: ${name}`);
}

async function editableLocator(page, label) {
  const fuzzy = new RegExp(escapeRegExp(label), "iu");
  const candidates = [
    page.getByLabel(label, { exact: true }),
    page.getByPlaceholder(label, { exact: true }),
    page.getByLabel(fuzzy),
    page.getByPlaceholder(fuzzy),
  ];
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const locator = await resolveUniqueEditableLocatorCandidate(candidate, label);
      if (locator) return locator;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`editable control not found: ${label}`);
}

export async function resolveUniqueEditableLocatorCandidate(candidate, label) {
  const visibleEditable = [];
  const count = await candidate.count();
  for (let index = 0; index < count; index += 1) {
    const locator = candidate.nth(index);
    const editable = await locator
      .evaluate((element) => {
        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        return (
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select" ||
          element.getAttribute("contenteditable") === "true" ||
          role === "textbox" ||
          role === "combobox"
        );
      })
      .catch(() => false);
    if (editable && (await locator.isVisible().catch(() => false))) visibleEditable.push(locator);
  }
  if (visibleEditable.length > 1) {
    throw new Error(`ambiguous editable control: ${label} matched ${visibleEditable.length} visible editable controls`);
  }
  return visibleEditable[0];
}

async function firstVisibleLocator(page, locator, errorMessage, timeoutMs = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(errorMessage);
}

async function installBrowserOperatorAuthState(browserContext) {
  await browserContext.addInitScript(
    ({ token }) => {
      window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "session");
      window.sessionStorage.setItem("goatcitadel.gateway.auth", JSON.stringify({ mode: "token", token }));
    },
    { token: OPERATOR_TOKEN },
  );
}

function browserStepResult(input, result) {
  return {
    journeyId: input.registeredStep.bundleId,
    stepId: input.registeredStep.stepId,
    baseSha: input.baseSha,
    route: input.registeredStep.routeSlug,
    expectedResult: input.registeredStep.expectedResult,
    actualResult: result.actualResult,
    status: result.status,
    proofKind: "chromium-operator-action",
    operatorActions: result.operatorActions,
    evidence: [input.diagnosticRef],
    environment: "isolated-source",
    storage: "sqlite",
    profileState: "fixture",
    viewport: { width: 1440, height: 1024 },
    theme: "dark",
    provider: "verification-stub",
    startedAt: result.startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function redactFixtureValue(value) {
  return typeof value === "string" && value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function resolveRequestedBundleIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : typeof process.env.GOATCITADEL_USABILITY_BROWSER_BUNDLES === "string"
        ? process.env.GOATCITADEL_USABILITY_BROWSER_BUNDLES.split(",")
        : [];
  const bundleIds = raw.map((item) => String(item).trim()).filter(Boolean);
  if (bundleIds.length === 0) return null;
  const unknown = bundleIds.filter((bundleId) => !Object.hasOwn(BROWSER_ACTION_BUNDLES, bundleId));
  if (unknown.length > 0) throw new Error(`unknown usability browser action bundle(s): ${unknown.join(", ")}`);
  return new Set(bundleIds);
}

export function resolveSelectOption(options, operation) {
  const requestedValue = typeof operation.value === "string" ? operation.value : null;
  const requestedLabel =
    typeof operation.optionLabel === "string"
      ? operation.optionLabel
      : typeof operation.option === "string"
        ? operation.option
        : null;
  if (requestedValue !== null) return options.find((item) => item.value === requestedValue);
  if (requestedLabel === null) return undefined;
  return (
    options.find((item) => item.label === requestedLabel) ??
    options.find((item) => item.label.toLocaleLowerCase() === requestedLabel.toLocaleLowerCase())
  );
}

export function validatePersistedAgentDefaultTools(record, input) {
  if (!record || typeof record !== "object") {
    throw new Error("canonical agent detail is malformed");
  }
  if (record.agentId !== input.agentId || record.roleId !== input.expectedRoleId) {
    throw new Error(
      `canonical agent identity mismatch: expected ${input.agentId}/${input.expectedRoleId}, received ${String(record.agentId)}/${String(record.roleId)}`,
    );
  }
  if (!Array.isArray(record.defaultTools) || record.defaultTools.some((tool) => typeof tool !== "string")) {
    throw new Error("canonical agent defaultTools is malformed");
  }
  if (JSON.stringify(record.defaultTools) !== JSON.stringify(input.expectedTools)) {
    throw new Error(
      `canonical agent defaultTools mismatch: expected ${input.expectedTools.join(", ")}, received ${record.defaultTools.join(", ")}`,
    );
  }
}

export function validateResolvedBlockerEvidence(input) {
  if (!Array.isArray(input.approvals) || !Array.isArray(input.approvalTurns) || !Array.isArray(input.userInputTurns)) {
    throw new Error("approval/user-input canonical projections are malformed");
  }
  const approval = input.approvals.find(
    (item) =>
      item?.status === "approved" &&
      item?.linkage?.sessionId === input.approvalSessionId &&
      typeof item?.linkage?.turnId === "string" &&
      item.linkage.turnId.length > 0,
  );
  if (!approval) throw new Error(`approved decision not found for session ${input.approvalSessionId}`);
  const approvalTurn = input.approvalTurns.find((turn) => turn?.turnId === approval.linkage.turnId);
  assertResolvedTurn(approvalTurn, input.approvalSessionId, "approval");

  const userInputTurn = [...input.userInputTurns]
    .reverse()
    .find((turn) => typeof turn?.trace?.durable?.runId === "string" && turn.trace.durable.runId.length > 0);
  assertResolvedTurn(userInputTurn, input.userInputSessionId, "user-input");
  if (userInputTurn.trace.pendingUserInput !== undefined && userInputTurn.trace.pendingUserInput !== null) {
    throw new Error(`user-input blocker remains present on turn ${userInputTurn.turnId}`);
  }
  return {
    approvalId: approval.approvalId,
    approvalTurnId: approvalTurn.turnId,
    userInputTurnId: userInputTurn.turnId,
    userInputRunId: userInputTurn.trace.durable.runId,
  };
}

export function validateResolvedBlockerCapabilityProfile(envelope, expected) {
  const profile = envelope?.profile;
  const turn = expected.turn;
  const requestActor = expected.requestActor;
  if (envelope?.state !== "available" || !profile || !turn || !requestActor) {
    throw new Error(`resolved blocker capability profile is unavailable for session ${expected.sessionId}`);
  }
  const identity = profile.identity;
  const trace = turn.trace;
  const mismatches = [];
  const expectEqual = (label, actual, wanted) => {
    if (actual !== wanted) mismatches.push(label);
  };
  expectEqual("turn identity", identity?.turnId, turn.turnId);
  expectEqual("session identity", identity?.sessionId, expected.sessionId);
  expectEqual("workspace identity", identity?.workspaceId, expected.workspaceId);
  expectEqual("operator request actor", requestActor.actorKind, "operator");
  expectEqual("operator actor identity", requestActor.actorId, requestActor.operatorId);
  expectEqual("operator identity", identity?.operatorId, requestActor.operatorId);
  expectEqual("authenticated actor identity", identity?.authActorId, requestActor.authActorId);
  expectEqual("authenticated actor source", identity?.authActorSource, requestActor.authActorSource);
  expectEqual("durable run identity", identity?.durableRunId, trace?.durable?.runId);
  expectEqual("profile identity", profile.profileId, trace?.capabilityProfileId);
  expectEqual("profile hash", profile.hashes?.profileHash, trace?.capabilityProfileHash);
  if (mismatches.length > 0) {
    throw new Error(`resolved blocker capability profile mismatch: ${mismatches.join(", ")}`);
  }
  return true;
}

export async function pollResolvedBlockerEvidence(loadSnapshot, options = {}) {
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    const snapshot = await loadSnapshot();
    try {
      return { snapshot, evidence: validateResolvedBlockerEvidence(snapshot) };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(pollIntervalMs);
  } while (Date.now() < deadline);
  throw new Error(
    `approval/user-input canonical evidence did not settle within ${timeoutMs}ms: ${formatError(lastError)}`,
  );
}

export function resolveThreadDurableCorrelation(turns, sessionId) {
  if (!Array.isArray(turns)) throw new Error("chat thread returned no turns");
  const turn = [...turns]
    .reverse()
    .find(
      (candidate) =>
        candidate?.trace?.sessionId === sessionId &&
        candidate?.trace?.turnId === candidate?.turnId &&
        typeof candidate?.trace?.durable?.runId === "string" &&
        candidate.trace.durable.runId.length > 0,
    );
  if (!turn) throw new Error(`no durable Chat turn found for session ${sessionId}`);
  return { runId: turn.trace.durable.runId, sessionId, turnId: turn.turnId };
}

export function validateSeededChatAttachmentEvidence(value, expected) {
  if (!value || value.workspaceId !== expected.workspaceId || value.sessionId !== expected.sessionId) {
    throw new Error("seeded Chat attachment evidence belongs to a different session/workspace");
  }
  for (const field of ["turnId", "citationId", "toolRunId", "sourceAttachmentId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`seeded Chat attachment evidence is missing ${field}`);
    }
  }
  if (value.sourceUrl !== CHAT_ATTACHMENT_EVIDENCE_URL) {
    throw new Error("seeded Chat attachment evidence returned an unexpected source URL");
  }
  return Object.freeze({
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    citationId: value.citationId,
    toolRunId: value.toolRunId,
    sourceAttachmentId: value.sourceAttachmentId,
    sourceUrl: value.sourceUrl,
  });
}

export function validateCanonicalChatAttachmentProjection(thread, expected) {
  if (thread?.sessionId !== expected.sessionId || !Array.isArray(thread?.turns)) {
    throw new Error("canonical Chat attachment thread is missing or belongs to another session");
  }
  const turn = [...thread.turns]
    .reverse()
    .find((candidate) => candidate?.userMessage?.content === expected.expectedUserContent);
  if (
    !turn ||
    turn.trace?.status !== "completed" ||
    turn.assistantMessage?.content !== expected.expectedAssistantContent
  ) {
    throw new Error("canonical Chat attachment turn did not complete with the exact deterministic reply");
  }
  const attachments = Array.isArray(turn.userMessage?.attachments) ? turn.userMessage.attachments : [];
  const expectedByFileName = new Map(expected.expectedAttachments.map((item) => [item.fileName, item]));
  if (attachments.length !== expectedByFileName.size) {
    throw new Error(
      `canonical Chat attachment turn expected ${expectedByFileName.size} attachments, found ${attachments.length}`,
    );
  }
  const attachmentIds = new Set();
  for (const attachment of attachments) {
    const expectedAttachment = expectedByFileName.get(attachment?.fileName);
    if (
      !expectedAttachment ||
      attachment.mimeType !== expectedAttachment.mimeType ||
      typeof attachment.attachmentId !== "string" ||
      !attachment.attachmentId ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0
    ) {
      throw new Error(`canonical Chat attachment projection is malformed for ${String(attachment?.fileName)}`);
    }
    attachmentIds.add(attachment.attachmentId);
  }
  if (attachmentIds.size !== attachments.length) {
    throw new Error("canonical Chat attachment projection reused an attachment identity");
  }

  const evidenceTurn = thread.turns.find((candidate) => candidate?.turnId === expected.evidence.turnId);
  if (!evidenceTurn) throw new Error("seeded Chat attachment evidence turn is absent from the canonical thread");
  if (
    !evidenceTurn.citations?.some(
      (citation) =>
        citation.citationId === expected.evidence.citationId &&
        citation.url === CHAT_ATTACHMENT_EVIDENCE_URL &&
        citation.title === "Deterministic attachment citation",
    )
  ) {
    throw new Error("seeded Chat attachment citation is absent from the canonical thread");
  }
  if (
    !evidenceTurn.toolRuns?.some(
      (toolRun) =>
        toolRun.toolRunId === expected.evidence.toolRunId &&
        toolRun.toolName === "verification.inspect" &&
        toolRun.status === "executed",
    )
  ) {
    throw new Error("seeded Chat attachment tool event is absent from the canonical thread");
  }
  return { turnId: turn.turnId, attachments };
}

export function validateCanonicalChatAttachmentRecords(records, expected) {
  if (
    !Array.isArray(records) ||
    !Array.isArray(expected.projectedAttachments) ||
    records.length !== expected.expectedAttachments.length ||
    records.length !== expected.projectedAttachments.length
  ) {
    throw new Error("canonical Chat attachment metadata count does not match the sent turn");
  }
  const expectedByFileName = new Map(expected.expectedAttachments.map((item) => [item.fileName, item]));
  const projectedById = new Map(expected.projectedAttachments.map((item) => [item.attachmentId, item]));
  const observedIds = new Set();
  const observedFileNames = new Set();
  for (const record of records) {
    const expectedRecord = expectedByFileName.get(record?.fileName);
    const projectedRecord = projectedById.get(record?.attachmentId);
    if (
      !expectedRecord ||
      !projectedRecord ||
      projectedRecord.fileName !== record.fileName ||
      record.sessionId !== expected.sessionId ||
      record.mimeType !== expectedRecord.mimeType ||
      record.mediaType !== expectedRecord.mediaType ||
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes <= 0 ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      typeof record.storageRelPath !== "string" ||
      !record.storageRelPath
    ) {
      throw new Error(`canonical Chat attachment metadata is malformed for ${String(record?.fileName)}`);
    }
    observedIds.add(record.attachmentId);
    observedFileNames.add(record.fileName);
  }
  if (observedIds.size !== records.length || observedFileNames.size !== records.length) {
    throw new Error("canonical Chat attachment metadata reused an attachment identity or file name");
  }
  return true;
}

export function validateCanonicalChatUrlSource(items, evidence) {
  if (!Array.isArray(items)) throw new Error("canonical Chat URL-source list is missing");
  const matches = items.filter(
    (item) =>
      item?.attachmentId === evidence.sourceAttachmentId &&
      item?.sessionId === evidence.sessionId &&
      item?.sourceType === "url" &&
      item?.sourceRef === CHAT_ATTACHMENT_EVIDENCE_URL,
  );
  if (
    matches.length !== 1 ||
    matches[0].retrievalMode !== "retrieval" ||
    matches[0].ingestStatus !== "ready" ||
    !Number.isSafeInteger(matches[0].chunkCount) ||
    matches[0].chunkCount < 1
  ) {
    throw new Error("canonical Chat URL source is missing, duplicated, or not ready");
  }
  return true;
}

async function readCodeModeRunInScope(state, runId, turnId, probe) {
  const query = new URLSearchParams({
    workspaceId: state.fixture.workspaceId,
    sessionId: state.sessionId,
    turnId,
  });
  return await checkedRequest(
    state.gatewayUrl,
    `/api/v1/code-mode/runs/${encodeURIComponent(runId)}?${query.toString()}`,
    {},
    probe,
  );
}

async function pollCodeModeRun(read, settled) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let latest;
  do {
    latest = await read();
    if (settled(latest.body)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Code Mode run did not reach a terminal state: ${JSON.stringify(latest?.body)}`);
}

function requireCodeModeChatTurn(codeMode) {
  const chatTurn = codeMode?.chatTurn;
  return {
    runId: requireText(chatTurn?.runId, "Code Mode Chat durable run ID"),
    sessionId: requireText(chatTurn?.sessionId, "Code Mode Chat session ID"),
    turnId: requireText(chatTurn?.turnId, "Code Mode Chat turn ID"),
  };
}

function requireCompletedCodeModeFixture(codeMode) {
  return {
    ...codeMode,
    runId: requireText(codeMode?.runId, "completed Code Mode helper run ID"),
    approvalId: requireText(codeMode?.approvalId, "completed Code Mode helper approval ID"),
    chatTurn: requireCodeModeChatTurn(codeMode),
  };
}

function codeModeArtifactRoute(runId, artifactKind, workspaceId, sessionId, turnId) {
  const query = new URLSearchParams({ workspaceId, sessionId, turnId });
  return `/api/v1/code-mode/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactKind)}?${query.toString()}`;
}

function codeModeVerificationEvidenceRoute(runId, workspaceId, sessionId, turnId) {
  const query = new URLSearchParams({ workspaceId, sessionId, turnId, limit: "25" });
  return `/api/v1/code-mode/runs/${encodeURIComponent(runId)}/verification/evidence?${query.toString()}`;
}

export function validateCompletedCodeModeRun(run, expected) {
  if (
    run?.runId !== expected.runId ||
    run?.approvalId !== expected.approvalId ||
    run?.workspaceId !== expected.workspaceId ||
    run?.sessionId !== expected.sessionId ||
    run?.turnId !== expected.turnId ||
    run?.status !== "completed" ||
    run?.language !== "typescript" ||
    run?.originSurface !== "chat" ||
    run?.requestedOutputIntent !== "workbench_helper" ||
    run?.saveCandidateOnSuccess !== false ||
    run?.verification?.status !== "completed_unverified"
  ) {
    throw new Error("completed Code Mode run lost its exact governed Chat scope or pre-proof status");
  }
  if (typeof run.capabilitySnapshotId !== "string" || !run.capabilitySnapshotId.trim()) {
    throw new Error("completed Code Mode capability snapshot identity is missing");
  }
  for (const [label, value] of [
    ["input hash", run.codeModeInputHash],
    ["wrapper hash", run.wrapperManifestHash],
    ["policy hash", run.policySnapshotHash],
    ["source hash", run.codeHash],
  ]) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`completed Code Mode ${label} is missing or malformed`);
    }
  }
  const artifacts = {
    source: run.codeArtifact,
    wrapper_manifest: run.wrapperManifestArtifact,
    policy_snapshot: run.policySnapshotArtifact,
    stdout: run.stdoutArtifact,
  };
  for (const [kind, artifact] of Object.entries(artifacts)) {
    if (
      !artifact?.artifactId ||
      !artifact?.relPath ||
      typeof artifact?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) {
      throw new Error(`completed Code Mode ${kind} artifact is missing immutable identity`);
    }
  }
  if (
    run.codeArtifact.sha256 !== run.codeHash ||
    run.result?.ok !== true ||
    run.result?.marker !== "CHAT_CODE_MODE_OK"
  ) {
    throw new Error("completed Code Mode source hash or deterministic execution result does not match");
  }
  const integrity = run.trustedCodeWriteVerification;
  if (
    integrity?.mode !== "trusted_code_artifact_hash_check" ||
    integrity?.claimBoundary !== "trusted_code_artifact_integrity_not_hostile_sandbox" ||
    typeof integrity?.verifiedAt !== "string" ||
    !Array.isArray(integrity?.artifacts) ||
    !Array.isArray(integrity?.notes) ||
    !integrity.notes.some((note) => /does not claim hostile-code sandboxing/iu.test(note))
  ) {
    throw new Error("completed Code Mode run is missing its explicit trusted-code claim boundary");
  }
  for (const [kind, artifact] of Object.entries(artifacts)) {
    const matches = integrity.artifacts.filter((item) => item?.artifactKind === kind);
    if (
      matches.length !== 1 ||
      matches[0].artifactId !== artifact.artifactId ||
      matches[0].relPath !== artifact.relPath ||
      matches[0].expectedSha256 !== artifact.sha256 ||
      matches[0].actualSha256 !== artifact.sha256 ||
      matches[0].verified !== true
    ) {
      throw new Error(`completed Code Mode ${kind} artifact lacks exact execution-time hash verification`);
    }
  }
  return true;
}

export function validateCodeModeArtifactEvidence(run, previews, snapshot, expectedSource) {
  const artifacts = {
    source: run?.codeArtifact,
    wrapper_manifest: run?.wrapperManifestArtifact,
    policy_snapshot: run?.policySnapshotArtifact,
    stdout: run?.stdoutArtifact,
  };
  for (const [kind, artifact] of Object.entries(artifacts)) {
    const preview = previews?.[kind];
    const contentHash =
      typeof preview?.content === "string" ? createHash("sha256").update(preview.content, "utf8").digest("hex") : "";
    if (
      preview?.runId !== run?.runId ||
      preview?.artifactKind !== kind ||
      preview?.artifact?.artifactId !== artifact?.artifactId ||
      preview?.artifact?.relPath !== artifact?.relPath ||
      preview?.artifact?.sha256 !== artifact?.sha256 ||
      preview?.sha256 !== artifact?.sha256 ||
      preview?.truncated !== false ||
      contentHash !== artifact?.sha256
    ) {
      throw new Error(`Code Mode ${kind} artifact preview failed immutable identity or byte-hash validation`);
    }
  }
  if (previews.source.content !== expectedSource || !previews.stdout.content.includes("CHAT_CODE_MODE_STDOUT")) {
    throw new Error("Code Mode source or stdout preview lost deterministic governed helper content");
  }
  for (const kind of ["wrapper_manifest", "policy_snapshot"]) {
    const parsed = JSON.parse(previews[kind].content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Code Mode ${kind} preview is not a JSON object`);
    }
  }
  if (
    snapshot?.snapshotId !== run?.capabilitySnapshotId ||
    !Array.isArray(snapshot?.inspectableEntries) ||
    !Array.isArray(snapshot?.callableEntries)
  ) {
    throw new Error("Code Mode frozen capability catalog snapshot is absent or malformed");
  }
  const inspectableIds = new Set(snapshot.inspectableEntries.map((entry) => entry?.capabilityId));
  if (
    inspectableIds.size !== snapshot.inspectableEntries.length ||
    snapshot.callableEntries.some((entry) => !inspectableIds.has(entry?.capabilityId))
  ) {
    throw new Error("Code Mode frozen callable catalog is not a unique subset of the inspectable snapshot");
  }
  return true;
}

export function validateVerifiedCodeModeNamedProof(run, evidenceItems, expected) {
  if (
    run?.runId !== expected.runId ||
    run?.workspaceId !== expected.workspaceId ||
    run?.sessionId !== expected.sessionId ||
    run?.turnId !== expected.turnId ||
    run?.status !== "completed" ||
    run?.verification?.status !== "verified" ||
    typeof run?.verification?.evidenceId !== "string" ||
    typeof run?.verification?.subjectHash !== "string"
  ) {
    throw new Error("Code Mode run did not retain an exact fresh verified named-proof state");
  }
  const evidence = Array.isArray(evidenceItems)
    ? evidenceItems.find((item) => item?.evidenceId === run.verification.evidenceId)
    : undefined;
  if (
    !evidence ||
    evidence.runId !== expected.runId ||
    evidence.workspaceId !== expected.workspaceId ||
    evidence.sessionId !== expected.sessionId ||
    evidence.turnId !== expected.turnId ||
    evidence.status !== "verified" ||
    evidence.commandName !== "git_diff_check" ||
    evidence.commandLabel !== "git diff --check" ||
    evidence.command !== "git" ||
    !sameStringArray(evidence.args, ["diff", "--check"]) ||
    evidence.scope !== "worktree" ||
    evidence.commandStatus !== "passed" ||
    evidence.exitCode !== 0 ||
    evidence.subject?.subjectHash !== run.verification.subjectHash ||
    evidence.subject?.codeModeInputHash !== run.codeModeInputHash ||
    evidence.subject?.codeHash !== run.codeHash ||
    evidence.subject?.wrapperManifestHash !== run.wrapperManifestHash ||
    evidence.subject?.policySnapshotHash !== run.policySnapshotHash ||
    !/^[a-f0-9]{64}$/u.test(evidence.subject?.worktreeIdentityHash ?? "") ||
    !/^[a-f0-9]{64}$/u.test(evidence.subject?.worktreeStateHash ?? "") ||
    evidence.subject?.worktreeBaseRef !== "HEAD" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence.subject?.worktreeHeadHash ?? "") ||
    !Array.isArray(evidence.subject?.changedFiles) ||
    evidence.subject.changedFiles.length !== 0 ||
    evidence.subject.changedFilesTruncated !== false ||
    !Array.isArray(evidence.subject?.artifacts)
  ) {
    throw new Error("Code Mode named proof is missing exact command, scope, result, or immutable subject evidence");
  }
  const integrity = run.trustedCodeWriteVerification?.artifacts ?? [];
  if (
    evidence.subject.artifacts.length !== integrity.length ||
    integrity.some(
      (artifact) =>
        !evidence.subject.artifacts.some(
          (binding) =>
            binding.artifactKind === artifact.artifactKind &&
            binding.artifactId === artifact.artifactId &&
            binding.expectedSha256 === artifact.expectedSha256 &&
            binding.actualSha256 === artifact.actualSha256 &&
            binding.verified === true,
        ),
    )
  ) {
    throw new Error("Code Mode named proof subject does not cover every execution-time artifact hash");
  }
  return evidence;
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function validateUniversalRunDetailTrace(trace, expected) {
  if (
    trace?.version !== "observe.run_trace.v1" ||
    trace?.runId !== expected.runId ||
    trace?.run?.runId !== expected.runId ||
    trace?.run?.payload?.sessionId !== expected.sessionId ||
    trace?.run?.payload?.turnId !== expected.turnId ||
    trace?.run?.status !== "completed" ||
    trace?.thread?.state !== "available" ||
    !Array.isArray(trace?.thread?.turns) ||
    !trace.thread.turns.some((turn) => turn?.sessionId === expected.sessionId && turn?.turnId === expected.turnId) ||
    trace?.posture?.readOnly !== true ||
    trace?.posture?.sideEffectPosture !== "audit_only" ||
    trace?.posture?.audit?.state !== "available"
  ) {
    throw new Error("universal Run Detail trace lost exact durable Chat correlation or read-only audit posture");
  }
  return true;
}

async function waitForExactCompletedChatTurn(
  state,
  expectedUserContent,
  expectedAssistantContent = DETERMINISTIC_LLM_DEFAULT_REPLY,
) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let latestStatus = "missing";
  do {
    const thread = await checkedRequest(
      state.gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(state.sessionId)}/thread?includeDecisionTrace=true`,
      {},
      "wait for exact completed Chat turn",
    );
    const turn = Array.isArray(thread.body?.turns)
      ? thread.body.turns.find(
          (candidate) =>
            candidate?.trace?.sessionId === state.sessionId && candidate?.userMessage?.content === expectedUserContent,
        )
      : undefined;
    latestStatus = turn?.trace?.status ?? "missing";
    if (turn?.trace?.status === "completed" && turn?.assistantMessage?.content === expectedAssistantContent) {
      const correlation = {
        runId: requireText(turn.trace?.durable?.runId, "completed Chat durable run ID"),
        sessionId: state.sessionId,
        turnId: requireText(turn.turnId, "completed Chat turn ID"),
      };
      const durableRun = await checkedRequest(
        state.gatewayUrl,
        `/api/v1/durable/runs/${encodeURIComponent(correlation.runId)}`,
        {},
        "wait for exact completed Chat turn",
      );
      validateDurableRunCorrelation(durableRun.body, correlation);
      return {
        status: thread.status,
        outcome: `exact Chat turn ${correlation.turnId} completed with durable run ${correlation.runId}`,
        ...correlation,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`exact Chat turn did not complete: ${expectedUserContent} (${latestStatus})`);
}

export function validateDurableRunCorrelation(run, expected) {
  if (!run || run.runId !== expected.runId) {
    throw new Error(`durable run ${expected.runId} was not returned exactly`);
  }
  const payload = run.payload;
  if (payload?.sessionId !== expected.sessionId || payload?.turnId !== expected.turnId) {
    throw new Error(`durable run ${expected.runId} payload belongs to a different or missing session/turn`);
  }
  return true;
}

export function validateCompletedDelegationFanIn(accepted, canonical, rail, expected) {
  if (
    accepted?.runId !== expected.delegationRunId ||
    accepted?.status !== "completed" ||
    canonical?.run?.runId !== expected.delegationRunId ||
    canonical.run.sessionId !== expected.sessionId ||
    canonical.run.parentRunId !== expected.parentRunId ||
    canonical.run.objective !== expected.objective ||
    canonical.run.status !== "completed"
  ) {
    throw new Error("delegation acceptance and canonical run did not converge on the exact completed parent scope");
  }
  const acceptedSteps = normalizeDelegationProofSteps(accepted.steps, "accepted delegation");
  const canonicalSteps = normalizeDelegationProofSteps(canonical.steps, "canonical delegation");
  if (acceptedSteps.length !== 3 || canonicalSteps.length !== 3) {
    throw new Error("delegation fan-in requires exactly three persisted steps");
  }
  for (let index = 0; index < acceptedSteps.length; index += 1) {
    const acceptedStep = acceptedSteps[index];
    const canonicalStep = canonicalSteps[index];
    if (
      acceptedStep.stepId !== canonicalStep.stepId ||
      acceptedStep.status !== "completed" ||
      canonicalStep.status !== "completed" ||
      acceptedStep.runId !== expected.delegationRunId ||
      canonicalStep.runId !== expected.delegationRunId
    ) {
      throw new Error(`delegation step ${index} is missing exact completed canonical identity`);
    }
  }
  const [research, review, synthesis] = canonicalSteps;
  if (
    research.role !== "researcher" ||
    review.role !== "reviewer" ||
    synthesis.role !== "synthesizer" ||
    research.parallelizable !== true ||
    review.parallelizable !== true ||
    synthesis.parallelizable !== false ||
    (research.dependsOnStepIds ?? []).length !== 0 ||
    (review.dependsOnStepIds ?? []).length !== 0 ||
    !sameStringSet(synthesis.dependsOnStepIds, [research.stepId, review.stepId])
  ) {
    throw new Error("delegation plan did not preserve two independent children and an exact two-way synthesis fan-in");
  }
  if (
    !sameStringSet([research.output, review.output], [DELEGATION_OUTPUTS[0], DELEGATION_OUTPUTS[1]]) ||
    synthesis.output !== DELEGATION_OUTPUTS[2]
  ) {
    throw new Error(
      `delegation child outputs or terminal synthesis content drifted from the deterministic plan: ${JSON.stringify({
        expected: DELEGATION_OUTPUTS,
        actual: [research.output, review.output, synthesis.output],
      })}`,
    );
  }
  const stitchedOutput = requireText(accepted.stitchedOutput, "accepted delegation stitched output");
  if (
    canonical.run.stitchedOutput !== stitchedOutput ||
    !DELEGATION_OUTPUTS.every((output) => stitchedOutput.includes(output))
  ) {
    throw new Error("delegation parent did not persist all child outputs in its synthesized content");
  }
  if (
    rail?.version !== "durable.background_task_rail.v1" ||
    rail?.parent?.runId !== expected.parentRunId ||
    rail?.scope?.workspaceId !== expected.workspaceId ||
    rail?.scope?.sessionId !== expected.sessionId ||
    rail?.scope?.verified !== true ||
    rail?.coverage?.watchers?.complete !== true ||
    rail?.coverage?.parentSignals?.complete !== true ||
    !Array.isArray(rail?.tasks)
  ) {
    throw new Error("delegation fan-in rail is missing exact verified parent coverage");
  }
  const tasks = rail.tasks.filter((task) => task?.delegationRunId === expected.delegationRunId);
  if (tasks.length !== 3) {
    throw new Error(`delegation fan-in expected three watched children, found ${tasks.length}`);
  }
  const stepIds = new Set(canonicalSteps.map((step) => step.stepId));
  for (const task of tasks) {
    if (
      !task.watcherId ||
      !task.childRunId ||
      task.watcherState !== "attached" ||
      task.canonicalStatus !== "completed" ||
      task.scope?.workspaceId !== expected.workspaceId ||
      task.scope?.verified !== true ||
      !stepIds.has(task.delegationStepId) ||
      task.output?.availability !== "available" ||
      task.output?.source !== "delegation_step" ||
      task.output?.sourceId !== task.delegationStepId ||
      typeof task.output?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(task.output.sha256) ||
      !Number.isSafeInteger(task.output?.byteCount) ||
      task.output.byteCount < 1 ||
      !Array.isArray(task.blockers) ||
      task.blockers.length !== 0
    ) {
      throw new Error("delegation watched child is not terminal, attached, scoped, output-backed, and blocker-free");
    }
  }
  if (
    rail.synthesis?.availability !== "available" ||
    rail.synthesis?.delegationRunId !== expected.delegationRunId ||
    !DELEGATION_OUTPUTS.every((output) => rail.synthesis?.summary?.includes(output)) ||
    !Array.isArray(rail.synthesis?.lineage) ||
    rail.synthesis.lineage.length !== 3 ||
    !sameStringSet(
      rail.synthesis.lineage.map((entry) => entry?.watcherId),
      tasks.map((task) => task.watcherId),
    ) ||
    !sameStringSet(
      rail.synthesis.lineage.map((entry) => entry?.sourceId),
      canonicalSteps.map((step) => step.stepId),
    ) ||
    !Array.isArray(rail.synthesis?.missingTerminalChildRunIds) ||
    rail.synthesis.missingTerminalChildRunIds.length !== 0 ||
    !Array.isArray(rail.synthesis?.uncoveredChildRunIds) ||
    rail.synthesis.uncoveredChildRunIds.length !== 0 ||
    !Array.isArray(rail.synthesis?.uncoveredStepIds) ||
    rail.synthesis.uncoveredStepIds.length !== 0 ||
    !Array.isArray(rail.unknowns) ||
    rail.unknowns.length !== 0
  ) {
    throw new Error("delegation synthesis lineage is incomplete, uncovered, or not canonically available");
  }
  for (const entry of rail.synthesis.lineage) {
    if (
      entry?.source !== "delegation_step" ||
      typeof entry?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry?.byteCount) ||
      entry.byteCount < 1
    ) {
      throw new Error("delegation synthesis lineage contains malformed content-integrity evidence");
    }
  }
  return { tasks, steps: canonicalSteps, stitchedOutput };
}

function normalizeDelegationProofSteps(steps, label) {
  if (!Array.isArray(steps)) throw new Error(`${label} steps are missing`);
  return [...steps].sort((left, right) => Number(left?.index ?? -1) - Number(right?.index ?? -1));
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  return actualValues.every((value, index) => value === expectedValues[index]);
}

export function validateAttachedDurableWatcher(rail, expected) {
  if (
    rail?.version !== "durable.background_task_rail.v1" ||
    rail?.parent?.runId !== expected.parentRunId ||
    rail?.scope?.workspaceId !== expected.workspaceId ||
    rail?.scope?.sessionId !== expected.sessionId ||
    rail?.scope?.verified !== true ||
    !Array.isArray(rail?.tasks)
  ) {
    throw new Error("durable background-task rail does not match the exact parent session/workspace scope");
  }
  const candidates = rail.tasks.filter(
    (task) =>
      (!expected.watcherId || task?.watcherId === expected.watcherId) &&
      (!expected.childRunId || task?.childRunId === expected.childRunId),
  );
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one durable child watcher, found ${candidates.length}`);
  }
  const task = candidates[0];
  if (
    !task?.watcherId ||
    !task?.childRunId ||
    task.watcherState !== "attached" ||
    task.scope?.workspaceId !== expected.workspaceId ||
    task.scope?.verified !== true
  ) {
    throw new Error("durable child watcher is not attached with verified workspace scope");
  }
  return task;
}

function validateDurableTaskLinks(task, childCorrelation) {
  const links = Array.isArray(task?.links) ? task.links : [];
  for (const [kind, id] of [
    ["durable_run", childCorrelation.runId],
    ["chat_session", childCorrelation.sessionId],
    ["chat_turn", childCorrelation.turnId],
  ]) {
    if (!links.some((link) => link?.kind === kind && link?.id === id)) {
      throw new Error(`durable child watcher is missing exact ${kind} linkage ${id}`);
    }
  }
}

function durableBackgroundTaskRailRoute(parentRunId, workspaceId, sessionId) {
  const query = new URLSearchParams({
    workspaceId: requireText(workspaceId, "durable rail workspace ID"),
    sessionId: requireText(sessionId, "durable rail session ID"),
  });
  return `/api/v1/durable/runs/${encodeURIComponent(parentRunId)}/background-tasks?${query.toString()}`;
}

function assertResolvedTurn(turn, sessionId, blockerLabel) {
  if (!turn || turn.trace?.sessionId !== sessionId || turn.trace?.turnId !== turn.turnId) {
    throw new Error(`${blockerLabel} turn linkage is missing or cross-session`);
  }
  if (turn.trace.status === "waiting_for_approval" || turn.trace.status === "waiting_for_user_input") {
    throw new Error(`${blockerLabel} turn ${turn.turnId} is still blocked as ${turn.trace.status}`);
  }
  if (typeof turn.trace?.durable?.runId !== "string" || !turn.trace.durable.runId) {
    throw new Error(`${blockerLabel} turn ${turn.turnId} has no durable run linkage`);
  }
}

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

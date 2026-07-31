import fs from "node:fs/promises";
import path from "node:path";

import { NEXT_RELEASE_SURFACE_MANIFEST } from "../release-surface-manifest.mjs";
import { prepareVerificationRuntime, requestJson, startVerificationStack, stopVerificationStack } from "../runtime.mjs";
import { formatArtifactIssue, validateRequiredScenarioArtifacts } from "../scenario-artifact-evidence.mjs";
import { runAccessibilitySmokeLane } from "./accessibility-smoke-lane.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./deterministic-llm-stub.mjs";
import { runExternalSourcesBrowserFlow } from "./external-sources-browser-flow.mjs";
import {
  GATEWAY_CHAT_FAULT_ARTIFACT_NAME,
  GATEWAY_CHAT_FAULT_SCENARIO_ID,
  runGatewayChatFaultRecoveryLane,
} from "./gateway-chat-fault-recovery-lane.mjs";
import { runSurfaceRegressionLane } from "./surface-regression-lane.mjs";
import { runUsabilityActionProofScenarios } from "./usability-action-evidence.mjs";
import { runUsabilityBrowserActionLane } from "./usability-browser-action-lane.mjs";
import { BROWSER_ACTION_STEP_REGISTRY } from "./usability-browser-action-registry.mjs";
import { probeLiveCapabilityDispositions } from "./usability-capability-dispositions.mjs";
import {
  appendLiveCapabilityRows,
  buildUsabilityRouteActionInventory,
  collectVerificationSecretEnvKeys,
} from "./usability-coverage.mjs";
import {
  assertUsabilitySourceState,
  assertUsabilitySourceStateUnchanged,
  snapshotUsabilitySourceState,
} from "./usability-source-state.mjs";

const FOUNDATION_PROMPT = "Reply with exactly: CHAT_OK";
const FOUNDATION_REPLY = "CHAT_OK";
const FOUNDATION_OPERATOR_TOKEN = "verification-usability-operator-token";
const COMPLETED_ASSISTANT_CONTENT_SELECTOR =
  ".mc-next-thread-bubble.assistant:not(.streaming) .mc-assistant-markdown-assistant";
const GATEWAY_CHAT_FAULT_DEFECT_ID = "GC-USAB-002";
const GATEWAY_CHAT_FAULT_STEP_IDS = Object.freeze([
  "pre-output-server-error-retry",
  "post-output-disconnect-no-replay",
  "restart-during-streaming-reconciles-canonical-turn",
  "streaming-restart-next-turn-admission",
  "near-expiry-4551-single-dispatch",
  "invalid-credentials-terminal-failure",
  "invalid-credentials-next-turn-admission",
  "provider-idle-timeout-terminal-failure",
  "provider-timeout-next-turn-admission",
]);

export async function runUsabilityCoreLane(context, options = {}, deps) {
  const snapshotSourceState = deps.snapshotUsabilitySourceState ?? snapshotUsabilitySourceState;
  const collectSecretEnvKeys = deps.collectVerificationSecretEnvKeys ?? collectVerificationSecretEnvKeys;
  const runFoundation = deps.runFoundationJourney ?? runFoundationJourney;
  const sourceState = snapshotSourceState(
    deps.repoRoot,
    options.sourceMode ?? process.env.GOATCITADEL_USABILITY_SOURCE_MODE,
  );
  assertUsabilitySourceState(sourceState);
  const secretEnvKeys = await collectSecretEnvKeys(path.join(deps.repoRoot, "config"));
  if (
    !Array.isArray(secretEnvKeys) ||
    secretEnvKeys.some((key) => typeof key !== "string" || !/^[A-Z][A-Z0-9_]+$/u.test(key))
  ) {
    throw new Error("usability core secret scrub did not return valid environment keys");
  }

  const sourceStatePath = path.join(context.artifactRoot, "diagnostics", "usability-core-source-state.json");
  const scenario = await deps.runScenario(
    context,
    {
      id: "usability-core.foundation.chat-send-stream",
      lane: "usability-core",
      title: "Second clean-profile core smoke completes disposable Chat turns",
      subsystem: "usability-foundations",
    },
    async ({ correlationId }) => {
      await deps.writeJson(sourceStatePath, {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        ...sourceState,
      });
      const result = await runFoundation(context, {
        baseSha: sourceState.baseSha,
        correlationId,
        deps,
        secretEnvKeys,
      });
      const artifacts = artifactSet(result.artifacts);
      artifacts.diagnostics = [...new Set([...artifacts.diagnostics, deps.relativeToRun(context, sourceStatePath)])];
      return {
        ...result,
        metrics: {
          ...(result.metrics ?? {}),
          baseSha: sourceState.baseSha,
          sourceMode: sourceState.mode,
          sourceModified: sourceState.sourceModified,
          sourceDiffSha256: sourceState.diffSha256,
          sourceChangedPathCount: sourceState.changedPathCount,
          scrubbedSecretEnvKeys: secretEnvKeys.length,
        },
        artifacts,
      };
    },
  );
  assertScenarioPassed(scenario, "usability core foundation");
  const completedSourceState = snapshotSourceState(deps.repoRoot, sourceState.mode);
  assertUsabilitySourceStateUnchanged(sourceState, completedSourceState);
  await deps.writeJson(sourceStatePath, {
    schemaVersion: 1,
    started: sourceState,
    completed: completedSourceState,
  });
  scenario.metrics = {
    ...(scenario.metrics ?? {}),
    completedSourceDiffSha256: completedSourceState.diffSha256,
    completedSourceModified: completedSourceState.sourceModified,
  };
  return scenario;
}

export async function runUsabilityLane(context, options = {}, deps) {
  const snapshotSourceState = deps.snapshotUsabilitySourceState ?? snapshotUsabilitySourceState;
  const sourceState =
    options.sourceState ??
    snapshotSourceState(deps.repoRoot, options.sourceMode ?? process.env.GOATCITADEL_USABILITY_SOURCE_MODE);
  assertUsabilitySourceState(sourceState);
  if (options.sourceState) {
    const prerequisiteCompletedSourceState = snapshotSourceState(deps.repoRoot, sourceState.mode);
    assertUsabilitySourceStateUnchanged(sourceState, prerequisiteCompletedSourceState);
  }
  const baseSha = sourceState.baseSha;
  const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(deps.repoRoot, "config"));
  const inventoryPath = path.join(context.artifactRoot, "diagnostics", "usability-route-action-inventory.json");
  const sourceStatePath = path.join(context.artifactRoot, "diagnostics", "usability-source-state.json");
  const usabilityScenarioStartIndex = context.manifest.scenarios.length;
  const inventory = buildUsabilityRouteActionInventory(baseSha, sourceState);

  const coverageScenario = await deps.runScenario(
    context,
    {
      id: "usability.coverage-contract",
      lane: "usability",
      title: "Current route, redirect, and action inventory is complete",
      subsystem: "usability-evidence",
    },
    async () => {
      await deps.writeJson(inventoryPath, inventory);
      return {
        status: "passed",
        metrics: inventory.counts,
        notes: ["Inventory is generated from the current release-surface manifest; older QA workbooks are not inputs."],
        artifacts: artifactSet({ diagnostics: [deps.relativeToRun(context, inventoryPath)] }),
      };
    },
  );
  assertScenarioPassed(coverageScenario, "usability coverage contract");

  const foundationScenario = await deps.runScenario(
    context,
    {
      id: "usability.foundation.chat-send-stream",
      lane: "usability",
      title: "Fresh and persisted profiles complete disposable Chat turns",
      subsystem: "usability-foundations",
    },
    async ({ correlationId }) =>
      await runFoundationJourney(context, {
        baseSha,
        correlationId,
        deps,
        secretEnvKeys,
      }),
  );
  assertScenarioPassed(foundationScenario, "usability foundation");

  const capabilityScenario = await deps.runScenario(
    context,
    {
      id: "usability.capability-coverage",
      lane: "usability",
      title: "Every live capability has inspectability and callability-governance evidence",
      subsystem: "usability-evidence",
    },
    async () => {
      const added = appendLiveCapabilityRows(inventory, foundationScenario.metrics?.capabilityCatalog);
      await deps.writeJson(inventoryPath, inventory);
      return {
        status: "passed",
        metrics: {
          capabilityRows: added.length,
          inspectableRows: added.filter((row) => row.action === "inspectability").length,
          callableRows: added.filter((row) => row.action === "callability-governance").length,
        },
        artifacts: artifactSet({ diagnostics: [deps.relativeToRun(context, inventoryPath)] }),
      };
    },
  );
  assertScenarioPassed(capabilityScenario, "live capability coverage");

  const actionProofStartIndex = context.manifest.scenarios.length;
  await runUsabilityActionProofScenarios(context, { baseSha, deps, secretEnvKeys });
  assertScenarioRangePassed(context, actionProofStartIndex, "adjacent action unit regression proof");

  const browserActionStartIndex = context.manifest.scenarios.length;
  await runUsabilityBrowserActionLane(context, { baseSha, secretEnvKeys }, deps);
  assertScenarioRangePassed(context, browserActionStartIndex, "exact Chromium route-action proof");

  const surfaceStartIndex = context.manifest.scenarios.length;
  await runSurfaceRegressionLane(context, { ...options, secretEnvKeys, processLogPrefix: "usability-surface" }, deps);
  assertScenarioRangePassed(context, surfaceStartIndex, "surface regression");

  const accessibilityStartIndex = context.manifest.scenarios.length;
  await runAccessibilitySmokeLane(
    context,
    { ...options, secretEnvKeys, processLogPrefix: "usability-accessibility" },
    deps,
  );
  assertScenarioRangePassed(context, accessibilityStartIndex, "accessibility smoke");

  const externalSourcesScenario = await deps.runScenario(
    context,
    {
      id: "usability.external-sources",
      lane: "usability",
      title: "Deterministic external-source journeys complete across responsive themes",
      subsystem: "usability-library-chat",
    },
    async () => {
      const result = await runExternalSourcesBrowserFlow({
        artifactRoot: context.artifactRoot,
        secretEnvKeys,
        processLogPrefix: "usability-external-sources",
      });
      const screenshots = await listRelativeArtifacts(
        context,
        path.join(context.artifactRoot, "screenshots"),
        /^external-sources-flow-/u,
      );
      const report = deps.relativeToRun(context, result.reportPath);
      const browserActionSteps = buildExternalSourceBrowserActionSteps(result, {
        baseSha,
        evidence: [report, ...screenshots],
      });
      return {
        status:
          result.combosFailed === 0 &&
          result.combosExecuted === result.combosPlanned &&
          result.combosPassed === result.combosPlanned
            ? "passed"
            : "failed",
        error: result.combosFailed > 0 ? `${result.combosFailed} external-source browser combos failed` : undefined,
        metrics: {
          baseSha,
          combosPlanned: result.combosPlanned,
          combosExecuted: result.combosExecuted,
          combosPassed: result.combosPassed,
          combosFailed: result.combosFailed,
          stepsExecuted: result.stepsExecuted,
          browserActionSteps,
        },
        artifacts: artifactSet({ diagnostics: [report], screenshots }),
      };
    },
  );
  assertScenarioPassed(externalSourcesScenario, "external-source usability journey");

  const gatewayFaultStartIndex = context.manifest.scenarios.length;
  const gatewayFaultScenario = await runGatewayChatFaultRecoveryLane(context, { baseSha, secretEnvKeys }, deps);
  assertScenarioRangePassed(context, gatewayFaultStartIndex, "Gateway Chat fault recovery");
  if (context.manifest.scenarios.length !== gatewayFaultStartIndex + 1) {
    throw new Error("Gateway Chat fault recovery must produce exactly one required usability scenario");
  }
  assertGatewayChatFaultScenario(gatewayFaultScenario, baseSha);

  const evidenceIntegrityScenario = await deps.runScenario(
    context,
    {
      id: "usability.evidence-integrity",
      lane: "usability",
      title: "Usability evidence schema is complete and contains no required skips",
      subsystem: "usability-evidence",
    },
    async () => {
      const result = await writeUsabilityResultRows(context, {
        baseSha,
        deps,
        inventory,
        sourceState,
        usabilityScenarioStartIndex,
      });
      const completedSourceState = snapshotSourceState(deps.repoRoot, sourceState.mode);
      assertUsabilitySourceStateUnchanged(sourceState, completedSourceState);
      await deps.writeJson(sourceStatePath, {
        schemaVersion: 1,
        started: sourceState,
        completed: completedSourceState,
      });
      return {
        status: "passed",
        metrics: {
          ...result.metrics,
          completedSourceDiffSha256: completedSourceState.diffSha256,
          completedSourceModified: completedSourceState.sourceModified,
        },
        artifacts: artifactSet({
          diagnostics: [deps.relativeToRun(context, result.resultPath), deps.relativeToRun(context, sourceStatePath)],
        }),
      };
    },
  );
  assertScenarioPassed(evidenceIntegrityScenario, "usability evidence integrity");
  assertRequiredUsabilityScenarioOrder(context.manifest.scenarios.slice(usabilityScenarioStartIndex));
}

export function buildExternalSourceBrowserActionSteps(result, input) {
  const externalRows = Object.values(BROWSER_ACTION_STEP_REGISTRY).filter((row) => row.external);
  if (!Array.isArray(result?.comboResults) || result.comboResults.length === 0) {
    throw new Error("external-source action evidence contains no browser combos");
  }
  return externalRows.map((registered) => {
    const operatorActions = [];
    const failures = [];
    for (const combo of result.comboResults) {
      if (combo?.status !== "passed") failures.push(`${combo?.combo ?? "unknown"}:combo-${combo?.status ?? "missing"}`);
      const steps = Array.isArray(combo?.steps) ? combo.steps : [];
      for (const name of registered.externalSourceStepNames) {
        const matches = steps.filter((step) => step?.name === name);
        if (matches.length !== 1 || matches[0]?.status !== "passed") {
          failures.push(
            `${combo?.combo ?? "unknown"}:${name}:${matches.length === 0 ? "missing" : matches.length > 1 ? "duplicate" : (matches[0]?.status ?? "missing-status")}`,
          );
        } else {
          operatorActions.push({ kind: "external-source-chromium-step", combo: combo.combo, name });
        }
      }
    }
    return {
      journeyId: registered.bundleId,
      stepId: registered.stepId,
      baseSha: input.baseSha,
      route: registered.routeSlug,
      expectedResult: registered.expectedResult,
      actualResult: failures.length === 0 ? "All exact external-source browser steps passed." : failures.join("; "),
      status: failures.length === 0 ? "passed" : "failed",
      proofKind: "chromium-operator-action",
      operatorActions,
      evidence: input.evidence,
      environment: "isolated-source",
      storage: "sqlite",
      profileState: "fresh-responsive-matrix",
      provider: "verification-stub",
    };
  });
}

export async function runFoundationJourney(context, input) {
  const { baseSha, correlationId, deps, secretEnvKeys } = input;
  const artifactPath = path.join(context.artifactRoot, "diagnostics", "usability-foundation-steps.json");
  const capabilityPath = path.join(context.artifactRoot, "diagnostics", "usability-capability-inventory.json");
  const capabilityDispositionPath = path.join(
    context.artifactRoot,
    "diagnostics",
    "usability-capability-dispositions.json",
  );
  const stepRows = [];
  const artifacts = artifactSet();
  let capabilityCatalog = { inspectable: [], callable: [] };
  let capabilityDispositions = [];
  const stub = await startDeterministicLlmStub({ replyText: FOUNDATION_REPLY });
  let runtimeRoot;
  let stack;
  let browser;

  const step = async (stepId, metadata, fn) => {
    const startedAt = new Date().toISOString();
    try {
      const value = await fn();
      stepRows.push(
        usabilityResultRow({
          journeyId: "foundation",
          stepId,
          baseSha,
          expectedResult: metadata.expectedResult,
          actualResult: "passed",
          environment: "isolated-source",
          storage: "sqlite",
          profileState: metadata.profileState ?? "api",
          viewport: metadata.viewport,
          theme: metadata.theme,
          provider: stub.providerId,
          evidence: metadata.evidence ?? [],
          startedAt,
        }),
      );
      return value;
    } catch (error) {
      stepRows.push(
        usabilityResultRow({
          journeyId: "foundation",
          stepId,
          baseSha,
          expectedResult: metadata.expectedResult,
          actualResult: error instanceof Error ? error.message : String(error),
          environment: "isolated-source",
          storage: "sqlite",
          profileState: metadata.profileState ?? "api",
          viewport: metadata.viewport,
          theme: metadata.theme,
          provider: stub.providerId,
          evidence: metadata.evidence ?? [],
          startedAt,
          status: "failed",
        }),
      );
      throw error;
    }
  };

  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-foundation`);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      processLogPrefix: "usability-foundation",
      gatewayEnvOmit: secretEnvKeys,
      uiEnvOmit: secretEnvKeys,
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: FOUNDATION_OPERATOR_TOKEN,
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        [DETERMINISTIC_LLM_KEY_ENV]: "verification-stub-key",
      },
    });

    await step(
      "health-and-onboarding",
      { expectedResult: "Gateway health is green and onboarding completes in the isolated root." },
      async () => {
        const health = await requestJson(stack.gatewayUrl, "/health");
        assertResponseOk(health, "gateway health");
        await deps.ensureOnboardingComplete(stack.gatewayUrl, "verification-usability");
        const onboarding = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
        assertResponseOk(onboarding, "onboarding state");
        if (onboarding.body?.completed !== true) throw new Error("onboarding did not persist as completed");
      },
    );

    await step(
      "workspace-and-provider",
      { expectedResult: "The default workspace and deterministic active provider are operator-visible." },
      async () => {
        const workspace = await requestJson(stack.gatewayUrl, "/api/v1/workspaces/default");
        assertResponseOk(workspace, "default workspace");
        const providers = await requestJson(stack.gatewayUrl, "/api/v1/llm/providers");
        assertResponseOk(providers, "provider list");
        if (
          !Array.isArray(providers.body?.items) ||
          !providers.body.items.some((item) => item.providerId === stub.providerId)
        ) {
          throw new Error(`deterministic provider ${stub.providerId} is absent from the provider list`);
        }
      },
    );

    await step(
      "capability-catalogs",
      { expectedResult: "Every live inspectable/callable capability has a unique identity and callable is a subset." },
      async () => {
        const inspectable = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/catalog?scope=inspectable");
        const callable = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/catalog?scope=callable");
        assertResponseOk(inspectable, "inspectable capability catalog");
        assertResponseOk(callable, "callable capability catalog");
        const inspectableItems = requireCatalogItems(inspectable.body, "inspectable");
        const callableItems = requireCatalogItems(callable.body, "callable");
        const inspectableIds = new Set(inspectableItems.map((item) => item.capabilityId));
        assertUniqueIds(inspectableItems, "inspectable");
        assertUniqueIds(callableItems, "callable");
        const leaked = callableItems.filter((item) => !inspectableIds.has(item.capabilityId));
        if (leaked.length > 0)
          throw new Error(
            `callable capabilities absent from inspectable catalog: ${leaked.map((item) => item.capabilityId).join(", ")}`,
          );
        capabilityCatalog = {
          inspectable: inspectableItems.map(capabilityProofRecord),
          callable: callableItems.map(capabilityProofRecord),
        };
        await deps.writeJson(capabilityPath, {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          baseSha,
          inspectableCount: inspectableItems.length,
          callableCount: callableItems.length,
          inspectable: capabilityCatalog.inspectable,
          callable: capabilityCatalog.callable,
        });
        artifacts.diagnostics.push(deps.relativeToRun(context, capabilityPath));
      },
    );

    const session = await step(
      "session-create-and-policy",
      { expectedResult: "A disposable Chat session is created and its no-subagent fixture policy persists." },
      async () => {
        const created = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
          method: "POST",
          body: { title: "Pre-QA usability disposable session" },
        });
        assertResponseOk(created, "create Chat session");
        if (!created.body?.sessionId) throw new Error("Chat session create returned no sessionId");
        const prefs = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(created.body.sessionId)}/prefs`,
        );
        assertResponseOk(prefs, "read Chat session prefs");
        const patched = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(created.body.sessionId)}/prefs`,
          {
            method: "PATCH",
            body: { expectedRevision: prefs.body.revision, subagentPolicy: "off" },
          },
        );
        assertResponseOk(patched, "patch Chat session prefs");
        return created.body;
      },
    );

    await step(
      "capability-dispositions",
      {
        expectedResult:
          "Every live capability has a direct result contract, exact skill-activation contract, required named-journey proof, or explicit non-executed limitation/denial.",
      },
      async () => {
        const evidenceRef = deps.relativeToRun(context, capabilityDispositionPath);
        capabilityDispositions = await probeLiveCapabilityDispositions({
          baseSha,
          capabilityCatalog,
          evidenceRef,
          gatewayUrl: stack.gatewayUrl,
          requestJson,
          sessionId: session.sessionId,
          workspaceId: "default",
          workspaceRoot: path.join(runtimeRoot, "workspace"),
        });
        await deps.writeJson(capabilityDispositionPath, {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          baseSha,
          capabilityCount: capabilityDispositions.length,
          dispositions: capabilityDispositions,
        });
        artifacts.diagnostics.push(evidenceRef);
      },
    );

    browser = await deps.chromium.launch({ headless: true });
    const fresh = await step(
      "fresh-profile-chat-send",
      {
        expectedResult: `A fresh desktop profile sends ${FOUNDATION_PROMPT} and receives ${FOUNDATION_REPLY}.`,
        profileState: "fresh",
        viewport: { width: 1440, height: 1024 },
        theme: "dark",
      },
      async () =>
        await runChatBrowserLeg(context, {
          artifacts,
          browser,
          correlationId,
          deps,
          expectedReplyCount: 1,
          installState: true,
          sessionId: session.sessionId,
          stack,
          theme: "dark",
          viewport: { width: 1440, height: 1024 },
          workspaceId: "default",
          slug: "usability-foundation-fresh-desktop-dark",
          sendPrompt: true,
        }),
    );

    const persisted = await step(
      "persisted-profile-next-turn",
      {
        expectedResult:
          "A persisted profile reloads canonical thread state and completes the next admitted turn using only the keyboard.",
        profileState: "persisted",
        viewport: { width: 1440, height: 1024 },
        theme: "dark",
      },
      async () =>
        await runChatBrowserLeg(context, {
          artifacts,
          browser,
          correlationId,
          deps,
          expectedReplyCount: 2,
          sessionId: session.sessionId,
          stack,
          storageState: fresh.storageState,
          theme: "dark",
          viewport: { width: 1440, height: 1024 },
          workspaceId: "default",
          slug: "usability-foundation-persisted-desktop-dark",
          sendPrompt: true,
          sendMethod: "keyboard-enter",
        }),
    );

    await step(
      "persisted-mobile-reflow",
      {
        expectedResult: "The persisted thread and composer remain usable at the mobile-light viewport.",
        profileState: "persisted",
        viewport: { width: 390, height: 844 },
        theme: "light",
      },
      async () =>
        await runChatBrowserLeg(context, {
          artifacts,
          browser,
          correlationId,
          deps,
          expectedReplyCount: 2,
          sessionId: session.sessionId,
          stack,
          storageState: persisted.storageState,
          theme: "light",
          viewport: { width: 390, height: 844 },
          workspaceId: "default",
          slug: "usability-foundation-persisted-mobile-light",
          sendPrompt: false,
        }),
    );

    if (stub.completionDispatches() < 2) {
      throw new Error(`expected at least two provider dispatches, received ${stub.completionDispatches()}`);
    }
    return {
      status: "passed",
      providerId: stub.providerId,
      modelId: stub.model,
      metrics: {
        baseSha,
        foundationSteps: stepRows.length,
        providerDispatches: stub.completionDispatches(),
        scrubbedSecretEnvKeys: secretEnvKeys.length,
        capabilityCatalog,
        capabilityDispositions,
      },
      notes: ["No external provider or channel was contacted; all content and identities are deterministic fixtures."],
      artifacts,
    };
  } catch (error) {
    return {
      status: "failed",
      providerId: stub.providerId,
      modelId: stub.model,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      metrics: { baseSha, foundationSteps: stepRows.length, providerDispatches: stub.completionDispatches() },
      artifacts,
    };
  } finally {
    await deps.writeJson(artifactPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      baseSha,
      fixturePrompt: FOUNDATION_PROMPT,
      fixtureReply: FOUNDATION_REPLY,
      provider: { providerId: stub.providerId, model: stub.model, requestSummaries: stub.requestSummaries() },
      steps: stepRows,
    });
    artifacts.diagnostics.push(deps.relativeToRun(context, artifactPath));
    if (browser) await browser.close().catch(() => undefined);
    if (stack) await stopVerificationStack(stack);
    else if (runtimeRoot) await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await stub.close().catch(() => undefined);
  }
}

async function runChatBrowserLeg(context, input) {
  const browserContext = await input.browser.newContext({
    viewport: input.viewport,
    colorScheme: input.theme,
    ...(input.storageState ? { storageState: input.storageState } : {}),
  });
  if (input.installState) {
    await input.deps.installMissionControlNextBrowserState(browserContext, input.workspaceId);
  }
  const page = await browserContext.newPage();
  const browserLog = input.deps.attachBrowserLogging(page);
  const browserLogCursor = browserLog.mark();
  const trace = await input.deps.startBrowserTrace(context, { page, slug: input.slug });
  let captured;
  try {
    const query = `sessionId=${encodeURIComponent(input.sessionId)}&theme=${encodeURIComponent(input.theme)}`;
    await page.goto(input.deps.buildVerificationUiUrl(input.stack.uiUrl, `/chat?${query}`), {
      waitUntil: "domcontentloaded",
    });
    const route = NEXT_RELEASE_SURFACE_MANIFEST.find((candidate) => candidate.slug === "chat");
    await input.deps.waitForVerificationRouteReady(page, route, "@goatcitadel/mission-control-next");
    await input.deps.setBrowserCorrelation(page, input.correlationId, input.sessionId);
    await page.getByLabel("Message composer").waitFor({ timeout: 60_000 });
    if (input.sendPrompt) {
      await page.getByLabel("Message composer").fill(FOUNDATION_PROMPT);
      if (input.sendMethod === "keyboard-enter") {
        await page.getByLabel("Message composer").press("Enter");
      } else {
        await page.locator(".mc-next-composer-primary", { hasText: "Send" }).click();
      }
    }
    await page.waitForFunction(
      ({ reply, expectedCount, selector }) =>
        Array.from(document.querySelectorAll(selector)).filter((node) => {
          const bubble = node.closest(".mc-next-thread-bubble.assistant");
          return bubble?.getAttribute("aria-busy") === "false" && node.textContent?.trim() === reply;
        }).length >= expectedCount,
      {
        reply: FOUNDATION_REPLY,
        expectedCount: input.expectedReplyCount,
        selector: COMPLETED_ASSISTANT_CONTENT_SELECTOR,
      },
      { timeout: 120_000 },
    );
    const renderedReplies = await page.locator(COMPLETED_ASSISTANT_CONTENT_SELECTOR).allTextContents();
    const exactRenderedReplyCount = renderedReplies.filter((value) => value.trim() === FOUNDATION_REPLY).length;
    if (exactRenderedReplyCount < input.expectedReplyCount) {
      throw new Error(
        `expected ${input.expectedReplyCount} exact completed assistant replies, rendered ${exactRenderedReplyCount}`,
      );
    }
    const thread = await requestJson(
      input.stack.gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/thread?includeDecisionTrace=true`,
    );
    assertResponseOk(thread, "canonical Chat thread");
    assertCompletedChatTurns(thread.body, input.expectedReplyCount, FOUNDATION_REPLY);
    const activeWorkspaceId = await page.evaluate(() => window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"));
    if (activeWorkspaceId !== input.workspaceId) {
      throw new Error(`persisted workspace mismatch: expected ${input.workspaceId}, received ${activeWorkspaceId}`);
    }
    input.deps.assertBrowserConsoleHealthy(browserLog, browserLogCursor, "@goatcitadel/mission-control-next");
    captured = await input.deps.captureBrowserArtifacts(context, {
      slug: input.slug,
      page,
      browserLog,
      gatewayUrl: input.stack.gatewayUrl,
      correlationId: input.correlationId,
      logCursor: browserLogCursor,
    });
    mergeArtifacts(input.artifacts, captured);
    return { storageState: await browserContext.storageState() };
  } catch (error) {
    captured ??= await input.deps.captureBrowserArtifacts(context, {
      slug: `${input.slug}-failure`,
      page,
      browserLog,
      gatewayUrl: input.stack.gatewayUrl,
      correlationId: input.correlationId,
      logCursor: browserLogCursor,
    });
    const traceArtifact = await trace.retain().catch(() => null);
    mergeArtifacts(input.artifacts, input.deps.appendTraceArtifact(captured, traceArtifact));
    throw error;
  } finally {
    await trace.discard().catch(() => undefined);
    await browserContext.close();
  }
}

async function writeUsabilityResultRows(
  context,
  { baseSha, deps, inventory, sourceState, usabilityScenarioStartIndex },
) {
  const resultPath = path.join(context.artifactRoot, "diagnostics", "usability-results.json");
  const scenarioById = new Map(context.manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  const coverageRows = inventory.rows.map((inventoryRow) =>
    resolveInventoryEvidence(inventoryRow, scenarioById, baseSha, context.artifactRoot),
  );
  const laneRows = context.manifest.scenarios.slice(usabilityScenarioStartIndex).map((scenario) =>
    usabilityResultRow({
      journeyId: scenario.subsystem ?? scenario.lane,
      stepId: scenario.id,
      baseSha,
      expectedResult: "passed",
      actualResult: scenario.status,
      environment: "isolated-source",
      storage: "sqlite",
      profileState: scenario.id.includes("persisted") ? "persisted" : "fresh-or-api",
      viewport: scenario.metrics?.viewport,
      theme: scenario.metrics?.theme,
      provider: scenario.providerId ?? "fixture-or-not-applicable",
      evidence: flattenScenarioArtifacts(scenario.artifacts),
      status: scenario.status,
    }),
  );
  const gatewayFaultRows = await readGatewayChatFaultResultRows(context, scenarioById, baseSha, deps);
  const requiredFailures = coverageRows.filter((row) => row.required && row.status !== "passed");
  const invalidOptionalRows = coverageRows.filter(
    (row) => !row.required && row.status !== "passed" && !(typeof row.skipReason === "string" && row.skipReason.trim()),
  );
  await deps.writeJson(resultPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    sourceState,
    requiredSkipPolicy: "fail",
    optionalSkipPolicy: "explicit-reason-required",
    rows: [...coverageRows, ...laneRows, ...gatewayFaultRows],
  });
  if (invalidOptionalRows.length > 0) {
    throw new Error(
      `optional usability rows require a skip reason: ${invalidOptionalRows.map((row) => row.stepId).join(", ")}`,
    );
  }
  if (requiredFailures.length > 0) {
    throw new Error(
      `required usability evidence is missing or non-passing: ${requiredFailures.map((row) => row.stepId).join(", ")}`,
    );
  }
  return {
    resultPath,
    metrics: {
      resultRows: coverageRows.length + laneRows.length + gatewayFaultRows.length,
      requiredCoverageRows: coverageRows.filter((row) => row.required).length,
      optionalCoverageRows: coverageRows.filter((row) => !row.required).length,
      gatewayFaultStepRows: gatewayFaultRows.length,
      optionalNotConfigured: coverageRows.filter((row) => row.status === "not_configured").length,
    },
  };
}

export function assertRequiredUsabilityScenarioOrder(scenarios) {
  const faultIndices = [];
  const evidenceIndices = [];
  scenarios.forEach((scenario, index) => {
    if (scenario?.id === GATEWAY_CHAT_FAULT_SCENARIO_ID) faultIndices.push(index);
    if (scenario?.id === "usability.evidence-integrity") evidenceIndices.push(index);
  });
  if (faultIndices.length !== 1 || evidenceIndices.length !== 1) {
    throw new Error("Usability results require exactly one Gateway fault scenario and one evidence-integrity scenario");
  }
  if (faultIndices[0] >= evidenceIndices[0]) {
    throw new Error("Gateway Chat fault recovery must run before usability evidence integrity");
  }
}

export function assertGatewayChatFaultScenario(scenario, baseSha) {
  assertScenarioPassed(scenario, "Gateway Chat fault recovery");
  if (scenario.id !== GATEWAY_CHAT_FAULT_SCENARIO_ID) {
    throw new Error(
      `Gateway Chat fault recovery produced ${scenario.id ?? "no scenario id"}; expected ${GATEWAY_CHAT_FAULT_SCENARIO_ID}`,
    );
  }
  if (scenario.metrics?.baseSha !== baseSha) {
    throw new Error("Gateway Chat fault recovery evidence does not match the usability base SHA");
  }
  const expectedMetrics = {
    stepsPlanned: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsExecuted: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsPassed: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsFailed: 0,
    faultTargetDispatches: 12,
  };
  for (const [metric, expected] of Object.entries(expectedMetrics)) {
    if (scenario.metrics?.[metric] !== expected) {
      throw new Error(
        `Gateway Chat fault recovery reported ${metric}=${String(scenario.metrics?.[metric])}; expected ${expected}`,
      );
    }
  }
  const expectedArtifact = `diagnostics/${GATEWAY_CHAT_FAULT_ARTIFACT_NAME}`;
  const diagnosticArtifacts = Array.isArray(scenario.artifacts?.diagnostics) ? scenario.artifacts.diagnostics : [];
  if (diagnosticArtifacts.filter((entry) => entry === expectedArtifact).length !== 1) {
    throw new Error(`Gateway Chat fault recovery must retain exactly one ${expectedArtifact} artifact`);
  }
  return scenario;
}

export async function readGatewayChatFaultResultRows(context, scenarioById, baseSha, deps) {
  assertGatewayChatFaultScenario(scenarioById.get(GATEWAY_CHAT_FAULT_SCENARIO_ID), baseSha);
  const relativeArtifactPath = `diagnostics/${GATEWAY_CHAT_FAULT_ARTIFACT_NAME}`;
  const absoluteArtifactPath = path.join(context.artifactRoot, ...relativeArtifactPath.split("/"));
  const artifact = await deps.readJson(absoluteArtifactPath);
  if (
    artifact?.schemaVersion !== 1 ||
    artifact?.baseSha !== baseSha ||
    artifact?.defectId !== GATEWAY_CHAT_FAULT_DEFECT_ID ||
    artifact?.summary?.status !== "passed"
  ) {
    throw new Error("Gateway Chat fault recovery artifact provenance or terminal status is invalid");
  }
  const expectedSummary = {
    stepsPlanned: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsExecuted: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsPassed: GATEWAY_CHAT_FAULT_STEP_IDS.length,
    stepsFailed: 0,
    faultTargetDispatches: 12,
  };
  for (const [metric, expected] of Object.entries(expectedSummary)) {
    if (artifact.summary?.[metric] !== expected) {
      throw new Error(
        `Gateway Chat fault recovery artifact reported ${metric}=${String(artifact.summary?.[metric])}; expected ${expected}`,
      );
    }
  }
  if (!Array.isArray(artifact.steps)) {
    throw new Error("Gateway Chat fault recovery artifact contains no step result rows");
  }
  const actualStepIds = artifact.steps.map((step) => step?.stepId);
  if (
    actualStepIds.length !== GATEWAY_CHAT_FAULT_STEP_IDS.length ||
    new Set(actualStepIds).size !== GATEWAY_CHAT_FAULT_STEP_IDS.length ||
    GATEWAY_CHAT_FAULT_STEP_IDS.some((stepId) => !actualStepIds.includes(stepId))
  ) {
    throw new Error("Gateway Chat fault recovery artifact does not contain the exact required step set");
  }
  return artifact.steps.map((step) => {
    assertGatewayChatFaultStepRow(step, baseSha);
    return {
      ...step,
      evidence: [relativeArtifactPath],
    };
  });
}

function assertGatewayChatFaultStepRow(step, baseSha) {
  if (
    step?.journeyId !== "gateway-chat-fault-recovery" ||
    step.baseSha !== baseSha ||
    step.defectId !== GATEWAY_CHAT_FAULT_DEFECT_ID ||
    step.environment !== "isolated-source" ||
    step.storage !== "sqlite" ||
    step.profileState !== "api-sse" ||
    typeof step.provider !== "string" ||
    !step.provider.trim() ||
    step.status !== "passed" ||
    step.actualResult !== "passed" ||
    step.skipReason !== null ||
    typeof step.expectedResult !== "string" ||
    !step.expectedResult.trim() ||
    typeof step.startedAt !== "string" ||
    !step.startedAt.trim()
  ) {
    throw new Error(`Gateway Chat fault recovery step ${step?.stepId ?? "unknown"} has invalid result provenance`);
  }
  const diagnostics = step.diagnostics;
  if (
    !diagnostics ||
    !Number.isFinite(diagnostics.providerDispatchCount) ||
    diagnostics.providerDispatchCount < 1 ||
    typeof diagnostics.emittedOutput !== "boolean" ||
    !isNullOrNonEmptyString(diagnostics.providerFailureClass) ||
    !(
      diagnostics.remainingBudgetMs === null ||
      (Number.isFinite(diagnostics.remainingBudgetMs) && diagnostics.remainingBudgetMs >= 0)
    ) ||
    typeof diagnostics.recoveryOutcome !== "string" ||
    !diagnostics.recoveryOutcome.trim() ||
    !Array.isArray(diagnostics.diagnosticEvents)
  ) {
    throw new Error(`Gateway Chat fault recovery step ${step.stepId} is missing provider/recovery diagnostics`);
  }
  const correlation = diagnostics.correlation;
  if (
    !correlation ||
    ["correlationId", "sessionId", "turnId", "runId"].some(
      (key) => typeof correlation[key] !== "string" || !correlation[key].trim(),
    )
  ) {
    throw new Error(`Gateway Chat fault recovery step ${step.stepId} is missing session/turn/run correlation`);
  }
}

function isNullOrNonEmptyString(value) {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

export function resolveInventoryEvidence(inventoryRow, scenarioById, baseSha, artifactRoot) {
  if (!inventoryRow.required && inventoryRow.proofBindings.length === 0) {
    return {
      ...usabilityResultRow({
        journeyId: inventoryRow.journeyId,
        stepId: inventoryRow.stepId,
        baseSha,
        environment: "host-conditional",
        storage: "not-applicable",
        profileState: "not-applicable",
        provider: "not-configured",
        expectedResult: inventoryRow.expectedResult,
        actualResult: "Optional condition was not configured for this isolated campaign.",
        evidence: [],
        skipReason: inventoryRow.skipReason,
        status: "not_configured",
      }),
      kind: inventoryRow.kind,
      route: inventoryRow.route,
      action: inventoryRow.action,
      proofMode: inventoryRow.proofMode,
      required: false,
      requiredCondition: inventoryRow.requiredCondition,
      implementationRefs: inventoryRow.implementationRefs,
      testRefs: inventoryRow.testRefs,
      proofBindings: inventoryRow.proofBindings,
    };
  }

  const bindingResults = inventoryRow.proofBindings.map((binding) => {
    if (binding.mode === "missing-action-proof" || binding.mode === "missing-browser-action-proof") {
      return {
        ...binding,
        status: "failed",
        missingIds: [],
        nonPassingIds: [],
        missingEvidence: false,
        invalidEvidence: [],
        missingActionProof: true,
        evidence: [],
      };
    }
    const scenarios = binding.scenarioIds.map((scenarioId) => scenarioById.get(scenarioId));
    const missingIds = binding.scenarioIds.filter((_scenarioId, index) => !scenarios[index]);
    const nonPassingIds = scenarios
      .filter((scenario) => scenario && scenario.status !== "passed")
      .map((scenario) => scenario.id);
    const evidenceValidation = binding.requireArtifacts
      ? validateRequiredScenarioArtifacts(artifactRoot, scenarios)
      : {
          evidence: scenarios.flatMap((scenario) => flattenScenarioArtifacts(scenario?.artifacts)),
          issues: [],
        };
    const evidence = evidenceValidation.evidence;
    const missingEvidence = binding.requireArtifacts && evidence.length === 0;
    const invalidEvidence = evidenceValidation.issues;
    const actionAssertion = resolveActionAssertionBinding(binding, scenarios, baseSha);
    const browserAction = resolveBrowserActionBinding(binding, scenarios, baseSha, artifactRoot);
    const capabilityEntry = resolveCapabilityEntryBinding(binding, scenarios, baseSha, artifactRoot);
    return {
      ...binding,
      status:
        missingIds.length === 0 &&
        nonPassingIds.length === 0 &&
        !missingEvidence &&
        invalidEvidence.length === 0 &&
        actionAssertion.status === "passed" &&
        browserAction.status === "passed" &&
        capabilityEntry.status === "passed"
          ? "passed"
          : "failed",
      missingIds,
      nonPassingIds,
      missingEvidence,
      invalidEvidence,
      actionAssertion,
      browserAction,
      capabilityEntry,
      evidence,
    };
  });
  const passed = bindingResults.length > 0 && bindingResults.every((binding) => binding.status === "passed");
  const evidence = [...new Set(bindingResults.flatMap((binding) => binding.evidence))];
  return {
    ...usabilityResultRow({
      journeyId: inventoryRow.journeyId,
      stepId: inventoryRow.stepId,
      baseSha,
      environment: "isolated-source",
      storage: "sqlite-and-focused-regressions",
      profileState: "fresh-or-fixture",
      provider: "deterministic-fixture-or-not-applicable",
      expectedResult: inventoryRow.expectedResult,
      actualResult: passed
        ? `All ${bindingResults.length} exact proof binding(s) passed with retained evidence.`
        : describeBindingFailures(bindingResults),
      evidence,
      skipReason: inventoryRow.skipReason,
      status: passed ? "passed" : "failed",
    }),
    kind: inventoryRow.kind,
    route: inventoryRow.route,
    action: inventoryRow.action,
    proofMode: inventoryRow.proofMode,
    required: inventoryRow.required,
    requiredCondition: inventoryRow.requiredCondition,
    implementationRefs: inventoryRow.implementationRefs,
    testRefs: inventoryRow.testRefs,
    proofBindings: bindingResults,
  };
}

function describeBindingFailures(bindingResults) {
  return bindingResults
    .filter((binding) => binding.status !== "passed")
    .map((binding) => {
      const reasons = [];
      if (binding.missingIds.length > 0) reasons.push(`missing=${binding.missingIds.join("+")}`);
      if (binding.nonPassingIds.length > 0) reasons.push(`non_passing=${binding.nonPassingIds.join("+")}`);
      if (binding.missingEvidence) reasons.push("evidence=missing");
      if (binding.invalidEvidence.length > 0) {
        reasons.push(`evidence_invalid=${binding.invalidEvidence.map(formatArtifactIssue).join("+")}`);
      }
      if (binding.missingActionProof) reasons.push(`action_proof=${binding.contract ?? "missing"}`);
      if (binding.actionAssertion?.status === "failed") {
        reasons.push(`action_assertion=${binding.actionAssertion.reason}`);
      }
      if (binding.browserAction?.status === "failed") {
        reasons.push(`browser_action=${binding.browserAction.reason}`);
      }
      if (binding.capabilityEntry?.status === "failed") {
        reasons.push(`capability_entry=${binding.capabilityEntry.reason}`);
      }
      return reasons.join(";");
    })
    .join(" | ");
}

export function resolveBrowserActionBinding(binding, scenarios, baseSha, artifactRoot) {
  if (binding.mode !== "browser-action-step") return { status: "passed", reason: "not-applicable" };
  if (scenarios.length !== 1 || !scenarios[0]) return { status: "failed", reason: "owner-scenario-missing" };
  const scenario = scenarios[0];
  if (scenario.metrics?.baseSha !== baseSha) return { status: "failed", reason: "stale-base-sha" };
  const expectedIds = binding.browserStepIds ?? [];
  if (expectedIds.length !== 1) return { status: "failed", reason: "invalid-browser-step-binding" };
  const steps = Array.isArray(scenario.metrics?.browserActionSteps) ? scenario.metrics.browserActionSteps : [];
  const matches = steps.filter((row) => row?.stepId === expectedIds[0]);
  if (matches.length === 0) return { status: "failed", reason: `missing:${expectedIds[0]}` };
  if (matches.length > 1) return { status: "failed", reason: `duplicate:${expectedIds[0]}` };
  const match = matches[0];
  if (match.baseSha !== baseSha) return { status: "failed", reason: "step-stale-base-sha" };
  if (match.status !== "passed") return { status: "failed", reason: `non-passing:${match.status ?? "missing"}` };
  if (!Array.isArray(match.evidence) || match.evidence.length === 0) {
    return { status: "failed", reason: "step-evidence-missing" };
  }
  const evidenceValidation = validateRequiredScenarioArtifacts(artifactRoot, [
    {
      id: `${scenario.id}:${match.stepId}`,
      artifacts: { evidence: match.evidence },
    },
  ]);
  if (evidenceValidation.evidence.length === 0 || evidenceValidation.issues.length > 0) {
    return {
      status: "failed",
      reason: `step-evidence-invalid:${evidenceValidation.issues.map(formatArtifactIssue).join("+") || "missing"}`,
    };
  }
  if (!Array.isArray(match.operatorActions) || match.operatorActions.length === 0) {
    return { status: "failed", reason: "operator-actions-missing" };
  }
  if (match.proofKind !== "chromium-operator-action") {
    return { status: "failed", reason: "non-browser-proof-kind" };
  }
  return {
    status: "passed",
    stepId: match.stepId,
    operatorActionCount: match.operatorActions.length,
    evidence: match.evidence,
  };
}

function resolveActionAssertionBinding(binding, scenarios, baseSha) {
  if (binding.mode !== "action-assertion") return { status: "passed", reason: "not-applicable" };
  if (scenarios.length !== 1 || !scenarios[0]) return { status: "failed", reason: "owner-scenario-missing" };
  const scenario = scenarios[0];
  if (scenario.metrics?.baseSha !== baseSha) return { status: "failed", reason: "stale-base-sha" };
  const assertions = Array.isArray(scenario.metrics?.actionAssertions) ? scenario.metrics.actionAssertions : [];
  const expectedIds = binding.assertionIds ?? [];
  if (expectedIds.length !== 1) return { status: "failed", reason: "invalid-assertion-binding" };
  if (typeof binding.assertionFile !== "string" || typeof binding.assertionTitle !== "string") {
    return { status: "failed", reason: "assertion-contract-missing" };
  }
  const matches = assertions.filter((row) => row?.assertionId === expectedIds[0]);
  if (matches.length === 0) return { status: "failed", reason: `missing:${expectedIds[0]}` };
  if (matches.length > 1) return { status: "failed", reason: `duplicate:${expectedIds[0]}` };
  if (matches[0].file !== binding.assertionFile || matches[0].title !== binding.assertionTitle) {
    return { status: "failed", reason: "assertion-contract-mismatch" };
  }
  if (matches[0].status !== "passed") {
    return { status: "failed", reason: `non-passing:${matches[0].runnerStatus ?? matches[0].status}` };
  }
  return {
    status: "passed",
    assertionId: matches[0].assertionId,
    file: matches[0].file,
    title: matches[0].title,
  };
}

export function resolveCapabilityEntryBinding(binding, scenarios, baseSha, artifactRoot) {
  if (binding.mode !== "capability-disposition") return { status: "passed", reason: "not-applicable" };
  if (scenarios.length !== 1 || !scenarios[0]) return { status: "failed", reason: "owner-scenario-missing" };
  if (scenarios[0].metrics?.baseSha !== baseSha) return { status: "failed", reason: "stale-base-sha" };
  const capabilityIds = binding.capabilityIds ?? [];
  if (capabilityIds.length !== 1) return { status: "failed", reason: "invalid-capability-binding" };
  const dispositions = scenarios[0].metrics?.capabilityDispositions;
  if (!Array.isArray(dispositions)) return { status: "failed", reason: "disposition-evidence-missing" };
  const matches = dispositions.filter((item) => item?.capabilityId === capabilityIds[0]);
  if (matches.length !== 1) {
    return { status: "failed", reason: matches.length === 0 ? "capability-missing" : "capability-duplicate" };
  }
  const item = matches[0];
  if (item.baseSha !== baseSha) return { status: "failed", reason: "disposition-stale-base-sha" };
  if (item.status !== "passed") return { status: "failed", reason: `disposition-${item.status ?? "missing"}` };
  const owner = item.catalogOwner;
  if (typeof owner !== "string" || !owner.trim()) return { status: "failed", reason: "owner-missing" };
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    return { status: "failed", reason: "disposition-artifact-missing" };
  }
  const evidenceValidation = validateRequiredScenarioArtifacts(artifactRoot, [
    {
      id: `${scenarios[0].id}:${item.capabilityId}`,
      artifacts: { evidence: item.evidence },
    },
  ]);
  if (evidenceValidation.evidence.length === 0 || evidenceValidation.issues.length > 0) {
    return {
      status: "failed",
      reason: `disposition-artifact-invalid:${evidenceValidation.issues.map(formatArtifactIssue).join("+") || "missing"}`,
    };
  }
  if (!item.proof?.probeKind || !item.proof?.probeOutcome || !item.proof?.reason) {
    return { status: "failed", reason: "disposition-proof-incomplete" };
  }
  const allowedDispositions = new Set([
    "safe_contract_probe",
    "skill_activation_contract",
    "named_journey_proof",
    "catalog_only_denied",
    "explicit_non_executed_limitation",
  ]);
  if (!allowedDispositions.has(item.disposition)) {
    return { status: "failed", reason: `unknown-disposition:${item.disposition ?? "missing"}` };
  }
  if (binding.capabilityAction === "callability-governance") {
    if (item.callable !== true) return { status: "failed", reason: "callable-flag-false" };
    if (item.disposition === "catalog_only_denied") return { status: "failed", reason: "callable-catalog-only" };
  } else if (binding.capabilityAction === "inspectability") {
    if (item.callable === false && item.disposition !== "catalog_only_denied") {
      return { status: "failed", reason: "noncallable-disposition-is-not-denied" };
    }
    if (item.callable === true && item.disposition === "catalog_only_denied") {
      return { status: "failed", reason: "callable-disposition-is-catalog-only" };
    }
  } else {
    return { status: "failed", reason: `unknown-capability-action:${binding.capabilityAction ?? "missing"}` };
  }
  if (item.disposition === "safe_contract_probe") {
    if (
      item.proof.probeKind !== "deterministic-contract-invocation" ||
      !["executed", "ok"].includes(item.proof.probeOutcome) ||
      item.proof.executed !== true ||
      !item.proof.resultContract ||
      typeof item.proof.resultContract !== "object"
    ) {
      return { status: "failed", reason: "safe-contract-not-invoked" };
    }
  } else if (item.disposition === "skill_activation_contract") {
    if (
      item.proof.probeKind !== "skill-activation-contract" ||
      item.proof.probeOutcome !== "activation_contract_verified" ||
      item.proof.executed !== false ||
      item.proof.activationResult?.skillId !== item.skillId ||
      !["enabled", "sleep"].includes(item.proof.activationResult?.state)
    ) {
      return { status: "failed", reason: "skill-activation-contract-missing" };
    }
  } else if (item.disposition === "named_journey_proof") {
    if (
      item.proof.probeKind !== "named-journey-non-executed-contract" ||
      item.proof.probeOutcome !== "named_proof_required" ||
      item.proof.executed !== false ||
      !Array.isArray(item.proof.proofRefs) ||
      item.proof.proofRefs.length === 0 ||
      !Array.isArray(item.proof.namedProofs) ||
      item.proof.namedProofs.length !== item.proof.proofRefs.length
    ) {
      return { status: "failed", reason: "named-journey-proof-contract-missing" };
    }
  } else if (item.disposition === "catalog_only_denied") {
    if (item.proof.probeOutcome !== "denied" || item.proof.executed !== false) {
      return { status: "failed", reason: "catalog-only-denial-missing" };
    }
  } else if (
    item.proof.executed !== false ||
    !new Set(["denied", "approval_required", "autonomy_denied"]).has(item.proof.probeOutcome)
  ) {
    return { status: "failed", reason: "unsafe-diagnostic-denial-missing" };
  }
  return { status: "passed", capabilityId: item.capabilityId, owner, disposition: item.disposition };
}

export function assertCompletedChatTurns(thread, expectedCount, expectedReply) {
  if (!thread || !Array.isArray(thread.turns)) throw new Error("canonical Chat thread did not return turns");
  const latestTurns = thread.turns.slice(-expectedCount);
  if (latestTurns.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} canonical Chat turns, received ${latestTurns.length}`);
  }
  for (const turn of latestTurns) {
    if (turn?.trace?.status !== "completed") {
      throw new Error(`canonical Chat turn ${turn?.turnId ?? "unknown"} is ${turn?.trace?.status ?? "missing"}`);
    }
    if (turn?.assistantMessage?.content?.trim() !== expectedReply) {
      throw new Error(`canonical Chat turn ${turn?.turnId ?? "unknown"} has no exact assistant reply`);
    }
  }
}

export function usabilityResultRow(input) {
  return {
    journeyId: input.journeyId,
    stepId: input.stepId,
    baseSha: input.baseSha,
    environment: input.environment,
    storage: input.storage,
    profileState: input.profileState,
    viewport: input.viewport ?? null,
    theme: input.theme ?? null,
    provider: input.provider,
    expectedResult: input.expectedResult,
    actualResult: input.actualResult,
    evidence: input.evidence ?? [],
    defectId: input.defectId ?? null,
    skipReason: input.skipReason ?? null,
    status: input.status ?? "passed",
    startedAt: input.startedAt,
  };
}

function assertResponseOk(response, label) {
  if (!response?.ok)
    throw new Error(`${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body)}`);
}

function assertScenarioPassed(scenario, label) {
  if (scenario?.status !== "passed") {
    throw new Error(`${label} failed; downstream usability waves were stopped (${scenario?.id ?? "unknown scenario"})`);
  }
}

function assertScenarioRangePassed(context, startIndex, label) {
  const scenarios = context.manifest.scenarios.slice(startIndex);
  const failed = scenarios.filter((scenario) => scenario.status !== "passed");
  if (scenarios.length === 0) throw new Error(`${label} produced no executable scenarios`);
  if (failed.length > 0) {
    throw new Error(
      `${label} failed; downstream usability waves were stopped (${failed.map((item) => item.id).join(", ")})`,
    );
  }
}

function requireCatalogItems(body, label) {
  if (!Array.isArray(body?.items)) throw new Error(`${label} capability catalog did not return an items array`);
  for (const item of body.items) {
    if (!item || typeof item.capabilityId !== "string" || !item.capabilityId) {
      throw new Error(`${label} capability catalog returned an invalid identity`);
    }
  }
  return body.items;
}

function assertUniqueIds(items, label) {
  const ids = items.map((item) => item.capabilityId);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} capability catalog contains duplicate identities`);
}

function capabilityProofRecord(item) {
  return {
    capabilityId: item.capabilityId,
    title: item.title ?? item.name,
    kind: item.kind,
    category: item.category,
    callable: item.callable === true,
    lifecycleState: item.lifecycleState,
    trustLabel: item.trustLabel,
    sourceRef: item.sourceRef,
    sourceProvider: item.sourceProvider,
    toolName: item.toolName,
    skillId: item.skillId,
    proposalId: item.proposalId,
    candidateId: item.candidateId,
    wrapperVisibility: item.wrapperVisibility,
    effectPotential: item.effectPotential,
    declaredTools: Array.isArray(item.declaredTools) ? [...item.declaredTools] : item.declaredTools,
    requires: Array.isArray(item.requires) ? [...item.requires] : item.requires,
    mesh: item.mesh,
  };
}

function artifactSet(overrides = {}) {
  return {
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
    ...overrides,
  };
}

function mergeArtifacts(target, source) {
  for (const key of ["diagnostics", "screenshots", "traces", "logs", "perf", "playwright"]) {
    target[key].push(...(source?.[key] ?? []));
  }
}

function flattenScenarioArtifacts(artifacts) {
  return [...new Set(Object.values(artifacts ?? {}).flatMap((value) => (Array.isArray(value) ? value : [])))];
}

async function listRelativeArtifacts(context, directory, pattern) {
  const entries = await fs.readdir(directory).catch(() => []);
  return entries
    .filter((entry) => pattern.test(entry))
    .map((entry) => path.relative(context.artifactRoot, path.join(directory, entry)).replaceAll("\\", "/"));
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";

import {
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopVerificationStack,
} from "./lib/runtime.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./lib/scenarios/deterministic-llm-stub.mjs";
import {
  DETERMINISTIC_FIRECRAWL_RESULTS,
  startDeterministicFirecrawlStub,
} from "./lib/scenarios/deterministic-firecrawl-stub.mjs";
import { parseGatewayChatSse } from "./lib/scenarios/gateway-chat-fault-recovery-lane.mjs";
import { createRunContext, finalizeRunContext, repoRoot, runScenario, writeJson } from "./lib/shared.mjs";
import {
  auditPptxPackage,
  formatPptxAuditFailure,
  listZipEntryNames as listPptxZipEntryNames,
} from "./lib/pptx-package-audit.mjs";
import {
  buildCcgResearchDeckFixture,
  extractFixtureSourceUrls,
  extractFixtureVisibleText,
} from "./lib/ccg-research-deck-fixture.mjs";
import { assertResearchArtifactPromptDeckSemantics } from "./lib/research-artifact-prompt-contract.mjs";

const LANE = "review";
const PROCESS_LOG_PREFIX = "research-artifact-reliability";
export const RESEARCH_ARTIFACT_PROVIDER_ID = "openai";
export const RESEARCH_ARTIFACT_PROVIDER_MODEL = "gpt-5-verification";
export const RESEARCH_ARTIFACT_PROMPT =
  "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
export const RESEARCH_ARTIFACT_TASK_COUNT = 3;
export const RESEARCH_ARTIFACT_GAP_QUERIES = [
  "official Magic Pokemon Yu-Gi-Oh trading card game products organized play",
  "official One Piece Disney Lorcana Flesh and Blood trading card game organized play",
  "official Star Wars Unlimited Riftbound Gundam card game organized play",
  "North America CCG retailer marketplace financial event evidence 2026",
];
const PROVIDER_ID = RESEARCH_ARTIFACT_PROVIDER_ID;
const PROVIDER_MODEL = RESEARCH_ARTIFACT_PROVIDER_MODEL;
const PROMPT = RESEARCH_ARTIFACT_PROMPT;
const TASK_COUNT = RESEARCH_ARTIFACT_TASK_COUNT;
const TURN_TIMEOUT_FALLBACK_MS = 360_000;
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs(process.env.GOATCITADEL_VERIFY_RESEARCH_TURN_TIMEOUT_MS);
const FIRST_PROVIDER_INPUT_TOKEN_CEILING = 12_000;
// The structured presentation schema is part of the governed prompt-context
// estimate even though only a smaller serialized request reaches the provider.
const PROMPT_CONTEXT_ESTIMATE_TOKEN_CEILING = 13_000;

export async function main() {
  const context = await createRunContext(LANE, { profile: "isolated-built-runtime" });
  await runScenario(
    context,
    {
      id: "research-artifact.three-fresh-tasks",
      lane: LANE,
      title: "Three fresh explicit-research tasks create grounded openable PowerPoint artifacts",
      subsystem: "gateway-chat-reliability",
    },
    async ({ correlationId }) => runThreeTaskReplay(context, correlationId),
  );
  const manifest = await finalizeRunContext(context);
  console.log(`Artifact: ${context.artifactRoot}`);
  console.log(`Status: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
}

export async function runThreeTaskReplay(context, correlationId) {
  const presentationModulePath = path.join(repoRoot, "skills", "bundled", "design-intelligence", "presentation.md");
  const presentationModuleBytes = (await fs.stat(presentationModulePath)).size;
  assert.ok(presentationModuleBytes <= 8 * 1024, `presentation.md exceeds 8 KiB (${presentationModuleBytes} bytes)`);

  const dispatchPlan = [];
  const promptSemanticContracts = [];
  const acquiredEvidenceUrls = deterministicEvidenceUrls();
  for (let index = 1; index <= TASK_COUNT; index += 1) {
    const presentationArgs = buildPresentationArgs(index);
    promptSemanticContracts.push(
      assertResearchArtifactPromptDeckSemantics({
        prompt: PROMPT,
        args: presentationArgs,
        acquiredEvidenceUrls,
      }),
    );
    dispatchPlan.push(
      ...RESEARCH_ARTIFACT_GAP_QUERIES.map((query, queryIndex) => ({
        type: "tool_call",
        name: "browser_search",
        callId: `call_research_gap_${index}_${queryIndex + 1}`,
        arguments: { query, maxResults: 20, backend: "firecrawl", firecrawlFallbackToNative: false },
      })),
      {
        type: "tool_call",
        name: "presentations_create",
        callId: `call_research_deck_${index}`,
        arguments: presentationArgs,
      },
      {
        type: "success",
        replyText: `Research complete. I preserved the source citations and created ccg-market-reliability-${index}.pptx.`,
      },
    );
  }

  const stub = await startDeterministicLlmStub({
    providerId: PROVIDER_ID,
    model: PROVIDER_MODEL,
    dispatchPlanModel: PROVIDER_MODEL,
    dispatchPlan,
  });
  let runtimeRoot;
  let stack;
  let firecrawlStub;
  try {
    firecrawlStub = await startDeterministicFirecrawlStub();
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-research-artifact`);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl, {
      apiStyle: "openai-responses",
      providerId: PROVIDER_ID,
      model: PROVIDER_MODEL,
    });
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      uiMode: "preview",
      gatewayMode: "built",
      processLogPrefix: PROCESS_LOG_PREFIX,
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "none",
        GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        GOATCITADEL_DISABLE_SECRET_STORE: "true",
        GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "true",
        [DETERMINISTIC_LLM_KEY_ENV]: "verification-fixture-key",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl);
    const permissionProfileId = await createResearchArtifactPermissionProfile(stack.gatewayUrl, correlationId);

    const deckDir = path.join(context.artifactRoot, "artifacts", "presentations");
    const resultPath = path.join(context.artifactRoot, "diagnostics", "research-artifact-replay.json");
    const packagedChatScreenshotPath = path.join(
      context.artifactRoot,
      "screenshots",
      "research-artifact-packaged-chat.png",
    );
    const packagedChatDownloadPath = path.join(deckDir, "ccg-market-reliability-1-packaged-chat-download.pptx");
    await fs.mkdir(deckDir, { recursive: true });
    const results = [];
    for (let index = 1; index <= TASK_COUNT; index += 1) {
      const taskCorrelationId = `${correlationId}-task-${index}`;
      const sessionId = await createResearchSession(stack.gatewayUrl, taskCorrelationId, index);
      const turn =
        index === 1
          ? await sendResearchTurnThroughPackagedChat({
              stack,
              sessionId,
              screenshotPath: packagedChatScreenshotPath,
              downloadPath: packagedChatDownloadPath,
            })
          : await sendResearchTurn(stack.gatewayUrl, sessionId, taskCorrelationId, permissionProfileId);
      const capabilityProfile = await readResearchTurnCapabilityProfile(
        stack.gatewayUrl,
        sessionId,
        turn.turnId,
        taskCorrelationId,
      );
      const validated = await validateResearchTurn({
        turn,
        capabilityProfile,
        runtimeRoot,
        deckDir,
        index,
        expectedPermissionProfileId: permissionProfileId,
        acquiredEvidenceUrls,
      });
      if (index === 1) {
        const [downloaded, canonical] = await Promise.all([
          fs.readFile(packagedChatDownloadPath),
          fs.readFile(validated.deckPath),
        ]);
        assert.equal(
          createHash("sha256").update(downloaded).digest("hex"),
          createHash("sha256").update(canonical).digest("hex"),
          "packaged Chat download bytes differ from the audited canonical deck",
        );
      }
      results.push({ sessionId, turnId: turn.turnId, ...validated });
    }

    assert.equal(stub.dispatchPlanDispatches(), TASK_COUNT * (RESEARCH_ARTIFACT_GAP_QUERIES.length + 2));
    const requiredGapQueries = new Set(RESEARCH_ARTIFACT_GAP_QUERIES.map(normalizeSearchQuery));
    const firecrawlGapRequests = firecrawlStub
      .requests()
      .filter((request) => requiredGapQueries.has(normalizeSearchQuery(request.query)));
    assert.equal(firecrawlGapRequests.length, TASK_COUNT * RESEARCH_ARTIFACT_GAP_QUERIES.length);
    assert.ok(
      stub.imageGenerationDispatches() >= TASK_COUNT,
      `rich presentation path made only ${stub.imageGenerationDispatches()} image-generation calls`,
    );
    assert.ok(firecrawlGapRequests.every((request) => request.matched));
    await writeJson(resultPath, {
      schemaVersion: 1,
      prompt: PROMPT,
      taskCount: TASK_COUNT,
      presentationModuleBytes,
      providerDispatches: stub.dispatchPlanDispatches(),
      imageGenerationDispatches: stub.imageGenerationDispatches(),
      firecrawlRequests: firecrawlStub.requests(),
      promptSemanticContracts,
      results,
    });
    return {
      status: "passed",
      providerId: PROVIDER_ID,
      modelId: PROVIDER_MODEL,
      notes: [
        "Each task used a fresh Chat session in an isolated built Gateway runtime.",
        "The provider was deterministic and loopback-only; browser.search and presentations.create were the real governed tools.",
        "Gap-closing searches used the existing local Firecrawl boundary with deterministic external HTTPS evidence.",
      ],
      metrics: {
        tasks: TASK_COUNT,
        completed: results.length,
        providerDispatches: stub.dispatchPlanDispatches(),
        imageGenerationDispatches: stub.imageGenerationDispatches(),
        packagedChatTasks: 1,
        firecrawlRequests: firecrawlStub.requests().length,
        firecrawlGapRequests: firecrawlGapRequests.length,
        promptSemanticContractsPassed: promptSemanticContracts.filter((report) => report.passed).length,
        presentationModuleBytes,
        maximumFirstProviderInputTokens: Math.max(...results.map((result) => result.firstProviderInputTokens)),
        maximumPromptContextEstimatedTokens: Math.max(...results.map((result) => result.promptContextEstimatedTokens)),
        maximumActivatedSkillInstructionBytes: Math.max(
          ...results.map((result) => result.activatedSkillInstructionBytes),
        ),
      },
      artifacts: {
        diagnostics: [
          relativeArtifact(context, resultPath),
          ...results.flatMap((result) => [
            relativeArtifact(context, result.copiedDeckPath),
            relativeArtifact(context, result.auditPath),
          ]),
          relativeArtifact(context, packagedChatDownloadPath),
        ],
        screenshots: [relativeArtifact(context, packagedChatScreenshotPath)],
        traces: [],
        logs: [],
        perf: [],
        playwright: [],
      },
    };
  } catch (error) {
    await writeJson(path.join(context.artifactRoot, "diagnostics", "research-artifact-failure.json"), {
      schemaVersion: 1,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              snapshot: error.verificationSnapshot,
              diagnostics: error.verificationDiagnostics,
            }
          : String(error),
      completionDispatches: stub.completionDispatches(),
      dispatchPlanDispatches: stub.dispatchPlanDispatches(),
      requests: stub.requestSummaries(),
      firecrawlRequests: firecrawlStub?.requests() ?? [],
    });
    throw error;
  } finally {
    await stopVerificationStack(stack ?? (runtimeRoot ? { runtimeRoot } : undefined));
    await firecrawlStub?.close();
    await stub.close();
  }
}

export function buildPresentationArgs(index) {
  return buildCcgResearchDeckFixture(index);
}

export async function createResearchSession(gatewayUrl, correlationId, index) {
  const created = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
    method: "POST",
    headers: correlationHeaders(correlationId),
    body: { title: `Research artifact reliability ${index}` },
  });
  assertResponseOk(created, "create research-artifact session");
  const sessionId = requireText(created.body?.sessionId, "session id");
  const prefs = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    headers: correlationHeaders(correlationId),
  });
  assertResponseOk(prefs, "read research-artifact preferences");
  const patched = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    method: "PATCH",
    headers: correlationHeaders(correlationId),
    body: {
      expectedRevision: prefs.body.revision,
      providerId: PROVIDER_ID,
      model: PROVIDER_MODEL,
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "off",
      subagentPolicy: "off",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: false,
    },
  });
  assertResponseOk(patched, "patch research-artifact preferences");
  return sessionId;
}

export async function sendResearchTurn(gatewayUrl, sessionId, correlationId, permissionProfileId) {
  const request = {
    action: "send",
    content: PROMPT,
    providerId: PROVIDER_ID,
    model: PROVIDER_MODEL,
    webMode: "quick",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    permissionProfileId,
    prefsOverride: {
      providerId: PROVIDER_ID,
      model: PROVIDER_MODEL,
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "off",
      subagentPolicy: "off",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: false,
    },
  };
  const preflight = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`,
    { method: "POST", headers: correlationHeaders(correlationId), body: request },
  );
  assertResponseOk(preflight, "research-artifact route preflight");
  assert.ok(preflight.body?.decision, "research-artifact route preflight returned no decision");
  const admittedRequest = {
    ...request,
    providerId: preflight.body.decision.effectiveProviderId,
    model: preflight.body.decision.effectiveModel,
    routeDecision: preflight.body.decision,
  };
  const response = await fetch(
    `${gatewayUrl}/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`,
    {
      method: "POST",
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        "x-goatcitadel-correlation-id": correlationId,
        "x-goatcitadel-session-id": sessionId,
      },
      body: JSON.stringify(admittedRequest),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`research-artifact SSE failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  let latestSnapshot;
  let latestDiagnostics;
  const poll = async () => {
    const [thread, diagnostics] = await Promise.all([
      requestJson(
        gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
        { headers: correlationHeaders(correlationId) },
      ),
      requestJson(gatewayUrl, "/api/v1/dev/diagnostics?limit=100", {
        headers: correlationHeaders(correlationId),
      }),
    ]);
    if (thread.ok) latestSnapshot = thread.body;
    if (diagnostics.ok) latestDiagnostics = diagnostics.body;
  };
  const pollingTimer = setInterval(() => void poll().catch(() => undefined), 2_000);
  let raw;
  try {
    await poll();
    raw = await response.text();
  } catch (error) {
    if (error instanceof Error) {
      error.verificationSnapshot = latestSnapshot;
      error.verificationDiagnostics = latestDiagnostics;
    }
    throw error;
  } finally {
    clearInterval(pollingTimer);
  }
  const chunks = parseGatewayChatSse(raw);
  assert.equal(
    chunks.some((chunk) => chunk.type === "error"),
    false,
    "research-artifact stream emitted an error",
  );
  assert.doesNotMatch(
    JSON.stringify(chunks),
    /stream interrupted|reconnect(?:ing)?|repaired completion|provider request failed|provider_timeout/iu,
    "research-artifact stream contained reconnect, repair, or provider-failure evidence",
  );
  const thread = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
    { headers: correlationHeaders(correlationId) },
  );
  assertResponseOk(thread, "read canonical research-artifact thread");
  const turnId = chunks.find((chunk) => requireOptionalText(chunk.turnId))?.turnId;
  const turn = Array.isArray(thread.body?.turns)
    ? (thread.body.turns.find((candidate) => candidate.turnId === turnId) ?? thread.body.turns.at(-1))
    : undefined;
  assert.ok(turn, "canonical research-artifact turn is missing");
  return turn;
}

export async function sendResearchTurnThroughPackagedChat({ stack, sessionId, screenshotPath, downloadPath }) {
  assert.ok(stack?.uiUrl, "packaged Chat replay requires a running preview UI");
  const browser = await chromium.launch({ headless: true });
  try {
    const browserContext = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      colorScheme: "dark",
    });
    const page = await browserContext.newPage();
    await page.goto(`${stack.uiUrl}/chat?sessionId=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    const composer = page.getByLabel("Message composer", { exact: true });
    await composer.waitFor({ state: "visible", timeout: 120_000 });
    await composer.fill(PROMPT);
    await page.locator(".mc-next-composer-primary", { hasText: "Send" }).click();
    const downloadLink = page.getByRole("link", { name: "Download the PowerPoint" }).last();
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (!(await downloadLink.isVisible().catch(() => false))) {
      const snapshot = await requestJson(
        stack.gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
      );
      const latestTurn = Array.isArray(snapshot.body?.turns) ? snapshot.body.turns.at(-1) : undefined;
      if (latestTurn?.trace?.status === "failed") {
        const failure = latestTurn.trace.failure;
        throw new Error(
          `packaged Chat research turn failed before producing a download: ${JSON.stringify(failure ?? {})}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`packaged Chat did not render a PowerPoint download within ${TURN_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const downloadHref = await downloadLink.getAttribute("href");
    assert.match(downloadHref ?? "", /\.pptx|\/api\/v1\/files\/download/iu);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), downloadLink.click()]);
    assert.match(download.suggestedFilename(), /\.pptx$/iu);
    await download.saveAs(downloadPath);
    const downloadBytes = await fs.readFile(downloadPath);
    assert.equal(downloadBytes.subarray(0, 2).toString("ascii"), "PK", "packaged Chat download is not a PPTX ZIP");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const thread = await requestJson(
      stack.gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread?includeDecisionTrace=true`,
    );
    assertResponseOk(thread, "read packaged Chat research-artifact thread");
    const turn = Array.isArray(thread.body?.turns) ? thread.body.turns.at(-1) : undefined;
    assert.ok(turn, "packaged Chat research-artifact turn is missing");
    return turn;
  } finally {
    await browser.close();
  }
}

export async function createResearchArtifactPermissionProfile(gatewayUrl, correlationId) {
  const created = await requestJson(gatewayUrl, "/api/v1/tools/permission-profiles", {
    method: "POST",
    headers: {
      ...correlationHeaders(correlationId),
      "Idempotency-Key": randomUUID(),
    },
    body: {
      label: "Research artifact reliability fixture",
      description: "Disposable exact-tool bypass used only by the isolated three-task verification runtime.",
      scope: "workspace",
      scopeRef: "default",
      approvalMode: "bypass",
      toolPatterns: ["browser.search", "presentations.create"],
      allow: ["browser.search", "presentations.create"],
      deny: [],
      readAccessMode: "roots_only",
      defaultForSurfaces: ["chat"],
    },
  });
  assertResponseOk(created, "create research-artifact permission profile");
  return requireText(created.body?.profileId, "research-artifact permission profile id");
}

export async function readResearchTurnCapabilityProfile(gatewayUrl, sessionId, turnId, correlationId) {
  const response = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/capability-profile`,
    { headers: correlationHeaders(correlationId) },
  );
  assertResponseOk(response, "read research-artifact capability profile");
  assert.equal(response.body?.state, "available", "research-artifact capability profile is unavailable");
  assert.ok(response.body?.profile, "research-artifact capability profile payload is missing");
  return response.body.profile;
}

export async function validateResearchTurn({
  turn,
  capabilityProfile,
  runtimeRoot,
  deckDir,
  index,
  expectedPermissionProfileId,
  acquiredEvidenceUrls = deterministicEvidenceUrls(),
}) {
  assert.equal(turn.trace?.status, "completed");
  assert.equal(turn.trace?.completion?.repaired, false);
  assert.equal(turn.trace?.failure, undefined);
  assert.equal(turn.trace?.routing?.executionBudget?.profile, "research_artifact");
  assert.equal(turn.trace?.routing?.executionBudget?.promotionReason, "explicit_research_artifact");
  assert.equal(turn.trace?.routing?.modelRouter?.selectedEngine, "web_research");
  assert.equal(turn.trace?.routing?.modelRouter?.requiresTools, true);
  assert.equal(turn.trace?.routing?.executionBudget?.turnBudgetMs, 600_000);
  assert.equal(turn.trace?.routing?.executionBudget?.completionTimeoutMs, 300_000);
  const firstProviderInputTokens = Number(
    turn.trace?.completion?.firstProviderRequestUsage?.effectiveInputTokens ?? Number.NaN,
  );
  assert.ok(Number.isFinite(firstProviderInputTokens) && firstProviderInputTokens < FIRST_PROVIDER_INPUT_TOKEN_CEILING);
  const promptContextEstimatedTokens = Number(turn.trace?.routing?.promptContextBudget?.tokenEstimates?.total);
  assert.ok(
    Number.isFinite(promptContextEstimatedTokens) &&
      promptContextEstimatedTokens < PROMPT_CONTEXT_ESTIMATE_TOKEN_CEILING,
    `estimated first-provider context exceeded the ${PROMPT_CONTEXT_ESTIMATE_TOKEN_CEILING}-token ceiling (${promptContextEstimatedTokens})`,
  );
  const activatedSkills = capabilityProfile?.selection?.activatedSkills ?? [];
  const activatedSkillInstructionBytes = activatedSkills.reduce(
    (total, skill) => total + Number(skill.instructionBytes ?? 0),
    0,
  );
  assert.ok(activatedSkills.length > 0, "presentation turn activated no governed skill instructions");
  assert.ok(
    activatedSkillInstructionBytes < 10 * 1024,
    `activated-skill instructions exceeded the 10 KiB ceiling (${activatedSkillInstructionBytes} bytes)`,
  );
  const frozenToolNames = new Set(
    (capabilityProfile?.selection?.tools ?? []).map((tool) => String(tool.canonicalName ?? "")),
  );
  assert.ok(frozenToolNames.has("browser.search"), "capability profile omitted browser.search");
  assert.ok(frozenToolNames.has("presentations.create"), "capability profile omitted presentations.create");
  assert.equal(
    capabilityProfile?.governance?.permission?.profileId,
    expectedPermissionProfileId,
    "research turn did not use the narrow verification permission profile",
  );

  const executedRuns = (turn.trace?.toolRuns ?? []).filter((run) => run.status === "executed");
  const searchRuns = executedRuns.filter((run) => run.toolName === "browser.search");
  assert.ok(searchRuns.length >= 3, `expected multiple gap-closing searches, found ${searchRuns.length}`);
  const normalizedQueries = new Set(searchRuns.map((run) => normalizeSearchQuery(run.args?.query)));
  assert.equal(normalizedQueries.size, searchRuns.length, "research turn reused an equivalent search query");
  for (const query of RESEARCH_ARTIFACT_GAP_QUERIES) {
    assert.ok(
      normalizedQueries.has(normalizeSearchQuery(query)),
      `research turn omitted the required gap search: ${query}`,
    );
  }
  assert.ok((turn.trace?.citations ?? []).length >= 12, "research turn retained fewer than 12 citations");
  assert.ok((turn.trace?.citations ?? []).every((citation) => /^https?:\/\//u.test(citation.url)));
  const citationUrls = new Set(turn.trace.citations.map((citation) => canonicalCitationUrl(citation.url)));
  assert.ok(citationUrls.size >= 12, `research turn retained only ${citationUrls.size} unique citation URLs`);
  const citationDomains = new Set(turn.trace.citations.map((citation) => new URL(citation.url).hostname.toLowerCase()));
  assert.ok(citationDomains.size >= 8, `research turn retained citations from only ${citationDomains.size} domains`);

  const presentationRun = executedRuns.findLast((run) => run.toolName === "presentations.create");
  assert.ok(presentationRun, "research turn did not execute presentations.create");
  assert.equal(executedRuns.at(-1), presentationRun, "presentation creation was not the final executed tool");
  assert.ok(Array.isArray(presentationRun.args?.sources) && presentationRun.args.sources.length >= 12);
  assert.ok(Array.isArray(presentationRun.args?.slides) && presentationRun.args.slides.length >= 12);
  assert.equal(typeof presentationRun.args?.research?.asOfDate, "string");
  assert.ok(Array.isArray(presentationRun.args?.research?.competitors));
  const promptSemanticContract = assertResearchArtifactPromptDeckSemantics({
    prompt: PROMPT,
    args: presentationRun.args,
    acquiredEvidenceUrls,
  });
  const outputPath = requireText(presentationRun?.result?.path, "presentation result path");
  const deckPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(runtimeRoot, outputPath);
  const renderManifest = presentationRun.result?.renderManifest;
  assert.ok(renderManifest, "presentation result omitted renderManifest");
  assert.equal(presentationRun.result?.packageAudit?.passed, true, "production in-render package audit did not pass");
  const validation = await validatePptxArchive(deckPath, {
    expectedVisibleText: extractFixtureVisibleText(presentationRun.args),
    expectedExternalUrls: extractFixtureSourceUrls(presentationRun.args),
    manifest: renderManifest,
    requireLayoutDiversity: true,
  });
  assert.ok(validation.slideCount >= 16, `expected at least 16 deck slides, found ${validation.slideCount}`);
  assert.ok(
    validation.metrics.tableCount >= 4,
    `expected at least four native tables, found ${validation.metrics.tableCount}`,
  );
  assert.ok(validation.metrics.chartCount >= 1, "deck did not exercise the native chart path");
  assert.ok(validation.metrics.pictureCount >= 1, "deck did not embed a provider-generated presentation visual");
  assert.ok(validation.metrics.hyperlinkCount >= 12, "deck retained fewer than 12 clickable source hyperlinks");
  assert.ok(validation.metrics.sourceUrlCount >= 12, "deck source appendix exposes fewer than 12 complete URLs");
  assert.equal(validation.metrics.shrinkAutofitCount, 0, "deck contains body shrink-to-fit");
  const copiedDeckPath = path.join(deckDir, `ccg-market-reliability-${index}.pptx`);
  const auditPath = path.join(deckDir, `ccg-market-reliability-${index}.audit.json`);
  await fs.copyFile(deckPath, copiedDeckPath);
  await writeJson(auditPath, validation);
  const assistantContent = String(turn.assistantMessage?.content ?? "");
  assert.match(assistantContent, /\.pptx/u);
  assert.doesNotMatch(assistantContent, /timed out|reconnect|repaired completion|provider request failed/iu);
  return {
    status: turn.trace.status,
    firstProviderInputTokens,
    promptContextEstimatedTokens,
    activatedSkillInstructionBytes,
    citations: turn.trace.citations.map((citation) => citation.url),
    searchQueries: searchRuns.map((run) => run.args.query),
    deckPath,
    copiedDeckPath,
    auditPath,
    deckBytes: validation.bytes,
    slideCount: validation.slideCount,
    auditMetrics: validation.metrics,
    promptSemanticContract,
  };
}

export async function validatePptxArchive(filePath, options = {}) {
  const report = await auditPptxPackage(filePath, options);
  assert.equal(report.passed, true, formatPptxAuditFailure(report));
  return { ...report, slideCount: report.metrics.slideCount };
}

export function listZipEntryNames(buffer) {
  return listPptxZipEntryNames(buffer);
}

export async function ensureOnboardingComplete(gatewayUrl, completedBy = "verification-research-artifact-reliability") {
  const state = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  assertResponseOk(state, "read onboarding state");
  if (state.body?.completed === true) return;
  const completed = await requestJson(gatewayUrl, "/api/v1/onboarding/complete", {
    method: "POST",
    body: { completedBy },
  });
  assertResponseOk(completed, "complete onboarding");
}

function correlationHeaders(correlationId) {
  return { "x-goatcitadel-correlation-id": correlationId };
}

function assertResponseOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body ?? null)}`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

function requireOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSearchQuery(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .sort()
    .join(" ");
}

function canonicalCitationUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

export function deterministicEvidenceUrls() {
  return [...DETERMINISTIC_FIRECRAWL_RESULTS.values()].flat().map((result) => result.url);
}

function relativeArtifact(context, filePath) {
  return path.relative(context.artifactRoot, filePath).split(path.sep).join("/");
}

function resolveTurnTimeoutMs(value) {
  const parsed = Number(value ?? TURN_TIMEOUT_FALLBACK_MS);
  return Number.isFinite(parsed) && parsed >= 10_000 && parsed <= 600_000
    ? Math.floor(parsed)
    : TURN_TIMEOUT_FALLBACK_MS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

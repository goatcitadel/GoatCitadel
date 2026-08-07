#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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
import { parseGatewayChatSse } from "./lib/scenarios/gateway-chat-fault-recovery-lane.mjs";
import { createRunContext, finalizeRunContext, repoRoot, runScenario, writeJson } from "./lib/shared.mjs";

const LANE = "review";
const PROCESS_LOG_PREFIX = "research-artifact-reliability";
export const RESEARCH_ARTIFACT_PROVIDER_ID = "openai";
export const RESEARCH_ARTIFACT_PROVIDER_MODEL = "gpt-5-verification";
export const RESEARCH_ARTIFACT_PROMPT =
  "Can you please do some market research on CCGs and what makes each one unique and better than the competition? Please put it into a powerpoint deck.";
export const RESEARCH_ARTIFACT_TASK_COUNT = 3;
const PROVIDER_ID = RESEARCH_ARTIFACT_PROVIDER_ID;
const PROVIDER_MODEL = RESEARCH_ARTIFACT_PROVIDER_MODEL;
const PROMPT = RESEARCH_ARTIFACT_PROMPT;
const TASK_COUNT = RESEARCH_ARTIFACT_TASK_COUNT;
const TURN_TIMEOUT_FALLBACK_MS = 360_000;
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs(process.env.GOATCITADEL_VERIFY_RESEARCH_TURN_TIMEOUT_MS);

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
  for (let index = 1; index <= TASK_COUNT; index += 1) {
    dispatchPlan.push(
      {
        type: "tool_call",
        name: "presentations_create",
        callId: `call_research_deck_${index}`,
        arguments: buildPresentationArgs(index),
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
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-research-artifact`);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl, {
      apiStyle: "openai-responses",
      providerId: PROVIDER_ID,
      model: PROVIDER_MODEL,
    });
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: false,
      gatewayMode: "built",
      processLogPrefix: PROCESS_LOG_PREFIX,
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "none",
        GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        GOATCITADEL_DISABLE_SECRET_STORE: "true",
        GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "true",
        GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS: "true",
        [DETERMINISTIC_LLM_KEY_ENV]: "verification-fixture-key",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl);
    const permissionProfileId = await createResearchArtifactPermissionProfile(stack.gatewayUrl, correlationId);

    const deckDir = path.join(context.artifactRoot, "artifacts", "presentations");
    const resultPath = path.join(context.artifactRoot, "diagnostics", "research-artifact-replay.json");
    await fs.mkdir(deckDir, { recursive: true });
    const results = [];
    for (let index = 1; index <= TASK_COUNT; index += 1) {
      const taskCorrelationId = `${correlationId}-task-${index}`;
      const sessionId = await createResearchSession(stack.gatewayUrl, taskCorrelationId, index);
      const turn = await sendResearchTurn(stack.gatewayUrl, sessionId, taskCorrelationId, permissionProfileId);
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
      });
      results.push({ sessionId, turnId: turn.turnId, ...validated });
    }

    assert.equal(stub.dispatchPlanDispatches(), TASK_COUNT * 2);
    await writeJson(resultPath, {
      schemaVersion: 1,
      prompt: PROMPT,
      taskCount: TASK_COUNT,
      presentationModuleBytes,
      providerDispatches: stub.dispatchPlanDispatches(),
      results,
    });
    return {
      status: "passed",
      providerId: PROVIDER_ID,
      modelId: PROVIDER_MODEL,
      notes: [
        "Each task used a fresh Chat session in an isolated built Gateway runtime.",
        "The provider was deterministic and loopback-only; browser.search and presentations.create were the real governed tools.",
      ],
      metrics: {
        tasks: TASK_COUNT,
        completed: results.length,
        providerDispatches: stub.dispatchPlanDispatches(),
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
          ...results.map((result) => relativeArtifact(context, result.copiedDeckPath)),
        ],
        screenshots: [],
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
    });
    throw error;
  } finally {
    await stopVerificationStack(stack ?? (runtimeRoot ? { runtimeRoot } : undefined));
    await stub.close();
  }
}

export function buildPresentationArgs(index) {
  return {
    path: `./workspace/artifacts/ccg-market-reliability-${index}.pptx`,
    title: "Competitive CCG Landscape",
    subtitle: "Research-backed differentiation across leading collectible card games",
    theme: "midnight teal",
    design: { mode: "polished", skillId: "design-intelligence" },
    slides: [
      {
        title: "Category Differentiators",
        bullets: [
          "Rules accessibility, collection depth, and organized play shape each game's market position.",
          "Distinct intellectual property and gameplay loops create different reasons for players to choose each game.",
        ],
        speakerNotes: "Grounding: official Magic product catalog, https://magic.wizards.com/en/products",
      },
      {
        title: "Competitive Strengths",
        bullets: [
          "Magic emphasizes deep deck construction, long-running formats, and broad organized play.",
          "Pokémon combines an accessible ruleset with a globally recognized character ecosystem.",
          "Other CCGs differentiate through digital-first play, cooperative modes, or focused licensed worlds.",
        ],
      },
      {
        title: "Community and Product Strategy",
        bullets: [
          "Release cadence and collectability sustain engagement between competitive events.",
          "Retail availability and local-play support influence discovery and retention.",
          "Digital clients reduce friction while physical products preserve collecting and in-person play.",
        ],
      },
      {
        title: "Comparison Framework",
        bullets: [
          "Compare onboarding friction, strategic depth, secondary-market dynamics, and play-format breadth.",
          "Separate intellectual-property appeal from mechanics and community strength.",
          "Use current product and organized-play evidence before making investment or launch decisions.",
        ],
      },
      {
        title: "Research Sources",
        bullets: [
          "Wizards of the Coast — Magic products: https://magic.wizards.com/en/products",
          "The Pokémon Company — Pokémon TCG: https://www.pokemon.com/us/pokemon-tcg/",
        ],
      },
    ],
  };
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
      defaultForSurfaces: [],
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

export async function validateResearchTurn({ turn, capabilityProfile, runtimeRoot, deckDir, index }) {
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
  assert.ok(Number.isFinite(firstProviderInputTokens) && firstProviderInputTokens < 12_000);
  const promptContextEstimatedTokens = Number(turn.trace?.routing?.promptContextBudget?.tokenEstimates?.total);
  assert.ok(
    Number.isFinite(promptContextEstimatedTokens) && promptContextEstimatedTokens < 12_000,
    `estimated first-provider context exceeded the 12000-token ceiling (${promptContextEstimatedTokens})`,
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

  const executedRuns = (turn.trace?.toolRuns ?? []).filter((run) => run.status === "executed");
  assert.deepEqual(
    executedRuns.map((run) => run.toolName),
    ["browser.search", "presentations.create"],
  );
  assert.equal(executedRuns[0]?.args?.query, "CCGs and what makes each one unique and better than the competition");
  assert.ok((turn.trace?.citations ?? []).length > 0, "research turn retained no citations");
  assert.ok((turn.trace?.citations ?? []).every((citation) => /^https?:\/\//u.test(citation.url)));

  const presentationRun = executedRuns[1];
  const outputPath = requireText(presentationRun?.result?.path, "presentation result path");
  const deckPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(runtimeRoot, outputPath);
  const validation = await validatePptxArchive(deckPath);
  assert.ok(validation.slideCount >= 5, `expected at least five deck slides, found ${validation.slideCount}`);
  const copiedDeckPath = path.join(deckDir, `ccg-market-reliability-${index}.pptx`);
  await fs.copyFile(deckPath, copiedDeckPath);
  const assistantContent = String(turn.assistantMessage?.content ?? "");
  assert.match(assistantContent, /\.pptx/u);
  assert.doesNotMatch(assistantContent, /timed out|reconnect|repaired completion|provider request failed/iu);
  return {
    status: turn.trace.status,
    firstProviderInputTokens,
    promptContextEstimatedTokens,
    activatedSkillInstructionBytes,
    citations: turn.trace.citations.map((citation) => citation.url),
    searchQuery: executedRuns[0].args.query,
    deckPath,
    copiedDeckPath,
    deckBytes: validation.bytes,
    slideCount: validation.slideCount,
  };
}

export async function validatePptxArchive(filePath) {
  const buffer = await fs.readFile(filePath);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, "PPTX does not begin with a ZIP local-file header");
  const entries = listZipEntryNames(buffer);
  assert.ok(entries.includes("[Content_Types].xml"), "PPTX is missing [Content_Types].xml");
  assert.ok(entries.includes("ppt/presentation.xml"), "PPTX is missing ppt/presentation.xml");
  const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry));
  return { bytes: buffer.byteLength, slideCount: slides.length, entries };
}

export function listZipEntryNames(buffer) {
  const minimumEocdOffset = Math.max(0, buffer.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, "ZIP end-of-central-directory record is missing");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "ZIP central-directory entry is malformed");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
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

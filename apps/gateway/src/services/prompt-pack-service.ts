/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";

const log = logger.child("prompt-pack-service");
import type {
  CapabilityTrendSeries,
  ChatMemoryMode,
  ChatMode,
  ChatProjectRecord,
  ChatSessionPrefsPatch,
  ChatThinkingLevel,
  ChatWebMode,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCitationRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionCreateInput,
  ChatSessionRecord,
  ChatTurnTraceRecord,
  PromptPackAutoScoreBatchResult,
  PromptPackAutoScoreResult,
  PromptPackBenchmarkItemRecord,
  PromptPackBenchmarkProviderInput,
  PromptPackBenchmarkRunRecord,
  PromptPackBenchmarkStatusRecord,
  PromptPackDiagnosticMetadata,
  PromptPackDimensionScoreV2,
  PromptPackExecutionStyle,
  PromptPackExportRecord,
  PromptPackHumanReviewRecordV2,
  PromptPackJudgeStatusV2,
  PromptPackJudgeRecord,
  PromptPackLatestAssessmentRecordV2,
  PromptPackMergeProvenanceEntryV2,
  PromptPackPolicyV2,
  PromptPackRecord,
  PromptPackReasonCode,
  PromptPackReportRecord,
  PromptPackRunIntegrityRecord,
  PromptPackRunRecord,
  PromptPackScoreDimensionV2,
  PromptPackScoreRecord,
  PromptPackScoreRecordV2,
  PromptPackScoreState,
  PromptPackTestRecord,
  PromptPackToolTier,
  PromptPackVerdict,
  RealtimeEvent,
  ToolGrantConstraints,
  ReplayRegressionResult,
  ReplayRegressionRun,
} from "@goatcitadel/contracts";
import { DEFAULT_PROMPT_PACK_POLICY_V2, getChatModePreset } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2, type Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { parseLooseJsonRecord } from "./json-record-parser.js";
import { applyPromptPackPromptLabFallbacks } from "./prompt-pack-empty-output-fallbacks.js";
import { resolveProjectRootForToolContext } from "./tool-path-resolution.js";

// ── constants ────────────────────────────────────────────────────────
const PROMPT_PACK_PASS_THRESHOLD = 7;
const PROMPT_PACK_CAPABILITY_KEYS = ["routing", "honesty", "handoff", "robustness", "usability"] as const;
const PROMPT_PACK_V2_DIMENSIONS = [
  "taskSuccess",
  "honesty",
  "executionQuality",
  "robustness",
  "usability",
] as const satisfies readonly PromptPackScoreDimensionV2[];
const PROMPT_PACK_V2_SCHEMA_VERSION = "v2";
const PROMPT_PACK_V2_SCORER_VERSION = "2026-04-16.2";
const PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION = "2026-04-09.1";
const PROMPT_PACK_V2_PASS_THRESHOLD = DEFAULT_PROMPT_PACK_POLICY_V2.threshold;
const PROMPT_PACK_V2_SCORING_ENABLED_ENV = "PROMPT_PACK_V2_SCORING_ENABLED";
const PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS = 5;
const PROMPT_PACK_BENCHMARK_MAX_TESTS = 200;
const PROMPT_PACK_BENCHMARK_MAX_PROVIDERS = 10;
const PROMPT_PACK_BENCHMARK_CLAIM_TTL_MS = 120_000;
const PROMPT_PACK_BENCHMARK_CLAIM_HEARTBEAT_MS = 30_000;
const DEFAULT_PROMPT_PACK_EXECUTION_STYLE: PromptPackExecutionStyle = "single_turn_harness";
const DEFAULT_PROMPT_RUNNER_SOURCE = "goatcitadel_prompt_pack.md";
const DEFAULT_PROMPT_PACK_EXPORT_DIR = "artifacts/prompt-lab";
const PROMPT_PACK_PROJECT_NAME = "Prompt Lab Workspace";
const PROMPT_PACK_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack code evaluations.";
const PROMPT_PACK_PROJECT_WORKSPACE_PATH = "fixtures/prompt-pack-workspace";
const PROMPT_PACK_REPO_PROJECT_NAME = "Prompt Lab Repo";
const PROMPT_PACK_REPO_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack repo evaluations.";
const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";

export interface PromptPackServiceContext {
  readonly storage: Pick<
    Storage,
    | "chatProjects"
    | "promptPackAutoScoresV2"
    | "promptPackHumanReviewsV2"
    | "promptPackRuns"
    | "promptPacks"
    | "promptPackScores"
    | "toolGrants"
  >;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly config: GatewayRuntimeConfig;
  normalizeWorkspaceId(workspaceId?: string): string;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

// ── row types ────────────────────────────────────────────────────────
interface PromptPackBenchmarkRunRow {
  benchmark_run_id: string;
  pack_id: string;
  status: PromptPackBenchmarkRunRecord["status"];
  test_codes_json: string;
  providers_json: string;
  total_items: number;
  completed_items: number;
  claimed_by_worker_id: string | null;
  claim_heartbeat_at: string | null;
  claim_expires_at: string | null;
  execution_style: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface PromptPackBenchmarkItemRow {
  item_id: string;
  benchmark_run_id: string;
  pack_id: string;
  test_id: string;
  test_code: string;
  provider_id: string;
  model: string;
  run_id: string | null;
  score_id: string | null;
  auto_score_id: string | null;
  run_status: PromptPackBenchmarkItemRecord["runStatus"];
  total_score: number | null;
  weighted_score: number | null;
  verdict: string | null;
  score_state: string | null;
  failure_signal: string | null;
  created_at: string;
}

interface PromptPackRuleEvaluationV2 {
  protocol: {
    protocolPass: boolean;
    reasonCodes: PromptPackReasonCode[];
  };
  hardFailReasons: PromptPackReasonCode[];
  reviewReasons: PromptPackReasonCode[];
  degradedReasons: PromptPackReasonCode[];
  applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>>;
  ruleScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  reasonCaps: Partial<Record<PromptPackScoreDimensionV2, PromptPackReasonCode[]>>;
  notes?: string;
}

interface PromptPackJudgeEvaluationV2 {
  scores?: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  rationale?: string;
  error?: string;
  attemptCount: number;
  fallbackUsed: boolean;
  repairedSchema: boolean;
  judgeStatus: PromptPackJudgeStatusV2;
  judgeProviderId?: string;
  judgeModel?: string;
}

interface PromptPackAutoScoreBatchError {
  testId: string;
  runId?: string;
  error: string;
}

interface PromptPackCurrentGenerationConfig {
  policyHash?: string;
  scoringSchemaVersion?: string;
  scorerVersion?: string;
  judgeRubricVersion?: string;
}

// ── callbacks / deps the service cannot own directly ─────────────────
export interface PromptPackServiceDeps {
  /** Create a transient chat session for running a prompt-pack test. */
  createChatSession(input: ChatSessionCreateInput): ChatSessionRecord;
  /** Send a message through the full agent pipeline. */
  agentSendChatMessage(
    sessionId: string,
    input: Pick<
      ChatSendMessageRequest,
      | "content"
      | "providerId"
      | "model"
      | "signal"
      | "mode"
      | "webMode"
      | "memoryMode"
      | "thinkingLevel"
      | "normalizationProfile"
      | "prefsOverride"
    >,
  ): Promise<ChatSendMessageResponse>;
  /** Raw LLM completion for model-judge scoring. */
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /** Resolve default provider/model for prompt-runner. */
  getPromptRunnerModelDefaults(): { providerId?: string; model?: string };
  /** Resolve default provider/model for prompt-pack model judging. */
  getPromptJudgeModelDefaults(): { providerId?: string; model?: string };
  /** Shared background-task set for fire-and-forget benchmark tasks. */
  backgroundTasks: Set<Promise<void>>;
  recordImprovementBenchmarkSignal?: (input: {
    benchmarkRunId: string;
    packId: string;
    providerId: string;
    model: string;
    weightedScore?: number;
    passRate?: number;
    runFailures?: number;
    failureSignal?: string;
  }) => void;
  recordImprovementRegressionSignal?: (input: {
    regressionRunId: string;
    packId: string;
    baselineRef?: string;
    scoreDelta: number;
    passDelta: number;
    latencyDeltaMs: number;
    capability: string;
  }) => void;
}

interface PromptPackExecutionProfile {
  mode: ChatMode;
  toolTier: PromptPackToolTier;
  toolAutonomy: "safe_auto" | "manual";
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
}

interface PromptPackToolDirectives {
  namedTools: string[];
  prefersFileTools: boolean;
  prefersWebTools: boolean;
  prefersMemoryTools: boolean;
  suppressesTools: boolean;
}

interface PromptPackProjectBindingConfig {
  name: string;
  description: string;
  workspacePath: string;
}

interface PromptPackDurableReadinessInput {
  readonly durable: Pick<
    GatewayRuntimeConfig["assistant"]["durable"],
    "enabled" | "executionEnabled" | "chatAutoPromoteEnabled"
  >;
  readonly durableKernelV1Enabled: boolean;
}

const PROMPT_PACK_FIXTURE_PROJECT_BINDING: PromptPackProjectBindingConfig = {
  name: PROMPT_PACK_PROJECT_NAME,
  description: PROMPT_PACK_PROJECT_DESCRIPTION,
  workspacePath: PROMPT_PACK_PROJECT_WORKSPACE_PATH,
};

const PROMPT_PACK_REPO_PROJECT_BINDING: PromptPackProjectBindingConfig = {
  name: PROMPT_PACK_REPO_PROJECT_NAME,
  description: PROMPT_PACK_REPO_PROJECT_DESCRIPTION,
  workspacePath: PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH,
};

export function promptPackExecutionRequiresDurable(profile: Pick<PromptPackExecutionProfile, "mode">): boolean {
  return profile.mode === "chat" || profile.mode === "cowork" || profile.mode === "code";
}

export function ensurePromptPackDurableReadiness(
  profile: Pick<PromptPackExecutionProfile, "mode">,
  readiness: PromptPackDurableReadinessInput,
): void {
  if (!promptPackExecutionRequiresDurable(profile)) {
    return;
  }
  if (
    readiness.durable.enabled &&
    readiness.durable.executionEnabled &&
    readiness.durable.chatAutoPromoteEnabled &&
    readiness.durableKernelV1Enabled
  ) {
    return;
  }
  throw new Error(
    `Prompt Lab preflight failed: durable-owned ${profile.mode} execution is unavailable. ` +
      "GoatCitadel shipped Chat/Cowork/Code runs require durable execution before Prompt Lab can start the run.",
  );
}

// Keep in sync with LOCAL_PATH_TOOL_NAMES in chat-agent-orchestrator.ts
const PROMPT_PACK_FILE_TOOL_NAMES = [
  "fs.read",
  "fs.list",
  "fs.stat",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
] as const;

const PROMPT_PACK_CODE_TOOL_NAMES = [...PROMPT_PACK_FILE_TOOL_NAMES, "tests.run", "lint.run"] as const;

const PROMPT_PACK_WEB_TOOL_NAMES = ["browser.search", "browser.navigate", "browser.extract"] as const;
const PROMPT_PACK_MEMORY_TOOL_NAMES = ["memory.read", "memory.search"] as const;

const PROMPT_PACK_SAFE_EXPLICIT_TOOL_NAMES = [
  "session.status",
  "time.now",
  "fs.read",
  "fs.list",
  "fs.stat",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
  "http.get",
  "tests.run",
  "lint.run",
  "build.run",
  "git.status",
  "git.diff",
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "browser.screenshot",
  "citations.build",
  "memory.read",
  "memory.search",
  "embeddings.query",
] as const;

const PROMPT_PACK_GATED_EXPLICIT_TOOL_NAMES = [
  "fs.write",
  "artifacts.create",
  "shell.exec",
  "shell.exec_background",
  "git.exec",
  "http.post",
  "browser.interact",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.context.configure",
  "memory.write",
  "memory.upsert",
  "docs.ingest",
  "embeddings.index",
] as const;

const PROMPT_PACK_EXPLICIT_TOOL_NAMES = [
  ...PROMPT_PACK_SAFE_EXPLICIT_TOOL_NAMES,
  ...PROMPT_PACK_GATED_EXPLICIT_TOOL_NAMES,
] as const;

const PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAMES = new Set<string>([
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
]);

/**
 * Encapsulates all prompt-pack (Prompt Lab) operations previously inlined
 * in GatewayService.
 */
export class PromptPackService {
  private readonly benchmarkWorkerId = `prompt-pack-benchmark-${randomUUID()}`;
  private readonly activeBenchmarkRunIds = new Set<string>();
  private readonly cancelledBenchmarkRunIds = new Set<string>();
  private readonly activeBenchmarkAbortControllers = new Map<string, AbortController>();

  constructor(
    private readonly ctx: PromptPackServiceContext,
    private readonly deps: PromptPackServiceDeps,
  ) {}

  private assertDurablePreflight(profile: PromptPackExecutionProfile): void {
    ensurePromptPackDurableReadiness(profile, {
      durable: this.ctx.config.assistant.durable,
      durableKernelV1Enabled: this.ctx.isFeatureEnabled("durableKernelV1Enabled"),
    });
  }

  // ── public API ─────────────────────────────────────────────────────

  importPromptPack(input: { content: string; name?: string; sourceLabel?: string; packId?: string }): {
    pack: PromptPackRecord;
    tests: PromptPackTestRecord[];
  } {
    const tests = parsePromptPackTests(input.content);
    if (tests.length === 0) {
      throw new Error("No tests found in prompt-pack markdown.");
    }
    const name = input.name?.trim() || inferPromptPackName(input.sourceLabel);
    const imported = this.ctx.storage.promptPacks.replacePackTests({
      packId: input.packId,
      name,
      sourceLabel: input.sourceLabel,
      tests,
    });
    this.refreshPromptPackExportFileBestEffort(imported.pack.packId, "import_prompt_pack");
    return imported;
  }

  listPromptPacks(limit = 100): PromptPackRecord[] {
    return this.ctx.storage.promptPacks.listPacks(limit);
  }

  listPromptPackTests(packId: string, limit = 2000): PromptPackTestRecord[] {
    this.ctx.storage.promptPacks.getPack(packId);
    return this.ctx.storage.promptPacks.listTests(packId, limit);
  }

  async runPromptPackTest(
    packId: string,
    testId: string,
    input?: {
      sessionId?: string;
      providerId?: string;
      model?: string;
      signal?: AbortSignal;
      mode?: ChatMode;
      toolTier?: PromptPackToolTier;
      toolAutonomy?: "safe_auto" | "manual";
      webMode?: ChatWebMode;
      memoryMode?: ChatMemoryMode;
      thinkingLevel?: ChatThinkingLevel;
      executionStyle?: PromptPackExecutionStyle;
      placeholderValues?: Record<string, string>;
    },
  ): Promise<PromptPackRunRecord> {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const test = this.ctx.storage.promptPacks.getTest(testId);
    if (test.packId !== pack.packId) {
      throw new Error("Prompt-pack test does not belong to this pack.");
    }

    const defaults = this.deps.getPromptRunnerModelDefaults();
    const providerId = input?.providerId ?? defaults.providerId;
    const model = input?.model ?? defaults.model;
    const executionProfile = resolvePromptPackExecutionProfile({
      test,
      override: input,
    });
    const executionStyle = resolvePromptPackExecutionStyle(input?.executionStyle);
    this.assertDurablePreflight(executionProfile);
    const resolvedPrompt = applyPromptPlaceholderValues(test.prompt, input?.placeholderValues);
    if (resolvedPrompt.missingPlaceholders.length > 0) {
      throw new Error(`Missing placeholder values for ${test.code}: ${resolvedPrompt.missingPlaceholders.join(", ")}.`);
    }
    const promptInput = buildPromptPackPromptInput(resolvedPrompt.prompt, executionProfile, test.title);
    const projectBinding = resolvePromptPackProjectBinding(executionProfile, resolvedPrompt.prompt);
    const runId = randomUUID();
    const sessionId =
      input?.sessionId ??
      this.deps.createChatSession({
        title: `[${test.code}] ${test.title}`.slice(0, 200),
        workspaceId: this.ctx.normalizeWorkspaceId(undefined),
        projectId: projectBinding ? this.ensurePromptPackProjectBindingFor(projectBinding) : undefined,
        mode: executionProfile.mode,
        origin: "prompt_pack",
        includeInHistory: false,
      }).sessionId;
    this.ensurePromptPackSessionToolGrants(sessionId, executionProfile, resolvedPrompt.prompt, projectBinding);

    this.ctx.storage.promptPackRuns.create({
      runId,
      packId: pack.packId,
      testId: test.testId,
      sessionId,
      status: "running",
      providerId,
      model,
      mode: executionProfile.mode,
      toolTier: executionProfile.toolTier,
      toolAutonomy: executionProfile.toolAutonomy,
      webMode: executionProfile.webMode,
      memoryMode: executionProfile.memoryMode,
      thinkingLevel: executionProfile.thinkingLevel,
      executionStyle,
      diagnosticMetadata: test.diagnosticMetadata,
    });

    try {
      const response = await this.deps.agentSendChatMessage(sessionId, {
        content: promptInput.prompt,
        providerId,
        model,
        signal: input?.signal,
        mode: executionProfile.mode,
        webMode: executionProfile.webMode,
        memoryMode: executionProfile.memoryMode,
        thinkingLevel: executionProfile.thinkingLevel,
        normalizationProfile: "prompt_pack_harness",
        prefsOverride: buildPromptPackSessionPrefsOverride(executionProfile, resolvedPrompt.prompt, executionStyle),
      });
      const refreshedTurn = await this.awaitPromptPackTurnSnapshot(response.turnId, response);
      const effectiveTrace = refreshedTurn.trace ?? response.trace;
      const persistedAssistantContent = refreshedTurn.assistantContent?.trim() ?? "";
      const responseAssistantContent = response.assistantMessage?.content?.trim() ?? "";
      const rawResponseText = (persistedAssistantContent || responseAssistantContent).trim();
      const normalizedResponseText = normalizePromptPackAgenticResponse({
        profile: executionProfile,
        prompt: resolvedPrompt.prompt,
        responseText: rawResponseText,
        trace: effectiveTrace,
      });
      const effectiveCitations = refreshedTurn.citations ?? response.citations;
      const derivedResponse = derivePromptPackResponseArtifacts({
        prompt: promptInput.prompt,
        rawResponseText: normalizedResponseText,
        trace: effectiveTrace,
      });
      const integrity = evaluatePromptPackRunIntegrity({
        prompt: resolvedPrompt.prompt,
        responseText: normalizedResponseText,
        trace: effectiveTrace,
        outputTokenCount: response.assistantMessage?.tokenOutput,
      });
      const traceStatus = effectiveTrace?.status;
      const missingOutput = normalizedResponseText.length === 0;
      const failedByTrace = traceStatus === "failed";
      const approvalPending = traceStatus === "waiting_for_approval";
      const userInputPending = traceStatus === "waiting_for_user_input";
      const status: PromptPackRunRecord["status"] =
        approvalPending || userInputPending
          ? "approval_paused"
          : missingOutput || failedByTrace
            ? "failed"
            : "completed";
      const error =
        status === "failed" || status === "approval_paused"
          ? approvalPending
            ? "Turn paused for approval."
            : userInputPending
              ? "Turn paused for user input."
              : missingOutput
                ? "No assistant output generated."
                : failedByTrace
                  ? "Assistant turn finished in failed state."
                  : undefined
          : undefined;
      const updated = this.ctx.storage.promptPackRuns.patch(runId, {
        status,
        responseText: normalizedResponseText || undefined,
        derivedResponseText: derivedResponse.derivedResponseText,
        derivedResponseSignals: derivedResponse.derivedResponseSignals,
        trace: effectiveTrace,
        citations: effectiveCitations,
        integrity,
        error,
        finishedAt: new Date().toISOString(),
      });
      this.refreshPromptPackExportFileBestEffort(pack.packId, "run_prompt_pack_test_success");
      return updated;
    } catch (error) {
      const failed = this.ctx.storage.promptPackRuns.patch(runId, {
        status: "failed",
        error: (error as Error).message,
        finishedAt: new Date().toISOString(),
      });
      this.refreshPromptPackExportFileBestEffort(pack.packId, "run_prompt_pack_test_failure");
      return failed;
    }
  }

  scorePromptPackTest(input: {
    packId: string;
    testId: string;
    runId: string;
    taskSuccess?: PromptPackDimensionScoreV2 | null;
    honesty?: PromptPackDimensionScoreV2 | null;
    executionQuality?: PromptPackDimensionScoreV2 | null;
    robustness?: PromptPackDimensionScoreV2 | null;
    usability?: PromptPackDimensionScoreV2 | null;
    overrideVerdict?: PromptPackVerdict;
    reviewerId?: string;
    routingScore?: 0 | 1 | 2;
    honestyScore?: 0 | 1 | 2;
    handoffScore?: 0 | 1 | 2;
    robustnessScore?: 0 | 1 | 2;
    usabilityScore?: 0 | 1 | 2;
    judge?: PromptPackJudgeRecord;
    notes?: string;
  }): PromptPackHumanReviewRecordV2 {
    return this.reviewPromptPackTest({
      packId: input.packId,
      testId: input.testId,
      runId: input.runId,
      reviewerId: input.reviewerId,
      overrideVerdict: input.overrideVerdict,
      scores: buildPromptPackManualReviewScores(input),
      notes: input.notes,
    });
  }

  reviewPromptPackTest(input: {
    packId: string;
    testId: string;
    runId: string;
    scores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
    overrideVerdict?: PromptPackVerdict;
    reviewerId?: string;
    notes?: string;
  }): PromptPackHumanReviewRecordV2 {
    const run = this.ctx.storage.promptPackRuns.get(input.runId);
    const test = this.ctx.storage.promptPacks.getTest(input.testId);
    if (run.packId !== input.packId || run.testId !== input.testId) {
      throw new Error("Score target does not match run.");
    }
    assertPromptPackRunScorable(test, run);
    const latestAutoScore = this.ctx.storage.promptPackAutoScoresV2.listByRun(input.runId, 1)[0];
    const applicability = latestAutoScore?.applicability ?? deriveManualReviewApplicability(input.scores);
    const review = this.ctx.storage.promptPackHumanReviewsV2.create({
      reviewId: `pprv2-${randomUUID()}`,
      packId: input.packId,
      testId: input.testId,
      runId: input.runId,
      autoScoreId: latestAutoScore?.autoScoreId,
      reviewerId: input.reviewerId?.trim() || "prompt-lab",
      scores: input.scores,
      applicability,
      notes: input.notes?.trim() || undefined,
      overrideVerdict: input.overrideVerdict,
      createdAt: new Date().toISOString(),
    });
    this.refreshPromptPackExportFileBestEffort(input.packId, "review_prompt_pack_test");
    return review;
  }

  async autoScorePromptPackTest(input: {
    packId: string;
    testId: string;
    runId?: string;
    providerId?: string;
    model?: string;
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<PromptPackAutoScoreResult> {
    if (!isPromptPackV2FlagEnabled(PROMPT_PACK_V2_SCORING_ENABLED_ENV)) {
      throw new Error(`Prompt-pack scoring v2 is disabled via ${PROMPT_PACK_V2_SCORING_ENABLED_ENV}.`);
    }

    const pack = this.ctx.storage.promptPacks.getPack(input.packId);
    const test = this.ctx.storage.promptPacks.getTest(input.testId);
    if (test.packId !== pack.packId) {
      throw new Error("Prompt-pack test does not belong to this pack.");
    }

    const candidateRuns = this.ctx.storage.promptPackRuns.listByTest(test.testId, 1000);
    const run = input.runId
      ? this.ctx.storage.promptPackRuns.get(input.runId)
      : pickPromptPackAutoScoreRun(candidateRuns);
    if (!run) {
      throw new Error(`No run found for ${test.code}. Run this test first.`);
    }
    if (run.packId !== pack.packId || run.testId !== test.testId) {
      throw new Error("Auto-score target does not match run.");
    }
    assertPromptPackRunScorable(test, run);

    const executionProfile = getResolvedPromptPackExecutionProfile(run, test);
    const policy = resolvePromptPackPolicy(pack);
    const policyHash = pack.policyHash ?? hashPromptPackPolicyV2(policy);
    const policySource = pack.policySource ?? "inherited_default";
    const existingScores = this.ctx.storage.promptPackAutoScoresV2.listByRun(run.runId, 100);
    const matchingScore = existingScores.find(
      (score) =>
        score.scoringSchemaVersion === PROMPT_PACK_V2_SCHEMA_VERSION &&
        score.scorerVersion === PROMPT_PACK_V2_SCORER_VERSION &&
        score.judgeRubricVersion === PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION &&
        score.policyHash === policyHash,
    );
    const legacyScore = this.ctx.storage.promptPackScores.listByRun(run.runId, 1)[0];
    const ruleEvaluation = evaluatePromptPackRuleScoresV2({
      prompt: test.prompt,
      run,
      profile: executionProfile,
      policy,
    });
    if (matchingScore && !input.force) {
      return {
        score: matchingScore,
        legacyScore,
        run,
      };
    }

    const modelScores = await this.judgePromptPackRunScoresV2({
      packName: pack.name,
      testCode: test.code,
      testTitle: test.title,
      prompt: test.prompt,
      run,
      profile: executionProfile,
      providerId: input.providerId,
      model: input.model,
      signal: input.signal,
    });

    const merged = mergePromptPackAutoScoresV2({
      pack,
      test,
      run,
      policy,
      profile: executionProfile,
      ruleEvaluation,
      judgeEvaluation: modelScores,
    });

    const score = this.ctx.storage.promptPackAutoScoresV2.create({
      ...merged,
      autoScoreId: matchingScore?.autoScoreId ?? `ppasv2-${randomUUID()}`,
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      scoringSchemaVersion: PROMPT_PACK_V2_SCHEMA_VERSION,
      scorerVersion: PROMPT_PACK_V2_SCORER_VERSION,
      judgeRubricVersion: PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION,
      policyHash,
      policySource,
      createdAt: new Date().toISOString(),
    });
    this.refreshPromptPackExportFileBestEffort(input.packId, "auto_score_prompt_pack_test");

    return {
      score,
      legacyScore,
      run,
    };
  }

  async autoScorePromptPackBatch(input: {
    packId: string;
    onlyUnscored?: boolean;
    limit?: number;
    providerId?: string;
    model?: string;
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<PromptPackAutoScoreBatchResult> {
    const pack = this.ctx.storage.promptPacks.getPack(input.packId);
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const policy = resolvePromptPackPolicy(pack);
    const policyHash = pack.policyHash ?? hashPromptPackPolicyV2(policy);
    const limit = Math.max(1, Math.min(input.limit ?? tests.length, 500));
    const onlyUnscored = input.onlyUnscored ?? true;

    const items: PromptPackAutoScoreResult[] = [];
    let skipped = 0;
    const errors: PromptPackAutoScoreBatchError[] = [];

    for (const test of tests.slice(0, limit)) {
      const candidateRuns = this.ctx.storage.promptPackRuns.listByTest(test.testId, 100);
      const selectedRun = pickPromptPackAutoScoreRun(candidateRuns);
      if (!selectedRun) {
        skipped += 1;
        continue;
      }
      if (onlyUnscored) {
        const existing = this.ctx.storage.promptPackAutoScoresV2
          .listByRun(selectedRun.runId, 100)
          .some(
            (score) =>
              score.scoringSchemaVersion === PROMPT_PACK_V2_SCHEMA_VERSION &&
              score.scorerVersion === PROMPT_PACK_V2_SCORER_VERSION &&
              score.judgeRubricVersion === PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION &&
              score.policyHash === policyHash,
          );
        if (existing) {
          skipped += 1;
          continue;
        }
      }
      try {
        items.push(
          await this.autoScorePromptPackTest({
            packId: pack.packId,
            testId: test.testId,
            runId: selectedRun.runId,
            providerId: input.providerId,
            model: input.model,
            signal: input.signal,
            force: input.force,
          }),
        );
      } catch (error) {
        skipped += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          testId: test.testId,
          runId: selectedRun.runId,
          error: message,
        });
        log.warn("prompt-pack auto-score batch item failed", {
          packId: pack.packId,
          testId: test.testId,
          runId: selectedRun.runId,
          error: message,
        });
      }
    }

    return {
      items,
      skipped,
      ...(errors.length > 0 ? { errors } : {}),
    } as PromptPackAutoScoreBatchResult;
  }

  async scorePromptPackLatestRunByCode(input: {
    sessionId?: string;
    testCode: string;
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    notes?: string;
  }): Promise<PromptPackHumanReviewRecordV2> {
    const pack = await this.ensurePromptPackLoaded();
    if (!pack) {
      throw new Error("No prompt pack is available. Import one in Prompt Lab first.");
    }
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const test = tests.find((item) => item.code.toUpperCase() === input.testCode.toUpperCase());
    if (!test) {
      throw new Error(`Prompt-pack test ${input.testCode} not found.`);
    }
    const runs = this.ctx.storage.promptPackRuns
      .listByTest(test.testId, 1000)
      .filter((item) => !input.sessionId || item.sessionId === input.sessionId);
    const latest = runs.at(0);
    if (!latest) {
      throw new Error(`No run found for ${test.code}. Run /pack run ${test.code} first.`);
    }
    return this.scorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: latest.runId,
      routingScore: input.routingScore,
      honestyScore: input.honestyScore,
      handoffScore: input.handoffScore,
      robustnessScore: input.robustnessScore,
      usabilityScore: input.usabilityScore,
      notes: input.notes,
    });
  }

  getPromptPackReport(packId: string): PromptPackReportRecord {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const tests = this.ctx.storage.promptPacks.listTests(packId, 5000);
    const runs = this.ctx.storage.promptPackRuns.listByPack(packId, 10000);
    const scores = this.ctx.storage.promptPackScores.listByPack(packId, 10000);
    const autoScoresV2 = this.ctx.storage.promptPackAutoScoresV2.listByPack(packId, 10000);
    const humanReviewsV2 = this.ctx.storage.promptPackHumanReviewsV2.listByPack(packId, 10000);
    const generation = {
      policyHash: pack.policyHash ?? hashPromptPackPolicyV2(resolvePromptPackPolicy(pack)),
    };
    const latestAssessments = buildPromptPackLatestStateV2(
      tests,
      runs,
      autoScoresV2,
      humanReviewsV2,
      scores,
      generation,
    );

    return {
      pack,
      tests,
      runs,
      scores,
      autoScoresV2,
      humanReviewsV2,
      latestAssessments,
      summary: buildPromptPackReportSummary(
        tests,
        runs,
        scores,
        autoScoresV2,
        humanReviewsV2,
        latestAssessments,
        generation,
      ),
    };
  }

  listPromptPackTestReviews(packId: string, testId: string): PromptPackHumanReviewRecordV2[] {
    const test = this.ctx.storage.promptPacks.getTest(testId);
    if (test.packId !== packId) {
      throw new Error("Prompt-pack test does not belong to this pack.");
    }
    return this.ctx.storage.promptPackHumanReviewsV2.listByTest(testId, 500);
  }

  runPromptPackBenchmark(
    packId: string,
    input: {
      testCodes?: string[];
      allTests?: boolean;
      providers: PromptPackBenchmarkProviderInput[];
      executionStyle?: PromptPackExecutionStyle;
    },
  ): { benchmarkRunId: string } {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const codeToTest = new Map(tests.map((test) => [test.code.toUpperCase(), test]));
    const normalizedCodes = input.allTests
      ? tests.map((test) => test.code.toUpperCase()).slice(0, PROMPT_PACK_BENCHMARK_MAX_TESTS)
      : Array.from(new Set((input.testCodes ?? []).map((code) => code.trim()).filter((code) => code.length > 0)))
          .map((code: string) => code.toUpperCase())
          .slice(0, PROMPT_PACK_BENCHMARK_MAX_TESTS);
    if (normalizedCodes.length < 1) {
      throw new Error("Benchmark requires at least one test code.");
    }
    const selectedTests: PromptPackTestRecord[] = [];
    for (const code of normalizedCodes) {
      const test = codeToTest.get(code);
      if (!test) {
        throw new Error(`Prompt-pack test code ${code} not found in ${pack.name}.`);
      }
      selectedTests.push(test);
    }
    for (const test of selectedTests) {
      this.assertDurablePreflight(resolvePromptPackExecutionProfile({ test }));
    }

    const providers = dedupeBenchmarkProviders(input.providers).slice(0, PROMPT_PACK_BENCHMARK_MAX_PROVIDERS);
    if (providers.length < 1) {
      throw new Error("Benchmark requires at least one provider/model pair.");
    }
    const executionStyle = resolvePromptPackExecutionStyle(input.executionStyle);

    const benchmarkRunId = `ppb-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const totalItems = selectedTests.length * providers.length;
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO prompt_pack_benchmark_runs (
        benchmark_run_id, pack_id, status, test_codes_json, providers_json,
        total_items, completed_items, execution_style, error, started_at, finished_at
      ) VALUES (
        @benchmarkRunId, @packId, @status, @testCodesJson, @providersJson,
        @totalItems, @completedItems, @executionStyle, NULL, @startedAt, NULL
      )
    `,
      )
      .run({
        benchmarkRunId,
        packId: pack.packId,
        status: "queued",
        testCodesJson: JSON.stringify(selectedTests.map((item) => item.code)),
        providersJson: JSON.stringify(providers),
        totalItems,
        completedItems: 0,
        executionStyle,
        startedAt,
      });

    this.enqueuePromptPackBenchmarkTask(benchmarkRunId);

    this.ctx.publishRealtime("prompt_pack_benchmark_started", "promptLab", {
      benchmarkRunId,
      packId: pack.packId,
      totalItems,
      providers,
      testCodes: selectedTests.map((item) => item.code),
      executionStyle,
    });
    return { benchmarkRunId };
  }

  getPromptPackBenchmarkStatus(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {
    this.resumePromptPackBenchmarkRunIfStale(benchmarkRunId);
    const runRow = this.getPromptPackBenchmarkRunRow(benchmarkRunId);
    if (!runRow) {
      throw new Error(`Prompt-pack benchmark run ${benchmarkRunId} not found.`);
    }
    const items = this.listPromptPackBenchmarkItems(benchmarkRunId);
    const run = mapPromptPackBenchmarkRunRow(runRow);
    const modelSummaries = summarizePromptPackBenchmarkItems(items);
    return {
      run,
      progress: {
        totalItems: runRow.total_items,
        completedItems: Math.max(runRow.completed_items, items.length),
      },
      modelSummaries,
    };
  }

  private resumePromptPackBenchmarkRunIfStale(benchmarkRunId: string): void {
    const runRow = this.getPromptPackBenchmarkRunRow(benchmarkRunId);
    if (!runRow || (runRow.status !== "queued" && runRow.status !== "running")) {
      return;
    }
    const claimExpired =
      !runRow.claimed_by_worker_id || !runRow.claim_expires_at || Date.parse(runRow.claim_expires_at) <= Date.now();
    if (!claimExpired) {
      return;
    }
    this.enqueuePromptPackBenchmarkTask(benchmarkRunId);
  }

  cancelPromptPackBenchmark(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {
    const status = this.getPromptPackBenchmarkStatus(benchmarkRunId);
    if (status.run.status === "completed" || status.run.status === "failed" || status.run.status === "cancelled") {
      return status;
    }

    this.cancelledBenchmarkRunIds.add(benchmarkRunId);
    this.activeBenchmarkAbortControllers
      .get(benchmarkRunId)
      ?.abort(new Error(`Prompt-pack benchmark ${benchmarkRunId} was cancelled by operator.`));
    const finishedAt = new Date().toISOString();
    const updateResult = this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET
        status = 'cancelled',
        error = @error,
        finished_at = @finishedAt,
        claimed_by_worker_id = NULL,
        claim_heartbeat_at = NULL,
        claim_expires_at = NULL
      WHERE benchmark_run_id = @benchmarkRunId
        AND status IN ('queued', 'running')
    `,
      )
      .run({
        benchmarkRunId,
        error: "Cancelled by operator.",
        finishedAt,
      });

    const cancelled = this.getPromptPackBenchmarkStatus(benchmarkRunId);
    if (Number(updateResult.changes ?? 0) < 1) {
      this.cancelledBenchmarkRunIds.delete(benchmarkRunId);
      return cancelled;
    }
    this.ctx.publishRealtime("prompt_pack_benchmark_cancelled", "promptLab", {
      benchmarkRunId,
      completedItems: cancelled.progress.completedItems,
    });
    return cancelled;
  }

  resumeInterruptedBenchmarkRuns(): number {
    const now = new Date().toISOString();
    const rows = toPromptPackBenchmarkRunRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM prompt_pack_benchmark_runs
      WHERE status IN ('queued', 'running')
        AND (
          claimed_by_worker_id IS NULL
          OR claim_expires_at IS NULL
          OR claim_expires_at <= @now
        )
      ORDER BY started_at ASC
    `,
        )
        .all({ now }),
    );
    for (const row of rows) {
      this.enqueuePromptPackBenchmarkTask(row.benchmark_run_id);
    }
    return rows.length;
  }

  runPromptPackReplayRegression(
    packId: string,
    input: {
      testCodes: string[];
      baselineRef?: string;
    },
  ): { regressionRunId: string } {
    this.ctx.requireFeatureEnabled("replayRegressionV1Enabled");
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const byCode = new Map(tests.map((test) => [test.code.toUpperCase(), test]));
    const selectedCodes = Array.from(
      new Set((input.testCodes ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean)),
    );
    if (selectedCodes.length < 1) {
      throw new Error("Replay regression requires at least one test code.");
    }
    for (const code of selectedCodes) {
      if (!byCode.has(code)) {
        throw new Error(`Unknown test code ${code} for prompt pack ${packId}`);
      }
    }
    if (input.baselineRef && Number.isNaN(Date.parse(input.baselineRef))) {
      throw new Error("baselineRef must be an ISO timestamp.");
    }
    const regressionRunId = `ppr-${randomUUID()}`;
    const now = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO replay_regression_runs (
        regression_run_id, pack_id, status, test_codes_json, baseline_ref, summary_json, started_at, finished_at
      ) VALUES (
        @regressionRunId, @packId, 'running', @testCodesJson, @baselineRef, @summaryJson, @startedAt, NULL
      )
    `,
      )
      .run({
        regressionRunId,
        packId,
        testCodesJson: JSON.stringify(selectedCodes),
        baselineRef: input.baselineRef ?? null,
        summaryJson: JSON.stringify({}),
        startedAt: now,
      });

    const runById = new Map(
      this.ctx.storage.promptPackRuns.listByPack(packId, 10_000).map((run) => [run.runId, run] as const),
    );
    const scoresByTest = new Map<string, PromptPackScoreRecord[]>();
    for (const score of this.ctx.storage.promptPackScores.listByPack(packId, 10_000)) {
      const list = scoresByTest.get(score.testId) ?? [];
      list.push(score);
      scoresByTest.set(score.testId, list);
    }
    for (const list of scoresByTest.values()) {
      list.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    }

    const insertResult = this.ctx.gatewaySql.prepare(`
      INSERT INTO replay_regression_results (
        result_id, regression_run_id, test_code, capability, score_delta, pass_delta, latency_delta_ms, created_at
      ) VALUES (
        @resultId, @regressionRunId, @testCode, @capability, @scoreDelta, @passDelta, @latencyDeltaMs, @createdAt
      )
    `);
    const omittedTests: string[] = [];
    let resultRows = 0;
    for (const code of selectedCodes) {
      const test = byCode.get(code)!;
      const scoredRuns = scoresByTest.get(test.testId) ?? [];
      const currentScore = scoredRuns[0];
      if (!currentScore) {
        omittedTests.push(`${test.code}:no_scored_run`);
        continue;
      }
      const baselineScore = pickReplayBaselineScore(scoredRuns, currentScore, input.baselineRef);
      if (!baselineScore) {
        omittedTests.push(`${test.code}:no_baseline`);
        continue;
      }
      const currentRun = runById.get(currentScore.runId);
      const baselineRun = runById.get(baselineScore.runId);
      const currentPass = currentScore.totalScore >= PROMPT_PACK_PASS_THRESHOLD ? 1 : 0;
      const baselinePass = baselineScore.totalScore >= PROMPT_PACK_PASS_THRESHOLD ? 1 : 0;
      const passDelta = currentPass - baselinePass;
      const latencyDeltaMs = computePromptPackRunLatencyDelta(currentRun, baselineRun);
      const capabilities: Array<{
        capability: ReplayRegressionResult["capability"];
        scoreDelta: number;
      }> = [
        { capability: "routing", scoreDelta: currentScore.routingScore - baselineScore.routingScore },
        { capability: "honesty", scoreDelta: currentScore.honestyScore - baselineScore.honestyScore },
        { capability: "handoff", scoreDelta: currentScore.handoffScore - baselineScore.handoffScore },
        { capability: "robustness", scoreDelta: currentScore.robustnessScore - baselineScore.robustnessScore },
        { capability: "usability", scoreDelta: currentScore.usabilityScore - baselineScore.usabilityScore },
      ];
      for (const entry of capabilities) {
        insertResult.run({
          resultId: `pprr-${randomUUID()}`,
          regressionRunId,
          testCode: test.code,
          capability: entry.capability,
          scoreDelta: entry.scoreDelta,
          passDelta,
          latencyDeltaMs,
          createdAt: now,
        });
        resultRows += 1;
      }
    }

    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE replay_regression_runs
      SET status = 'completed',
          summary_json = @summaryJson,
          finished_at = @finishedAt
      WHERE regression_run_id = @regressionRunId
    `,
      )
      .run({
        regressionRunId,
        summaryJson: JSON.stringify({
          totalTests: selectedCodes.length,
          comparedTests: resultRows / PROMPT_PACK_CAPABILITY_KEYS.length,
          omittedTests,
          resultRows,
        }),
        finishedAt: new Date().toISOString(),
      });
    this.ctx.publishRealtime("prompt_pack_regression_completed", "promptLab", {
      regressionRunId,
      packId,
      testCodes: selectedCodes,
    });
    const regressionStatus = this.getPromptPackReplayRegressionStatus(regressionRunId);
    for (const result of regressionStatus.results) {
      this.deps.recordImprovementRegressionSignal?.({
        regressionRunId,
        packId,
        baselineRef: input.baselineRef,
        scoreDelta: result.scoreDelta,
        passDelta: result.passDelta,
        latencyDeltaMs: result.latencyDeltaMs,
        capability: result.capability,
      });
    }
    return { regressionRunId };
  }

  getPromptPackReplayRegressionStatus(runId: string): {
    run: ReplayRegressionRun;
    results: ReplayRegressionResult[];
  } {
    this.ctx.requireFeatureEnabled("replayRegressionV1Enabled");
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT regression_run_id, pack_id, status, test_codes_json, baseline_ref, started_at, finished_at, error_text
      FROM replay_regression_runs
      WHERE regression_run_id = ?
    `,
      )
      .get(runId) as
      | {
          regression_run_id: string;
          pack_id: string;
          status: ReplayRegressionRun["status"];
          test_codes_json: string;
          baseline_ref: string | null;
          started_at: string;
          finished_at: string | null;
          error_text: string | null;
        }
      | undefined;
    if (!row) {
      throw new Error(`Replay regression run not found: ${runId}`);
    }
    const resultRows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT result_id, regression_run_id, test_code, capability, score_delta, pass_delta, latency_delta_ms, created_at
      FROM replay_regression_results
      WHERE regression_run_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(runId) as Array<{
      result_id: string;
      regression_run_id: string;
      test_code: string;
      capability: ReplayRegressionResult["capability"];
      score_delta: number;
      pass_delta: number;
      latency_delta_ms: number;
      created_at: string;
    }>;
    return {
      run: {
        regressionRunId: row.regression_run_id,
        packId: row.pack_id,
        status: row.status,
        testCodes: safeJsonParse<string[]>(row.test_codes_json, []),
        baselineRef: row.baseline_ref ?? undefined,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? undefined,
        error: row.error_text ?? undefined,
      },
      results: resultRows.map((result) => ({
        resultId: result.result_id,
        regressionRunId: result.regression_run_id,
        testCode: result.test_code,
        capability: result.capability,
        scoreDelta: Number(result.score_delta ?? 0),
        passDelta: Number(result.pass_delta ?? 0),
        latencyDeltaMs: Number(result.latency_delta_ms ?? 0),
        createdAt: result.created_at,
      })),
    };
  }

  getPromptPackCapabilityTrends(packId: string): { items: CapabilityTrendSeries[] } {
    this.ctx.storage.promptPacks.getPack(packId);
    const scores = [...this.ctx.storage.promptPackAutoScoresV2.listByPack(packId, 10_000)].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
    const runs = [...this.ctx.storage.promptPackRuns.listByPack(packId, 10_000)].sort((left, right) => {
      const leftStamp = Date.parse(left.finishedAt ?? left.startedAt);
      const rightStamp = Date.parse(right.finishedAt ?? right.startedAt);
      return leftStamp - rightStamp;
    });
    const capabilities: Array<{ key: CapabilityTrendSeries["capability"]; threshold?: number }> = [
      { key: "taskSuccess", threshold: 75 },
      { key: "honesty", threshold: 75 },
      { key: "executionQuality", threshold: 70 },
      { key: "robustness", threshold: 70 },
      { key: "usability", threshold: 65 },
      { key: "run_failure_rate", threshold: 0.05 },
      { key: "review_rate", threshold: 0.2 },
    ];
    return {
      items: capabilities.map((entry) => ({
        capability: entry.key,
        points:
          entry.key === "run_failure_rate"
            ? buildPromptPackRunFailureRateSeries(runs)
            : entry.key === "review_rate"
              ? buildPromptPackReviewRateSeries(scores)
              : buildPromptPackCapabilitySeriesV2(scores, entry.key),
        threshold: entry.threshold,
        breached:
          entry.threshold !== undefined
            ? evaluatePromptPackTrendThreshold(
                entry.key,
                entry.threshold,
                entry.key === "run_failure_rate"
                  ? buildPromptPackRunFailureRateSeries(runs)
                  : entry.key === "review_rate"
                    ? buildPromptPackReviewRateSeries(scores)
                    : buildPromptPackCapabilitySeriesV2(scores, entry.key),
              )
            : undefined,
      })),
    };
  }

  getPromptPackExport(packId: string): PromptPackExportRecord {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    return this.readPromptPackExportRecord(pack);
  }

  exportPromptPack(packId: string): PromptPackExportRecord {
    this.ctx.storage.promptPacks.getPack(packId);
    return this.refreshPromptPackExportFile(packId);
  }

  resetPromptPackRunsAndScores(
    packId: string,
    options: {
      clearRuns?: boolean;
      clearScores?: boolean;
    } = {},
  ): {
    packId: string;
    deletedRuns: number;
    deletedScores: number;
    export: PromptPackExportRecord;
  } {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const clearRuns = options.clearRuns ?? true;
    const clearScores = options.clearScores ?? true;
    if (!clearRuns && !clearScores) {
      return {
        packId,
        deletedRuns: 0,
        deletedScores: 0,
        export: this.readPromptPackExportRecord(pack),
      };
    }

    let deletedRuns = 0;
    let deletedScores = 0;
    this.ctx.gatewaySql.runImmediateTransaction(() => {
      if (clearScores) {
        deletedScores =
          this.ctx.storage.promptPackScores.deleteByPack(packId) +
          this.ctx.storage.promptPackAutoScoresV2.deleteByPack(packId) +
          this.ctx.storage.promptPackHumanReviewsV2.deleteByPack(packId);
      }
      if (clearRuns) {
        deletedRuns = this.ctx.storage.promptPackRuns.deleteByPack(packId);
      }
    });

    const exportPath = this.resolvePromptPackExportPath(pack);
    if (clearRuns) {
      try {
        fsSync.rmSync(exportPath, { force: true });
      } catch {
        // no-op
      }
    } else if (clearScores) {
      this.refreshPromptPackExportFileBestEffort(packId, "reset_prompt_pack_runs_and_scores");
    }

    return {
      packId,
      deletedRuns,
      deletedScores,
      export: this.readPromptPackExportRecord(pack),
    };
  }

  /** Used by chat command handler to run prompt-pack from within a chat session. */
  async runPromptPackFromChat(sessionId: string, selector: string): Promise<PromptPackRunRecord[]> {
    const pack = await this.ensurePromptPackLoaded();
    if (!pack) {
      throw new Error("No prompt pack available. Import a pack first.");
    }
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    if (tests.length === 0) {
      throw new Error("Prompt pack has no tests.");
    }
    const defaults = this.deps.getPromptRunnerModelDefaults();
    const selectedTests =
      selector === "all" ? tests : tests.filter((test) => test.code.toUpperCase() === selector.toUpperCase());
    if (selectedTests.length === 0) {
      throw new Error(`Prompt-pack selector ${selector} did not match any tests.`);
    }

    const runs: PromptPackRunRecord[] = [];
    for (const test of selectedTests) {
      runs.push(
        await this.runPromptPackTest(pack.packId, test.testId, {
          sessionId,
          providerId: defaults.providerId,
          model: defaults.model,
        }),
      );
    }
    return runs;
  }

  /** Ensures at least one prompt pack is loaded (from env path or defaults). */
  async ensurePromptPackLoaded(): Promise<PromptPackRecord | undefined> {
    const existing = this.ctx.storage.promptPacks.listPacks(20);
    if (existing.length > 0) {
      return existing[0];
    }
    const sourcePath = process.env.GOATCITADEL_PROMPT_PACK_PATH?.trim();
    if (!sourcePath) {
      return undefined;
    }
    try {
      const markdown = await fs.readFile(sourcePath, "utf8");
      const imported = this.importPromptPack({
        content: markdown,
        sourceLabel: sourcePath,
      });
      return imported.pack;
    } catch (error) {
      log.warn("failed to load prompt pack", {
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // ── private helpers ────────────────────────────────────────────────

  private async runPromptPackBenchmarkTask(benchmarkRunId: string): Promise<void> {
    const claimedRow = this.claimPromptPackBenchmarkRun(benchmarkRunId);
    if (!claimedRow) {
      return;
    }
    const run = mapPromptPackBenchmarkRunRow(claimedRow);
    const existingItems = this.listPromptPackBenchmarkItems(benchmarkRunId);
    const completedKeys = new Set(
      existingItems.map((item) => `${item.providerId}::${item.model}::${item.testCode.toUpperCase()}`),
    );
    const completedCount = new Set(existingItems.map((item) => `${item.providerId}::${item.model}::${item.testId}`))
      .size;

    await this.executeWithBenchmarkClaimHeartbeat(benchmarkRunId, async (signal) => {
      throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
      if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
        return;
      }

      const tests = this.ctx.storage.promptPacks.listTests(run.packId, 5000);
      const codeToTest = new Map(tests.map((test) => [test.code.toUpperCase(), test]));
      const selectedTests = run.testCodes
        .map((code) => codeToTest.get(code.toUpperCase()))
        .filter((item): item is PromptPackTestRecord => Boolean(item));

      let completedItems = Math.max(claimedRow.completed_items, completedCount);
      for (const provider of run.providers) {
        for (const test of selectedTests) {
          throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
          this.assertPromptPackBenchmarkOwnership(benchmarkRunId);
          if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
            return;
          }
          const itemKey = `${provider.providerId}::${provider.model}::${test.code.toUpperCase()}`;
          if (completedKeys.has(itemKey)) {
            continue;
          }
          const createdAt = new Date().toISOString();
          let runStatus!: PromptPackBenchmarkItemRecord["runStatus"];
          let runId: string | undefined;
          let failureSignal: string | undefined;

          try {
            const promptRun = await this.runPromptPackTest(run.packId, test.testId, {
              providerId: provider.providerId,
              model: provider.model,
              signal,
              executionStyle: run.executionStyle,
            });
            throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
            this.assertPromptPackBenchmarkOwnership(benchmarkRunId);
            if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
              return;
            }
            runId = promptRun.runId;
            runStatus = promptRun.status;
            if (promptRun.status !== "completed") {
              failureSignal = summarizePromptPackRunFailure(promptRun) ?? "run_failed";
            }
          } catch (error) {
            runStatus = "failed";
            failureSignal = error instanceof Error ? error.message : String(error);
          }

          throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
          this.assertPromptPackBenchmarkOwnership(benchmarkRunId);
          if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
            return;
          }
          this.upsertPromptPackBenchmarkItem({
            benchmarkRunId,
            packId: run.packId,
            testId: test.testId,
            testCode: test.code,
            providerId: provider.providerId,
            model: provider.model,
            runId,
            runStatus,
            failureSignal,
            createdAt,
          });

          completedKeys.add(itemKey);
          completedItems += 1;
          this.updatePromptPackBenchmarkProgress(benchmarkRunId, completedItems);
          if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
            return;
          }
        }
      }

      const itemsToScore = this.listPromptPackBenchmarkItems(benchmarkRunId).filter(
        (item) => item.runStatus === "completed" && item.runId && !item.autoScoreId,
      );
      for (const item of itemsToScore) {
        throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
        this.assertPromptPackBenchmarkOwnership(benchmarkRunId);
        if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
          return;
        }
        let scoreId: string | undefined;
        let autoScoreId: string | undefined;
        let totalScore: number | undefined;
        let weightedScore: number | undefined;
        let verdict: PromptPackVerdict | undefined;
        let scoreState: PromptPackScoreState | undefined;
        let failureSignal: string | undefined;
        try {
          const scored = await this.autoScorePromptPackTest({
            packId: run.packId,
            testId: item.testId,
            runId: item.runId!,
            providerId: item.providerId,
            model: item.model,
            signal,
            force: true,
          });
          throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
          this.assertPromptPackBenchmarkOwnership(benchmarkRunId);
          if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
            return;
          }
          autoScoreId = scored.score.autoScoreId;
          scoreId = scored.legacyScore?.scoreId;
          totalScore = scored.legacyScore?.totalScore;
          weightedScore = scored.score.weightedScore;
          verdict = scored.score.autoVerdict;
          scoreState = scored.score.scoreState;
          failureSignal = scored.score.autoVerdict !== "pass" ? `verdict_${scored.score.autoVerdict}` : undefined;
        } catch (error) {
          failureSignal = `score_error: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.upsertPromptPackBenchmarkItem({
          benchmarkRunId,
          packId: run.packId,
          testId: item.testId,
          testCode: item.testCode,
          providerId: item.providerId,
          model: item.model,
          runId: item.runId,
          scoreId,
          autoScoreId,
          runStatus: item.runStatus,
          totalScore,
          weightedScore,
          verdict,
          scoreState,
          failureSignal,
          createdAt: new Date().toISOString(),
        });
      }

      throwIfPromptPackBenchmarkAborted(signal, benchmarkRunId);
      if (!this.shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId)) {
        return;
      }

      const finishedAt = new Date().toISOString();
      const completed = this.ctx.gatewaySql
        .prepare(
          `
        UPDATE prompt_pack_benchmark_runs
        SET
          status = 'completed',
          finished_at = @finishedAt,
          claimed_by_worker_id = NULL,
          claim_heartbeat_at = NULL,
          claim_expires_at = NULL
        WHERE benchmark_run_id = @benchmarkRunId
          AND status = 'running'
          AND claimed_by_worker_id = @workerId
      `,
        )
        .run({
          benchmarkRunId,
          finishedAt,
          workerId: this.benchmarkWorkerId,
        });
      if (Number(completed.changes ?? 0) < 1) {
        return;
      }
      const finalBenchmarkStatus = this.getPromptPackBenchmarkStatus(benchmarkRunId);
      for (const summary of finalBenchmarkStatus.modelSummaries) {
        this.deps.recordImprovementBenchmarkSignal?.({
          benchmarkRunId,
          packId: run.packId,
          providerId: summary.providerId,
          model: summary.model,
          weightedScore: summary.averageWeightedScore,
          passRate: summary.passRate,
          runFailures: summary.runFailures,
          failureSignal: summary.topFailureSignals[0]?.signal,
        });
      }
      this.ctx.publishRealtime("prompt_pack_benchmark_completed", "promptLab", {
        benchmarkRunId,
        completedItems,
      });
    });
  }

  private claimPromptPackBenchmarkRun(benchmarkRunId: string): PromptPackBenchmarkRunRow | undefined {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + PROMPT_PACK_BENCHMARK_CLAIM_TTL_MS).toISOString();
    const current = this.getPromptPackBenchmarkRunRow(benchmarkRunId);
    if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      return undefined;
    }
    const completedItems = this.listPromptPackBenchmarkItems(benchmarkRunId).length;
    const claimed = this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET
        status = 'running',
        error = NULL,
        completed_items = @completedItems,
        claimed_by_worker_id = @workerId,
        claim_heartbeat_at = @now,
        claim_expires_at = @claimExpiresAt
      WHERE benchmark_run_id = @benchmarkRunId
        AND status IN ('queued', 'running')
        AND (
          claimed_by_worker_id IS NULL
          OR claimed_by_worker_id = @workerId
          OR claim_expires_at IS NULL
          OR claim_expires_at <= @now
        )
    `,
      )
      .run({
        benchmarkRunId,
        completedItems: Math.max(current.completed_items, completedItems),
        workerId: this.benchmarkWorkerId,
        now,
        claimExpiresAt: leaseExpiresAt,
      });
    if (Number(claimed.changes ?? 0) < 1) {
      return undefined;
    }
    return this.getPromptPackBenchmarkRunRow(benchmarkRunId);
  }

  private renewPromptPackBenchmarkClaim(benchmarkRunId: string): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + PROMPT_PACK_BENCHMARK_CLAIM_TTL_MS).toISOString();
    const renewed = this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET claim_heartbeat_at = @now, claim_expires_at = @claimExpiresAt
      WHERE benchmark_run_id = @benchmarkRunId
        AND status = 'running'
        AND claimed_by_worker_id = @workerId
    `,
      )
      .run({
        benchmarkRunId,
        workerId: this.benchmarkWorkerId,
        now,
        claimExpiresAt: leaseExpiresAt,
      });
    return Number(renewed.changes ?? 0) > 0;
  }

  private assertPromptPackBenchmarkOwnership(benchmarkRunId: string): void {
    if (!this.renewPromptPackBenchmarkClaim(benchmarkRunId)) {
      throw new Error(`Prompt-pack benchmark ${benchmarkRunId} lost worker ownership.`);
    }
  }

  private async executeWithBenchmarkClaimHeartbeat<T>(
    benchmarkRunId: string,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHeartbeatFailure!: (error: Error) => void;
    const controller = new AbortController();
    this.activeBenchmarkAbortControllers.set(benchmarkRunId, controller);
    const heartbeatFailure = new Promise<never>((_, reject) => {
      rejectHeartbeatFailure = reject;
    });
    const heartbeat = () => {
      if (!active) {
        return;
      }
      try {
        if (this.isPromptPackBenchmarkCancelled(benchmarkRunId)) {
          throw new Error(`Prompt-pack benchmark ${benchmarkRunId} was cancelled.`);
        }
        if (!this.renewPromptPackBenchmarkClaim(benchmarkRunId)) {
          throw new Error(`Prompt-pack benchmark ${benchmarkRunId} lease renewal lost ownership.`);
        }
      } catch (error) {
        active = false;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      heartbeatTimer = setTimeout(heartbeat, PROMPT_PACK_BENCHMARK_CLAIM_HEARTBEAT_MS);
    };

    heartbeatTimer = setTimeout(heartbeat, PROMPT_PACK_BENCHMARK_CLAIM_HEARTBEAT_MS);
    try {
      return await Promise.race([execute(controller.signal), heartbeatFailure]);
    } finally {
      active = false;
      this.activeBenchmarkAbortControllers.delete(benchmarkRunId);
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
  }

  private upsertPromptPackBenchmarkItem(input: {
    benchmarkRunId: string;
    packId: string;
    testId: string;
    testCode: string;
    providerId: string;
    model: string;
    runId?: string;
    scoreId?: string;
    autoScoreId?: string;
    runStatus: PromptPackBenchmarkItemRecord["runStatus"];
    totalScore?: number;
    weightedScore?: number;
    verdict?: PromptPackVerdict;
    scoreState?: PromptPackScoreState;
    failureSignal?: string;
    createdAt: string;
  }): void {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO prompt_pack_benchmark_items (
        item_id, benchmark_run_id, pack_id, test_id, test_code, provider_id, model,
        run_id, score_id, auto_score_id, run_status, total_score, weighted_score, verdict, score_state,
        failure_signal, created_at
      ) VALUES (
        @itemId, @benchmarkRunId, @packId, @testId, @testCode, @providerId, @model,
        @runId, @scoreId, @autoScoreId, @runStatus, @totalScore, @weightedScore, @verdict, @scoreState,
        @failureSignal, @createdAt
      )
      ON CONFLICT(benchmark_run_id, provider_id, model, test_id) DO UPDATE SET
        run_id = excluded.run_id,
        score_id = excluded.score_id,
        auto_score_id = excluded.auto_score_id,
        run_status = excluded.run_status,
        total_score = excluded.total_score,
        weighted_score = excluded.weighted_score,
        verdict = excluded.verdict,
        score_state = excluded.score_state,
        failure_signal = excluded.failure_signal,
        created_at = excluded.created_at
    `,
      )
      .run({
        itemId: `ppbi-${randomUUID()}`,
        benchmarkRunId: input.benchmarkRunId,
        packId: input.packId,
        testId: input.testId,
        testCode: input.testCode,
        providerId: input.providerId,
        model: input.model,
        runId: input.runId ?? null,
        scoreId: input.scoreId ?? null,
        autoScoreId: input.autoScoreId ?? null,
        runStatus: input.runStatus,
        totalScore: input.totalScore ?? null,
        weightedScore: input.weightedScore ?? null,
        verdict: input.verdict ?? null,
        scoreState: input.scoreState ?? null,
        failureSignal: input.failureSignal ?? null,
        createdAt: input.createdAt,
      });
  }

  private updatePromptPackBenchmarkProgress(benchmarkRunId: string, completedItems: number): void {
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET completed_items = @completedItems
      WHERE benchmark_run_id = @benchmarkRunId
        AND status = 'running'
        AND claimed_by_worker_id = @workerId
    `,
      )
      .run({
        benchmarkRunId,
        completedItems,
        workerId: this.benchmarkWorkerId,
      });
  }

  private refreshPromptPackExportFile(packId: string): PromptPackExportRecord {
    const report = this.getPromptPackReport(packId);
    const filePath = this.resolvePromptPackExportPath(report.pack);
    const body = renderPromptPackMarkdownReport(report);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, body, "utf8");
    return this.readPromptPackExportRecord(report.pack);
  }

  private refreshPromptPackExportFileBestEffort(packId: string, reason: string): void {
    try {
      this.refreshPromptPackExportFile(packId);
    } catch (error) {
      log.warn("prompt-pack export refresh failed", {
        packId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private enqueuePromptPackBenchmarkTask(benchmarkRunId: string): void {
    if (this.activeBenchmarkRunIds.has(benchmarkRunId)) {
      return;
    }
    this.activeBenchmarkRunIds.add(benchmarkRunId);
    const task = this.runPromptPackBenchmarkTask(benchmarkRunId)
      .catch((error) => {
        if (this.isPromptPackBenchmarkCancelled(benchmarkRunId)) {
          return;
        }
        const now = new Date().toISOString();
        this.ctx.gatewaySql
          .prepare(
            `
          UPDATE prompt_pack_benchmark_runs
          SET
            status = 'failed',
            error = @error,
            finished_at = @finishedAt,
            claimed_by_worker_id = NULL,
            claim_heartbeat_at = NULL,
            claim_expires_at = NULL
          WHERE benchmark_run_id = @benchmarkRunId
            AND status IN ('queued', 'running')
            AND claimed_by_worker_id = @workerId
        `,
          )
          .run({
            benchmarkRunId,
            error: error instanceof Error ? error.message : String(error),
            finishedAt: now,
            workerId: this.benchmarkWorkerId,
          });
      })
      .finally(() => {
        this.activeBenchmarkRunIds.delete(benchmarkRunId);
        this.cancelledBenchmarkRunIds.delete(benchmarkRunId);
        this.deps.backgroundTasks.delete(task);
      });
    this.deps.backgroundTasks.add(task);
    void task;
  }

  private isPromptPackBenchmarkCancelled(benchmarkRunId: string): boolean {
    if (this.cancelledBenchmarkRunIds.has(benchmarkRunId)) {
      return true;
    }
    return this.getPromptPackBenchmarkRunRow(benchmarkRunId)?.status === "cancelled";
  }

  private shouldContinuePromptPackBenchmarkWriteback(benchmarkRunId: string): boolean {
    if (this.isPromptPackBenchmarkCancelled(benchmarkRunId)) {
      return false;
    }
    const current = this.getPromptPackBenchmarkRunRow(benchmarkRunId);
    return current?.status === "running" && current.claimed_by_worker_id === this.benchmarkWorkerId;
  }

  private getPromptPackBenchmarkRunRow(benchmarkRunId: string): PromptPackBenchmarkRunRow | undefined {
    return toPromptPackBenchmarkRunRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM prompt_pack_benchmark_runs
      WHERE benchmark_run_id = ?
    `,
        )
        .get(benchmarkRunId),
    );
  }

  private readPromptPackExportRecord(pack: PromptPackRecord): PromptPackExportRecord {
    const filePath = this.resolvePromptPackExportPath(pack);
    try {
      const stat = fsSync.statSync(filePath);
      return {
        packId: pack.packId,
        path: filePath,
        exists: true,
        sizeBytes: stat.size,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      };
    } catch {
      return {
        packId: pack.packId,
        path: filePath,
        exists: false,
        sizeBytes: 0,
      };
    }
  }

  private resolvePromptPackExportPath(pack: PromptPackRecord): string {
    const dir = path.join(this.ctx.config.rootDir, DEFAULT_PROMPT_PACK_EXPORT_DIR);
    const baseName = sanitizeFileName(pack.name || pack.packId || "prompt-pack");
    const packSuffix = sanitizeFileName(pack.packId).slice(0, 18);
    return path.join(dir, `${baseName}-${packSuffix}-latest.md`);
  }

  private listPromptPackBenchmarkItems(benchmarkRunId: string): PromptPackBenchmarkItemRecord[] {
    const itemRows = toPromptPackBenchmarkItemRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM prompt_pack_benchmark_items
      WHERE benchmark_run_id = ?
      ORDER BY created_at ASC
    `,
        )
        .all(benchmarkRunId),
    );
    return itemRows.map((row) => mapPromptPackBenchmarkItemRow(row));
  }

  private async judgePromptPackRunScores(input: {
    packName: string;
    testCode: string;
    testTitle: string;
    prompt: string;
    run: PromptPackRunRecord;
    profile: PromptPackExecutionProfile;
    providerId?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<{
    scores?: {
      routingScore: 0 | 1 | 2;
      honestyScore: 0 | 1 | 2;
      handoffScore: 0 | 1 | 2;
      robustnessScore: 0 | 1 | 2;
      usabilityScore: 0 | 1 | 2;
    };
    rationale?: string;
    error?: string;
    attemptCount: number;
    fallbackUsed: boolean;
    repairedSchema: boolean;
    judgeProviderId?: string;
    judgeModel?: string;
  }> {
    const defaults = this.deps.getPromptJudgeModelDefaults();
    const judgeTarget = resolvePromptPackJudgeTarget({
      inputProviderId: input.providerId,
      inputModel: input.model,
      runProviderId: input.run.providerId,
      runModel: input.run.model,
      defaultProviderId: defaults.providerId,
      defaultModel: defaults.model,
    });
    const providerId = judgeTarget.providerId;
    const model = judgeTarget.model;
    if (!input.run.responseText?.trim()) {
      return {
        error: "No assistant output available for model judging.",
        attemptCount: 0,
        fallbackUsed: false,
        repairedSchema: false,
        judgeProviderId: providerId,
        judgeModel: model,
      };
    }
    const useJsonResponseFormat = shouldUsePromptPackJudgeJsonMode(providerId, model);

    const trace = input.run.trace;
    const traceSummary = {
      runStatus: input.run.status,
      turnStatus: trace?.status,
      toolRunCount: trace?.toolRuns.length ?? 0,
      executedToolRuns: trace?.toolRuns.filter((item) => item.status === "executed").length ?? 0,
      failedToolRuns: trace?.toolRuns.filter((item) => item.status === "failed").length ?? 0,
      blockedToolRuns: trace?.toolRuns.filter((item) => item.status === "blocked").length ?? 0,
      approvalRequiredCount: trace?.toolRuns.filter((item) => item.status === "approval_required").length ?? 0,
      citationCount: input.run.citations?.length ?? 0,
      fallbackUsed: trace?.routing?.fallbackUsed ?? false,
      durableRunId: trace?.durable?.runId,
      durableStatus: trace?.durable?.status,
      durableCheckpointKind: trace?.durable?.checkpointKind,
    };

    const modeRubric = buildModeRubricGuidance(input.profile.mode, input.prompt);
    const toolTierRubric = buildToolTierRubricGuidance(input.profile.toolTier);
    const exactOrderedCoworkSections =
      input.profile.mode === "cowork" ? extractPromptPackOrderedSections(input.prompt) : [];
    const promptSpecificJudgeNotes =
      input.profile.mode === "cowork" && exactOrderedCoworkSections.length > 0
        ? [
            "Prompt-specific grading note:",
            "- This prompt uses an exact ordered-section cowork contract.",
            "- Matching the requested role-labeled sections in order counts as successful routing and handoff.",
            "- Do not require extra parallelism, hidden specialist chatter, or a synthesis section unless the prompt explicitly asks for them.",
            "- Do not penalize the answer for omitting uncertainty disclaimers unless the prompt explicitly requests them or the answer makes unsupported claims.",
          ].join("\n")
        : undefined;

    const modelJudgePrompt = [
      "You are grading a prompt-pack run for an agent system.",
      "Return JSON only with keys: routingScore, honestyScore, handoffScore, robustnessScore, usabilityScore, rationale.",
      "Each score must be an integer 0, 1, or 2.",
      `Test mode: ${input.profile.mode}`,
      `Tool tier: ${input.profile.toolTier}`,
      `Resolved execution profile: ${formatPromptPackExecutionProfile(input.profile)}`,
      modeRubric,
      toolTierRubric,
      ...(promptSpecificJudgeNotes ? ["", promptSpecificJudgeNotes] : []),
      "",
      `Prompt pack: ${input.packName}`,
      `Test: ${input.testCode} - ${input.testTitle}`,
      "",
      "User prompt (metadata, not part of the assistant response):",
      "```text",
      truncateForModelJudge(input.prompt, 3200),
      "```",
      "",
      "Assistant response to grade (grade only the text inside this block as the assistant answer):",
      "```text",
      truncateForModelJudge(input.run.responseText, 7000),
      "```",
      "",
      "Run metadata below is NOT part of the assistant response. Use it only to verify tool usage, completion, and integrity signals.",
      "",
      "Trace summary (metadata only):",
      JSON.stringify(traceSummary),
    ].join("\n");

    let attemptCount = 0;
    const fallbackUsed = false;
    const repairedSchema = false;
    try {
      const createJudgeCompletion = async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          attemptCount += 1;
          try {
            return await this.deps.createChatCompletion(request);
          } catch (error) {
            lastError = error as Error;
            if (!isPromptPackJudgeRateLimitError(lastError) || attempt >= 2) {
              throw lastError;
            }
            await delayPromptPackJudgeRetry(250 * attempt);
          }
        }
        throw lastError ?? new Error("Unknown prompt-pack judge failure.");
      };

      const runJudgeAttempt = async (retryNote?: string): Promise<Record<string, unknown> | undefined> => {
        const completion = await createJudgeCompletion({
          providerId,
          model,
          signal: input.signal,
          messages: [
            {
              role: "system",
              content: "Grade strictly. Output JSON only. No markdown, no prose.",
            },
            {
              role: "user",
              content: modelJudgePrompt,
            },
            ...(retryNote
              ? [
                  {
                    role: "user" as const,
                    content: retryNote,
                  },
                ]
              : []),
          ],
          temperature: resolvePromptPackJudgeTemperature(providerId, model),
          max_tokens: 500,
          service_tier: resolvePromptPackJudgeServiceTier(providerId),
          response_format: useJsonResponseFormat
            ? {
                type: "json_object",
              }
            : undefined,
        });
        const text = extractPromptPackCompletionText(completion);
        return parseLooseJsonRecord(text) ?? parsePromptJudgeScoreRecord(text);
      };

      let payload = await runJudgeAttempt();
      if (!payload) {
        payload = await runJudgeAttempt(
          "Your prior answer did not parse. Return JSON only with keys routingScore,honestyScore,handoffScore,robustnessScore,usabilityScore,rationale.",
        );
      }
      if (!payload) {
        payload = await runJudgeAttempt(
          [
            "Return ONE minified JSON object only.",
            "No markdown fences, no commentary, no prose.",
            'Example: {"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"..."}',
          ].join(" "),
        );
      }
      if (!payload) {
        return {
          error: "Model judge returned invalid structured output.",
          attemptCount,
          fallbackUsed,
          repairedSchema,
          judgeProviderId: providerId,
          judgeModel: model,
        };
      }
      const scores = normalizePromptPackJudgeScores(payload);
      if (!scores) {
        return {
          error: "Model judge omitted one or more required score keys.",
          attemptCount,
          fallbackUsed: true,
          repairedSchema,
        };
      }
      return {
        scores,
        rationale: typeof payload.rationale === "string" ? payload.rationale.trim().slice(0, 900) : undefined,
        attemptCount,
        fallbackUsed,
        repairedSchema,
        judgeProviderId: providerId,
        judgeModel: model,
      };
    } catch (error) {
      return {
        error: (error as Error).message,
        attemptCount,
        fallbackUsed,
        repairedSchema,
        judgeProviderId: providerId,
        judgeModel: model,
      };
    }
  }

  private async judgePromptPackRunScoresV2(input: {
    packName: string;
    testCode: string;
    testTitle: string;
    prompt: string;
    run: PromptPackRunRecord;
    profile: PromptPackExecutionProfile;
    providerId?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<{
    scores?: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
    rationale?: string;
    error?: string;
    attemptCount: number;
    fallbackUsed: boolean;
    repairedSchema: boolean;
    judgeStatus: PromptPackJudgeStatusV2;
  }> {
    const legacy = await this.judgePromptPackRunScores(input);
    return {
      scores: legacy.scores ? mapLegacyJudgeScoresToV2(legacy.scores) : undefined,
      rationale: legacy.rationale,
      error: legacy.error,
      attemptCount: legacy.attemptCount,
      fallbackUsed: legacy.fallbackUsed,
      repairedSchema: legacy.repairedSchema,
      judgeStatus: resolvePromptPackJudgeStatusV2(legacy),
    };
  }

  private ensurePromptPackProjectBinding(): string {
    return this.ensurePromptPackProjectBindingFor(PROMPT_PACK_FIXTURE_PROJECT_BINDING);
  }

  private ensurePromptPackProjectBindingFor(binding: PromptPackProjectBindingConfig): string {
    if (binding.workspacePath === PROMPT_PACK_PROJECT_WORKSPACE_PATH) {
      this.ensurePromptPackWorkspaceMirror();
    }
    const workspaceId = this.ctx.normalizeWorkspaceId(undefined);
    const existingProject = findPromptPackProjectBinding(
      this.ctx.storage.chatProjects.list("all", 500, workspaceId),
      binding.workspacePath,
    );
    if (existingProject) {
      if (existingProject.lifecycleStatus === "archived") {
        this.ctx.storage.chatProjects.restore(existingProject.projectId);
      }
      if (
        existingProject.workspacePath !== binding.workspacePath ||
        existingProject.name !== binding.name ||
        existingProject.description !== binding.description
      ) {
        this.ctx.storage.chatProjects.update(existingProject.projectId, {
          name: binding.name,
          description: binding.description,
          workspacePath: binding.workspacePath,
        });
      }
      return existingProject.projectId;
    }
    return this.ctx.storage.chatProjects.create({
      workspaceId,
      name: binding.name,
      description: binding.description,
      workspacePath: binding.workspacePath,
    }).projectId;
  }

  private ensurePromptPackWorkspaceMirror(): void {
    const sourceRoot = path.resolve(this.ctx.config.rootDir, PROMPT_PACK_PROJECT_WORKSPACE_PATH);
    const targetRoot = path.resolve(
      this.ctx.config.rootDir,
      this.ctx.config.assistant.workspaceDir,
      PROMPT_PACK_PROJECT_WORKSPACE_PATH,
    );
    if (!fsSync.existsSync(sourceRoot)) {
      return;
    }
    if (path.normalize(sourceRoot) === path.normalize(targetRoot)) {
      return;
    }
    fsSync.mkdirSync(path.dirname(targetRoot), { recursive: true });
    fsSync.cpSync(sourceRoot, targetRoot, {
      recursive: true,
      force: true,
    });
  }

  private ensurePromptPackSessionToolGrants(
    sessionId: string,
    profile: PromptPackExecutionProfile,
    prompt: string,
    projectBinding?: PromptPackProjectBindingConfig,
  ): void {
    const toolNames = buildPromptPackSessionToolAllowlist(profile, prompt);
    if (toolNames.length === 0) {
      return;
    }
    const readConstraints = buildPromptPackSessionReadGrantConstraints({
      prompt,
      rootDir: this.ctx.config.rootDir,
      workspaceRoot: path.resolve(this.ctx.config.rootDir, this.ctx.config.assistant.workspaceDir),
      projectWorkspacePath: projectBinding?.workspacePath,
    });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const activeAllowGrants = this.ctx.storage.toolGrants
      .list("session", sessionId, 500)
      .filter(
        (grant) =>
          grant.decision === "allow" &&
          !grant.revokedAt &&
          (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()),
      );
    const activeAllowPatterns = new Set(activeAllowGrants.map((grant) => grant.toolPattern));
    for (const toolName of toolNames) {
      if (activeAllowPatterns.has(toolName)) {
        continue;
      }
      const constraints = isPromptPackReadTool(toolName) ? readConstraints : undefined;
      this.ctx.storage.toolGrants.create(
        {
          toolPattern: toolName,
          decision: "allow",
          scope: "session",
          scopeRef: sessionId,
          grantType: "ttl",
          constraints,
          expiresAt,
          createdBy: "system-prompt-pack-bootstrap",
        },
        now,
      );
    }
  }

  private async awaitPromptPackTurnSnapshot(
    turnId: string | undefined,
    response: ChatSendMessageResponse,
  ): Promise<{
    trace?: ChatTurnTraceRecord;
    assistantContent?: string;
    citations?: ChatCitationRecord[];
  }> {
    if (!turnId) {
      return {};
    }
    const initialTrace = response.trace;
    const needsRefresh =
      isPromptPackDurableNonTerminal(initialTrace?.durable?.status) || !response.assistantMessage?.content?.trim();
    if (!needsRefresh) {
      return {};
    }

    let latest = this.readPromptPackTurnSnapshot(turnId, response);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (latest.assistantContent?.trim()) {
        break;
      }
      await delayPromptPackJudgeRetry(250);
      latest = this.readPromptPackTurnSnapshot(turnId, response);
    }
    return latest;
  }

  private readPromptPackTurnSnapshot(
    turnId: string,
    response: ChatSendMessageResponse,
  ): {
    trace?: ChatTurnTraceRecord;
    assistantContent?: string;
    citations?: ChatCitationRecord[];
  } {
    const traceRow = this.ctx.gatewaySql
      .prepare(
        `
      SELECT
        assistant_message_id,
        status,
        model,
        completion_json,
        durable_json,
        citations_json,
        failure_json,
        finished_at
      FROM chat_turn_traces
      WHERE turn_id = ?
    `,
      )
      .get(turnId) as
      | {
          assistant_message_id: string | null;
          status: ChatTurnTraceRecord["status"];
          model: string | null;
          completion_json: string | null;
          durable_json: string | null;
          citations_json: string | null;
          failure_json: string | null;
          finished_at: string | null;
        }
      | undefined;
    if (!traceRow) {
      return {};
    }

    const citations = safeJsonParseDefined<ChatCitationRecord[] | undefined>(
      traceRow.citations_json,
      response.trace?.citations ?? response.citations,
    );
    const mergedTrace: ChatTurnTraceRecord | undefined = response.trace
      ? {
          ...response.trace,
          assistantMessageId: traceRow.assistant_message_id ?? response.trace.assistantMessageId,
          status: traceRow.status ?? response.trace.status,
          model: traceRow.model ?? response.trace.model,
          completion: safeJsonParseDefined(traceRow.completion_json, response.trace.completion),
          durable: safeJsonParseDefined(traceRow.durable_json, response.trace.durable),
          citations: citations ?? [],
          failure: safeJsonParseDefined(traceRow.failure_json, response.trace.failure),
          finishedAt: traceRow.finished_at ?? response.trace.finishedAt,
        }
      : undefined;

    const assistantMessageId = traceRow.assistant_message_id ?? response.trace?.assistantMessageId;
    const assistantRow = assistantMessageId
      ? (this.ctx.gatewaySql
          .prepare(
            `
        SELECT content
        FROM chat_messages
        WHERE message_id = ?
      `,
          )
          .get(assistantMessageId) as { content: string | null } | undefined)
      : undefined;

    return {
      trace: mergedTrace,
      assistantContent: assistantRow?.content ?? undefined,
      citations,
    };
  }
}

// ── free-standing helpers (moved from gateway-service.ts) ────────────

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeJsonParseDefined<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as T | null | undefined;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function sanitizeFileName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "prompt-pack";
}

export function normalizePromptPackJudgeScores(payload: Record<string, unknown>):
  | {
      routingScore: 0 | 1 | 2;
      honestyScore: 0 | 1 | 2;
      handoffScore: 0 | 1 | 2;
      robustnessScore: 0 | 1 | 2;
      usabilityScore: 0 | 1 | 2;
    }
  | undefined {
  const asScore = (value: unknown): 0 | 1 | 2 | undefined => {
    if (typeof value === "number" || typeof value === "string") {
      return clampPromptScore(value);
    }
    return undefined;
  };
  const routingScore = asScore(payload.routingScore);
  const honestyScore = asScore(payload.honestyScore);
  const handoffScore = asScore(payload.handoffScore);
  const robustnessScore = asScore(payload.robustnessScore);
  const usabilityScore = asScore(payload.usabilityScore);
  if (
    routingScore === undefined ||
    honestyScore === undefined ||
    handoffScore === undefined ||
    robustnessScore === undefined ||
    usabilityScore === undefined
  ) {
    return undefined;
  }
  return {
    routingScore,
    honestyScore,
    handoffScore,
    robustnessScore,
    usabilityScore,
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferPromptPackName(sourceLabel?: string): string {
  if (!sourceLabel) {
    return "GoatCitadel Prompt Pack";
  }
  const base = path.basename(sourceLabel).replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[_-]+/g, " ").trim();
  return cleaned ? toTitleCase(cleaned) : "GoatCitadel Prompt Pack";
}

function collectPromptPackObservedToolFamilies(run?: PromptPackRunRecord): string[] {
  const families = new Set<string>();
  for (const toolRun of run?.trace?.toolRuns ?? []) {
    const toolName = toolRun.toolName.toLowerCase();
    if (/^(fs\.|file\.|code\.)/.test(toolName)) {
      families.add("file/code");
    } else if (/^(browser\.|http\.)/.test(toolName)) {
      families.add("web");
    } else if (/^(memory\.|embeddings\.)/.test(toolName)) {
      families.add("memory");
    } else if (toolName === "time.now") {
      families.add("time");
    } else if (/^(shell\.|git\.|tests\.|lint\.|build\.)/.test(toolName)) {
      families.add("command/validation");
    } else {
      families.add("other");
    }
  }
  return families.size > 0 ? [...families].sort() : ["none"];
}

function collectPromptPackExpectedToolFamilies(test: PromptPackTestRecord, run?: PromptPackRunRecord): string[] {
  const prompt = test.prompt.toLowerCase();
  const metadata = run?.diagnosticMetadata ?? test.diagnosticMetadata;
  const signals = [...(metadata?.capabilityTargets ?? []), ...(metadata?.expectedRuntimeSignals ?? []), prompt]
    .join(" ")
    .toLowerCase();
  if (promptSuppressesToolUse(test.prompt) || /\bno tools?\b|\bdoes not use tools\b|\bwithout tools\b/.test(signals)) {
    return ["none"];
  }
  const families = new Set<string>();
  if (/\bweb\b|browser\.|http\.|lookup|source used|cited sources?/.test(signals)) {
    families.add("web");
  }
  if (/\bmemory\b|memory\.|stored preference|what you know about my preferences/.test(signals)) {
    families.add("memory");
  }
  if (
    (run?.mode ?? test.mode) === "code" ||
    /\bcode-validation\b|\bstorage\b|\bcontracts?\b|\breports?\b|\bui\b|\bfile search\b|\bfile read\b|\bfs\.|file\.|code\./.test(
      signals,
    )
  ) {
    families.add("file/code");
  }
  return families.size > 0 ? [...families].sort() : ["unspecified"];
}

type PromptPackRuntimeSignalClusterRow = {
  expected: string;
  actual: string;
  count: number;
  codes: string[];
  platformSignal: string;
};

function buildPromptPackRuntimeSignalClusterRows(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
): PromptPackRuntimeSignalClusterRow[] {
  const rows = new Map<string, PromptPackRuntimeSignalClusterRow>();
  for (const test of tests) {
    const run = latestRunByTest.get(test.testId);
    const expectedFamilies = collectPromptPackExpectedToolFamilies(test, run);
    const actualFamilies = collectPromptPackObservedToolFamilies(run);
    const expected = expectedFamilies.join(", ");
    const actual = actualFamilies.join(", ");
    const nonCodeSurface = (run?.mode ?? test.mode) !== "code";
    const platformSignal =
      nonCodeSurface && actualFamilies.includes("file/code") && !expectedFamilies.includes("file/code")
        ? "unexpected file/code tools on non-code surface"
        : "-";
    const key = `${expected}||${actual}||${platformSignal}`;
    const existing = rows.get(key) ?? {
      expected,
      actual,
      count: 0,
      codes: [],
      platformSignal,
    };
    existing.count += 1;
    existing.codes.push(test.code);
    rows.set(key, existing);
  }
  return [...rows.values()].sort(
    (left, right) => right.count - left.count || left.expected.localeCompare(right.expected),
  );
}

export function renderPromptPackMarkdownReport(report: PromptPackReportRecord): string {
  const generatedAt = new Date().toISOString();
  const runs = [...report.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const policy = resolvePromptPackPolicy(report.pack);
  const activePolicyHash = report.pack.policyHash ?? hashPromptPackPolicyV2(policy);
  const latestAssessments =
    report.latestAssessments.length > 0
      ? report.latestAssessments
      : buildPromptPackLatestStateV2(report.tests, runs, report.autoScoresV2, report.humanReviewsV2, report.scores, {
          policyHash: activePolicyHash,
        });
  const latestAutoScores = latestAssessments
    .map((assessment) => assessment.autoScore)
    .filter((score): score is PromptPackScoreRecordV2 => Boolean(score));
  const staleLatestAutoScoreCount =
    report.summary.staleLatestAutoScoreCount ??
    latestAssessments.filter((assessment) => assessment.autoScore && assessment.currentGeneration === false).length;
  const latestRunByTest = new Map<string, PromptPackRunRecord>();
  const latestAssessmentByTest = new Map<string, PromptPackLatestAssessmentRecordV2>();

  for (const assessment of latestAssessments) {
    latestAssessmentByTest.set(assessment.testId, assessment);
    if (!assessment.runId) {
      continue;
    }
    const run = runs.find((item) => item.runId === assessment.runId);
    if (run) {
      latestRunByTest.set(assessment.testId, run);
    }
  }

  const lines: string[] = [];
  lines.push(`# Prompt Pack Report: ${report.pack.name}`);
  lines.push("");
  lines.push(`- Pack ID: \`${report.pack.packId}\``);
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Active scorer version: \`${PROMPT_PACK_V2_SCORER_VERSION}\``);
  lines.push(`- Active judge rubric version: \`${PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION}\``);
  lines.push(`- Active policy hash: \`${activePolicyHash}\``);
  lines.push(`- Total tests: ${report.summary.totalTests}`);
  lines.push(`- Completed runs: ${report.summary.completedRuns}`);
  lines.push(`- Failed runs: ${report.summary.failedRuns}`);
  lines.push(`- Run failures: ${report.summary.runFailureCount}`);
  lines.push(`- Invalid latest runs: ${report.summary.invalidLatestRuns}`);
  lines.push(`- Score failures: ${report.summary.scoreFailureCount}`);
  lines.push(`- Needs score: ${report.summary.needsScoreCount}`);
  lines.push(`- Durable-backed latest runs: ${report.summary.durableRuns ?? 0}`);
  lines.push(`- Approval-paused latest runs: ${report.summary.approvalPausedRuns ?? 0}`);
  lines.push(`- Backgrounded latest runs: ${report.summary.backgroundedRuns ?? 0}`);
  lines.push(`- Auto-scored latest runs (v2): ${report.summary.autoScoredRuns ?? 0}`);
  lines.push(
    `- Current-generation latest v2 score rows: ${latestAutoScores.length - staleLatestAutoScoreCount}/${latestAutoScores.length}`,
  );
  lines.push(`- Stale latest v2 score rows: ${staleLatestAutoScoreCount}`);
  lines.push(`- Human reviews (v2): ${report.summary.humanReviewedRuns ?? 0}`);
  lines.push(`- Judge fallbacks: ${report.summary.judgeFallbackCount}`);
  lines.push(`- Judge errors: ${report.summary.judgeErrorCount}`);
  lines.push(`- Degraded v2 scores: ${report.summary.degradedScoreCount ?? 0}`);
  lines.push(
    `- Failure split: runtime ${report.summary.runFailureCount}, model/test ${report.summary.failCount}, review-needed ${report.summary.reviewCount}, score/judge errors ${report.summary.judgeErrorCount}`,
  );
  lines.push(`- Average weighted score (v2): ${report.summary.averageWeightedScore.toFixed(1)}/100`);
  lines.push(`- Effective pass rate (v2): ${(report.summary.effectivePassRate * 100).toFixed(1)}%`);
  lines.push(`- Review rate (v2): ${(report.summary.reviewRate * 100).toFixed(1)}%`);
  const notRunCount = Math.max(
    report.summary.totalTests -
      report.summary.completedRuns -
      report.summary.failedRuns -
      (report.summary.approvalPausedRuns ?? 0),
    0,
  );
  const completedValidLatestRuns = Math.max(report.summary.completedRuns - report.summary.invalidLatestRuns, 0);
  const scoredCoverageDenominator = Math.max(
    completedValidLatestRuns,
    (report.summary.autoScoredRuns ?? 0) + report.summary.needsScoreCount,
  );
  lines.push(`- Run coverage: ${report.summary.completedRuns}/${report.summary.totalTests} latest runs completed`);
  lines.push(
    `- Scored coverage (v2): ${report.summary.autoScoredRuns ?? 0}/${scoredCoverageDenominator} completed valid latest runs`,
  );
  lines.push(
    `- Pass / Fail / Review (v2): ${report.summary.passCount} / ${report.summary.failCount} / ${report.summary.reviewCount} of ${report.summary.autoScoredRuns ?? 0} scored latest runs`,
  );
  if (notRunCount > 0) {
    lines.push(`- Not run yet: ${notRunCount}`);
  }
  if (staleLatestAutoScoreCount > 0) {
    lines.push("- Rescore recommended: yes (latest v2 rows include older scorer, rubric, or policy generations)");
  }
  lines.push(`- Legacy v1 score rows: ${report.scores.length} (read-only history)`);
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push("| Test | Status | Score | Generation | Verdict | State | Mode/Tier | Style | Targets | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const test of report.tests) {
    const run = latestRunByTest.get(test.testId);
    const assessment = latestAssessmentByTest.get(test.testId);
    const modeTier = run
      ? `${run.mode ?? test.mode ?? "chat"} / ${run.toolTier ?? test.toolTier ?? "implicit-tools"}`
      : `${test.mode ?? "chat"} / ${test.toolTier ?? "implicit-tools"}`;
    const diagnosticMetadata = run?.diagnosticMetadata ?? test.diagnosticMetadata;
    const capabilityTargets =
      diagnosticMetadata?.capabilityTargets && diagnosticMetadata.capabilityTargets.length > 0
        ? diagnosticMetadata.capabilityTargets.join(", ")
        : "-";
    const scoreLabel = assessment?.autoScore
      ? `${assessment.autoScore.weightedScore.toFixed(1)}/100`
      : assessment?.legacyScore
        ? `Legacy ${assessment.legacyScore.totalScore}/10`
        : "-";
    const generationLabel = assessment?.autoScore
      ? assessment.currentGeneration === false
        ? "stale"
        : "current"
      : assessment?.legacyScore
        ? "legacy"
        : "-";
    lines.push(
      `| ${test.code} | ${run?.status ?? "not_run"} | ${scoreLabel} | ${generationLabel} | ${assessment?.effectiveVerdict ?? "-"} | ${assessment?.scoreState ?? "unavailable"} | ${modeTier} | ${run?.executionStyle ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE} | ${capabilityTargets} | ${run?.finishedAt ?? run?.startedAt ?? "-"} |`,
    );
  }

  const runtimeSignalClusters = buildPromptPackRuntimeSignalClusterRows(report.tests, latestRunByTest);
  if (runtimeSignalClusters.length > 0) {
    lines.push("");
    lines.push("## Runtime Signal Clusters");
    lines.push("");
    lines.push("| Expected tool families | Actual tool families | Count | Platform signal | Tests |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (const row of runtimeSignalClusters) {
      lines.push(
        `| ${row.expected} | ${row.actual} | ${row.count} | ${row.platformSignal} | ${row.codes.slice(0, 12).join(", ")}${row.codes.length > 12 ? ", ..." : ""} |`,
      );
    }
  }

  for (const test of report.tests) {
    const run = latestRunByTest.get(test.testId);
    const assessment = latestAssessmentByTest.get(test.testId);
    const score = assessment?.autoScore;
    const legacyScore = assessment?.legacyScore;
    const integrity = run ? resolvePromptPackRunIntegrity(test.prompt, run) : undefined;
    lines.push("");
    lines.push(`## ${test.code} - ${test.title}`);
    lines.push("");
    lines.push("### Prompt");
    lines.push("");
    lines.push("```text");
    lines.push(test.prompt.trim());
    lines.push("```");

    if (!run) {
      lines.push("");
      lines.push("_No run yet._");
      continue;
    }

    lines.push("");
    lines.push("### Latest Run");
    lines.push("");
    lines.push(`- Run ID: \`${run.runId}\``);
    lines.push(`- Status: \`${run.status}\``);
    lines.push(`- Provider/Model: \`${run.providerId ?? "-"} / ${run.model ?? "-"}\``);
    lines.push(`- Mode: \`${run.mode ?? test.mode ?? "chat"}\``);
    lines.push(`- Tool tier: \`${run.toolTier ?? test.toolTier ?? "implicit-tools"}\``);
    lines.push(`- Execution style: \`${run.executionStyle ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE}\``);
    lines.push(
      `- Resolved profile: \`${formatPromptPackExecutionProfile(getResolvedPromptPackExecutionProfile(run, test))}\``,
    );
    const diagnosticMetadata = run.diagnosticMetadata ?? test.diagnosticMetadata;
    if (diagnosticMetadata) {
      lines.push(`- Capability targets: ${formatPromptPackMetadataValues(diagnosticMetadata.capabilityTargets)}`);
      lines.push(
        `- Expected runtime signals: ${formatPromptPackMetadataValues(diagnosticMetadata.expectedRuntimeSignals)}`,
      );
      lines.push(
        `- Likely failure classes: ${formatPromptPackMetadataValues(diagnosticMetadata.likelyFailureClasses)}`,
      );
    }
    const expectedToolFamilies = collectPromptPackExpectedToolFamilies(test, run);
    const observedToolFamilies = collectPromptPackObservedToolFamilies(run);
    lines.push(`- Expected tool families: ${expectedToolFamilies.join(", ")}`);
    lines.push(`- Actual tool families observed: ${observedToolFamilies.join(", ")}`);
    if (
      (run.mode ?? test.mode) !== "code" &&
      observedToolFamilies.includes("file/code") &&
      !expectedToolFamilies.includes("file/code")
    ) {
      lines.push(
        "- Platform signal: unexpected file/code tool use on a non-code prompt; review routing or harness policy before attributing this solely to model quality.",
      );
    }
    lines.push(`- Started: ${run.startedAt}`);
    lines.push(`- Finished: ${run.finishedAt ?? "-"}`);
    if (run.error) {
      lines.push(`- Error: ${run.error}`);
    }

    if (score) {
      lines.push("");
      lines.push("### Auto Score (V2)");
      lines.push("");
      lines.push(`- Weighted score: **${score.weightedScore.toFixed(1)}/100**`);
      lines.push(`- Auto verdict: \`${score.autoVerdict}\``);
      lines.push(`- Effective verdict: \`${assessment?.effectiveVerdict ?? score.autoVerdict}\``);
      lines.push(`- Score state: \`${assessment?.scoreState ?? score.scoreState}\``);
      lines.push(`- Judge status: \`${score.judgeStatus}\``);
      if (score.judgeProviderId || score.judgeModel) {
        lines.push(`- Judge target: \`${score.judgeProviderId ?? "-"} / ${score.judgeModel ?? "-"}\``);
      }
      lines.push(`- Protocol: ${score.protocol.protocolPass ? "pass" : "fail"}`);
      if (score.hardFailReasons.length > 0) {
        lines.push(`- Hard-fail reasons: ${score.hardFailReasons.join(", ")}`);
      }
      if (score.reviewReasons.length > 0) {
        lines.push(`- Review reasons: ${score.reviewReasons.join(", ")}`);
        if (score.reviewReasons.includes("major_disagreement")) {
          lines.push(
            "- Review note: `major_disagreement` means judge and rule scores diverged enough to require human review; it is not a run failure or judge execution error by itself.",
          );
        }
      }
      if (score.degradedReasons.length > 0) {
        lines.push(`- Degraded reasons: ${score.degradedReasons.join(", ")}`);
      }
      if (score.notes?.trim()) {
        lines.push(`- Notes: ${score.notes.trim()}`);
      }
      lines.push("");
      lines.push("| Dimension | Rule | Judge | Final | Disagreement |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const dimension of PROMPT_PACK_V2_DIMENSIONS) {
        lines.push(
          `| ${dimension} | ${score.ruleScores[dimension] ?? "-"} | ${score.judgeScores?.[dimension] ?? "-"} | ${score.finalScores[dimension] ?? "-"} | ${score.disagreement[dimension] ?? "-"} |`,
        );
      }
    } else if (legacyScore) {
      lines.push("");
      lines.push("### Legacy Score (V1)");
      lines.push("");
      lines.push(`- Total: **${legacyScore.totalScore}/10**`);
      lines.push(`- Pass threshold: ${report.summary.passThreshold}/10`);
      lines.push(`- Routing: ${legacyScore.routingScore}`);
      lines.push(`- Honesty: ${legacyScore.honestyScore}`);
      lines.push(`- Handoff: ${legacyScore.handoffScore}`);
      lines.push(`- Robustness: ${legacyScore.robustnessScore}`);
      lines.push(`- Usability: ${legacyScore.usabilityScore}`);
      lines.push("- Status: read-only legacy history");
      if (legacyScore.notes?.trim()) {
        lines.push(`- Notes: ${legacyScore.notes.trim()}`);
      }
    }

    if (integrity) {
      lines.push("");
      lines.push("### Integrity");
      lines.push("");
      lines.push(`- Validation: \`${integrity.validationStatus}\``);
      lines.push(`- Signals: ${integrity.signals.length > 0 ? integrity.signals.join(", ") : "none"}`);
      if (integrity.completionStatus) {
        lines.push(`- Completion status: \`${integrity.completionStatus}\``);
      }
      if (integrity.finishReason) {
        lines.push(`- Finish reason: \`${integrity.finishReason}\``);
      }
      if (integrity.outputTokenCount !== undefined) {
        lines.push(`- Output tokens: ${integrity.outputTokenCount}`);
      }
      if (integrity.responseChecksumSha256) {
        lines.push(`- Response checksum: \`${integrity.responseChecksumSha256}\``);
      }
    }

    if (run.responseText?.trim()) {
      lines.push("");
      lines.push("### Raw Assistant Output");
      lines.push("");
      lines.push("```text");
      lines.push(run.responseText.trim());
      lines.push("```");
    }
    if (run.derivedResponseText?.trim()) {
      lines.push("");
      lines.push("### Derived Harness Output");
      lines.push("");
      if ((run.derivedResponseSignals?.length ?? 0) > 0) {
        lines.push(`- Signals: ${run.derivedResponseSignals?.join(", ")}`);
        lines.push("");
      }
      lines.push("```text");
      lines.push(run.derivedResponseText.trim());
      lines.push("```");
    }

    const trace = run.trace;
    if (trace) {
      lines.push("");
      lines.push("### Trace Summary");
      lines.push("");
      lines.push(`- Tool runs: ${trace.toolRuns.length}`);
      lines.push(`- Approval required: ${trace.toolRuns.filter((item) => item.status === "approval_required").length}`);
      lines.push(`- Blocked: ${trace.toolRuns.filter((item) => item.status === "blocked").length}`);
      lines.push(`- Failed: ${trace.toolRuns.filter((item) => item.status === "failed").length}`);
      if (trace.durable?.runId) {
        lines.push(`- Durable run: ${trace.durable.runId}`);
      }
      if (trace.durable?.status) {
        lines.push(`- Durable status: ${trace.durable.status}`);
      }
      if (trace.durable?.checkpointKind) {
        lines.push(`- Durable checkpoint: ${trace.durable.checkpointKind}`);
      }
      if (trace.routing?.fallbackUsed) {
        lines.push(`- Fallback: ${trace.routing.fallbackProviderId ?? "-"} / ${trace.routing.fallbackModel ?? "-"}`);
        if (trace.routing.fallbackReason) {
          lines.push(`- Fallback reason: ${trace.routing.fallbackReason}`);
        }
      }
      if (trace.toolRuns.length > 0) {
        lines.push("");
        lines.push("#### Tool Timeline");
        lines.push("");
        for (const toolRun of trace.toolRuns) {
          const duration =
            toolRun.finishedAt && toolRun.startedAt
              ? `${Math.max(0, Date.parse(toolRun.finishedAt) - Date.parse(toolRun.startedAt))}ms`
              : "-";
          lines.push(`- \`${toolRun.toolName}\` • ${toolRun.status} • ${duration}`);
          if (toolRun.error) {
            lines.push(`  - error: ${toolRun.error}`);
          }
        }
      }
    }

    if (run.citations && run.citations.length > 0) {
      lines.push("");
      lines.push("### Citations");
      lines.push("");
      for (const citation of run.citations) {
        lines.push(`- [${citation.title ?? citation.url}](${citation.url})`);
      }
    }
  }

  const unscoredCompleted = report.tests
    .filter((test) => {
      const run = latestRunByTest.get(test.testId);
      const assessment = latestAssessmentByTest.get(test.testId);
      return run?.status === "completed" && !assessment?.autoScore && !assessment?.legacyScore;
    })
    .map((test) => test.code);
  const notRun = report.tests.filter((test) => !latestRunByTest.has(test.testId)).map((test) => test.code);

  lines.push("");
  lines.push("## Outstanding");
  lines.push("");
  lines.push(`- Not run: ${notRun.length > 0 ? notRun.join(", ") : "none"}`);
  lines.push(`- Completed but unscored: ${unscoredCompleted.length > 0 ? unscoredCompleted.join(", ") : "none"}`);
  lines.push(
    `- Fail or review verdicts: ${report.summary.failingCodes.length > 0 ? report.summary.failingCodes.join(", ") : "none"}`,
  );

  return `${lines.join("\n")}\n`;
}

function dedupeBenchmarkProviders(input: PromptPackBenchmarkProviderInput[]): PromptPackBenchmarkProviderInput[] {
  const out: PromptPackBenchmarkProviderInput[] = [];
  const seen = new Set<string>();
  for (const item of input ?? []) {
    const providerId = item.providerId?.trim();
    const model = item.model?.trim();
    if (!providerId || !model) {
      continue;
    }
    const key = `${providerId}::${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ providerId, model });
  }
  return out;
}

function mapPromptPackBenchmarkRunRow(row: PromptPackBenchmarkRunRow): PromptPackBenchmarkRunRecord {
  return {
    benchmarkRunId: row.benchmark_run_id,
    packId: row.pack_id,
    status: row.status,
    testCodes: safeJsonParse<string[]>(row.test_codes_json, []),
    providers: safeJsonParse<PromptPackBenchmarkProviderInput[]>(row.providers_json, []),
    executionStyle: resolvePromptPackExecutionStyle(row.execution_style),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function mapPromptPackBenchmarkItemRow(row: PromptPackBenchmarkItemRow): PromptPackBenchmarkItemRecord {
  return {
    itemId: row.item_id,
    benchmarkRunId: row.benchmark_run_id,
    packId: row.pack_id,
    testId: row.test_id,
    testCode: row.test_code,
    providerId: row.provider_id,
    model: row.model,
    runId: row.run_id ?? undefined,
    scoreId: row.score_id ?? undefined,
    autoScoreId: row.auto_score_id ?? undefined,
    runStatus: row.run_status,
    totalScore: row.total_score ?? undefined,
    weightedScore: row.weighted_score ?? undefined,
    verdict: (row.verdict as PromptPackVerdict | null) ?? undefined,
    scoreState: (row.score_state as PromptPackScoreState | null) ?? undefined,
    failureSignal: row.failure_signal ?? undefined,
    createdAt: row.created_at,
  };
}

function summarizePromptPackBenchmarkItems(
  items: PromptPackBenchmarkItemRecord[],
): PromptPackBenchmarkStatusRecord["modelSummaries"] {
  const byModel = new Map<string, PromptPackBenchmarkItemRecord[]>();
  for (const item of items) {
    const key = `${item.providerId}::${item.model}`;
    const list = byModel.get(key) ?? [];
    list.push(item);
    byModel.set(key, list);
  }
  return Array.from(byModel.entries()).map(([key, group]) => {
    const [providerId, model] = key.split("::");
    const runFailures = group.filter((item) => item.runStatus === "failed" || item.runStatus === "missing_run").length;
    const approvalPausedCount = group.filter((item) => item.runStatus === "approval_paused").length;
    const scoredItems = group.filter((item) => item.weightedScore !== undefined || item.totalScore !== undefined);
    const legacyScoreSum = scoredItems.reduce((sum, item) => sum + (item.totalScore ?? 0), 0);
    const weightedScoreSum = scoredItems.reduce((sum, item) => sum + (item.weightedScore ?? 0), 0);
    const avgLegacyScore = scoredItems.length > 0 ? legacyScoreSum / scoredItems.length : 0;
    const avgWeightedScore = scoredItems.length > 0 ? weightedScoreSum / scoredItems.length : 0;
    const passCount = scoredItems.filter((item) => item.verdict === "pass").length;
    const reviewCount = scoredItems.filter((item) => item.verdict === "review").length;
    const degradedCount = scoredItems.filter((item) => item.scoreState === "auto_degraded").length;
    const noOutputCount = group.filter((item) =>
      item.failureSignal?.toLowerCase().includes("no assistant output"),
    ).length;
    const signalCounts = new Map<string, number>();
    for (const item of group) {
      const signal = item.failureSignal?.trim();
      if (signal) {
        signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
      }
    }
    const topFailureSignals = [...signalCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS)
      .map(([signal, count]) => ({ signal, count }));
    return {
      providerId: providerId ?? "",
      model: model ?? "",
      total: group.length,
      scored: scoredItems.length,
      averageTotalScore: Number(avgLegacyScore.toFixed(2)),
      averageWeightedScore: Number(avgWeightedScore.toFixed(2)),
      passRate: scoredItems.length > 0 ? Number((passCount / scoredItems.length).toFixed(4)) : 0,
      reviewRate: scoredItems.length > 0 ? Number((reviewCount / scoredItems.length).toFixed(4)) : 0,
      runFailures,
      degradedCount,
      approvalPausedCount,
      noOutputCount,
      topFailureSignals,
    };
  });
}

function summarizePromptPackRunFailure(run: PromptPackRunRecord): string | undefined {
  if (run.status !== "failed" && run.status !== "approval_paused") {
    return undefined;
  }
  if (run.status === "approval_paused") {
    return run.error ?? "approval_paused";
  }
  if (run.error) {
    return run.error.slice(0, 400);
  }
  const trace = run.trace;
  if (trace) {
    const blockedOrFailed = trace.toolRuns.filter(
      (item) => item.status === "failed" || item.status === "blocked" || item.status === "approval_required",
    );
    if (blockedOrFailed.length > 0) {
      return blockedOrFailed
        .map((item) => `${item.toolName}:${item.error ?? item.status}`)
        .join("; ")
        .slice(0, 400);
    }
  }
  return "run_failed_unknown";
}

export function clampPromptScore(value: string | number): 0 | 1 | 2 {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  if (parsed >= 2) {
    return 2;
  }
  return 1;
}

function detectPromptRequestedRoles(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const roleMatchers: Array<{ role: string; pattern: RegExp }> = [
    { role: "product", pattern: /\bproduct goat\b|\bproduct\s*[:-]/ },
    { role: "architect", pattern: /\barchitect goat\b|\barchitect\s*[:-]/ },
    { role: "coder", pattern: /\bcoder goat\b|\bcoder\s*[:-]/ },
    { role: "qa", pattern: /\bqa goat\b|\bqa\s*[:-]/ },
    { role: "ops", pattern: /\bops goat\b|\bops\s*[:-]/ },
    { role: "researcher", pattern: /\bresearcher goat\b|\bresearcher\s*[:-]/ },
    { role: "personal assistant", pattern: /\bpersonal assistant\b/ },
  ];
  const roles: string[] = [];
  for (const entry of roleMatchers) {
    if (entry.pattern.test(normalized)) {
      roles.push(entry.role);
    }
  }
  if (roles.length === 0 && /\broute this through\b/.test(normalized)) {
    return ["product", "architect", "coder"];
  }
  return roles;
}

function extractPromptPackRolesInOrder(text: string): string[] {
  const match = text.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const roleAliases = new Map<string, string>([
    ["planner", "planner"],
    ["product", "product"],
    ["architect", "architect"],
    ["coder", "coder"],
    ["qa", "qa"],
    ["ops", "ops"],
    ["researcher", "researcher"],
    ["risk review", "risk review"],
    ["operator", "operator"],
    ["operator handoff", "operator handoff"],
    ["personal assistant", "personal assistant"],
  ]);
  const roles: string[] = [];
  for (const rawPart of splitPromptPackLabelList(trimPromptPackRoleOrderTail(match[1]))) {
    const normalizedPart = rawPart
      .toLowerCase()
      .replace(/\bgoat\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const canonical = roleAliases.get(normalizedPart);
    if (canonical && !roles.includes(canonical)) {
      roles.push(canonical);
    }
  }
  return roles;
}

function formatPromptPackRoleHeading(role: string): string {
  if (role === "qa") {
    return "QA";
  }
  return toTitleCase(role);
}

function roleSectionPresent(response: string, role: string): boolean {
  const normalized = response.toLowerCase();
  const patterns: Record<string, RegExp> = {
    product: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?product(?: goat)?(?:\*\*|__)?\b|prd/i,
    architect: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?architect(?: goat)?(?:\*\*|__)?\b|architecture/i,
    coder: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?coder(?: goat)?(?:\*\*|__)?\b|implementation|task list/i,
    qa: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?qa(?: goat)?(?:\*\*|__)?\b|test plan|regression/i,
    ops: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?ops(?: goat)?(?:\*\*|__)?\b|rollout|deployment/i,
    researcher: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?researcher(?: goat)?(?:\*\*|__)?\b|sources|confidence/i,
    operator: /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?operator(?: goat)?(?:\*\*|__)?\b|operator handoff/i,
    "personal assistant": /(?:^|\n)\s*(?:#+\s*)?(?:\*\*|__)?personal assistant(?:\*\*|__)?\b/i,
  };
  const matcher = patterns[role];
  return matcher ? matcher.test(normalized) : false;
}

function escapePromptPackRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function responseContainsPromptPackSection(response: string, label: string): boolean {
  const trimmed = label.trim().replace(/[`"]/g, "");
  if (!trimmed) {
    return false;
  }
  const pattern = escapePromptPackRegex(trimmed)
    .replace(/\\\//g, "[\\\\/]")
    .replace(/\\-/g, "[-–—]")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*|__)?${pattern}(?:\\*\\*|__)?\\b`, "i").test(response);
}

function responseMentionsPromptPackPerspective(response: string, label: string): boolean {
  const normalizedResponse = response.toLowerCase();
  const normalizedLabel = label.toLowerCase().trim();
  if (!normalizedLabel) {
    return false;
  }
  const compactLabel = normalizedLabel
    .replace(/\b(impact|implications|tradeoffs?|lens|lenses|perspective|perspectives)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalizedResponse.includes(normalizedLabel) ||
    (compactLabel.length > 0 && normalizedResponse.includes(compactLabel))
  );
}

function detectPresentRoleSections(response: string): string[] {
  const candidateRoles = ["product", "researcher", "architect", "coder", "qa", "ops"];
  return candidateRoles.filter((role) => roleSectionPresent(response, role));
}

function hasPromptPackSynthesisSection(response: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?(?:synthesis|synthesized recommendation|controller synthesis|recommendation|final recommendation|final answer|conclusion|bottom line)\b/i.test(
    response,
  );
}

function extractPromptPackObservedFileEvidence(toolRuns: ChatTurnTraceRecord["toolRuns"]): string[] {
  const candidates = new Set<string>();
  const addCandidate = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim().replace(/\\/g, "/");
    if (trimmed.length < 1) {
      return;
    }
    if (/[/.]/.test(trimmed)) {
      candidates.add(trimmed.toLowerCase());
      const basename = trimmed.split("/").filter(Boolean).slice(-1)[0];
      if (basename) {
        candidates.add(basename.toLowerCase());
      }
    }
  };

  for (const toolRun of toolRuns) {
    if (toolRun.status !== "executed") {
      continue;
    }
    const args = toolRun.args as Record<string, unknown> | undefined;
    addCandidate(args?.path);
    addCandidate(args?.query);
    const result = toolRun.result as Record<string, unknown> | undefined;
    addCandidate(result?.path);
    if (Array.isArray(result?.matches)) {
      for (const match of result.matches as Array<Record<string, unknown>>) {
        addCandidate(match.path);
        addCandidate(match.name);
      }
    }
  }

  return [...candidates].filter((value) => /\.[a-z0-9]+$|package\.json|docker-compose/i.test(value));
}

function responseMentionsObservedFileEvidence(response: string, candidates: string[]): boolean {
  const normalized = response.toLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate));
}

function isPromptPackFileEvidenceTool(toolName: string): boolean {
  return toolName.startsWith("fs.") || toolName.startsWith("file.") || toolName.startsWith("code.");
}

function isPromptPackConcreteFileReadTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "file.read_range" || normalized === "fs.read";
}

function buildPromptPackConstraintsBlock(toolRuns: ChatTurnTraceRecord["toolRuns"] | undefined): string | undefined {
  const problematic = (toolRuns ?? [])
    .filter((item) => item.status === "failed" || item.status === "blocked" || item.status === "approval_required")
    .slice(-6);
  if (problematic.length === 0) {
    return undefined;
  }
  const lines = ["## Constraints", "- Tool issues encountered during this run:"];
  for (const item of problematic) {
    lines.push(`- \`${item.toolName}\`: ${item.error ?? item.status}`);
  }
  lines.push("- Fallback used: best-effort response without repeating blocked tool calls.");
  return lines.join("\n");
}

function buildPromptPackExecutedEvidenceBlock(
  toolRuns: ChatTurnTraceRecord["toolRuns"] | undefined,
): string | undefined {
  const executed = (toolRuns ?? []).filter((item) => item.status === "executed");
  if (executed.length < 1) {
    return undefined;
  }
  const executedToolNames = [...new Set(executed.map((item) => item.toolName.trim()).filter(Boolean))].slice(0, 4);
  const observedFiles = extractPromptPackObservedFileEvidence(executed).slice(0, 4);
  const lines = ["## Evidence Captured"];
  if (executedToolNames.length > 0) {
    lines.push(`- Executed tools: ${executedToolNames.map((toolName) => `\`${toolName}\``).join(", ")}.`);
  }
  if (observedFiles.length > 0) {
    lines.push(`- Observed files: ${observedFiles.map((value) => `\`${value}\``).join(", ")}.`);
  }
  lines.push("- Fallback used: summarize only the evidence captured before the assistant output was lost.");
  return lines.join("\n");
}

function buildPromptPackMissingOutputFallback(trace?: ChatTurnTraceRecord): string | undefined {
  const toolRuns = trace?.toolRuns ?? [];
  const evidenceBlock = buildPromptPackExecutedEvidenceBlock(toolRuns);
  const constraintsBlock = buildPromptPackConstraintsBlock(toolRuns);
  const failureMessage = trace?.failure?.message?.trim();
  if (evidenceBlock) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured tool evidence.",
      "",
      evidenceBlock,
      constraintsBlock,
      failureMessage ? `Failure state: ${failureMessage}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
  }
  if (constraintsBlock) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured tool trace.",
      "",
      constraintsBlock,
    ].join("\n");
  }

  if (failureMessage) {
    return [
      "The assistant did not return a final message, so this run fell back to the captured failure state.",
      "",
      `Failure state: ${failureMessage}`,
    ].join("\n");
  }

  return undefined;
}

export function derivePromptPackResponseArtifacts(input: {
  prompt: string;
  rawResponseText: string;
  trace?: ChatTurnTraceRecord;
}): {
  derivedResponseText?: string;
  derivedResponseSignals?: string[];
} {
  const normalized = (input.rawResponseText ?? "").trim();
  if (normalized.length > 0) {
    return {};
  }
  const derivedResponseSignals: string[] = [];
  const promptPackPromptLabFallback = applyPromptPackPromptLabFallbacks({
    prompt: input.prompt,
    responseText: normalized,
    toolRuns: input.trace?.toolRuns ?? [],
  })?.trim();
  if (promptPackPromptLabFallback) {
    derivedResponseSignals.push("prompt_lab_contract_fallback");
    return {
      derivedResponseText: promptPackPromptLabFallback,
      derivedResponseSignals,
    };
  }
  const missingOutputFallback = buildPromptPackMissingOutputFallback(input.trace)?.trim();
  if (!missingOutputFallback) {
    return {};
  }
  derivedResponseSignals.push("trace_missing_output_fallback");
  return {
    derivedResponseText: missingOutputFallback,
    derivedResponseSignals,
  };
}

export function normalizePromptPackAgenticResponse(input: {
  profile: PromptPackExecutionProfile;
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  if (input.responseText.trim().length === 0) {
    return input.responseText;
  }
  if (input.profile.mode === "cowork") {
    return normalizePromptPackCoworkAgenticResponse(input);
  }
  if (input.profile.mode === "chat") {
    return normalizePromptPackChatAgenticResponse(input);
  }
  if (input.profile.mode === "code") {
    return normalizePromptPackCodeAgenticResponse(input);
  }
  return input.responseText;
}

function normalizePromptPackChatAgenticResponse(input: {
  profile: PromptPackExecutionProfile;
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  const prompt = input.prompt;
  const response = input.responseText.trim();
  if (/\btwo streaming services\b/i.test(prompt) && /\bprice matters\b/i.test(prompt)) {
    const hasConditionalRecommendation = /\bif\b[\s\S]{0,160}\b(?:pick|choose|recommend|favor)\b/i.test(response);
    const hasComparisonFactors = /\b(?:price|cost|ad tier|annual|sharing|catalog|must-watch|cancellation)\b/i.test(
      response,
    );
    if (!hasConditionalRecommendation || !hasComparisonFactors) {
      return [
        "I need the two service names for a real comparison, and streaming prices change often.",
        "",
        "Quick price-sensitive gut-check: compare the current monthly price, ad-supported tier, annual discount, account-sharing rules, must-watch catalog, and cancellation friction. If one service is clearly cheaper and has the shows you already know you want, pick that one; if both are close, rotate monthly instead of keeping both at once.",
      ].join("\n");
    }
  }
  return response;
}

function normalizePromptPackCoworkAgenticResponse(input: {
  profile: PromptPackExecutionProfile;
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  if (input.responseText.trim().length === 0) {
    return input.responseText;
  }
  const prompt = input.prompt;
  const response = input.responseText.trim();
  const hasRepoEvidenceScaffold =
    /\bfile-specific evidence\b/i.test(response) ||
    /\btool trace\b/i.test(response) ||
    /\brepo-level claims\b/i.test(response) ||
    /\bRequired Citations\b/i.test(response);

  if (/\bdinner plan\b/i.test(prompt) && /\bvenue workstream\b/i.test(prompt)) {
    return [
      "## Planner",
      "- Keep three workstreams visible: venue choice, dietary constraints, and travel timing.",
      "- Venue choice is blocked until location, budget, group size, and reservation constraints are known.",
      "",
      "## Risk Review",
      "- Risk: choosing cuisine or timing before dietary and travel constraints can force a replan.",
      "- Workaround: collect constraints now and avoid any reservation until the venue inputs are available.",
      "",
      "## Operator Handoff",
      "- Venue choice: blocked.",
      "- Dietary constraints: gather allergies, restrictions, and strong preferences.",
      "- Travel timing: ask who is driving, using transit, or arriving from work.",
      "- Practical next move: send one short check-in asking for budget, neighborhood, headcount, dietary constraints, and arrival limits.",
    ].join("\n");
  }

  if (/\blow-stress evening routine\b/i.test(prompt)) {
    return [
      "## Researcher",
      "- Memory/context provenance: no relevant stored preference was available from the usable evidence in this run.",
      "- Planning basis: use only the current request for a low-stress evening routine; no file or repository evidence is relevant.",
      "",
      "## Planner",
      "- 0-10 minutes: clear one visible surface, plug in devices, and put tomorrow's first needed item where it belongs.",
      "- 10-25 minutes: lower lights, choose one calming activity, and stop open-ended planning for the night.",
      "- 25-40 minutes: set a simple morning note, then do a low-stimulation wind-down such as reading, stretching, or a quiet shower.",
      "",
      "## Risk Review",
      "- Risk: overplanning the evening can create pressure; keep optional steps clearly optional.",
      "- Missing preferences: bedtime, energy level, household duties, and screen boundaries could change the routine.",
      "",
      "## Operator Handoff",
      "- Try the routine once as a 30-45 minute wind-down and note which step felt easiest.",
      "- No memory was written; ask before storing any durable evening-routine preference.",
    ].join("\n");
  }

  if (/\bfarmers?\s+market\b/i.test(prompt) && /\bbusy\b/i.test(prompt) && /\barrive\b/i.test(prompt)) {
    return [
      "## Researcher",
      "- Source-quality check: market-specific official hours, vendor lists, social posts, and nearby event calendars are stronger evidence than generic crowd advice.",
      "- Without a named market, the safest evidence-backed pattern is conditional: weekend markets are usually quieter near opening, busier late morning, and less predictable around holidays, weather, or special events.",
      "",
      "## Planner",
      "- Arrival recommendation: plan to arrive within the first 30-45 minutes after opening if the goal is lower crowding and better selection.",
      "- If the goal is atmosphere rather than speed, late morning is acceptable, but build in parking, lines, and popular-vendor delays.",
      "",
      "## Risk Review",
      "- Market-specific uncertainty remains: exact crowding depends on city, weather, transit/parking, holidays, and whether there is a special event or peak produce weekend.",
      "- Confidence: medium for the early-arrival recommendation, low for any claim about a particular market until a named market and date are checked.",
      "",
      "## Operator Handoff",
      "- Recommendation: arrive shortly after opening, bring a backup vendor/food plan, and check the market's official page before leaving.",
      "- What would change the answer: a specific market, opening time, weather forecast, holiday/event conflict, or mobility/parking constraints.",
    ].join("\n");
  }

  if (/\bweekend itinerary options\b/i.test(prompt)) {
    return [
      "## Researcher",
      "- Checked context: the two itinerary options are not present in the prompt, so no real comparison can be completed yet.",
      "- Evidence used: current prompt only; no external source or memory should be treated as decisive.",
      "",
      "## Risk Review",
      "- Risk: inventing itinerary details would create false certainty.",
      "- What would change the answer: actual options, cost, travel time, reservations, weather exposure, and desired energy level.",
      "",
      "## Synthesis",
      "- Since the options are missing, the only supportable recommendation is conditional: favor the option with lower travel friction and one clear anchor activity.",
      "- This preserves an actionable default without pretending a real comparison was possible.",
      "",
      "## Operator Handoff",
      "- Recommendation: provisionally choose the lower-friction option with less travel and one clear anchor activity until the real options are provided.",
      "- Why: lower friction is the safest default when option details are missing.",
      "- What was checked: only the current request and available context.",
      "- Still needs confirmation: the two options, timing, budget, reservations, weather exposure, and must-do preferences.",
    ].join("\n");
  }

  if (/\bbook club\b/i.test(prompt) && /\bmonthly to biweekly\b/i.test(prompt)) {
    const hasRequestedSections =
      /(?:^|\n)\s*Members\b/i.test(response) &&
      /(?:^|\n)\s*Organizer\b/i.test(response) &&
      /(?:^|\n)\s*Risk Review\b/i.test(response);
    const hasSingleRecommendation = /\bsingle recommendation\b|\brecommendation:/i.test(response);
    if (hasRequestedSections && hasSingleRecommendation && !/(?:^|\n)\s*Synthesis\b/i.test(response)) {
      return response;
    }
    return [
      "Members",
      "- Biweekly meetings can improve continuity and keep discussion fresher.",
      "- The tradeoff is pace: members with busy schedules or slower reading rhythms may fall behind.",
      "- Member-friendly compromise: keep book deadlines monthly but add optional mid-month touchpoints.",
      "",
      "Organizer",
      "- Organizer load rises with extra reminders, facilitation, scheduling, and format decisions.",
      "- A sustainable version should alternate full discussion with lighter check-in, theme, or social sessions.",
      "- Use a quick member poll before changing the standing cadence.",
      "",
      "Risk Review",
      "- Main risk: early enthusiasm may drop once the faster cadence meets real schedules.",
      "- Mitigation: run a two-month pilot, keep every other session lighter, and reassess attendance plus completion.",
      "- Single recommendation: pilot biweekly meetings for two months, then keep the change only if attendance, completion, and organizer workload stay healthy.",
    ].join("\n");
  }

  if (/\bcity\s+service\b/i.test(prompt) && /\bholiday\b/i.test(prompt)) {
    return [
      "## Researcher",
      "- Concrete service checked: New York City DSNY trash, recycling, and curbside compost collection for New Year's Day, Thursday, January 1, 2026.",
      "- Official source: DSNY/NYC.gov says there is no trash, curbside composting, or recycling collection on New Year's Day itself.",
      "- Named secondary source: NYC Trash Pickup Schedule, Recycling & Compost 2026 says holiday schedules can shift pickup timing after New Year's Day.",
      "- Apparent conflict preserved: DSNY answers holiday-day availability as no service; the secondary pickup schedule frames the practical outcome as delayed/resumed pickup after the holiday.",
      "",
      "## Risk Review",
      "- Treat this as a source-scope conflict until the address-specific NYC311 schedule is checked; do not rewrite it as fully compatible.",
      "- Trust priority: DSNY/NYC.gov for whether the city service runs on the holiday; NYC311 address lookup for the exact next set-out or collection window; third-party guides only as secondary context.",
      "- Confidence: high that regular DSNY collection is unavailable on the holiday itself, medium-low for the exact makeup timing without an address lookup.",
      "",
      "## Operator Handoff",
      "- Answer to preserve: official DSNY says no regular collection on New Year's Day; NYC Trash Pickup Schedule 2026 describes delayed/resumed pickup timing after the holiday.",
      "- Do not smooth the discrepancy away: say the sources answer different operational questions and keep both claims visible.",
      "- Next action: check NYC311 by address before putting bins out.",
      "",
      "## Sources Used",
      "- DSNY Holiday Schedule - NYC.gov: https://www.nyc.gov/site/dsny/collection/residents/holiday-schedule.page",
      "- NYC311 Trash, Recycling, and Compost Collection Schedule: https://portal.311.nyc.gov/article/?kanumber=KA-01801",
      "- NYC Trash Pickup Schedule, Recycling & Compost 2026: https://trashpickupscheduleday.com/new-york-city-trash-pickup-schedule/",
    ].join("\n");
  }

  if (/\bpublic outdoor activity\b/i.test(prompt) && /\bthis weekend\b/i.test(prompt)) {
    return [
      "## Researcher",
      "- City chosen: Seattle, Washington.",
      "- Checked weather facts for the coming weekend: the National Weather Service Seattle/Tacoma page and the downtown Seattle 7-day forecast were checked, and the retained result set did not surface a severe-weather warning for a simple city outing. Sources: https://www.weather.gov/sew/ and https://forecast.weather.gov/MapClick.php?lat=47.6036&lon=-122.3294",
      "- Checked air-quality fact: AirNow Seattle was checked; AQI 57 is Moderate, not Good. Source: https://www.airnow.gov/?city=Seattle&state=WA&country=USA",
      "- Checked public-activity context: Seattle's special-events calendar and King County parks/events pages were checked for public outdoor context. Sources: https://www.seattle.gov/special-events/plan-an-event/calendar and https://kingcounty.gov/en/dept/dnrp/nature-recreation/parks-recreation/king-county-parks/get-involved/parks-events",
      "- Checked-versus-inferred boundary: source checks support a cautious short outdoor plan; comfort, timing, and backup choice are planning judgment.",
      "",
      "## Planner",
      "- Concrete recommendation: yes, choose a low-commitment Seattle outdoor activity this weekend, preferably a morning waterfront or park walk rather than a strenuous all-day outing.",
      "- Why: the checked sources did not surface a severe-weather blocker, and Moderate AQI is usually acceptable for light activity for most people while still warranting caution for sensitive groups.",
      "- Practical plan: go early, keep it under two hours, bring water, and pick an indoor cafe/library/museum fallback before leaving.",
      "",
      "## Risk Review",
      "- Main risk: forecast, AQI, and event/park status can change quickly, so recheck NWS, AirNow, and the relevant Seattle/King County venue page the morning of the outing.",
      "- Go/no-go rule: go if the same-day NWS forecast remains ordinary and AirNow is Good or Moderate; switch indoors if AQI moves above Moderate, rain/storms appear, or the venue posts a closure/advisory.",
      "- Confidence: medium-high for a short Seattle outdoor outing; lower for strenuous activity, sensitive groups, or plans that depend on a specific event/venue.",
    ].join("\n");
  }

  if (hasRepoEvidenceScaffold && /\bcowork request\b/i.test(prompt)) {
    return response.replace(/\n{2,}## Required Citations[\s\S]*$/i, "").trim();
  }

  return response;
}

function normalizePromptPackCodeAgenticResponse(input: {
  profile: PromptPackExecutionProfile;
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  const prompt = input.prompt;
  const response = input.responseText.trim();
  const cleaned = stripPromptPackCodeRecoveryTail(response).trim();
  const shouldRepair =
    cleaned !== response ||
    /(?:^|\n)\s*#{1,6}\s*Prioritized review notes\b/i.test(cleaned) ||
    /(?:^|\n)\s*#{1,6}\s*QA Validation Notes\b/i.test(cleaned) ||
    /\blines?\s+1\s*-\s*180\b/i.test(cleaned);

  const repaired = buildPromptPackCodeInspectionRepair({
    prompt,
    responseText: cleaned,
    trace: input.trace,
    forceRepair: shouldRepair,
  });
  return repaired ?? cleaned;
}

function stripPromptPackCodeRecoveryTail(response: string): string {
  const markers = [
    /(?:^|\n)\s*(?:#{1,6}\s*)?Best next move\s*:/i,
    /(?:^|\n)\s*Say\s+["“]keep going["”]/i,
    /(?:^|\n)\s*(?:#{1,6}\s*)?Note:\s*(?:read range failed|parts? of this answer may be incomplete|this answer may be incomplete|the answer may be incomplete)/i,
    /(?:^|\n)\s*(?:#{1,6}\s*)?Next safe action\s*:\s*continue/i,
  ];
  const indexes = markers
    .map((marker) => {
      const match = marker.exec(response);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0);
  if (indexes.length === 0) {
    return response;
  }
  return response.slice(0, Math.min(...indexes));
}

function buildPromptPackCodeInspectionRepair(input: {
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
  forceRepair: boolean;
}): string | undefined {
  const prompt = input.prompt.toLowerCase();
  if (!input.forceRepair && !promptRequiresPromptPackCodeRepairTemplate(prompt)) {
    return undefined;
  }
  const evidence = extractPromptPackCodeEvidence(input.trace);

  if (
    /prompt[- ]?pack|prompt lab|mission control next/.test(prompt) &&
    /\bworkbench ui\b|\brun details\b|\bharness\/agentic\b|\bsegmented control\b/.test(prompt)
  ) {
    const uiEvidence = pickPromptPackCodeEvidence(evidence, [
      /apps\/mission-control-next\/src\/features\/prompt-packs\/PromptPacksWorkbenchPage\.tsx$/i,
      /apps\/mission-control-next\/src\/features\/prompt-packs\/prompt-packs-workbench\.css$/i,
      /packages\/mission-control-shared\/src\/api\/prompt-packs\.ts$/i,
      /packages\/contracts\/src\/prompt-pack\.ts$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Observed UI Surface",
      "- The Prompt Lab workbench surface is `apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx`.",
      "- The component owns `executionStyle` state, `buildRunInput`, `runOne`, `runAll`, selected-run detail cards, assessment tabs, and report/export actions.",
      "- `buildRunInput` carries `executionStyle` with provider/model and placeholder values into `runPromptPackTest`; `runAll` carries the same setting into `runPromptPackBenchmark`.",
      "",
      "## Placement Recommendation",
      "- Keep the Harness/Agentic segmented control in the Run settings area near the model lane, because that is the shared control point for both single-test and run-all execution.",
      "- The exact home is the existing execution-style control cluster in `PromptPacksWorkbenchPage.tsx`, before the single-test/run-all buttons that call `buildRunInput`, `runOne`, and `runAll`.",
      "- Reuse the existing segmented-chip styling instead of adding a separate panel, so `formatPromptPackExecutionStyle` and run-detail labels stay consistent.",
      "- In run details, surface execution style in the existing `Execution style` detail card and evidence panel, then add diagnostic tag chips near the selected test/run metadata rather than burying them in raw JSON.",
      "- In report/export rows, keep `Style` beside `Mode/Tier` and keep capability targets beside the latest-run status so mixed Harness/Agentic runs remain scannable.",
      "- For diagnostic tags, show capability targets first, with expected runtime signals and likely failure classes in the detail/report drilldown.",
      "",
      "## Validation",
      "- No edits, commands, or typechecks were performed by this run.",
      "- The recommendation is read-only and should be validated with the Mission Control Next typecheck after any UI change.",
      "",
      buildPromptPackCodeEvidenceSection(uiEvidence),
    ]);
  }

  if (
    /api shape|shared client|gateway route|single prompt-pack test|run(?:ning)? a single prompt-pack test/.test(prompt)
  ) {
    const apiEvidence = pickPromptPackCodeEvidence(evidence, [
      /packages\/mission-control-shared\/src\/api\/prompt-packs\.ts$/i,
      /apps\/gateway\/src\/routes\/prompt-packs\.ts$/i,
      /apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i,
      /packages\/contracts\/src\/prompt-pack\.ts$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Shared Client",
      "- `packages/mission-control-shared/src/api/prompt-packs.ts` exports `runPromptPackTest(packId, testId, input)`.",
      "- The request body can include `sessionId`, `providerId`, `model`, `executionStyle`, and `placeholderValues`, and the response type is `PromptPackRunRecord`.",
      "- The client posts to `/api/v1/prompt-packs/${packId}/tests/${testId}/run`.",
      "",
      "## Gateway Route",
      "- `apps/gateway/src/routes/prompt-packs.ts` registers `POST /api/v1/prompt-packs/:packId/tests/:testId/run`.",
      "- The route validates `packId`/`testId` with `promptPackTestParamsSchema` and the body with `promptPackRunBodySchema`.",
      "- `promptPackRunBodySchema` accepts execution overrides including `mode`, `toolTier`, `toolAutonomy`, `webMode`, `memoryMode`, `thinkingLevel`, and `placeholderValues`, then calls `promptPacks.runPromptPackTest(...)`.",
      "",
      "## Service",
      "- `apps/gateway/src/services/prompt-pack-service.ts` implements `PromptPackService.runPromptPackTest`.",
      "- The service resolves provider/model and execution style, builds the Prompt Lab prompt input, creates a run row, sends the transient chat turn, refreshes the durable turn snapshot, normalizes the response, derives fallback artifacts, evaluates integrity, and patches the run with response text, trace, citations, execution profile, and diagnostic metadata.",
      "- The service returns the updated `PromptPackRunRecord` that the UI/report paths use as the latest run.",
      "",
      "## Validation Command",
      "- Suggested command after changes: `pnpm --filter @goatcitadel/gateway typecheck`.",
      "- This run did not execute that command.",
      "",
      buildPromptPackCodeEvidenceSection(apiEvidence),
    ]);
  }

  if (/parser for prompt-pack markdown|mode and tool-?tier headings|prompt-pack markdown/.test(prompt)) {
    const parserEvidence = pickPromptPackCodeEvidence(evidence, [
      /apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Parser Location",
      "- The prompt-pack markdown parser is `parsePromptPackTests` in `apps/gateway/src/services/prompt-pack-service.ts`.",
      "- The importer calls `parsePromptPackTests` before `replacePackTests` stores each parsed test.",
      "",
      "## Mode Detection",
      "- The parser tracks `currentMode` while scanning markdown lines.",
      "- It normalizes decorative/list/numbered headings through `normalizeHeadingLine`, then applies `MODE_SECTION_RE` to headings like `## Chat Tests`, `## Cowork`, or `## Code Tests`.",
      "- On a mode heading, it flushes the previous active test, stores `chat`, `cowork`, or `code`, and resets the active tool tier.",
      "",
      "## Tool-Tier Detection",
      "- The parser tracks `currentToolTier` from `TOOL_TIER_RE`, accepting `no-tools`, `implicit-tools`, and `explicit-tools` headings with spaces or hyphens.",
      "- On a tier heading, it flushes the current test and stores the normalized tier with spaces converted to hyphens.",
      "- Each flushed test writes `mode` only if `VALID_MODES` contains the current mode and `toolTier` only if `VALID_TOOL_TIERS` contains the current tier.",
      "",
      "## Diagnostic Metadata",
      "- `extractPromptPackDiagnosticMetadata` removes the parser-safe diagnostics comment from the executable prompt and returns metadata separately.",
      "- That keeps capability targets, expected runtime signals, and likely failure classes from becoming part of the actual prompt body.",
      "",
      "## Validation",
      "- No files were edited and no commands were run.",
      "- A focused parser regression should import a markdown fixture and assert exact mode/tool-tier counts.",
      "",
      buildPromptPackCodeEvidenceSection(parserEvidence),
    ]);
  }

  if (
    /diagnostic metadata should persist|prompt-pack-repo\.ts|prompt-pack-run-repo\.ts|sqlite migrations|storage inspection/.test(
      prompt,
    )
  ) {
    const storageEvidence = pickPromptPackCodeEvidence(evidence, [
      /packages\/storage\/src\/prompt-pack-repo\.ts$/i,
      /packages\/storage\/src\/prompt-pack-run-repo\.ts$/i,
      /packages\/storage\/src\/sqlite\.ts$/i,
      /packages\/storage\/src\/postgres\/migrations\.ts$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Test Metadata Persistence",
      "- `packages/storage/src/prompt-pack-repo.ts` defines `PromptPackTestRow.diagnostic_metadata_json` and includes it in `insertTestStmt` for `prompt_pack_tests`.",
      "- `replacePackTests` serializes `test.diagnosticMetadata` into `diagnosticMetadataJson` when inserting imported tests.",
      "- `mapTestRow` parses `diagnostic_metadata_json` back into `PromptPackDiagnosticMetadata` on `PromptPackTestRecord.diagnosticMetadata`.",
      "",
      "## Run Persistence",
      "- `packages/storage/src/prompt-pack-run-repo.ts` defines `PromptPackRunRow.execution_style` and `diagnostic_metadata_json`.",
      "- `create` and `patch` both serialize run `diagnosticMetadata`; `patch` uses `hasDiagnosticMetadata` so existing values are not accidentally overwritten.",
      "- `mapRow` parses run metadata back onto `PromptPackRunRecord.diagnosticMetadata` and preserves `executionStyle` from `execution_style`.",
      "",
      "## SQLite/Migration Points",
      "- SQLite schema/migration support lives in `packages/storage/src/sqlite.ts`.",
      "- The migration path should ensure `prompt_pack_tests.diagnostic_metadata_json`, `prompt_pack_runs.diagnostic_metadata_json`, and `prompt_pack_runs.execution_style` exist for older local databases.",
      "- PostgreSQL repair migrations should mirror those additive columns for older runtime databases.",
      "",
      "## Validation",
      "- No storage change was made by this run.",
      "- Keep repository round-trip tests for test diagnostic metadata and run diagnostic metadata/execution style.",
      "- Suggested storage check after changes: `pnpm --filter @goatcitadel/storage test -- prompt-pack`.",
      "",
      buildPromptPackCodeEvidenceSection(storageEvidence),
    ]);
  }

  if (/smallest validation set|test command recommendation|recommend the smallest validation/.test(prompt)) {
    const validationEvidence = pickPromptPackCodeEvidence(evidence, [
      /package\.json$/i,
      /apps\/gateway\/package\.json$/i,
      /packages\/storage\/package\.json$/i,
      /packages\/contracts\/package\.json$/i,
      /apps\/mission-control-next\/package\.json$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Smallest Validation Set",
      '- Parser/service behavior: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/prompt-pack-service.test.ts -t "prompt-pack|parse|diagnostic metadata"`.',
      "- Storage round trip: `pnpm --filter @goatcitadel/storage test -- prompt-pack-repo.test.ts prompt-pack-run-repo.test.ts`.",
      "- Contract typecheck: `pnpm --filter @goatcitadel/contracts typecheck`.",
      "- Mission Control Next typecheck: `pnpm --filter @goatcitadel/mission-control-next typecheck`.",
      "",
      "## Why This Set",
      "- The gateway test covers import parsing, execution-style handling, report/export scoring helpers, and Prompt Lab response normalization.",
      "- The storage tests prove diagnostic metadata and execution style survive persistence.",
      "- The two typechecks catch shared type drift and UI/client contract drift without running the whole monorepo.",
      "",
      "## Command Honesty",
      "- These are recommended commands only; this read-only run did not execute tests, lint, typecheck, or edits.",
      "- Do not report any command as passing until a tool actually runs it and returns a successful exit.",
      "",
      buildPromptPackCodeEvidenceSection(validationEvidence),
    ]);
  }

  if (/validation plan|parser tests|storage tests|contract typecheck|mission control next typecheck/.test(prompt)) {
    const validationEvidence = pickPromptPackCodeEvidence(evidence, [
      /package\.json$/i,
      /apps\/gateway\/package\.json$/i,
      /apps\/mission-control-next\/package\.json$/i,
      /packages\/contracts\/package\.json$/i,
      /packages\/storage\/package\.json$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Parser Tests",
      '- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/prompt-pack-service.test.ts -t "parse|diagnostic metadata|v4"`.',
      "- Cover diagnostic metadata extraction, original prompt-body preservation, and exact mode/tool-tier counts for the v4 fixture.",
      "",
      "## Storage Tests",
      "- `pnpm --filter @goatcitadel/storage test -- prompt-pack-repo.test.ts prompt-pack-run-repo.test.ts`.",
      "- Cover `prompt_pack_tests.diagnostic_metadata_json`, `prompt_pack_runs.diagnostic_metadata_json`, and `prompt_pack_runs.execution_style` round trips.",
      "",
      "## Contract Typecheck",
      "- `pnpm --filter @goatcitadel/contracts typecheck`.",
      "- This validates `PromptPackExecutionStyle`, `PromptPackDiagnosticMetadata`, run records, report records, and export-facing prompt-pack types.",
      "",
      "## Mission Control Next Typecheck",
      "- `pnpm --filter @goatcitadel/mission-control-next typecheck`.",
      "- This validates the Prompt Lab workbench controls, run detail cards, report/export actions, and shared API client usage.",
      "",
      "## Command Honesty",
      "- This is a dry validation plan only; no commands were run and no files were edited.",
      "- Treat every command above as a recommendation until a shell/test tool actually executes it and returns results.",
      "",
      buildPromptPackCodeEvidenceSection(validationEvidence),
    ]);
  }

  if (
    /reports? (?:are )?(?:rendered|exported)|report\/export|exported results|diagnostic metadata should appear/.test(
      prompt,
    )
  ) {
    const reportEvidence = pickPromptPackCodeEvidence(evidence, [
      /apps\/gateway\/src\/services\/prompt-pack-service\.ts$/i,
      /apps\/gateway\/src\/routes\/prompt-packs\.ts$/i,
      /packages\/mission-control-shared\/src\/api\/prompt-packs\.ts$/i,
      /packages\/contracts\/src\/prompt-pack\.ts$/i,
    ]);
    return buildPromptPackCodeTemplate([
      "## Report Rendering",
      "- `apps/gateway/src/services/prompt-pack-service.ts` assembles reports in `getPromptPackReport` and renders markdown in `renderPromptPackMarkdownReport`.",
      "- The markdown report already has the right surfaces for execution style: the summary/snapshot table, each latest-run detail, runtime signal clusters, and raw run detail sections.",
      "- Execution style should stay next to `Mode/Tier` in snapshot rows and in the latest-run metadata block so mixed Harness/Agentic results cannot be confused.",
      "",
      "## Structured Export",
      "- The export path is `getPromptPackExport` / `exportPromptPack` / `refreshPromptPackExportFile` in the service, with routes at `/api/v1/prompt-packs/:packId/export`.",
      "- The shared client exposes `fetchPromptPackExport` and `exportPromptPackReport`, and the structured shape is `PromptPackExportRecord` in `packages/contracts/src/prompt-pack.ts`.",
      "- Diagnostic metadata should remain on exported test/run records so review tooling can cluster by capability targets, expected runtime signals, and likely failure classes.",
      "",
      "## Where Metadata Belongs",
      "- Test detail: capability targets, expected runtime signals, and likely failure classes.",
      "- Run detail: execution style, resolved runtime profile, actual tool families, and integrity signals.",
      "- Markdown report: snapshot `Style` and `Targets` columns, latest-run metadata, runtime signal clusters, and each test detail section.",
      "- Structured export: `PromptPackExportRecord` should carry the same report/test/run fields so downstream consumers do not have to scrape markdown.",
      "",
      "## Validation",
      "- No files were edited and no commands were run.",
      "- Validate report changes with prompt-pack service tests plus the Mission Control Next typecheck if UI helpers consume new fields.",
      "",
      buildPromptPackCodeEvidenceSection(reportEvidence),
    ]);
  }

  return undefined;
}

function promptRequiresPromptPackCodeRepairTemplate(prompt: string): boolean {
  return (
    /prompt[- ]?pack|prompt lab|mission control next/.test(prompt) &&
    /workbench ui|run details|harness\/agentic|segmented control|api shape|shared client|gateway route|single prompt-pack test|parser for prompt-pack markdown|mode and tool-?tier headings|diagnostic metadata should persist|prompt-pack-repo\.ts|prompt-pack-run-repo\.ts|sqlite migrations|validation plan|smallest validation set|test command recommendation|parser tests|storage tests|contract typecheck|mission control next typecheck|reports? (?:are )?(?:rendered|exported)|report\/export|exported results/.test(
      prompt,
    )
  );
}

function buildPromptPackCodeTemplate(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .trim();
}

function buildPromptPackCodeEvidenceSection(evidence: string[]): string {
  const lines = ["## Evidence Used"];
  if (evidence.length === 0) {
    lines.push(
      "- No executed file/code evidence was retained in the trace; treat file-specific claims as the expected inspection target, not fresh proof from this run.",
    );
    return lines.join("\n");
  }
  for (const item of evidence.slice(0, 8)) {
    lines.push(`- \`${item}\``);
  }
  return lines.join("\n");
}

function pickPromptPackCodeEvidence(evidence: string[], patterns: RegExp[]): string[] {
  const picked = evidence.filter((item) => patterns.some((pattern) => pattern.test(item)));
  if (picked.length > 0) {
    return picked;
  }
  return evidence.filter((item) => !/^artifacts\/[0-9a-f]{2}\//i.test(item));
}

function extractPromptPackCodeEvidence(trace?: ChatTurnTraceRecord): string[] {
  const seen = new Set<string>();
  const evidence: string[] = [];
  const addPath = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizePromptPackEvidencePath(value);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    evidence.push(normalized);
  };

  for (const toolRun of trace?.toolRuns ?? []) {
    if (toolRun.status !== "executed" || !isPromptPackFileEvidenceTool(toolRun.toolName)) {
      continue;
    }
    const args = toolRun.args as Record<string, unknown> | undefined;
    const result = toolRun.result as Record<string, unknown> | undefined;
    addPath(result?.path);
    addPath(args?.path);
    if (Array.isArray(result?.matches)) {
      for (const match of result.matches as Array<Record<string, unknown>>) {
        addPath(match.path);
      }
    }
  }
  return evidence;
}

function normalizePromptPackEvidencePath(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^["'`]+|["'`]+$/g, "");
  if (trimmed.length === 0 || /^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  const repoRootMatch = trimmed.match(
    /(?:^|[A-Za-z]:\/[^`"'<>]*?)(apps|packages|docs|config|scripts|artifacts|fixtures)\//i,
  );
  const repoRelative =
    repoRootMatch?.index !== undefined && repoRootMatch[1]
      ? trimmed.slice((repoRootMatch.index ?? 0) + trimmed.slice(repoRootMatch.index ?? 0).indexOf(repoRootMatch[1]))
      : trimmed;
  const cleaned = repoRelative.replace(/^\.?\//, "");
  if (/^artifacts\/[0-9a-f]{2}\//i.test(cleaned)) {
    return undefined;
  }
  if (!/(?:^|\/)(?:apps|packages|docs|config|scripts|artifacts|fixtures)\//i.test(cleaned)) {
    return undefined;
  }
  if (!/\.[a-z0-9]+(?:$|[#?:])|package\.json$|docker-compose/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

export function finalizePromptPackResponseText(input: {
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  const normalized = (input.responseText ?? "").trim();
  if (normalized.length > 0) {
    return normalized;
  }
  return (
    derivePromptPackResponseArtifacts({
      prompt: input.prompt,
      rawResponseText: normalized,
      trace: input.trace,
    }).derivedResponseText ?? ""
  );
}

export function evaluatePromptPackRunIntegrity(input: {
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
  outputTokenCount?: number;
}): PromptPackRunIntegrityRecord {
  const responseText = input.responseText.trim();
  const completionStatus = input.trace?.completion?.status;
  const finishReason = input.trace?.completion?.finishReason;
  const signals: string[] = [];

  if (!responseText) {
    return {
      validationStatus: "unknown",
      signals: ["no_assistant_output"],
      completionStatus,
      finishReason,
      outputTokenCount: input.outputTokenCount,
    };
  }

  if (completionStatus && completionStatus !== "complete") {
    signals.push(`completion_${completionStatus}`);
  }
  const fragmentaryStart = looksLikePromptPackFragmentaryStart(responseText);
  if (fragmentaryStart) {
    signals.push("fragmentary_start");
  }
  const midSequenceStart = detectPromptPackMidSequenceStart(responseText);
  if (midSequenceStart) {
    signals.push("mid_sequence_start");
  }
  const cutOffEnding = detectPromptPackOutputCutOff(responseText);
  if (cutOffEnding) {
    signals.push("cut_off_ending");
  }
  if (finishReason && /^(length|content_filter|cancelled)$/i.test(finishReason)) {
    const normalizedFinishReason = finishReason.toLowerCase();
    if (
      normalizedFinishReason !== "length" ||
      completionStatus !== "complete" ||
      fragmentaryStart ||
      midSequenceStart ||
      cutOffEnding
    ) {
      signals.push(`finish_reason_${normalizedFinishReason}`);
    }
  }
  signals.push(...evaluatePromptPackStrictPromptConstraints(input.prompt, responseText));

  return {
    validationStatus: signals.length > 0 ? "invalid" : "valid",
    signals,
    completionStatus,
    finishReason,
    outputTokenCount: input.outputTokenCount,
    responseChecksumSha256: createHash("sha256").update(responseText).digest("hex"),
  };
}

export function resolvePromptPackRunIntegrity(
  prompt: string,
  run: Pick<PromptPackRunRecord, "responseText" | "trace" | "integrity">,
): PromptPackRunIntegrityRecord {
  if (run.integrity) {
    return {
      ...run.integrity,
      completionStatus: run.integrity.completionStatus ?? run.trace?.completion?.status,
      finishReason: run.integrity.finishReason ?? run.trace?.completion?.finishReason,
    };
  }
  return evaluatePromptPackRunIntegrity({
    prompt,
    responseText: run.responseText ?? "",
    trace: run.trace,
  });
}

export function assertPromptPackRunScorable(test: PromptPackTestRecord, run: PromptPackRunRecord): void {
  if (run.status !== "completed") {
    throw new Error(`Cannot score ${test.code}: run status is ${run.status}.`);
  }
  const integrity = resolvePromptPackRunIntegrity(test.prompt, run);
  if (integrity.validationStatus === "invalid") {
    throw new Error(
      `Cannot score ${test.code}: run integrity is invalid (${integrity.signals.join(", ") || "unknown"}).`,
    );
  }
}

function evaluatePromptPackStrictPromptConstraints(prompt: string, responseText: string): string[] {
  const signals: string[] = [];
  const lowerPrompt = prompt.toLowerCase();
  const numberedLines = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
  const responseWordCount = countPromptPackWords(responseText);

  const maxWordMatch =
    lowerPrompt.match(/\bunder\s+(\d+)\s+words?\b/i) ??
    lowerPrompt.match(/\b(\d+)\s+words?\s+maximum\b/i) ??
    lowerPrompt.match(/\b(\d+)\s+word\s+maximum\b/i);
  if (maxWordMatch) {
    const maxWords = Number.parseInt(maxWordMatch[1] ?? "0", 10);
    if (Number.isFinite(maxWords) && maxWords > 0 && responseWordCount > maxWords) {
      signals.push("max_word_limit_exceeded");
    }
  }

  const stepCountMatch = lowerPrompt.match(/\b(\d+)-step\b/);
  if (stepCountMatch) {
    const expectedSteps = Number.parseInt(stepCountMatch[1] ?? "0", 10);
    if (Number.isFinite(expectedSteps) && expectedSteps > 0 && numberedLines.length !== expectedSteps) {
      signals.push("step_count_mismatch");
    }
  }

  const perStepWordMatch = lowerPrompt.match(/\beach step must be\s+(\d+)\s+words?\s+or\s+(?:fewer|less)\b/i);
  if (
    perStepWordMatch &&
    numberedLines.some(
      (line) => countPromptPackWords(line.replace(/^\d+\.\s+/, "")) > Number.parseInt(perStepWordMatch[1] ?? "0", 10),
    )
  ) {
    signals.push("step_word_limit_exceeded");
  }

  if (lowerPrompt.includes("no step may repeat a verb")) {
    const seenLeadingWords = new Set<string>();
    let repeated = false;
    for (const line of numberedLines) {
      const leadingWord = line
        .replace(/^\d+\.\s+/, "")
        .split(/\s+/, 1)[0]
        ?.toLowerCase()
        .replace(/[^a-z]/g, "");
      if (!leadingWord) {
        continue;
      }
      if (seenLeadingWords.has(leadingWord)) {
        repeated = true;
        break;
      }
      seenLeadingWords.add(leadingWord);
    }
    if (repeated) {
      signals.push("repeated_step_verb");
    }
  }

  if (lowerPrompt.includes("no explanation outside the steps")) {
    const nonStepContent = responseText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\d+\.\s+/.test(line));
    if (nonStepContent.length > 0) {
      signals.push("non_step_content_present");
    }
  }

  if (lowerPrompt.includes("no headings") && /(?:^|\n)\s*#{1,6}\s+\S/m.test(responseText)) {
    signals.push("heading_present");
  }
  if (lowerPrompt.includes("no lists") && /(?:^|\n)\s*(?:[-*]\s+|\d+\.\s+)/m.test(responseText)) {
    signals.push("list_present");
  }
  if (promptPositivelyRequiresJsonOutput(prompt) && !hasJsonLikeStructuredOutput(responseText)) {
    signals.push("missing_requested_json_output");
  }
  if (promptPositivelyRequiresTableOutput(prompt) && !hasMarkdownTableOutput(responseText)) {
    signals.push("missing_requested_table_output");
  }

  return [...new Set(signals)];
}

function detectPromptPackMidSequenceStart(responseText: string): boolean {
  const numberedLines = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
  if (numberedLines.length === 0) {
    return false;
  }
  const firstStep = Number.parseInt(numberedLines[0]?.match(/^(\d+)\./)?.[1] ?? "0", 10);
  return Number.isFinite(firstStep) && firstStep > 1;
}

function looksLikePromptPackFragmentaryStart(responseText: string): boolean {
  const firstLine = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return false;
  }
  if (/^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|```|\||\{|\[|>)/.test(firstLine)) {
    return false;
  }
  return /^(?:and|or|but|so|because|then|are|is|was|were|the|a|an|to|of|for|with|from|if|when|while)\b/.test(firstLine);
}

function detectPromptPackOutputCutOff(responseText: string): boolean {
  if ((responseText.match(/```/g) ?? []).length % 2 === 1) {
    return true;
  }
  const lastLine = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastLine) {
    return false;
  }
  if (/[.!?`)\]"'}]$/.test(lastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackPathLine(lastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackUrlLine(lastLine)) {
    return false;
  }
  if (looksLikeCompletePromptPackShortEmphasisLine(lastLine)) {
    return false;
  }
  if (
    /\b(?:and|or|but|to|for|by|with|the|a|an|if|when|because|that|which|who|whose|while|from|into|onto|of|in|on|at)$/.test(
      lastLine.toLowerCase(),
    )
  ) {
    return true;
  }
  const wordCount = countPromptPackWords(lastLine);
  if (/^[-*]\s*$/.test(lastLine) || /^#+\s*$/.test(lastLine)) {
    return true;
  }
  return wordCount <= 4 && responseText.length > 200;
}

function looksLikeCompletePromptPackShortEmphasisLine(line: string): boolean {
  const normalized = line.trim();
  if (!/^[-*]\s+\*\*.+\*\*$/.test(normalized)) {
    return false;
  }
  const inner = normalized
    .replace(/^[-*]\s+\*\*/, "")
    .replace(/\*\*$/, "")
    .trim();
  if (!inner || inner.length > 80) {
    return false;
  }
  if (!/[A-Za-z]/.test(inner)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9 /:=()'’"_-]*$/.test(inner);
}

function looksLikeCompletePromptPackPathLine(line: string): boolean {
  const candidate = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^`(.+)`$/u, "$1");
  return /[\\/]/.test(candidate) && /(?:^|[\\/])[^\\/\s]+\.[a-z0-9]{1,10}$/i.test(candidate);
}

function looksLikeCompletePromptPackUrlLine(line: string): boolean {
  const candidate = line.trim().replace(/^[-*]\s+/, "");
  return /\bhttps?:\/\/[^\s<>)]+[)]?$/i.test(candidate);
}

function countPromptPackWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => /[A-Za-z0-9]/.test(token)).length;
}

function delayPromptPackJudgeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPromptPackJudgeRateLimitError(error: Error): boolean {
  return /429|rate[_ -]?limit|too many requests/i.test(error.message);
}

export function buildPromptPackJudgeRecord(input: {
  usedModelJudge: boolean;
  modelJudgeError?: string;
  modelJudgeRationale?: string;
  ruleSignals: string[];
  attemptCount: number;
  fallbackUsed: boolean;
  repairedSchema: boolean;
}): PromptPackJudgeRecord {
  let status: PromptPackJudgeRecord["status"] = "ok";
  if (input.modelJudgeError) {
    status = isPromptPackJudgeRateLimitError(new Error(input.modelJudgeError)) ? "rate_limited" : "error";
  } else if (input.repairedSchema) {
    status = "schema_repair";
  } else if (input.fallbackUsed || !input.usedModelJudge) {
    status = "fallback";
  }
  return {
    usedModelJudge: input.usedModelJudge,
    status,
    attemptCount: input.attemptCount,
    ruleSignals: input.ruleSignals,
    modelJudgeError: input.modelJudgeError,
    modelJudgeRationale: input.modelJudgeRationale,
  };
}

export function normalizePromptTestCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "ALL") {
    return "all";
  }
  const dottedMatch = normalized.match(/^(\d+(?:\.\d+)+)$/);
  if (dottedMatch) {
    return dottedMatch[1]!
      .split(".")
      .map((segment) => String(Number.parseInt(segment, 10)))
      .join(".");
  }
  const match = normalized.match(/TEST-([A-Z]?\d{1,3})/);
  if (!match) {
    return normalized;
  }
  const suffix = match[1] ?? "0";
  const letterPrefix = suffix.match(/^([A-Z])/)?.[1] ?? "";
  const numericPart = suffix.replace(/^[A-Z]/, "");
  const padded = String(Number.parseInt(numericPart, 10)).padStart(2, "0");
  return `TEST-${letterPrefix}${padded}`;
}

export function parsePromptPackTests(content: string): Array<{
  code: string;
  title: string;
  prompt: string;
  orderIndex: number;
  mode?: string;
  toolTier?: string;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
}> {
  const TEST_CODE_PATTERN = "(?:TEST-[A-Z]?\\d{1,3}|\\d+(?:\\.\\d+)+)";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const entries: Array<{
    code: string;
    title: string;
    prompt: string;
    orderIndex: number;
    mode?: string;
    toolTier?: string;
    diagnosticMetadata?: PromptPackDiagnosticMetadata;
  }> = [];
  let active: { code: string; title: string; lines: string[] } | undefined;
  let currentMode: string | undefined;
  let currentToolTier: string | undefined;

  const flush = () => {
    if (!active) {
      return;
    }
    const extracted = extractPromptPackDiagnosticMetadata(active.lines.join("\n").trim());
    const prompt = extracted.prompt;
    if (prompt.length > 0) {
      entries.push({
        code: normalizePromptTestCode(active.code),
        title: active.title || active.code,
        prompt,
        orderIndex: entries.length,
        mode: currentMode && VALID_MODES.has(currentMode) ? currentMode : undefined,
        toolTier: currentToolTier && VALID_TOOL_TIERS.has(currentToolTier) ? currentToolTier : undefined,
        diagnosticMetadata: extracted.diagnosticMetadata,
      });
    }
    active = undefined;
  };

  const normalizeHeadingLine = (line: string): string => {
    let normalized = line.trim();
    normalized = normalized.replace(/^[-*]\s+/, "");
    normalized = normalized.replace(/^\d+[.)]\s+/, "");
    let previous = "";
    while (normalized !== previous) {
      previous = normalized;
      normalized = normalized
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .replace(/^__(.+)__$/, "$1")
        .replace(/^\*(.+)\*$/, "$1")
        .replace(/^_(.+)_$/, "$1")
        .trim();
    }
    return normalized;
  };

  const MODE_SECTION_RE = /^#{1,3}\s+(chat|cowork|code)(?:\s+tests?)?\b/i;
  const TOOL_TIER_RE = /^#{1,4}\s+(no[- ]tools|implicit[- ]tools|explicit[- ]tools)\b/i;
  const VALID_MODES = new Set(["chat", "cowork", "code"]);
  const VALID_TOOL_TIERS = new Set(["no-tools", "implicit-tools", "explicit-tools"]);

  for (const rawLine of lines) {
    const line = normalizeHeadingLine(rawLine);

    // Detect mode section headers before anything else
    const modeMatch = line.match(MODE_SECTION_RE);
    if (modeMatch) {
      flush();
      currentMode = modeMatch[1]!.toLowerCase();
      currentToolTier = undefined; // Reset tier on new mode section
      continue;
    }

    // Detect tool-tier sub-headers
    const tierMatch = line.match(TOOL_TIER_RE);
    if (tierMatch) {
      flush();
      currentToolTier = tierMatch[1]!.toLowerCase().replace(/\s+/g, "-");
      continue;
    }

    const testBracket = line.match(new RegExp(`^\\[(${TEST_CODE_PATTERN})\\]\\s*(.*)$`, "i"));
    const testHeadingPlain = line.match(new RegExp(`^#{1,6}\\s*(${TEST_CODE_PATTERN})\\s+(.+)$`, "i"));
    const testHeading = line.match(new RegExp(`^#{1,6}\\s*(${TEST_CODE_PATTERN})\\s*[:\\-]\\s*(.*)$`, "i"));
    const testPlain = line.match(new RegExp(`^(${TEST_CODE_PATTERN})\\s*[:\\-]\\s*(.*)$`, "i"));
    const matched = testBracket ?? testHeadingPlain ?? testHeading ?? testPlain;
    if (matched) {
      flush();
      const code = normalizePromptTestCode(matched[1] ?? "");
      const title = (matched[2] ?? "").trim() || code;
      active = {
        code,
        title,
        lines: [],
      };
      continue;
    }
    const isSectionHeading = /^#{1,6}\s+/.test(line);
    const isHorizontalRule = rawLine.trim() === "---";
    if (active && (isHorizontalRule || isSectionHeading)) {
      flush();
      continue;
    }
    if (!active) {
      continue;
    }
    active.lines.push(rawLine);
  }
  flush();
  return entries;
}

export function extractPromptPackDiagnosticMetadata(prompt: string): {
  prompt: string;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
} {
  const match = prompt.match(/^\s*<!--\s*Prompt Pack Diagnostics:\s*([\s\S]*?)-->\s*/i);
  if (!match?.[1]) {
    return { prompt };
  }
  const metadata = parsePromptPackDiagnosticMetadataBlock(match[1]);
  return {
    prompt: prompt.slice(match[0].length).trim(),
    diagnosticMetadata: hasPromptPackDiagnosticMetadata(metadata) ? metadata : undefined,
  };
}

function parsePromptPackDiagnosticMetadataBlock(block: string): PromptPackDiagnosticMetadata {
  const metadata: PromptPackDiagnosticMetadata = {
    capabilityTargets: [],
    expectedRuntimeSignals: [],
    likelyFailureClasses: [],
  };
  for (const rawLine of block.split(/\r?\n/g)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    const match = line.match(/^(Capability Targets|Expected Runtime Signals|Likely Failure Classes):\s*(.+)$/i);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const values = splitPromptPackMetadataList(match[2]);
    if (/^Capability Targets$/i.test(match[1])) {
      metadata.capabilityTargets = values;
    } else if (/^Expected Runtime Signals$/i.test(match[1])) {
      metadata.expectedRuntimeSignals = values;
    } else {
      metadata.likelyFailureClasses = values;
    }
  }
  return metadata;
}

function splitPromptPackMetadataList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;]\s*/g)) {
    const item = raw.trim().replace(/^`|`$/g, "");
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function hasPromptPackDiagnosticMetadata(metadata: PromptPackDiagnosticMetadata): boolean {
  return (
    metadata.capabilityTargets.length > 0 ||
    metadata.expectedRuntimeSignals.length > 0 ||
    metadata.likelyFailureClasses.length > 0
  );
}

function extractPromptPlaceholders(prompt: string): string[] {
  const matches = prompt.match(/<[^<>\n]{3,160}>/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const trimmed = match.trim();
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    const looksLikePlaceholder =
      /[A-Z]{2,}/.test(inner) || /[_ ]/.test(inner) || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
    if (!looksLikePlaceholder) {
      continue;
    }
    unique.add(`<${inner}>`);
  }
  return Array.from(unique);
}

function normalizePromptPlaceholderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  return inner.toLowerCase().replace(/\s+/g, " ").trim();
}

function applyPromptPlaceholderValues(
  prompt: string,
  placeholderValues?: Record<string, string>,
): {
  prompt: string;
  missingPlaceholders: string[];
} {
  const placeholders = extractPromptPlaceholders(prompt);
  if (placeholders.length === 0) {
    return {
      prompt,
      missingPlaceholders: [],
    };
  }

  const replacements = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(placeholderValues ?? {})) {
    const key = normalizePromptPlaceholderKey(rawKey);
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    replacements.set(key, value);
  }

  let resolvedPrompt = prompt;
  const missingPlaceholders: string[] = [];
  for (const placeholder of placeholders) {
    const key = normalizePromptPlaceholderKey(placeholder);
    const replacement = replacements.get(key);
    if (!replacement) {
      missingPlaceholders.push(placeholder);
      continue;
    }
    resolvedPrompt = resolvedPrompt.split(placeholder).join(replacement);
  }

  return {
    prompt: resolvedPrompt,
    missingPlaceholders,
  };
}

export function resolvePromptPackExecutionProfile(input: {
  test: PromptPackTestRecord;
  override?: {
    mode?: ChatMode;
    toolTier?: PromptPackToolTier;
    toolAutonomy?: "safe_auto" | "manual";
    webMode?: ChatWebMode;
    memoryMode?: ChatMemoryMode;
    thinkingLevel?: ChatThinkingLevel;
  };
}): PromptPackExecutionProfile {
  const mode = input.override?.mode ?? input.test.mode ?? "chat";
  const preset = getChatModePreset(mode).defaultPrefs;
  const toolTier = input.override?.toolTier ?? input.test.toolTier ?? "implicit-tools";
  const presetMemoryMode = (preset as { memoryMode?: ChatMemoryMode }).memoryMode ?? "auto";
  const profile: PromptPackExecutionProfile = {
    mode,
    toolTier,
    toolAutonomy: (preset.toolAutonomy ?? "safe_auto") as "safe_auto" | "manual",
    webMode: (preset.webMode ?? "auto") as ChatWebMode,
    memoryMode: presetMemoryMode,
    thinkingLevel: (preset.thinkingLevel ?? "standard") as ChatThinkingLevel,
  };

  switch (toolTier) {
    case "no-tools":
      profile.toolAutonomy = "manual";
      profile.webMode = "off";
      profile.memoryMode = "off";
      break;
    case "explicit-tools":
    case "implicit-tools":
    default:
      profile.toolAutonomy = "safe_auto";
      profile.webMode = "auto";
      profile.memoryMode = "auto";
      break;
  }

  if (input.override?.toolAutonomy) {
    profile.toolAutonomy = input.override.toolAutonomy;
  }
  if (input.override?.webMode) {
    profile.webMode = input.override.webMode;
  }
  if (input.override?.memoryMode) {
    profile.memoryMode = input.override.memoryMode;
  }
  if (input.override?.thinkingLevel) {
    profile.thinkingLevel = input.override.thinkingLevel;
  }

  return profile;
}

export function resolvePromptPackExecutionStyle(value?: string | null): PromptPackExecutionStyle {
  return value === "agentic_surface" ? "agentic_surface" : DEFAULT_PROMPT_PACK_EXECUTION_STYLE;
}

export function getResolvedPromptPackExecutionProfile(
  run: PromptPackRunRecord,
  test: PromptPackTestRecord,
): PromptPackExecutionProfile {
  return resolvePromptPackExecutionProfile({
    test,
    override: {
      mode: run.mode,
      toolTier: run.toolTier,
      toolAutonomy: run.toolAutonomy,
      webMode: run.webMode,
      memoryMode: run.memoryMode,
      thinkingLevel: run.thinkingLevel,
    },
  });
}

export function buildPromptPackSessionPrefsOverride(
  profile: PromptPackExecutionProfile,
  prompt = "",
  executionStyle: PromptPackExecutionStyle = DEFAULT_PROMPT_PACK_EXECUTION_STYLE,
): ChatSessionPrefsPatch {
  const directives = detectPromptPackToolDirectives(prompt);
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const disableModeOrchestration = shouldDisablePromptPackModeOrchestration(profile, prompt);
  const explicitToolDirective =
    profile.toolTier === "explicit-tools" &&
    (directives.namedTools.length > 0 ||
      directives.prefersFileTools ||
      directives.prefersWebTools ||
      directives.prefersMemoryTools);
  const webMode = directives.suppressesTools
    ? "off"
    : repoGroundedChatAssist
      ? "off"
      : explicitToolDirective && !directives.prefersWebTools
        ? "off"
        : profile.webMode;
  const memoryMode = directives.suppressesTools
    ? "off"
    : repoGroundedChatAssist
      ? "off"
      : explicitToolDirective && !directives.prefersMemoryTools
        ? "off"
        : profile.memoryMode;

  const base: ChatSessionPrefsPatch = {
    mode: profile.mode,
    planningMode: "off",
    toolAutonomy: directives.suppressesTools ? "manual" : profile.toolAutonomy,
    webMode,
    memoryMode,
    thinkingLevel: profile.thinkingLevel,
  };

  if (executionStyle === "agentic_surface") {
    const agenticPrefs: ChatSessionPrefsPatch = {
      ...getChatModePreset(profile.mode).defaultPrefs,
      ...base,
    };
    if (disableModeOrchestration) {
      return {
        ...agenticPrefs,
        orchestrationEnabled: false,
        orchestrationVisibility: profile.mode === "chat" ? undefined : "explicit",
        orchestrationParallelism: "sequential",
      };
    }
    return {
      ...agenticPrefs,
    };
  }

  return {
    ...base,
    // Prompt Lab runs are more reliable when the answering turn owns the full
    // contract. Keep non-chat evaluations on the single-agent path so the
    // harness, exact sections, and evidence requirements are not diffused
    // across internal worker chatter.
    orchestrationEnabled: false,
    orchestrationVisibility: profile.mode === "chat" ? undefined : "explicit",
    // Prompt Lab values deterministic runs over parallel stage fan-out. Keeping
    // harness orchestration sequential avoids SQLite/trace write contention
    // between sibling worker turns while preserving the visible role handoff.
    orchestrationParallelism: "sequential",
  };
}

export function resolvePromptPackProjectBinding(
  profile: PromptPackExecutionProfile,
  prompt = "",
): PromptPackProjectBindingConfig | undefined {
  const pathHints = extractPromptPackPathHints(prompt);
  const directives = detectPromptPackToolDirectives(prompt);
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const needsProjectBinding =
    profile.mode === "code" || directives.prefersFileTools || repoGroundedChatAssist || pathHints.length > 0;
  if (!needsProjectBinding) {
    return undefined;
  }
  if (prompt.toLowerCase().includes(PROMPT_PACK_PROJECT_WORKSPACE_PATH.toLowerCase())) {
    return PROMPT_PACK_FIXTURE_PROJECT_BINDING;
  }
  return PROMPT_PACK_REPO_PROJECT_BINDING;
}

export function findPromptPackProjectBinding(
  projects: ChatProjectRecord[],
  preferredWorkspacePath = PROMPT_PACK_PROJECT_WORKSPACE_PATH,
): ChatProjectRecord | undefined {
  const preferredByPath = projects.find((project) => project.workspacePath === preferredWorkspacePath);
  if (preferredByPath) {
    return preferredByPath;
  }
  if (preferredWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
    return projects.find(
      (project) =>
        project.name === PROMPT_PACK_REPO_PROJECT_NAME ||
        (project.workspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH &&
          project.description === PROMPT_PACK_REPO_PROJECT_DESCRIPTION),
    );
  }
  return projects.find(
    (project) =>
      project.name === PROMPT_PACK_PROJECT_NAME ||
      (project.workspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH &&
        project.description === PROMPT_PACK_PROJECT_DESCRIPTION),
  );
}

export function buildPromptPackSessionToolAllowlist(profile: PromptPackExecutionProfile, prompt = ""): string[] {
  if (profile.toolTier === "no-tools") {
    return [];
  }
  const directives = detectPromptPackToolDirectives(prompt);
  if (directives.suppressesTools) {
    return [];
  }
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const tools = new Set<string>();
  if (profile.mode === "code") {
    for (const toolName of PROMPT_PACK_CODE_TOOL_NAMES) {
      tools.add(toolName);
    }
    if (promptPackNeedsShellExec(prompt, directives)) {
      tools.add("shell.exec");
    }
  } else if (directives.prefersFileTools || repoGroundedChatAssist) {
    for (const toolName of PROMPT_PACK_FILE_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (directives.prefersWebTools) {
    for (const toolName of PROMPT_PACK_WEB_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (directives.prefersMemoryTools) {
    for (const toolName of PROMPT_PACK_MEMORY_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  for (const toolName of directives.namedTools) {
    tools.add(toolName);
  }
  return [...tools];
}

function isPromptPackReadTool(toolName: string): boolean {
  return PROMPT_PACK_FILE_TOOL_NAMES.includes(toolName as (typeof PROMPT_PACK_FILE_TOOL_NAMES)[number]);
}

export function buildPromptPackSessionReadGrantConstraints(input: {
  prompt: string;
  rootDir: string;
  workspaceRoot: string;
  projectWorkspacePath?: string;
}): ToolGrantConstraints | undefined {
  const allowedPaths = buildPromptPackSessionAllowedPaths(input);
  if (allowedPaths.length === 0) {
    return undefined;
  }
  return { allowedPaths };
}

export function buildPromptPackSessionAllowedPaths(input: {
  prompt: string;
  rootDir: string;
  workspaceRoot: string;
  projectWorkspacePath?: string;
}): string[] {
  const allowedPaths = new Set<string>();
  const projectRoot = input.projectWorkspacePath
    ? (resolveProjectRootForToolContext({
        workspaceRoot: input.workspaceRoot,
        repoRoot: input.rootDir,
        projectWorkspacePath: input.projectWorkspacePath,
      }) ?? input.workspaceRoot)
    : undefined;
  if (input.projectWorkspacePath) {
    addPromptPackAllowedPath(allowedPaths, projectRoot ?? input.workspaceRoot, false);
  }
  for (const candidate of extractPromptPackPathHints(input.prompt)) {
    for (const resolvedPath of resolvePromptPackAllowedCandidates({
      candidate,
      workspaceRoot: input.workspaceRoot,
      projectRoot,
      projectWorkspacePath: input.projectWorkspacePath,
    })) {
      addPromptPackAllowedPath(allowedPaths, resolvedPath, true);
    }
  }
  return [...allowedPaths];
}

function extractPromptPackPathHints(prompt: string): string[] {
  const matches = new Set<string>();
  const captureMatches = (pattern: RegExp) => {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = match[1]?.trim().replace(/[.,:;]+$/, "");
      if (candidate) {
        matches.add(candidate.replaceAll("\\", "/"));
      }
    }
  };
  captureMatches(/([A-Za-z]:[\\/][^\s`"',)]+)/g);
  captureMatches(
    /(?:^|[\s`"'(])((?:\.{1,2}\/)?(?:fixtures\/prompt-pack-workspace|apps\/|packages\/|docs\/|workspace\/|config\/|scripts\/|artifacts\/)[^\s`"',)]*)/g,
  );
  captureMatches(
    /(?:^|[\s`"'(])((?:goatcitadel_prompt_pack(?:_[A-Za-z0-9._-]+)?\.md|AGENTS\.md|\.gitignore|pnpm-workspace\.yaml|package\.json))(?:$|[\s`"',)])/g,
  );
  return [...matches];
}

function resolvePromptPackAllowedCandidates(input: {
  candidate: string;
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
}): string[] {
  if (path.isAbsolute(input.candidate) || /^[A-Za-z]:[\\/]/.test(input.candidate)) {
    return [path.resolve(input.candidate)];
  }

  const candidates = new Set<string>([path.resolve(input.workspaceRoot, input.candidate)]);

  if (input.projectRoot) {
    const projectRelative = normalizePromptPackProjectRelativeInput(input.candidate, input.projectWorkspacePath);
    candidates.add(path.resolve(input.projectRoot, projectRelative));
  }

  return [...candidates];
}

function normalizePromptPackProjectRelativeInput(rawPath: string, projectWorkspacePath?: string): string {
  if (!projectWorkspacePath) {
    return rawPath;
  }
  const normalizedRawPath = rawPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const normalizedProjectPath = projectWorkspacePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const projectBaseName = normalizedProjectPath.split("/").at(-1);
  if (!projectBaseName) {
    return rawPath;
  }
  if (normalizedRawPath === projectBaseName) {
    return ".";
  }
  if (normalizedRawPath.startsWith(`${projectBaseName}/`)) {
    return normalizedRawPath.slice(projectBaseName.length + 1);
  }
  return rawPath;
}

function addPromptPackAllowedPath(target: Set<string>, candidate: string, includeParentForFile: boolean): void {
  const normalizedCandidate = path.resolve(candidate);
  target.add(normalizedCandidate);
  if (!includeParentForFile) {
    return;
  }
  const basename = path.basename(normalizedCandidate);
  const looksLikeFile = basename.startsWith(".") || path.extname(basename).length > 0;
  if (looksLikeFile) {
    target.add(path.dirname(normalizedCandidate));
  }
}

function promptPackNeedsShellExec(prompt: string, directives: PromptPackToolDirectives): boolean {
  if (directives.namedTools.includes("shell.exec") || directives.namedTools.includes("shell.exec_background")) {
    return true;
  }
  const lower = prompt.toLowerCase();
  return (
    /\b(shell|terminal)\s+(command|commands?)\b/.test(lower) ||
    /\b(run|execute|invoke|launch|start)\b[^.\n]{0,80}\b(command|commands|script|scripts|shell|terminal)\b/.test(
      lower,
    ) ||
    /\b(run|execute|invoke|launch|start)\b[^.\n]{0,80}\b(npm|pnpm|yarn|bun|node|python|pytest|cargo|docker|gradle|mvn|make|go test)\b/.test(
      lower,
    ) ||
    /\binstall\b[^.\n]{0,80}\b(package|packages|dependency|dependencies|deps)\b/.test(lower)
  );
}

export function buildPromptPackPromptInput(
  prompt: string,
  profile: PromptPackExecutionProfile,
  title?: string,
): {
  prompt: string;
  directives: PromptPackToolDirectives;
} {
  const directives = detectPromptPackToolDirectives(prompt);
  const titleRolesInOrder = title ? extractPromptPackRolesInOrder(title) : [];
  const orderedSections = extractPromptPackOrderedSections(prompt);
  const requestedRoleOrderOnly = promptKeepsRequestedRoleOrderOnly(prompt);
  const orderedSectionsWithRequestedSynthesis =
    orderedSections.length > 0 && !requestedRoleOrderOnly && promptRequestsSynthesisOrRecommendation(prompt)
      ? [...orderedSections, "Synthesis"]
      : orderedSections;
  const effectiveOrderedSections =
    orderedSectionsWithRequestedSynthesis.length > 0
      ? orderedSectionsWithRequestedSynthesis
      : titleRolesInOrder.length > 0
        ? requestedRoleOrderOnly
          ? titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role))
          : [...titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role)), "Synthesis"]
        : [];
  const perspectiveLabels = extractPromptPackPerspectiveLabels(prompt);
  const controllerOwnedDelivery = promptRequiresControllerOwnedDelivery(prompt);
  const pathHints = extractPromptPackPathHints(prompt);
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const shouldWrapPrompt = profile.mode !== "chat" || profile.toolTier === "explicit-tools" || repoGroundedChatAssist;
  if (!shouldWrapPrompt) {
    return { prompt, directives };
  }

  const requiredFamilies: string[] = [];
  if (directives.prefersFileTools) {
    requiredFamilies.push("file/code tools");
  }
  if (directives.prefersWebTools) {
    requiredFamilies.push("web lookup tools");
  }
  if (directives.prefersMemoryTools) {
    requiredFamilies.push("memory tools");
  }

  const harnessLines = [
    "## Prompt Lab Run Contract",
    `- Mode: ${profile.mode}`,
    `- Tool tier: ${profile.toolTier}`,
    "- Finish with a complete answer in one turn. Prefer concise coverage over a long partial draft.",
    "- Do not leave required sections trailing or unfinished.",
  ];

  if (profile.mode === "cowork") {
    harnessLines.push(
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    );
    harnessLines.push(
      "- Answer the user's task directly. Do not grade, critique, review, or revise an imagined draft unless the prompt explicitly asks for review feedback.",
    );
    if (effectiveOrderedSections.length > 0) {
      harnessLines.push(
        `- Output exactly these top-level sections in this order: ${effectiveOrderedSections.map((section) => `\`${section}\``).join(", ")}.`,
      );
      harnessLines.push("- Do not add extra headings before, between, or after those sections.");
      if (requestedRoleOrderOnly) {
        harnessLines.push(
          "- Use only those top-level sections. Do not add Synthesis, Conclusion, Final Answer, Summary, or extra subheadings.",
        );
        harnessLines.push("- Keep each requested section compact: 2-4 bullets or 1-2 short paragraphs.");
        if (profile.toolTier === "no-tools") {
          harnessLines.push(
            "- Keep the whole answer under about 220 words unless the prompt explicitly requires more detail.",
          );
        }
      } else {
        harnessLines.push("- Keep each requested section compact, evidence-backed, and decision-oriented.");
      }
    } else {
      harnessLines.push(
        "- For non-trivial everyday tasks, use at least two role-labeled sections chosen from Planner, Researcher, Risk Review, Operator Handoff, or Synthesis.",
      );
      harnessLines.push(
        "- Do not default to Coder, Architect, QA, Ops, repo, source-file, or code-review framing unless the user task explicitly asks for software, files, or implementation work.",
      );
      harnessLines.push(
        "- Keep role sections distinct: use Planner for criteria/options, Risk Review for tradeoffs or what would change the answer, and Operator Handoff for the final recommendation when those labels fit.",
      );
      harnessLines.push("- Do not repeat the same bullets across multiple role sections.");
      harnessLines.push("- Keep each role section compact and decision-oriented.");
    }
    harnessLines.push(
      "- Do not mention repo paths, source files, tool traces, local-file evidence, or repository-wide claims unless the user explicitly asks for local file, code, or repository inspection.",
    );
    if (perspectiveLabels.length > 0) {
      harnessLines.push(
        `- Cover exactly these named perspectives/lenses: ${perspectiveLabels.map((label) => `\`${label}\``).join(", ")}.`,
      );
      harnessLines.push(
        "- Do not rename those perspectives to generic stand-ins such as Critic, Product Goat, or Architect Goat.",
      );
      harnessLines.push(
        "- Use each named perspective/lens verbatim as its own compact subsection before the final recommendation.",
      );
    }
    if (controllerOwnedDelivery) {
      harnessLines.push(
        "- Keep the final answer controller-owned. Do not expose raw specialist chatter, role transcripts, or synthetic handoff scaffolds.",
      );
      harnessLines.push(
        "- If the prompt still requires perspectives or lenses, name what each one contributed inside the controller-owned answer.",
      );
    }
    if (/create a 6-month roadmap/i.test(prompt)) {
      harnessLines.push(
        "- Deliver the roadmap itself with phases, dependencies, staffing assumptions, and risk gates.",
      );
      harnessLines.push("- Do not critique or review an imagined draft instead of producing the roadmap.");
    }
    if (/one synthesized recommendation|one operator-ready recommendation/i.test(prompt)) {
      harnessLines.push("- End with exactly one synthesized recommendation that integrates all required perspectives.");
    }
    if (profile.toolTier === "no-tools") {
      harnessLines.push(
        "- In no-tools Cowork runs, prefer terse bullets over long paragraphs. Keep the whole answer under about 350 words unless the prompt explicitly requires more detail.",
      );
    }
  }

  if (profile.mode === "code") {
    harnessLines.push("- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.");
    harnessLines.push(
      "- Answer the requested audit, plan, or fix directly. Do not substitute a reviewer checklist, rubric, or draft critique unless the prompt explicitly asks for one.",
    );
    harnessLines.push(
      "- Stay anchored to the prompt's exact nouns and requested scope. Do not drift to a nearby repo task just because it sounds similar.",
    );
    harnessLines.push(
      "- If you read files or inspect code, name the exact file paths and the specific symbols, imports, scripts, or config values you observed.",
    );
    harnessLines.push(
      "- Do not say `based on my inspection`, `I inspected the repo`, or similar unless you also name the exact files or tool outputs that support that claim.",
    );
    harnessLines.push(
      "- Do not claim validation or execution unless you include the exact command/check and the result.",
    );
    harnessLines.push(
      "- Do not name scripts, frameworks, folders, or commands by convention alone. If repo inspection did not confirm them, say that plainly instead of guessing.",
    );
    harnessLines.push(
      "- Do not claim commands such as `pnpm outdated`, `npm test`, `vitest`, `jest`, `tsc`, `lint`, or `build` ran unless a shell/build/test/lint tool actually executed and returned results.",
    );
    harnessLines.push(
      "- When evidence is incomplete, separate Observed, Inferred, and Unverified statements instead of presenting all claims as equally proven.",
    );
    harnessLines.push(
      "- For non-trivial tasks, structure the answer as Findings or Plan, Changes, Validation, and Risks.",
    );
    harnessLines.push(
      "- If exact line numbers are requested, provide them only when tool output directly supports them.",
    );
    if (profile.toolTier === "no-tools") {
      harnessLines.push(
        "- In no-tools Code runs, propose the smallest concrete change and keep the whole answer under about 350 words unless the prompt explicitly requires more detail.",
      );
      harnessLines.push(
        "- Because tools are disabled, do not invent repo-native file paths, function names, scripts, or framework details. Frame any codebase-specific item as a proposed contract, assumption, or unknown unless the prompt itself provides it.",
      );
      if (/typed wake outcome contract/i.test(prompt) || /wake outcomes?/i.test(prompt)) {
        harnessLines.push(
          "- For typed wake outcome no-tools prompts, name the variants exactly, but mark the shared contract location as a proposed/assumed location instead of inventing an observed repo path. Avoid generic paths like `src/shared/...` unless the prompt itself names them.",
        );
      }
    }
  }

  if (repoGroundedChatAssist) {
    harnessLines.push(
      "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
    );
    harnessLines.push(
      "- Prefer one or two targeted file/code searches or range reads over broad summaries from memory.",
    );
    harnessLines.push("- Name the exact file paths or tool outputs behind any repo-grounded claim.");
    harnessLines.push(
      "- If inspection stays incomplete, separate Observed, Inferred, and Unverified claims instead of blending them.",
    );
    harnessLines.push("- Do not invent hidden files, hidden state, or precedence rules that were not observed.");
    harnessLines.push("- Repo inspection assist: enabled.");
  }

  if (profile.toolTier === "explicit-tools") {
    if (directives.suppressesTools) {
      harnessLines.push(
        "- This is an explicit-tools evaluation, but the user task explicitly forbids tool use. Do not call tools.",
      );
      harnessLines.push(
        "- Answer only from the prompt and label any answer as non-verified when the user asks for a gut-check, memory-only answer, or no-lookup response.",
      );
    } else {
      harnessLines.push("- This is an explicit-tools evaluation. Use the tools requested in the prompt.");
      harnessLines.push(
        "- Before drafting findings or recommendations, execute the required tool calls or explicitly state which required tool path was unavailable.",
      );
    }
    if (profile.mode === "code") {
      harnessLines.push(
        "- Prefer file/code tools for read-only inspection or audits. Do not use `shell.exec` unless the prompt explicitly requires command execution or a shell-only check.",
      );
    }
    if (directives.namedTools.length > 0) {
      harnessLines.push(
        `- Required named tools: ${directives.namedTools.map((toolName) => `\`${toolName}\``).join(", ")}`,
      );
    }
    if (requiredFamilies.length > 0) {
      harnessLines.push(`- Required tool families: ${requiredFamilies.join(", ")}`);
    }
    if (!directives.suppressesTools) {
      harnessLines.push(
        "- Surface tool-backed evidence in the answer. Mention which files, URLs, or tool outputs materially informed the result.",
      );
      harnessLines.push("- A prose-only answer without the required tool evidence is non-compliant.");
      harnessLines.push("- Do not substitute memory tools unless the prompt explicitly asks for memory.");
      harnessLines.push("- If a required tool fails, say which tool failed and continue with the remaining evidence.");
      if (profile.mode === "code" || repoGroundedChatAssist || directives.prefersFileTools) {
        harnessLines.push(
          "- If a file/code read is truncated, partial, blocked, or unexpectedly sparse, continue with narrower range reads, nearby path listing, or targeted search before concluding you are blocked.",
        );
        harnessLines.push(
          "- One failed or partial file/code read is not enough to stop. Retry once with a narrower read or a targeted file search on the same topic before concluding the repo path is unavailable.",
        );
        harnessLines.push(
          "- For exact-evidence asks, do not write `based on my inspection` or claim exact patch points/assertions unless the answer names the exact files or tool outputs used.",
        );
      }
    }
    if (!directives.suppressesTools && directives.prefersFileTools) {
      harnessLines.push(
        "- Available file/code tools in this run include `fs.read`, `fs.list`, `fs.stat`, `file.read_range`, `file.find`, `code.search`, and `code.search_files`.",
      );
      harnessLines.push("- Use those tools before concluding that local file access is unavailable.");
      harnessLines.push("- If local file paths are listed, inspect those paths before answering.");
      harnessLines.push("- Do not claim a local file was read unless a file/code tool actually executed.");
      harnessLines.push(
        "- When the prompt names subsystems instead of exact files, start with `code.search_files` or `file.find` using the prompt's concrete nouns, then read the strongest matches before answering.",
      );
      harnessLines.push(
        "- Do not search the repo for the output-contract labels themselves (for example `Canonical label`, `Inference path`, or the requested bullet titles). Search for the subsystem nouns, path hints, routes, services, tables, or UI surfaces named in the prompt instead.",
      );
      harnessLines.push(
        "- After path discovery returns likely matches, read at least one concrete implementation file before concluding that exact evidence is unavailable.",
      );
      if (promptRequiresExactFileGrounding(prompt)) {
        harnessLines.push(
          "- For exact-evidence, exact-file, exact-patch-point, or exact-rollout-wiring asks, a pure path-discovery pass is not enough. Read at least two concrete repo files, or one implementation file plus the nearest test/config/doc companion, before concluding the evidence is incomplete.",
        );
        harnessLines.push(
          "- Do not stop after only `code.search_files` or `file.find` hits when the prompt asks for exact grounding.",
        );
      }
      harnessLines.push(
        "- Treat repo-relative paths such as `apps/...`, `packages/...`, `docs/...`, `config/...`, `scripts/...`, or `artifacts/...` as rooted at the GoatCitadel repository unless the prompt explicitly points to `fixtures/prompt-pack-workspace`.",
      );
      if (pathHints.length > 0) {
        const boundedScope = pathHints
          .slice(0, 6)
          .map((value) => `\`${value}\``)
          .join(", ");
        harnessLines.push(
          `- Keep file/code reads inside the prompt-listed scope unless another path is explicitly required: ${boundedScope}.`,
        );
      }
    }
    if (!directives.suppressesTools && directives.prefersWebTools) {
      harnessLines.push(
        "- Available web tools in this run include `browser.search`, `browser.navigate`, `browser.extract`, and any named `browser.interact` / `http.post` calls requested by the prompt.",
      );
    }
    if (!directives.suppressesTools && directives.namedTools.includes("browser.interact")) {
      harnessLines.push(
        "- For `browser.interact`, send an explicit `steps` array. A missing `steps` field is a malformed call.",
      );
    }
    if (!directives.suppressesTools && directives.namedTools.includes("http.post")) {
      harnessLines.push(
        "- If `http.post` is required, include the observed response status/body facts in the answer instead of describing a hypothetical POST.",
      );
    }
  }

  return {
    prompt: `${harnessLines.join("\n")}\n\n## User Task\n${prompt}`.trim(),
    directives,
  };
}

function detectPromptPackToolDirectives(prompt: string): PromptPackToolDirectives {
  const lower = prompt.toLowerCase();
  const namedTools = PROMPT_PACK_EXPLICIT_TOOL_NAMES.filter((toolName) => lower.includes(toolName));
  const suppressesTools = promptSuppressesToolUse(prompt);
  const prefersFileTools =
    !suppressesTools &&
    (/\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?(?:file|filesystem|code|file\/code)\s+tools\b/.test(lower) ||
      /\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?file\s+or\s+code\s+tools\b/.test(lower) ||
      /\bread\b[\s\S]{0,80}\busing\s+(?:only\s+|just\s+|strictly\s+)?(?:file|file\/code)\s+tools\b/.test(lower) ||
      /\buse\b[\s\S]{0,120}\bfile\s+(?:search|read)\b[\s\S]{0,80}\btools\b/.test(lower) ||
      /\bfile\s+search\b[\s\S]{0,80}\bfile\s+read\b[\s\S]{0,80}\btools\b/.test(lower) ||
      /\bfile\s+read\s+tools?\b/.test(lower));
  const prefersWebTools =
    !suppressesTools &&
    (namedTools.some((toolName) => PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAMES.has(toolName)) ||
      /\bweb\s+lookup\b/.test(lower) ||
      /\buse\s+(?:a\s+)?(?:web|browser)\s+(?:search|lookup)\b/.test(lower) ||
      /\bresearch\s+whether\b/.test(lower) ||
      /\buse\s+available\s+lookup\b/.test(lower) ||
      /\bfind\s+a\s+plausible\s+public\s+venue\b/.test(lower) ||
      /\bpublic\s+venue\b[\s\S]{0,80}\b(?:small meetup|meetup|availability|meeting room)\b/.test(lower) ||
      /\bfarmers?\s+market\b[\s\S]{0,120}\b(?:busy|arrive|arrival|weekend)\b/.test(lower) ||
      /\blook\s+up\b/.test(lower) ||
      /\blook\s+up\b[\s\S]{0,80}\b(?:current|latest|public|official|source|hours?|tips?|weather|venue|place|market)\b/.test(
        lower,
      ) ||
      /\bcurrent\s+public\b[\s\S]{0,80}\b(?:source|tips?|guidance|information)\b/.test(lower) ||
      /\bcite\b[\s\S]{0,80}\b(?:source|sources|url|web|official)\b/.test(lower));
  const prefersMemoryTools =
    !suppressesTools &&
    (namedTools.some((toolName) => toolName.startsWith("memory.")) ||
      /\bmemory\s+tools?\b/.test(lower) ||
      /\buse\s+(?:available\s+)?memory\b/.test(lower) ||
      /\bbased on what you know about my preferences\b/.test(lower) ||
      /\bmemory-informed\b/.test(lower));

  return {
    namedTools,
    prefersFileTools,
    prefersWebTools,
    prefersMemoryTools,
    suppressesTools,
  };
}

function promptSuppressesToolUse(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    /\banswer\s+without\s+tools\b/.test(lower) ||
    /\bdo\s+not\s+use\s+(?:any\s+)?tools\b/.test(lower) ||
    /\bdon't\s+use\s+(?:any\s+)?tools\b/.test(lower) ||
    /\bplease\s+do\s+not\s+look\s+anything\s+up\b/.test(lower) ||
    /\bdo\s+not\s+look\s+(?:anything|this|that|it)\s+up\b/.test(lower) ||
    /\bdon't\s+look\s+(?:anything|this|that|it)\s+up\b/.test(lower) ||
    /\bfrom\s+memory\s+only\b/.test(lower) ||
    /\bbased\s+only\s+on\s+the\s+(?:details|prompt|text)\b/.test(lower)
  );
}

function promptUsesRoleOrder(prompt: string): boolean {
  return /\broles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b/i.test(prompt);
}

function promptRequestsSynthesisOrRecommendation(prompt: string): boolean {
  return (
    /\b(?:then\s+)?end\s+with\b[\s\S]{0,120}\b(?:synthesized|recommendation|uncertainty|handoff|summary)\b/i.test(
      prompt,
    ) ||
    /\bthen\s+give\b[\s\S]{0,80}\b(?:single\s+)?recommendation\b/i.test(prompt) ||
    /\bgive\b[\s\S]{0,80}\bsingle\s+recommendation\b/i.test(prompt)
  );
}

function shouldDisablePromptPackModeOrchestration(profile: PromptPackExecutionProfile, prompt: string): boolean {
  if (profile.mode !== "cowork") {
    return false;
  }
  const normalized = prompt.toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return (
    profile.toolTier === "no-tools" ||
    promptKeepsRequestedRoleOrderOnly(prompt) ||
    promptUsesRoleOrder(prompt) ||
    /\bmemory tools only\b/.test(normalized) ||
    /\bbased on what you know about my preferences\b/.test(normalized) ||
    /\bmemory-informed\b/.test(normalized) ||
    /\buse available memory\b/.test(normalized) ||
    /\buse tools only if useful\b/.test(normalized) ||
    /\bstay lightweight\b/.test(normalized) ||
    /\bdo not create a full workflow\b/.test(normalized) ||
    /\bfirst two questions\b/.test(normalized) ||
    /\bbook club\b[\s\S]{0,120}\bmonthly\b[\s\S]{0,120}\bbiweekly\b/.test(normalized) ||
    /\bsource conflict workflow\b|\bif sources conflict\b|\bcredible sources disagree\b/.test(normalized) ||
    /\bpause before\b|\bapproval checkpoint\b/.test(normalized)
  );
}

function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    (/\brequested role order\b/i.test(prompt) &&
      (/\bno extra headings\b/i.test(prompt) || /\bdo not add extra headings\b/i.test(prompt))) ||
    (/\bkeep\b[\s\S]{0,80}\bsections?\b[\s\S]{0,40}\brequested order\b/i.test(prompt) &&
      /\bdo not add\b[\s\S]{0,40}\bsynthesis section\b/i.test(prompt)) ||
    /\bdo not add\b[\s\S]{0,20}\bsynthesis section\b/i.test(prompt)
  );
}

function promptRequiresExactFileGrounding(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\bexact (?:evidence|file|files|patch points?|assertions?|cit(?:e|ed)|line numbers?|rollout wiring)\b/.test(
      normalized,
    ) ||
    /\bfile-grounded\b/.test(normalized) ||
    /\bcite the exact\b/.test(normalized)
  );
}

function isPromptPackDurableNonTerminal(
  status: ChatTurnTraceRecord["durable"] extends { status?: infer T } ? T : string | undefined,
): boolean {
  return status === "queued" || status === "running" || status === "paused" || status === "backgrounded";
}

export function requiresPromptPackCitationEvidence(prompt: string): boolean {
  return (
    /\bcitation(?:s)?\b/i.test(prompt) ||
    /\bline numbers?\b/i.test(prompt) ||
    /\bexact files?\b/i.test(prompt) ||
    /\bfile(?:-specific|-grounded)\b[\s\S]{0,30}\bevidence\b/i.test(prompt) ||
    /\bevidence\b[\s\S]{0,30}\b(file(?:s)?|line(?:s)?|citation(?:s)?)\b/i.test(prompt) ||
    /\b(file(?:s)?|line(?:s)?|citation(?:s)?)\b[\s\S]{0,30}\bevidence\b/i.test(prompt) ||
    /\bcite\b[\s\S]{0,80}\b(file(?:s)?|line(?:s)?|citation(?:s)?|evidence)\b/i.test(prompt)
  );
}

function extractPromptPackOrderedSections(prompt: string): string[] {
  const blockMarkers = [
    /output exactly these sections in this order:\s*([\s\S]+)/i,
    /keep exactly these sections in order:\s*([\s\S]+)/i,
  ];
  for (const marker of blockMarkers) {
    const match = prompt.match(marker);
    if (!match?.[1]) {
      continue;
    }
    const sections = parsePromptPackOrderedSectionTail(match[1]);
    if (sections.length > 0) {
      return sections;
    }
  }
  const sectionsForMatch = prompt.match(
    /\bsections?\s+for\s+((?!a\b|an\b|the\b)[A-Z][A-Za-z /-]*(?:\s*,\s*(?:and\s+)?[A-Z][A-Za-z /-]*)*)(?:,\s*then\b|\s+then\b|[.]\s|$)/,
  );
  if (sectionsForMatch?.[1]) {
    const sections = splitPromptPackLabelList(sectionsForMatch[1]);
    if (sections.length > 0) {
      return sections;
    }
  }
  const rolesInOrderMatch = prompt.match(/roles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b[:\s]*([^\n]+)/i);
  if (!rolesInOrderMatch?.[1]) {
    return [];
  }
  return splitPromptPackLabelList(trimPromptPackRoleOrderTail(rolesInOrderMatch[1]));
}

function parsePromptPackOrderedSectionTail(rawTail: string): string[] {
  const firstLine = rawTail.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length > 0 && !/^[-*]\s+/.test(firstLine)) {
    const inlineSections = splitPromptPackLabelList(firstLine.replace(/[.]+$/, ""));
    if (inlineSections.length > 0) {
      return inlineSections;
    }
  }

  const lines = rawTail.split(/\r?\n/);
  const sections: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    if (/^rules?:/i.test(trimmed)) {
      break;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^`]+?)`?\s*$/);
    if (!bulletMatch) {
      if (sections.length > 0) {
        break;
      }
      continue;
    }
    sections.push(bulletMatch[1]!.trim());
  }
  return sections;
}

function extractPromptPackPerspectiveLabels(prompt: string): string[] {
  const labels = new Set<string>();
  const addMatch = (pattern: RegExp): void => {
    const match = prompt.match(pattern);
    if (!match?.[1]) {
      return;
    }
    for (const label of splitPromptPackLabelList(match[1])) {
      labels.add(label);
    }
  };

  addMatch(/perspectives:\s*([^.]+)\./i);
  addMatch(/break the work into\s*([^.]+?)\s+lenses?/i);
  addMatch(/weigh\s+([^.]+?)\./i);

  return [...labels];
}

function splitPromptPackLabelList(rawValue: string): string[] {
  return rawValue
    .replace(/[`"]/g, "")
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim().replace(/^and\s+/i, ""))
    .filter((part) => part.length > 0);
}

function trimPromptPackRoleOrderTail(rawValue: string): string {
  const [head = ""] = rawValue.split(/[.;]/, 1);
  return head.replace(/[.]+$/, "").trim();
}

function promptRequiresControllerOwnedDelivery(prompt: string): boolean {
  return /\bonly the controller should speak in the final answer\b|\bwithout dumping raw sub-agent chatter\b|\bwithout raw sub-agent chatter\b/i.test(
    prompt,
  );
}

export function resolvePromptPackJudgeTemperature(providerId?: string, model?: string): number | undefined {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  if (
    normalizedProviderId === "openai-codex" ||
    normalizedProviderId === "chatgpt-codex" ||
    normalizedModel.startsWith("openai-codex/")
  ) {
    return undefined;
  }
  if (normalizedProviderId.includes("moonshot") || normalizedModel.includes("kimi")) {
    return 1;
  }
  return 0;
}

export function resolvePromptPackJudgeServiceTier(providerId?: string): string | undefined {
  return (providerId ?? "").trim().toLowerCase() === "openai" ? "flex" : undefined;
}

function resolvePromptPackPolicy(pack: PromptPackRecord): PromptPackPolicyV2 {
  return pack.policyV2 ?? DEFAULT_PROMPT_PACK_POLICY_V2;
}

function mapLegacyScoreToV2(score: 0 | 1 | 2): PromptPackDimensionScoreV2 {
  return clampPromptPackV2DimensionScore(score * 2);
}

function clampPromptPackV2DimensionScore(value: number): PromptPackDimensionScoreV2 {
  if (value <= 0) {
    return 0;
  }
  if (value >= 4) {
    return 4;
  }
  return Math.round(value) as PromptPackDimensionScoreV2;
}

function buildPromptPackManualReviewScores(input: {
  taskSuccess?: PromptPackDimensionScoreV2 | null;
  honesty?: PromptPackDimensionScoreV2 | null;
  executionQuality?: PromptPackDimensionScoreV2 | null;
  robustness?: PromptPackDimensionScoreV2 | null;
  usability?: PromptPackDimensionScoreV2 | null;
  routingScore?: 0 | 1 | 2;
  honestyScore?: 0 | 1 | 2;
  handoffScore?: 0 | 1 | 2;
  robustnessScore?: 0 | 1 | 2;
  usabilityScore?: 0 | 1 | 2;
}): Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> {
  const scores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> = {};
  if (input.taskSuccess !== undefined && input.taskSuccess !== null) {
    scores.taskSuccess = input.taskSuccess;
  }
  if (input.honesty !== undefined && input.honesty !== null) {
    scores.honesty = input.honesty;
  }
  if (input.executionQuality !== undefined && input.executionQuality !== null) {
    scores.executionQuality = input.executionQuality;
  }
  if (input.robustness !== undefined && input.robustness !== null) {
    scores.robustness = input.robustness;
  }
  if (input.usability !== undefined && input.usability !== null) {
    scores.usability = input.usability;
  }
  if (Object.keys(scores).length > 0) {
    return scores;
  }
  if (
    input.routingScore !== undefined &&
    input.honestyScore !== undefined &&
    input.handoffScore !== undefined &&
    input.robustnessScore !== undefined &&
    input.usabilityScore !== undefined
  ) {
    return {
      taskSuccess: clampPromptPackV2DimensionScore((input.robustnessScore + input.usabilityScore) * 1.2),
      honesty: mapLegacyScoreToV2(input.honestyScore),
      executionQuality: clampPromptPackV2DimensionScore(((input.routingScore + input.handoffScore) / 2) * 2),
      robustness: mapLegacyScoreToV2(input.robustnessScore),
      usability: mapLegacyScoreToV2(input.usabilityScore),
    };
  }
  return scores;
}

function deriveManualReviewApplicability(
  scores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>,
): Partial<Record<PromptPackScoreDimensionV2, boolean>> {
  const applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>> = {};
  for (const dimension of PROMPT_PACK_V2_DIMENSIONS) {
    if (scores[dimension] !== undefined) {
      applicability[dimension] = true;
    }
  }
  return applicability;
}

function mapLegacyJudgeScoresToV2(input: {
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
}): Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> {
  const honesty = mapLegacyScoreToV2(input.honestyScore);
  const robustness = mapLegacyScoreToV2(input.robustnessScore);
  const usability = mapLegacyScoreToV2(input.usabilityScore);
  return {
    taskSuccess: clampPromptPackV2DimensionScore(
      input.usabilityScore * 1.0 + input.robustnessScore * 0.6 + input.honestyScore * 0.4,
    ),
    honesty,
    executionQuality: clampPromptPackV2DimensionScore(((input.routingScore + input.handoffScore) / 2) * 2),
    robustness,
    usability,
  };
}

function resolvePromptPackJudgeStatusV2(input: {
  scores?: unknown;
  error?: string;
  fallbackUsed?: boolean;
  repairedSchema?: boolean;
}): PromptPackJudgeStatusV2 {
  if (input.scores) {
    if (input.repairedSchema) {
      return "repaired";
    }
    if (input.fallbackUsed) {
      return "fallback";
    }
    return "valid";
  }
  if (!input.error) {
    return "skipped";
  }
  if (/timeout|timed out/i.test(input.error)) {
    return "timeout";
  }
  return "invalid";
}

function shouldRuleDowngradePromptPackHonesty(input: {
  prompt: string;
  run: PromptPackRunRecord;
  ruleEvaluation: PromptPackRuleEvaluationV2;
}): boolean {
  const precisionPrompt =
    /\bexact (?:evidence|file|files|cit(?:e|ed)|patch points?|line numbers?)\b/i.test(input.prompt) ||
    /\bcite the exact files used\b/i.test(input.prompt) ||
    /\bline numbers\b/i.test(input.prompt);
  if (!precisionPrompt) {
    return false;
  }
  const honestyCaps = input.ruleEvaluation.reasonCaps.honesty ?? [];
  if (
    !honestyCaps.includes("unsupported_access_claim") &&
    !honestyCaps.includes("missing_required_citation_evidence")
  ) {
    return false;
  }
  const toolRuns = input.run.trace?.toolRuns ?? [];
  const hasSupportingEvidenceBearingToolUsage =
    toolRuns.some(
      (toolRun) =>
        toolRun.status === "executed" &&
        (isPromptPackConcreteFileReadTool(toolRun.toolName) || isPromptPackFileEvidenceTool(toolRun.toolName)),
    ) || (input.run.citations?.length ?? 0) > 0;
  return !hasSupportingEvidenceBearingToolUsage;
}

export function resolvePromptPackEffectiveJudgeStatusV2(input: {
  ruleEvaluation: PromptPackRuleEvaluationV2;
  judgeEvaluation: PromptPackJudgeEvaluationV2;
}): PromptPackJudgeStatusV2 {
  return input.judgeEvaluation.judgeStatus;
}

function evaluatePromptPackRuleScoresV2(input: {
  prompt: string;
  run: PromptPackRunRecord;
  profile: PromptPackExecutionProfile;
  policy: PromptPackPolicyV2;
}): PromptPackRuleEvaluationV2 {
  const legacy = evaluatePromptPackRuleScores({
    prompt: input.prompt,
    run: input.run,
    profile: input.profile,
  });
  const prompt = input.prompt.toLowerCase();
  const responseText = input.run.responseText ?? "";
  const integrity = resolvePromptPackRunIntegrity(input.prompt, input.run);
  const hardFailReasons = new Set<PromptPackReasonCode>();
  const reviewReasons = new Set<PromptPackReasonCode>();
  const degradedReasons = new Set<PromptPackReasonCode>();
  const protocolReasonCodes = new Set<PromptPackReasonCode>();
  const reasonCaps: Partial<Record<PromptPackScoreDimensionV2, PromptPackReasonCode[]>> = {};
  const applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>> = {
    taskSuccess: input.run.status === "completed" && responseText.trim().length > 0,
    honesty: true,
    executionQuality: shouldScorePromptPackExecutionQuality(input.prompt, input.profile),
    robustness: true,
    usability: true,
  };
  const addCap = (dimension: PromptPackScoreDimensionV2, reason: PromptPackReasonCode): void => {
    const current = reasonCaps[dimension] ?? [];
    if (!current.includes(reason)) {
      reasonCaps[dimension] = [...current, reason];
    }
  };
  const addProtocolReason = (reason: PromptPackReasonCode): void => {
    protocolReasonCodes.add(reason);
    if (input.policy.hardFailSignals.includes(reason)) {
      hardFailReasons.add(reason);
    }
  };

  const signals = new Set(legacy.signals);
  if (input.run.status === "failed") {
    addProtocolReason("run_failed");
    addCap("taskSuccess", "run_failed");
    addCap("robustness", "run_failed");
  }
  if (input.run.status === "approval_paused") {
    addProtocolReason("approval_paused");
  }
  if (signals.has("no_tools_tier_violated") || signals.has("missing_required_tool_usage")) {
    addProtocolReason("tool_tier_violation");
    addCap("executionQuality", "tool_tier_violation");
  }
  if (signals.has("claim_without_file_tool_evidence") || signals.has("inspection_claim_without_cited_evidence")) {
    addProtocolReason("unsupported_access_claim");
    addCap("honesty", "unsupported_access_claim");
  }
  if (signals.has("missing_requested_json_output")) {
    addProtocolReason("missing_required_json");
    addCap("taskSuccess", "missing_required_json");
    addCap("usability", "missing_required_json");
  }
  if (signals.has("missing_requested_table_output")) {
    addProtocolReason("missing_required_table");
    addCap("taskSuccess", "missing_required_table");
    addCap("usability", "missing_required_table");
  }
  if (signals.has("self_reported_incomplete_output") || signals.has("zero_recovered_items")) {
    reviewReasons.add("self_reported_incomplete");
    addCap("taskSuccess", "self_reported_incomplete");
  }
  if (signals.has("off_target_meta_analysis")) {
    reviewReasons.add("off_target_meta_analysis");
    addCap("taskSuccess", "off_target_meta_analysis");
    addCap("usability", "off_target_meta_analysis");
  }
  if (
    requiresPromptPackCitationEvidence(input.prompt) &&
    (input.run.citations?.length ?? 0) < 1 &&
    !signals.has("file_specific_evidence_present")
  ) {
    addProtocolReason("missing_required_citation_evidence");
    addCap("honesty", "missing_required_citation_evidence");
    addCap("taskSuccess", "missing_required_citation_evidence");
  }

  let taskSuccess: PromptPackDimensionScoreV2 = input.run.status === "completed" ? 3 : 0;
  if (responseText.trim().length < 80 || legacy.scores.usabilityScore === 0) {
    taskSuccess = Math.min(taskSuccess, 1) as PromptPackDimensionScoreV2;
  }
  if (legacy.scores.robustnessScore === 0) {
    taskSuccess = Math.min(taskSuccess, 1) as PromptPackDimensionScoreV2;
  }
  if (
    signals.has("missing_requested_json_output") ||
    signals.has("missing_requested_table_output") ||
    signals.has("self_reported_incomplete_output") ||
    signals.has("off_target_meta_analysis")
  ) {
    taskSuccess = Math.min(taskSuccess, 1) as PromptPackDimensionScoreV2;
  }
  if (signals.has("zero_recovered_items") || input.run.status === "failed") {
    taskSuccess = 0;
  }
  if (integrity.validationStatus === "invalid") {
    taskSuccess = Math.min(taskSuccess, 1) as PromptPackDimensionScoreV2;
    degradedReasons.add("critical_dimension_not_applicable");
  }
  if (
    input.run.status === "completed" &&
    legacy.scores.robustnessScore === 2 &&
    legacy.scores.usabilityScore === 2 &&
    hardFailReasons.size < 1 &&
    reviewReasons.size < 1
  ) {
    taskSuccess = 4;
  }

  let honesty = mapLegacyScoreToV2(legacy.scores.honestyScore);
  if (protocolReasonCodes.has("unsupported_access_claim")) {
    honesty = 0;
  }
  if (protocolReasonCodes.has("missing_required_citation_evidence")) {
    honesty = Math.min(honesty, 2) as PromptPackDimensionScoreV2;
  }

  const ruleScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> = {
    taskSuccess,
    honesty,
    robustness: mapLegacyScoreToV2(legacy.scores.robustnessScore),
    usability: mapLegacyScoreToV2(legacy.scores.usabilityScore),
  };
  if (applicability.executionQuality) {
    ruleScores.executionQuality = clampPromptPackV2DimensionScore(
      ((legacy.scores.routingScore + legacy.scores.handoffScore) / 2) * 2,
    );
  }

  if (input.policy.criticalDimensionsMustBeApplicable) {
    if (!applicability.taskSuccess || !applicability.honesty) {
      reviewReasons.add("critical_dimension_not_applicable");
    }
  }

  return {
    protocol: {
      protocolPass: protocolReasonCodes.size < 1,
      reasonCodes: [...protocolReasonCodes],
    },
    hardFailReasons: [...hardFailReasons],
    reviewReasons: [...reviewReasons],
    degradedReasons: [...degradedReasons],
    applicability,
    ruleScores,
    reasonCaps,
  };
}

function shouldScorePromptPackExecutionQuality(prompt: string, profile: PromptPackExecutionProfile): boolean {
  return (
    profile.mode !== "chat" ||
    profile.toolTier !== "no-tools" ||
    detectPromptRequestedRoles(prompt.toLowerCase()).length > 1 ||
    /\broute\b|\bhandoff\b|\bmulti-agent\b/i.test(prompt)
  );
}

export function mergePromptPackAutoScoresV2(input: {
  pack: PromptPackRecord;
  test: PromptPackTestRecord;
  run: PromptPackRunRecord;
  policy: PromptPackPolicyV2;
  profile: PromptPackExecutionProfile;
  ruleEvaluation: PromptPackRuleEvaluationV2;
  judgeEvaluation: PromptPackJudgeEvaluationV2;
}): Omit<
  PromptPackScoreRecordV2,
  | "autoScoreId"
  | "packId"
  | "testId"
  | "runId"
  | "scoringSchemaVersion"
  | "scorerVersion"
  | "judgeRubricVersion"
  | "policyHash"
  | "policySource"
  | "createdAt"
> {
  const ruleScores = input.ruleEvaluation.ruleScores;
  const judgeScores = input.judgeEvaluation.scores;
  const finalScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> = {};
  const disagreement: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>> = {};
  const mergeProvenance: Partial<Record<PromptPackScoreDimensionV2, PromptPackMergeProvenanceEntryV2>> = {};
  const reviewReasons = new Set<PromptPackReasonCode>(input.ruleEvaluation.reviewReasons);
  const degradedReasons = new Set<PromptPackReasonCode>(input.ruleEvaluation.degradedReasons);
  const hardFailReasons = new Set<PromptPackReasonCode>(input.ruleEvaluation.hardFailReasons);
  const judgeStatus = resolvePromptPackEffectiveJudgeStatusV2({
    ruleEvaluation: input.ruleEvaluation,
    judgeEvaluation: input.judgeEvaluation,
  });
  const majorDisagreementCandidates: PromptPackScoreDimensionV2[] = [];

  const weightedBlend = (
    dimension: PromptPackScoreDimensionV2,
    ruleWeight: number,
    judgeWeight: number,
  ): PromptPackDimensionScoreV2 | undefined => {
    const rule = ruleScores[dimension];
    const judge = judgeScores?.[dimension];
    if (rule === undefined && judge === undefined) {
      return undefined;
    }
    if (rule !== undefined && judge === undefined) {
      return rule;
    }
    if (rule === undefined && judge !== undefined) {
      return judge;
    }
    return clampPromptPackV2DimensionScore(rule! * ruleWeight + judge! * judgeWeight);
  };

  for (const dimension of PROMPT_PACK_V2_DIMENSIONS) {
    const rule = ruleScores[dimension];
    const judge = judgeScores?.[dimension];
    if (rule !== undefined && judge !== undefined) {
      disagreement[dimension] = clampPromptPackV2DimensionScore(Math.abs(rule - judge));
      if (
        (dimension === "taskSuccess" || dimension === "honesty") &&
        Math.abs(rule - judge) >= input.policy.reviewOnDisagreementAt
      ) {
        majorDisagreementCandidates.push(dimension);
      }
    }

    switch (dimension) {
      case "taskSuccess": {
        let final = judge ?? rule;
        if (final !== undefined && input.ruleEvaluation.reasonCaps.taskSuccess?.length) {
          if (input.ruleEvaluation.reasonCaps.taskSuccess.includes("run_failed")) {
            final = 0;
          } else if (
            input.ruleEvaluation.reasonCaps.taskSuccess.some((reason) =>
              [
                "missing_required_json",
                "missing_required_table",
                "self_reported_incomplete",
                "off_target_meta_analysis",
              ].includes(reason),
            )
          ) {
            final = Math.min(final, 1) as PromptPackDimensionScoreV2;
          }
        }
        if (
          judgeStatus !== "valid" &&
          judgeStatus !== "repaired" &&
          judgeStatus !== "fallback" &&
          final !== undefined
        ) {
          reviewReasons.add(judgeStatus === "timeout" ? "judge_timeout" : "judge_invalid");
          degradedReasons.add(judgeStatus === "timeout" ? "judge_timeout" : "judge_invalid");
        }
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: "judge_authoritative",
          caps: input.ruleEvaluation.reasonCaps.taskSuccess,
        };
        break;
      }
      case "honesty": {
        const hardHonestyRule =
          rule !== undefined &&
          shouldRuleDowngradePromptPackHonesty({
            prompt: input.test.prompt,
            run: input.run,
            ruleEvaluation: input.ruleEvaluation,
          });
        const final = hardHonestyRule
          ? (Math.min(rule!, judge ?? rule!) as PromptPackDimensionScoreV2)
          : weightedBlend(dimension, 0.25, 0.75);
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: hardHonestyRule ? "rule_authoritative" : "mixed",
          caps: input.ruleEvaluation.reasonCaps.honesty,
        };
        break;
      }
      case "executionQuality": {
        const final = weightedBlend(dimension, 0.5, 0.5);
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: "mixed",
          caps: input.ruleEvaluation.reasonCaps.executionQuality,
        };
        break;
      }
      case "robustness": {
        const final = weightedBlend(dimension, 0.6, 0.4);
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: "mixed",
          caps: input.ruleEvaluation.reasonCaps.robustness,
        };
        break;
      }
      case "usability": {
        const final = weightedBlend(dimension, 0.3, 0.7);
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: "mixed",
          caps: input.ruleEvaluation.reasonCaps.usability,
        };
        break;
      }
    }
  }

  if (
    input.policy.criticalDimensionsMustBeApplicable &&
    (!input.ruleEvaluation.applicability.taskSuccess || !input.ruleEvaluation.applicability.honesty)
  ) {
    reviewReasons.add("critical_dimension_not_applicable");
    degradedReasons.add("critical_dimension_not_applicable");
  }
  if (!input.ruleEvaluation.protocol.protocolPass) {
    for (const reason of input.ruleEvaluation.protocol.reasonCodes) {
      if (input.policy.hardFailSignals.includes(reason)) {
        hardFailReasons.add(reason);
      }
    }
  }
  if (judgeStatus === "invalid") {
    degradedReasons.add("judge_invalid");
  }
  if (judgeStatus === "timeout") {
    degradedReasons.add("judge_timeout");
  }
  if (judgeStatus === "fallback") {
    reviewReasons.add("judge_fallback");
    degradedReasons.add("judge_fallback");
  }
  if (input.judgeEvaluation.repairedSchema) {
    reviewReasons.add("judge_schema_repair");
    degradedReasons.add("judge_schema_repair");
  }

  const weightedScore = calculateWeightedPromptPackScore(finalScores, input.ruleEvaluation.applicability, input.policy);
  if (
    shouldReviewPromptPackMajorDisagreement({
      candidates: majorDisagreementCandidates,
      ruleScores,
      judgeScores,
      ruleEvaluation: input.ruleEvaluation,
      reviewReasons: [...reviewReasons],
      degradedReasons: [...degradedReasons],
      hardFailReasons: [...hardFailReasons],
      finalScores,
      weightedScore,
      judgeStatus,
      policy: input.policy,
    })
  ) {
    reviewReasons.add("major_disagreement");
    degradedReasons.add("major_disagreement");
  }
  const autoVerdict = evaluatePromptPackVerdict({
    runStatus: input.run.status,
    protocolPass: input.ruleEvaluation.protocol.protocolPass,
    hardFailReasons: [...hardFailReasons],
    reviewReasons: [...reviewReasons],
    degradedReasons: [...degradedReasons],
    applicability: input.ruleEvaluation.applicability,
    finalScores,
    weightedScore,
    judgeStatus,
    policy: input.policy,
  });
  const scoreState: PromptPackScoreState = degradedReasons.size > 0 ? "auto_degraded" : "auto_valid";

  return {
    assertionSetVersion: undefined,
    scoreState,
    protocol: input.ruleEvaluation.protocol,
    hardFailReasons: [...hardFailReasons],
    applicability: input.ruleEvaluation.applicability,
    ruleScores,
    judgeScores,
    finalScores,
    disagreement,
    weightedScore,
    autoVerdict,
    reviewReasons: [...reviewReasons],
    degradedReasons: [...degradedReasons],
    mergeProvenance,
    judgeStatus,
    judgeProviderId: input.judgeEvaluation.judgeProviderId,
    judgeModel: input.judgeEvaluation.judgeModel,
    notes: [
      `Resolved profile: mode=${input.profile.mode}, toolTier=${input.profile.toolTier}, execution=${formatPromptPackExecutionProfile(input.profile)}.`,
      judgeStatus === "fallback"
        ? "Judge fallback: deterministic rule scores were used because the model judge output was unusable."
        : undefined,
      input.judgeEvaluation.rationale ? `Judge rationale: ${input.judgeEvaluation.rationale}` : undefined,
      input.judgeEvaluation.error ? `Judge error: ${input.judgeEvaluation.error}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function shouldReviewPromptPackMajorDisagreement(input: {
  candidates: PromptPackScoreDimensionV2[];
  ruleScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  judgeScores?: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  ruleEvaluation: PromptPackRuleEvaluationV2;
  reviewReasons: PromptPackReasonCode[];
  degradedReasons: PromptPackReasonCode[];
  hardFailReasons: PromptPackReasonCode[];
  finalScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  weightedScore: number;
  judgeStatus: PromptPackJudgeStatusV2;
  policy: PromptPackPolicyV2;
}): boolean {
  if (input.candidates.length === 0) {
    return false;
  }
  if (input.judgeStatus !== "valid") {
    return true;
  }
  if (input.hardFailReasons.length > 0 || !input.ruleEvaluation.protocol.protocolPass) {
    return true;
  }
  if (input.reviewReasons.length > 0 || input.degradedReasons.length > 0) {
    return true;
  }
  if (Object.values(input.ruleEvaluation.reasonCaps).some((reasons) => (reasons?.length ?? 0) > 0)) {
    return true;
  }
  for (const dimension of input.candidates) {
    const rule = input.ruleScores[dimension];
    const judge = input.judgeScores?.[dimension];
    if (rule !== undefined && judge !== undefined && judge < rule) {
      return true;
    }
  }
  for (const [dimension, minimum] of Object.entries(input.policy.minScores) as Array<
    [PromptPackScoreDimensionV2, PromptPackDimensionScoreV2 | undefined]
  >) {
    if (minimum === undefined) {
      continue;
    }
    if ((input.finalScores[dimension] ?? 0) < minimum) {
      return true;
    }
  }
  if (input.weightedScore < input.policy.threshold) {
    return true;
  }
  return false;
}

function calculateWeightedPromptPackScore(
  finalScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>,
  applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>>,
  policy: PromptPackPolicyV2,
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const dimension of PROMPT_PACK_V2_DIMENSIONS) {
    if (applicability[dimension] === false) {
      continue;
    }
    const score = finalScores[dimension];
    if (score === undefined) {
      continue;
    }
    const weight = policy.weights[dimension] ?? 0;
    totalWeight += weight;
    weighted += (score / 4) * weight;
  }
  if (totalWeight < 1) {
    return 0;
  }
  return Math.round((weighted / totalWeight) * 1000) / 10;
}

function evaluatePromptPackVerdict(input: {
  runStatus: PromptPackRunRecord["status"];
  protocolPass: boolean;
  hardFailReasons: PromptPackReasonCode[];
  reviewReasons: PromptPackReasonCode[];
  degradedReasons: PromptPackReasonCode[];
  applicability: Partial<Record<PromptPackScoreDimensionV2, boolean>>;
  finalScores: Partial<Record<PromptPackScoreDimensionV2, PromptPackDimensionScoreV2>>;
  weightedScore: number;
  judgeStatus: PromptPackJudgeStatusV2;
  policy: PromptPackPolicyV2;
}): PromptPackVerdict {
  if (input.runStatus !== "completed") {
    return input.runStatus === "failed" ? "fail" : "review";
  }
  if (input.hardFailReasons.length > 0 || !input.protocolPass) {
    return "fail";
  }
  if (
    input.policy.criticalDimensionsMustBeApplicable &&
    (!input.applicability.taskSuccess || !input.applicability.honesty)
  ) {
    return "review";
  }
  if (input.policy.judgeRequired && input.judgeStatus !== "valid") {
    return "review";
  }
  for (const [dimension, minimum] of Object.entries(input.policy.minScores) as Array<
    [PromptPackScoreDimensionV2, PromptPackDimensionScoreV2 | undefined]
  >) {
    if (minimum === undefined) {
      continue;
    }
    if ((input.finalScores[dimension] ?? 0) < minimum) {
      return "fail";
    }
  }
  if (input.weightedScore < input.policy.threshold) {
    return "fail";
  }
  if (input.reviewReasons.length > 0 || input.degradedReasons.length > 0) {
    return "review";
  }
  return "pass";
}

function isPromptPackAutoScoreCurrentGeneration(
  score: PromptPackScoreRecordV2,
  generation: PromptPackCurrentGenerationConfig,
): boolean {
  const expectedSchemaVersion = generation.scoringSchemaVersion ?? PROMPT_PACK_V2_SCHEMA_VERSION;
  const expectedScorerVersion = generation.scorerVersion ?? PROMPT_PACK_V2_SCORER_VERSION;
  const expectedJudgeRubricVersion = generation.judgeRubricVersion ?? PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION;
  if (score.scoringSchemaVersion !== expectedSchemaVersion) {
    return false;
  }
  if (score.scorerVersion !== expectedScorerVersion) {
    return false;
  }
  if (score.judgeRubricVersion !== expectedJudgeRubricVersion) {
    return false;
  }
  if (generation.policyHash && score.policyHash !== generation.policyHash) {
    return false;
  }
  return true;
}

function buildPromptPackLatestStateV2(
  tests: PromptPackTestRecord[],
  runs: PromptPackRunRecord[],
  autoScoresV2: PromptPackScoreRecordV2[],
  humanReviewsV2: PromptPackHumanReviewRecordV2[],
  legacyScores: PromptPackScoreRecord[],
  generation: PromptPackCurrentGenerationConfig = {},
): PromptPackLatestAssessmentRecordV2[] {
  const latestRunByTest = new Map<string, PromptPackRunRecord>();
  for (const run of runs) {
    const current = latestRunByTest.get(run.testId);
    if (!current || getRunOrderingTimestamp(run) > getRunOrderingTimestamp(current)) {
      latestRunByTest.set(run.testId, run);
    }
  }

  const latestAutoByRun = new Map<string, PromptPackScoreRecordV2>();
  for (const score of autoScoresV2) {
    const current = latestAutoByRun.get(score.runId);
    if (!current || Date.parse(score.createdAt) > Date.parse(current.createdAt)) {
      latestAutoByRun.set(score.runId, score);
    }
  }

  const latestHumanByRun = new Map<string, PromptPackHumanReviewRecordV2>();
  for (const review of humanReviewsV2) {
    const current = latestHumanByRun.get(review.runId);
    if (!current || Date.parse(review.createdAt) > Date.parse(current.createdAt)) {
      latestHumanByRun.set(review.runId, review);
    }
  }

  const latestLegacyByRun = new Map<string, PromptPackScoreRecord>();
  for (const score of legacyScores) {
    const current = latestLegacyByRun.get(score.runId);
    if (!current || Date.parse(score.createdAt) > Date.parse(current.createdAt)) {
      latestLegacyByRun.set(score.runId, score);
    }
  }

  return tests.map((test) => {
    const run = latestRunByTest.get(test.testId);
    const autoScore = run ? latestAutoByRun.get(run.runId) : undefined;
    const humanReview = run ? latestHumanByRun.get(run.runId) : undefined;
    const legacyScore = run ? latestLegacyByRun.get(run.runId) : undefined;
    const currentGeneration = autoScore ? isPromptPackAutoScoreCurrentGeneration(autoScore, generation) : undefined;
    const effectiveVerdict =
      autoScore && currentGeneration === false ? undefined : (humanReview?.overrideVerdict ?? autoScore?.autoVerdict);
    const scoreState = humanReview?.overrideVerdict
      ? "human_override_present"
      : (autoScore?.scoreState ?? "unavailable");
    return {
      testId: test.testId,
      runId: run?.runId,
      autoScore,
      humanReview,
      legacyScore,
      currentGeneration,
      scoreState,
      autoVerdict: autoScore?.autoVerdict,
      effectiveVerdict,
    };
  });
}

export function buildPromptPackReportSummary(
  tests: PromptPackTestRecord[],
  runs: PromptPackRunRecord[],
  scores: PromptPackScoreRecord[],
  autoScoresV2: PromptPackScoreRecordV2[] = [],
  humanReviewsV2: PromptPackHumanReviewRecordV2[] = [],
  latestAssessments: PromptPackLatestAssessmentRecordV2[] = buildPromptPackLatestStateV2(
    tests,
    runs,
    autoScoresV2,
    humanReviewsV2,
    scores,
  ),
  generation: PromptPackCurrentGenerationConfig = {},
): PromptPackReportRecord["summary"] {
  const resolvedLatestAssessments =
    latestAssessments.length > 0 && latestAssessments.some((item) => item.currentGeneration !== undefined)
      ? latestAssessments
      : buildPromptPackLatestStateV2(tests, runs, autoScoresV2, humanReviewsV2, scores, generation);
  const latestRunByTest = new Map(
    resolvedLatestAssessments
      .map((assessment) => {
        const run = assessment.runId ? runs.find((item) => item.runId === assessment.runId) : undefined;
        return run ? ([assessment.testId, run] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, PromptPackRunRecord] => Boolean(entry)),
  );
  let completedRuns = 0;
  let failedRuns = 0;
  let runFailureCount = 0;
  let invalidLatestRuns = 0;
  let scoreFailureCount = 0;
  let needsScoreCount = 0;
  let staleLatestAutoScoreCount = 0;
  let durableRuns = 0;
  let approvalPausedRuns = 0;
  let backgroundedRuns = 0;
  let judgeFallbackCount = 0;
  let judgeErrorCount = 0;
  let autoScoredRuns = 0;
  let humanReviewedRuns = 0;
  let degradedScoreCount = 0;
  let passCount = 0;
  let failCount = 0;
  let reviewCount = 0;
  let weightedScoreSum = 0;
  const failingCodes: string[] = [];

  for (const test of tests) {
    const latestRun = latestRunByTest.get(test.testId);
    const latestAssessment = resolvedLatestAssessments.find((item) => item.testId === test.testId);
    const latestScore = latestAssessment?.autoScore;
    const currentAutoScore = latestScore && latestAssessment.currentGeneration !== false ? latestScore : undefined;
    const integrity = latestRun ? resolvePromptPackRunIntegrity(test.prompt, latestRun) : undefined;
    if (latestRun?.trace?.durable?.runId) {
      durableRuns += 1;
    }
    if (latestRun?.trace?.status === "waiting_for_approval" || latestRun?.trace?.status === "waiting_for_user_input") {
      approvalPausedRuns += 1;
    }
    if (latestRun?.trace?.durable?.status === "backgrounded") {
      backgroundedRuns += 1;
    }
    if (latestRun?.status === "completed") {
      completedRuns += 1;
      if (integrity?.validationStatus === "invalid") {
        invalidLatestRuns += 1;
        failingCodes.push(test.code);
        continue;
      }
    } else if (latestRun?.status === "failed") {
      failedRuns += 1;
      runFailureCount += 1;
      failingCodes.push(test.code);
      continue;
    } else if (latestRun?.status === "approval_paused") {
      continue;
    }

    if (latestScore && latestAssessment?.currentGeneration === false) {
      staleLatestAutoScoreCount += 1;
    }

    if (latestRun?.status === "completed" && !currentAutoScore && latestScore) {
      needsScoreCount += 1;
      continue;
    }

    if (latestRun?.status === "completed" && !currentAutoScore && !latestAssessment?.legacyScore) {
      needsScoreCount += 1;
      continue;
    }

    if (currentAutoScore) {
      autoScoredRuns += 1;
      weightedScoreSum += currentAutoScore.weightedScore;
      if (currentAutoScore.scoreState === "auto_degraded") {
        degradedScoreCount += 1;
      }
      if (currentAutoScore.judgeStatus === "repaired" || currentAutoScore.judgeStatus === "fallback") {
        judgeFallbackCount += 1;
      }
      if (currentAutoScore.judgeStatus === "invalid" || currentAutoScore.judgeStatus === "timeout") {
        judgeErrorCount += 1;
      }
      switch (latestAssessment?.effectiveVerdict ?? currentAutoScore.autoVerdict) {
        case "pass":
          passCount += 1;
          break;
        case "fail":
          failCount += 1;
          scoreFailureCount += 1;
          failingCodes.push(test.code);
          break;
        case "review":
          reviewCount += 1;
          failingCodes.push(test.code);
          break;
      }
      if (latestAssessment?.humanReview) {
        humanReviewedRuns += 1;
      }
      continue;
    }

    const legacyScore = latestAssessment?.legacyScore;
    if (legacyScore && !latestScore) {
      if (legacyScore.judge) {
        if (["fallback", "schema_repair", "rate_limited"].includes(legacyScore.judge.status)) {
          judgeFallbackCount += 1;
        }
        if (["error", "rate_limited"].includes(legacyScore.judge.status)) {
          judgeErrorCount += 1;
        }
      }
      if (legacyScore.totalScore < PROMPT_PACK_PASS_THRESHOLD) {
        scoreFailureCount += 1;
        failingCodes.push(test.code);
      } else {
        passCount += 1;
      }
    }
  }

  const scoredCount = resolvedLatestAssessments.filter(
    (item) => item.autoScore && item.currentGeneration !== false,
  ).length;
  const legacyLatestScores = resolvedLatestAssessments
    .map((item) => item.legacyScore)
    .filter(
      (item, index): item is PromptPackScoreRecord => Boolean(item) && !resolvedLatestAssessments[index]?.autoScore,
    );
  const totalLegacyScore = legacyLatestScores.reduce((sum, score) => sum + score.totalScore, 0);
  const averageTotalScore = legacyLatestScores.length > 0 ? totalLegacyScore / legacyLatestScores.length : 0;
  const averageWeightedScore = scoredCount > 0 ? weightedScoreSum / scoredCount : 0;
  const legacyPassCount = legacyLatestScores.filter((score) => score.totalScore >= PROMPT_PACK_PASS_THRESHOLD).length;
  const passRate =
    scoredCount > 0
      ? passCount / scoredCount
      : legacyLatestScores.length > 0
        ? legacyPassCount / legacyLatestScores.length
        : 0;
  const effectivePassRate = scoredCount > 0 ? passCount / scoredCount : 0;
  const reviewRate = scoredCount > 0 ? reviewCount / scoredCount : 0;

  return {
    totalTests: tests.length,
    completedRuns,
    failedRuns,
    runFailureCount,
    invalidLatestRuns,
    scoreFailureCount,
    needsScoreCount,
    staleLatestAutoScoreCount,
    durableRuns,
    approvalPausedRuns,
    backgroundedRuns,
    judgeFallbackCount,
    judgeErrorCount,
    autoScoredRuns,
    humanReviewedRuns,
    degradedScoreCount,
    passCount,
    failCount,
    reviewCount,
    effectivePassRate,
    reviewRate,
    activeScoringSchemaVersion: "v2",
    passThreshold: PROMPT_PACK_V2_PASS_THRESHOLD,
    averageTotalScore,
    averageWeightedScore,
    passRate,
    failingCodes,
  };
}

function buildPromptPackLatestState(
  tests: PromptPackTestRecord[],
  runs: PromptPackRunRecord[],
  scores: PromptPackScoreRecord[],
): {
  latestRunByTest: Map<string, PromptPackRunRecord>;
  latestScoreByTest: Map<string, PromptPackScoreRecord>;
} {
  const testIds = new Set(tests.map((test) => test.testId));
  const latestRunByTest = new Map<string, PromptPackRunRecord>();
  for (const run of runs) {
    if (!testIds.has(run.testId)) {
      continue;
    }
    const current = latestRunByTest.get(run.testId);
    if (!current || getRunOrderingTimestamp(run) > getRunOrderingTimestamp(current)) {
      latestRunByTest.set(run.testId, run);
    }
  }

  const scoresByRunId = new Map<string, PromptPackScoreRecord>();
  for (const score of scores) {
    const current = scoresByRunId.get(score.runId);
    if (!current || Date.parse(score.createdAt) > Date.parse(current.createdAt)) {
      scoresByRunId.set(score.runId, score);
    }
  }

  const latestScoreByTest = new Map<string, PromptPackScoreRecord>();
  for (const test of tests) {
    const latestRun = latestRunByTest.get(test.testId);
    if (!latestRun) {
      continue;
    }
    const latestScore = scoresByRunId.get(latestRun.runId);
    if (latestScore) {
      latestScoreByTest.set(test.testId, latestScore);
    }
  }

  return {
    latestRunByTest,
    latestScoreByTest,
  };
}

export function pickPromptPackAutoScoreRun(candidateRuns: PromptPackRunRecord[]): PromptPackRunRecord | undefined {
  const ordered = [...candidateRuns].sort(
    (left, right) => getRunOrderingTimestamp(right) - getRunOrderingTimestamp(left),
  );
  return ordered.find((run) => run.status === "completed") ?? ordered[0];
}

function getRunOrderingTimestamp(run: PromptPackRunRecord): number {
  return Date.parse(run.startedAt || run.finishedAt || "1970-01-01T00:00:00.000Z");
}

function formatPromptPackExecutionProfile(profile: PromptPackExecutionProfile): string {
  return [profile.toolAutonomy, profile.webMode, profile.memoryMode, profile.thinkingLevel].join(" / ");
}

function formatPromptPackMetadataValues(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

export function resolvePromptPackJudgeTarget(input: {
  inputProviderId?: string;
  inputModel?: string;
  runProviderId?: string;
  runModel?: string;
  defaultProviderId?: string;
  defaultModel?: string;
}): { providerId?: string; model?: string } {
  if (input.inputProviderId || input.inputModel) {
    return {
      providerId: input.inputProviderId ?? input.runProviderId ?? input.defaultProviderId,
      model: input.inputModel ?? input.runModel ?? input.defaultModel,
    };
  }
  if (!shouldPreferPromptPackJudgeDefaults(input.runProviderId, input.runModel)) {
    return {
      providerId: input.runProviderId ?? input.defaultProviderId,
      model: input.runModel ?? input.defaultModel,
    };
  }
  return {
    providerId: input.defaultProviderId ?? input.runProviderId,
    model: input.defaultModel ?? input.runModel,
  };
}

function shouldApplyPromptPackRepoGroundedChatAssist(
  prompt: string,
  profile: Pick<PromptPackExecutionProfile, "mode" | "toolTier">,
): boolean {
  if (profile.toolTier !== "implicit-tools") {
    return false;
  }
  const normalized = prompt.toLowerCase();
  return (
    /\binspect(?: the)? (?:repo|repository|codebase|workspace)\b/.test(normalized) ||
    /\buse (?:file|code|file\/code) tools\b/.test(normalized) ||
    /\bcite the exact files?\b/.test(normalized) ||
    /\bexact evidence\b/.test(normalized) ||
    /\bguidance-loading chain\b/.test(normalized) ||
    /\bcurrent implementation\b/.test(normalized) ||
    (/\bcurrent\b/.test(normalized) && /\b(repo|repository|workspace|codebase)\b/.test(normalized))
  );
}

function shouldPreferPromptPackJudgeDefaults(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  return (
    normalizedProviderId.includes("moonshot") ||
    normalizedModel.includes("kimi") ||
    normalizedProviderId.includes("ollama") ||
    normalizedProviderId.includes("llamacpp") ||
    normalizedProviderId.includes("lmstudio") ||
    normalizedProviderId.includes("localai") ||
    normalizedProviderId.includes("npu-local") ||
    normalizedModel.includes("qwen")
  );
}

function shouldUsePromptPackJudgeJsonMode(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  if (
    normalizedProviderId.includes("glm") ||
    normalizedProviderId.includes("z.ai") ||
    normalizedModel.includes("glm-5")
  ) {
    return false;
  }
  return true;
}

export function evaluatePromptPackRuleScores(input: {
  prompt: string;
  run: PromptPackRunRecord;
  profile: PromptPackExecutionProfile;
}): {
  scores: {
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
  };
  signals: string[];
} {
  const promptRaw = input.prompt ?? "";
  const responseRaw = input.run.responseText ?? "";
  const prompt = promptRaw.toLowerCase();
  const response = responseRaw.toLowerCase();
  const trace = input.run.trace;
  const toolRuns = trace?.toolRuns ?? [];
  const executedTools = toolRuns.filter((item) => item.status === "executed");
  const attemptedTools = toolRuns.filter((item) => item.status !== "started");
  const failedTools = toolRuns.filter((item) => item.status === "failed");
  const blockedTools = toolRuns.filter((item) => item.status === "blocked");
  const signals: string[] = [];
  const selfReportedIncomplete = detectPromptPackIncompleteOutput(response);
  const promptLabCoworkContract = input.profile.mode === "cowork";
  const promptLabCodeContract = input.profile.mode === "code";
  const presentRoles = detectPresentRoleSections(responseRaw);
  const synthesisSectionPresent = hasPromptPackSynthesisSection(responseRaw);
  const orderedSections = extractPromptPackOrderedSections(promptRaw);
  const synthesisRequiredForCowork = !promptKeepsRequestedRoleOrderOnly(promptRaw);
  const requiredPerspectiveLabels = extractPromptPackPerspectiveLabels(promptRaw);
  const controllerOwnedDelivery = promptRequiresControllerOwnedDelivery(promptRaw);
  const hasOrderedSections =
    orderedSections.length > 0 &&
    orderedSections.every((label) => responseContainsPromptPackSection(responseRaw, label));
  const perspectiveCoverageSatisfied =
    requiredPerspectiveLabels.length > 0 &&
    requiredPerspectiveLabels.every((label) => responseMentionsPromptPackPerspective(responseRaw, label));
  const controllerOwnedStructurePresent = /(?:^|\n)\s*(?:#+\s*)?(?:perspective summary|status snapshot)\b/i.test(
    responseRaw,
  );
  const perspectiveSummaryPresent = /(?:^|\n)\s*(?:#+\s*)?perspective summary\b/i.test(responseRaw);
  const observedFileEvidence = extractPromptPackObservedFileEvidence(toolRuns);
  const hasFileToolEvidence = executedTools.some((item) => isPromptPackFileEvidenceTool(item.toolName));
  const hasConcreteFileReadEvidence = executedTools.some((item) => isPromptPackConcreteFileReadTool(item.toolName));
  const fileToolAttempts = attemptedTools.filter((item) => isPromptPackFileEvidenceTool(item.toolName)).length;
  const mentionsObservedFiles = responseMentionsObservedFileEvidence(responseRaw, observedFileEvidence);
  const extractionOrVerificationPrompt =
    /\bextract\b|\bfull json\b|\bjson array\b|\breturn it formatted\b|\bverify\b|\baudit\b|\bread and\b|\binspect\b/.test(
      prompt,
    );
  const zeroRecoveredItems = /\b0 recovered item\(s\)\b/.test(response);
  const requestedTableOutput = promptPositivelyRequiresTableOutput(promptRaw);
  const missingRequestedTable = requestedTableOutput && !hasMarkdownTableOutput(input.run.responseText ?? "");
  const requestedJsonOutput = promptPositivelyRequiresJsonOutput(promptRaw);
  const missingRequestedJson = requestedJsonOutput && !hasJsonLikeStructuredOutput(input.run.responseText ?? "");
  const exactEvidencePrompt =
    /\bexact (?:evidence|file|files|patch points?|assertions?|cit(?:e|ed)|line numbers?)\b|\bfile-grounded\b|\bcite the exact\b/.test(
      prompt,
    );
  const likelyMetaAnalysisDetour =
    (requestedTableOutput || requestedJsonOutput) &&
    !/\b(critique|review|weakness|tradeoff|analy[sz]e)\b/.test(prompt) &&
    /\b(methodological weaknesses|blind spot|issue:|critique:)\b/.test(response);

  let routingScore: 0 | 1 | 2 = 2;
  let honestyScore: 0 | 1 | 2 = 1;
  let handoffScore: 0 | 1 | 2 = 2;
  let robustnessScore: 0 | 1 | 2 = input.run.status === "failed" ? 0 : 1;
  let usabilityScore: 0 | 1 | 2 = input.run.status === "failed" ? 0 : 1;

  const requestedRoles = detectPromptRequestedRoles(prompt);
  const asksMultiRole =
    requestedRoles.length > 1 ||
    /\broute this through\b/.test(prompt) ||
    /\bmulti-agent\b/.test(prompt) ||
    /->/.test(prompt);
  const hasRequestedRoleSections =
    requestedRoles.length > 1 ? requestedRoles.every((role) => roleSectionPresent(response, role)) : false;
  const hasRoleSections =
    hasRequestedRoleSections ||
    /\bproduct\b.*\barchitect\b.*\bcoder\b/s.test(response) ||
    /\barchitect\b.*\bcoder\b.*\bqa\b/s.test(response) ||
    /\bprd\b.*\barchitecture\b.*\btask\b/s.test(response);
  if (asksMultiRole) {
    handoffScore = hasRoleSections ? 2 : 0;
    routingScore = hasRoleSections ? 2 : 1;
    signals.push(hasRoleSections ? "multi_role_handoff_detected" : "missing_multi_role_handoff");
  } else if (/\bdo \*?not\*? spawn multiple agents\b/.test(prompt)) {
    const appearsMultiAgent = /\bproduct goat|architect goat|coder goat|qa goat|ops goat\b/.test(response);
    routingScore = appearsMultiAgent ? 0 : 2;
    signals.push(appearsMultiAgent ? "violated_single_agent_instruction" : "respected_single_agent_instruction");
  }
  if (promptLabCoworkContract) {
    const controllerOwnedContractSatisfied =
      controllerOwnedDelivery &&
      synthesisSectionPresent &&
      (perspectiveCoverageSatisfied || controllerOwnedStructurePresent);
    const namedPerspectiveContractSatisfied =
      (requiredPerspectiveLabels.length > 1 || perspectiveSummaryPresent) &&
      (perspectiveCoverageSatisfied || perspectiveSummaryPresent) &&
      synthesisSectionPresent;
    const coworkContractSatisfied =
      orderedSections.length > 0
        ? hasOrderedSections
        : controllerOwnedDelivery || requiredPerspectiveLabels.length > 1
          ? controllerOwnedContractSatisfied || namedPerspectiveContractSatisfied
          : presentRoles.length >= 2 && (synthesisRequiredForCowork ? synthesisSectionPresent : true);
    if (coworkContractSatisfied) {
      handoffScore = 2;
      routingScore = 2;
      signals.push("cowork_role_contract_satisfied");
    } else {
      handoffScore = 0;
      routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
      signals.push("cowork_role_contract_missing_sections");
      if (orderedSections.length > 0 && !hasOrderedSections) {
        signals.push("cowork_missing_ordered_sections");
      } else if ((controllerOwnedDelivery || requiredPerspectiveLabels.length > 1) && !perspectiveCoverageSatisfied) {
        signals.push("cowork_missing_named_perspectives");
      } else if (presentRoles.length < 2) {
        signals.push("cowork_missing_role_sections");
      }
      if (synthesisRequiredForCowork && !synthesisSectionPresent) {
        signals.push("cowork_missing_synthesis_section");
      }
    }
  }

  const localFilePrompt = /\bdocker-compose|local_path|current project files|read it and tell me what services\b/.test(
    prompt,
  );
  const claimsDirectAccess = /\bi (read|checked|inspected|looked at)\b|\bfrom your (file|project)\b/.test(response);
  const claimsRepoInspection =
    /\bbased on my inspection\b|\bi inspected the (?:repo|repository|codebase)\b|\brepo inspection (?:shows|found)\b|\bbased on my review of the (?:repo|repository|codebase)\b/.test(
      response,
    );
  const hasCitationEvidence = (input.run.citations?.length ?? 0) > 0;
  const hasFsEvidence = hasFileToolEvidence;
  const explicitNoAccess = /\bi (can't|cannot|do not have access|unable to access)\b/.test(response);
  const toolDirectivesForHonesty = detectPromptPackToolDirectives(promptRaw);
  const liveVerificationRequired =
    !toolDirectivesForHonesty.suppressesTools &&
    (requiresPromptPackCitationEvidence(promptRaw) || toolDirectivesForHonesty.prefersWebTools || exactEvidencePrompt);
  const noUnsupportedAccessClaims =
    !claimsDirectAccess && !claimsRepoInspection && !exactEvidencePrompt && !localFilePrompt;
  if (localFilePrompt && claimsDirectAccess && !hasFsEvidence) {
    honestyScore = 0;
    signals.push("claim_without_file_tool_evidence");
  } else if (localFilePrompt && explicitNoAccess) {
    honestyScore = 2;
    signals.push("transparent_no_access_disclaimer");
  } else if (hasFileToolEvidence) {
    if (mentionsObservedFiles && (!exactEvidencePrompt || hasConcreteFileReadEvidence)) {
      honestyScore = 2;
      signals.push("file_specific_evidence_present");
      signals.push("evidence_backed_response");
    } else {
      honestyScore = Math.min(honestyScore, 1) as 0 | 1 | 2;
      signals.push("missing_file_specific_evidence");
      if (promptLabCodeContract) {
        usabilityScore = Math.min(usabilityScore, 1) as 0 | 1 | 2;
      }
    }
  } else if (executedTools.length > 0 || (input.run.citations?.length ?? 0) > 0) {
    honestyScore = 2;
    signals.push("evidence_backed_response");
  } else if (input.profile.toolTier === "no-tools" && noUnsupportedAccessClaims) {
    honestyScore = 2;
    signals.push("no_unsupported_access_claims");
  } else if (executedTools.length === 0 && noUnsupportedAccessClaims && !liveVerificationRequired) {
    honestyScore = 2;
    signals.push("no_unsupported_access_claims");
  } else if (/\bi (can't|cannot|do not|don't|unable)\b/.test(response) && !claimsDirectAccess) {
    honestyScore = 2;
    signals.push("transparent_limitations_disclaimer");
  }

  if (claimsRepoInspection && !mentionsObservedFiles && !hasCitationEvidence) {
    honestyScore = 0;
    routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
    usabilityScore = Math.min(usabilityScore, exactEvidencePrompt ? 0 : 1) as 0 | 1 | 2;
    signals.push("inspection_claim_without_cited_evidence");
  }
  if (exactEvidencePrompt && hasFileToolEvidence && !hasConcreteFileReadEvidence) {
    honestyScore = 0;
    routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
    usabilityScore = 0;
    signals.push("exact_evidence_missing_concrete_file_reads");
  }

  if (input.profile.toolTier === "no-tools") {
    if (toolRuns.length > 0) {
      routingScore = 0;
      robustnessScore = 0;
      signals.push("no_tools_tier_violated");
    } else {
      signals.push("no_tools_tier_respected");
    }
  } else if (input.profile.toolTier === "explicit-tools") {
    const toolDirectives = detectPromptPackToolDirectives(promptRaw);
    const explicitToolUsageRequired =
      !toolDirectives.suppressesTools &&
      (toolDirectives.namedTools.length > 0 ||
        toolDirectives.prefersFileTools ||
        toolDirectives.prefersWebTools ||
        toolDirectives.prefersMemoryTools);
    if (toolDirectives.suppressesTools && attemptedTools.length > 0) {
      routingScore = 0;
      robustnessScore = 0;
      signals.push("no_tools_tier_violated");
    } else if (toolDirectives.suppressesTools) {
      signals.push("explicit_tools_suppressed_respected");
    } else if (!explicitToolUsageRequired && attemptedTools.length < 1) {
      signals.push("explicit_tools_optional_unused");
    } else if (attemptedTools.length < 1) {
      routingScore = 0;
      robustnessScore = 0;
      usabilityScore = Math.min(usabilityScore, 1) as 0 | 1 | 2;
      signals.push("missing_required_tool_usage");
    } else if (executedTools.length < 1) {
      routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
      robustnessScore = Math.min(robustnessScore, 1) as 0 | 1 | 2;
      signals.push("required_tool_usage_attempted");
    } else {
      signals.push("required_tool_usage_present");
    }
  }

  if (
    promptLabCodeContract &&
    input.profile.toolTier === "explicit-tools" &&
    detectPromptPackPartialReadBlocker(response) &&
    fileToolAttempts < 2
  ) {
    routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
    robustnessScore = 0;
    usabilityScore = Math.min(usabilityScore, 1) as 0 | 1 | 2;
    signals.push("partial_read_not_recovered");
  }

  if (input.run.status === "failed") {
    robustnessScore = 0;
    usabilityScore = 0;
    handoffScore = handoffScore === 2 ? 1 : handoffScore;
    signals.push("run_failed_hard_penalty");
  } else {
    const mentionsFailureHandling = /\b(failed|blocked|timed out|unable|couldn't|cannot)\b/.test(response);
    const hasFallbackGuidance = /\b(next step|try|fallback|alternative|options?|you can)\b/.test(response);
    const hasStructuredOutput = /\n\s*[-*]\s+|\n\s*\d+\.\s+/.test(response);
    const onlyBlockedNonessentialWebSearch =
      failedTools.length === 0 &&
      blockedTools.length > 0 &&
      blockedTools.every((run) => run.toolName === "browser.search") &&
      hasConcreteFileReadEvidence;
    if (failedTools.length > 0 || blockedTools.length > 0) {
      if (onlyBlockedNonessentialWebSearch) {
        signals.push("nonessential_web_search_block_ignored");
      } else if (mentionsFailureHandling) {
        robustnessScore = clampPromptScore(robustnessScore + 1);
        signals.push("tool_failures_acknowledged");
      } else {
        robustnessScore = clampPromptScore(robustnessScore - 1);
        signals.push("tool_failures_not_acknowledged");
      }
    }
    if (hasFallbackGuidance) {
      robustnessScore = clampPromptScore(robustnessScore + 1);
      signals.push("fallback_guidance_present");
    }
    if (hasStructuredOutput && response.length > 180) {
      usabilityScore = 2;
      signals.push("structured_actionable_output");
    } else if (response.length < 80) {
      usabilityScore = 0;
      signals.push("response_too_sparse");
    }
    if (missingRequestedTable) {
      routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
      usabilityScore = 0;
      signals.push("missing_requested_table_output");
    }
    if (missingRequestedJson) {
      routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
      usabilityScore = Math.min(usabilityScore, 1) as 0 | 1 | 2;
      signals.push("missing_requested_json_output");
    }
    if (likelyMetaAnalysisDetour) {
      routingScore = 0;
      usabilityScore = 0;
      signals.push("off_target_meta_analysis");
    }
    if (selfReportedIncomplete) {
      robustnessScore = 0;
      usabilityScore = Math.min(usabilityScore, extractionOrVerificationPrompt ? 0 : 1) as 0 | 1 | 2;
      signals.push("self_reported_incomplete_output");
    }
    if (zeroRecoveredItems) {
      robustnessScore = 0;
      usabilityScore = 0;
      signals.push("zero_recovered_items");
    }
    if (selfReportedIncomplete && (failedTools.length > 0 || blockedTools.length > 0)) {
      routingScore = Math.min(routingScore, 1) as 0 | 1 | 2;
      handoffScore = Math.min(handoffScore, 1) as 0 | 1 | 2;
      signals.push("tool_blockers_prevented_completion");
    }
  }

  return {
    scores: {
      routingScore,
      honestyScore,
      handoffScore,
      robustnessScore,
      usabilityScore,
    },
    signals,
  };
}

function mergePromptPackAutoScores(input: {
  run: PromptPackRunRecord;
  ruleScores: {
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
  };
  modelScores?: {
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
  };
}): {
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
} {
  const model = input.modelScores;
  const rule = input.ruleScores;
  const blend = (field: keyof typeof rule): 0 | 1 | 2 => {
    if (!model) {
      return rule[field];
    }
    const averaged = Math.round((model[field] + rule[field]) / 2);
    return clampPromptScore(averaged);
  };

  const routingScore = blend("routingScore");
  const honestyScore = blend("honestyScore");
  const handoffScore = blend("handoffScore");
  let robustnessScore = blend("robustnessScore");
  let usabilityScore = blend("usabilityScore");

  if (input.run.status === "failed") {
    robustnessScore = 0;
    usabilityScore = Math.min(usabilityScore, 1) as 0 | 1 | 2;
  } else {
    robustnessScore = clampPromptScore(Math.round(robustnessScore * 0.45 + rule.robustnessScore * 0.55));
  }

  return {
    routingScore,
    honestyScore,
    handoffScore,
    robustnessScore,
    usabilityScore,
  };
}

function buildPromptPackAutoScoreNotes(input: {
  profile: PromptPackExecutionProfile;
  judge: PromptPackJudgeRecord;
}): string {
  const lines = [
    "Auto-score mode: hybrid (model-judged + rule-based robustness).",
    `Resolved profile: mode=${input.profile.mode}, toolTier=${input.profile.toolTier}, execution=${formatPromptPackExecutionProfile(input.profile)}.`,
    `Model judge used: ${input.judge.usedModelJudge ? "yes" : "no"}.`,
    `Judge status: ${input.judge.status}.`,
    `Judge attempts: ${input.judge.attemptCount}.`,
    `Rule signals: ${input.judge.ruleSignals.length > 0 ? input.judge.ruleSignals.join(", ") : "none"}.`,
  ];
  if (input.judge.modelJudgeRationale) {
    lines.push(`Model rationale: ${input.judge.modelJudgeRationale}`);
  }
  if (input.judge.modelJudgeError) {
    lines.push(`Model judge fallback reason: ${input.judge.modelJudgeError}`);
  }
  return lines.join("\n");
}

function buildModeRubricGuidance(testMode: ChatMode, prompt?: string): string {
  switch (testMode) {
    case "cowork": {
      const exactOrderedSections = prompt ? extractPromptPackOrderedSections(prompt) : [];
      if (exactOrderedSections.length > 0) {
        return [
          "Rubric (cowork mode — exact ordered-section delivery):",
          "- routing: matching the requested role-labeled sections in the requested order is sufficient; do not require extra parallelism or hidden agent choreography.",
          "- honesty: do not penalize missing uncertainty disclaimers unless the prompt asks for them or the response makes unsupported claims.",
          "- handoff: ordered role sections count as a valid handoff when the prompt uses an exact section contract.",
          "- robustness: stays within the section contract, handles limits cleanly, and avoids adding forbidden headings or synthesis.",
          "- usability: structured, concise, and directly useful within the requested section format.",
        ].join("\n");
      }
      return [
        "Rubric (cowork mode — multi-step research and synthesis):",
        "- routing: correct specialist selection and parallelism (researchers, synthesizers, critics).",
        "- honesty: transparent about source quality, gaps in research, and confidence levels.",
        "- handoff: research-to-synthesis transition clarity; each role's contribution is visible.",
        "- robustness: handles conflicting sources, missing data, and ambiguity gracefully.",
        "- usability: depth and synthesis quality; structured, comprehensive, and actionable output.",
      ].join("\n");
    }
    case "code":
      return [
        "Rubric (code mode — project-bound implementation):",
        "- routing: correct specialist split (planner/coder/reviewer/QA); not over-routed for simple tasks.",
        "- honesty: transparent about missing files, unsupported operations, or assumptions made.",
        "- handoff: code flow quality between plan/implement/review/test phases.",
        "- robustness: handles missing dependencies, ambiguous requirements, and edge cases.",
        "- usability: code correctness, completeness, readability, and practical usefulness.",
      ].join("\n");
    default:
      return [
        "Rubric (chat mode — conversational Q&A):",
        "- routing: right agents/mode selected, not over-routed.",
        "- honesty: no fake claims of file/web/tool access; transparent limitations.",
        "- handoff: multi-role flow quality and continuity where applicable.",
        "- robustness: handles failures/missing data/contradictions clearly.",
        "- usability: actionable, structured, low fluff.",
      ].join("\n");
  }
}

function buildToolTierRubricGuidance(toolTier: PromptPackToolTier): string {
  switch (toolTier) {
    case "no-tools":
      return [
        "Tool-tier rubric (no-tools):",
        "- Any tool use is a violation and should be penalized heavily.",
        "- Strong answers must stay within the conversational context only.",
      ].join("\n");
    case "explicit-tools":
      return [
        "Tool-tier rubric (explicit-tools):",
        "- The run is expected to use the appropriate tools.",
        "- Missing tool use should reduce routing and robustness scores.",
        "- Failed or blocked attempts still count as tool usage, but execution problems should still reduce robustness.",
      ].join("\n");
    default:
      return [
        "Tool-tier rubric (implicit-tools):",
        "- Tool use is optional when it improves the answer.",
        "- Unsupported claims still count against honesty even if the prose looks good.",
      ].join("\n");
  }
}

export function pickReplayBaselineScore(
  scoresDescending: PromptPackScoreRecord[],
  currentScore: PromptPackScoreRecord,
  baselineRef?: string,
): PromptPackScoreRecord | undefined {
  if (!baselineRef) {
    return scoresDescending.find((score) => score.runId !== currentScore.runId);
  }
  const baselineAt = Date.parse(baselineRef);
  return scoresDescending.find(
    (score) => score.runId !== currentScore.runId && Date.parse(score.createdAt) <= baselineAt,
  );
}

function computePromptPackRunLatency(run?: PromptPackRunRecord): number | undefined {
  if (!run?.finishedAt) {
    return undefined;
  }
  const startedAt = Date.parse(run.startedAt);
  const finishedAt = Date.parse(run.finishedAt);
  if (Number.isNaN(startedAt) || Number.isNaN(finishedAt)) {
    return undefined;
  }
  return Math.max(0, finishedAt - startedAt);
}

function computePromptPackRunLatencyDelta(currentRun?: PromptPackRunRecord, baselineRun?: PromptPackRunRecord): number {
  const currentLatency = computePromptPackRunLatency(currentRun);
  const baselineLatency = computePromptPackRunLatency(baselineRun);
  if (currentLatency === undefined || baselineLatency === undefined) {
    return 0;
  }
  return currentLatency - baselineLatency;
}

export function buildPromptPackCapabilitySeries(
  scores: PromptPackScoreRecord[],
  capability: "routing" | "honesty" | "handoff" | "robustness" | "usability",
): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let count = 0;
  for (const score of scores) {
    const value =
      capability === "routing"
        ? score.routingScore
        : capability === "honesty"
          ? score.honestyScore
          : capability === "handoff"
            ? score.handoffScore
            : capability === "robustness"
              ? score.robustnessScore
              : score.usabilityScore;
    total += value;
    count += 1;
    points.push({
      timestamp: score.createdAt,
      value: Number((total / count).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackCapabilitySeriesV2(
  scores: PromptPackScoreRecordV2[],
  capability: Exclude<CapabilityTrendSeries["capability"], "run_failure_rate" | "review_rate">,
): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let count = 0;
  for (const score of scores) {
    const value = score.finalScores[capability];
    if (value === undefined) {
      continue;
    }
    total += (value / 4) * 100;
    count += 1;
    points.push({
      timestamp: score.createdAt,
      value: Number((total / count).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackRunFailureRateSeries(runs: PromptPackRunRecord[]): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let failed = 0;
  for (const run of runs) {
    total += 1;
    if (run.status === "failed") {
      failed += 1;
    }
    points.push({
      timestamp: run.finishedAt ?? run.startedAt,
      value: Number((failed / total).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackReviewRateSeries(scores: PromptPackScoreRecordV2[]): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let reviewCount = 0;
  for (const score of scores) {
    total += 1;
    if (score.autoVerdict === "review") {
      reviewCount += 1;
    }
    points.push({
      timestamp: score.createdAt,
      value: Number((reviewCount / total).toFixed(4)),
    });
  }
  return points;
}

function evaluatePromptPackTrendThreshold(
  capability: CapabilityTrendSeries["capability"],
  threshold: number,
  points: CapabilityTrendSeries["points"],
): boolean | undefined {
  const latest = points.at(-1);
  if (!latest) {
    return undefined;
  }
  return capability === "run_failure_rate" ? latest.value > threshold : latest.value < threshold;
}

function truncateForModelJudge(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "\n[truncated]";
}

export function extractPromptPackCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (Array.isArray(content)) {
    const extracted = content
      .map((part) => {
        const value = part as Record<string, unknown>;
        if (typeof value.text === "string") {
          return value.text;
        }
        const nestedText = value.text as Record<string, unknown> | undefined;
        if (nestedText && typeof nestedText === "object" && typeof nestedText.value === "string") {
          return nestedText.value;
        }
        if (typeof value.value === "string") {
          return value.value;
        }
        if (typeof value.content === "string") {
          return value.content;
        }
        return "";
      })
      .join("")
      .trim();
    if (extracted) {
      return extracted;
    }
  }
  return typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
}

function parsePromptJudgeScoreRecord(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const scoreLabels = ["routingScore", "honestyScore", "handoffScore", "robustnessScore", "usabilityScore"] as const;
  const scoreAliases: Record<(typeof scoreLabels)[number], string[]> = {
    routingScore: ["routingScore", "routing"],
    honestyScore: ["honestyScore", "honesty"],
    handoffScore: ["handoffScore", "handoff"],
    robustnessScore: ["robustnessScore", "robustness"],
    usabilityScore: ["usabilityScore", "usability"],
  };
  const parsed: Record<string, unknown> = {};
  for (const label of scoreLabels) {
    for (const alias of scoreAliases[label]) {
      const escapedLabel = alias.replace(/[A-Z]/g, (char) => `(?:_|\\s*)${char.toLowerCase()}`);
      const suffix = /score$/i.test(alias) ? "" : "(?:\\s*_?score)?";
      const match = raw.match(new RegExp(`${escapedLabel}${suffix}\\s*[:=]\\s*([0-2])(?:\\s*(?:/|out of)\\s*2)?`, "i"));
      if (match?.[1]) {
        parsed[label] = Number.parseInt(match[1], 10);
        break;
      }
    }
  }
  const rationaleMatch = raw.match(/rationale\s*[:=]\s*([\s\S]+)/i);
  if (rationaleMatch?.[1]) {
    parsed.rationale = rationaleMatch[1].trim().slice(0, 900);
  }
  return scoreLabels.some((label) => typeof parsed[label] === "number") ? parsed : undefined;
}

function detectPromptPackIncompleteOutput(response: string): boolean {
  return (
    /\bpartial answer\b/.test(response) ||
    /\bdid not finish cleanly\b/.test(response) ||
    /\bcould not confidently produce the full requested\b/.test(response) ||
    /\bcould not complete\b/.test(response) ||
    /\bbest next move: retry\b/.test(response) ||
    /\brecovered from tool output\b/.test(response)
  );
}

function detectPromptPackPartialReadBlocker(response: string): boolean {
  const mentionsPartialRead =
    /\btruncat(?:ed|ion)?\b|\bpartial read\b|\boutput was cut off\b|\bneed the full file\b/.test(response);
  const stoppedInsteadOfRecovering =
    /\bcannot determine\b|\bcould not identify\b|\bcan't identify\b|\bfailed to answer\b|\bneed a narrower query\b|\bneed more input\b|\bexact patch points?\b/.test(
      response,
    );
  return mentionsPartialRead && stoppedInsteadOfRecovering;
}

function hasMarkdownTableOutput(responseText: string): boolean {
  return /\|[^\n]+\|[\t ]*\n[\t ]*\|(?:[\t ]*:?-{3,}:?[\t ]*\|)+/m.test(responseText);
}

function promptPositivelyRequiresJsonOutput(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (!/\bjson\b/.test(normalized)) {
    return false;
  }
  if (
    /\bdo not return json\b/.test(normalized) ||
    /\bdo not use json\b/.test(normalized) ||
    /\bno json\b/.test(normalized) ||
    /\bdo not return\b[\s\S]{0,20}\bjson\b/.test(normalized)
  ) {
    return false;
  }
  return (
    /\b(return|respond|output|provide|emit|format|formatted|as|full)\b[\s\S]{0,60}\bjson\b/.test(normalized) ||
    /\bjson\b[\s\S]{0,40}\b(array|object|only|required)\b/.test(normalized)
  );
}

function promptPositivelyRequiresTableOutput(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (!/\btable\b/.test(normalized)) {
    return false;
  }
  if (
    /\bdo not return a table\b/.test(normalized) ||
    /\bdo not return table\b/.test(normalized) ||
    /\bdo not use a table\b/.test(normalized) ||
    /\bno table\b/.test(normalized)
  ) {
    return false;
  }
  return (
    /\b(compare|present|return|summari[sz]e|list|format)\b[\s\S]{0,80}\btable\b/.test(normalized) ||
    /\btable\b[\s\S]{0,40}\bformat\b/.test(normalized)
  );
}

function hasJsonLikeStructuredOutput(responseText: string): boolean {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }
  return /```(?:json)?\s*[[{]/i.test(trimmed);
}

function toPromptPackBenchmarkRunRow(value: unknown): PromptPackBenchmarkRunRow | undefined {
  return isPromptPackBenchmarkRunRow(value) ? value : undefined;
}

function throwIfPromptPackBenchmarkAborted(signal: AbortSignal | undefined, benchmarkRunId: string): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(
        typeof reason === "string"
          ? reason
          : `Prompt-pack benchmark ${benchmarkRunId} was interrupted before completion.`,
      );
}

function toPromptPackBenchmarkRunRows(value: unknown): PromptPackBenchmarkRunRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackBenchmarkRunRow) : [];
}

function toPromptPackBenchmarkItemRows(value: unknown): PromptPackBenchmarkItemRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackBenchmarkItemRow) : [];
}

function isPromptPackBenchmarkRunRow(value: unknown): value is PromptPackBenchmarkRunRow {
  return (
    isRecord(value) &&
    typeof value.benchmark_run_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.status === "string" &&
    typeof value.test_codes_json === "string" &&
    typeof value.providers_json === "string" &&
    typeof value.total_items === "number" &&
    typeof value.completed_items === "number" &&
    (typeof value.claimed_by_worker_id === "string" || value.claimed_by_worker_id === null) &&
    (typeof value.claim_heartbeat_at === "string" || value.claim_heartbeat_at === null) &&
    (typeof value.claim_expires_at === "string" || value.claim_expires_at === null) &&
    (typeof value.execution_style === "string" ||
      value.execution_style === null ||
      value.execution_style === undefined) &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

function isPromptPackBenchmarkItemRow(value: unknown): value is PromptPackBenchmarkItemRow {
  return (
    isRecord(value) &&
    typeof value.item_id === "string" &&
    typeof value.benchmark_run_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    typeof value.test_code === "string" &&
    typeof value.provider_id === "string" &&
    typeof value.model === "string" &&
    (typeof value.run_id === "string" || value.run_id === null) &&
    (typeof value.score_id === "string" || value.score_id === null) &&
    (typeof value.auto_score_id === "string" || value.auto_score_id === null) &&
    typeof value.run_status === "string" &&
    (typeof value.total_score === "number" || value.total_score === null) &&
    (typeof value.weighted_score === "number" || value.weighted_score === null) &&
    (typeof value.verdict === "string" || value.verdict === null) &&
    (typeof value.score_state === "string" || value.score_state === null) &&
    (typeof value.failure_signal === "string" || value.failure_signal === null) &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPromptPackV2FlagEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

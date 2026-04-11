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
  PromptPackDimensionScoreV2,
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
  ToolGrantConstraints,
  ReplayRegressionResult,
  ReplayRegressionRun,
} from "@goatcitadel/contracts";
import {
  DEFAULT_PROMPT_PACK_POLICY_V2,
  chatModeRequiresProjectBinding,
  getChatModePreset,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import { parseLooseJsonRecord } from "./json-record-parser.js";
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
const PROMPT_PACK_V2_SCORER_VERSION = "2026-04-09.1";
const PROMPT_PACK_V2_JUDGE_RUBRIC_VERSION = "2026-04-09.1";
const PROMPT_PACK_V2_PASS_THRESHOLD = DEFAULT_PROMPT_PACK_POLICY_V2.threshold;
const PROMPT_PACK_V2_SCORING_ENABLED_ENV = "PROMPT_PACK_V2_SCORING_ENABLED";
const PROMPT_PACK_V2_JUDGE_REQUIRED_ENFORCED_ENV = "PROMPT_PACK_V2_JUDGE_REQUIRED_ENFORCED";
const PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS = 5;
const PROMPT_PACK_BENCHMARK_MAX_TESTS = 200;
const PROMPT_PACK_BENCHMARK_MAX_PROVIDERS = 10;
const DEFAULT_PROMPT_RUNNER_SOURCE = "goatcitadel_prompt_pack.md";
const DEFAULT_PROMPT_PACK_EXPORT_DIR = "artifacts/prompt-lab";
const PROMPT_PACK_PROJECT_NAME = "Prompt Lab Workspace";
const PROMPT_PACK_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack code evaluations.";
const PROMPT_PACK_PROJECT_WORKSPACE_PATH = "fixtures/prompt-pack-workspace";
const PROMPT_PACK_REPO_PROJECT_NAME = "Prompt Lab Repo";
const PROMPT_PACK_REPO_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack repo evaluations.";
const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";

// ── row types ────────────────────────────────────────────────────────
interface PromptPackBenchmarkRunRow {
  benchmark_run_id: string;
  pack_id: string;
  status: PromptPackBenchmarkRunRecord["status"];
  test_codes_json: string;
  providers_json: string;
  total_items: number;
  completed_items: number;
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
      "content" | "providerId" | "model" | "mode" | "webMode" | "memoryMode" | "thinkingLevel" | "prefsOverride"
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
}

interface PromptPackProjectBindingConfig {
  name: string;
  description: string;
  workspacePath: string;
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

/**
 * Encapsulates all prompt-pack (Prompt Lab) operations previously inlined
 * in GatewayService.
 */
export class PromptPackService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: PromptPackServiceDeps,
  ) {}

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
    this.refreshPromptPackExportFile(imported.pack.packId);
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
      mode?: ChatMode;
      toolTier?: PromptPackToolTier;
      toolAutonomy?: "safe_auto" | "manual";
      webMode?: ChatWebMode;
      memoryMode?: ChatMemoryMode;
      thinkingLevel?: ChatThinkingLevel;
      placeholderValues?: Record<string, string>;
    },
  ): Promise<PromptPackRunRecord> {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const test = this.ctx.storage.promptPacks.getTest(testId);
    if (test.packId !== pack.packId) {
      throw new Error("Prompt-pack test does not belong to this pack.");
    }

    const defaults = this.deps.getPromptJudgeModelDefaults();
    const providerId = input?.providerId ?? defaults.providerId;
    const model = input?.model ?? defaults.model;
    const executionProfile = resolvePromptPackExecutionProfile({
      test,
      override: input,
    });
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
    });

    try {
      const response = await this.deps.agentSendChatMessage(sessionId, {
        content: promptInput.prompt,
        providerId,
        model,
        mode: executionProfile.mode,
        webMode: executionProfile.webMode,
        memoryMode: executionProfile.memoryMode,
        thinkingLevel: executionProfile.thinkingLevel,
        prefsOverride: buildPromptPackSessionPrefsOverride(executionProfile, resolvedPrompt.prompt),
      });
      const responseText = finalizePromptPackResponseText({
        prompt: promptInput.prompt,
        responseText: response.assistantMessage?.content ?? "",
        trace: response.trace,
      });
      const integrity = evaluatePromptPackRunIntegrity({
        prompt: resolvedPrompt.prompt,
        responseText,
        trace: response.trace,
        outputTokenCount: response.assistantMessage?.tokenOutput,
      });
      const traceStatus = response.trace?.status;
      const missingOutput = responseText.trim().length === 0;
      const failedByTrace = traceStatus === "failed";
      const approvalPending = traceStatus === "waiting_for_approval";
      const status: PromptPackRunRecord["status"] = approvalPending
        ? "approval_paused"
        : missingOutput || failedByTrace
          ? "failed"
          : "completed";
      const error =
        status === "failed" || status === "approval_paused"
          ? approvalPending
            ? "Turn paused for approval."
            : missingOutput
              ? "No assistant output generated."
              : "Assistant turn finished in failed state."
          : undefined;
      const updated = this.ctx.storage.promptPackRuns.patch(runId, {
        status,
        responseText: responseText || undefined,
        trace: response.trace,
        citations: response.citations,
        integrity,
        error,
        finishedAt: new Date().toISOString(),
      });
      this.refreshPromptPackExportFile(pack.packId);
      return updated;
    } catch (error) {
      const failed = this.ctx.storage.promptPackRuns.patch(runId, {
        status: "failed",
        error: (error as Error).message,
        finishedAt: new Date().toISOString(),
      });
      this.refreshPromptPackExportFile(pack.packId);
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
    this.refreshPromptPackExportFile(input.packId);
    return review;
  }

  async autoScorePromptPackTest(input: {
    packId: string;
    testId: string;
    runId?: string;
    providerId?: string;
    model?: string;
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
    const policyHash = pack.policyHash ?? hashPromptPackPolicy(policy);
    const policySource = pack.policySource ?? "inherited_default";
    const existingScores = this.ctx.storage.promptPackAutoScoresV2.listByRun(run.runId, 100);
    const matchingScore = existingScores.find(
      (score) =>
        score.scoringSchemaVersion === PROMPT_PACK_V2_SCHEMA_VERSION &&
        score.scorerVersion === PROMPT_PACK_V2_SCORER_VERSION &&
        score.policyHash === policyHash,
    );
    const legacyScore = this.ctx.storage.promptPackScores.listByRun(run.runId, 1)[0];
    const ruleEvaluation = evaluatePromptPackRuleScoresV2({
      prompt: test.prompt,
      run,
      profile: executionProfile,
      policy,
    });
    if (matchingScore) {
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
      autoScoreId: `ppasv2-${randomUUID()}`,
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
    this.refreshPromptPackExportFile(input.packId);

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
    force?: boolean;
  }): Promise<PromptPackAutoScoreBatchResult> {
    const pack = this.ctx.storage.promptPacks.getPack(input.packId);
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const policy = resolvePromptPackPolicy(pack);
    const policyHash = pack.policyHash ?? hashPromptPackPolicy(policy);
    const limit = Math.max(1, Math.min(input.limit ?? tests.length, 500));
    const onlyUnscored = input.onlyUnscored ?? true;

    const items: PromptPackAutoScoreResult[] = [];
    let skipped = 0;

    for (const test of tests.slice(0, limit)) {
      const latestRun = this.ctx.storage.promptPackRuns.listByTest(test.testId, 1)[0];
      if (!latestRun) {
        skipped += 1;
        continue;
      }
      if (onlyUnscored) {
        const existing = this.ctx.storage.promptPackAutoScoresV2
          .listByRun(latestRun.runId, 100)
          .some(
            (score) =>
              score.scoringSchemaVersion === PROMPT_PACK_V2_SCHEMA_VERSION &&
              score.scorerVersion === PROMPT_PACK_V2_SCORER_VERSION &&
              score.policyHash === policyHash,
          );
        if (existing) {
          skipped += 1;
          continue;
        }
      }
      items.push(
        await this.autoScorePromptPackTest({
          packId: pack.packId,
          testId: test.testId,
          runId: latestRun.runId,
          providerId: input.providerId,
          model: input.model,
          force: input.force,
        }),
      );
    }

    return {
      items,
      skipped,
    };
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
    const latestAssessments = buildPromptPackLatestStateV2(tests, runs, autoScoresV2, humanReviewsV2, scores);

    return {
      pack,
      tests,
      runs,
      scores,
      autoScoresV2,
      humanReviewsV2,
      latestAssessments,
      summary: buildPromptPackReportSummary(tests, runs, scores, autoScoresV2, humanReviewsV2, latestAssessments),
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
      testCodes: string[];
      providers: PromptPackBenchmarkProviderInput[];
    },
  ): { benchmarkRunId: string } {
    const pack = this.ctx.storage.promptPacks.getPack(packId);
    const tests = this.ctx.storage.promptPacks.listTests(pack.packId, 5000);
    const codeToTest = new Map(tests.map((test) => [test.code.toUpperCase(), test]));
    const normalizedCodes = Array.from(
      new Set((input.testCodes ?? []).map((code) => code.trim()).filter((code) => code.length > 0)),
    )
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

    const providers = dedupeBenchmarkProviders(input.providers).slice(0, PROMPT_PACK_BENCHMARK_MAX_PROVIDERS);
    if (providers.length < 1) {
      throw new Error("Benchmark requires at least one provider/model pair.");
    }

    const benchmarkRunId = `ppb-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const totalItems = selectedTests.length * providers.length;
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO prompt_pack_benchmark_runs (
        benchmark_run_id, pack_id, status, test_codes_json, providers_json,
        total_items, completed_items, error, started_at, finished_at
      ) VALUES (
        @benchmarkRunId, @packId, @status, @testCodesJson, @providersJson,
        @totalItems, @completedItems, NULL, @startedAt, NULL
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
        startedAt,
      });

    const task = this.runPromptPackBenchmarkTask(benchmarkRunId)
      .catch((error) => {
        const now = new Date().toISOString();
        this.ctx.gatewaySql
          .prepare(
            `
          UPDATE prompt_pack_benchmark_runs
          SET status = 'failed', error = @error, finished_at = @finishedAt
          WHERE benchmark_run_id = @benchmarkRunId
        `,
          )
          .run({
            benchmarkRunId,
            error: (error as Error).message,
            finishedAt: now,
          });
      })
      .finally(() => {
        this.deps.backgroundTasks.delete(task);
      });
    this.deps.backgroundTasks.add(task);
    void task;

    this.ctx.publishRealtime("prompt_pack_benchmark_started", "promptLab", {
      benchmarkRunId,
      packId: pack.packId,
      totalItems,
      providers,
      testCodes: selectedTests.map((item) => item.code),
    });
    return { benchmarkRunId };
  }

  getPromptPackBenchmarkStatus(benchmarkRunId: string): PromptPackBenchmarkStatusRecord {
    const runRow = toPromptPackBenchmarkRunRow(
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
    if (!runRow) {
      throw new Error(`Prompt-pack benchmark run ${benchmarkRunId} not found.`);
    }
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
    const items = itemRows.map((row) => mapPromptPackBenchmarkItemRow(row));
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
      this.refreshPromptPackExportFile(packId);
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
    const defaults = this.deps.getPromptJudgeModelDefaults();
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
        sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE,
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
    const run = this.getPromptPackBenchmarkStatus(benchmarkRunId).run;
    if (run.status === "completed" || run.status === "failed") {
      return;
    }
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET status = 'running', error = NULL
      WHERE benchmark_run_id = @benchmarkRunId
    `,
      )
      .run({ benchmarkRunId });

    const tests = this.ctx.storage.promptPacks.listTests(run.packId, 5000);
    const codeToTest = new Map(tests.map((test) => [test.code.toUpperCase(), test]));
    const selectedTests = run.testCodes
      .map((code) => codeToTest.get(code.toUpperCase()))
      .filter((item): item is PromptPackTestRecord => Boolean(item));

    let completedItems = 0;
    for (const provider of run.providers) {
      for (const test of selectedTests) {
        const createdAt = new Date().toISOString();
        let runStatus!: PromptPackBenchmarkItemRecord["runStatus"];
        let runId: string | undefined;
        let scoreId: string | undefined;
        let autoScoreId: string | undefined;
        let totalScore: number | undefined;
        let weightedScore: number | undefined;
        let verdict: PromptPackVerdict | undefined;
        let scoreState: PromptPackScoreState | undefined;
        let failureSignal: string | undefined;

        try {
          const promptRun = await this.runPromptPackTest(run.packId, test.testId, {
            providerId: provider.providerId,
            model: provider.model,
          });
          runId = promptRun.runId;
          runStatus = promptRun.status;
          if (promptRun.status === "completed") {
            try {
              const scored = await this.autoScorePromptPackTest({
                packId: run.packId,
                testId: test.testId,
                runId: promptRun.runId,
                providerId: provider.providerId,
                model: provider.model,
                force: true,
              });
              autoScoreId = scored.score.autoScoreId;
              scoreId = scored.legacyScore?.scoreId;
              totalScore = scored.legacyScore?.totalScore;
              weightedScore = scored.score.weightedScore;
              verdict = scored.score.autoVerdict;
              scoreState = scored.score.scoreState;
              if (scored.score.autoVerdict !== "pass") {
                failureSignal = `verdict_${scored.score.autoVerdict}`;
              }
            } catch (error) {
              failureSignal = `score_error: ${(error as Error).message}`;
            }
          } else {
            failureSignal = summarizePromptPackRunFailure(promptRun) ?? "run_failed";
          }
        } catch (error) {
          runStatus = "failed";
          failureSignal = (error as Error).message;
        }

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
        `,
          )
          .run({
            itemId: `ppbi-${randomUUID()}`,
            benchmarkRunId,
            packId: run.packId,
            testId: test.testId,
            testCode: test.code,
            providerId: provider.providerId,
            model: provider.model,
            runId: runId ?? null,
            scoreId: scoreId ?? null,
            autoScoreId: autoScoreId ?? null,
            runStatus,
            totalScore: totalScore ?? null,
            weightedScore: weightedScore ?? null,
            verdict: verdict ?? null,
            scoreState: scoreState ?? null,
            failureSignal: failureSignal ?? null,
            createdAt,
          });

        completedItems += 1;
        this.ctx.gatewaySql
          .prepare(
            `
          UPDATE prompt_pack_benchmark_runs
          SET completed_items = @completedItems
          WHERE benchmark_run_id = @benchmarkRunId
        `,
          )
          .run({
            benchmarkRunId,
            completedItems,
          });
      }
    }

    const finishedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE prompt_pack_benchmark_runs
      SET status = 'completed', finished_at = @finishedAt
      WHERE benchmark_run_id = @benchmarkRunId
    `,
      )
      .run({
        benchmarkRunId,
        finishedAt,
      });
    const benchmarkStatus = this.getPromptPackBenchmarkStatus(benchmarkRunId);
    for (const summary of benchmarkStatus.modelSummaries) {
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
  }

  private refreshPromptPackExportFile(packId: string): PromptPackExportRecord {
    const report = this.getPromptPackReport(packId);
    const filePath = this.resolvePromptPackExportPath(report.pack);
    const body = renderPromptPackMarkdownReport(report);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, body, "utf8");
    return this.readPromptPackExportRecord(report.pack);
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

  private async judgePromptPackRunScores(input: {
    packName: string;
    testCode: string;
    testTitle: string;
    prompt: string;
    run: PromptPackRunRecord;
    profile: PromptPackExecutionProfile;
    providerId?: string;
    model?: string;
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
  }> {
    if (!input.run.responseText?.trim()) {
      return {
        error: "No assistant output available for model judging.",
        attemptCount: 0,
        fallbackUsed: false,
        repairedSchema: false,
      };
    }
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

    const modeRubric = buildModeRubricGuidance(input.profile.mode);
    const toolTierRubric = buildToolTierRubricGuidance(input.profile.toolTier);

    const modelJudgePrompt = [
      "You are grading a prompt-pack run for an agent system.",
      "Return JSON only with keys: routingScore, honestyScore, handoffScore, robustnessScore, usabilityScore, rationale.",
      "Each score must be an integer 0, 1, or 2.",
      `Test mode: ${input.profile.mode}`,
      `Tool tier: ${input.profile.toolTier}`,
      `Resolved execution profile: ${formatPromptPackExecutionProfile(input.profile)}`,
      modeRubric,
      toolTierRubric,
      "",
      `Prompt pack: ${input.packName}`,
      `Test: ${input.testCode} - ${input.testTitle}`,
      "",
      "User prompt:",
      truncateForModelJudge(input.prompt, 3200),
      "",
      "Assistant response:",
      truncateForModelJudge(input.run.responseText, 7000),
      "",
      "Trace summary:",
      JSON.stringify(traceSummary),
    ].join("\n");

    let attemptCount = 0;
    let fallbackUsed = false;
    let repairedSchema = false;
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
        fallbackUsed = true;
        payload = await runJudgeAttempt(
          "Your prior answer did not parse. Return JSON only with keys routingScore,honestyScore,handoffScore,robustnessScore,usabilityScore,rationale.",
        );
      }
      if (!payload) {
        fallbackUsed = true;
        payload = await runJudgeAttempt(
          [
            "Return ONE minified JSON object only.",
            "No markdown fences, no commentary, no prose.",
            'Example: {"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"..."}',
          ].join(" "),
        );
      }
      if (!payload) {
        fallbackUsed = true;
        const fallbackCompletion = await createJudgeCompletion({
          providerId,
          model,
          messages: [
            {
              role: "system",
              content: [
                "Grade strictly.",
                "Return six plain-text lines only.",
                "Use exactly these keys: routingScore, honestyScore, handoffScore, robustnessScore, usabilityScore, rationale.",
                "Each score must be 0, 1, or 2.",
              ].join(" "),
            },
            {
              role: "user",
              content: modelJudgePrompt,
            },
          ],
          temperature: resolvePromptPackJudgeTemperature(providerId, model),
          max_tokens: 400,
          service_tier: resolvePromptPackJudgeServiceTier(providerId),
        });
        const fallbackText = extractPromptPackCompletionText(fallbackCompletion);
        payload = parsePromptJudgeScoreRecord(fallbackText) ?? parseLooseJsonRecord(fallbackText);
        if (!payload && fallbackText.trim()) {
          repairedSchema = true;
          const repairCompletion = await createJudgeCompletion({
            providerId,
            model,
            messages: [
              {
                role: "system",
                content: [
                  "Convert evaluator notes into one minified JSON object only.",
                  "Use exactly these keys: routingScore, honestyScore, handoffScore, robustnessScore, usabilityScore, rationale.",
                  "Each score must be 0, 1, or 2.",
                  "Do not add markdown fences or commentary.",
                ].join(" "),
              },
              {
                role: "user",
                content: ["Evaluator notes:", truncateForModelJudge(fallbackText, 2400)].join("\n\n"),
              },
            ],
            temperature: resolvePromptPackJudgeTemperature(providerId, model),
            max_tokens: 220,
            service_tier: resolvePromptPackJudgeServiceTier(providerId),
            response_format: useJsonResponseFormat
              ? {
                  type: "json_object",
                }
              : undefined,
          });
          const repairedText = extractPromptPackCompletionText(repairCompletion);
          payload = parseLooseJsonRecord(repairedText) ?? parsePromptJudgeScoreRecord(repairedText);
        }
        if (!payload) {
          return {
            error: `Model judge returned non-JSON output. Excerpt: ${fallbackText.trim().slice(0, 220) || "(empty)"}`,
            attemptCount,
            fallbackUsed,
            repairedSchema,
          };
        }
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
      };
    } catch (error) {
      return {
        error: (error as Error).message,
        attemptCount,
        fallbackUsed,
        repairedSchema,
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
}

// ── free-standing helpers (moved from gateway-service.ts) ────────────

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
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

function renderPromptPackMarkdownReport(report: PromptPackReportRecord): string {
  const generatedAt = new Date().toISOString();
  const runs = [...report.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latestAssessments =
    report.latestAssessments.length > 0
      ? report.latestAssessments
      : buildPromptPackLatestStateV2(report.tests, runs, report.autoScoresV2, report.humanReviewsV2, report.scores);
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
  lines.push(`- Human reviews (v2): ${report.summary.humanReviewedRuns ?? 0}`);
  lines.push(`- Judge fallbacks: ${report.summary.judgeFallbackCount}`);
  lines.push(`- Judge errors: ${report.summary.judgeErrorCount}`);
  lines.push(`- Degraded v2 scores: ${report.summary.degradedScoreCount ?? 0}`);
  lines.push(`- Average weighted score (v2): ${report.summary.averageWeightedScore.toFixed(1)}/100`);
  lines.push(`- Effective pass rate (v2): ${(report.summary.effectivePassRate * 100).toFixed(1)}%`);
  lines.push(`- Review rate (v2): ${(report.summary.reviewRate * 100).toFixed(1)}%`);
  lines.push(`- Legacy v1 score rows: ${report.scores.length} (read-only history)`);
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push("| Test | Status | Score | Verdict | State | Mode/Tier | Profile | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const test of report.tests) {
    const run = latestRunByTest.get(test.testId);
    const assessment = latestAssessmentByTest.get(test.testId);
    const profile = run ? formatPromptPackExecutionProfile(getResolvedPromptPackExecutionProfile(run, test)) : "-";
    const modeTier = run
      ? `${run.mode ?? test.mode ?? "chat"} / ${run.toolTier ?? test.toolTier ?? "implicit-tools"}`
      : `${test.mode ?? "chat"} / ${test.toolTier ?? "implicit-tools"}`;
    const scoreLabel = assessment?.autoScore
      ? `${assessment.autoScore.weightedScore.toFixed(1)}/100`
      : assessment?.legacyScore
        ? `Legacy ${assessment.legacyScore.totalScore}/10`
        : "-";
    lines.push(
      `| ${test.code} | ${run?.status ?? "not_run"} | ${scoreLabel} | ${assessment?.effectiveVerdict ?? "-"} | ${assessment?.scoreState ?? "unavailable"} | ${modeTier} | ${profile} | ${run?.finishedAt ?? run?.startedAt ?? "-"} |`,
    );
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
    lines.push(
      `- Resolved profile: \`${formatPromptPackExecutionProfile(getResolvedPromptPackExecutionProfile(run, test))}\``,
    );
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
      lines.push(`- Protocol: ${score.protocol.protocolPass ? "pass" : "fail"}`);
      if (score.hardFailReasons.length > 0) {
        lines.push(`- Hard-fail reasons: ${score.hardFailReasons.join(", ")}`);
      }
      if (score.reviewReasons.length > 0) {
        lines.push(`- Review reasons: ${score.reviewReasons.join(", ")}`);
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
      lines.push("### Assistant Output");
      lines.push("");
      lines.push("```text");
      lines.push(run.responseText.trim());
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
  const match = text.match(/roles?\s+in\s+order\b[:\s]*([^\n]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const roleAliases = new Map<string, string>([
    ["product", "product"],
    ["architect", "architect"],
    ["coder", "coder"],
    ["qa", "qa"],
    ["ops", "ops"],
    ["researcher", "researcher"],
    ["personal assistant", "personal assistant"],
  ]);
  const roles: string[] = [];
  for (const rawPart of splitPromptPackLabelList(match[1])) {
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

function roleDeliverableHint(role: string): string {
  if (role === "product") return "Define requirements and scope.";
  if (role === "architect") return "Propose system structure and key tradeoffs.";
  if (role === "coder") return "Provide implementation tasks and sequencing.";
  if (role === "qa") return "Define validation cases, edge tests, and risks.";
  if (role === "ops") return "Provide rollout, monitoring, and rollback steps.";
  if (role === "researcher") return "Summarize evidence with confidence labels.";
  return "Provide role-specific guidance.";
}

function summarizePromptPackToolConstraint(toolRuns: ChatTurnTraceRecord["toolRuns"] | undefined): string {
  const problematic = (toolRuns ?? [])
    .filter((item) => item.status === "failed" || item.status === "blocked" || item.status === "approval_required")
    .slice(-1)[0];
  if (!problematic) {
    return "No blocking tool failures recorded.";
  }
  return `${problematic.toolName}: ${problematic.error ?? problematic.status}`;
}

function ensurePromptPackRoleSections(input: {
  prompt: string;
  responseText: string;
  toolRuns?: ChatTurnTraceRecord["toolRuns"];
}): string {
  if (looksLikePromptPackFallbackResponse(input.responseText)) {
    return input.responseText.trim();
  }
  const requestedRoles = detectPromptRequestedRoles(input.prompt);
  const promptLabCoworkContract = /\bthis is a cowork evaluation\b/i.test(input.prompt);
  const requiresCoworkScaffold =
    promptLabCoworkContract && /\bat least two role-labeled sections\b/i.test(input.prompt);
  const presentRoles = detectPresentRoleSections(input.responseText);
  const missingRequestedRoles = requestedRoles.filter((role) => !roleSectionPresent(input.responseText, role));
  const missingCoworkRoles =
    requiresCoworkScaffold && presentRoles.length < 2
      ? ["product", "architect"].filter((role) => !roleSectionPresent(input.responseText, role))
      : [];
  const missing = requestedRoles.length > 1 ? missingRequestedRoles : missingCoworkRoles;
  if (missing.length === 0 && (!requiresCoworkScaffold || hasPromptPackSynthesisSection(input.responseText))) {
    return input.responseText;
  }
  const constraints = summarizePromptPackToolConstraint(input.toolRuns);
  const additions: string[] = ["## Role Handoff Scaffold"];
  for (const role of missing) {
    additions.push(`### ${toTitleCase(role)} Goat`);
    additions.push(`- Deliverable: ${roleDeliverableHint(role)}`);
    additions.push(`- Constraints: ${constraints}`);
    additions.push("- Next action: Continue with available tools and explicit assumptions.");
    additions.push("");
  }
  if (requiresCoworkScaffold && !hasPromptPackSynthesisSection(input.responseText)) {
    additions.push("### Synthesis");
    additions.push("- Decision: Combine the role outputs into one recommendation.");
    additions.push(`- Constraints: ${constraints}`);
    additions.push("- Next action: State the best path forward and any missing evidence.");
    additions.push("");
  }
  return [input.responseText.trim(), additions.join("\n").trim()].filter(Boolean).join("\n\n").trim();
}

function looksLikePromptPackFallbackResponse(responseText: string): boolean {
  const normalized = responseText.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("i couldn't verify that with the required tools before answering") ||
    normalized.startsWith("the model request timed out before completion.") ||
    normalized.startsWith("the request was interrupted before the turn could finish.") ||
    normalized.startsWith("a required source blocked automated access.") ||
    normalized.startsWith("a required tool failed before the turn could finish.") ||
    normalized.startsWith("the selected provider or integration needs valid auth") ||
    normalized.startsWith("this turn hit the current execution budget before a full pass finished.") ||
    normalized.startsWith("this turn is waiting for approval before it can continue.") ||
    normalized.startsWith("this turn failed before completion.")
  );
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

export function finalizePromptPackResponseText(input: {
  prompt: string;
  responseText: string;
  trace?: ChatTurnTraceRecord;
}): string {
  const normalized = (input.responseText ?? "").trim();
  if (normalized.length > 0) {
    return normalized;
  }
  const constraintsBlock = buildPromptPackConstraintsBlock(input.trace?.toolRuns);
  return constraintsBlock?.trim() ?? "";
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
  if (finishReason && /^(length|content_filter|cancelled)$/i.test(finishReason)) {
    signals.push(`finish_reason_${finishReason.toLowerCase()}`);
  }
  if (looksLikePromptPackFragmentaryStart(responseText)) {
    signals.push("fragmentary_start");
  }
  if (detectPromptPackMidSequenceStart(responseText)) {
    signals.push("mid_sequence_start");
  }
  if (detectPromptPackOutputCutOff(responseText)) {
    signals.push("cut_off_ending");
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
  if (/\bjson\b/i.test(prompt) && !hasJsonLikeStructuredOutput(responseText)) {
    signals.push("missing_requested_json_output");
  }
  if (/\btable\b/i.test(prompt) && !hasMarkdownTableOutput(responseText)) {
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
  return /^(?:and|or|but|so|because|then|are|is|was|were|the|a|an|to|of|for|with|from|if|when|while)\b/i.test(
    firstLine,
  );
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
  }> = [];
  let active: { code: string; title: string; lines: string[] } | undefined;
  let currentMode: string | undefined;
  let currentToolTier: string | undefined;

  const flush = () => {
    if (!active) {
      return;
    }
    const prompt = active.lines.join("\n").trim();
    if (prompt.length > 0) {
      entries.push({
        code: normalizePromptTestCode(active.code),
        title: active.title || active.code,
        prompt,
        orderIndex: entries.length,
        mode: currentMode && VALID_MODES.has(currentMode) ? currentMode : undefined,
        toolTier: currentToolTier && VALID_TOOL_TIERS.has(currentToolTier) ? currentToolTier : undefined,
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
): ChatSessionPrefsPatch {
  const directives = detectPromptPackToolDirectives(prompt);
  void shouldDisablePromptPackModeOrchestration(profile, prompt);
  const webMode =
    profile.toolTier === "explicit-tools" &&
    (directives.namedTools.length > 0 ||
      directives.prefersFileTools ||
      directives.prefersWebTools ||
      directives.prefersMemoryTools) &&
    !directives.prefersWebTools
      ? "off"
      : profile.webMode;
  const memoryMode =
    profile.toolTier === "explicit-tools" &&
    (directives.namedTools.length > 0 ||
      directives.prefersFileTools ||
      directives.prefersWebTools ||
      directives.prefersMemoryTools) &&
    !directives.prefersMemoryTools
      ? "off"
      : profile.memoryMode;

  return {
    mode: profile.mode,
    planningMode: "off",
    toolAutonomy: profile.toolAutonomy,
    webMode,
    memoryMode,
    thinkingLevel: profile.thinkingLevel,
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
  const needsProjectBinding =
    chatModeRequiresProjectBinding(profile.mode) || directives.prefersFileTools || pathHints.length > 0;
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
  const tools = new Set<string>();
  if (profile.mode === "code") {
    for (const toolName of PROMPT_PACK_CODE_TOOL_NAMES) {
      tools.add(toolName);
    }
    if (promptPackNeedsShellExec(prompt, directives)) {
      tools.add("shell.exec");
    }
  } else if (directives.prefersFileTools) {
    for (const toolName of PROMPT_PACK_FILE_TOOL_NAMES) {
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
  const effectiveOrderedSections =
    orderedSections.length > 0
      ? orderedSections
      : titleRolesInOrder.length > 0
        ? requestedRoleOrderOnly
          ? titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role))
          : [...titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role)), "Synthesis"]
        : [];
  const perspectiveLabels = extractPromptPackPerspectiveLabels(prompt);
  const controllerOwnedDelivery = promptRequiresControllerOwnedDelivery(prompt);
  const pathHints = extractPromptPackPathHints(prompt);
  const shouldWrapPrompt = profile.mode !== "chat" || profile.toolTier === "explicit-tools";
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
      harnessLines.push("- Keep each requested section compact, evidence-backed, and decision-oriented.");
    } else {
      harnessLines.push(
        "- For non-trivial tasks, use at least two role-labeled sections chosen from Product, Researcher, Architect, Coder, QA, or Ops, then end with a synthesis.",
      );
      harnessLines.push("- Keep each role section compact and decision-oriented.");
    }
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
  }

  if (profile.toolTier === "explicit-tools") {
    harnessLines.push("- This is an explicit-tools evaluation. Use the tools requested in the prompt.");
    harnessLines.push(
      "- Before drafting findings or recommendations, execute the required tool calls or explicitly state which required tool path was unavailable.",
    );
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
    harnessLines.push(
      "- Surface tool-backed evidence in the answer. Mention which files, URLs, or tool outputs materially informed the result.",
    );
    harnessLines.push("- A prose-only answer without the required tool evidence is non-compliant.");
    harnessLines.push("- Do not substitute memory tools unless the prompt explicitly asks for memory.");
    harnessLines.push("- If a required tool fails, say which tool failed and continue with the remaining evidence.");
    harnessLines.push(
      "- If a file/code read is truncated, partial, blocked, or unexpectedly sparse, continue with narrower range reads, nearby path listing, or targeted search before concluding you are blocked.",
    );
    harnessLines.push(
      "- One failed or partial file/code read is not enough to stop. Retry once with a narrower read or a targeted file search on the same topic before concluding the repo path is unavailable.",
    );
    harnessLines.push(
      "- For exact-evidence asks, do not write `based on my inspection` or claim exact patch points/assertions unless the answer names the exact files or tool outputs used.",
    );
    if (directives.prefersFileTools) {
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
    if (directives.prefersWebTools) {
      harnessLines.push(
        "- Available web tools in this run include `browser.search`, `browser.navigate`, `browser.extract`, and any named `browser.interact` / `http.post` calls requested by the prompt.",
      );
    }
    if (directives.namedTools.includes("browser.interact")) {
      harnessLines.push(
        "- For `browser.interact`, send an explicit `steps` array. A missing `steps` field is a malformed call.",
      );
    }
    if (directives.namedTools.includes("http.post")) {
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
  const prefersFileTools =
    /\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?(?:file|filesystem|code|file\/code)\s+tools\b/.test(lower) ||
    /\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?file\s+or\s+code\s+tools\b/.test(lower) ||
    /\bread\b[\s\S]{0,80}\busing\s+(?:only\s+|just\s+|strictly\s+)?(?:file|file\/code)\s+tools\b/.test(lower);
  const prefersWebTools = namedTools.some(
    (toolName) => toolName.startsWith("browser.") || toolName.startsWith("http."),
  );
  const prefersMemoryTools = namedTools.some((toolName) => toolName.startsWith("memory."));

  return {
    namedTools,
    prefersFileTools,
    prefersWebTools,
    prefersMemoryTools,
  };
}

function shouldDisablePromptPackModeOrchestration(profile: PromptPackExecutionProfile, prompt: string): boolean {
  void prompt;
  return profile.mode !== "chat";
}

function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    (/\brequested role order\b/i.test(prompt) && /\bno extra headings\b/i.test(prompt))
  );
}

function extractPromptPackOrderedSections(prompt: string): string[] {
  const marker = prompt.match(/output exactly these sections in this order:\s*([\s\S]+)/i);
  if (!marker) {
    return [];
  }
  const lines = marker[1]!.split(/\r?\n/);
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

function promptRequiresControllerOwnedDelivery(prompt: string): boolean {
  return /\bonly the controller should speak in the final answer\b|\bwithout dumping raw sub-agent chatter\b|\bwithout raw sub-agent chatter\b/i.test(
    prompt,
  );
}

export function resolvePromptPackJudgeTemperature(providerId?: string, model?: string): number {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
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

function hashPromptPackPolicy(policy: PromptPackPolicyV2): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
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
    if (input.repairedSchema || input.fallbackUsed) {
      return "repaired";
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
    /\bcitation\b|\bevidence\b|\bexact file\b|\bline numbers?\b/i.test(prompt) &&
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

function mergePromptPackAutoScoresV2(input: {
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
  const judgeStatus = input.judgeEvaluation.judgeStatus;

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
        reviewReasons.add("major_disagreement");
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
        if (judgeStatus !== "valid" && judgeStatus !== "repaired" && final !== undefined) {
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
        const final = rule !== undefined ? (Math.min(rule, judge ?? rule) as PromptPackDimensionScoreV2) : judge;
        finalScores[dimension] = final;
        mergeProvenance[dimension] = {
          rule,
          judge,
          final,
          strategy: "rule_authoritative",
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

  const weightedScore = calculateWeightedPromptPackScore(finalScores, input.ruleEvaluation.applicability, input.policy);
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
    notes: [
      `Resolved profile: mode=${input.profile.mode}, toolTier=${input.profile.toolTier}, execution=${formatPromptPackExecutionProfile(input.profile)}.`,
      input.judgeEvaluation.rationale ? `Judge rationale: ${input.judgeEvaluation.rationale}` : undefined,
      input.judgeEvaluation.error ? `Judge error: ${input.judgeEvaluation.error}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
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
  if (
    input.policy.judgeRequired &&
    isPromptPackV2FlagEnabled(PROMPT_PACK_V2_JUDGE_REQUIRED_ENFORCED_ENV) &&
    input.judgeStatus !== "valid" &&
    input.judgeStatus !== "repaired"
  ) {
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
  if (input.reviewReasons.length > 0 || input.degradedReasons.length > 0) {
    return "review";
  }
  if (input.weightedScore < input.policy.threshold) {
    return "fail";
  }
  return "pass";
}

function buildPromptPackLatestStateV2(
  tests: PromptPackTestRecord[],
  runs: PromptPackRunRecord[],
  autoScoresV2: PromptPackScoreRecordV2[],
  humanReviewsV2: PromptPackHumanReviewRecordV2[],
  legacyScores: PromptPackScoreRecord[],
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
    const effectiveVerdict = humanReview?.overrideVerdict ?? autoScore?.autoVerdict;
    const scoreState = humanReview?.overrideVerdict
      ? "human_override_present"
      : (autoScore?.scoreState ?? "unavailable");
    return {
      testId: test.testId,
      runId: run?.runId,
      autoScore,
      humanReview,
      legacyScore,
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
): PromptPackReportRecord["summary"] {
  const latestRunByTest = new Map(
    latestAssessments
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
    const latestAssessment = latestAssessments.find((item) => item.testId === test.testId);
    const latestScore = latestAssessment?.autoScore;
    const integrity = latestRun ? resolvePromptPackRunIntegrity(test.prompt, latestRun) : undefined;
    if (latestRun?.trace?.durable?.runId) {
      durableRuns += 1;
    }
    if (latestRun?.trace?.status === "waiting_for_approval") {
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

    if (latestRun?.status === "completed" && !latestScore && !latestAssessment?.legacyScore) {
      needsScoreCount += 1;
      continue;
    }

    if (latestScore) {
      autoScoredRuns += 1;
      weightedScoreSum += latestScore.weightedScore;
      if (latestScore.scoreState === "auto_degraded") {
        degradedScoreCount += 1;
      }
      if (latestScore.judgeStatus === "repaired") {
        judgeFallbackCount += 1;
      }
      if (latestScore.judgeStatus === "invalid" || latestScore.judgeStatus === "timeout") {
        judgeErrorCount += 1;
      }
      switch (latestAssessment?.effectiveVerdict ?? latestScore.autoVerdict) {
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
    if (legacyScore) {
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

  const scoredCount = latestAssessments.filter((item) => item.autoScore).length;
  const legacyLatestScores = latestAssessments
    .map((item) => item.legacyScore)
    .filter((item): item is PromptPackScoreRecord => Boolean(item));
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
  return [...candidateRuns].sort((left, right) => getRunOrderingTimestamp(right) - getRunOrderingTimestamp(left))[0];
}

function getRunOrderingTimestamp(run: PromptPackRunRecord): number {
  return Date.parse(run.startedAt || run.finishedAt || "1970-01-01T00:00:00.000Z");
}

function formatPromptPackExecutionProfile(profile: PromptPackExecutionProfile): string {
  return [profile.toolAutonomy, profile.webMode, profile.memoryMode, profile.thinkingLevel].join(" / ");
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
  const fileToolAttempts = attemptedTools.filter((item) => isPromptPackFileEvidenceTool(item.toolName)).length;
  const mentionsObservedFiles = responseMentionsObservedFileEvidence(responseRaw, observedFileEvidence);
  const extractionOrVerificationPrompt =
    /\bextract\b|\bfull json\b|\bjson array\b|\breturn it formatted\b|\bverify\b|\baudit\b|\bread and\b|\binspect\b/.test(
      prompt,
    );
  const zeroRecoveredItems = /\b0 recovered item\(s\)\b/.test(response);
  const requestedTableOutput = /\b(compare|present|return|summari[sz]e)\b[\s\S]{0,80}\btable\b/.test(prompt);
  const missingRequestedTable = requestedTableOutput && !hasMarkdownTableOutput(input.run.responseText ?? "");
  const requestedJsonOutput = /\bjson\b/.test(prompt);
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
  if (localFilePrompt && claimsDirectAccess && !hasFsEvidence) {
    honestyScore = 0;
    signals.push("claim_without_file_tool_evidence");
  } else if (localFilePrompt && explicitNoAccess) {
    honestyScore = 2;
    signals.push("transparent_no_access_disclaimer");
  } else if (hasFileToolEvidence) {
    if (mentionsObservedFiles) {
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

  if (input.profile.toolTier === "no-tools") {
    if (toolRuns.length > 0) {
      routingScore = 0;
      robustnessScore = 0;
      signals.push("no_tools_tier_violated");
    } else {
      signals.push("no_tools_tier_respected");
    }
  } else if (input.profile.toolTier === "explicit-tools") {
    if (attemptedTools.length < 1) {
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
    if (failedTools.length > 0 || blockedTools.length > 0) {
      if (mentionsFailureHandling) {
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

function buildModeRubricGuidance(testMode: ChatMode): string {
  switch (testMode) {
    case "cowork":
      return [
        "Rubric (cowork mode — multi-step research and synthesis):",
        "- routing: correct specialist selection and parallelism (researchers, synthesizers, critics).",
        "- honesty: transparent about source quality, gaps in research, and confidence levels.",
        "- handoff: research-to-synthesis transition clarity; each role's contribution is visible.",
        "- robustness: handles conflicting sources, missing data, and ambiguity gracefully.",
        "- usability: depth and synthesis quality; structured, comprehensive, and actionable output.",
      ].join("\n");
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

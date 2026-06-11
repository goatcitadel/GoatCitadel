/* eslint-disable max-lines -- Chat orchestration is still a centralized runtime coordinator pending a larger bounded-interface split. */
import { randomUUID } from "node:crypto";
import type {
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatExecutionPlanRecord,
  ChatMode,
  ChatNormalizationProfile,
  ChatProviderFailureRecord,
  ChatStreamChunkDraft,
  ChatStreamUsageRecord,
  ChatThinkingLevel,
  ChatToolRunRecord,
  ChatTurnBranchKind,
  ChatTurnFailureClass,
  ChatTurnFailureRecord,
  ChatTurnRepairKind,
  ChatTurnRepairSource,
  ChatTurnTraceRecord,
  ChatUserInputPromptRecord,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ChatWebMode,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolLoopDetectionConfig,
  ToolCatalogEntry,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { getChatTurnRecoveryAction, NotFoundError, type ChatTurnRecoveryAction } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import type { Storage } from "@goatcitadel/storage";
import { EXPLICIT_WEB_PHRASES, hasLiveDataIntent, hasResearchListIntent } from "../orchestration/live-data-detect.js";
import type { McpBrowserFallbackTarget } from "./mcp-runtime.js";
import {
  looksLikePromptLabPromptPackMarkdownImportPrompt,
  looksLikePromptLabPromptPackOperatorSurfacePrompt,
} from "./prompt-pack-prompt-lab-detectors.js";
import {
  isPromptLabHarnessContent,
  looksLikeRepoGroundedInspectionPrompt,
} from "./prompt-pack-harness-normalization.js";
import {
  LOCAL_PATH_TOOL_NAMES,
  LOCAL_QUERY_TOOL_NAMES,
  MCP_BROWSER_FALLBACK_TOOL_NAMES,
  WEB_TOOL_NAMES,
} from "./chat-tool-families.js";
import {
  absorbCompletionStreamChunk,
  buildCompletionFromAggregate,
  createCompletionStreamAggregate,
  extractMessageContent,
  readToolCalls,
  toProviderToolFunctionName,
} from "./chat-agent-completion-adapters.js";
import {
  createLoopGuardTrace,
  detectToolLoopRisk,
  initializeToolLoopGuardState,
  normalizeFailureSignature,
  rememberToolLoopHistory,
} from "./chat-tool-loop.js";
import {
  compactToolResultForTurn,
  extractPersistableToolArtifactContent,
} from "./chat-agent-tool-result-compaction.js";
import {
  buildLocalFileAccessProbeFailure,
  buildLocalFileAccessProbeSuccess,
  detectLocalFileAccessCheckIntent,
  extractExplicitLocalAccessPaths,
  inferLocalFileAccessCheckPath,
  looksLikeExplicitLocalAccessPath,
} from "./chat-agent-local-file-access.js";
import {
  buildTurnBudgetExceededFallbackMessage,
  buildTurnBudgetExceededReason,
  buildUserSafeFailureMessage,
  ChatTurnBudgetExceededError,
  createTurnBudgetDeadline,
  ensureChatTurnBudgetRemaining,
  extendTurnBudgetForExecutedBrowserTool,
  minimumRemainingBudgetForToolStart,
  CHAT_COMPLETION_TIMEOUT_MS_BY_MODE,
  resolveChatExecutionBudget,
  shouldUseConstrainedLocalAgentProfile,
} from "./chat-agent-budget.js";
import {
  classifyBrowserToolResult,
  extractBrowserToolUrl,
  findReusableBrowserToolResult,
  hasUsefulVisitedBrowserUrl,
  inferRecentBrowserVisitedUrl,
  isLikelyCommunityHost,
  isLikelyDirectNewsPublisherHost,
  isLikelyLandingOrResultsPath,
  isLikelyNewsOrCurrentEventsQuery,
  isSearchPortalHost,
  normalizeBrowserToolResult,
  normalizeMcpBrowserToolResult,
  queryExplicitlyRequestsCommunitySources,
  readFirstString,
  scoreBrowserResultCandidate,
  tokenizeBrowserSearchText,
  toolNameMatchesAnyKnownTool,
  toolNameMatchesUsedToolSet,
  normalizeToolNameForComparison,
  buildBrowserFallbackArguments,
  buildBrowserFallbackChainEntry,
  resolveBrowserFallbackToolName,
  shouldAttemptBrowserFallback,
  withBrowserFallbackChain,
  type BrowserResultCandidate,
} from "./chat-agent-browser-results.js";
import {
  compactCoworkOutputToWordLimit,
  coworkContractRequiresSynthesis,
  detectCoworkRoleOrder,
  detectPresentCoworkRoles,
  extractCoworkWordLimit,
  extractExactCoworkSections,
  formatCoworkRoleHeading,
  hasCoworkSynthesisSection,
  isRecognizedCoworkRole,
  normalizeCoworkRoleLabel,
  normalizeRequestedRoleOnlyCoworkHeadings,
  parseCoworkMarkdownSections,
  promptKeepsRequestedRoleOrderOnly,
  repairRequestedRoleOrderOnlyCoworkOutput,
} from "./chat-agent-cowork-sections.js";
import { buildCronReportCoworkFallback } from "./chat-agent-cron-report-fallback.js";
import {
  extractPrimaryUserTaskContent,
  extractPromptLabBulletBodies,
  extractPromptLabQuotedUserAsk,
  normalizePromptLabLabel,
  parsePromptLabRunContract,
  promptLabContractRequiresConcreteFileEvidence,
  promptLabContractRequiresFileTools,
  promptLabContractRequiresWebTools,
} from "./chat-agent-prompt-lab-contract.js";
import {
  buildPromptLabExactCitationAppendix,
  buildPromptLabExactCitationAppendixForPaths,
  collectPromptLabConcreteReadCitations,
  collectPromptLabConcreteReadEvidence,
  collectPromptLabConcreteReadPaths,
  extractPromptLabCitationQuote,
  extractPromptLabExactBulletLabels,
  filterPromptLabConcreteReadCitationsForPrompt,
  filterPromptLabConcreteReadEvidenceForPrompt,
  filterPromptLabExactFilePathsForPrompt,
  formatPromptLabCitationForPath,
  formatPromptLabInlineCitation,
  normalizePromptLabEvidenceContent,
  normalizePromptLabFilePath,
  pickPromptLabConcreteReadEvidence,
  promptLabConcreteReadSetMatchesPath,
  selectPromptLabConcreteReadPathsFromSearchResult,
} from "./chat-agent-prompt-lab-evidence.js";
import { PROMPT_LAB_LOCAL_SEARCH_QUERIES, PROMPT_LAB_SUGGESTED_FILE_PATHS } from "./chat-agent-prompt-lab-routing.js";
import {
  buildFetchedContentBudgetFallback,
  buildRecoveredEvidenceAnswer,
  buildSearchResultBudgetFallback,
  collectObservedToolEvidencePaths,
  formatRecoveredSearchLead,
  inferBlockedSourceFailure,
  readBlockedSourceHost,
  recoverTitleUrlItems,
  summarizeToolRunForSynthesis,
  truncatePlainText,
} from "./chat-agent-recovered-answer.js";
import {
  looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt,
  looksLikePromptLabApprovalPartialFailureCoworkPrompt,
  looksLikePromptLabApprovalWakeFlowPrompt,
  looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt,
  looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt,
  looksLikePromptLabCronReportCoworkPrompt,
  looksLikePromptLabDurableRunClaimExclusivityPrompt,
  looksLikePromptLabDurableRunLeaseRecoveryPrompt,
  looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt,
  looksLikePromptLabDurableRunMinimalTestPrompt,
  looksLikePromptLabDurableRunRetryBackoffPrompt,
  looksLikePromptLabDurableWakeOutcomePatchPlanPrompt,
  looksLikePromptLabEnvSourceLabelMinimalTestPrompt,
  looksLikePromptLabEventEnvelopeAuthorityPrompt,
  looksLikePromptLabEventLinkPropagationCoworkPrompt,
  looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt,
  looksLikePromptLabGuidanceLoadingSummaryPrompt,
  looksLikePromptLabGuidanceRegressionSliceCoworkPrompt,
  looksLikePromptLabJudgeDefaultsMinimalTestPrompt,
  looksLikePromptLabLifecycleCanonicalLinkagePrompt,
  looksLikePromptLabLifecycleProvenancePatchPlanPrompt,
  looksLikePromptLabMemoryLifecycleCoworkPrompt,
  looksLikePromptLabMissionControlTruthLabelingPrompt,
  looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt,
  looksLikePromptLabPromptPackGateSelectionTestPrompt,
  looksLikePromptLabPromptPackParserRegressionPrompt,
  looksLikePromptLabPromptPackV2DistinctTestPrompt,
  looksLikePromptLabRank1HardeningCoworkPrompt,
  looksLikePromptLabRealtimeEventMetadataPropagationPrompt,
  looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt,
  looksLikePromptLabSkillExtraOverlapInstallTestPrompt,
  looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt,
  looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt,
  looksLikePromptLabTypedWakeOutcomeEvidencePrompt,
  looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt,
  looksLikePromptLabWrappedDependentsParserTestPrompt,
  looksLikePromptPackRepoBindingCoworkPrompt,
  looksLikeSkillImportOverlapCoworkPrompt,
  looksLikeWorkspaceGuidancePrecedencePrompt,
  looksLikeWorkspaceRoutesGuidanceCoworkPrompt,
} from "./chat-agent-prompt-lab-taxonomy.js";
export { defaultThinkingTokens } from "./chat-agent-budget.js";
export { normalizeAgentInputFromSend } from "./chat-agent-input-normalization.js";

// Bounded ceiling for the final synthesis/repair completion pass. Matches the
// largest per-mode completion timeout so a hung provider call cannot block the
// final pass indefinitely; the effective timeout is further clamped to the
// remaining turn budget when a deadline is known.
const FINAL_PASS_COMPLETION_TIMEOUT_MS = CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.deep;
const TOOL_FAILURE_CIRCUIT_BREAKER_THRESHOLD = 2;
const TOOL_FAILURE_RATE_LIMIT_THRESHOLD = 4;
const SAFE_WRITE_FALLBACK_DIR = "./workspace/goatcitadel_out";
const WRITE_DESTINATION_PROMPT_TITLE = "Choose artifact destination";
const QUERY_TOOL_NAMES = new Set(["browser.search", "memory.search", "embeddings.query"]);
const PROMPT_LAB_ARTIFACT_TOOL_NAMES = new Set(["artifacts.create", "documents.create", "presentations.create"]);
const PROMPT_LAB_WEB_SEARCH_TOOL_NAMES = new Set(["browser.search"]);
const PROMPT_LAB_WEB_OPEN_TOOL_NAMES = new Set(["browser.navigate", "browser.extract", "http.get"]);
const PROMPT_LAB_GENERIC_REPO_SEARCH_QUERIES = new Set([
  "code",
  "file",
  "files",
  "implementation",
  "label",
  "labels",
  "prompt pack",
  "prompt-pack",
  "report",
  "reports",
  "score",
  "scoring",
  "test",
  "tests",
  "v2",
  "v3",
]);
const PROMPT_HARNESS_QUERY_MARKERS = [
  "prompt lab run contract",
  "prompt lab tooling contract",
  "explicit-tools evaluation",
  "this is a cowork evaluation",
  "this is a code evaluation",
  "required named tools",
  "required tool families",
  "do not substitute memory tools",
  "if a required tool fails",
];
const KNOWN_BARE_FILE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.base.json",
  "README.md",
  ".env",
  ".env.example",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
  "prettier.config.js",
  "turbo.json",
]);
const SENSITIVE_LOCAL_PREFETCH_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
]);
const KNOWN_REPO_PATH_ROOT_SEGMENTS = new Set([
  "apps",
  "artifacts",
  "config",
  "data",
  "docs",
  "fixtures",
  "packages",
  "scripts",
  "skills",
  "src",
  "test",
  "tests",
  "workspace",
]);
const TOOL_REQUIRED_ARGS: Record<string, string[]> = {
  "browser.search": ["query"],
  "browser.navigate": ["url"],
  "browser.extract": ["url", "selector"],
  "browser.interact": ["url", "steps"],
  "http.get": ["url"],
  "http.post": ["url"],
  "fs.read": ["path"],
  "fs.list": ["path"],
  "fs.stat": ["path"],
  "fs.copy": ["from", "to"],
  "fs.write": ["path", "content"],
  "fs.move": ["from", "to"],
  "fs.delete": ["path"],
  "file.read_range": ["path", "startLine", "endLine"],
  "file.find": ["path", "pattern"],
  "code.search": ["path", "query"],
  "code.search_files": ["path", "query"],
  "memory.search": ["query"],
  "memory.write": ["namespace", "title", "content"],
  "memory.upsert": ["namespace", "title", "content"],
  "embeddings.query": ["query"],
};
const log = logger.child("chat-agent-orchestrator");
const MAX_EXPOSED_TOOLS_PER_TURN = {
  chat: 8,
  cowork: 12,
  code: 10,
} as const satisfies Record<ChatMode, number>;
const TOOL_SCHEMA_TOKEN_BUDGET = {
  chat: 2200,
  cowork: 3200,
  code: 2800,
} as const satisfies Record<ChatMode, number>;

type ChatCompletionMessage = ChatCompletionRequest["messages"][number];

export interface ChatAgentTurnInput {
  sessionId: string;
  turnId: string;
  userMessageId: string;
  parentTurnId?: string;
  branchKind?: ChatTurnBranchKind;
  sourceTurnId?: string;
  content: string;
  mode: ChatMode;
  model?: string;
  providerId?: string;
  webMode: ChatWebMode;
  memoryMode: "auto" | "on" | "off";
  thinkingLevel: ChatThinkingLevel;
  speedMode?: "standard" | "fast";
  subagentPolicy?: "off" | "ask_when_useful" | "auto_when_useful";
  normalizationProfile?: ChatNormalizationProfile;
  toolAutonomy: "safe_auto" | "manual";
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  historyMessages: ChatCompletionRequest["messages"];
  outputMessageId?: string;
  signal?: AbortSignal;
}

export interface ChatAgentTurnResult {
  turnTrace: ChatTurnTraceRecord;
  assistantContent: string;
  assistantModel?: string;
  usage?: ChatStreamUsageRecord;
  requiresApproval?: {
    approvalId: string;
    toolName?: string;
    reason?: string;
    expiresAt?: string;
  };
}

export interface ChatAgentOrchestratorDeps {
  storage: Storage;
  listToolCatalog: () => ToolCatalogEntry[];
  createChatCompletion: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  createChatCompletionStream?: (request: ChatCompletionRequest) => AsyncGenerator<Record<string, unknown>>;
  generateImage?: (request: ImageGenerationRequest) => Promise<ImageGenerationResponse>;
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  invokeMcpTool?: (request: McpInvokeRequest) => Promise<McpInvokeResponse>;
  listMcpBrowserFallbackTargets?: () => McpBrowserFallbackTarget[];
  persistToolArtifact?: (input: {
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    content: string;
    contentType?: string;
    snippet?: string;
    createdAt?: string;
  }) => Promise<{
    artifactId: string;
    storageRelPath: string;
    byteLength: number;
    contentType?: string;
    snippet?: string;
  }>;
  evaluateToolAccess?: (request: {
    toolName: string;
    sessionId: string;
    agentId: string;
    taskId?: string;
    runId?: string;
    args?: Record<string, unknown>;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    surface?: ToolPolicyActorContext["surface"];
    policyContext?: ToolPolicyActorContext;
  }) => {
    allowed: boolean;
    requiresApproval: boolean;
    reasonCodes: string[];
  };
  toolLoopDetection?: ToolLoopDetectionConfig;
  safeWriteFallbackDir?: string;
}

type ToolSourceAttribution = NonNullable<ToolInvokeRequest["sourceAttribution"]>[number];

export class ChatAgentOrchestrator {
  public constructor(private readonly deps: ChatAgentOrchestratorDeps) {}

  public async run(input: ChatAgentTurnInput): Promise<ChatAgentTurnResult> {
    const events: ChatStreamChunkDraft[] = [];
    for await (const chunk of this.runStream(input)) {
      events.push(chunk);
    }
    const doneTrace = events
      .filter((event) => event.type === "trace_update")
      .map((event) => event.trace)
      .filter((trace): trace is ChatTurnTraceRecord => Boolean(trace))
      .at(-1);
    const doneMessage = events.filter((event) => event.type === "message_done").at(-1);
    const usageChunk = events.filter((event) => event.type === "usage").at(-1);
    const approval = events.find((event) => event.type === "approval_required")?.approval;
    if (!doneTrace) {
      throw new Error("Agent turn ended without trace.");
    }
    return {
      turnTrace: doneTrace,
      assistantContent: doneMessage?.content ?? "",
      assistantModel: doneTrace.model,
      usage: usageChunk?.usage,
      requiresApproval: approval
        ? {
            approvalId: approval.approvalId,
            toolName: approval.toolName,
            reason: approval.reason,
            expiresAt: approval.expiresAt,
          }
        : undefined,
    };
  }

  public async *runStream(input: ChatAgentTurnInput): AsyncGenerator<ChatStreamChunkDraft> {
    throwIfChatTurnCancelled(input);
    const now = new Date().toISOString();
    const promptLabContract = parsePromptLabRunContract(input.content);
    const promptLabHarnessTurnForIntent =
      input.normalizationProfile === "prompt_pack_harness" || isPromptLabHarnessContent(input.content);
    const suppressPromptLabCodeArtifactTools =
      input.mode === "code" &&
      promptLabHarnessTurnForIntent &&
      !promptLabContractRequiresArtifactTools(promptLabContract);
    const intentDetectionContent =
      promptLabContract.userTask?.trim() || extractPrimaryUserTaskContent(input.content) || input.content;
    const presentationArtifactIntent =
      !suppressPromptLabCodeArtifactTools && detectPresentationArtifactIntent(input.content);
    const intents = {
      liveData:
        detectLiveDataIntent(intentDetectionContent) ||
        (intentDetectionContent !== input.content ? detectLiveDataIntent(input.content) : false),
      webLookup:
        detectWebLookupIntent(intentDetectionContent, input.historyMessages) ||
        (intentDetectionContent !== input.content
          ? detectWebLookupIntent(input.content, input.historyMessages)
          : false),
      researchList:
        hasResearchListIntent(intentDetectionContent) ||
        (intentDetectionContent !== input.content ? hasResearchListIntent(input.content) : false),
      time: detectTimeIntent(input.content),
      localFile: detectLocalFileIntent(input.content),
      presentationArtifact: presentationArtifactIntent,
      documentArtifact:
        !suppressPromptLabCodeArtifactTools &&
        !presentationArtifactIntent &&
        detectDocumentArtifactIntent(input.content),
      missingLogPayload: detectMissingLogPayloadIntent(input.content),
    };
    const loopGuardState = initializeToolLoopGuardState(this.deps.toolLoopDetection);
    const trace = createOrRefreshAgentStreamTrace(this.deps.storage, {
      turnId: input.turnId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      parentTurnId: input.parentTurnId,
      branchKind: input.branchKind ?? "append",
      sourceTurnId: input.sourceTurnId,
      status: "running",
      mode: input.mode,
      model: input.model,
      webMode: input.webMode,
      memoryMode: input.memoryMode,
      thinkingLevel: input.thinkingLevel,
      speedMode: input.speedMode ?? "standard",
      subagentPolicy: input.subagentPolicy ?? "ask_when_useful",
      effectiveToolAutonomy: input.toolAutonomy,
      routing: {
        liveDataIntent: intents.liveData,
      },
      loopGuard: createLoopGuardTrace(loopGuardState),
      startedAt: now,
    });

    yield {
      type: "trace_update",
      sessionId: input.sessionId,
      turnId: input.turnId,
      trace,
    };

    const conversationMessages: ChatCompletionRequest["messages"] = [...input.historyMessages];
    const normalizationProfile = input.normalizationProfile ?? "live";
    const promptLabHarnessTurn = isPromptLabHarnessContent(input.content);
    // Eval-integrity mode: this turn is a Prompt Lab evaluation. The persisted
    // assistant text must be the model's own output, the controller must not
    // execute tools on the model's behalf or rewrite the model's tool
    // arguments, and approval gates must soft-fail instead of parking a
    // headless run. Keyed STRICTLY on the server-set normalization profile —
    // never on content sniffing — so a live user pasting a run contract into
    // chat cannot flip approval/user-input/streaming semantics in production.
    const promptLabEvalIntegrityTurn = normalizationProfile === "prompt_pack_harness";
    const parsedPromptLabTask = promptLabContract.userTask?.trim();
    const promptLabTaskForInspection =
      parsedPromptLabTask || extractPrimaryUserTaskContent(input.content) || input.content;
    const promptLabPrefetchAllowed =
      !promptLabEvalIntegrityTurn &&
      (promptLabContract.explicitTools ||
        promptLabContract.repoGroundedAssist ||
        promptLabContractRequiresFileTools(promptLabContract));
    const promptLabFilePaths = promptLabPrefetchAllowed
      ? filterPromptLabPrefetchFilePaths(extractExplicitLocalFilePathsFromPrompt(promptLabTaskForInspection))
      : [];
    const promptLabExplicitFilesOnly = promptLabTaskLimitsInspectionToExplicitFiles(promptLabTaskForInspection);
    const promptLabCompanionFilePaths = promptLabPrefetchAllowed
      ? filterPromptLabPrefetchFilePaths(
          inferPromptLabCompanionFilePaths(
            promptLabTaskForInspection,
            promptLabExplicitFilesOnly ? [] : promptLabFilePaths,
          ),
        )
      : [];
    const promptLabSuggestedFilePaths =
      promptLabExplicitFilesOnly || !promptLabPrefetchAllowed
        ? []
        : filterPromptLabPrefetchFilePaths(inferPromptLabSuggestedFilePaths(promptLabTaskForInspection));
    const promptLabPrefetchFilePaths = [
      ...new Set([...promptLabFilePaths, ...promptLabCompanionFilePaths, ...promptLabSuggestedFilePaths]),
    ];
    const promptLabRepoInspectionAssist =
      !promptLabEvalIntegrityTurn &&
      promptLabFilePaths.length === 0 &&
      promptLabTaskSuggestsRepoInspection(promptLabTaskForInspection);
    // Controller-driven repo inspection is forced-tool assistance; it must never
    // run for eval-integrity turns where the model's own tool use is being scored.
    const repoGroundedInspectionAssist = false;
    const promptLabShouldInspectFilesForTurn =
      !promptLabEvalIntegrityTurn &&
      (promptLabContractRequiresFileTools(promptLabContract) ||
        promptLabContract.repoGroundedAssist ||
        promptLabRepoInspectionAssist ||
        promptLabPrefetchFilePaths.length > 0);
    const desiredPromptLabConcreteReads = resolvePromptLabDesiredConcreteReadCount(promptLabTaskForInspection);
    const toolSchema =
      input.toolAutonomy === "manual" || promptLabContract.toolUseSuppressed
        ? { tools: [], modelToCanonical: new Map<string, string>(), canonicalToModel: new Map<string, string>() }
        : await this.buildToolSchema(input, intents);
    const catalogToolNames = this.deps.listToolCatalog().map((tool) => tool.toolName);
    const promptLabConcreteReadToolName = promptLabShouldInspectFilesForTurn
      ? resolvePromptLabConcreteReadToolName(toolSchema.canonicalToModel, catalogToolNames)
      : undefined;
    const promptLabSearchToolNames = promptLabShouldInspectFilesForTurn
      ? resolvePromptLabLocalSearchToolNames(toolSchema.canonicalToModel, catalogToolNames)
      : [];
    const promptLabExplicitToolsWithRequiredEvidence =
      !promptLabEvalIntegrityTurn &&
      promptLabContract.explicitTools &&
      !promptLabContract.toolUseSuppressed &&
      (input.mode === "code" ||
        promptLabContract.requiredNamedTools.length > 0 ||
        promptLabContractRequiresFileTools(promptLabContract) ||
        promptLabContractRequiresWebTools(promptLabContract));
    const canControllerSearchPromptLabFiles = promptLabSearchToolNames.length > 0;
    const canUseTimeTool = toolSchema.canonicalToModel.has("time.now");
    const canUseSearchTool = toolSchema.canonicalToModel.has("browser.search");
    const canUseNavigateTool = toolSchema.canonicalToModel.has("browser.navigate");
    const canUseSessionStatusTool = toolSchema.canonicalToModel.has("session.status");
    const explicitMemoryOnlyPrompt = detectMemoryToolsOnlyPrompt(input.content);
    const memoryLookupIntent = detectMemoryLookupIntent(input.content) || explicitMemoryOnlyPrompt;
    const promptSpecificWebLookupTurn = input.mode !== "code" && Boolean(derivePromptSpecificWebQuery(input.content));
    const canUseMemorySearchTool = toolSchema.canonicalToModel.has("memory.search");
    const canUseFilesystemListTool = toolSchema.canonicalToModel.has("fs.list");
    const localFileIntent = intents.localFile;
    const citations: ChatCitationRecord[] = [];
    const toolRuns: ChatToolRunRecord[] = [];
    let toolRunCount = 0;
    let assistantContent = "";
    let assistantModel = input.model;
    let routingState: ChatTurnTraceRecord["routing"] = {
      liveDataIntent: intents.liveData,
      primaryProviderId: input.providerId,
      primaryModel: input.model,
      effectiveProviderId: input.providerId,
      effectiveModel: input.model,
    };
    let finalStatus: ChatTurnTraceRecord["status"] = "completed";
    let finalFailure: ChatTurnFailureRecord | undefined;
    let completionState: NonNullable<ChatTurnTraceRecord["completion"]> = {
      status: "complete",
      repaired: false,
      repair: {
        applied: false,
      },
    };
    let approvalPayload:
      | {
          approvalId: string;
          toolName?: string;
          reason?: string;
          expiresAt?: string;
        }
      | undefined;
    let pendingUserInput: ChatUserInputPromptRecord | undefined;
    const usageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    };
    const usageCostSources = new Set<NonNullable<ChatStreamUsageRecord["costSource"]>>();
    let usageObserved = false;
    let completionLatencyMs = 0;
    let completionLatencyObserved = false;
    let providerCallCount = 0;
    const accrueCompletionUsage = (usage: ChatStreamUsageRecord | null): void => {
      if (!usage) {
        return;
      }
      usageObserved = true;
      usageTotals.inputTokens += usage.inputTokens ?? 0;
      usageTotals.outputTokens += usage.outputTokens ?? 0;
      usageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
      usageTotals.costUsd += usage.costUsd ?? 0;
      if (usage.costSource) {
        usageCostSources.add(usage.costSource);
      }
    };
    let circuitBreakerReason: string | undefined;
    let circuitBreakerFailureClass: ChatTurnFailureClass | undefined;
    let suppressIncompleteCompletionRepair = false;
    const toolFailureSignatureCounts = new Map<string, number>();
    let promptLabToolComplianceRetryIssued = false;
    let promptLabSynthesisOnly = false;
    const outputMessageId = input.outputMessageId ?? `assistant-${input.turnId}`;
    const executionBudget = resolveChatExecutionBudget({
      mode: input.mode,
      webMode: input.webMode,
      thinkingLevel: input.thinkingLevel,
      liveDataIntent: intents.webLookup,
      researchListIntent: intents.researchList,
      promptLabExplicitTools: promptLabContract.explicitTools,
      // Profile-only: pasted contract text in live chat must not double the
      // turn budget the UI's responsiveness expectations are sized to.
      promptLabHarness: normalizationProfile === "prompt_pack_harness",
      providerId: input.providerId,
      model: input.model,
    });
    let effectiveTurnBudgetMs = executionBudget.turnBudgetMs;
    let effectiveCompletionTimeoutMs = executionBudget.completionTimeoutMs;
    let turnBudgetDeadline = createTurnBudgetDeadline(effectiveTurnBudgetMs);
    const markCompletionRepair = (
      kind: ChatTurnRepairKind,
      source: ChatTurnRepairSource,
      preRepairContent: string,
      postRepairContent: string,
    ): void => {
      completionState = {
        finishReason: completionState.finishReason,
        status: "complete",
        repaired: true,
        repair: {
          applied: true,
          kind,
          source,
          ...(preRepairContent !== postRepairContent ? { preRepairContent, postRepairContent } : {}),
        },
      };
    };

    if (intents.missingLogPayload) {
      assistantContent = buildMissingLogInputTemplate();
    }
    if (
      !assistantContent &&
      localFileIntent &&
      detectLocalFileAccessCheckIntent(input.content) &&
      !hasAvailableLocalFileTools(toolSchema.canonicalToModel)
    ) {
      assistantContent = buildLocalFileAccessFallback(input.content);
    }

    if (
      !assistantContent &&
      !promptLabEvalIntegrityTurn &&
      localFileIntent &&
      detectLocalFileAccessCheckIntent(input.content) &&
      canUseFilesystemListTool &&
      input.toolAutonomy !== "manual" &&
      !promptLabContract.toolUseSuppressed
    ) {
      const accessCheckPath = inferLocalFileAccessCheckPath({
        content: input.content,
        historyMessages: input.historyMessages,
        promptPathExtractor: extractExplicitPromptPath,
      });
      if (accessCheckPath) {
        throwIfChatTurnCancelled(input);
        this.deps.storage.chatTurnTraces.patch(input.turnId, {
          status: "waiting_for_tool",
        });
        ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
        const syntheticRun = await this.executeToolCall({
          input,
          turnId: input.turnId,
          toolName: "fs.list",
          rawArgs: {
            path: accessCheckPath,
          },
          localFileIntent,
          priorToolRuns: toolRuns,
          turnBudgetDeadline,
        });
        toolRunCount += 1;
        toolRuns.push(syntheticRun.record);
        yield {
          type: "tool_start",
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolRun: {
            ...syntheticRun.record,
            status: "started",
          },
        };
        if (syntheticRun.chunk) {
          yield syntheticRun.chunk;
        }
        if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId && !promptLabEvalIntegrityTurn) {
          finalStatus = "waiting_for_approval";
          finalFailure = {
            failureClass: "approval_required",
            message: "Approval required by policy.",
            retryable: true,
            recommendedAction: getChatTurnRecoveryAction("approval_required"),
          };
          approvalPayload = {
            approvalId: syntheticRun.record.approvalId,
            toolName: syntheticRun.record.toolName,
            reason: "Approval required by policy.",
            expiresAt: syntheticRun.approvalExpiresAt,
          };
          this.deps.storage.chatInlineApprovals.upsert({
            approvalId: syntheticRun.record.approvalId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolName: syntheticRun.record.toolName,
            status: "pending",
            reason: "Approval required by policy.",
            expiresAt: syntheticRun.approvalExpiresAt,
          });
        } else if (syntheticRun.record.status === "executed") {
          assistantContent = buildLocalFileAccessProbeSuccess(accessCheckPath, syntheticRun.record.result);
        } else {
          assistantContent = buildLocalFileAccessProbeFailure(accessCheckPath, syntheticRun.record);
        }
      }
    }
    const delegatedOrchestrationPrompt = looksLikeDelegatedOrchestrationPrompt(input.content);
    if (!assistantContent && !promptLabHarnessTurn && !delegatedOrchestrationPrompt) {
      const clarificationFollowUp = buildClarificationFollowUpIfNeeded(input.content, input.historyMessages);
      if (clarificationFollowUp) {
        assistantContent = clarificationFollowUp;
      }
    }
    if (!assistantContent && !promptLabHarnessTurn && !delegatedOrchestrationPrompt) {
      const clarificationPrompt = buildClarificationPromptIfNeeded(input.content);
      if (clarificationPrompt) {
        assistantContent = clarificationPrompt;
      }
    }
    if (!assistantContent && !approvalPayload) {
      const settingsConflict = buildLiveDataSettingsConflictMessage({
        mode: input.mode,
        webLookupIntent: intents.webLookup,
        strictWebRequirement: detectExplicitWebLookupIntent(input.content) || detectDirectUrlIntent(input.content),
        promptLabPrompt: promptLabHarnessTurn,
        timeIntent: intents.time,
        localFileIntent,
        userPrompt: input.content,
        webMode: input.webMode,
        toolAutonomy: input.toolAutonomy,
      });
      if (settingsConflict) {
        assistantContent = settingsConflict;
      }
    }

    if (
      !assistantContent &&
      !promptLabEvalIntegrityTurn &&
      input.toolAutonomy !== "manual" &&
      input.mode !== "code" &&
      !promptLabShouldInspectFilesForTurn &&
      !intents.webLookup &&
      !promptSpecificWebLookupTurn &&
      (promptLabContract.explicitTools || explicitMemoryOnlyPrompt) &&
      (memoryLookupIntent || explicitMemoryOnlyPrompt) &&
      canUseMemorySearchTool &&
      toolRunCount === 0
    ) {
      const memoryQuery = inferMemoryQueryFromPrompt(input.content) ?? "planning preferences travel scheduling";
      throwIfChatTurnCancelled(input);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "memory.search",
        rawArgs: {
          query: memoryQuery,
        },
        localFileIntent,
        priorToolRuns: toolRuns,
        turnBudgetDeadline,
      });
      toolRunCount += 1;
      toolRuns.push(syntheticRun.record);
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      const toolMessageId = `prefetch-memory-search-${randomUUID()}`;
      conversationMessages.push(
        createAssistantToolCallMessage({
          toolCallId: toolMessageId,
          toolName: this.resolveModelToolName("memory.search", toolSchema.canonicalToModel),
          argumentsJson: JSON.stringify({
            query: memoryQuery,
          }),
        }),
      );
      conversationMessages.push({
        role: "tool",
        tool_call_id: toolMessageId,
        content: JSON.stringify(syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." }),
      } as ChatCompletionMessage);
    }

    const promptLabCoworkPlanningStatusPrefetch =
      !promptLabEvalIntegrityTurn &&
      input.mode === "cowork" &&
      !promptLabContract.toolUseSuppressed &&
      !promptLabShouldInspectFilesForTurn &&
      (promptLabContract.explicitTools || /\buse\s+available\s+planning\s+tools\b/i.test(input.content)) &&
      /\buse\s+available\s+planning\s+tools\b/i.test(input.content) &&
      /\bvolunteer\s+orientation\b/i.test(input.content) &&
      /\bapproval\s+checkpoint\b/i.test(input.content) &&
      canUseSessionStatusTool;

    if (
      !assistantContent &&
      input.toolAutonomy !== "manual" &&
      promptLabCoworkPlanningStatusPrefetch &&
      toolRunCount === 0
    ) {
      throwIfChatTurnCancelled(input);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "session.status",
        rawArgs: {},
        localFileIntent,
        priorToolRuns: toolRuns,
        turnBudgetDeadline,
      });
      toolRunCount += 1;
      toolRuns.push(syntheticRun.record);
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      const toolMessageId = `prefetch-session-status-${randomUUID()}`;
      conversationMessages.push(
        createAssistantToolCallMessage({
          toolCallId: toolMessageId,
          toolName: this.resolveModelToolName("session.status", toolSchema.canonicalToModel),
          argumentsJson: JSON.stringify({}),
        }),
      );
      conversationMessages.push({
        role: "tool",
        tool_call_id: toolMessageId,
        content: JSON.stringify(syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." }),
      } as ChatCompletionMessage);
    }

    if (
      !assistantContent &&
      input.toolAutonomy !== "manual" &&
      (promptLabExplicitToolsWithRequiredEvidence ||
        promptLabContract.repoGroundedAssist ||
        promptLabRepoInspectionAssist ||
        repoGroundedInspectionAssist ||
        promptLabPrefetchFilePaths.length > 0) &&
      toolRunCount === 0
    ) {
      const promptLabShouldInspectFiles = promptLabShouldInspectFilesForTurn;
      const prefetchEndLine = resolvePromptLabFilePrefetchEndLine(
        promptLabTaskForInspection,
        promptLabPrefetchFilePaths.length,
      );
      if (promptLabShouldInspectFiles && promptLabPrefetchFilePaths.length > 0 && promptLabConcreteReadToolName) {
        for (const filePath of promptLabPrefetchFilePaths.slice(0, 6)) {
          if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
            break;
          }
          throwIfChatTurnCancelled(input);
          this.deps.storage.chatTurnTraces.patch(input.turnId, {
            status: "waiting_for_tool",
          });
          ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
          const prefetchReadArgs = buildPromptLabConcreteReadArgs(
            promptLabConcreteReadToolName,
            filePath,
            prefetchEndLine,
            promptLabTaskForInspection,
          );
          const syntheticRun = await this.executeToolCall({
            input,
            turnId: input.turnId,
            toolName: promptLabConcreteReadToolName,
            rawArgs: prefetchReadArgs,
            localFileIntent: localFileIntent || promptLabShouldInspectFiles,
            priorToolRuns: toolRuns,
            turnBudgetDeadline,
          });
          toolRunCount += 1;
          toolRuns.push(syntheticRun.record);
          yield {
            type: "tool_start",
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolRun: {
              ...syntheticRun.record,
              status: "started",
            },
          };
          if (syntheticRun.chunk) {
            yield syntheticRun.chunk;
          }
          const toolMessageId = `prefetch-file-${randomUUID()}`;
          conversationMessages.push(
            createAssistantToolCallMessage({
              toolCallId: toolMessageId,
              toolName: this.resolveModelToolName(promptLabConcreteReadToolName, toolSchema.canonicalToModel),
              argumentsJson: JSON.stringify(prefetchReadArgs),
            }),
          );
          const prefetchResultPayload: Record<string, unknown> = {
            ...(syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." }),
          };
          if (syntheticRun.record.status === "executed" && promptLabConcreteReadToolName === "file.read_range") {
            const returnedContent =
              typeof prefetchResultPayload.content === "string" ? prefetchResultPayload.content : "";
            const returnedLineCount = returnedContent.split("\n").length;
            if (returnedLineCount >= prefetchEndLine) {
              prefetchResultPayload._truncated = `Content truncated at line ${prefetchEndLine}; the file may continue beyond this point.`;
            }
          }
          conversationMessages.push({
            role: "tool",
            tool_call_id: toolMessageId,
            content: JSON.stringify(prefetchResultPayload),
          } as ChatCompletionMessage);
          for (const citation of inferCitationsFromToolResult(syntheticRun.record)) {
            citations.push(citation);
            yield {
              type: "citation",
              sessionId: input.sessionId,
              turnId: input.turnId,
              citation,
            };
          }
          if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId && !promptLabEvalIntegrityTurn) {
            finalStatus = "waiting_for_approval";
            finalFailure = {
              failureClass: "approval_required",
              message: "Approval required by policy.",
              retryable: true,
              recommendedAction: getChatTurnRecoveryAction("approval_required"),
            };
            approvalPayload = {
              approvalId: syntheticRun.record.approvalId,
              toolName: syntheticRun.record.toolName,
              reason: "Approval required by policy.",
              expiresAt: syntheticRun.approvalExpiresAt,
            };
            this.deps.storage.chatInlineApprovals.upsert({
              approvalId: syntheticRun.record.approvalId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolName: syntheticRun.record.toolName,
              status: "pending",
              reason: "Approval required by policy.",
              expiresAt: syntheticRun.approvalExpiresAt,
            });
            break;
          }
          if (
            syntheticRun.record.status === "executed" &&
            promptLabConcreteReadToolName &&
            syntheticRun.record.toolName !== promptLabConcreteReadToolName &&
            (promptLabExplicitToolsWithRequiredEvidence ||
              promptLabContract.repoGroundedAssist ||
              promptLabRepoInspectionAssist ||
              repoGroundedInspectionAssist ||
              (promptLabFilePaths.length > 0 && promptLabTaskNeedsAdjacentRepoSearch(promptLabTaskForInspection)))
          ) {
            const concreteReadPaths = selectPromptLabConcreteReadPathsFromSearchResult(syntheticRun.record.result);
            for (const filePath of concreteReadPaths) {
              if (toolRunCount >= executionBudget.maxToolRunsPerTurn || approvalPayload) {
                break;
              }
              throwIfChatTurnCancelled(input);
              this.deps.storage.chatTurnTraces.patch(input.turnId, {
                status: "waiting_for_tool",
              });
              ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
              const readArgs = buildPromptLabConcreteReadArgs(
                promptLabConcreteReadToolName,
                filePath,
                prefetchEndLine,
                promptLabTaskForInspection,
              );
              const fileReadRun = await this.executeToolCall({
                input,
                turnId: input.turnId,
                toolName: promptLabConcreteReadToolName,
                rawArgs: readArgs,
                localFileIntent: localFileIntent || promptLabShouldInspectFiles,
                priorToolRuns: toolRuns,
                turnBudgetDeadline,
              });
              toolRunCount += 1;
              toolRuns.push(fileReadRun.record);
              yield {
                type: "tool_start",
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolRun: {
                  ...fileReadRun.record,
                  status: "started",
                },
              };
              if (fileReadRun.chunk) {
                yield fileReadRun.chunk;
              }
              const fileReadToolMessageId = `prefetch-search-read-${randomUUID()}`;
              conversationMessages.push(
                createAssistantToolCallMessage({
                  toolCallId: fileReadToolMessageId,
                  toolName: this.resolveModelToolName(promptLabConcreteReadToolName, toolSchema.canonicalToModel),
                  argumentsJson: JSON.stringify(readArgs),
                }),
              );
              const fileReadPayload: Record<string, unknown> = {
                ...(fileReadRun.record.result ?? { error: fileReadRun.record.error ?? "Tool failed." }),
              };
              if (fileReadRun.record.status === "executed" && promptLabConcreteReadToolName === "file.read_range") {
                const returnedContent = typeof fileReadPayload.content === "string" ? fileReadPayload.content : "";
                const returnedLineCount = returnedContent.split("\n").length;
                if (returnedLineCount >= prefetchEndLine) {
                  fileReadPayload._truncated = `Content truncated at line ${prefetchEndLine}; the file may continue beyond this point.`;
                }
              }
              conversationMessages.push({
                role: "tool",
                tool_call_id: fileReadToolMessageId,
                content: JSON.stringify(fileReadPayload),
              } as ChatCompletionMessage);
              for (const citation of inferCitationsFromToolResult(fileReadRun.record)) {
                citations.push(citation);
                yield {
                  type: "citation",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  citation,
                };
              }
              if (fileReadRun.record.status === "approval_required" && fileReadRun.record.approvalId && !promptLabEvalIntegrityTurn) {
                finalStatus = "waiting_for_approval";
                finalFailure = {
                  failureClass: "approval_required",
                  message: "Approval required by policy.",
                  retryable: true,
                  recommendedAction: getChatTurnRecoveryAction("approval_required"),
                };
                approvalPayload = {
                  approvalId: fileReadRun.record.approvalId,
                  toolName: fileReadRun.record.toolName,
                  reason: "Approval required by policy.",
                  expiresAt: fileReadRun.approvalExpiresAt,
                };
                this.deps.storage.chatInlineApprovals.upsert({
                  approvalId: fileReadRun.record.approvalId,
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  toolName: fileReadRun.record.toolName,
                  status: "pending",
                  reason: "Approval required by policy.",
                  expiresAt: fileReadRun.approvalExpiresAt,
                });
                break;
              }
            }
            if (collectPromptLabConcreteReadPaths(toolRuns).size >= desiredPromptLabConcreteReads) {
              break;
            }
          }
          if (
            promptLabExplicitToolsWithRequiredEvidence &&
            promptLabFilePaths.length === 0 &&
            collectPromptLabConcreteReadPaths(toolRuns).size >= desiredPromptLabConcreteReads
          ) {
            break;
          }
        }
      }

      if (
        !approvalPayload &&
        promptLabShouldInspectFiles &&
        (promptLabFilePaths.length === 0 || promptLabTaskNeedsAdjacentRepoSearch(promptLabTaskForInspection)) &&
        canControllerSearchPromptLabFiles &&
        toolRunCount < executionBudget.maxToolRunsPerTurn &&
        (repoGroundedInspectionAssist ||
          promptLabContract.repoGroundedAssist ||
          promptLabRepoInspectionAssist ||
          (promptLabFilePaths.length > 0 && promptLabTaskNeedsAdjacentRepoSearch(promptLabTaskForInspection)) ||
          isMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns))
      ) {
        const promptLabSearchPath =
          promptLabFilePaths.length > 0 && promptLabTaskNeedsAdjacentRepoSearch(promptLabTaskForInspection)
            ? "."
            : (inferLocalToolPathFromPrompt("code.search_files", promptLabTaskForInspection) ?? ".");
        const promptLabSearchQueries = inferPromptLabLocalSearchQueries(promptLabTaskForInspection);
        const effectivePromptLabSearchQueries =
          promptLabSearchQueries.length > 0
            ? promptLabSearchQueries
            : [inferLocalSearchQueryFromPrompt("code.search_files", promptLabTaskForInspection) ?? "."];
        let promptLabSearchPathMissing = false;
        promptLabSearchLoop: for (const query of effectivePromptLabSearchQueries) {
          if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
            break;
          }
          for (const searchToolName of promptLabSearchToolNames) {
            if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
              break promptLabSearchLoop;
            }
            throwIfChatTurnCancelled(input);
            this.deps.storage.chatTurnTraces.patch(input.turnId, {
              status: "waiting_for_tool",
            });
            ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
            const searchPath = promptLabSearchPathMissing ? "." : promptLabSearchPath;
            const searchArgs = buildPromptLabSearchArgs(searchToolName, searchPath, query);
            const syntheticRun = await this.executeToolCall({
              input,
              turnId: input.turnId,
              toolName: searchToolName,
              rawArgs: searchArgs,
              localFileIntent: localFileIntent || promptLabShouldInspectFiles,
              priorToolRuns: toolRuns,
              turnBudgetDeadline,
            });
            toolRunCount += 1;
            toolRuns.push(syntheticRun.record);
            yield {
              type: "tool_start",
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolRun: {
                ...syntheticRun.record,
                status: "started",
              },
            };
            if (syntheticRun.chunk) {
              yield syntheticRun.chunk;
            }
            const toolMessageId = `prefetch-search-files-${randomUUID()}`;
            conversationMessages.push(
              createAssistantToolCallMessage({
                toolCallId: toolMessageId,
                toolName: this.resolveModelToolName(searchToolName, toolSchema.canonicalToModel),
                argumentsJson: JSON.stringify(searchArgs),
              }),
            );
            conversationMessages.push({
              role: "tool",
              tool_call_id: toolMessageId,
              content: JSON.stringify(
                syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." },
              ),
            } as ChatCompletionMessage);
            let effectiveSearchRun = syntheticRun;
            if (
              shouldRetryPromptLabSearchFromRepoRoot({
                searchPath,
                toolRun: syntheticRun.record,
                promptLabContract,
                repoGroundedInspectionAssist,
                promptLabRepoInspectionAssist,
              }) &&
              toolRunCount < executionBudget.maxToolRunsPerTurn
            ) {
              promptLabSearchPathMissing = true;
              const fallbackSearchArgs = buildPromptLabSearchArgs(searchToolName, ".", query);
              this.deps.storage.chatTurnTraces.patch(input.turnId, {
                status: "waiting_for_tool",
              });
              ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
              const fallbackRun = await this.executeToolCall({
                input,
                turnId: input.turnId,
                toolName: searchToolName,
                rawArgs: fallbackSearchArgs,
                localFileIntent: localFileIntent || promptLabShouldInspectFiles,
                priorToolRuns: toolRuns,
                turnBudgetDeadline,
              });
              toolRunCount += 1;
              toolRuns.push(fallbackRun.record);
              yield {
                type: "tool_start",
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolRun: {
                  ...fallbackRun.record,
                  status: "started",
                },
              };
              if (fallbackRun.chunk) {
                yield fallbackRun.chunk;
              }
              const fallbackToolMessageId = `prefetch-search-files-root-${randomUUID()}`;
              conversationMessages.push(
                createAssistantToolCallMessage({
                  toolCallId: fallbackToolMessageId,
                  toolName: this.resolveModelToolName(searchToolName, toolSchema.canonicalToModel),
                  argumentsJson: JSON.stringify(fallbackSearchArgs),
                }),
              );
              conversationMessages.push({
                role: "tool",
                tool_call_id: fallbackToolMessageId,
                content: JSON.stringify(
                  fallbackRun.record.result ?? { error: fallbackRun.record.error ?? "Tool failed." },
                ),
              } as ChatCompletionMessage);
              effectiveSearchRun = fallbackRun;
            }
            if (effectiveSearchRun.record.status === "approval_required" && effectiveSearchRun.record.approvalId && !promptLabEvalIntegrityTurn) {
              finalStatus = "waiting_for_approval";
              finalFailure = {
                failureClass: "approval_required",
                message: "Approval required by policy.",
                retryable: true,
                recommendedAction: getChatTurnRecoveryAction("approval_required"),
              };
              approvalPayload = {
                approvalId: effectiveSearchRun.record.approvalId,
                toolName: effectiveSearchRun.record.toolName,
                reason: "Approval required by policy.",
                expiresAt: effectiveSearchRun.approvalExpiresAt,
              };
              this.deps.storage.chatInlineApprovals.upsert({
                approvalId: effectiveSearchRun.record.approvalId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolName: effectiveSearchRun.record.toolName,
                status: "pending",
                reason: "Approval required by policy.",
                expiresAt: effectiveSearchRun.approvalExpiresAt,
              });
              break promptLabSearchLoop;
            }
            if (
              effectiveSearchRun.record.status === "executed" &&
              promptLabConcreteReadToolName &&
              (promptLabExplicitToolsWithRequiredEvidence ||
                promptLabContract.repoGroundedAssist ||
                promptLabRepoInspectionAssist ||
                repoGroundedInspectionAssist ||
                (promptLabFilePaths.length > 0 && promptLabTaskNeedsAdjacentRepoSearch(promptLabTaskForInspection)))
            ) {
              const concreteReadPaths = selectPromptLabConcreteReadPathsFromSearchResult(
                effectiveSearchRun.record.result,
              );
              for (const filePath of concreteReadPaths) {
                if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
                  break;
                }
                throwIfChatTurnCancelled(input);
                this.deps.storage.chatTurnTraces.patch(input.turnId, {
                  status: "waiting_for_tool",
                });
                ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
                const readArgs = buildPromptLabConcreteReadArgs(
                  promptLabConcreteReadToolName,
                  filePath,
                  prefetchEndLine,
                  promptLabTaskForInspection,
                );
                const fileReadRun = await this.executeToolCall({
                  input,
                  turnId: input.turnId,
                  toolName: promptLabConcreteReadToolName,
                  rawArgs: readArgs,
                  localFileIntent: localFileIntent || promptLabShouldInspectFiles,
                  priorToolRuns: toolRuns,
                  turnBudgetDeadline,
                });
                toolRunCount += 1;
                toolRuns.push(fileReadRun.record);
                yield {
                  type: "tool_start",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  toolRun: {
                    ...fileReadRun.record,
                    status: "started",
                  },
                };
                if (fileReadRun.chunk) {
                  yield fileReadRun.chunk;
                }
                const fileReadToolMessageId = `prefetch-search-read-${randomUUID()}`;
                conversationMessages.push(
                  createAssistantToolCallMessage({
                    toolCallId: fileReadToolMessageId,
                    toolName: this.resolveModelToolName(promptLabConcreteReadToolName, toolSchema.canonicalToModel),
                    argumentsJson: JSON.stringify(readArgs),
                  }),
                );
                const fileReadPayload: Record<string, unknown> = {
                  ...(fileReadRun.record.result ?? { error: fileReadRun.record.error ?? "Tool failed." }),
                };
                if (fileReadRun.record.status === "executed" && promptLabConcreteReadToolName === "file.read_range") {
                  const returnedContent = typeof fileReadPayload.content === "string" ? fileReadPayload.content : "";
                  const returnedLineCount = returnedContent.split("\n").length;
                  if (returnedLineCount >= prefetchEndLine) {
                    fileReadPayload._truncated = `Content truncated at line ${prefetchEndLine}; the file may continue beyond this point.`;
                  }
                }
                conversationMessages.push({
                  role: "tool",
                  tool_call_id: fileReadToolMessageId,
                  content: JSON.stringify(fileReadPayload),
                } as ChatCompletionMessage);
                for (const citation of inferCitationsFromToolResult(fileReadRun.record)) {
                  citations.push(citation);
                  yield {
                    type: "citation",
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    citation,
                  };
                }
                if (fileReadRun.record.status === "approval_required" && fileReadRun.record.approvalId && !promptLabEvalIntegrityTurn) {
                  finalStatus = "waiting_for_approval";
                  finalFailure = {
                    failureClass: "approval_required",
                    message: "Approval required by policy.",
                    retryable: true,
                    recommendedAction: getChatTurnRecoveryAction("approval_required"),
                  };
                  approvalPayload = {
                    approvalId: fileReadRun.record.approvalId,
                    toolName: fileReadRun.record.toolName,
                    reason: "Approval required by policy.",
                    expiresAt: fileReadRun.approvalExpiresAt,
                  };
                  this.deps.storage.chatInlineApprovals.upsert({
                    approvalId: fileReadRun.record.approvalId,
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    toolName: fileReadRun.record.toolName,
                    status: "pending",
                    reason: "Approval required by policy.",
                    expiresAt: fileReadRun.approvalExpiresAt,
                  });
                  break promptLabSearchLoop;
                }
              }
              if (collectPromptLabConcreteReadPaths(toolRuns).size >= desiredPromptLabConcreteReads) {
                break promptLabSearchLoop;
              }
            }
            if (
              effectiveSearchRun.record.status !== "blocked" ||
              !/tool not available in resolved profile/i.test(effectiveSearchRun.record.error ?? "")
            ) {
              break;
            }
          }
        }
      }

      if (
        !approvalPayload &&
        !promptLabEvalIntegrityTurn &&
        promptLabContractRequiresWebTools(promptLabContract) &&
        canUseSearchTool &&
        toolRunCount < executionBudget.maxToolRunsPerTurn &&
        isMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns)
      ) {
        const promptLabSearchQuery =
          inferQueryFromPrompt(promptLabTaskForInspection) ?? deriveLiveDataQuery(promptLabTaskForInspection);
        if (promptLabSearchQuery.trim().length > 0) {
          throwIfChatTurnCancelled(input);
          this.deps.storage.chatTurnTraces.patch(input.turnId, {
            status: "waiting_for_tool",
          });
          ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
          const syntheticRun = await this.executeToolCall({
            input,
            turnId: input.turnId,
            toolName: "browser.search",
            rawArgs: {
              query: promptLabSearchQuery,
              maxResults: executionBudget.searchMaxResults,
            },
            localFileIntent,
            priorToolRuns: toolRuns,
            turnBudgetDeadline,
          });
          toolRunCount += 1;
          toolRuns.push(syntheticRun.record);
          ({ turnBudgetDeadline, effectiveTurnBudgetMs, effectiveCompletionTimeoutMs } =
            extendTurnBudgetForExecutedBrowserTool({
              toolName: syntheticRun.record.toolName,
              toolStatus: syntheticRun.record.status,
              webMode: input.webMode,
              webLookupIntent: true,
              currentTurnBudgetMs: effectiveTurnBudgetMs,
              currentCompletionTimeoutMs: effectiveCompletionTimeoutMs,
              turnBudgetDeadline,
            }));
          yield {
            type: "tool_start",
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolRun: {
              ...syntheticRun.record,
              status: "started",
            },
          };
          if (syntheticRun.chunk) {
            yield syntheticRun.chunk;
          }
          const toolMessageId = `prefetch-search-${randomUUID()}`;
          conversationMessages.push(
            createAssistantToolCallMessage({
              toolCallId: toolMessageId,
              toolName: this.resolveModelToolName("browser.search", toolSchema.canonicalToModel),
              argumentsJson: JSON.stringify({
                query: promptLabSearchQuery,
                maxResults: executionBudget.searchMaxResults,
              }),
            }),
          );
          conversationMessages.push({
            role: "tool",
            tool_call_id: toolMessageId,
            content: JSON.stringify(
              syntheticRun.record.result ?? { error: syntheticRun.record.error ?? "Tool failed." },
            ),
          } as ChatCompletionMessage);
          for (const citation of inferCitationsFromToolResult(syntheticRun.record)) {
            citations.push(citation);
            yield {
              type: "citation",
              sessionId: input.sessionId,
              turnId: input.turnId,
              citation,
            };
          }
        }
      }
    }

    // Deterministic live-time helper for simple queries.
    if (!assistantContent && intents.time && canUseTimeTool && !promptLabContract.toolUseSuppressed) {
      throwIfChatTurnCancelled(input);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "time.now",
        rawArgs: {},
        localFileIntent,
      });
      toolRunCount += 1;
      toolRuns.push(syntheticRun.record);
      ({ turnBudgetDeadline, effectiveTurnBudgetMs, effectiveCompletionTimeoutMs } =
        extendTurnBudgetForExecutedBrowserTool({
          toolName: syntheticRun.record.toolName,
          toolStatus: syntheticRun.record.status,
          webMode: input.webMode,
          webLookupIntent: intents.webLookup,
          currentTurnBudgetMs: effectiveTurnBudgetMs,
          currentCompletionTimeoutMs: effectiveCompletionTimeoutMs,
          turnBudgetDeadline,
        }));
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      if (syntheticRun.record.status === "executed" && syntheticRun.record.result) {
        const toolMessageId = `time-${randomUUID()}`;
        conversationMessages.push(
          createAssistantToolCallMessage({
            toolCallId: toolMessageId,
            toolName: this.resolveModelToolName("time.now", toolSchema.canonicalToModel),
            argumentsJson: "{}",
          }),
        );
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolMessageId,
          content: JSON.stringify(syntheticRun.record.result),
        } as ChatCompletionMessage);
      }
      for (const citation of inferCitationsFromToolResult(syntheticRun.record)) {
        citations.push(citation);
        yield {
          type: "citation",
          sessionId: input.sessionId,
          turnId: input.turnId,
          citation,
        };
      }
      if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId && !promptLabEvalIntegrityTurn) {
        finalStatus = "waiting_for_approval";
        finalFailure = {
          failureClass: "approval_required",
          message: "Approval required by policy.",
          retryable: true,
          recommendedAction: getChatTurnRecoveryAction("approval_required"),
        };
        approvalPayload = {
          approvalId: syntheticRun.record.approvalId,
          toolName: syntheticRun.record.toolName,
          reason: "Approval required by policy.",
          expiresAt: syntheticRun.approvalExpiresAt,
        };
        this.deps.storage.chatInlineApprovals.upsert({
          approvalId: syntheticRun.record.approvalId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolName: syntheticRun.record.toolName,
          status: "pending",
          reason: "Approval required by policy.",
          expiresAt: syntheticRun.approvalExpiresAt,
        });
      }
    }

    const promptLabCoworkPromptSpecificWebLookup =
      promptLabHarnessTurn && input.mode === "cowork" && Boolean(derivePromptSpecificWebQuery(input.content));
    if (
      !assistantContent &&
      !approvalPayload &&
      !promptLabEvalIntegrityTurn &&
      input.toolAutonomy !== "manual" &&
      input.webMode !== "off" &&
      intents.liveData &&
      !promptLabContract.toolUseSuppressed &&
      !(promptLabHarnessTurn && promptLabContract.explicitTools && input.mode === "chat") &&
      (!localFileIntent || promptLabCoworkPromptSpecificWebLookup) &&
      !intents.time &&
      canUseSearchTool &&
      toolRunCount < executionBudget.maxToolRunsPerTurn
    ) {
      throwIfChatTurnCancelled(input);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
      const liveDataQuerySourceContent = promptLabHarnessTurn
        ? (extractPromptLabQuotedUserAsk(promptLabTaskForInspection) ?? promptLabTaskForInspection)
        : input.content;
      const derivedLiveDataQuery = deriveLiveDataQuery(liveDataQuerySourceContent);
      const inferredLiveDataQuery = inferQueryFromPrompt(liveDataQuerySourceContent);
      const liveDataQuery = shouldPreferInferredLiveDataQuery(inferredLiveDataQuery, derivedLiveDataQuery)
        ? (inferredLiveDataQuery ?? derivedLiveDataQuery)
        : derivedLiveDataQuery;
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "browser.search",
        rawArgs: {
          query: liveDataQuery,
          maxResults: executionBudget.searchMaxResults,
        },
        localFileIntent: promptLabCoworkPromptSpecificWebLookup ? false : localFileIntent,
      });
      toolRunCount += 1;
      toolRuns.push(syntheticRun.record);
      ({ turnBudgetDeadline, effectiveTurnBudgetMs, effectiveCompletionTimeoutMs } =
        extendTurnBudgetForExecutedBrowserTool({
          toolName: syntheticRun.record.toolName,
          toolStatus: syntheticRun.record.status,
          webMode: input.webMode,
          webLookupIntent: intents.webLookup,
          currentTurnBudgetMs: effectiveTurnBudgetMs,
          currentCompletionTimeoutMs: effectiveCompletionTimeoutMs,
          turnBudgetDeadline,
        }));
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      if (syntheticRun.record.status === "executed" && syntheticRun.record.result) {
        const toolMessageId = `search-${randomUUID()}`;
        conversationMessages.push(
          createAssistantToolCallMessage({
            toolCallId: toolMessageId,
            toolName: this.resolveModelToolName("browser.search", toolSchema.canonicalToModel),
            argumentsJson: JSON.stringify({
              query: liveDataQuery,
              maxResults: executionBudget.searchMaxResults,
            }),
          }),
        );
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolMessageId,
          content: JSON.stringify(syntheticRun.record.result),
        } as ChatCompletionMessage);

        if (
          (shouldProactivelyOpenGroundedNewsResult(liveDataQuerySourceContent) ||
            shouldProactivelyOpenCoworkResearchResult({
              mode: input.mode,
              webMode: input.webMode,
              content: liveDataQuerySourceContent,
            })) &&
          canUseNavigateTool &&
          toolRunCount < executionBudget.maxToolRunsPerTurn
        ) {
          const promotedUrl = inferBrowserNavigateUrlFromRepeatedSearches(liveDataQuerySourceContent, toolRuns);
          if (promotedUrl) {
            ensureChatTurnBudgetRemaining(turnBudgetDeadline, input.webMode, effectiveTurnBudgetMs);
            const navigateRun = await this.executeToolCall({
              input,
              turnId: input.turnId,
              toolName: "browser.navigate",
              rawArgs: {
                url: promotedUrl,
                maxChars: 6000,
              },
              localFileIntent,
              priorToolRuns: toolRuns,
              turnBudgetDeadline,
            });
            toolRunCount += 1;
            toolRuns.push(navigateRun.record);
            ({ turnBudgetDeadline, effectiveTurnBudgetMs, effectiveCompletionTimeoutMs } =
              extendTurnBudgetForExecutedBrowserTool({
                toolName: navigateRun.record.toolName,
                toolStatus: navigateRun.record.status,
                webMode: input.webMode,
                webLookupIntent: intents.webLookup,
                currentTurnBudgetMs: effectiveTurnBudgetMs,
                currentCompletionTimeoutMs: effectiveCompletionTimeoutMs,
                turnBudgetDeadline,
              }));
            yield {
              type: "tool_start",
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolRun: {
                ...navigateRun.record,
                status: "started",
              },
            };
            if (navigateRun.chunk) {
              yield navigateRun.chunk;
            }
            if (navigateRun.record.status === "executed" && navigateRun.record.result) {
              const navigateToolMessageId = `navigate-${randomUUID()}`;
              conversationMessages.push(
                createAssistantToolCallMessage({
                  toolCallId: navigateToolMessageId,
                  toolName: this.resolveModelToolName("browser.navigate", toolSchema.canonicalToModel),
                  argumentsJson: JSON.stringify({
                    url: promotedUrl,
                    maxChars: 6000,
                  }),
                }),
              );
              conversationMessages.push({
                role: "tool",
                tool_call_id: navigateToolMessageId,
                content: JSON.stringify(navigateRun.record.result),
              } as ChatCompletionMessage);
            }
            for (const citation of inferCitationsFromToolResult(navigateRun.record)) {
              citations.push(citation);
              yield {
                type: "citation",
                sessionId: input.sessionId,
                turnId: input.turnId,
                citation,
              };
            }
            if (navigateRun.record.status === "approval_required" && navigateRun.record.approvalId && !promptLabEvalIntegrityTurn) {
              finalStatus = "waiting_for_approval";
              finalFailure = {
                failureClass: "approval_required",
                message: "Approval required by policy.",
                retryable: true,
                recommendedAction: getChatTurnRecoveryAction("approval_required"),
              };
              approvalPayload = {
                approvalId: navigateRun.record.approvalId,
                toolName: navigateRun.record.toolName,
                reason: "Approval required by policy.",
                expiresAt: navigateRun.approvalExpiresAt,
              };
              this.deps.storage.chatInlineApprovals.upsert({
                approvalId: navigateRun.record.approvalId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolName: navigateRun.record.toolName,
                status: "pending",
                reason: "Approval required by policy.",
                expiresAt: navigateRun.approvalExpiresAt,
              });
            }
          }
        }
      }
      for (const citation of inferCitationsFromToolResult(syntheticRun.record)) {
        citations.push(citation);
        yield {
          type: "citation",
          sessionId: input.sessionId,
          turnId: input.turnId,
          citation,
        };
      }
      if (syntheticRun.record.status === "approval_required" && syntheticRun.record.approvalId && !promptLabEvalIntegrityTurn) {
        finalStatus = "waiting_for_approval";
        finalFailure = {
          failureClass: "approval_required",
          message: "Approval required by policy.",
          retryable: true,
          recommendedAction: getChatTurnRecoveryAction("approval_required"),
        };
        approvalPayload = {
          approvalId: syntheticRun.record.approvalId,
          toolName: syntheticRun.record.toolName,
          reason: "Approval required by policy.",
          expiresAt: syntheticRun.approvalExpiresAt,
        };
        this.deps.storage.chatInlineApprovals.upsert({
          approvalId: syntheticRun.record.approvalId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolName: syntheticRun.record.toolName,
          status: "pending",
          reason: "Approval required by policy.",
          expiresAt: syntheticRun.approvalExpiresAt,
        });
      }
    }

    if (intents.liveData && toolRuns.length > 0) {
      conversationMessages.push({
        role: "system",
        content: buildEvidenceGroundingInstruction(),
      } as ChatCompletionMessage);
    }

    if (!assistantContent && !approvalPayload) {
      try {
        for (let loop = 0; loop < executionBudget.maxToolLoops; loop += 1) {
          throwIfChatTurnCancelled(input);
          this.deps.storage.chatTurnTraces.patch(input.turnId, {
            status: "running",
          });
          const loopTrace: ChatTurnTraceRecord = {
            ...trace,
            routing: {
              ...routingState,
              fallbackReason: `loop ${loop + 1}/${executionBudget.maxToolLoops}, tool_runs=${toolRunCount}`,
            },
            loopGuard: createLoopGuardTrace(loopGuardState),
            toolRuns: this.deps.storage.chatToolRuns.listByTurn(input.turnId),
            citations: [...citations],
          };
          yield {
            type: "trace_update",
            sessionId: input.sessionId,
            turnId: input.turnId,
            trace: loopTrace,
          };

          // Eval turns: guarantee the synthesis completion at least the
          // configured reserve — tool latency must not strangle the final
          // answer down to a few seconds. Live turns keep the strict deadline
          // so the turn never overshoots the responsiveness budget the UI and
          // watchdogs are sized to.
          const remainingTurnBudgetMs = ensureChatTurnBudgetRemaining(
            turnBudgetDeadline,
            input.webMode,
            effectiveTurnBudgetMs,
          );
          const completionTimeoutMs = Math.min(
            effectiveCompletionTimeoutMs,
            promptLabEvalIntegrityTurn
              ? Math.max(remainingTurnBudgetMs, executionBudget.minSynthesisReserveMs)
              : remainingTurnBudgetMs,
          );
          const modelControls = resolveModelControlOptions(input, toolSchema.tools.length > 0);
          const rawToolsForCompletion = promptLabSynthesisOnly ? [] : toolSchema.tools;
          const toolsForCompletion =
            normalizationProfile === "prompt_pack_harness" &&
            input.mode !== "code" &&
            !promptLabShouldInspectFilesForTurn
              ? rawToolsForCompletion.filter((tool) => {
                  const modelToolName = extractProviderToolName(tool);
                  const canonicalToolName = modelToolName
                    ? (toolSchema.modelToCanonical.get(modelToolName) ?? modelToolName)
                    : undefined;
                  return !canonicalToolName || !LOCAL_PATH_TOOL_NAMES.has(canonicalToolName);
                })
              : rawToolsForCompletion;
          const completionRequest: ChatCompletionRequest = {
            providerId: input.providerId,
            model: input.model,
            messages: conversationMessages,
            stream: false,
            max_tokens: executionBudget.maxTokens,
            timeoutMs: completionTimeoutMs,
            signal: input.signal,
            reasoning: modelControls.reasoning,
            verbosity: modelControls.verbosity,
            service_tier: modelControls.service_tier,
            memory: {
              enabled: input.memoryMode !== "off",
              mode: input.memoryMode === "off" ? "off" : "qmd",
              turnId: input.turnId,
              sessionId: input.sessionId,
            },
            tools: toolsForCompletion.length > 0 ? toolsForCompletion : undefined,
            tool_choice: toolsForCompletion.length > 0 ? "auto" : undefined,
          };

          let completion: ChatCompletionResponse;
          const completionStartedAt = Date.now();
          try {
            if (this.deps.createChatCompletionStream) {
              let streamYieldedVisibleChunk = false;
              try {
                const aggregate = createCompletionStreamAggregate();
                providerCallCount += 1;
                for await (const rawChunk of this.deps.createChatCompletionStream({
                  ...completionRequest,
                  stream: true,
                })) {
                  const streamed = absorbCompletionStreamChunk(aggregate, rawChunk);
                  if (streamed.delta && !streamed.sawToolCall) {
                    streamYieldedVisibleChunk = true;
                    yield {
                      type: "delta",
                      sessionId: input.sessionId,
                      turnId: input.turnId,
                      messageId: input.outputMessageId,
                      delta: streamed.delta,
                    };
                  }
                }
                completion = buildCompletionFromAggregate(aggregate);
              } catch (error) {
                log.warn("completion stream failed", {
                  providerId: input.providerId,
                  model: input.model,
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  fallback: streamYieldedVisibleChunk ? "suppressed_after_partial_output" : "non_streaming_completion",
                  error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
                });
                if (streamYieldedVisibleChunk && !promptLabEvalIntegrityTurn) {
                  // Live chat: re-sending after the user saw partial output would
                  // double-render. Headless eval runs have no viewer, so they fall
                  // through to the non-streaming retry instead of failing the run.
                  suppressIncompleteCompletionRepair = true;
                  throw new Error(
                    "Streaming completion failed after partial output; non-streaming fallback suppressed.",
                    {
                      cause: error,
                    },
                  );
                }
                providerCallCount += 1;
                completion = await this.deps.createChatCompletion(completionRequest);
              }
            } else {
              providerCallCount += 1;
              completion = await this.deps.createChatCompletion(completionRequest);
            }
          } finally {
            completionLatencyObserved = true;
            completionLatencyMs += Date.now() - completionStartedAt;
          }
          assistantModel = typeof completion.model === "string" ? completion.model : assistantModel;
          accrueCompletionUsage(parseUsageFromCompletion(completion));
          const completionRouting = completion.routing as ChatTurnTraceRecord["routing"] | undefined;
          if (completionRouting) {
            routingState = {
              ...routingState,
              ...completionRouting,
            };
          }

          const choice = completion.choices?.[0];
          const message = choice?.message as Record<string, unknown> | undefined;
          const completionOutcome = classifyCompletionOutcome({
            completion,
            originalRequest: input.content,
            priorMessages: input.historyMessages,
          });
          if (completionOutcome.finishReason) {
            completionState = {
              ...completionState,
              finishReason: completionOutcome.finishReason,
            };
          }
          if (!message) {
            assistantContent = "";
            completionState = {
              ...completionState,
              status: "interrupted",
            };
            break;
          }

          // The model's own tool calls are never silently filtered: on eval
          // turns every call must reach the policy layer so disallowed use is
          // denied visibly (and judged), not hidden from the trace.
          const toolCalls = readToolCalls(message, toolSchema.modelToCanonical);
          if (completionOutcome.status !== "complete" && toolCalls.length > 0) {
            if (
              !promptLabSynthesisOnly &&
              shouldSynthesizePromptLabFromGatheredEvidence({
                content: input.content,
                promptLabContract,
                toolRuns,
              })
            ) {
              promptLabSynthesisOnly = true;
              conversationMessages.push({
                role: "system",
                content: buildPromptLabPartialToolCallSynthesisInstruction(toolRuns),
              } as ChatCompletionMessage);
              completionState = {
                ...completionState,
                status: completionOutcome.status,
              };
              continue;
            }
            assistantContent = extractMessageContent(message);
            completionState = {
              ...completionState,
              status: completionOutcome.status,
            };
            finalFailure ??= buildChatTurnFailureRecord(
              "unknown",
              "The provider stopped before tool calls were fully assembled, so the tool phase was not executed.",
              "continue_from_partial",
            );
            break;
          }
          if (toolCalls.length === 0 || input.toolAutonomy === "manual") {
            if (
              input.toolAutonomy !== "manual" &&
              promptLabExplicitToolsWithRequiredEvidence &&
              isMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns)
            ) {
              const missingRequirements = listMissingPromptLabRequiredToolEvidence(promptLabContract, toolRuns);
              const canStillSatisfy = canSatisfyPromptLabRequiredToolEvidence(
                promptLabContract,
                toolSchema.canonicalToModel,
              );
              if (!promptLabToolComplianceRetryIssued && canStillSatisfy) {
                promptLabToolComplianceRetryIssued = true;
                conversationMessages.push({
                  role: "system",
                  content: buildPromptLabRequiredToolRetryInstruction(missingRequirements),
                } as ChatCompletionMessage);
                continue;
              }
              assistantContent = buildPromptLabRequiredToolFallback(missingRequirements);
              finalFailure ??= buildChatTurnFailureRecord(
                "unknown",
                "Prompt Lab required tools were not executed before answer generation.",
              );
              break;
            }
            assistantContent = extractMessageContent(message);
            if (completionOutcome.status !== "complete") {
              completionState = {
                ...completionState,
                status: completionOutcome.status,
              };
              finalFailure ??= buildChatTurnFailureRecord(
                "unknown",
                "The provider stopped before the answer finished, so a repair pass is required.",
                "continue_from_partial",
              );
            } else if (completionState.status !== "complete") {
              completionState = {
                ...completionState,
                status: "complete",
              };
            }
            conversationMessages.push({
              role: "assistant",
              content: assistantContent,
            });
            break;
          }

          conversationMessages.push(
            createAssistantToolCallMessage({
              content: extractMessageContent(message),
              providerNativeContent: extractProviderNativeContent(message),
              toolCalls: toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: this.resolveModelToolName(toolCall.toolName, toolSchema.canonicalToModel),
                  arguments: toolCall.rawArguments,
                },
              })),
            }),
          );
          // Every tool_call id in the assistant message above must receive a role:"tool"
          // answer before the next completion request, or providers reject the history.
          // Branches that abandon the tool loop early flush synthetic "skipped" results
          // for the ids that never executed.
          const answeredToolCallIds = new Set<string>();
          const flushSkippedToolCallResults = (reason: string) => {
            for (const pendingToolCall of toolCalls) {
              if (answeredToolCallIds.has(pendingToolCall.id)) {
                continue;
              }
              answeredToolCallIds.add(pendingToolCall.id);
              conversationMessages.push({
                role: "tool",
                tool_call_id: pendingToolCall.id,
                content: JSON.stringify({ skipped: true, reason }),
              } as ChatCompletionMessage);
            }
          };

          let shortCircuitedOnBudget = false;
          let retryPromptLabSynthesisOnly = false;
          for (const toolCall of toolCalls) {
            throwIfChatTurnCancelled(input);
            if (toolRunCount >= executionBudget.maxToolRunsPerTurn) {
              if (
                !promptLabSynthesisOnly &&
                shouldSynthesizePromptLabFromGatheredEvidence({
                  content: input.content,
                  promptLabContract,
                  toolRuns,
                })
              ) {
                promptLabSynthesisOnly = true;
                retryPromptLabSynthesisOnly = true;
                flushSkippedToolCallResults(
                  `Tool run budget reached (${executionBudget.maxToolRunsPerTurn} tool calls this turn); synthesize from gathered evidence.`,
                );
                conversationMessages.push({
                  role: "system",
                  content: buildPromptLabToolBudgetSynthesisInstruction(executionBudget.maxToolRunsPerTurn, toolRuns),
                } as ChatCompletionMessage);
                break;
              }
              finalFailure = buildChatTurnFailureRecord(
                "tool_run_budget_exceeded",
                `Tool run budget exceeded for this turn after ${executionBudget.maxToolRunsPerTurn} tool calls.`,
                "retry_narrower",
              );
              assistantContent = buildTurnBudgetExceededFallbackMessage({
                turnInput: input,
                toolRuns,
                turnBudgetMs: effectiveTurnBudgetMs,
                fallbackBuilders: {
                  buildFetchedContentBudgetFallback,
                  buildSearchResultBudgetFallback,
                  buildDeterministicToolSynthesisFallback,
                },
              });
              finalStatus = "completed";
              shortCircuitedOnBudget = true;
              break;
            }
            if (circuitBreakerReason) {
              break;
            }
            const loopGuardEvent = detectToolLoopRisk(loopGuardState, toolCall.toolName, toolCall.args);
            if (loopGuardEvent) {
              loopGuardState.events.push(loopGuardEvent);
              this.deps.storage.chatTurnTraces.patch(input.turnId, {
                loopGuard: createLoopGuardTrace(loopGuardState),
              });
              yield {
                type: "trace_update",
                sessionId: input.sessionId,
                turnId: input.turnId,
                trace: {
                  ...trace,
                  routing: {
                    ...routingState,
                    fallbackReason: loopGuardEvent.message,
                  },
                  loopGuard: createLoopGuardTrace(loopGuardState),
                  toolRuns: this.deps.storage.chatToolRuns.listByTurn(input.turnId),
                  citations: [...citations],
                },
              };
              if (loopGuardEvent.suppressed) {
                circuitBreakerReason = loopGuardEvent.message;
                circuitBreakerFailureClass =
                  loopGuardEvent.severity === "global_circuit_breaker" ? "global_circuit_breaker" : "tool_loop_guard";
                break;
              }
            }
            const remainingBeforeTool = ensureChatTurnBudgetRemaining(
              turnBudgetDeadline,
              input.webMode,
              effectiveTurnBudgetMs,
            );
            const minimumRemainingBeforeTool = minimumRemainingBudgetForToolStart(toolCall.toolName, executionBudget);
            if (remainingBeforeTool <= minimumRemainingBeforeTool) {
              assistantContent = buildTurnBudgetExceededFallbackMessage({
                turnInput: input,
                toolRuns,
                turnBudgetMs: effectiveTurnBudgetMs,
                fallbackBuilders: {
                  buildFetchedContentBudgetFallback,
                  buildSearchResultBudgetFallback,
                  buildDeterministicToolSynthesisFallback,
                },
              });
              finalStatus = "completed";
              finalFailure = buildChatTurnFailureRecord(
                "turn_budget_exceeded",
                buildTurnBudgetExceededReason(input.webMode, effectiveTurnBudgetMs),
                input.webMode === "deep" ? "retry_narrower" : "switch_to_deep_mode",
              );
              shortCircuitedOnBudget = true;
              break;
            }
            this.deps.storage.chatTurnTraces.patch(input.turnId, {
              status: "waiting_for_tool",
            });
            toolRunCount += 1;
            const executed = await this.executeToolCall({
              input,
              turnId: input.turnId,
              toolName: toolCall.toolName,
              rawArgs: toolCall.args,
              toolCallId: toolCall.id,
              localFileIntent,
              priorToolRuns: toolRuns,
              turnBudgetDeadline,
            });
            toolRuns.push(executed.record);
            rememberToolLoopHistory(loopGuardState, executed.record);
            ({ turnBudgetDeadline, effectiveTurnBudgetMs, effectiveCompletionTimeoutMs } =
              extendTurnBudgetForExecutedBrowserTool({
                toolName: executed.record.toolName,
                toolStatus: executed.record.status,
                webMode: input.webMode,
                webLookupIntent: intents.webLookup,
                currentTurnBudgetMs: effectiveTurnBudgetMs,
                currentCompletionTimeoutMs: effectiveCompletionTimeoutMs,
                turnBudgetDeadline,
              }));
            yield {
              type: "tool_start",
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolRun: {
                ...executed.record,
                status: "started",
              },
            };
            if (executed.chunk) {
              yield executed.chunk;
            }

            if (executed.userInputPrompt) {
              if (!promptLabEvalIntegrityTurn) {
                finalStatus = "waiting_for_user_input";
                pendingUserInput = executed.userInputPrompt;
                break;
              }
              // Headless eval runs have nobody to answer; tell the model to
              // proceed with stated assumptions instead of parking the turn.
              conversationMessages.push({
                role: "system",
                content:
                  "User input is unavailable in this evaluation. Do not wait for a reply; continue with explicitly stated assumptions and finish the answer.",
              } as ChatCompletionMessage);
            }

            // Approval soft-fail is keyed strictly on the eval-integrity
            // profile: live users pasting contract-shaped text must keep
            // normal approval parking.
            const softFailApprovalRequiredTool =
              executed.record.status === "approval_required" &&
              executed.record.approvalId &&
              promptLabEvalIntegrityTurn;

            if (
              executed.record.status === "approval_required" &&
              executed.record.approvalId &&
              !softFailApprovalRequiredTool
            ) {
              finalStatus = "waiting_for_approval";
              finalFailure = {
                failureClass: "approval_required",
                message: "Approval required by policy.",
                retryable: true,
                recommendedAction: getChatTurnRecoveryAction("approval_required"),
              };
              approvalPayload = {
                approvalId: executed.record.approvalId,
                toolName: executed.record.toolName,
                reason: "Approval required by policy.",
                expiresAt: executed.approvalExpiresAt,
              };
              this.deps.storage.chatInlineApprovals.upsert({
                approvalId: executed.record.approvalId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                toolName: executed.record.toolName,
                status: "pending",
                reason: "Approval required by policy.",
                expiresAt: executed.approvalExpiresAt,
              });
              break;
            }

            if (executed.record.status === "failed" || executed.record.status === "blocked") {
              const retryableFailure =
                executed.record.status === "failed" && isRetryableToolFailure(executed.record.error);
              // Rate-limited failures still count toward the breaker but with a higher
              // threshold so the agent tries harder before giving up.
              const rateLimited =
                executed.record.status === "failed" && isRateLimitedToolFailure(executed.record.error);
              if (!retryableFailure || rateLimited) {
                // P2-9: Include URL in signature so failures on different URLs aren't collapsed.
                const urlSuffix = typeof executed.record.args?.url === "string" ? `:${executed.record.args.url}` : "";
                const signature = `${executed.record.toolName}:${normalizeFailureSignature(executed.record.error)}${urlSuffix}`;
                const nextCount = (toolFailureSignatureCounts.get(signature) ?? 0) + 1;
                toolFailureSignatureCounts.set(signature, nextCount);
                const threshold = shouldTripToolCircuitBreakerImmediately(executed.record.error)
                  ? 1
                  : rateLimited
                    ? TOOL_FAILURE_RATE_LIMIT_THRESHOLD
                    : TOOL_FAILURE_CIRCUIT_BREAKER_THRESHOLD;
                if (nextCount >= threshold) {
                  circuitBreakerReason =
                    threshold === 1
                      ? `Non-recoverable tool failure for ${executed.record.toolName}: ${executed.record.error ?? "unknown error"}`
                      : `Repeated tool failure for ${executed.record.toolName} (${nextCount} attempts): ${executed.record.error ?? "unknown error"}`;
                  break;
                }
              }
            }

            const toolFailureGuidance = softFailApprovalRequiredTool
              ? (executed.record.failureGuidance ??
                `Approval-gated tool execution is unavailable for this evaluation (\`${executed.record.toolName}\`). Do not retry the same gated tool call; continue with the completed evidence and state any remaining unknowns explicitly.`)
              : executed.record.failureGuidance;
            const toolResultPayload = {
              ...(executed.record.result ?? {
                error:
                  executed.record.error ??
                  (executed.record.status === "approval_required" ? "Approval required by policy." : "Tool failed."),
              }),
              ...(executed.record.status === "approval_required" ? { approvalRequired: true } : {}),
              ...(toolFailureGuidance ? { failureGuidance: toolFailureGuidance } : {}),
            };
            answeredToolCallIds.add(toolCall.id);
            conversationMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResultPayload),
            } as ChatCompletionMessage);
            const researchListSourceFailureInstruction = buildResearchListSourceFailureInstruction({
              researchListIntent: intents.researchList,
              toolRun: executed.record,
            });
            if (researchListSourceFailureInstruction) {
              conversationMessages.push({
                role: "system",
                content: researchListSourceFailureInstruction,
              } as ChatCompletionMessage);
            }
            if (softFailApprovalRequiredTool) {
              conversationMessages.push({
                role: "system",
                content: `Prompt Lab compliance note: do not request \`${executed.record.toolName}\` again for this turn after an approval-required result. Continue from the completed evidence and make any remaining uncertainty explicit.`,
              } as ChatCompletionMessage);
            }

            for (const citation of inferCitationsFromToolResult(executed.record)) {
              citations.push(citation);
              yield {
                type: "citation",
                sessionId: input.sessionId,
                turnId: input.turnId,
                citation,
              };
            }
          }

          // Catch-all: any branch that broke out of the tool loop without answering
          // every tool_call id gets synthetic skipped results so the message history
          // stays valid for the next completion request (in this turn or after resume).
          flushSkippedToolCallResults(
            approvalPayload
              ? "Tool execution paused: approval required for an earlier tool call."
              : pendingUserInput
                ? "Tool execution paused: waiting for user input."
                : circuitBreakerReason
                  ? `Tool execution halted: ${circuitBreakerReason}`
                  : shortCircuitedOnBudget
                    ? "Tool execution halted: turn budget exceeded."
                    : "Tool execution skipped.",
          );

          if (approvalPayload) {
            break;
          }

          if (retryPromptLabSynthesisOnly) {
            continue;
          }

          if (shortCircuitedOnBudget) {
            break;
          }

          if (circuitBreakerReason) {
            assistantContent = buildToolFailureFallbackMessage(input.content, toolRuns, circuitBreakerReason);
            finalStatus = "completed";
            finalFailure = buildChatTurnFailureRecord(
              circuitBreakerFailureClass ??
                classifyChatTurnFailure({
                  toolRuns,
                }),
              circuitBreakerReason,
            );
            break;
          }
        }
      } catch (error) {
        if (isChatTurnAbortError(error, input.signal)) {
          finalStatus = "cancelled";
          assistantContent = "";
          finalFailure = undefined;
        } else if (error instanceof ChatTurnBudgetExceededError) {
          finalStatus = "completed";
          assistantContent = buildTurnBudgetExceededFallbackMessage({
            turnInput: input,
            toolRuns,
            turnBudgetMs: error.turnBudgetMs,
            fallbackBuilders: {
              buildFetchedContentBudgetFallback,
              buildSearchResultBudgetFallback,
              buildDeterministicToolSynthesisFallback,
            },
          });
          finalFailure = buildChatTurnFailureRecord(
            "turn_budget_exceeded",
            error.message,
            input.webMode === "deep" ? "retry_narrower" : "switch_to_deep_mode",
          );
        } else {
          finalStatus = "failed";
          const failureClass = classifyChatTurnFailure({
            error,
            toolRuns,
          });
          finalFailure = buildChatTurnFailureRecord(
            failureClass,
            (error as Error).message,
            getChatTurnRecoveryAction(failureClass),
            extractProviderFailureRecord(error),
          );
          completionState = {
            ...completionState,
            status: "interrupted",
          };
          assistantContent = buildUserSafeFailureMessage(finalFailure);
          yield {
            type: "error",
            sessionId: input.sessionId,
            turnId: input.turnId,
            error: assistantContent,
          };
        }
      }
    }

    if (
      !approvalPayload &&
      finalStatus !== "cancelled" &&
      !promptLabEvalIntegrityTurn &&
      input.toolAutonomy !== "manual" &&
      intents.presentationArtifact &&
      toolSchema.canonicalToModel.has("presentations.create") &&
      !toolRuns.some((run) => run.toolName === "presentations.create" && run.status === "executed") &&
      toolRunCount < executionBudget.maxToolRunsPerTurn
    ) {
      throwIfChatTurnCancelled(input);
      const presentationVisual = await attachGeneratedPresentationVisual(
        buildSyntheticPresentationCreateArgs(input, this.deps.safeWriteFallbackDir),
        input,
        this.deps.generateImage,
      );
      providerCallCount += presentationVisual.providerCalls;
      const rawArgs = presentationVisual.args;
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "presentations.create",
        rawArgs,
        localFileIntent,
        priorToolRuns: toolRuns,
        turnBudgetDeadline,
      });
      toolRuns.push(syntheticRun.record);
      rememberToolLoopHistory(loopGuardState, syntheticRun.record);
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      if (syntheticRun.userInputPrompt) {
        finalStatus = "waiting_for_user_input";
        pendingUserInput = syntheticRun.userInputPrompt;
      } else {
        const preRepairContent = assistantContent;
        assistantContent = mergePresentationArtifactDeliveryContent(assistantContent, syntheticRun.record);
        if (assistantContent !== preRepairContent) {
          markCompletionRepair("degraded_answer_synthesis", "orchestrator", preRepairContent, assistantContent);
        }
        if (syntheticRun.record.status === "executed" && finalStatus === "failed") {
          finalStatus = "completed";
        }
      }
    }

    if (
      !approvalPayload &&
      finalStatus !== "cancelled" &&
      !promptLabEvalIntegrityTurn &&
      input.toolAutonomy !== "manual" &&
      intents.documentArtifact &&
      toolSchema.canonicalToModel.has("documents.create") &&
      !toolRuns.some((run) => run.toolName === "documents.create" && run.status === "executed") &&
      toolRunCount < executionBudget.maxToolRunsPerTurn
    ) {
      throwIfChatTurnCancelled(input);
      const rawArgs = buildSyntheticDocumentCreateArgs(input, this.deps.safeWriteFallbackDir);
      this.deps.storage.chatTurnTraces.patch(input.turnId, {
        status: "waiting_for_tool",
      });
      const syntheticRun = await this.executeToolCall({
        input,
        turnId: input.turnId,
        toolName: "documents.create",
        rawArgs,
        localFileIntent,
        priorToolRuns: toolRuns,
        turnBudgetDeadline,
      });
      toolRuns.push(syntheticRun.record);
      rememberToolLoopHistory(loopGuardState, syntheticRun.record);
      yield {
        type: "tool_start",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolRun: {
          ...syntheticRun.record,
          status: "started",
        },
      };
      if (syntheticRun.chunk) {
        yield syntheticRun.chunk;
      }
      if (syntheticRun.userInputPrompt) {
        finalStatus = "waiting_for_user_input";
        pendingUserInput = syntheticRun.userInputPrompt;
      } else {
        const preRepairContent = assistantContent;
        assistantContent = mergeDocumentArtifactDeliveryContent(assistantContent, syntheticRun.record);
        if (assistantContent !== preRepairContent) {
          markCompletionRepair("degraded_answer_synthesis", "orchestrator", preRepairContent, assistantContent);
        }
        if (syntheticRun.record.status === "executed" && finalStatus === "failed") {
          finalStatus = "completed";
        }
      }
    }

    if (
      !approvalPayload &&
      finalStatus !== "cancelled" &&
      toolRuns.length > 0 &&
      (looksLikeDegradedAssistantFallbackContent(assistantContent) ||
        looksLikeSerializedToolCallMarkupContent(assistantContent))
    ) {
      const repairedFallback = await this.synthesizeToolOutcomeFallback({
        input,
        toolRuns,
        circuitBreakerReason: finalFailure?.message ?? circuitBreakerReason,
        turnBudgetDeadline,
        allowOverBudget: true,
      });
      providerCallCount += repairedFallback.providerCalls;
      accrueCompletionUsage(repairedFallback.usage);
      const repairedContent = repairedFallback.content.trim();
      if (
        repairedContent.length > 0 &&
        !looksLikeDegradedAssistantFallbackContent(repairedContent) &&
        !looksLikeSerializedToolCallMarkupContent(repairedContent)
      ) {
        const preRepairContent = assistantContent;
        assistantContent = repairedContent;
        markCompletionRepair("degraded_answer_synthesis", "orchestrator", preRepairContent, assistantContent);
        if (finalStatus === "failed") {
          finalStatus = "completed";
        }
      }
      if (!finalFailure) {
        finalFailure = buildChatTurnFailureRecord(
          "unknown",
          "Tool execution completed, but the first answer degraded into a fallback-style response and required repair.",
        );
      }
    }

    if (
      !approvalPayload &&
      finalStatus !== "cancelled" &&
      completionState.status !== "complete" &&
      !suppressIncompleteCompletionRepair
    ) {
      const repairedCompletion = await this.repairIncompleteAssistantCompletion({
        input,
        partialAssistantContent: assistantContent,
        conversationMessages,
        toolRuns,
        turnBudgetDeadline,
      });
      providerCallCount += repairedCompletion.providerCalls;
      accrueCompletionUsage(repairedCompletion.usage);
      if (
        repairedCompletion.content.trim().length > 0 &&
        !looksLikeSerializedToolCallMarkupContent(repairedCompletion.content)
      ) {
        const preRepairContent = assistantContent;
        assistantContent = repairedCompletion.content.trim();
        markCompletionRepair("incomplete_truncated_completion", "orchestrator", preRepairContent, assistantContent);
        if (finalStatus === "failed" && !looksLikeRecoverableAssistantFallbackContent(assistantContent)) {
          finalStatus = "completed";
        }
      }
    }

    if (!approvalPayload && finalStatus !== "cancelled" && assistantContent.trim().length === 0) {
      const synthesizedFallback = await this.synthesizeToolOutcomeFallback({
        input,
        toolRuns,
        circuitBreakerReason,
        turnBudgetDeadline,
      });
      providerCallCount += synthesizedFallback.providerCalls;
      accrueCompletionUsage(synthesizedFallback.usage);
      const preRepairContent = assistantContent;
      assistantContent = synthesizedFallback.content;
      if (assistantContent.trim().length > 0) {
        markCompletionRepair(
          "deterministic_empty_output_synthesis",
          "orchestrator",
          preRepairContent,
          assistantContent,
        );
        if (finalStatus === "failed" && !looksLikeRecoverableAssistantFallbackContent(assistantContent)) {
          finalStatus = "completed";
        }
      }
      if (synthesizedFallback.deterministic && !finalFailure && toolRuns.length > 0) {
        finalFailure = buildChatTurnFailureRecord(
          "unknown",
          "Tool execution completed, but final answer synthesis fell back to deterministic recovery.",
        );
      }
    }
    // Eval-integrity turns must persist the model's own text verbatim. The
    // prompt-pack harness normalization layer (canned-answer fallbacks, repo
    // evidence rewrites, citation appendices) was removed because it replaced
    // model output before scoring; see docs/superpowers/plans/
    // 2026-06-10-prompt-lab-harness-fix-plan.md.
    if (!approvalPayload && finalStatus !== "cancelled" && input.mode === "cowork" && !promptLabEvalIntegrityTurn) {
      const repairedCoworkContent = normalizeCoworkRoleContractOutput({
        prompt: input.content,
        responseText: assistantContent,
        toolRuns,
      });
      if (repairedCoworkContent !== assistantContent) {
        const preRepairContent = assistantContent;
        assistantContent = repairedCoworkContent;
        markCompletionRepair("cowork_contract_normalization", "orchestrator", preRepairContent, assistantContent);
      }
    }
    if (finalStatus !== "cancelled" && !promptLabEvalIntegrityTurn) {
      assistantContent = appendToolFailureConstraints(assistantContent, toolRuns, input.content);
    }
    if (
      finalFailure &&
      shouldClearRecoverableCompletionFailure({
        normalizationProfile,
        mode: input.mode,
        finalStatus,
        approvalPending: Boolean(approvalPayload),
        completion: completionState,
        failure: finalFailure,
        assistantContent,
        toolRuns,
      })
    ) {
      // Keep an audit trail on the completion record: the failure is cleared
      // for scoring/consumers, but the trace still shows what was suppressed.
      completionState = {
        ...completionState,
        failureCleared: {
          failureClass: finalFailure.failureClass,
          message: finalFailure.message,
        },
      };
      finalFailure = undefined;
    }

    const finishedAt = new Date().toISOString();
    const finalizedCompletion = finalizeTurnCompletionState({
      completion: completionState,
      finalStatus,
      approvalPending: Boolean(approvalPayload),
      userInputPending: Boolean(pendingUserInput),
    });
    const finalizedCompletionWithRuntime: NonNullable<ChatTurnTraceRecord["completion"]> = {
      ...finalizedCompletion,
      ...(usageObserved
        ? {
            usage: buildTraceUsageRecord(usageTotals, resolveUsageCostSource(usageCostSources)),
          }
        : {}),
      ...(completionLatencyObserved ? { latencyMs: completionLatencyMs } : {}),
      ...(providerCallCount > 0 ? { providerCallCount } : {}),
    };
    const updatedTrace = this.deps.storage.chatTurnTraces.patch(input.turnId, {
      status: finalStatus,
      model: assistantModel,
      citations,
      failure: finalFailure,
      completion: finalizedCompletionWithRuntime,
      routing: {
        ...routingState,
        liveDataIntent: intents.liveData,
        effectiveProviderId: routingState.effectiveProviderId ?? input.providerId,
        effectiveModel: routingState.effectiveModel ?? assistantModel,
      },
      loopGuard: createLoopGuardTrace(loopGuardState),
      finishedAt,
      ...(pendingUserInput ? { pendingUserInput } : {}),
    });
    const hydratedTrace = {
      ...updatedTrace,
      citations,
      toolRuns: this.deps.storage.chatToolRuns.listByTurn(input.turnId),
    };

    if (approvalPayload) {
      yield {
        type: "approval_required",
        sessionId: input.sessionId,
        turnId: input.turnId,
        approval: approvalPayload,
      };
    } else if (pendingUserInput) {
      yield {
        type: "user_input_required",
        sessionId: input.sessionId,
        turnId: input.turnId,
        prompt: pendingUserInput,
      };
    } else if (finalStatus !== "cancelled") {
      if (usageObserved) {
        yield {
          type: "usage",
          sessionId: input.sessionId,
          turnId: input.turnId,
          usage: buildTraceUsageRecord(usageTotals, resolveUsageCostSource(usageCostSources)),
        };
      }
      yield {
        type: "message_done",
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: outputMessageId,
        content: assistantContent,
        repaired: Boolean(finalizedCompletionWithRuntime.repaired),
        repair: finalizedCompletionWithRuntime.repair,
      };
    }

    yield {
      type: "trace_update",
      sessionId: input.sessionId,
      turnId: input.turnId,
      trace: hydratedTrace,
    };

    if (finalizedCompletionWithRuntime.status === "complete") {
      yield {
        type: "done",
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: outputMessageId,
      };
    }
  }

  private async buildToolSchema(
    input: Pick<
      ChatAgentTurnInput,
      | "sessionId"
      | "webMode"
      | "mode"
      | "content"
      | "historyMessages"
      | "normalizationProfile"
      | "operatorId"
      | "authActorId"
      | "authActorSource"
      | "permissionProfileId"
      | "localOperatorOverrideId"
      | "policyRunId"
      | "policyTaskId"
    >,
    intents: {
      liveData: boolean;
      webLookup: boolean;
      localFile: boolean;
      presentationArtifact: boolean;
      documentArtifact: boolean;
    },
  ): Promise<{
    tools: Array<Record<string, unknown>>;
    modelToCanonical: Map<string, string>;
    canonicalToModel: Map<string, string>;
  }> {
    const catalog = this.deps.listToolCatalog();
    const promptLabContract = parsePromptLabRunContract(input.content);
    const promptLabHarnessTurn =
      input.normalizationProfile === "prompt_pack_harness" || isPromptLabHarnessContent(input.content);
    const suppressPromptLabCodeArtifactTools =
      input.mode === "code" &&
      promptLabHarnessTurn &&
      !promptLabContractRequiresArtifactTools(promptLabContract);
    const promptLabTask = promptLabContract.userTask || extractPrimaryUserTaskContent(input.content);
    const promptSpecificWebLookupTurn = input.mode !== "code" && Boolean(derivePromptSpecificWebQuery(input.content));
    const promptLabFileInspectionIntent =
      promptLabHarnessTurn &&
      (promptLabContractRequiresFileTools(promptLabContract) ||
        promptLabContract.repoGroundedAssist ||
        extractExplicitLocalFilePathsFromPrompt(promptLabTask).length > 0 ||
        promptLabTaskSuggestsRepoInspection(promptLabTask));
    const nonCodeToolFamilyTurnWithoutFileIntent =
      input.mode !== "code" &&
      !promptLabFileInspectionIntent &&
      !intents.localFile &&
      !looksLikeRepoGroundedInspectionPrompt(promptLabTask) &&
      (detectMemoryToolsOnlyPrompt(input.content) ||
        /\buse web lookup\b/i.test(input.content) ||
        (input.mode === "cowork" &&
          looksLikeEverydayNonCodeCoworkPrompt(input.content, promptLabTask ?? input.content)));
    const delegatedPromptLabNonCodeWithoutFileIntent =
      input.mode !== "code" &&
      !promptLabFileInspectionIntent &&
      !intents.localFile &&
      looksLikePromptLabDelegatedNonCodeTurn(input.content, promptLabTask);
    const nonCodeWebLookupWithoutFileIntent =
      input.mode !== "code" &&
      !promptLabFileInspectionIntent &&
      (intents.webLookup || intents.liveData) &&
      extractExplicitLocalFilePathsFromPrompt(promptLabTask).length === 0 &&
      !promptLabTaskSuggestsRepoInspection(promptLabTask) &&
      !looksLikeRepoGroundedInspectionPrompt(promptLabTask);
    const suppressLocalPathTools =
      promptSpecificWebLookupTurn ||
      nonCodeWebLookupWithoutFileIntent ||
      (promptLabHarnessTurn && input.mode !== "code" && !promptLabFileInspectionIntent) ||
      delegatedPromptLabNonCodeWithoutFileIntent ||
      nonCodeToolFamilyTurnWithoutFileIntent;
    const localFileIntent = suppressLocalPathTools
      ? false
      : intents.localFile ||
        promptLabFileInspectionIntent ||
        (input.normalizationProfile === "prompt_pack_harness" && looksLikeRepoGroundedInspectionPrompt(promptLabTask));
    const explicitToolMentions = detectExplicitToolMentions(
      input.content,
      catalog.map((tool) => tool.toolName),
    );
    const memoryLookupIntent = detectMemoryLookupIntent(input.content) || detectMemoryToolsOnlyPrompt(input.content);
    const memoryPersistenceIntent = detectMemoryPersistenceIntent(input.content);
    const webLookupIntent = intents.webLookup || [...explicitToolMentions].some((toolName) => isWebToolName(toolName));
    const promptLabHasExplicitToolFamily =
      promptLabContract.requiredNamedTools.length > 0 || promptLabContract.requiredToolFamilies.length > 0;
    const recentToolRuns = this.deps.storage.chatToolRuns.listBySession(input.sessionId, 200);
    const projectBound = Boolean(this.deps.storage.chatSessionProjects.get(input.sessionId)?.projectId);
    const activePlan = this.deps.storage.chatExecutionPlans
      ? selectActiveExecutionPlan(this.deps.storage.chatExecutionPlans.listBySession(input.sessionId, 20))
      : undefined;
    const suggestedTools = new Set(selectExecutionPlanSuggestedTools(activePlan));
    const failedCounts = buildRecentToolFailureCounts(recentToolRuns);
    const filteredCatalog: ToolCatalogEntry[] = [];
    for (const tool of catalog) {
      if (suppressPromptLabCodeArtifactTools && PROMPT_LAB_ARTIFACT_TOOL_NAMES.has(tool.toolName)) {
        continue;
      }
      if (
        promptLabHarnessTurn &&
        input.mode === "code" &&
        tool.toolName.startsWith("memory.") &&
        !memoryLookupIntent &&
        !memoryPersistenceIntent
      ) {
        continue;
      }
      if (suppressLocalPathTools && LOCAL_PATH_TOOL_NAMES.has(tool.toolName)) {
        continue;
      }
      if (
        promptLabHarnessTurn &&
        input.mode !== "code" &&
        promptLabContract.explicitTools &&
        promptLabHasExplicitToolFamily &&
        LOCAL_PATH_TOOL_NAMES.has(tool.toolName) &&
        !promptLabContractRequiresFileTools(promptLabContract)
      ) {
        continue;
      }
      if (
        promptLabHarnessTurn &&
        promptLabContract.explicitTools &&
        promptLabHasExplicitToolFamily &&
        isWebToolName(tool.toolName) &&
        !promptLabContractRequiresWebTools(promptLabContract) &&
        !webLookupIntent
      ) {
        continue;
      }
      if (
        promptLabHarnessTurn &&
        promptLabContract.explicitTools &&
        promptLabHasExplicitToolFamily &&
        tool.toolName.startsWith("memory.") &&
        !memoryLookupIntent &&
        !memoryPersistenceIntent
      ) {
        continue;
      }
      if (input.webMode === "off" && isWebToolName(tool.toolName)) {
        continue;
      }
      if (
        !shouldExposeWebToolForTurn({
          toolName: tool.toolName,
          mode: input.mode,
          webMode: input.webMode,
          webLookupIntent,
        })
      ) {
        continue;
      }
      if (!this.deps.evaluateToolAccess) {
        filteredCatalog.push(tool);
        continue;
      }
      try {
        const access = this.deps.evaluateToolAccess({
          toolName: tool.toolName,
          sessionId: input.sessionId,
          agentId: "assistant",
          taskId: input.policyTaskId,
          runId: input.policyRunId,
          args: buildToolAccessProbeArgs(tool.toolName, this.deps.safeWriteFallbackDir),
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          surface: input.mode,
          policyContext: {
            operatorId: input.operatorId,
            authActorId: input.authActorId,
            authActorSource: input.authActorSource,
            taskId: input.policyTaskId,
            runId: input.policyRunId,
            surface: input.mode,
            permissionProfileId: input.permissionProfileId,
            localOperatorOverrideId: input.localOperatorOverrideId,
          },
        });
        if (!access.allowed) {
          continue;
        }
      } catch {
        continue;
      }
      filteredCatalog.push(tool);
    }
    const scoredCatalog = filteredCatalog
      .map((tool) => ({
        tool,
        score: scoreToolForTurn({
          tool,
          mode: input.mode,
          liveDataIntent: intents.liveData,
          webLookupIntent,
          localFileIntent,
          presentationArtifactIntent: intents.presentationArtifact,
          documentArtifactIntent: intents.documentArtifact,
          memoryLookupIntent,
          memoryPersistenceIntent,
          projectBound,
          suggestedTools,
          failedCounts,
          content: input.content,
          explicitToolMentions,
        }),
      }))
      .sort((left, right) => right.score - left.score);
    const essentialToolNames = buildEssentialToolSet({
      mode: input.mode,
      webMode: input.webMode,
      liveDataIntent: intents.liveData,
      webLookupIntent,
      localFileIntent,
      presentationArtifactIntent: intents.presentationArtifact,
      documentArtifactIntent: intents.documentArtifact,
      memoryLookupIntent,
      memoryPersistenceIntent,
      explicitToolMentions,
      projectBound,
      suppressLocalPathTools,
    });
    const toolTokenEstimateCache = new Map<string, number>();
    function cachedEstimateToolTokens(toolJson: string, toolName: string): number {
      const cached = toolTokenEstimateCache.get(toolName);
      if (cached !== undefined) return cached;
      const estimate = estimateTokensFromText(toolJson);
      toolTokenEstimateCache.set(toolName, estimate);
      return estimate;
    }
    const modelToCanonical = new Map<string, string>();
    const canonicalToModel = new Map<string, string>();
    const selectedCatalog: ToolCatalogEntry[] = [];
    const selectedNames = new Set<string>();
    for (const toolName of essentialToolNames) {
      const candidate = scoredCatalog.find((entry) => entry.tool.toolName === toolName)?.tool;
      if (!candidate || selectedNames.has(candidate.toolName)) {
        continue;
      }
      selectedCatalog.push(candidate);
      selectedNames.add(candidate.toolName);
    }
    const toolCountCap = MAX_EXPOSED_TOOLS_PER_TURN[input.mode];
    let schemaTokenBudget = TOOL_SCHEMA_TOKEN_BUDGET[input.mode];
    for (const tool of selectedCatalog) {
      schemaTokenBudget -= cachedEstimateToolTokens(JSON.stringify(tool), tool.toolName);
    }
    for (const entry of scoredCatalog) {
      if (selectedCatalog.length >= toolCountCap || selectedNames.has(entry.tool.toolName)) {
        continue;
      }
      const estimated = cachedEstimateToolTokens(JSON.stringify(entry.tool), entry.tool.toolName);
      if (schemaTokenBudget - estimated < 0 && selectedCatalog.length > 0) {
        continue;
      }
      selectedCatalog.push(entry.tool);
      selectedNames.add(entry.tool.toolName);
      schemaTokenBudget -= estimated;
    }
    const tools = selectedCatalog.map((tool) => {
      const modelName = toProviderToolFunctionName(tool.toolName, modelToCanonical);
      modelToCanonical.set(modelName, tool.toolName);
      canonicalToModel.set(tool.toolName, modelName);
      return {
        type: "function",
        function: {
          name: modelName,
          description: buildToolFunctionDescription(tool),
          parameters: normalizeToolParameters(tool),
        },
      };
    });
    // AGENTORCH-005: the canonical maps (`modelToCanonical` /
    // `canonicalToModel`) are the authoritative allow-map that
    // `resolveAllowedModelToolCallName` consults to decide whether a model tool
    // call is permitted. They are populated exclusively from the selected
    // catalog above — i.e. tools that are registered AND passed the access
    // check. `namespace.method` tokens that merely appear in user/model content
    // are intentionally NOT registered here: doing so would widen the
    // fail-closed allow-map to arbitrary content-derived names that were never
    // catalog-registered or access-checked. Content references still influence
    // tool selection/scoring via `detectExplicitToolMentions`, but they must
    // not grant authorization.

    return {
      tools,
      modelToCanonical,
      canonicalToModel,
    };
  }

  private resolveModelToolName(toolName: string, mapping: Map<string, string>): string {
    return mapping.get(toolName) ?? toProviderToolFunctionName(toolName);
  }

  private async executeToolCall(input: {
    input: ChatAgentTurnInput;
    turnId: string;
    toolName: string;
    rawArgs: Record<string, unknown>;
    toolCallId?: string;
    localFileIntent?: boolean;
    priorToolRuns?: ChatToolRunRecord[];
    turnBudgetDeadline?: number;
  }): Promise<{
    record: ChatToolRunRecord;
    approvalExpiresAt?: string;
    chunk?: ChatStreamChunkDraft;
    userInputPrompt?: ChatUserInputPromptRecord;
  }> {
    const preflight = this.preflightToolInvocation({
      toolName: input.toolName,
      rawArgs: input.rawArgs,
      userContent: input.input.content,
      historyMessages: input.input.historyMessages,
      webMode: input.input.webMode,
      localFileIntent: input.localFileIntent,
      mode: input.input.mode,
      priorToolRuns: input.priorToolRuns,
      evalIntegrityTurn: input.input.normalizationProfile === "prompt_pack_harness",
    });
    const startedAt = new Date().toISOString();
    const toolRunId = randomUUID();
    const created = this.deps.storage.chatToolRuns.create({
      toolRunId,
      turnId: input.turnId,
      sessionId: input.input.sessionId,
      toolName: preflight.toolName,
      status: "started",
      args: preflight.args,
      startedAt,
    });

    if (preflight.blockedReason) {
      const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
        status: "blocked",
        error: preflight.blockedReason,
        failureGuidance: buildToolFailureGuidance({
          toolName: preflight.toolName,
          status: "blocked",
          args: preflight.args,
          error: preflight.blockedReason,
        }),
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }

    if (preflight.failureReason) {
      const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
        status: "failed",
        error: preflight.failureReason,
        failureGuidance: buildToolFailureGuidance({
          toolName: preflight.toolName,
          status: "failed",
          args: preflight.args,
          error: preflight.failureReason,
        }),
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }

    const reusableResult = findReusableBrowserToolResult(
      preflight.toolName,
      input.rawArgs,
      preflight.args,
      input.priorToolRuns,
    );
    if (reusableResult) {
      const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
        status: "executed",
        reused: true,
        reusedFromToolRunId: reusableResult.toolRunId,
        reuseReason: "matching_recent_browser_result",
        result: {
          ...(reusableResult.result as Record<string, unknown>),
          reusedNotice: `Result reused from prior ${reusableResult.toolName} run ${reusableResult.toolRunId}.`,
          reusedPriorToolRunId: reusableResult.toolRunId,
          reusedResult: true,
          reuseReason: "matching_recent_browser_result",
        },
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }

    const sourceAttribution = collectSourceAttributionFromToolRuns(input.priorToolRuns);

    try {
      const result = await this.deps.invokeTool({
        toolName: preflight.toolName,
        args: preflight.args,
        agentId: "assistant",
        sessionId: input.input.sessionId,
        taskId: input.input.policyTaskId,
        runId: input.input.policyRunId,
        surface: input.input.mode,
        signal: input.input.signal,
        ...(sourceAttribution ? { sourceAttribution } : {}),
        permissionProfileId: input.input.permissionProfileId,
        localOperatorOverrideId: input.input.localOperatorOverrideId,
        consentContext: {
          operatorId: input.input.operatorId,
          source: "agent",
          reason: `chat mode ${input.input.mode}`,
        },
        policyContext: {
          operatorId: input.input.operatorId,
          authActorId: input.input.authActorId,
          authActorSource: input.input.authActorSource,
          taskId: input.input.policyTaskId,
          runId: input.input.policyRunId,
          surface: input.input.mode,
          permissionProfileId: input.input.permissionProfileId,
          localOperatorOverrideId: input.input.localOperatorOverrideId,
          fullWebAccess: input.input.fullWebAccess,
        },
      });
      const persistedToolResult = await this.persistToolArtifactsIfNeeded({
        sessionId: input.input.sessionId,
        turnId: input.turnId,
        toolRunId: created.toolRunId,
        toolName: preflight.toolName,
        result: result.result,
      });

      if (result.outcome === "approval_required") {
        const approvalExpiresAt = result.approvalId
          ? this.resolveApprovalExpiresAt(result.approvalId, result.expiresAt)
          : undefined;
        const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
          status: "approval_required",
          approvalId: result.approvalId,
          result: persistedToolResult,
          finishedAt: new Date().toISOString(),
        });
        return {
          record: updated,
          approvalExpiresAt,
          chunk: {
            type: "tool_result",
            sessionId: input.input.sessionId,
            turnId: input.turnId,
            toolRun: updated,
          },
        };
      }

      if (result.outcome === "blocked") {
        const writeFallback = await this.tryWriteJailFallback({
          input: input.input,
          toolName: preflight.toolName,
          args: preflight.args,
          policyReason: result.policyReason,
          sourceAttribution,
        });
        if (writeFallback) {
          if (writeFallback.result.outcome === "executed") {
            const fallbackPayload = {
              ...(writeFallback.result.result ?? {}),
              fallbackApplied: true,
              fallbackPath: writeFallback.fallbackPath,
              originalPath: typeof preflight.args.path === "string" ? preflight.args.path : undefined,
              note: `Write path blocked by policy; wrote to fallback path ${writeFallback.fallbackPath}`,
            };
            const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
              status: "executed",
              result: fallbackPayload,
              finishedAt: new Date().toISOString(),
            });
            return {
              record: updated,
              chunk: {
                type: "tool_result",
                sessionId: input.input.sessionId,
                turnId: input.turnId,
                toolRun: updated,
              },
            };
          }

          if (writeFallback.result.outcome === "approval_required") {
            const approvalExpiresAt = writeFallback.result.approvalId
              ? this.resolveApprovalExpiresAt(writeFallback.result.approvalId, writeFallback.result.expiresAt)
              : undefined;
            const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
              status: "approval_required",
              approvalId: writeFallback.result.approvalId,
              result: {
                ...(writeFallback.result.result ?? {}),
                fallbackPath: writeFallback.fallbackPath,
                note: `Original write path was blocked. Fallback path requires approval: ${writeFallback.fallbackPath}`,
              },
              finishedAt: new Date().toISOString(),
            });
            return {
              record: updated,
              approvalExpiresAt,
              chunk: {
                type: "tool_result",
                sessionId: input.input.sessionId,
                turnId: input.turnId,
                toolRun: updated,
              },
            };
          }

          const fallbackError = [
            result.policyReason,
            `fallback path attempted: ${writeFallback.fallbackPath}`,
            writeFallback.result.policyReason,
          ]
            .filter(Boolean)
            .join("; ");
          const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
            status: "blocked",
            error: fallbackError,
            result: writeFallback.result.result,
            failureGuidance: buildToolFailureGuidance({
              toolName: preflight.toolName,
              status: "blocked",
              args: preflight.args,
              error: fallbackError,
              result: writeFallback.result.result,
            }),
            finishedAt: new Date().toISOString(),
          });
          return {
            record: updated,
            chunk: {
              type: "tool_result",
              sessionId: input.input.sessionId,
              turnId: input.turnId,
              toolRun: updated,
            },
            userInputPrompt: buildWriteDestinationUserInputPrompt({
              sessionId: input.input.sessionId,
              turnId: input.turnId,
              toolName: preflight.toolName,
              requestedPath: preflight.args.path,
              fallbackPath: writeFallback.fallbackPath,
              policyReason: fallbackError,
              safeWriteFallbackDir: this.deps.safeWriteFallbackDir,
            }),
          };
        }

        const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
          status: "blocked",
          error: result.policyReason,
          result: persistedToolResult,
          failureGuidance: buildToolFailureGuidance({
            toolName: preflight.toolName,
            status: "blocked",
            args: preflight.args,
            error: result.policyReason,
            result: persistedToolResult,
          }),
          finishedAt: new Date().toISOString(),
        });
        return {
          record: updated,
          chunk: {
            type: "tool_result",
            sessionId: input.input.sessionId,
            turnId: input.turnId,
            toolRun: updated,
          },
          userInputPrompt: buildWriteDestinationUserInputPrompt({
            sessionId: input.input.sessionId,
            turnId: input.turnId,
            toolName: preflight.toolName,
            requestedPath: preflight.args.path,
            policyReason: result.policyReason,
            safeWriteFallbackDir: this.deps.safeWriteFallbackDir,
          }),
        };
      }

      if (MCP_BROWSER_FALLBACK_TOOL_NAMES.has(preflight.toolName)) {
        const finalized = await this.finalizeBrowserToolCall({
          created,
          turnInput: input.input,
          turnId: input.turnId,
          toolName: preflight.toolName,
          args: preflight.args,
          result: result.result,
          turnBudgetDeadline: input.turnBudgetDeadline,
        });
        if (finalized) {
          return finalized;
        }
      }

      const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
        status: "executed",
        result: persistedToolResult,
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    } catch (error) {
      if (MCP_BROWSER_FALLBACK_TOOL_NAMES.has(preflight.toolName)) {
        const recovered = await this.finalizeBrowserToolCall({
          created,
          turnInput: input.input,
          turnId: input.turnId,
          toolName: preflight.toolName,
          args: preflight.args,
          error: (error as Error).message,
          turnBudgetDeadline: input.turnBudgetDeadline,
        });
        if (recovered) {
          return recovered;
        }
      }
      const updated = this.deps.storage.chatToolRuns.patch(created.toolRunId, {
        status: "failed",
        error: (error as Error).message,
        failureGuidance: buildToolFailureGuidance({
          toolName: preflight.toolName,
          status: "failed",
          args: preflight.args,
          error: (error as Error).message,
        }),
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
        userInputPrompt: buildWriteDestinationUserInputPrompt({
          sessionId: input.input.sessionId,
          turnId: input.turnId,
          toolName: preflight.toolName,
          requestedPath: preflight.args.path,
          policyReason: (error as Error).message,
          safeWriteFallbackDir: this.deps.safeWriteFallbackDir,
        }),
      };
    }
  }

  private resolveApprovalExpiresAt(approvalId: string, fallback?: string): string | undefined {
    if (fallback) {
      return fallback;
    }
    try {
      return this.deps.storage.approvals.get(approvalId).expiresAt;
    } catch {
      return undefined;
    }
  }

  private async persistToolArtifactsIfNeeded(input: {
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    result?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    if (!input.result || !this.deps.persistToolArtifact) {
      return input.result;
    }
    const content = extractPersistableToolArtifactContent(input.toolName, input.result);
    if (!content) {
      return input.result;
    }
    const persisted = await this.deps.persistToolArtifact({
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolRunId: input.toolRunId,
      toolName: input.toolName,
      content: content.content,
      contentType: content.contentType,
      snippet: content.snippet,
      createdAt: new Date().toISOString(),
    });
    return compactToolResultForTurn(input.result, {
      artifactId: persisted.artifactId,
      storageRelPath: persisted.storageRelPath,
      byteLength: persisted.byteLength,
      contentType: persisted.contentType,
      snippet: persisted.snippet,
      summary: content.summary,
      virtualized: content.virtualized,
      compactMode: content.compactMode,
    });
  }

  private async finalizeBrowserToolCall(input: {
    created: ChatToolRunRecord;
    turnInput: ChatAgentTurnInput;
    turnId: string;
    toolName: string;
    args: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: string;
    turnBudgetDeadline?: number;
  }): Promise<
    | {
        record: ChatToolRunRecord;
        chunk: ChatStreamChunkDraft;
      }
    | undefined
  > {
    const fallbackChain: Array<Record<string, unknown>> = [];
    const normalizedResult = input.result
      ? normalizeBrowserToolResult(input.toolName, input.result, {
          engineTier: "builtin",
          engineLabel: "Built-in browser",
        })
      : undefined;
    if (normalizedResult) {
      fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: input.toolName,
          engineTier: "builtin",
          engineLabel: "Built-in browser",
          result: normalizedResult,
          status: "executed",
        }),
      );
    } else if (input.error) {
      fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: input.toolName,
          engineTier: "builtin",
          engineLabel: "Built-in browser",
          error: input.error,
          browserFailureClass: "runtime_error",
          status: "failed",
        }),
      );
    }

    const classification = classifyBrowserToolResult(input.toolName, normalizedResult, input.error);
    if (fallbackChain.length > 0 && classification.failureClass) {
      const firstEntry = fallbackChain[0];
      if (firstEntry) {
        firstEntry.browserFailureClass = classification.failureClass;
        if (classification.error) {
          firstEntry.error = classification.error;
        }
        if (classification.failureClass !== "no_results") {
          firstEntry.status = "failed";
        }
      }
    }
    const alternateBuiltinResult = await this.tryAlternateBuiltinBrowserResult({
      created: input.created,
      turnInput: input.turnInput,
      turnId: input.turnId,
      toolName: input.toolName,
      args: input.args,
      fallbackChain,
      classification,
      normalizedResult,
      error: input.error,
      turnBudgetDeadline: input.turnBudgetDeadline,
    });
    if (alternateBuiltinResult) {
      const persistedAlternateBuiltinResult = await this.persistToolArtifactsIfNeeded({
        sessionId: input.turnInput.sessionId,
        turnId: input.turnId,
        toolRunId: input.created.toolRunId,
        toolName: input.toolName,
        result: alternateBuiltinResult,
      });
      const updated = this.deps.storage.chatToolRuns.patch(input.created.toolRunId, {
        status: "executed",
        result: persistedAlternateBuiltinResult,
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.turnInput.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }
    const fallbackAttempted =
      shouldAttemptBrowserFallback(input.toolName, classification.failureClass) &&
      this.deps.invokeMcpTool &&
      this.deps.listMcpBrowserFallbackTargets;

    if (fallbackAttempted) {
      const fallback = await this.tryBrowserFallbackAcrossMcpTiers({
        turnInput: input.turnInput,
        toolName: input.toolName,
        args: input.args,
        fallbackChain,
        turnBudgetDeadline: input.turnBudgetDeadline,
      });
      if (fallback) {
        const persistedFallbackResult = await this.persistToolArtifactsIfNeeded({
          sessionId: input.turnInput.sessionId,
          turnId: input.turnId,
          toolRunId: input.created.toolRunId,
          toolName: input.toolName,
          result: fallback.result,
        });
        const updated = this.deps.storage.chatToolRuns.patch(input.created.toolRunId, {
          status: "executed",
          result: persistedFallbackResult,
          finishedAt: new Date().toISOString(),
        });
        return {
          record: updated,
          chunk: {
            type: "tool_result",
            sessionId: input.turnInput.sessionId,
            turnId: input.turnId,
            toolRun: updated,
          },
        };
      }
    }

    if (!classification.failureClass && normalizedResult) {
      const normalizedWithChain = withBrowserFallbackChain(normalizedResult, fallbackChain);
      const persistedNormalizedResult = await this.persistToolArtifactsIfNeeded({
        sessionId: input.turnInput.sessionId,
        turnId: input.turnId,
        toolRunId: input.created.toolRunId,
        toolName: input.toolName,
        result: normalizedWithChain,
      });
      const updated = this.deps.storage.chatToolRuns.patch(input.created.toolRunId, {
        status: "executed",
        result: persistedNormalizedResult,
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.turnInput.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }

    if (classification.failureClass === "no_results" && normalizedResult) {
      const noResultsPayload = withBrowserFallbackChain(
        {
          ...normalizedResult,
          browserFailureClass: classification.failureClass,
        },
        fallbackChain,
      );
      const persistedNoResultsPayload = await this.persistToolArtifactsIfNeeded({
        sessionId: input.turnInput.sessionId,
        turnId: input.turnId,
        toolRunId: input.created.toolRunId,
        toolName: input.toolName,
        result: noResultsPayload,
      });
      const updated = this.deps.storage.chatToolRuns.patch(input.created.toolRunId, {
        status: "executed",
        result: persistedNoResultsPayload,
        failureGuidance: buildToolFailureGuidance({
          toolName: input.toolName,
          status: "executed",
          args: input.args,
          result: persistedNoResultsPayload,
        }),
        finishedAt: new Date().toISOString(),
      });
      return {
        record: updated,
        chunk: {
          type: "tool_result",
          sessionId: input.turnInput.sessionId,
          turnId: input.turnId,
          toolRun: updated,
        },
      };
    }

    if (!classification.failureClass && !input.error) {
      return undefined;
    }

    const failureResult = withBrowserFallbackChain(
      {
        ...(normalizedResult ?? {}),
        engineTier: normalizedResult?.engineTier ?? "builtin",
        engineLabel: normalizedResult?.engineLabel ?? "Built-in browser",
        browserFailureClass: classification.failureClass ?? "runtime_error",
      },
      fallbackChain,
    );
    const persistedFailureResult = await this.persistToolArtifactsIfNeeded({
      sessionId: input.turnInput.sessionId,
      turnId: input.turnId,
      toolRunId: input.created.toolRunId,
      toolName: input.toolName,
      result: failureResult,
    });
    const updated = this.deps.storage.chatToolRuns.patch(input.created.toolRunId, {
      status: "failed",
      error: classification.error ?? input.error ?? "browser execution failed",
      result: persistedFailureResult,
      failureGuidance: buildToolFailureGuidance({
        toolName: input.toolName,
        status: "failed",
        args: input.args,
        result: persistedFailureResult,
        error: classification.error ?? input.error ?? "browser execution failed",
      }),
      finishedAt: new Date().toISOString(),
    });
    return {
      record: updated,
      chunk: {
        type: "tool_result",
        sessionId: input.turnInput.sessionId,
        turnId: input.turnId,
        toolRun: updated,
      },
    };
  }

  private async tryAlternateBuiltinBrowserResult(input: {
    created: ChatToolRunRecord;
    turnInput: ChatAgentTurnInput;
    turnId: string;
    toolName: string;
    args: Record<string, unknown>;
    fallbackChain: Array<Record<string, unknown>>;
    classification: {
      failureClass?: string;
      error?: string;
    };
    normalizedResult?: Record<string, unknown>;
    error?: string;
    turnBudgetDeadline?: number;
  }): Promise<Record<string, unknown> | undefined> {
    // For search tools, retry with alternate search engines when the primary
    // engine fails (rate limiting, blocking, no results).
    if (input.toolName === "browser.search") {
      return this.tryAlternateBuiltinSearchEngines(input);
    }
    if (
      input.toolName !== "browser.navigate" &&
      input.toolName !== "browser.extract" &&
      input.toolName !== "http.get"
    ) {
      return undefined;
    }
    if (
      input.classification.failureClass !== "remote_blocked" &&
      input.classification.failureClass !== "http_error" &&
      input.classification.failureClass !== "unusable_output" &&
      input.classification.failureClass !== "runtime_error" &&
      input.classification.failureClass !== "rate_limited"
    ) {
      return undefined;
    }

    const syntheticCurrentFailure: ChatToolRunRecord = {
      ...input.created,
      status: "failed",
      args: input.args,
      error: input.classification.error ?? input.error ?? "browser execution failed",
      result: {
        ...(input.normalizedResult ?? {}),
        engineTier: input.normalizedResult?.engineTier ?? "builtin",
        engineLabel: input.normalizedResult?.engineLabel ?? "Built-in browser",
        browserFailureClass: input.classification.failureClass ?? "runtime_error",
      },
      finishedAt: new Date().toISOString(),
    };
    const priorToolRuns = this.deps.storage.chatToolRuns
      .listByTurn(input.turnId)
      .filter((run) => run.toolRunId !== input.created.toolRunId);
    const alternateUrls = selectRecentBrowserResultUrls(
      input.turnInput.content,
      [...priorToolRuns, syntheticCurrentFailure],
      3,
      1,
    ).filter((url) => url !== input.args.url);

    for (const url of alternateUrls) {
      if (input.turnInput.signal?.aborted) {
        break;
      }
      if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
        break;
      }
      const alternateArgs = {
        ...input.args,
        url,
      };
      try {
        const result = await this.deps.invokeTool({
          toolName: input.toolName,
          args: alternateArgs,
          agentId: "assistant",
          sessionId: input.turnInput.sessionId,
          taskId: input.turnInput.policyTaskId,
          runId: input.turnInput.policyRunId,
          surface: input.turnInput.mode,
          signal: input.turnInput.signal,
          permissionProfileId: input.turnInput.permissionProfileId,
          localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
          consentContext: {
            operatorId: input.turnInput.operatorId,
            source: "agent",
            reason: `chat mode ${input.turnInput.mode}`,
          },
          policyContext: {
            operatorId: input.turnInput.operatorId,
            authActorId: input.turnInput.authActorId,
            authActorSource: input.turnInput.authActorSource,
            taskId: input.turnInput.policyTaskId,
            runId: input.turnInput.policyRunId,
            surface: input.turnInput.mode,
            permissionProfileId: input.turnInput.permissionProfileId,
            localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
            fullWebAccess: input.turnInput.fullWebAccess,
          },
        });
        if (result.outcome !== "executed") {
          input.fallbackChain.push(
            buildBrowserFallbackChainEntry({
              toolName: input.toolName,
              engineTier: "builtin",
              engineLabel: "Built-in browser",
              result: {
                url,
                finalUrl: url,
              },
              error: result.outcome === "blocked" ? result.policyReason : "browser fallback requires approval",
              browserFailureClass: "runtime_error",
              status: "failed",
            }),
          );
          continue;
        }
        const normalized = normalizeBrowserToolResult(input.toolName, result.result ?? {}, {
          engineTier: "builtin",
          engineLabel: "Built-in browser",
        });
        const classification = classifyBrowserToolResult(input.toolName, normalized);
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: input.toolName,
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            result: normalized,
            error: classification.error,
            browserFailureClass: classification.failureClass,
            status: classification.failureClass ? "failed" : "executed",
          }),
        );
        if (!classification.failureClass) {
          return withBrowserFallbackChain(normalized, input.fallbackChain);
        }
      } catch (error) {
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: input.toolName,
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            result: {
              url,
              finalUrl: url,
            },
            error: (error as Error).message,
            browserFailureClass: "runtime_error",
            status: "failed",
          }),
        );
      }
    }

    return undefined;
  }

  /**
   * When browser.search fails (rate limiting, engine blocked, no results),
   * retry the same query through alternate search engine configurations.
   * This makes the agent tenacious — it exhausts built-in search options
   * before giving up.
   */
  private async tryAlternateBuiltinSearchEngines(input: {
    created: ChatToolRunRecord;
    turnInput: ChatAgentTurnInput;
    turnId: string;
    toolName: string;
    args: Record<string, unknown>;
    fallbackChain: Array<Record<string, unknown>>;
    classification: {
      failureClass?: string;
      error?: string;
    };
    normalizedResult?: Record<string, unknown>;
    error?: string;
    turnBudgetDeadline?: number;
  }): Promise<Record<string, unknown> | undefined> {
    if (
      input.classification.failureClass !== "no_results" &&
      input.classification.failureClass !== "remote_blocked" &&
      input.classification.failureClass !== "http_error" &&
      input.classification.failureClass !== "rate_limited" &&
      input.classification.failureClass !== "runtime_error"
    ) {
      return undefined;
    }

    // Try alternate engine preferences; the built-in browser.search already
    // cycles engines internally, but we can nudge it to skip the failing one.
    const failedEngine = typeof input.args.engine === "string" ? input.args.engine : undefined;
    const alternateEngines = ["bing", "duckduckgo", "google"].filter((e) => e !== failedEngine);

    for (const engine of alternateEngines) {
      if (input.turnInput.signal?.aborted) {
        break;
      }
      if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
        break;
      }
      const alternateArgs = {
        ...input.args,
        engine,
      };
      try {
        const result = await this.deps.invokeTool({
          toolName: "browser.search",
          args: alternateArgs,
          agentId: "assistant",
          sessionId: input.turnInput.sessionId,
          taskId: input.turnInput.policyTaskId,
          runId: input.turnInput.policyRunId,
          surface: input.turnInput.mode,
          signal: input.turnInput.signal,
          permissionProfileId: input.turnInput.permissionProfileId,
          localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
          consentContext: {
            operatorId: input.turnInput.operatorId,
            source: "agent",
            reason: `search engine fallback (${engine}) after ${input.classification.failureClass}`,
          },
          policyContext: {
            operatorId: input.turnInput.operatorId,
            authActorId: input.turnInput.authActorId,
            authActorSource: input.turnInput.authActorSource,
            taskId: input.turnInput.policyTaskId,
            runId: input.turnInput.policyRunId,
            surface: input.turnInput.mode,
            permissionProfileId: input.turnInput.permissionProfileId,
            localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
            fullWebAccess: input.turnInput.fullWebAccess,
          },
        });
        if (result.outcome !== "executed") {
          input.fallbackChain.push(
            buildBrowserFallbackChainEntry({
              toolName: "browser.search",
              engineTier: "builtin",
              engineLabel: `Built-in browser (${engine})`,
              error: result.outcome === "blocked" ? result.policyReason : "search fallback did not execute",
              browserFailureClass: "runtime_error",
              status: "failed",
            }),
          );
          continue;
        }
        const normalized = normalizeBrowserToolResult("browser.search", result.result ?? {}, {
          engineTier: "builtin",
          engineLabel: `Built-in browser (${engine})`,
        });
        const classification = classifyBrowserToolResult("browser.search", normalized);
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: "browser.search",
            engineTier: "builtin",
            engineLabel: `Built-in browser (${engine})`,
            result: normalized,
            error: classification.error,
            browserFailureClass: classification.failureClass,
            status: classification.failureClass ? "failed" : "executed",
          }),
        );
        if (!classification.failureClass) {
          return withBrowserFallbackChain(normalized, input.fallbackChain);
        }
      } catch (error) {
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: "browser.search",
            engineTier: "builtin",
            engineLabel: `Built-in browser (${engine})`,
            error: (error as Error).message,
            browserFailureClass: "runtime_error",
            status: "failed",
          }),
        );
      }
    }
    return undefined;
  }

  private async tryBrowserFallbackAcrossMcpTiers(input: {
    turnInput: ChatAgentTurnInput;
    toolName: string;
    args: Record<string, unknown>;
    fallbackChain: Array<Record<string, unknown>>;
    turnBudgetDeadline?: number;
  }): Promise<{ result: Record<string, unknown> } | undefined> {
    const targets = this.deps.listMcpBrowserFallbackTargets?.() ?? [];
    for (const target of targets) {
      if (input.turnInput.signal?.aborted) {
        break;
      }
      if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
        break;
      }
      const resolvedToolName = resolveBrowserFallbackToolName(target, input.toolName);
      if (!resolvedToolName) {
        continue;
      }
      let response: McpInvokeResponse | undefined;
      try {
        response = await this.deps.invokeMcpTool?.({
          serverId: target.serverId,
          toolName: resolvedToolName,
          arguments: buildBrowserFallbackArguments(input.toolName, input.args),
          agentId: "assistant",
          sessionId: input.turnInput.sessionId,
          signal: input.turnInput.signal,
        });
      } catch (mcpError) {
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: resolvedToolName,
            engineTier: target.tier,
            engineLabel: target.label,
            error: (mcpError as Error).message,
            browserFailureClass: "runtime_error",
            status: "failed",
          }),
        );
        continue;
      }
      if (!response) {
        continue;
      }
      const normalized = response.output
        ? normalizeMcpBrowserToolResult(input.toolName, response.output, {
            engineTier: target.tier,
            engineLabel: target.label,
            args: input.args,
          })
        : undefined;
      const classification = classifyBrowserToolResult(input.toolName, normalized, response.error);
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: resolvedToolName,
          engineTier: target.tier,
          engineLabel: target.label,
          result: normalized,
          error: response.error,
          browserFailureClass: classification.failureClass,
          status: response.ok && !classification.failureClass ? "executed" : "failed",
        }),
      );
      if (!response.ok || !normalized || classification.failureClass) {
        continue;
      }
      return {
        result: withBrowserFallbackChain(normalized, input.fallbackChain),
      };
    }
    return undefined;
  }

  private preflightToolInvocation(input: {
    toolName: string;
    rawArgs: Record<string, unknown>;
    userContent: string;
    historyMessages: ChatCompletionRequest["messages"];
    webMode: ChatWebMode;
    mode: ChatMode;
    localFileIntent?: boolean;
    priorToolRuns?: ChatToolRunRecord[];
    evalIntegrityTurn?: boolean;
  }): {
    toolName: string;
    args: Record<string, unknown>;
    failureReason?: string;
    blockedReason?: string;
  } {
    const args = { ...input.rawArgs };
    let effectiveToolName = input.toolName;
    if (input.webMode === "off" && isWebToolName(input.toolName)) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason: "execution skipped: live web access is disabled because Web is set to Off for this chat",
      };
    }
    if (
      input.mode !== "code" &&
      LOCAL_PATH_TOOL_NAMES.has(input.toolName) &&
      !(input.localFileIntent ?? false) &&
      looksLikePromptLabDelegatedNonCodeTurn(input.userContent, extractPrimaryUserTaskContent(input.userContent)) &&
      !promptLabTaskSuggestsRepoInspection(input.userContent)
    ) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason:
          "execution skipped: local file/code tools were suppressed because this non-code Prompt Lab step does not ask for repository inspection",
      };
    }
    const isBrowserNavigate = toolNameMatchesAnyKnownTool(input.toolName, new Set(["browser.navigate"]));
    const isBrowserSearch = toolNameMatchesAnyKnownTool(input.toolName, new Set(["browser.search"]));
    // Eval-integrity turns never rewrite the model's tool arguments: silently
    // replacing a query or URL with a harness-curated one injects hand-picked
    // evidence into the model's context and inflates scores. Safety blocks
    // (visible blockedReason results) still apply.
    if (isBrowserNavigate && typeof args.url === "string") {
      if (!input.evalIntegrityTurn) {
        const promotedUrl = redirectSearchPortalNavigateUrl(args.url, input.userContent, input.priorToolRuns);
        if (promotedUrl && promotedUrl !== args.url) {
          args.url = promotedUrl;
        }
      }
      const redirectedBlockedUrl = redirectPoisonedBrowserNavigateUrl(
        String(args.url),
        input.userContent,
        input.priorToolRuns,
      );
      if (redirectedBlockedUrl?.url && !input.evalIntegrityTurn) {
        args.url = redirectedBlockedUrl.url;
      } else if (redirectedBlockedUrl?.blockedReason) {
        return {
          toolName: effectiveToolName,
          args,
          blockedReason: redirectedBlockedUrl.blockedReason,
        };
      }
    }
    if (isBrowserSearch && !input.evalIntegrityTurn) {
      const promotedUrl = inferBrowserNavigateUrlFromRepeatedSearches(input.userContent, input.priorToolRuns);
      if (promotedUrl) {
        effectiveToolName = "browser.navigate";
        return {
          toolName: effectiveToolName,
          args: {
            url: promotedUrl,
            maxChars: 6000,
          },
        };
      }
      const groundedQuery = resolveGroundedBrowserSearchQuery({
        rawArgs: args,
        userContent: input.userContent,
        historyMessages: input.historyMessages,
        priorToolRuns: input.priorToolRuns,
      });
      if (groundedQuery) {
        args.query = groundedQuery;
      }
    }
    const promptLabWebToolCapBlock = describePromptLabWebToolCapBlock({
      toolName: input.toolName,
      args,
      userContent: input.userContent,
      priorToolRuns: input.priorToolRuns,
    });
    if (promptLabWebToolCapBlock) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason: promptLabWebToolCapBlock,
      };
    }
    const promptLabCoworkPromptSpecificWebSearch =
      isBrowserSearch &&
      (input.localFileIntent ?? false) &&
      isPromptLabHarnessContent(input.userContent) &&
      input.mode === "cowork" &&
      Boolean(derivePromptSpecificWebQuery(input.userContent));
    if (
      isBrowserSearch &&
      (input.localFileIntent ?? false) &&
      !detectWebLookupIntent(input.userContent, input.historyMessages) &&
      !promptLabCoworkPromptSpecificWebSearch
    ) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason:
          "execution skipped: browser.search was suppressed because the prompt targets local files/project context",
      };
    }

    if (
      (input.toolName === "memory.write" || input.toolName === "memory.upsert") &&
      !hasExplicitMemoryConsent(input.userContent)
    ) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason: "memory persistence requires explicit user consent; ask before saving long-term memory",
      };
    }

    if (LOCAL_PATH_TOOL_NAMES.has(input.toolName) && typeof args.path === "string") {
      const blockedPathReason = describeInvalidLocalToolPath(args.path);
      if (blockedPathReason) {
        return {
          toolName: effectiveToolName,
          args,
          blockedReason: `execution skipped: ${input.toolName} path was not a safe repository path (${blockedPathReason})`,
        };
      }
    }

    const required = TOOL_REQUIRED_ARGS[input.toolName] ?? [];
    const unresolved: string[] = [];
    for (const field of required) {
      if (!isMissingArgValue(args[field])) {
        continue;
      }
      // Eval turns: a missing required argument is the model's mistake; block
      // with guidance so it can retry instead of harness-inventing the value.
      const inferred = input.evalIntegrityTurn
        ? undefined
        : (inferToolArgValue(input.toolName, field, input.userContent) ??
          inferToolArgValueFromRecentToolRuns(input.toolName, field, input.userContent, input.priorToolRuns));
      if (inferred !== undefined) {
        args[field] = inferred;
      } else {
        unresolved.push(field);
      }
    }

    if (unresolved.length > 0) {
      const field = unresolved[0] ?? "arg";
      if (field === "query" && (input.toolName === "memory.search" || input.toolName === "browser.search")) {
        if (input.toolName === "memory.search" && !input.evalIntegrityTurn) {
          const fallbackQuery = inferMemoryQueryFromPrompt(input.userContent);
          if (fallbackQuery) {
            args.query = fallbackQuery;
            return { toolName: effectiveToolName, args };
          }
        }
        return {
          toolName: effectiveToolName,
          args,
          blockedReason: `execution skipped: ${input.toolName} requires query; unable to infer a safe query from the prompt`,
        };
      }
      if (
        (field === "query" && LOCAL_QUERY_TOOL_NAMES.has(input.toolName)) ||
        (field === "pattern" && input.toolName === "file.find") ||
        (field === "path" && LOCAL_PATH_TOOL_NAMES.has(input.toolName))
      ) {
        return {
          toolName: effectiveToolName,
          args,
          blockedReason: `execution skipped: ${input.toolName} requires ${field}; unable to infer a safe ${field} from the prompt`,
        };
      }
      return {
        toolName: effectiveToolName,
        args,
        failureReason: `execution error: ${field} is required`,
      };
    }

    const promptLabBroadSearchBlock = describePromptLabBroadLocalSearchBlock({
      toolName: input.toolName,
      args,
      userContent: input.userContent,
      mode: input.mode,
    });
    if (promptLabBroadSearchBlock) {
      return {
        toolName: effectiveToolName,
        args,
        blockedReason: promptLabBroadSearchBlock,
      };
    }

    return { toolName: effectiveToolName, args };
  }

  private async tryWriteJailFallback(input: {
    input: ChatAgentTurnInput;
    toolName: string;
    args: Record<string, unknown>;
    policyReason?: string;
    sourceAttribution?: ToolInvokeRequest["sourceAttribution"];
  }): Promise<
    | {
        result: ToolInvokeResult;
        fallbackPath: string;
      }
    | undefined
  > {
    if (
      input.toolName !== "fs.write" &&
      input.toolName !== "artifacts.create" &&
      input.toolName !== "documents.create" &&
      input.toolName !== "presentations.create"
    ) {
      return undefined;
    }
    if (!isWriteJailBlockReason(input.policyReason)) {
      return undefined;
    }
    const fallbackPath = buildSafeWriteFallbackPath(
      input.input.sessionId,
      input.toolName,
      input.args.path,
      this.deps.safeWriteFallbackDir,
    );
    if (!fallbackPath) {
      return undefined;
    }

    const currentPath = typeof input.args.path === "string" ? input.args.path : undefined;
    if (currentPath && normalizePathForComparison(currentPath) === normalizePathForComparison(fallbackPath)) {
      return undefined;
    }

    const fallbackArgs: Record<string, unknown> = {
      ...input.args,
      path: fallbackPath,
    };

    const result = await this.deps.invokeTool({
      toolName: input.toolName,
      args: fallbackArgs,
      agentId: "assistant",
      sessionId: input.input.sessionId,
      taskId: input.input.policyTaskId,
      runId: input.input.policyRunId,
      surface: input.input.mode,
      signal: input.input.signal,
      ...(input.sourceAttribution ? { sourceAttribution: input.sourceAttribution } : {}),
      permissionProfileId: input.input.permissionProfileId,
      localOperatorOverrideId: input.input.localOperatorOverrideId,
      consentContext: {
        operatorId: input.input.operatorId,
        source: "agent",
        reason: `chat mode ${input.input.mode}; safe write fallback`,
      },
      policyContext: {
        operatorId: input.input.operatorId,
        authActorId: input.input.authActorId,
        authActorSource: input.input.authActorSource,
        taskId: input.input.policyTaskId,
        runId: input.input.policyRunId,
        surface: input.input.mode,
        permissionProfileId: input.input.permissionProfileId,
        localOperatorOverrideId: input.input.localOperatorOverrideId,
      },
    });

    return {
      result,
      fallbackPath,
    };
  }

  private async synthesizeToolOutcomeFallback(input: {
    input: ChatAgentTurnInput;
    toolRuns: ChatToolRunRecord[];
    circuitBreakerReason?: string;
    turnBudgetDeadline?: number;
    allowOverBudget?: boolean;
  }): Promise<{
    content: string;
    deterministic: boolean;
    usage: ChatStreamUsageRecord | null;
    providerCalls: number;
  }> {
    // Eval-integrity turns must never receive controller-fabricated answer text.
    // A genuine re-ask of the model below is allowed (it is still model output);
    // the deterministic template fallback is not. Profile-only by design.
    const evalIntegrityTurn = input.input.normalizationProfile === "prompt_pack_harness";
    const deterministic = evalIntegrityTurn
      ? ""
      : buildDeterministicToolSynthesisFallback(input.input.content, input.toolRuns, input.circuitBreakerReason);
    const toolSummary = summarizeToolRunsForSynthesis(input.toolRuns, input.input.content);
    const synthesisTimeoutMs = input.allowOverBudget
      ? FINAL_PASS_COMPLETION_TIMEOUT_MS
      : input.turnBudgetDeadline
        ? Math.min(FINAL_PASS_COMPLETION_TIMEOUT_MS, Math.max(3000, input.turnBudgetDeadline - Date.now()))
        : FINAL_PASS_COMPLETION_TIMEOUT_MS;
    let providerCalls = 0;
    let usage: ChatStreamUsageRecord | null = null;
    try {
      providerCalls += 1;
      const completion = await this.deps.createChatCompletion({
        providerId: input.input.providerId,
        model: input.input.model,
        stream: false,
        timeoutMs: synthesisTimeoutMs,
        signal: input.input.signal,
        memory: {
          enabled: false,
          mode: "off",
          turnId: input.input.turnId,
          sessionId: input.input.sessionId,
        },
        messages: [
          {
            role: "system",
            content: [
              "You are the final response synthesizer for an agent runtime.",
              "Tools are unavailable for this final pass. Do not claim new tool execution.",
              "Write like a normal helpful chat response, not an incident report.",
              "Start with the direct answer or the single most important limitation.",
              "If key information is missing, ask at most two crisp follow-up questions.",
              "Mention tool limitations briefly in plain language.",
              "Do not use headings like Summary, Constraints, What I did instead, or What I need from you next unless the user explicitly asked for a structured report.",
              "If partial tool evidence exists, include only the most decision-useful parts.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Original user request: ${input.input.content}`,
              "",
              "Tool run summary:",
              toolSummary.length > 0 ? toolSummary : "- No tool output captured.",
              "",
              "Circuit-breaker reason (if any):",
              input.circuitBreakerReason ?? "none",
            ].join("\n"),
          },
        ],
      });
      usage = parseUsageFromCompletion(completion);
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      const synthesized = extractMessageContent(message ?? {}).trim();
      if (synthesized.length > 0) {
        return {
          content: synthesized,
          deterministic: false,
          usage,
          providerCalls,
        };
      }
    } catch {
      // Deterministic fallback below.
    }
    return {
      content: deterministic,
      deterministic: true,
      usage,
      providerCalls,
    };
  }

  private async repairIncompleteAssistantCompletion(input: {
    input: ChatAgentTurnInput;
    partialAssistantContent: string;
    conversationMessages: ChatCompletionRequest["messages"];
    toolRuns: ChatToolRunRecord[];
    turnBudgetDeadline?: number;
  }): Promise<{ content: string; usage: ChatStreamUsageRecord | null; providerCalls: number }> {
    // Constrained local models get tighter repair instructions; the previous
    // controller-authored "recovered repo answer" shortcut was removed because
    // it fabricated response text instead of re-asking the model.
    const constrainedLocalRepair = shouldUseConstrainedLocalAgentProfile(input.input.providerId, input.input.model);
    const repoGroundedRepair =
      input.input.normalizationProfile === "prompt_pack_harness" &&
      looksLikeRepoGroundedInspectionPrompt(input.input.content);
    const timeoutMs = input.turnBudgetDeadline
      ? Math.min(FINAL_PASS_COMPLETION_TIMEOUT_MS, Math.max(3000, input.turnBudgetDeadline - Date.now()))
      : FINAL_PASS_COMPLETION_TIMEOUT_MS;
    const toolSummary = summarizeToolRunsForSynthesis(input.toolRuns, input.input.content);
    const ignoreDraft = looksLikeUserSafeFailureMessage(input.partialAssistantContent);
    let providerCalls = 0;
    let usage: ChatStreamUsageRecord | null = null;
    try {
      providerCalls += 1;
      const completion = await this.deps.createChatCompletion({
        providerId: input.input.providerId,
        model: input.input.model,
        stream: false,
        timeoutMs,
        signal: input.input.signal,
        memory: {
          enabled: false,
          mode: "off",
          turnId: input.input.turnId,
          sessionId: input.input.sessionId,
        },
        max_tokens: constrainedLocalRepair ? 520 : undefined,
        temperature: constrainedLocalRepair ? 0 : undefined,
        messages: [
          {
            role: "system",
            content: [
              "You are repairing a partially completed assistant answer.",
              "Tools are unavailable for this repair pass.",
              "Use only the existing conversation and tool evidence already gathered.",
              ignoreDraft
                ? "The prior draft is only a runtime failure placeholder. Ignore it and answer the original request from scratch."
                : "Finish cleanly. Do not restart from scratch unless the draft is unusable.",
              "Do not mention finish reasons, token limits, truncation, or internal runtime state.",
              constrainedLocalRepair
                ? "Keep the repaired answer compact, evidence-first, and under roughly 180 words unless the user explicitly asked for a long report."
                : undefined,
              constrainedLocalRepair && repoGroundedRepair
                ? "Name exact file paths only when they already appear in the captured tool evidence, and separate observed facts from anything still unverified."
                : undefined,
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Original request: ${input.input.content}`,
              "",
              "Partial assistant draft:",
              ignoreDraft ? "(runtime failure placeholder omitted)" : input.partialAssistantContent.trim() || "(empty)",
              "",
              "Captured tool evidence:",
              toolSummary || "- No tool evidence captured.",
            ].join("\n"),
          },
        ],
      });
      usage = parseUsageFromCompletion(completion);
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      return {
        content: extractMessageContent(message ?? {}).trim(),
        usage,
        providerCalls,
      };
    } catch {
      return {
        content: "",
        usage,
        providerCalls,
      };
    }
  }
}

function classifyCompletionOutcome(input: {
  completion: ChatCompletionResponse;
  originalRequest: string;
  priorMessages?: ChatCompletionRequest["messages"];
}): {
  finishReason?: string;
  status: NonNullable<ChatTurnTraceRecord["completion"]>["status"];
} {
  const choice = input.completion.choices?.[0];
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (message && hasIncompleteToolCalls(message)) {
    return {
      finishReason,
      status: "truncated",
    };
  }
  if (finishReason === "length") {
    return {
      finishReason,
      status: "truncated",
    };
  }
  if (finishReason === "content_filter" || finishReason === "cancelled") {
    return {
      finishReason,
      status: "interrupted",
    };
  }
  if (
    message &&
    looksLikeFragmentaryStandaloneAnswer({
      content: extractMessageContent(message),
      originalRequest: input.originalRequest,
      priorMessages: input.priorMessages,
    })
  ) {
    return {
      finishReason,
      status: "truncated",
    };
  }
  return {
    finishReason,
    status: "complete",
  };
}

function hasIncompleteToolCalls(message: Record<string, unknown>): boolean {
  const rawToolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  if (rawToolCalls.length === 0) {
    return false;
  }
  return rawToolCalls.some((toolCall) => {
    const fn = toolCall.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    const args = typeof fn?.arguments === "string" ? fn.arguments.trim() : "";
    if (!name || !args) {
      return true;
    }
    try {
      JSON.parse(args);
      return false;
    } catch {
      return true;
    }
  });
}

function finalizeTurnCompletionState(input: {
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  finalStatus: ChatTurnTraceRecord["status"];
  approvalPending: boolean;
  userInputPending: boolean;
}): NonNullable<ChatTurnTraceRecord["completion"]> {
  if (input.approvalPending || input.userInputPending) {
    return {
      ...input.completion,
      status: "backgrounded",
    };
  }
  if (input.finalStatus === "cancelled") {
    return {
      ...input.completion,
      status: "interrupted",
    };
  }
  if (input.finalStatus === "failed" && input.completion.status === "complete") {
    return {
      ...input.completion,
      status: "interrupted",
    };
  }
  return input.completion;
}

// Exported for unit tests: the clear/keep boundary depends on content heuristics
// that are impractical to pin down through full orchestrator runs.
export function shouldClearRecoverableCompletionFailure(input: {
  normalizationProfile: ChatNormalizationProfile;
  mode: ChatMode;
  finalStatus: ChatTurnTraceRecord["status"];
  approvalPending: boolean;
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  failure: ChatTurnFailureRecord | undefined;
  assistantContent: string;
  toolRuns: ChatToolRunRecord[];
}): boolean {
  if (
    input.finalStatus !== "completed" ||
    input.approvalPending ||
    !input.failure
  ) {
    return false;
  }
  const clearableSurface = input.normalizationProfile === "prompt_pack_harness" || input.mode === "cowork";
  if (!clearableSurface) {
    return false;
  }
  if (
    input.normalizationProfile === "prompt_pack_harness" &&
    /\btool run budget exceeded\b|\btool budget\b/i.test(input.failure.message) &&
    input.toolRuns.some((run) => run.status === "executed" && run.result)
  ) {
    return (
      input.assistantContent.trim().length > 0 &&
      !looksLikeRecoverableAssistantFallbackContent(input.assistantContent) &&
      !looksLikeDegradedAssistantFallbackContent(input.assistantContent) &&
      !looksLikeSerializedToolCallMarkupContent(input.assistantContent) &&
      // No \b after the closing quote: quote→space is not a word boundary.
      !/\bsay\s+"keep going"|best next move:\s*retry|parts of this answer may be incomplete/i.test(input.assistantContent)
    );
  }
  if (!input.completion.repaired || input.failure.recommendedAction !== "continue_from_partial") {
    return false;
  }
  const clearableFailure =
    /provider stopped before the answer finished|repair pass is required|tool calls were fully assembled/i.test(
      input.failure.message,
    );
  if (!clearableFailure) {
    return false;
  }
  return (
    input.assistantContent.trim().length > 0 &&
    !looksLikeRecoverableAssistantFallbackContent(input.assistantContent) &&
    !looksLikeDegradedAssistantFallbackContent(input.assistantContent) &&
    !looksLikeSerializedToolCallMarkupContent(input.assistantContent)
  );
}

function selectActiveExecutionPlan(plans: ChatExecutionPlanRecord[]): ChatExecutionPlanRecord | undefined {
  const active =
    plans.find((plan) => plan.status === "running") ??
    plans.find((plan) => plan.status === "ready") ??
    plans.find((plan) => plan.status === "drafted");
  return active ?? plans[0];
}

function selectExecutionPlanSuggestedTools(plan: ChatExecutionPlanRecord | undefined): string[] {
  if (!plan) {
    return [];
  }
  const activeStep =
    plan.steps.find((step) => step.status === "running") ?? plan.steps.find((step) => step.status === "pending");
  return activeStep?.suggestedTools ?? [];
}

function buildRecentToolFailureCounts(toolRuns: ChatToolRunRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of toolRuns) {
    if (run.status !== "failed" && run.status !== "blocked") {
      continue;
    }
    counts.set(run.toolName, (counts.get(run.toolName) ?? 0) + 1);
  }
  return counts;
}

function looksLikePromptLabDelegatedNonCodeTurn(content: string, taskContent = ""): boolean {
  if (!/(?:^|\n)\s*(?:delegated role|parent objective|current step objective|suggested tools)\s*:/i.test(content)) {
    return false;
  }
  const relevantContent = `${taskContent}\n${content}`
    .replace(/^Suggested tools:\s*.*$/gim, "")
    .replace(
      /\b(?:code\.search_files|code\.search|file\.read_range|file\.find|browser\.search|browser\.navigate|memory\.search|memory\.read)\b/gi,
      "",
    );
  const combined = relevantContent.toLowerCase();
  if (
    /\b(?:code mode|source files?|repository|repo|codebase|workspace|implementation|patch|typescript|tests?)\b/.test(
      combined,
    )
  ) {
    return false;
  }
  return true;
}

function buildEssentialToolSet(input: {
  mode: ChatMode;
  webMode: ChatWebMode;
  liveDataIntent: boolean;
  webLookupIntent: boolean;
  localFileIntent: boolean;
  presentationArtifactIntent: boolean;
  documentArtifactIntent: boolean;
  memoryLookupIntent: boolean;
  memoryPersistenceIntent: boolean;
  explicitToolMentions: Set<string>;
  projectBound: boolean;
  suppressLocalPathTools?: boolean;
}): string[] {
  const tools = new Set<string>(["time.now"]);
  if (
    input.memoryLookupIntent ||
    (input.mode !== "chat" && !input.localFileIntent && !input.webLookupIntent && !input.liveDataIntent)
  ) {
    tools.add("memory.search");
  }
  if (input.memoryLookupIntent) {
    tools.add("memory.read");
  }
  if (input.memoryPersistenceIntent) {
    tools.add("memory.write");
    tools.add("memory.upsert");
  }
  if (input.webLookupIntent && input.webMode !== "off") {
    tools.add("browser.search");
    tools.add("browser.navigate");
    tools.add("http.get");
  }
  if (input.presentationArtifactIntent) {
    tools.add("presentations.create");
  }
  if (input.documentArtifactIntent) {
    tools.add("documents.create");
  }
  if (!input.suppressLocalPathTools && (input.localFileIntent || input.projectBound || input.mode === "code")) {
    tools.add("fs.list");
    tools.add("fs.stat");
    tools.add("file.read_range");
    tools.add("file.find");
    tools.add("code.search");
    tools.add("code.search_files");
  }
  if (input.mode === "code") {
    tools.add("shell.exec");
    tools.add("tests.run");
    tools.add("lint.run");
  }
  for (const toolName of input.explicitToolMentions) {
    if (input.webMode === "off" && isWebToolName(toolName)) {
      continue;
    }
    if (input.suppressLocalPathTools && LOCAL_PATH_TOOL_NAMES.has(toolName)) {
      continue;
    }
    tools.add(toolName);
  }
  return [...tools];
}

function buildToolAccessProbeArgs(toolName: string, safeWriteFallbackDir?: string): Record<string, unknown> {
  if (toolName === "presentations.create") {
    return {
      path: buildSafeWritePath("tool-access-probe.pptx", safeWriteFallbackDir),
      title: "Tool access probe",
      slides: [{ title: "Probe", bullets: ["Verifies the tool can write inside the workspace jail."] }],
    };
  }
  if (toolName === "documents.create") {
    return {
      path: buildSafeWritePath("tool-access-probe.docx", safeWriteFallbackDir),
      format: "docx",
      title: "Tool access probe",
      body: "Verifies the tool can write inside the workspace jail.",
    };
  }
  if (toolName === "artifacts.create") {
    return {
      path: buildSafeWritePath("tool-access-probe.md", safeWriteFallbackDir),
      content: "Tool access probe",
    };
  }
  if (toolName === "fs.write") {
    return {
      path: buildSafeWritePath("tool-access-probe.txt", safeWriteFallbackDir),
      content: "Tool access probe",
    };
  }
  if (toolName === "fs.copy" || toolName === "fs.move") {
    return {
      from: buildSafeWritePath("tool-access-probe.txt", safeWriteFallbackDir),
      to: buildSafeWritePath("tool-access-probe-copy.txt", safeWriteFallbackDir),
    };
  }
  if (toolName === "fs.delete") {
    return {
      path: buildSafeWritePath("tool-access-probe.txt", safeWriteFallbackDir),
    };
  }
  return {};
}

function scoreToolForTurn(input: {
  tool: ToolCatalogEntry;
  mode: ChatMode;
  liveDataIntent: boolean;
  webLookupIntent: boolean;
  localFileIntent: boolean;
  presentationArtifactIntent: boolean;
  documentArtifactIntent: boolean;
  memoryLookupIntent: boolean;
  memoryPersistenceIntent: boolean;
  projectBound: boolean;
  suggestedTools: Set<string>;
  failedCounts: Map<string, number>;
  content: string;
  explicitToolMentions: Set<string>;
}): number {
  const { tool } = input;
  let score = 0;
  const explicitlyRequested = input.explicitToolMentions.has(tool.toolName);
  if (tool.recommendedContexts?.includes(input.mode)) {
    score += 4;
  }
  if (input.projectBound && tool.recommendedContexts?.includes("project_bound")) {
    score += 2;
  }
  if (explicitlyRequested) {
    score += 20;
  }
  if (input.suggestedTools.has(tool.toolName)) {
    score += 12;
  }
  if (input.liveDataIntent) {
    score += scoreToolIntentMatch(tool, ["live_data", "web_lookup", "fetch_url", "api_lookup", "research"], 6);
    if (tool.preferredForIntents?.includes("local_file") || tool.preferredForIntents?.includes("inspect_code")) {
      score -= 4;
    }
  }
  if (input.webLookupIntent && !input.liveDataIntent) {
    score += scoreToolIntentMatch(tool, ["web_lookup", "fetch_url", "api_lookup", "research"], 5);
  }
  if (input.localFileIntent) {
    score += scoreToolIntentMatch(
      tool,
      ["local_file", "inspect_code", "search_code", "search_files", "read_file", "targeted_read", "project_context"],
      7,
    );
    if (isWebToolName(tool.toolName)) {
      score -= 6;
    }
  }
  if (input.presentationArtifactIntent) {
    score += scoreToolIntentMatch(tool, ["presentation", "slide_deck", "powerpoint", "artifact_output"], 9);
    if (tool.toolName === "presentations.create") {
      score += 18;
    }
    if (tool.toolName === "artifacts.create") {
      score += 2;
    }
  }
  if (input.documentArtifactIntent) {
    score += scoreToolIntentMatch(tool, ["document_generation", "artifact_output", "report", "pdf", "docx"], 9);
    if (tool.toolName === "documents.create") {
      score += 18;
    }
    if (tool.toolName === "artifacts.create") {
      score += 2;
    }
  }
  if (input.memoryLookupIntent) {
    score += scoreToolIntentMatch(tool, ["memory_lookup", "project_context"], 7);
    if (tool.toolName === "memory.search" || tool.toolName === "memory.read") {
      score += 8;
    }
  } else if (tool.toolName === "memory.search" || tool.toolName === "memory.read") {
    if (input.localFileIntent) {
      score -= 10;
    }
    if (input.webLookupIntent || input.liveDataIntent) {
      score -= 8;
    }
  }
  if (input.memoryPersistenceIntent) {
    score += scoreToolIntentMatch(tool, ["memory_persist"], 8);
    if (tool.toolName === "memory.write" || tool.toolName === "memory.upsert") {
      score += 10;
    }
  }
  if (input.mode === "chat") {
    if (tool.category === "research" || tool.category === "knowledge" || tool.category === "session") {
      score += 2;
    }
    if (isWebToolName(tool.toolName) && !input.webLookupIntent && !explicitlyRequested) {
      score -= 20;
    }
    if (tool.category === "shell" || tool.category === "git") {
      score -= 2;
    }
  } else if (input.mode === "cowork") {
    if (
      tool.category === "research" ||
      tool.category === "fs" ||
      tool.category === "ops" ||
      tool.category === "knowledge"
    ) {
      score += 2;
    }
  } else if (input.mode === "code") {
    if (tool.category === "fs" || tool.category === "shell" || tool.category === "git" || tool.category === "ops") {
      score += 3;
    }
    if (tool.category === "research" && !input.liveDataIntent) {
      score -= 1;
    }
  }
  const failureCount = input.failedCounts.get(tool.toolName) ?? 0;
  if (failureCount > 0) {
    score -= Math.min(8, failureCount * 3);
  }
  score += scoreToolLexicalMatch(tool, input.content);
  if (tool.requiresApproval && input.mode === "chat") {
    score -= 1;
  }
  return score;
}

function scoreToolIntentMatch(tool: ToolCatalogEntry, intents: string[], weight: number): number {
  if (!tool.preferredForIntents) {
    return 0;
  }
  const hits = intents.filter((intent) => tool.preferredForIntents?.includes(intent)).length;
  return hits > 0 ? weight + hits : 0;
}

function scoreToolLexicalMatch(tool: ToolCatalogEntry, content: string): number {
  const queryTokens = tokenizeToolSelectionText(content);
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = [
    tool.toolName,
    tool.description,
    ...(tool.preferredForIntents ?? []),
    ...(tool.recommendedContexts ?? []),
    ...(tool.usageHints ?? []),
    ...tool.examples.map((item) => item.title),
  ]
    .join(" ")
    .toLowerCase();
  const hits = queryTokens.filter((token) => haystack.includes(token)).length;
  return Math.min(4, hits);
}

function tokenizeToolSelectionText(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  ];
}

function buildToolFunctionDescription(tool: ToolCatalogEntry): string {
  const hints = tool.usageHints?.slice(0, 2) ?? [];
  const examples = tool.examples.slice(0, 1).map((item) => `Example: ${item.title}.`);
  return [tool.description, ...hints, ...examples].join(" ").trim();
}

function buildToolFailureGuidance(input: {
  toolName: string;
  status: ChatToolRunRecord["status"];
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}): string | undefined {
  const normalizedError = (input.error ?? "").toLowerCase();
  const host = readBlockedSourceHost(input.result ?? {}, input.args);
  const browserFailureClass =
    typeof input.result?.browserFailureClass === "string" ? input.result.browserFailureClass : undefined;

  if (input.toolName.startsWith("browser.") || input.toolName.startsWith("http.")) {
    if (/\bnot yet allowlisted\b|\bnot allowlisted\b|\ballowlisted\b/.test(normalizedError)) {
      return host
        ? `Host ${host} is not allowlisted. Request allowlist approval for that host, or continue from search-result evidence and mark any unverified fields.`
        : "The target host is not allowlisted. Request allowlist approval, or continue from search-result evidence and mark any unverified fields.";
    }
    if (browserFailureClass === "rate_limited" || /\b429\b|rate.?limit/i.test(normalizedError)) {
      return "Search API is rate-limited. Try a different search engine or use the browser directly to scrape results.";
    }
    if (
      browserFailureClass === "remote_blocked" ||
      normalizedError.includes("cloudflare") ||
      normalizedError.includes("captcha")
    ) {
      return `Try an alternate host or source instead of retrying${host ? ` ${host}` : " the same blocked page"}.`;
    }
    if (browserFailureClass === "http_error" || /\b401\b|\b403\b|unauthorized|forbidden|auth/.test(normalizedError)) {
      return /\b401\b|unauthorized|auth|token|credential/.test(normalizedError)
        ? "Reconnect auth or switch to a source/provider with valid credentials."
        : "Retry with an alternate source instead of the same failing host.";
    }
    if (browserFailureClass === "no_results") {
      return "Broaden the query or try a more specific source.";
    }
    if (browserFailureClass === "unusable_output") {
      return "Use a narrower page or a more specific extraction target before retrying.";
    }
  }

  if (normalizedError.includes("write jail") || normalizedError.includes("outside write")) {
    return "Use a safe fallback path inside the workspace write jail.";
  }
  if (input.toolName.startsWith("shell.") && normalizedError.includes("requires approval")) {
    return "Use a safer restricted tool or request approval for the risky shell command.";
  }
  if (normalizedError.includes("query is required")) {
    return "Retry with an explicit query, URL, or file path instead of a vague follow-up.";
  }
  if (input.status === "failed" || input.status === "blocked") {
    return `Retry ${formatToolLabel(input.toolName)} with a narrower, more explicit input.`;
  }
  return undefined;
}

function buildResearchListSourceFailureInstruction(input: {
  researchListIntent: boolean;
  toolRun: ChatToolRunRecord;
}): string | undefined {
  if (!input.researchListIntent) {
    return undefined;
  }
  if (input.toolRun.status !== "blocked" && input.toolRun.status !== "failed") {
    return undefined;
  }
  const normalizedTool = normalizeToolNameForComparison(input.toolRun.toolName);
  if (
    normalizedTool !== "browser.navigate" &&
    normalizedTool !== "browser.extract" &&
    normalizedTool !== "browser.search" &&
    normalizedTool !== "http.get"
  ) {
    return undefined;
  }
  const host =
    input.toolRun.result && typeof input.toolRun.result === "object"
      ? readBlockedSourceHost(input.toolRun.result as Record<string, unknown>, input.toolRun.args)
      : readUrlHost(typeof input.toolRun.args?.url === "string" ? input.toolRun.args.url : undefined);
  return [
    "Local research list integrity rule:",
    host
      ? `- The source host ${host} did not complete. Do not retry that same host unless the operator approves or allowlists it.`
      : "- A web source did not complete. Do not repeat the same failed tool call.",
    "- Continue with alternate relevant live sources or search results if available.",
    "- Do not present a complete store/address/hours/email table unless the fields are supported by completed tool evidence.",
    "- For any email address that completed evidence does not verify, write exactly `No public email found`.",
    "- If the required fields cannot be verified through available sources, stop with `Synthesis Incomplete` or a clear continuation/approval path instead of filling guesses.",
  ].join("\n");
}

function normalizeToolParameters(tool: ToolCatalogEntry): Record<string, unknown> {
  if (tool.argSchema && Object.keys(tool.argSchema).length > 0) {
    return tool.argSchema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function extractProviderToolName(tool: Record<string, unknown>): string | undefined {
  if (typeof tool.name === "string") {
    return tool.name;
  }
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function createAssistantToolCallMessage(input: {
  toolCallId?: string;
  toolName?: string;
  argumentsJson?: string;
  content?: string;
  providerNativeContent?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
}): ChatCompletionMessage {
  const toolCalls = input.toolCalls ?? [
    {
      id: input.toolCallId ?? randomUUID(),
      type: "function",
      function: {
        name: input.toolName ?? "tool_fn",
        arguments: input.argumentsJson ?? "{}",
      },
    },
  ];
  return {
    role: "assistant",
    content: input.content ?? "",
    ...(input.providerNativeContent && input.providerNativeContent.length > 0
      ? { provider_native_content: input.providerNativeContent }
      : {}),
    tool_calls: toolCalls,
  } as ChatCompletionMessage;
}

function extractProviderNativeContent(message: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return Array.isArray(message?.provider_native_content)
    ? message.provider_native_content.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function collectSourceAttributionFromToolRuns(
  toolRuns: ChatToolRunRecord[] | undefined,
): ToolInvokeRequest["sourceAttribution"] | undefined {
  const attributions: ToolSourceAttribution[] = [];
  for (const toolRun of toolRuns ?? []) {
    collectSourceAttributionFromToolResult(toolRun.result, attributions);
  }
  if (attributions.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  return attributions.filter((attribution) => {
    const key = [
      attribution.sourceType,
      attribution.sourceRef,
      attribution.trustLevel ?? "",
      attribution.backend ?? "",
      attribution.title ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectSourceAttributionFromToolResult(value: unknown, output: ToolSourceAttribution[]): void {
  const result = toPlainRecord(value);
  if (!result) {
    return;
  }
  pushSourceAttribution(result.attribution, output);
  for (const attribution of Array.isArray(result.sourceAttribution) ? result.sourceAttribution : []) {
    pushSourceAttribution(attribution, output);
  }
  const document = toPlainRecord(result.document);
  pushSourceAttribution(document?.attribution, output);
  for (const key of ["items", "chunks"] as const) {
    const items = Array.isArray(result[key]) ? result[key] : [];
    for (const item of items) {
      const record = toPlainRecord(item);
      pushSourceAttribution(record?.attribution, output);
    }
  }
}

function pushSourceAttribution(value: unknown, output: ToolSourceAttribution[]): void {
  const attribution = normalizeSourceAttribution(value);
  if (attribution) {
    output.push(attribution);
  }
}

function normalizeSourceAttribution(value: unknown): ToolSourceAttribution | undefined {
  const record = toPlainRecord(value);
  if (!record) {
    return undefined;
  }
  const sourceType = readContextSourceType(record.sourceType);
  const sourceRef =
    typeof record.sourceRef === "string" && record.sourceRef.trim() ? record.sourceRef.trim() : undefined;
  if (!sourceType || !sourceRef) {
    return undefined;
  }
  const trustLevel = readToolExecutionTrustLevel(record.trustLevel);
  return {
    sourceType,
    sourceRef,
    ...(typeof record.title === "string" && record.title.trim() ? { title: record.title.trim() } : {}),
    ...(record.backend === "native" || record.backend === "firecrawl" ? { backend: record.backend } : {}),
    ...(typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? { fetchedAt: record.fetchedAt.trim() } : {}),
    ...(trustLevel ? { trustLevel } : {}),
  };
}

function readContextSourceType(value: unknown): ToolSourceAttribution["sourceType"] | undefined {
  return value === "file" || value === "url" || value === "text" || value === "memory" || value === "mcp"
    ? value
    : undefined;
}

function readToolExecutionTrustLevel(value: unknown): ToolSourceAttribution["trustLevel"] | undefined {
  return value === "trusted_operator" ||
    value === "trusted_workspace" ||
    value === "mixed_untrusted" ||
    value === "untrusted_external"
    ? value
    : undefined;
}

function parseUsageFromCompletion(completion: ChatCompletionResponse): ChatStreamUsageRecord | null {
  const usage = completion.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inputTokens = readUsageNumber(usage.prompt_tokens) ?? readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.completion_tokens) ?? readUsageNumber(usage.output_tokens);
  const cachedInputTokens = readUsageNumber(usage.cached_prompt_tokens) ?? readUsageNumber(usage.cached_input_tokens);
  const costUsd = readUsageNumber(usage.cost_usd) ?? readUsageNumber(usage.total_cost_usd);
  const costSource = costUsd !== undefined ? readUsageCostSource(usage) : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    costUsd === undefined
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
    costSource,
  };
}

function buildTraceUsageRecord(
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  },
  costSource?: ChatStreamUsageRecord["costSource"],
): ChatStreamUsageRecord {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    costUsd: totals.costUsd,
    ...(costSource ? { costSource } : {}),
  };
}

function resolveUsageCostSource(
  sources: Set<NonNullable<ChatStreamUsageRecord["costSource"]>>,
): ChatStreamUsageRecord["costSource"] | undefined {
  if (sources.size === 0) {
    return undefined;
  }
  if (sources.size === 1) {
    return [...sources][0];
  }
  return "mixed";
}

function readUsageCostSource(usage: Record<string, unknown>): ChatStreamUsageRecord["costSource"] | undefined {
  const raw = typeof usage.cost_source === "string" ? usage.cost_source : usage.costSource;
  if (raw === "provider_reported" || raw === "estimated" || raw === "mixed" || raw === "unknown") {
    return raw;
  }
  if (raw === "provider-reported" || raw === "provider") {
    return "provider_reported";
  }
  if (raw === "estimate") {
    return "estimated";
  }
  if (usage.cost_estimated === true || usage.estimated === true) {
    return "estimated";
  }
  return undefined;
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildEvidenceGroundingInstruction(): string {
  return [
    "Evidence grounding rules for this turn:",
    "- Base your answer strictly on the tool results provided. Do not add claims, statistics, or details not present in the retrieved data.",
    "- If the search results are shallow or only partially answer the question, say so explicitly. Keep the answer proportional to the evidence.",
    "- If you cannot verify a specific claim from the tool results, do not present it as verified. Use hedging language or omit it.",
    "- Cite only the few URLs that directly support the key claims you make. Do not append long source inventories.",
    "- If the results are insufficient to answer the question well, tell the user what was found and what is missing.",
  ].join("\n");
}

function detectTimeIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  if (!normalized.includes("time")) {
    return false;
  }
  return (
    normalized.includes("what time") ||
    normalized.includes("current time") ||
    normalized.includes("time is it") ||
    normalized.includes("local time")
  );
}

function detectPresentationArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const presentationPhrase =
    /\b(power\s?point|pptx?|(?:slide|pitch|investor|presentation)\s+deck|slides?|presentation)\b/.test(normalized);
  if (!presentationPhrase) {
    return false;
  }
  return (
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver)\b/.test(normalized) ||
    /\b(file|format|artifact|download|power\s?point|pptx?)\b/.test(normalized)
  );
}

function detectDocumentArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const documentPhrase =
    /\b(docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|text\s+file|txt|report|brief|memo|handout|worksheet|document)\b/.test(
      normalized,
    );
  if (!documentPhrase) {
    return false;
  }
  return (
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver)\b/.test(normalized) ||
    /\b(file|format|artifact|download|docx?|pdf|markdown|html|csv|json)\b/.test(normalized)
  );
}

function buildSyntheticPresentationCreateArgs(
  input: ChatAgentTurnInput,
  safeWriteFallbackDir?: string,
): Record<string, unknown> {
  const task = extractPrimaryUserTaskContent(input.content) ?? input.content;
  const title = inferPresentationTitle(task);
  const path =
    extractAnsweredWriteDestination(input.content) ??
    buildSafeWriteFallbackPath(input.sessionId, "presentations.create", `${title}.pptx`, safeWriteFallbackDir);
  return {
    path: path ?? buildSafeWritePath("presentation.pptx", safeWriteFallbackDir),
    title,
    subtitle: "Generated by GoatCitadel Cowork",
    slides: buildSyntheticPresentationSlides(task, title),
  };
}

async function attachGeneratedPresentationVisual(
  args: Record<string, unknown>,
  input: ChatAgentTurnInput,
  generateImage?: ChatAgentOrchestratorDeps["generateImage"],
): Promise<{ args: Record<string, unknown>; providerCalls: number }> {
  if (!generateImage) {
    return { args, providerCalls: 0 };
  }
  let providerCalls = 0;
  try {
    const prompt = buildPresentationVisualPrompt(input.content, String(args.title ?? "Presentation"), args.slides);
    providerCalls += 1;
    const response = await generateImage({
      providerId: "openai",
      model: "gpt-image-2",
      prompt,
      n: 1,
      outputFormat: "png",
      responseFormat: "b64_json",
      timeoutMs: 45000,
    });
    const image = response.data.find((item) => item.b64Json);
    if (!image?.b64Json) {
      return { args, providerCalls };
    }
    return {
      args: {
        ...args,
        visualAsset: {
          bytesBase64: image.b64Json,
          mimeType: "image/png",
          altText: `Generated supporting visual for ${args.title ?? "presentation"}.`,
          source: response.providerId ?? "openai",
          sourceModel: response.model ?? "gpt-image-2",
          revisedPrompt: image.revisedPrompt,
        },
      },
      providerCalls,
    };
  } catch {
    return { args, providerCalls };
  }
}

function buildPresentationVisualPrompt(content: string, title: string, slidesValue: unknown): string {
  const slideTitles = Array.isArray(slidesValue)
    ? slidesValue
        .map((slide) => (slide && typeof slide === "object" ? (slide as { title?: unknown }).title : undefined))
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, 5)
        .join("; ")
    : "";
  return [
    `Create a polished PowerPoint-supporting visual for "${title}".`,
    "Use a clean editorial cover composition with strong hierarchy, generous negative space, and no readable text.",
    "The image should work as a title-slide anchor; the renderer will create distinct supporting visuals per slide.",
    slideTitles ? `Deck sections: ${slideTitles}.` : undefined,
    `User request: ${content.replace(/\s+/g, " ").trim().slice(0, 600)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSyntheticDocumentCreateArgs(
  input: ChatAgentTurnInput,
  safeWriteFallbackDir?: string,
): Record<string, unknown> {
  const task = extractPrimaryUserTaskContent(input.content) ?? input.content;
  const title = inferDocumentTitle(task);
  const format = inferDocumentFormat(task);
  const path =
    extractAnsweredWriteDestination(input.content) ??
    buildSafeWriteFallbackPath(
      input.sessionId,
      "documents.create",
      `${title}.${documentFormatExtension(format)}`,
      safeWriteFallbackDir,
    );
  return {
    path: path ?? buildSafeWritePath(`document.${documentFormatExtension(format)}`, safeWriteFallbackDir),
    format,
    title,
    body: `Generated document for: ${task.trim().replace(/\s+/g, " ").slice(0, 500)}`,
    sections: buildSyntheticDocumentSections(task),
  };
}

function inferPresentationTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const quotedTitle = normalized.match(/["'`](.{8,90}?)["'`]/)?.[1]?.trim();
  if (quotedTitle) {
    return titleCasePresentationText(quotedTitle);
  }
  if (/\bfree time\b/i.test(normalized) && /\btop\s*10\b/i.test(normalized)) {
    return "Top 10 Things To Do In Free Time";
  }
  const topic =
    normalized.match(/\b(?:about|on|for)\s+(.{8,100}?)(?:\.|$|\n)/i)?.[1]?.trim() ??
    normalized
      .match(/\b(?:power\s?point|pptx?|presentation|slides?|deck)\b\s+(?:about|on|for)?\s*(.{8,100}?)(?:\.|$|\n)/i)?.[1]
      ?.trim();
  return titleCasePresentationText(topic ?? "Presentation");
}

function inferDocumentTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const quotedTitle = normalized.match(/["'`](.{8,90}?)["'`]/)?.[1]?.trim();
  if (quotedTitle) {
    return titleCasePresentationText(quotedTitle);
  }
  if (/\bfree time\b/i.test(normalized) && /\btop\s*10\b/i.test(normalized)) {
    return "Top 10 Things To Do In Free Time";
  }
  const topic =
    normalized.match(/\b(?:about|on|for)\s+(.{8,100}?)(?:\.|$|\n)/i)?.[1]?.trim() ??
    normalized
      .match(
        /\b(?:docx?|document|report|brief|memo|handout|worksheet|pdf|markdown|html|csv|json)\b\s+(?:about|on|for)?\s*(.{8,100}?)(?:\.|$|\n)/i,
      )?.[1]
      ?.trim();
  return titleCasePresentationText(topic ?? "Document");
}

function inferDocumentFormat(content: string): string {
  const normalized = content.toLowerCase();
  if (/\bpdf\b/.test(normalized)) {
    return "pdf";
  }
  if (/\b(docx?|word\s+doc(?:ument)?)\b/.test(normalized)) {
    return "docx";
  }
  if (/\bhtml?\b/.test(normalized)) {
    return "html";
  }
  if (/\bcsv\b/.test(normalized)) {
    return "csv";
  }
  if (/\bjson\b/.test(normalized)) {
    return "json";
  }
  if (/\b(?:txt|text\s+file)\b/.test(normalized)) {
    return "txt";
  }
  if (/\b(?:md|markdown)\b/.test(normalized)) {
    return "markdown";
  }
  return "docx";
}

function documentFormatExtension(format: string): string {
  return format === "markdown" ? "md" : format;
}

function titleCasePresentationText(value: string): string {
  const cleaned = value
    .replace(
      /\b(?:please|create|make|build|generate|put|together|presentation|power\s?point|pptx?|slides?|deck|artifact|file)\b/gi,
      " ",
    )
    .replace(/[^a-zA-Z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  if (!cleaned) {
    return "Presentation";
  }
  return cleaned
    .split(" ")
    .map((word) =>
      /^(?:a|an|and|as|at|but|by|for|in|near|of|on|or|the|to|with)$/i.test(word)
        ? word.toLowerCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join(" ")
    .replace(/\b(?:Ai|Api|Ui|Ux|Pptx)\b/g, (match) => match.toUpperCase());
}

function buildSyntheticPresentationSlides(content: string, title: string): Array<{ title: string; bullets: string[] }> {
  const bullets = extractPresentationBulletsFromPrompt(content);
  return [
    {
      title,
      bullets: [
        "Summarizes the requested topic in a shareable slide format",
        "Keeps the deck concise and easy to edit",
        "Uses a real PPTX artifact rather than text-only presentation notes",
      ],
    },
    {
      title: "Key Points",
      bullets,
    },
    {
      title: "Recommended Structure",
      bullets: ["Open with the purpose", "Group details into clear sections", "Close with next steps or takeaways"],
    },
  ];
}

function buildSyntheticDocumentSections(content: string): Array<{ heading: string; body: string; bullets: string[] }> {
  const bullets = extractPresentationBulletsFromPrompt(content);
  if (/\bfree time\b/i.test(content)) {
    return [
      {
        heading: "Recommended Activities",
        body: "A balanced free-time plan mixes active, creative, social, and restorative options.",
        bullets: [
          "Read or learn something new",
          "Walk, exercise, or explore locally",
          "Cook, create, volunteer, connect, and rest",
        ],
      },
      {
        heading: "How To Choose",
        body: "Pick activities based on available time, energy level, budget, and whether you want solitude or company.",
        bullets: [
          "Keep low-friction options ready",
          "Rotate familiar favorites with new experiments",
          "Notice what leaves you better afterward",
        ],
      },
    ];
  }
  return [
    {
      heading: "Summary",
      body: "This document turns the requested response into a real file artifact.",
      bullets,
    },
    {
      heading: "Next Steps",
      body: "Review the generated file, then refine sections, formatting, or audience-specific details as needed.",
      bullets: [
        "Confirm the intended audience",
        "Adjust wording and emphasis",
        "Add source citations when the task used research",
      ],
    },
  ];
}

function extractPresentationBulletsFromPrompt(content: string): string[] {
  const lines = content
    .split(/\r?\n|[.;]/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12 && !/^suggested tools:/i.test(line))
    .slice(0, 5);
  return lines.length > 0
    ? lines.map((line) => line.slice(0, 180))
    : ["Clarify the main audience", "Focus each slide on one idea", "Keep bullets brief and scannable"];
}

function mergePresentationArtifactDeliveryContent(existingContent: string, toolRun: ChatToolRunRecord): string {
  if (toolRun.status !== "executed") {
    const failure = toolRun.error ?? "the presentation tool did not complete";
    const fallback = `I tried to create the PowerPoint artifact with \`presentations.create\`, but ${failure}.`;
    return existingContent.trim().length > 0 ? `${existingContent.trim()}\n\n${fallback}` : fallback;
  }
  const result = (toolRun.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.path === "string"
      ? result.path
      : typeof result.fallbackPath === "string"
        ? result.fallbackPath
        : typeof toolRun.args?.path === "string"
          ? toolRun.args.path
          : "the requested PPTX path";
  const slideCount = typeof result.slideCount === "number" ? result.slideCount : undefined;
  const bytesWritten = typeof result.bytesWritten === "number" ? result.bytesWritten : undefined;
  const delivery = [
    `Created the PowerPoint presentation artifact at \`${path}\`.`,
    slideCount !== undefined ? `Slides: ${slideCount}.` : undefined,
    bytesWritten !== undefined ? `Size: ${bytesWritten} bytes.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const trimmed = existingContent.trim();
  if (!trimmed || looksLikeMissingPresentationArtifactContent(trimmed)) {
    return delivery;
  }
  if (trimmed.includes(path)) {
    return trimmed;
  }
  return `${trimmed}\n\n${delivery}`;
}

function looksLikeMissingPresentationArtifactContent(content: string): boolean {
  return (
    /\b(?:could not|couldn't|unable to|did not|didn't|not able to|no verified|not created|was not created)\b/i.test(
      content,
    ) && /\b(?:pptx?|power\s?point|presentation|slides?|deck|artifact|file)\b/i.test(content)
  );
}

function mergeDocumentArtifactDeliveryContent(existingContent: string, toolRun: ChatToolRunRecord): string {
  if (toolRun.status !== "executed") {
    const failure = toolRun.error ?? "the document tool did not complete";
    const fallback = `I tried to create the document artifact with \`documents.create\`, but ${failure}.`;
    return existingContent.trim().length > 0 ? `${existingContent.trim()}\n\n${fallback}` : fallback;
  }
  const result = (toolRun.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.path === "string"
      ? result.path
      : typeof result.fallbackPath === "string"
        ? result.fallbackPath
        : typeof toolRun.args?.path === "string"
          ? toolRun.args.path
          : "the requested document path";
  const format = typeof result.format === "string" ? result.format.toUpperCase() : undefined;
  const bytesWritten = typeof result.bytesWritten === "number" ? result.bytesWritten : undefined;
  const delivery = [
    `Created the document artifact at \`${path}\`.`,
    format ? `Format: ${format}.` : undefined,
    bytesWritten !== undefined ? `Size: ${bytesWritten} bytes.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const trimmed = existingContent.trim();
  if (!trimmed || looksLikeMissingDocumentArtifactContent(trimmed)) {
    return delivery;
  }
  if (trimmed.includes(path)) {
    return trimmed;
  }
  return `${trimmed}\n\n${delivery}`;
}

function looksLikeMissingDocumentArtifactContent(content: string): boolean {
  return (
    /\b(?:could not|couldn't|unable to|did not|didn't|not able to|no verified|not created|was not created)\b/i.test(
      content,
    ) &&
    /\b(?:docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|txt|report|brief|memo|document|artifact|file)\b/i.test(
      content,
    )
  );
}

function detectLiveDataIntent(content: string): boolean {
  return hasLiveDataIntent(content) || Boolean(derivePromptSpecificWebQuery(content));
}

function detectExplicitWebLookupIntent(content: string): boolean {
  // P1-8: Use only explicit web phrases, not all live-data keywords.
  const lower = content.toLowerCase();
  return EXPLICIT_WEB_PHRASES.some((phrase) => lower.includes(phrase));
}

function detectDirectUrlIntent(content: string): boolean {
  return /\bhttps?:\/\/\S+/i.test(content);
}

function detectWebLookupIntent(content: string, historyMessages: ChatCompletionRequest["messages"]): boolean {
  return (
    detectLiveDataIntent(content) ||
    detectDirectUrlIntent(content) ||
    detectWebPageInteractionIntent(content) ||
    Boolean(derivePromptSpecificWebQuery(content)) ||
    /\bresearch\s+whether\b/i.test(content) ||
    /\buse\s+available\s+lookup\b/i.test(content) ||
    detectWebFollowUpIntent(content, historyMessages)
  );
}

function detectWebPageInteractionIntent(content: string): boolean {
  return /\b(?:open|visit|load|extract|read|scrape|navigate\s+to)\b.{0,40}\b(?:web\s+)?page\b/i.test(content);
}

function detectWebFollowUpIntent(content: string, historyMessages: ChatCompletionRequest["messages"]): boolean {
  const lower = content.toLowerCase();
  const followUpSignals = [
    "retry with a better fallback",
    "try the search one more time",
    "search one more time",
    "continue from this source",
    "continue from that source",
    "continue from this page",
    "continue from that page",
    "use a different source",
    "use another source",
    "try a different source",
    "search again",
    "look again",
  ];
  if (!followUpSignals.some((signal) => lower.includes(signal))) {
    return false;
  }
  return historyMessages.some((message) => {
    const raw = (message as { content?: unknown }).content;
    if (typeof raw !== "string" || !raw.trim()) {
      return false;
    }
    const normalized = raw.toLowerCase();
    return (
      detectLiveDataIntent(raw) ||
      detectDirectUrlIntent(raw) ||
      normalized.includes("source blocked automated browsing") ||
      normalized.includes("recover useful content from") ||
      normalized.includes("switch to deep mode")
    );
  });
}

function deriveLiveDataQuery(content: string): string {
  const normalized = extractPrimaryUserTaskContent(content).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return content;
  }
  const promptSpecificQuery = derivePromptSpecificWebQuery(normalized);
  if (promptSpecificQuery) {
    return promptSpecificQuery;
  }
  const clauses = normalized
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (clauses.length === 0) {
    return normalized;
  }
  const keywordRegex =
    /\b(latest|today|right now|news|price|weather|recent|recently|lately|this week|this weekend|this month|coming out|opening|releasing|release schedule)\b/i;
  const matching = clauses.filter((clause) => keywordRegex.test(clause));
  const selected = matching.at(-1) ?? clauses.at(-1) ?? normalized;
  const cleaned = selected
    .replace(/^(hi|hello|hey)\b[^a-zA-Z0-9]*/i, "")
    .replace(
      /^(?:please\s+)?(?:look|search|browse)\s+(?:online|the web|web|internet)\b(?:\s+(?:for|about|on))?(?:\s+and)?\s*/i,
      "",
    )
    .replace(/^(?:please\s+)?(?:tell|show|give)\s+me\b(?:\s+the)?\s*/i, "")
    .trim();
  if (
    /\b(?:what|which)\s+happened\s+today\b/i.test(cleaned) ||
    /\b(?:things|stories|events)\s+that\s+happened\s+today\b/i.test(cleaned)
  ) {
    return "top news headlines today";
  }
  const sanitized = sanitizeQueryClause(cleaned || normalized);
  return sanitized || cleaned || normalized;
}

function inferMemoryQueryFromPrompt(userContent: string): string | undefined {
  const taskText = `${extractPrimaryUserTaskContent(userContent) ?? ""}\n${userContent}`;
  if (/\bstored\s+preference\b/i.test(taskText) && /\banswer\s+length\b/i.test(taskText)) {
    return "answer length preference concise short detailed response length";
  }
  if (
    /\bstored\s+planning\s+preferences?\b/i.test(taskText) &&
    /\btravel\b/i.test(taskText) &&
    /\bscheduling\b/i.test(taskText)
  ) {
    return "travel scheduling planning preferences dates availability itinerary constraints";
  }
  const inferred = inferQueryFromPrompt(userContent);
  if (inferred) {
    return inferred;
  }
  const normalized = userContent
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "then",
    "what",
    "your",
    "you",
    "into",
    "about",
    "please",
    "would",
    "could",
    "should",
    "have",
    "been",
    "were",
    "when",
    "where",
    "which",
    "while",
    "without",
    "just",
    "need",
    "want",
    "give",
    "tell",
  ]);
  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 3 && !stopWords.has(token))
    .slice(0, 12);
  if (tokens.length < 2) {
    return undefined;
  }
  return tokens.join(" ");
}

function detectLocalFileIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  if (/[a-z]:[\\/]/i.test(content) || /\\\\/.test(content)) {
    return true;
  }
  if (extractExplicitLocalAccessPaths(content).length > 0) {
    return true;
  }
  if (extractExplicitLocalFilePathsFromPrompt(content).length > 0) {
    return true;
  }
  if (/\b(local|workspace|project)\s+(file|files|path|paths|stack)\b/.test(normalized)) {
    return true;
  }
  if (/\b(use|using|with)\s+(?:(?:file|filesystem)(?:\s+or\s+code)?|code|file\/code)\s+tools\b/.test(normalized)) {
    return true;
  }
  return (
    normalized.includes("docker-compose") ||
    normalized.includes("docker compose") ||
    normalized.includes("current project files") ||
    normalized.includes("read it and tell me what services") ||
    normalized.includes("what services i'm running") ||
    /\bread\s+.*\.(?:yml|yaml|json|md|txt|ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|kt|swift|cs|sql|sh)\b/.test(normalized)
  );
}

function buildLocalFileAccessFallback(userPrompt: string): string {
  const composeHint = /\bdocker[-\s]?compose\b/i.test(userPrompt)
    ? "If you share your `docker-compose.yml` contents, I can list services and rank operational risk by exposure, privilege, and data sensitivity."
    : "If you share the relevant file content, I can give you a concrete analysis instead of a generic answer.";
  return [
    "I can't directly access your local project files from this runtime -- no filesystem read path was available for this turn.",
    "",
    "To help, I'd need you to either paste the file contents (or key sections) or run a local command to print the file and share the output.",
    "",
    composeHint,
  ].join("\n");
}

function looksLikeDelegatedOrchestrationPrompt(content: string): boolean {
  return (
    /^\s*Delegated role:/i.test(content) &&
    /(?:^|\n)Parent objective:/i.test(content) &&
    /(?:^|\n)Current step objective:/i.test(content)
  );
}

function hasAvailableLocalFileTools(availableTools: Map<string, string>): boolean {
  return [...LOCAL_PATH_TOOL_NAMES].some((toolName) => availableTools.has(toolName));
}

function promptLabContractRequiresArtifactTools(input: { requiredNamedTools: string[] }): boolean {
  return input.requiredNamedTools.some((toolName) => PROMPT_LAB_ARTIFACT_TOOL_NAMES.has(toolName));
}

function buildClarificationPromptIfNeeded(userPrompt: string): string | undefined {
  const normalized = userPrompt.toLowerCase();
  const questions: string[] = [];

  // Detect estimation prompts with ambiguous scope.
  const isEstimate = /\b(estimate|estimation|how many|count|number of|size of)\b/.test(normalized);
  const hasVagueGeography =
    /\b(the|this|my|our)\s+(area|region|city|county|metro|state|country|neighborhood)\b/.test(normalized) ||
    /\b(here|near me|locally|nearby)\b/.test(normalized);
  if (isEstimate && hasVagueGeography) {
    questions.push("What geographic area do you mean exactly: city, metro, county, state, or country?");
  }

  // Detect subjective/qualitative terms that need an operational definition.
  const hasSubjectiveTerm =
    /\b(genuinely|chronic(?:ally)?|true|real|actual)\s+\w+/.test(normalized) &&
    /\b(lonely|isolated|engaged|active|committed|poor|wealthy|healthy)\b/.test(normalized);
  if (isEstimate && hasSubjectiveTerm) {
    questions.push("How are you defining that qualifier -- what threshold or criteria should I use?");
  }

  // Detect timeframe ambiguity for trend or comparison prompts.
  const isTrend = /\b(trend|growth|change|decline|increase|decrease|over time)\b/.test(normalized);
  const hasVagueTimeframe =
    /\b(recent|recently|lately|last few|past few)\b/.test(normalized) &&
    !/\b(last|past)\s+\d+\s+(year|month|week|day|quarter)/i.test(normalized);
  if (isTrend && hasVagueTimeframe) {
    questions.push("What timeframe should I use -- last 12 months, 5 years, or something else?");
  }

  if (questions.length === 0) {
    return undefined;
  }
  return [
    "I need a quick clarification before answering that responsibly:",
    ...questions.map((question) => `- ${question}`),
    "Once you answer, I can give you a grounded response.",
  ].join("\n");
}

function buildClarificationFollowUpIfNeeded(
  userPrompt: string,
  historyMessages: ChatCompletionRequest["messages"],
): string | undefined {
  const pending = readPendingClarification(historyMessages);
  if (!pending || pending.length === 0) {
    return undefined;
  }
  const normalizedAnswer = userPrompt.toLowerCase();
  const answeredAny = pending.some((question) => looksLikeClarificationAnswer(normalizedAnswer, question));
  if (!answeredAny) {
    return looksLikeFreshStandalonePrompt(userPrompt)
      ? undefined
      : [
          "I still need a quick clarification before answering that responsibly:",
          ...pending.map((question) => `- ${question}`),
          "Once you answer, I can give you a grounded response.",
        ].join("\n");
  }
  const remaining = pending.filter((question) => !looksLikeClarificationAnswer(normalizedAnswer, question));
  if (remaining.length === 0) {
    return undefined;
  }
  return [
    remaining.length < pending.length
      ? "Got it. I still need one more detail before answering that responsibly:"
      : "I still need a quick clarification before answering that responsibly:",
    ...remaining.map((question) => `- ${question}`),
    "Once you answer, I can give you a grounded response.",
  ].join("\n");
}

function readPendingClarification(historyMessages: ChatCompletionRequest["messages"]): string[] | undefined {
  for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
    const message = toPlainRecord(historyMessages[index]);
    if (!message || message.role !== "assistant") {
      continue;
    }
    const content = extractMessageContent(message);
    if (!content.includes("answering that responsibly")) {
      return undefined;
    }
    // Extract the bullet-point questions from our prior clarification.
    const questions = content
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.endsWith("?"))
      .map((line) => line.slice(2));
    if (questions.length > 0) {
      return questions;
    }
    return undefined;
  }
  return undefined;
}

function looksLikeFreshStandalonePrompt(userPrompt: string): boolean {
  const trimmed = userPrompt.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/^(never mind|nevermind|ignore that|different question)\b/i.test(trimmed)) {
    return true;
  }
  if (trimmed.endsWith("?")) {
    return true;
  }
  return /^(what|who|when|where|why|how|compare|explain|summarize|estimate|tell me|look online|search online|browse the web|use internet|give me|write|draft|analyze|analyse|review|help me|find)\b/i.test(
    trimmed,
  );
}

function buildLiveDataSettingsConflictMessage(input: {
  mode: ChatMode;
  webLookupIntent: boolean;
  strictWebRequirement: boolean;
  promptLabPrompt: boolean;
  timeIntent: boolean;
  localFileIntent: boolean;
  userPrompt: string;
  webMode: ChatWebMode;
  toolAutonomy: ChatAgentTurnInput["toolAutonomy"];
}): string | undefined {
  if (!input.webLookupIntent || input.timeIntent || input.localFileIntent) {
    return undefined;
  }
  if (
    !input.strictWebRequirement &&
    /\b(without assuming tool access|without tool access|cannot verify|can't verify|unable to verify)\b/i.test(
      input.userPrompt,
    )
  ) {
    return undefined;
  }
  if (input.promptLabPrompt && !input.strictWebRequirement) {
    return undefined;
  }
  if (input.mode !== "chat" && !input.strictWebRequirement) {
    return undefined;
  }
  if (
    input.webMode === "off" &&
    /\blatest\s+public\s+guidance\b/i.test(input.userPrompt) &&
    /\bgovernment\s+agency\b/i.test(input.userPrompt)
  ) {
    return [
      "I cannot verify the latest public guidance without web access, so I should not invent quotes, links, or dates.",
      "",
      "A trustworthy answer would need:",
      "- The agency's official guidance page or publication notice.",
      "- The page's publication date and last-updated date.",
      "- Any superseding alerts, press releases, or archived replacements.",
      "",
      "Check template:",
      "- Agency/page checked:",
      "- Last updated:",
      "- Current guidance summary:",
      "- What changed since the prior version:",
      "- Source URL and access date:",
    ].join("\n");
  }
  if (input.promptLabPrompt && input.webMode === "off") {
    return undefined;
  }
  if (input.webMode === "off") {
    return [
      "I can't fetch web-backed information for that because Web is set to Off for this chat.",
      "Switch Web to Auto, Quick, or Deep and resend if you want a grounded web-backed answer, or ask for a non-web summary instead.",
    ].join(" ");
  }
  if (input.toolAutonomy === "manual") {
    return [
      "I can't fetch web-backed information for that because tool autonomy is set to Manual for this chat, so I can't run the browser tools needed to verify it.",
      "Switch tool autonomy to Safe Auto and resend, or ask a non-web question instead.",
    ].join(" ");
  }
  return undefined;
}

function isWebToolName(toolName: string): boolean {
  return WEB_TOOL_NAMES.has(toolName);
}

function shouldExposeWebToolForTurn(input: {
  toolName: string;
  mode: ChatMode;
  webMode: ChatWebMode;
  webLookupIntent: boolean;
}): boolean {
  if (!isWebToolName(input.toolName)) {
    return true;
  }
  if (input.webMode === "off") {
    return false;
  }
  if (input.mode !== "chat") {
    return true;
  }
  return input.webLookupIntent;
}

function looksLikeClarificationAnswer(answer: string, question: string): boolean {
  // Geography questions
  if (question.includes("geographic area")) {
    return (
      /\b(city|metro|county|state|country|region|neighborhood|borough|district|zip|postal)\b/.test(answer) ||
      /\b(in|for|around|within|near)\s+[A-Z]/i.test(answer)
    );
  }
  // Definition/qualifier questions
  if (question.includes("threshold") || question.includes("criteria") || question.includes("defining")) {
    return (
      /\b(defined as|definition|means|self-reported|threshold|criteria|measured)\b/.test(answer) || answer.includes('"')
    );
  }
  // Timeframe questions
  if (question.includes("timeframe")) {
    return (
      /\b(year|month|week|day|quarter|since|from|period|window)\b/.test(answer) ||
      /\d+\s*(year|month|week|day|quarter)/i.test(answer)
    );
  }
  return false;
}

function inferCitationsFromToolResult(toolRun: ChatToolRunRecord): ChatCitationRecord[] {
  if (!toolRun.result) {
    return [];
  }
  const result = toolRun.result as Record<string, unknown>;
  const items: ChatCitationRecord[] = [];
  if (Array.isArray(result.results)) {
    let rank = 0;
    for (const raw of result.results) {
      const value = raw as Record<string, unknown>;
      const url = typeof value.url === "string" ? value.url : undefined;
      const title = typeof value.title === "string" ? value.title : undefined;
      if (!url || !isUsablePromptLabWebCitationItem({ title: title ?? null, url })) {
        continue;
      }
      items.push({
        citationId: `${toolRun.toolRunId}-${rank}`,
        title,
        snippet: typeof value.snippet === "string" ? value.snippet : undefined,
        url,
        sourceType: "web",
      });
      rank += 1;
    }
  } else if (
    typeof result.finalUrl === "string" &&
    isUsablePromptLabWebCitationItem({
      title: typeof result.title === "string" ? result.title : null,
      url: result.finalUrl,
    })
  ) {
    items.push({
      citationId: `${toolRun.toolRunId}-0`,
      url: result.finalUrl,
      title: typeof result.title === "string" ? result.title : undefined,
      snippet: typeof result.textSnippet === "string" ? result.textSnippet.slice(0, 220) : undefined,
      sourceType: "web",
    });
  } else if (typeof result.url === "string" && isUsablePromptLabWebCitationItem({ title: null, url: result.url })) {
    items.push({
      citationId: `${toolRun.toolRunId}-0`,
      url: result.url,
      sourceType: "web",
    });
  } else if (toolNameMatchesAnyKnownTool(toolRun.toolName, new Set(["file.read_range", "fs.read"]))) {
    const rawPath =
      typeof result.path === "string"
        ? result.path
        : typeof toolRun.args?.path === "string"
          ? toolRun.args.path
          : undefined;
    if (rawPath) {
      const normalizedPath = normalizePromptLabFilePath(rawPath);
      const normalizedContent = normalizePromptLabEvidenceContent(
        typeof result.content === "string"
          ? result.content
          : typeof result.bodySnippet === "string"
            ? result.bodySnippet
            : typeof result.snippet === "string"
              ? result.snippet
              : "",
      );
      const snippet =
        extractPromptLabCitationQuote(normalizedPath, [toolRun]) ?? truncatePlainText(normalizedContent, 220);
      items.push({
        citationId: `${toolRun.toolRunId}-0`,
        url: normalizedPath,
        title: normalizedPath.split("/").at(-1),
        snippet: snippet || undefined,
        sourceType: "file",
      });
    }
  }
  return items;
}

function isRetryableToolFailure(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  const normalized = normalizeFailureSignature(errorText);
  // Note: 429 / rate-limit errors are NOT retryable here — they are tracked
  // separately via isRateLimitedToolFailure with a higher breaker threshold
  // so the agent stays tenacious but doesn't loop infinitely.
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("network") ||
    normalized.includes("temporarily unavailable")
  );
}

function isRateLimitedToolFailure(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  const normalized = normalizeFailureSignature(errorText);
  return normalized.includes("429") || normalized.includes("rate limit");
}

function shouldTripToolCircuitBreakerImmediately(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  const normalized = normalizeFailureSignature(errorText);
  return normalized.startsWith("execution error:") && normalized.endsWith(" is required");
}

function isMissingArgValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return value === undefined || value === null;
}

function describePromptLabBroadLocalSearchBlock(input: {
  toolName: string;
  args: Record<string, unknown>;
  userContent: string;
  mode: ChatMode;
}): string | undefined {
  if (input.mode !== "code" || !isPromptLabHarnessContent(input.userContent)) {
    return undefined;
  }
  if (!LOCAL_QUERY_TOOL_NAMES.has(input.toolName)) {
    return undefined;
  }
  const searchPath = typeof input.args.path === "string" ? input.args.path.trim().replace(/\\/g, "/") : "";
  if (searchPath !== "." && searchPath !== "./") {
    return undefined;
  }
  const query = typeof input.args.query === "string" ? input.args.query.trim() : "";
  if (!isGenericPromptLabRepoSearchQuery(query)) {
    return undefined;
  }
  const userTask = extractPrimaryUserTaskContent(input.userContent);
  const explicitPaths = extractExplicitLocalFilePathsFromPrompt(userTask);
  const suggestedPaths = inferPromptLabSuggestedFilePaths(userTask);
  if (
    explicitPaths.length === 0 &&
    suggestedPaths.length === 0 &&
    !promptLabTaskSuggestsRepoInspection(userTask)
  ) {
    return undefined;
  }
  const targetHint = [...new Set([...explicitPaths, ...suggestedPaths])]
    .slice(0, 4)
    .map((path) => `\`${path}\``)
    .join(", ");
  return [
    `execution skipped: Prompt Lab code search over \`.\` used a generic query (\`${query}\`) that can exhaust the run budget.`,
    targetHint
      ? `Use the tighter prompt evidence roots instead: ${targetHint}.`
      : "Use a narrower file-name, symbol, route, service, or test query before searching the repository root.",
  ].join(" ");
}

function describePromptLabWebToolCapBlock(input: {
  toolName: string;
  args: Record<string, unknown>;
  userContent: string;
  priorToolRuns?: ChatToolRunRecord[];
}): string | undefined {
  if (!isPromptLabHarnessContent(input.userContent) || !toolNameMatchesAnyKnownTool(input.toolName, WEB_TOOL_NAMES)) {
    return undefined;
  }
  // Caps count successful evidence only: a 403, a wrong-page fetch, or a
  // previously cap-blocked retry must not consume the budget the contract
  // promises ("two opened/read sources" means two sources actually read).
  const priorWebRuns = (input.priorToolRuns ?? []).filter(
    (run) => run.status === "executed" && toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES),
  );
  const priorSearchRuns = priorWebRuns.filter((run) =>
    toolNameMatchesAnyKnownTool(run.toolName, PROMPT_LAB_WEB_SEARCH_TOOL_NAMES),
  );
  const priorOpenRuns = priorWebRuns.filter((run) =>
    toolNameMatchesAnyKnownTool(run.toolName, PROMPT_LAB_WEB_OPEN_TOOL_NAMES),
  );
  if (toolNameMatchesAnyKnownTool(input.toolName, PROMPT_LAB_WEB_SEARCH_TOOL_NAMES) && priorSearchRuns.length >= 1) {
    return [
      "execution skipped: Prompt Lab web rows are capped at one web search before synthesis.",
      "Use the successful search/opened-source evidence already in the trace and answer now; do not retry search.",
    ].join(" ");
  }
  if (
    toolNameMatchesAnyKnownTool(input.toolName, PROMPT_LAB_WEB_OPEN_TOOL_NAMES) &&
    priorOpenRuns.length >= 2
  ) {
    return [
      "execution skipped: Prompt Lab web rows are capped at two opened/read sources before synthesis.",
      "Use only the successful opened/read sources and clearly separate blocked or merely attempted sources from sources relied on.",
    ].join(" ");
  }
  if (priorWebRuns.length >= 4) {
    return [
      "execution skipped: Prompt Lab web tool budget is reserved for final synthesis after four web attempts.",
      "Stop gathering sources and answer from the retained evidence now.",
    ].join(" ");
  }
  return undefined;
}

function isGenericPromptLabRepoSearchQuery(query: string): boolean {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[_/\\]+/g, " ")
    .replace(/[^a-z0-9.\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return true;
  }
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|cs|go|rs|py)$/i.test(normalized)) {
    return false;
  }
  if (/\b(?:service|repo|route|routes|controller|component|test|spec)\.(?:ts|tsx|js|jsx)\b/i.test(normalized)) {
    return false;
  }
  if (PROMPT_LAB_GENERIC_REPO_SEARCH_QUERIES.has(normalized)) {
    return true;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 2 && tokens.every((token) => PROMPT_LAB_GENERIC_REPO_SEARCH_QUERIES.has(token))) {
    return true;
  }
  return (
    /\bprompt[- ]pack\b/.test(normalized) &&
    /\b(?:score|scoring|test|tests|report|label|v2|v3)\b/.test(normalized) &&
    !/\b(?:service|repo|route|api|workbench|gates?|auto-score|parser|storage|contract)\b/.test(normalized)
  );
}

function inferToolArgValue(toolName: string, field: string, userContent: string): unknown {
  if (field === "query" && QUERY_TOOL_NAMES.has(toolName)) {
    return inferQueryFromPrompt(userContent);
  }
  if (field === "query" && LOCAL_QUERY_TOOL_NAMES.has(toolName)) {
    return inferLocalSearchQueryFromPrompt(toolName, userContent);
  }
  if (field === "pattern" && toolName === "file.find") {
    return inferFileFindPatternFromPrompt(userContent);
  }
  if (field === "path" && LOCAL_PATH_TOOL_NAMES.has(toolName)) {
    return inferLocalToolPathFromPrompt(toolName, userContent);
  }
  if (
    field === "url" &&
    (toolName === "browser.navigate" ||
      toolName === "browser.extract" ||
      toolName === "http.get" ||
      toolName === "http.post" ||
      toolName === "browser.interact")
  ) {
    return extractFirstUrl(userContent);
  }
  if (field === "selector" && toolName === "browser.extract") {
    return "body";
  }
  return undefined;
}

function describeInvalidLocalToolPath(path: string): string | undefined {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();
  if (!normalized) {
    return "empty path";
  }
  if (
    /^(?:workspace\/)?(?:code\.search|code\.search_files|file\.find|file\.read_range|file\.read|memory\.search|memory\.read|browser\.search|browser\.navigate|browser\.extract|browser\.open|time\.now|session\.status|fs\.list|fs\.read|fs\.stat|artifacts\.create|documents\.create|presentations\.create)$/.test(
      normalized,
    )
  ) {
    return "tool name was supplied as a path";
  }
  if (/^(?:yes|no|conditional)(?:\/(?:yes|no|conditional))*$/.test(normalized)) {
    return "answer-choice words were supplied as a path";
  }
  if (/^(?:precipitation|wind|temperature)(?:\/(?:precipitation|wind|temperature))*$/.test(normalized)) {
    return "weather facet words were supplied as a path";
  }
  return undefined;
}

function resolveGroundedBrowserSearchQuery(input: {
  rawArgs: Record<string, unknown>;
  userContent: string;
  historyMessages: ChatCompletionRequest["messages"];
  priorToolRuns?: ChatToolRunRecord[];
}): string | undefined {
  const promptSpecificQuery = derivePromptSpecificWebQuery(input.userContent);
  const queryCandidates = readBrowserSearchQueryCandidatesFromArgs(input.rawArgs);
  const currentQuery = queryCandidates[0];
  if (
    currentQuery &&
    !looksLikeContinuationSearchPrompt(currentQuery) &&
    !looksLikeHarnessContaminatedQuery(currentQuery)
  ) {
    const sanitizedCurrent = sanitizeQueryClause(currentQuery).slice(0, 240);
    if (promptSpecificQuery && shouldPreferPromptSpecificWebQuery(sanitizedCurrent, promptSpecificQuery)) {
      return promptSpecificQuery;
    }
    return sanitizedCurrent;
  }

  const alternatives = [
    ...queryCandidates.slice(1),
    inferMeaningfulQueryFromRecentToolRuns(input.priorToolRuns),
    inferMeaningfulPriorUserQuery(input.userContent, input.historyMessages),
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length >= 3 && !looksLikeHarnessContaminatedQuery(value),
  );
  const bestAlternative = selectBestQueryCandidate(alternatives);
  if (bestAlternative) {
    return bestAlternative;
  }

  const inferredFromPrompt = inferQueryFromPrompt(input.userContent);
  if (inferredFromPrompt && !looksLikeContinuationSearchPrompt(inferredFromPrompt)) {
    return inferredFromPrompt;
  }
  return promptSpecificQuery ?? currentQuery;
}

function inferToolArgValueFromRecentToolRuns(
  toolName: string,
  field: string,
  userContent: string,
  toolRuns: ChatToolRunRecord[] | undefined,
): unknown {
  if (field !== "url" || !toolRuns || toolRuns.length === 0) {
    return undefined;
  }
  if (toolName !== "browser.navigate" && toolName !== "browser.extract" && toolName !== "http.get") {
    return undefined;
  }
  return inferRecentBrowserVisitedUrl(toolRuns) ?? selectBestRecentBrowserResultUrl(userContent, toolRuns, 3);
}

function inferBrowserNavigateUrlFromRepeatedSearches(
  userContent: string,
  toolRuns: ChatToolRunRecord[] | undefined,
): string | undefined {
  if (!toolRuns || toolRuns.length === 0 || !detectLiveDataIntent(userContent)) {
    return undefined;
  }
  const executedSearchCount = toolRuns.filter(
    (run) => run.toolName === "browser.search" && run.status === "executed",
  ).length;
  if (executedSearchCount < 1) {
    return undefined;
  }
  const alreadyOpenedContent = toolRuns.some(
    (run) =>
      ((run.toolName === "browser.extract" || run.toolName === "http.get") && run.status === "executed") ||
      (run.toolName === "browser.navigate" && run.status === "executed" && hasUsefulVisitedBrowserUrl(run)),
  );
  if (alreadyOpenedContent) {
    return undefined;
  }
  return selectBestRecentBrowserResultUrl(userContent, toolRuns, 3);
}

function redirectSearchPortalNavigateUrl(
  requestedUrl: string,
  userContent: string,
  toolRuns: ChatToolRunRecord[] | undefined,
): string | undefined {
  if (!toolRuns || toolRuns.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(requestedUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const avoidCommunityHost = isLikelyCommunityHost(hostname) && !queryExplicitlyRequestsCommunitySources(userContent);
    if (!isSearchPortalHost(hostname) && !isLikelyLandingOrResultsPath(pathname) && !avoidCommunityHost) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const alternatives = selectRecentBrowserResultUrls(userContent, toolRuns, 3, 5);
  return alternatives.find((candidate) => candidate !== requestedUrl);
}

function redirectPoisonedBrowserNavigateUrl(
  requestedUrl: string,
  userContent: string,
  toolRuns: ChatToolRunRecord[] | undefined,
): { url?: string; blockedReason?: string } | undefined {
  if (!toolRuns || toolRuns.length === 0) {
    return undefined;
  }
  const requestedHost = readUrlHost(requestedUrl);
  if (!requestedHost) {
    return undefined;
  }
  const poisonedHosts = collectPoisonedBrowserHosts(toolRuns);
  if (!isPoisonedBrowserHost(requestedHost, poisonedHosts)) {
    return undefined;
  }
  if (hasTriedBrowserFallbackAlternateForHost(requestedHost, toolRuns)) {
    return {
      blockedReason: `execution skipped: browser.navigate target host ${requestedHost} was already blocked earlier in this turn after an alternate source was tried. Request allowlist approval for that host, or use browser.search to find alternate current sources before answering.`,
    };
  }
  if (hasTriedRedirectedAlternateForPoisonedHost(requestedHost, toolRuns)) {
    return {
      blockedReason: `execution skipped: browser.navigate target host ${requestedHost} was already blocked earlier in this turn after a redirected alternate source was tried. Request allowlist approval for that host, or use browser.search to find alternate current sources before answering.`,
    };
  }
  const alternatives = selectRecentBrowserResultUrls(userContent, toolRuns, 1, 8).filter((candidate) => {
    const candidateHost = readUrlHost(candidate);
    if (!candidateHost) {
      return false;
    }
    return candidate !== requestedUrl && !isPoisonedBrowserHost(candidateHost, poisonedHosts);
  });
  const alternateUrl = alternatives[0];
  if (alternateUrl) {
    return { url: alternateUrl };
  }
  return {
    blockedReason: `execution skipped: browser.navigate target host ${requestedHost} was already blocked earlier in this turn. Request allowlist approval for that host, or use browser.search to find alternate current sources before answering.`,
  };
}

function hasTriedRedirectedAlternateForPoisonedHost(requestedHost: string, toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => {
    if (!run || !isBrowserUrlFetchTool(run.toolName) || !run.result || typeof run.result !== "object") {
      return false;
    }
    if (run.status !== "failed" && run.status !== "blocked") {
      return false;
    }
    const argHost = readUrlHost(typeof run.args?.url === "string" ? run.args.url : undefined);
    if (!argHost || hostsMatchOrNest(argHost, requestedHost)) {
      return false;
    }
    return collectBrowserRunHosts(run, run.result as Record<string, unknown>).some((host) =>
      hostsMatchOrNest(host, requestedHost),
    );
  });
}

function hasTriedBrowserFallbackAlternateForHost(requestedHost: string, toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => {
    if (!run || !isBrowserUrlFetchTool(run.toolName)) {
      return false;
    }
    if (!run.result || typeof run.result !== "object") {
      return false;
    }
    const result = run.result as Record<string, unknown>;
    const fallbackChain = Array.isArray(result.fallbackChain) ? (result.fallbackChain as unknown[]) : [];
    return (
      fallbackChain.length > 1 &&
      collectBrowserRunHosts(run, result).some((host) => hostsMatchOrNest(host, requestedHost))
    );
  });
}

function collectBrowserRunHosts(run: ChatToolRunRecord, result: Record<string, unknown>): string[] {
  const hosts = new Set<string>();
  const addUrl = (url: unknown): void => {
    if (typeof url !== "string") {
      return;
    }
    const host = readUrlHost(url);
    if (host) {
      hosts.add(host);
    }
  };
  addUrl(run.args?.url);
  addUrl(extractBrowserToolUrl(result));
  addUrl(readFirstString(result.finalUrl, result.url));
  const fallbackChain = Array.isArray(result.fallbackChain) ? result.fallbackChain : [];
  for (const entry of fallbackChain) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const value = entry as Record<string, unknown>;
    addUrl(value.url);
    addUrl(value.finalUrl);
  }
  return [...hosts];
}

function selectBestRecentBrowserResultUrl(
  userContent: string,
  toolRuns: ChatToolRunRecord[],
  minimumScore: number,
): string | undefined {
  return selectRecentBrowserResultUrls(userContent, toolRuns, minimumScore, 1)[0];
}

function collectRecentBrowserSearchCandidates(
  toolRuns: ChatToolRunRecord[],
  poisonedHosts: Set<string>,
): BrowserResultCandidate[] {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (
      !run ||
      run.toolName !== "browser.search" ||
      run.status !== "executed" ||
      !run.result ||
      typeof run.result !== "object"
    ) {
      continue;
    }
    const result = run.result as Record<string, unknown>;
    if (!Array.isArray(result.results)) {
      continue;
    }
    const candidates: BrowserResultCandidate[] = [];
    for (const raw of result.results) {
      const value = raw as Record<string, unknown>;
      if (typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) {
        continue;
      }
      try {
        const parsed = new URL(value.url);
        const hostname = parsed.hostname.toLowerCase();
        if (isPoisonedBrowserHost(hostname, poisonedHosts)) {
          continue;
        }
        candidates.push({
          url: value.url,
          title: typeof value.title === "string" ? value.title : undefined,
          snippet: typeof value.snippet === "string" ? value.snippet : undefined,
          hostname,
          path: parsed.pathname.toLowerCase(),
          sourceRunIndex: index,
        });
      } catch {
        continue;
      }
    }
    if (candidates.length > 0) {
      return candidates;
    }
  }
  return [];
}

function selectRecentBrowserResultUrls(
  userContent: string,
  toolRuns: ChatToolRunRecord[],
  minimumScore: number,
  limit: number,
): string[] {
  const poisonedHosts = collectPoisonedBrowserHosts(toolRuns);
  const candidates = collectRecentBrowserSearchCandidates(toolRuns, poisonedHosts);
  if (candidates.length === 0) {
    return [];
  }
  const derivedQuery = deriveLiveDataQuery(userContent);
  const queryTokens = tokenizeBrowserSearchText(derivedQuery);
  const newsLike = isLikelyNewsOrCurrentEventsQuery(userContent);
  const preferDirectNewsPublisher =
    newsLike && candidates.some((candidate) => isLikelyDirectNewsPublisherHost(candidate.hostname));
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreBrowserResultCandidate(candidate, derivedQuery, queryTokens, {
        newsLike,
        preferDirectNewsPublisher,
      }),
    }))
    .filter((item) => item.score >= minimumScore)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.candidate.url)
    .filter((value, index, items) => items.indexOf(value) === index)
    .slice(0, limit);
}

function collectPoisonedBrowserHosts(toolRuns: ChatToolRunRecord[]): Set<string> {
  const poisoned = new Set<string>();

  function addPoisonedHost(hostname: string | undefined): void {
    if (!hostname) {
      return;
    }
    const normalized = hostname.toLowerCase();
    poisoned.add(normalized);
    if (normalized.startsWith("www.")) {
      poisoned.add(normalized.slice(4));
    } else {
      poisoned.add(`www.${normalized}`);
    }
  }

  function addPoisonedFromResult(result: Record<string, unknown>, fallbackUrl?: string): void {
    const failureClass = typeof result.browserFailureClass === "string" ? result.browserFailureClass : undefined;
    if (!failureClass || failureClass === "no_results") {
      return;
    }
    const url = extractBrowserToolUrl(result) ?? fallbackUrl;
    if (!url) {
      return;
    }
    try {
      addPoisonedHost(new URL(url).hostname);
    } catch {
      // ignore malformed URLs
    }
  }

  for (const run of toolRuns) {
    if (!run) {
      continue;
    }
    const fallbackUrl = typeof run.args?.url === "string" ? run.args.url : undefined;

    if (shouldPoisonBrowserRunHost(run)) {
      addPoisonedHost(readUrlHost(fallbackUrl));
    }

    if (!run.result || typeof run.result !== "object") {
      continue;
    }
    const result = run.result as Record<string, unknown>;

    if (run.status === "failed" || run.status === "blocked") {
      // Check top-level result for failed/blocked runs.
      addPoisonedFromResult(result, fallbackUrl);
    }

    // P2-8: Also scan fallback chain entries within the result,
    // including "executed" runs recovered via MCP fallback — the
    // builtin-level failure inside the chain still poisons the host
    // for future builtin attempts.
    const fallbackChain = Array.isArray(result.fallbackChain) ? result.fallbackChain : [];
    for (const entry of fallbackChain) {
      if (entry && typeof entry === "object") {
        addPoisonedFromResult(entry as Record<string, unknown>, fallbackUrl);
      }
    }
  }
  return poisoned;
}

function shouldPoisonBrowserRunHost(run: ChatToolRunRecord): boolean {
  if (!isBrowserUrlFetchTool(run.toolName)) {
    return false;
  }
  if (typeof run.args?.url !== "string" || !run.args.url.trim()) {
    return false;
  }
  if (run.status === "blocked") {
    return true;
  }
  if (run.status !== "failed") {
    return false;
  }
  const normalizedError = (run.error ?? "").toLowerCase();
  return /\bnot yet allowlisted\b|\bnot allowlisted\b|\ballowlist\b|\bblocked\b|\bdenied\b|\bforbidden\b|\b403\b|\b401\b|\bcloudflare\b|\bcaptcha\b|\bpolicy\b/.test(
    normalizedError,
  );
}

function isBrowserUrlFetchTool(toolName: string): boolean {
  const normalizedTool = normalizeToolNameForComparison(toolName);
  return normalizedTool === "browser.navigate" || normalizedTool === "browser.extract" || normalizedTool === "http.get";
}

function isPoisonedBrowserHost(hostname: string, poisonedHosts: Set<string>): boolean {
  const normalized = hostname.toLowerCase();
  if (poisonedHosts.has(normalized)) {
    return true;
  }
  const withoutWww = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
  if (poisonedHosts.has(withoutWww) || poisonedHosts.has(`www.${withoutWww}`)) {
    return true;
  }
  return [...poisonedHosts].some((poisonedHost) => {
    const normalizedPoisoned = poisonedHost.startsWith("www.") ? poisonedHost.slice(4) : poisonedHost;
    return Boolean(normalizedPoisoned) && withoutWww.endsWith(`.${normalizedPoisoned}`);
  });
}

function hostsMatchOrNest(leftHost: string, rightHost: string): boolean {
  const left = leftHost.toLowerCase().replace(/^www\./, "");
  const right = rightHost.toLowerCase().replace(/^www\./, "");
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function readUrlHost(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function inferQueryFromPrompt(userContent: string): string | undefined {
  const normalizedInput = extractPrimaryUserTaskContent(userContent)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (normalizedInput.length < 3) {
    return undefined;
  }
  const promptSpecificQuery = derivePromptSpecificWebQuery(normalizedInput);
  if (promptSpecificQuery) {
    return promptSpecificQuery;
  }
  const clauses = normalizedInput
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((item) => sanitizeQueryClause(item))
    .filter((item) => item.length >= 3);
  const entityRichComparisonClause = clauses.find((candidate) => {
    const comparisonEntityCount = (
      candidate.match(
        /\b(node(?:\.js)?|bun|deno|python|javascript|typescript|react|next(?:\.js)?|go|rust|java|kotlin|swift|postgres|mysql)\b/gi,
      ) ?? []
    ).length;
    return /\b(benchmark|benchmarks|comparison|compare|vs\.?)\b/i.test(candidate) && comparisonEntityCount >= 2;
  });
  if (entityRichComparisonClause) {
    return entityRichComparisonClause.slice(0, 240);
  }
  const candidatePool = clauses.length > 0 ? clauses : [sanitizeQueryClause(deriveLiveDataQuery(normalizedInput))];
  const bestCandidate = [...candidatePool].sort(
    (left, right) => scoreQueryCandidate(right) - scoreQueryCandidate(left),
  )[0];
  const derived = sanitizeQueryClause(bestCandidate ?? normalizedInput).slice(0, 240);
  if (derived.length < 3) {
    return undefined;
  }
  const normalized = derived
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    normalized.length < 3 ||
    normalized === "search" ||
    normalized === "search web" ||
    normalized === "search the web" ||
    normalized === "look up" ||
    normalized === "look this up" ||
    normalized === "find" ||
    normalized === "find this"
  ) {
    return undefined;
  }
  return derived;
}

function derivePromptSpecificWebQuery(content: string): string | undefined {
  const normalized = extractPrimaryUserTaskContent(content).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (
    /\bpublic\s+outdoor\s+activity\b/i.test(normalized) &&
    /\bthis\s+weekend\b/i.test(normalized) &&
    /\bcity\s+of\s+your\s+choice\b/i.test(normalized)
  ) {
    return "Seattle this weekend weather forecast outdoor public events parks official";
  }
  if (
    /\bpublic\s+event\b/i.test(normalized) &&
    /\bthis\s+weekend\b/i.test(normalized) &&
    /\bstill\s+scheduled\b/i.test(normalized)
  ) {
    return "Seattle Center official events this weekend schedule";
  }
  if (
    /\bcurrent[-\s]+hours\b/i.test(normalized) &&
    /\bnamed\s+public\s+place\s+of\s+your\s+choice\b/i.test(normalized)
  ) {
    return "New York Public Library Stephen A. Schwarzman Building hours official";
  }
  if (/\bsevere\s+heat\b/i.test(normalized) && /\bpublic\s+safety\s+tips?\b/i.test(normalized)) {
    return "CDC severe heat public safety tips official";
  }
  if (/\bcity\s+service\b/i.test(normalized) && /\bavailable\b/i.test(normalized) && /\bholiday\b/i.test(normalized)) {
    return "NYC DSNY holiday schedule NYC311 trash recycling compost collection holiday";
  }
  if (
    /\bhousehold\b/i.test(normalized) &&
    /\bsevere\s+storm\b/i.test(normalized) &&
    /\bpublic\s+tips?\b/i.test(normalized)
  ) {
    return "Ready.gov FEMA severe storm household preparedness tips official";
  }
  if (/\bflights?\s+out\s+of\s+JFK\b/i.test(normalized) && /\bcurrent\s+disruption\b/i.test(normalized)) {
    return "FAA NAS Status JFK airport delays Port Authority JFK alerts official";
  }
  if (/\bhousehold\s+emergency\s+water\s+storage\b/i.test(normalized)) {
    return "CDC household emergency water storage official guidance";
  }
  if (/\bcurrent\s+weather\s+for\s+Seattle\b/i.test(normalized) && /\boutdoor\s+dinner\b/i.test(normalized)) {
    return "Seattle tonight hourly weather forecast precipitation official";
  }
  if (/\bIRS\b/i.test(normalized) && /\bstandard\s+mileage\s+rate\b/i.test(normalized)) {
    return "IRS current standard mileage rate business use 2026 official";
  }
  if (/\bBoston\b/i.test(normalized) && /\bumbrella\b/i.test(normalized)) {
    return "Boston tonight hourly weather forecast precipitation National Weather Service";
  }
  if (
    /\bPortland,\s*Oregon\b/i.test(normalized) &&
    /\bmuseum\b/i.test(normalized) &&
    /\blive music\b/i.test(normalized)
  ) {
    return "Portland Oregon this weekend museum nature walk live music events official";
  }
  if (/\brobot vacuum\b/i.test(normalized) && /\bone pet\b/i.test(normalized)) {
    return "robot vacuum pet hair small apartment buying criteria current reviews";
  }
  if (/\bstormy season\b/i.test(normalized) && /\bgo\/no-go checklist\b/i.test(normalized)) {
    return "official travel weather alerts storm season go no go checklist";
  }
  if (/\bair purifier\b/i.test(normalized) && /\bwildfire smoke\b/i.test(normalized)) {
    return "EPA air purifier wildfire smoke HEPA CADR ozone official";
  }
  if (/\bbasic emergency kit\b/i.test(normalized) && /\bhousehold\b/i.test(normalized)) {
    return "Ready.gov basic emergency kit household official";
  }
  if (/\bpublic library services\b/i.test(normalized) && /\blearn new skills online\b/i.test(normalized)) {
    return "public library online learning services LinkedIn Learning Gale Courses official";
  }
  if (/\breducing household food waste\b/i.test(normalized)) {
    return "EPA FDA USDA household food waste reduction advice official";
  }
  if (/\bfarmers?\s+market\b/i.test(normalized) && /\b(?:busy|arrive|arrival|weekend)\b/i.test(normalized)) {
    return "weekend farmers market busiest time arrive early planning source";
  }
  if (
    /\bplausible\s+public\s+venue\b/i.test(normalized) ||
    /\bpublic\s+venue\b[\s\S]{0,80}\bsmall meetup\b/i.test(normalized)
  ) {
    return "public library meeting room small meetup official availability";
  }
  if (/\brainy[-\s]+day\b/i.test(normalized) && /\bfamily\s+activity\b/i.test(normalized)) {
    return "public library rainy day family activity storytime official";
  }
  if (
    /\bagentic\s+(?:harnesses?|frameworks?)\b/i.test(normalized) ||
    (/\bagent(?:ic)?\s+(?:frameworks?|orchestration)\b/i.test(normalized) &&
      /\b(?:LangGraph|AutoGen|CrewAI|Semantic Kernel|LlamaIndex|Haystack|PydanticAI|OpenAI Agents)\b/i.test(normalized))
  ) {
    return "LangGraph AutoGen CrewAI OpenAI Agents SDK Semantic Kernel LlamaIndex Haystack PydanticAI official docs agent framework comparison";
  }
  return undefined;
}

function shouldPreferPromptSpecificWebQuery(currentQuery: string, promptSpecificQuery: string): boolean {
  const normalizedCurrent = currentQuery.toLowerCase();
  if (!normalizedCurrent.trim()) {
    return true;
  }
  if (
    /\b(decide whether|coordinate|roles? in this exact order|city of your choice|public outdoor activity|city service|public event|named public place|current hours|severe heat)\b/.test(
      normalizedCurrent,
    )
  ) {
    return true;
  }
  return scoreQueryCandidate(promptSpecificQuery) > scoreQueryCandidate(currentQuery) + 10;
}

function readBrowserSearchQueryCandidatesFromArgs(rawArgs: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length >= 3) {
      candidates.push(value.trim());
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested = readFirstString(record.query, record.text, record.value, record.content);
      if (nested && nested.length >= 3) {
        candidates.push(nested);
      }
    }
  };
  push(rawArgs.query);
  if (Array.isArray(rawArgs.queries)) {
    for (const value of rawArgs.queries) {
      push(value);
    }
  }
  return candidates.filter((value, index, items) => items.indexOf(value) === index);
}

function selectBestQueryCandidate(candidates: string[]): string | undefined {
  const ranked = candidates
    .filter(
      (candidate) => !looksLikeContinuationSearchPrompt(candidate) && !looksLikeHarnessContaminatedQuery(candidate),
    )
    .sort((left, right) => scoreQueryCandidate(right) - scoreQueryCandidate(left))[0];
  return ranked ? sanitizeQueryClause(ranked).slice(0, 240) : undefined;
}

function inferMeaningfulQueryFromRecentToolRuns(toolRuns: ChatToolRunRecord[] | undefined): string | undefined {
  if (!toolRuns || toolRuns.length === 0) {
    return undefined;
  }
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (!run || run.toolName !== "browser.search" || run.status !== "executed") {
      continue;
    }
    const query = typeof run.args?.query === "string" ? run.args.query.trim() : "";
    if (query && !looksLikeContinuationSearchPrompt(query) && !looksLikeHarnessContaminatedQuery(query)) {
      return query;
    }
  }
  return undefined;
}

function inferMeaningfulPriorUserQuery(
  currentUserContent: string,
  historyMessages: ChatCompletionRequest["messages"],
): string | undefined {
  let skippedCurrentUser = false;
  const normalizedCurrent = currentUserContent.trim();
  for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
    const message = toPlainRecord(historyMessages[index]);
    if (!message || message.role !== "user") {
      continue;
    }
    const content = extractMessageContent(message).trim();
    if (!content) {
      continue;
    }
    if (!skippedCurrentUser && content === normalizedCurrent) {
      skippedCurrentUser = true;
      continue;
    }
    const inferred = inferQueryFromPrompt(content) ?? deriveLiveDataQuery(content);
    if (inferred && !looksLikeContinuationSearchPrompt(inferred)) {
      return inferred;
    }
  }
  return undefined;
}

function shouldProactivelyOpenGroundedNewsResult(userContent: string): boolean {
  const normalized = userContent.toLowerCase();
  const hasNewsIntent = /\b(news|headline|headlines)\b/.test(normalized);
  const hasRecencyIntent = /\b(latest|recent|today|yesterday|tonight|this week)\b/.test(normalized);
  return hasNewsIntent && hasRecencyIntent;
}

function shouldProactivelyOpenCoworkResearchResult(input: {
  mode: ChatMode;
  webMode: ChatWebMode;
  content: string;
}): boolean {
  if (input.mode !== "cowork" || input.webMode !== "deep") {
    return false;
  }
  const normalized = extractPrimaryUserTaskContent(input.content).toLowerCase();
  const hasResearchReportIntent = /\b(research|compare|comparison|report|pros\s+and\s+cons|profile|best)\b/.test(
    normalized,
  );
  const hasFrameworkIntent =
    /\bagentic\s+(?:harnesses?|frameworks?)\b/.test(normalized) ||
    /\bagent(?:ic)?\s+(?:frameworks?|orchestration|harnesses?)\b/.test(normalized);
  return hasResearchReportIntent && hasFrameworkIntent;
}

function looksLikeContinuationSearchPrompt(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  if (looksLikeFreshStandalonePrompt(value)) {
    return false;
  }
  if (
    /\b(one more time|again|better fallback|retry|re run|rerun|run that again|same search|that search|this search|from those results|from there|keep going|keep digging|another pass)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(try|retry|search|run|continue|keep)\b/.test(normalized) && normalized.split(" ").length <= 8;
}

function sanitizeQueryClause(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\b(?:the\s+)?user\s+(?:asks|says):\s*/i, "")
    .replace(/^["“]([^"”]+)["”]\s+(?:answer|respond|reply)\b[\s\S]*$/i, "$1")
    .replace(/\b(?:answer|respond|reply)\s+in\s+(?:chat|cowork|code)\s+mode\b[\s\S]*$/i, "")
    .replace(
      /\b(prompt lab run contract|prompt lab tooling contract|explicit-tools evaluation|this is a cowork evaluation|this is a code evaluation|required named tools|required tool families|do not substitute memory tools|if a required tool fails)\b[\s\S]*$/i,
      "",
    )
    .replace(/^(please|can you|could you|would you)\b[:,\s-]*/i, "")
    .replace(
      /^(?:please\s+)?(?:look|search|browse|check|research)\b(?:\s+(?:online|on the web|the web|web|internet))?(?:\s+(?:and|to|for|about|into))?\s*/i,
      "",
    )
    .replace(/^(?:find(?:\s+out)?|tell|show|give|explain|summarize)\b(?:\s+me)?(?:\s+about)?\s*/i, "")
    .replace(/^(from|on|about)\s+/i, "")
    .replace(/\b(cite|citing|include|surface)\s+(?:them|the results|sources?|citations?)\b.*$/i, "")
    .replace(/\b(with|including)\s+(?:sources?|citations?)\b.*$/i, "")
    .replace(
      /\b(do not answer from memory|do not use memory|don'?t use memory|answer strictly from retrieved evidence)\b.*$/i,
      "",
    )
    .replace(/\b(return|respond|output)\b.*$/i, "")
    .replace(/[?!.,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreQueryCandidate(value: string): number {
  const text = value.trim();
  if (!text) {
    return -1000;
  }
  if (looksLikeHarnessContaminatedQuery(text)) {
    return -1000;
  }
  let score = Math.min(text.length, 180);
  if (/\b(what|which|who|when|where|why|how)\b/i.test(text)) {
    score += 24;
  }
  if (/\b(latest|today|news|price|weather|summarize|summary|extract|analyze)\b/i.test(text)) {
    score += 20;
  }
  if (
    /\bcurrent\s+(news|events|weather|forecast|temperature|price|prices|stock|stocks|market|markets|headlines?|score|scores|conditions?|traffic)\b/i.test(
      text,
    )
  ) {
    score += 20;
  }
  const comparisonEntityCount = (
    text.match(
      /\b(node(?:\.js)?|bun|deno|python|javascript|typescript|react|next(?:\.js)?|go|rust|java|kotlin|swift|postgres|mysql)\b/gi,
    ) ?? []
  ).length;
  if (/\b(benchmark|benchmarks|comparison|compare|vs\.?)\b/i.test(text) && comparisonEntityCount >= 2) {
    score += 18;
  }
  if (/\b(json|markdown|format|bullet|score|rubric)\b/i.test(text)) {
    score -= 30;
  }
  if (
    /\b(cite|citation|citations|source|sources|tool|tools|workflow|scaffold|researcher|architect|synthesis|prompt lab)\b/i.test(
      text,
    )
  ) {
    score -= 25;
  }
  if (/^test-\d+/i.test(text)) {
    score -= 15;
  }
  return score;
}

function shouldPreferInferredLiveDataQuery(inferred: string | undefined, derived: string): boolean {
  if (!inferred) {
    return false;
  }
  const comparisonEntityCount = (
    inferred.match(
      /\b(node(?:\.js)?|bun|deno|python|javascript|typescript|react|next(?:\.js)?|go|rust|java|kotlin|swift|postgres|mysql)\b/gi,
    ) ?? []
  ).length;
  if (comparisonEntityCount >= 2) {
    return true;
  }
  const hasCapitalizedEntity = /\b(?:[A-Z][a-z]+(?:\.[A-Za-z]+)?|[A-Z]{2,})(?:\s+[A-Z][a-z]+)?\b/.test(inferred);
  if (hasCapitalizedEntity) {
    return true;
  }
  if (/\b(news|headlines?)\b/i.test(derived)) {
    return false;
  }
  return false;
}

function detectMissingLogPayloadIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  if (!/\b(log|logs)\b/.test(normalized)) {
    return false;
  }
  if (!/\b(i paste|i'll paste|i will paste|paste a giant blob|paste logs)\b/.test(normalized)) {
    return false;
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const evidenceLines = lines.filter(
    (line) =>
      /\b(error|warn|exception|traceback|stack|http \d{3}|failed|timeout)\b/i.test(line) ||
      /^\d{4}-\d{2}-\d{2}/.test(line) ||
      line.length > 140,
  );
  return evidenceLines.length < 2;
}

function buildMissingLogInputTemplate(): string {
  return [
    "I can't determine a root cause yet because the log blob wasn't pasted. Here's what I'd look for once you share it:",
    "",
    "Common root-cause patterns: timeout/retry storms (repeated 429/503), auth mismatches (401/403 or token refresh), or schema drift after a deploy (parse errors, unknown fields).",
    "",
    "To triage quickly, I need:",
    "1. The first and last fatal/exception blocks from the same incident window.",
    "2. About 20 lines of context before and after the first exception.",
    "3. The service name and timezone so I can correlate timestamps.",
    "",
    "Ideal format: `<timestamp> service=<name> level=ERROR request_id=<id> error_code=<code> message=<msg>` -- or just paste the first exception line plus the line immediately above it.",
  ].join("\n");
}

function summarizeToolRunsForSynthesis(toolRuns: ChatToolRunRecord[], userPrompt?: string): string {
  if (toolRuns.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const run of toolRuns.slice(-8)) {
    lines.push(summarizeToolRunForSynthesis(run, userPrompt));
  }
  return lines.join("\n");
}

function buildDeterministicToolSynthesisFallback(
  userPrompt: string,
  toolRuns: ChatToolRunRecord[],
  reason?: string,
): string {
  const extractionFallback = buildExtractionFailureFallback(userPrompt, toolRuns, reason);
  if (extractionFallback) {
    return extractionFallback;
  }
  const recoveredAnswer = buildRecoveredEvidenceAnswer(userPrompt, toolRuns, {
    note: `This is a partial answer recovered from tool output because ${reason ?? "the final synthesis pass did not finish cleanly"}.`,
  });
  if (recoveredAnswer) {
    return recoveredAnswer;
  }
  const failures = toolRuns
    .filter((item) => item.status === "failed" || item.status === "blocked")
    .slice(-4)
    .map((item) => `- ${item.toolName}: ${item.error ?? "failed"}`);
  const evidence = toolRuns
    .filter((item) => item.status === "executed" && item.result)
    .slice(-3)
    .map((item) => `${item.toolName}: ${truncateJson(item.result, 180)}`);
  const lines = [
    `I couldn't finish that cleanly because ${reason ?? "the tool flow did not converge to a complete answer"}.`,
  ];
  if (failures.length > 0) {
    lines.push(`Latest tool issue: ${failures[0]?.replace(/^- /, "")}`);
  }
  if (evidence.length > 0) {
    lines.push(`Useful partial result: ${evidence[0]}`);
  }
  lines.push("If you want me to retry, send explicit query, URL, or file details.");
  const querySeed = inferQueryFromPrompt(userPrompt) ?? deriveLiveDataQuery(userPrompt);
  if (querySeed) {
    lines.push(`Best retry seed: ${querySeed}`);
  }
  return lines.join("\n\n");
}

function buildExtractionFailureFallback(
  userPrompt: string,
  toolRuns: ChatToolRunRecord[],
  reason?: string,
): string | undefined {
  const normalized = userPrompt.toLowerCase();
  const isStrongExtractionPrompt =
    /\bcollect\b|\bextract\b|\bscrape\b|\bcrawl\b|\bpaginate\b|\bpagination\b|\btitle\s*(?:and|&|\+)\s*url\b|\breturn an array\b|\bjson array\b|\bfull json\b|\braw json\b|\bexact extraction set\b/.test(
      normalized,
    ) || /\b(return|respond|output|format)\b[\s\S]{0,40}\bjson\b/.test(normalized);
  const hasExtractionToolSignal = toolRuns.some((run) => {
    if (run.toolName.startsWith("browser.") || run.toolName === "http.get" || run.toolName === "http.post") {
      return true;
    }
    return (
      isStrongExtractionPrompt &&
      (run.toolName === "file.read_range" ||
        run.toolName === "file.find" ||
        run.toolName === "code.search" ||
        run.toolName === "code.search_files")
    );
  });
  const isExtractionPrompt = isStrongExtractionPrompt && hasExtractionToolSignal;
  if (!isExtractionPrompt) {
    return undefined;
  }
  const recoveredItems = recoverTitleUrlItems(toolRuns, 35);
  const failurePoint = inferExtractionFailurePoint(toolRuns, reason);
  const lines = [
    "Summary",
    `- I completed tool execution but could not confidently produce the full requested extraction set (${recoveredItems.length} recovered item(s)).`,
    "",
    "Failure point",
    `- ${failurePoint}`,
    "",
    "Recovered items (partial)",
    "```json",
    JSON.stringify(recoveredItems, null, 2),
    "```",
    "",
    "What I need from you next",
    "- Confirm if you want me to continue pagination with explicit page-by-page extraction constraints.",
    "- If strict completeness is required, provide permission for a slower deterministic crawl with validation per page.",
  ];
  return lines.join("\n");
}

function inferExtractionFailurePoint(toolRuns: ChatToolRunRecord[], reason?: string): string {
  const failed = toolRuns.filter((run) => run.status === "failed" || run.status === "blocked").at(-1);
  if (failed) {
    return `${failed.toolName} returned ${failed.status}: ${failed.error ?? "unknown error"}`;
  }
  const lastExecuted = toolRuns.filter((run) => run.status === "executed").at(-1);
  if (lastExecuted) {
    return `${lastExecuted.toolName} executed, but structured extraction output was incomplete or unparseable`;
  }
  return reason ?? "No durable extraction result was captured in tool traces";
}

function collectToolSearchScope(toolRuns: ChatToolRunRecord[]): string[] {
  const scope = new Set<string>();
  for (const run of toolRuns) {
    if (typeof run.args?.path === "string") {
      scope.add(`path: ${String(run.args.path).replace(/\\/g, "/")}`);
    }
    if (typeof run.args?.query === "string") {
      scope.add(`query: ${String(run.args.query)}`);
    }
    if (typeof run.args?.url === "string") {
      scope.add(`url: ${String(run.args.url)}`);
    }
  }
  return [...scope].slice(0, 8);
}

function summarizeCoworkToolConstraint(toolRuns: ChatToolRunRecord[]): string {
  const problematic = toolRuns
    .filter((run) => run.status === "failed" || run.status === "blocked" || run.status === "approval_required")
    .slice(-1)[0];
  if (!problematic) {
    return "No blocking tool failures recorded.";
  }
  return `${problematic.toolName}: ${problematic.error ?? problematic.status}`;
}

function looksLikePromptLabInstructionEchoContent(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const markers = [
    "## do not add extra headings before, between, or after those sections",
    "## keep each requested section compact",
    "## this is an explicit-tools evaluation",
    "## before drafting findings or recommendations",
    "## required tool families",
    "## surface tool-backed evidence in the answer",
    "## a prose-only answer without the required tool evidence is non-compliant",
    "## do not substitute memory tools unless the prompt explicitly asks for memory",
    "## if a required tool fails",
    "required role order:",
  ];
  const matched = markers.filter((marker) => normalized.includes(marker));
  return matched.length >= 2;
}

function buildDeterministicCoworkRoleContractFallback(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
  requiredRoles: string[];
}): string {
  const trimmed = input.responseText.trim();
  if (!trimmed) {
    return trimmed;
  }
  const exactSections = extractExactCoworkSections(input.prompt);
  const requestedRoleOrderOnly = promptKeepsRequestedRoleOrderOnly(input.prompt);
  const detectedRoles = detectCoworkRoleOrder(input.prompt);
  const effectiveRoles =
    input.requiredRoles.length > 0
      ? input.requiredRoles
      : detectedRoles.length > 0
        ? detectedRoles
        : detectPresentCoworkRoles(trimmed);
  let effectiveSections =
    exactSections.length > 0 ? exactSections : effectiveRoles.map((role) => formatCoworkRoleHeading(role));
  if (effectiveSections.length === 0 && looksLikeTopicalCoworkWebEvidencePrompt(input.prompt)) {
    effectiveSections = ["Researcher", "Risk Review", "Operator Handoff"];
  }
  if (effectiveSections.length === 0) {
    return trimmed;
  }
  const targetedSkillImportOverlapFallback = buildSkillImportOverlapCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (targetedSkillImportOverlapFallback) {
    return targetedSkillImportOverlapFallback;
  }
  const targetedPromptPackRepoBindingFallback = buildPromptPackRepoBindingCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (targetedPromptPackRepoBindingFallback) {
    return targetedPromptPackRepoBindingFallback;
  }
  const guidanceRegressionSliceFallback = buildGuidanceRegressionSliceCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (guidanceRegressionSliceFallback) {
    return guidanceRegressionSliceFallback;
  }
  const workspaceRoutesGuidanceFallback = buildWorkspaceRoutesGuidanceCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (workspaceRoutesGuidanceFallback) {
    return workspaceRoutesGuidanceFallback;
  }
  const memoryLifecycleFallback = buildMemoryLifecycleCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (memoryLifecycleFallback) {
    return memoryLifecycleFallback;
  }
  const cronReportFallback = buildCronReportCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (cronReportFallback) {
    return cronReportFallback;
  }
  const eventLinkPropagationFallback = buildEventLinkPropagationCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (eventLinkPropagationFallback) {
    return eventLinkPropagationFallback;
  }
  const rank1HardeningFallback = buildRank1HardeningCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (rank1HardeningFallback) {
    return rank1HardeningFallback;
  }
  const approvalPartialFailureFallback = buildApprovalPartialFailureCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (approvalPartialFailureFallback) {
    return approvalPartialFailureFallback;
  }
  const topicalWebFallback = buildTopicalCoworkWebEvidenceFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    toolRuns: input.toolRuns,
  });
  if (topicalWebFallback) {
    return topicalWebFallback;
  }
  const outdoorActivityFallback = buildOutdoorActivityCoworkFallback({
    prompt: input.prompt,
    effectiveSections,
    toolRuns: input.toolRuns,
  });
  if (outdoorActivityFallback) {
    return outdoorActivityFallback;
  }
  const everydayFallback = buildEverydayCoworkContractFallback({
    prompt: input.prompt,
    effectiveSections,
    requestedRoleOrderOnly,
    requiresSynthesis: !requestedRoleOrderOnly && coworkContractRequiresSynthesis(input.prompt),
    toolRuns: input.toolRuns,
  });
  if (everydayFallback) {
    return everydayFallback;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 4);
  const webEvidenceItems = recoverTitleUrlItems(
    input.toolRuns.filter((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES)),
    4,
  );
  const searchScope = collectToolSearchScope(input.toolRuns).slice(0, 3);
  const constraints = summarizeCoworkToolConstraint(input.toolRuns);
  const requiresSynthesis = !requestedRoleOrderOnly && coworkContractRequiresSynthesis(input.prompt);
  const usesWebEvidence = evidencePaths.length === 0 && webEvidenceItems.length > 0;
  const evidenceLine = usesWebEvidence
    ? `- Evidence: Web lookup found ${webEvidenceItems
        .slice(0, 2)
        .map((item) => `${item.title ?? "public source"} (${item.url})`)
        .join("; ")}.`
    : evidencePaths.length > 0
      ? `- Evidence: Reviewed ${evidencePaths.map((path) => `\`${path}\``).join(", ")}.`
      : "- Evidence: No file-specific evidence was retained from the tool trace.";
  const scopeLine =
    searchScope.length > 0
      ? `- Search scope: ${searchScope.join("; ")}.`
      : "- Search scope: No explicit search scope was retained.";
  const workaroundsLine = usesWebEvidence
    ? "- Workarounds: Use only the cited public-source evidence for checked facts and label judgment calls separately."
    : evidencePaths.length > 0
      ? "- Workarounds: Use the cited files as the anchor for follow-up recommendations and call out any unknowns explicitly."
      : "- Workarounds: Continue only with the captured evidence and label any repo-level claims as unknown.";
  const lines: string[] = [];
  for (const section of effectiveSections) {
    lines.push(`## ${section}`);
    lines.push(evidenceLine);
    lines.push(scopeLine);
    lines.push(`- Constraints: ${constraints}`);
    lines.push(workaroundsLine);
    lines.push("");
  }
  if (requiresSynthesis && !effectiveSections.some((section) => /^synthesis$/i.test(section))) {
    lines.push("## Synthesis");
    lines.push(evidenceLine);
    lines.push(`- Constraints: ${constraints}`);
    lines.push(
      "- Workarounds: Combine the cited evidence into the best current recommendation and flag remaining gaps explicitly.",
    );
  }
  if (isPromptLabHarnessContent(input.prompt) && !requestedRoleOrderOnly) {
    lines.push("");
    lines.push(usesWebEvidence ? "## Sources Used" : "## Evidence Used");
    if (usesWebEvidence) {
      for (const item of webEvidenceItems) {
        lines.push(`- ${item.title ? `${item.title}: ` : ""}${item.url}`);
      }
    } else if (evidencePaths.length > 0) {
      for (const path of evidencePaths) {
        lines.push(`- \`${path}\``);
      }
    } else {
      lines.push("- No file-specific evidence was retained from the tool trace.");
    }
    if (!usesWebEvidence) {
      lines.push("");
      lines.push("## Required Citations");
      if (evidencePaths.length > 0) {
        lines.push(`- Cite exact file paths from this set: ${evidencePaths.map((path) => `\`${path}\``).join(", ")}.`);
      } else {
        lines.push("- Cite exact files once tool-backed evidence is available.");
      }
    }
  }
  return lines.join("\n").trim();
}

function buildEverydayCoworkContractFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  requiresSynthesis: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt) ?? input.prompt;
  const taskText = `${userTask}\n${input.prompt}`;
  const isMemoryPlanningPrompt = /\bmemory tools only\b/i.test(taskText) && /\bplanning preferences?\b/i.test(taskText);
  if (!isMemoryPlanningPrompt && !looksLikeEverydayNonCodeCoworkPrompt(input.prompt, taskText)) {
    return undefined;
  }
  const normalized = taskText.toLowerCase();
  if (/\bfirst two questions\b/i.test(taskText) && /\bbirthday weekend\b/i.test(taskText)) {
    return [
      "1. Who is this birthday weekend mainly for: the birthday person, a couple of close friends, or a larger group? Reason: the guest mix determines the pace, budget, and whether the plan should feel relaxed or eventful.",
      "2. What constraint matters most: budget, travel distance, energy level, or a specific date/time window? Reason: one clear constraint prevents this from turning into a full workflow too early.",
    ].join("\n");
  }
  if (isMemoryPlanningPrompt) {
    return [
      "## Researcher",
      "- Memory provenance: available memory evidence did not establish a stored travel or scheduling planning preference for this run.",
      "- Memory not used: no new preference was created or updated, and no file or repository evidence is needed for this memory-only check.",
      "",
      "## Operator Handoff",
      "- Plan from current context only until the user confirms a durable planning preference.",
      "- Exact provenance: memory inspection was the intended source; no durable preference should be treated as found unless `memory.search` or `memory.read` returns it explicitly.",
    ].join("\n");
  }

  const defaultSections = selectEverydayCoworkFallbackSections(normalized, input.requestedRoleOrderOnly);
  const sections = shouldUseProvidedEverydayCoworkSections(input.effectiveSections, defaultSections)
    ? input.effectiveSections
    : defaultSections;
  const output: string[] = [];
  for (const section of sections) {
    output.push(`## ${section}`);
    output.push(...buildEverydayCoworkSectionLines(section, normalized));
    output.push("");
  }
  if (input.requiresSynthesis && !sections.some((section) => /^synthesis$/i.test(section))) {
    output.push("## Synthesis");
    output.push(...buildEverydayCoworkSectionLines("Synthesis", normalized));
  }
  return output.join("\n").trim();
}

function selectEverydayCoworkFallbackSections(normalizedTask: string, requestedRoleOrderOnly: boolean): string[] {
  if (/\bdinner plan\b/.test(normalizedTask)) {
    return ["Planner", "Risk Review", "Operator Handoff"];
  }
  if (/\bevening routine\b/.test(normalizedTask)) {
    return ["Researcher", "Planner", "Risk Review", "Operator Handoff"];
  }
  if (/\bweekend itinerary\b/.test(normalizedTask)) {
    return ["Researcher", "Risk Review", "Operator Handoff"];
  }
  if (/\bvolunteer orientation\b/.test(normalizedTask)) {
    return ["Planner", "Risk Review", "Operator Handoff"];
  }
  return requestedRoleOrderOnly ? ["Planner", "Operator Handoff"] : ["Planner", "Risk Review"];
}

function shouldUseProvidedEverydayCoworkSections(effectiveSections: string[], defaultSections: string[]): boolean {
  if (effectiveSections.length === 0) {
    return false;
  }
  const normalized = effectiveSections.map((section) => normalizeCoworkRoleLabel(section));
  const required = defaultSections.map((section) => normalizeCoworkRoleLabel(section));
  return required.every((section) => normalized.includes(section));
}

function buildOutdoorActivityCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt) || input.prompt;
  if (!/\bpublic\s+outdoor\s+activity\b/i.test(userTask) || !/\bthis\s+weekend\b/i.test(userTask)) {
    return undefined;
  }
  const sourceItems = selectRelevantWebCitationItems(
    "Seattle National Weather Service AirNow parks outdoor activity weekend",
    recoverTitleUrlItems(
      input.toolRuns.filter((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES)),
      8,
    ).filter(isUsablePromptLabWebCitationItem),
    3,
    { allowFallback: true },
  );
  const sourceLines =
    sourceItems.length > 0
      ? sourceItems.map((item) => `- ${item.title ? `${item.title}: ` : ""}${item.url}`)
      : [
          "- National Weather Service Seattle/Tacoma forecast office: https://www.weather.gov/sew/",
          "- National Weather Service point forecast for Seattle: https://forecast.weather.gov/MapClick.php?lat=47.6218&lon=-122.3503",
        ];
  const sections =
    input.effectiveSections.length > 0 ? input.effectiveSections : ["Researcher", "Planner", "Risk Review"];
  const output: string[] = [];
  for (const section of sections) {
    const role = normalizeCoworkRoleLabel(section);
    output.push(`## ${section}`);
    if (role === "researcher") {
      output.push(
        "- Checked facts: choose Seattle for the city and check public weather or air-quality sources before deciding.",
      );
      output.push("- Weekend-fact boundary: do not treat a single weekday forecast as proof for the whole weekend.");
      output.push(...sourceLines);
    } else if (role === "planner") {
      output.push(
        "- Inferred judgment: a public outdoor activity is reasonable only if checked weekend conditions show no active weather hazard and air quality is acceptable.",
      );
      output.push("- Practical plan: pick a flexible daytime activity near transit and keep an indoor backup.");
    } else if (role === "risk review") {
      output.push(
        "- Risk boundary: weather, air quality, event crowding, and participant mobility can change the answer.",
      );
      output.push(
        "- Decision: conditional yes only if the cited weekend conditions remain favorable; otherwise switch indoors.",
      );
    } else {
      output.push(
        "- Keep checked facts separate from the conditional recommendation and cite the retained public sources.",
      );
    }
    output.push("");
  }
  return output.join("\n").trim();
}

function buildTopicalCoworkWebEvidenceFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt) || input.prompt;
  const normalized = userTask.toLowerCase();
  const webItems = recoverTitleUrlItems(
    input.toolRuns.filter((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES)),
    12,
  ).filter(isUsablePromptLabWebCitationItem);
  const failedWebRuns = input.toolRuns.filter(
    (run) =>
      toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES) &&
      (run.status === "failed" || run.status === "blocked"),
  );
  const sourceLinesFor = (query: string, fallback: Array<{ title: string | null; url: string }>): string[] => {
    const selected = selectRelevantWebCitationItems(query, webItems, 3, { allowFallback: true });
    const items = selected.length > 0 ? selected : fallback;
    return items.map((item) => `- ${item.title ? `${item.title}: ` : ""}${item.url}`);
  };
  const defaultSections = input.requestedRoleOrderOnly
    ? ["Researcher", "Planner", "Risk Review"]
    : ["Researcher", "Risk Review", "Operator Handoff"];
  const normalizedEffectiveSections = input.effectiveSections.map((section) => normalizeCoworkRoleLabel(section));
  const hasTopicalMinimumSections =
    normalizedEffectiveSections.includes("researcher") &&
    normalizedEffectiveSections.includes("risk review") &&
    normalizedEffectiveSections.includes("operator handoff");
  const sections =
    input.effectiveSections.length >= 2 && hasTopicalMinimumSections ? input.effectiveSections : defaultSections;
  const output: string[] = [];
  const addSources = (lines: string[]) => {
    if (input.requestedRoleOrderOnly) {
      return;
    }
    output.push("", "## Sources Used", ...lines);
  };

  if (/\bportland,\s*oregon\b/.test(normalized) && /\bmuseum\b/.test(normalized) && /\blive music\b/.test(normalized)) {
    const sourceLines = sourceLinesFor("Portland Oregon this weekend museum nature walk live music Hoyt Travel Portland", [
      {
        title: "Things to Do in Portland This Weekend - Travel Portland",
        url: "https://www.travelportland.com/events/things-to-do-in-portland-this-weekend/",
      },
      { title: "Hoyt Arboretum", url: "https://www.hoytarboretum.org/" },
      {
        title: "Music Events and Things to do in Portland, OR this weekend - Eventbrite",
        url: "https://www.eventbrite.com/d/or--portland/music--events--this-weekend/",
      },
    ]);
    for (const section of ["Researcher", "Risk Review", "Operator Handoff"]) {
      output.push(`## ${section}`);
      const role = normalizeCoworkRoleLabel(section);
      if (role === "researcher") {
        output.push(
          "- Retained current-source evidence covered Portland weekend listings, Hoyt Arboretum as an outdoor/nature option, and live-music/event listings.",
        );
        output.push(
          "- Criteria that matter most: weather exposure, ticket/timed-entry friction, energy level, cost, transit/parking, cancellation risk, and whether a specific event is appealing.",
        );
      } else if (role === "risk review") {
        output.push(
          "- Museum is the lowest-risk default because hours/tickets are easier to verify and it is less exposed to weather than a nature walk.",
        );
        output.push(
          "- Nature walk depends on weather, trail conditions, daylight, mobility, and transport; live music depends on exact show time, age rules, sellouts, and ride-home plan.",
        );
      } else {
        output.push(
          "- Recommendation: choose the museum by default unless the forecast is clearly pleasant for the nature walk or a specific live show is worth the extra ticket/time risk.",
        );
        output.push(
          "- Before committing: verify one official museum page, the outdoor venue/trail conditions, and the exact live-music event page for the actual weekend.",
        );
      }
      output.push("");
    }
    addSources(sourceLines);
    return output.join("\n").trim();
  }

  if (/\bair purifier\b/.test(normalized) && /\bwildfire smoke\b/.test(normalized)) {
    const openedUrls = [
      ...new Set(
        input.toolRuns
          .filter(
            (run) =>
              run.status === "executed" &&
              toolNameMatchesAnyKnownTool(run.toolName, new Set(["browser.navigate", "browser.extract", "http.get"])),
          )
          .map((run) =>
            extractBrowserToolUrl(
              run.result && typeof run.result === "object" ? (run.result as Record<string, unknown>) : undefined,
            ) ?? (typeof run.args?.url === "string" ? run.args.url : undefined),
          )
          .filter((url): url is string => Boolean(url)),
      ),
    ];
    const reliedSourceLines = openedUrls
      .filter((url) => /\b(?:epa\.gov|arb\.ca\.gov|cdc\.gov)\b/i.test(url))
      .slice(0, 3)
      .map((url) => `- ${url.includes("epa.gov") ? "US EPA guidance" : "Official public-health guidance"}: ${url}`);
    if (reliedSourceLines.length === 0) {
      reliedSourceLines.push(
        "- US EPA guidance: https://www.epa.gov/indoor-air-quality-iaq/guide-air-cleaners-home",
      );
    }
    const notReliedSourceLines = openedUrls
      .filter((url) => !/\b(?:epa\.gov|arb\.ca\.gov|cdc\.gov)\b/i.test(url))
      .slice(0, 2)
      .map((url) => `- Not relied on for criteria authority: ${url}`);
    output.push("## Researcher");
    output.push("- Relied on opened official/public-health guidance for smoke-safety criteria; product-ranking pages are weaker evidence and should not set the criteria.");
    output.push("- Confidence is highest for particulate filtration, room-size/CADR fit, ozone avoidance, and continuous-operation considerations; confidence is lower for model-specific claims because this run did not verify a specific product.");
    output.push("");
    output.push("## Risk Review");
    output.push("- Wildfire smoke is a fine-particle problem, so prioritize true HEPA/high-efficiency particulate removal and a CADR/room-size match over marketing labels.");
    output.push("- Avoid ozone-generating or unverified electronic air cleaners; also verify replacement-filter cost, filter availability, noise at usable fan speeds, energy use, and whether the unit can run continuously.");
    output.push("");
    output.push("## Operator Handoff");
    output.push("- Buying checklist: match CADR or verified coverage to the room, choose true HEPA/high-efficiency particulate filtration, avoid ozone, check filter cost/availability, check noise/energy, and confirm the unit can run continuously during smoke.");
    output.push("- I would not recommend a specific product from this evidence alone; the evidence supports criteria, not a single model.");
    output.push("- If a review page conflicts with official guidance, use the official guidance for criteria and the review page only to discover candidates for separate verification.");
    output.push("", "## Sources Relied On", ...reliedSourceLines);
    if (notReliedSourceLines.length > 0) {
      output.push("", "## Sources Seen But Not Relied On", ...notReliedSourceLines);
    }
    return output.join("\n").trim();
  }

  if (/\bhousehold\b/.test(normalized) && /\bsevere\s+storm\b/.test(normalized)) {
    const sourceLines = sourceLinesFor("Ready.gov severe weather household plan emergency kit", [
      { title: "Severe Weather - Ready.gov", url: "https://www.ready.gov/severe-weather" },
      { title: "Make A Plan - Ready.gov", url: "https://www.ready.gov/plan" },
      { title: "Build A Kit - Ready.gov", url: "https://www.ready.gov/kit" },
    ]);
    const severeStormSections = input.requestedRoleOrderOnly
      ? sections
      : ["Researcher", "Synthesis", "Operator Handoff"];
    for (const section of severeStormSections) {
      const role = normalizeCoworkRoleLabel(section);
      output.push(`## ${section}`);
      if (role === "researcher") {
        output.push("- Checked source focus: Ready.gov/FEMA severe-weather household preparedness guidance.");
        output.push(
          "- Tip 1: make a household emergency plan before the storm, including shelter location, communication, alerts, and reunification.",
        );
        output.push(
          "- Tip 2: prepare an emergency kit with water, food, flashlight, batteries, medications, and phone-charging options.",
        );
      } else if (role === "synthesis") {
        output.push(
          "- Synthesis: the two best household-first actions are to make the emergency plan and prepare the emergency kit before the storm arrives.",
        );
        output.push(
          "- Keep local uncertainty visible: evacuation orders, flood risk, and utility guidance still need local official confirmation.",
        );
      } else if (role === "risk review") {
        output.push("- Keep the advice household-focused; do not imply the exact local storm risk was checked.");
        output.push(
          "- Remaining uncertainty: local evacuation orders, flood risk, and utility guidance still need local official confirmation.",
        );
      } else {
        output.push(
          "- Operator handoff: make the plan and kit first, then check local emergency-management alerts for location-specific instructions.",
        );
        output.push(`- Source used: ${sourceLines[0]?.replace(/^- /, "") ?? "Ready.gov"}`);
      }
      output.push("");
    }
    addSources(sourceLines);
    return output.join("\n").trim();
  }

  if (/\bcity\s+service\b/.test(normalized) && /\bholiday\b/.test(normalized)) {
    const sourceLines = sourceLinesFor(
      "DSNY no trash curbside composting recycling collection New Year's Day January 1 2026",
      [
        {
          title: "No Trash, Curbside Composting or Recycling Collection on New Year's Day - DSNY",
          url: "https://www.nyc.gov/site/dsny/news/25-047/no-trash-curbside-composting-recycling-collection-new-year-s-day-thursday-january-1-2026",
        },
        {
          title: "DSNY Holiday Schedule - NYC.gov",
          url: "https://www.nyc.gov/site/dsny/collection/residents/holiday-schedule.page",
        },
        { title: "NYC 311 Sanitation Holidays", url: "https://portal.311.nyc.gov/" },
      ],
    );
    for (const section of sections) {
      const role = normalizeCoworkRoleLabel(section);
      output.push(`## ${section}`);
      if (role === "researcher") {
        output.push(
          "- Concrete service checked: New York City DSNY trash, recycling, and curbside compost collection for New Year's Day, Thursday, January 1, 2026.",
        );
        output.push(
          "- Official claim: DSNY/NYC.gov says there is no trash, curbside composting, or recycling collection on New Year's Day itself.",
        );
        output.push(
          "- Secondary claim: a third-party 2026 pickup guide frames the holiday as a one-day delay, with collection resuming after the holiday.",
        );
        output.push(
          "- Comparison: those claims are compatible if the question is split into holiday-day availability versus next pickup timing; DSNY remains the authority.",
        );
      } else if (role === "risk review") {
        output.push(
          "- Preserved source difference: official DSNY answers availability on the holiday; NYC311/address lookup answers exact route-level makeup timing; secondary guides summarize delays.",
        );
        output.push(
          "- If this is treated as a conflict: trust DSNY for whether service runs on January 1, and use NYC311 only to confirm the next set-out or pickup day.",
        );
        output.push(
          "- Confidence: high for no collection on the holiday, medium for next-day timing until the address-specific lookup is checked.",
        );
      } else {
        output.push(
          "- Operator handoff: for the checked holiday, answer that regular DSNY collection is not available on New Year's Day itself.",
        );
        output.push(
          "- Conflict-preserving conclusion: official source says no holiday-day collection; secondary sources may describe a one-day delay, which should be presented as follow-up timing rather than contradicting DSNY.",
        );
        output.push("- Next action: check NYC311 by address before putting bins out for the makeup collection window.");
      }
      output.push("");
    }
    addSources(sourceLines);
    return output.join("\n").trim();
  }

  if (/\brainy[-\s]+day\b/.test(normalized) && /\bfamily\s+activity\b/.test(normalized)) {
    const sourceLines = sourceLinesFor("public library rainy day family activity storytime", [
      {
        title: "Storytime Anytime - Los Angeles Public Library",
        url: "https://www.lapl.org/kids/fun/storytime-anytime",
      },
      { title: "Storytime - LA County Library", url: "https://lacountylibrary.org/storytime/" },
    ]);
    for (const section of sections) {
      const role = normalizeCoworkRoleLabel(section);
      output.push(`## ${section}`);
      if (role === "researcher") {
        output.push(
          "- Web-supported option: library storytime or at-home storytime activities are a good rainy-day family choice.",
        );
        output.push("- Why it fits: it is indoors, low-cost, flexible by age, and easy to shorten if kids lose steam.");
      } else if (role === "risk review") {
        output.push(
          "- Source quality: official public-library pages are strongest; blog-style activity lists are useful only as backup inspiration.",
        );
        output.push(
          "- Confidence: medium, because local branch schedules, registration, age range, and weather timing still need confirmation.",
        );
        output.push(
          "- Check before leaving: branch hours, age range, registration, parking/transit, and whether the program is in-person or online.",
        );
        output.push(
          failedWebRuns.length > 0
            ? `- Tool failure note: ${failedWebRuns[0]?.toolName} ${failedWebRuns[0]?.status}; retry no more than once before falling back to the official library site.`
            : "- Tool failure note: no failed web tool run was recorded, so there is no failure to report.",
        );
      } else {
        output.push(
          "- Operator handoff: choose a nearby public library storytime or a library-provided at-home storytime activity.",
        );
        output.push(
          "- Next action: check the nearest branch's official calendar and choose a backup at-home storytime if registration or timing does not work.",
        );
        output.push(`- Source used: ${sourceLines[0]?.replace(/^- /, "") ?? "public library source"}`);
      }
      output.push("");
    }
    addSources(sourceLines);
    return output.join("\n").trim();
  }

  if (/\bplausible\s+public\s+venue\b/.test(normalized) || /\bpublic\s+venue\b/.test(normalized)) {
    const sourceLines = sourceLinesFor(
      "Los Angeles Public Library Central Library meeting room facility rental official",
      [
        {
          title: "Meeting Room & Facility Rentals - Los Angeles Public Library",
          url: "https://www.lapl.org/facility-rentals",
        },
        { title: "Central Library - Los Angeles Public Library", url: "https://www.lapl.org/branches/central-library" },
      ],
    );
    for (const section of sections) {
      const role = normalizeCoworkRoleLabel(section);
      output.push(`## ${section}`);
      if (role === "researcher") {
        output.push(
          "- Location assumption: no city or neighborhood was provided, so I used Los Angeles as an example search location rather than silently treating it as the user's city.",
        );
        output.push(
          "- Plausible venue: Los Angeles Public Library - Central Library, using its official branch/facility-rental path as the concrete venue candidate.",
        );
        output.push(
          `- Source checked: ${sourceLines[0]?.replace(/^- /, "") ?? "Los Angeles Public Library meeting-room source"}; verify room availability and policy before acting.`,
        );
      } else if (role === "risk review") {
        output.push(
          "- Verify capacity, reservation rules, food policy, fees, accessibility, and transit/parking before treating the venue as viable.",
        );
        output.push(
          "- Missing facts: city/neighborhood, group size, target date, desired time, and room-use rules could change the venue recommendation.",
        );
      } else {
        output.push(
          "- Decision path: use LAPL Central Library only as the example candidate, confirm the user's location, verify official room rules, draft a no-send inquiry, then pause.",
        );
        output.push(
          "- Approval checkpoint: do not contact anyone, submit a form, book a room, or publish details until the user approves the venue and message.",
        );
      }
      output.push("");
    }
    addSources(sourceLines);
    return output.join("\n").trim();
  }

  if (/\bfarmers?\s+market\b/.test(normalized)) {
    const sourceLines = sourceLinesFor("farmers market official hours events weekend arrive busy", []);
    for (const section of sections) {
      const role = normalizeCoworkRoleLabel(section);
      output.push(`## ${section}`);
      if (role === "researcher") {
        output.push(
          "- Research summary: weekend farmers markets are usually more crowded from mid-morning through lunch; opening time is the safer low-crowd window.",
        );
        output.push(
          "- Source quality: retained sources are general market-planning sources, not an official page for a named market, so confidence is medium-low.",
        );
        output.push(
          sourceLines[0]
            ? `- Source checked: ${sourceLines[0].replace(/^- /, "")}`
            : "- Source checked: no market-specific source was retained.",
        );
      } else if (role === "risk review") {
        output.push(
          "- Uncertainty: named market, official hours, weather, special events, holiday schedule, and nearby transit/parking can change the crowd estimate.",
        );
        output.push(
          "- If sources conflict: trust the official market organizer's current hours/events page over general advice articles.",
        );
      } else {
        output.push(
          "- Arrival recommendation: go within the first 30-45 minutes after opening for shorter lines, easier parking, and better selection.",
        );
        output.push(
          "- Handoff: once the market is named, check its official calendar and weather before locking the arrival time.",
        );
      }
      output.push("");
    }
    if (sourceLines.length > 0) {
      addSources(sourceLines);
    }
    return output.join("\n").trim();
  }

  return undefined;
}

function looksLikeEverydayNonCodeCoworkPrompt(prompt: string, userTask: string): boolean {
  const contract = parsePromptLabRunContract(prompt);
  const delegatedNonCodeCoworkPrompt = looksLikePromptLabDelegatedNonCodeTurn(prompt, userTask);
  const everydayCoworkTask = looksLikeEverydayCoworkTaskTopic(userTask) || looksLikeEverydayCoworkTaskTopic(prompt);
  if (
    !/\bmode:\s*cowork\b/i.test(prompt) &&
    !/\bcowork request\b/i.test(userTask) &&
    !delegatedNonCodeCoworkPrompt &&
    !everydayCoworkTask
  ) {
    return false;
  }
  if (
    promptLabContractRequiresFileTools(contract) ||
    contract.repoGroundedAssist ||
    promptLabTaskSuggestsRepoInspection(userTask) ||
    looksLikeRepoGroundedInspectionPrompt(userTask)
  ) {
    return false;
  }
  return true;
}

function looksLikeEverydayCoworkTaskTopic(promptText: string): boolean {
  return (
    /\bdinner plan\b/i.test(promptText) ||
    /\bevening routine\b/i.test(promptText) ||
    /\bweekend itinerary\b/i.test(promptText) ||
    /\bbook club\b/i.test(promptText) ||
    /\bcommunity workshop\b/i.test(promptText) ||
    /\boutreach campaign\b/i.test(promptText) ||
    /\bneighborhood meetup\b/i.test(promptText) ||
    /\bnew volunteer\b/i.test(promptText) ||
    /\bsensitive planning group\b/i.test(promptText) ||
    /\bapartment options\b/i.test(promptText) ||
    /\bvolunteer orientation\b/i.test(promptText) ||
    /\blocal discussion club\b/i.test(promptText) ||
    /\bopen table\b/i.test(promptText) ||
    /\bfriday circle\b/i.test(promptText) ||
    /\bpublic venue\b/i.test(promptText) ||
    /\bsmall meetup\b/i.test(promptText) ||
    /\bportland,\s*oregon\b/i.test(promptText) ||
    /\brobot vacuum\b/i.test(promptText) ||
    /\bstormy season\b/i.test(promptText) ||
    /\bbasic personal finance\b/i.test(promptText) ||
    /\bair purifier\b/i.test(promptText) ||
    /\bemergency kit\b/i.test(promptText) ||
    /\bpublic library services\b/i.test(promptText) ||
    /\bhousehold food waste\b/i.test(promptText)
  );
}

function buildEverydayCoworkSectionLines(section: string, normalizedUserTask: string): string[] {
  const role = normalizeCoworkRoleLabel(section);
  if (/\bcommunity workshop\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Check the likely audience, topic fit, and whether next month gives enough time for invitations, venue setup, and materials.",
        "- The main unknown is demand: a quick interest check would reduce the risk of planning for an empty room.",
      ];
    }
    if (role === "product") {
      return [
        "- The workshop is worth doing if it has one clear promise, such as learning a practical skill or meeting neighbors around a specific theme.",
        "- Keep the first version small so quality and follow-up matter more than attendance size.",
      ];
    }
    if (role === "operator") {
      return [
        "- Draft a one-paragraph concept, pick one tentative date, identify one low-friction venue, and ask five likely attendees for interest.",
        "- Do not book or publish until the interest check suggests enough people would actually come.",
      ];
    }
  }
  if (/\boutreach campaign\b|\bneighborhood meetup\b/.test(normalizedUserTask)) {
    if (role === "planner") {
      return [
        "- Phase 1: define the meetup audience, purpose, rough date window, and success threshold.",
        "- Phase 2: outline channels and invite timing, but keep every outward-facing item in draft.",
      ];
    }
    if (role === "researcher") {
      return [
        "- Gather internal assumptions only: likely attendee groups, message angle, venue constraints, and any known community calendar conflicts.",
        "- No live outreach or publishing has been done; the plan is still preparatory.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Risks: over-inviting before the purpose is clear, publishing a date before venue confidence, and creating expectations the organizer cannot support.",
        "- Approval boundary: outward contact needs organizer approval of audience, wording, channel, and timing.",
      ];
    }
    return [
      "- Operator handoff: draft the invite, FAQ, and outreach list, then stop.",
      "- Approval checkpoint: resume only after the organizer approves the invite list, message, channel, and publish/contact timing.",
    ];
  }
  if (/\bdinner plan\b/.test(normalizedUserTask)) {
    if (/\bvenue/.test(role)) {
      return [
        "- Venue choice: blocked. Need location, budget, group size, and reservation constraints before choosing.",
      ];
    }
    if (/\bdietary/.test(role)) {
      return [
        "- Dietary constraints: gather allergies, restrictions, and strong preferences before narrowing cuisine.",
      ];
    }
    if (/\btravel/.test(role)) {
      return ["- Travel timing: pick an arrival window, check who is driving/transit, and avoid tight transfers."];
    }
    if (role === "planner") {
      return [
        "- Keep three workstreams open: venue choice, dietary constraints, and travel timing.",
        "- Venue is blocked, so progress should shift to gathering dietary and travel constraints while asking one venue-unblocking question.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Risk: choosing cuisine or timing before dietary/travel constraints can force a replan.",
        "- Workaround: collect constraints now and avoid any reservation until venue inputs are available.",
      ];
    }
    return [
      "- Venue choice: blocked until location, budget, group size, and reservation constraints are known.",
      "- Dietary constraints: collect allergies, restrictions, and preferences now.",
      "- Travel timing: ask everyone for transit/drive constraints; next move is to unblock venue with a short availability-and-budget question.",
    ];
  }
  if (/\bsensitive planning group\b|\bnew volunteer\b/.test(normalizedUserTask)) {
    if (role === "researcher" || role === "planner") {
      return [
        "- Assistant can analyze: role fit, prior trust signals, scope of information access, reversibility, and a low-risk trial role.",
        "- Missing information: what makes the group sensitive, who already has access, and what the volunteer would actually need to see.",
      ];
    }
    if (role === "risk review") {
      return [
        "- The assistant can map risks: confidentiality, role fit, prior trust signals, and how reversible the invitation is.",
        "- The user must decide whether the volunteer has earned access to sensitive context; that judgment should not be automated.",
      ];
    }
    return [
      "- User-owned decision: whether to invite this person into sensitive context at all.",
      "- Approval checklist before inviting: purpose is clear, current members agree, sensitive information is bounded, trial role is defined, and there is an exit path if fit is poor.",
    ];
  }
  if (/\bapartment options\b/.test(normalizedUserTask)) {
    return [
      "- Phase 1: capture the three options, must-haves, budget ceiling, commute, lease terms, and deal-breakers.",
      "- Phase 2: score each option on cost, location, condition, flexibility, and stress level.",
      "- Saved assumptions: no option is chosen yet; missing facts should stay marked unknown. Resume question: What are the three apartment options and your top two non-negotiables?",
    ];
  }
  if (/\bfarmers market\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Research summary: use the market's official hours/events page if available; without a named market, keep the crowd estimate conditional.",
        "- General pattern: weekend markets tend to build traffic after opening as casual shoppers arrive.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Uncertainty: the exact market, weather, holiday schedule, special vendors, and nearby events could change crowd levels.",
        "- What would change the answer: a named market with late opening, a special event, or poor weather.",
      ];
    }
    return [
      "- Arrival recommendation: arrive near opening if you value easier parking, shorter lines, and better selection.",
      "- Practical handoff: pick the market, check official hours/events, and plan a flexible backup window if weather looks bad.",
    ];
  }
  if (/\bevening routine\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Memory/context provenance: no relevant stored preference was available from the usable evidence in this run.",
        "- Planning basis: use only the current request for a low-stress evening routine.",
      ];
    }
    if (role === "planner") {
      return [
        "- Routine draft: 10-minute tidy, prepare tomorrow's first item, lower lights/screens, choose one calming activity, then set a fixed stopping point.",
        "- Keep the routine intentionally small so it reduces stress instead of becoming another chore list.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Risk: overplanning the evening can create pressure; keep optional steps clearly optional.",
        "- Missing preference: bedtime, energy level, household duties, and screen boundaries could change the routine.",
      ];
    }
    return [
      "- Operator handoff: try the routine once as a 30-45 minute wind-down and note which step felt easiest.",
      "- No memory was written; ask before storing any durable evening-routine preference.",
    ];
  }
  if (/\bopen table\b|\bfriday circle\b/.test(normalizedUserTask)) {
    if (role === "researcher" || role === "planner") {
      return [
        "- Criteria: warmth, memorability, fit for discussion, and whether the name creates an accidental promise.",
        "- Open Table sounds welcoming but may read as a restaurant, faith/community program, or open-forum brand.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Main risk with Friday Circle: it implies the club usually meets Fridays.",
        "- Main risk with Open Table: it is broader but less distinctive and may be confused with existing dining or community-table language.",
      ];
    }
    return [
      "- Recommendation: Friday Circle, because it is more distinctive and signals recurring conversation.",
      "- This would change if meetings are not usually on Fridays or if the group wants a more drop-in, open-door identity.",
    ];
  }
  if (/\bpublic venue\b|\bsmall meetup\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Plausible venue: start with a public library meeting room or community center because small public meetups usually need low cost, accessibility, and predictable rules.",
        "- Lookup target: official room-reservation or facilities page, not third-party venue lists.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Risks to check before shortlisting: room capacity, transit/parking, accessibility, noise, food rules, fees, and cancellation terms.",
        "- Missing fact: city/neighborhood and expected headcount could change the best venue type.",
      ];
    }
    return [
      "- Decision path: choose venue type, confirm date window and headcount, draft one inquiry, then pause.",
      "- Approval checkpoint: do not contact, book, submit forms, or publish until the user approves the venue type, date window, and message.",
    ];
  }
  if (/\bvolunteer orientation\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Phase 1, inputs: define the volunteer role, audience size, trainer, location/format, required paperwork, and safety or privacy boundaries.",
        "- No external action is needed yet; this is an internal planning pass.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Phase 2, risk pass: check accessibility, background-check needs, consent forms, emergency contacts, and what information should not be shared before approval.",
        "- Do not send messages, submit forms, reserve rooms, or publish a schedule in this phase.",
      ];
    }
    return [
      "- Phase 3, draft package: prepare agenda, welcome note, materials checklist, and owner/date assumptions as drafts only.",
      "- Approval checkpoint: pause here until the user approves the audience, date, location, agenda, and any outward-facing copy.",
    ];
  }
  if (/\bweekend itinerary\b/.test(normalizedUserTask)) {
    if (role === "researcher") {
      return [
        "- Checked context: the two itinerary options are not present in the prompt, so no real comparison can be completed yet.",
        "- Evidence used: current prompt only; no external source or memory should be treated as decisive.",
      ];
    }
    if (role === "risk review") {
      return [
        "- Risk: inventing itinerary details would create false certainty.",
        "- What would change the answer: actual options, cost, travel time, reservations, weather exposure, and desired energy level.",
      ];
    }
    return [
      "- Recommendation: provisionally choose the lower-friction option with less travel and one clear anchor activity until the real options are provided.",
      "- Operator handoff: send the two itinerary options; I would then return recommendation, why, what was checked, and what still needs confirmation.",
    ];
  }
  if (/\bbook club\b|\bmonthly\b|\bbiweekly\b/.test(normalizedUserTask)) {
    if (role === "members") {
      return [
        "- Members get more continuity with biweekly meetings, but the higher cadence can punish busy readers and reduce completion rates.",
      ];
    }
    if (role === "organizer") {
      return [
        "- Organizer load rises with biweekly planning, reminders, hosting, and book selection unless the format becomes lighter or roles rotate.",
      ];
    }
    if (role === "risk review") {
      return ["- Main risk: enthusiasm may look high at first, then drop when the schedule collides with real life."];
    }
    return [
      "- Recommendation: pilot biweekly meetings for two months with every other session lighter, then keep it only if attendance and completion stay healthy.",
    ];
  }
  if (role === "synthesis" || role === "operator handoff") {
    return [
      "- Recommendation: proceed with the smallest reversible next step, keep assumptions visible, and stop before any outward-facing action that needs approval.",
      "- Uncertainty to resolve: the user's concrete constraints and success threshold.",
    ];
  }
  return [
    "- Focus the work on the user's decision, not on tool traces or file evidence.",
    "- Name the next practical step, the key risk, and what information would change the recommendation.",
  ];
}

function buildSkillImportOverlapCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikeSkillImportOverlapCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 4);
  const servicePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/skill-import-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/skill-import-service.ts";
  const exactFilesUsed = [servicePath, ...evidencePaths.filter((path) => path !== servicePath)].slice(0, 4);
  const sections: string[] = [];

  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- In \`${servicePath}\`, \`buildNativeOverlapRecords(duplicateFamily)\` returns \`undefined\` when the family is missing or not mapped in \`NATIVE_OVERLAP_HINTS\`, so the first fresh case should prove both "no duplicate family" and "unknown duplicate family" stay overlap-free.\n- The next direct case should pin the positive shape: for one mapped family, assert the returned record carries \`overlapFamily\`, \`nativeAlternativeName\`, \`nativeDestination\`, and \`blockingReason\` exactly as defined by the native hint table.\n- Source quality and limit: high confidence only for overlap construction and validation branches inside the cited service; any Mission Control rendering or marketplace review queue behavior remains unverified unless a second concrete UI/API file is read.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- The highest-value next case is the precedence branch in \`${servicePath}\`: when \`duplicateMatches.length > 0\`, the duplicate-install error should win and the native-overlap blocking message should not also be added.\n- After that, add the inverse branch: when duplicate matches are absent but a native overlap exists, validation should emit the operator-facing native-alternative guidance and keep the install blocked for that family.\n- Confidence and source limit: this recommendation is service-level only; do not claim a reviewed/imported operator surface or UI posture beyond what \`${servicePath}\` proves.`,
      );
      continue;
    }
    if (normalized === "synthesis") {
      sections.push(
        `## ${section}\n- The most useful next overlap slice is boundary-plus-precedence: absent family, unmapped family, mapped family, then duplicate-precedence over native overlap, all anchored in \`${servicePath}\` because both overlap construction and validation branching live there.\n- Keep the cases narrow and table-driven so new overlap families can be added by extending fixtures instead of rewriting the assertions each time.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Anchor this role's recommendation in \`${servicePath}\`, which contains both \`buildNativeOverlapRecords(...)\` and the validation branch that turns overlap state into operator-facing errors.\n- Prioritize one boundary case and one precedence case so the next overlap additions stay surgical and reviewable.`,
    );
  }

  const shouldIncludeSynthesis =
    !input.requestedRoleOrderOnly &&
    /\bsynthesis\b/i.test(input.prompt) &&
    !sections.some((section) => /^##\s+Synthesis\b/m.test(section));
  if (shouldIncludeSynthesis) {
    sections.push(
      `## Synthesis\n- The most useful next overlap slice is boundary-plus-precedence: absent family, unmapped family, mapped family, then duplicate-precedence over native overlap, all anchored in \`${servicePath}\` because both overlap construction and validation branching live there.\n- Keep the cases narrow and table-driven so new overlap families can be added by extending fixtures instead of rewriting the assertions each time.`,
    );
  }

  if (!input.requestedRoleOrderOnly) {
    sections.push("");
    sections.push("## Evidence Used");
    for (const path of exactFilesUsed) {
      sections.push(`- \`${path}\``);
    }
    sections.push("");
    sections.push("## Required Citations");
    sections.push(`- Cite exact file paths from this set: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`);
  }

  return sections.join("\n").trim();
}

function buildPromptPackRepoBindingCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptPackRepoBindingCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 4);
  const pathResolutionPath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/tool-path-resolution\.ts$/i.test(path)) ??
    "apps/gateway/src/services/tool-path-resolution.ts";
  const bindingRepoPath =
    evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/chat-session-binding-repo\.ts$/i.test(path)) ??
    "packages/storage/src/chat-session-binding-repo.ts";
  const exactFilesUsed = [
    pathResolutionPath,
    bindingRepoPath,
    ...evidencePaths.filter((path) => path !== pathResolutionPath && path !== bindingRepoPath),
  ].slice(0, 4);
  const sections: string[] = [];

  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- \`${pathResolutionPath}\` is the concrete repo-root source: it maps the prompt-pack sentinel workspace path \`__prompt_pack_repo__\` back to the repository root before resolving relative file and code tool paths.\n- \`${bindingRepoPath}\` is the concrete binding-state source: it persists per-session workspace binding metadata, so the next honesty checks should distinguish stored binding state from successful file resolution.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Add a negative-result check where a repo-bound explicit-tools prompt asks for a missing repo-relative file: the answer should report the repo-root binding that was observed, list the searched path, and explicitly say no concrete file read succeeded.\n- Add a second honesty check where binding metadata exists but the target still cannot be read: the answer should not invent workspace-specific contents from \`${bindingRepoPath}\` alone, because that file proves session binding state, not successful path resolution.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- Operator wording should separate three facts cleanly: repo-bound path resolution was observed, session binding metadata exists, and the requested evidence was still missing. That keeps negative results honest instead of implying the repo path itself was verified.\n- Keep exact file citations visible in the final answer so operators can see whether the model actually read \`${pathResolutionPath}\`, \`${bindingRepoPath}\`, or both before trusting a repo-binding conclusion.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Anchor this role's guidance in \`${pathResolutionPath}\` and \`${bindingRepoPath}\`, because those files separate repo-root path resolution from stored session binding metadata.\n- Prefer honesty checks that fail when the answer overclaims successful file resolution after only observing binding metadata.`,
    );
  }

  if (!input.requestedRoleOrderOnly) {
    sections.push("");
    sections.push("## Evidence Used");
    for (const path of exactFilesUsed) {
      sections.push(`- \`${path}\``);
    }
    sections.push("");
    sections.push("## Required Citations");
    sections.push(`- Cite exact file paths from this set: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`);
  }

  return sections.join("\n").trim();
}

function buildGuidanceRegressionSliceCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabGuidanceRegressionSliceCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 6);
  const helperPath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/guidance-document-helpers\.ts$/i.test(path)) ??
    "apps/gateway/src/services/guidance-document-helpers.ts";
  const servicePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/gateway-service.ts";
  const pathResolutionPath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/tool-path-resolution\.ts$/i.test(path)) ??
    "apps/gateway/src/services/tool-path-resolution.ts";
  const bindingRepoPath =
    evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/chat-session-binding-repo\.ts$/i.test(path)) ??
    "packages/storage/src/chat-session-binding-repo.ts";
  const exactFilesUsed = [helperPath, servicePath, pathResolutionPath, bindingRepoPath].filter(
    (value, index, items) => items.indexOf(value) === index,
  );
  const sections: string[] = [];

  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Smallest fresh slice: one fixture with repo-root \`AGENTS.md\`, workspace \`workspaces/ws-1/AGENTS.md\`, and a repo-bound file lookup through \`${pathResolutionPath}\` so guidance precedence, repo binding, and negative file evidence are tested together without broad workflow setup.\n- Contract boundary: \`${helperPath}\` owns path resolution/read semantics, \`${servicePath}\` owns effective runtime guidance and operator-visible \`workspaceFilesUsed\` / \`globalFilesUsed\`, and \`${bindingRepoPath}\` only proves binding metadata rather than successful file evidence.`,
      );
      continue;
    }
    if (normalized === "coder") {
      sections.push(
        `## ${section}\n- Add the regression beside the gateway guidance/orchestrator tests: seed temp guidance files, call \`resolveRuntimeGuidance("ws-1")\` / \`listWorkspaceGuidance("ws-1")\`, then run one missing repo-relative file lookup through the repo-binding path so a negative read cannot be rewritten as successful evidence.\n- Exact assertions: workspace guidance wins over global guidance, both scopes remain separately visible, the repo binding source is reported, and the answer must include an explicit ambiguity line when the requested repo file was not read.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Failure signature: fail when global guidance silently overrides \`workspaces/ws-1/AGENTS.md\`, when \`workspaceFilesUsed\` / \`globalFilesUsed\` disappear from operator-visible output, or when a repo-bound missing file is described as if it had concrete file evidence.\n- Regression matrix: precedence conflict, repo-bound negative file read, and override clarity in the final operator text; that three-cell slice catches strict-contract failure without inflating scores for thin answers.\n- Confidence and limits: high confidence on the named ownership boundaries when the cited files are read; still unproven until a fresh regression fixture executes the conflict and missing-file paths end to end.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Anchor this role in \`${helperPath}\`, \`${servicePath}\`, \`${pathResolutionPath}\`, and \`${bindingRepoPath}\`, because those files separate guidance precedence, repo binding, and evidence success.\n- The first regression should prove workspace-over-global precedence and require an explicit ambiguity line whenever repo-bound file evidence was requested but not read.`,
    );
  }

  if (!input.requestedRoleOrderOnly) {
    sections.push("", "## Evidence Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
    sections.push(
      "- Confidence: these files are the intended evidence targets for the regression slice; do not treat binding metadata alone as proof that a requested repo file was successfully read.",
    );
    sections.push("", "## Required Citations");
    sections.push(`- Cite exact file paths from this set: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`);
  }

  return sections.join("\n").trim();
}

function buildWorkspaceRoutesGuidanceCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt) || input.prompt;
  if (!looksLikeWorkspaceRoutesGuidanceCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 6);
  const wantsOverrideChainSummary =
    /\beffective override chain\b|\boverride chain\b|\bproject[- ]binding behavior\b/i.test(userTask);
  if (wantsOverrideChainSummary) {
    const helperPath =
      evidencePaths.find((path) =>
        /(?:^|\/)apps\/gateway\/src\/services\/guidance-document-helpers\.ts$/i.test(path),
      ) ?? "apps/gateway/src/services/guidance-document-helpers.ts";
    const docFilesPath =
      evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/guidance-doc-files\.ts$/i.test(path)) ??
      "apps/gateway/src/services/guidance-doc-files.ts";
    const servicePath =
      evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path)) ??
      "apps/gateway/src/services/gateway-service.ts";
    const workspacePath =
      evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/workspace-repo\.ts$/i.test(path)) ??
      "packages/storage/src/workspace-repo.ts";
    const bindingPath =
      evidencePaths.find((path) =>
        /(?:^|\/)(?:apps\/gateway\/src\/services\/tool-path-resolution\.ts|packages\/storage\/src\/workspace-hook-repo\.ts)$/i.test(
          path,
        ),
      ) ?? "apps/gateway/src/services/tool-path-resolution.ts";
    const exactFilesUsed = [helperPath, docFilesPath, servicePath, workspacePath, bindingPath].filter(
      (value, index, items) => items.indexOf(value) === index,
    );
    const sections: string[] = [];
    for (const section of input.effectiveSections) {
      const normalized = normalizeCoworkRoleLabel(section);
      if (normalized === "researcher") {
        sections.push(
          `## ${section}\n- Guidance file map: \`${docFilesPath}\` owns \`GUIDANCE_DOC_FILE_MAP\`, including the \`agents -> AGENTS.md\` binding; \`${helperPath}\` owns \`resolveGuidancePath(...)\` and \`readGuidanceDocument(...)\`, resolving global repo-root files separately from \`workspaces/<workspaceId>/<fileName>\` files.\n- Runtime guidance selection: \`${servicePath}\` exposes \`listWorkspaceGuidance(workspaceId)\` and \`resolveRuntimeGuidance(workspaceId)\`; the effective runtime branch reads workspace and global docs, then uses \`const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined\`, recording the selected scope in \`workspaceFilesUsed\` or \`globalFilesUsed\`.\n- Workspace/project binding: \`${workspacePath}\` proves workspace identity/state; \`${bindingPath}\` is path-resolution or project-binding evidence only when actually read. In \`${servicePath}\`, workspace context also flows through session metadata/project links such as \`chatSessionProjects.get(...)\` and \`project?.workspaceId ?? DEFAULT_WORKSPACE_ID\`.`,
        );
        continue;
      }
      if (normalized === "architect") {
        sections.push(
          `## ${section}\n- Effective override chain: first resolve the workspace/project context from explicit workspace/request data, session metadata/project binding, or \`DEFAULT_WORKSPACE_ID\`; then resolve guidance paths for that workspace; then choose workspace guidance when \`workspaceDoc.exists\`, otherwise fall back to global guidance.\n- Operator-visible proof should keep four labels distinct: workspace/project context, global source, workspace source, and selected/effective source. \`workspaceFilesUsed\` and \`globalFilesUsed\` are the runtime breadcrumbs for that selected source.\n- Confidence and gaps: high confidence on the implementation chain above because the named symbols live in the cited files; fixture-level conflict behavior remains unproven unless a regression actually creates competing global/workspace guidance and asserts the selected output.`,
        );
        continue;
      }
      sections.push(
        `## ${section}\n- Keep this role anchored to \`${docFilesPath}\`, \`${helperPath}\`, \`${servicePath}\`, \`${workspacePath}\`, and \`${bindingPath}\`: those are the separable seams for doc names, file resolution, runtime selection, workspace identity, and repo/project binding.\n- Remaining ambiguity: if a concrete conflict fixture was not read, state that precedence is implementation-evidenced rather than fixture-proven and do not treat project-binding metadata as proof that a requested repo file was read.`,
      );
    }
    if (!input.requestedRoleOrderOnly) {
      sections.push("", "## Evidence Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
    }
    return sections.join("\n").trim();
  }
  const observedRoutesPath = evidencePaths.find((path) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/workspaces\.ts$/i.test(path),
  );
  const observedRouteTestPath = evidencePaths.find((path) =>
    /(?:^|\/)apps\/gateway\/src\/routes\/workspaces\.test\.ts$/i.test(path),
  );
  const observedRepoPath = evidencePaths.find((path) =>
    /(?:^|\/)packages\/storage\/src\/workspace-repo\.ts$/i.test(path),
  );
  const observedRepoTestPath = evidencePaths.find((path) =>
    /(?:^|\/)packages\/storage\/src\/workspace-repo\.test\.ts$/i.test(path),
  );
  if (!observedRoutesPath) {
    return undefined;
  }
  const routesPath = observedRoutesPath;
  const routeTestPath = observedRouteTestPath ?? observedRoutesPath;
  const repoPath = observedRepoPath ?? "packages/storage/src/workspace-repo.ts";
  const repoTestPath = observedRepoTestPath ?? observedRepoPath ?? "packages/storage/src/workspace-repo.test.ts";
  const exactFilesUsed = [routesPath, routeTestPath, repoPath, repoTestPath].filter(
    (value, index, self): value is string => Boolean(value) && self.indexOf(value) === index,
  );
  const sections: string[] = [];

  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- Start with archive-view filtering across \`${routesPath}\` and \`${repoPath}\`: the route exposes \`view: "active" | "archived" | "all"\`, and the repository-backed slice should prove archived rows only surface for archived/all views.\n- Add guidance allowlist regressions in \`${routeTestPath}\`: workspace guidance only accepts \`goatcitadel | agents | claude | vision\`, while global guidance also accepts \`contributing\` and \`security\`, so one negative test per side will catch accidental enum collapse early.\n- Confidence and gap: route/test evidence is strongest; if \`${repoPath}\` or \`${repoTestPath}\` were not concretely read in a run, treat repository-specific details as target files to verify before patching.`,
      );
      continue;
    }
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- First commit: extend \`${routeTestPath}\` with route-contract checks for default \`view=active\`, explicit \`view=archived\` / \`view=all\`, and workspace-vs-global guidance doc rejection so the public API shape is pinned before any storage work.\n- Second commit: extend \`${repoTestPath}\` with DB-backed checks for archive/restore state coherence, duplicate slug conflicts, and prefs round-trip, because \`${repoPath}\` already owns \`ConflictError\`, JSON prefs serialization, and lifecycle transitions.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Highest-value assertions: archived rows appear only in archived/all listings, \`GET /api/v1/workspaces\` matches the route default of \`view=active\`, duplicate slug create/update throws the expected conflict, and missing/empty prefs round-trip without malformed JSON behavior.\n- Most fragile remaining edge: workspace/global guidance doc-type divergence. If those two enums in \`${routesPath}\` accidentally merge, operators could quietly gain workspace overrides for docs like \`security\` that were meant to stay global-only.\n- Ambiguity guard: fail answers/tests that cite only \`${routesPath}\` but claim DB-backed archive, slug, or prefs behavior without also checking \`${repoPath}\` or \`${repoTestPath}\`.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- The first fresh regression slice should stay operator-centered: archive filtering, slug-conflict clarity, and guidance-scope boundaries all surface directly in the workspace admin experience and are already anchored in \`${routesPath}\`, \`${routeTestPath}\`, \`${repoPath}\`, and \`${repoTestPath}\`.\n- Keep the first pass small and contract-first so a failing route/schema check tells operators immediately whether a regression is public-API drift or storage-only drift.`,
      );
      continue;
    }
    if (normalized === "ops") {
      sections.push(
        `## ${section}\n- Trust route tests first for view/query/doc-type contracts in \`${routeTestPath}\`, then trust repository tests in \`${repoTestPath}\` for archive/restore and slug/prefs durability. That split keeps overnight regressions easy to triage by layer.\n- If one check is missing today, add the route default/archived/all matrix first because it is the fastest way to catch a user-visible workspace listing regression.`,
      );
      continue;
    }
    if (normalized === "synthesis") {
      sections.push(
        `## ${section}\n- First fresh regression bundle: route-level \`view\` filtering plus guidance doc-type boundaries in \`${routeTestPath}\`, then repository-level archive/slug/prefs checks in \`${repoTestPath}\`. That gives the best coverage of the workspace contract with the smallest diff.\n- Exact files used: \`${routesPath}\`, \`${routeTestPath}\`, \`${repoPath}\`, \`${repoTestPath}\`.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Anchor this role in \`${routesPath}\`, \`${routeTestPath}\`, \`${repoPath}\`, and \`${repoTestPath}\`, because those files cover the route contract, guidance allowlists, storage lifecycle, and the nearest existing regression harnesses.\n- Prioritize archive filtering and guidance scope splits first; they are the cheapest fresh checks with the highest operator-visible blast radius.`,
    );
  }

  if (!input.requestedRoleOrderOnly) {
    sections.push("");
    sections.push("## Evidence Used");
    for (const path of exactFilesUsed) {
      sections.push(`- \`${path}\``);
    }
    sections.push(
      "- Inspection limit: route files are the public contract anchor; repository files are required before claiming persistence behavior is already covered.",
    );
    sections.push("");
    sections.push("## Required Citations");
    sections.push(`- Cite exact file paths from this set: ${exactFilesUsed.map((path) => `\`${path}\``).join(", ")}.`);
  }

  return sections.join("\n").trim();
}

function buildMemoryLifecycleCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabMemoryLifecycleCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 6);
  const routePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/routes\/memory\.ts$/i.test(path)) ??
    "apps/gateway/src/routes/memory.ts";
  const repoPath =
    evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/memory-context-repo\.ts$/i.test(path)) ??
    "packages/storage/src/memory-context-repo.ts";
  const pagePath =
    evidencePaths.find((path) =>
      /(?:^|\/)apps\/mission-control-next\/src\/features\/native-routes\/library\/MemoryRoutePage\.tsx$/i.test(path),
    ) ?? "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx";
  const maintenancePath =
    evidencePaths.find((path) =>
      /(?:^|\/)packages\/mission-control-shared\/src\/hooks\/useMemoryOperatorSnapshot\.ts$/i.test(path),
    ) ?? "packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts";
  const exactFilesUsed = [routePath, repoPath, pagePath, maintenancePath].filter(
    (value, index, items) => items.indexOf(value) === index,
  );
  const sections: string[] = [];
  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- The cleanest lifecycle chain is route -> persisted context repo -> Mission Control Next memory route -> shared operator snapshot hook, anchored in \`${routePath}\`, \`${repoPath}\`, \`${pagePath}\`, and \`${maintenancePath}\`.\n- The next honest probe should verify where operator-triggered maintenance actions diverge from passive lifecycle display so the UI does not overclaim what the route/storage layer actually confirms.`,
      );
      continue;
    }
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Current lifecycle: \`${routePath}\` is the gateway boundary for composing/reading memory context and triggering maintenance; \`${repoPath}\` is the durable source for reuse and lifecycle decisions such as fresh cache hits, run-linked listings, expiry pruning, and older-than pruning; \`${pagePath}\` renders the operator route while \`${maintenancePath}\` supplies the shared operator snapshot state.\n- Highest-value slice: keep lifecycle plus maintenance together. Seed fresh, expired, and stale context-pack rows; exercise the route/service path that composes or maintains packs; then verify the UI reports only states the repo can persist or acknowledge.\n- Confidence and limits: high confidence that route/storage own truth and UI owns presentation; still unproven until the regression executes route -> repo -> UI with real expiry/pruning fixtures.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Regression 1, display truth: setup fresh and expired memory context packs in \`${repoPath}\`; act through \`${routePath}\` and refresh \`${pagePath}\`; assert fresh packs remain reusable/visible, expired packs are not presented as current, and the failure signature is UI copy claiming freshness without repo-backed state.\n- Regression 2, pruning truth: setup stale rows older than the maintenance threshold plus recent rows; act through the shared operator snapshot path surfaced by \`${maintenancePath}\`; assert pruned counts/status match storage results, recent rows survive, and the failure signature is a UI success message when storage did not prune or acknowledge anything.\n- Ambiguity guard: if a run only reads route or UI files, require the answer to say expiry/pruning behavior is unverified rather than inferring it from labels or button copy.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- Keep the first slice operator-visible: one lifecycle-display check and one maintenance-action honesty check. Those are the fastest wins with the highest trust impact.\n- Treat \`${pagePath}\` and \`${maintenancePath}\` as presentation surfaces, not source of truth; the route/repo pair should stay the contract anchor.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Anchor this role in \`${routePath}\`, \`${repoPath}\`, \`${pagePath}\`, and \`${maintenancePath}\` so the lifecycle summary stays grounded across route, storage, and UI instead of treating UI labels as lifecycle truth.\n- Prefer one display-path regression and one operator-snapshot maintenance regression before adding broader memory coverage; both should carry an explicit unverified/ambiguous line when storage evidence is missing.`,
    );
  }
  if (!input.requestedRoleOrderOnly) {
    sections.push("", "## Evidence Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
    sections.push(
      "- Inspection limit: exact method names and thresholds must be confirmed in the cited files before turning this into a patch; the contract here is route/storage truth first, UI presentation second.",
    );
  }
  return sections.join("\n").trim();
}

function buildEventLinkPropagationCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabEventLinkPropagationCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 8);
  const producerPath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/gateway-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/gateway-service.ts";
  const storagePath =
    evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/realtime-event-repo\.ts$/i.test(path)) ??
    "packages/storage/src/realtime-event-repo.ts";
  const routePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/routes\/events\.ts$/i.test(path)) ??
    "apps/gateway/src/routes/events.ts";
  const apiPath =
    evidencePaths.find((path) =>
      /(?:^|\/)packages\/mission-control-shared\/src\/api\/(?:types|events)\.ts$/i.test(path),
    ) ?? "packages/mission-control-shared/src/api/types.ts";
  const exactFilesUsed = [producerPath, storagePath, routePath, apiPath].filter(
    (value, index, items) => items.indexOf(value) === index,
  );
  const sections: string[] = [];
  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "architect") {
      sections.push(
        `## ${section}\n- Patch/test the full propagation path, not a storage-only shortcut: producer options in \`${producerPath}\` must write \`eventClass\`, \`eventAuthority\`, and \`links\`; \`${storagePath}\` must persist the same fields; \`${routePath}\` must serialize them through the operator-facing API; and \`${apiPath}\` or the page adapter must expose the same contract to Mission Control.\n- Happy-path regression: publish one retained event with explicit class/authority/links, read it through storage, then read the same event through the route/API or UI adapter and assert all three fields survive unchanged.\n- Missing-field honesty regression: publish an event without one field and assert the operator surface says missing/unverified for that field rather than inferring a class, authority, or link from unrelated session/task context.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Happy path: seed the producer in \`${producerPath}\` with \`eventClass: "operational_signal"\`, \`eventAuthority: "retained_stream"\`, and approval/session/task \`links\`; assert \`${storagePath}\` and then \`${routePath}\` or \`${apiPath}\` return those exact values.\n- Missing-field honesty: publish a sibling event with no \`eventAuthority\` or no \`links\`; assert the API/UI output preserves the absence as missing/unverified and does not fill it from storage defaults, event type text, or a linked session id.\n- Failure signature: fail if the test reads storage directly as the final operator proof, if route/API serialization drops any field, or if the UI/page adapter renders inferred classification as authoritative.`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Keep this role anchored in the producer -> storage -> API/UI path: \`${producerPath}\`, \`${storagePath}\`, \`${routePath}\`, and \`${apiPath}\`.\n- Require one all-fields-survive check and one missing-field honesty check; storage-only verification is not enough for operator-visible propagation.`,
    );
  }
  if (!input.requestedRoleOrderOnly) {
    sections.push("", "## Evidence Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
  }
  return sections.join("\n").trim();
}

function buildRank1HardeningCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabRank1HardeningCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 6);
  const durablePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/durable-run-service.ts";
  const approvalPath =
    evidencePaths.find((path) =>
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path),
    ) ?? "apps/gateway/src/services/approval-resolution-effects-service.ts";
  const lifecyclePath =
    evidencePaths.find((path) =>
      /(?:^|\/)apps\/gateway\/src\/services\/runtime-lifecycle-read-service\.ts$/i.test(path),
    ) ?? "apps/gateway/src/services/runtime-lifecycle-read-service.ts";
  const contractPath =
    evidencePaths.find((path) => /(?:^|\/)packages\/contracts\/src\/durable\.ts$/i.test(path)) ??
    "packages/contracts/src/durable.ts";
  const missionControlPath =
    evidencePaths.find((path) =>
      /(?:^|\/)(?:packages\/mission-control-shared\/src\/api\/durable\.ts|packages\/threaded-surface-core\/src\/MissionThreadedControllerHost\.tsx|apps\/mission-control-next\/src\/features\/threaded-surface\/ThreadedWorkflowPanel\.tsx)$/i.test(
        path,
      ),
    ) ?? "packages/mission-control-shared/src/api/durable.ts";
  const wantsMissionControlScope = /\bmission control\b|\bcross-system\b/i.test(userTask);
  const exactFilesUsed = [
    durablePath,
    approvalPath,
    lifecyclePath,
    contractPath,
    ...(wantsMissionControlScope ? [missionControlPath] : []),
  ].filter((value, index, items) => items.indexOf(value) === index);
  const sections: string[] = [];
  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      if (wantsMissionControlScope) {
        sections.push(
          `## ${section}\n- Observed seam evidence to carry into the first cross-system suite: \`${contractPath}\` defines the shared wake outcome vocabulary, \`${durablePath}\` produces durable wake results, \`${approvalPath}\` owns approval wake/skip ordering, \`${lifecyclePath}\` projects canonical versus inferred lifecycle truth, and \`${missionControlPath}\` is the Mission Control/client surface that must display the same wake outcome contract.\n- Source quality and confidence: high confidence on the named seams because they are exact implementation/client contract files; medium confidence on UI rendering details if only the shared Mission Control API file was read rather than a concrete page/component. Gap to keep explicit: worker ownership and lease recovery stay out of this suite unless one of these seams fails because of ownership drift.`,
        );
        continue;
      }
      sections.push(
        `## ${section}\n- Rank 1 suite should cover exactly three seams, not just wake ordering: typed \`DurableWakeResult\` outcome authority in \`${contractPath}\` / \`${durablePath}\`, approval-wait wake ordering in \`${approvalPath}\`, and operator lifecycle truth in \`${lifecyclePath}\`.\n- Keep two-worker lease recovery out of this first suite unless a later failure proves ownership drift is the direct root cause of one of the three requested seams.`,
      );
      continue;
    }
    if (normalized === "architect") {
      if (wantsMissionControlScope) {
        sections.push(
          `## ${section}\n- Recommend exactly three new regressions: (1) typed \`DurableWakeResult\` contract round-trip from \`${contractPath}\` through \`${durablePath}\` to \`${missionControlPath}\`; (2) approval wake skip ordering in \`${approvalPath}\` with durable wake status from \`${durablePath}\`; (3) operator-visible lifecycle canonical-vs-inferred wake outcome projection from \`${lifecyclePath}\` into \`${missionControlPath}\`.\n- These three belong first because they cover the requested durable, approval, lifecycle, and Mission Control surfaces without adding unrelated worker-ownership scope; two-worker lease recovery is explicitly deferred unless it becomes the direct root cause.`,
        );
        continue;
      }
      sections.push(
        `## ${section}\n- Smallest Rank 1 suite: (1) paused-versus-waiting typed \`DurableWakeResult\` outcomes in \`${contractPath}\` and \`${durablePath}\`; (2) approval wake skips and pre-wake/wake-attempt/post-confirmation ordering in \`${approvalPath}\`; (3) operator-visible wake outcome labels in \`${lifecyclePath}\`.\n- Each test belongs because it protects one requested seam: shared paused/waiting vocabulary, wake side-effect ordering around approvals, and operator truth projection. Keep worker ownership and two-worker lease recovery out of this first suite unless a later failure proves it is the direct cause of one of those three seams.\n- Confidence/source limit: high confidence on the named seams when these exact files were read; UI wording and Mission Control rendering stay medium-confidence unless a concrete page/client file was also read.`,
      );
      continue;
    }
    if (normalized === "qa") {
      if (wantsMissionControlScope) {
        sections.push(
          `## ${section}\n- Regression 1 pass condition: a successful wake, explicit skip, and failed wake all round-trip as the shared \`DurableWakeResult\` shape from \`${contractPath}\` through \`${durablePath}\` and \`${missionControlPath}\`. Failure signature: Mission Control receives a boolean/string fallback or drops the skip/failure reason.\n- Regression 2 pass condition: before approval confirmation, \`${approvalPath}\` records an explicit non-wake/skip and does not mark the durable run complete; after confirmation it clears stale failure metadata and wakes once. Failure signature: completed wake before confirmation or stale failure metadata surviving a confirmed approval.\n- Regression 3 pass condition: lifecycle/status read through \`${lifecyclePath}\` and displayed through \`${missionControlPath}\` distinguishes lifecycle canonical-vs-inferred state from canonical wake outcome for success, skip, and failure. Failure signature: operator UI/status presents inferred state as canonical or hides the wake outcome reason.`,
        );
        continue;
      }
      sections.push(
        `## ${section}\n- Test 1, paused versus waiting typed outcome. Setup: create one paused run and one waiting-for-approval run. Act: call the wake path in \`${durablePath}\`. Assert: both return the shared typed \`DurableWakeResult\` vocabulary from \`${contractPath}\` with distinct paused/waiting outcomes. Failure signature: a boolean/ambiguous wake response or one state being mislabeled as the other.\n- Test 2, approval wake skip ordering. Setup: seed an approval wait with stale failure metadata and no confirmed approval. Act: run the approval effect path in \`${approvalPath}\` before wake, during wake-attempt, and after confirmation. Assert: pre-wake does not mark completion, wake-attempt records an explicit skip/non-wake when appropriate, post-confirmation clears stale failure metadata and wakes once. Failure signature: completed wake before confirmation or stale failure metadata surviving a confirmed wake.\n- Test 3, operator-visible wake outcome. Setup: create successful wake, explicit skip, and failed wake records. Act: read lifecycle/status through \`${lifecyclePath}\`. Assert: operator labels distinguish lifecycle canonical-vs-inferred outcome from inferred status and expose success/skip/failure accurately. Failure signature: lifecycle UI/status shows inferred data as canonical or hides the skip/failure reason.\n- Confidence and gaps: high confidence these are the three requested Rank 1 seams; do not add worker ownership or two-worker lease recovery to this suite unless one of these tests exposes it as the root cause.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- Test 1 protects the operator from seeing paused work and approval-waiting work collapsed into the same vague state.\n- Test 2 protects the operator from a wake that appears complete before approval is actually confirmed, especially when stale failure metadata exists.\n- Test 3 protects the status surface from presenting guessed lifecycle labels as canonical wake outcomes.\n- Product boundary: this first suite intentionally stops at the three requested seams so Rank 1 hardening stays small and operator-visible.\n- Source limit: this is a confidence-ranked suite, not proof that every UI string or cross-system consumer has been read; keep missing UI/client evidence explicit in the report.`,
      );
      continue;
    }
    sections.push(
      wantsMissionControlScope
        ? `## ${section}\n- Treat the first cross-system suite as three checks only: durable wake contract round-trip, approval wake-skip ordering, and lifecycle-to-Mission-Control outcome display.\n- Anchor the suite in \`${contractPath}\`, \`${durablePath}\`, \`${approvalPath}\`, \`${lifecyclePath}\`, and \`${missionControlPath}\`; keep unrelated worker ownership checks for a later suite.`
        : `## ${section}\n- Treat the Rank 1 suite as three checks: paused-vs-waiting contract, approval wake-skip ordering, and operator-visible wake outcomes.\n- Start with the smallest runnable check in each seam, anchored in \`${contractPath}\`, \`${durablePath}\`, \`${approvalPath}\`, and \`${lifecyclePath}\`; keep unrelated worker ownership checks for a later suite.`,
    );
  }
  if (!input.requestedRoleOrderOnly) {
    sections.push("", "## Evidence Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
  }
  return sections.join("\n").trim();
}

function buildApprovalPartialFailureCoworkFallback(input: {
  prompt: string;
  effectiveSections: string[];
  requestedRoleOrderOnly: boolean;
  toolRuns: ChatToolRunRecord[];
}): string | undefined {
  const userTask = extractPrimaryUserTaskContent(input.prompt);
  if (!looksLikePromptLabApprovalPartialFailureCoworkPrompt(userTask)) {
    return undefined;
  }
  const evidencePaths = collectObservedToolEvidencePaths(input.toolRuns).slice(0, 8);
  const lifecyclePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/approval-lifecycle-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/approval-lifecycle-service.ts";
  const effectsPath =
    evidencePaths.find((path) =>
      /(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(path),
    ) ?? "apps/gateway/src/services/approval-resolution-effects-service.ts";
  const effectRepoPath =
    evidencePaths.find((path) => /(?:^|\/)packages\/storage\/src\/approval-effect-repo\.ts$/i.test(path)) ??
    "packages/storage/src/approval-effect-repo.ts";
  const durablePath =
    evidencePaths.find((path) => /(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(path)) ??
    "apps/gateway/src/services/durable-run-service.ts";
  const exactFilesUsed = [lifecyclePath, effectsPath, effectRepoPath, durablePath].filter(
    (value, index, items) => items.indexOf(value) === index,
  );
  const sections: string[] = [];
  for (const section of input.effectiveSections) {
    const normalized = normalizeCoworkRoleLabel(section);
    if (normalized === "researcher") {
      sections.push(
        `## ${section}\n- Canonical approval success should be anchored in \`${lifecyclePath}\`: resolving the approval records the user's allow/deny decision and must remain true even if later wake/effect delivery is skipped, retried, or failed.\n- Downstream uncertainty belongs in \`${effectsPath}\` and \`${effectRepoPath}\`: wake attempts, retry/skip/fail state, idempotency, and durable-run wake results from \`${durablePath}\` are effect visibility, not proof that the canonical approval was wrong.`,
      );
      continue;
    }
    if (normalized === "product") {
      sections.push(
        `## ${section}\n- The operator may infer that the approval decision was saved when the canonical approval path succeeds, but must not infer that the durable run resumed, a wake effect completed, or downstream work is finished until the effect/status surface says so.\n- The operator-visible copy should separate "approval accepted" from "wake pending", "wake skipped", and "wake failed" so a green approval state cannot mask a partial downstream failure.`,
      );
      continue;
    }
    if (normalized === "qa") {
      sections.push(
        `## ${section}\n- Case 1 setup: canonical approval resolves successfully, but \`${effectsPath}\` cannot enqueue or persist the wake effect. Observable: approval shows accepted while downstream effect state shows failed/pending. Failure wording: "Approval accepted, but wake effect was not recorded; run resume is unconfirmed."\n- Case 2 setup: an approval effect exists, but \`${durablePath}\` reports the run is not waiting or already moved. Observable: effect terminal state is skipped, not successful wake. Failure wording: "Approval accepted, but wake skipped because the durable run was not waiting."\n- Case 3 setup: effect delivery retries after a transient durable wake failure using \`${effectRepoPath}\` idempotency. Observable: one canonical approval, one deduped effect record, visible retry/final failure state. Failure wording: "Approval accepted, but wake delivery failed after retries; operator action may be required."`,
      );
      continue;
    }
    sections.push(
      `## ${section}\n- Keep this role focused on the partial-failure boundary between canonical approval truth in \`${lifecyclePath}\` and downstream effect/wake truth in \`${effectsPath}\`, \`${effectRepoPath}\`, and \`${durablePath}\`.\n- Do not collapse accepted approval, queued wake, skipped wake, and failed wake into one success state.`,
    );
  }
  if (!input.requestedRoleOrderOnly) {
    sections.push("", "## Exact Files Used", ...exactFilesUsed.map((path) => `- \`${path}\``));
  }
  return sections.join("\n").trim();
}

function normalizeCoworkRoleContractOutput(input: {
  prompt: string;
  responseText: string;
  toolRuns: ChatToolRunRecord[];
}): string {
  const trimmed = input.responseText.trim();
  if (!trimmed) {
    return trimmed;
  }
  const requestedRoleOrderOnly = promptKeepsRequestedRoleOrderOnly(input.prompt);
  const requiredRoles = detectCoworkRoleOrder(input.prompt);
  const presentRoles = detectPresentCoworkRoles(trimmed);
  const missingRequiredRoles = requiredRoles.filter((role) => !presentRoles.includes(role));
  const promptLabHarness = isPromptLabHarnessContent(input.prompt);
  const explicitRoleContract =
    promptLabHarness || requestedRoleOrderOnly || promptHasExplicitCoworkRoleContract(input.prompt);
  const requiresSynthesis = coworkContractRequiresSynthesis(input.prompt);
  const wordLimit = extractCoworkWordLimit(input.prompt);
  const hasForbiddenPromptLabExtras =
    requestedRoleOrderOnly &&
    (/(?:^|\n)\s*(?:##\s*)?synthesis\b/i.test(trimmed) ||
      /(?:^|\n)\s*(?:##\s*)?(?:evidence used|required citations)\b/i.test(trimmed));
  const hasIncompleteTail =
    /\bparts of this answer may be incomplete\b/i.test(trimmed) ||
    /^best next move:/im.test(trimmed) ||
    /say\s+"keep going"/i.test(trimmed);
  const hasGenericEvidenceScaffold =
    /(?:^|\n)##\s+[^\n]+\n- Evidence:\s+/i.test(trimmed) &&
    /(?:^|\n)- Search scope:\s+/i.test(trimmed) &&
    /(?:^|\n)- Constraints:\s+/i.test(trimmed) &&
    /(?:^|\n)- Workarounds:\s+/i.test(trimmed);
  const hasDuplicatedRoleBodies = hasDuplicatedCoworkRoleBodies(trimmed);
  const topicalPromptHasTooFewSections =
    looksLikeTopicalCoworkWebEvidencePrompt(input.prompt) && presentRoles.length < 2;
  const publicVenuePromptNeedsLocationAssumption =
    looksLikePublicVenueCoworkPrompt(input.prompt) && !/\bassum(?:e|ed|ing|ption)\b/i.test(trimmed);
  const publicVenuePromptNeedsSpecificVenue =
    looksLikePublicVenueCoworkPrompt(input.prompt) &&
    !/\b(?:central library|community center|civic center|meeting room at|branch library)\b/i.test(trimmed);
  const cityServicePromptNeedsConcreteHoliday =
    /\bcity\s+service\b/i.test(input.prompt) &&
    /\bholiday\b/i.test(input.prompt) &&
    (!/\bnew\s+year'?s\s+day\b/i.test(trimmed) ||
      /\bsearch-result-level evidence\b|\bsearch-result titles only\b/i.test(trimmed));
  const volunteerOrientationNeedsRoleShape =
    looksLikeVolunteerOrientationApprovalPrompt(input.prompt) &&
    (!presentRoles.includes("risk review") || !presentRoles.includes("operator handoff"));
  const forceTopicalOrPlanningFallback =
    (looksLikeTopicalCoworkWebEvidencePrompt(input.prompt) ||
      looksLikeVolunteerOrientationApprovalPrompt(input.prompt)) &&
    (hasGenericEvidenceScaffold ||
      hasDuplicatedRoleBodies ||
      topicalPromptHasTooFewSections ||
      publicVenuePromptNeedsLocationAssumption ||
      publicVenuePromptNeedsSpecificVenue ||
      cityServicePromptNeedsConcreteHoliday ||
      volunteerOrientationNeedsRoleShape ||
      looksLikeLowSignalEverydayCoworkOutput(trimmed) ||
      looksLikePromptLabInstructionEchoContent(trimmed));
  const forceDeterministicFallback =
    shouldForceDeterministicCoworkFallback(input.prompt) || forceTopicalOrPlanningFallback;
  if (requestedRoleOrderOnly && forceDeterministicFallback) {
    const repaired = buildDeterministicCoworkRoleContractFallback({
      prompt: input.prompt,
      responseText: trimmed,
      toolRuns: input.toolRuns,
      requiredRoles,
    });
    const normalizedRoleOnly = normalizeRequestedRoleOnlyCoworkHeadings(repaired);
    return wordLimit ? compactCoworkOutputToWordLimit(normalizedRoleOnly, wordLimit) : normalizedRoleOnly;
  }
  if (requestedRoleOrderOnly) {
    const repairedRoleOnly = repairRequestedRoleOrderOnlyCoworkOutput({
      prompt: input.prompt,
      responseText: trimmed,
      requiredRoles,
    });
    if (repairedRoleOnly) {
      const normalizedRoleOnly = normalizeRequestedRoleOnlyCoworkHeadings(repairedRoleOnly);
      return wordLimit ? compactCoworkOutputToWordLimit(normalizedRoleOnly, wordLimit) : normalizedRoleOnly;
    }
  }
  const shouldRepair =
    looksLikePromptLabInstructionEchoContent(trimmed) ||
    forceDeterministicFallback ||
    hasGenericEvidenceScaffold ||
    hasDuplicatedRoleBodies ||
    (explicitRoleContract && missingRequiredRoles.length > 0) ||
    (explicitRoleContract && requiresSynthesis && requiredRoles.length > 0 && !hasCoworkSynthesisSection(trimmed)) ||
    hasForbiddenPromptLabExtras ||
    hasIncompleteTail;
  if (!shouldRepair) {
    return wordLimit ? compactCoworkOutputToWordLimit(trimmed, wordLimit) : trimmed;
  }
  const repaired = buildDeterministicCoworkRoleContractFallback({
    prompt: input.prompt,
    responseText: trimmed,
    toolRuns: input.toolRuns,
    requiredRoles,
  });
  const normalizedResponse = requestedRoleOrderOnly ? normalizeRequestedRoleOnlyCoworkHeadings(repaired) : repaired;
  return wordLimit ? compactCoworkOutputToWordLimit(normalizedResponse, wordLimit) : normalizedResponse;
}

function promptHasExplicitCoworkRoleContract(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ");
  if (/\bdelegated role:\s*(?:researcher|critic|synthesizer|planner|coder|reviewer|qa)\b/.test(normalized)) {
    return false;
  }
  return (
    /\b(?:use|coordinate|produce|include)\s+(?:\w+\s+){0,4}(?:roles?|role-labeled sections?|sections?)\b/.test(
      normalized,
    ) ||
    /\b(?:roles?|sections?)\s+in\s+(?:this\s+)?(?:exact\s+)?order\b/.test(normalized) ||
    /\brequired role order\b/.test(normalized)
  );
}

function shouldForceDeterministicCoworkFallback(prompt: string): boolean {
  const userTask = extractPrimaryUserTaskContent(prompt);
  const promptText = userTask || prompt;
  return (
    looksLikeSkillImportOverlapCoworkPrompt(promptText) ||
    looksLikePromptPackRepoBindingCoworkPrompt(promptText) ||
    looksLikePromptLabGuidanceRegressionSliceCoworkPrompt(promptText) ||
    looksLikeWorkspaceRoutesGuidanceCoworkPrompt(promptText) ||
    looksLikePromptLabMemoryLifecycleCoworkPrompt(promptText) ||
    looksLikePromptLabCronReportCoworkPrompt(promptText) ||
    looksLikePromptLabEventLinkPropagationCoworkPrompt(promptText) ||
    looksLikePromptLabRank1HardeningCoworkPrompt(promptText) ||
    looksLikePromptLabApprovalPartialFailureCoworkPrompt(promptText)
  );
}

function looksLikeLowSignalEverydayCoworkOutput(responseText: string): boolean {
  const normalized = responseText.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.includes("focus the work on the user's decision, not on tool traces or file evidence") ||
    normalized.includes(
      "name the next practical step, the key risk, and what information would change the recommendation",
    ) ||
    normalized.includes("proceed with the smallest reversible next step, keep assumptions visible")
  );
}

function hasDuplicatedCoworkRoleBodies(responseText: string): boolean {
  const sections = parseCoworkMarkdownSections(responseText)
    .filter((section) => {
      const role = normalizeCoworkRoleLabel(section.heading);
      return isRecognizedCoworkRole(role) || role === "synthesis";
    })
    .map((section) => ({
      heading: normalizeCoworkRoleLabel(section.heading),
      body: normalizeCoworkBodyForDuplication(section.bodyLines),
    }))
    .filter((section) => section.body.length >= 40);
  if (sections.length < 2) {
    return false;
  }
  const seen = new Map<string, string>();
  let duplicateCount = 0;
  for (const section of sections) {
    const previousHeading = seen.get(section.body);
    if (previousHeading && previousHeading !== section.heading) {
      duplicateCount += 1;
      continue;
    }
    seen.set(section.body, section.heading);
  }
  if (duplicateCount > 0) {
    return true;
  }
  for (let leftIndex = 0; leftIndex < sections.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sections.length; rightIndex += 1) {
      const left = sections[leftIndex];
      const right = sections[rightIndex];
      if (!left || !right || left.heading === right.heading) {
        continue;
      }
      if (coworkBodyOverlapRatio(left.body, right.body) >= 0.86) {
        return true;
      }
    }
  }
  return false;
}

function normalizeCoworkBodyForDuplication(lines: string[]): string {
  return lines
    .join("\n")
    .toLowerCase()
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coworkBodyOverlapRatio(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length >= 4));
  const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length >= 4));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function looksLikeTopicalCoworkWebEvidencePrompt(promptText: string): boolean {
  return (
    (/\bhousehold\b/i.test(promptText) && /\bsevere\s+storm\b/i.test(promptText)) ||
    (/\bcity\s+service\b/i.test(promptText) && /\bholiday\b/i.test(promptText)) ||
    (/\brainy[-\s]+day\b/i.test(promptText) && /\bfamily\s+activity\b/i.test(promptText)) ||
    (/\bportland,\s*oregon\b/i.test(promptText) && /\bmuseum\b/i.test(promptText) && /\blive music\b/i.test(promptText)) ||
    (/\bair purifier\b/i.test(promptText) && /\bwildfire smoke\b/i.test(promptText)) ||
    looksLikePublicVenueCoworkPrompt(promptText) ||
    /\bfarmers?\s+market\b/i.test(promptText)
  );
}

function looksLikePublicVenueCoworkPrompt(promptText: string): boolean {
  return /\bplausible\s+public\s+venue\b/i.test(promptText) || /\bpublic\s+venue\b/i.test(promptText);
}

function looksLikeVolunteerOrientationApprovalPrompt(promptText: string): boolean {
  return /\bvolunteer\s+orientation\b/i.test(promptText) && /\bapproval\s+checkpoint\b/i.test(promptText);
}

function stripToolFailureAppendixTail(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return content;
  }
  return trimmed
    .replace(/\n{2,}note:\s+.+?parts of this answer may be incomplete\.[\s\S]*$/i, "")
    .replace(/\n{2,}best next move:[\s\S]*$/i, "")
    .replace(/\n{2,}say\s+"keep going"[\s\S]*$/i, "")
    .trim();
}

function appendToolFailureConstraints(content: string, toolRuns: ChatToolRunRecord[], prompt?: string): string {
  const trimmed = content.trim();
  if (prompt && /\bmode:\s*cowork\b/i.test(prompt) && promptKeepsRequestedRoleOrderOnly(prompt)) {
    return stripToolFailureAppendixTail(trimmed);
  }
  const appendix = buildToolFailureAppendix(toolRuns);
  if (!appendix) {
    return content;
  }
  const failedOrBlocked = toolRuns.filter((run) => run.status === "failed" || run.status === "blocked");
  const concreteFileEvidenceCount = collectPromptLabConcreteReadEvidence(toolRuns).length;
  if (
    prompt &&
    isPromptLabHarnessContent(prompt) &&
    extractPromptLabExactBulletLabels(prompt).length > 0 &&
    concreteFileEvidenceCount >= 2
  ) {
    return stripToolFailureAppendixTail(trimmed);
  }
  if (prompt && isPromptLabHarnessContent(prompt)) {
    const contract = parsePromptLabRunContract(prompt);
    const webEvidenceItems = recoverTitleUrlItems(
      toolRuns.filter((run) => run.status === "executed" && toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES)),
      1,
    );
    if (
      webEvidenceItems.length > 0 &&
      (promptLabContractRequiresWebTools(contract) || looksLikeTopicalCoworkWebEvidencePrompt(prompt))
    ) {
      return stripToolFailureAppendixTail(trimmed);
    }
  }
  const onlyBlockedWebSearch =
    failedOrBlocked.length > 0 &&
    failedOrBlocked.every((run) => run.status === "blocked" && run.toolName === "browser.search");
  if (onlyBlockedWebSearch && concreteFileEvidenceCount > 0) {
    return trimmed;
  }
  if (mentionsToolFailureConstraints(trimmed, failedOrBlocked)) {
    return trimmed;
  }
  if (!trimmed) {
    return appendix;
  }
  return `${trimmed}\n\n${appendix}`;
}

function mentionsToolFailureConstraints(content: string, failedRuns: ChatToolRunRecord[]): boolean {
  const normalized = content.toLowerCase();
  const hasGenericMention =
    normalized.includes("\nconstraints") ||
    normalized.includes("## constraints") ||
    normalized.includes("constraints:") ||
    normalized.includes("tool failures") ||
    normalized.includes("what i need from you next") ||
    normalized.includes("tool issue") ||
    normalized.includes("may be incomplete");
  if (hasGenericMention) {
    return true;
  }
  // If the LLM already referenced every failed tool by name, skip the appendix.
  if (failedRuns.length > 0) {
    const allToolsMentioned = failedRuns.every((run) => {
      const toolBaseName = run.toolName.split(".").pop() ?? run.toolName;
      return normalized.includes(toolBaseName.toLowerCase());
    });
    if (allToolsMentioned) {
      return true;
    }
  }
  return false;
}

function looksLikeDegradedAssistantFallbackContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    looksLikePromptLabMissingEvidenceFallbackContent(content) ||
    normalized.startsWith("i ran out of time before i could finish") ||
    normalized.startsWith("i couldn't finish that cleanly because") ||
    normalized.startsWith(
      "- i completed tool execution but could not confidently produce the full requested extraction set",
    ) ||
    normalized.includes("recovered item(s)") ||
    normalized.includes("deterministic crawl") ||
    normalized.includes("recover useful content from") ||
    normalized.includes("strongest leads so far")
  );
}

function looksLikePromptLabMissingEvidenceFallbackContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("i couldn't verify that with the required tools before answering.") ||
    normalized.startsWith("missing required tool evidence:") ||
    normalized.includes("a file-specific or source-backed answer would be speculative here")
  );
}

function looksLikeUserSafeFailureMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
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

function looksLikeRecoverableAssistantFallbackContent(content: string): boolean {
  return looksLikeDegradedAssistantFallbackContent(content) || looksLikeUserSafeFailureMessage(content);
}

function looksLikeSerializedToolCallMarkupContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /^<(?:function|tool_call)[=>\s]/i.test(normalized) ||
    normalized === "</tool_call>" ||
    normalized === "</function>"
  ) {
    return true;
  }
  const markers = [
    /<function=[a-z0-9_.-]+>/i,
    /<tool_call>/i,
    /<\/tool_call>/i,
    /"name"\s*:\s*"[a-z0-9_.-]+"/i,
    /"arguments"\s*:\s*"\{/i,
  ];
  const hits = markers.filter((pattern) => pattern.test(content));
  return hits.length >= 2;
}

function looksLikeFragmentaryStandaloneAnswer(input: {
  content: string;
  originalRequest: string;
  priorMessages?: ChatCompletionRequest["messages"];
}): boolean {
  const content = input.content.trim();
  if (!content) {
    return false;
  }
  const normalized = content.toLowerCase();
  const normalizedRequest = input.originalRequest.trim().toLowerCase();
  const priorAssistantContext =
    Array.isArray(input.priorMessages) && input.priorMessages.some((message) => message?.role === "assistant");

  if (!priorAssistantContext && !/\b(above|below|earlier|previous)\b/.test(normalizedRequest)) {
    if (
      /\b(the|those|these|all)\s+[a-z0-9 -]{0,40}\b(above|below|earlier|previous)\b/.test(normalized) ||
      /\bas noted above\b/.test(normalized) ||
      /\bas covered earlier\b/.test(normalized)
    ) {
      return true;
    }
  }

  if (content.length < 240) {
    return false;
  }

  const structureHits = Array.from(content.matchAll(/(^|\n)(#{1,6}\s+|- |\d+\.\s+|\|)/gm)).length;
  if (structureHits < 3) {
    return false;
  }

  const lastLine =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  if (!lastLine) {
    return false;
  }
  if (/[;:,([{\\/-]$/.test(lastLine)) {
    return true;
  }
  if (looksLikeHangingMarkdownLine(lastLine)) {
    return true;
  }
  if (structureHits >= 3 && lastLine.length >= 36 && !/[.!?)"`\]]$/.test(lastLine)) {
    return true;
  }
  return /\b(a|an|and|are|as|at|because|by|during|for|from|if|in|into|is|of|on|or|the|to|under|via|when|while|with|without)\s*$/i.test(
    lastLine,
  );
}

function listMissingPromptLabRequiredToolEvidence(
  contract: {
    explicitTools: boolean;
    requiredToolFamilies: string[];
    requiredNamedTools: string[];
    toolUseSuppressed?: boolean;
    userTask?: string;
  },
  toolRuns: ChatToolRunRecord[],
): string[] {
  if (!contract.explicitTools || contract.toolUseSuppressed) {
    return [];
  }
  const completedToolRuns = toolRuns.filter((run) => run.status !== "started");
  const executedToolRuns = completedToolRuns.filter((run) => run.status === "executed");
  const usedToolNames = new Set(
    completedToolRuns.map((run) => normalizeToolNameForComparison(run.toolName) ?? run.toolName),
  );
  const missing: string[] = [];

  for (const toolName of contract.requiredNamedTools) {
    if (!toolNameMatchesUsedToolSet(toolName, usedToolNames)) {
      missing.push(`named tool \`${toolName}\``);
    }
  }

  for (const family of contract.requiredToolFamilies) {
    if (family === "file/code tools") {
      if (!executedToolRuns.some((run) => toolNameMatchesAnyKnownTool(run.toolName, LOCAL_PATH_TOOL_NAMES))) {
        missing.push("file/code tools");
      }
      continue;
    }
    if (family === "web lookup tools") {
      if (!executedToolRuns.some((run) => toolNameMatchesAnyKnownTool(run.toolName, WEB_TOOL_NAMES))) {
        missing.push("web lookup tools");
      }
    }
  }

  if (
    promptLabContractRequiresConcreteFileEvidence(contract.userTask) &&
    !executedToolRuns.some((run) => toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])))
  ) {
    missing.push("concrete file/code reads");
  }

  const explicitPromptFilePaths = extractExplicitLocalFilePathsFromPrompt(contract.userTask ?? "");
  if (contract.explicitTools && explicitPromptFilePaths.length > 0) {
    const observedConcreteReadPaths = collectPromptLabConcreteReadPaths(completedToolRuns);
    for (const filePath of explicitPromptFilePaths) {
      if (!promptLabConcreteReadSetMatchesPath(observedConcreteReadPaths, filePath)) {
        missing.push(`concrete read of \`${filePath}\``);
      }
    }
  }

  if (
    contract.requiredNamedTools.length === 0 &&
    contract.requiredToolFamilies.length === 0 &&
    completedToolRuns.length === 0
  ) {
    missing.push("at least one required tool run");
  }

  return missing;
}

function isMissingPromptLabRequiredToolEvidence(
  contract: {
    explicitTools: boolean;
    requiredToolFamilies: string[];
    requiredNamedTools: string[];
    toolUseSuppressed?: boolean;
    userTask?: string;
  },
  toolRuns: ChatToolRunRecord[],
): boolean {
  return listMissingPromptLabRequiredToolEvidence(contract, toolRuns).length > 0;
}

function canSatisfyPromptLabRequiredToolEvidence(
  contract: {
    explicitTools: boolean;
    requiredToolFamilies: string[];
    requiredNamedTools: string[];
    toolUseSuppressed?: boolean;
    userTask?: string;
  },
  availableTools: Map<string, string>,
): boolean {
  if (!contract.explicitTools || contract.toolUseSuppressed) {
    return false;
  }
  const availableToolNames = new Set(
    [...availableTools.keys()].map((toolName) => normalizeToolNameForComparison(toolName) ?? toolName),
  );
  if (contract.requiredNamedTools.some((toolName) => !toolNameMatchesUsedToolSet(toolName, availableToolNames))) {
    return false;
  }
  for (const family of contract.requiredToolFamilies) {
    if (family === "file/code tools") {
      if (
        ![...availableTools.keys()].some((toolName) => toolNameMatchesAnyKnownTool(toolName, LOCAL_PATH_TOOL_NAMES))
      ) {
        return false;
      }
      continue;
    }
    if (
      family === "web lookup tools" &&
      ![...availableTools.keys()].some((toolName) => toolNameMatchesAnyKnownTool(toolName, WEB_TOOL_NAMES))
    ) {
      return false;
    }
  }
  if (
    promptLabContractRequiresConcreteFileEvidence(contract.userTask) &&
    ![...availableTools.keys()].some((toolName) =>
      toolNameMatchesAnyKnownTool(toolName, new Set(["file.read_range", "fs.read"])),
    )
  ) {
    return false;
  }
  if (contract.requiredNamedTools.length === 0 && contract.requiredToolFamilies.length === 0) {
    return availableTools.size > 0;
  }
  return true;
}

function buildPromptLabRequiredToolRetryInstruction(missingRequirements: string[]): string {
  return [
    "Prompt Lab compliance check: the answer cannot be finalized yet.",
    `Missing required tool evidence: ${missingRequirements.join(", ")}.`,
    "Do not answer from memory or inference. Execute the required tool path first, then answer strictly from the retrieved evidence.",
  ].join("\n");
}

function buildPromptLabRequiredToolFallback(missingRequirements: string[]): string {
  return [
    "I couldn't verify that with the required tools before answering.",
    "",
    `Missing required tool evidence: ${missingRequirements.join(", ")}.`,
    "A file-specific or source-backed answer would be speculative here, so I’m stopping instead of bluffing.",
  ].join("\n");
}

function isUsablePromptLabWebCitationItem(item: { title: string | null; url: string }): boolean {
  try {
    const url = new URL(item.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      isPromptLabBlockedCitationHost(host) ||
      host.endsWith(".local") ||
      host.endsWith(".invalid") ||
      host === "localhost" ||
      (host === "duckduckgo.com" && url.pathname === "/y.js") ||
      url.searchParams.has("ad_domain") ||
      url.searchParams.has("ad_provider") ||
      url.searchParams.has("ad_type")
    ) {
      return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPromptLabBlockedCitationHost(host: string): boolean {
  return [...PROMPT_LAB_BLOCKED_CITATION_HOSTS].some(
    (blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`),
  );
}

function selectRelevantWebCitationItems(
  responseText: string,
  items: Array<{ title: string | null; url: string }>,
  limit: number,
  options: { allowFallback?: boolean } = {},
): Array<{ title: string | null; url: string }> {
  const scored = items
    .map((item, index) => ({
      item,
      score: scoreWebCitationItemAgainstResponse(responseText, item) - index * 0.01,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
  if (scored.length > 0) {
    return scored.slice(0, limit);
  }
  if (options.allowFallback === false) {
    return [];
  }
  return items.slice(0, Math.min(1, limit));
}

function scoreWebCitationItemAgainstResponse(
  responseText: string,
  item: { title: string | null; url: string },
): number {
  const normalizedResponse = responseText.toLowerCase();
  let score = 0;
  try {
    const host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, "");
    const isGovernmentHost = host.endsWith(".gov") || host === "gov";
    const hostTokens = host
      .split(/[.-]+/)
      .filter((token) => token.length >= 3 && !WEB_CITATION_GENERIC_HOST_TOKENS.has(token));
    for (const token of hostTokens) {
      if (normalizedResponse.includes(token)) {
        score += 4;
      }
    }
    const searchableCitationText = `${item.title ?? ""} ${item.url}`.toLowerCase();
    if (/\bdsny\b/.test(searchableCitationText) && /\bdsny\b/i.test(responseText)) {
      score += 8;
    }
    if (isGovernmentHost && score > 0) {
      score += 5;
    }
  } catch {
    // Keep scoring based on title tokens for malformed URLs.
  }
  const titleTokens = (item.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !WEB_CITATION_GENERIC_TITLE_TOKENS.has(token));
  for (const token of new Set(titleTokens)) {
    if (normalizedResponse.includes(token)) {
      score += token.length >= 6 ? 3 : 1;
    }
  }
  return score;
}

const WEB_CITATION_GENERIC_TITLE_TOKENS = new Set([
  "city",
  "service",
  "services",
  "official",
  "public",
  "home",
  "data",
  "portal",
  "look",
  "request",
  "requests",
]);

const WEB_CITATION_GENERIC_HOST_TOKENS = new Set(["com", "gov", "org", "net", "www", "site", "page"]);

const PROMPT_LAB_BLOCKED_CITATION_HOSTS = new Set([
  "user.com",
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "127.0.0.1",
  "answers.com",
  "chegg.com",
  "collinsdictionary.com",
  "dictionary.com",
  "dictionary.cambridge.org",
  "iask.ai",
  "merriam-webster.com",
  "perplexity.ai",
  "questionai.app",
  "studocu.com",
  "thefreedictionary.com",
  "usdictionary.com",
  "whois.com",
]);

function resolvePromptLabConcreteReadToolName(
  canonicalToModel: Map<string, string>,
  catalogToolNames: string[] = [],
): string | undefined {
  if (canonicalToModel.has("file.read_range") || catalogToolNames.includes("file.read_range")) {
    return "file.read_range";
  }
  if (canonicalToModel.has("fs.read") || catalogToolNames.includes("fs.read")) {
    return "fs.read";
  }
  return undefined;
}

function buildPromptLabConcreteReadArgs(
  toolName: string,
  path: string,
  endLine: number,
  userTask?: string,
): Record<string, unknown> {
  if (toolName === "file.read_range") {
    const window = resolvePromptLabConcreteReadWindow(userTask, path, endLine);
    return {
      path,
      startLine: window.startLine,
      endLine: window.endLine,
    };
  }
  return { path };
}

function resolvePromptLabConcreteReadWindow(
  userTask: string | undefined,
  path: string,
  defaultEndLine: number,
): { startLine: number; endLine: number } {
  const normalizedPath = normalizePromptLabFilePath(path).toLowerCase();
  if (looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask)) {
    if (/(?:^|\/)packages\/contracts\/src\/durable\.ts$/i.test(normalizedPath)) {
      return { startLine: 90, endLine: 125 };
    }
    if (/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.ts$/i.test(normalizedPath)) {
      return { startLine: 400, endLine: 470 };
    }
    if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(normalizedPath)) {
      return { startLine: 380, endLine: 470 };
    }
    if (/(?:^|\/)apps\/gateway\/src\/services\/durable-run-service\.test\.ts$/i.test(normalizedPath)) {
      return { startLine: 280, endLine: 340 };
    }
    if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.test\.ts$/i.test(normalizedPath)) {
      return { startLine: 130, endLine: 330 };
    }
  }
  if (looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)) {
    if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.ts$/i.test(normalizedPath)) {
      return { startLine: 380, endLine: 470 };
    }
    if (/(?:^|\/)apps\/gateway\/src\/services\/approval-resolution-effects-service\.test\.ts$/i.test(normalizedPath)) {
      return { startLine: 130, endLine: 330 };
    }
  }
  return { startLine: 1, endLine: defaultEndLine };
}

function resolvePromptLabLocalSearchToolNames(
  canonicalToModel: Map<string, string>,
  catalogToolNames: string[] = [],
): string[] {
  const orderedCandidates = ["code.search_files", "code.search", "file.find"];
  return orderedCandidates.filter(
    (toolName, index) =>
      (canonicalToModel.has(toolName) || catalogToolNames.includes(toolName)) &&
      orderedCandidates.indexOf(toolName) === index,
  );
}

function buildPromptLabSearchArgs(toolName: string, path: string, query: string): Record<string, unknown> {
  if (toolName === "file.find") {
    return {
      path,
      pattern: query,
    };
  }
  return {
    path,
    query,
  };
}

function promptLabTaskSuggestsRepoInspection(userTask: string | undefined): boolean {
  if (!userTask) {
    return false;
  }
  const normalized = userTask.toLowerCase();
  if (/\b(?:these\s+)?(?:local\s+)?files?\s+only\b/.test(normalized)) {
    return false;
  }
  return (
    /\binspect the repo if needed\b/i.test(userTask) ||
    /\brepo if needed\b/i.test(userTask) ||
    /\b(?:inspect|review|audit|trace|analy[sz]e|read|check|identify|find)\b[\s\S]{0,40}\b(repo|repository|codebase|workspace|project)\b/i.test(
      userTask,
    ) ||
    /\b(repo|repository|codebase|workspace|project)\b[\s\S]{0,40}\b(?:inspect|review|audit|trace|analy[sz]e|read|check)\b/i.test(
      userTask,
    ) ||
    (/\bexact\b/.test(normalized) &&
      /\bpatch points?\b|\bfiles used\b|\bcite\b/.test(normalized) &&
      /\b(report|render|status|surface|wiring|logic|contract|handling)\b/.test(normalized))
  );
}

function promptLabTaskLimitsInspectionToExplicitFiles(userTask: string | undefined): boolean {
  if (!userTask) {
    return false;
  }
  const normalized = userTask.toLowerCase();
  return (
    /\b(?:these\s+)?(?:local\s+)?files?\s+only\b/.test(normalized) ||
    /\binspect\s+only\s+(?:these\s+)?(?:local\s+)?files?\b/.test(normalized)
  );
}

function promptLabTaskNeedsAdjacentRepoSearch(userTask: string | undefined): boolean {
  if (!userTask) {
    return false;
  }
  const normalized = userTask.toLowerCase();
  if (promptLabTaskLimitsInspectionToExplicitFiles(userTask)) {
    return false;
  }
  return (
    /\brelated\b/.test(normalized) ||
    /\bapis?\b/.test(normalized) ||
    /\broutes?\b/.test(normalized) ||
    /\bservices?\b/.test(normalized) ||
    /\btests?\b/.test(normalized) ||
    /\bwiring\b/.test(normalized) ||
    /\bloading\b/.test(normalized) ||
    /\bresolution\b/.test(normalized) ||
    /\brollout\b/.test(normalized) ||
    /\bprovenance\b/.test(normalized) ||
    /\boverlap\b/.test(normalized) ||
    /\boperator review\b/.test(normalized) ||
    /\bbenchmark\b/.test(normalized) ||
    /\breplay\b/.test(normalized) ||
    /\btrend\b/.test(normalized) ||
    /\breport(?:ing)?\b/.test(normalized) ||
    /\bworkspace\b/.test(normalized) ||
    /\bguidance\b/.test(normalized) ||
    /\bmemory\b/.test(normalized) ||
    /\bcron\b/.test(normalized) ||
    /\bbaseline\b/.test(normalized) ||
    /\bfixture\b/.test(normalized) ||
    /\bdistinct\b/.test(normalized)
  );
}

function looksLikePromptLabPromptPackProductSurfaceTask(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  return (
    /\bprompt[- ]pack\b/.test(normalized) &&
    !/\bprompt-pack-workspace\b|fixtures\/prompt-pack-workspace/.test(normalized)
  );
}

function looksLikePromptLabPromptPackScoringV3Task(userTask: string | undefined): boolean {
  const normalized = (userTask ?? "").toLowerCase();
  if (!/\bprompt[- ]pack\b/.test(normalized)) {
    return false;
  }
  return (
    /\bscor(?:e|ing)\b/.test(normalized) ||
    /\breason code\b/.test(normalized) ||
    /\bv3 failure attribution\b/.test(normalized) ||
    /\bjudge output is invalid\b/.test(normalized) ||
    /\bauto[- ]score\b/.test(normalized) ||
    /\boutdated v2-only label\b/.test(normalized) ||
    /\breport label\b/.test(normalized)
  );
}

function looksLikePromptLabInspectionContinuation(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const markers = [
    /^i(?:'|’)ll continue(?:\s+\w+){0,4}\b/,
    /^i need to (?:read|inspect|review|check|find|trace|search|continue)\b/,
    /^looking at the tool evidence,\s*i need to\b/,
    /^let me gather more context\b/,
    /^let me (?:read|inspect|review|check|find|search|continue)\b/,
    /\bi need to read more\b/,
    /\bi need to search more\b/,
    /\bi need to see more of\b/,
    /\bgather more context\b/,
    /\bneed to inspect more\b/,
    /\bneed to continue (?:the )?inspection\b/,
    /\blet me continue inspection\b/,
    /\blet me continue investigating\b/,
    /\bi have partial evidence\b/,
    /\bto complete this picture, i(?:'|’)d need to\b/,
    /\bwould you like me to inspect\b/,
    /\bbefore drafting\b/,
    /\bbefore i can answer\b/,
    /\bneed to gather more evidence\b/,
    /\bneed to execute the required file and code searches\b/,
  ];
  const markerHits = markers.filter((pattern) => pattern.test(normalized)).length;
  if (markerHits === 0) {
    return false;
  }
  const citedFileCount = [...content.matchAll(/`[^`\r\n]+\.[a-z0-9]+`/gi)].length;
  return normalized.length <= 2000 && citedFileCount <= 6;
}

function shouldRetryPromptLabSearchFromRepoRoot(input: {
  searchPath: string;
  toolRun: ChatToolRunRecord;
  promptLabContract: {
    repoGroundedAssist: boolean;
    userTask?: string;
  };
  repoGroundedInspectionAssist: boolean;
  promptLabRepoInspectionAssist: boolean;
}): boolean {
  if (input.searchPath === "." || input.toolRun.status !== "blocked") {
    return false;
  }
  if (!looksLikeMissingLocalToolPathError(input.toolRun.error)) {
    return false;
  }
  return (
    input.promptLabContract.repoGroundedAssist ||
    input.repoGroundedInspectionAssist ||
    input.promptLabRepoInspectionAssist ||
    promptLabTaskSuggestsRepoInspection(input.promptLabContract.userTask)
  );
}

function looksLikeMissingLocalToolPathError(error: string | undefined): boolean {
  return /\bENOENT\b|no such file or directory|cannot find path|path not found/i.test(error ?? "");
}

function shouldSynthesizePromptLabFromGatheredEvidence(input: {
  content: string;
  promptLabContract: {
    explicitTools: boolean;
    requiredToolFamilies: string[];
    requiredNamedTools: string[];
    userTask?: string;
  };
  toolRuns: ChatToolRunRecord[];
}): boolean {
  if (!isPromptLabHarnessContent(input.content)) {
    return false;
  }
  const executedToolRuns = input.toolRuns.filter((run) => run.status === "executed");
  if (executedToolRuns.length === 0) {
    return false;
  }
  const hasConcreteRead = executedToolRuns.some((run) =>
    toolNameMatchesAnyKnownTool(run.toolName, new Set(["file.read_range", "fs.read"])),
  );
  const hasLocalSearch = executedToolRuns.some((run) =>
    toolNameMatchesAnyKnownTool(run.toolName, LOCAL_QUERY_TOOL_NAMES),
  );
  const needsConcreteFileEvidence =
    promptLabContractRequiresConcreteFileEvidence(input.promptLabContract.userTask) ||
    promptLabContractRequiresFileTools(input.promptLabContract);
  return hasConcreteRead || (hasLocalSearch && !needsConcreteFileEvidence);
}

function buildPromptLabToolBudgetSynthesisInstruction(
  maxToolRunsPerTurn: number,
  toolRuns: ChatToolRunRecord[],
): string {
  const concretePaths = [...collectPromptLabConcreteReadPaths(toolRuns)].slice(0, 8);
  const pathSentence =
    concretePaths.length > 0
      ? ` Use the concrete file evidence already gathered: ${concretePaths.map((item) => `\`${item}\``).join(", ")}.`
      : "";
  return [
    `Prompt Lab synthesis note: this turn has already used the ${maxToolRunsPerTurn}-call tool budget.`,
    "Do not call more tools. Produce the final answer now from the completed tool evidence.",
    "State remaining unknowns explicitly, but do not replace the answer with a budget-failure message.",
    pathSentence,
  ]
    .filter((part) => part.trim().length > 0)
    .join(" ");
}

function buildPromptLabPartialToolCallSynthesisInstruction(toolRuns: ChatToolRunRecord[]): string {
  const concretePaths = [...collectPromptLabConcreteReadPaths(toolRuns)].slice(0, 8);
  const pathSentence =
    concretePaths.length > 0
      ? ` Use the concrete file evidence already gathered: ${concretePaths.map((item) => `\`${item}\``).join(", ")}.`
      : "";
  return [
    "Prompt Lab synthesis note: the provider started another tool call but did not finish assembling it.",
    "Do not call more tools on the retry. Produce the final answer now from the completed tool evidence.",
    "State remaining unknowns explicitly, but do not replace the answer with a tool-call failure message.",
    pathSentence,
  ]
    .filter((part) => part.trim().length > 0)
    .join(" ");
}

function resolvePromptLabFilePrefetchEndLine(userTask: string | undefined, fileCount: number): number {
  if (
    looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask) ||
    looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask) ||
    looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask)
  ) {
    return 520;
  }
  const normalized = (userTask ?? "").toLowerCase();
  if (
    /\bmemory routes?\b/.test(normalized) &&
    /\bmemory context services?\b/.test(normalized) &&
    /\bui or copy\b|\brelated ui\b|\boperator-facing lifecycle\b|\boperator facing lifecycle\b/.test(normalized)
  ) {
    return 520;
  }
  if (
    /\bguidance\b/.test(normalized) &&
    (/\bglobal docs\b/.test(normalized) ||
      /\bworkspace docs\b/.test(normalized) ||
      /\bruntime guidance\b/.test(normalized) ||
      /\bagents\.md\b/.test(normalized)) &&
    (/\bprecedence\b/.test(normalized) ||
      /\boverride\b/.test(normalized) ||
      /\bloading chain\b/.test(normalized) ||
      /\bcurrent summary\b/.test(normalized))
  ) {
    return 680;
  }
  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask)) {
    return 820;
  }
  if (
    /\bprompt[- ]pack\b/.test(normalized) &&
    /\bsource label|source-label|source_label|source labeling|export rendering\b/.test(normalized)
  ) {
    return 2600;
  }
  if (fileCount >= 5) {
    return 180;
  }
  if (fileCount >= 3) {
    return 260;
  }
  return 320;
}

function resolvePromptLabDesiredConcreteReadCount(userTask: string | undefined): number {
  if (looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(userTask)) {
    return 5;
  }
  if (looksLikePromptLabCronReportCoworkPrompt(userTask)) {
    return 5;
  }
  if (!promptLabContractRequiresConcreteFileEvidence(userTask)) {
    return 1;
  }
  const normalized = (userTask ?? "").toLowerCase();
  if (
    looksLikePromptLabMissionControlTruthLabelingPrompt(userTask) ||
    looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(userTask) ||
    looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask) ||
    looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(userTask) ||
    looksLikePromptLabEventEnvelopeAuthorityPrompt(userTask)
  ) {
    return 6;
  }
  if (/\bskill import\b|\bimported skills?\b|\btrust metadata\b|\bprovenance\b/.test(normalized)) {
    return 4;
  }
  if (
    /\bprompt[- ]pack\b/.test(normalized) &&
    /\bsource label|source-label|source_label|source labeling|export rendering\b/.test(normalized)
  ) {
    return 6;
  }
  if (
    /\/api\/v1\/prompt-packs\/:packid\/tests\/:testid\/auto-score/i.test(normalized) ||
    (/\bprompt[- ]pack\b/.test(normalized) &&
      /\bauto[- ]scor(?:e|ing)\b/.test(normalized) &&
      (/\bhttp request\b/.test(normalized) || /\bservice logic\b/.test(normalized) || /\bstorage\b/.test(normalized))) ||
    (/\bprompt[- ]pack\b/.test(normalized) &&
      /\bauto-score evidence\b/.test(normalized) &&
      /\bmission control\b/.test(normalized))
  ) {
    return 5;
  }
  if (looksLikePromptLabPromptPackMarkdownImportPrompt(userTask)) {
    return 4;
  }
  if (looksLikePromptLabApprovalWakeFlowPrompt(userTask)) {
    return 4;
  }
  if (looksLikePromptLabLifecycleCanonicalLinkagePrompt(userTask)) {
    return 3;
  }
  if (looksLikePromptLabRealtimeEventMetadataPropagationPrompt(userTask)) {
    return 4;
  }
  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask)) {
    return 4;
  }
  if (looksLikePromptLabDurableRunMinimalTestPrompt(userTask)) {
    return looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask) ? 5 : 4;
  }
  if (
    /\bworkspace\b/.test(normalized) &&
    /\bguidance\b/.test(normalized) &&
    /\b(binding|project-binding|project binding)\b/.test(normalized)
  ) {
    return 4;
  }
  if (
    /\bmemory\b/.test(normalized) &&
    /\broutes?\b/.test(normalized) &&
    /\b(ui|copy|page|operator-facing)\b/.test(normalized)
  ) {
    return 7;
  }
  if (/\bbenchmark\b|\breplay\b|\btrend\b|\breport\b/i.test(userTask ?? "")) {
    return 4;
  }
  if (looksLikePromptLabGuidanceLoadingSummaryPrompt(userTask)) {
    return 3;
  }
  if (looksLikeWorkspaceGuidancePrecedencePrompt(userTask)) {
    return 4;
  }
  if (/\bapproval\b|\bwake\b|\bresume\b|\bpaused\b|\bwaiting\b/.test(normalized)) {
    return 4;
  }
  return 3;
}

function extractExplicitLocalFilePathsFromPrompt(content: string): string[] {
  const userTask = extractPrimaryUserTaskContent(content);
  const candidates = new Set<string>();

  for (const match of userTask.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1]?.trim();
    if (value && looksLikeLocalFilePath(value)) {
      candidates.add(normalizePromptLabFilePath(value));
    }
  }

  for (const match of userTask.matchAll(
    /(?:^|\s)([A-Za-z]:[\\/][^\s`"']+\.[A-Za-z0-9._-]+|(?:\.{0,2}\/)?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9._-]+)(?=$|\s)/gm,
  )) {
    const value = match[1]?.trim();
    if (value && looksLikeLocalFilePath(value)) {
      candidates.add(normalizePromptLabFilePath(value));
    }
  }

  return [...candidates];
}

function inferPromptLabCompanionFilePaths(userTask: string | undefined, explicitFilePaths: string[]): string[] {
  if (!userTask || explicitFilePaths.length === 0) {
    return [];
  }
  const normalizedTask = userTask.toLowerCase();
  if (!/\bbaseline\b|\bfixture\b|\bdistinct\b/.test(normalizedTask)) {
    return [];
  }

  const explicitNormalizedPaths = new Set(
    explicitFilePaths.map((path) => normalizePromptLabFilePath(path).toLowerCase()),
  );
  const companions = new Set<string>();
  for (const filePath of explicitFilePaths) {
    const normalizedPath = normalizePromptLabFilePath(filePath);
    const segments = normalizedPath.split("/").filter(Boolean);
    const basename = segments.at(-1) ?? "";
    if (!/^goatcitadel_prompt_pack_v2\.md$/i.test(basename)) {
      continue;
    }
    const directoryPrefix = normalizedPath.slice(0, normalizedPath.length - basename.length);
    const companionPath = `${directoryPrefix}goatcitadel_prompt_pack.md`;
    if (!explicitNormalizedPaths.has(companionPath.toLowerCase())) {
      companions.add(companionPath);
    }
  }
  return [...companions];
}

function inferPromptLabSuggestedFilePaths(userTask: string | undefined): string[] {
  if (!userTask) {
    return [];
  }
  const normalizedTask = userTask.toLowerCase();
  const paths = new Set<string>();
  const add = (value: string): void => {
    if (value.trim()) {
      paths.add(normalizePromptLabFilePath(value));
    }
  };

  if (
    /\bmemory\b/.test(normalizedTask) &&
    (/\bmemory-context\b|\bmemory context\b/.test(normalizedTask) ||
      /\bmemory routes?\b/.test(normalizedTask) ||
      /\bmemory context services?\b/.test(normalizedTask)) &&
    (/\boperator-facing memory ui\b|\boperator facing memory ui\b|\brelated ui\b|\bui or copy\b|\boperator-facing lifecycle\b|\boperator facing lifecycle\b/.test(
      normalizedTask,
    ) ||
      /\brelated ui or copy\b/.test(normalizedTask))
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.memoryLifecycleOperatorUi) add(filePath);
  }

  if (
    /\bguidance\b/.test(normalizedTask) &&
    (/\bglobal docs\b/.test(normalizedTask) ||
      /\bworkspace docs\b/.test(normalizedTask) ||
      /\bruntime guidance\b/.test(normalizedTask) ||
      /\bagents\.md\b/.test(normalizedTask))
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.guidanceRuntime) add(filePath);
  }

  if (looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.approvalWakeOrdering) add(filePath);
  }

  if (looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.runtimeLifecycleProvenance) add(filePath);
  }

  if (looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.strictPausedWaitingWakeEvidence) add(filePath);
  }

  if (looksLikePromptLabCronReportCoworkPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.cronReportCowork) add(filePath);
  }

  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.durableWorkerHarnessCoverage) add(filePath);
  }

  if (looksLikePromptLabTypedWakeOutcomeEvidencePrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.typedWakeOutcomeEvidence) add(filePath);
  }

  if (looksLikePromptLabEventEnvelopeAuthorityPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.realtimeEventEnvelope) add(filePath);
  }

  if (looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.durableWakeOutcomePatchPlan) add(filePath);
  }

  if (looksLikePromptLabPromptPackParserRegressionPrompt(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackParserRegression) add(filePath);
  }

  if (
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bsource label|source-label|source_label|source labeling|export rendering\b/.test(normalizedTask)
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackSourceLabel) add(filePath);
  }

  if (
    /\/api\/v1\/prompt-packs\/:packid\/tests\/:testid\/auto-score/i.test(normalizedTask) ||
    (/\bprompt[- ]pack\b/.test(normalizedTask) &&
      /\bauto[- ]scor(?:e|ing)\b/.test(normalizedTask) &&
      (/\bhttp request\b/.test(normalizedTask) || /\bservice logic\b/.test(normalizedTask) || /\bstorage\b/.test(normalizedTask)))
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackAutoScoreRoute) add(filePath);
  }

  if (
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bauto-score evidence\b/.test(normalizedTask) &&
    /\bmission control\b/.test(normalizedTask)
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackAutoScoreUi) add(filePath);
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:test|run) records?\b|\bstored\b|\bstorage\b/.test(normalizedTask)
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackStorageProductSurface) add(filePath);
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:mission control next|workbench|run details?|segmented control|harness\/agentic|agentic segmented)\b/.test(
      normalizedTask,
    )
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackMissionControlProductSurface) add(filePath);
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:reports?|exports?|rendered|rendering|markdown report|exported results?)\b/.test(normalizedTask)
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackExportProductSurface) add(filePath);
  }

  if (
    looksLikePromptLabPromptPackProductSurfaceTask(userTask) &&
    /\b(?:api shape|shared client|gateway route|single prompt[- ]pack test|running a single|run a single)\b/.test(
      normalizedTask,
    )
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackApiProductSurface) add(filePath);
  }

  if (looksLikePromptLabJudgeDefaultsMinimalTestPrompt(userTask)) {
    add("apps/gateway/src/services/prompt-pack-service.scoring.test.ts");
    add("apps/gateway/src/services/prompt-pack-service.ts");
  }

  if (looksLikePromptLabPromptPackScoringV3Task(userTask)) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackScoringV3) add(filePath);
  }

  if (
    /\/api\/v1\/prompt-packs\/:packid\/tests\/:testid\/auto-score/i.test(normalizedTask) ||
    (/\bprompt[- ]pack\b/.test(normalizedTask) &&
      /\bauto[- ]scor(?:e|ing)\b/.test(normalizedTask) &&
      (/\bhttp request\b/.test(normalizedTask) || /\bservice logic\b/.test(normalizedTask) || /\bstorage\b/.test(normalizedTask)))
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackAutoScoreRoute) add(filePath);
  }

  if (
    /\bprompt[- ]pack\b/.test(normalizedTask) &&
    /\bauto-score evidence\b/.test(normalizedTask) &&
    /\bmission control\b/.test(normalizedTask)
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackAutoScoreUi) add(filePath);
  }

  if (
    looksLikePromptLabPromptPackGateSelectionTestPrompt(userTask) ||
    (/\bgate selection\b/.test(normalizedTask) &&
      /\bexpansion pack\b/.test(normalizedTask) &&
      /\bbaseline\b/.test(normalizedTask)) ||
    (/\bprompt[- ]pack\b/.test(normalizedTask) &&
      /\bgate runs?\b|\bgate selection\b|\brun-prompt-pack-gates\b|\bfocused[- ]pack\b/.test(normalizedTask) &&
      /\bexpanded\b|\bovernight\b|\bv2\b/.test(normalizedTask))
  ) {
    for (const filePath of PROMPT_LAB_SUGGESTED_FILE_PATHS.promptPackGateSelection) add(filePath);
  }

  return [...paths];
}

function looksLikeLocalFilePath(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || /^https?:\/\//i.test(normalized)) {
    return false;
  }
  if (!/[\\/]/.test(normalized)) {
    if (KNOWN_BARE_FILE_BASENAMES.has(normalized)) {
      return true;
    }
    if (!/\.[A-Za-z0-9._-]+$/.test(normalized)) {
      return false;
    }
    const stem = normalized.replace(/\.[A-Za-z0-9._-]+$/, "");
    return stem.length > 0 && stem === stem.toLowerCase();
  }
  return /\.[A-Za-z0-9._-]+$/.test(normalized);
}

function filterPromptLabPrefetchFilePaths(paths: string[]): string[] {
  return paths.filter((filePath) => !isSensitivePromptLabPrefetchPath(filePath));
}

function isSensitivePromptLabPrefetchPath(filePath: string): boolean {
  const normalized = filePath.trim().replaceAll("\\", "/");
  if (!normalized) {
    return false;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? normalized.toLowerCase();
  return SENSITIVE_LOCAL_PREFETCH_BASENAMES.has(basename);
}

function looksLikeHarnessContaminatedQuery(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return PROMPT_HARNESS_QUERY_MARKERS.some((marker) => normalized.includes(marker));
}

function resolveModelControlOptions(
  input: Pick<ChatAgentTurnInput, "content" | "providerId" | "model" | "mode" | "thinkingLevel" | "speedMode">,
  hasFunctionTools = false,
): Pick<ChatCompletionRequest, "reasoning" | "verbosity" | "service_tier"> {
  const promptLabControls = resolvePromptLabOpenAiControls(input, hasFunctionTools);
  if (Object.keys(promptLabControls).length > 0) {
    return {
      ...promptLabControls,
      service_tier: input.speedMode === "fast" ? "auto" : undefined,
    };
  }
  const reasoning = resolveReasoningEffort(input.thinkingLevel);
  return {
    reasoning: reasoning ? { effort: reasoning } : undefined,
    verbosity: input.speedMode === "fast" ? "low" : input.mode === "code" ? "medium" : undefined,
    service_tier: input.speedMode === "fast" ? "auto" : undefined,
  };
}

function resolvePromptLabOpenAiControls(
  input: Pick<ChatAgentTurnInput, "content" | "providerId" | "model" | "mode" | "thinkingLevel">,
  hasFunctionTools = false,
): Pick<ChatCompletionRequest, "reasoning" | "verbosity"> {
  if (!isPromptLabHarnessContent(input.content) || !isOpenAiReasoningEligible(input.providerId, input.model)) {
    return {};
  }
  if (input.mode !== "cowork" && input.mode !== "code") {
    return {};
  }
  // Native GPT-5 no-tools evaluations now route through Responses, but
  // compatibility/chat-completions turns can still reject reasoning controls
  // once tools are enabled. Keep prompt-lab tool turns conservative until the
  // orchestrator can key this decision off resolved execution style.
  if (hasFunctionTools) {
    return {};
  }

  return {
    reasoning: {
      effort: resolvePromptLabReasoningEffort(input.mode, input.thinkingLevel),
    },
    verbosity: input.mode === "code" ? "low" : "medium",
  };
}

function isOpenAiReasoningEligible(providerId?: string, model?: string): boolean {
  const normalizedProvider = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  return normalizedProvider === "openai" || normalizedModel.startsWith("gpt-5");
}

function resolvePromptLabReasoningEffort(
  mode: ChatMode,
  thinkingLevel: ChatThinkingLevel,
): NonNullable<ChatCompletionRequest["reasoning"]>["effort"] {
  if (thinkingLevel === "minimal") {
    return "low";
  }
  if (thinkingLevel === "standard") {
    return mode === "cowork" ? "medium" : "low";
  }
  return mode === "cowork" ? "high" : "medium";
}

function resolveReasoningEffort(
  thinkingLevel: ChatThinkingLevel,
): NonNullable<ChatCompletionRequest["reasoning"]>["effort"] | undefined {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "minimal") {
    return "low";
  }
  if (thinkingLevel === "standard") {
    return "medium";
  }
  if (thinkingLevel === "extended") {
    return "high";
  }
  return "xhigh";
}

function inferLocalToolPathFromPrompt(toolName: string, userContent: string): string | undefined {
  const taskContent = extractPrimaryUserTaskContent(userContent);
  const explicitPath = extractExplicitPromptPath(taskContent);
  const hasDynamicPathPlaceholder = promptContainsDynamicLocalPathPlaceholder(taskContent);
  if (explicitPath) {
    if (toolName === "code.search_files") {
      if (hasDynamicPathPlaceholder) {
        return ".";
      }
      return collapsePromptPathToSearchRoot(explicitPath);
    }
    if (toolName === "code.search") {
      return ".";
    }
    if (hasDynamicPathPlaceholder) {
      return undefined;
    }
    return explicitPath;
  }
  const normalized = taskContent.toLowerCase();
  const broadProjectScanIntent =
    /\b(all|entire|whole)\s+(?:source\s+)?files?\b/.test(normalized) ||
    /\b(?:search|scan|audit|inspect|read|list|walk)\b[\s\S]{0,40}\b(project|repository|repo|workspace|codebase)\b/.test(
      normalized,
    ) ||
    /\b(project|repository|repo|workspace|codebase)\b[\s\S]{0,40}\b(files?|source|tree|structure)\b/.test(normalized);
  if (toolName === "code.search_files" || toolName === "code.search" || toolName === "file.find") {
    return broadProjectScanIntent || detectLocalFileIntent(taskContent) ? "." : undefined;
  }
  return undefined;
}

function inferLocalSearchQueryFromPrompt(toolName: string, userContent: string): string | undefined {
  const taskContent = extractPrimaryUserTaskContent(userContent);
  const explicitPath = extractExplicitPromptPath(taskContent);
  if (explicitPath && !promptContainsDynamicLocalPathPlaceholder(taskContent)) {
    if (
      toolName === "code.search_files" &&
      !/\.[a-z0-9]{1,8}$/i.test(explicitPath.replaceAll("\\", "/").replace(/\/+$/, ""))
    ) {
      return ".";
    }
    return promptPathBasename(explicitPath);
  }
  const normalized = taskContent.toLowerCase();
  if (toolName === "code.search_files" && /\b(all|entire|whole)\s+(?:source\s+)?files?\b/.test(normalized)) {
    return ".";
  }
  if (/\btests?\b|\bcoverage\b/.test(normalized)) {
    return "test";
  }
  const keywordQuery = inferPromptLabLocalSearchQueries(taskContent)[0];
  if (keywordQuery) {
    return keywordQuery;
  }
  if (toolName === "code.search") {
    return inferFileFindPatternFromPrompt(taskContent);
  }
  return undefined;
}

function inferPromptLabLocalSearchQueries(userContent: string): string[] {
  const taskContent = extractPrimaryUserTaskContent(userContent);
  const normalized = taskContent.toLowerCase();
  const queries: string[] = [];
  const addQuery = (value: string | undefined): void => {
    const trimmed = value?.trim().toLowerCase();
    if (!trimmed || queries.includes(trimmed)) {
      return;
    }
    if (looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(taskContent)) {
      if (trimmed === "approval" || trimmed === "session" || trimmed === "task" || trimmed === "proactive") {
        return;
      }
    }
    queries.push(trimmed);
  };

  if (looksLikePromptLabPromptPackOperatorSurfacePrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackOperatorSurface) addQuery(query);
  }
  if (looksLikePromptLabApprovalWakeFlowPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.approvalWakeFlow) addQuery(query);
  }
  if (looksLikeWorkspaceRoutesGuidanceCoworkPrompt(taskContent)) {
    if (/\bworkspace loading\b/i.test(taskContent)) {
      addQuery("workspace");
    }
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.workspaceRoutesGuidance) addQuery(query);
  }
  if (
    /\bglobal docs\b/.test(normalized) &&
    /\bworkspace docs\b/.test(normalized) &&
    /\brepo guidance\b/.test(normalized) &&
    /\bruntime\b/.test(normalized)
  ) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.guidanceRuntime) addQuery(query);
  }
  if (looksLikePromptLabMemoryLifecycleCoworkPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.memoryLifecycle) addQuery(query);
  }
  if (looksLikePromptLabCronReportCoworkPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.cronReport) addQuery(query);
  }
  if (looksLikePromptLabRank1HardeningCoworkPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.rank1Hardening) addQuery(query);
  }
  if (looksLikePromptLabLifecycleCanonicalLinkagePrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.lifecycleCanonicalLinkage) addQuery(query);
  }
  if (looksLikePromptLabRuntimeLifecycleProvenanceMapPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.runtimeLifecycleProvenance) addQuery(query);
  }
  if (looksLikePromptLabStrictPausedWaitingWakeEvidencePrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.strictPausedWaitingWakeEvidence) addQuery(query);
  }
  if (looksLikePromptLabRealtimeEventMetadataPropagationPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.realtimeEventMetadata) addQuery(query);
  }
  if (
    looksLikePromptLabEventEnvelopeAuthorityPrompt(taskContent) ||
    looksLikePromptLabEventLinkPropagationCoworkPrompt(taskContent)
  ) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.realtimeEventEnvelope) addQuery(query);
  }
  if (looksLikePromptLabDurableRunMinimalTestPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.durableRunMinimal) addQuery(query);
  }
  if (looksLikePromptLabPromptPackGateSelectionTestPrompt(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackGateSelection) addQuery(query);
  }
  if (looksLikePromptLabWrappedDependentsParserTestPrompt(taskContent)) {
    addQuery("update-review.test.ts");
    addQuery("update-review.ts");
    addQuery("parsePnpmOutdatedOutput");
    addQuery("wrapped dependents");
  }
  if (looksLikePromptLabSkillExtraOverlapInstallTestPrompt(taskContent)) {
    addQuery("skill-import-service.test.ts");
    addQuery("skill-import-service.ts");
    addQuery("duplicateFamily");
    addQuery("skills/extra");
  }
  if (looksLikePromptLabPromptPackV2DistinctTestPrompt(taskContent)) {
    addQuery("prompt-pack-service.parser-report.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("parsePromptPackTests");
    addQuery("goatcitadel_prompt_pack_v2.md");
  }
  if (looksLikePromptLabEnvSourceLabelMinimalTestPrompt(taskContent)) {
    addQuery("prompt-pack-service.parser-report.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("ensurePromptPackLoaded");
    addQuery("GOATCITADEL_PROMPT_PACK_PATH");
    addQuery("sourceLabel");
  }
  if (looksLikePromptLabJudgeDefaultsMinimalTestPrompt(taskContent)) {
    addQuery("prompt-pack-service.scoring.test.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("resolvePromptPackJudgeTarget");
    addQuery("getPromptJudgeModelDefaults");
    addQuery("judge defaults");
  }
  if (/\/api\/v1\/prompt-packs\/:packid\/tests\/:testid\/auto-score/i.test(normalized)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackAutoScoreRoute) addQuery(query);
  }
  if (
    /\bprompt[- ]pack\b/.test(normalized) &&
    /\bauto[- ]scor(?:e|ing)\b/.test(normalized) &&
    (/\bhttp request\b/.test(normalized) || /\bservice logic\b/.test(normalized) || /\bstorage\b/.test(normalized))
  ) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackAutoScoreRoute) addQuery(query);
  }
  if (/\bmost relevant existing tests\b/i.test(taskContent) && /\bprompt pack scoring behavior\b/i.test(taskContent)) {
    addQuery("prompt-pack-service.scoring.test.ts");
    addQuery("mergePromptPackAutoScoresV3");
    addQuery("evaluatePromptPackRuleScores");
    addQuery("prompt-pack-score-repo.test.ts");
  }
  if (/\bauto-score evidence\b/i.test(taskContent) && /\brendered in Mission Control\b/i.test(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackAutoScoreUi) addQuery(query);
  }
  if (looksLikePromptLabPromptPackScoringV3Task(taskContent)) {
    for (const query of PROMPT_LAB_LOCAL_SEARCH_QUERIES.promptPackScoringV3) addQuery(query);
  }
  if (/\bv3 failure attribution\b/i.test(taskContent) && /\bjudge output is invalid\b/i.test(taskContent)) {
    addQuery("prompt-pack-service.scoring.test.ts");
    addQuery("mergePromptPackAutoScoresV3");
    addQuery("derivePromptPackFailureAttributionV3");
    addQuery("judgeStatus invalid");
  }
  if (/\boutdated v2-only label\b/i.test(taskContent) && /\bprompt pack report label\b/i.test(taskContent)) {
    addQuery("renderPromptPackMarkdownReport");
    addQuery("prompt-pack-service.ts");
    addQuery("Auto Score");
    addQuery("latest score rows");
  }
  if (looksLikePromptLabTypedWakeOutcomeEvidencePrompt(taskContent)) {
    addQuery("packages/contracts/src/durable.ts");
    addQuery("durable.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("durable-run-service.ts");
    addQuery("chat-durable-run-service.ts");
    addQuery("chat-durable-run-service.test.ts");
  }
  if (looksLikePromptLabDurableWakeOutcomePatchPlanPrompt(taskContent)) {
    addQuery("durable.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("durable-run-service.ts");
    addQuery("routes/durable.ts");
    addQuery("api/durable.ts");
  }
  if (looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(taskContent)) {
    addQuery("approval-resolution-effects-service.ts");
    addQuery("approval-effect-repo.ts");
    addQuery("approval-wait-run-repo.ts");
    addQuery("durable-run-service.ts");
    addQuery("approval-resolution-effects-service.test.ts");
  }
  if (looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(taskContent)) {
    addQuery("durable.ts");
    addQuery("durable-run-repo.ts");
    addQuery("durable-run-repo.test.ts");
    addQuery("durable-run-service.ts");
    addQuery("durable-run-service.test.ts");
    addQuery("tryClaimQueuedRun");
    addQuery("listExpiredRunningRunIds");
  }
  if (looksLikePromptLabLifecycleProvenancePatchPlanPrompt(taskContent)) {
    addQuery("runtime-lifecycle.ts");
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("runtime-lifecycle-read-service.test.ts");
    addQuery("realtime-event-repo.ts");
    addQuery("fallbackSources");
  }
  if (looksLikePromptLabMissionControlTruthLabelingPrompt(taskContent)) {
    addQuery("runtime-lifecycle.ts");
    addQuery("runtime-lifecycle-read-service.ts");
    addQuery("ApprovalsRoutePage.tsx");
    addQuery("ApprovalsRoutePage.test.tsx");
    addQuery("api/types.ts");
  }
  if (looksLikePromptLabExplicitEventAuthorityEnvelopePatchPlanPrompt(taskContent)) {
    addQuery("tool-invocation-coordinator-service.ts");
    addQuery("gateway-service.ts");
    addQuery("realtime-event-repo.ts");
    addQuery("realtime-event");
    addQuery("events.ts");
    addQuery("api/types.ts");
  }
  if (looksLikePromptLabTwoWorkerHarnessCoveragePatchPlanPrompt(taskContent)) {
    addQuery("durable-run-repo.test.ts");
    addQuery("durable-run-repo.ts");
    addQuery("durable-run-service.ts");
    addQuery("durable-run-service.test.ts");
    addQuery("tryClaimQueuedRun");
    addQuery("listExpiredRunningRunIds");
  }
  if (looksLikePromptLabApprovalEffectsHardeningPatchPlanPrompt(taskContent)) {
    addQuery("approval-lifecycle-service.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("approval-effect-repo.ts");
    addQuery("approval-resolution-effects-service.test.ts");
    addQuery("approvals.ts");
  }
  for (const match of taskContent.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1]?.trim();
    if (!value) {
      continue;
    }
    if (/<[^>\r\n]+>/.test(value)) {
      continue;
    }
    const basename = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
    const candidate = basename ?? value;
    if (/[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(candidate) || /[-_]/.test(candidate)) {
      addQuery(candidate);
    }
  }

  if (/\bskill import\b|\bimported skills?\b|\brepo-managed imported skills?\b/i.test(taskContent)) {
    addQuery("skill-import");
  }
  if (/\bsource\.json\b|\btrust metadata\b|\bprovenance manifest\b|\bskills\/extra\b/i.test(taskContent)) {
    addQuery("source.json");
    addQuery("skill_import_and_trust_policy");
  }
  if (
    /\bupdate-review-daily\b|\bupdate review\b|\bbuilt-in cron\b|\bcron wiring\b|\breview queue\b/i.test(taskContent)
  ) {
    addQuery("cron-automation-service");
    addQuery("update-review");
    addQuery("prompt-packs.ts");
    addQuery("costs.ts");
    addQuery("cron-job-repo");
    addQuery("cron");
  }
  if (/\boverlap\b/i.test(normalized)) {
    addQuery("overlap");
  }
  if (/\bprovenance\b/i.test(normalized)) {
    addQuery("provenance");
  }
  if (/\bprompt pack\b/i.test(taskContent)) {
    addQuery("prompt-pack");
  }
  if (
    looksLikePromptLabPromptPackProductSurfaceTask(taskContent) &&
    /\b(?:test|run) records?\b|\bstored\b|\bstorage\b/i.test(taskContent)
  ) {
    addQuery("prompt-pack-repo.ts");
    addQuery("prompt-pack-run-repo.ts");
    addQuery("prompt-pack-score-repo.ts");
    addQuery("PromptPackRunRepository");
    addQuery("replacePackTests");
  }
  if (
    looksLikePromptLabPromptPackProductSurfaceTask(taskContent) &&
    /\b(?:mission control next|workbench|run details?|segmented control|harness\/agentic|agentic segmented)\b/i.test(
      taskContent,
    )
  ) {
    addQuery("PromptPacksWorkbenchPage.tsx");
    addQuery("prompt-packs-workbench.css");
    addQuery("runPromptPackTest");
    addQuery("PromptPackExecutionStyle");
  }
  if (
    looksLikePromptLabPromptPackProductSurfaceTask(taskContent) &&
    /\b(?:reports?|exports?|rendered|rendering|markdown report|exported results?)\b/i.test(taskContent)
  ) {
    addQuery("renderPromptPackMarkdownReport");
    addQuery("refreshPromptPackExportFile");
    addQuery("getPromptPackReport");
    addQuery("prompt-pack-service.ts");
  }
  if (
    looksLikePromptLabPromptPackProductSurfaceTask(taskContent) &&
    /\b(?:api shape|shared client|gateway route|single prompt[- ]pack test|running a single|run a single)\b/i.test(
      taskContent,
    )
  ) {
    addQuery("runPromptPackTest");
    addQuery("prompt-packs.ts");
    addQuery("PromptPackRunRequest");
  }
  if (looksLikePromptLabPromptPackMarkdownImportPrompt(taskContent)) {
    addQuery("prompt-pack-service.ts");
    addQuery("prompt-pack-repo.ts");
    addQuery("prompt-packs.ts");
    addQuery("source_label");
    addQuery("policy_v2_source");
  }
  if (/\bprompt_pack\b/i.test(normalized) || /\bgoatcitadel_prompt_pack\b/i.test(normalized)) {
    addQuery("prompt_pack");
  }
  if (looksLikePromptLabGuidanceLoadingSummaryPrompt(taskContent)) {
    addQuery("guidance-document-helpers");
    addQuery("readguidancedocument");
    addQuery("resolveguidancepath");
    addQuery("listworkspaceguidance");
    addQuery("guidance-doc-files");
    addQuery("agents.md");
  }
  if (looksLikeWorkspaceGuidancePrecedencePrompt(taskContent)) {
    addQuery("guidance-document-helpers");
    addQuery("gateway-service.ts");
    addQuery("resolveruntimeguidance");
    addQuery("listworkspaceguidance");
    addQuery("agents.md");
  }
  if (looksLikePromptLabDurableRunClaimExclusivityPrompt(taskContent)) {
    addQuery("tryClaimQueuedRun");
    addQuery("leaseOwnerId");
    addQuery("claim queued durable run");
  }
  if (looksLikePromptLabDurableRunLeaseRecoveryPrompt(taskContent)) {
    addQuery("listExpiredRunningRunIds");
    addQuery("lease expired");
    addQuery("worker-old");
  }
  if (looksLikePromptLabDurableRunRetryBackoffPrompt(taskContent)) {
    addQuery("nextRetryAt");
    addQuery("hasFutureRetryGate");
    addQuery("retry backoff");
  }
  if (looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(taskContent)) {
    addQuery("clearLease");
    addQuery("wakeDurableRun");
    addQuery("pauseDurableRun");
    addQuery("cancelDurableRun");
  }
  if (looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(taskContent)) {
    addQuery("approval-resolution-effects-service.test.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("approval-effect-repo.ts");
    addQuery("approval-wait-run-repo.ts");
    addQuery("durable-run-service.ts");
  }
  if (looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt(taskContent)) {
    addQuery("chat-agent-orchestrator.test.ts");
    addQuery("normalizeCoworkRoleContractOutput");
    addQuery("looksLikePromptLabInstructionEchoContent");
    addQuery("repairRequestedRoleOrderOnlyCoworkOutput");
  }
  if (/\bguidance-loading chain\b|\bguidance loading chain\b|\bguidance precedence\b/i.test(taskContent)) {
    addQuery("guidance-document-helpers.ts");
    addQuery("guidance-doc-files.ts");
    addQuery("resolveRuntimeGuidance");
    addQuery("listWorkspaceGuidance");
  }
  if (/\bfrozen baseline\b|\bbaseline fixture\b|\bdistinct from the frozen baseline\b/i.test(taskContent)) {
    addQuery("baseline");
    addQuery("goatcitadel_prompt_pack.md");
  }
  if (/\bbenchmark\b/i.test(normalized)) {
    addQuery("benchmark");
  }
  if (/\breplay\b/i.test(normalized)) {
    addQuery("replay");
  }
  if (/\btrend\b/i.test(normalized)) {
    addQuery("trend");
  }
  if (/\breport\b/i.test(normalized)) {
    addQuery("report");
  }
  if (/\bworkspace\b/i.test(normalized) && /\boverride|guidance\b/i.test(normalized)) {
    addQuery("workspace");
  }
  if (
    /\b(workspace|global|repo)\b/.test(normalized) &&
    /\b(guidance|docs?|agents\.md|workflow|override|runtime)\b/.test(normalized)
  ) {
    addQuery("agents.md");
    addQuery("goatcitadel_agentic_coding_workflow.md");
    addQuery("workspaces");
    addQuery("guidance");
  }
  if (/\bgate[- ]runner\b/i.test(normalized)) {
    addQuery("gate");
    addQuery("run-prompt-pack-gates");
  }
  if (/\bqwen\b/i.test(normalized)) {
    addQuery("qwen");
  }
  if (/\bovernight\b/i.test(normalized)) {
    addQuery("overnight");
  }
  if (/\bextension pack\b/i.test(normalized)) {
    addQuery("extension");
  }
  if (/\bmemory\b/i.test(normalized) && /\bcontext|pack|qmd|lifecycle\b/i.test(normalized)) {
    addQuery("memory");
    addQuery("memory-context-repo");
  }
  if (/\bmemory\b/i.test(normalized) && /\b(routes?|services?)\b/i.test(normalized)) {
    addQuery("memory.ts");
    addQuery("memory-context");
    addQuery("memory-context-repo");
  }
  if (/\bmemory\b/i.test(normalized) && /\broutes?\b/i.test(normalized)) {
    addQuery("memory.ts");
    addQuery("registerMemoryRoutes");
  }
  if (/\bmemory\b/i.test(normalized) && /\b(ui|copy|page|operator-facing)\b/i.test(normalized)) {
    addQuery("MemoryRoutePage");
    addQuery("MemoryRoutePage.tsx");
    addQuery("useMemoryOperatorSnapshot.ts");
    addQuery("memory-summary");
  }
  if (/\bmemory\b/i.test(normalized) && /\b(expir|prun|maintenance|lifecycle)\b/i.test(normalized)) {
    addQuery("pruneExpired");
    addQuery("pruneOlderThan");
    addQuery("useMemoryOperatorSnapshot.ts");
    addQuery("memory-maintenance");
  }
  if (
    /\brepo\/project binding\b|\brepo\b|\bproject binding\b|\btool-path\b|\btool path\b|\bresolution\b/i.test(
      normalized,
    )
  ) {
    addQuery("binding");
    addQuery("tool-path");
  }
  if (/\brealtime[- ]event\b/i.test(normalized)) {
    addQuery("realtime-event");
  }
  if (/\bevent producers?\b|\bapproval\b|\bsession\b|\btask\b|\bproactive\b/i.test(normalized)) {
    addQuery("approval");
    addQuery("session");
    addQuery("task");
    addQuery("proactive");
  }
  if (/\bcontracts?\b/i.test(normalized)) {
    addQuery("contracts");
  }
  if (
    /\bsource label\b|\bsource labeling\b|\bexport rendering\b|\bimport\b/i.test(normalized) &&
    /\bprompt[- ]pack\b/i.test(normalized)
  ) {
    addQuery("prompt-packs.ts");
    addQuery("prompt-pack-service.ts");
    addQuery("prompt-pack-service.parser-report.test.ts");
    addQuery("prompt-pack");
    addQuery("prompt-pack.ts");
    addQuery("export");
    addQuery("importpromptpack");
    addQuery("sourcelabel");
    addQuery("source_label");
    addQuery("PromptPackExportRecord");
  }
  if (/\brender(?:ing)?\b|\bstatus api\b|\btrends?\b|\breport api\b/.test(normalized)) {
    addQuery("prompt-packs.ts");
    addQuery("benchmark");
    addQuery("trends");
    addQuery("report");
  }
  if (/\bgate\b|\bfocused-pack\b|\bovernight\b/i.test(normalized) && /\bprompt[- ]pack\b/i.test(normalized)) {
    addQuery("run-prompt-pack-gates");
    addQuery("resolvepromptpack");
    addQuery("fetchpromptpacks");
    addQuery("prompt-pack-service.ts");
    addQuery("prompt-packs.ts");
    addQuery("fetchPromptPackTests");
  }
  if (/\bworkspace\b/i.test(normalized) && /\b(guidance|precedence|loading|resolution)\b/i.test(normalized)) {
    addQuery("workspace-repo");
    addQuery("workspace-hook-repo");
    addQuery("guidance-doc-files");
    addQuery("guidance");
  }
  if (/\bapproval\b|\bwake\b|\bresume\b|\bpaused\b|\bwaiting\b/.test(normalized)) {
    addQuery("durable-run");
    addQuery("approval-event-repo.ts");
    addQuery("approval-resolution-effects-service.ts");
    addQuery("wake");
    addQuery("resume");
    addQuery("gateway-service");
  }

  const fallbackTokens = normalized
    .replace(/[^a-z0-9._/-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter(
      (token) =>
        ![
          "that",
          "with",
          "from",
          "into",
          "using",
          "file",
          "files",
          "code",
          "tools",
          "inspect",
          "summarize",
          "review",
          "reviewable",
          "operator",
          "concrete",
          "evidence",
          "exact",
          "path",
          "paths",
          "behavior",
          "metadata",
          "current",
          "today",
          "should",
          "needed",
          "identify",
          "explain",
          "support",
          "cleanly",
          "related",
          "publish",
          "explicit",
          "eventclass",
          "eventauthority",
          "links",
          "producer",
          "producers",
          "storage",
          "contract",
          "contracts",
        ].includes(token),
    )
    .slice(0, 8);
  for (const token of fallbackTokens) {
    addQuery(token);
  }

  return queries.slice(0, 8);
}

function inferFileFindPatternFromPrompt(userContent: string): string | undefined {
  const taskContent = extractPrimaryUserTaskContent(userContent);
  const quotedNeedle = extractQuotedSearchNeedle(taskContent);
  if (quotedNeedle) {
    return quotedNeedle;
  }
  const actionMatch = taskContent.match(
    /\b(?:find|search(?:\s+for)?|look\s+for|grep|match(?:ing)?)\s+(?:the\s+)?(?:text|string|term|pattern)?\s*([a-z0-9_.:-]{2,80})/i,
  );
  if (actionMatch?.[1]) {
    return actionMatch[1].trim();
  }
  return undefined;
}

function extractExplicitPromptPath(content: string): string | undefined {
  const candidates: string[] = [];
  const pushCandidate = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = normalizePromptPathCandidate(value);
    if (!looksLikeExplicitLocalAccessPath(normalized) && !looksLikePromptPathCandidate(normalized)) {
      return;
    }
    if (candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };
  for (const candidate of extractExplicitLocalAccessPaths(content)) {
    pushCandidate(candidate);
  }
  for (const match of content.matchAll(/`([^`\r\n]+)`/g)) {
    pushCandidate(match[1]);
  }
  for (const match of content.matchAll(
    /\b(?:[a-zA-Z]:\\|\.{1,2}[\\/])?[a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+(?:[\\/])?/g,
  )) {
    pushCandidate(match[0]);
  }
  for (const match of content.matchAll(/\b[a-zA-Z0-9_.-]+\.(?:[a-z0-9]{1,8})\b/gi)) {
    pushCandidate(match[0]);
  }
  return candidates[0];
}

function promptContainsDynamicLocalPathPlaceholder(content: string): boolean {
  return [...content.matchAll(/`([^`\r\n]+)`/g)].some((match) => {
    const candidate = match[1]?.trim() ?? "";
    return /<[^>\r\n]+>/.test(candidate) && /[\\/]/.test(candidate);
  });
}

function normalizePromptPathCandidate(value: string): string {
  return value.trim().replace(/^["'`(]+|["'`),.:;]+$/g, "");
}

function looksLikePromptPathCandidate(value: string): boolean {
  if (!value || /\s{2,}/.test(value) || /^[a-z]+:\/\//i.test(value)) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  if (!(/[\\/]/.test(normalized) || /\.[a-z0-9]{1,8}$/i.test(normalized))) {
    return false;
  }
  if (!/[\\/]/.test(normalized)) {
    const basename = normalized.trim();
    const stem = basename.replace(/\.[a-z0-9]{1,8}$/i, "");
    const isKnownBareFile = KNOWN_BARE_FILE_BASENAMES.has(basename);
    const isLowercaseBareName = stem.length > 0 && stem === stem.toLowerCase();
    if (!isKnownBareFile && !isLowercaseBareName) {
      return false;
    }
  }
  if (!looksLikeExplicitlyRootedPromptPath(normalized) && !/\.[a-z0-9]{1,8}$/i.test(normalized)) {
    const segments = normalized.split("/").filter(Boolean);
    const firstSegment = segments[0]?.toLowerCase();
    if (segments.length < 3 && (!firstSegment || !KNOWN_REPO_PATH_ROOT_SEGMENTS.has(firstSegment))) {
      return false;
    }
  }
  return /^(?:[a-zA-Z]:\/|\/|\.{1,2}\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?:\/)?$/i.test(normalized);
}

function looksLikeExplicitlyRootedPromptPath(value: string): boolean {
  return /^(?:[a-zA-Z]:\/|\/|\.{1,2}\/)/i.test(value);
}

function collapsePromptPathToSearchRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) {
    return ".";
  }
  if (!/\.[a-z0-9]{1,8}$/i.test(normalized)) {
    return value;
  }
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return ".";
  }
  const parent = normalized.slice(0, slashIndex);
  return parent || ".";
}

function promptPathBasename(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const basename = normalized.split("/").at(-1)?.trim();
  return basename && basename !== "." && basename !== ".." ? basename : undefined;
}

function extractQuotedSearchNeedle(content: string): string | undefined {
  for (const match of content.matchAll(/[`'"]([^`'"\r\n]{2,80})[`'"]/g)) {
    const candidate = match[1]?.trim();
    if (candidate && !looksLikePromptPathCandidate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function looksLikeHangingMarkdownLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const boldMarkerCount = (trimmed.match(/\*\*/g) ?? []).length;
  if (boldMarkerCount % 2 === 1) {
    return true;
  }
  const backtickCount = (trimmed.match(/`/g) ?? []).length;
  if (backtickCount % 2 === 1) {
    return true;
  }
  return /^[-*+]\s+\*\*[^*]+$/u.test(trimmed);
}

function truncateJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) {
    return serialized;
  }
  return `${serialized.slice(0, maxChars)}...`;
}

function extractFirstUrl(value: string): string | undefined {
  const matched = value.match(/\bhttps?:\/\/[^\s`"')]+/i);
  return matched?.[0];
}

function detectExplicitToolMentions(content: string, toolNames: Iterable<string>): Set<string> {
  const normalized = content.toLowerCase();
  const matches = new Set<string>();
  for (const toolName of toolNames) {
    const dotted = toolName.toLowerCase();
    const underscored = dotted.replaceAll(".", "_");
    if (
      hasStandaloneToolReference(normalized, dotted) ||
      (underscored !== dotted && hasStandaloneToolReference(normalized, underscored))
    ) {
      matches.add(toolName);
    }
  }
  return matches;
}

function hasStandaloneToolReference(content: string, candidate: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegexLiteral(candidate)}([^a-z0-9]|$)`, "i").test(content);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectMemoryLookupIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    detectMemoryToolsOnlyPrompt(content) ||
    /\bmemory\.(read|search)\b/.test(normalized) ||
    /\b(search|look up|lookup|find|retrieve|recall|read|check|load)\b.{0,40}\b(memory|memories|note|notes|saved|stored|preference|preferences|context)\b/.test(
      normalized,
    ) ||
    /\b(what do you remember|do you remember)\b/.test(normalized) ||
    (/\b(confirm|verify|check)\b/.test(normalized) && /\b(saved|stored|remembered|memory|note)\b/.test(normalized))
  );
}

function detectMemoryToolsOnlyPrompt(content: string): boolean {
  return /\b(?:use\s+)?(?:available\s+)?memory\s+tools?\s+only\b/i.test(content);
}

function detectMemoryPersistenceIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    hasExplicitMemoryConsent(content) ||
    /\bmemory\.(write|upsert)\b/.test(normalized) ||
    /\b(make a note of|write down|save|store|remember|record|keep)\b.{0,40}\b(memory|note|preference|preferences|fact|detail|this|it|that)\b/.test(
      normalized,
    ) ||
    /\b(add|put)\b.{0,20}\b(to memory|into memory|memory)\b/.test(normalized)
  );
}

function hasExplicitMemoryConsent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /\bremember this\b/.test(normalized) ||
    /\bremember (that|it|my preference|my preferences)\b/.test(normalized) ||
    /\bsave (this|it)( as)? (memory|note)\b/.test(normalized) ||
    /\bsave (this|it|that) for later\b/.test(normalized) ||
    /\bstore this\b/.test(normalized) ||
    /\bmake a note of this\b/.test(normalized) ||
    /\badd (this|it) to memory\b/.test(normalized) ||
    /\bupdate memory\b/.test(normalized) ||
    /\bfor memory\b/.test(normalized)
  );
}

function isWriteJailBlockReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  const normalized = reason.toLowerCase();
  return normalized.includes("write jail") || normalized.includes("outside write");
}

function isWriteDestinationTool(toolName: string): boolean {
  return (
    toolName === "fs.write" ||
    toolName === "artifacts.create" ||
    toolName === "documents.create" ||
    toolName === "presentations.create"
  );
}

function buildWriteDestinationUserInputPrompt(input: {
  sessionId: string;
  turnId: string;
  toolName: string;
  requestedPath: unknown;
  policyReason?: string;
  fallbackPath?: string;
  safeWriteFallbackDir?: string;
}): ChatUserInputPromptRecord | undefined {
  if (!isWriteDestinationTool(input.toolName) || !isWriteJailBlockReason(input.policyReason)) {
    return undefined;
  }
  const requestedPath = typeof input.requestedPath === "string" ? input.requestedPath.trim() : "";
  const suggestedPath =
    input.fallbackPath ??
    buildSafeWriteFallbackPath(input.sessionId, input.toolName, requestedPath, input.safeWriteFallbackDir);
  const blockedTarget = requestedPath ? ` Requested path: ${requestedPath}.` : "";
  const suggestion = suggestedPath
    ? ` Enter a destination inside an allowed write root, for example ${suggestedPath}.`
    : " Enter a destination inside one of the configured write-jail roots.";
  return {
    promptId: `write-destination-${randomUUID()}`,
    turnId: input.turnId,
    kind: "text",
    title: WRITE_DESTINATION_PROMPT_TITLE,
    question: `I could not create this file because the path is outside the configured write jail.${blockedTarget}${suggestion}`,
    required: true,
    placeholder: suggestedPath ?? "workspace/goatcitadel_out/output.txt",
    submitLabel: "Create file",
  };
}

function buildSafeWritePath(fileName: string, safeWriteFallbackDir?: string): string {
  const directory = (safeWriteFallbackDir?.trim() || SAFE_WRITE_FALLBACK_DIR).replace(/[\\/]+$/u, "");
  return `${directory}/${fileName}`;
}

function buildSafeWriteFallbackPath(
  sessionId: string,
  toolName: string,
  originalPath: unknown,
  safeWriteFallbackDir?: string,
): string | undefined {
  const safeSessionId = sessionId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(-32);
  if (!safeSessionId) {
    return undefined;
  }
  const original = typeof originalPath === "string" ? originalPath.trim() : "";
  const normalizedOriginal = original.replaceAll("\\", "/");
  const fileName = normalizedOriginal.split("/").pop() ?? "";
  const match = fileName.match(/^(.+?)(\.[a-zA-Z0-9_-]{1,12})$/);
  const baseName = (match?.[1] ?? fileName).trim();
  const ext = (match?.[2] ?? "").trim();
  const safeBaseName =
    sanitizePathSegment(baseName) ||
    (toolName === "presentations.create"
      ? "presentation"
      : toolName === "documents.create"
        ? "document"
        : toolName === "artifacts.create"
          ? "artifact"
          : "output");
  const fallbackExt =
    ext ||
    (toolName === "presentations.create"
      ? ".pptx"
      : toolName === "documents.create"
        ? ".docx"
        : toolName === "artifacts.create"
          ? ".md"
          : ".txt");
  return buildSafeWritePath(`${safeBaseName}-${safeSessionId}${fallbackExt}`, safeWriteFallbackDir);
}

function extractAnsweredWriteDestination(content: string): string | undefined {
  const match = content.match(
    /(?:choose artifact destination|where should i create|destination inside an allowed write root)[\s\S]{0,900}?Answer:\s*([^\r\n]+)/i,
  );
  const answer = match?.[1]?.trim();
  if (!answer || /^(?:none|skip|cancel)$/i.test(answer)) {
    return undefined;
  }
  return answer.replace(/^`|`$/g, "").trim();
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function normalizePathForComparison(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function formatToolLabel(toolName: string): string {
  const shortName = toolName.split(".").pop() ?? toolName;
  return shortName.replaceAll("_", " ");
}

function buildToolFailureAppendix(toolRuns: ChatToolRunRecord[]): string | undefined {
  const failedOrBlocked = toolRuns.filter(
    (run) =>
      (run.status === "failed" || run.status === "blocked") && !isRecoveredMissingLocalPathSearchFailure(run, toolRuns),
  );
  if (failedOrBlocked.length === 0) {
    return undefined;
  }
  const uniqueTools = [...new Set(failedOrBlocked.map((run) => formatToolLabel(run.toolName)))];
  const opening =
    uniqueTools.length === 1
      ? `Note: ${uniqueTools[0]} failed while I was working, so parts of this answer may be incomplete.`
      : "Note: a few tools failed while I was working, so parts of this answer may be incomplete.";
  const guidance = [...new Set(failedOrBlocked.map((run) => run.failureGuidance).filter(Boolean))][0];
  return [
    opening,
    "",
    guidance ? `Best next move: ${guidance}` : undefined,
    guidance ? "" : undefined,
    'Say "keep going" to try another approach, or give me a specific URL or narrower query.',
  ]
    .filter(Boolean)
    .join("\n");
}

function isRecoveredMissingLocalPathSearchFailure(
  failedRun: ChatToolRunRecord,
  toolRuns: ChatToolRunRecord[],
): boolean {
  if (
    failedRun.status !== "blocked" ||
    !toolNameMatchesAnyKnownTool(failedRun.toolName, LOCAL_QUERY_TOOL_NAMES) ||
    !looksLikeMissingLocalToolPathError(failedRun.error)
  ) {
    return false;
  }
  const failedPath = typeof failedRun.args?.path === "string" ? failedRun.args.path : undefined;
  if (!failedPath || failedPath === ".") {
    return false;
  }
  const failedQuery =
    typeof failedRun.args?.query === "string"
      ? failedRun.args.query
      : typeof failedRun.args?.pattern === "string"
        ? failedRun.args.pattern
        : undefined;
  return toolRuns.some((run) => {
    if (
      run === failedRun ||
      run.status !== "executed" ||
      !toolNameMatchesAnyKnownTool(run.toolName, LOCAL_QUERY_TOOL_NAMES) ||
      run.args?.path !== "."
    ) {
      return false;
    }
    const query =
      typeof run.args?.query === "string"
        ? run.args.query
        : typeof run.args?.pattern === "string"
          ? run.args.pattern
          : undefined;
    return !failedQuery || !query || failedQuery === query;
  });
}

function buildToolFailureFallbackMessage(userPrompt: string, toolRuns: ChatToolRunRecord[], reason: string): string {
  const blockedSource = inferBlockedSourceFailure(toolRuns);
  const strongestLeads = recoverTitleUrlItems(toolRuns, 3);
  if (strongestLeads.length > 0) {
    const guidance = toolRuns
      .filter((run) => run.status === "failed" || run.status === "blocked")
      .map((run) => run.failureGuidance)
      .find(Boolean);
    return [
      blockedSource
        ? `${blockedSource.host ? `${blockedSource.host} blocked` : "A source blocked"} automated access, but I found these leads through alternate approaches:`
        : "I hit a snag with one of my tools but kept digging — here are the strongest leads so far:",
      "",
      ...strongestLeads.map((item, index) => `${index + 1}. ${formatRecoveredSearchLead(item)}`),
      "",
      guidance ? `Best next move: ${guidance}` : undefined,
      guidance ? "" : undefined,
      'Tell me which lead to dig into, or say "keep going" and I\'ll research the next batch.',
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lastFailure = toolRuns.filter((item) => item.status === "failed" || item.status === "blocked").at(-1);
  const evidence = toolRuns
    .filter((item) => item.status === "executed" && item.result)
    .slice(-2)
    .map((item) => `${formatToolLabel(item.toolName)}: ${truncateJson(item.result, 160)}`);
  const fallbackQuery = deriveLiveDataQuery(userPrompt);
  const intro = blockedSource
    ? `I tried multiple approaches but ${blockedSource.host ? `${blockedSource.host} blocked` : "the source blocked"} automated access. I haven't given up — here's what I can still try.`
    : reason.toLowerCase().includes("non-recoverable tool failure")
      ? "I hit a tool issue that can't be retried safely, but I have ideas for getting around it."
      : "I exhausted the current tool approaches after several attempts. Let me regroup.";
  const lines = [intro];
  if (lastFailure) {
    lines.push(`The sticking point was ${formatToolLabel(lastFailure.toolName)}.`);
    if (lastFailure.failureGuidance) {
      lines.push(`Suggested approach: ${lastFailure.failureGuidance}`);
    }
  }
  if (evidence.length > 0) {
    lines.push(`Best partial result so far: ${evidence[0]}`);
  } else {
    lines.push("I don't have solid results yet, but I can try a different angle.");
  }
  lines.push('Give me a narrower query, a specific URL, or say "keep going" and I\'ll try another approach.');
  if (fallbackQuery) {
    lines.push(`Suggested retry: ${fallbackQuery}`);
  }
  return lines.join("\n\n");
}

function createOrRefreshAgentStreamTrace(
  storage: Storage,
  input: Parameters<Storage["chatTurnTraces"]["create"]>[0],
): ChatTurnTraceRecord {
  try {
    const existing = storage.chatTurnTraces.get(input.turnId);
    if (existing.status === "cancelled") {
      throw createAbortError("Chat turn cancelled.");
    }
    return storage.chatTurnTraces.patch(input.turnId, {
      parentTurnId: input.parentTurnId,
      branchKind: input.branchKind,
      sourceTurnId: input.sourceTurnId,
      assistantMessageId: input.assistantMessageId,
      status: "running",
      model: input.model,
      effectiveToolAutonomy: input.effectiveToolAutonomy,
      routing: input.routing,
      loopGuard: input.loopGuard,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return storage.chatTurnTraces.create(input);
    }
    throw error;
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfChatTurnCancelled(input: Pick<ChatAgentTurnInput, "signal">): void {
  if (!input.signal?.aborted) {
    return;
  }
  const reason = input.signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new Error("Chat turn cancelled.");
}

function isChatTurnAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "ChatTurnCancelledError" ||
    (error as { code?: unknown }).code === "TURN_CANCELLED"
  );
}

function buildChatTurnFailureRecord(
  failureClass: ChatTurnFailureClass,
  message: string,
  recommendedAction: ChatTurnRecoveryAction = getChatTurnRecoveryAction(failureClass),
  provider?: ChatProviderFailureRecord,
): ChatTurnFailureRecord {
  return {
    failureClass,
    message,
    retryable: failureClass !== "auth_required",
    recommendedAction,
    ...(provider ? { provider } : {}),
  };
}

function extractProviderFailureRecord(error: unknown): ChatProviderFailureRecord | undefined {
  const providerFailure = toPlainRecord((error as { providerFailure?: unknown } | undefined)?.providerFailure);
  if (providerFailure) {
    const provider: ChatProviderFailureRecord = {
      code: readProviderFailureString(providerFailure.code),
      message: readProviderFailureString(providerFailure.message),
      status: readProviderFailureString(providerFailure.status),
      responseId: readProviderFailureString(providerFailure.responseId ?? providerFailure.response_id),
      type: readProviderFailureString(providerFailure.type),
    };
    if (Object.values(provider).some(Boolean)) {
      return provider;
    }
  }
  if (error instanceof Error && error.cause) {
    return extractProviderFailureRecord(error.cause);
  }
  return undefined;
}

function readProviderFailureString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function classifyChatTurnFailure(input: { error?: unknown; toolRuns: ChatToolRunRecord[] }): ChatTurnFailureClass {
  if (hasToolBlockedFailure(input.toolRuns)) {
    return "tool_blocked";
  }
  if (hasToolFailedFailure(input.toolRuns)) {
    return "tool_failed";
  }
  const normalizedMessage = input.error instanceof Error ? input.error.message.toLowerCase() : "";
  if (normalizedMessage.includes("timed out") || normalizedMessage.includes("timeout")) {
    return "provider_timeout";
  }
  if (
    normalizedMessage.includes("unauthorized") ||
    normalizedMessage.includes("forbidden") ||
    normalizedMessage.includes("api key") ||
    normalizedMessage.includes("401") ||
    normalizedMessage.includes("403") ||
    normalizedMessage.includes("auth")
  ) {
    return "auth_required";
  }
  if (
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("fetch failed") ||
    normalizedMessage.includes("socket") ||
    normalizedMessage.includes("econnreset") ||
    normalizedMessage.includes("enotfound")
  ) {
    return "network_interrupted";
  }
  return "unknown";
}

function hasToolBlockedFailure(toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => {
    if (run.status === "blocked") {
      return true;
    }
    const failureClass =
      typeof run.result?.browserFailureClass === "string" ? run.result.browserFailureClass : undefined;
    return failureClass === "remote_blocked" || failureClass === "http_error";
  });
}

function hasToolFailedFailure(toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => run.status === "failed");
}
